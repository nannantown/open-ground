// Guard: a question that CLOSES reaches the president desks, and an undelivered
// line that still asks it is withdrawn (owner report 2026-09-24 — a president
// retold two already-answered questions as 「まだ判断待ち」 because it only ever
// heard the OPEN side). Drives the real answerEscalation / dismissEscalation
// against a temp store; only the PTY pool is faked (two live president desks,
// both busy so nothing is typed and the queues can be read back).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { openEscalation, answerEscalation, dismissEscalation } from './swarmEscalations'
import { noticeToSupply, peekSupplyImportant, resetSupplyNoticeState } from './supplyNotice'
import { buildInfoAppNotification } from './swarmNotifications'

const { desks } = vi.hoisted(() => ({ desks: [] as { id: string; cwd: string }[] }))
vi.mock('./terminal', () => ({
  listOwnerDeskTerminals: () => desks.map((d) => ({ ...d, deskLabel: '社長' })),
  isTerminalProcessAlive: () => true,
  getTerminalScreen: () =>
    ['⏺ working', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on · esc to interrupt'].join('\n'),
  writeInput: () => false,
}))
vi.mock('./swarmSupply', () => ({ SUPPLY_DESK_LABEL: '社長' }))

let home: string
let alpha: string
let beta: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-qclosed-')))
  process.env.OPENGROUND_HOME = home
  alpha = join(home, 'alpha')
  beta = join(home, 'beta')
  await mkdir(alpha, { recursive: true })
  await mkdir(beta, { recursive: true })
  desks.length = 0
  desks.push({ id: 'desk-alpha', cwd: alpha }, { id: 'desk-beta', cwd: beta })
  resetSupplyNoticeState()
})

afterEach(async () => {
  resetSupplyNoticeState()
  await rm(home, { recursive: true, force: true })
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const open = async (question = 'raw worker question') =>
  (
    await openEscalation(
      {
        projectPath: alpha,
        question,
        plainQuestion: '公開してよいですか? A: 公開 B: 待つ',
        context: 'ctx',
        whyEscalated: 'irreversible',
      },
      { notify: async () => undefined },
    )
  ).escalation

const queueOpenNotice = (id: string) =>
  noticeToSupply(
    buildInfoAppNotification({ event: 'escalation-open', detail: '質問が届いています: 公開してよいですか?', projectPath: alpha, escalationId: id }, 1_000),
  )

const lines = (p: string) => peekSupplyImportant().get(p) ?? []

describe('a closed question reaches every president desk', () => {
  it('answered: withdraws the undelivered open line and tells both desks (other project too)', async () => {
    const e = await open()
    expect(e.routedTo).not.toBe('commander')
    await queueOpenNotice(e.id)
    expect(lines(alpha).some((l) => l.includes('質問が届いています'))).toBe(true)

    await answerEscalation(e.id, 'A: 公開')

    for (const p of [alpha, beta]) expect(lines(p).some((l) => l.includes('質問が届いています'))).toBe(false)
    // Its own project: in full (question + answer).
    expect(lines(alpha).some((l) => l.includes('公開してよいですか') && l.includes('「A: 公開」と答え済み'))).toBe(true)
    // Another project: ONE short line — project name + what happened, still
    // saying it is no longer waiting (owner decision 2026-09-25).
    expect(lines(beta)).toHaveLength(1)
    expect(lines(beta)[0]).toContain('alpha の質問は答え済みです(alpha の判断待ちはもうありません)')
  })

  it('another project never hears the question, the answer or the choices', async () => {
    const e = await open()
    await answerEscalation(e.id, 'A: 公開')
    const other = lines(beta).join('\n')
    expect(other).toContain('alpha の質問は答え済み')
    expect(other).toContain('判断待ちはもうありません')
    for (const leak of ['公開してよいですか', 'A: 公開', 'B: 待つ', 'raw worker question']) expect(other).not.toContain(leak)
  })

  it('two closes in one other project are two distinct lines, each with the remaining count', async () => {
    const e1 = await open()
    const e2 = await open('another worker question')
    await answerEscalation(e1.id, 'A: 公開')
    await answerEscalation(e2.id, 'B: 待つ')
    // Neither is swallowed by the text dedup, and the other desk can keep an
    // exact per-project waiting count.
    const q = lines(beta)
    expect(q).toHaveLength(2)
    expect(q[0]).toContain('alpha の判断待ちは残り1件')
    expect(q[1]).toContain('alpha の判断待ちはもうありません')
  })

  it('dismissed: told as withdrawn (other project: the short line)', async () => {
    const e = await open()
    await dismissEscalation(e.id)
    for (const p of [alpha, beta]) expect(lines(p).some((l) => l.includes('取り下げ済み'))).toBe(true)
    expect(lines(beta).join('\n')).not.toContain('公開してよいですか')
  })

  it('the desk that closed it is not told again', async () => {
    const e = await open()
    await answerEscalation(e.id, 'B: 待つ', undefined, { fromDesk: beta })
    expect(lines(beta)).toEqual([])
    expect(lines(alpha).some((l) => l.includes('答え済み'))).toBe(true)
  })
})
