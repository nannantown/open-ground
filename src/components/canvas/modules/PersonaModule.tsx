// PersonaModule — the owner-only "persona" surface, as a SCREEN rather than a
// form: the owner is drawn as a figure made of particles, and every lit point is
// one thing this place knows about them (see PersonaFigure).
//
// WHAT IT IS FOR (owner, 2026-08-15, and it is the subject of the whole screen):
// 「自分をデータベース化することで仕事探しやもの探し、自分探しや恋愛相談…全ての
// データをうまく整理して自分を理解する場」 — SELF-UNDERSTANDING. The fact that the
// same corpus can also be spent answering a blocked swarm worker is a property
// of the OVERSEER SWITCH, and it is stated there (SwarmManagerPane) rather than
// here: 「swarmでの自動返信はサブ的なポジション」.
//
// FOUR WAYS IN, ONE CORPUS:
//   • TALKING (bottom centre) — the main one. One turn is one `claude` run that
//     replies AND distils what the owner said into kept lines, which are
//     appended as they land (PersonaConversation + src/lib/server/personaChat.ts).
//     There is no approval step 「対話していけば勝手にペルソナに入る」 — and no
//     invisible write either: every kept line is printed under the message it
//     came from and is pressable to correct.
//   • DROPPING a claude.ai export on the same input — the same act as talking,
//     so it takes the same slot (POST /api/persona/import).
//   • the day's question — the existing interview loop, now the conversation's
//     OPENING TURN rather than a fourth card in a corner.
//   • the courses (bottom left) — GET /api/persona/courses, submitted whole to
//     POST /api/persona/courses/:id/submit. The SERVER scores.
//
// THE STAGE NEVER SCROLLS 「スクロールなしにしてほしい」. Everything is pinned to an
// edge; only the conversation's own thread and the result sheet scroll, inside
// themselves. Nothing but the figure occupies the middle, and the readings that
// used to stand as permanent walls of text (the portrait, the ledger, the meta
// strip) are now RAISED ON DEMAND into one centre column — the same "point at
// it and it speaks" rule the region probe established.
//
// TWO READINGS SIT ON TOP OF THAT CORPUS, and neither one writes:
//   • the PORTRAIT (top-right count → the centre column, GET
//     /api/persona/portrait) — the few composed lines that answer
//     「で、私はどういう人?」 without reading every node. It is composed from scored
//     results server-side (src/lib/persona/portrait.ts), never generated, so an
//     empty `lines` is shown as an INVITATION rather than padded with a sentence
//     that would be true of anyone.
//   • a course's PAST RESULT (a 済 row → GET /api/persona/courses/:id/history) —
//     re-opened in the very same PersonaResultSheet, read-only, with a date
//     strip when the instrument has been taken more than once. Re-taking lives
//     INSIDE that sheet: one button per row keeps the corner a quiet list.
//
// CORRECTION = APPEND. There is no edit and no delete: correcting an earlier
// note writes a NEW note that carries the old one in its `context` (and its id
// in `correctsId`). History is never destroyed, and the overseer — which reads
// newest-first — sees the correction before the thing it corrects. There is no
// "add a note" button any more (2026-08-15): talking is how things go in, so the
// composer only ever opens OVER an existing line.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { capTrackingClass } from '@/lib/labelScript'
import { Btn } from '@/components/ui/Btn'
import {
  PersonaFigure,
  regionCountLine,
  type PersonaSpark,
  type RegionSummary,
} from './PersonaFigure'
import {
  PersonaConversation,
  RESOLVED_NOTICE_MS,
  type PersonaImportView,
} from './PersonaConversation'
import {
  COURSE_REGION,
  REGION_LABEL_KEY,
  buildPersonaNodes,
  placeJudgment,
  regionForQuestion,
  type PersonaNode,
} from '@/lib/persona/regions'
import { PersonaResultSheet } from './PersonaResultSheet'
import { PersonaKnownList, type PersonaMaterials } from './PersonaKnownList'
import { resultDelta } from '@/lib/persona/resultDelta'
import { PersonaTellApartCard } from './PersonaTellApartCard'
import { PersonaSaidDid } from './PersonaSaidDid'
import { saidDidPairs } from '@/lib/persona/saidDid'
import { isOurTag } from '@/lib/persona/knownGroups'
// (PersonaLedgerBlock — the ledger's own CARD — is deliberately not imported
//  any more: the ledger is one count line in the top-right corner now, and the
//  detail list it opens is the same one the card opened. The component is left
//  in place rather than deleted; nothing about the ledger feature was removed.)
import { PersonaLedgerDetail, isPersonaLedger } from './PersonaLedgerBlock'
import { Check, ChevronRight } from 'lucide-react'
import { courseById, itemAt, type PersonaCourse } from '@/lib/persona/instruments'
import { MAX_EXPORT_UPLOAD_BYTES, megabytes } from '@/lib/claudeExport'
import { portraitAgeLabel } from '@/lib/persona/portrait'
import type {
  ManualJudgment,
  PersonaChatStartResponse,
  PersonaChatStateResponse,
  PersonaChatTurn,
  PersonaChatTurnResponse,
  PersonaCourseHistoryResponse,
  PersonaCourseId,
  PersonaCourseRecord,
  PersonaCoursesResponse,
  PersonaImportJobResponse,
  PersonaImportStartResponse,
  PersonaInterviewResponse,
  PersonaKeptWrite,
  PersonaLedgerResponse,
  PersonaPortrait,
  PersonaQuestion,
  PersonaRegion,
  PersonaTellApartCheck,
  PersonaTellApartResponse,
  PersonaTellApartResult,
  RetiredJudgment,
  SubmitPersonaCourseResponse,
  YouCorpusAppendResponse,
  YouCorpusJudgmentsResponse,
  YouCorpusMeta,
  YouCorpusStatus,
} from '@/lib/types'

// How much of a corrected note to quote inside the correction's `context`. The
// original stays in the corpus verbatim under its own entry, so the quote is a
// POINTER, not a copy — capping it keeps a long-running correction chain from
// growing the corpus quadratically.
const QUOTE_MAX = 280

export const quoteForCorrection = (text: string): string =>
  text.length <= QUOTE_MAX ? text : `${text.slice(0, QUOTE_MAX)}…`

/** The tags the OWNER wrote, dropping the ones this app stamps (`region:…`,
 *  `take:…`, `persona`, `chat`, `import`, `interview`, the course ids). They are
 *  machine bookkeeping: shown as chips they read as if the owner had filed his
 *  own sentence under them. */
const ownTags = (tags: readonly string[]): string[] => tags.filter((t) => !isOurTag(t))

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

/** The spine's plate on 「言ったこと / やったこと」: year + month, so time reads
 *  off the rule in one pass instead of being restated by every row. */
const formatMonth = (iso: string | null, lang: string): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'long',
  })
}

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
  disabled,
}: {
  onClick: () => void
  children: string
  disabled?: boolean
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="rounded-[2px] border border-line px-2 py-0.5 text-meta text-ink-onDeep/70 transition-colors hover:border-accent hover:text-ink-onDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:hover:border-line disabled:hover:text-ink-onDeep/70"
  >
    {children}
  </button>
)

/** How often a running turn / import is asked about. The same 500ms every
 *  sibling job on this panel polls at; there is no SSE on this path. */
const CHAT_POLL_MS = 500

/** The digest the import dedupe is keyed on — of the FILE'S BYTES, so the
 *  server and this side agree without the server having to hold the file
 *  (src/lib/server/personaImport.ts shaOfBytes computes the same thing over the
 *  same bytes). Exported for the test: a client that sends a wrong digest
 *  silently degrades to the text-level dedupe, which is not a failure anyone
 *  would see until the corpus had doubled. */
export const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const PersonaModule = () => {
  const { t, lang } = useT()
  const [status, setStatus] = useState<YouCorpusStatus | null>(null)
  const [judgments, setJudgments] = useState<ManualJudgment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  /** A corpus read is IN FLIGHT. Separate from `loading`, which blanks the whole
   *  screen for the first read — a retry must not take the conversation the
   *  owner is mid-way through off the stage. This one only quiets the retry
   *  button so presses cannot stack. */
  const [reloading, setReloading] = useState(false)

  // Draft state. Only the inputs themselves ever write these, so a value is
  // never rewritten out from under an in-progress IME composition.
  //
  // `correcting` IS the composer's open/closed state now: with the add-note
  // button gone there is no second reason for it to be open, and a separate
  // `composing` flag would only be a way for the two to disagree.
  const [draft, setDraft] = useState('')
  const [tagsDraft, setTagsDraft] = useState('')
  const [correcting, setCorrecting] = useState<ManualJudgment | null>(null)
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
  const [resolving, setResolving] = useState(false)
  // A failed SKIP gets its own line, because there is no answer to reassure the
  // owner about on that path. A failed ANSWER is reported the way a failed turn
  // is — as the owner's own bubble, still on screen, with a retry under it —
  // since that is the same mechanism and the same promise.
  const [skipFailed, setSkipFailed] = useState(false)
  // ⚠ THREE-VALUED ON PURPOSE. 'none' is a CLAIM about the owner's records
  // ("nothing left to ask"), so it may only be reached through a 2xx — the
  // route 500s on a sweep that could not read them, which lands on 'failed'.
  // Collapsing the two would print the app's oldest lie shape: an emptiness
  // asserted over a source nobody managed to read.
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'none' | 'failed'>('idle')

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

  // The decision ledger (top right) — what the stand-in DID, as opposed to what
  // the owner said about themselves. Same rule as the portrait: `null` means
  // "not read", NOT "it has done nothing", and only a successful read may put
  // anything on screen.
  const [ledger, setLedger] = useState<PersonaLedgerResponse | null>(null)

  // ── the conversation ───────────────────────────────────────────────────────
  // The thread lives on the SERVER for the life of the process (a restart drops
  // it; the kept lines themselves are in the corpus and survive), so re-opening
  // the panel does not lose it.
  const [turns, setTurns] = useState<PersonaChatTurn[]>([])
  // Whether GET /api/persona/chat actually LANDED. Separate from `turns.length`
  // for the reason every other read on this screen keeps the pair apart: an
  // empty conversation is a claim, and a failed read may not make it.
  const [threadRead, setThreadRead] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [chatErrorKey, setChatErrorKey] = useState<string | null>(null)
  // REAL elapsed time of the turn in flight. A cold `claude` start is tens of
  // seconds and a fake typing animation over that is the lie; this is the
  // counter that replaces it.
  const [elapsedMs, setElapsedMs] = useState(0)
  const [importJob, setImportJob] = useState<PersonaImportView | null>(null)

  // WHICH READING IS RAISED in the centre column, when no note is open and no
  // course is running. The column renders exactly one thing via an if/else
  // chain (see the render), so two cards cannot stack there no matter what
  // these say.
  const [reading, setReading] = useState<'ledger' | 'courses' | 'known' | 'saidDid' | null>(null)

  const [selected, setSelected] = useState<PersonaNode | null>(null)
  // ── 「取り消す」 ────────────────────────────────────────────────────────────
  // The lines he took back, and the one he currently has open. Withdrawn lines
  // have NO node (they are off the body, which is the point), so the card that
  // opens for one is raised from the judgment itself rather than from `selected`.
  const [retired, setRetired] = useState<RetiredJudgment[]>([])
  const [retiredOpen, setRetiredOpen] = useState<ManualJudgment | null>(null)
  const [retiring, setRetiring] = useState(false)
  const [retireFailed, setRetireFailed] = useState(false)
  // WHICH line the last retire/restore acted on. 「言ったこと / やったこと」 shows
  // its rows all at once, so a bare boolean would spin every button and print
  // the failure under every entry.
  const [retireId, setRetireId] = useState<string | null>(null)
  // ── 「どれが自分ではないか」 ────────────────────────────────────────────────
  // The check, its outcome, and whether a send is in flight. It writes nothing
  // to the corpus in either direction — see personaTellApart.ts.
  const [check, setCheck] = useState<PersonaTellApartCheck | null>(null)
  const [checkResult, setCheckResult] = useState<PersonaTellApartResult | null>(null)
  const [checkBusy, setCheckBusy] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildResult, setRebuildResult] = useState<{ ok: boolean; warning?: string } | null>(null)
  // ── THE TWO ENDS OF THE LIST ⇄ BODY BINDING ────────────────────────────────
  // Which note the list is pointing at (the figure rings that point), and which
  // region the figure is being probed at (the list marks the rows seated there
  // and scrolls to the first). Both live HERE because they are the one piece of
  // state two siblings share; neither surface may own the other's half.
  const [highlight, setHighlight] = useState<string | null>(null)
  const [probed, setProbed] = useState<PersonaRegion | null>(null)
  const [spark, setSpark] = useState<PersonaSpark | null>(null)
  const [askPulse, setAskPulse] = useState(false)

  const sparkSeq = useRef(0)
  // Which history read is the CURRENT one. Two 済 rows clicked in quick
  // succession are two reads in flight, and the slower one must not drop its
  // course's result on top of the one the owner actually asked for last.
  const historySeq = useRef(0)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)
  // Every pending timer this component started (the poll loops and the spark
  // wave), so unmounting stops them instead of leaving them to fire into a
  // dead component.
  const timers = useRef<number[]>([])
  // `loadChat` runs before `pollTurn` exists (it is a useCallback further
  // down, and loadChat is in the mount effect's dependency list). The ref is
  // the seam rather than a reorder: pollTurn depends on the loaders, and the
  // loaders would then depend on it.
  const pollTurnRef = useRef<((turnId: string, startedAt: number) => void) | null>(null)
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      if (alive.current) fn()
    }, ms)
    timers.current.push(id)
  }, [])

  /** Fly `count` sparks into a region. `seq` is what fires it, so answering
   *  twice in the same region sparks twice. */
  const fireSpark = useCallback((region: PersonaRegion, count: number, kind: 'raw' | 'node') => {
    if (count <= 0) return
    sparkSeq.current += 1
    setSpark({ seq: sparkSeq.current, region, count, kind })
  }, [])

  /** One spark per kept line, STAGGERED — a batch of writes can land in several
   *  regions at once, and `spark` carries one region, so firing them in the
   *  same tick would show only the last. The stagger is also what makes the
   *  size of an import felt rather than merely counted. */
  const fireSparkWave = useCallback(
    (writes: readonly PersonaKeptWrite[], stepMs: number) => {
      writes.forEach((w, i) => later(() => fireSpark(w.region, 1, 'node'), i * stepMs))
    },
    [fireSpark, later],
  )

  /** Read the corpus.
   *
   *  ⚠ `loadError` IS CLEARED ONLY BY A READ THAT LANDED, never at the start of
   *  an attempt. Clearing it up front is what made pressing Retry flip the whole
   *  stage to 「まだ何も光っていません」 for the seconds the retry took: `loading`
   *  is already false by then and `judgments` is still empty from the failure, so
   *  the empty-invitation gate opened over a corpus that may be entirely intact.
   *  That is the forbidden sentence — "you have said nothing" — printed from a
   *  source nobody has read. The last KNOWN state is "could not read", and it
   *  stays on screen until something replaces it with a fact. */
  const load = useCallback(async () => {
    setReloading(true)
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
      // ⚠ THE SAME READ, so live and withdrawn cannot disagree about a line.
      setRetired(judgmentsBody.retired ?? [])
      setLoadError(false)
    } catch {
      if (alive.current) setLoadError(true)
    } finally {
      if (alive.current) {
        setLoading(false)
        setReloading(false)
      }
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

  // Its own loader, like every other reading on this screen. The route is newer
  // than the screen it sits on, so a server that 404s it must cost the owner
  // NOTHING else here — and, on failure, must leave the block absent rather than
  // showing an empty ledger, which would claim the stand-in has never acted.
  const loadLedger = useCallback(async () => {
    try {
      const res = await fetch('/api/persona/ledger', { cache: 'no-store' })
      if (!res.ok) throw new Error('ledger load failed')
      const body = (await res.json()) as unknown
      if (!alive.current) return
      // SHAPE-CHECK BEFORE STORING — the render path reaches straight into
      // `summary.week`, so a 200 that is not a ledger would throw inside render
      // and blank the whole panel. Exactly the failure the portrait loader was
      // fixed for on 2026-08-14; the same 200-with-a-bare-object arrives here
      // from any older server and from App.render's own fetch stub.
      if (!isPersonaLedger(body)) throw new Error('ledger shape')
      setLedger(body)
    } catch {
      // Deliberately silent AND deliberately non-destructive: whatever was read
      // last stays on screen, and a read that failed says nothing at all.
    }
  }, [])

  // Its own loader, same as every other reading here. A FAILED read leaves
  // `threadRead` false, and the conversation renders 「これまでの会話が読めません
  // でした」 with a retry instead of an empty thread — "you have said nothing" is
  // the one claim a failed read is in no position to make.
  const loadChat = useCallback(async () => {
    try {
      const res = await fetch('/api/persona/chat', { cache: 'no-store' })
      if (!res.ok) throw new Error('chat load failed')
      const body = (await res.json()) as Partial<PersonaChatStateResponse>
      if (!alive.current) return
      // SHAPE-CHECK BEFORE STORING — the same 200-with-a-bare-object that took
      // the portrait and the ledger down twice (2026-08-14). A body without
      // `turns` is not a thread.
      if (!Array.isArray(body.turns)) throw new Error('chat shape')
      setTurns(body.turns)
      setThreadRead(true)
      // A TURN CAN OUTLIVE THIS SCREEN. The run is a job, not this connection
      // (closing the panel mid-turn must not orphan a `claude`), so a reopened
      // panel can find one still going — and without re-attaching the poll it
      // would sit at 「送っています」 forever over a turn that finished minutes
      // ago. `live` is the server's own answer to "is one in flight".
      const running = body.turns.find((x) => x.state === 'running')
      if (body.live && running) {
        setChatBusy(true)
        setElapsedMs(0)
        pollTurnRef.current?.(running.id, Date.parse(running.askedAt) || Date.now())
      }
    } catch {
      // Non-destructive: whatever was read last stays on screen.
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    void loadQuestion()
    void loadCourses()
    void loadPortrait()
    void loadLedger()
    void loadChat()
    return () => {
      alive.current = false
      for (const id of timers.current) window.clearTimeout(id)
      timers.current = []
    }
  }, [load, loadQuestion, loadCourses, loadPortrait, loadLedger, loadChat])

  const nodes = useMemo(() => buildPersonaNodes(judgments), [judgments])
  const regionLabel = useCallback((region: PersonaRegion) => t(REGION_LABEL_KEY[region]), [t])
  const provenance = useCallback(
    (node: PersonaNode) =>
      [
        // A node whose region was SPREAD rather than read (regions.ts tier 4)
        // says so. Printing a region name here would put a label the owner
        // never chose directly under the owner's own sentence — in a store
        // where it could only be superseded, never removed.
        node.placed ? regionLabel(node.region) : t('persona.region.unplaced'),
        formatWhen(node.addedAt, lang) ?? node.addedAt,
      ].join(' ・ '),
    [regionLabel, t, lang],
  )

  // WHAT THE REGION PROBE SAYS. Composed HERE, never in PersonaFigure: the
  // figure holds no corpus, and a counter living next to the renderer is how a
  // screen starts reporting numbers nobody read.
  //
  // THREE STATES, KEPT APART (docs/VERIFICATION.md — this repo has shipped
  // "nothing here" over real data four times in one week):
  //   • a failed read     → state 'unread'. NO number at all; the probe prints
  //                         「ここは読めていません」. A 0 here would be a
  //                         measurement nobody took.
  //   • read, none seated → state 'read', placed 0 → 「ここはまだ何もありません」.
  //   • read, some spread → `unplaced` counted SEPARATELY and never added to
  //     `placed`. The ~159 notes that predate regions sit on the body without a
  //     reading (regions.ts tier 4); summing them would claim evidence for every
  //     one of them.
  const regionSummary = useCallback(
    (region: PersonaRegion): RegionSummary => {
      const label = regionLabel(region)
      if (loadError) {
        return {
          region,
          state: 'unread',
          placed: 0,
          unplaced: 0,
          lines: [],
          ariaName: `${label} ${t('persona.region.unreadable')}`,
        }
      }
      const seated = nodes.filter((n) => n.region === region)
      const read = seated.filter((n) => n.placed)
      const unplaced = seated.length - read.length
      // Newest first, two at most: the probe is a glance, not a list — the
      // sr-only node list is where every note is reachable.
      const lines = [...read]
        .sort((a, b) => (a.addedAt === b.addedAt ? a.id.localeCompare(b.id) : a.addedAt < b.addedAt ? 1 : -1))
        .slice(0, 2)
        .map((n) => ({ text: n.text, sub: provenance(n) }))
      // The SAME line the probe panel prints. It used to be composed here by
      // hand and said 「ここはまだ何もありません」 whenever nothing was READ —
      // ignoring `unplaced` entirely, so a region holding 40 spread notes was
      // announced as empty to anyone who could not see the panel's second line.
      const count = regionCountLine({ state: 'read', placed: read.length, unplaced })
      return {
        region,
        state: 'read',
        placed: read.length,
        unplaced,
        lines,
        ariaName: `${label} ${t(count.key, count.vars)}`,
      }
    },
    [nodes, regionLabel, provenance, loadError, t],
  )

  // The patch that pulses: the region the current question is digging in, or —
  // while a course runs — the region that course grows.
  const gapRegion: PersonaRegion | null = run
    ? COURSE_REGION[run.course.id]
    : regionForQuestion(question)

  const pulseAsk = useCallback(() => {
    setAskPulse(true)
    window.setTimeout(() => {
      if (alive.current) setAskPulse(false)
    }, 1100)
  }, [])

  const openComposer = (target: ManualJudgment) => {
    setCorrecting(target)
    setSubmitError(false)
    // KEEP whatever is already typed. Clearing it would silently throw away an
    // in-progress note the moment the owner clicks 直す on something — and a
    // React value reset is not undoable, so the text would be gone for good.
    // Losing typed words is the one thing this surface must never do. Only seed
    // the tags when the owner has none of their own in flight.
    setTagsDraft((prev) => (prev.trim() ? prev : target.tags?.join(', ') ?? ''))
    requestAnimationFrame(() => textRef.current?.focus())
  }

  // Leaves the draft alone for the same reason as openComposer: closing the
  // composer should drop the correction, not the owner's words.
  const closeComposer = () => {
    setCorrecting(null)
  }

  const startCorrection = (node: PersonaNode) => {
    const j = judgments.find((x) => x.id === node.id)
    if (!j) return
    setSelected(null)
    openComposer(j)
  }

  /** From a kept line under a reply. Same composer, same append-only rule — the
   *  chip carries the FULL stored judgment (PersonaKeptWrite.judgment) so this
   *  needs no round-trip to find the row that was just written. */
  const correctKept = useCallback((judgment: ManualJudgment) => {
    setSelected(null)
    setReading(null)
    setCorrecting(judgment)
    setSubmitError(false)
    setTagsDraft((prev) => (prev.trim() ? prev : judgment.tags?.join(', ') ?? ''))
    requestAnimationFrame(() => textRef.current?.focus())
  }, [])

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
      // The spark flies to where the note will actually be seated — the same
      // rule the figure seats it by — so the point that lights up is the note,
      // not a decoration next to it.
      if (body.judgment) fireSpark(placeJudgment(body.judgment).region, 1, 'node')
      // The portrait counts what the stand-in knows, so a new note moves it too.
      await Promise.all([load(), loadPortrait()])
    } catch {
      if (alive.current) setSubmitError(true)
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }

  /** 「もう1問もらう」. The daily sweep offers one unasked; this is the owner
   *  asking for another (2026-08-16: 「1日1答にする必要はない」). The server
   *  refuses to jump the queue while one is open, and the control is only
   *  offered when nothing is — so a press here always means "I am done with the
   *  last one". */
  const askAnother = useCallback(async () => {
    setMoreState('loading')
    try {
      const res = await fetch('/api/you-corpus/interview/next', { method: 'POST' })
      if (!res.ok) throw new Error('next question failed')
      const body = (await res.json()) as PersonaInterviewResponse
      if (!alive.current) return
      setQuestion(body.question ?? null)
      // `questionLoaded` is what lets the tab distinguish "no question" from
      // "never read". A 2xx landed, so it is true from here whatever came back.
      setQuestionLoaded(true)
      setSkipFailed(false)
      setAnswerStale(false)
      setMoreState(body.question ? 'idle' : 'none')
    } catch {
      if (alive.current) setMoreState('failed')
    }
  }, [])

  const submitAnswer = async (text: string) => {
    if (!text || resolving || !question) return
    setResolving(true)
    setSkipFailed(false)
    // ON SCREEN BEFORE THE REQUEST, exactly like a turn: the input has already
    // cleared itself by the time this runs, so the owner's words have to exist
    // somewhere else or a failed save costs them. It carries no `kept` — an
    // interview answer is not distilled, so there is nothing to report under it.
    const localId = `answer-${Date.now()}`
    setTurns((prev) => [
      ...prev,
      { id: localId, askedAt: new Date().toISOString(), text, state: 'running' },
    ])
    // Nothing is THINKING on this path — it is a plain save — so the counter
    // stays at zero and the bubble says 「送っています」 instead.
    setElapsedMs(0)
    try {
      const res = await fetch('/api/you-corpus/interview/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: question.id, answer: text }),
      })
      if (!res.ok) throw new Error('answer failed')
      const body = (await res.json()) as PersonaInterviewResponse
      if (!alive.current) return
      setTurns((prev) => prev.map((x) => (x.id === localId ? { ...x, state: 'done' } : x)))
      // ⚠ AND THEN THE WHOLE EXCHANGE LEAVES (owner, 2026-08-16: 「質問に答えたら
      // 質問や返答は消えるようにできてるね? ずっと残っててもいみないからね」). The
      // question goes the instant it is answered; this retires the ANSWER on the
      // same clock as the receipt, so all three clear together instead of
      // leaving the owner's own words parked above the box for the rest of the
      // day.
      //
      // ⚠ ONLY ON SUCCESS, AND THAT IS CARRIED BY THE POSITION, NOT BY A CHECK.
      // An interview answer is a form submission, not a conversation — its
      // record is the corpus line and the lit point on the figure, neither of
      // which is this bubble. A FAILED send keeps its bubble forever: the typed
      // words are the one thing that must never be lost, and the retry hangs off
      // them. That holds because this line is INSIDE the try, after the response
      // landed — a failure throws past it and schedules nothing.
      //
      // A `state === 'done'` filter here would read as extra safety and be
      // unreachable, which this file has been bitten by before (see the note in
      // answerTodayQuestion about a re-read that no test could reach). If this
      // ever moves to a `finally`, the failure test below is what goes red.
      later(() => {
        setTurns((prev) => prev.filter((x) => x.id !== localId))
      }, RESOLVED_NOTICE_MS)
      setQuestion(body.question ?? null)
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
      // kind, which is what placeJudgment reads back).
      const asked = regionForQuestion(question)
      if (asked && !body.corpusStale) fireSpark(asked, 1, 'node')
      // The answer just became a note — refresh so the owner sees where it
      // landed instead of having to take it on faith.
      await Promise.all([load(), loadPortrait()])
    } catch {
      // The words stay on screen as the owner's own bubble, with a retry under
      // it — and the question is still OPEN (its status only moves on a
      // successful write), so pressing retry answers it again.
      if (alive.current) failTurn(localId)
    } finally {
      if (alive.current) setResolving(false)
    }
  }

  // ── the conversation ───────────────────────────────────────────────────────

  /** Mark a turn as failed WITHOUT touching its text. The owner's words stay on
   *  screen with a retry under them; a React value reset is not undoable, so
   *  they must live in the turn rather than in the input.
   *
   *  `errorKey` is only for reasons the bubble cannot show on its own — the CLI
   *  is signed out, a turn is already running. A plain failure says so once, in
   *  the bubble, rather than twice. */
  const failTurn = useCallback((turnId: string, errorKey?: string) => {
    setTurns((prev) => prev.map((x) => (x.id === turnId ? { ...x, state: 'failed' } : x)))
    setChatErrorKey(errorKey ?? null)
    setChatBusy(false)
  }, [])

  const pollTurn = useCallback(
    (turnId: string, startedAt: number) => {
      const tick = async () => {
        setElapsedMs(Date.now() - startedAt)
        try {
          const res = await fetch(`/api/persona/chat/turn/${turnId}`, { cache: 'no-store' })
          if (!res.ok) throw new Error('turn poll failed')
          const body = (await res.json()) as PersonaChatTurnResponse
          if (!alive.current) return
          if (body.state === 'running') {
            later(() => void tick(), CHAT_POLL_MS)
            return
          }
          const kept = body.kept ?? []
          setTurns((prev) =>
            prev.map((x) =>
              x.id === turnId
                ? {
                    ...x,
                    state: body.state,
                    ...(body.reply === undefined ? {} : { reply: body.reply }),
                    // An EMPTY array is a real answer ("nothing was kept"), and
                    // the screen says so. `undefined` would mean "still going".
                    kept,
                    ...(body.keptUnreadable === undefined
                      ? {}
                      : { keptUnreadable: body.keptUnreadable }),
                    ...(body.error === undefined ? {} : { error: body.error }),
                  }
                : x,
            ),
          )
          setChatBusy(false)
          // A turn the server itself failed says so in the bubble, with the
          // owner's words still above it — no second line under the input.
          if (body.state === 'failed') return
          // The kept lines are already IN the corpus — re-read so the figure
          // lights them for real, and spark one point per line so the owner
          // sees where each landed.
          fireSparkWave(kept, 260)
          await Promise.all([load(), loadPortrait()])
        } catch {
          if (alive.current) failTurn(turnId)
        }
      }
      later(() => void tick(), CHAT_POLL_MS)
    },
    [later, load, loadPortrait, fireSparkWave, failTurn],
  )

  pollTurnRef.current = pollTurn

  const sendChat = useCallback(
    async (text: string) => {
      if (chatBusy) return
      setChatBusy(true)
      setChatErrorKey(null)
      // ON SCREEN BEFORE THE REQUEST, and it stays there whatever comes back.
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setTurns((prev) => [
        ...prev,
        { id: localId, askedAt: new Date().toISOString(), text, state: 'running' },
      ])
      setElapsedMs(0)
      try {
        const res = await fetch('/api/persona/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!alive.current) return
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            busy?: boolean
            claudeMissing?: boolean
            claudeLoggedOut?: boolean
          }
          failTurn(
            localId,
            body.claudeLoggedOut
              ? 'persona.chat.claudeLoggedOut'
              : body.claudeMissing
                ? 'persona.chat.claudeMissing'
                : body.busy
                  ? 'persona.chat.busy'
                  : undefined,
          )
          return
        }
        const body = (await res.json()) as PersonaChatStartResponse
        if (!alive.current) return
        // Re-key onto the SERVER's turn id, which is what the poll asks about.
        setTurns((prev) => prev.map((x) => (x.id === localId ? { ...x, id: body.turnId } : x)))
        pollTurn(body.turnId, Date.now())
      } catch {
        if (alive.current) failTurn(localId)
      }
    },
    [chatBusy, failTurn, pollTurn],
  )

  /** Stop the turn in flight.
   *
   *  THE ONLY THING THAT ENDS A RUN. A dropped connection does not: the turn is
   *  a job, deliberately not bound to the request that started it (that is what
   *  keeps a reply from being lost when the panel closes). The flip side is that
   *  a cold `claude` start that wedges holds the single-flight slot for its full
   *  ten-minute ceiling, burning the owner's own subscription, and until this was
   *  wired POST /api/persona/chat/cancel had no caller anywhere in the app.
   *
   *  Fire-and-forget on the wire, but the TURN CHANGES LOCALLY EITHER WAY: the
   *  press has to change the screen. A cancel that 404s (the turn had already
   *  finished server-side) is not a reason to leave a counter running. The poll
   *  reconciles whatever the server actually did on its next tick — and the
   *  server marks a cancelled turn `error: 'cancelled'` itself, which is the
   *  same marker set here, so the two agree rather than fight.
   *
   *  No global error banner: the owner did this on purpose. 'cancelled' is what
   *  makes the line under their message read "you stopped this" instead of the
   *  failure copy, which would be a small lie about who did what. */
  const cancelTurn = useCallback((turnId: string) => {
    void fetch('/api/persona/chat/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
    }).catch(() => {})
    setTurns((prev) =>
      prev.map((x) => (x.id === turnId ? { ...x, state: 'failed', error: 'cancelled' } : x)),
    )
    setChatErrorKey(null)
    setChatBusy(false)
  }, [])

  /** ONE input, two destinations. While the day's question is open the next
   *  thing typed ANSWERS it (the interview loop mints exactly one node); after
   *  that, and on every other day, it goes to the stand-in.
   *
   *  Deliberately NOT memoised: `submitAnswer` closes over the question and the
   *  loaders and is re-created every render anyway, so a useCallback here would
   *  be a dependency list that lies rather than an identity that holds. */
  const handleSend = (text: string) => {
    if (question && question.status === 'open') void submitAnswer(text)
    else void sendChat(text)
  }

  // ── taking in a claude.ai export ───────────────────────────────────────────

  const pollImport = useCallback(
    (importId: string, fileName: string) => {
      const tick = async () => {
        try {
          const res = await fetch(`/api/persona/import/${importId}`, { cache: 'no-store' })
          if (!res.ok) throw new Error('import poll failed')
          const body = (await res.json()) as PersonaImportJobResponse
          if (!alive.current) return
          if (body.state === 'running') {
            // `counts` lands as soon as PARSING did — show what arrived while
            // the distillation is still going.
            setImportJob({
              fileName,
              state: 'running',
              ...(body.counts ? { counts: body.counts } : {}),
            })
            later(() => void tick(), CHAT_POLL_MS)
            return
          }
          if (body.state === 'failed' || !body.result) {
            setImportJob({ fileName, state: 'failed', errorKey: 'persona.import.failed' })
            return
          }
          setImportJob({
            fileName,
            state: 'done',
            counts: body.result,
            result: body.result,
          })
          fireSparkWave(body.result.kept, 34)
          await Promise.all([load(), loadPortrait()])
        } catch {
          if (alive.current)
            setImportJob({ fileName, state: 'failed', errorKey: 'persona.import.failed' })
        }
      }
      later(() => void tick(), CHAT_POLL_MS)
    },
    [later, load, loadPortrait, fireSparkWave],
  )

  /** A file dropped on the conversation. Parsed and HASHED here, because the
   *  server never sees the bytes — the sha of the file is the only thing that
   *  can tell "the same export again" from "a newer export". */
  const dropExport = useCallback(
    async (file: File) => {
      const fail = (errorKey: string, errorVars?: Record<string, string | number>) =>
        setImportJob({ fileName: file.name, state: 'failed', errorKey, ...(errorVars ? { errorVars } : {}) })
      // There is no zip reader in this app, and there is not going to be one
      // for this: saying "drop the zip" and then failing is worse than saying
      // ⚠ THE ZIP IS THE NORMAL CASE, NOT AN ERROR (2026-08-15). claude.ai hands
      // the export over AS a zip; the old path refused it and told the owner to
      // open it and pull conversations.json out themselves — homework, at the
      // exact moment the app is asking for their history. The server sniffs the
      // content and takes either shape, so nothing is checked by file name here.
      //
      // ⚠ AND NOTHING IS READ ON THIS THREAD. The whole file used to be pulled
      // into an ArrayBuffer, hashed, decoded, JSON.parsed and then re-serialised
      // into a request body — five live copies on the thread that draws the
      // screen. The owner's real export is 23 MB zipped / 98 MB raw, so the
      // 64 MB cap that stopped the freeze would have refused the very file it
      // was built to serve. `body: file` streams the bytes and stops; Node does
      // the unzip, the parse and the digest (measured: ~1.6 s for all three).
      //
      // The size check that remains is the SERVER's ceiling, not a main-thread
      // one, and it is checked here only to fail fast with a number the owner
      // can act on rather than after a 256 MB upload.
      if (file.size > MAX_EXPORT_UPLOAD_BYTES) {
        fail('persona.import.tooLarge', {
          size: megabytes(file.size),
          max: megabytes(MAX_EXPORT_UPLOAD_BYTES),
        })
        return
      }
      setImportJob({ fileName: file.name, state: 'running' })
      try {
        const res = await fetch('/api/persona/import/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        })
        if (!alive.current) return
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            alreadyImported?: boolean
            at?: string
            busy?: boolean
            unreadableFile?: boolean
            claudeMissing?: boolean
            claudeLoggedOut?: boolean
          }
          if (body.alreadyImported) {
            fail('persona.import.already', {
              date: (body.at && formatDay(body.at, lang)) || body.at || '',
            })
          } else if (body.busy) fail('persona.import.busy')
          else if (body.claudeLoggedOut) fail('persona.chat.claudeLoggedOut')
          else if (body.claudeMissing) fail('persona.chat.claudeMissing')
          else if (body.unreadableFile) fail('persona.import.unreadableFile')
          else fail('persona.import.failed')
          return
        }
        const body = (await res.json()) as PersonaImportStartResponse
        if (!alive.current) return
        pollImport(body.importId, file.name)
      } catch {
        if (alive.current) fail('persona.import.failed')
      }
    },
    [lang, pollImport],
  )

  const skipQuestion = async () => {
    if (!question || resolving) return
    setResolving(true)
    setSkipFailed(false)
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
      if (alive.current) setSkipFailed(true)
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
        fireSpark(COURSE_REGION[course.id], body.minted, 'node')
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
    fireSpark(COURSE_REGION[run.course.id], 1, 'raw')
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
  // ── 前回から動いたところ ─────────────────────────────────────────────────
  // ⚠ THE TAKE BEFORE THE ONE ON SCREEN, not the newest one. Walking back
  // through the strip has to compare each sheet with what came before IT —
  // comparing an old take against the latest would print a movement that runs
  // backwards through time. `takes` is newest-first, so that is index + 1.
  const previousTake = sheet ? (sheet.takes[sheet.index + 1] ?? null) : null
  const shownDelta =
    shownTake && previousTake ? resultDelta(shownTake.result, previousTake.result) : null
  const shownDeltaSince = previousTake
    ? (formatWhen(previousTake.takenAt, lang) ?? previousTake.takenAt)
    : null
  const takeStrip = sheet
    ? sheet.takes.map((take) => ({
        id: take.takenAt,
        label: formatDay(take.takenAt, lang) ?? take.takenAt,
        title: formatWhen(take.takenAt, lang) ?? take.takenAt,
      }))
    : []

  // ⚠ THE COMPOSED COUNTS SENTENCE IS GONE (owner, 2026-08-16: 「いらない情報は
  // 出さないように気をつけて」). It read 「わかっていること 41件（うち3件はこの1週間）・
  // コースは4本中2本」 — every number in it already printed twice on this screen,
  // in the rail's own three rows and again in the list screen's header. Its
  // three-state honesty (unread ≠ 0, and an uncounted week ≠ a quiet one) did
  // NOT go with it: that rule lives in the rail, which is where the numbers now
  // are, and keeps its own guards (see the counts-corner tests).
  // Shown when the portrait was READ and has nothing evidenced to say. NEVER a
  // composed sentence: with no evidence there is nothing true to say about who
  // the owner is.
  const showPortraitInvite = !!portrait && portrait.lines.length === 0

  // The ledger's rows. The count line is only pressable when there is something
  // to open: a control that leads to an empty list is a broken promise, and an
  // unread ledger has nothing to say in either direction.
  const runningCourseId = run?.course.id ?? null
  const runAnswered = run?.answers.length ?? 0
  const ledgerEntries = ledger?.recent ?? []
  const ledgerDay = useCallback((iso: string) => formatDay(iso, lang) ?? iso, [lang])
  // "It has never done anything" and "it did nothing in the last seven days"
  // are different claims. A ledger that has never recorded ANYTHING draws no
  // line at all (a 0 there is a dashboard measuring nothing on a first run); an
  // idle week draws its 0, which is a measurement.
  const showLedgerCount =
    !!ledger &&
    (ledger.summary.lastAt !== null ||
      ledger.summary.total.answered + ledger.summary.total.asked + ledger.summary.total.abstained >
        0)

  /** 「取り消す」/「戻す」. One function for both, because they are the same act in
   *  two directions and a second copy is how the two drift.
   *
   *  ⚠ RELOADS RATHER THAN PATCHING LOCAL STATE. Whether a line is live is
   *  resolved server-side by replaying the whole log; guessing the new state
   *  here would be a second implementation of that rule, in the one place where
   *  being wrong means showing the owner a belief he just withdrew. */
  const setRetiredState = async (id: string, to: 'retire' | 'restore') => {
    setRetiring(true)
    setRetireFailed(false)
    setRetireId(id)
    try {
      const res = await fetch(`/api/you-corpus/${to}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error('failed')
      if (!alive.current) return
      // The card that raised this is about the line that just changed state, so
      // it cannot stay open over the new answer.
      setSelected(null)
      setRetiredOpen(null)
      await load()
    } catch {
      if (alive.current) setRetireFailed(true)
    } finally {
      if (alive.current) setRetiring(false)
    }
  }

  /** Raise ONE reading in the centre column. Every entrance goes through here,
   *  so opening the ledger cannot leave a note open behind it. */
  const openReading = (which: 'ledger' | 'courses' | 'known' | 'saidDid') => {
    setSelected(null)
    setCorrecting(null)
    setReading(which)
  }

  // ⚠ THE LIST IS A SCREEN, NOT A CARD IN THE COLUMN (owner, 2026-08-16:
  // 「情報が多いものはモーダルじゃなくてちゃんとしたスクリーン作るのもあり」). While it is
  // up, the stage becomes two panes — the list left, the body still drawn full
  // height on the right — and everything else steps off: the rail's counts, the
  // courses, the console. They are what you use to ADD to the record; this
  // screen is for reading it back, and 「いらない情報は出さないように」 applies hardest
  // to the surface that already carries four hundred rows.
  // ── 材料: what the stand-in is BUILT FROM ──────────────────────────────────
  // ⚠ EVERY SOURCE IS NAMED, INCLUDING THE ONES THAT DID NOT RESOLVE. A list of
  // only what landed reads as "this is everything", and the missing one is
  // exactly what explains a thin stand-in. `null` when the status read did not
  // land — the block is absent rather than reporting sources nobody read.
  const materials: PersonaMaterials | null = status
    ? {
        heading: `${t('persona.material.heading')} ・ ${t('persona.meta.updated')} ${updatedAt ?? t('persona.meta.never')}`,
        sources: [
          {
            label: t('persona.meta.manual'),
            value: countLabel('persona.meta.count', status.manualCount),
            present: status.manualCount > 0,
          },
          {
            label: t('persona.meta.memory'),
            // ⚠ THE DIR AND THE COUNT ARE DIFFERENT FACTS. An unresolved memory
            // dir is 「見つかりません」; a resolved one with nothing in it is 0,
            // which is a measurement.
            value: status.memoryDirExists
              ? countLabel('persona.meta.count', status.memoryCount)
              : t('persona.material.missing'),
            present: status.memoryDirExists,
          },
          {
            label: t('persona.material.concept'),
            value: status.conceptExists
              ? t('persona.material.included')
              : t('persona.material.missing'),
            present: status.conceptExists,
          },
          {
            label: t('persona.material.vision'),
            value: status.businessVisionExists
              ? t('persona.material.included')
              : t('persona.material.missing'),
            present: status.businessVisionExists,
          },
        ],
        rebuildLabel: t('persona.material.rebuild'),
        rebuildingLabel: t('persona.material.rebuilding'),
        rebuiltLabel: t('persona.material.rebuilt'),
        failedLabel: t('persona.material.rebuildFailed'),
      }
    : null

  /** 「作り直す」. The corpus is re-assembled on every write already, so the one
   *  state this exists for is an append whose rebuild was SKIPPED — the record
   *  saved, the file the stand-in reads left behind it.
   *
   *  ⚠ A SKIPPED REBUILD IS NOT A SUCCESS. The route answers 200 with
   *  `meta.skipped`, which is the assembler REFUSING to overwrite a real corpus
   *  from sources that did not resolve — reporting that as done would tell the
   *  owner the file was rebuilt at the exact moment it was not. */
  const rebuildCorpus = async () => {
    setRebuilding(true)
    setRebuildResult(null)
    try {
      const res = await fetch('/api/you-corpus/rebuild', { method: 'POST' })
      if (!res.ok) throw new Error('failed')
      const meta = (await res.json()) as YouCorpusMeta
      if (!alive.current) return
      setRebuildResult(
        meta.skipped ? { ok: false, ...(meta.warning ? { warning: meta.warning } : {}) } : { ok: true },
      )
      await load()
    } catch {
      if (alive.current) setRebuildResult({ ok: false })
    } finally {
      if (alive.current) setRebuilding(false)
    }
  }

  /** Ask the server whether a check is due. POST because it can write: the three
   *  options are frozen the moment they are drawn, so a reload re-reads the same
   *  question rather than dealing a new hand.
   *
   *  ⚠ A NULL CHECK IS THE ORDINARY ANSWER — it is offered once the record has
   *  grown by ten lines, not on a schedule. A failure is silent for the same
   *  reason: this is an offer, and a screen that reports "could not fetch the
   *  optional question you did not ask for" is noise. */
  const loadCheck = useCallback(async () => {
    try {
      const res = await fetch('/api/you-corpus/tell-apart', { method: 'POST' })
      if (!res.ok) return
      const body = (await res.json()) as PersonaTellApartResponse
      if (alive.current) setCheck(body.check)
    } catch {
      /* an offer nobody asked for stays silent */
    }
  }, [])

  const answerCheck = async (optionId: string) => {
    if (!check) return
    setCheckBusy(true)
    setCheckFailed(false)
    try {
      const res = await fetch('/api/you-corpus/tell-apart/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: check.id, optionId }),
      })
      if (!res.ok) throw new Error('failed')
      const body = (await res.json()) as PersonaTellApartResult
      if (alive.current) setCheckResult(body)
    } catch {
      if (alive.current) setCheckFailed(true)
    } finally {
      if (alive.current) setCheckBusy(false)
    }
  }

  const skipCheck = async () => {
    if (!check) return
    const id = check.id
    // Cleared HERE rather than on the response: 「あとで」 is the owner declining
    // to answer, and making him wait for a round trip to be rid of a question he
    // just dismissed is the whole complaint about this kind of card.
    setCheck(null)
    setCheckResult(null)
    try {
      await fetch('/api/you-corpus/tell-apart/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch {
      /* the next load will offer it again, which is the safe direction */
    }
  }

  /** When a withdrawn line was withdrawn. Read from the same array the list
   *  renders, so the card and the row cannot print different dates. */
  const retiredAtOf = (id: string): string | null =>
    retired.find((r) => r.judgment.id === id)?.retiredAt ?? null

  const knownOpen = reading === 'known'
  // ── 「答えたことと、そのときの状況」 ────────────────────────────────────────
  // Split back out of the corpus, never re-derived: both halves were stored in
  // one line by the interview writer. `undefined` on a failed read — an empty
  // list would say he has answered nothing, which is a claim.
  const saidDidOpen = reading === 'saidDid'
  const pairs = loadError ? undefined : saidDidPairs(judgments)

  // ⚠ BOTH HALVES OF THE BINDING DIE WITH THE SCREEN, IN ONE PLACE. A ring left
  // burning on the body for a list nobody can see is a pointer with nothing
  // pointing it, and a probe left set would mark rows the instant the screen was
  // re-opened. Keyed on the screen being up rather than hung off the close
  // button, so no exit path — now or later — can be the one that skips it.
  useEffect(() => {
    if (knownOpen) return
    setHighlight(null)
    setProbed(null)
  }, [knownOpen])

  // The check is offered when the list screen opens — the one place his own
  // words are already in front of him, so 「これは本当に自分のことか」 can be
  // answered by scrolling rather than by memory.
  useEffect(() => {
    if (knownOpen) void loadCheck()
  }, [knownOpen, loadCheck])

  if (loading) {
    return (
      <div className="flex-1 px-8 py-6 text-ui text-ink-subtle">{t('persona.loading')}</div>
    )
  }

  // ── THE STAGE ───────────────────────────────────────────────────────────────
  // Eight slots, all pinned to an edge, and the middle belongs to the figure.
  // NOTHING here scrolls: the conversation's thread and the result sheet scroll
  // INSIDE themselves (owner: 「スクロールなしにしてほしい」).
  //
  //   1 figure            inset-0
  //   2 top-left          what this place is (two lines, always)
  //   3 top-right         the counts — two of them open a reading
  //   4 bottom-left       the courses, a quiet list
  //   5 bottom-centre     the conversation
  //   6 centre column     ONE reading at a time (if/else, not three booleans)
  //   7 probe             inside PersonaFigure
  //   8 result sheet      over everything
  //
  // The top corners start at `top-16` rather than the mock's 22px because the
  // panel around this screen (PersonaPanel) draws the shared 「Ground に戻る」
  // chip at left-4 top-4, and PersonaFigure draws its own recenter chip at
  // right-4 top-4. Sitting under them is the deviation; overlapping them was
  // the bug.
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-deep">
      {/* ⚠ ONE MOUNT, TWO PLACES. The figure is wrapped rather than moved into
       *  the screen's subtree: re-parenting it would unmount the component,
       *  throwing away the camera and re-firing the spark effect. It resizes
       *  into the right pane instead — which its ResizeObserver already handles,
       *  because that is the same path a window resize takes. NO transition on
       *  the width: an eased pane would fire that observer every frame and
       *  rebuild ~1,800 particles each time. */}
      <div
        className={
          knownOpen
            ? 'absolute inset-y-0 right-0 left-[min(520px,44%)]'
            : 'absolute inset-0'
        }
      >
        <PersonaFigure
          nodes={nodes}
          gapRegion={gapRegion}
          pendingRegion={run ? COURSE_REGION[run.course.id] : null}
          spark={spark}
          // Opening a note takes the reading column: everything that reads sits
          // in ONE place on this screen, so a note replaces whatever was there.
          // ⚠ EXCEPT ON THE LIST SCREEN, where the note opens BESIDE the list
          // instead of closing it — losing your place in four hundred rows to
          // read one of them is how a list stops being usable.
          onSelect={(node) => {
            setReading((r) => (r === 'known' ? r : null))
            setCorrecting(null)
            setSelected(node)
          }}
          // ⚠ TAPPING THE EMPTY STAGE PUTS THE READING DOWN (owner, 2026-08-17:
          // 「モーダル系はモーダル外をタップすると閉じる仕様にしてね。全部」). The reading
          // column is not an Overlay — it is a card floating on the stage with
          // no backdrop of its own — so the shell's rule cannot reach it, and
          // to the eye it is a modal like any other. This is that rule, spelt
          // out for the one surface the shell does not own.
          //
          // ⚠ THE COMPOSER AND A COURSE IN FLIGHT ARE SAFE BY STRUCTURE, NOT BY
          // A CHECK. They are the FIRST branches of the column (`run ? … :
          // correcting ? …`), so while either is up it owns the column and
          // nothing below it is even rendered — clearing `reading` under them
          // changes nothing. A `if (correcting || run) return` guard was written
          // here first and then deleted: mutation-tested, it could not be made
          // to go red, which is the definition of a line that reads as
          // protection and protects nothing.
          //
          // And it leaves the two full SCREENS alone: `known` / `saidDid` fill
          // the surface and have their own 「戻る」, so on those the tap means
          // only "put the note down".
          onTapEmpty={() => {
            setSelected(null)
            setRetiredOpen(null)
            setReading((r) => (r === 'known' || r === 'saidDid' ? r : null))
          }}
          onTapGap={pulseAsk}
          regionLabel={regionLabel}
          provenance={provenance}
          regionSummary={regionSummary}
          highlightId={highlight}
          // Only while the list is on screen: the probe fires on every hover
          // over the body, and a state nobody reads is a re-render per frame.
          onProbe={knownOpen ? setProbed : undefined}
        />
      </div>

      {/* ── THE LIST SCREEN's left pane. `bg-bg` against the stage's `bg-deep`:
       *  a reading surface that inverts with the theme, beside a stage that
       *  deliberately does not. */}
      {knownOpen && (
        <div className="absolute inset-y-0 left-0 z-30 w-[min(520px,44%)] border-r border-line bg-bg">
          <PersonaKnownList
            judgments={loadError ? undefined : judgments}
            nodes={nodes}
            portrait={portrait}
            portraitLineDetail={(line) =>
              [line.detail, portraitAgeLabel(line.ageDays)].filter(Boolean).join(' ・ ')
            }
            portraitInvite={showPortraitInvite}
            materials={materials}
            onRebuild={() => void rebuildCorpus()}
            rebuilding={rebuilding}
            rebuildResult={rebuildResult}
            provenance={provenance}
            retired={loadError ? undefined : retired}
            retiredLabel={(iso) =>
              `${t('persona.retire.at')} ${formatWhen(iso, lang) ?? iso}`
            }
            onOpenNote={(node) => {
              setRetiredOpen(null)
              setSelected(node)
            }}
            onOpenRetired={(j) => {
              setSelected(null)
              setRetiredOpen(j)
            }}
            onHighlight={setHighlight}
            probedRegion={probed}
            onRetry={() => void load()}
            onClose={() => setReading(null)}
            reloading={reloading}
            {...(check
              ? {
                  banner: (
                    <PersonaTellApartCard
                      check={check}
                      result={checkResult}
                      busy={checkBusy}
                      failed={checkFailed}
                      onAnswer={(optionId) => void answerCheck(optionId)}
                      onSkip={() => void skipCheck()}
                      onDone={() => {
                        setCheck(null)
                        setCheckResult(null)
                      }}
                    />
                  ),
                }
              : {})}
          />
        </div>
      )}

      {/* ── 「答えたことと、そのときの状況」: the widest thing on this surface, so it
       *  takes the WHOLE stage rather than a pane — two columns of prose need
       *  the measure, and the figure has nothing to add to a comparison between
       *  two texts. */}
      {saidDidOpen && (
        <div className="absolute inset-0 z-30 bg-bg">
          <PersonaSaidDid
            pairs={pairs}
            day={(iso) => formatDay(iso, lang) ?? iso}
            month={(iso) => formatMonth(iso, lang) ?? iso}
            stamp={(iso) => formatWhen(iso, lang) ?? iso}
            // 「直す」 LEAVES THIS SCREEN, on purpose: rewriting a line is a
            // different act from auditing one, and the composer is where every
            // other correction on this surface is written. Landing in two
            // places depending on where you started would be the worse seam.
            onOpenCorrect={(id) => {
              const node = nodes.find((n) => n.id === id)
              if (!node) return
              setReading(null)
              startCorrection(node)
            }}
            // 「取り消す」 stays here: it is one POST, and the row simply leaves
            // the list because a withdrawn line is not live any more.
            onRetire={(id) => void setRetiredState(id, 'retire')}
            busyId={retiring ? retireId : null}
            failedId={retireFailed ? retireId : null}
            onRetry={() => void load()}
            onClose={() => setReading(null)}
            reloading={reloading}
          />
        </div>
      )}

      {/* ── 2. THE RAIL — everything about YOU, in one column ────────────────
       *
       *  ⚠ THIS USED TO BE FIVE FLOATING ISLANDS (owner, 2026-08-15:
       *  「全体的にバランスが悪い配置のバランス、情報のまとまりもない」): the name and
       *  the two intro lines top-left, the counts top-RIGHT, the courses
       *  bottom-left, a gesture hint floating at 52% down the middle, and the
       *  conversation bottom-centre. Nothing tied any of them together, so the
       *  screen read as debris around a picture rather than as an instrument.
       *
       *  They are one rail now, and the order is an argument: WHO this is →
       *  WHAT IS IN IT (the numbers) → WHAT YOU CAN ADD (the courses) → how to
       *  move the figure. That also finishes the merge the owner asked for
       *  earlier — the results summary and the courses were the two halves that
       *  were furthest apart on the screen, and they are now adjacent.
       *
       *  The right edge is left EMPTY on purpose. One rail against a centred
       *  figure is a composition; a second rail balancing it is how the five
       *  islands happened. Hairlines separate the groups, so grouping is carried
       *  by the rule and the gap rather than by distance across the window. */}
      <aside
        className={`absolute left-6 top-16 z-10 w-[min(272px,32vw)] flex-col gap-4 ${
          knownOpen || saidDidOpen ? 'hidden' : 'flex'
        }`}
      >
        {/* WHO: the plate and the two lines that say what this place is. */}
        <div className="flex flex-col gap-3">
          <span className={`label-cap ${capTrackingClass(t('persona.tabLabel'))} text-ink-onDeep/50`}>
            {t('persona.tabLabel')}
          </span>
          <div className="flex flex-col gap-1.5">
            <p className="text-meta leading-relaxed text-ink-onDeep/75">{t('persona.intro.lead')}</p>
            <p className="text-micro leading-relaxed text-ink-onDeep/45">
              {t('persona.intro.leadSub')}
            </p>
          </div>
          {loadError && (
            <div className="flex items-center gap-2 text-micro text-ink-onDeep/70">
              <span>{t('persona.loadFailed')}</span>
              {/* The error stays up until a read LANDS (see `load`), so the button
               *  is the only thing that changes while one is in flight. */}
              <StageButton onClick={() => void load()} disabled={reloading}>
                {reloading ? t('persona.loading') : t('persona.retry')}
              </StageButton>
            </div>
          )}
        </div>

        {/* ⚠ `courses` IS PART OF THE GATE, not just of the contents. This block
         *  used to open on `portrait || showLedgerCount`, and the courses line
         *  below is now the ONLY way to reach the courses at all — so a failed
         *  portrait read would have taken the whole feature off the screen with
         *  it. Three independent reads feed this block; each one draws its own
         *  line, and none of them can silence another. */}
        {(portrait || showLedgerCount || courses.length > 0 || coursesError) && (
          <section
            aria-label={t('persona.counts.label')}
            className="flex flex-col gap-1.5"
          >
            {portrait && (
              <>
                {/* Pressable: the composed portrait lines used to stand
                 *  permanently down the left of the stage. Same facts, raised
                 *  only when asked for — the rule the probe established. */}
                {/* ⚠ THIS ROW NOW OPENS WHAT IT SAYS. It used to be labelled
                 *  「わかっていること」 and open the PORTRAIT — five composed lines,
                 *  the rest silently dropped. A word meaning "everything that is
                 *  known", pressed, returning five sentences, is why the label
                 *  stopped meaning anything (owner, 2026-08-16). It opens the
                 *  full list now, with the portrait as that list's header. */}
                <button
                  type="button"
                  onClick={() => openReading('known')}
                  className="text-left text-plate tracking-wide text-ink-onDeep/45 transition-colors hover:text-ink-onDeep"
                >
                  {t('persona.counts.known')}{' '}
                  {/* ⚠ NOT `?? 0`. An absent count means the corpus could not be
                   *  read, and printing a 0 there tells the owner their record is
                   *  empty at exactly the moment nobody could look at it. The
                   *  word goes where the number would be — same distinction the
                   *  region probe draws between "could not read" and "nothing". */}
                  {portrait.nodeCount === undefined ? (
                    <b className="font-medium text-ink-onDeep/45">{t('persona.counts.unread')}</b>
                  ) : (
                    <b className="font-medium tabular-nums text-[#DDAE58]">{portrait.nodeCount}</b>
                  )}
                  {/* ⚠ THE WEEK IS A SUFFIX, NOT A ROW. It used to stand alone as
                   *  「今週 6」 — a bare time adverbial with no noun, readable only
                   *  by borrowing the noun from the row above, which the eye does
                   *  not do across three rows of unlike things. Folded here it is
                   *  subordinate to the total it came out of, and the rail loses
                   *  a row.
                   *
                   *  ⚠ FAINTER AND SMALLER THAN THE TOTAL, deliberately. At equal
                   *  weight it becomes a fourth competing number and the original
                   *  complaint returns in a new place.
                   *
                   *  `recentCount` is optional on the wire: a server that did not
                   *  count is not a week in which nothing happened, so the suffix
                   *  is ABSENT rather than 「今週 +0」. */}
                  {portrait.recentCount !== undefined && (
                    <span className="ml-1.5 text-micro text-ink-onDeep/30">
                      {t('persona.counts.weekDelta', { count: portrait.recentCount })}
                    </span>
                  )}
                </button>
              </>
            )}
            {/* ⚠ THE COURSES USED TO BE A PERMANENT FOUR-ROW LIST at the foot of
             *  the rail — four names, four dates, standing there from first
             *  paint whether or not anyone was going to take one (owner,
             *  2026-08-16: 「ここの表示もずっとしておかなくてもいいかも」/「なるべく画面に
             *  表示する情報は少なくしよう」). It is one line now, and pressing it
             *  raises the list in the reading column — the same rule the
             *  portrait and the ledger already follow: the facts exist, they are
             *  raised WHEN ASKED FOR rather than standing on the stage.
             *
             *  ⚠ COUNTED FROM `courses`, not from the portrait. The number and
             *  the list this line opens are then the same array by construction,
             *  so "4/4" can never label a panel that turns out to be empty. And
             *  when the courses could not be read the word goes where the number
             *  would be — the same three-valued rule as `nodeCount` above: a
             *  count nobody could take is not a 0. */}
            {(courses.length > 0 || coursesError) && (
              <button
                type="button"
                onClick={() => openReading('courses')}
                className="text-left text-plate tracking-wide text-ink-onDeep/45 transition-colors hover:text-ink-onDeep"
              >
                {t('persona.counts.courses')}{' '}
                {coursesError ? (
                  <b className="font-medium text-ink-onDeep/45">{t('persona.counts.unread')}</b>
                ) : (
                  <b className="font-medium tabular-nums text-[#DDAE58]">
                    {`${courses.filter((c) => c.lastTakenAt).length}/${courses.length}`}
                  </b>
                )}
              </button>
            )}
            {/* The decision ledger, demoted from its own card to one line — and it
             *  counts THIS WEEK, not the lifetime tally. The block answers one
             *  question ("how often did it speak for me lately?") and a lifetime
             *  number under that question is the flattering version. */}
            {showLedgerCount && ledger && (
              <button
                type="button"
                onClick={() => openReading('ledger')}
                disabled={ledgerEntries.length === 0}
                aria-label={t('persona.ledger.label')}
                className="text-left text-plate tracking-wide text-ink-onDeep/45 transition-colors hover:text-ink-onDeep disabled:hover:text-ink-onDeep/45"
              >
                {t('persona.counts.decided')}{' '}
                <b className="font-medium tabular-nums text-[#DDAE58]">
                  {ledger.summary.week.answered}
                </b>
              </button>
            )}
            {/* ⚠ ONLY WHEN THERE ARE PAIRS. A row that opens a screen saying
             *  「まだありません」 is a promise the record cannot keep — and this one
             *  fills itself: every answered question adds a pair. It is also
             *  ABSENT over a failed read (`pairs` undefined), because a row
             *  reading 0 would be a count nobody took. */}
            {!!pairs?.length && (
              <button
                type="button"
                onClick={() => openReading('saidDid')}
                className="text-left text-plate tracking-wide text-ink-onDeep/45 transition-colors hover:text-ink-onDeep"
              >
                {t('persona.saidDid.heading')}{' '}
                <b className="font-medium tabular-nums text-ochre">{pairs.length}</b>
              </button>
            )}
          </section>
        )}

        {/* ⚠ NO OPERATING INSTRUCTIONS ON THIS STAGE (owner, 2026-08-16:
         *  「操作の仕方の説明はいりません。スクロールとかの」). A line reading
         *  「スクロールで移動、⌘/Ctrl+スクロールで拡大…」 used to close the rail —
         *  permanent chrome teaching gestures that the figure answers the moment
         *  you try them. It is gone, and so is the probe's variant of it; the
         *  probe already draws its own summary beside the cursor, and the lit
         *  points look pressable because they are. Anything that has to be
         *  explained in a footnote here should be fixed in the figure instead. */}
      </aside>

      {/* ── 5. the one thing to DO ─────────────────────────────────────────── */}
      <div
        /* Centred on the FULL width, deliberately — it lines up with the
         *  figure, and the two of them are what the screen is about. The rail
         *  is the margin note, so the console does not re-centre itself into
         *  the leftover space and drag the composition off the figure. */
        data-testid="persona-console"
        /* ⚠ HIDDEN, NOT UNMOUNTED, while the list screen is up. The console owns
         *  the half-typed message in its textarea; unmounting it would eat a
         *  sentence every time the owner opened the list to check something
         *  mid-thought. */
        className={`absolute bottom-6 left-1/2 z-20 w-[min(620px,calc(100%-680px))] min-w-[min(480px,calc(100%-3rem))] -translate-x-1/2 rounded-[3px] transition-shadow ${
          knownOpen || saidDidOpen ? 'hidden' : ''
        } ${askPulse ? 'ring-2 ring-accent/40' : ''}`}
      >
        <PersonaConversation
          turns={turns}
          threadRead={threadRead}
          onRetryThread={() => void loadChat()}
          elapsedMs={elapsedMs}
          busy={chatBusy || resolving}
          errorKey={chatErrorKey}
          onSend={handleSend}
          onCancel={cancelTurn}
          onCorrect={correctKept}
          // A question is only offered while it is unanswered on a day it was
          // actually READ — `questionLoaded` is what keeps "no question today"
          // from being said over a read that simply failed.
          question={questionLoaded ? question : null}
          answering={resolving}
          answerStale={answerStale}
          skipFailed={skipFailed}
          onSkipQuestion={() => void skipQuestion()}
          moreState={moreState}
          onAskAnother={() => void askAnother()}
          lang={lang}
          onDropExport={(file) => void dropExport(file)}
          importJob={importJob}
        />
      </div>

      {/* First run: the figure is all dust, so say what this place is and what
       *  lights it. Only ever shown over a SUCCESSFUL read (showEmptyInvite),
       *  and never under an open reading — the column would land on top of it. */}
      {showEmptyInvite && !selected && !correcting && !reading && !run && (
        <div className="pointer-events-none absolute inset-x-0 top-[16%] z-10 mx-auto flex max-w-[440px] flex-col gap-2 px-6 text-center">
          <h2 className="font-display text-title tracking-tightest text-ink-onDeep">
            {t('persona.intro.title')}
          </h2>
          <p className="text-meta leading-relaxed text-ink-onDeep/70">{t('persona.figure.empty')}</p>
          <p className="text-micro leading-relaxed text-ink-onDeep/50">
            {t('persona.intro.correctionNote')}
          </p>
        </div>
      )}

      {/* ── 6. THE READING COLUMN — exactly one thing, structurally ──────────
       *  An if/else chain rather than three independent flags: two cards
       *  stacked here is how the column stops being one place where things are
       *  read, and a chain cannot produce that state however the flags fall. */}
      {/* ⚠ THE COLUMN WIDENS FOR THE COURSES (owner, 2026-08-16: 「テストが終わった
       *  ものに関しては、それによってモーダルの出る大きさとかも変えてもいいよ」). A taken
       *  course carries the instrument's own sentence, and at 420px that sentence
       *  was clipped mid-word by the two-line clamp — a summary cut in half is
       *  not a summary. Everything else read here is a column of short lines and
       *  keeps the narrower measure, which is the width prose wants.
       *
       *  ⚠ AND IT MOVES OFF CENTRE WHILE THE LIST SCREEN IS UP. Centred on the
       *  full stage it would land half on the list and half on the body; over
       *  the right pane it sits beside the row that opened it, with the point
       *  that row lights still visible under it. */}
      {/* ⚠ AND IT STEPS OFF UNDER THE RESULT SHEET. The sheet is `z-overlay-local`
       *  (20) and this column is z-30, so the courses panel the sheet was opened
       *  FROM was drawing on top of it — the owner's result with a list of
       *  courses over its header. Hiding the column is the structural fix rather
       *  than a z-index race: the sheet is a full surface, and a surface has
       *  nothing else on it. */}
      <div
        data-testid="persona-reading"
        className={
          knownOpen
            ? `absolute right-6 top-[10%] z-40 flex w-[min(380px,44%)] flex-col gap-3 ${
                sheet ? 'hidden' : ''
              }`
            : `absolute left-1/2 top-[14%] z-30 flex -translate-x-1/2 flex-col gap-3 ${
                sheet ? 'hidden' : ''
              } ${
                reading === 'courses'
                  ? 'w-[min(560px,calc(100%-3rem))]'
                  : 'w-[min(420px,calc(100%-3rem))]'
              }`
        }
      >
        {staleWarning && (
          // On a CARD, not bare on the stage: `ochre` is the warning colour and
          // it inverts with the theme, so on a surface that does not invert it
          // would be a dark-brown line on near-black at noon.
          <p className="rounded-[3px] border border-line bg-bg-card px-2.5 py-1 text-meta leading-relaxed text-ochre-deep">
            {t('persona.meta.stale')}
          </p>
        )}

        {run ? (
          /* A COURSE IN FLIGHT. It used to live in the bottom-right card with
             the day's question; that card is gone, and a course is a focused
             task, so it takes the reading column while it runs. */
          <section
            aria-live="polite"
            className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card"
          >
            <p className="flex items-baseline justify-between gap-3">
              <span className="label-cap text-accent">{run.course.name}</span>
              <span className="text-meta tabular-nums text-ink-faint">
                {`${Math.min(run.answers.length + 1, run.course.itemCount)} / ${run.course.itemCount}`}
              </span>
            </p>
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
          </section>
        ) : correcting ? (
          /* CORRECTING = APPENDING. The original is never touched; this writes
             a new note carrying it. */
          <section className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card">
            <h3 className="label-cap text-ink-faint">{t('persona.correct.heading')}</h3>
            <blockquote className="border-l-2 border-accent-soft pl-3 text-ui leading-relaxed text-ink-subtle">
              {correcting.text}
            </blockquote>
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
              placeholder={t('persona.correct.placeholder')}
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
                {submitting ? t('persona.add.submitting') : t('persona.correct.submit')}
              </Btn>
            </div>
            {submitError && <p className="text-meta text-accent">{t('persona.add.failed')}</p>}
          </section>
        ) : selected ? (
          <article className="rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card">
            <p className="whitespace-pre-wrap text-read font-semibold leading-relaxed text-ink">
              {selected.text}
            </p>
            <p className="mt-2 text-meta text-ink-faint">{provenance(selected)}</p>
            {/* ⚠ HIS TAGS ONLY (owner, 2026-08-16: 「いらない情報は出さないように気を
             *  つけて」). The card used to print the raw list, so a chat note wore
             *  `chat` and `region:arms` — our vocabulary, in our punctuation,
             *  saying twice over what the line above already says in words
             *  (「やり方 ・ 2026年8月11日」) and what the group heading says again.
             *  Same predicate the list's filter uses, so "what counts as ours"
             *  is decided in one place. */}
            {ownTags(selected.tags).length > 0 && (
              <p className="mt-1.5 flex flex-wrap gap-1.5 text-meta text-ink-muted">
                {ownTags(selected.tags).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-[2px] border border-line-soft bg-bg-inset px-1.5 py-0.5"
                  >
                    {tag}
                  </span>
                ))}
              </p>
            )}
            {/* ⚠ 元の言葉 — THE ONE THING THAT MAKES A DISTILLED LINE CHECKABLE.
             *  Most lines here were not typed by him: a model read what he wrote
             *  and produced a sentence ABOUT him, which is either a fair reading
             *  or a small invention, and until this field there was no way to
             *  tell which. Absent is NOT empty — a line written before the field
             *  existed says so, rather than showing a blank quote. */}
            <div className="mt-2.5 flex flex-col gap-1">
              <span className="label-cap text-ink-faint">{t('persona.source.heading')}</span>
              {selected.source ? (
                <p className="max-h-[10.5rem] overflow-y-auto whitespace-pre-wrap text-meta leading-relaxed text-ink-subtle">
                  {selected.source}
                </p>
              ) : (
                <p className="text-meta leading-relaxed text-ink-faint">
                  {t('persona.source.missing')}
                </p>
              )}
            </div>
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
            {/* ⚠ TWO DIFFERENT ACTS, SIDE BY SIDE. 「直す」 says 「本当はこう」 and
             *  needs a replacement sentence; 「取り消す」 says 「これは要らない」 and
             *  needs none. Until now only the first existed, so a line that was
             *  simply wrong to have could be argued with but never withdrawn —
             *  and the owner's only way out was to write a correction he did not
             *  mean. Nothing is deleted either way (see retireJudgment): the
             *  line stays in the file and comes back in one press. */}
            <div className="mt-3.5 flex items-center gap-2">
              <Btn variant="ghost" size="xs" onClick={() => startCorrection(selected)}>
                {t('persona.correct.start')}
              </Btn>
              <Btn
                variant="ghost"
                size="xs"
                disabled={retiring}
                onClick={() => void setRetiredState(selected.id, 'retire')}
              >
                {retiring ? t('persona.retire.working') : t('persona.retire.start')}
              </Btn>
              <Btn variant="subtle" size="xs" onClick={() => setSelected(null)}>
                {t('persona.node.close')}
              </Btn>
            </div>
            {retireFailed && <p className="mt-1.5 text-meta text-accent">{t('persona.retire.failed')}</p>}
          </article>
        ) : retiredOpen ? (
          /* A WITHDRAWN LINE, opened from its own group. Same card, one button:
             it is not on the body, so there is nothing to correct — only to put
             back. The words are shown exactly as he wrote them. */
          <article className="rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card">
            <p className="whitespace-pre-wrap text-read leading-relaxed text-ink-muted">
              {retiredOpen.text}
            </p>
            <p className="mt-2 text-meta text-ink-faint">
              {`${t('persona.retire.at')} ${formatWhen(retiredAtOf(retiredOpen.id) ?? retiredOpen.addedAt, lang) ?? ''}`}
            </p>
            <div className="mt-3.5 flex items-center gap-2">
              <Btn
                variant="ghost"
                size="xs"
                disabled={retiring}
                onClick={() => void setRetiredState(retiredOpen.id, 'restore')}
              >
                {retiring ? t('persona.retire.working') : t('persona.retire.undo')}
              </Btn>
              <Btn variant="subtle" size="xs" onClick={() => setRetiredOpen(null)}>
                {t('persona.node.close')}
              </Btn>
            </div>
            {retireFailed && <p className="mt-1.5 text-meta text-accent">{t('persona.retire.failed')}</p>}
          </article>
        ) : reading === 'courses' ? (
          /* 「クリックしたら中身が表示されて受けることができるぐらいのやつ」 — the
             courses, raised on demand. On the stage they were four bare names;
             here each one can say WHAT IT IS (the instrument's own subtitle) and
             how long it takes, because a panel you opened on purpose is allowed
             to be a paragraph where a permanent rail is not. */
          <section
            aria-label={t('persona.course.railHeading')}
            className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card"
          >
            {coursesError ? (
              <div className="flex items-center gap-2 text-meta text-ink-muted">
                <span>{t('persona.loadFailed')}</span>
                <Btn variant="subtle" size="xs" onClick={() => void loadCourses()}>
                  {t('persona.retry')}
                </Btn>
              </div>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {courses.map((c) => {
                  const state = courseRailState(c, runningCourseId)
                  const metaLine =
                    state === 'running'
                      ? t('persona.course.state.running', {
                          index: runAnswered + 1,
                          total: c.itemCount,
                        })
                      : state === 'done'
                        ? openingCourse === c.id
                          ? t('persona.course.opening')
                          : t('persona.course.state.done', {
                              date: formatDay(c.lastTakenAt, lang) ?? '',
                            })
                        : t('persona.course.state.new', { count: c.itemCount })
                  // ⚠ THE ROW SAYS IT BY BEING A ROW (owner, 2026-08-16:
                  // 「テキストで表現をしなくてよくて、UIとして見た時にあの押せる状態
                  // っていうのが分かるように、例えばリストのようなボタンになってると
                  // か…全部言葉で説明しなくてもいい」).
                  //
                  // The pass before this answered "how do I know these are
                  // pressable / which did I take?" by WRITING THE ANSWER — a
                  // 受ける / 結果を見る verb on every row and 「まだ受けていません」 in
                  // the meta line. Legible, and four sentences of furniture. The
                  // form carries both facts for free:
                  //   • a full-width row with a hover face and a chevron is the
                  //     shape every settings list uses for "this opens";
                  //   • a ✓ in the leading slot is "taken", and its absence is
                  //     "not taken" — no sentence needed either way.
                  // The meta line drops to two facts (what it is · when / how
                  // long) so every row stays one line.
                  //
                  // ⚠ THE VERB SURVIVES IN `aria-label`. A chevron is silent to a
                  // screen reader, so the sentence that stopped being DRAWN is
                  // still the button's accessible name — the visual economy is
                  // not paid for out of someone else's access.
                  const done = state === 'done'
                  const actionKey =
                    state === 'running'
                      ? 'persona.course.action.quit'
                      : done
                        ? 'persona.course.action.result'
                        : 'persona.course.action.take'
                  return (
                    <li key={c.id} className="border-t border-line/60 first:border-t-0">
                      <button
                        type="button"
                        aria-label={`${c.name} — ${t(actionKey)}`}
                        onClick={() =>
                          state === 'running'
                            ? quitCourse()
                            : done
                              ? void openCourseResult(c)
                              : startCourse(c.id)
                        }
                        className="group flex w-full items-start gap-3 rounded-[2px] px-2 py-2.5 text-left transition-colors hover:bg-bg-inset/70"
                      >
                        {/* The taken mark, in a FIXED-WIDTH slot so the names
                         *  line up whether or not there is a tick in it — a
                         *  column that jitters row to row reads as a bug. */}
                        <span
                          aria-hidden="true"
                          className="flex w-[14px] flex-none justify-center pt-[3px] text-moss"
                        >
                          {done ? <Check size={13} strokeWidth={2.5} /> : null}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate text-ui leading-relaxed text-ink transition-colors group-hover:text-accent">
                              {c.name}
                            </span>
                            {/* ⚠ THE RESULT'S OWN SHORT NAME, WHEN IT HAS ONE
                             *  (owner, 2026-08-16: 「NBTIだったら、ENTPとかあるじゃん。
                             *  そういうの」). Only the 16-type course produces a
                             *  label; the other three produce a profile, and
                             *  inventing a badge for them would be a made-up
                             *  summary of a real measurement. So: a chip when
                             *  there is one, nothing at all when there is not —
                             *  never a placeholder. */}
                            {done && c.badge && (
                              <span
                                data-testid="course-badge"
                                className="flex-none rounded-[2px] border border-moss/40 px-1.5 py-px font-mono text-plate tracking-wider text-moss"
                              >
                                {c.badge}
                              </span>
                            )}
                          </span>
                          {/* A TAKEN COURSE SAYS WHAT IT FOUND. The headline is
                           *  the instrument's own sentence, composed from the
                           *  scored result — never generated, so a row can only
                           *  ever repeat what the sheet already says. Two lines
                           *  at most: the owner sanctioned the rows growing for
                           *  taken courses (「モーダルの出る大きさとかも変えてもいい」),
                           *  and a sentence cut mid-word helps nobody.
                           *
                           *  An untaken row keeps its two facts on one line —
                           *  what it is, and how long it takes. */}
                          <span
                            className={`text-meta leading-relaxed text-ink-faint ${
                              done && c.headline ? 'line-clamp-2' : 'truncate'
                            }`}
                          >
                            {done && c.headline
                              ? c.headline
                              : [c.sub, metaLine].filter(Boolean).join(' ・ ')}
                          </span>
                        </span>
                        {/* The right end: WHEN, then "this opens". One group on
                         *  one baseline — the date used to float a line above the
                         *  chevron, which read as two unrelated bits of furniture
                         *  rather than the end of a row. */}
                        <span className="flex flex-none items-center gap-2 pt-[2px]">
                          {done && c.headline && metaLine && (
                            <span className="text-plate tracking-wide text-ink-faint">
                              {metaLine}
                            </span>
                          )}
                          <ChevronRight
                            aria-hidden="true"
                            size={14}
                            className="text-ink-faint transition-colors group-hover:text-accent"
                          />
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {historyError && (
              <p className="text-meta leading-relaxed text-ink-muted">
                {t('persona.course.historyFailed')}
              </p>
            )}
            <div className="flex">
              <Btn variant="subtle" size="xs" onClick={() => setReading(null)}>
                {t('persona.node.close')}
              </Btn>
            </div>
          </section>
        ) : reading === 'ledger' && ledgerEntries.length > 0 ? (
          <PersonaLedgerDetail
            entries={ledgerEntries}
            dayLabel={ledgerDay}
            onClose={() => setReading(null)}
          />
        ) : null}
      </div>

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
          delta={shownDelta}
          {...(shownDeltaSince ? { deltaSince: shownDeltaSince } : {})}
          onClose={() => setSheet(null)}
          onRetake={retakeCourse}
        />
      )}
    </div>
  )
}
