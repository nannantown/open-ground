import { describe, it, expect, afterEach } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  closesOnQuestion,
  presidentAskedAtFromJsonl,
  promptAuthor,
  readPresidentAskedAtFile,
} from './groundMarks'
import { SUPPLY_NOTICE_PREFIX, SUPPLY_REPLY_PREFIX } from './supplyNotice'
import { groundLamp } from '@/lib/groundLamp'

const ms = (hh: string) => Date.parse(`2026-09-26T${hh}:00.000Z`)
const iso = (hh: string) => new Date(ms(hh)).toISOString()
const assistant = (text: string, hh = '03:00', extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(hh), message: { content: [{ type: 'text', text }] }, ...extra })
const toolUse = () =>
  JSON.stringify({ type: 'assistant', timestamp: iso('03:00'), message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
const toolResult = () =>
  JSON.stringify({ type: 'user', timestamp: iso('03:00'), message: { content: [{ type: 'tool_result', content: 'ok' }] } })
const owner = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: iso('02:00'), message: { content: text }, ...extra })
// The two lines the app actually types into the president's desk (supplyNotice.ts).
const notice = (text: string) => owner(`${SUPPLY_NOTICE_PREFIX}${text} (自動の知らせ。平易に1〜3行)`)
const commanderReply = (text: string) => owner(`${SUPPLY_REPLY_PREFIX}${text}`)
const compactSummary = () =>
  owner('This session is being continued from a previous conversation that ran out of context.', {
    isCompactSummary: true,
  })

describe('presidentAskedAtFromJsonl — is the president waiting on the owner?', () => {
  it('a reply to the owner ending in ？ ⇒ its timestamp', () => {
    expect(presidentAskedAtFromJsonl([owner('進めて'), assistant('A と B、どちらにしますか？')])).toBe(ms('03:00'))
  })

  it('ASCII ?, trailing markdown and brackets still count', () => {
    expect(presidentAskedAtFromJsonl([owner('pick'), assistant('Which one — A or B?**\n')])).toBe(ms('03:00'))
    expect(presidentAskedAtFromJsonl([owner('どう'), assistant('(どちらでしょう？)')])).toBe(ms('03:00'))
  })

  it('a reply to the owner ending in a statement ⇒ not asking', () => {
    expect(presidentAskedAtFromJsonl([owner('相談'), assistant('質問はありますか？\n\n以上で完了です。')])).toBeUndefined()
  })

  it('through tool calls in between, the LAST text of the owner turn decides', () => {
    expect(
      presidentAskedAtFromJsonl([owner('ログイン画面を直したい'), toolUse(), toolResult(), assistant('A と B、どちらにしますか？')]),
    ).toBe(ms('03:00'))
    // asked, then carried on and ended on a statement ⇒ not asking
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('調べますか？'), toolUse(), toolResult(), assistant('調べました。')])).toBeUndefined()
    // mid-turn (last is a tool call) ⇒ not finished asking
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('調べますか？'), toolUse()])).toBeUndefined()
  })

  it('an API error line is not a question', () => {
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('rate limited?', '03:00', { isApiErrorMessage: true })])).toBeUndefined()
  })

  it('skips meta / non-conversation lines and a torn partial line', () => {
    expect(
      presidentAskedAtFromJsonl([
        '{"type":"assis',
        owner('相談'),
        assistant('どうしますか？'),
        owner('<system>', { isMeta: true }),
        JSON.stringify({ type: 'system', subtype: 'x' }),
      ]),
    ).toBe(ms('03:00'))
  })

  // ── the guards the commander ordered (rework 2, 2026-09-26) ────────────────
  it('owner → question → app notice → a plain retelling ⇒ STILL the question', () => {
    // Autopilot types a notice every few minutes; the president retells it.
    // Neither is the owner answering, so the question stands.
    expect(
      presidentAskedAtFromJsonl([
        owner('ログイン画面を直したい'),
        assistant('A と B、どちらにしますか？', '03:00'),
        notice('カード1枚が本体に入りました'),
        assistant('ログイン修正が入りました。', '03:10'),
        commanderReply('統合しました'),
        assistant('統合が済みました。', '03:20'),
      ]),
    ).toBe(ms('03:00'))
  })

  it('the ? of a retelling alone ⇒ no question — after a delivery the card shows the EYE', () => {
    const lines = [
      owner('A でお願い'),
      assistant('了解です。'),
      notice('ログイン修正が本体に入りました'),
      toolUse(),
      toolResult(),
      assistant('ログインの修正が入りました。これで OK ですか？', '03:30'),
    ]
    const askedAt = presidentAskedAtFromJsonl(lines)
    expect(askedAt).toBeUndefined()
    expect(
      groundLamp({ started: 0, openQuestions: 0, liveWork: false, presidentAskedAt: askedAt, deliveredAt: ms('03:29'), seenAt: ms('01:00') }),
    ).toBe('review')
    // the /supply launch (claude's command wrapper) is not the owner either
    expect(
      presidentAskedAtFromJsonl([
        owner('<command-message>supply</command-message>\n<command-name>/supply</command-name>'),
        assistant('何を作りましょうか？'),
      ]),
    ).toBeUndefined()
  })

  it('an auto-compaction summary is not the owner speaking', () => {
    // Skipped, not read as a prompt: it neither starts an owner turn…
    expect(presidentAskedAtFromJsonl([notice('進捗'), compactSummary(), assistant('続きを進めますか？')])).toBeUndefined()
    expect(presidentAskedAtFromJsonl([compactSummary(), notice('進捗'), assistant('これで OK ですか？')])).toBeUndefined()
    // …nor answers a standing question
    expect(
      presidentAskedAtFromJsonl([owner('x'), assistant('どちらに？'), compactSummary(), notice('進捗'), assistant('進みました。')]),
    ).toBe(ms('03:00'))
    // (it can land mid-turn — the reply after it still answers the owner)
    expect(presidentAskedAtFromJsonl([owner('x'), toolUse(), compactSummary(), assistant('どちらに？', '03:05')])).toBe(ms('03:05'))
  })

  it('the owner speaking again clears it', () => {
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('どちらに？'), notice('進捗'), owner('A で')])).toBeUndefined()
  })

  it('only the exact app prefixes are app lines — the owner writing 【急ぎ】 is still the owner', () => {
    expect(promptAuthor('【急ぎ】ログインを直して')).toBe('owner')
    expect(promptAuthor(`${SUPPLY_NOTICE_PREFIX}x`)).toBe('other')
    expect(promptAuthor(`  ${SUPPLY_REPLY_PREFIX}x`)).toBe('other')
    expect(presidentAskedAtFromJsonl([owner('【急ぎ】ログインを直して'), assistant('A と B どちらに？')])).toBe(ms('03:00'))
  })

  // A background task's completion notice, as claude writes it (real shape, 2026-09-26).
  const taskNote = (withOrigin = true) =>
    owner('<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>', withOrigin
      ? { origin: { kind: 'task-notification' } }
      : {})
  // What the owner types while the president is mid-turn: only an attachment line.
  const queued = (prompt: string, hh = '03:10') =>
    JSON.stringify({ type: 'attachment', timestamp: iso(hh), attachment: { type: 'queued_command', prompt, commandMode: 'prompt' } })

  it('a task notification is not the owner — its ? reply raises no hand', () => {
    expect(presidentAskedAtFromJsonl([taskNote(), assistant('調査が終わりました。次はどうしますか？')])).toBeUndefined()
    expect(presidentAskedAtFromJsonl([taskNote(false), assistant('次はどうしますか？')])).toBeUndefined()
    expect(promptAuthor('<task-notification>\n<task-id>a1</task-id>')).toBe('other')
  })

  it('a task notification after the owner question does not clear it', () => {
    expect(
      presidentAskedAtFromJsonl([owner('x'), assistant('A と B どちらに？'), taskNote(), assistant('調査も終わりました。')]),
    ).toBe(ms('03:00'))
  })

  it('the owner answering while the president is busy (queued_command) clears it', () => {
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('A と B どちらに？'), queued('A で')])).toBeUndefined()
    // …and the reply to that queued answer is judged like any owner turn
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('どちらに？'), queued('A で'), assistant('A の細部は？', '03:20')])).toBe(
      ms('03:20'),
    )
  })

  it('a queued app notice or task notification is not the owner answering', () => {
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('どちらに？'), queued(`${SUPPLY_NOTICE_PREFIX}進捗`)])).toBe(ms('03:00'))
    expect(presidentAskedAtFromJsonl([owner('x'), assistant('どちらに？'), queued('<task-notification>\n<task-id>b</task-id>')])).toBe(
      ms('03:00'),
    )
  })

  it('no owner prompt in the tail at all ⇒ no evidence, not a question', () => {
    expect(presidentAskedAtFromJsonl([assistant('どうしますか？')])).toBeUndefined()
    expect(presidentAskedAtFromJsonl([])).toBeUndefined()
  })
})

describe('readPresidentAskedAtFile — incremental walk over the growing transcript', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('folds in only appended lines, holds a half-written line, and restarts on truncation', async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-gm-'))
    const file = join(dir, 's.jsonl')
    await writeFile(file, `${owner('x')}\n${assistant('どちらに？')}\n`)
    expect(await readPresidentAskedAtFile(file)).toBe(ms('03:00'))
    // a notice and its retelling arrive — the question stands
    await appendFile(file, `${notice('進捗')}\n${assistant('進みました。', '03:10')}\n`)
    expect(await readPresidentAskedAtFile(file)).toBe(ms('03:00'))
    // the owner's reply is still being written (no newline yet) — not consumed
    const reply = owner('A で')
    await appendFile(file, reply.slice(0, 20))
    expect(await readPresidentAskedAtFile(file)).toBe(ms('03:00'))
    await appendFile(file, `${reply.slice(20)}\n`)
    expect(await readPresidentAskedAtFile(file)).toBeUndefined()
    // the file shrank (rewritten) — walk again from scratch
    await writeFile(file, `${owner('y')}\n${assistant('いいですか？', '04:00')}\n`)
    expect(await readPresidentAskedAtFile(file)).toBe(ms('04:00'))
  })
})

describe('closesOnQuestion — measured on real president replies', () => {
  it('a question anywhere in the LAST paragraph', () => {
    expect(closesOnQuestion('いいですか？')).toBe(true)
    expect(closesOnQuestion('説明…\n\nこの形で進めてよいですか？ 印の絵柄に好みがあれば、それも教えてください。')).toBe(true)
    expect(closesOnQuestion('A・B・C のどれにしますか？（どれも違う場合は、それも言ってください）')).toBe(true)
  })
  it('not a question in an earlier paragraph, nor one only quoted', () => {
    expect(closesOnQuestion('いいですか？\n\n進めます。')).toBe(false)
    expect(closesOnQuestion('社長が「他に気になる点はありますか？」で締めると印が付くおそれがあります。')).toBe(false)
    expect(closesOnQuestion('以上で完了です。')).toBe(false)
  })
})
