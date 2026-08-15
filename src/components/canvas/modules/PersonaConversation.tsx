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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    className={`max-w-[88%] whitespace-pre-wrap rounded-[3px] border px-3 py-2 text-meta leading-relaxed ${
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
  lang,
  onDropExport,
  importJob,
}: PersonaConversationProps) => {
  const { t } = useT()
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
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
  useEffect(() => {
    if (reduced) return undefined
    const id = window.setInterval(() => {
      // NEVER while they are using it: typing, or focused with an empty box.
      if (busyRef.current) return
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

  // Grow upward: the newest thing is at the bottom, next to the input.
  useEffect(() => {
    const el = talkRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, importJob])

  const anythingKept = turns.some((turn) => (turn.kept?.length ?? 0) > 0)
  const questionText = question ? (lang === 'ja' ? question.textJa : question.textEn) : ''
  const questionContext = question ? (lang === 'ja' ? question.contextJa : question.contextEn) : ''

  const placeholder = dragging
    ? t('persona.import.dropHint')
    : t('persona.chat.placeholder', { prompt: t(PROMPT_KEYS[promptIndex]) })

  const stop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const hasThread = !threadRead || question !== null || turns.length > 0 || importJob !== null

  return (
    <div
      className="flex flex-col"
      onDragEnter={(e) => {
        stop(e)
        setDragging(true)
      }}
      onDragOver={(e) => {
        stop(e)
        setDragging(true)
      }}
      onDragLeave={(e) => {
        stop(e)
        setDragging(false)
      }}
      onDrop={(e) => {
        stop(e)
        setDragging(false)
        const file = e.dataTransfer?.files?.[0]
        if (file) onDropExport(file)
      }}
    >
      {/* THE ONLY THING ON THIS SCREEN THAT SCROLLS, besides the result sheet —
       *  and it scrolls INSIDE itself, so the stage never becomes a page (owner:
       *  「スクロールなしにしてほしい」). Absent entirely when there is nothing in
       *  it: the rotating placeholder carries the whole invitation. */}
      {hasThread && (
        <div
          ref={talkRef}
          className="mb-2.5 flex max-h-[min(46vh,420px)] flex-col gap-3 overflow-y-auto pr-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

          {/* Today's 1問, as the conversation's opening turn. The next thing the
           *  owner types answers it (the module routes the send). */}
          {question && (
            <div className="flex flex-col gap-1.5">
              <span
                className={`label-cap ${capTrackingClass(t('persona.interview.heading'))} text-ink-onDeep/40`}
              >
                {t('persona.interview.heading')}
              </span>
              {/* THE SETTING FIRST: the question quotes fragments of something
               *  that happened days ago, and read cold those quotes are noise.
               *  Absent on questions written by an older build. */}
              {questionContext && (
                <p className="max-w-[88%] self-start text-micro leading-relaxed text-ink-onDeep/45">
                  {questionContext}
                </p>
              )}
              <Bubble>{questionText}</Bubble>
              {question.status === 'open' ? (
                <button
                  type="button"
                  onClick={onSkipQuestion}
                  disabled={answering}
                  className="self-start text-micro text-ink-onDeep/45 underline-offset-2 hover:text-ink-onDeep hover:underline disabled:opacity-50"
                >
                  {t('persona.interview.skip')}
                </button>
              ) : (
                <p className="self-start text-micro leading-relaxed text-ink-onDeep/55">
                  {t(
                    question.status !== 'answered'
                      ? 'persona.interview.skipped'
                      : // "Your stand-in has this now" is only true once the
                        // file it reads has actually been rebuilt.
                        answerStale
                        ? 'persona.interview.answeredStale'
                        : 'persona.interview.answered',
                  )}
                </p>
              )}
              {skipFailed && (
                <p className={`self-start text-micro leading-relaxed ${STAGE_ALERT}`}>
                  {t('persona.interview.skipFailed')}
                </p>
              )}
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

          {importJob && (
            <div className="flex flex-col gap-1.5">
              <Bubble me>{importJob.fileName}</Bubble>
              <Bubble>
                {/* THE HEAD LINE, and it is exclusive with the counts below: a
                 *  partial count over a file that could not be parsed is the
                 *  exact failure mode, so a failure prints its own sentence and
                 *  NO numbers at all. */}
                {importJob.errorKey
                  ? t(importJob.errorKey, importJob.errorVars)
                  : importJob.counts
                    ? null
                    : t('persona.import.reading')}
                {/* WHAT WAS READ, WHAT WAS UNREADABLE, WHAT WAS DROPPED — every
                 *  field, including the zeros. A number that hides its own
                 *  losses is the failure this app keeps hitting. Shown as soon
                 *  as PARSING lands, before the distillation finishes. */}
                {!importJob.errorKey && importJob.counts && (
                  <span className="mt-1 block text-ink-muted">
                    <span className="block">
                      {t('persona.import.parsed', {
                        conversations: importJob.counts.conversations,
                      })}
                    </span>
                    <span className="block">{t('persona.import.ownerOnly')}</span>
                    <span className="block">
                      {t('persona.import.dropped', { count: importJob.counts.droppedNonOwner })}
                    </span>
                    <span className="block">
                      {t('persona.import.unreadableRows', { count: importJob.counts.unreadable })}
                    </span>
                    <span className="block">
                      {t('persona.import.considered', { count: importJob.counts.considered })}
                    </span>
                    <span className="block">
                      {t('persona.import.notConsidered', {
                        count: importJob.counts.notConsidered,
                      })}
                    </span>
                  </span>
                )}
                {importJob.result && (
                  <span className="mt-1 block text-ink-muted">
                    <span className="block">
                      {t('persona.import.duplicates', {
                        count: importJob.result.duplicatesSkipped,
                      })}
                    </span>
                    <span className="block">
                      {t('persona.import.keptUnreadable', {
                        count: importJob.result.keptUnreadable,
                      })}
                    </span>
                  </span>
                )}
              </Bubble>
              {importJob.result && (
                <p className="self-end text-micro leading-relaxed text-ink-onDeep/55">
                  {t('persona.import.keptCount', { count: importJob.result.kept.length })}
                </p>
              )}
              {importJob.result?.kept.map((kept) => (
                <KeptChip key={kept.judgment.id} kept={kept} onCorrect={onCorrect} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── the input. Quiet until focused; ochre and dashed while a file is
       *  over it, because dropping an export here is the same act as talking. */}
      <div
        className={`flex items-center gap-2.5 rounded-[3px] border px-3.5 py-2.5 transition-colors ${
          dragging ? 'border-dashed border-ochre bg-ochre/10' : 'border-line bg-bg-card'
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
          className="min-w-0 flex-1 bg-transparent text-ui text-ink placeholder:text-ink-faint focus:outline-none"
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

      {/* One line, and it changes once there is something to correct: at that
       *  moment the useful sentence is what to do about a line that is wrong. */}
      <p className="mt-2 text-center text-micro leading-relaxed text-ink-onDeep/40">
        {t(anythingKept ? 'persona.chat.hintCorrect' : 'persona.chat.hint')}
      </p>

      <PersonaPrivacyNote />
    </div>
  )
}
