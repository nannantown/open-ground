import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, realpath, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createSwarmFatalNotification,
  createSwarmInfoNotification,
  registerIncomingNotifications,
} from './swarmNotifications'
import { OS_NOTIFY_MESSAGE, WINDOW_FOCUS_MESSAGE, setWindowFocused } from './osNotify'
import type { SwarmFatalEvent, SwarmInfoEvent } from '../types'

// Guard for the owner decision of 2026-09-26: a Mac toast only for the three
// events that must reach the owner while they look elsewhere, and never while
// the OPEN GROUND window is in front. The bell record is written regardless.
// Observed through the real IPC seam (process.send), not a mocked gate.

// Record<Union, …> makes tsc fail when a new event is added without a decision
// here — and the expected default for a new event is "no toast".
const INFO: Record<SwarmInfoEvent, boolean> = {
  'escalation-open': true,
  'session-limit': true,
  'stuck-processes': true,
  'escalation-reminder': false,
  'review-idle': false,
  'overseer-throttled': false,
  'manager-woke': false,
  'self-update-requested': false,
  'daily-fuel-report': false,
  'engine-resumed': false,
  'commander-reply': false,
  'supply-notice-unsent': false,
  'ready-without-work': false,
  'work-landed': false,
}
const FATAL: Record<SwarmFatalEvent, false> = {
  'rework-exhausted': false,
  'all-workers-down': false,
  'exec-timeout': false,
  'guard-unwired': false,
  rollback: false,
  'canary-failed': false,
  'review-panel-failed': false,
  'high-risk-hold': false,
  'manager-unrevivable': false,
  'worker-spawn-failed': false,
  'manager-unresponsive': false,
  'engine-resume-suppressed': false,
  'data-integrity': false,
}

let home: string
const prevHome = process.env.OPENGROUND_HOME
const prevSend = process.send
let send: ReturnType<typeof vi.fn>
const toasts = () => send.mock.calls.filter(([m]) => m?.type === OS_NOTIFY_MESSAGE)

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-osgate-')))
  process.env.OPENGROUND_HOME = home
  send = vi.fn(() => true)
  process.send = send as unknown as typeof process.send
  setWindowFocused(false)
})

afterEach(async () => {
  process.send = prevSend
  setWindowFocused(false)
  await rm(home, { recursive: true, force: true })
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

describe('Mac toast gate', () => {
  for (const [event, allowed] of Object.entries(INFO) as [SwarmInfoEvent, boolean][]) {
    it(`info ${event}: toast=${allowed}, bell always`, async () => {
      const app = await createSwarmInfoNotification({ event, detail: 'x' }, { now: 1 })
      expect(toasts()).toHaveLength(allowed ? 1 : 0)
      const file = await readFile(join(home, 'swarm-notifications.json'), 'utf8')
      expect(file).toContain(app.id)
    })
  }

  for (const event of Object.keys(FATAL) as SwarmFatalEvent[]) {
    it(`fatal ${event}: no toast`, async () => {
      await createSwarmFatalNotification({ event, detail: 'x' }, { now: 1 })
      expect(toasts()).toHaveLength(0)
    })
  }

  it('no toast while the OPEN GROUND window is focused (relayed from Electron)', async () => {
    registerIncomingNotifications()
    process.emit('message', { type: WINDOW_FOCUS_MESSAGE, focused: true }, undefined)
    for (const event of ['escalation-open', 'session-limit', 'stuck-processes'] as const) {
      await createSwarmInfoNotification({ event, detail: 'x' }, { now: 1 })
    }
    expect(toasts()).toHaveLength(0)

    process.emit('message', { type: WINDOW_FOCUS_MESSAGE, focused: false }, undefined)
    await createSwarmInfoNotification({ event: 'escalation-open', detail: 'x' }, { now: 2 })
    expect(toasts()).toHaveLength(1)
  })

  it('electron/main.js raises no toast of its own (only the gated server message)', async () => {
    const src = await readFile(join(process.cwd(), 'electron/main.js'), 'utf8')
    const calls = src.match(/\bshowOsNotification\(/g) ?? []
    // 1 definition + 1 call in the OS_NOTIFY_MESSAGE handler.
    expect(calls).toHaveLength(2)
    expect(src).toMatch(/msg\.type === OS_NOTIFY_MESSAGE\) \{\s*showOsNotification\(/)
    // electron-updater's AndNotify variant shows its own "update ready" toast.
    expect(src).not.toMatch(/\.checkForUpdatesAndNotify\(/)
    expect(src.match(/new Notification\(/g) ?? []).toHaveLength(1)
  })
})
