// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import {
  SdkWorkerPane,
  appendFrame,
  blipVerdict,
  postFailureMessage,
  MAX_FRAMES,
  type Frame,
} from './SdkWorkerPane'

// The SDK worker tile. Three things are guarded here, each of which was a
// silent failure before:
//   ① a REFUSED message vanished — the composer cleared before the POST and
//      nothing looked at the answer, so the owner believed an instruction had
//      been delivered to a session that never took it;
//   ② the received frames grew without bound on the client while the server
//      capped its own ring buffer at RING_CAPACITY;
//   ③ a manual SDK worker's tile had no terminate / force-remove at all, so
//      its worktree could not be cleaned up from the UI.
//
// The server journey (409 from pushSdkInput, the ring buffer, worktree
// removal) lives in the server suites; here fetch and EventSource are stubbed.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  }),
}))

// A minimal EventSource. jsdom has none, and the pane opens one on mount. Most
// cases here do not depend on the stream, but the liveness cases (④) DO: they
// have to deliver an `error` / `frame` / `end` the way the server does, so this
// stub can also emit.
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]
  }
  url: string
  closed = false
  listeners = new Map<string, ((e: Event) => void)[]>()
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    const cur = this.listeners.get(type) ?? []
    cur.push(fn)
    this.listeners.set(type, cur)
  }
  close() {
    this.closed = true
  }
  /** Deliver an event. `data` omitted = an Event with NO data — which is how a
   *  CONNECTION blip (as opposed to the server's own error event) arrives. */
  emit(type: string, data?: unknown) {
    const e = (data === undefined ? {} : { data: JSON.stringify(data) }) as unknown as Event
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
}

type FetchCall = { url: string; init?: RequestInit }
let fetchCalls: FetchCall[] = []
/** What the next POST answers. Replaced per case. */
let respond: (url: string) => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true, queued: true }), { status: 200 })

beforeEach(() => {
  fetchCalls = []
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init })
      return respond(url)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  respond = async () => new Response(JSON.stringify({ ok: true, queued: true }), { status: 200 })
})

const mount = (over: Partial<Parameters<typeof SdkWorkerPane>[0]> = {}) =>
  render(
    <SdkWorkerPane
      sdkSessionId="sdk-1"
      projectPath="/proj"
      branch="swarm/card-1"
      taskTitle="カードのタイトル"
      {...over}
    />,
  )

const typeAndEnter = (input: HTMLElement, text: string) => {
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('SdkWorkerPane — a refused message must not vanish (①)', () => {
  it('puts the text back and says why when the session refuses it (409)', async () => {
    respond = async () =>
      new Response(JSON.stringify({ error: 'session is no longer accepting input' }), {
        status: 409,
      })
    const { getByPlaceholderText, getByRole } = mount()
    const input = getByPlaceholderText('projectPanel.swarm.sdk.placeholder')

    typeAndEnter(input, 'テストをもう一度回して')

    // The words are back in the box — the owner can re-send or copy them out.
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('テストをもう一度回して'))
    // And the refusal is on screen, in the SERVER's words (not "HTTP 409").
    const alert = getByRole('alert')
    expect(alert.textContent).toContain('projectPanel.swarm.sdk.sendFailed')
    expect(alert.textContent).toContain('session is no longer accepting input')
  })

  it('reports a rejected fetch the same way (the dev-reload case)', async () => {
    respond = async () => {
      throw new TypeError('Failed to fetch')
    }
    const { getByPlaceholderText, getByRole } = mount()
    const input = getByPlaceholderText('projectPanel.swarm.sdk.placeholder')

    typeAndEnter(input, 'もう一度')

    await waitFor(() => expect((input as HTMLInputElement).value).toBe('もう一度'))
    expect(getByRole('alert').textContent).toContain('Failed to fetch')
  })

  it('falls back to the status code when the body is not the shape we expect', async () => {
    respond = async () => new Response('<html>nope</html>', { status: 403 })
    const { getByPlaceholderText, getByRole } = mount()
    const input = getByPlaceholderText('projectPanel.swarm.sdk.placeholder')

    typeAndEnter(input, 'ping')

    await waitFor(() => expect(getByRole('alert').textContent).toContain('HTTP 403'))
    expect((getByPlaceholderText('projectPanel.swarm.sdk.placeholder') as HTMLInputElement).value).toBe('ping')
  })

  it('clears the box and stays silent when the session accepts it', async () => {
    const { getByPlaceholderText, queryByRole } = mount()
    const input = getByPlaceholderText('projectPanel.swarm.sdk.placeholder')

    typeAndEnter(input, 'ok')

    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url.includes('/api/sdk-session/sdk-1/input'))).toBe(true),
    )
    expect((input as HTMLInputElement).value).toBe('')
    expect(queryByRole('alert')).toBeNull()
  })

  it('does NOT clobber what the owner typed while the POST was in flight', async () => {
    let release!: (r: Response) => void
    respond = () => new Promise<Response>((res) => { release = (r) => res(r) })
    const { getByPlaceholderText, getByRole } = mount()
    const input = getByPlaceholderText('projectPanel.swarm.sdk.placeholder')

    typeAndEnter(input, '一通目')
    await waitFor(() => expect(typeof release).toBe('function'))
    // The owner starts a new thought while the first is still in flight.
    fireEvent.change(input, { target: { value: '二通目' } })
    release(new Response(JSON.stringify({ error: 'gone' }), { status: 409 }))

    // Wait for the REFUSAL to be on screen first. Asserting on the input value
    // straight after release() proves nothing: the restore has not run yet at
    // that instant, so the assertion passes even for a restore that clobbers
    // (measured — an unconditional `setDraft(text)` was green here until the
    // wait was anchored to something the failure path itself renders).
    await waitFor(() => getByRole('alert'))
    expect((input as HTMLInputElement).value).toBe('二通目')
  })
})

describe('postFailureMessage', () => {
  it('prefers the server sentence, falls back to the status', () => {
    expect(postFailureMessage(409, { error: 'session is no longer accepting input' })).toBe(
      'session is no longer accepting input',
    )
    expect(postFailureMessage(404, null)).toBe('HTTP 404')
    expect(postFailureMessage(500, {})).toBe('HTTP 500')
    expect(postFailureMessage(500, { error: '   ' })).toBe('HTTP 500')
    expect(postFailureMessage(500, { error: 42 })).toBe('HTTP 500')
  })
})

describe('SdkWorkerPane — the transcript is bounded (②)', () => {
  const frame = (seq: number): Frame => ({ seq, ev: { kind: 'text', text: `line ${seq}` } })

  it('evicts oldest-first at MAX_FRAMES instead of growing forever', () => {
    let acc: Frame[] = []
    for (let i = 1; i <= MAX_FRAMES + 500; i++) acc = appendFrame(acc, frame(i))
    expect(acc.length).toBe(MAX_FRAMES)
    // Newest kept, oldest dropped — a tile shows the END of a long day's work.
    expect(acc[acc.length - 1].seq).toBe(MAX_FRAMES + 500)
    expect(acc[0].seq).toBe(501)
  })

  it('is pinned to the server ring buffer, so the two cannot drift apart', () => {
    // Reading the server source is the only way to see the number from here:
    // sdkSession.ts is server code (node-pty / SDK imports) and must not be
    // pulled into a browser-side test just to read one constant.
    const src = readFileSync(
      resolve(__dirname, '../../../lib/server/sdkSession.ts'),
      'utf8',
    )
    const m = src.match(/const RING_CAPACITY = (\d+)/)
    expect(m, 'sdkSession.ts no longer declares RING_CAPACITY the expected way').toBeTruthy()
    expect(
      Number(m![1]),
      'the server ring buffer changed size — MAX_FRAMES in SdkWorkerPane.tsx must follow it',
    ).toBe(MAX_FRAMES)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ LIVENESS IS `reaped`, NEVER STATUS.
//
// `terminateSdkSession` flips the status to 'exited' SYNCHRONOUSLY — it only
// asks the CLI to stop — while the pump keeps draining and keeps emitting the
// frames that say HOW the desk ended. Every seam that judged liveness by status
// therefore hung up on a session that was still talking. This tile did it twice:
// in the connection-blip re-check (it closed its own EventSource) and in the
// render (it hid the composer and the interrupt).
//
// MUTATIONS that turn these red (all measured):
//   · blipVerdict → `body.status !== 'exited' && body.status !== 'failed'`;
//   · `!finished` → `!isTerminal(status)` on the composer / interrupt;
//   · drop `setFinished(true)` from the 'end' handler.
describe('blipVerdict — the connection-blip re-check', () => {
  it('does NOT hang up on a session that is unwinding (status exited, not reaped)', () => {
    expect(blipVerdict(true, { status: 'exited', reaped: false })).toEqual({ close: false })
    expect(blipVerdict(true, { status: 'exited' })).toEqual({ close: false })
    expect(blipVerdict(true, { status: 'failed' })).toEqual({ close: false })
    expect(blipVerdict(true, { status: 'working' })).toEqual({ close: false })
  })

  it('closes once the session is REAPED, honouring the status it read', () => {
    expect(blipVerdict(true, { status: 'exited', reaped: true })).toEqual({
      close: true,
      status: 'exited',
    })
    // A crash must not be drawn as a normal finish.
    expect(blipVerdict(true, { status: 'failed', reaped: true })).toEqual({
      close: true,
      status: 'failed',
    })
  })

  it('closes when the session is gone or not ours (404 / 403)', () => {
    expect(blipVerdict(false, null)).toEqual({ close: true, status: 'exited' })
  })

  it('keeps retrying when the answer is unreadable — the server DID answer', () => {
    expect(blipVerdict(true, null)).toEqual({ close: false })
  })
})

describe('SdkWorkerPane — a teardown in flight is not a finished desk (④)', () => {
  const blip = async () => {
    await act(async () => {
      FakeEventSource.last.emit('error')
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('stays attached through a blip while a terminate is still unwinding', async () => {
    // The teardown window: status already 'exited', pump still draining.
    respond = async () =>
      new Response(JSON.stringify({ status: 'exited', reaped: false }), { status: 200 })
    const onExit = vi.fn()
    const { getByPlaceholderText } = mount({ onExit })

    await blip()

    // The stream is still ours — the final frames have somewhere to land.
    expect(FakeEventSource.last.closed).toBe(false)
    expect(onExit).not.toHaveBeenCalled()
    // …and the desk is still addressable: the composer is the owner's only way
    // to answer a question the winding-down worker may still ask.
    expect(getByPlaceholderText('projectPanel.swarm.sdk.placeholder')).toBeTruthy()
  })

  it('hangs up once the session is really reaped, and says it FAILED when it did', async () => {
    respond = async () =>
      new Response(JSON.stringify({ status: 'failed', reaped: true }), { status: 200 })
    const onExit = vi.fn()
    const { queryByPlaceholderText, getByText } = mount({ onExit })

    await blip()

    await waitFor(() => expect(FakeEventSource.last.closed).toBe(true))
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(queryByPlaceholderText('projectPanel.swarm.sdk.placeholder')).toBeNull()
    // 'failed', not a blanket 'exited'.
    expect(getByText('projectPanel.swarm.sdk.statusFailed')).toBeTruthy()
  })

  it('WITHDRAWS the composer and the interrupt when a STATUS frame says exited — the pool has stopped taking input', async () => {
    // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong in the way that
    // is hardest to see: it reasoned "not reaped ⇒ still alive ⇒ still speakable".
    // The first two steps are right and the third does not follow. `pushSdkInput`
    // and `interruptSdkSession` refuse on the pool's `closed` flag, which
    // `terminateSdkSession` sets SYNCHRONOUSLY — so through the whole
    // terminate→reap window the desk IS alive and refuses every word of it. The
    // old assertion pinned a composer that could only produce a 409, in the same
    // round that started SHOWING 409s to the owner.
    const { getByText, queryByPlaceholderText, queryByTitle } = mount({ onTerminate: vi.fn() })

    await act(async () => {
      FakeEventSource.last.emit('frame', { seq: 1, ev: { kind: 'status', status: 'exited' } })
    })

    expect(getByText('projectPanel.swarm.statusExited')).toBeTruthy()
    expect(queryByPlaceholderText('projectPanel.swarm.sdk.placeholder')).toBeNull()
    expect(queryByTitle('projectPanel.swarm.sdk.interrupt')).toBeNull()
  })

  it('…but STAYS ATTACHED — the last frames still arrive and are drawn', async () => {
    // The half that IS about liveness, and the reason the stream is not closed
    // on a terminal status: the frames a stopped desk emits while unwinding are
    // the ones the owner most needs to read. Withdrawing the CONTROLS and
    // withdrawing the VIEW are different decisions.
    const { getByText } = mount({ onTerminate: vi.fn() })

    await act(async () => {
      FakeEventSource.last.emit('frame', { seq: 1, ev: { kind: 'status', status: 'exited' } })
      FakeEventSource.last.emit('frame', {
        seq: 2,
        ev: { kind: 'text', text: 'finishing the commit' },
      })
    })

    expect(getByText('finishing the commit')).toBeTruthy()
  })
})

describe('SdkWorkerPane — the restart chain does not end here (⑤)', () => {
  const endTheSession = async () => {
    await act(async () => {
      FakeEventSource.last.emit('end', { session: { status: 'exited', reaped: true } })
    })
  }

  it("the SERVER'S OWN error ends the tile — attach refused / session gone from the pool", async () => {
    // The `error` event WITH data is the server speaking, not a transport blip:
    // the attach was refused or the session is no longer in the pool, and no
    // retry can change either. Dropping `setFinished(true)` from that branch
    // left 22/22 green (measured) while the tile sat forever showing a composer
    // for a session that does not exist, with Restart never offered and the
    // parent never told — the dead-worker-shows-running shape, in one pane.
    const onExit = vi.fn()
    const { getByText, queryByPlaceholderText } = mount({ onExit, onRestart: vi.fn() })

    await act(async () => {
      FakeEventSource.last.emit('error', 'session is no longer available')
    })

    expect(queryByPlaceholderText('projectPanel.swarm.sdk.placeholder')).toBeNull()
    expect(getByText('projectPanel.swarm.restart')).toBeTruthy()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('offers Restart once the session is finished, and calls it', async () => {
    const onRestart = vi.fn()
    const { getByText, queryByText } = mount({ onRestart })

    // Nothing to restart while it is alive — the same rule the PTY tile follows
    // (offering it over a live worker spawns a twin into that worktree).
    expect(queryByText('projectPanel.swarm.restart')).toBeNull()

    await endTheSession()

    fireEvent.click(getByText('projectPanel.swarm.restart'))
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(getByText('projectPanel.swarm.sessionEnded')).toBeTruthy()
  })

  it('shows no Restart for an engine-owned worker (the orchestrator owns it)', async () => {
    const { queryByText } = mount({ source: 'engine' })
    await endTheSession()
    expect(queryByText('projectPanel.swarm.restart')).toBeNull()
  })

  it('is disabled while a teardown is already in flight', async () => {
    const { getByText } = mount({ onRestart: vi.fn(), busy: true })
    await endTheSession()
    expect(getByText('projectPanel.swarm.restarting').closest('button')).toBeDisabled()
  })

  it('starts the new session clean when the tile is reused for a fresh id', async () => {
    const onRestart = vi.fn()
    const { rerender, queryByText, getByPlaceholderText } = render(
      <SdkWorkerPane
        sdkSessionId="sdk-old"
        projectPath="/proj"
        branch="swarm/card-1"
        taskTitle="t"
        onRestart={onRestart}
      />,
    )
    await endTheSession()
    expect(queryByText('projectPanel.swarm.restart')).toBeTruthy()

    // SwarmModule keys worker tiles by WORKTREE, so a worker relaunched in place
    // arrives as a new id on this same component. It must not inherit the dead
    // session's "finished".
    rerender(
      <SdkWorkerPane
        sdkSessionId="sdk-new"
        projectPath="/proj"
        branch="swarm/card-1"
        taskTitle="t"
        onRestart={onRestart}
      />,
    )
    expect(queryByText('projectPanel.swarm.restart')).toBeNull()
    expect(getByPlaceholderText('projectPanel.swarm.sdk.placeholder')).toBeTruthy()
  })
})

describe('SdkWorkerPane — a manual worker can be torn down (③)', () => {
  it('offers terminate, and force-remove once a soft terminate kept the tree', () => {
    const onTerminate = vi.fn()
    const onForceRemove = vi.fn()
    const { getByTitle, getByText } = mount({
      onTerminate,
      onForceRemove,
      retainedReason: 'worktree is dirty',
    })

    fireEvent.click(getByTitle('projectPanel.swarm.terminate'))
    expect(onTerminate).toHaveBeenCalledTimes(1)

    fireEvent.click(getByText('projectPanel.swarm.forceRemove'))
    expect(onForceRemove).toHaveBeenCalledTimes(1)
  })

  it('disables both while a teardown is already in flight', () => {
    const { getByTitle, getByText } = mount({
      onTerminate: vi.fn(),
      onForceRemove: vi.fn(),
      retainedReason: 'worktree is dirty',
      busy: true,
    })
    expect(getByTitle('projectPanel.swarm.terminate')).toBeDisabled()
    expect(getByText('projectPanel.swarm.forceRemove').closest('button')).toBeDisabled()
  })

  it('shows the engine chip and NO teardown control for an engine-owned worker', () => {
    const { queryByTitle, getByText } = mount({ source: 'engine' })
    expect(getByText('projectPanel.swarm.engineOwned')).toBeTruthy()
    expect(queryByTitle('projectPanel.swarm.terminate')).toBeNull()
    // The engine also owns the turn — no interrupt from here either.
    expect(queryByTitle('projectPanel.swarm.sdk.interrupt')).toBeNull()
  })
})

describe('SdkWorkerPane — the open-question banner (2026-08-03)', () => {
  // The 0.11.52 acceptance put the owner in front of this pane while their
  // worker waited on a question — and the pane said only 「待機中」, with the
  // question living silently in another tab. The banner closes that gap; these
  // tests pin the two ways it could quietly lie:
  //   • showing NOTHING (the pre-fix state), and
  //   • showing SOMEONE ELSE'S question (the address filter dropped — the same
  //     empty-terminalId aliasing family as the S4 shared-slot bug).
  const inbox = (items: unknown[]) => {
    respond = async (url) =>
      url.includes('/api/swarm/escalations')
        ? new Response(JSON.stringify({ escalations: items }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, queued: true }), { status: 200 })
  }

  it("shows THIS session's open question — not another worker's, not an answered one", async () => {
    inbox([
      {
        id: 'e-mine',
        status: 'open',
        sdkSessionId: 'sdk-1',
        question: 'AとBのどちらにしますか?',
        createdAt: '2026-08-03T00:00:10Z',
      },
      {
        id: 'e-other',
        status: 'open',
        sdkSessionId: 'sdk-SOMEONE-ELSE',
        question: '他人の質問',
        createdAt: '2026-08-03T00:00:20Z',
      },
      {
        id: 'e-done',
        status: 'answered',
        sdkSessionId: 'sdk-1',
        question: '回答済みの質問',
        createdAt: '2026-08-03T00:00:30Z',
      },
    ])
    const { findByText, queryByText } = mount()
    await findByText('AとBのどちらにしますか?')
    expect(queryByText('projectPanel.swarm.sdk.questionBanner')).toBeTruthy()
    expect(queryByText('projectPanel.swarm.sdk.questionBannerHint')).toBeTruthy()
    expect(queryByText('他人の質問')).toBeNull()
    expect(queryByText('回答済みの質問')).toBeNull()
  })

  it('shows NO banner when the inbox holds nothing addressed to this session', async () => {
    inbox([
      {
        id: 'e-other',
        status: 'open',
        sdkSessionId: 'sdk-SOMEONE-ELSE',
        question: '他人の質問',
        createdAt: '2026-08-03T00:00:20Z',
      },
    ])
    const { queryByText } = mount()
    // Let the mount-time poll settle before asserting the negative.
    await act(async () => {
      await Promise.resolve()
    })
    expect(queryByText('projectPanel.swarm.sdk.questionBanner')).toBeNull()
    expect(queryByText('他人の質問')).toBeNull()
  })
})
