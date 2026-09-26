// groundMarks — the three timestamps behind the Ground card's QUESTION and
// REVIEW marks (owner decision 2026-09-26; the verdict is src/lib/groundLamp.ts).
//
//   presidentAskedAt  the president (社長 / supply desk) answered the owner's own
//                     words with a question and the owner has not spoken since
//                     (app notices neither raise nor clear it) — read from
//                     claude's own JSONL; the rule is stepPresidentAsk below.
//   deliveredAt       the latest card the engine LANDED on main (the landed
//                     ledger, swarmLandedLedger.ts) — "work was delivered".
//   seenAt            the last time the owner had the project open with the
//                     agent-team bar (the president's seat) unfolded.
//   openedAt          the last time the owner had the project open at all —
//                     clears the eye only (ground-opened.json, 2026-09-26).
//
// A mark is lit only when its event is NEWER than seenAt, so opening the seat
// is what clears it — and nothing can stay lit forever on a misread: the next
// look stamps seenAt past it. Everything here fails quiet to `undefined`
// ("no evidence"), which lights nothing.

import { open, readFile, stat, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { projectDataFile } from './projectDataPath'
import { readSwarmSessions } from './swarmSessions'
import { sessionJsonlPath } from './transcript'
import { readLandedLedger } from './swarmLandedLedger'
import { SUPPLY_NOTICE_PREFIX, SUPPLY_REPLY_PREFIX } from './supplyNotice'

const SEEN_FILE = 'ground-seen.json'

/** When the owner last looked at this project's president seat (ms), or
 *  undefined when never recorded / unreadable. */
export const readGroundSeenAt = async (projectPath: string): Promise<number | undefined> =>
  readStamp(projectPath, SEEN_FILE)

/** Stamp "the owner is looking at it now". */
export const markGroundSeen = async (projectPath: string, now = Date.now()): Promise<void> =>
  writeStamp(projectPath, SEEN_FILE, now)

/** The PROJECT-open stamp (2026-09-26): clears the eye only, never a hand.
 *  Its own file rather than a second field in ground-seen.json, so the seat
 *  and the project panel — which stamp at the same moment — never race a
 *  read-modify-write and drop each other's stamp. */
const OPENED_FILE = 'ground-opened.json'

export const readGroundOpenedAt = async (projectPath: string): Promise<number | undefined> =>
  readStamp(projectPath, OPENED_FILE)

export const markGroundOpened = async (projectPath: string, now = Date.now()): Promise<void> =>
  writeStamp(projectPath, OPENED_FILE, now)

async function readStamp(projectPath: string, name: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await readFile(await projectDataFile(projectPath, name), 'utf8'))
    const t = Date.parse(raw?.seenAt)
    return Number.isFinite(t) ? t : undefined
  } catch {
    return undefined
  }
}

async function writeStamp(projectPath: string, name: string, now: number): Promise<void> {
  const file = await projectDataFile(projectPath, name)
  await mkdir(dirname(file), { recursive: true })
  await atomicWriteJson(file, { seenAt: new Date(now).toISOString() })
}

/** The latest landedAt across the project's landed ledger (ms), or undefined. */
export const readDeliveredAt = async (projectPath: string): Promise<number | undefined> => {
  let best: number | undefined
  for (const e of await readLandedLedger(projectPath)) {
    const t = e.landedAt ? Date.parse(e.landedAt) : NaN
    if (Number.isFinite(t) && (best === undefined || t > best)) best = t
  }
  return best
}

/** Does the reply CLOSE on a question? A question mark anywhere in its last
 *  paragraph, not counting quoted 「…」『…』 spans. Measured on real president
 *  transcripts (2026-09-26): the ask is usually followed by one more sentence —
 *  「この形で進めてよいですか？ 印の絵柄に好みがあれば、それも教えてください。」,
 *  「A・B・C のどれにしますか？（どれも違う場合は…）」 — which a strict "ends with ?"
 *  test missed; the quote rule drops 「他に気になる点はありますか？」 being talked
 *  ABOUT. A question in an earlier paragraph followed by a closing statement
 *  paragraph is not the close. */
export const closesOnQuestion = (text: string): boolean => {
  const closing = text.trim().split(/\n\s*\n/).at(-1) ?? ''
  return /[?？]/.test(closing.replace(/「[^」]*」|『[^』]*』/g, ''))
}

type JsonlEvent = {
  type?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  timestamp?: string
  message?: { content?: unknown }
  origin?: { kind?: string }
  attachment?: { type?: string; prompt?: unknown }
}

const blocks = (content: unknown): Array<{ type?: string; text?: string }> =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? (content as Array<{ type?: string; text?: string }>)
      : []

const textOf = (content: unknown): string =>
  blocks(content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')

/** Lines the APP typed into the president's desk — the only two it types
 *  (supplyNotice.ts, frozen protocol constants). Matched on the exact prefix,
 *  so an owner who writes 「【急ぎ】…」 is still the owner. */
const APP_LINE_PREFIXES = [SUPPLY_NOTICE_PREFIX, SUPPLY_REPLY_PREFIX] as const

/** claude's own wrappers around slash commands — the launch `/supply`, a
 *  `/model` the owner ran, its stdout — and the completion notice of a
 *  background task the president started (`<task-notification>`). Not a
 *  message to answer. */
const COMMAND_WRAPPER = /^<(command-|local-command-|task-notification>)/

/** Who wrote a user line: the owner's own words, or something else (an app
 *  notice, a command wrapper, a task notification). Tool results carry no
 *  text and are neither. */
export const promptAuthor = (text: string): 'owner' | 'other' => {
  const s = text.trimStart()
  return APP_LINE_PREFIXES.some((p) => s.startsWith(p)) || COMMAND_WRAPPER.test(s) ? 'other' : 'owner'
}

/** Walking state over the president's transcript, oldest line first.
 *  `asked` = timestamp of the standing question to the owner, if any.
 *  `ownerTurn` = the turn in progress answers the owner's own words. */
export interface PresidentAskState {
  asked?: number
  ownerTurn: boolean
}

export const freshAskState = (): PresidentAskState => ({ ownerTurn: false })

/** THE RULE (commander rework 2, 2026-09-26 — measured on a real president
 *  transcript): the president is waiting on the owner when its latest reply
 *  TO THE OWNER'S OWN WORDS ended with a question, and the owner has not
 *  spoken since.
 *
 *   - Only the owner's own words clear it (seenAt clears the MARK, groundLamp).
 *   - App notices and the president's retelling of them neither raise nor
 *     clear it: the retelling is usually 「…案はまだお返事を待っています。進めて
 *     よいですか？」 — the SAME question re-asked — while 「これで OK ですか？」 after a
 *     delivery must not light the hand (that is the eye's job). Looking only at
 *     the last line, as the first two versions did, lost real questions every
 *     few minutes under autopilot and still lit deliveries.
 *   - Within an owner turn the LAST text wins: 「調べますか？」 followed by tool
 *     calls and a statement is not a question.
 *   - An auto-compaction summary (isCompactSummary) is not the owner speaking.
 *   - An API-error line says nothing either way. */
export const stepPresidentAsk = (st: PresidentAskState, line: string): PresidentAskState => {
  let ev: JsonlEvent
  try {
    ev = JSON.parse(line) as JsonlEvent
  } catch {
    return st // the partial first line of a tail read, or a torn write
  }
  if (ev.isMeta || ev.isCompactSummary) return st
  // What the owner types while the president is mid-turn is not a user line:
  // claude records it only as a queued_command attachment (measured 2026-09-26,
  // 7 of them in a real president transcript) — a phone answer arrives that way.
  const queued = ev.type === 'attachment' && ev.attachment?.type === 'queued_command'
  if (ev.type === 'user' || queued) {
    const text = queued ? textOf(ev.attachment?.prompt) : textOf(ev.message?.content)
    if (!text.trim()) return st // a tool_result — still inside the turn
    const isOwner = ev.origin?.kind !== 'task-notification' && promptAuthor(text) === 'owner'
    return isOwner ? { ownerTurn: true } : { ...st, ownerTurn: false }
  }
  if (ev.type !== 'assistant' || ev.isApiErrorMessage || !st.ownerTurn) return st
  const last = blocks(ev.message?.content).at(-1)
  if (last?.type !== 'text') return { ownerTurn: true } // mid-turn — the reply is not finished
  const t = Date.parse(ev.timestamp ?? '')
  return closesOnQuestion(last.text ?? '') && Number.isFinite(t)
    ? { ownerTurn: true, asked: t }
    : { ownerTurn: true }
}

/** Fold a whole transcript (or its tail): the standing question's ms, or undefined. */
export const presidentAskedAtFromJsonl = (lines: readonly string[]): number | undefined =>
  lines.reduce(stepPresidentAsk, freshAskState()).asked

// The president's transcript only grows. Start from a bounded tail once, then
// fold in only the bytes appended since — this runs on every lamps poll. A
// question whose owner prompt lies before the first tail is not seen (no
// evidence ⇒ no mark), never the other way round.
const TAIL_BYTES = 2 * 1024 * 1024
const walkCache = new Map<string, { offset: number; state: PresidentAskState }>()

const readFrom = async (file: string, start: number, end: number): Promise<Buffer> => {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(end - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** When the project's president asked the owner its standing question (ms), or
 *  undefined — no president session, no transcript, or not asking. */
export const readPresidentAskedAt = async (projectPath: string): Promise<number | undefined> => {
  try {
    const supply = (await readSwarmSessions(projectPath)).supply
    if (!supply) return undefined
    return await readPresidentAskedAtFile(sessionJsonlPath(supply.cwd, supply.sessionId))
  } catch {
    return undefined
  }
}

/** The incremental walk over one transcript file. Throws when unreadable. */
export const readPresidentAskedAtFile = async (file: string): Promise<number | undefined> => {
  const { size } = await stat(file)
  let hit = walkCache.get(file)
  if (!hit || size < hit.offset) hit = { offset: Math.max(0, size - TAIL_BYTES), state: freshAskState() }
  if (size > hit.offset) {
    const buf = await readFrom(file, hit.offset, size)
    // Consume whole lines only; a line still being written waits for the next poll.
    // '\n' never occurs inside a UTF-8 multibyte sequence, so the cut is safe.
    const cut = buf.lastIndexOf(0x0a) + 1
    const state = buf
      .subarray(0, cut)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .reduce(stepPresidentAsk, hit.state)
    hit = { offset: hit.offset + cut, state }
  }
  walkCache.set(file, hit)
  return hit.state.asked
}
