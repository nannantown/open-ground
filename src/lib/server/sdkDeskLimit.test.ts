// The SDK desk's model-limit watch.
//
// Its whole claim is that the elaborate PTY watch (quiet window, confirm window,
// three-clean-read re-arm — ownerDeskLimit.ts) exists to compensate for reading
// a SCREEN, and that none of it is needed when the CLI simply tells you. These
// tests pin that the shortcut is taken only where it is justified: the event is
// trusted BECAUSE sdkEvents recognised it with the SDK's own prefix list, and
// everything else — the wording, the message, the never-touch-the-desk rule —
// is still shared with the PTY watch.

import { describe, it, expect, vi } from 'vitest'
import { watchSdkDeskForLimit } from './sdkDeskLimit'
import type { SdkStreamFrame } from './sdkSession'
import type { SwarmInfoNotification } from '../types'

/** A fake pool: hands the listener back so a test can push frames at it. */
const fakeAttach = (replay: SdkStreamFrame[] = []) => {
  let cb: ((f: SdkStreamFrame) => void) | null = null
  const detach = vi.fn()
  const attach = vi.fn((_id: string, _from: number, listener: (f: SdkStreamFrame) => void) => {
    cb = listener
    return { replay, truncated: false, detach }
  })
  return { attach: attach as never, emit: (f: SdkStreamFrame) => cb?.(f), detach }
}

const frame = (raw: string, seq = 1): SdkStreamFrame => ({ seq, ev: { kind: 'quota_refusal', raw } })

const ACCOUNT_WIDE = "You've reached your usage limit. Your limit resets at 3pm."
const MODEL_SWITCHABLE =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

const settle = () => new Promise((r) => setImmediate(r))

describe('watchSdkDeskForLimit', () => {
  it('tells the owner ONCE, naming the desk and the project', async () => {
    const f = fakeAttach()
    const notify = vi.fn(async (_n: SwarmInfoNotification) => {})
    watchSdkDeskForLimit({
      sdkSessionId: 's1',
      cwd: '/repo',
      deskLabel: '司令官',
      deps: { attach: f.attach, notify, project: async () => ({ label: 'OPEN GROUND', path: '/repo' }) },
    })
    f.emit(frame(MODEL_SWITCHABLE))
    await settle()
    expect(notify).toHaveBeenCalledOnce()
    const n = notify.mock.calls[0][0]
    expect(n.event).toBe('session-limit')
    expect(n.detail).toContain('司令官')
    expect(n.projectPath).toBe('/repo')
  })

  it('does not ring twice for the same session', async () => {
    // The same refusal arrives again on the next turn (the owner types, the
    // limit is still spent). One bell per stop; a bell per attempt is noise.
    const f = fakeAttach()
    const notify = vi.fn(async () => {})
    watchSdkDeskForLimit({
      sdkSessionId: 's1',
      cwd: '/repo',
      deskLabel: '司令官',
      deps: { attach: f.attach, notify, project: async () => null },
    })
    f.emit(frame(ACCOUNT_WIDE, 1))
    f.emit(frame(ACCOUNT_WIDE, 2))
    await settle()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('ignores every event that is not a quota refusal', async () => {
    const f = fakeAttach()
    const notify = vi.fn(async () => {})
    watchSdkDeskForLimit({
      sdkSessionId: 's1',
      cwd: '/repo',
      deskLabel: '司令官',
      deps: { attach: f.attach, notify, project: async () => null },
    })
    f.emit({ seq: 1, ev: { kind: 'text', text: "You've reached your usage limit — quoting a screen" } })
    f.emit({ seq: 2, ev: { kind: 'tool_use', name: 'Bash', detail: 'git status' } })
    f.emit({ seq: 3, ev: { kind: 'api_error', status: 500, head: 'boom' } })
    await settle()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a refusal already in the buffer is not missed (replay from seq 0)', async () => {
    const f = fakeAttach([frame(ACCOUNT_WIDE)])
    const notify = vi.fn(async () => {})
    watchSdkDeskForLimit({
      sdkSessionId: 's1',
      cwd: '/repo',
      deskLabel: '司令官',
      deps: { attach: f.attach, notify, project: async () => null },
    })
    await settle()
    expect(notify).toHaveBeenCalledOnce()
    expect(f.attach).toHaveBeenCalledWith('s1', 0, expect.any(Function))
  })

  it('classifies the kind with the SHARED wording module, not a private copy', async () => {
    const seen: string[] = []
    for (const raw of [MODEL_SWITCHABLE, ACCOUNT_WIDE]) {
      const f = fakeAttach()
      const notify = vi.fn(async (n: SwarmInfoNotification) => {
        seen.push(n.detail)
      })
      watchSdkDeskForLimit({
        sdkSessionId: 's1',
        cwd: '/repo',
        deskLabel: '司令官',
        deps: { attach: f.attach, notify, project: async () => null },
      })
      f.emit(frame(raw))
      await settle()
    }
    // The two stops give DIFFERENT advice — that difference is the whole reason
    // the kind is classified rather than assumed.
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })

  it('a failed bell never escapes into the session pump', async () => {
    const f = fakeAttach()
    watchSdkDeskForLimit({
      sdkSessionId: 's1',
      cwd: '/repo',
      deskLabel: '司令官',
      deps: {
        attach: f.attach,
        notify: async () => {
          throw new Error('notification store is down')
        },
        project: async () => null,
      },
    })
    expect(() => f.emit(frame(ACCOUNT_WIDE))).not.toThrow()
    await settle()
  })

  it('returns null when the session cannot be subscribed to', () => {
    expect(
      watchSdkDeskForLimit({
        sdkSessionId: 'gone',
        cwd: '/repo',
        deskLabel: '司令官',
        deps: { attach: (() => null) as never },
      }),
    ).toBeNull()
  })
})
