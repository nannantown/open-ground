// savedWorkHold — ONE wording and ONE reading of "an operation whose result
// nobody confirmed" (an uncertain receipt, or a saved conversation cut mid-tool).
//
// SCOPED (AUTONOMY-SPEC R-B3, owner decision 2026-11-28 §7-1 = A). Such an
// operation holds ONLY the conversation that issued it: that conversation's tool
// calls are denied and it is never resumed (runtimeActionReceipts.ts — the launch
// guard and the PreToolUse hook ask with their own session). Everything else in
// the project goes on. The rule that stays: an unknown result is never run again
// automatically, and its input is never handed to another actor. Until
// 2026-11-28 one such operation stopped every launch in its project, which turned
// eight stale receipts into days without automation in seven projects (§1.1).
//
// ONE PLACE (R-B4). Each held operation is one question in the owner's question
// inbox (the yellow hand), keyed `hold:<id>`, in plain words; the answer is
// applied by answerHeldOperation. The Settings recovery panel keeps working
// through the same review functions.

import { projectPanel as panelMessages } from '../../i18n/messages/projectPanel'
import { board as boardMessages } from '../../i18n/messages/board'
import { settings as settingsMessages } from '../../i18n/messages/settings'
import { toolbar as toolbarMessages } from '../../i18n/messages/toolbar'
import type { Escalation } from '../types'
import type { PromptLang } from './promptLang'

/** Where the owner signs in to the app: the person icon in the toolbar, by its own
 *  tooltip (Toolbar.tsx). Settings has no sign-in — it shows only the Claude CLI's
 *  connection — and every sentence that told the owner to sign in under Settings
 *  sent them to a screen without one (review R5 S1). */
export const APP_SIGN_IN_WHERE = { ja: `画面上部のツールバーの人のアイコン(「${toolbarMessages.ja['toolbar.signIn']}」)`,
  en: `the person icon in the toolbar at the top ("${toolbarMessages.en['toolbar.signIn']}")` }

/** Where the owner answers for an unconfirmed operation: the question inbox, by
 *  the label the agent-team bar shows it under (「あなたへの質問」). */
export const OWNER_REVIEW_WHERE = `エージェントチームのバーの「${panelMessages.ja['projectPanel.swarm.bar.questions'].replace(/\s*\{count\}/, '')}」`

/** The words every hold that only the owner's answer can clear carries. Matched
 *  by the boot resume (`ownerOnly`, through isOwnerReviewHold) — keep it one constant. */
export const OWNER_REVIEW_HOLD_HINT = `${OWNER_REVIEW_WHERE}に答えると再開します`

/** The same, for a held ChatGPT desk conversation: it raises no question in the
 *  bar (its unfinished call or broken history is not a receipt), so its door is
 *  the Settings recovery panel, named by that screen's own labels (review R2 S-4)
 *  — used only while that panel can list it (chatGptHoldHint). */
export const CHATGPT_REVIEW_HOLD_HINT =
  `設定 › ${settingsMessages.ja['settings.advanced']} › ChatGPT › ${settingsMessages.ja['settings.recovery.title']}で確かめると再開します`

/** The panel lists a ChatGPT item only while the owner is signed in to the app,
 *  ChatGPT is live-connected to the account that started it, and work mode is off
 *  (ConversationRecoverySetting, runtimeRecovery, listChatGptUncertainActions).
 *  Otherwise those conditions are the door: met, the conversation resumes or shows
 *  up there to review (reviews R3-ui S1, R4 S2 — an expired ChatGPT token or app
 *  sign-in empties the panel too). */
export const CHATGPT_SIGN_IN_HOLD_HINT =
  `${APP_SIGN_IN_WHERE.ja}からサインインした状態で、その会話を始めた ChatGPT のアカウントで「${settingsMessages.ja['settings.chatgpt.connect']}」し、${settingsMessages.ja['settings.lockdown.heading']}をオフにすると、自動で再開するか、設定 › ${settingsMessages.ja['settings.advanced']} › ChatGPT › ${settingsMessages.ja['settings.recovery.title']}に確かめる項目が出ます`

/** A saved ChatGPT history that cannot be read at all: no screen clears it, so the
 *  words promise no door (review R3-ui S1). */
export const CHATGPT_UNREADABLE_HOLD_HINT = '保存された ChatGPT の会話履歴を読み取れないため、自動では再開しません'

/** Which of the three ChatGPT words fits a held conversation. `panelShows`: the
 *  panel's own conditions besides the account (app sign-in, live connection, work
 *  mode off — savedSwarmRuntimeHold reads them). */
export const chatGptHoldHint = (account: 'this' | 'other' | 'signed-out' | 'unreadable', recovery: 'uncertain' | 'invalid', panelShows: boolean): string =>
  account === 'unreadable' ? CHATGPT_UNREADABLE_HOLD_HINT
    : account === 'this' && recovery === 'uncertain' && panelShows ? CHATGPT_REVIEW_HOLD_HINT
      : CHATGPT_SIGN_IN_HOLD_HINT

/** A hold only the owner can clear — it carries one of the words above. */
export const isOwnerReviewHold = (reason: string): boolean =>
  [OWNER_REVIEW_HOLD_HINT, CHATGPT_REVIEW_HOLD_HINT, CHATGPT_SIGN_IN_HOLD_HINT, CHATGPT_UNREADABLE_HOLD_HINT].some((hint) => reason.includes(hint))

/** Who issued a held operation. */
export type HeldSeat =
  | { role: 'worker'; taskId?: string; title?: string }
  | { role: 'manager' }
  | { role: 'supply' }
  | { role: 'unknown' }

/** One operation whose result nobody confirmed, as the engine and the owner's
 *  question see it. Never carries the call's arguments. */
export interface HeldOperation {
  /** The receipt id, or `native-<sessionId>` for a saved conversation cut mid-tool. */
  id: string
  /** The conversation it holds (absent = it names none, so it holds everyone). */
  sessionId?: string
  /** The tool's name; absent for an owner instruction to the president. */
  tool?: string
  /** When it began (ISO). */
  at: string
  /** The call's own `description` input, as the model wrote it (raw). */
  description?: string
  seat: HeldSeat
}

/** The inbox key of a held operation's question — one open question per key. */
export const holdKey = (id: string): string => `hold:${id}`

/** Every operation whose result nobody confirmed in this project right now — the
 *  question the launch guard asks, answered for the engine with who issued each.
 *  Throws exactly when that question throws (the owner's sign-in cannot be
 *  confirmed, the record cannot be read): every launch would then fail the same
 *  way, and the engine holds the whole project under its own words.
 *  `sessionId` keeps only what that one conversation issued; `anyOwner` reads
 *  every account's records even while the owner-role lookup has not answered —
 *  the question "may this saved conversation be resumed?" must not read "yes"
 *  just because the lookup is offline (the boot check reads it the same way). */
export const savedWorkHolds = async (projectPath: string, opts: { anyOwner?: boolean; sessionId?: string } = {}): Promise<HeldOperation[]> => {
  const { listUncertainRuntimeActions, receiptSession } = await import('./runtimeActionReceipts')
  const receipts = (await listUncertainRuntimeActions(projectPath, false, opts.anyOwner ?? false, opts.sessionId))
    // A receipt naming no conversation holds every one, this one included.
    .filter((r) => opts.sessionId === undefined || receiptSession(r) === undefined || receiptSession(r) === opts.sessionId)
  if (!receipts.length) return []
  const seats = await persistedSeats(projectPath)
  const { findToolOutcome } = await import('./runtimeToolEvidence')
  return Promise.all(receipts.map(async (r): Promise<HeldOperation> => {
    const body = (r.body ?? {}) as { kind?: unknown; tool?: unknown; sessionId?: unknown; toolId?: unknown; cwd?: unknown }
    const sessionId = receiptSession(r)
    const tool = body.kind === 'runtime-tool' && typeof body.tool === 'string' ? body.tool : undefined
    // findToolOutcome is memoised on the transcript's files: the predicate above
    // already read them, so this is normally a cache hit.
    const outcome = tool && typeof body.sessionId === 'string' && typeof body.toolId === 'string'
      ? await findToolOutcome(body.sessionId, body.toolId, { cwd: typeof body.cwd === 'string' ? body.cwd : undefined }).catch(() => undefined)
      : undefined
    const description = outcome && outcome.kind !== 'no-record' ? outcome.description : undefined
    return { id: r.id, ...(sessionId ? { sessionId } : {}), ...(tool ? { tool } : {}), at: r.acceptedAt, ...(description ? { description } : {}),
      seat: (sessionId && seats.get(sessionId)) || (body.kind === 'president-input' ? { role: 'supply' } : { role: 'unknown' }) }
  }))
}

/** A saved conversation that ends in a tool call with no recorded result (the
 *  native transcript's own view — a PTY desk has no receipts, and a user without
 *  the owner role records none), as one held operation keyed `native-<session>`:
 *  the same id the Settings recovery panel uses. */
export const nativeHeldOperation = (sessionId: string, tool: { name: string; at?: string; description?: string } | undefined, seat: HeldSeat): HeldOperation =>
  ({ id: `native-${sessionId}`, sessionId, tool: tool?.name ?? 'tool', at: tool?.at ?? '', ...(tool?.description ? { description: tool.description } : {}), seat })

/** Who each saved conversation in the project belongs to, from what is on disk:
 *  the desk records (commander, president) and the worker roster. Display only —
 *  a read that fails names nobody. */
export const persistedSeats = async (projectPath: string): Promise<Map<string, HeldSeat>> => {
  const seats = new Map<string, HeldSeat>()
  try {
    const { readSwarmSessions } = await import('./swarmSessions')
    const sessions = await readSwarmSessions(projectPath)
    for (const desk of [sessions, sessions.chatgpt ?? {}]) {
      if (desk.manager) seats.set(desk.manager.sessionId, { role: 'manager' })
      if (desk.supply) seats.set(desk.supply.sessionId, { role: 'supply' })
    }
  } catch { /* names nobody */ }
  try {
    const { readRoster } = await import('./swarmWorkerRoster')
    for (const w of await readRoster(projectPath)) seats.set(w.sessionId, { role: 'worker', taskId: w.taskId })
  } catch { /* names nobody */ }
  return seats
}

/** The language of a held operation's question, its options and its refusal
 *  reasons: Settings.language through the app's one resolver (promptLang.langOf —
 *  unset ⇒ English), like every escalation question (CLAUDE.md language policy;
 *  review A N4, 2026-11-28). */
export type HoldLang = PromptLang
export const holdLang = async (): Promise<HoldLang> => {
  const { getSettings } = await import('./store')
  const { langOf } = await import('./promptLang')
  return langOf((await getSettings().catch(() => undefined)) ?? {})
}

/** The seats by the names the screen gives them (社長 / マネージャー / ワーカー). */
const seatWords = (seat: HeldSeat, lang: HoldLang): string =>
  lang === 'en'
    ? seat.role === 'worker' ? (seat.title ? `the worker on "${seat.title}"` : 'a worker')
      : seat.role === 'manager' ? 'the manager' : seat.role === 'supply' ? 'the president' : 'an earlier conversation'
    : seat.role === 'worker' ? (seat.title ? `「${seat.title}」のワーカー` : 'ワーカー')
      : seat.role === 'manager' ? 'マネージャー' : seat.role === 'supply' ? '社長' : '以前の会話'

// Words that make a description command text rather than plain words.
const COMMAND_WORDS = /^(git|gh|npm|npx|pnpm|yarn|node|tsx|vitest|jest|python3?|pip|make|docker|curl|wget|ssh|scp|rsync|sudo|bash|sh|zsh|rm|mv|cp|mkdir|chmod|chown|kill|pkill|killall|ln|tar|open|osascript|brew|cargo|push|pull|merge|rebase|reset|checkout|restore|stash|commit|clone|fetch|branch|tag|origin|main|master|head|force|sql|drop|truncate)$/i
const codeLike = (word: string): boolean =>
  /[^A-Za-z\u00C0-\u024F\u3040-\u30FF\u3400-\u9FFF々〆'’,.()（）、。・-]/.test(word) || /^-|--|[a-z][A-Z]/.test(word)
    || COMMAND_WORDS.test(word.replace(/[,.()（）、。]/g, ''))
/** The call's own description, kept only when ALL of it is plain words: one word
 *  that looks like a path, an option, shell syntax, an identifier, a number, a
 *  branch name or a command word drops the whole description — a partial
 *  redaction still let 「git push origin main to」 through (review D S6) — so no
 *  path, branch name or command text reaches the owner (R-B4). */
export const plainDescription = (raw: string | undefined): string | undefined => {
  const flat = (raw ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!flat || flat.split(' ').some(codeLike)) return undefined
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

const TOOL_WORDS: Record<HoldLang, Record<string, string>> = {
  ja: { Bash: 'コマンドの実行', Write: 'ファイルの書き込み', Edit: 'ファイルの書き換え', MultiEdit: 'ファイルの書き換え', NotebookEdit: 'ファイルの書き換え', Agent: '下請けへの依頼', Task: '下請けへの依頼' },
  en: { Bash: 'running a command', Write: 'writing a file', Edit: 'editing a file', MultiEdit: 'editing a file', NotebookEdit: 'editing a file', Agent: 'a request to a helper', Task: 'a request to a helper' },
}
const whatWords = (op: HeldOperation, lang: HoldLang): string => {
  const description = plainDescription(op.description)
  if (!op.tool) return lang === 'en' ? "the owner's instruction to the president" : 'オーナーから社長への指示'
  const kind = TOOL_WORDS[lang][op.tool] ?? (lang === 'en' ? 'an operation with a tool' : '道具を使った操作')
  return description ? (lang === 'en' ? `${kind} ("${description}")` : `${kind}「${description}」`) : kind
}

const whenWords = (iso: string, lang: HoldLang): string => {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return lang === 'en' ? 'an unknown time' : '時刻の分からないとき'
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return lang === 'en' ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** The engine's own sentence when it cut the operation off itself (a forced stop),
 *  in both languages: the question picks one. */
export interface HoldCause { ja: string; en: string }

/** The owner's question for one held operation, in the plain three-part shape —
 *  what to decide, the options, what each REALLY does — with no path, branch name
 *  or command text (R-B4), in the language its caller passes (production passes
 *  holdLang(): Settings.language, unset ⇒ English). The same lines and the same
 *  letters in both languages.
 *  - A worker with a card gets two options that differ (answerHeldOperation):
 *    A keeps the card's branch (a new conversation continues the saved work),
 *    B drops it (a new conversation starts the work over from the main line).
 *  - A desk (manager, president) or an unattributed conversation gets ONE option:
 *    a held desk conversation is never resumed (R-B3), so A and B would both just
 *    open a new conversation — offering two would promise a difference that
 *    does not exist (review D S3).
 *  - An operation that names no conversation holds every launch in the project
 *    (refreshSavedWorkHold 'all'), so it never says the rest goes on (D S4). */
export const unconfirmedOperationQuestion = (op: HeldOperation, cause?: HoldCause, lang: HoldLang = 'ja'): { question: string; plainQuestion: string; context: string } => {
  const who = seatWords(op.seat, lang), when = whenWords(op.at, lang), what = whatWords(op, lang)
  const twoWay = op.seat.role === 'worker' && !!op.seat.taskId
  const supply = op.seat.role === 'supply'
  if (lang === 'en') {
    const stopped = `${who} started ${what} at ${when}, and it stopped without anyone knowing whether it finished.`
    const rest = op.sessionId ? 'Everything else keeps going.' : 'Until you answer, no new work starts in this project.'
    const never = 'the app never runs the operation with the unknown result again by itself.'
    const context = (cause ? `${capital(cause.en)}. ` : '') + `All that is recorded is that ${what} began. Whether it finished or stopped partway is unknown.`
    const head = `${capital(who)} started ${what} at ${when} and its result could not be confirmed.`
    return twoWay
      ? {
          question: `${head} A: carry on from the work so far / B: start over`,
          plainQuestion: [
            `What to decide: ${capital(stopped)} Choose how this work goes on.`,
            'A "Carry on": a new conversation takes over the work saved so far, checks the current state, and continues.',
            'B "Start over": the earlier changes are kept but not used; a new conversation does this work again from the beginning.',
            `Until you answer, this work waits in "${boardMessages.en['board.col.blocked']}" on the Board. ${rest} Either way, ${never}`,
          ].join('\n'),
          context,
        }
      : {
          question: `${head} A: noted (continue in a new conversation, not the stopped one)`,
          plainQuestion: [
            `What to decide: ${capital(stopped)} If needed, check what that operation did before you answer.`,
            `A "Noted": the stopped conversation is not used again; ${supply ? 'the president reopens in a new conversation' : 'the next start is a new conversation'}.`,
            `${supply ? "Until you answer, the president's seat stays closed. " : ''}${rest} ${capital(never)}`,
          ].join('\n'),
          context,
        }
  }
  const stopped = `${who}が${when}に始めた${what}が、終わったかどうか分からないまま止まっています。`
  const rest = op.sessionId ? 'ほかの作業は止まらずに続いています。' : '答えるまで、このプロジェクトでは新しい作業を始めません。'
  const never = '結果の分からない操作を、アプリが自動でもう一度実行することはありません。'
  const context = (cause ? `${cause.ja}。` : '') + `記録にあるのは、${what}を始めたことだけです。終わったのか、途中で止まったのかは分かりません。`
  if (twoWay) {
    return {
      question: `${who}が${when}に始めた${what}の結果が確かめられていません。A: これまでの作業を引き継いで続ける / B: 初めからやり直す`,
      plainQuestion: [
        `決めていただきたいこと: ${stopped}この作業の続け方を選んでください。`,
        'A「引き継いで続ける」: 新しい会話が、これまでの作業(保存済みの変更)を引き継ぎ、いまの状態を確かめてから続けます。',
        'B「初めからやり直す」: これまでの変更は消さずに残したまま、新しい会話がこの作業を初めからやり直します。',
        `答えるまで、この作業はボードの「${boardMessages.ja['board.col.blocked']}」で待ちます。${rest}どちらを選んでも、${never}`,
      ].join('\n'),
      context,
    }
  }
  const after = supply ? '社長は新しい会話で再開します' : '次は新しい会話で始めます'
  return {
    question: `${who}が${when}に始めた${what}の結果が確かめられていません。A: 確認した(止まった会話は使わず、新しい会話で続ける)`,
    plainQuestion: [
      `決めていただきたいこと: ${stopped}必要なら、その操作が何をしたかを確かめてから答えてください。`,
      `A「確認した」: 止まった会話はもう使わず、${after}。`,
      `${supply ? '答えるまで、社長の席は開きません。' : ''}${rest}${never}`,
    ].join('\n'),
    context,
  }
}

/** Raise the question for one held operation in the owner's inbox — at most one
 *  open question per operation, also across restarts (the inbox dedupes on the
 *  key while a question is open). Carries no worker address: the answer must
 *  never be handed to the conversation that is held. */
export const askAboutHeldOperation = async (projectPath: string, op: HeldOperation, cause?: HoldCause): Promise<{ deduped: boolean }> => {
  const { openEscalation } = await import('./swarmEscalations')
  const { deduped } = await openEscalation({ projectPath, ...unconfirmedOperationQuestion(op, cause, await holdLang()), whyEscalated: 'insufficient-info',
    receiptKey: holdKey(op.id), ...(op.seat.role === 'worker' && op.seat.taskId ? { taskId: op.seat.taskId } : {}) })
  return { deduped }
}

/** The open held-operation questions of one project: key → the card each named.
 *  STRICT: an inbox that cannot be read throws (the caller then neither re-asks
 *  nor releases on its account). */
export const openHoldQuestions = async (projectPath: string): Promise<Map<string, { taskId?: string }>> => {
  const { listOpenOwnerQuestionsStrict } = await import('./swarmEscalations')
  return new Map((await listOpenOwnerQuestionsStrict(projectPath)).filter((e) => e.receiptKey.startsWith('hold:'))
    .map((e) => [e.receiptKey, e.taskId ? { taskId: e.taskId } : {}]))
}

/** Withdraw the open question of an operation that stopped holding without the
 *  owner's answer (its result was recorded after all). True when one was open. */
export const withdrawHoldQuestion = async (projectPath: string, id: string): Promise<boolean> => {
  const { listEscalations, dismissEscalation } = await import('./swarmEscalations')
  const open = (await listEscalations({ projectPath, status: 'open' })).filter((e) => e.receiptKey === holdKey(id))
  for (const e of open) await dismissEscalation(e.id)
  return open.length > 0
}

/** The opening line of a FRESH desk conversation that replaces a held one (R-B3):
 *  what stopped, when, and that nothing similar is done before the current state
 *  is checked. Desk-facing, so English; names the call only by its tool and its
 *  own description, never its arguments. */
export const heldOperationOpening = (op: Pick<HeldOperation, 'tool' | 'at' | 'description'>, ownerAnswer?: string): string =>
  `[OPEN GROUND] Your previous conversation in this project stopped during an operation whose result is unknown: ${op.tool ?? 'an instruction'}` +
  `${plainDescription(op.description) ? ` (its own description: ${JSON.stringify(plainDescription(op.description))})` : ''}, started ${op.at || 'at an unknown time'}. This is a NEW conversation. ` +
  'Do not repeat that operation or anything similar until you have looked at the current state (Board, Git, files) and confirmed what it did. ' +
  (ownerAnswer !== undefined ? `The owner answered about it: ${JSON.stringify(ownerAnswer.slice(0, 1000))}` : 'The owner has been asked about it.')

/** The owner's choice on a held operation's question. THE CONTRACT (review R2
 *  N-M2, 2026-11-28): the FIRST LINE is the letter alone — `A` or `B` (full-width
 *  folded, any case), optionally inside 「」『』 quotes or brackets, optionally
 *  followed by 。.、, — and every line after it is the owner's note. Anything else
 *  on the first line is not a choice (refused with a reason that says this format).
 *  Two rounds of guessing choices out of prose (「Aで」「Aでお願いします」) each read
 *  some negation or hesitation as a letter — 「AでなくB」 as A — and a false hit
 *  releases the hold, so the reader no longer interprets: the president sends the
 *  letter alone, and the bar sends bare letters. PURE. */
export const readHoldChoice = (answer: string): 'A' | 'B' | null => {
  const first = (answer ?? '').normalize('NFKC').trim().split(/\r?\n/)[0].trim() // the route trims the answer too
  const m = /^(?:([AaBb])|「([AaBb])」|『([AaBb])』|"([AaBb])"|'([AaBb])'|\(([AaBb])\)|\[([AaBb])\]|【([AaBb])】)[。.、,]?$/.exec(first)
  const letter = m?.slice(1).find(Boolean)
  return letter ? (letter.toUpperCase() as 'A' | 'B') : null
}

/** Why an owner's answer to a held operation's question did not take: words the
 *  president relays as they are (the question stays open — swarmEscalations refuses
 *  the answer instead of recording it), and a `reason` sent in the 409 body so a seat
 *  branches on a marker, never on the sentence (review R3-ui S2: the onlyA sentence
 *  also "asks for the letter alone"). Only `format` may be fixed and posted again
 *  without the owner; every other reason is told to the owner as it is. */
export type HoldRefusal = 'format' | Exclude<keyof typeof HOLD_ANSWER, 'unread' | 'unreadA'>
export class HoldAnswerRefused extends Error {
  constructor(message: string, readonly reason: HoldRefusal = 'failed') { super(message); this.name = 'HoldAnswerRefused' }
}
const HOLD_ANSWER = {
  unread: { ja: 'この質問には、1行目に「A」か「B」の1文字だけを書いて答えてください(ご自身の言葉は2行目以降に書けます)。この答えは受け付けていません。質問はそのまま残っています。',
    en: 'Please answer with "A" or "B" alone on the first line (your own words can go on the lines below). This answer was not accepted; the question is still open.' },
  // A desk's question offers only A, so its format refusal names only A (R3-ui S2).
  unreadA: { ja: 'この質問には、1行目に「A」の1文字だけを書いて答えてください(ご自身の言葉は2行目以降に書けます)。この答えは受け付けていません。質問はそのまま残っています。',
    en: 'Please answer with "A" alone on the first line (your own words can go on the lines below). This answer was not accepted; the question is still open.' },
  failed: { ja: '答えを記録できませんでした。質問はそのまま残っています。少し待ってから、もう一度答えてください。',
    en: 'Your answer could not be recorded. The question is still open; please try again in a moment.' },
  onlyA: { ja: 'この質問の選択肢は「A」だけです。1行目に「A」とだけ書いて答えてください。質問はそのまま残っています。',
    en: 'This question offers only "A". Please answer with "A" alone on the first line. The question is still open.' },
  signIn: { ja: `あなたのアカウントを確かめられないため、答えを記録できませんでした。${APP_SIGN_IN_WHERE.ja}からサインインしているかを確かめてから、もう一度答えてください。質問はそのまま残っています。`,
    en: `Your answer could not be recorded because your account could not be confirmed. Check that you are signed in (${APP_SIGN_IN_WHERE.en}), then answer again. The question is still open.` },
  running: { ja: 'その会話はまだ動いています。止まってから、もう一度答えてください。質問はそのまま残っています。',
    en: 'That conversation is still running. Please answer again once it has stopped. The question is still open.' },
  // Withdrawn (its result turned up) or dismissed: a question still needed is asked
  // again as a new one (refreshSavedWorkHold), so either way this one needs nothing.
  closed: { ja: 'この質問はもう閉じられていて、答えは要りません。まだ決めることが残っていれば、新しい質問として届きます。',
    en: 'This question has already been closed, so no answer is needed. If anything is still left to decide, it comes as a new question.' },
} satisfies Record<string, Record<HoldLang, string>>
/** A refusal reason in the owner's language (holdLang). */
export const holdAnswerReason = (kind: keyof typeof HOLD_ANSWER, lang: HoldLang): string => HOLD_ANSWER[kind][lang]
const refuse = (kind: keyof typeof HOLD_ANSWER, lang: HoldLang): HoldAnswerRefused =>
  new HoldAnswerRefused(HOLD_ANSWER[kind][lang], kind === 'unread' || kind === 'unreadA' ? 'format' : kind)

/** Apply the owner's answer to a held operation's question (swarmEscalations'
 *  answer hook, run BEFORE the answer is recorded). Records the owner's decision
 *  on the receipt (or the native conversation) with the answer as the note and
 *  the question's id as the operation id — the same review the Settings panel
 *  writes, so the hold lifts and the question is not raised again — then moves
 *  the work on (see unconfirmedOperationQuestion for what A and B do).
 *  Throws HoldAnswerRefused (plain words) when the answer picks nothing, the held
 *  conversation is still running, or the review did not take: the hold stands.
 *  Never re-runs the call; never hands its input to anyone. */
export const answerHeldOperation = async (
  record: Pick<Escalation, 'id' | 'receiptKey' | 'projectPath' | 'taskId'>,
  answer: string,
  deps?: { unpark?: (projectPath: string, taskId: string, opts: { fresh: boolean }) => Promise<boolean>; forgetDesk?: (projectPath: string, sessionId: string, desks: ('supply' | 'manager')[]) => Promise<unknown> },
): Promise<'reviewed'> => {
  // Only an explicit choice applies. 「待ってください」「再開しないで」 or any other
  // free text is not one: refused, so the owner can answer again.
  const lang = await holdLang()
  const choice = readHoldChoice(answer)
  if (!choice) throw refuse(record.taskId ? 'unread' : 'unreadA', lang)
  // A desk's (or an unattributed) question offers only A (unconfirmedOperationQuestion):
  // B is not a choice the owner was given, even though it would do the same.
  if (choice === 'B' && !record.taskId) throw refuse('onlyA', lang)
  const id = record.receiptKey.slice('hold:'.length)
  const note = answer.trim().slice(0, 1000)
  const { projectUUIDFromPath } = await import('./projectDataPath')
  const scope = await projectUUIDFromPath(record.projectPath)
  const { isAgentConversationOccupied, isRecordedRuntimeHandleOccupied } = await import('./liveDesks')
  try {
    if (id.startsWith('native-')) {
      const sessionId = id.slice('native-'.length)
      if (isAgentConversationOccupied(sessionId)) throw refuse('running', lang) // as the Settings route refuses (409)
      const { reviewNativeConversationRecovery, nativeReviewerKey } = await import('./swarmNativeRecovery')
      await reviewNativeConversationRecovery({ id, projectId: scope, sessionId, note, operationId: record.id, expectedOwnerKey: await nativeReviewerKey() })
    } else {
      const { readConversationReceipt, reviewConversationReceipt, finishConversationReceipt } = await import('./conversationReceipts')
      // A receipt still `executing` whose actor is gone holds (listUncertainRuntime-
      // Actions) but only an `uncertain` one can be reviewed: record it uncertain
      // first — the write runtimeRecoveryIssues makes (review A-M2, 2026-11-28).
      const now = await readConversationReceipt(scope, id)
      if (now?.state === 'executing') {
        const body = now.body as { sessionId?: unknown } | null
        if (now.execution ? isRecordedRuntimeHandleOccupied(now.execution.runtime, now.execution.handleId) : typeof body?.sessionId === 'string' && isAgentConversationOccupied(body.sessionId))
          throw refuse('running', lang)
        await finishConversationReceipt(scope, id, 'uncertain', { reason: 'actor-ended-without-result', automaticReplay: false })
      }
      await reviewConversationReceipt(scope, id, note, record.id)
    }
  } catch (e) {
    if (e instanceof HoldAnswerRefused) throw e
    if (id.startsWith('native-')) {
      // A worker's conversation that is no longer on the roster can no longer be
      // reviewed — and nothing can resume it either (only roster entries are ever
      // resumed, and the resume refuses an unfinished call), so its card simply
      // goes on in a new conversation. A desk's conversation keeps its hold.
      if (!record.taskId) throw refuse('failed', lang)
    } else {
      // Receipts are keyed by the signed-in owner: signed out (or another account),
      // "try again in a moment" never helps — say to check the sign-in (review R2 NIT).
      if (e instanceof Error && /sign-in is required|owner account changed/i.test(e.message)) throw refuse('signIn', lang)
      // Settled meanwhile (the transcript showed its result) is not a failure; any
      // other refusal leaves the hold.
      const { readConversationReceipt } = await import('./conversationReceipts')
      const now = await readConversationReceipt(scope, id).catch(() => undefined)
      if (!now || now.state === 'uncertain' || now.state === 'executing') throw refuse('failed', lang)
    }
  }
  if (record.taskId) {
    // A = continue on the card's saved branch; B = start over: the branch is dropped
    // from the card (kept in git), so the next dispatch begins from the main line.
    const unpark = deps?.unpark ?? (await import('./swarmOrchestrator')).unparkBlockedCard
    await unpark(record.projectPath, record.taskId, { fresh: choice === 'B' }).catch(() => false)
  } else {
    // A held desk conversation is never resumed (R-B3): whatever the owner chose,
    // its saved pointer is dropped, so the next launch opens a NEW conversation and
    // does not ask again (review A S3). The president's own native hold keeps its
    // pointer: its next open reads this review and opens fresh, told what stopped
    // and what the owner said (swarmSupply).
    const native = id.startsWith('native-')
    const { readConversationReceipt } = await import('./conversationReceipts')
    const { receiptSession } = await import('./runtimeActionReceipts')
    const receipt = native ? undefined : await readConversationReceipt(scope, id).catch(() => undefined)
    const session = native ? id.slice('native-'.length) : receipt && receiptSession(receipt)
    const roles: ('supply' | 'manager')[] = native ? ['manager'] : ['supply', 'manager']
    const forget = deps?.forgetDesk ?? (async (projectPath: string, sessionId: string, desks: ('supply' | 'manager')[]) => {
      const { forgetSwarmSessionIf } = await import('./swarmSessions')
      for (const role of desks) await forgetSwarmSessionIf(projectPath, role, sessionId)
    })
    if (session) await forget(record.projectPath, session, roles).catch(() => undefined)
  }
  const { notifyRuntimeRecoveryChanged } = await import('./runtimeRecoveryBoot')
  void notifyRuntimeRecoveryChanged().catch(() => {})
  return 'reviewed'
}

/** Why the commander could not be started, in the owner's words. The reflex used
 *  to call every failed wake "no usable model tier" — for eight hours on
 *  2026-11-24 while the real cause was an unconfirmed operation, and it went on
 *  saying so after the limit had lifted. The launch's own words decide first
 *  (`reason`: what the launch threw, or why the desk ended at start); a wall in
 *  the model table (`wall`) is named only when the launch did not say otherwise.
 *  An unconfirmed operation comes with where to go and what clears it. */
export const commanderFailureWords = (reason: string | undefined, wall: 'all-cooling' | 'none-allowed' | null): string =>
  reason && /unconfirmed result/i.test(reason)
    ? `結果を確かめられなかった操作が残っています(${OWNER_REVIEW_HOLD_HINT})`
    : wall === 'all-cooling'
      ? '使用量の上限で、いま使えるモデルがありません(上限が明けると自動で起動します)'
      : wall === 'none-allowed'
        ? '使えるモデルがすべてオフになっています(設定の「使用可能モデル」で1つオンにすると起動します)'
        : reason && plainReason(reason)
          ? `起動時の理由: ${plainReason(reason)}`
          : reason
            ? `起動直後に止まりました(${IN_THE_JOURNAL})`
            : '理由は記録されていません(エンジンの記録の integrate 行を確認してください)'

const IN_THE_JOURNAL = '詳しい理由はエンジンの記録にあります'

/** A failure's own words, when they are the owner's language: the known cases
 *  are written plain (swarmWorker.ts). A raw English error or git's output is
 *  not — it stays in the engine journal, which every caller writes it to, and
 *  the notice says so instead (review 2026-11-26). */
const plainReason = (reason: string): string | null => {
  const words = reason.replace(/^createSwarmWorktree: /, '')
  return /[぀-ヿ一-鿿]/.test(words) ? words : null
}

/** The president's notice for a card whose dispatch keeps failing. */
export const dispatchFailureNotice = (taskTitle: string, reason: string): string =>
  `「${taskTitle}」の作業を始めようとして、失敗が続いています(${plainReason(reason) ? `理由: ${plainReason(reason)}` : IN_THE_JOURNAL})。` +
  '原因が解消すると自動で始まります。'

/** The president's notice for a project in the automation frame whose engine
 *  keeps failing to start. */
export const automationStartNotice = (reason: string): string =>
  `このプロジェクトは自動運用の枠に入っていますが、作業を自動で始められない状態が続いています(${plainReason(reason) ? `理由: ${plainReason(reason)}` : IN_THE_JOURNAL})。` +
  '理由が解消すると自動で始まります。'

/** The president's notice for a worker whose every tool call is refused (the
 *  runtime action guard: the owner's account could not be confirmed, or the
 *  operation could not be recorded). Plain words, one line. */
export const toolDenialNotice = (taskTitle: string): string =>
  `「${taskTitle}」のワーカーが、道具(コマンドやファイルの操作)をすべて断られていて作業を進められません。` +
  'オーナーのアカウントが確かめられないときや、操作の記録ができないときに起きます。' +
  `${APP_SIGN_IN_WHERE.ja}からサインインしているかを確かめ、${OWNER_REVIEW_WHERE}に質問が届いていれば答えてください。`

/** The president's notice when the launch guard cannot even ask: every launch
 *  would fail at its first step, so nothing is started. Worded by cause — only a
 *  sign-in failure sends the owner to check their sign-in; a record that could
 *  not be read is a different thing (review 2026-11-26). */
export const ownerUnconfirmedNotice = (running: number, signIn = true): string =>
  (signIn ? 'オーナーのアカウントが確かめられないため' : '操作の記録が読み取れないため') +
  '、このプロジェクトで新しい作業の開始とマネージャーの起動を止めています' +
  (running > 0 ? `(作業中の ${running} 件も道具を使えず止まっています)` : '') +
  (signIn
    ? `。${APP_SIGN_IN_WHERE.ja}からサインインしているかを確かめてください。確かめられると自動で再開します。`
    : '。読み取れるようになると自動で再開します。長く続くときはアプリを再起動してください。')
