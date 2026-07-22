// PersonaModule — the owner-only "persona" experiment surface.
//
// PURPOSE: this is where the owner GROWS THEIR STAND-IN. The you-corpus
// (src/lib/server/youCorpus.ts) is already what the overseer reads before it
// judges anything on the owner's behalf — until now it was only writable from a
// CLI and only readable as one long markdown file. This tab makes the same
// corpus legible (each hand-written note as its own card, with its date and the
// note a correction carries) and correctable IN PLACE.
//
// CORRECTION = APPEND. There is no edit and no delete: correcting an earlier
// note writes a NEW note that carries the old one in its `context`. History is
// never destroyed, and the overseer — which reads newest-first — sees the
// correction before the thing it corrects. (Direct editing of the corpus is
// deliberately out of scope; the assembled file is regenerated from source on
// every write and hand-edits there would be lost.)
//
// SECURITY: mounted ONLY from ProjectPanel's render branch
// `view === 'persona' && experiments?.persona` — itself behind the
// server-resolved owner+toggle gate (gateFromFlags / computeExperiments). A
// non-owner or a flag-off user never mounts it, so the reads below are reached
// ONLY when the gate is open. The routes are independently loopback-gated
// (server/routes/youCorpus.ts) — this component is not the only thing standing
// between a remote page and the corpus.
//
// NOT PER-PROJECT: the corpus describes the OWNER, not a repo, so this surface
// takes no project prop and shows the same content on every project's tab. It
// lives in the per-project tab row because that is where the tab machinery is,
// not because the data is scoped there.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import { PersonaGraphView } from './PersonaGraphView'
import type {
  ManualJudgment,
  PersonaInterviewResponse,
  PersonaQuestion,
  YouCorpusAppendResponse,
  YouCorpusJudgmentsResponse,
  YouCorpusStatus,
} from '@/lib/types'

// How much of a corrected note to quote inside the correction's `context`. The
// original stays in the corpus verbatim under its own entry, so the quote is a
// POINTER, not a copy — capping it keeps a long-running correction chain from
// growing the corpus quadratically.
const QUOTE_MAX = 280

export const quoteForCorrection = (text: string): string =>
  text.length <= QUOTE_MAX ? text : `${text.slice(0, QUOTE_MAX)}…`

/** Split the tags input on commas (either width — a JA keyboard produces "、"
 *  and "，" without the user noticing) and drop the empties. */
export const parseTags = (raw: string): string[] =>
  raw
    .split(/[,、，]/)
    .map((s) => s.trim())
    .filter(Boolean)

const formatWhen = (iso: string | null, lang: string): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// One label → value row in the meta card. Every fact in that card is one of
// these, so they read as a single scannable column rather than a mix of shapes.
const MetaRow = ({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'present' | 'absent'
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-ink-muted">{label}</span>
    <span
      className={
        tone === 'present' ? 'text-moss' : tone === 'absent' ? 'text-ink-faint' : 'text-ink'
      }
    >
      {value}
    </span>
  </div>
)

// A "is this in there?" row. Present/absent reads as words, not a checkmark the
// owner has to decode.
const SourceRow = ({ label, present }: { label: string; present: boolean }) => {
  const { t } = useT()
  return (
    <MetaRow
      label={label}
      value={t(present ? 'persona.meta.present' : 'persona.meta.absent')}
      tone={present ? 'present' : 'absent'}
    />
  )
}

export const PersonaModule = () => {
  const { t, lang } = useT()
  const [status, setStatus] = useState<YouCorpusStatus | null>(null)
  const [judgments, setJudgments] = useState<ManualJudgment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // Draft state. Only the inputs themselves ever write these, so a value is
  // never rewritten out from under an in-progress IME composition.
  const [draft, setDraft] = useState('')
  const [tagsDraft, setTagsDraft] = useState('')
  const [correcting, setCorrecting] = useState<ManualJudgment | null>(null)
  // List is the default and the one every existing surface/test expects on
  // mount. The graph ("synapse map") is an alternate lens over the SAME
  // judgments — a toggle, not a separate tab, because it is read-only and has
  // no state of its own worth preserving across a switch.
  const [notesView, setNotesView] = useState<'list' | 'graph'>('list')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  // Set when a write reported that the sources could not be read and the
  // previous corpus was kept (YouCorpusMeta.skipped) — worth saying out loud:
  // the note landed, but the file the overseer reads was not rebuilt.
  const [staleWarning, setStaleWarning] = useState(false)

  // Today's question (the interview loop). Kept in its OWN state with its own
  // loader: a question is an extra on this page, and folding it into `load`'s
  // Promise.all would let a question-endpoint failure blank the whole tab.
  const [question, setQuestion] = useState<PersonaQuestion | null>(null)
  // "Loaded" is tracked separately from "is null" for the same reason
  // `showNotes` exists: "no question today" is a CLAIM, and it must not be made
  // on top of a read that simply failed.
  const [questionLoaded, setQuestionLoaded] = useState(false)
  // Whether THIS ANSWER reached the file the stand-in reads. Deliberately not
  // the shared `staleWarning` above: that one is also raised by the note form,
  // so reusing it would make a stale NOTE rewrite the wording of a later answer
  // that landed perfectly — the confirmation line would deny a save that
  // actually succeeded.
  const [answerStale, setAnswerStale] = useState(false)
  const [answerDraft, setAnswerDraft] = useState('')
  const [resolving, setResolving] = useState(false)
  // Which action failed, not just "something did" — the answer path's message
  // reassures the owner their words are still on screen, which is nonsense on
  // the skip path where there are none.
  const [resolveError, setResolveError] = useState<'answer' | 'skip' | null>(null)

  const textRef = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const [statusRes, judgmentsRes] = await Promise.all([
        fetch('/api/you-corpus', { cache: 'no-store' }),
        fetch('/api/you-corpus/judgments', { cache: 'no-store' }),
      ])
      if (!statusRes.ok || !judgmentsRes.ok) throw new Error('load failed')
      const statusBody = (await statusRes.json()) as YouCorpusStatus
      const judgmentsBody = (await judgmentsRes.json()) as YouCorpusJudgmentsResponse
      if (!alive.current) return
      setStatus(statusBody)
      setJudgments(judgmentsBody.judgments ?? [])
    } catch {
      if (alive.current) setLoadError(true)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  // POST, not GET: this is the call that GENERATES the day's question on its
  // first use, and a read must never mutate. It is idempotent per local day —
  // mounting the tab ten times still asks once.
  const loadQuestion = useCallback(async () => {
    try {
      const res = await fetch('/api/you-corpus/interview', { method: 'POST' })
      if (!res.ok) throw new Error('interview load failed')
      const body = (await res.json()) as PersonaInterviewResponse
      if (!alive.current) return
      setQuestion(body.question ?? null)
      setQuestionLoaded(true)
    } catch {
      // Deliberately silent: the section stays hidden rather than announcing
      // "no question today" over a failed read. Nothing else on the tab depends
      // on it, so there is nothing to retry into.
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    void loadQuestion()
    return () => {
      alive.current = false
    }
  }, [load, loadQuestion])

  const startCorrection = (j: ManualJudgment) => {
    setCorrecting(j)
    // KEEP whatever is already typed. Clearing it would silently throw away an
    // in-progress note the moment the owner clicks "correct this" on something
    // further down the page — and a React value reset is not undoable, so the
    // text would be gone for good. Losing typed words is the one thing this
    // surface must never do (the failed-write path guards the same way); an
    // unrelated draft carried into a correction is visible and fixable, an
    // erased one is not. Only seed the tags when the owner has none of their
    // own in flight.
    setTagsDraft((prev) => (prev.trim() ? prev : j.tags?.join(', ') ?? ''))
    setSubmitError(false)
    // Put the cursor where the owner is about to type — the form is above the
    // note they just clicked, so without this the click looks like it did
    // nothing.
    requestAnimationFrame(() => textRef.current?.focus())
  }

  // Leaves the draft alone for the same reason as startCorrection: cancelling
  // the correction should drop the correction, not the owner's words.
  const cancelCorrection = () => setCorrecting(null)

  const submit = async () => {
    const text = draft.trim()
    if (!text || submitting) return
    setSubmitting(true)
    setSubmitError(false)
    setStaleWarning(false)
    try {
      const tags = parseTags(tagsDraft)
      const res = await fetch('/api/you-corpus/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(tags.length ? { tags } : {}),
          ...(correcting
            ? {
                // Two pointers at the note being corrected, deliberately: the
                // quote is what the owner and the stand-in READ (an id tells
                // neither of them anything), the id is what stays exact when
                // the quote is truncated or two notes read alike.
                context: `${t('persona.correct.contextPrefix')} ${quoteForCorrection(correcting.text)}`,
                correctsId: correcting.id,
              }
            : {}),
        }),
      })
      if (!res.ok) throw new Error('append failed')
      const body = (await res.json()) as YouCorpusAppendResponse
      if (!alive.current) return
      setDraft('')
      setTagsDraft('')
      setCorrecting(null)
      if (body.meta?.skipped) setStaleWarning(true)
      await load()
    } catch {
      if (alive.current) setSubmitError(true)
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }

  const submitAnswer = async () => {
    const text = answerDraft.trim()
    if (!text || resolving || !question) return
    setResolving(true)
    setResolveError(null)
    try {
      const res = await fetch('/api/you-corpus/interview/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: question.id, answer: text }),
      })
      if (!res.ok) throw new Error('answer failed')
      const body = (await res.json()) as PersonaInterviewResponse
      if (!alive.current) return
      setQuestion(body.question ?? null)
      setAnswerDraft('')
      // The answer was stored but the file the stand-in reads was not rebuilt.
      // Saying "your stand-in has this now" here would be false, so this both
      // raises the same honest warning the note form shows on the identical
      // failure AND swaps the confirmation line for one that does not claim the
      // stand-in received anything. Set from the response EVERY time, not only
      // on failure: a retry that succeeds must clear the earlier denial.
      setAnswerStale(body.corpusStale === true)
      if (body.corpusStale) setStaleWarning(true)
      // The answer just became a note — refresh the list and the counts so the
      // owner sees where it landed instead of having to take it on faith.
      await load()
    } catch {
      // KEEP the draft, same rule as the note form: a failed write must never
      // cost the owner the words they just typed.
      if (alive.current) setResolveError('answer')
    } finally {
      if (alive.current) setResolving(false)
    }
  }

  const skipQuestion = async () => {
    if (!question || resolving) return
    setResolving(true)
    setResolveError(null)
    try {
      const res = await fetch('/api/you-corpus/interview/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: question.id }),
      })
      if (!res.ok) throw new Error('skip failed')
      const body = (await res.json()) as PersonaInterviewResponse
      if (!alive.current) return
      setQuestion(body.question ?? null)
    } catch {
      if (alive.current) setResolveError('skip')
    } finally {
      if (alive.current) setResolving(false)
    }
  }

  const updatedAt = formatWhen(status?.assembledAt ?? null, lang)

  // English inflects ("1 note" / "2 notes"), Japanese does not. The i18n layer
  // is plain `{var}` interpolation by design, so the message file carries both
  // forms and the count picks one — the whole of the pluralisation this surface
  // needs, without a plural engine behind it.
  const countLabel = (key: string, n: number) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { count: n })

  // "Nothing here yet" is a CLAIM about the corpus, so only make it when the
  // read actually succeeded. Notes carried over from an earlier successful load
  // still show (they are real; the banner says the refresh failed) — it is the
  // empty case that must never be reported on top of a failed read.
  const showNotes = !loadError || judgments.length > 0

  if (loading) {
    return (
      <div className="flex-1 px-8 py-6 text-[12px] text-ink-subtle">
        {t('persona.loading')}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-8 py-7">
        {/* Why this tab exists. The owner should be able to read this once and
         *  understand that what they write here is what their stand-in acts on. */}
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-ink">
            <Fingerprint size={14} strokeWidth={2} />
            <h2 className="font-display text-[17px] tracking-tightest">
              {t('persona.intro.title')}
            </h2>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {t('persona.intro.body')}
          </p>
          <p className="text-[12.5px] leading-relaxed text-ink-subtle">
            {t('persona.intro.correctionNote')}
          </p>
        </header>

        {loadError && (
          <div className="flex items-center gap-3 rounded-[3px] border border-line bg-bg-card px-4 py-3 text-[12px] text-ink-muted">
            <span>{t('persona.loadFailed')}</span>
            <Btn variant="ghost" size="xs" onClick={() => void load()}>
              {t('persona.retry')}
            </Btn>
          </div>
        )}

        {/* Today's question. Sits above everything the owner merely READS,
         *  because it is the one thing on this page asking them to act — and it
         *  is the half of the loop that grows the stand-in without them having
         *  to think of what to write. Hidden entirely until the read succeeds
         *  (see `questionLoaded`). */}
        {questionLoaded && (
          <section className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-4 py-3.5 shadow-card">
            <h3 className="label-cap text-ink-faint">{t('persona.interview.heading')}</h3>
            {question ? (
              <>
                <p className="text-[13px] leading-relaxed text-ink">
                  {lang === 'ja' ? question.textJa : question.textEn}
                </p>
                <p className="text-[11.5px] leading-relaxed text-ink-subtle">
                  {t('persona.interview.intro')}
                </p>
                {question.status === 'open' ? (
                  <>
                    <textarea
                      value={answerDraft}
                      onChange={(e) => setAnswerDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter, never a bare Enter — the modifier is
                        // what keeps it clear of the Enter that CONFIRMS a
                        // Japanese conversion (same rule as the note form).
                        if (
                          e.key === 'Enter' &&
                          (e.metaKey || e.ctrlKey) &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault()
                          void submitAnswer()
                        }
                      }}
                      rows={3}
                      placeholder={t('persona.interview.placeholder')}
                      className="w-full resize-y rounded-[2px] border border-line bg-bg px-3 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Btn
                        variant="subtle"
                        size="sm"
                        onClick={() => void skipQuestion()}
                        disabled={resolving}
                      >
                        {t('persona.interview.skip')}
                      </Btn>
                      <Btn
                        variant="primary"
                        size="sm"
                        onClick={() => void submitAnswer()}
                        disabled={resolving || !answerDraft.trim()}
                      >
                        {resolving
                          ? t('persona.interview.answering')
                          : t('persona.interview.answer')}
                      </Btn>
                    </div>
                    {resolveError && (
                      <p className="text-[11.5px] text-accent">
                        {t(
                          resolveError === 'skip'
                            ? 'persona.interview.skipFailed'
                            : 'persona.interview.failed',
                        )}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="border-t border-line-soft pt-2 text-[11.5px] leading-relaxed text-ink-muted">
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
              </>
            ) : (
              // A barren day is stated plainly, and says WHY — otherwise the
              // absence reads as the feature being broken.
              <div className="flex flex-col gap-1.5">
                <p className="text-[12.5px] text-ink">{t('persona.interview.none.title')}</p>
                <p className="text-[12px] leading-relaxed text-ink-muted">
                  {t('persona.interview.none.body')}
                </p>
              </div>
            )}
          </section>
        )}

        {/* What the stand-in is reading right now. */}
        {status && (
          <section className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-4 py-3.5 shadow-card">
            <h3 className="label-cap text-ink-faint">{t('persona.meta.heading')}</h3>
            <div className="flex flex-col gap-1.5 text-[12px]">
              <MetaRow
                label={t('persona.meta.updated')}
                value={updatedAt ?? t('persona.meta.never')}
              />
              <MetaRow
                label={t('persona.meta.memory')}
                value={countLabel('persona.meta.count', status.memoryCount)}
              />
              <MetaRow
                label={t('persona.meta.manual')}
                value={countLabel('persona.meta.count', status.manualCount)}
              />
              <SourceRow label={t('persona.meta.concept')} present={status.conceptExists} />
              <SourceRow
                label={t('persona.meta.vision')}
                present={status.businessVisionExists}
              />
            </div>
            {staleWarning && (
              <p className="border-t border-line-soft pt-2 text-[11.5px] leading-relaxed text-ochre-deep">
                {t('persona.meta.stale')}
              </p>
            )}
          </section>
        )}

        {/* Add / correct. One textarea + optional tags — the minimum that still
         *  captures a judgment. */}
        <section className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-4 py-3.5 shadow-card">
          <h3 className="label-cap text-ink-faint">
            {t(correcting ? 'persona.correct.heading' : 'persona.add.heading')}
          </h3>
          {correcting && (
            <blockquote className="border-l-2 border-accent-soft pl-3 text-[12px] leading-relaxed text-ink-subtle">
              {correcting.text}
            </blockquote>
          )}
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits. The modifier is what makes this
              // IME-safe: the Enter that CONFIRMS a Japanese conversion never
              // carries one, so it is never stolen from the composition.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={4}
            placeholder={t(
              correcting ? 'persona.correct.placeholder' : 'persona.add.placeholder',
            )}
            className="w-full resize-y rounded-[2px] border border-line bg-bg px-3 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex flex-1 items-center gap-2 text-[11px] text-ink-muted">
              <span className="whitespace-nowrap">{t('persona.add.tagsLabel')}</span>
              <input
                value={tagsDraft}
                onChange={(e) => setTagsDraft(e.target.value)}
                placeholder={t('persona.add.tagsPlaceholder')}
                className="min-w-0 flex-1 rounded-[2px] border border-line bg-bg px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              />
            </label>
            {correcting && (
              <Btn variant="subtle" size="sm" onClick={cancelCorrection} disabled={submitting}>
                {t('persona.correct.cancel')}
              </Btn>
            )}
            <Btn
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              disabled={submitting || !draft.trim()}
            >
              {submitting
                ? t('persona.add.submitting')
                : t(correcting ? 'persona.correct.submit' : 'persona.add.submit')}
            </Btn>
          </div>
          {submitError && (
            <p className="text-[11.5px] text-accent">{t('persona.add.failed')}</p>
          )}
        </section>

        {/* The notes themselves, newest first (the order the stand-in reads).
         *  Gone entirely when the read failed and nothing survives from an
         *  earlier one — see `showNotes`: the banner above is the whole story,
         *  and an invitation to write your first note has no business appearing
         *  over a corpus we merely failed to open. */}
        {showNotes && (
          <section className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="label-cap text-ink-faint">{t('persona.notes.heading')}</h3>
              <div className="flex items-center gap-2">
                {judgments.length > 0 && (
                  <span className="text-[11px] text-ink-faint">
                    {countLabel('persona.notes.count', judgments.length)}
                  </span>
                )}
                <div className="flex items-center gap-1">
                  <Btn
                    variant={notesView === 'list' ? 'primary' : 'ghost'}
                    size="xs"
                    flat
                    aria-pressed={notesView === 'list'}
                    onClick={() => setNotesView('list')}
                  >
                    {t('persona.notes.viewList')}
                  </Btn>
                  <Btn
                    variant={notesView === 'graph' ? 'primary' : 'ghost'}
                    size="xs"
                    flat
                    aria-pressed={notesView === 'graph'}
                    onClick={() => setNotesView('graph')}
                  >
                    {t('persona.notes.viewGraph')}
                  </Btn>
                </div>
              </div>
            </div>

            {notesView === 'graph' ? (
              <PersonaGraphView judgments={judgments} />
            ) : judgments.length === 0 ? (
              <div className="flex flex-col gap-1.5 rounded-[3px] border border-dashed border-line px-4 py-5">
                <p className="text-[12.5px] text-ink">{t('persona.notes.empty.title')}</p>
                <p className="text-[12px] leading-relaxed text-ink-muted">
                  {t('persona.notes.empty.body')}
                </p>
              </div>
            ) : (
              judgments.map((j) => (
                <article
                  key={j.id}
                  className="flex flex-col gap-2 rounded-[3px] border border-line bg-bg-card px-4 py-3 shadow-card"
                >
                  <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">
                    {j.text}
                  </p>
                  {j.context && (
                    <div className="flex flex-col gap-1 border-l-2 border-line-strong pl-3">
                      <span className="label-cap text-ink-faint">
                        {/* The same slot holds two different things: on a
                         *  correction it is the note being superseded, otherwise
                         *  it is where the note came from. `correctsId` is what
                         *  tells them apart — labelling a superseded note "where
                         *  this came from" reads as if the owner had cited it.
                         *  Corrections written before that field existed fall
                         *  back to the generic label. */}
                        {t(j.correctsId ? 'persona.notes.corrects' : 'persona.notes.basis')}
                      </span>
                      <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-subtle">
                        {j.context}
                      </p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
                      <time dateTime={j.addedAt}>{formatWhen(j.addedAt, lang) ?? j.addedAt}</time>
                      {j.tags?.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-[2px] border border-line-soft bg-bg-inset px-1.5 py-0.5 text-ink-muted"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <Btn
                      variant="subtle"
                      size="xs"
                      onClick={() => startCorrection(j)}
                      disabled={submitting}
                    >
                      {t('persona.correct.start')}
                    </Btn>
                  </div>
                </article>
              ))
            )}
          </section>
        )}
      </div>
    </div>
  )
}
