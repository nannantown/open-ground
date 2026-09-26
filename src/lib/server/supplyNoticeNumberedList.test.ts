// An IDLE president desk whose last answer ended in a numbered list held every
// commander reply until a restart repainted it (Echona, 2026-09-26: three
// replies told 51–60 minutes late, "(約56分前の返事)"). detectMenu read the list
// as an open chooser because the idle footer every president shows —
// `⏵⏵ bypass permissions on (shift+tab to cycle)` — matched its footer gate.
// Reproduced on a real claude PTY with scripts/probe-supply-numbered-list.mts;
// FRAME below is that probe's idle frame (the transcript-warning row dropped).
//
// RED MEASURED 2026-09-26 (claudeMenu.ts gate reverted to "footer anywhere or a
// trailing ?", then restored): the first three tests fail — the reply stays
// queued, exactly the production symptom. The journal tests fail with the
// noteHold call removed from the busy branch.
import { beforeEach, describe, expect, it } from 'vitest'
import { detectMenu } from '@/lib/claudeMenu'
import { noticeDeliverable, noticeHoldReason } from './deskDeliverable'
import {
  flushSupplyNotices,
  peekSupplyReplies,
  queueSupplyReply,
  resetSupplyNoticeState,
  SUPPLY_HOLD_LOG_MS,
} from './supplyNotice'

const PROJECT = '/repo/alpha'
const DESK = 'term-president'
const RULE = '─'.repeat(158)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const FRAME = [
  '⏺ このあとの作業を、次の順番で並べています。',
  '  1. 保存先の選択肢',
  '  2. ウェブの案内ページ',
  '  3. 画面写真と説明文',
  '',
  '  順番どおりに進めます。',
  '',
  '✻ Brewed for 2s · done 7:24 PM',
  '',
  RULE,
  '❯ ',
  RULE,
  FOOTER,
].join('\n')
// The president asking the owner to choose — the other shape the old gate
// misread (a list under a line ending in "?").
const QUESTION_FRAME = FRAME.replace('このあとの作業を、次の順番で並べています。', 'どちらにしますか?')
const BUSY = [...FRAME.split('\n').slice(0, -1), `${FOOTER} · esc to interrupt`].join('\n')
// REAL chooser frames, captured on claude 2.1.283 at 158x22 in bypass mode with
// scripts/probe-desk-choosers.mts (long rows trimmed). A chooser replaces the
// input box — its cursor row is the last ❯ on screen.
const MODEL_MENU = [
  '▔'.repeat(158),
  '   Select model',
  '   Switch between Claude models. Your pick becomes the default for new sessions.',
  '',
  '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
  '   ❯ 2.  Opus 5.5 ✔             Most capable for ambitious work',
  '      … +9 models',
  '',
  '   ◐ Medium effort (default) ←/→ to adjust',
  '',
  '   Enter to set as default · s to use this session only · Esc to cancel',
].join('\n')
const ASK_MENU = [
  '❯ AskUserQuestion ツールで「色はどれにしますか?」と1問だけ聞いてください。',
  '',
  RULE,
  ' ☐ 色 ',
  '',
  '色はどれにしますか?',
  '',
  '❯ 1. 赤',
  '     赤を選ぶ',
  '  2. 青',
  '     青を選ぶ',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')
// The owner's own numbered message in the history, above the live input box.
const OWNER_LIST_FRAME = ['❯ 1. 保存先を先に', '  2. 案内ページはあとで', '', '⏺ 承知しました。', '', RULE, '❯ ', RULE, FOOTER].join('\n')

const instant = async (): Promise<void> => {}

/** A desk showing `idle` (or `busy()` while it returns true) until our Enter lands. */
const desk = (idle: string, busy: () => boolean = () => false) => {
  let state = 'before'
  const logs: string[] = []
  return {
    logs,
    deps: {
      desks: () => [{ id: DESK, cwd: PROJECT }],
      screen: () =>
        busy() ? BUSY : state === 'before' || state === 'after' ? idle : `${RULE}\n❯ ${state}\n${RULE}\n${FOOTER}`,
      write: (_id: string, data: string) => {
        state = data === '\r' ? 'after' : data.replace(/\x1b\[20[01]~/g, '')
        return true
      },
      sleep: instant,
      onReplyExpired: () => {},
      onNoticeGivenUp: () => {},
      openQuestions: async () => [],
      log: (_p: string, _l: string, m: string) => void logs.push(m),
    },
  }
}

beforeEach(() => resetSupplyNoticeState())

describe('supply notice vs a numbered list left on an idle president desk', () => {
  it('an answer ending in a numbered list is not a menu', () => {
    expect(detectMenu(FRAME)).toBeNull()
    expect(detectMenu(QUESTION_FRAME)).toBeNull()
    expect(noticeDeliverable(FRAME)).toBe(true)
    expect(noticeDeliverable(QUESTION_FRAME)).toBe(true)
  })

  it('delivers a commander reply to that desk at once', async () => {
    const { deps } = desk(FRAME)
    await queueSupplyReply(PROJECT, '朝と夜のタイムラインを本体に取り込みました', deps)
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
  })

  it('delivers under a list that follows a question too', async () => {
    const { deps } = desk(QUESTION_FRAME)
    await queueSupplyReply(PROJECT, '録音の削除を本体に取り込みました', deps)
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
  })

  it('still refuses a real chooser, and names it', () => {
    expect(noticeHoldReason(MODEL_MENU)).toBe('menu')
    expect(noticeHoldReason(ASK_MENU)).toBe('menu')
  })

  it('the owner\'s own numbered message is conversation, not a menu', async () => {
    expect(detectMenu(OWNER_LIST_FRAME)).toBeNull()
    const { deps } = desk(OWNER_LIST_FRAME)
    await queueSupplyReply(PROJECT, '承りました', deps)
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
  })
})

describe('a hold that lasts is written to the engine journal', () => {
  it('one line once the desk has held a reply past SUPPLY_HOLD_LOG_MS, with the reason', async () => {
    let now = 1_000_000
    let busy = true
    const { deps, logs } = desk(FRAME, () => busy)
    const clocked = { ...deps, now: () => now }
    await queueSupplyReply(PROJECT, '返事', clocked)
    now += SUPPLY_HOLD_LOG_MS - 60_000
    await flushSupplyNotices(clocked)
    expect(logs).toEqual([])
    now += 2 * 60_000
    await flushSupplyNotices(clocked)
    now += 5 * 60_000
    await flushSupplyNotices(clocked)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('(generating)')
    busy = false
    await flushSupplyNotices(clocked)
    expect(peekSupplyReplies().get(PROJECT) ?? []).toHaveLength(0)
  })

  it('the hold clock restarts after a delivery', async () => {
    let now = 1_000_000
    let busy = true
    const { deps, logs } = desk(FRAME, () => busy)
    const clocked = { ...deps, now: () => now }
    await queueSupplyReply(PROJECT, '一つ目', clocked)
    now += SUPPLY_HOLD_LOG_MS / 2
    busy = false
    await flushSupplyNotices(clocked) // delivered
    busy = true
    now += SUPPLY_HOLD_LOG_MS
    await queueSupplyReply(PROJECT, '二つ目', clocked) // held from here, not from the first
    now += 60_000
    await flushSupplyNotices(clocked)
    expect(logs).toEqual([])
  })
})
