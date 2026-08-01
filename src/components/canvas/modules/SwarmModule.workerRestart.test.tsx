// @vitest-environment jsdom
//
// The worker tab's RESTART affordance, across the two runtimes.
//
// Unlike SwarmModule.sdkTeardown.test.tsx (which had to inject the roster row
// because the sanitizer truncated it), everything here goes through the REAL
// path: GET /api/swarm/workers answers with the shape the server actually
// sends, the REAL useSwarmEngine poll consumes it, and the REAL
// sanitizeSwarmWorkers parses it. That is deliberate — the defect being pinned
// was IN that parse, so a test that skips it proves nothing.
//
// Three failures are pinned:
//   · `sanitizeSwarmWorkers` dropped `runtime` + `sdkSessionId`, so a live,
//     working SDK worker was drawn as an ENDED PTY session with a Restart
//     button over it;
//   · a restart that comes up on the SDK runtime returns terminalId '' — the
//     optimistic overlay carried only a terminalId, so an EMPTY one changed
//     nothing and the dead tile (Restart button live) stayed on screen for a
//     whole poll interval. A second click there spawns a twin `claude` into
//     the worktree the fresh worker is already writing in;
//   · the restart response's `fellBackBecause` was thrown away, so an SDK dial
//     that silently degraded to a PTY looked like a broken switch.
//
// MUTATIONS that turn this red: drop `runtime`/`sdkSessionId` from the
// sanitizer's field table; make the pendingRestarts overlay carry only
// `terminalId` again; delete the `fellBackBecause` branch from restartWorker.
//
// The second half of the file (added 2026-08-01) covers restarting a worker
// whose desk lives in the SDK pool at all — see its own header. Until then the
// only tile offering Restart was the PTY one, so `restartWorker`'s SDK stop, the
// PTY arm of the overlay, and the reconcile that retires a pending restart were
// all reachable by no test in the repo: each could be broken outright and this
// suite stayed green (measured).

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { messages } from '@/i18n/messages'
import type { ProjectMeta, SwarmOrchestratorState, SwarmWorkerRecord } from '@/lib/types'

// The key-echo `t` this suite has always used — assertions read as the key that
// produced them. It NOW also looks every key up in the REAL en+ja dictionaries
// and records a miss.
//
// That addition is the whole point of `missingKeys`: with a mock that echoes
// whatever it is handed, `getByText('projectPanel.swarm.restart')` passes just
// as happily for a key that exists in NEITHER locale — which is a button the
// owner sees as a blank rectangle, guarded by a green test. A mock may make
// assertions readable; it may not make them true.
const missingKeys = new Set<string>()
const noteKey = (k: string) => {
  if (!(k in messages.en) || !(k in messages.ja)) missingKeys.add(k)
  return k
}

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, v?: Record<string, unknown>) =>
      v ? `${noteKey(k)}:${JSON.stringify(v)}` : noteKey(k),
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}))

// The xterm host, stubbed. NOT to make anything pass — the cases below are
// about WHICH tile SwarmModule renders and WHICH id it hands it, and that
// decision is entirely SwarmModule's. Real xterm cannot open in jsdom
// (`matchMedia` is missing) and throws asynchronously, which would land as an
// unhandled rejection attributed to whichever test happened to be running. The
// stub also makes the chosen terminalId readable, which the real one does not.
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="pty-tile" data-terminal-id={terminalId} />
  ),
}))

import { SwarmModule } from './SwarmModule'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// The SDK tile opens an SSE stream on mount; jsdom has no EventSource. Several
// cases here DO depend on it — a tile only offers Restart once its session is
// finished, and "which session is this tile addressing?" is readable nowhere
// else in the DOM — so the stub records its URL and can deliver events.
class FakeEventSource {
  static instances: FakeEventSource[] = []
  /** The most recent stream opened for an /api/sdk-session/<id>/… URL. */
  static forSession(id: string) {
    return [...FakeEventSource.instances]
      .reverse()
      .find((s) => s.url.includes(`/api/sdk-session/${id}/`))
  }
  /** Which SDK session the newest tile is attached to (''=none opened). */
  static get lastSessionId() {
    const last = [...FakeEventSource.instances]
      .reverse()
      .find((s) => s.url.includes('/api/sdk-session/'))
    return last ? (last.url.match(/\/api\/sdk-session\/([^/]+)\//)?.[1] ?? '') : ''
  }
  closed = false
  listeners = new Map<string, ((e: Event) => void)[]>()
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
  }
  emit(type: string, data?: unknown) {
    const e = (data === undefined ? {} : { data: JSON.stringify(data) }) as unknown as Event
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
}

/** Tell an SDK tile its session is over, the way the server does — that is what
 *  brings up the "session ended · Restart" strip. */
const endSdkSession = async (id: string) => {
  await act(async () => {
    FakeEventSource.forSession(id)?.emit('end', { session: { status: 'exited', reaped: true } })
  })
}

/** Force the engine poll to run now instead of waiting out ENGINE_POLL_MS. */
const repoll = async () => {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    await Promise.resolve()
  })
}

const project: ProjectMeta = {
  id: 'p-restart',
  name: 'proj',
  path: '/prestart',
  description: '',
  lastModified: '2026-08-01T00:00:00.000Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

const WORKTREE = '/home/.openground/projects/p-restart/worktrees/swarm-card-3'

/** A LIVE SDK worker exactly as swarmWorkerRegistry reports one: no terminalId
 *  (pty ⇔ terminalId / sdk ⇔ sdkSessionId), no `stage` — which is what makes it
 *  a manual worker this tab may act on. */
const liveSdkWorker: SwarmWorkerRecord = {
  worktree: WORKTREE,
  branch: 'swarm/card-3',
  runtime: 'sdk',
  sdkSessionId: 'sdk-3',
  taskTitle: 'SDK worker at work',
}

/** A DEAD worker: only its heartbeat file is left (registry source 3), so it
 *  carries neither a runtime nor any id. This is the record the restart
 *  affordance exists for. */
const deadWorker: SwarmWorkerRecord = {
  worktree: WORKTREE,
  branch: 'swarm/card-3',
  note: 'died mid-implement',
  heartbeatAt: '2026-08-01T00:01:00.000Z',
}

const engineState = (): SwarmOrchestratorState => ({
  running: false,
  manualStop: false,
  manualStopPersisted: false,
  selfSupply: false,
  overseer: false,
  workers: [],
  reviews: [],
  log: [],
  anomalies: [],
  maxWorkers: 3,
  kpis: {
    leadTime: { medianMs: null, count: 0 },
    conflictRate: null,
    reworkRate: null,
    workerSuccessRate: null,
    counts: { dispatched: 0, integrated: 0, conflicted: 0, reworked: 0, crashed: 0, stalled: 0 },
  },
  consumption: { activeWorkers: 0, activeRunMs: 0, dispatched: 0, limit: 0, overLimit: false },
  autonomyRemembered: false,
  autonomyResumed: false,
  overseerRemembered: false,
})

type Req = { url: string; method: string }

/** Answer every route the pane polls and record each request.
 *
 *  `roster` is what GET /api/swarm/workers keeps answering — deliberately NOT
 *  updated after a restart, because the up-to-5s window in which the server has
 *  not caught up yet is precisely the window the optimistic overlay exists for
 *  (and the window the twin-spawn happened in). */
const harness = (opts: { roster: SwarmWorkerRecord[]; spawn?: Record<string, unknown> }) => {
  const reqs: Req[] = []
  // `opts` is READ on every request, so a case can advance server truth
  // mid-test by reassigning `opts.roster` and calling repoll().
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)

  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request)?.url ?? '')
      const method = (init?.method ?? 'GET').toUpperCase()
      reqs.push({ url, method })
      if (url.startsWith('/api/swarm/workers')) return json({ workers: opts.roster })
      if (url.startsWith('/api/swarm/orchestrator')) return json(engineState())
      if (url.startsWith('/api/swarm/preflight')) return json({ issues: [] })
      if (url.startsWith('/api/swarm/escalations')) return json({ escalations: [] })
      if (url === '/api/swarm/worker') return json(opts.spawn ?? {})
      return json({})
    }),
  )
  return { reqs }
}

beforeEach(() => {
  FakeEventSource.instances = []
  missingKeys.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const openWorkerTab = async () => {
  render(<SwarmModule project={project} />)
  await userEvent.click(await screen.findByRole('tab', { name: /workersTab/ }))
}

describe('an SDK worker arriving over the real poll', () => {
  it('renders as the SDK tile — NOT an ended session with a Restart button', async () => {
    harness({ roster: [liveSdkWorker] })
    await openWorkerTab()

    // The SDK badge is the tile's own marker (SdkWorkerPane).
    expect(await screen.findByTitle('projectPanel.swarm.sdk.badgeHint')).toBeTruthy()
    // …and none of the PTY tile's dead-session chrome. Offering "Restart" over a
    // working worker is not a cosmetic slip: pressing it puts a SECOND claude
    // into that worktree.
    expect(screen.queryByText('projectPanel.swarm.sessionEnded')).toBeNull()
    expect(screen.queryByText('projectPanel.swarm.restart')).toBeNull()
  })
})

describe('restarting a dead worker that comes back on the SDK runtime', () => {
  it('swaps the tile to the SDK one at once, leaving no Restart to click twice', async () => {
    const { reqs } = harness({
      roster: [deadWorker],
      // What the server answers when the worker dial is 'sdk': terminalId is
      // EMPTY and the handle is the session id.
      spawn: {
        terminalId: '',
        runtime: 'sdk',
        sdkSessionId: 'sdk-fresh',
        agentSessionId: 'agent-1',
        worktree: WORKTREE,
        branch: 'swarm/card-3',
      },
    })
    await openWorkerTab()

    await userEvent.click(await screen.findByText('projectPanel.swarm.restart'))

    await waitFor(() =>
      expect(reqs.filter((r) => r.url === '/api/swarm/worker' && r.method === 'POST').length).toBe(1),
    )
    // The fresh worker is an SDK one, so its tile must be the SDK tile — right
    // now, not after the next poll. The roster STILL reports the dead worker.
    expect(await screen.findByTitle('projectPanel.swarm.sdk.badgeHint')).toBeTruthy()
    // And the button that would spawn the twin is gone.
    expect(screen.queryByText('projectPanel.swarm.restart')).toBeNull()
    expect(screen.queryByText('projectPanel.swarm.sessionEnded')).toBeNull()
  })

  it('says so out loud when the SDK dial degraded this worker to a PTY', async () => {
    harness({
      roster: [deadWorker],
      spawn: {
        terminalId: 'pty-fresh',
        agentSessionId: 'agent-1',
        worktree: WORKTREE,
        branch: 'swarm/card-3',
        fellBackBecause: 'SDK worker slots are full (1/1) — this worker runs as a PTY',
      },
    })
    await openWorkerTab()

    await userEvent.click(await screen.findByText('projectPanel.swarm.restart'))

    // The reason rides back on the response precisely because the server is a
    // forked child in a packaged app — a console.warn there reaches nobody.
    const banner = await screen.findByText(/projectPanel\.swarm\.runtime\.fellBack/)
    expect(banner.textContent).toContain('slots are full (1/1)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Restarting a worker that lives in the SDK POOL.
//
// Everything below was unguarded until 2026-08-01, and a re-audit MEASURED it:
// the SDK stop inside `restartWorker` could be deleted outright and the whole
// suite stayed green, the PTY arm of the optimistic overlay could be replaced
// with `: w` (5/5 green), and the reconcile that retires a pending restart could
// be made to match nothing at all (5/5 green). The reason was structural, not
// oversight: the only tile that offered Restart was the PTY one, so no case here
// could ever reach the SDK paths.
//
// MUTATIONS that turn these red (each measured, one at a time):
//   · `stopWorkerDesk(worker, …)` in restartWorker → the old PTY-only kill;
//   · the overlay's PTY arm → `: w`;
//   · the reconcile's `engineWorkerKey(seen) === engineWorkerKey(pending)` →
//     `'never-matches-anything'`;
//   · the unaddressable-spawn guard → the old two-arm ternary.
describe('restarting a worker whose desk is an SDK session', () => {
  /** The tile only offers Restart once its session is over — the same rule the
   *  PTY tile follows (offering it over a live worker puts a twin `claude` into
   *  that worktree). Bring the live SDK worker to that state. */
  const openFinishedSdkTile = async (id: string) => {
    await openWorkerTab()
    await screen.findByTitle('projectPanel.swarm.sdk.badgeHint')
    await endSdkSession(id)
    return screen.findByText('projectPanel.swarm.restart')
  }

  it('stops the SDK SESSION before respawning — not a terminalId it does not have', async () => {
    const { reqs } = harness({
      roster: [liveSdkWorker],
      spawn: { terminalId: '', runtime: 'sdk', sdkSessionId: 'sdk-fresh', worktree: WORKTREE },
    })

    await userEvent.click(await openFinishedSdkTile('sdk-3'))

    await waitFor(() =>
      expect(reqs.some((r) => r.url === '/api/swarm/worker' && r.method === 'POST')).toBe(true),
    )
    const stop = reqs.findIndex(
      (r) => r.method === 'DELETE' && r.url.startsWith('/api/sdk-session/sdk-3?'),
    )
    const spawn = reqs.findIndex((r) => r.url === '/api/swarm/worker' && r.method === 'POST')
    // The old desk was told to stop AT ALL. A restart reuses the worktree, so a
    // stop that silently does nothing leaves the previous `claude` running in the
    // tree the fresh worker is about to enter — two agents, one branch.
    expect(stop, 'no DELETE /api/sdk-session/sdk-3 — the SDK desk was never stopped').toBeGreaterThan(-1)
    expect(stop).toBeLessThan(spawn)
    expect(reqs[stop].url).toContain(`path=${encodeURIComponent(project.path)}`)
    // And nothing was asked of the PTY pool: this worker has no terminalId, so a
    // DELETE /api/terminal/ addresses nobody — or somebody else.
    expect(reqs.some((r) => r.url.startsWith('/api/terminal/') && r.method === 'DELETE')).toBe(false)
  })

  it('swaps the tile to the PTY one when the restart degrades to a PTY', async () => {
    // The roster keeps reporting the OLD SDK worker (the ≤5 s window the overlay
    // exists for). The overlay must replace the WHOLE runtime identity: leaving
    // the record as-is keeps a dead SDK tile on screen, addressing a session that
    // has been stopped, over a PTY worker that is already running.
    harness({
      roster: [liveSdkWorker],
      spawn: {
        terminalId: 'pty-fresh',
        worktree: WORKTREE,
        fellBackBecause: 'SDK worker slots are full (1/1) — this worker runs as a PTY',
      },
    })

    await userEvent.click(await openFinishedSdkTile('sdk-3'))

    await waitFor(() => expect(screen.queryByTitle('projectPanel.swarm.sdk.badgeHint')).toBeNull())
    // …and it is pointed at the id the server actually returned.
    expect(screen.getByTestId('pty-tile').getAttribute('data-terminal-id')).toBe('pty-fresh')
    // The dead SDK tile's own Restart is gone with it — one more click there
    // would spawn a second worker into the same worktree.
    expect(screen.queryByText('projectPanel.swarm.restart')).toBeNull()
  })

  it('retires the optimistic overlay once the roster catches up, so a LATER relaunch shows', async () => {
    const opts = {
      roster: [liveSdkWorker] as SwarmWorkerRecord[],
      spawn: { terminalId: '', runtime: 'sdk', sdkSessionId: 'sdk-fresh', worktree: WORKTREE },
    }
    harness(opts)

    await userEvent.click(await openFinishedSdkTile('sdk-3'))

    // The overlay does its job: the tile addresses the fresh session at once.
    await waitFor(() => expect(FakeEventSource.lastSessionId).toBe('sdk-fresh'))

    // Server truth catches up — the overlay is now redundant and must be dropped.
    opts.roster = [{ ...liveSdkWorker, sdkSessionId: 'sdk-fresh' }]
    await repoll()

    // …because the engine later relaunches this worktree ITSELF. A pending entry
    // that never retires outranks server truth forever: the tile would keep
    // addressing 'sdk-fresh' — a session that no longer exists — and the owner
    // would watch a dead transcript beside a working worker.
    opts.roster = [{ ...liveSdkWorker, sdkSessionId: 'sdk-second' }]
    await repoll()

    await waitFor(() => expect(FakeEventSource.lastSessionId).toBe('sdk-second'))
  })

  it('records NO overlay when the spawn answer has no address to overlay with', async () => {
    // `runtime:'sdk'` with no sdkSessionId cannot happen server-side — which is
    // precisely why the old code's `else` arm swept it into `{runtime:'pty',
    // terminalId:''}`: a pending restart pointing at NOBODY. Its key is '', so
    // the reconcile can never retire it, and until then it overwrote the live
    // record — redrawing a working SDK worker as a dead PTY tile, permanently.
    harness({
      roster: [liveSdkWorker],
      spawn: { terminalId: '', runtime: 'sdk', worktree: WORKTREE },
    })

    await userEvent.click(await openFinishedSdkTile('sdk-3'))

    await waitFor(() =>
      expect(screen.queryByText('projectPanel.swarm.restarting')).toBeNull(),
    )
    // Nothing was overlaid, so the tile still shows what the server last said —
    // stale for one poll, but never a lie.
    expect(screen.getByTitle('projectPanel.swarm.sdk.badgeHint')).toBeTruthy()
    expect(screen.queryByText('projectPanel.swarm.sessionEnded')).toBeTruthy()
  })
})

describe('every label the worker tab renders exists in BOTH locales', () => {
  it('has no imaginary keys — checked against ja and en, not against the mock', async () => {
    // Two tiles, distinct worktrees (the React key) — one of each renderer, so
    // both tiles' labels are swept.
    harness({ roster: [liveSdkWorker, { ...deadWorker, worktree: `${WORKTREE}-dead` }] })
    await openWorkerTab()
    await screen.findByTitle('projectPanel.swarm.sdk.badgeHint')
    await endSdkSession('sdk-3')
    expect(Array.from(missingKeys).sort()).toEqual([])
  })
})
