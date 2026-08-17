// PersonaConversation — the one thing to DO on the persona screen.
//
// TALKING IS HOW THE PERSONA GROWS (owner, 2026-08-15: 「対話していけば勝手に
// ペルソナに入る」). One turn is one `claude` run that both REPLIES and distils
// what the owner said into kept lines (src/lib/server/personaChat.ts), and the
// kept lines are appended to the corpus as they land.
//
// TWO RULES THIS COMPONENT EXISTS TO MAKE VISIBLE:
//   1. ONLY THE OWNER'S WORDS ARE LEARNED. The reply is never written back —
//      enforced server-side (personaChat.ts appendKeptLines never sees it), and
//      shown here by the fact that a chip only ever hangs off what the owner
//      said, never off the answer.
//   2. NOTHING IS WRITTEN INVISIBLY. 「勝手に入る」 means there is no approval
//      step; it does NOT mean behind your back. Every kept line is printed
//      under the message it came from and is a BUTTON that opens the existing
//      correction composer on that exact judgment. A turn that kept nothing
//      says so, because an absent chip row must never mean "we saved something
//      you cannot see".
//
// NO FETCHING OF ITS OWN. Every write and every poll lives in PersonaModule —
// the same rule as PersonaFigure. This file renders what it is handed and
// reports what the owner did.
//
// THE WAIT IS REAL AND IS STATED. A turn is a whole cold `claude` start: tens of
// seconds. The mock's 420ms bubble is unreachable on any runtime available
// today, so there is no typing animation here — there is an elapsed counter,
// which is the true thing.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { capTrackingClass } from '@/lib/labelScript'
import { PersonaPrivacyNote } from './PersonaPrivacyNote'
import type {
  ManualJudgment,
  PersonaChatTurn,
  PersonaImportCounts,
  PersonaImportResult,
  PersonaKeptWrite,
  PersonaQuestion,
} from '@/lib/types'

/** The rotating examples. Not decoration: this is the only place that says what
 *  the screen is FOR, and a single example would read as "this is a work tool"
 *  (owner, 2026-08-15 — the list deliberately spans work, money, other people
 *  and the owner themselves, i.e. the five regions of the figure). */
export const PROMPT_KEYS: readonly string[] = [
  'persona.prompt.01',
  'persona.prompt.02',
  'persona.prompt.03',
  'persona.prompt.04',
  'persona.prompt.05',
  'persona.prompt.06',
  'persona.prompt.07',
  'persona.prompt.08',
  'persona.prompt.09',
  'persona.prompt.10',
  'persona.prompt.11',
  'persona.prompt.12',
  'persona.prompt.13',
  'persona.prompt.14',
  'persona.prompt.15',
  'persona.prompt.16',
  'persona.prompt.17',
  'persona.prompt.18',
]

/** How long one example stays up. */
export const PROMPT_ROTATE_MS = 4200

/** How long the 「保存しました」 line stays after today's question is resolved.
 *  Long enough to read a sentence without looking for it; short enough that it
 *  is an acknowledgement rather than the standing panel it replaced. It is
 *  never the ONLY evidence — the answer becomes a lit point on the figure, and
 *  a save whose corpus rebuild failed raises the module's own persistent
 *  warning instead of relying on this. */
export const RESOLVED_NOTICE_MS = 8000

/** "At the bottom" for the stick-to-bottom rule — within one short bubble of
 *  the true foot. Tighter and an in-flight smooth scroll un-sticks the follow;
 *  looser and reading the second-to-last message still counts as "away". */
export const AT_BOTTOM_PX = 48

/** Kept lines shown on an import receipt before the 「ほか{n}件」 disclosure.
 *  An import can mint up to 40 (IMPORT_MAX_KEPT) — rendered flat, the chip
 *  wall pushed the receipt's numbers hundreds of pixels above a hidden-
 *  scrollbar fold, which is exactly what the owner photographed. */
export const IMPORT_KEPT_PREVIEW = 5

/** WANDER, DON'T CYCLE. A fixed +1 walk turns the list into a carousel the
 *  reader learns the order of; a jump of 1–3 keeps it feeling like the screen
 *  is offering something rather than reciting. Never returns the index it was
 *  given, so the placeholder always visibly changes. */
export const nextPromptIndex = (i: number, rnd: number, len = PROMPT_KEYS.length): number =>
  (i + 1 + Math.floor(rnd * 3)) % len

/** Same probe as PersonaFigure / SwarmSprite keep locally — one line of
 *  matchMedia, not worth a shared module, and this file must never animate on
 *  its own if the owner asked the OS not to. */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A claude.ai export being taken in, as the screen sees it. The module owns
 *  the job; this is the view of it. */
export interface PersonaImportView {
  fileName: string
  state: 'running' | 'done' | 'failed'
  /** Lands as soon as PARSING finished — before the distillation does. */
  counts?: PersonaImportCounts
  result?: PersonaImportResult
  /** i18n key for a failure that has copy of its own (a zip, a file that is not
   *  an export, an already-imported file). */
  errorKey?: string
  errorVars?: Record<string, string | number>
}

export interface PersonaConversationProps {
  /** Oldest first. */
  turns: PersonaChatTurn[]
  /** Whether GET /api/persona/chat actually LANDED. `false` is a failed read,
   *  and an empty thread must never be drawn over one — that would say "you
   *  have said nothing", which is the claim a failed read cannot make. */
  threadRead: boolean
  onRetryThread: () => void
  /** Real elapsed ms of the turn in flight. The module owns the clock. */
  elapsedMs: number
  /** A turn is in flight: the input still takes text, the send does not fire. */
  busy: boolean
  /** i18n key of the last send failure, or null. */
  errorKey: string | null
  onSend: (text: string) => void
  /** Stop the turn in flight. Reaches POST /api/persona/chat/cancel — the ONLY
   *  thing that ends a run (a dropped connection does not), and until this was
   *  wired the route had no caller at all. */
  onCancel: (turnId: string) => void
  /** Opens the existing correction composer on a kept line. */
  onCorrect: (judgment: ManualJudgment) => void
  /** Today's question — the conversation's OPENING turn rather than a fourth
   *  card in a corner (owner: 「文字は極力少なくしたい」). `null` covers both "no
   *  question today" and "could not read one": neither is worth a sentence. */
  question: PersonaQuestion | null
  answering: boolean
  answerStale: boolean
  /** A failed SKIP gets its own line: there is no answer to reassure the owner
   *  about on that path, so the answer path's wording would be nonsense. A
   *  failed ANSWER is reported as a failed TURN instead — the owner's own
   *  bubble, still on screen, with a retry under it. */
  skipFailed: boolean
  onSkipQuestion: () => void
  /** 'none' = swept and found nothing; 'failed' = the sweep itself did not
   *  land. Kept apart because only one of them is a claim about the owner. */
  moreState: 'idle' | 'loading' | 'none' | 'failed'
  onAskAnother: () => void
  lang: string
  /** A file dropped on the input. Parsing, hashing and posting are the
   *  module's; this only reports the drop. */
  onDropExport: (file: File) => void
  importJob: PersonaImportView | null
}

/** Ink for anything that sits BARE on the stage. `bg-deep` is the one surface
 *  that does not invert with the theme, so the semantic warning tokens are each
 *  wrong in one theme here (`accent` is #B23A2C in light — ~2.3:1 on the stage).
 *  Painted, like PersonaFigure's own tones, for the same reason. */
const STAGE_ALERT = 'text-[#F29580]'
const STAGE_WARN = 'text-[#DDAE58]'

/** One bubble. `me` is the owner's own words.
 *
 *  The two are built differently on purpose: the reply sits on an OPAQUE card
 *  (`bg-bg-card` inverts with the theme, and `text-ink` inverts with it), while
 *  the owner's own bubble is a translucent wash that lets the dark stage
 *  through — so it takes `ink-onDeep`, the one ink made for a surface that does
 *  not invert. Swapping either pair puts dark ink on near-black at noon. */
const Bubble = ({ me, children }: { me?: boolean; children: React.ReactNode }) => (
  <div
    className={`max-w-[88%] whitespace-pre-wrap break-words rounded-[3px] border px-3 py-2 text-meta leading-relaxed ${
      me
        ? 'self-end border-accent/40 bg-accent/15 text-ink-onDeep'
        : 'self-start border-line bg-bg-card text-ink'
    }`}
  >
    {children}
  </div>
)

/** A kept line, exactly where it came from — and pressable. */
const KeptChip = ({
  kept,
  onCorrect,
}: {
  kept: PersonaKeptWrite
  onCorrect: (j: ManualJudgment) => void
}) => {
  const { t } = useT()
  return (
    <>
      <button
        type="button"
        onClick={() => onCorrect(kept.judgment)}
        className="flex max-w-[88%] items-start gap-2 self-end text-left text-micro leading-relaxed text-ink-onDeep/55 transition-colors hover:text-ink-onDeep/85"
      >
        <span
          aria-hidden="true"
          className="mt-1.5 block h-1.5 w-1.5 flex-none rounded-full bg-accent shadow-[0_0_8px_rgba(242,149,128,.8)]"
        />
        <span>
          {`${t('persona.chat.keptLead')} — ${kept.judgment.text}`}
          <span className="block text-ink-onDeep/35">
            {[kept.judgment.context, t('persona.correct.pressToFix')].filter(Boolean).join(' ・ ')}
          </span>
        </span>
      </button>
      {kept.corpusStale && (
        <p className={`max-w-[88%] self-end text-micro leading-relaxed ${STAGE_WARN}`}>
          {t('persona.chat.keptStale')}
        </p>
      )}
    </>
  )
}

export const PersonaConversation = ({
  turns,
  threadRead,
  onRetryThread,
  elapsedMs,
  onCancel,
  busy,
  errorKey,
  onSend,
  onCorrect,
  question,
  answering,
  answerStale,
  skipFailed,
  onSkipQuestion,
  moreState,
  onAskAnother,
  lang,
  onDropExport,
  importJob,
}: PersonaConversationProps) => {
  const { t } = useT()
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragDepthRef = useRef(0)
  const talkRef = useRef<HTMLDivElement>(null)

  // The rotation reads these through refs so the interval is created ONCE —
  // re-creating it on every keystroke would reset the 4.2s clock and the
  // placeholder would never change while anyone was typing anyway.
  const busyRef = useRef(false)
  busyRef.current = focused || draft.length > 0
  const reduced = useMemo(prefersReducedMotion, [])
  const [promptIndex, setPromptIndex] = useState(() =>
    Math.floor(Math.random() * PROMPT_KEYS.length),
  )
  // `question` is read through the ref for the same reason `busy` is: the
  // interval must be created ONCE, and re-creating it whenever the question
  // object is re-fetched would reset the 4.2s clock on every poll.
  const answeringRef = useRef(false)
  answeringRef.current = question?.status === 'open'
  useEffect(() => {
    if (reduced) return undefined
    const id = window.setInterval(() => {
      // NEVER while they are using it: typing, or focused with an empty box.
      if (busyRef.current) return
      // …and never while today's question is the box's job (see `placeholder`).
      if (answeringRef.current) return
      setPromptIndex((i) => nextPromptIndex(i, Math.random()))
    }, PROMPT_ROTATE_MS)
    return () => window.clearInterval(id)
  }, [reduced])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text || busy) return
    // CLEARED HERE, and the module re-offers the words on failure by keeping
    // them in the turn itself (state 'failed' carries `text`). A React value
    // reset is not undoable, so the words have to exist somewhere else BEFORE
    // this line runs — which is why onSend is given them.
    setDraft('')
    onSend(text)
  }, [draft, busy, onSend])

  const anythingKept = turns.some((turn) => (turn.kept?.length ?? 0) > 0)
  const questionText = question ? (lang === 'ja' ? question.textJa : question.textEn) : ''
  const questionContext = question ? (lang === 'ja' ? question.contextJa : question.contextEn) : ''

  // ── THE QUESTION HAS A LIFETIME, AND THE SCREEN SHOULD TOO ────────────────
  //
  // Owner, 2026-08-16, on an answered question still standing hours later:
  // 「答えたらずっと表示する必要なくない? ちゃんとユーザーのフローも考えて設計して」.
  //
  // The block used to render for every status, so a question asked at 09:00 and
  // answered at 09:01 kept its heading, its setting, its text and a 「保存しました」
  // line above the input until midnight — five lines whose entire job was
  // finished in the first minute. Worse, within the same session the answer was
  // ALSO in the thread as the owner's own bubble, so the screen said the same
  // thing twice.
  //
  // The loop is once a day (personaInterview.ts), so the flow is:
  //   ASKED    — the question is the point of the screen; the box is its answer
  //              box (see `awaitingAnswer` below). This is the only phase with
  //              anything to do, and the only one that draws the block.
  //   RESOLVED — an EVENT, not a state. A short confirmation, then gone. The
  //              durable record is not this line: the answer became a lit point
  //              on the figure (the module sparks it) and a line in the corpus.
  //   AFTER    — nothing. The box is a plain chat box again and the day's
  //              question is simply over; tomorrow brings another.
  //
  // ⚠ ONLY SUCCESS IS TRANSIENT. A failed skip leaves the question OPEN, so the
  // block — and its error — stay put. A save whose corpus rebuild failed raises
  // the module's own persistent `persona.meta.stale` card, which is not on this
  // timer. Nothing that needs acting on is allowed to fade.
  const [justResolved, setJustResolved] = useState<'answered' | 'skipped' | null>(null)
  const lastStatus = useRef<PersonaQuestion['status'] | null>(question?.status ?? null)
  useEffect(() => {
    const before = lastStatus.current
    const now = question?.status ?? null
    lastStatus.current = now
    // Only a transition WATCHED BY THE OWNER counts. Mounting onto an
    // already-answered question (a reload later the same day) must say nothing —
    // that is the standing panel this replaces.
    if (before === 'open' && (now === 'answered' || now === 'skipped')) setJustResolved(now)
  }, [question?.status])
  useEffect(() => {
    if (!justResolved) return undefined
    const id = window.setTimeout(() => setJustResolved(null), RESOLVED_NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [justResolved])

  // ── STICK TO THE BOTTOM, DON'T YANK TO IT ─────────────────────────────────
  //
  // The first cut was one unconditional `scrollTop = scrollHeight` on
  // [turns, importJob]. Measured on the running app (owner, 2026-08-17:
  // 「スクロールも適当な感じ」), that one line was BOTH scroll defects at once:
  //   · no "is the reader already at the bottom?" check, so reading history
  //     got snapped to the foot on every reply/failure/cancel — and during a
  //     ZIP import the poll re-minted its state every 500ms, which made
  //     scrolling up PHYSICALLY IMPOSSIBLE for the whole distillation;
  //   · deps of only [turns, importJob], so the skip receipt, the day's
  //     question and the resolved notice appended real content with NO scroll
  //     at all — invisible below the fold of a scrollbar-less container.
  //
  // The rule now: follow new content ONLY while the reader is at (or within a
  // bubble's height of) the bottom. Scrolled up = reading — nothing moves the
  // view; a 「↓ 最新へ」 pill appears instead, and pressing it (or scrolling
  // back down) re-arms the follow. SdkWorkerPane:426 has carried this exact
  // guard for its log pane all along; the chat simply never got it.
  const stuckRef = useRef(true)
  const [below, setBelow] = useState(false) // new content while scrolled up
  const [scrolled, setScrolled] = useState(false) // history exists above the fold
  const pinToBottom = useCallback(() => {
    const el = talkRef.current
    if (el) el.scrollTop = el.scrollHeight
    stuckRef.current = true
    setBelow(false)
  }, [])
  const onThreadScroll = useCallback(() => {
    const el = talkRef.current
    if (!el) return
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX
    if (stuckRef.current) setBelow(false)
    setScrolled(el.scrollTop > 4)
  }, [])
  // useLayoutEffect, not useEffect: the pin must land before paint, or every
  // new message flashes the un-scrolled position for a frame first.
  useLayoutEffect(() => {
    if (stuckRef.current) {
      const el = talkRef.current
      if (el) el.scrollTop = el.scrollHeight
    } else {
      setBelow(true)
    }
    // Every dep here APPENDS OR REMOVES content inside the container — the old
    // list stopped at the first two, which is how the skip receipt and the
    // question arrived off-screen.
  }, [turns, importJob, question?.status, justResolved, skipFailed])
  // The container is max-h-[46vh]: its height follows the window, so a resize
  // while stuck must re-pin or the newest message slides below the fold.
  useEffect(() => {
    const onResize = () => {
      if (!stuckRef.current) return
      const el = talkRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── IMPORT RECEIPT STATE ──────────────────────────────────────────────────
  // The distillation is a whole cold `claude` run — minutes on a real export —
  // and a static count block reads as a hang. The clock runs only while the
  // distiller actually does (counts landed, job still running); the parse
  // phase before that has its own 「読んでいます」 line and needs no timer.
  const distilling = importJob?.state === 'running' && importJob.counts != null
  const [importSeconds, setImportSeconds] = useState(0)
  useEffect(() => {
    if (!distilling) {
      setImportSeconds(0)
      return undefined
    }
    const started = Date.now()
    const id = window.setInterval(
      () => setImportSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    )
    return () => window.clearInterval(id)
  }, [distilling])
  // A real export kept ~40 lines and every one became a chip — a wall that
  // buried the receipt's own numbers (2026-08-17 audit). The receipt previews
  // IMPORT_KEPT_PREVIEW and folds the rest behind one button; a NEW file
  // starts folded again.
  const [showAllKept, setShowAllKept] = useState(false)
  useEffect(() => {
    setShowAllKept(false)
  }, [importJob?.fileName])

  // ⚠ ONE BOX, ONE JOB AT A TIME (field report, 2026-08-15). While today's
  // question is unanswered, this box IS that question's answer box — and the
  // rotating placeholder suggests a DIFFERENT thing to talk about. Shown under
  // an open question it reads as a second, competing prompt, and the owner
  // could not tell which one the box belonged to. The rotation is not merely
  // hidden: `awaitingAnswer` also stops the interval below, because a
  // placeholder nobody can see has no business burning a timer.
  const awaitingAnswer = question?.status === 'open'
  const placeholder = dragging
    ? t('persona.import.dropHint')
    : awaitingAnswer
      ? t('persona.chat.placeholderAnswer')
      : t('persona.chat.placeholder', { prompt: t(PROMPT_KEYS[promptIndex]) })

  const stop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // `question?.status === 'open'`, not `question !== null`: a resolved question
  // renders nothing (the block below gates on 'open'), so counting it here
  // mounted an EMPTY scroll container whose only contribution was its margin.
  // `justResolved` DOES count: on an empty day the resolved receipt is the only
  // thing in the thread, and a receipt whose container is gone was never shown.
  const hasThread =
    !threadRead ||
    question?.status === 'open' ||
    turns.length > 0 ||
    importJob !== null ||
    justResolved !== null

  return (
    <div
      className="flex flex-col"
      onDragEnter={(e) => {
        stop(e)
        // A DEPTH COUNTER, not a boolean. dragleave fires on this root every
        // time the pointer crosses INTO a child (the thread, the input, every
        // bubble), so a plain setDragging(false) made the ochre drop border
        // flicker all the way across the console.
        dragDepthRef.current += 1
        setDragging(true)
      }}
      onDragOver={stop}
      onDragLeave={(e) => {
        stop(e)
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        stop(e)
        dragDepthRef.current = 0
        setDragging(false)
        const file = e.dataTransfer?.files?.[0]
        if (file) onDropExport(file)
      }}
    >
      {/* THE ONLY THING ON THIS SCREEN THAT SCROLLS, besides the result sheet —
       *  and it scrolls INSIDE itself, so the stage never becomes a page (owner:
       *  「スクロールなしにしてほしい」). Absent entirely when there is nothing in
       *  it: the rotating placeholder carries the whole invitation.
       *
       *  The scrollbar stays hidden (stage aesthetics), so the wrapper carries
       *  the two affordances that replace it: a top fade the moment history
       *  exists above the fold, and the 「↓ 最新へ」 pill when content arrived
       *  while the reader was up in that history. */}
      {hasThread && (
        <div className="relative mb-2.5">
          {scrolled && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 bg-gradient-to-b from-bg-deep to-transparent"
            />
          )}
          {below && (
            <button
              type="button"
              onClick={pinToBottom}
              className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line-onDeep bg-bg-cardOnDeep px-3 py-1 text-micro text-ink-onDeep/75 shadow-card transition-colors hover:text-ink-onDeep"
            >
              {t('persona.chat.jumpLatest')}
            </button>
          )}
        <div
          ref={talkRef}
          data-testid="chat-thread"
          onScroll={onThreadScroll}
          className="flex max-h-[min(46vh,420px)] flex-col gap-3 overflow-y-auto pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {/* A FAILED READ IS NOT AN EMPTY CONVERSATION. */}
          {!threadRead && (
            <div className="flex flex-col items-start gap-1.5">
              <Bubble>{t('persona.chat.stateUnreadable')}</Bubble>
              <button
                type="button"
                onClick={onRetryThread}
                className="text-micro text-ink-onDeep/50 underline-offset-2 hover:text-ink-onDeep hover:underline"
              >
                {t('persona.retry')}
              </button>
            </div>
          )}

          {turns.map((turn) => (
            <div key={turn.id} className="flex flex-col gap-1.5">
              {/* The owner's own words. They STAY on screen whatever happens to
               *  the turn — a failed send must never cost someone what they
               *  typed. */}
              <Bubble me>{turn.text}</Bubble>

              {turn.state === 'running' && (
                <div className="flex items-baseline gap-2.5 self-start">
                  <p className="text-micro leading-relaxed text-ink-onDeep/45">
                    {elapsedMs > 0
                      ? t('persona.chat.thinking', { seconds: Math.floor(elapsedMs / 1000) })
                      : t('persona.chat.sending')}
                  </p>
                  {/* THE WAY OUT. A turn runs on the owner's own subscription
                   *  for up to ten minutes and holds the single-flight slot the
                   *  whole time, so with no stop here a cold start that wedges
                   *  costs them the screen AND their quota with nothing to press.
                   *  The server route existed from the start; nothing reached
                   *  it. Quiet by default — this is an escape hatch, not an
                   *  action the owner is being invited to take. */}
                  <button
                    type="button"
                    onClick={() => onCancel(turn.id)}
                    className="text-micro text-ink-onDeep/40 underline-offset-2 transition-colors hover:text-ink-onDeep hover:underline"
                  >
                    {t('persona.chat.stop')}
                  </button>
                </div>
              )}

              {turn.state === 'failed' && (
                <div className="flex flex-col items-start gap-1">
                  {/* A turn the OWNER stopped is not a turn that failed. The
                   *  marker comes from the server itself (personaChat.ts stamps
                   *  `error: 'cancelled'` on an aborted run) and is set locally
                   *  on the press too, so the line is right immediately and
                   *  still right after the poll reconciles. */}
                  <p
                    className={`text-micro leading-relaxed ${
                      turn.error === 'cancelled' ? 'text-ink-onDeep/45' : STAGE_ALERT
                    }`}
                  >
                    {turn.error === 'cancelled'
                      ? t('persona.chat.stopped')
                      : t('persona.chat.turnFailed')}
                  </p>
                  <button
                    type="button"
                    onClick={() => onSend(turn.text)}
                    disabled={busy}
                    className="text-micro text-ink-onDeep/60 underline-offset-2 hover:text-ink-onDeep hover:underline disabled:opacity-50"
                  >
                    {t('persona.chat.retry')}
                  </button>
                </div>
              )}

              {turn.state === 'done' && turn.reply && <Bubble>{turn.reply}</Bubble>}

              {turn.kept?.map((kept) => (
                <KeptChip key={kept.judgment.id} kept={kept} onCorrect={onCorrect} />
              ))}

              {/* An EMPTY kept array is a real answer and is said out loud.
               *  `undefined` is a different thing: nothing was distilled from
               *  this turn at all (it is still running, or it was an answer to
               *  the day's question, which mints its node server-side). */}
              {turn.state === 'done' && turn.kept?.length === 0 && (
                <p className="self-end text-micro leading-relaxed text-ink-onDeep/40">
                  {t('persona.chat.keptNone')}
                </p>
              )}

              {/* Lines the distiller produced that could not be placed. Dropped
               *  rather than guessed at — and counted rather than swallowed. */}
              {(turn.keptUnreadable ?? 0) > 0 && (
                <p className="self-end text-micro leading-relaxed text-ink-onDeep/40">
                  {t('persona.chat.keptUnreadable', { count: turn.keptUnreadable ?? 0 })}
                </p>
              )}
            </div>
          ))}

          {/* ⚠ AT THE FOOT OF THE THREAD, NOT WHERE THE QUESTION WAS. It is a
           *  receipt for what the owner just sent, so it belongs under their own
           *  bubble — the place they are already looking — rather than in the
           *  gap the question left, which reads as the panel refusing to go.
           *  `aria-live` because it is announced once and then leaves. */}
          {justResolved && (
            <p
              aria-live="polite"
              className="self-start text-micro leading-relaxed text-ink-onDeep/45"
            >
              {t(
                justResolved === 'skipped'
                  ? 'persona.interview.skipped'
                  : // "Your stand-in has this now" is only true once the file it
                    // reads has actually been rebuilt.
                    answerStale
                    ? 'persona.interview.answeredStale'
                    : 'persona.interview.answered',
              )}
            </p>
          )}

          {/* ── THE IMPORT RECEIPT — A CARD, NOT A CHAT EXCHANGE ─────────────
           *  It used to render as an owner bubble (the file name) answered by an
           *  assistant bubble (the numbers) — the import WEARING the chat's
           *  clothes. The owner then asked the stand-in about the zip and it
           *  truthfully said it had never seen one (2026-08-17 screenshot):
           *  both channels behaved, and the screen as a whole lied. The import
           *  is a different process, so it gets a different body — one card in
           *  the stage's own on-deep surface, named 「取り込み」, with the file
           *  name in its head — and the card SAYS the conversation never saw
           *  this file.
           *
           *  ⚠ ZEROS ARE NOT SAID. The receipt printed 「読めなかった行が0件あり、
           *  飛ばしました」 and three more zero-lines on a clean import — the
           *  exact clause-per-known-thing rule the Board roll-up follows,
           *  broken wholesale here. A zero loss is silence; a NONZERO loss is
           *  a sentence. (The failure line is still exclusive with ALL numbers:
           *  a partial count over a file that could not be parsed is the exact
           *  failure mode.) */}
          {importJob && (
            <div
              data-testid="import-receipt"
              className="flex flex-col gap-1.5 self-stretch rounded-[3px] border border-line-onDeep bg-bg-cardOnDeep px-3.5 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className={`label-cap ${capTrackingClass(t('persona.import.heading'))} shrink-0 text-ink-onDeep/50`}>
                  {t('persona.import.heading')}
                </span>
                <span className="min-w-0 truncate text-micro text-ink-onDeep/40" title={importJob.fileName}>
                  {importJob.fileName}
                </span>
              </div>
              {importJob.errorKey ? (
                <p className={`text-meta leading-relaxed ${STAGE_ALERT}`}>
                  {t(importJob.errorKey, importJob.errorVars)}
                </p>
              ) : (
                <>
                  {!importJob.counts && (
                    <p className="text-meta leading-relaxed text-ink-onDeep/70">
                      {t('persona.import.reading')}
                    </p>
                  )}
                  {importJob.counts && (
                    <div className="text-meta leading-relaxed text-ink-onDeep/70">
                      <span className="block">
                        {t('persona.import.parsed', {
                          conversations: importJob.counts.conversations,
                        })}
                      </span>
                      <span className="block">{t('persona.import.ownerOnly')}</span>
                      {importJob.counts.droppedNonOwner > 0 && (
                        <span className="block">
                          {t('persona.import.dropped', {
                            count: importJob.counts.droppedNonOwner,
                          })}
                        </span>
                      )}
                      {importJob.counts.unreadable > 0 && (
                        <span className="block">
                          {t('persona.import.unreadableRows', {
                            count: importJob.counts.unreadable,
                          })}
                        </span>
                      )}
                      {/* The denominator, at last: 「このうち400件」 with nothing to
                       *  anchor it was the owner's own screenshot. */}
                      <span className="block">
                        {t('persona.import.considered', {
                          total: importJob.counts.considered + importJob.counts.notConsidered,
                          count: importJob.counts.considered,
                        })}
                      </span>
                      {importJob.counts.notConsidered > 0 && (
                        <span className="block">
                          {t('persona.import.notConsidered', {
                            count: importJob.counts.notConsidered,
                          })}
                        </span>
                      )}
                    </div>
                  )}
                  {/* The distillation is a whole cold claude run — minutes on a
                   *  real export. A static count block reads as a hang; the
                   *  elapsed counter is the same honesty the chat's own
                   *  thinking line carries. */}
                  {importJob.state === 'running' && importJob.counts && (
                    <p className="text-micro leading-relaxed text-ink-onDeep/45">
                      {t('persona.import.distilling', { seconds: importSeconds })}
                    </p>
                  )}
                  {importJob.result && (
                    <div className="text-meta leading-relaxed text-ink-onDeep/70">
                      {importJob.result.duplicatesSkipped > 0 && (
                        <span className="block">
                          {t('persona.import.duplicates', {
                            count: importJob.result.duplicatesSkipped,
                          })}
                        </span>
                      )}
                      {importJob.result.keptUnreadable > 0 && (
                        <span className="block">
                          {t('persona.import.keptUnreadable', {
                            count: importJob.result.keptUnreadable,
                          })}
                        </span>
                      )}
                    </div>
                  )}
                  {importJob.result &&
                    (importJob.result.kept.length === 0 ? (
                      <p className="text-micro leading-relaxed text-ink-onDeep/45">
                        {t('persona.chat.keptNone')}
                      </p>
                    ) : (
                      <p className="text-micro leading-relaxed text-ink-onDeep/55">
                        {t('persona.import.keptCount', {
                          count: importJob.result.kept.length,
                        })}
                      </p>
                    ))}
                  {(showAllKept
                    ? importJob.result?.kept
                    : importJob.result?.kept.slice(0, IMPORT_KEPT_PREVIEW)
                  )?.map((kept) => (
                    <KeptChip key={kept.judgment.id} kept={kept} onCorrect={onCorrect} />
                  ))}
                  {!showAllKept &&
                    (importJob.result?.kept.length ?? 0) > IMPORT_KEPT_PREVIEW && (
                      <button
                        type="button"
                        onClick={() => setShowAllKept(true)}
                        className="self-end text-micro text-ink-onDeep/55 underline-offset-2 transition-colors hover:text-ink-onDeep hover:underline"
                      >
                        {t('persona.import.showMoreKept', {
                          count: (importJob.result?.kept.length ?? 0) - IMPORT_KEPT_PREVIEW,
                        })}
                      </button>
                    )}
                  {/* The line the owner's screenshot was missing: the chat and
                   *  the import are different channels, and only this card says
                   *  so. Stated on the finished receipt, where the next thing
                   *  the owner does is often to ASK the stand-in about it. */}
                  {importJob.state === 'done' && (
                    <p className="border-t border-line-onDeep pt-1.5 text-micro leading-relaxed text-ink-onDeep/40">
                      {t('persona.import.notChat')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Today's 1問 — AT THE FOOT of the thread, right above the box that
           *  answers it. It opened the thread for its first two arrangements,
           *  which read fine on an empty day and became invisible on a full
           *  one: the thread pins to the bottom, the scrollbar is hidden, and a
           *  question inserted at the TOP arrived with no scroll and no
           *  affordance — while the input silently became its answer box
           *  (2026-08-17 audit). The thing the next keypress answers belongs
           *  next to the place the keypress happens.
           *
           *  ⚠ WHILE IT IS OPEN, AND NOT A MINUTE LONGER — see the lifetime note
           *  at `justResolved`. An answered question has nothing left to do and
           *  standing there is the whole complaint. */}
          {question?.status === 'open' && (
            /* ⚠ THE QUESTION IS TEXT. NOT A CARD, NOT A BRACKET.
             *
             *  It has now been through three arrangements, and the third is the
             *  owner's own diagnosis (2026-08-16): 「今日の一問もブロックに囲まれてて
             *  フォームも囲まれているから冗長に感じるのかも。質問はテキストだけでいい」
             *  — a box above a box, and only one of them is a thing you can
             *  operate. The input's border MEANS something (type here); a border
             *  drawn around the question means nothing, so it was competing with
             *  the one that does. With the card gone the box below is the only
             *  bordered object on the stage, which says where to answer better
             *  than any amount of drawing around the question did.
             *
             *  The ochre rail that ran down the left of both went with it, same
             *  verdict — 「左のサイドラインもやめようAIっぽい」. The job it was doing
             *  (tying the question to the box) is done by there being nothing
             *  else between them.
             *
             *  ⚠ `ink-onDeep`, NOT `ink`. This text now sits bare on `bg-deep`,
             *  the one surface in the palette that does NOT invert — `text-ink`
             *  on it is the SAME COLOUR in light mode (1.00:1, invisible). The
             *  card carried inverting tokens legitimately; on the stage they
             *  would be a light-theme-only disappearance nobody developing in
             *  dark would ever see. See src/labelPlates.test.ts. */
            <div className="flex flex-col">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={`label-cap ${capTrackingClass(t('persona.interview.heading'))} text-[var(--beacon-waiting)]`}
                >
                  {t('persona.interview.heading')}
                </span>
                <button
                  type="button"
                  onClick={onSkipQuestion}
                  disabled={answering}
                  className="shrink-0 text-micro text-ink-onDeep/35 transition-colors hover:text-ink-onDeep disabled:opacity-50"
                >
                  {t('persona.interview.skip')}
                </button>
              </div>
              {/* THE SETTING FIRST: the question quotes fragments of something
               *  that happened days ago, and read cold those quotes are noise.
               *  Absent on questions written by an older build. */}
              {questionContext && (
                <p className="mt-1.5 text-micro leading-relaxed text-ink-onDeep/40">
                  {questionContext}
                </p>
              )}
              <p className="mt-1 text-meta leading-relaxed text-ink-onDeep/85">{questionText}</p>
              {skipFailed && (
                <p className={`mt-1.5 text-micro leading-relaxed ${STAGE_ALERT}`}>
                  {t('persona.interview.skipFailed')}
                </p>
              )}
            </div>
          )}
        </div>
        </div>
      )}

      {/* ── ASK FOR ANOTHER ──────────────────────────────────────────────────
       *  Owner, 2026-08-16: 「新しい質問を出すボタンがあってもいいかも。1日1答に
       *  する必要はない」. The daily sweep offers one without being asked; this is
       *  the owner asking.
       *
       *  ⚠ OUTSIDE `talkRef`, not inside it. Everything in the thread scrolls
       *  away as the conversation grows, and an ACTION that scrolls out of reach
       *  is worse than no action. It sits directly above the box instead —
       *  adjacent to where the answer gets typed.
       *
       *  ⚠ ONLY WHEN NOTHING IS OPEN. With a question on the table this would be
       *  an invitation to abandon it, and the server refuses anyway
       *  (nextQuestion returns the open one rather than burning its subject). */}
      {question?.status !== 'open' && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <button
            type="button"
            onClick={onAskAnother}
            disabled={moreState === 'loading'}
            className="text-micro text-ink-onDeep/45 underline-offset-2 transition-colors hover:text-ink-onDeep hover:underline disabled:no-underline disabled:opacity-60"
          >
            {t(moreState === 'loading' ? 'persona.interview.moreLoading' : 'persona.interview.more')}
          </button>
          {/* The two outcomes that are not a question, kept apart: one is a
           *  finding about the owner's records, the other is this app failing. */}
          {moreState === 'none' && (
            <span className="text-micro leading-relaxed text-ink-onDeep/40">
              {t('persona.interview.moreNone')}
            </span>
          )}
          {moreState === 'failed' && (
            <span className={`text-micro leading-relaxed ${STAGE_ALERT}`}>
              {t('persona.interview.moreFailed')}
            </span>
          )}
        </div>
      )}

      {/* ── the input. Quiet until focused; ochre and dashed while a file is
       *  over it, because dropping an export here is the same act as talking.
       *
       *  ⚠ `cardOnDeep` / `line-onDeep`, NOT `bg-card` / `line`. This box is the
       *  ONE bordered object on the stage — the last two rounds of this screen
       *  were about exactly that — and it sat on `bg-deep`, which does not
       *  invert, wearing surface tokens that do. Rendered in the LIGHT theme for
       *  the first time (2026-08-16) it was a cream slab on near-black. The
       *  owner runs dark and could not have seen it. The on-deep pair carries
       *  the DARK values in both palettes, so dark is byte-identical to before
       *  and light finally matches it. */}
      <div
        className={`flex items-center gap-2.5 rounded-[3px] border px-3.5 py-2.5 transition-colors ${
          dragging
            ? 'border-dashed border-ochre bg-ochre/10'
            : 'border-line-onDeep bg-bg-cardOnDeep'
        }`}
      >
        <input
          type="text"
          value={draft}
          autoComplete="off"
          // A STABLE accessible name. The placeholder rotates, and an input
          // whose only name is a placeholder is an input a screen reader
          // renames every four seconds.
          aria-label={t('persona.chat.inputLabel')}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // THE IME GUARD. In Japanese, Enter CONFIRMS a conversion — sending
            // on it would post half a sentence the owner was still writing, and
            // this is the one surface where losing typed words is unacceptable.
            if (e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-ui text-ink-onDeep placeholder:text-ink-onDeep/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !draft.trim()}
          aria-label={t('persona.chat.send')}
          className="flex-none text-plate text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
        >
          ↵
        </button>
      </div>

      {errorKey && (
        <p className={`mt-1.5 text-center text-micro leading-relaxed ${STAGE_ALERT}`}>
          {t(errorKey)}
        </p>
      )}

      {/* ── the footer, as ONE line ──────────────────────────────────────────
       *  Two centred sentences stacked under the box (what this does · where it
       *  goes) read as two unrelated afterthoughts, and they were the last of
       *  the loose parts on this stage. They are one row now, separated by a
       *  middot: the same two facts, occupying one line's worth of attention.
       *  The hint changes once there is something to correct — at that moment
       *  the useful sentence is what to do about a line that is wrong. */}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-micro leading-relaxed text-ink-onDeep/40">
        <span>{t(anythingKept ? 'persona.chat.hintCorrect' : 'persona.chat.hint')}</span>
        <span aria-hidden="true" className="text-ink-onDeep/20">
          ·
        </span>
        <PersonaPrivacyNote />
      </div>
    </div>
  )
}
