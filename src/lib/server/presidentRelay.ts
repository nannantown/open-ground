// presidentRelay — the owner's assistant passes one message to a project's
// president and brings the president's answer back (2026-10-30, owner:
// 「ちゃんとアシスタントが各社長と連絡を取れたりできるようにしよう」).
//
// Called ONLY from the owner's button on a 'president' proposal
// (assistantProposals.approveProposal) — the assistant itself can only propose.
// The way in is the president's own window, the same lane the iPhone uses for
// the owner's words (supplyNotice.queueSupplyOwnerSay: busy / half-typed / menu
// ⇒ held for the next pass, never typed over). The line carries the frozen
// ASSISTANT_RELAY_PREFIX so the president — and anyone reading its conversation,
// on the Mac or the iPhone — sees it came through the assistant.
//
// The answer is read from the president's own transcript (the same file the
// phone link tails): every president text written after the line landed, until
// the desk stops working. A closed window is opened first (the phone's steps);
// one that cannot be opened is reported, never silent.
//
// ponytail: the wait lives in this process only — a server restart while a
// reply is awaited drops the watch (the line itself still lands and the
// president still answers in its own conversation). Persist it if restarts
// mid-wait turn out to matter.
import { open, stat } from 'fs/promises'
import { resolve } from 'path'
import { ASSISTANT_RELAY_PREFIX, assistantRelayLine, cancelSupplyOwnerSay, ownerSayLine, queueSupplyOwnerSay, SUPPLY_OWNER_SAY_MAX, supplyLineBody } from './supplyNotice'
import { canonicalize } from './canonicalize'
import { listAllActiveDesks, listDeskIdsByRole } from './liveDesks'
import { SUPPLY_DESK_LABEL } from './swarmSupply'
import { readSwarmSessions } from './swarmSessions'
import { sessionJsonlPath } from './transcript'
import { isTaskNotification } from './groundMarks'

/** How long the assistant waits for the line to land and the president to answer. */
export const PRESIDENT_REPLY_WAIT_MS = 10 * 60_000
/** How often the president's transcript and desk are looked at while waiting. */
export const PRESIDENT_POLL_MS = 3000
/** The president's answer as handed to the assistant, at most. */
export const PRESIDENT_REPLY_MAX = 2000
/** One poll reads at most this much of a transcript. */
const READ_MAX = 1024 * 1024

/** The longest message a president frame may hold: the typed line (prefix +
 *  words + tail) must stay unfolded (SUPPLY_OWNER_SAY_MAX), or its Enter never lands. */
export const presidentWordsFit = (words: string): boolean => assistantRelayLine(words).length <= SUPPLY_OWNER_SAY_MAX

/** What came back: the president's words, or why there are none. */
export type PresidentReply =
  | { kind: 'answered'; text: string }
  /** Landed, but nothing written (or the desk never finished) within the wait. */
  | { kind: 'no-reply'; text?: string }
  /** Still waiting behind a busy desk when the wait ran out. */
  | { kind: 'not-landed' }

export type PresidentRelayResult = { ok: true; woke: boolean; waiting: number } | { ok: false; error: string }

export interface PresidentRelayDeps {
  hasDesk(path: string): boolean
  /** Open the window (error string, or null when it is up). */
  wake(path: string): Promise<string | null>
  say: typeof queueSupplyOwnerSay
  /** Take back a line still waiting (the wait ran out before it landed). */
  cancel: typeof cancelSupplyOwnerSay
  /** Where the president's transcript is right now (null = none yet). */
  transcript(path: string): Promise<string | null>
  /** The president is writing / looking things up right now. */
  working(path: string): Promise<boolean>
  now(): number
  sleep(ms: number): Promise<void>
  waitMs: number
  pollMs: number
}

/** Same steps as POST /api/swarm/supply: preflights, spawn (resuming the
 *  stored conversation), remember the intent. Returns an error string or null.
 *  Shared with the phone link (a say to a project whose desk is closed). */
export const wakePresidentDesk = async (path: string): Promise<string | null> => {
  const { claudeRunPreflight } = await import('./claudePreflight')
  const { swarmEnvPreflight } = await import('./swarmEnvPreflight')
  const { spawnSwarmSupply } = await import('./swarmSupply')
  const { patchEngineIntent } = await import('./swarmEnginePersistence')
  if (!(await claudeRunPreflight()).ok) return 'claude-unavailable'
  if (!(await swarmEnvPreflight(path, { force: true, requireGit: false, requireGitRepo: false })).ok) return 'env-unavailable'
  await spawnSwarmSupply({ projectPath: path })
  await patchEngineIntent(path, { supplyDesired: true }).catch(() => {})
  return null
}

const defaults: PresidentRelayDeps = {
  // Both pools (liveDesks): the president is PTY today, an SDK one counts the same.
  hasDesk: (path) => {
    const ids = listDeskIdsByRole(SUPPLY_DESK_LABEL, 'supply')
    const want = resolve(path)
    return listAllActiveDesks().claude.some((d) => ids.has(d.id) && resolve(d.cwd) === want)
  },
  wake: wakePresidentDesk,
  say: queueSupplyOwnerSay,
  cancel: cancelSupplyOwnerSay,
  transcript: async (path) => {
    const s = (await readSwarmSessions(path)).supply
    return s ? sessionJsonlPath(s.cwd, s.sessionId) : null
  },
  working: async (path) => {
    const { presidentWorkingCwds } = await import('./groundLamps')
    // The same match as the lamps (groundLamps `under`): canonical, or a folder inside it.
    const canon = await canonicalize(path).catch(() => path)
    return presidentWorkingCwds().some((c) => c === canon || c === path || c.startsWith(canon + '/'))
  },
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  waitMs: PRESIDENT_REPLY_WAIT_MS,
  pollMs: PRESIDENT_POLL_MS,
}

const clip = (s: string) => (s.length > PRESIDENT_REPLY_MAX ? s.slice(0, PRESIDENT_REPLY_MAX - 1) + '…' : s)

/** The first look reads back this much (the line may have landed a moment
 *  before the watch started); only what follows the line itself is taken. */
const FIRST_LOOK_BYTES = 256 * 1024
/** The line's own echo in the transcript may carry a time a little before the
 *  sender heard it landed. */
const ECHO_SLACK_MS = 60_000

type Block = { type?: string; text?: string }
type TranscriptLine = {
  type?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  message?: { content?: unknown }
  origin?: { kind?: string } | null
  attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string } | null; commandMode?: string }
}

/** Someone typed this line into the window — the owner, a notice, a commander
 *  reply, another message, a slash command (/model, /compact, a resume line).
 *  Not: a tool result, a background task's notification, a meta line (a skill
 *  loading mid-turn) or a compaction summary. */
const typedIn = (ev: TranscriptLine): boolean => {
  if (ev.isMeta || ev.isCompactSummary || isTaskNotification(ev)) return false
  const queued = ev.type === 'attachment' && ev.attachment?.type === 'queued_command'
  if (ev.type !== 'user' && !queued) return false
  const c = queued ? ev.attachment?.prompt : ev.message?.content
  return typeof c === 'string' ? c.trim() !== '' : Array.isArray(c) && c.some((b) => (b as Block)?.type !== 'tool_result')
}

/** Read the president's answer to THIS line: find the line's own echo in its
 *  transcript (ASSISTANT_RELAY_PREFIX + the words), take the president's text
 *  after it, and stop at the next thing anyone types into the window (a notice,
 *  a commander reply, the owner, another message) — that is another
 *  conversation. Finished when the last block written was text (the turn ended,
 *  not a "let me look" before a tool) and the desk has been idle for two looks. */
export const watchPresidentReply = async (path: string, words: string, from: number, until: number, d: PresidentRelayDeps): Promise<PresidentReply> => {
  const { phoneEventsFromLine } = await import('./phoneLink')
  // The WHOLE line as the phone link reads it back (typed via ownerSayLine, then
  // prefix + body): two messages that open alike are not mistaken for each
  // other. Never longer than the phone's event clip (SUPPLY_OWNER_SAY_MAX < 8000).
  const echo = ASSISTANT_RELAY_PREFIX + supplyLineBody(ownerSayLine(assistantRelayLine(words)))
  const said: string[] = []
  let file: string | null = null
  let offset = 0
  let rest = ''
  let idle = 0
  let anchored = false
  let closed = false
  let endedOnText = false
  // A file there at the FIRST look is read from a bounded tail (it holds earlier
  // talk); any file found later — a fresh desk's — from its start. Only what
  // follows the line's own echo counts either way.
  let first = true
  const take = (line: string): boolean => {
    let ev: TranscriptLine
    try {
      ev = JSON.parse(line)
    } catch {
      return false // the torn first line of a tail read
    }
    if (ev?.type === 'assistant') {
      if (!anchored || closed || ev.isMeta || ev.isApiErrorMessage) return false
      const blocks = Array.isArray(ev.message?.content) ? (ev.message!.content as Block[]) : typeof ev.message?.content === 'string' ? [{ type: 'text', text: ev.message.content }] : []
      if (!blocks.length) return false
      endedOnText = blocks.at(-1)?.type === 'text'
      const texts = phoneEventsFromLine(line).filter((e) => e.kind === 'president').map((e) => e.text)
      said.push(...texts)
      return true
    }
    if (!anchored) {
      for (const e of phoneEventsFromLine(line))
        if (e.kind === 'owner' && e.via === 'assistant' && e.text === echo && (e.at === undefined || e.at >= from - ECHO_SLACK_MS)) anchored = true
    } else if (typedIn(ev)) closed = true // anything typed into the window ends the answer
    return false
  }
  const read = async () => {
    const atStart = first
    first = false
    const f = await d.transcript(path).catch(() => null)
    if (!f) return false
    const size = await stat(f).then((st) => st.size, () => -1)
    if (size < 0) return false
    if (f !== file) {
      offset = atStart ? Math.max(0, size - FIRST_LOOK_BYTES) : 0
      file = f
      rest = ''
      // A window made anew while waiting: what it says (a resume report, a
      // greeting) answers nothing until the line's own echo is found in it.
      anchored = closed = endedOnText = false
      said.length = 0
      idle = 0
    }
    if (size < offset) offset = size
    if (size === offset) return false
    const fh = await open(f, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(Math.min(size - offset, READ_MAX))
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      offset += bytesRead
      text = rest + buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
    const lines = text.split('\n')
    rest = lines.pop() ?? ''
    let grew = false
    for (const line of lines) if (take(line)) grew = true
    return grew
  }
  const answer = () => clip(said.join('\n\n'))
  await read().catch(() => false)
  for (;;) {
    // Someone typed in before the president wrote a word: nothing is coming.
    if (closed) return said.length ? { kind: 'answered', text: answer() } : { kind: 'no-reply' }
    if (said.length && endedOnText && idle >= 2) return { kind: 'answered', text: answer() }
    if (d.now() >= until) break
    await d.sleep(d.pollMs)
    const grew = await read().catch(() => false)
    const busy = await d.working(path).catch(() => true)
    idle = grew || busy ? 0 : idle + 1
  }
  return said.length ? { kind: 'no-reply', text: answer() } : { kind: 'no-reply' }
}

/** Told while a passed-on message is in flight: `landed` once it is typed into
 *  the president's window, `reply` ONCE with what came back (or why nothing did). */
export interface PresidentRelayListener {
  landed?: () => void
  reply: (r: PresidentReply) => void
}

/** Pass `words` (the frame's body, exactly as the owner saw it) to the
 *  project's president — opening its window when closed — and tell `on` how
 *  it goes. The result tells only whether it was passed on: `waiting` = lines
 *  still ahead of it (0 = typed in already). */
export const relayToPresident = async (
  path: string,
  words: string,
  on: PresidentRelayListener,
  partial: Partial<PresidentRelayDeps> = {},
): Promise<PresidentRelayResult> => {
  const d = { ...defaults, ...partial }
  if (!words.trim() || !presidentWordsFit(words)) return { ok: false, error: 'too-long' }
  let woke = false
  if (!d.hasDesk(path)) {
    const err = await d.wake(path).catch((e) => String(e?.message ?? e))
    if (err) return { ok: false, error: err.slice(0, 200) }
    woke = true
  }
  const until = d.now() + d.waitMs
  let answered = false
  const answer = (r: PresidentReply) => {
    if (answered) return
    answered = true
    try {
      on.reply(r)
    } catch {
      /* the listener's own failure */
    }
  }
  let landed = false
  const onLanded = () => {
    // Given up on already (the wait ran out): nothing more is told.
    if (answered || landed) return
    landed = true
    try {
      on.landed?.()
    } catch {
      /* the listener's own failure */
    }
    // The answer gets its own full wait from the landing: a desk busy for most
    // of the landing wait must not leave the president seconds to answer.
    const from = d.now()
    void watchPresidentReply(path, words, from, from + d.waitMs, d).then(answer, () => answer({ kind: 'no-reply' }))
  }
  const waiting = await d.say(path, assistantRelayLine(words), onLanded)
  if (!landed)
    void (async () => {
      while (!landed && d.now() < until) await d.sleep(d.pollMs)
      if (landed) return
      // Never typed in: taken back, so it does not land days later when the desk reopens.
      d.cancel(path, onLanded)
      answer({ kind: 'not-landed' })
    })()
  // Others' lines queued behind it do not make a landed one "waiting".
  return { ok: true, woke, waiting: landed ? 0 : waiting }
}
