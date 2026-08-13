// swarmEngineSdkBlindspots — the engine's own blind spots toward the SECOND desk
// pool (Agent SDK), 2026-08-01.
//
// The SDK runtime landed as a peer of the PTY runtime, and three engine-side
// mechanisms kept looking at only one of them. Every one of these failures is
// SILENT by construction — nothing throws, nothing logs, a gate simply does not
// fire — so each needs a test that would be RED without the fix, not a test that
// merely exercises the happy path.
//
//  ① the swarm SELF-MODIFICATION gate (SWARM_CODE_PATHS / touchesSwarmPaths) did
//     not match a single SDK-runtime file, so a branch rewriting the SDK desk
//     pool auto-merged without the swarm-safety suite ever running against it;
//  ② the SDK commander desk had no death-on-arrival learning — a spent tier was
//     never cooled and a one-line-refusal session was never forgotten, both of
//     which the PTY commander has had since the 2026-07-19 four-desk burn;
//  ③ the boot RESUME path's runtime-degrade notice had no coverage at all: the
//     `noteRuntimeFallback` call in adoptResumeCandidates could be deleted and
//     the whole suite stayed green (measured).
//
// ④ is the negative finding: OrchestratorDeps.instructRework has no caller, and
//    the reason is dead plumbing rather than a lost message. Pinned so the dead
//    PTY-keyed conduit is not silently re-wired.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// PARTIAL mocks only (importOriginal spread): every other export of these modules
// stays REAL, so the disk/engine tests below run against production code. Only the
// three things a commander launch would otherwise do for real are replaced — spawn
// an SDK session, spawn a PTY, and mark a tier cooling on the shared quota table.
const wire = vi.hoisted(() => ({
  spawnSdkSession: vi.fn(),
  attachSdkListener: vi.fn(),
  // Params are DECLARED (not `vi.fn()`) so the assertions below can read
  // mock.calls[0][0] and toHaveBeenCalledWith(…) without fighting the types.
  markRateLimited: vi.fn(
    (_tier: string, _opts: { ptyText?: string | null; now: number }): number => 0,
  ),
  forgetSwarmSessionIf: vi.fn(
    async (_projectPath: string, _role: string, _sessionId: string): Promise<boolean> => true,
  ),
  launchClaude: vi.fn(() => ({ terminalId: 'term-fallback' })),
  sdkManagerPreflight: vi.fn(),
  recordSwarmSession: vi.fn(async () => {}),
  resolveSwarmSession: vi.fn(async () => ({ agentSessionId: 'agent-sid-e2e', resume: false })),
  installOgManageSkill: vi.fn(async () => ({ outcome: 'installed' as const, path: '/tmp/skill' })),
}))
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: wire.spawnSdkSession,
  attachSdkListener: wire.attachSdkListener,
}))
vi.mock('./swarmQuota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmQuota')>()),
  markRateLimited: wire.markRateLimited,
}))
vi.mock('./claudeTerminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeTerminal')>()),
  launchClaude: wire.launchClaude,
}))
vi.mock('./swarmManagerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmManagerSdk')>()),
  sdkManagerPreflight: wire.sdkManagerPreflight,
  sdkManagerLaunchPlan: () => ({ options: {}, initialPrompt: '/og-manage', warnings: [] }),
}))
vi.mock('./swarmSessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmSessions')>()),
  resolveSwarmSession: wire.resolveSwarmSession,
  recordSwarmSession: wire.recordSwarmSession,
  forgetSwarmSessionIf: wire.forgetSwarmSessionIf,
}))
vi.mock('./ogManageSkill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ogManageSkill')>()),
  installOgManageSkill: wire.installOgManageSkill,
}))
// resumeEngines calls claudeRunPreflight() DIRECTLY (not through deps) and skips
// the whole project when it is not ok. Left real, ③ below would silently depend on
// the host having a healthy `claude` on PATH — green alone on this machine, red
// under load or on CI, and red for the WRONG reason (no resume ⇒ no log line).
vi.mock('./claudePreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudePreflight')>()),
  claudeRunPreflight: async () => ({ ok: true }),
}))
// The tier resolver PROBES by spawning a headless `claude` — never in a unit test.
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async () => ({ model: 'opus', effort: 'max' as const }),
  resolveSwarmRemoteName: async () => 'manager',
}))

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { writeFile, rm, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  touchesSwarmPaths,
  defaultDeps,
  resumeEngines,
  getOrchestratorState,
  __resetOrchestratorForTests,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { watchSdkDeskForDeathOnArrival, DESK_DOA_WINDOW_MS, spawnSwarmManager } from './swarmManager'
import { setSettings } from './store'
import type { SdkStreamFrame } from './sdkSession'
import type { SdkEvent } from './sdkEvents'
import { writeEngineIntent } from './swarmEnginePersistence'
import { SdkWorkerUnavailableError } from './swarmWorkerSdk'
import { listSwarmNotifications } from './swarmNotifications'
import { swarmNotificationsFile } from './paths'
import { canonicalize } from './canonicalize'
import { forgetSwarmManualStop } from './store'
import { settingsFile, engineBootsFile } from './paths'

vi.setConfig({ testTimeout: 60_000 })

// ── ① the self-modification gate's membership criterion ──────────────────────
//
// SWARM_CODE_PATHS is a list of path regexes, and a list of names rots. The
// criterion it approximates is written in its header; these tests RE-DERIVE that
// criterion from the working tree, so a file that joins either family without a
// matching pattern turns this file RED — which is the whole point (a plain
// enumeration test would only re-state the list back to itself).

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Files DIRECTLY under `dir` (no recursion — the patterns are dir-anchored). */
const filesIn = (dir: string): string[] => {
  const abs = join(repoRoot, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => `${dir}/${d.name}`)
}

/** The dirs the naming convention is anchored to. */
const CONVENTION_DIRS = [
  'src/lib/server',
  'server/routes',
  'server/routes/__tests__',
  'src/components/canvas/modules',
]

/** The desk-runtime seams. Importing ANY of these means the file can change how a
 *  live desk behaves: sdkSession = the SDK pool, workerRuntime = the pty⇔sdk
 *  dispatcher, liveDesks = the ask-BOTH-pools seam. */
const SEAMS = ['sdkSession', 'workerRuntime', 'liveDesks']
const SEAM_SPECIFIERS = SEAMS.flatMap((m) => [`'./${m}'`, `'@/lib/server/${m}'`])

describe('① SWARM_CODE_PATHS — the swarm self-modification gate must see the SDK runtime', () => {
  it('family (a): EVERY sdk*/Sdk*-named file on disk, in every convention dir, trips the gate', () => {
    const named = CONVENTION_DIRS.flatMap(filesIn).filter((p) => {
      const base = p.slice(p.lastIndexOf('/') + 1)
      return /^sdk/i.test(base)
    })
    // Sanity: the scan actually found the runtime (a broken scan must not pass by
    // finding nothing).
    expect(named).toContain('src/lib/server/sdkSession.ts')
    expect(named).toContain('src/lib/server/sdkEvents.ts')
    expect(named).toContain('src/lib/server/sdkGuardHook.ts')
    expect(named).toContain('server/routes/sdkSession.ts')
    expect(named).toContain('src/components/canvas/modules/SdkWorkerPane.tsx')
    expect(named.length).toBeGreaterThanOrEqual(10)

    const missed = named.filter((p) => !touchesSwarmPaths([p]))
    expect(missed).toEqual([])
  })

  it('family (b): every SERVER file that imports a desk-runtime seam trips the gate', () => {
    const serverFiles = ['src/lib/server', 'server/routes', 'server/routes/__tests__']
      .flatMap(filesIn)
      .filter((p) => p.endsWith('.ts'))
    const importers = serverFiles.filter((p) => {
      const src = readFileSync(join(repoRoot, p), 'utf8')
      return SEAM_SPECIFIERS.some((s) => src.includes(s))
    })
    // The two members of (b) that the naming convention does NOT cover — the
    // reason family (b) is checked from disk at all.
    expect(importers).toContain('src/lib/server/worktreeCleanup.ts')
    expect(importers).toContain('server/routes/terminal.ts')

    const missed = importers.filter((p) => !touchesSwarmPaths([p]))
    expect(missed).toEqual([])
  })

  it('the SDK patterns are a CRITERION, not an enumeration — a file that does not exist yet is already covered', () => {
    // If someone ever replaces the prefix patterns with an explicit list of
    // today's filenames, these go red: that is the regression this pins.
    expect(touchesSwarmPaths(['src/lib/server/sdkBrandNewThing.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/sdkBrandNewThing.test.ts'])).toBe(true)
    expect(touchesSwarmPaths(['server/routes/sdkBrandNewRoute.ts'])).toBe(true)
    expect(touchesSwarmPaths(['server/routes/__tests__/sdkBrandNew.test.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/components/canvas/modules/SdkBrandNewPane.tsx'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/workerRuntime.ts'])).toBe(true)
    expect(touchesSwarmPaths(['src/lib/server/liveDesks.ts'])).toBe(true)
  })

  it('the widening stayed anchored — unrelated files still do NOT pay for the swarm gate', () => {
    // Guards the other direction: matching everything is as useless as matching
    // nothing (every branch would run the swarm suite and the signal would be
    // renamed noise). These mirror the negatives pinned in the integration test.
    expect(touchesSwarmPaths(['src/lib/server/projectData.ts'])).toBe(false)
    expect(touchesSwarmPaths(['src/components/canvas/modules/BoardModule.tsx'])).toBe(false)
    expect(touchesSwarmPaths(['src/lib/server/sub/sdkX.ts'])).toBe(false) // not directly under the dir
    expect(touchesSwarmPaths(['docs/sdkSession.ts'])).toBe(false) // wrong dir
    expect(touchesSwarmPaths(['src/lib/server/canvasData.ts'])).toBe(false)
    expect(touchesSwarmPaths([])).toBe(false)
  })
})

// ── ② the SDK commander desk's death-on-arrival learning ─────────────────────

type Attach = Parameters<typeof watchSdkDeskForDeathOnArrival>[5] extends { attach?: infer A }
  ? NonNullable<A>
  : never

/** A fake SDK session stream: hands the watch a listener and lets the test emit
 *  frames onto it. `replay` is empty (the buffer had nothing when we attached). */
const fakeStream = (): {
  attach: Attach
  emit: (ev: SdkEvent) => void
  attachCount: () => number
  seedReplay: (ev: SdkEvent) => void
} => {
  const listeners: ((f: SdkStreamFrame) => void)[] = []
  const replay: SdkStreamFrame[] = []
  let seq = 0
  let attached = 0
  const attach = ((_id: string, _fromSeq: number, cb: (f: SdkStreamFrame) => void) => {
    attached += 1
    listeners.push(cb)
    // `replay` carries what the ring buffer ALREADY holds. Seeding it is the
    // only way to test the arm-after-await contract the caller depends on.
    return { replay: replay.slice(), truncated: false, detach: () => {} }
  }) as unknown as Attach
  return {
    attach,
    emit: (ev: SdkEvent) => {
      seq += 1
      for (const l of [...listeners]) l({ seq, ev })
    },
    attachCount: () => attached,
    /** Put a frame in the buffer BEFORE anyone subscribes. */
    seedReplay: (ev: SdkEvent) => {
      seq += 1
      replay.push({ seq, ev })
    },
  }
}

/** The attested CLI refusal wording (the 2026-07-19 corpus). */
const REFUSAL = "You've reached your Fable 5 limit. Resets at 3:00pm. Switch models with /model"

describe('② the SDK 司令官卓 learns from its own corpse (tier cooling + stale session pointer)', () => {
  const armed = (
    over: {
      tier?: string
      wasResumed?: boolean
      now?: () => number
    } = {},
  ) => {
    const stream = fakeStream()
    const marks: { tier: string; text: string | null | undefined }[] = []
    const forgets: { path: string; role: string; sessionId: string }[] = []
    const detach = watchSdkDeskForDeathOnArrival(
      'sdk-sess-1',
      over.tier ?? 'fable',
      '/proj/a',
      'agent-sid-1',
      over.wasResumed ?? false,
      {
        attach: stream.attach,
        now: over.now ?? (() => 1_000_000),
        mark: (tier, opts) => {
          marks.push({ tier, text: opts.ptyText })
          return opts.now + 20 * 60_000
        },
        forget: async (path, role, sessionId) => {
          forgets.push({ path, role, sessionId })
          return true
        },
      },
    )
    return { stream, marks, forgets, detach }
  }

  /** What death looks like on the SDK stream: the pool announces the terminal
   *  status once the pump has unwound. */
  const died = (a: { stream: { emit: (ev: SdkEvent) => void } }) =>
    a.stream.emit({ kind: 'status', status: 'exited' })

  it('A REFUSAL ALONE CHANGES NOTHING — the desk is parked, not dead', () => {
    // The defect this replaced: firing on the refusal frame by itself. An SDK
    // desk does not die when it is refused ("The desk keeps running" —
    // sdkDeskLimit.ts), and `quota-parked` has documented exits back to working.
    // So the first cut cooled the tier for a LIVE commander and — the part that
    // actually costs — deleted the session pointer of a conversation that was
    // still running.
    const a = armed()
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    expect(a.marks).toEqual([])
    expect(a.forgets).toEqual([])
  })

  it('a refusal FOLLOWED BY DEATH inside the birth window cools the tier', () => {
    const a = armed()
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    died(a)
    expect(a.marks).toHaveLength(1)
    expect(a.marks[0].tier).toBe('fable')
    // The refusal text itself reaches the cooling resolver, so "Resets at
    // 3:00pm" can set the deadline instead of the bare grace.
    expect(a.marks[0].text).toBe(REFUSAL)
  })

  it('a death with NO refusal says nothing about the tier', () => {
    // The polarity rule, at the layer that can actually enforce it: "the desk
    // died young" is not evidence, "the desk SAID the tier is spent" is.
    const a = armed()
    died(a)
    expect(a.marks).toEqual([])
    expect(a.forgets).toEqual([])
  })

  it('EVERY refusal wording Anthropic ships cools the tier — not just the two a private regex liked', () => {
    // Regression guard for the second gate that used to sit here:
    // `matchesQuotaExhaustion(normalizeScreen(raw))`, a PRIVATE MIRROR of the
    // wording written for the PTY path because pixels are all it has. Measured
    // 2026-08-01: of six realistic refusal sentences it passed two, silently
    // dropping the entire credit-exhaustion family. The SDK path already
    // matched against Anthropic's own exported prefix list before the event was
    // ever emitted, so the second gate could only subtract.
    for (const raw of [
      "You're out of usage credits. Add funds to continue.",
      'Fable 5 requires usage credits. Add funds to continue.',
      "You're out of extra usage. Your limit resets at midnight.",
    ]) {
      const a = armed()
      a.stream.emit({ kind: 'quota_refusal', raw })
      died(a)
      expect(a.marks, raw).toHaveLength(1)
      expect(a.marks[0].text).toBe(raw)
    }
  })

  it('a FRESH desk that died quoting a refusal also FORGETS its session pointer (else the next launch --resumes a one-line transcript)', () => {
    const a = armed({ wasResumed: false })
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    died(a)
    expect(a.forgets).toEqual([{ path: '/proj/a', role: 'manager', sessionId: 'agent-sid-1' }])
  })

  it('a RESUMED desk is NEVER forgotten — its transcript is weeks of integration history plus one refusal line', () => {
    const a = armed({ wasResumed: true })
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    died(a)
    expect(a.marks).toHaveLength(1) // the tier is still cooled…
    expect(a.forgets).toEqual([]) // …but the --resume pointer survives
  })

  it('a refusal ALREADY in the ring buffer still counts — the caller may arm after its awaits', () => {
    // The one line that makes the wiring position legal: `sub.replay.forEach`.
    // Its own comment is what permits arming the watch AFTER the spawn's awaits,
    // and deleting it left every test green because the fake replay was always
    // empty — so nothing pinned the reason the wiring is where it is.
    const stream = fakeStream()
    stream.seedReplay({ kind: 'quota_refusal', raw: REFUSAL })
    const marks: { tier: string }[] = []
    watchSdkDeskForDeathOnArrival('sdk-sess-1', 'fable', '/proj/a', 'agent-sid-1', false, {
      attach: stream.attach,
      now: () => 1_000_000,
      mark: (tier, opts) => {
        marks.push({ tier })
        return opts.now + 20 * 60_000
      },
      forget: async () => true,
    })
    stream.emit({ kind: 'status', status: 'exited' })
    expect(marks).toHaveLength(1)
  })

  it('a refusal AFTER the birth window says nothing about the launch — no cooling, no forget', () => {
    let clock = 1_000_000
    const a = armed({ now: () => clock })
    clock += DESK_DOA_WINDOW_MS + 1
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    a.stream.emit({ kind: 'status', status: 'exited' })
    expect(a.marks).toEqual([])
    expect(a.forgets).toEqual([])
  })

  it('POLARITY LIVES UPSTREAM — a 529 never reaches here AS a refusal, and as itself it is inert', () => {
    // The previous version of this test fed `{kind:'quota_refusal', raw:'API
    // Error: 529 …'}`, which the distiller cannot produce: a `quota_refusal`
    // event exists only because the text already matched Anthropic's exported
    // prefix list (sdkEvents.matchesQuotaRefusal). Asserting the polarity rule
    // again HERE, on an input production cannot deliver, is how the second gate
    // got justified — and that gate then dropped four real wordings. The rule is
    // real; it is enforced one layer up, and this file's job is what happens
    // AFTER a genuine refusal.
    const a = armed()
    a.stream.emit({ kind: 'api_error', status: 529, head: 'overloaded_error' })
    a.stream.emit({ kind: 'status', status: 'failed' })
    expect(a.marks).toEqual([])
    expect(a.forgets).toEqual([])
  })

  it('non-refusal traffic on the stream is inert', () => {
    const a = armed()
    a.stream.emit({ kind: 'text', text: REFUSAL }) // the desk merely TALKING about a limit
    a.stream.emit({ kind: 'api_error', status: 529, head: 'overloaded' })
    expect(a.marks).toEqual([])
    expect(a.forgets).toEqual([])
  })

  it('only ONE mark per desk, however many times the refusal repeats', () => {
    const a = armed()
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    a.stream.emit({ kind: 'quota_refusal', raw: REFUSAL })
    a.stream.emit({ kind: 'status', status: 'exited' })
    a.stream.emit({ kind: 'status', status: 'failed' })
    expect(a.marks).toHaveLength(1)
    expect(a.forgets).toHaveLength(1)
  })

  it('an arbitrary (non-ladder) model string never cools anything, and never even subscribes', () => {
    const stream = fakeStream()
    const detach = watchSdkDeskForDeathOnArrival(
      'sdk-sess-1',
      'some-custom-model',
      '/proj/a',
      'agent-sid-1',
      false,
      { attach: stream.attach, now: () => 1_000_000, mark: () => 0, forget: async () => true },
    )
    expect(detach).toBeNull()
    expect(stream.attachCount()).toBe(0)
  })
})

describe('②-wiring: launchSdkDesk actually ARMS the death-on-arrival watch', () => {
  // The unit tests above prove the watcher WORKS. This one proves it is CONNECTED:
  // delete the call in launchSdkDesk and the watcher above still passes every test
  // while a real SDK commander learns nothing. Both halves are needed.
  beforeEach(async () => {
    vi.clearAllMocks()
    wire.launchClaude.mockImplementation(() => ({ terminalId: 'term-fallback' }))
    wire.markRateLimited.mockImplementation(() => 0)
    wire.forgetSwarmSessionIf.mockImplementation(async () => true)
    wire.recordSwarmSession.mockImplementation(async () => {})
    wire.resolveSwarmSession.mockImplementation(async () => ({
      agentSessionId: 'agent-sid-e2e',
      resume: false,
    }))
    wire.installOgManageSkill.mockImplementation(async () => ({
      outcome: 'installed' as const,
      path: '/tmp/skill',
    }))
    wire.sdkManagerPreflight.mockReturnValue({
      ok: true,
      problems: [],
      claudeBin: '/usr/local/bin/claude',
      cliVersion: '2.1.220',
    })
    await setSettings({ swarmManagerRuntime: { mode: 'sdk' } })
  })

  it('an SDK commander that refuses on arrival cools its tier and drops its session pointer', async () => {
    const listeners: ((f: SdkStreamFrame) => void)[] = []
    wire.attachSdkListener.mockImplementation(
      (_id: string, _from: number, cb: (f: SdkStreamFrame) => void) => {
        listeners.push(cb)
        return { replay: [], truncated: false, detach: () => {} }
      },
    )
    wire.spawnSdkSession.mockReturnValue({
      id: 'sdk-e2e-1',
      cwd: '/repo/alpha',
      role: 'manager',
      agentSessionId: 'agent-sid-e2e',
      status: 'running',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      seq: 0,
    })

    const r = await spawnSwarmManager({ projectPath: '/repo/alpha' })
    expect(r.runtime).toBe('sdk') // the SDK desk was seated (not a fallback)
    expect(listeners.length).toBeGreaterThanOrEqual(2) // owner-notice watch + DOA watch

    // The tier dries up 2 seconds in — the 2026-07-19 shape — and the desk then
    // ENDS. Both frames are required: a refusal alone leaves a PARKED desk that
    // is still running, and treating that as a corpse deletes a live
    // commander's session pointer.
    for (const cb of [...listeners]) cb({ seq: 1, ev: { kind: 'quota_refusal', raw: REFUSAL } })
    expect(wire.markRateLimited).not.toHaveBeenCalled() // …not yet: still alive
    for (const cb of [...listeners]) cb({ seq: 2, ev: { kind: 'status', status: 'exited' } })

    expect(wire.markRateLimited).toHaveBeenCalledTimes(1)
    expect(wire.markRateLimited.mock.calls[0][0]).toBe('opus') // whatever tier the probe seated
    expect(wire.forgetSwarmSessionIf).toHaveBeenCalledWith(
      '/repo/alpha',
      'manager',
      'agent-sid-e2e',
    )
  })

  it('the RESUME flag reaches the watch — a resumed commander keeps its pointer through a DOA refusal', async () => {
    // Pins the 5th argument at the WIRING. The unit tests above call the watch
    // directly, so replacing `session.resume` with a literal `false` in
    // launchSdkDesk left all of them green — and that mutation trades a working
    // `--resume` for a wiped memory: the next launch mints a commander that has
    // forgotten everything instead of resuming one that remembers everything
    // but a refusal.
    wire.resolveSwarmSession.mockImplementation(async () => ({
      agentSessionId: 'agent-sid-e2e',
      resume: true,
    }))
    const listeners: ((f: SdkStreamFrame) => void)[] = []
    wire.attachSdkListener.mockImplementation(
      (_id: string, _from: number, cb: (f: SdkStreamFrame) => void) => {
        listeners.push(cb)
        return { replay: [], truncated: false, detach: () => {} }
      },
    )
    wire.spawnSdkSession.mockReturnValue({
      id: 'sdk-e2e-3',
      cwd: '/repo/alpha',
      role: 'manager',
      agentSessionId: 'agent-sid-e2e',
      status: 'running',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      seq: 0,
    })

    const r = await spawnSwarmManager({ projectPath: '/repo/alpha' })
    expect(r.runtime).toBe('sdk')
    for (const cb of [...listeners]) cb({ seq: 1, ev: { kind: 'quota_refusal', raw: REFUSAL } })
    for (const cb of [...listeners]) cb({ seq: 2, ev: { kind: 'status', status: 'exited' } })

    expect(wire.markRateLimited).toHaveBeenCalledTimes(1) // the tier is still cooled…
    expect(wire.forgetSwarmSessionIf).not.toHaveBeenCalled() // …and the memory survives
  })

  it('a healthy SDK commander cools nothing (the watch is armed, not trigger-happy)', async () => {
    wire.attachSdkListener.mockImplementation(() => ({
      replay: [],
      truncated: false,
      detach: () => {},
    }))
    wire.spawnSdkSession.mockReturnValue({
      id: 'sdk-e2e-2',
      cwd: '/repo/alpha',
      role: 'manager',
      agentSessionId: 'agent-sid-e2e',
      status: 'running',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      seq: 0,
    })
    const r = await spawnSwarmManager({ projectPath: '/repo/alpha' })
    expect(r.runtime).toBe('sdk')
    expect(wire.markRateLimited).not.toHaveBeenCalled()
    expect(wire.forgetSwarmSessionIf).not.toHaveBeenCalled()
  })
})

// ── ③ the boot RESUME path's runtime-degrade notice ──────────────────────────
//
// The engine spawns unattended: nobody holds an HTTP response and the server is a
// forked child in a packaged app, so a `console.warn` reaches NOBODY. The engine
// LOG is the only sink. The dispatch path's call is covered elsewhere; the RESUME
// path's was not (deleting it left the whole suite green — measured 2026-08-01).

describe('③ boot resume under SDK-only fail-fast — no degrade notice, no stranded card', () => {
  const safeDeps = (
    over: Partial<OrchestratorDeps & IntegrationDeps & AnomalyDeps> = {},
  ): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
    ...defaultDeps(),
    fetchTasks: async () => [],
    isAlive: () => true,
    moveToDoing: async () => true,
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    ...over,
  })

  const ENTRY = {
    sessionId: 'sess-aaaa-bbbb-cccc-dddd',
    taskId: 'card-resume-1',
    branch: 'swarm/resume-degrade',
    worktree: '/central/wt/resume-degrade',
    tier: 'fable',
    spawnAt: 1_700_000_000_000,
    workedMs: 10_000,
    reworkCount: 0,
  }

  const withResumedProject = async (
    spawn: OrchestratorDeps['spawnWorker'],
  ): Promise<{ log: { level: string; message: string }[] }> => {
    __resetOrchestratorForTests()
    const proj = await mkdtemp(join(tmpdir(), 'og-sdk-blind-'))
    const uuid = randomUUID()
    await writeFile(
      settingsFile(),
      JSON.stringify({ projects: [{ id: uuid, path: proj, addedAt: '2026-01-01T00:00:00.000Z' }] }),
    )
    await rm(engineBootsFile(), { recursive: true, force: true })
    try {
      await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: false })
      const deps = safeDeps({
        spawnWorker: spawn,
        fetchTasks: async () =>
          [{ id: ENTRY.taskId, title: 'resume me', boardColumn: 'doing' }] as never,
      })
      await resumeEngines(deps, {
        listProjectPaths: async () => [proj],
        reconcileRoster: async () => ({
          resumeCandidates: [ENTRY],
          ready: [],
          vanished: [],
          cardGone: [],
        }),
        proveResumable: async () => true,
      })
      const state = await getOrchestratorState(proj, safeDeps())
      return { log: state.log.map((l) => ({ level: l.level, message: l.message })) }
    } finally {
      __resetOrchestratorForTests()
      await forgetSwarmManualStop(await canonicalize(proj)).catch(() => {})
      await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
      await rm(engineBootsFile(), { recursive: true, force: true })
      await rm(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }

  it('a resume spawn produces NO runtime-fallback notice — the concept was deleted with the PTY worker (2026-08-13)', async () => {
    const { log } = await withResumedProject(async (o) => ({
      terminalId: 't-resume',
      agentSessionId: o.resumeSessionId ?? 'sid',
      worktree: o.worktree ?? '/central/wt/x',
      branch: ENTRY.branch,
      model: 'fable',
    }))
    expect(log.filter((l) => l.message.includes('runtime fallback'))).toEqual([])
  })

  it('a resume spawn REFUSED by the SDK requeues the card to todo, arms the hold, and bells — never a silent doing-strand', async () => {
    // The adversarial-review finding this pins (2026-08-13): a non-adopted
    // resume candidate is never pushed to engine.workers, the orphan-doing
    // anomaly SKIPS it (its worktree still exists), and the first syncRoster
    // wipes its roster row — so before the fix, the exact upgrade scenario the
    // resume path exists for (restart on a signed-out machine) stranded every
    // in-flight card in 'doing' forever, silently.
    await rm(swarmNotificationsFile(), { force: true })
    const recovered: [string, string][] = []
    __resetOrchestratorForTests()
    const proj = await mkdtemp(join(tmpdir(), 'og-sdk-blind-'))
    const uuid = randomUUID()
    await writeFile(
      settingsFile(),
      JSON.stringify({ projects: [{ id: uuid, path: proj, addedAt: '2026-01-01T00:00:00.000Z' }] }),
    )
    await rm(engineBootsFile(), { recursive: true, force: true })
    try {
      await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: false })
      const deps = safeDeps({
        spawnWorker: async () => {
          throw new SdkWorkerUnavailableError(['CLI signed out after the update'])
        },
        recoverCard: async (_p, taskId, column) => {
          recovered.push([taskId, column])
          return true
        },
        fetchTasks: async () =>
          [{ id: ENTRY.taskId, title: 'resume me', boardColumn: 'doing' }] as never,
      })
      await resumeEngines(deps, {
        listProjectPaths: async () => [proj],
        reconcileRoster: async () => ({
          resumeCandidates: [ENTRY],
          ready: [],
          vanished: [],
          cardGone: [],
        }),
        proveResumable: async () => true,
      })
      // The card went home to 'todo' — the ordinary dispatch path (which
      // carries the hold ladder + auto-recovery) owns the retry now.
      expect(recovered).toContainEqual([ENTRY.taskId, 'todo'])
      const state = await getOrchestratorState(proj, safeDeps())
      expect(state.log.some((l) => l.message.includes('resume spawn failed → requeue to todo'))).toBe(true)
      // …and the owner heard about it — the hold was armed at boot, not left
      // for the first fill attempt to discover. Read back through the
      // PRODUCTION store reader.
      const bells = await listSwarmNotifications()
      expect(bells.filter((b) => b.swarmFatal?.event === 'worker-spawn-failed')).toHaveLength(1)
    } finally {
      __resetOrchestratorForTests()
      await forgetSwarmManualStop(await canonicalize(proj)).catch(() => {})
      await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
      await rm(engineBootsFile(), { recursive: true, force: true })
      await rm(swarmNotificationsFile(), { force: true })
      await rm(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

// ── ④ the dead 差し戻し conduit ───────────────────────────────────────────────

describe('④ instructRework — a dead, PTY-keyed seam that must not be silently re-wired', () => {
  it('defaultDeps() does not wire it', () => {
    // Route trace (2026-08-01): its only caller, reworkOrPark, was deleted with
    // the engine's whole integration path in 675968e5 (manager-only rework).
    // 差し戻し today = the commander's POST /api/project { rework }, and the REASON
    // reaches the worker through engine.reworkReasons → the next /order. So this
    // is dead plumbing, not a lost message.
    //
    // It stays pinned because the SHAPE is a trap: `(terminalId, message)` cannot
    // address an SDK worker at all — its terminalId is ''. Anyone re-wiring an
    // in-place 差し戻し conduit must take the WorkerHandle and go through
    // runtimeOf(w).say(w, …), which means this key must stay absent.
    expect('instructRework' in defaultDeps()).toBe(false)
  })

  it('the engine module exports no PTY-keyed rework writer', async () => {
    const mod = (await import('./swarmOrchestrator')) as Record<string, unknown>
    expect(mod.defaultInstructRework).toBeUndefined()
  })
})
