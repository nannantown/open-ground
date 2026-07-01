import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, symlink } from 'fs/promises'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSwarmWorktree, removeSwarmWorktree } from './swarmWorker'
import { withRebasedWorktree } from './swarmOrchestrator'
import { cleanProjectWorktrees } from './worktreeCleanup'
import { ensureClaudeFolderTrusted } from './claudeTrust'
import { canonicalize } from './canonicalize'
import { centralWorktreesDir } from './paths'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'

// ─────────────────────────────────────────────────────────────────────────────
// Every central-worktree teardown path that launchClaude could have seeded a
// ~/.claude.json folder-trust entry in must DROP that entry — otherwise ephemeral
// worktree paths pile up in claude's `projects` map forever (slowing every claude
// start's read/write of that file). ensureClaudeFolderTrusted (claudeTerminal.ts)
// seeds one on every launchClaude in a worktree, and removeClaudeFolderTrust used
// to have ZERO production callers. These REAL-git tests pin the prune on all three
// seed-bearing teardown paths:
//   - removeSwarmWorktree  (swarmWorker.ts)        — worker dirs (spawnSwarmWorker)
//   - withRebasedWorktree  (swarmOrchestrator.ts)  — reviewer .review-* dirs
//   - cleanProjectWorktrees(worktreeCleanup.ts)    — the periodic central sweep
// (makeVerify / integrate tear down their worktrees too, but run NO launchClaude —
// tsc/lint/test + git only — so they seed no trust entry and need no prune.)
//
// HOME ISOLATION: OPENGROUND_HOME (central worktrees dir) and CLAUDE_CONFIG_PATH
// (claude's global config) are both pinned under a throwaway tmp dir per test, so
// nothing here touches the real ~/.openground or ~/.claude.json. Mirrors the
// home-isolation pattern in swarmSafety.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)

/** git with an inline identity so fixtures need no ambient user.name/email and
 *  never sign commits — mirrors swarmSafety.test.ts. */
const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      [
        '-c', 'user.name=OG Test',
        '-c', 'user.email=og-test@example.com',
        '-c', 'commit.gpgsign=false',
        '-c', 'init.defaultBranch=main',
        ...args,
      ],
      { cwd },
    )
  ).stdout

let scratch: string
let savedHome: string | undefined
let savedCfg: string | undefined
let cfg: string
const read = () => JSON.parse(readFileSync(cfg, 'utf8'))

beforeEach(async () => {
  // realpath so the worktree path EQUALS its realpath (no /var→/private/var
  // symlink hop) — exactly as production paths under ~/.openground do, which keeps
  // the trust key single-valued (pathKeys dedupes path===realpath). swarmSafety
  // does the same realpath() at setup.
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-wt-trust-')))
  savedHome = process.env.OPENGROUND_HOME
  const home = join(scratch, 'home')
  await mkdir(home, { recursive: true })
  process.env.OPENGROUND_HOME = home
  savedCfg = process.env.CLAUDE_CONFIG_PATH
  cfg = join(home, '.claude.json')
  process.env.CLAUDE_CONFIG_PATH = cfg
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENGROUND_HOME
  else process.env.OPENGROUND_HOME = savedHome
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_PATH
  else process.env.CLAUDE_CONFIG_PATH = savedCfg
  __resetMigrationCacheForTests()
  await rm(scratch, { recursive: true, force: true })
})

/** A real repo with an origin/main, registered in the registry so
 *  projectUUIDFromPath resolves (createSwarmWorktree's central-dir key). */
async function registeredRepo(): Promise<{ proj: string; uuid: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])
  const proj = join(scratch, 'proj')
  await mkdir(proj)
  await git(proj, ['init', '-b', 'main'])
  await git(proj, ['remote', 'add', 'origin', origin])
  await writeFile(join(proj, 'README.md'), '# base\n')
  await git(proj, ['add', '-A'])
  await git(proj, ['commit', '-m', 'base'])
  await git(proj, ['push', '-u', 'origin', 'main'])
  const entry = await addProjectEntry(proj)
  return { proj, uuid: entry.id }
}

describe('removeSwarmWorktree — ~/.claude.json trust pruning (Issue 1)', () => {
  it('drops the worktree’s trust entry when the worktree is removed', async () => {
    const { proj } = await registeredRepo()
    const wt = await createSwarmWorktree(proj)

    // What launchClaude does on every spawn in this dir (claudeTerminal.ts:333).
    ensureClaudeFolderTrusted(wt.worktree)
    expect(read().projects[wt.worktree]?.hasTrustDialogAccepted).toBe(true)

    const res = await removeSwarmWorktree(proj, wt.worktree, { force: true })

    expect(res).toEqual({ removed: true })
    // The ephemeral worktree path no longer lingers in claude's projects map.
    expect(read().projects[wt.worktree]).toBeUndefined()
  })

  it('does not accumulate trust entries across repeated dispatch/teardown cycles', async () => {
    const { proj } = await registeredRepo()

    for (let i = 0; i < 3; i++) {
      const wt = await createSwarmWorktree(proj)
      ensureClaudeFolderTrusted(wt.worktree)
      const res = await removeSwarmWorktree(proj, wt.worktree, { force: true })
      expect(res).toEqual({ removed: true })
    }

    // Every worktree path was pruned on teardown → the map never grows unbounded.
    expect(Object.keys(read().projects)).toHaveLength(0)
  })

  it('prunes a lingering trust entry even when the worktree dir is already gone (idempotent path)', async () => {
    const { proj } = await registeredRepo()
    const wt = await createSwarmWorktree(proj)
    ensureClaudeFolderTrusted(wt.worktree)

    // Delete the dir out-of-band (NOT via removeSwarmWorktree) → a stale trust
    // entry is left behind. The idempotent already-gone branch must still drop it.
    await rm(wt.worktree, { recursive: true, force: true })
    expect(read().projects[wt.worktree]).toBeDefined()

    const res = await removeSwarmWorktree(proj, wt.worktree, { force: true })

    expect(res).toEqual({ removed: true })
    expect(read().projects[wt.worktree]).toBeUndefined()
  })

  it('leaves OTHER projects’ trust entries intact when pruning one worktree', async () => {
    const { proj } = await registeredRepo()
    ensureClaudeFolderTrusted('/some/other/registered/project')
    const wt = await createSwarmWorktree(proj)
    ensureClaudeFolderTrusted(wt.worktree)

    await removeSwarmWorktree(proj, wt.worktree, { force: true })

    const d = read()
    expect(d.projects[wt.worktree]).toBeUndefined()
    // A sibling (e.g. the user's real project) keeps its trust — we prune ONLY the
    // removed worktree's key.
    expect(d.projects['/some/other/registered/project'].hasTrustDialogAccepted).toBe(true)
  })
})

describe('withRebasedWorktree — reviewer .review-* trust pruning (Issue 1, LEAK 1)', () => {
  it('drops the trust entry its fn seeded when the reviewer worktree is torn down', async () => {
    const { proj, uuid } = await registeredRepo()
    // withRebasedWorktree does NOT mkdir the central parent (production relies on a
    // prior createSwarmWorktree having made it); create it so the .review-* add works.
    await mkdir(centralWorktreesDir(uuid), { recursive: true })

    let seededDir = ''
    const res = await withRebasedWorktree(proj, 'main', 'main', async (dir) => {
      // Exactly what defaultRunReviewer's launchClaude does for this .review-* dir.
      seededDir = dir
      ensureClaudeFolderTrusted(dir)
      expect(read().projects[dir]?.hasTrustDialogAccepted).toBe(true)
      return 'sentinel'
    })

    expect(res).toEqual({ ok: true, value: 'sentinel' })
    expect(seededDir).not.toBe('')
    // finally tore the reviewer worktree down AND pruned its trust entry — no
    // .review-* path lingers in claude's projects map.
    expect(read().projects[seededDir]).toBeUndefined()
  })
})

describe('cleanProjectWorktrees — central sweep trust pruning (Issue 1, LEAK 2)', () => {
  it('prunes trust entries for the clean worktrees it sweeps', async () => {
    const { proj } = await registeredRepo()
    // A clean, non-live central worktree (registeredRepo has no node_modules, so
    // createSwarmWorktree adds no untracked symlink → the tree stays clean and the
    // sweep removes it). Seed its trust as launchClaude would on a Board/task launch.
    const wt = await createSwarmWorktree(proj)
    ensureClaudeFolderTrusted(wt.worktree)
    expect(read().projects[wt.worktree]?.hasTrustDialogAccepted).toBe(true)

    const res = await cleanProjectWorktrees(proj)

    // The worktree was swept (results carry the canonicalized dir)…
    expect(res.removed).toContain(await canonicalize(wt.worktree))
    // …and its trust entry pruned, so swept paths don't accumulate.
    expect(read().projects[wt.worktree]).toBeUndefined()
  })

  it('does NOT prune trust for a worktree it skips (dirty → still live)', async () => {
    const { proj } = await registeredRepo()
    const wt = await createSwarmWorktree(proj)
    ensureClaudeFolderTrusted(wt.worktree)
    // Make it dirty so the sweep SKIPS it (never force-removes uncommitted work).
    await writeFile(join(wt.worktree, 'DIRTY.txt'), 'uncommitted\n')

    const res = await cleanProjectWorktrees(proj)

    expect(res.removed).not.toContain(await canonicalize(wt.worktree))
    // A skipped (still-present) worktree keeps its trust — we only prune what we removed.
    expect(read().projects[wt.worktree]?.hasTrustDialogAccepted).toBe(true)
  })

  // SYMLINKED home: the seed key diverges from the swept (canonicalized) key.
  // createSwarmWorktree roots every worktree path at openGroundHome() VERBATIM,
  // so when the home is a SYMLINK the seed key is the un-resolved form — and
  // ensureClaudeFolderTrusted's pathKeys seeds that raw key AND its realpath (two
  // keys). The sweep only sees the resolved form (git reports already-resolved
  // paths, then listProjectWorktrees canonicalizes), so it must rebuild the raw
  // form to drop it too. Before the fix, pruning by the canonical wt.dir left the
  // raw-form key in ~/.claude.json forever. The realpath-isolated home above can't
  // catch this (path === realpath there), so this case pins a symlinked home.
  it('prunes BOTH the raw and resolved trust keys under a SYMLINKED home (no raw-form leak)', async () => {
    // Point OPENGROUND_HOME (+ claude's config) at a SYMLINK to the real dir, so
    // every worktree path is the un-resolved form — exactly the production shape
    // the realpath()'d setup above deliberately avoids. Set before any registry
    // call so the central worktrees dir is built from the symlinked root.
    const realHome = join(scratch, 'realhome')
    await mkdir(realHome, { recursive: true })
    const linkHome = join(scratch, 'linkhome')
    await symlink(realHome, linkHome)
    process.env.OPENGROUND_HOME = linkHome
    cfg = join(linkHome, '.claude.json')
    process.env.CLAUDE_CONFIG_PATH = cfg
    __resetMigrationCacheForTests()

    const { proj } = await registeredRepo()
    const wt = await createSwarmWorktree(proj)
    // wt.worktree is the RAW (linkHome-rooted) path launchClaude actually seeds;
    // pathKeys records it AND its realpath (the resolved, realHome-rooted form).
    ensureClaudeFolderTrusted(wt.worktree)
    const rawKey = wt.worktree
    const resolvedKey = await realpath(wt.worktree)
    expect(rawKey).not.toBe(resolvedKey) // the symlink really diverged the two
    expect(read().projects[rawKey]?.hasTrustDialogAccepted).toBe(true)
    expect(read().projects[resolvedKey]?.hasTrustDialogAccepted).toBe(true)

    const res = await cleanProjectWorktrees(proj)
    expect(res.removed).toContain(await canonicalize(wt.worktree))

    // BOTH forms cleared — the raw-form key no longer leaks under a symlinked home.
    expect(read().projects[rawKey]).toBeUndefined()
    expect(read().projects[resolvedKey]).toBeUndefined()
  })

  // A worktree the sweep CANNOT remove (locked → `git worktree remove` refuses,
  // yet the tree is CLEAN so it passes the dirty probe and actually reaches the
  // refused remove — the dirty-in-race shape) must be left WHOLLY untouched. The
  // prune deletes the ENTIRE projects[key] entry, so it may run ONLY after a
  // confirmed removal: a survivor keeps not just its trust flag but every field
  // claude owns on that entry (history / mcpServers / allowedTools / …), else its
  // next PTY launch re-hits the .mcp.json approval prompt. (Regression guard for a
  // prune-before-remove + lossy trust-only restore that wiped that state.)
  it('leaves a REFUSED (locked) worktree’s full entry intact — trust flag AND non-trust state', async () => {
    const { proj } = await registeredRepo()
    const wt = await createSwarmWorktree(proj)
    ensureClaudeFolderTrusted(wt.worktree)
    // Co-seed a NON-trust field claude owns on the SAME projects entry.
    const seeded = read()
    seeded.projects[wt.worktree].history = [{ display: 'prior session' }]
    await writeFile(cfg, JSON.stringify(seeded, null, 2))

    // Lock it: the tree stays clean (lock != dirty), so the sweep passes the
    // dirty probe and reaches `git worktree remove`, which then REFUSES it.
    await git(proj, ['worktree', 'lock', wt.worktree])

    const res = await cleanProjectWorktrees(proj)

    // Reported as skipped, never removed, still on disk.
    const canon = await canonicalize(wt.worktree)
    expect(res.removed).not.toContain(canon)
    expect(res.skippedDirty).toContain(canon)
    // Its FULL entry survives — the sweep never touched a worktree it couldn't remove.
    const after = read().projects[wt.worktree]
    expect(after?.hasTrustDialogAccepted).toBe(true)
    expect(after?.history).toEqual([{ display: 'prior session' }])
  })
})
