import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, symlink } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { integrateBranch } from './swarmIntegrate'
import {
  createSwarmWorktree,
  removeSwarmWorktree,
} from './swarmWorker'
import { isUnderCentralDir } from './worktreeCleanup'
import { centralWorktreesDir } from './paths'
import { canonicalize } from './canonicalize'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'

// ─────────────────────────────────────────────────────────────────────────────
// SWARM SAFETY NET — adversarial regression tests for the in-app swarm's git +
// teardown guards. The in-app counterpart of the tmux toolkit's
// ~/.claude/test-swarm-safety.sh (74 objective assertions): before the swarm can
// safely improve ITSELF, it needs a net that rejects a self-destroying change at
// the door. Each invariant is asserted against the REAL code with REAL git
// fixtures in a tmpdir (no mocks, no network), and is paired with a NEGATIVE
// CONTROL that performs the unsafe action directly — proving the green assertion
// has teeth (i.e. that "deliberately breaking it" really does go red).
//
// Invariants guarded here (full list + code map: docs/SWARM_SAFETY_INVARIANTS.md):
//
//   A — integration NEVER force-pushes: a non-fast-forward push is REJECTED
//       (status:'error'), never forced past, so a commit another worker landed on
//       the trunk between our fetch and our push is never clobbered.
//   B — worktree teardown only ever deletes a path strictly UNDER the project's
//       central worktrees dir; the main checkout, an out-of-central linked
//       worktree, and a symlink escaping central are all REFUSED — even with force.
//   D — a rebase CONFLICT aborts: nothing is pushed, the worker branch is left
//       untouched, no half-rebase remains, and the conflict is NEVER auto-resolved,
//       so a conflicting branch can never silently overwrite the trunk.
//
// (Invariant C — every /api/swarm route is owner-gated — lives in the routes
// test, server/routes/__tests__/swarmSafety.routes.test.ts, since it needs the
// Hono app.)
//
// HOME ISOLATION: OPENGROUND_HOME is pinned to a throwaway tmp dir per test (on
// top of the suite-wide setup-home.ts), so nothing here can read or write the
// real ~/.openground — the home-isolation invariant the whole suite enforces.
// ─────────────────────────────────────────────────────────────────────────────

vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)

/** git with an inline identity so fixtures need no ambient user.name/email and
 *  never sign commits — mirrors swarmIntegrate.test.ts / swarmJanitor.test.ts. */
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
let token = 0
const intDir = () => join(scratch, `integrate-${token++}`)

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-safety-')))
  // Pin HOME under the scratch dir AND reset the once-per-home migration cache, so
  // the registry (settings.json) the worktree-guard tests seed starts empty and
  // hermetic — exactly the pattern swarmOrchestrator.integration.test.ts uses. The
  // dir must EXIST before the registry's atomic settings.json write (no auto-mkdir).
  savedHome = process.env.OPENGROUND_HOME
  const home = join(scratch, 'home')
  await mkdir(home, { recursive: true })
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENGROUND_HOME
  else process.env.OPENGROUND_HOME = savedHome
  __resetMigrationCacheForTests()
  await rm(scratch, { recursive: true, force: true })
})

// ── fixtures (a bare "origin", a "project" clone, and an "other" clone to land a
//    competing commit on the trunk) — same shape as swarmIntegrate.test.ts ──────

async function makeRemote(): Promise<{ origin: string; project: string; other: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])
  // Permit the negative-control force-push regardless of a hostile GLOBAL git
  // config (a dev with receive.denyNonFastForwards=true would otherwise reject it).
  await git(origin, ['config', 'receive.denyNonFastForwards', 'false'])

  const seed = join(scratch, 'seed')
  await mkdir(seed)
  await git(seed, ['init', '-b', 'main'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await writeFile(join(seed, 'fileX'), 'base\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'C0'])
  await git(seed, ['push', 'origin', 'main'])

  const project = join(scratch, 'project')
  await git(scratch, ['clone', origin, project])
  const other = join(scratch, 'other')
  await git(scratch, ['clone', origin, other])
  return { origin, project, other }
}

/** Create `branch` off origin/main in `project` and commit `file=content` on it,
 *  via a temp worktree (mirrors how a real worker commits). Leaves
 *  refs/heads/<branch> at the new commit; the temp worktree is removed. */
async function commitOnBranch(
  project: string,
  branch: string,
  file: string,
  content: string,
  msg: string,
): Promise<void> {
  const wt = join(scratch, `wt-${branch.replace(/\//g, '-')}-${token++}`)
  await git(project, ['worktree', 'add', '-b', branch, wt, 'origin/main'])
  await writeFile(join(wt, file), content)
  await git(wt, ['add', '.'])
  await git(wt, ['commit', '-m', msg])
  await git(project, ['worktree', 'remove', '--force', wt])
}

/** Advance the trunk on origin via the `other` clone (a different worker landing
 *  first). Commits `file=content` on main and pushes. */
async function advanceTrunk(other: string, file: string, content: string, msg: string): Promise<void> {
  await git(other, ['pull', '--ff-only', 'origin', 'main'])
  await writeFile(join(other, file), content)
  await git(other, ['add', '.'])
  await git(other, ['commit', '-m', msg])
  await git(other, ['push', 'origin', 'main'])
}

const trunkTip = async (origin: string): Promise<string> =>
  (await git(origin, ['rev-parse', 'main'])).trim()

async function trunkHasFile(origin: string, file: string): Promise<boolean> {
  const out = await git(origin, ['ls-tree', '--name-only', 'main'])
  return out.split('\n').map((s) => s.trim()).includes(file)
}

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT A — integration never force-pushes; a non-FF push is REJECTED
// ═══════════════════════════════════════════════════════════════════════════
//
// The setup forces the FAST-FORWARD arm of integrateBranch to fire against a
// trunk that moved AFTER our clone's remote-tracking ref was last updated: the
// branch is a clean FF of the *stale* origin/main we hold, but origin's real main
// has a competing commit. A plain push is rejected as non-fast-forward; only a
// `--force` would (destructively) land it. integrateBranch must take the rejection.

describe('INVARIANT A — integration never force-pushes (non-FF push rejected)', () => {
  /** Branch swarm/ff off the trunk, then sneak a rival commit onto origin/main
   *  WITHOUT refreshing project's remote-tracking ref — so integrateBranch sees a
   *  clean fast-forward locally but the real push is non-FF. Returns the rival's
   *  trunk tip (what must survive) for assertions. */
  async function divergedAfterStaleFetch(): Promise<{
    origin: string
    project: string
    rivalTip: string
  }> {
    const { origin, project, other } = await makeRemote()
    await commitOnBranch(project, 'swarm/ff', 'a.txt', 'A\n', 'add a')
    // The rival lands on origin/main; project does NOT re-fetch, so its
    // refs/remotes/origin/main stays at C0 — making swarm/ff look like a clean FF.
    await advanceTrunk(other, 'rival.txt', 'R\n', 'rival commit on trunk')
    const rivalTip = await trunkTip(origin)
    return { origin, project, rivalTip }
  }

  it('A1 — rejects the non-FF push (status:error); the rival commit on the trunk survives untouched', async () => {
    const { origin, project, rivalTip } = await divergedAfterStaleFetch()

    const out = await integrateBranch(project, 'swarm/ff', { target: 'main', integrateDir: intDir() })

    // The push is rejected, NOT forced past — the engine surfaces an error and
    // retries on a later pass (when the trunk has been re-fetched).
    expect(out).toEqual({ status: 'error', reason: 'fast-forward push rejected' })
    // The invariant: the trunk is exactly where the rival left it — the rival's
    // commit is intact and our branch did NOT land. (If integrateBranch ever added
    // --force, the trunk tip would move to swarm/ff, rival.txt would vanish, and
    // out.status would be 'integrated' — all three of these flip this test RED.)
    expect(await trunkTip(origin)).toBe(rivalTip)
    expect(await trunkHasFile(origin, 'rival.txt')).toBe(true)
    expect(await trunkHasFile(origin, 'a.txt')).toBe(false)
  })

  it('A2 — NEGATIVE CONTROL: a force-push DOES destroy the rival commit (what A1 forbids)', async () => {
    const { origin, project, rivalTip } = await divergedAfterStaleFetch()

    // Prove the danger is real: the exact destructive operation A1's guard forbids.
    // A plain push here is rejected (non-FF) — only --force lands it, and doing so
    // silently discards the rival commit on the trunk.
    const plain = await git(project, ['push', 'origin', 'refs/heads/swarm/ff:refs/heads/main'])
      .then(() => 'accepted')
      .catch(() => 'rejected')
    expect(plain).toBe('rejected') // a NON-force push cannot land it — the trunk moved

    await git(project, ['push', '--force', 'origin', 'refs/heads/swarm/ff:refs/heads/main'])

    // The trunk has been rewound to our branch — the rival's commit is GONE. This
    // is precisely the data loss A1 proves integrateBranch refuses to cause.
    expect(await trunkTip(origin)).not.toBe(rivalTip)
    expect(await trunkHasFile(origin, 'rival.txt')).toBe(false)
    expect(await trunkHasFile(origin, 'a.txt')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT D — a merge conflict aborts; integration never continues through it
// ═══════════════════════════════════════════════════════════════════════════

describe('INVARIANT D — a rebase conflict aborts, never continues through it', () => {
  /** swarm/conf and the trunk both edit fileX differently → a guaranteed rebase
   *  conflict when integrateBranch tries to land the branch. */
  async function conflicting(): Promise<{ origin: string; project: string }> {
    const { origin, project, other } = await makeRemote()
    await commitOnBranch(project, 'swarm/conf', 'fileX', 'from-swarm\n', 'swarm edits X')
    await advanceTrunk(other, 'fileX', 'from-trunk\n', 'trunk edits X')
    await git(project, ['fetch', 'origin', 'main'])
    return { origin, project }
  }

  it('D1 — aborts on conflict: pushes nothing, leaves the trunk file as the trunk had it, no half-rebase', async () => {
    const { origin, project } = await conflicting()
    const branchTipBefore = (await git(project, ['rev-parse', 'refs/heads/swarm/conf'])).trim()
    const trunkBefore = await trunkTip(origin)
    const dir = intDir()

    const out = await integrateBranch(project, 'swarm/conf', { target: 'main', integrateDir: dir })

    // Conflict is REPORTED, not continued through. (A regression that auto-resolved
    // and pushed would return 'integrated' and move the trunk — flipping this RED.)
    expect(out).toEqual({ status: 'conflict', files: ['fileX'] })
    // Nothing was pushed: the trunk is untouched and still carries ITS OWN edit —
    // the swarm's conflicting version did not silently win.
    expect(await trunkTip(origin)).toBe(trunkBefore)
    expect((await git(origin, ['show', 'main:fileX']))).toBe('from-trunk\n')
    // The worker branch ref is untouched (no force, no rewrite), and nothing is
    // left half-rebased on disk (the throwaway integrate worktree is gone).
    expect((await git(project, ['rev-parse', 'refs/heads/swarm/conf'])).trim()).toBe(branchTipBefore)
    expect(existsSync(dir)).toBe(false)
    // The project repo itself is healthy (not wedged mid-rebase).
    expect((await git(project, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBeTruthy()
  })

  it('D2 — NEGATIVE CONTROL: continuing through the conflict (auto-resolve + push) overwrites the trunk (what D1 prevents)', async () => {
    const { origin, project } = await conflicting()
    const trunkBefore = await trunkTip(origin)

    // A merge that does NOT abort but auto-resolves the conflict in the branch's
    // favour (`-X theirs`) and pushes — the "continue through the conflict" failure
    // mode. It lands, silently discarding the trunk's concurrent edit on fileX.
    const wtMain = join(scratch, `wt-main-${token++}`)
    await git(project, ['worktree', 'add', wtMain, 'origin/main'])
    await git(wtMain, ['merge', '--no-edit', '-X', 'theirs', 'swarm/conf'])
    await git(wtMain, ['push', 'origin', 'HEAD:main'])
    await git(project, ['worktree', 'remove', '--force', wtMain])

    // The trunk moved and its fileX was overwritten with the swarm's version —
    // the user's concurrent edit on the trunk is gone. This is exactly the silent
    // corruption D1 proves integrateBranch refuses by aborting instead.
    expect(await trunkTip(origin)).not.toBe(trunkBefore)
    expect((await git(origin, ['show', 'main:fileX']))).toBe('from-swarm\n')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT B — worktree teardown only ever deletes inside the central dir
// ═══════════════════════════════════════════════════════════════════════════

describe('INVARIANT B — removeSwarmWorktree never deletes outside the central worktrees dir', () => {
  /** A real registered project (so projectUUIDFromPath / centralWorktreesDir
   *  resolve) with a real bare origin (so createSwarmWorktree can branch off
   *  origin/main). Returns the project path + its registry UUID + origin. */
  async function registeredRepo(): Promise<{ proj: string; uuid: string; origin: string }> {
    const origin = join(scratch, 'origin.git')
    await mkdir(origin)
    await git(origin, ['init', '--bare', '-b', 'main'])
  // Permit the negative-control force-push regardless of a hostile GLOBAL git
  // config (a dev with receive.denyNonFastForwards=true would otherwise reject it).
  await git(origin, ['config', 'receive.denyNonFastForwards', 'false'])
    const proj = join(scratch, 'proj')
    await mkdir(proj)
    await git(proj, ['init', '-b', 'main'])
    await git(proj, ['remote', 'add', 'origin', origin])
    await writeFile(join(proj, 'README.md'), '# base\n')
    await git(proj, ['add', '-A'])
    await git(proj, ['commit', '-m', 'base'])
    await git(proj, ['push', '-u', 'origin', 'main'])
    const entry = await addProjectEntry(proj) // registry: path → UUID, the central-dir key
    return { proj, uuid: entry.id, origin }
  }

  it('B1 — refuses to remove the project’s own MAIN checkout (never moves the user’s tree)', async () => {
    const { proj } = await registeredRepo()

    const res = await removeSwarmWorktree(proj, proj, { force: true })

    expect(res).toEqual({ removed: false, reason: 'not a central worktree' })
    // The real checkout — repo + working file — is entirely untouched.
    expect(existsSync(join(proj, '.git'))).toBe(true)
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
  })

  it('B2 — refuses an OUT-OF-CENTRAL linked worktree, and a symlink ESCAPING central — even with force', async () => {
    const { proj, uuid } = await registeredRepo()

    // (i) a legitimate git linked worktree that lives OUTSIDE the central dir.
    const rogue = join(scratch, 'rogue-wt')
    await git(proj, ['worktree', 'add', '-b', 'swarm/rogue', rogue, 'origin/main'])
    await writeFile(join(rogue, 'SENTINEL'), 'precious\n')
    const r1 = await removeSwarmWorktree(proj, rogue, { force: true })
    expect(r1).toEqual({ removed: false, reason: 'not a central worktree' })
    expect(existsSync(rogue)).toBe(true)
    expect(existsSync(join(rogue, 'SENTINEL'))).toBe(true)

    // (ii) the bare central ROOT itself is refused (it is the parent of all
    // worktrees, never a worktree to remove) — the `canon === central` arm.
    const central = centralWorktreesDir(uuid)
    await mkdir(central, { recursive: true })
    expect(await removeSwarmWorktree(proj, central, { force: true })).toEqual({
      removed: false,
      reason: 'not a central worktree',
    })

    // (iii) a symlink placed UNDER central that points OUTSIDE it — the guard
    // canonicalizes (follows the symlink) before judging, so the escape is refused
    // and the victim outside survives. The assertion matches the FULL outcome (not
    // just removed:false): a canonicalize→lexical regression would let the symlink
    // pass the prefix check and fail LATER in git with reason:'git refused' — only
    // the exact `reason:'not a central worktree'` proves the GUARD refused it (the
    // symlink-follow is defense-in-depth: removeSwarmWorktree only ever runs
    // `git worktree remove`, never rm, so a guard miss here fails safe in git too).
    const victim = join(scratch, 'outside-victim')
    await mkdir(victim)
    await writeFile(join(victim, 'KEEP'), 'do not delete\n')
    const escape = join(central, 'escape-link')
    await symlink(victim, escape)
    const r2 = await removeSwarmWorktree(proj, escape, { force: true })
    expect(r2).toEqual({ removed: false, reason: 'not a central worktree' })
    expect(existsSync(join(victim, 'KEEP'))).toBe(true)
  })

  it('B3 — DOES remove an in-central worktree (the guard distinguishes in/out, it is not always-refuse)', async () => {
    const { proj, uuid } = await registeredRepo()
    const central = centralWorktreesDir(uuid)

    // The real mint puts the worktree under the central dir.
    const wt = await createSwarmWorktree(proj)
    expect(existsSync(wt.worktree)).toBe(true)
    expect(isUnderCentralDir(await canonicalize(wt.worktree), await canonicalize(central))).toBe(true)

    const res = await removeSwarmWorktree(proj, wt.worktree, { force: true })

    expect(res).toEqual({ removed: true })
    expect(existsSync(wt.worktree)).toBe(false)
    // The main checkout was never in danger.
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
  })

  it('B4 — NEGATIVE CONTROL: an unguarded `git worktree remove` DOES delete the out-of-central tree (what B2 stops)', async () => {
    const { proj } = await registeredRepo()
    const rogue = join(scratch, 'rogue-wt-2')
    await git(proj, ['worktree', 'add', '-b', 'swarm/rogue2', rogue, 'origin/main'])
    await writeFile(join(rogue, 'SENTINEL'), 'precious\n')

    // The guard refuses it (out of central) — the tree is still there...
    expect((await removeSwarmWorktree(proj, rogue, { force: true })).removed).toBe(false)
    expect(existsSync(rogue)).toBe(true)

    // ...but the raw git operation a guard-LESS teardown would run deletes it.
    // Same path, same git — the central-only guard is the ONLY thing that saved it.
    await git(proj, ['worktree', 'remove', '--force', rogue])
    expect(existsSync(rogue)).toBe(false)
  })
})
