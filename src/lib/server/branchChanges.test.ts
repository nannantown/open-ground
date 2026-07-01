import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getBranchChanges,
  getFileDiff,
  isSafeRepoRelFile,
  MAX_DIFF_BYTES,
} from './branchChanges'

// Tests against REAL local git fixtures in a tmpdir (mergedBranches.test.ts
// house style) — no mocks, no network.

// Real `git` subprocesses flake under the 5s default when the machine is
// loaded; generous ceiling, passing tests still finish well under it.
vi.setConfig({ testTimeout: 30_000 })

const execFile = promisify(execFileCb)

/** Run git in a fixture dir with a self-contained identity/config. */
const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      [
        '-c', 'user.name=OG Test',
        '-c', 'user.email=og-test@example.com',
        '-c', 'commit.gpgsign=false',
        ...args,
      ],
      { cwd },
    )
  ).stdout

let scratch: string

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-branch-changes-')))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** git init -b main + one commit, so refs/heads exists. */
async function makeRepo(name: string): Promise<string> {
  const dir = join(scratch, name)
  await mkdir(dir)
  await git(dir, ['init', '-b', 'main'])
  await writeFile(join(dir, 'README.md'), '# fixture\nline one\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'init'])
  return dir
}

/** Commit a file on the CURRENT branch. */
async function commit(dir: string, file: string, content: string, msg: string): Promise<void> {
  await writeFile(join(dir, file), content)
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', msg])
}

describe('getBranchChanges', () => {
  it('a non-git dir answers { isGit: false }', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    expect(await getBranchChanges(dir)).toEqual({ isGit: false })
  })

  it('clean repo on main: target=main, sameBranch, empty lists', async () => {
    const dir = await makeRepo('clean')
    const res = await getBranchChanges(dir)
    expect(res).toEqual({
      isGit: true,
      branch: 'main',
      target: 'main',
      sameBranch: true,
      ahead: 0,
      behind: 0,
      working: [],
      committed: [],
    })
  })

  it('working tree: modified + untracked files show up with status codes', async () => {
    const dir = await makeRepo('dirty')
    await writeFile(join(dir, 'README.md'), '# fixture\nCHANGED\n')
    await writeFile(join(dir, 'new file.txt'), 'hello\n') // space in name → -z parsing
    const res = await getBranchChanges(dir)
    if (!res.isGit) throw new Error('expected git repo')
    const byPath = Object.fromEntries(res.working.map((w) => [w.path, w.status]))
    expect(byPath['README.md']).toBe('M')
    expect(byPath['new file.txt']).toBe('??')
  })

  it('feature branch vs main: committed numstat + ahead/behind', async () => {
    const dir = await makeRepo('feature')
    await git(dir, ['checkout', '-b', 'feat/x'])
    await commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'add a')
    await commit(dir, 'README.md', '# fixture\n', 'drop a line')
    // Advance main by one commit so behind > 0.
    await git(dir, ['checkout', 'main'])
    await commit(dir, 'main-only.txt', 'm\n', 'main moves on')
    await git(dir, ['checkout', 'feat/x'])

    const res = await getBranchChanges(dir)
    if (!res.isGit) throw new Error('expected git repo')
    expect(res.branch).toBe('feat/x')
    expect(res.target).toBe('main')
    expect(res.sameBranch).toBe(false)
    expect(res.ahead).toBe(2)
    expect(res.behind).toBe(1)
    const byPath = Object.fromEntries(res.committed.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toMatchObject({ additions: 3, deletions: 0 })
    expect(byPath['README.md']).toMatchObject({ additions: 0, deletions: 1 })
    // main's own advance is NOT part of this branch's changes (three-dot diff).
    expect(byPath['main-only.txt']).toBeUndefined()
  })

  it('committed: a non-ASCII (Japanese) path stays RAW, and file-diff resolves it', async () => {
    const dir = await makeRepo('nonascii')
    await git(dir, ['checkout', '-b', 'feat/jp'])
    // ASCII content (robust assertion) under a non-ASCII filename (the bug surface).
    await commit(dir, '日本語ファイル.md', '# heading\nhello world\n', 'add japanese-named file')

    const res = await getBranchChanges(dir)
    if (!res.isGit) throw new Error('expected git repo')
    // (1) raw path in the committed list — NOT C-quoted ("\346\227\245…").
    expect(res.committed).toHaveLength(1)
    expect(res.committed[0].path.normalize('NFC')).toBe('日本語ファイル.md')
    expect(res.committed[0]).toMatchObject({ additions: 2, deletions: 0 })

    // (2) file-diff on the EXACT path the parser produced (what the UI sends)
    //     returns a non-empty diff — pre-fix the quoted path missed → empty.
    const diff = await getFileDiff(dir, res.committed[0].path, 'branch')
    expect(diff.diff).not.toBe('')
    expect(diff.diff).toContain('+hello world')
  })

  it('committed: a rename is keyed on its NEW path (no "→"), and file-diff resolves it', async () => {
    const dir = await makeRepo('rename')
    // Pin rename detection on regardless of the CI machine's global git config.
    await git(dir, ['config', 'diff.renames', 'true'])
    await commit(dir, 'orig.txt', 'l1\nl2\nl3\nl4\nl5\n', 'add orig on main')
    await git(dir, ['checkout', '-b', 'feat/rename'])
    await git(dir, ['mv', 'orig.txt', 'renamed.txt'])
    await writeFile(join(dir, 'renamed.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\n') // ~83% similar → still a rename
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-m', 'rename orig to renamed'])

    const res = await getBranchChanges(dir)
    if (!res.isGit) throw new Error('expected git repo')
    // (1) one rename row keyed on the postimage, raw — not "orig.txt → renamed.txt"
    //     and not a delete(orig)+add(renamed) pair.
    const paths = res.committed.map((f) => f.path)
    expect(paths).toContain('renamed.txt')
    expect(paths).not.toContain('orig.txt')
    expect(paths.some((p) => p.includes('=>') || p.includes('→'))).toBe(false)

    // (2) file-diff on that new path is non-empty (carries the added line).
    const renamed = res.committed.find((f) => f.path === 'renamed.txt')
    if (!renamed) throw new Error('expected renamed.txt in committed list')
    const diff = await getFileDiff(dir, renamed.path, 'branch')
    expect(diff.diff).not.toBe('')
    expect(diff.diff).toContain('+l6')
  })

  it('configured targetBranch wins over main', async () => {
    const dir = await makeRepo('configured')
    await git(dir, ['branch', 'develop'])
    await git(dir, ['checkout', '-b', 'feat/y'])
    await commit(dir, 'b.txt', 'b\n', 'add b')
    const res = await getBranchChanges(dir, 'develop')
    if (!res.isGit) throw new Error('expected git repo')
    expect(res.target).toBe('develop')
    expect(res.committed.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('invalid configured target falls back to detection; master detected when no main', async () => {
    const dir = join(scratch, 'master-repo')
    await mkdir(dir)
    await git(dir, ['init', '-b', 'master'])
    await writeFile(join(dir, 'f.txt'), 'x\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'init'])
    const res = await getBranchChanges(dir, '--bad..name')
    if (!res.isGit) throw new Error('expected git repo')
    expect(res.target).toBe('master')
    expect(res.sameBranch).toBe(true)
  })

  it('no target anywhere → target null, committed empty', async () => {
    const dir = join(scratch, 'no-target')
    await mkdir(dir)
    await git(dir, ['init', '-b', 'trunk'])
    await writeFile(join(dir, 'f.txt'), 'x\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'init'])
    const res = await getBranchChanges(dir)
    if (!res.isGit) throw new Error('expected git repo')
    expect(res.target).toBeNull()
    expect(res.sameBranch).toBe(false)
    expect(res.committed).toEqual([])
    expect(res.ahead).toBe(0)
    expect(res.behind).toBe(0)
  })
})

describe('getFileDiff', () => {
  it('working scope: modified file yields a unified diff (staged AND unstaged)', async () => {
    const dir = await makeRepo('wdiff')
    await writeFile(join(dir, 'README.md'), '# fixture\nCHANGED\n')
    await git(dir, ['add', 'README.md']) // staged — must still show vs HEAD
    const res = await getFileDiff(dir, 'README.md', 'working')
    expect(res.truncated).toBe(false)
    expect(res.diff).toContain('-line one')
    expect(res.diff).toContain('+CHANGED')
  })

  it('working scope: untracked file yields its full content as additions', async () => {
    const dir = await makeRepo('untracked')
    await writeFile(join(dir, 'fresh.txt'), 'alpha\nbeta\n')
    const res = await getFileDiff(dir, 'fresh.txt', 'working')
    expect(res.diff).toContain('+alpha')
    expect(res.diff).toContain('+beta')
  })

  it('branch scope: diff vs the merge-base with the target', async () => {
    const dir = await makeRepo('bdiff')
    await git(dir, ['checkout', '-b', 'feat/z'])
    await commit(dir, 'z.txt', 'zee\n', 'add z')
    const res = await getFileDiff(dir, 'z.txt', 'branch')
    expect(res.diff).toContain('+zee')
  })

  it('truncates huge diffs at a line boundary and flags it', async () => {
    const dir = await makeRepo('huge')
    const big = Array.from({ length: 20_000 }, (_, i) => `line number ${i} padding padding`).join('\n') + '\n'
    await writeFile(join(dir, 'big.txt'), big)
    const res = await getFileDiff(dir, 'big.txt', 'working')
    expect(res.truncated).toBe(true)
    expect(res.diff.length).toBeLessThanOrEqual(MAX_DIFF_BYTES)
    expect(res.diff.endsWith('\n')).toBe(false) // cut AT the newline, not mid-line
  })

  it('rejects traversal / absolute paths outright', async () => {
    const dir = await makeRepo('guard')
    await expect(getFileDiff(dir, '../outside.txt', 'working')).rejects.toThrow(/invalid file path/)
    await expect(getFileDiff(dir, '/etc/passwd', 'working')).rejects.toThrow(/invalid file path/)
  })
})

describe('isSafeRepoRelFile', () => {
  it.each([
    ['src/lib/types.ts', true],
    ['a file with spaces.txt', true],
    ['日本語/ファイル.md', true],
    ['-starts-with-dash.txt', true], // safe: git only sees it after `--`
    ['', false],
    ['/abs/path', false],
    ['../up.txt', false],
    ['a/../../b', false],
    ['a/..', false],
    ['..\\win.txt', false],
    ['a\0b', false],
  ])('%j → %s', (file, ok) => {
    expect(isSafeRepoRelFile(file)).toBe(ok)
  })

  it('allows dotfiles and .. inside a segment name', () => {
    expect(isSafeRepoRelFile('.github/workflows/ci.yml')).toBe(true)
    expect(isSafeRepoRelFile('weird..name.txt')).toBe(true)
  })
})
