import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { swarmEnvPreflight } from './swarmEnvPreflight'

// Tests against a REAL local git fixture in a tmpdir (activeBranches.test.ts
// house style) — no mocks of git itself, since a repo's REAL git is the exact
// thing every worker spawn depends on. `force:true` bypasses the 10s cache so
// each case is independent.

// Real git subprocess I/O under load can exceed vitest's 5s default. Pinned to
// the canonical ceiling (vitest.config.ts's 60s); a shorter value here would
// silently re-cap that global back down (setConfig runs after the global config).
vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', ['-c', 'user.name=OG Test', '-c', 'user.email=og-test@example.com', ...args], { cwd }))
    .stdout

let scratch: string

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-envpreflight-')))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('swarmEnvPreflight — git/shell prerequisites for spawning a swarm session', () => {
  it('ok:true, no issues, for a real git repo (git + shell both present on the test box)', async () => {
    await git(scratch, ['init', '-b', 'main'])
    const result = await swarmEnvPreflight(scratch, { force: true })
    expect(result).toEqual({ ok: true, issues: [] })
  })

  it("notAGitRepo: a plain folder that never ran `git init` fails the repo check", async () => {
    const result = await swarmEnvPreflight(scratch, { force: true })
    expect(result.ok).toBe(false)
    expect(result.issues.map((i) => i.id)).toEqual(['notAGitRepo'])
  })

  it('caches the result for the same path+mode until force:true bypasses it', async () => {
    // A bare tmpdir (not a repo) answers notAGitRepo — call once uncached...
    const first = await swarmEnvPreflight(scratch, { force: true })
    expect(first.ok).toBe(false)
    // ...git init it, then a NON-forced call within the cache window still
    // reads the STALE (pre-init) answer...
    await git(scratch, ['init', '-b', 'main'])
    const cached = await swarmEnvPreflight(scratch)
    expect(cached.ok).toBe(false)
    // ...while force:true re-checks and sees the now-real repo.
    const fresh = await swarmEnvPreflight(scratch, { force: true })
    expect(fresh).toEqual({ ok: true, issues: [] })
  })

  it('requireGitRepo:false (the manager shape) never reports notAGitRepo, but still checks git is installed', async () => {
    // Same bare, never-`git init`-ed folder that fails the repo check above —
    // but the manager's own server code never calls git (only the /og-manage
    // conversation it launches does), so THIS check must read ok:true. requireGit
    // is left at its true default (unset), which must NOT be dragged to false
    // just because requireGitRepo is false (2026-07-22 review round 2, nit3) —
    // covered by the PATH-stripped case right below.
    const result = await swarmEnvPreflight(scratch, { force: true, requireGitRepo: false })
    expect(result).toEqual({ ok: true, issues: [] })
  })

  it('requireGitRepo:false still reports gitMissing when git truly is not installed (manager needs git, unlike supply)', async () => {
    const savedPath = process.env.PATH
    process.env.PATH = '/definitely-not-a-real-bin-dir'
    try {
      // No login-shell git resolvable either (this env var only affects THIS
      // process's execFile, not the login shell probe, so isolate it too).
      const loginShellSeesGit = await execFile('/bin/zsh', ['-lic', 'command -v git'])
        .then((r) => !!r.stdout.trim())
        .catch(() => false)
      if (loginShellSeesGit) return // this box can still resolve git via login shell — nothing to prove here
      const result = await swarmEnvPreflight(scratch, { force: true, requireGitRepo: false })
      expect(result.ok).toBe(false)
      expect(result.issues.map((i) => i.id)).toEqual(['gitMissing'])
    } finally {
      process.env.PATH = savedPath
    }
  })

  it('requireGit:false AND requireGitRepo:false (the supply shape) is ok:true even with no git installed', async () => {
    const savedPath = process.env.PATH
    process.env.PATH = '/definitely-not-a-real-bin-dir'
    try {
      const result = await swarmEnvPreflight(scratch, { force: true, requireGit: false, requireGitRepo: false })
      expect(result).toEqual({ ok: true, issues: [] })
    } finally {
      process.env.PATH = savedPath
    }
  })

  it(
    'does NOT false-positive notAGitRepo when git only resolves via the login-shell ' +
      "fallback (a real repo, but this process's bare PATH can't see git) — 2026-07-22 regression",
    async () => {
      await git(scratch, ['init', '-b', 'main'])
      // Strip PATH so a bare `execFile('git', …)` ENOENTs, forcing the same
      // login-shell fallback resolveGitBin uses when the server's boot-time PATH
      // snapshot misses git (nvm-style shims, Homebrew added post-boot). Before
      // the fix, the SUBSEQUENT `git rev-parse` call re-tried the bare name
      // against this same stale PATH and ENOENT'd too — which the old code
      // folded into "not a git repository" (a confidently wrong answer for a
      // real repo). This only exercises the repro when a login shell can still
      // find git on this box (harmless skip otherwise — CI images without a
      // profile-resolvable git would otherwise flake here for an unrelated reason).
      const savedPath = process.env.PATH
      process.env.PATH = '/definitely-not-a-real-bin-dir'
      try {
        const loginShellSeesGit = await execFile('/bin/zsh', ['-lic', 'command -v git'])
          .then((r) => !!r.stdout.trim())
          .catch(() => false)
        if (!loginShellSeesGit) return // this box has no profile-resolvable git — nothing to prove here
        const result = await swarmEnvPreflight(scratch, { force: true })
        expect(result).toEqual({ ok: true, issues: [] })
      } finally {
        process.env.PATH = savedPath
      }
    },
  )
})
