import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { realpath } from 'fs/promises'
import {
  createSwarmFatalNotification,
  createSwarmInfoNotification,
  listSwarmNotifications,
  appendSwarmNotification,
  capNotificationsByKind,
  formatFatalNotification,
  buildFatalAppNotification,
  markSwarmNotificationHandled,
  SWARM_NOTIFICATIONS_CAP,
} from './swarmNotifications'
import { swarmNotificationsFile } from './paths'
import type { AppNotification, SwarmFatalNotification } from '../types'

// The in-app half of the escalation safety valve, exercised against an ISOLATED
// HOME (a tmpdir) so it never touches the real ~/.openground. OS toasts are
// suppressed ({ os: false }) so no test ever pokes the vitest worker's IPC channel
// — the OS payload is asserted separately through the pure formatter.

let home: string
// The suite-wide pin (src/test/setup-home.ts), restored in afterEach. NEVER
// `delete` it: an unset OPENGROUND_HOME makes every later openGroundHome()
// resolve to the REAL ~/.openground (the 2026-07-18 data loss).
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-swarmnotif-')))
  process.env.OPENGROUND_HOME = home
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // NOT unset — see paths.ts openGroundHome(): empty means the real
  // ~/.openground, and worker processes are reused across test files. Restore
  // the suite-wide pin rather than leaving the (about to be removed) temp dir
  // in place, so the next file inherits a home that still exists.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
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

  it('info traffic never evicts a fatal record (the cap is PER KIND)', async () => {
    // The failure this guards (adversarial review, 2026-07-19): fatal and info
    // shared one 50-slot list capped by recency, and the daily fuel report posts
    // an info record EVERY day by design — including quiet days. So a single
    // rework-exhausted / canary-failed record, the unmanned swarm's safety valve,
    // was pushed off the bell after ~50 quiet days purely by routine traffic.
    await createSwarmFatalNotification(fatal({ taskId: 'the-alarm' }), { os: false, now: 1 })
    for (let i = 0; i < SWARM_NOTIFICATIONS_CAP * 2; i++) {
      await createSwarmInfoNotification(
        { event: 'daily-fuel-report', detail: `day ${i}` },
        { os: false, now: 100 + i },
      )
    }
    const list = await listSwarmNotifications()
    // The alarm is the OLDEST record here and every info entry is newer — under a
    // shared recency cap it would be the first thing gone.
    expect(list.find((n) => n.swarmFatal?.taskId === 'the-alarm')).toBeDefined()
    // …and info is still bounded on its own side (no unbounded growth).
    expect(list.filter((n) => n.kind === 'swarm-info')).toHaveLength(SWARM_NOTIFICATIONS_CAP)
  })

  it('capNotificationsByKind: newest N of each kind, newest-first overall', () => {
    const mk = (kind: 'swarm-fatal' | 'swarm-info', createdAt: number): AppNotification => ({
      id: `${kind}:${createdAt}`,
      kind,
      createdAt,
    })
    const items = [
      ...Array.from({ length: SWARM_NOTIFICATIONS_CAP + 5 }, (_, i) => mk('swarm-info', 1000 + i)),
      ...Array.from({ length: 3 }, (_, i) => mk('swarm-fatal', i + 1)),
    ]
    const capped = capNotificationsByKind(items)
    expect(capped.filter((n) => n.kind === 'swarm-info')).toHaveLength(SWARM_NOTIFICATIONS_CAP)
    expect(capped.filter((n) => n.kind === 'swarm-fatal')).toHaveLength(3) // under cap → untouched
    // Overall ordering stays newest-first (what the bell renders).
    const stamps = capped.map((n) => n.createdAt ?? 0)
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)
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

// GUARD (2026-08-04): the Swarm tab's needs-attention feed could never go quiet.
// Notifications are persisted with no expiry (they leave only by falling out of
// the per-kind cap), so the first fatal event of an install pinned the alert
// panel open forever and the "nothing needs you" state became unreachable — a
// permanently-lit warning board is one nobody reads.
//
// The dismissal is stamped HERE, on the notification, and NOT on the bell's
// read-state: read-state means "seen" and is written wholesale the moment the
// bell is opened, so reusing it would empty the swarm's work list the first time
// the owner glanced at the bell.
describe('markSwarmNotificationHandled — the owner can retire one row', () => {
  it('stamps handledAt on exactly that row, and READS BACK through the production reader', async () => {
    const a = await createSwarmFatalNotification(fatal({ taskId: 'card-a' }), { os: false, now: 1000 })
    const b = await createSwarmFatalNotification(fatal({ taskId: 'card-b' }), { os: false, now: 2000 })

    await markSwarmNotificationHandled(a.id, 5555)

    const items = await listSwarmNotifications()
    const readA = items.find((n) => n.id === a.id)
    const readB = items.find((n) => n.id === b.id)
    expect(readA?.handledAt).toBe(5555)
    expect(readB?.handledAt).toBeUndefined() // its neighbour is untouched
    // NOTHING IS DELETED — the row is still in the store (the bell still shows it).
    expect(items).toHaveLength(2)
  })

  it('is idempotent and keeps the FIRST timestamp (a double-click must not re-date it)', async () => {
    const a = await createSwarmFatalNotification(fatal(), { os: false, now: 1000 })
    await markSwarmNotificationHandled(a.id, 5555)
    await markSwarmNotificationHandled(a.id, 9999)
    const items = await listSwarmNotifications()
    expect(items.find((n) => n.id === a.id)?.handledAt).toBe(5555)
  })

  it('an unknown or empty id writes nothing and does not throw', async () => {
    const a = await createSwarmFatalNotification(fatal(), { os: false, now: 1000 })
    await markSwarmNotificationHandled('no-such-id', 5555)
    await markSwarmNotificationHandled('', 5555)
    const items = await listSwarmNotifications()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(a.id)
    expect(items[0].handledAt).toBeUndefined()
  })

  it('survives an append afterwards — the stamp is not clobbered by the next fatal', async () => {
    // appendSwarmNotification re-reads inside the single-flight chain; a stamp
    // written before it must still be there after (the classic lost-update).
    const a = await createSwarmFatalNotification(fatal(), { os: false, now: 1000 })
    await markSwarmNotificationHandled(a.id, 5555)
    await createSwarmFatalNotification(fatal({ taskId: 'later' }), { os: false, now: 3000 })
    const items = await listSwarmNotifications()
    expect(items.find((n) => n.id === a.id)?.handledAt).toBe(5555)
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
