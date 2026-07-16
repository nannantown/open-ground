import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile, realpath } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installHooks,
  verifyGuardWiring,
  resolveHookSourceRoot,
  __setHookSourceModuleDirForTests,
} from './hooksInstall'

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION NET — hook source resolution must be cwd-INDEPENDENT and must
// REFUSE volatile roots.
//
// The incident (2026-07-12): installHooks() used to resolve the hook/guard
// scripts from process.cwd(). An install that ran while the process cwd sat
// inside a swarm worker's worktree (~/.openground/projects/<uuid>/worktrees/…)
// baked that worktree's ABSOLUTE path into the user's GLOBAL
// ~/.claude/settings.json; the janitor later deleted the worktree and every
// claude session — OPEN GROUND-related or not — started failing its Stop hook
// with MODULE_NOT_FOUND.
//
// The RELAPSE (2026-07-14): the volatile-root refusal anchored at
// openGroundHome(), which honours the OPENGROUND_HOME redirect. A worker
// verifying its branch with `OPENGROUND_HOME=$(mktemp -d) node
// server/dist/index.cjs` from its worktree moved the refusal prefix to /tmp
// while settingsPath() (homedir-based) kept pointing at the REAL
// ~/.claude/settings.json — the worktree root sailed past the check and got
// wired globally again. Three layers now prevent this:
//   (1) resolution anchors at the hooksInstall MODULE's own location (never
//       the process cwd),
//   (2) a module-anchored root is refused (fail-closed, nothing written) when
//       it sits under EITHER openGroundHome() OR the literal
//       homedir()/.openground — the redirect can no longer move the fence, and
//   (3) the wired command never carries the resolved root at all: the hook is
//       COPIED to the stable ~/.openground/hooks/ (like the guard to
//       ~/.openground/guard/) and settings.json only ever references that
//       homedir-anchored copy — the same anchor settings.json itself lives
//       under, so no env redirect can split them apart again.
//
// HOME ISOLATION: HOME (→ ~/.claude + the homedir-based install dirs)
// and OPENGROUND_HOME (→ the volatile-root refusal prefix) are both pinned
// into one throwaway dir — nothing here touches the real machine state.
// ─────────────────────────────────────────────────────────────────────────────

describe('hook source resolution — cwd-independent, worktree-refusing', () => {
  let tmpHome: string
  let savedHome: string | undefined
  let savedOgHome: string | undefined
  let savedCwd: string
  const repoRoot = process.cwd()
  const ogHome = () => join(tmpHome, '.openground')
  const claudeSettings = () => join(tmpHome, '.claude', 'settings.json')

  beforeEach(async () => {
    savedHome = process.env.HOME
    savedOgHome = process.env.OPENGROUND_HOME
    savedCwd = process.cwd()
    tmpHome = await realpath(await mkdtemp(join(tmpdir(), 'og-hooks-cwd-')))
    process.env.HOME = tmpHome
    process.env.OPENGROUND_HOME = ogHome()
  })
  afterEach(async () => {
    __setHookSourceModuleDirForTests(null)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedOgHome === undefined) delete process.env.OPENGROUND_HOME
    else process.env.OPENGROUND_HOME = savedOgHome
    process.chdir(savedCwd)
    await rm(tmpHome, { recursive: true, force: true })
  })

  // A fake swarm-worker worktree: a full-enough checkout (both hook scripts
  // present) at the central worktrees path the janitor manages. With the old
  // cwd-based resolution this layout is exactly what got wired globally.
  const mintFakeWorktree = async (): Promise<string> => {
    const wt = join(ogHome(), 'projects', 'test-uuid', 'worktrees', 'swarm-worker-x')
    await mkdir(join(wt, 'scripts'), { recursive: true })
    await mkdir(join(wt, 'src', 'lib', 'server'), { recursive: true })
    await copyFile(
      join(repoRoot, 'scripts', 'openground-hook.js'),
      join(wt, 'scripts', 'openground-hook.js'),
    )
    await copyFile(
      join(repoRoot, 'scripts', 'openground-guard.js'),
      join(wt, 'scripts', 'openground-guard.js'),
    )
    return wt
  }

  const allWiredCommands = (settings: any): string[] => {
    const out: string[] = []
    for (const arr of Object.values(settings?.hooks ?? {})) {
      if (!Array.isArray(arr)) continue
      for (const entry of arr as any[]) {
        for (const h of entry?.hooks ?? []) {
          if (typeof h?.command === 'string') out.push(h.command)
        }
      }
    }
    return out
  }

  it('R1 — installHooks with cwd inside a swarm worktree writes NO worktree path into settings.json', async () => {
    const wt = await mintFakeWorktree()
    process.chdir(wt) // the incident's trigger: cwd points at the worktree
    const res = await installHooks()
    expect(res.errors).toEqual([])

    const settings = JSON.parse(await readFile(claudeSettings(), 'utf8'))
    const commands = allWiredCommands(settings)
    expect(commands.length).toBeGreaterThan(0)
    for (const cmd of commands) {
      expect(cmd, 'a wired hook command must never point into the worktree').not.toContain(wt)
      expect(
        cmd,
        'a wired hook command must never point into the source checkout either — it dies with the checkout',
      ).not.toContain(repoRoot)
    }
    // The Stop hook (the entry that broke in the incident) points at the
    // stable installed copy, not wherever cwd or the source checkout happened
    // to be.
    const stop = settings.hooks.Stop.find((e: any) =>
      e?.hooks?.[0]?.command?.includes('openground-hook.js'),
    )
    expect(stop.hooks[0].command).toContain(join(ogHome(), 'hooks', 'openground-hook.js'))
  })

  it('R2 — an engine whose MODULE lives under the central worktrees refuses to install: nothing written', async () => {
    const wt = await mintFakeWorktree()
    __setHookSourceModuleDirForTests(join(wt, 'src', 'lib', 'server'))

    const res = await installHooks()
    expect(res.errors.join('\n')).toContain('refusing hook source root')
    expect(res.installed).toEqual([])
    expect(res.refreshed).toEqual([])
    // Fail-closed means NOTHING was written: no settings.json, no guard copy.
    expect(existsSync(claudeSettings())).toBe(false)
    expect(existsSync(join(ogHome(), 'guard', 'openground-guard.js'))).toBe(false)
  })

  it('R2b — the refusal never touches an existing settings.json (user hooks preserved byte-for-byte)', async () => {
    await mkdir(join(tmpHome, '.claude'), { recursive: true })
    const userSettings = JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'afplay Glass.aiff' }] }] },
    })
    await writeFile(claudeSettings(), userSettings, 'utf8')

    const wt = await mintFakeWorktree()
    __setHookSourceModuleDirForTests(join(wt, 'src', 'lib', 'server'))
    const res = await installHooks()
    expect(res.errors.join('\n')).toContain('refusing hook source root')
    expect(await readFile(claudeSettings(), 'utf8')).toBe(userSettings)
  })

  it('R3 — verifyGuardWiring refuses a worktree-resident source as the "expected" version (spawn gate stays closed)', async () => {
    // A correct install first (real module location, sane root)…
    const res = await installHooks()
    expect(res.errors).toEqual([])
    expect((await verifyGuardWiring()).ok).toBe(true)

    // …then the same checks from an engine living inside a worktree: the
    // wiring on disk is intact, but the verifier must NOT bless it, because
    // this engine cannot prove its own source is the durable one.
    const wt = await mintFakeWorktree()
    __setHookSourceModuleDirForTests(join(wt, 'src', 'lib', 'server'))
    const check = await verifyGuardWiring()
    expect(check.ok).toBe(false)
    expect(check.problems.join('\n')).toContain('refusing hook source root')
  })

  it('R4 — resolveHookSourceRoot anchors at the module location: cwd may point anywhere', async () => {
    process.chdir(tmpdir()) // no scripts/ here — cwd-based resolution would fail
    const { root, problem } = resolveHookSourceRoot()
    expect(problem).toBeNull()
    expect(root).toBeTruthy()
    expect(existsSync(join(root!, 'scripts', 'openground-hook.js'))).toBe(true)
    expect(existsSync(join(root!, 'scripts', 'openground-guard.js'))).toBe(true)
    // vitest runs from the checkout root — the resolved root IS that checkout.
    expect(root).toBe(await realpath(repoRoot))
  })

  it('R5 — the 2026-07-14 relapse: an OPENGROUND_HOME redirect must not move the refusal fence off the real data home', async () => {
    // Incident shape: a worker verifies its branch with
    // `OPENGROUND_HOME=$(mktemp -d) node server/dist/index.cjs` from inside
    // its worktree. openGroundHome() then points at the redirect while
    // settingsPath() still points at the REAL ~/.claude — the fake worktree
    // below sits under homedir()/.openground, NOT under the redirect.
    const redirect = await realpath(await mkdtemp(join(tmpdir(), 'og-redirect-')))
    process.env.OPENGROUND_HOME = redirect
    try {
      const wt = await mintFakeWorktree() // under join(tmpHome, '.openground')
      __setHookSourceModuleDirForTests(join(wt, 'src', 'lib', 'server'))
      const res = await installHooks()
      expect(res.errors.join('\n')).toContain('refusing hook source root')
      expect(res.installed).toEqual([])
      expect(res.refreshed).toEqual([])
      expect(existsSync(claudeSettings())).toBe(false)
    } finally {
      await rm(redirect, { recursive: true, force: true })
    }
  })

  it('R6 — the hook is COPIED to ~/.openground/hooks and the wiring references only that stable copy', async () => {
    const res = await installHooks()
    expect(res.errors).toEqual([])

    const installedHook = join(ogHome(), 'hooks', 'openground-hook.js')
    expect(existsSync(installedHook)).toBe(true)
    const src = await readFile(join(repoRoot, 'scripts', 'openground-hook.js'))
    expect((await readFile(installedHook)).equals(src)).toBe(true)

    const settings = JSON.parse(await readFile(claudeSettings(), 'utf8'))
    for (const phase of ['SessionStart', 'Stop', 'PostToolUse']) {
      const entry = settings.hooks[phase].find((e: any) =>
        e?.hooks?.[0]?.command?.includes('openground-hook.js'),
      )
      expect(entry, `${phase} entry missing`).toBeTruthy()
      expect(entry.hooks[0].command).toContain(installedHook)
    }
  })

  it('R7 — SELF-HEAL: a poisoned entry pointing into a deleted worktree is rewritten to the stable copy (user hooks untouched)', async () => {
    await mkdir(join(tmpHome, '.claude'), { recursive: true })
    const gone = join(ogHome(), 'projects', 'x', 'worktrees', 'janitor-deleted')
    await writeFile(
      claudeSettings(),
      JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'afplay Glass.aiff' }] },
            {
              matcher: '',
              hooks: [
                { type: 'command', command: `node ${gone}/scripts/openground-hook.js stop` },
              ],
            },
          ],
        },
      }),
      'utf8',
    )

    const res = await installHooks()
    expect(res.errors).toEqual([])
    expect(res.refreshed).toContain('Stop')

    const settings = JSON.parse(await readFile(claudeSettings(), 'utf8'))
    const cmds = settings.hooks.Stop.map((e: any) => e.hooks[0].command)
    expect(cmds).toContain('afplay Glass.aiff')
    const ours = cmds.filter((c: string) => c.includes('openground-hook.js'))
    expect(ours).toHaveLength(1)
    expect(ours[0]).toContain(join(ogHome(), 'hooks', 'openground-hook.js'))
    expect(ours[0]).not.toContain(gone)
  })

  it('R8 — SELF-HEAL: duplicate entries of ours (poison + manual repair) collapse to ONE stable entry', async () => {
    await mkdir(join(tmpHome, '.claude'), { recursive: true })
    const gone = join(ogHome(), 'projects', 'x', 'worktrees', 'janitor-deleted')
    await writeFile(
      claudeSettings(),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: `node ${gone}/scripts/openground-hook.js stop` },
              ],
            },
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: `node ${join(repoRoot, 'scripts', 'openground-hook.js')} stop`,
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    )

    const res = await installHooks()
    expect(res.errors).toEqual([])

    const settings = JSON.parse(await readFile(claudeSettings(), 'utf8'))
    const ours = settings.hooks.Stop.map((e: any) => e.hooks[0].command).filter((c: string) =>
      c.includes('openground-hook.js'),
    )
    expect(ours).toHaveLength(1)
    expect(ours[0]).toContain(join(ogHome(), 'hooks', 'openground-hook.js'))
  })
})
