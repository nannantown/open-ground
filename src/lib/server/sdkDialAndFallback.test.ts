// @vitest-environment node
//
// TWO DEFECTS THAT SHARE ONE SHAPE: the owner is shown one thing and the server
// does another, with nothing anywhere saying so.
//
//   ① `sdkMaxWorkers: 0` — "keep the dial on sdk but run NO SDK workers" — was
//      thrown away by a falsy test in store.ts's normalizeRuntimeDial. The key
//      vanished from the persisted dial, the reader fell back to
//      DEFAULT_SDK_MAX_WORKERS (1), and the Swarm panel — which resolves the cap
//      with `cap >= 0` and therefore DISPLAYS 0 — promised something the server
//      had already discarded. No throw, no log, no way to notice.
//
//   ② a worker's SDK→PTY degrade named its reason only to `console.warn`. In a
//      packaged app the server is a forked child process, so that reason reaches
//      nobody. The owner flips the switch, watches PTY workers come up, and
//      cannot tell whether the cap was full, the preflight refused, or the dial
//      never took. This is not cosmetic: the slot-holding design (a
//      terminated-but-unwinding worker keeps its slot) was accepted BECAUSE
//      "the reason is displayed" — on the commander path it was, on the worker
//      path it was not, so the premise was false exactly where the cap bites.
//
// The two meet in the same place: with the cap at 0 every dispatch degrades, and
// a degrade nobody can see is indistinguishable from a broken switch.
//
// TEETH. ① goes through the PRODUCTION WRITER (setUserSettings — the function
// POST /api/settings calls, including its USER_SETTINGS_KEYS narrowing) and is
// read back through the PRODUCTION READERS (getWorkerRuntimeDial → sdkSlotLimit
// → chooseWorkerRuntime). Asserting "the write returned ok" is what let the
// original defect ship. ② drives the real git paths (real repo, real
// `git worktree add`) through spawnSwarmWorker and asserts on the RETURNED
// RESPONSE — the only surface the UI can ever read.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// Per-test control over the two things that decide a degrade: whether the
// preflight passes, and whether the SDK session survives its own spawn.
const LIVE_PREFLIGHT = {
  ok: true,
  problems: [] as string[],
  claudeBin: '/usr/local/bin/claude' as string | null,
  cliVersion: '2.1.220' as string | null,
}
const liveSession = (cwd: string) => ({
  id: 'sdk-live',
  cwd,
  status: 'working' as string,
  exitReason: undefined as string | undefined,
  startedAt: 0,
  lastEventAt: 0,
  seq: 0,
})

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  preflight: vi.fn(),
  spawnSdkSession: vi.fn(),
}))

vi.mock('./claudeTerminal', () => ({ launchClaude: mocks.launchClaude }))
vi.mock('./hooksInstall', () => ({ ensureGuardWiring: async () => ({ ok: true, problems: [] }) }))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async () => ({ model: 'sonnet', effort: 'medium' }),
  resolveSwarmRemoteName: async () => 'worker',
}))
vi.mock('./swarmWorkerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmWorkerSdk')>()),
  sdkWorkerPreflight: mocks.preflight,
  sdkWorkerLaunchPlan: () => ({ options: {}, initialPrompt: '/order go', warnings: [] }),
}))
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: mocks.spawnSdkSession,
}))

import { spawnSwarmWorker } from './swarmWorker'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings, setUserSettings, getSettings, getWorkerRuntimeDial } from './store'
import { __resetSdkSessionsForTests } from './sdkSession'
import {
  chooseWorkerRuntime,
  sdkSlotLimit,
  DEFAULT_SDK_MAX_WORKERS,
} from './swarmWorkerRuntimeDial'

/** The exact slice chooseWorkerRuntime / sdkSlotLimit take, read through the
 *  PRODUCTION dial reader — never re-assembled by hand in the test, because a
 *  fixture built from the value under test proves nothing about the reader. */
const dialSettings = async () => ({ swarmWorkerRuntime: await getWorkerRuntimeDial() })

// ─── ① the cap round trip ────────────────────────────────────────────────────
// No repo needed: this is purely writer → reader → decision.
//
// `setUserSettings` IS the POST /api/settings body handler — the route
// (server/routes/misc.ts) is a thin adapter over it, and the USER_SETTINGS_KEYS
// allowlist that silently eats unlisted keys lives inside it. That the route
// reaches this function at all is pinned separately, by
// server/routes/__tests__/settingsRuntimeDials.test.ts.

describe('sdkMaxWorkers survives the POST /api/settings narrowing — 0 included', () => {
  afterEach(async () => {
    await setSettings({ swarmWorkerRuntime: { mode: 'pty' } })
  })

  it('0 is STORED and READ BACK as 0 — the panel and the server agree', async () => {
    const applied = await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 0 } })
    // "the route accepted it" is exactly the evidence that was not enough.
    expect(applied).toContain('swarmWorkerRuntime')

    // THE assertion: the reader the spawn path consults.
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 0 })
    // …and the budget the dial actually enforces. Before the fix this was 1:
    // the owner set "no SDK workers", the panel showed 0, and one SDK worker
    // kept being seated on every dispatch.
    expect(sdkSlotLimit(await dialSettings())).toBe(0)
  })

  it('a 0 cap really stops SDK dispatch, and says why', async () => {
    // The setting only means something if it reaches the decision. An empty pool
    // is the interesting case: live 0 vs limit 0 must still refuse, otherwise
    // "no SDK workers" only holds while one is already running.
    await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 0 } })
    const c = chooseWorkerRuntime({
      settings: await dialSettings(),
      workers: [],
      worktree: '/wt/next',
      poolSessions: () => [],
      preflight: () => ({ ok: true, problems: [], claudeBin: '/bin/claude', cliVersion: '2.1.220' }) as never,
    })
    expect(c.runtime).toBe('pty')
    expect(c.fellBackBecause).toMatch(/slots are full \(0\/0\)/)
  })

  it('an ordinary cap still round-trips, and a fraction floors to a whole count', async () => {
    await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 3 } })
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 3 })

    // Floored rather than refused, because the READER floors too (sdkSlotLimit).
    // If the writer refused what the reader accepts, the same number would mean
    // two different things depending on whether it arrived by POST or by a
    // hand-edited settings.json — and this dial is one people hand-edit.
    await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 2.7 } })
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 2 })

    // The nastiest fraction: it floors INTO the meaningful 0, not away from it.
    await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 0.5 } })
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 0 })

    // A large finite cap is honoured verbatim. There is deliberately NO ceiling:
    // a silly-large cap only ever means "do not cap", and every worker it admits
    // still has to clear the SDK preflight.
    await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 1_000_000 } })
    expect(sdkSlotLimit(await dialSettings())).toBe(1_000_000)
  })

  it('a cap that is not a count is dropped — the mode survives, the budget defaults', async () => {
    for (const cap of [-1, -0.4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '4', null, {}, []]) {
      await setUserSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: cap } })
      // Dropping the CAP must not drop the MODE: the owner asked for the SDK and
      // a bad number is no reason to silently turn the experiment off.
      expect(await getWorkerRuntimeDial(), JSON.stringify(cap)).toEqual({ mode: 'sdk' })
      expect(sdkSlotLimit(await dialSettings()), JSON.stringify(cap)).toBe(DEFAULT_SDK_MAX_WORKERS)
    }
  })

  it('the commander dial still has no cap — one desk, nothing to budget', async () => {
    // 0 must not sneak a meaningless field onto the OTHER dial while making it
    // meaningful on the worker one: there is exactly one commander desk, so no
    // reader ever consults a budget here.
    await setUserSettings({ swarmManagerRuntime: { mode: 'sdk', sdkMaxWorkers: 0 } })
    expect((await getSettings()).swarmManagerRuntime).toEqual({ mode: 'sdk' })
    await setUserSettings({ swarmManagerRuntime: { mode: 'pty' } })
  })
})

// ─── ② the degrade reason reaches the caller ─────────────────────────────────

describe('a worker that falls back to PTY says WHY, on the response', () => {
  let scratch: string
  let project: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.launchClaude.mockImplementation(() => ({ terminalId: 'pty-1' }))
    mocks.preflight.mockReturnValue({ ...LIVE_PREFLIGHT })
    mocks.spawnSdkSession.mockImplementation((o: { cwd: string }) => liveSession(o.cwd))
    __resetSdkSessionsForTests()
    __resetMigrationCacheForTests?.()
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sdkdial-')))
    project = join(scratch, 'proj')
    await git(scratch, ['init', '-q', '-b', 'main', 'proj'])
    await git(project, ['config', 'user.email', 'dev@test'])
    await git(project, ['config', 'user.name', 'Dev'])
    await writeFile(join(project, 'README.md'), '# x\n')
    await git(project, ['add', '-A'])
    await git(project, ['commit', '-q', '-m', 'base'])
    await addProjectEntry(project)
    await setSettings({ swarmWorkerRuntime: { mode: 'sdk' } })
  })

  afterEach(async () => {
    __resetSdkSessionsForTests()
    await setSettings({ swarmWorkerRuntime: { mode: 'pty' } })
    await rm(scratch, { recursive: true, force: true })
  })

  it('slots full (a 0 cap) — a PTY worker AND the reason, not just a log line', async () => {
    await setSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 0 } })
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })

    // Degrading is correct — a worker on the known-good runtime beats no worker.
    expect(res.runtime ?? 'pty').toBe('pty')
    expect(res.terminalId).toBe('pty-1')
    // …and the owner can find out why, which is the whole point.
    expect(res.fellBackBecause).toMatch(/slots are full \(0\/0\)/)
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
  })

  it('a refused preflight names its problems on the response', async () => {
    mocks.preflight.mockReturnValue({
      ok: false,
      problems: ['guard did not deny a write outside the worktree'],
      claudeBin: null,
      cliVersion: null,
    })
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })

    expect(res.runtime ?? 'pty').toBe('pty')
    expect(res.fellBackBecause).toContain('guard did not deny')
    expect(mocks.spawnSdkSession).not.toHaveBeenCalled()
  })

  it('an SDK session that dies at start reports its exit reason', async () => {
    // This degrade is decided INSIDE spawnSwarmWorker, not in chooseWorkerRuntime,
    // so it had to be attached to the response by hand — and it is the one the
    // owner is most likely to meet right after flipping the switch (a missing
    // @anthropic-ai/claude-agent-sdk, a query() that throws on boot).
    mocks.spawnSdkSession.mockImplementation((o: { cwd: string }) => ({
      ...liveSession(o.cwd),
      id: 'sdk-dead',
      status: 'failed',
      exitReason: 'spawn failed: require blew up',
    }))
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })

    expect(res.runtime ?? 'pty').toBe('pty')
    expect(res.terminalId).toBe('pty-1')
    expect(res.sdkSessionId).toBeUndefined()
    expect(res.fellBackBecause).toContain('require blew up')
    // Proof this is a FALL-THROUGH and not a skip: the SDK spawn really was
    // attempted, in the same worktree the PTY then took over.
    expect(mocks.spawnSdkSession).toHaveBeenCalledTimes(1)
  })

  it('the dial OFF is not a fallback — no reason, no noise', async () => {
    // The other half of the rule. `fellBackBecause` must mean "you asked for the
    // SDK and did not get it"; if it appeared on every ordinary PTY dispatch the
    // UI would show an error banner on a completely healthy default install.
    await setSettings({ swarmWorkerRuntime: { mode: 'pty' } })
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })

    expect(res.runtime ?? 'pty').toBe('pty')
    expect(res.fellBackBecause).toBeUndefined()
  })

  it('a successful SDK worker carries no reason either', async () => {
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })

    expect(res.runtime).toBe('sdk')
    expect(res.sdkSessionId).toBe('sdk-live')
    // terminalId is EMPTY for an SDK worker (pty ⇔ terminalId / sdk ⇔ sdkSessionId).
    expect(res.terminalId).toBe('')
    expect(res.fellBackBecause).toBeUndefined()
  })
})
