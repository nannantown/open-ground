import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { realpath } from 'fs/promises'
import {
  createSwarmFatalNotification,
  listSwarmNotifications,
  appendSwarmNotification,
  formatFatalNotification,
  buildFatalAppNotification,
  SWARM_NOTIFICATIONS_CAP,
} from './swarmNotifications'
import { swarmNotificationsFile } from './paths'
import type { SwarmFatalNotification } from '../types'

// The in-app half of the escalation safety valve, exercised against an ISOLATED
// HOME (a tmpdir) so it never touches the real ~/.openground. OS toasts are
// suppressed ({ os: false }) so no test ever pokes the vitest worker's IPC channel
// — the OS payload is asserted separately through the pure formatter.

let home: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-swarmnotif-')))
  process.env.OPENGROUND_HOME = home
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  delete process.env.OPENGROUND_HOME
})

const fatal = (over: Partial<SwarmFatalNotification> = {}): SwarmFatalNotification => ({
  event: 'rework-exhausted',
  detail: 'a card was parked',
  projectPath: '/proj',
  taskId: 'card-1',
  branch: 'swarm/card-1',
  taskTitle: 'fix the thing',
  logHint: "Board の 'blocked' 列を確認",
  ...over,
})

describe('swarmNotifications — store round-trip (HOME-isolated)', () => {
  it('persists a fatal notification the bell can read back', async () => {
    const created = await createSwarmFatalNotification(fatal(), { os: false, now: 1000 })
    expect(created.kind).toBe('swarm-fatal')
    expect(created.createdAt).toBe(1000)
    expect(created.swarmFatal?.event).toBe('rework-exhausted')

    const list = await listSwarmNotifications()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(created.id)
    expect(list[0].swarmFatal?.taskId).toBe('card-1')
    expect(list[0].swarmFatal?.branch).toBe('swarm/card-1')

    // It actually hit the isolated home (not the real one).
    const raw = JSON.parse(await readFile(swarmNotificationsFile(), 'utf8'))
    expect(raw.items).toHaveLength(1)
  })

  it('lists newest-first regardless of insert order', async () => {
    await createSwarmFatalNotification(fatal({ taskId: 'a' }), { os: false, now: 100 })
    await createSwarmFatalNotification(fatal({ taskId: 'b' }), { os: false, now: 300 })
    await createSwarmFatalNotification(fatal({ taskId: 'c' }), { os: false, now: 200 })
    const list = await listSwarmNotifications()
    expect(list.map((n) => n.swarmFatal?.taskId)).toEqual(['b', 'c', 'a'])
  })

  it('caps the persisted set to the newest SWARM_NOTIFICATIONS_CAP', async () => {
    for (let i = 0; i < SWARM_NOTIFICATIONS_CAP + 10; i++) {
      // unique branch per occurrence → unique id (no dedup collapsing them)
      await createSwarmFatalNotification(fatal({ branch: `swarm/b${i}` }), { os: false, now: i + 1 })
    }
    const list = await listSwarmNotifications()
    expect(list).toHaveLength(SWARM_NOTIFICATIONS_CAP)
    // The newest survived; the oldest scrolled off.
    expect(list[0].createdAt).toBe(SWARM_NOTIFICATIONS_CAP + 10)
    expect(list.some((n) => n.createdAt === 1)).toBe(false)
  })

  it('survives a hand-corrupted file (non-array items) without crashing', async () => {
    await appendSwarmNotification(buildFatalAppNotification(fatal(), 1))
    // Corrupt it the way a careless hand-edit might.
    await rm(swarmNotificationsFile(), { force: true })
    const list = await listSwarmNotifications()
    expect(list).toEqual([])
  })

  it('an empty/absent store reads as no notifications', async () => {
    expect(await listSwarmNotifications()).toEqual([])
  })
})

describe('swarmNotifications — OS toast formatting (条件3: 何が/どのカード/導線)', () => {
  it('carries WHAT happened, the card+branch, and the engine-log 導線', () => {
    const toast = formatFatalNotification(fatal())
    expect(toast.title).toContain('OPEN GROUND')
    // what happened
    expect(toast.body).toContain('a card was parked')
    // which card + branch
    expect(toast.body).toContain('fix the thing')
    expect(toast.body).toContain('swarm/card-1')
    // the 導線 (where to look)
    expect(toast.body).toContain("Board の 'blocked' 列を確認")
  })

  it('uses a distinct title label per event', () => {
    expect(formatFatalNotification(fatal({ event: 'all-workers-down' })).title).toContain(
      'all workers stopped',
    )
    expect(formatFatalNotification(fatal({ event: 'exec-timeout' })).title).toContain('time limit')
    expect(formatFatalNotification(fatal({ event: 'rollback' })).title).toContain('rolled back')
    expect(formatFatalNotification(fatal({ event: 'canary-failed' })).title).toContain('canary')
  })

  it('omits the card/branch parens and hint when absent', () => {
    const toast = formatFatalNotification({
      event: 'all-workers-down',
      detail: 'zero workers',
    })
    expect(toast.body).toBe('zero workers')
  })
})

describe('swarmNotifications — id shape (read-state key)', () => {
  it('builds a stable, occurrence-unique id: swarm-fatal:event:ref:createdAt', () => {
    const app = buildFatalAppNotification(fatal({ taskId: 'card-9' }), 4242)
    expect(app.id).toBe('swarm-fatal:rework-exhausted:card-9:4242')
  })

  it('falls back ref to branch, then projectPath, then global', () => {
    expect(buildFatalAppNotification({ event: 'rollback', detail: 'x', branch: 'swarm/z' }, 1).id).toBe(
      'swarm-fatal:rollback:swarm/z:1',
    )
    expect(
      buildFatalAppNotification({ event: 'rollback', detail: 'x', projectPath: '/p' }, 1).id,
    ).toBe('swarm-fatal:rollback:/p:1')
    expect(buildFatalAppNotification({ event: 'rollback', detail: 'x' }, 1).id).toBe(
      'swarm-fatal:rollback:global:1',
    )
  })
})
