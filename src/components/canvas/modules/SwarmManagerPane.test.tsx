// @vitest-environment jsdom
//
// The COMMANDER desk, when it runs on the Agent SDK runtime instead of a PTY.
//
// Both failures pinned here are the family docs/MAP.md §5 names — "ask one pool
// a question about a desk that may live in the other" — arriving on the client
// this time:
//
//   ② the header beacon. GET /api/terminal/active cannot see the SDK pool, so
//      SwarmModule had no true status to pass and passed the CONSTANT 'working'.
//      The commander therefore read 作業中 forever: never waiting on a question,
//      never quota-parked, never exited. It is the one line the owner uses to
//      decide whether to go and look, and it could not be wrong — which means it
//      could not be right either.
//
//   ③ the command bar's React key. It was `session.terminalId`, and an SDK
//      commander's terminalId is the EMPTY STRING (the identity invariant: pty ⇔
//      terminalId, sdk ⇔ sdkSessionId). Every SDK desk was therefore the same
//      key, so the relaunch the key exists to notice never happened and a
//      half-typed order to the PREVIOUS commander sat waiting in the box for the
//      new one.
//
// MUTATIONS that turn this red (measured):
//   · `deskStatus` → the constant 'working' for an SDK desk;
//   · `managerSdkStatus` folding everything to 'working';
//   · `key={engineWorkerKey(session)}` → `key={session.terminalId}`.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { messages } from '@/i18n/messages'
import { SwarmManagerPane, managerSdkStatus, type ManagerSession } from './SwarmManagerPane'
import { DEFAULT_ENGINE } from './useSwarmEngine'

// The key-echo `t` every swarm suite uses — it keeps assertions readable. It
// ALSO looks each key up in the REAL ja/en dictionaries and records a miss, so a
// key that exists only in this file's imagination cannot pass unnoticed (that is
// exactly how a green test guarded a label nobody could ever see).
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

/** An EventSource that can also DELIVER — the SDK tile learns its status from
 *  the stream and nowhere else, so a silent stub would leave every case here
 *  measuring the 'starting' default. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
  missingKeys.clear()
})

const mount = (session: ManagerSession | null) => {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  return render(
    <SwarmManagerPane
      projectPath="/proj"
      session={session}
      sessionBusy={false}
      onLaunchSession={() => {}}
      onStopSession={() => {}}
      onSessionExit={() => {}}
      onRestartSession={() => {}}
      engine={DEFAULT_ENGINE}
      available
      busy={false}
      error={null}
      onToggleOverseer={() => {}}
      sandboxWarning={false}
      runtimeDials={{ worker: 'sdk', manager: 'sdk', workerCap: 1 }}
      onToggleRuntime={() => {}}
    />,
  )
}

/** The SDK commander exactly as SwarmModule holds one: terminalId EMPTY, the
 *  handle in sdkSessionId, and NO `status` — there is no poll that can see it. */
const sdkSession = (sdkSessionId: string): ManagerSession => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId,
})

describe('managerSdkStatus', () => {
  it('speaks the beacon vocabulary, and never invents "working"', () => {
    expect(managerSdkStatus('working')).toBe('working')
    expect(managerSdkStatus('waiting')).toBe('waiting')
    // A desk parked on the usage ceiling IS waiting on something it cannot
    // supply itself — the ochre beacon's meaning everywhere else in the app.
    expect(managerSdkStatus('quota-parked')).toBe('waiting')
    expect(managerSdkStatus('exited')).toBe('exited')
    expect(managerSdkStatus('failed')).toBe('exited')
    expect(managerSdkStatus('starting')).toBe('starting')
    // Nothing heard from the stream yet — "spawned, not yet observed".
    expect(managerSdkStatus(null)).toBe('starting')
  })
})

describe('the commander beacon follows the SDK desk (②)', () => {
  const beacon = (getByRole: ReturnType<typeof mount>['getByRole']) =>
    (getByRole('img') as HTMLElement).getAttribute('aria-label')

  it('starts at "starting" — not at a fabricated "working"', () => {
    const { getByRole } = mount(sdkSession('sdk-mgr'))
    expect(beacon(getByRole)).toBe('projectPanel.swarm.statusStarting')
  })

  it('reads WAITING when the desk says it is waiting for an answer', () => {
    const { getByRole } = mount(sdkSession('sdk-mgr'))
    act(() => {
      FakeEventSource.last.emit('frame', { seq: 1, ev: { kind: 'status', status: 'waiting' } })
    })
    expect(beacon(getByRole)).toBe('projectPanel.swarm.statusWaiting')
  })

  it('reads EXITED when the desk ends — the state a constant could never show', () => {
    const { getByRole } = mount(sdkSession('sdk-mgr'))
    act(() => {
      FakeEventSource.last.emit('end', { session: { status: 'exited', reaped: true } })
    })
    expect(beacon(getByRole)).toBe('projectPanel.swarm.statusExited')
  })

  it('still uses the PTY poll for a PTY commander', () => {
    const { getByRole } = mount({ terminalId: 'pty-mgr', runtime: 'pty', status: 'waiting' })
    expect(beacon(getByRole)).toBe('projectPanel.swarm.statusWaiting')
  })

  it('does not inherit the dead desk’s last word after a relaunch', () => {
    const { getByRole, rerender } = mount(sdkSession('sdk-old'))
    act(() => {
      FakeEventSource.last.emit('frame', { seq: 1, ev: { kind: 'status', status: 'working' } })
    })
    expect(beacon(getByRole)).toBe('projectPanel.swarm.statusWorking')

    rerender(
      <SwarmManagerPane
        projectPath="/proj"
        session={sdkSession('sdk-new')}
        sessionBusy={false}
        onLaunchSession={() => {}}
        onStopSession={() => {}}
        onSessionExit={() => {}}
        onRestartSession={() => {}}
        engine={DEFAULT_ENGINE}
        available
        busy={false}
        error={null}
        onToggleOverseer={() => {}}
        sandboxWarning={false}
        runtimeDials={{ worker: 'sdk', manager: 'sdk', workerCap: 1 }}
        onToggleRuntime={() => {}}
      />,
    )
    expect(beacon(getByRole)).toBe('projectPanel.swarm.statusStarting')
  })
})

describe('the command bar is keyed by the DESK, not by a PTY id (③)', () => {
  const bar = (r: ReturnType<typeof mount>) =>
    r.getByLabelText('projectPanel.swarm.manager.command') as HTMLTextAreaElement

  const renderWith = (r: ReturnType<typeof mount>, session: ManagerSession) =>
    r.rerender(
      <SwarmManagerPane
        projectPath="/proj"
        session={session}
        sessionBusy={false}
        onLaunchSession={() => {}}
        onStopSession={() => {}}
        onSessionExit={() => {}}
        onRestartSession={() => {}}
        engine={DEFAULT_ENGINE}
        available
        busy={false}
        error={null}
        onToggleOverseer={() => {}}
        sandboxWarning={false}
        runtimeDials={{ worker: 'sdk', manager: 'sdk', workerCap: 1 }}
        onToggleRuntime={() => {}}
      />,
    )

  it('drops a half-typed order when the SDK commander is relaunched', () => {
    const r = mount(sdkSession('sdk-old'))
    fireEvent.change(bar(r), { target: { value: 'マージして' } })
    expect(bar(r).value).toBe('マージして')

    // A relaunch: a NEW session id, the same (empty) terminalId. Keyed on the
    // terminalId these two are indistinguishable, and the order meant for the
    // dead commander stays in the box aimed at the new one.
    renderWith(r, sdkSession('sdk-new'))
    expect(bar(r).value).toBe('')
  })

  it('keeps the draft when nothing about the desk changed', () => {
    const r = mount(sdkSession('sdk-same'))
    fireEvent.change(bar(r), { target: { value: '状況' } })
    renderWith(r, sdkSession('sdk-same'))
    expect(bar(r).value).toBe('状況')
  })

  it('still re-keys a PTY commander on its terminalId', () => {
    const r = mount({ terminalId: 'pty-a', runtime: 'pty', status: 'working' })
    fireEvent.change(bar(r), { target: { value: '掃除' } })
    renderWith(r, { terminalId: 'pty-b', runtime: 'pty', status: 'working' })
    expect(bar(r).value).toBe('')
  })
})

describe('every label this pane renders exists in BOTH locales', () => {
  it('has no imaginary keys (ja and en are checked, not the mock)', () => {
    mount(sdkSession('sdk-mgr'))
    // The mock echoes keys so the assertions above stay readable; this is what
    // stops that convenience from also making non-existent keys look fine.
    expect(Array.from(missingKeys).sort()).toEqual([])
  })
})
