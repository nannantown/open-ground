// THE PRESIDENT'S DESK WAS CLOSED — nothing said meanwhile may be lost
// (owner decision 2026-09-23: the 監督 tab is gone, so the president's desk is the
// only place a question / fatal / landing is retold).
//
// End to end through the production pieces: the REAL escalation store (isolated
// HOME), the REAL notification seam (createSwarm*Notification → noticeToSupply),
// the REAL supply loop (startSupplyContextCapLoop → catchUpSupplyDesks) and the
// production `defaultDeps` — only the PTY pool is mocked, and its desk list is
// mutable so a desk can be "closed" and then "opened".
//
// RED MEASURED 2026-09-23 (each reverted after):
//   • the TTL sweep restored on the important lane → "every notice raised
//     while closed" fails (nothing reaches the desk after 2h)
//   • `catchUpSupplyDesks()` swapped back to `flushSupplyNotices()` in the loop
//     → "an app restart loses nothing" and "a reopened desk" fail
//   • `forgetSupplyQuestion(record.id)` removed from answerEscalation → "an
//     answered question is not retold" fails

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const RULE = '─'.repeat(40)
const IDLE_SCREEN = ['⏺ done.', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

const writes: [string, string][] = []
const enters: string[] = []
const typedBox = new Map<string, string>()
const IDLE_BOX = (text: string) =>
  ['⏺ done.', '', '─'.repeat(40), `❯ ${text}`, '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const pool: { id: string; cwd: string; deskLabel: string; startedAtMs: number }[] = []

vi.mock('./terminal', () => ({
  listOwnerDeskTerminals: () => pool,
  isTerminalProcessAlive: () => true,
  // Like a real desk: a paste shows in the box, the Enter clears it.
  getTerminalScreen: (id: string) => (typedBox.has(id) ? IDLE_BOX(typedBox.get(id)!) : IDLE_SCREEN),
  // Lines only: the submitting Enter is a separate bare-CR write (after the
  // paste), counted in `enters`.
  writeInput: (id: string, data: string) => {
    if (data === '\r') {
      enters.push(id)
      typedBox.delete(id)
    } else {
      writes.push([id, data])
      typedBox.set(id, data.replace('\x1b[200~', '').replace('\x1b[201~', ''))
    }
    return true
  },
}))

import { createSwarmFatalNotification } from './swarmNotifications'
import { openEscalation, answerEscalation } from './swarmEscalations'
import { resetSupplyNoticeState, queueSupplyNotice, queueSupplyReply, catchUpSupplyDesks, peekSupplyImportant, SUPPLY_NOTICE_TTL_MS } from './supplyNotice'
import { readFile, writeFile, readdir, chmod } from 'fs/promises'
import { startSupplyContextCapLoop, stopSupplyContextCapLoop } from './supplyContextCap'

let home: string
let project: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-supplyabsent-')))
  process.env.OPENGROUND_HOME = home
  project = join(home, 'proj')
  await mkdir(project)
  writes.length = 0
  enters.length = 0
  typedBox.clear()
  pool.length = 0
  resetSupplyNoticeState()
})

afterEach(async () => {
  stopSupplyContextCapLoop()
  vi.useRealTimers()
  await rm(home, { recursive: true, force: true })
  // NEVER unset — an empty OPENGROUND_HOME resolves to the REAL ~/.openground.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const openDesk = (id: string) => pool.push({ id, cwd: project, deskLabel: '補給官', startedAtMs: Date.now() })

/** Run the REAL supply loop until `cond` holds (generous timeout — the catch-up
 *  awaits a real file read, which stretches under load), then stop it and let
 *  one last catch-up settle so nothing in flight leaks into the next test. */
const runLoopUntil = async (cond: () => void) => {
  startSupplyContextCapLoop(10)
  try {
    await vi.waitFor(cond, { timeout: 10_000, interval: 20 })
  } finally {
    stopSupplyContextCapLoop()
    await catchUpSupplyDesks()
  }
}
/** Let the loop run for a while where the assertion is an ABSENCE. */
const runLoopFor = async (ms: number) => {
  startSupplyContextCapLoop(10)
  await new Promise((r) => setTimeout(r, ms))
  stopSupplyContextCapLoop()
  await catchUpSupplyDesks()
}
const told = () => writes.map(([, l]) => l).join('\n')

const ask = (plainQuestion: string) =>
  openEscalation(
    { projectPath: project, question: 'raw worker text', context: 'stakes', plainQuestion, whyEscalated: 'policy' },
    { notify: (x) => createSwarmInfoNotificationNoOs(x) },
  )

// The real seam, minus the OS toast (no osascript in tests).
const createSwarmInfoNotificationNoOs = async (x: Parameters<typeof import('./swarmNotifications').createSwarmInfoNotification>[0]) => {
  const { createSwarmInfoNotification } = await import('./swarmNotifications')
  return createSwarmInfoNotification(x, { os: false })
}

describe('a question opened while the president is closed', () => {
  it('reaches the desk, in plain words, once the president opens', async () => {
    await ask('AとBのどちらで進めますか')
    expect(writes).toEqual([]) // nobody to tell yet

    openDesk('desk-1')
    await runLoopUntil(() => expect(told()).toContain('AとBのどちらで進めますか'))
    expect(writes).toHaveLength(1)
    expect(writes[0]![0]).toBe('desk-1')
    expect(told()).not.toContain('raw worker text')
  })

  it('every notice raised while closed arrives — none overwritten, even hours later', async () => {
    await ask('一つ目の質問')
    await createSwarmFatalNotification({ event: 'high-risk-hold', detail: '高リスクなので止めました', projectPath: project }, { os: false })
    queueSupplyNotice(project, '作業が本体に入りました')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 4 * SUPPLY_NOTICE_TTL_MS)

    openDesk('desk-1')
    await runLoopUntil(() => expect(told()).toContain('作業が本体に入りました'))
    expect(told()).toContain('一つ目の質問')
    expect(told()).toContain('高リスクなので止めました')
    expect(told()).toContain('時間前')
    expect(told().split('一つ目の質問')).toHaveLength(2) // the question is not told twice
  })

  // Review 2026-09-23 (M1). RED MEASURED: savePending made a no-op → nothing but
  // the question survives the restart (the fatal and the landing are lost).
  it('an app restart loses NOTHING the desk had not heard — fatal, hold, delivery, question', async () => {
    await ask('再起動の前に聞いた質問')
    await createSwarmFatalNotification({ event: 'high-risk-hold', detail: '高リスクの変更を止めています', projectPath: project }, { os: false })
    queueSupplyNotice(project, 'お願いされていた作業が1件、本体に取り込まれました')
    resetSupplyNoticeState({ keepDisk: true }) // = the process restarted

    openDesk('desk-1')
    await runLoopUntil(() => {
      expect(told()).toContain('再起動の前に聞いた質問')
      expect(told()).toContain('高リスクの変更を止めています')
      expect(told()).toContain('本体に取り込まれました')
    })
    expect(told().split('再起動の前に聞いた質問')).toHaveLength(2)
    // Dequeued (and the saved queue rewritten) only once the Enter landed.
    await vi.waitFor(() => expect(peekSupplyImportant().size).toBe(0), { timeout: 10_000 })

    // …and what was told is not retold after ANOTHER restart (the new desk
    // hears the still-open question again, since it is a new conversation).
    writes.length = 0
    resetSupplyNoticeState({ keepDisk: true })
    pool.length = 0
    openDesk('desk-2')
    await runLoopUntil(() => expect(told()).toContain('再起動の前に聞いた質問'))
    expect(told()).not.toContain('高リスクの変更を止めています')
    expect(told()).not.toContain('本体に取り込まれました')
  })

  // 2026-09-24: replies no longer age out to the bell, so they are persisted —
  // a restart must not be what loses one. RED MEASURED: the `replies` key
  // dropped from savePending → the answer is never told.
  it('a commander reply queued for a closed desk survives an app restart', async () => {
    await queueSupplyReply(project, '入れて大丈夫です。テストは通っています', { desks: () => [] })
    resetSupplyNoticeState({ keepDisk: true }) // = the process restarted
    openDesk('desk-1')
    await runLoopUntil(() => expect(told()).toContain('入れて大丈夫です'))
  })

  // Review 2026-09-23 (S1), through the PRODUCTION reader. RED MEASURED:
  // openQuestions back on the tolerant listEscalations → the corrupt read marks
  // the desk caught up and the question never arrives.
  it('an unreadable question store is retried, not taken as "nothing waiting"', async () => {
    await ask('読めなかった質問')
    resetSupplyNoticeState() // only the store knows about it now
    const file = join(home, 'escalations.json')
    const good = await readFile(file, 'utf8')
    await writeFile(file, '{"items": [') // torn / corrupt

    openDesk('desk-1')
    await runLoopFor(300)
    expect(told()).not.toContain('読めなかった質問')

    await writeFile(file, good)
    await runLoopUntil(() => expect(told()).toContain('読めなかった質問'))
  })

  // Review rework 2 (R1): the saved queue is never overwritten by a load that
  // did not read it. RED MEASURED (reverted after): ensureLoaded back to
  // "mark loaded, any error = empty" → the transient-failure test loses the
  // saved fatal, and the damaged file is overwritten instead of moved aside.
  it('a DAMAGED saved queue is moved aside, not overwritten', async () => {
    const file = join(home, 'supply-notice-queue.json')
    await writeFile(file, '{"queues": [["x", [{"text": "壊れた')
    resetSupplyNoticeState({ keepDisk: true })
    queueSupplyNotice(project, '新しい知らせ')
    const names = await readdir(home)
    const aside = names.find((n) => n.startsWith('supply-notice-queue.json.corrupt-'))
    expect(aside).toBeTruthy()
    expect(await readFile(join(home, aside!), 'utf8')).toContain('壊れた')
    expect(await readFile(file, 'utf8')).toContain('新しい知らせ')
  })

  // The file must be UNREADABLE BUT REPLACEABLE (mode 000: read → EACCES, while
  // the rename over it still succeeds — the directory is writable). An earlier
  // version put a DIRECTORY at the path, which also made the write fail, so the
  // "never write before reading" guard in savePending could be deleted with the
  // test staying green. RED MEASURED 2026-09-23 (reverted after): the
  // `if (!diskState.loaded) return` guard in savePending removed → this test
  // fails (the write-through replaces the file and 保存されていた停止 is lost).
  // Skipped as root / on Windows, where mode 000 does not stop a read.
  const canMakeUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

  it.skipIf(!canMakeUnreadable)('a TRANSIENT read failure keeps the saved notices; they arrive once it is readable', async () => {
    const file = join(home, 'supply-notice-queue.json')
    await createSwarmFatalNotification({ event: 'high-risk-hold', detail: '保存されていた停止', projectPath: project }, { os: false })
    resetSupplyNoticeState({ keepDisk: true }) // restart
    await chmod(file, 0o000)
    queueSupplyNotice(project, '失敗中に来た知らせ')

    await chmod(file, 0o600)
    openDesk('desk-1')
    await runLoopUntil(() => {
      expect(told()).toContain('保存されていた停止')
      expect(told()).toContain('失敗中に来た知らせ')
    })
  })

  // Review 2026-09-23 (S2). RED MEASURED (reverted after): the disk load
  // restoring questions again (the `continue` on escalationId removed) → the
  // question is typed into desk-1 twice.
  it.skipIf(!canMakeUnreadable)('a question caught up while the saved queue was unreadable is not told again when it becomes readable', async () => {
    const file = join(home, 'supply-notice-queue.json')
    await ask('一度だけ聞きたい質問') // no desk → saved in the queue file
    resetSupplyNoticeState({ keepDisk: true }) // restart
    await chmod(file, 0o000)

    openDesk('desk-1')
    await runLoopUntil(() => expect(told()).toContain('一度だけ聞きたい質問')) // from the store
    await chmod(file, 0o600)
    await runLoopFor(300) // the file is now read and merged
    expect(told().split('一度だけ聞きたい質問')).toHaveLength(2)
  })

  // Review 2026-09-23 (S3). RED MEASURED (reverted after): same revert → the
  // answered question is retold after the restart.
  it.skipIf(!canMakeUnreadable)('a question answered while the saved queue was unreadable is not retold after a restart', async () => {
    const file = join(home, 'supply-notice-queue.json')
    const { escalation } = await ask('読めない間に答えた質問')
    resetSupplyNoticeState({ keepDisk: true }) // restart
    await chmod(file, 0o000)
    await answerEscalation(escalation.id, 'A') // its withdrawal cannot be written
    await chmod(file, 0o600)
    expect(await readFile(file, 'utf8')).toContain('読めない間に答えた質問') // still on disk

    resetSupplyNoticeState({ keepDisk: true }) // restart
    openDesk('desk-1')
    await runLoopFor(300)
    expect(told()).not.toContain('読めない間に答えた質問')
  })

  it('an answered question is not retold', async () => {
    const { escalation } = await ask('もう答えた質問')
    await answerEscalation(escalation.id, 'A')

    openDesk('desk-1')
    await runLoopFor(300)
    expect(told()).not.toContain('もう答えた質問')
  })

  it('a reopened (new) desk is told the still-open question again; the same desk is not', async () => {
    await ask('まだ答えていない質問')
    openDesk('desk-1')
    await runLoopUntil(() => expect(told()).toContain('まだ答えていない質問'))
    await runLoopFor(200) // many more passes
    expect(writes.filter(([id]) => id === 'desk-1')).toHaveLength(1)

    pool.length = 0
    openDesk('desk-2')
    await runLoopUntil(() =>
      expect(writes.filter(([id]) => id === 'desk-2').map(([, l]) => l).join('')).toContain('まだ答えていない質問'),
    )
  })
})
