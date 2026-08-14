// PersonaModule — the owner-only "persona" surface, as a SCREEN rather than a
// form: the stand-in is drawn as a figure made of particles, and every lit point
// is one thing it knows (see PersonaFigure).
//
// PURPOSE, unchanged from the first version of this tab: this is where the owner
// GROWS THEIR STAND-IN. The you-corpus (src/lib/server/youCorpus.ts) is what the
// overseer reads before it judges anything on the owner's behalf. What changed
// is legibility — a scrolling list of notes never showed how much of a person is
// actually in there, and a body with dark patches does.
//
// THREE WAYS IN, ONE CORPUS:
//   • the always-on question (bottom right) — the existing interview loop
//     (POST /api/you-corpus/interview + /answer + /skip). One a day, drawn from
//     the owner's own week. Answering mints exactly one node.
//   • the courses (bottom left) — GET /api/persona/courses, submitted whole to
//     POST /api/persona/courses/:id/submit. The SERVER scores; this screen sends
//     the answer vector and renders what comes back.
//   • correcting a note — click any lit point, then 直す.
//
// TWO READINGS SIT ON TOP OF THAT CORPUS, and neither one writes:
//   • the PORTRAIT (top left, GET /api/persona/portrait) — the few composed
//     lines that answer 「で、私はどういう人?」 without reading every node. It is
//     composed from scored results server-side (src/lib/persona/portrait.ts),
//     never generated, so an empty `lines` is shown as an INVITATION rather than
//     padded with a sentence that would be true of anyone.
//   • a course's PAST RESULT (rail 済 entry → GET /api/persona/courses/:id/
//     history) — re-opened in the very same PersonaResultSheet, read-only, with
//     a date strip when the instrument has been taken more than once.
//
// CORRECTION = APPEND. There is no edit and no delete: correcting an earlier
// note writes a NEW note that carries the old one in its `context` (and its id
// in `correctsId`). History is never destroyed, and the overseer — which reads
// newest-first — sees the correction before the thing it corrects.
//
// NOT PER-PROJECT — AND THAT IS ITS ADDRESS. The corpus describes the OWNER,
// not a repo (it lives in ~/.openground/), so this surface takes no project
// prop and used to render the same screen on every project's tab. Since
// 2026-08-14 it is mounted from GROUND instead — the toolbar entry beside
// Settings / Manual / Skills — by src/components/canvas/PersonaPanel.tsx. The
// component itself is unchanged by that move: it is still a full-bleed screen
// that fills whatever surface it is given. (It stays in modules/ next to its
// PersonaFigure / PersonaResultSheet siblings; the directory is where it was
// born, not a claim that it is still a tab.)
//
// SECURITY: mounted ONLY behind the persona gate (src/lib/persona/gate.ts —
// persona OR swarm, owner-ANDed server-side), which App re-checks before
// mounting the panel. A non-owner or a gate-closed user never mounts it, so the
// reads below are reached ONLY when the gate is open. The routes are
// independently loopback-gated (server/routes/youCorpus.ts) — this component is
// not the only thing standing between a remote page and the corpus.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import {
  PersonaFigure,
  PERSONA_ZONES,
  buildPersonaNodes,
  zoneForJudgment,
  zoneForQuestion,
  type PersonaNode,
  type PersonaSpark,
  type PersonaZone,
} from './PersonaFigure'
import { PersonaResultSheet } from './PersonaResultSheet'
import { courseById, itemAt, type PersonaCourse } from '@/lib/persona/instruments'
import { portraitAgeLabel } from '@/lib/persona/portrait'
import type {
  ManualJudgment,
  PersonaCourseHistoryResponse,
  PersonaCourseId,
  PersonaCourseRecord,
  PersonaCoursesResponse,
  PersonaInterviewResponse,
  PersonaPortrait,
  PersonaQuestion,
  SubmitPersonaCourseResponse,
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

const formatDay = (iso: string | null, lang: string): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'short', day: 'numeric' })
}

/** The courses API carries `zone` as a plain string (it crosses the wire). Only
 *  the five known regions may reach the figure — an unknown one would silently
 *  seat a course's findings nowhere. */
export const asZone = (zone: string): PersonaZone =>
  (PERSONA_ZONES as readonly string[]).includes(zone) ? (zone as PersonaZone) : 'mind'

/** What a course is doing right now, seen from the rail. Exported for the test:
 *  three states that must never be confused (never taken / in flight / done),
 *  and "done" is the only one allowed to show a date. */
export type CourseRailState = 'new' | 'running' | 'done'

export const courseRailState = (
  course: { id: string; lastTakenAt: string | null },
  runningId: string | null,
): CourseRailState =>
  runningId === course.id ? 'running' : course.lastTakenAt ? 'done' : 'new'

interface CourseRun {
  course: PersonaCourse
  answers: number[]
}

/** What the result sheet is showing. ONE shape for both ways in, because they
 *  are the same sheet: a course that just finished is a list of exactly one
 *  take (so the date strip is absent by construction), and a 済 entry re-opened
 *  from the rail is the stored list, newest first, starting at index 0 — the
 *  LAST result, which is what 「結果を見る」 promises.
 *
 *  `minted` is the one thing the two do not share: only the take that was just
 *  submitted knows how much of it reached the corpus. `null` = re-read. */
interface SheetState {
  courseId: PersonaCourseId
  /** The instrument's subtitle, from the courses API. */
  sub: string
  /** NEWEST FIRST. */
  takes: PersonaCourseRecord[]
  index: number
  minted: number | null
}

/** A control that sits directly on the dark stage rather than on a card, so it
 *  wears `text-ink-onDeep` — the one ink made for a surface that does not invert
 *  with the theme. The shared <Btn> variants take their ink from the theme,
 *  which is right on every card and wrong here (see the bg-deep guard in
 *  src/labelPlates.test.ts). Everything inside a card still uses <Btn>. */
const StageButton = ({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) => (
  <button
    type="button"
    onClick={onClick}
    className="rounded-[2px] border border-line px-2 py-0.5 text-meta text-ink-onDeep/70 transition-colors hover:border-accent hover:text-ink-onDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
  >
    {children}
  </button>
)

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
  const [composing, setComposing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  // Set when a write reported that the sources could not be read and the
  // previous corpus was kept (YouCorpusMeta.skipped) — worth saying out loud:
  // the note landed, but the file the overseer reads was not rebuilt.
  const [staleWarning, setStaleWarning] = useState(false)

  // Today's question (the interview loop). Kept in its OWN state with its own
  // loader: a question is one part of this screen, and folding it into `load`'s
  // Promise.all would let a question-endpoint failure blank the whole tab.
  const [question, setQuestion] = useState<PersonaQuestion | null>(null)
  // "Loaded" is tracked separately from "is null" because "no question today"
  // is a CLAIM, and it must not be made on top of a read that simply failed.
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

  // The courses (self-report instruments). Catalogue + last result come from the
  // server; the ITEMS come from src/lib/persona/instruments.ts, which is where
  // the scoring lives too.
  const [courses, setCourses] = useState<PersonaCoursesResponse['courses']>([])
  const [coursesError, setCoursesError] = useState(false)
  const [run, setRun] = useState<CourseRun | null>(null)
  const [courseSending, setCourseSending] = useState(false)
  const [courseError, setCourseError] = useState(false)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  // Which 済 entry is fetching its history right now, and whether that fetch
  // failed. Both are about ONE row, so they are keyed by course id / shown
  // beside the rail rather than blanking the screen.
  const [openingCourse, setOpeningCourse] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState(false)

  // The portrait (top left). `null` means "not read", NOT "nothing to say" —
  // the difference matters, because the empty portrait is an invitation and a
  // failed read is in no position to invite anyone anywhere.
  const [portrait, setPortrait] = useState<PersonaPortrait | null>(null)

  const [selected, setSelected] = useState<PersonaNode | null>(null)
  const [spark, setSpark] = useState<PersonaSpark | null>(null)
  const [askPulse, setAskPulse] = useState(false)

  const sparkSeq = useRef(0)
  // Which history read is the CURRENT one. Two 済 rows clicked in quick
  // succession are two reads in flight, and the slower one must not drop its
  // course's result on top of the one the owner actually asked for last.
  const historySeq = useRef(0)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)

  /** Fly `count` sparks into a zone. `seq` is what fires it, so answering twice
   *  in the same zone sparks twice. */
  const fireSpark = useCallback((zone: PersonaZone, count: number, kind: 'raw' | 'node') => {
    if (count <= 0) return
    sparkSeq.current += 1
    setSpark({ seq: sparkSeq.current, zone, count, kind })
  }, [])

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
      // Deliberately silent about the CONTENT: the card says nothing about
      // today's question rather than announcing "no question today" over a read
      // that failed.
    }
  }, [])

  const loadCourses = useCallback(async () => {
    setCoursesError(false)
    try {
      const res = await fetch('/api/persona/courses', { cache: 'no-store' })
      if (!res.ok) throw new Error('courses load failed')
      const body = (await res.json()) as PersonaCoursesResponse
      if (!alive.current) return
      setCourses(body.courses ?? [])
    } catch {
      if (alive.current) setCoursesError(true)
    }
  }, [])

  // Its own loader, like the question and the courses: the portrait is one part
  // of this screen, and a portrait endpoint that is not there yet (or fails)
  // must cost the owner nothing else on it.
  const loadPortrait = useCallback(async () => {
    try {
      const res = await fetch('/api/persona/portrait', { cache: 'no-store' })
      if (!res.ok) throw new Error('portrait load failed')
      const body = (await res.json()) as Partial<PersonaPortrait> | null
      if (!alive.current) return
      // SHAPE-CHECK BEFORE STORING. The render path treats `portrait` as read
      // and reaches straight into `lines`, so a body without it is not a
      // portrait — an older server, an error page, a proxy's JSON. Storing it
      // anyway crashed the whole panel (measured 2026-08-14 via App.render's
      // gate test, whose fetch mock answers a bare object). "Not a portrait"
      // and "never read" are the same state, and this is where they merge.
      if (!body || !Array.isArray(body.lines)) throw new Error('portrait shape')
      setPortrait(body as PersonaPortrait)
    } catch {
      // Deliberately silent AND deliberately non-destructive: whatever was read
      // last stays on screen. Blanking it on a refresh failure would delete a
      // true reading because a later request timed out.
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    void loadQuestion()
    void loadCourses()
    void loadPortrait()
    return () => {
      alive.current = false
    }
  }, [load, loadQuestion, loadCourses, loadPortrait])

  const nodes = useMemo(() => buildPersonaNodes(judgments), [judgments])
  const zoneLabel = useCallback((zone: PersonaZone) => t(`persona.zone.${zone}`), [t])
  const provenance = useCallback(
    (node: PersonaNode) =>
      [zoneLabel(node.zone), formatWhen(node.addedAt, lang) ?? node.addedAt].join(' ・ '),
    [zoneLabel, lang],
  )

  // The patch that pulses: the region the current question is digging in, or —
  // while a course runs — the region that course grows.
  const gapZone: PersonaZone | null = run ? run.course.zone : zoneForQuestion(question)

  const pulseAsk = useCallback(() => {
    setAskPulse(true)
    window.setTimeout(() => {
      if (alive.current) setAskPulse(false)
    }, 1100)
  }, [])

  const openComposer = (target: ManualJudgment | null) => {
    setCorrecting(target)
    setComposing(true)
    setSubmitError(false)
    // KEEP whatever is already typed. Clearing it would silently throw away an
    // in-progress note the moment the owner clicks 直す on something — and a
    // React value reset is not undoable, so the text would be gone for good.
    // Losing typed words is the one thing this surface must never do. Only seed
    // the tags when the owner has none of their own in flight.
    if (target) setTagsDraft((prev) => (prev.trim() ? prev : target.tags?.join(', ') ?? ''))
    requestAnimationFrame(() => textRef.current?.focus())
  }

  // Leaves the draft alone for the same reason as openComposer: closing the
  // composer should drop the correction, not the owner's words.
  const closeComposer = () => {
    setComposing(false)
    setCorrecting(null)
  }

  const startCorrection = (node: PersonaNode) => {
    const j = judgments.find((x) => x.id === node.id)
    if (!j) return
    setSelected(null)
    openComposer(j)
  }

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
      setComposing(false)
      if (body.meta?.skipped) setStaleWarning(true)
      // The spark flies to where the note will actually be seated — the same
      // rule the figure seats it by — so the point that lights up is the note,
      // not a decoration next to it.
      if (body.judgment) fireSpark(zoneForJudgment(body.judgment), 1, 'node')
      // The portrait counts what the stand-in knows, so a new note moves it too.
      await Promise.all([load(), loadPortrait()])
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
      // One answer, one node — landing in the patch that was pulsing while it
      // was asked (personaInterview.ts tags the write-back with the question's
      // kind, which is what zoneForJudgment reads back).
      const asked = zoneForQuestion(question)
      if (asked && !body.corpusStale) fireSpark(asked, 1, 'node')
      // The answer just became a note — refresh so the owner sees where it
      // landed instead of having to take it on faith.
      await Promise.all([load(), loadPortrait()])
    } catch {
      // KEEP the draft: a failed write must never cost the owner the words they
      // just typed.
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

  // ── courses ───────────────────────────────────────────────────────────────

  const sendCourse = useCallback(
    async (course: PersonaCourse, answers: number[]) => {
      setCourseSending(true)
      setCourseError(false)
      try {
        const res = await fetch(`/api/persona/courses/${course.id}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers }),
        })
        if (!res.ok) throw new Error('course submit failed')
        const body = (await res.json()) as SubmitPersonaCourseResponse
        if (!alive.current) return
        setRun(null)
        // A list of ONE: the sheet that opens on finishing is about the take
        // that just happened, so it carries no date strip. The past takes are a
        // deliberate click away (the rail's 済 entry), not a wall the owner has
        // to read past to see the result they just earned.
        setSheet({
          courseId: course.id,
          sub: courses.find((c) => c.id === course.id)?.sub ?? course.sub,
          takes: [body.record],
          index: 0,
          minted: body.minted,
        })
        // CONSOLIDATION: the dim answer dots stop being dots (setRun(null)
        // clears them) and exactly as many nodes as actually reached the corpus
        // fly in to replace them. `minted`, not findings.length — a sheet that
        // shows five findings while the corpus received none must not draw five
        // new points on the body.
        fireSpark(course.zone, body.minted, 'node')
        // The portrait is composed FROM the results, so a finished course is
        // exactly when it changes — re-read it in the same breath.
        await Promise.all([load(), loadCourses(), loadPortrait()])
      } catch {
        // The answers are KEPT (the run is untouched), so the owner can send
        // the same vector again instead of retaking 25 questions.
        if (alive.current) setCourseError(true)
      } finally {
        if (alive.current) setCourseSending(false)
      }
    },
    [courses, load, loadCourses, loadPortrait, fireSpark],
  )

  /** Re-open a finished course's LAST result, read-only, in the same sheet the
   *  course itself ends on. The history is fetched HERE and only on demand —
   *  the rail is on screen from the first paint, and pre-loading four courses'
   *  every take to render four one-line entries would be the wrong trade. */
  const openCourseResult = useCallback(
    async (course: { id: PersonaCourseId; sub: string }) => {
      const seq = ++historySeq.current
      setOpeningCourse(course.id)
      setHistoryError(false)
      try {
        const res = await fetch(`/api/persona/courses/${course.id}/history`, { cache: 'no-store' })
        if (!res.ok) throw new Error('history load failed')
        const body = (await res.json()) as PersonaCourseHistoryResponse
        if (!alive.current || historySeq.current !== seq) return
        const takes = body.takes ?? []
        // The rail said 済, and the store has nothing. Opening an empty sheet
        // would be the version that pretends; say it could not be opened.
        if (takes.length === 0) {
          setHistoryError(true)
          return
        }
        setCourseError(false)
        // index 0 = newest (the API's contract) = the LAST result.
        setSheet({ courseId: course.id, sub: course.sub, takes, index: 0, minted: null })
      } catch {
        if (alive.current && historySeq.current === seq) setHistoryError(true)
      } finally {
        if (alive.current && historySeq.current === seq) setOpeningCourse(null)
      }
    },
    [],
  )

  const startCourse = (id: string) => {
    const course = courseById(id)
    if (!course) return
    setSheet(null)
    setCourseError(false)
    setHistoryError(false)
    setRun({ course, answers: [] })
  }

  const quitCourse = () => {
    setRun(null)
    setCourseError(false)
  }

  const answerItem = (value: number) => {
    if (!run || courseSending) return
    const answers = [...run.answers, value]
    setRun({ ...run, answers })
    // One dim dot per answer: something was said, nothing has been concluded
    // from it yet.
    fireSpark(run.course.zone, 1, 'raw')
    if (answers.length >= run.course.itemCount) void sendCourse(run.course, answers)
  }

  // From the sheet — including a sheet opened over a PAST take. It starts the
  // instrument at item 1 with an empty answer vector; nothing of the take being
  // read is carried forward, because a re-take is a new observation.
  const retakeCourse = () => {
    if (!sheet) return
    const course = courseById(sheet.courseId)
    setSheet(null)
    setHistoryError(false)
    if (course) setRun({ course, answers: [] })
  }

  const updatedAt = formatWhen(status?.assembledAt ?? null, lang)

  // English inflects ("1 note" / "2 notes"), Japanese does not. The i18n layer
  // is plain `{var}` interpolation by design, so the message file carries both
  // forms and the count picks one — the whole of the pluralisation this surface
  // needs, without a plural engine behind it.
  const countLabel = (key: string, n: number) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { count: n })

  // "Nothing is lit yet" is a CLAIM about the corpus, so only make it when the
  // read actually succeeded — an empty figure over a failed read reads as "you
  // have told me nothing", which is the one lie this surface must never tell.
  const showEmptyInvite = !loading && !loadError && nodes.length === 0

  const item = run ? itemAt(run.course, run.answers.length) : null

  // What the sheet is showing, and the strip it can walk. Dates are localized
  // HERE — the sheet formats nothing (see its header comment).
  const shownTake = sheet ? sheet.takes[sheet.index] : null
  const takeStrip = sheet
    ? sheet.takes.map((take) => ({
        id: take.takenAt,
        label: formatDay(take.takenAt, lang) ?? take.takenAt,
        title: formatWhen(take.takenAt, lang) ?? take.takenAt,
      }))
    : []

  // The portrait's counts, in the same plain voice as the rest of the screen.
  // `recentCount` is optional on the wire, so the sentence itself changes rather
  // than printing "0 this week" over a server that simply did not count.
  const portraitCounts = portrait
    ? portrait.recentCount === undefined
      ? t('persona.portrait.counts', {
          nodes: portrait.nodeCount,
          taken: portrait.takenCount,
          total: portrait.courseCount,
        })
      : t('persona.portrait.countsRecent', {
          nodes: portrait.nodeCount,
          recent: portrait.recentCount,
          taken: portrait.takenCount,
          total: portrait.courseCount,
        })
    : null
  // Shown when the portrait was READ and has nothing evidenced to say — except
  // on a first run, where the figure's own invitation is already saying it in
  // the middle of the screen and a second copy in the corner is just noise.
  const showPortraitInvite = !!portrait && portrait.lines.length === 0 && !showEmptyInvite
  // A portrait that was never read renders NOTHING — no lines, no invitation,
  // no counts. Same rule as the figure's empty state above.
  const showPortrait = !!portrait && (portrait.lines.length > 0 || showPortraitInvite)

  if (loading) {
    return (
      <div className="flex-1 px-8 py-6 text-ui text-ink-subtle">{t('persona.loading')}</div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-deep">
      <PersonaFigure
        nodes={nodes}
        gapZone={gapZone}
        pendingZone={run ? run.course.zone : null}
        spark={spark}
        onSelect={setSelected}
        onTapEmpty={() => setSelected(null)}
        onTapGap={pulseAsk}
        zoneLabel={zoneLabel}
        provenance={provenance}
      />

      {/* ── the mark + what the stand-in is actually reading ── */}
      <div className="pointer-events-none absolute left-6 top-5 z-10 flex max-w-[min(360px,60%)] flex-col gap-1.5">
        <div className="pointer-events-auto flex items-center gap-3">
          <span className="label-cap tracking-cartographic text-ink-onDeep/60">
            {t('persona.tabLabel')}
          </span>
          <StageButton onClick={() => openComposer(null)}>{t('persona.add.open')}</StageButton>
        </div>

        {/* ── the portrait: 「で、私はどういう人?」, answered at a glance ──
         *  Quiet on purpose. It sits under the mark because it is the first
         *  thing worth reading and the last thing that should shout: the figure
         *  is the subject of this screen, and a five-line block in a heavy
         *  weight would compete with it. Its width is capped by this column
         *  (max-w-[min(360px,60%)] on the container), and it is hidden below
         *  `sm` — the screen is full-bleed, and on a narrow window these lines
         *  would sit on the figure's head rather than beside it. */}
        {showPortrait && portrait && (
          <section
            aria-label={t('persona.portrait.label')}
            className="hidden flex-col gap-1.5 sm:flex"
          >
            {showPortraitInvite ? (
              // NEVER a composed sentence here: with no evidence there is
              // nothing true to say about who the owner is, so this asks
              // instead of guessing.
              <p className="text-meta leading-relaxed text-ink-onDeep/60">
                {t('persona.portrait.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {portrait.lines.map((line) => (
                  <li key={`${line.courseId}|${line.text}`} className="flex flex-col gap-0.5">
                    <span className="text-ui leading-relaxed text-ink-onDeep/85">{line.text}</span>
                    {/* Provenance, always VISIBLE and always second: which
                     *  instrument said it and how old that is. A hover-only
                     *  version would be unreachable by touch and keyboard, and
                     *  a line whose evidence you cannot see is a horoscope.
                     *  The age wording comes from portraitAgeLabel — one
                     *  vocabulary for staleness, never a second one here.
                     *  `meta`, not `micro`: this line carries 和文 phrases, and
                     *  13px is where the scale says 和文 stops being decoration
                     *  (tailwind.config.ts). It recedes by opacity instead. */}
                    <span className="text-meta leading-relaxed text-ink-onDeep/40">
                      {[line.detail, portraitAgeLabel(line.ageDays)].filter(Boolean).join(' ・ ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {portraitCounts && (
              <p className="text-meta leading-relaxed text-ink-onDeep/45">{portraitCounts}</p>
            )}
          </section>
        )}

        {status && (
          <p className="text-meta leading-relaxed text-ink-onDeep/45">
            {`${t('persona.meta.memory')} ${countLabel('persona.meta.count', status.memoryCount)} ・ ${t('persona.meta.manual')} ${countLabel('persona.meta.count', status.manualCount)}`}
            <span className="block">
              {`${t('persona.meta.updated')} ${updatedAt ?? t('persona.meta.never')}`}
            </span>
          </p>
        )}
        {staleWarning && (
          // On a CARD, not bare on the stage: `ochre` is the warning colour and
          // it inverts with the theme, so on a surface that does not invert it
          // would be a dark-brown line on near-black at noon.
          <p className="rounded-[3px] border border-line bg-bg-card px-2.5 py-1 text-meta leading-relaxed text-ochre-deep">
            {t('persona.meta.stale')}
          </p>
        )}
        {loadError && (
          <div className="pointer-events-auto flex items-center gap-2 text-meta text-ink-onDeep/70">
            <span>{t('persona.loadFailed')}</span>
            <StageButton onClick={() => void load()}>{t('persona.retry')}</StageButton>
          </div>
        )}
      </div>

      {/* First run: the figure is all dust, so say what this place is and what
       *  lights it. Only ever shown over a SUCCESSFUL read (showEmptyInvite). */}
      {showEmptyInvite && !composing && (
        <div className="pointer-events-none absolute inset-x-0 top-[16%] z-10 mx-auto flex max-w-[440px] flex-col gap-2 px-6 text-center">
          <h2 className="font-display text-title tracking-tightest text-ink-onDeep">
            {t('persona.intro.title')}
          </h2>
          <p className="text-ui leading-relaxed text-ink-onDeep/70">{t('persona.intro.body')}</p>
          <p className="text-meta leading-relaxed text-ink-onDeep/50">
            {t('persona.figure.empty')}
          </p>
          <p className="text-meta leading-relaxed text-ink-onDeep/50">
            {t('persona.intro.correctionNote')}
          </p>
        </div>
      )}

      {/* ── the reading/writing column: the note you opened, and the box you
       *  write into. Stacked in ONE container so opening a note while a draft is
       *  in flight neither hides the draft nor lands on top of it. ── */}
      <div className="absolute left-1/2 top-[14%] z-20 flex w-[min(420px,calc(100%-3rem))] -translate-x-1/2 flex-col gap-3">
        {selected && (
          <article className="rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card">
            <p className="whitespace-pre-wrap text-read font-semibold leading-relaxed text-ink">
              {selected.text}
            </p>
            <p className="mt-2 text-meta text-ink-faint">{provenance(selected)}</p>
            {selected.tags.length > 0 && (
              <p className="mt-1.5 flex flex-wrap gap-1.5 text-meta text-ink-muted">
                {selected.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-[2px] border border-line-soft bg-bg-inset px-1.5 py-0.5"
                  >
                    {tag}
                  </span>
                ))}
              </p>
            )}
            {selected.context && (
              <div className="mt-2.5 flex flex-col gap-1 border-l-2 border-line-strong pl-3">
                {/* The same slot holds two different things: on a correction it is
                 *  the note being superseded, otherwise it is where the note came
                 *  from. `correctsId` is what tells them apart — labelling a
                 *  superseded note "where this came from" reads as if the owner
                 *  had cited it approvingly. */}
                <span className="label-cap text-ink-faint">
                  {t(selected.correctsId ? 'persona.notes.corrects' : 'persona.notes.basis')}
                </span>
                <p className="whitespace-pre-wrap text-meta leading-relaxed text-ink-subtle">
                  {selected.context}
                </p>
              </div>
            )}
            <div className="mt-3.5 flex items-center gap-2">
              <Btn variant="ghost" size="xs" onClick={() => startCorrection(selected)}>
                {t('persona.correct.start')}
              </Btn>
              <Btn variant="subtle" size="xs" onClick={() => setSelected(null)}>
                {t('persona.node.close')}
              </Btn>
            </div>
          </article>
        )}

        {/* write into the corpus: a new note, or a correction of one */}
        {composing && (
          <section className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card">
            <h3 className="label-cap text-ink-faint">
              {t(correcting ? 'persona.correct.heading' : 'persona.add.heading')}
            </h3>
            {correcting && (
              <blockquote className="border-l-2 border-accent-soft pl-3 text-ui leading-relaxed text-ink-subtle">
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
              placeholder={t(correcting ? 'persona.correct.placeholder' : 'persona.add.placeholder')}
              className="w-full resize-y rounded-[2px] border border-line bg-bg px-3 py-2 text-ui leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex flex-1 items-center gap-2 text-meta text-ink-muted">
                <span className="whitespace-nowrap">{t('persona.add.tagsLabel')}</span>
                <input
                  value={tagsDraft}
                  onChange={(e) => setTagsDraft(e.target.value)}
                  placeholder={t('persona.add.tagsPlaceholder')}
                  className="min-w-0 flex-1 rounded-[2px] border border-line bg-bg px-2 py-1 text-ui text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                />
              </label>
              <Btn variant="subtle" size="sm" onClick={closeComposer} disabled={submitting}>
                {t('persona.correct.cancel')}
              </Btn>
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
            {submitError && <p className="text-meta text-accent">{t('persona.add.failed')}</p>}
          </section>
        )}
      </div>

      {/* ── the course rail ── */}
      <div className="absolute bottom-6 left-6 z-10 flex flex-col gap-2">
        <p className="label-cap text-ink-onDeep/45">{t('persona.course.railHeading')}</p>
        {coursesError ? (
          <div className="flex items-center gap-2 text-meta text-ink-onDeep/70">
            <span>{t('persona.loadFailed')}</span>
            <StageButton onClick={() => void loadCourses()}>{t('persona.retry')}</StageButton>
          </div>
        ) : (
          <div className="flex max-w-[62%] flex-wrap gap-2 sm:max-w-none sm:flex-col sm:items-start">
            {courses.map((c) => {
              const state = courseRailState(c, run?.course.id ?? null)
              // `moss-text` is a card colour and flips with the theme, so the
              // "already taken" state is carried by the BORDER and by
              // brightness in the line — both readable on a stage that stays
              // dark in either theme.
              const metaLine =
                state === 'running'
                  ? t('persona.course.state.running', {
                      index: (run?.answers.length ?? 0) + 1,
                      total: c.itemCount,
                    })
                  : state === 'done'
                    ? openingCourse === c.id
                      ? t('persona.course.opening')
                      : t('persona.course.state.done', {
                          date: formatDay(c.lastTakenAt, lang) ?? '',
                        })
                    : t('persona.course.state.new', {
                        count: c.itemCount,
                        zone: zoneLabel(asZone(c.zone)),
                      })

              // A FINISHED course carries two different offers, and folding
              // them into one row is what made the result unreachable: the row
              // itself reads it back, and a narrow 「もう一度」 beside it starts
              // a fresh take without going through the sheet first. Two real
              // buttons rather than one button with a menu — the whole rail is
              // four rows, and a person who wants to re-take should not have to
              // read their old result to get there.
              if (state === 'done') {
                return (
                  <div
                    key={c.id}
                    className="flex min-w-[210px] items-stretch overflow-hidden rounded-[3px] border border-moss/40"
                  >
                    <button
                      type="button"
                      onClick={() => void openCourseResult(c)}
                      className="flex-1 px-3 py-2 text-left transition-colors hover:bg-accent/10"
                    >
                      <span className="block text-ui text-ink-onDeep/80">{c.name}</span>
                      <span className="mt-0.5 block text-meta text-ink-onDeep/65">{metaLine}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => startCourse(c.id)}
                      // Named with the course, because four rows of a bare
                      // 「もう一度」 tell a screen reader nothing about which.
                      aria-label={t('persona.course.retakeAria', { name: c.name })}
                      className="whitespace-nowrap border-l border-moss/40 px-2.5 text-meta text-ink-onDeep/60 transition-colors hover:bg-accent/10 hover:text-ink-onDeep"
                    >
                      {t('persona.course.retake')}
                    </button>
                  </div>
                )
              }

              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => (state === 'running' ? quitCourse() : startCourse(c.id))}
                  className={`min-w-[210px] rounded-[3px] border px-3 py-2 text-left transition-colors ${
                    state === 'running'
                      ? 'border-accent bg-accent/10 text-ink-onDeep'
                      : 'border-line text-ink-onDeep/80 hover:border-accent hover:text-ink-onDeep'
                  }`}
                >
                  <span className="block text-ui">{c.name}</span>
                  <span className="mt-0.5 block text-meta text-ink-onDeep/50">{metaLine}</span>
                </button>
              )
            })}
            {historyError && (
              <p className="max-w-[210px] text-meta leading-relaxed text-ink-onDeep/70">
                {t('persona.course.historyFailed')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* The figure is pannable and zoomable, and nothing about a field of dots
       *  says so. One quiet line, only where there is room for it. */}
      <p className="pointer-events-none absolute bottom-7 left-1/2 z-10 hidden -translate-x-1/2 text-meta text-ink-onDeep/35 xl:block">
        {t('persona.figure.hint')}
      </p>

      {/* ── the question. ALWAYS here, never a modal: the screen asks, the owner
       *  answers, and the figure changes. A dialog would make that a detour. ── */}
      <section
        aria-live="polite"
        className={`absolute bottom-6 right-6 z-10 flex w-[min(380px,calc(100%-3rem))] flex-col gap-2.5 rounded-[3px] border bg-bg-card px-5 py-4 shadow-card transition-colors ${
          askPulse ? 'border-accent ring-2 ring-accent/25' : 'border-line'
        }`}
      >
        <p className="flex items-baseline justify-between gap-3">
          <span className="label-cap text-accent">
            {run ? run.course.name : t('persona.interview.heading')}
          </span>
          {run && (
            <span className="text-meta tabular-nums text-ink-faint">
              {`${Math.min(run.answers.length + 1, run.course.itemCount)} / ${run.course.itemCount}`}
            </span>
          )}
        </p>

        {run ? (
          <>
            {item?.lead && <p className="text-meta text-ink-muted">{item.lead}</p>}
            {item && item.stem !== '' && (
              <p className="text-ui font-semibold leading-relaxed text-ink">{item.stem}</p>
            )}
            {item?.choices && (
              <div className="flex flex-wrap gap-1.5">
                {item.choices.map((choice, i) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => answerItem(i)}
                    className="rounded-full border border-line px-3.5 py-1.5 text-meta text-ink-muted transition-colors hover:border-accent hover:text-ink"
                  >
                    {choice}
                  </button>
                ))}
              </div>
            )}
            {item?.scale && (
              <div className="flex items-stretch gap-1.5">
                {item.scale.map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => answerItem(i)}
                    className="flex-1 rounded-[2px] border border-line px-1 py-2 text-meta leading-tight text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {!item && (
              <p className="text-ui leading-relaxed text-ink">
                {courseError ? t('persona.course.failed') : t('persona.course.submitting')}
              </p>
            )}
            {courseError && (
              <Btn
                variant="primary"
                size="sm"
                disabled={courseSending}
                onClick={() => void sendCourse(run.course, run.answers)}
              >
                {t('persona.course.retry')}
              </Btn>
            )}
            <div className="flex items-center gap-2.5">
              <span className="h-0.5 flex-1 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full bg-accent transition-[width] duration-300"
                  style={{ width: `${(run.answers.length / run.course.itemCount) * 100}%` }}
                />
              </span>
              <button
                type="button"
                onClick={quitCourse}
                className="text-meta text-ink-faint transition-colors hover:text-ink"
              >
                {t('persona.ask.quit')}
              </button>
            </div>
          </>
        ) : questionLoaded && question ? (
          <>
            <p className="text-ui font-semibold leading-relaxed text-ink">
              {lang === 'ja' ? question.textJa : question.textEn}
            </p>
            {question.status === 'open' ? (
              <>
                <textarea
                  value={answerDraft}
                  onChange={(e) => setAnswerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl+Enter, never a bare Enter — the modifier is what
                    // keeps it clear of the Enter that CONFIRMS a Japanese
                    // conversion (same rule as the note form).
                    if (
                      e.key === 'Enter' &&
                      (e.metaKey || e.ctrlKey) &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault()
                      void submitAnswer()
                    }
                  }}
                  rows={2}
                  placeholder={t('persona.interview.placeholder')}
                  className="w-full resize-y rounded-[2px] border border-line bg-bg px-3 py-2 text-ui leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-meta text-ink-faint">{t('persona.ask.hint')}</span>
                  <span className="flex items-center gap-2">
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
                  </span>
                </div>
                {resolveError && (
                  <p className="text-meta text-accent">
                    {t(
                      resolveError === 'skip'
                        ? 'persona.interview.skipFailed'
                        : 'persona.interview.failed',
                    )}
                  </p>
                )}
              </>
            ) : (
              <p className="border-t border-line-soft pt-2 text-meta leading-relaxed text-ink-muted">
                {t(
                  question.status !== 'answered'
                    ? 'persona.interview.skipped'
                    : // "Your stand-in has this now" is only true once the file
                      // it reads has actually been rebuilt.
                      answerStale
                      ? 'persona.interview.answeredStale'
                      : 'persona.interview.answered',
                )}
              </p>
            )}
          </>
        ) : questionLoaded ? (
          // A barren day is stated plainly, and says WHY — otherwise the absence
          // reads as the feature being broken.
          <>
            <p className="text-ui text-ink">{t('persona.interview.none.title')}</p>
            <p className="text-meta leading-relaxed text-ink-muted">
              {t('persona.interview.none.body')}
            </p>
            <p className="text-meta leading-relaxed text-ink-faint">{t('persona.ask.idle')}</p>
          </>
        ) : (
          // The question could not be read. NOT "no question today" — that is a
          // claim a failed read is in no position to make.
          <p className="text-meta leading-relaxed text-ink-muted">{t('persona.ask.idle')}</p>
        )}
      </section>

      {sheet && shownTake && (
        <PersonaResultSheet
          result={shownTake.result}
          sub={sheet.sub}
          takenAt={formatWhen(shownTake.takenAt, lang) ?? shownTake.takenAt}
          // Absent on a re-read: only the take that was just submitted knows
          // what reached the corpus (see the prop's doc comment).
          {...(sheet.minted === null ? {} : { minted: sheet.minted })}
          takes={takeStrip}
          currentTake={sheet.index}
          onPickTake={(index) => setSheet({ ...sheet, index })}
          onClose={() => setSheet(null)}
          onRetake={retakeCourse}
        />
      )}
    </div>
  )
}
