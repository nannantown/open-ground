import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { addProjectEntry, __resetMigrationCacheForTests } from '@/lib/server/registry'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/project/git-init — the Swarm preflight banner's one-click "set up
// git here" (server/routes/project.ts → src/lib/server/gitInit.ts).
//
// What must hold, each pinned by an OBSERVABLE outcome (検証の掟 #2 — not
// "status 200", but "the repo/HEAD really exists on disk", read back with git
// itself):
//   1. registry allowlist: an unregistered path 403s AND no .git appears;
//   2. an already-initialized project 409s ('already a git repository') and its
//      existing history is untouched;
//   3. happy path: after the POST, .git exists, `git rev-parse HEAD` succeeds
//      (the initial commit is real), and the folder's files were committed
//      (clean `git status --porcelain`);
//   4. an EMPTY registered folder still ends with a HEAD (--allow-empty is the
//      whole reason the route commits — a swarm worktree needs a HEAD to
//      branch from);
//   5. a machine with NO git identity gets the one-shot `-c` fallback
//      ("OPEN GROUND" <openground@localhost>) and the response says so.
//
// HOME ISOLATION: OPENGROUND_HOME pinned to a throwaway tmp dir per test (the
// registry the allowlist reads lives there). Git identity is pinned via env in
// both directions so the suite is deterministic on any machine: author/committer
// env vars for the tests that must NOT hit the fallback, and
// user.useConfigOnly=true + blanked global/system config (GIT_CONFIG_* env,
// git ≥ 2.31) to force the identity failure for the test that MUST.
// ─────────────────────────────────────────────────────────────────────────────

const execFile = promisify(execFileCb)

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const gitInit = (path: string) => app.request('/api/project/git-init', json({ path }))

const git = (cwd: string, args: string[]) => execFile('git', args, { cwd, timeout: 30_000 })

// Deterministic identity for the tests that shouldn't exercise the fallback —
// env beats any (missing) config, so these pass commit on a bare CI box too.
const IDENT_ENV = {
  GIT_AUTHOR_NAME: 'og-test',
  GIT_AUTHOR_EMAIL: 'og-test@example.com',
  GIT_COMMITTER_NAME: 'og-test',
  GIT_COMMITTER_EMAIL: 'og-test@example.com',
} as const

const ENV_KEYS = [
  'OPENGROUND_HOME',
  ...Object.keys(IDENT_ENV),
  'EMAIL',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
]

let home: string
let projectDir: string
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  // realpath: tmpdir is a symlink on macOS (/var → /private/var) and the
  // registry stores canonicalized paths — same as every sibling route test.
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-git-init-home-')))
  projectDir = await realpath(await mkdtemp(join(tmpdir(), 'og-git-init-proj-')))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.OPENGROUND_HOME = home
  Object.assign(process.env, IDENT_ENV)
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  // Restore saved values; delete only LITERAL non-home keys (testHomeEnvGuard
  // bans the computed `delete process.env[k]` form outright — a computed delete
  // could reach HOME/OPENGROUND_HOME, and OPENGROUND_HOME unset means the REAL
  // ~/.openground since vitest reuses workers across files).
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
  }
  if (savedEnv.GIT_AUTHOR_NAME === undefined) delete process.env.GIT_AUTHOR_NAME
  if (savedEnv.GIT_AUTHOR_EMAIL === undefined) delete process.env.GIT_AUTHOR_EMAIL
  if (savedEnv.GIT_COMMITTER_NAME === undefined) delete process.env.GIT_COMMITTER_NAME
  if (savedEnv.GIT_COMMITTER_EMAIL === undefined) delete process.env.GIT_COMMITTER_EMAIL
  if (savedEnv.EMAIL === undefined) delete process.env.EMAIL
  if (savedEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL
  if (savedEnv.GIT_CONFIG_SYSTEM === undefined) delete process.env.GIT_CONFIG_SYSTEM
  if (savedEnv.GIT_CONFIG_COUNT === undefined) delete process.env.GIT_CONFIG_COUNT
  if (savedEnv.GIT_CONFIG_KEY_0 === undefined) delete process.env.GIT_CONFIG_KEY_0
  if (savedEnv.GIT_CONFIG_VALUE_0 === undefined) delete process.env.GIT_CONFIG_VALUE_0
  await rm(home, { recursive: true, force: true })
  await rm(projectDir, { recursive: true, force: true })
})

describe('POST /api/project/git-init', () => {
  it('400 without a path', async () => {
    const res = await app.request('/api/project/git-init', json({}))
    expect(res.status).toBe(400)
  })

  it('403 for a path outside the registry — and creates nothing there', async () => {
    // projectDir deliberately NOT registered.
    const res = await gitInit(projectDir)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe('path not allowed')
    // The teeth: the guard must have stopped the work, not just the reply.
    expect(existsSync(join(projectDir, '.git'))).toBe(false)
  })

  it('409 for a project that is already a git repository — history untouched', async () => {
    await addProjectEntry(projectDir)
    await git(projectDir, ['init'])
    await git(projectDir, ['commit', '--allow-empty', '-m', 'pre-existing'])
    const head = (await git(projectDir, ['rev-parse', 'HEAD'])).stdout.trim()

    const res = await gitInit(projectDir)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error?: string }).error).toBe('already a git repository')
    // Nothing re-ran: HEAD is still the pre-existing commit, alone.
    expect((await git(projectDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
    expect((await git(projectDir, ['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1')
  })

  it('happy path: repo + initial commit exist, and the folder contents are IN it', async () => {
    await addProjectEntry(projectDir)
    await writeFile(join(projectDir, 'hello.txt'), 'hi\n')

    const res = await gitInit(projectDir)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok?: boolean
      committed?: boolean
      fallbackIdentity?: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.committed).toBe(true)
    // Identity came from IDENT_ENV — the fallback must NOT have been claimed.
    expect(body.fallbackIdentity).toBeUndefined()

    // Read the result back with git itself, not by trusting the response:
    expect(existsSync(join(projectDir, '.git'))).toBe(true)
    // HEAD exists (a worktree can branch from it) …
    await expect(git(projectDir, ['rev-parse', 'HEAD'])).resolves.toBeTruthy()
    expect((await git(projectDir, ['log', '-1', '--format=%s'])).stdout.trim()).toBe(
      'Initial commit',
    )
    // … and `git add -A` really swept the folder: nothing left uncommitted.
    expect((await git(projectDir, ['status', '--porcelain'])).stdout.trim()).toBe('')
  })

  it('an EMPTY folder still yields a HEAD (--allow-empty is load-bearing)', async () => {
    await addProjectEntry(projectDir) // nothing written into it
    const res = await gitInit(projectDir)
    expect(res.status).toBe(200)
    await expect(git(projectDir, ['rev-parse', 'HEAD'])).resolves.toBeTruthy()
  })

  it('no git identity anywhere → one-shot fallback commits as OPEN GROUND, response says so', async () => {
    await addProjectEntry(projectDir)
    // Force the identity failure deterministically: no ident env, no global or
    // system config, and user.useConfigOnly=true (via GIT_CONFIG_* env) so git
    // refuses to invent user@host even on a box where auto-detection would
    // otherwise quietly succeed.
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_COMMITTER_NAME
    delete process.env.GIT_COMMITTER_EMAIL
    delete process.env.EMAIL
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly'
    process.env.GIT_CONFIG_VALUE_0 = 'true'

    const res = await gitInit(projectDir)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; fallbackIdentity?: boolean }
    expect(body.ok).toBe(true)
    expect(body.fallbackIdentity).toBe(true)
    // The commit is REAL and carries the fallback identity (read back via git,
    // not the response) — and it was `-c` per-invocation only: the repo's own
    // config gained no user.name entry.
    expect((await git(projectDir, ['log', '-1', '--format=%an <%ae>'])).stdout.trim()).toBe(
      'OPEN GROUND <openground@localhost>',
    )
    await expect(git(projectDir, ['config', '--local', 'user.name'])).rejects.toThrow()
  })
})
