import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink, lstat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { installManagedSection } from './managedFileInstall'
import { getSettings, setSettings } from './store'
import {
  installCompactInstructions,
  COMPACT_SECTION_BEGIN,
  COMPACT_SECTION_END,
  COMPACT_INSTRUCTIONS_BODY,
  COMPACT_HEADING_RE,
  COMPACT_TARGET_REL,
} from './compactInstructionsInstall'

// The block-ownership contract for ~/.claude/CLAUDE.md — a file the USER also
// writes in. Exercised against a throwaway tmpdir home; the real ~/.claude is
// never touched (homeDir is injected, and settings go to an isolated
// OPENGROUND_HOME via src/test/setup-home.ts).
//
// The teeth that matter: everything the user wrote outside our delimiters must
// survive byte-for-byte, the section must never appear twice, and a user who
// already wrote their own "Compact Instructions" — or who deleted ours — must
// be left alone.

let dir: string
let home: string
let claudeMd: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-compact-instr-'))
  home = join(dir, 'home')
  claudeMd = join(home, ...COMPACT_TARGET_REL)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const run = () => installCompactInstructions({ homeDir: home })
const read = () => readFile(claudeMd, 'utf8')

const USER_PROSE = `# CLAUDE.md

# Global Rules
- 小手先のハックで問題を解決しないこと。

## My own section
Some notes I wrote by hand.
`

describe('installCompactInstructions', () => {
  // setup-home.ts points OPENGROUND_HOME at one isolated tmp home per FILE, so
  // the sentinel would otherwise leak between cases here and turn every test
  // after the first into 'opted-out'. Scoped to this describe: the block-level
  // tests below never read settings, and a settings write per test is the
  // single most expensive thing in this file.
  beforeEach(async () => {
    await setSettings({ compactInstructionsInstalledAt: undefined })
  })

  it('creates ~/.claude/CLAUDE.md with the section when nothing exists', async () => {
    const { result, sentinelWritten } = await run()
    expect(result.outcome).toBe('installed')
    expect(sentinelWritten).toBe(true)
    const text = await read()
    expect(text).toContain(COMPACT_SECTION_BEGIN)
    expect(text).toContain(COMPACT_SECTION_END)
    expect(text).toContain('# Compact Instructions')
  })

  it('uses the heading the native compactor actually reads (NOT "Summary instructions")', async () => {
    // The spike card's original wording was stale knowledge; the primary source
    // (how-claude-code-works.md, 2026-07-24) says "Compact Instructions".
    // A regression here silently makes the whole feature a no-op.
    expect(COMPACT_INSTRUCTIONS_BODY).toMatch(/^# Compact Instructions$/m)
    expect(COMPACT_INSTRUCTIONS_BODY).not.toMatch(/summary instructions/i)
  })

  it('delimits with well-formed HTML comments (so they are stripped, not rendered)', async () => {
    // Claude Code strips block-level HTML comments before injecting CLAUDE.md
    // into context — that is why the delimiters cost the user no tokens and can
    // carry the human-facing explanation. A stray `--` inside makes the comment
    // malformed, so it may not be recognised and would leak into context.
    for (const m of [COMPACT_SECTION_BEGIN, COMPACT_SECTION_END]) {
      expect(m.startsWith('<!--')).toBe(true)
      expect(m.endsWith('-->')).toBe(true)
      expect(m.slice(4, -3)).not.toContain('--')
    }
    // The BODY must NOT be inside a comment, or the instructions themselves
    // would be stripped and the whole feature would be a silent no-op.
    expect(COMPACT_INSTRUCTIONS_BODY).not.toContain('<!--')
  })

  it('carries the four things the card requires be preserved', async () => {
    const body = COMPACT_INSTRUCTIONS_BODY.toLowerCase()
    expect(body).toContain('files changed')
    expect(body).toMatch(/todo/)
    expect(body).toMatch(/decision/)
    expect(body).toMatch(/test/)
    expect(body).toMatch(/user's explicit instructions/)
  })

  it('appends to an EXISTING hand-written CLAUDE.md, preserving every byte of it', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(claudeMd, USER_PROSE, 'utf8')

    const { result } = await run()
    expect(result.outcome).toBe('installed')

    const text = await read()
    expect(text.startsWith(USER_PROSE.replace(/\s+$/, ''))).toBe(true)
    expect(text).toContain('小手先のハック')
    expect(text).toContain('Some notes I wrote by hand.')
    expect(text).toContain('# Compact Instructions')
  })

  it('is idempotent — a second run adds nothing (the section never appears twice)', async () => {
    await run()
    const first = await read()
    const { result, sentinelWritten } = await run()
    expect(result.outcome).toBe('unchanged')
    expect(sentinelWritten).toBe(false)
    expect(await read()).toBe(first)
    expect(first.split('# Compact Instructions').length - 1).toBe(1)
    expect(first.split(COMPACT_SECTION_BEGIN).length - 1).toBe(1)
  })

  it('stays idempotent across many boots with user edits in between', async () => {
    await run()
    // The user keeps writing in their own file around our block.
    await writeFile(claudeMd, `${await read()}\n## Added later\nmore notes\n`, 'utf8')
    for (let i = 0; i < 5; i++) await run()
    const text = await read()
    expect(text.split(COMPACT_SECTION_BEGIN).length - 1).toBe(1)
    expect(text.split('# Compact Instructions').length - 1).toBe(1)
    expect(text).toContain('## Added later')
    expect(text).toContain('more notes')
  })

  it('version-follows a stale block in place, leaving the surrounding text untouched', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    const before = '# Before our block\nkeep me\n'
    const after = '\n\n## After our block\nkeep me too\n'
    await writeFile(
      claudeMd,
      `${before}\n${COMPACT_SECTION_BEGIN}\n# Compact Instructions\n\nan OLD version of the text\n${COMPACT_SECTION_END}${after}`,
      'utf8',
    )
    // Sentinel set: this is an existing install, not a first one.
    await setSettings({ compactInstructionsInstalledAt: '2026-07-01T00:00:00.000Z' })

    const { result } = await run()
    expect(result.outcome).toBe('refreshed')

    const text = await read()
    expect(text).not.toContain('an OLD version of the text')
    expect(text).toContain(COMPACT_INSTRUCTIONS_BODY)
    expect(text.startsWith(before)).toBe(true)
    expect(text.endsWith(after)).toBe(true)
    expect(text).toContain('keep me too')
  })

  it("NEVER installs beside a user's own Compact Instructions section — kept-user", async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    const mine = `# CLAUDE.md\n\n## Compact Instructions\nKeep only the API contract.\n`
    await writeFile(claudeMd, mine, 'utf8')

    const { result, sentinelWritten } = await run()
    expect(result.outcome).toBe('kept-user')
    expect(sentinelWritten).toBe(false)
    // Byte-identical: two contradicting sections are worse than none.
    expect(await read()).toBe(mine)
  })

  it('kept-user detection survives repeat boots (regex state is not carried over)', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    const mine = `# Compact Instructions\nmine\n`
    await writeFile(claudeMd, mine, 'utf8')
    expect((await run()).result.outcome).toBe('kept-user')
    expect((await run()).result.outcome).toBe('kept-user')
    expect(await read()).toBe(mine)
  })

  it('never re-adds a block the user deleted — opted-out once the sentinel is set', async () => {
    await run() // first install → sentinel written
    await mkdir(join(home, '.claude'), { recursive: true })
    const afterDelete = '# CLAUDE.md\n\nI removed the OPEN GROUND block on purpose.\n'
    await writeFile(claudeMd, afterDelete, 'utf8')

    const { result } = await run()
    expect(result.outcome).toBe('opted-out')
    expect(await read()).toBe(afterDelete)
    // And it stays out on later boots.
    expect((await run()).result.outcome).toBe('opted-out')
    expect(await read()).toBe(afterDelete)
  })

  it('stays out of a SYMLINKED ~/.claude/CLAUDE.md — and does not spend the sentinel on it', async () => {
    // chezmoi/stow shape: the real file lives in the user's dotfiles repo and
    // ~/.claude/CLAUDE.md only points at it. Writing our block there would
    // replace the link with a regular file and quietly detach their dotfiles
    // management — so the only correct move is to write nothing.
    const dotfiles = join(dir, 'dotfiles-CLAUDE.md')
    await writeFile(dotfiles, USER_PROSE, 'utf8')
    await mkdir(join(home, COMPACT_TARGET_REL[0]), { recursive: true })
    await symlink(dotfiles, claudeMd)

    const { result, sentinelWritten } = await run()

    expect(result.outcome).toBe('kept-symlink')
    expect((await lstat(claudeMd)).isSymbolicLink()).toBe(true)
    expect(await readFile(dotfiles, 'utf8')).toBe(USER_PROSE)
    // Staying out is NOT "we installed once": if the user later un-symlinks the
    // file, that boot must still be allowed to add the section.
    expect(sentinelWritten).toBe(false)
    expect((await getSettings()).compactInstructionsInstalledAt).toBeUndefined()
  })

  it('backfills the sentinel when the block is already there but settings lost it', async () => {
    await run() // installs + writes the sentinel
    // Simulate a lost / reset settings.json while the block survives on disk.
    await setSettings({ compactInstructionsInstalledAt: undefined })
    const { result, sentinelWritten } = await run()
    expect(result.outcome).toBe('unchanged')
    expect(sentinelWritten).toBe(true)
    expect((await getSettings()).compactInstructionsInstalledAt).toBeDefined()

    // …so deleting the block afterwards is still a permanent opt-out.
    const afterDelete = '# CLAUDE.md\n\nremoved on purpose\n'
    await writeFile(claudeMd, afterDelete, 'utf8')
    expect((await run()).result.outcome).toBe('opted-out')
    expect(await read()).toBe(afterDelete)
  })

  it('the sentinel is only written after the block is actually on disk', async () => {
    // Make the write fail (target dir is a FILE, so mkdir/rename cannot work).
    await writeFile(join(home), 'not a dir', 'utf8').catch(async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(home, 'not a dir', 'utf8')
    })
    const { result, sentinelWritten } = await run()
    expect(result.outcome).toBe('error')
    expect(sentinelWritten).toBe(false)
    expect((await getSettings()).compactInstructionsInstalledAt).toBeUndefined()
  })

  it('targets the user scope, never a file inside a project repo', async () => {
    // Deploying into a scanned project's CLAUDE.md would write into the user's
    // git-tracked working tree — the one thing OPEN GROUND never does.
    expect(COMPACT_TARGET_REL.join('/')).toBe('.claude/CLAUDE.md')
  })
})

describe('installManagedSection (block ownership)', () => {
  const BEGIN = '<!-- og:test:begin -->'
  const END = '<!-- og:test:end -->'
  let target: string
  beforeEach(() => {
    target = join(dir, 'CLAUDE.md')
  })
  const install = (body: string, createIfAbsent = true) =>
    installManagedSection({ target, beginMarker: BEGIN, endMarker: END, body, createIfAbsent })

  it('fails closed on a begin marker with no end (never truncates the user file)', async () => {
    const mangled = `# mine\n${BEGIN}\n# Compact Instructions\nhalf a block\n\n## my other notes\nkeep\n`
    await writeFile(target, mangled, 'utf8')
    const r = await install('new body')
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/unbalanced/i)
    expect(await readFile(target, 'utf8')).toBe(mangled)
  })

  it('fails closed on duplicated markers rather than guessing which block is ours', async () => {
    const dup = `${BEGIN}\na\n${END}\n\n${BEGIN}\nb\n${END}\n`
    await writeFile(target, dup, 'utf8')
    const r = await install('new body')
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/duplicate/i)
    expect(await readFile(target, 'utf8')).toBe(dup)
  })

  it('fails closed when the end marker precedes the begin marker', async () => {
    const inverted = `${END}\nstuff\n${BEGIN}\n`
    await writeFile(target, inverted, 'utf8')
    const r = await install('new body')
    expect(r.outcome).toBe('error')
    expect(await readFile(target, 'utf8')).toBe(inverted)
  })

  it('fails closed when an EXISTING target is unreadable for a reason other than missing', async () => {
    await writeFile(target, '# private\n', 'utf8')
    await chmod(target, 0o000)
    try {
      const r = await install('new body')
      // root ignores the mode bit; only assert when the chmod actually bit.
      if (r.outcome !== 'unchanged' && r.outcome !== 'installed' && r.outcome !== 'refreshed') {
        expect(r.outcome).toBe('error')
        expect(r.error).toMatch(/refusing to guess ownership/)
      }
    } finally {
      await chmod(target, 0o600)
    }
    expect(await readFile(target, 'utf8')).toBe('# private\n')
  })

  it('never replaces a SYMLINKED target with a regular file', async () => {
    const dest = join(dir, 'elsewhere-CLAUDE.md')
    await writeFile(dest, USER_PROSE, 'utf8')
    await symlink(dest, target)

    const r = await install('new body')

    expect(r.outcome).toBe('kept-symlink')
    expect((await lstat(target)).isSymbolicLink()).toBe(true) // still a link
    expect(await readFile(dest, 'utf8')).toBe(USER_PROSE) // destination untouched
    expect(await readFile(target, 'utf8')).toBe(USER_PROSE) // and it still reads through
  })

  it('leaves a DANGLING symlink dangling instead of filling it in', async () => {
    // readFile reports ENOENT for a dangling link — exactly what a genuinely
    // missing file looks like. Without the lstat check this lands in the
    // fresh-write path and buries the link under a regular file.
    await symlink(join(dir, 'nowhere', 'CLAUDE.md'), target)

    const r = await install('new body')

    expect(r.outcome).toBe('kept-symlink')
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses identical begin/end markers', async () => {
    const r = await installManagedSection({
      target, beginMarker: BEGIN, endMarker: BEGIN, body: 'x', createIfAbsent: true,
    })
    expect(r.outcome).toBe('error')
  })

  it('reports opted-out (writing nothing) when the block is absent and creation is off', async () => {
    const mine = '# just mine\n'
    await writeFile(target, mine, 'utf8')
    const r = await install('body', false)
    expect(r.outcome).toBe('opted-out')
    expect(await readFile(target, 'utf8')).toBe(mine)
  })

  it('separates an appended block from the user text by exactly one blank line', async () => {
    await writeFile(target, '# mine\nlast line\n\n\n', 'utf8')
    await install('body')
    expect(await readFile(target, 'utf8')).toBe(`# mine\nlast line\n\n${BEGIN}\nbody\n${END}\n`)
  })

  it("keeps the user's file permissions (a 0600 CLAUDE.md does not come back 0600-less)", async () => {
    const { stat } = await import('fs/promises')
    await writeFile(target, '# mine\n', 'utf8')
    await chmod(target, 0o600)
    await install('body') // append
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    await install('a different body') // refresh in place
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('honours headingRe only outside our own block', async () => {
    // Our own block contains "# Compact Instructions" — that must NOT be read as
    // a user-authored section on the next boot (it would flip us to kept-user
    // and freeze the text forever).
    await installManagedSection({
      target, beginMarker: BEGIN, endMarker: END,
      body: COMPACT_INSTRUCTIONS_BODY, createIfAbsent: true, headingRe: COMPACT_HEADING_RE,
    })
    const r = await installManagedSection({
      target, beginMarker: BEGIN, endMarker: END,
      body: `${COMPACT_INSTRUCTIONS_BODY}\n\nextra`, createIfAbsent: true, headingRe: COMPACT_HEADING_RE,
    })
    expect(r.outcome).toBe('refreshed')
    expect(await readFile(target, 'utf8')).toContain('extra')
  })
})
