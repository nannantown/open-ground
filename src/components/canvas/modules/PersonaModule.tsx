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
import { PersonaConversation, type PersonaImportView } from './PersonaConversation'
import {
  COURSE_REGION,
  REGION_LABEL_KEY,
  buildPersonaNodes,
  placeJudgment,
  regionForQuestion,
  type PersonaNode,
} from '@/lib/persona/regions'
import { PersonaResultSheet } from './PersonaResultSheet'
// (PersonaLedgerBlock — the ledger's own CARD — is deliberately not imported
//  any more: the ledger is one count line in the top-right corner now, and the
//  detail list it opens is the same one the card opened. The component is left
//  in place rather than deleted; nothing about the ledger feature was removed.)
import { PersonaLedgerDetail, isPersonaLedger } from './PersonaLedgerBlock'
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
  const [reading, setReading] = useState<'portrait' | 'ledger' | 'courses' | null>(null)

  const [selected, setSelected] = useState<PersonaNode | null>(null)
  // Which region the owner is currently pointing at (or has opened from the
  // keyboard). The PANEL lives in the figure — this is only what the rest of the
  // screen needs to know about it, which today is one line of hint copy.
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
  const takeStrip = sheet
    ? sheet.takes.map((take) => ({
        id: take.takenAt,
        label: formatDay(take.takenAt, lang) ?? take.takenAt,
        title: formatWhen(take.takenAt, lang) ?? take.takenAt,
      }))
    : []

  // The portrait's counts, in the same plain voice as the rest of the screen.
  // THREE sentences, not one with holes in it, because there are three states
  // and only one of them is "we counted": `nodeCount` absent means the corpus
  // could not be READ (a `?? 0` here would print 「わかっていること 0件」 over an
  // intact record), and `recentCount` absent means the server did not count the
  // week — which is not a week in which nothing happened.
  const portraitCounts = portrait
    ? portrait.nodeCount === undefined
      ? t('persona.portrait.countsUnread', {
          taken: portrait.takenCount,
          total: portrait.courseCount,
        })
      : portrait.recentCount === undefined
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

  /** Raise ONE reading in the centre column. Every entrance goes through here,
   *  so opening the ledger cannot leave a note open behind it. */
  const openReading = (which: 'portrait' | 'ledger' | 'courses') => {
    setSelected(null)
    setCorrecting(null)
    setReading(which)
  }

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
      <PersonaFigure
        nodes={nodes}
        gapRegion={gapRegion}
        pendingRegion={run ? COURSE_REGION[run.course.id] : null}
        spark={spark}
        // Opening a note takes the reading column: everything that reads sits
        // in ONE place on this screen, so a note replaces whatever was there.
        onSelect={(node) => {
          setReading(null)
          setCorrecting(null)
          setSelected(node)
        }}
        onTapEmpty={() => setSelected(null)}
        onTapGap={pulseAsk}
        regionLabel={regionLabel}
        provenance={provenance}
        regionSummary={regionSummary}
      />

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
      <aside className="absolute left-6 top-16 z-10 flex w-[min(272px,32vw)] flex-col gap-4">
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
                <button
                  type="button"
                  onClick={() => openReading('portrait')}
                  className="text-plate tracking-wide text-ink-onDeep/45 transition-colors hover:text-ink-onDeep"
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
                </button>
                {/* `recentCount` is optional on the wire: a server that did not
                 *  count is not a week in which nothing happened, so the line is
                 *  absent rather than zero. */}
                {portrait.recentCount !== undefined && (
                  <span className="text-plate tracking-wide text-ink-onDeep/45">
                    {t('persona.counts.week')}{' '}
                    <b className="font-medium tabular-nums text-[#DDAE58]">{portrait.recentCount}</b>
                  </span>
                )}
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
                className="text-plate tracking-wide text-ink-onDeep/45 transition-colors hover:text-ink-onDeep disabled:hover:text-ink-onDeep/45"
              >
                {t('persona.counts.decided')}{' '}
                <b className="font-medium tabular-nums text-[#DDAE58]">
                  {ledger.summary.week.answered}
                </b>
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
        className={`absolute bottom-6 left-1/2 z-20 w-[min(620px,calc(100%-680px))] min-w-[min(480px,calc(100%-3rem))] -translate-x-1/2 rounded-[3px] transition-shadow ${
          askPulse ? 'ring-2 ring-accent/40' : ''
        }`}
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
      <div className="absolute left-1/2 top-[14%] z-30 flex w-[min(420px,calc(100%-3rem))] -translate-x-1/2 flex-col gap-3">
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
        ) : reading === 'portrait' && portrait ? (
          /* 「で、私はどういう人?」 — composed server-side from scored results,
             never generated, so with nothing evidenced it ASKS instead. */
          <section
            aria-label={t('persona.portrait.label')}
            className="flex flex-col gap-2.5 rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card"
          >
            {showPortraitInvite ? (
              <p className="text-meta leading-relaxed text-ink-muted">
                {t('persona.portrait.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {portrait.lines.map((line) => (
                  <li key={`${line.courseId}|${line.text}`} className="flex flex-col gap-0.5">
                    <span className="text-ui leading-relaxed text-ink">{line.text}</span>
                    {/* Provenance, always VISIBLE and always second: a line whose
                     *  evidence you cannot see is a horoscope. The age wording is
                     *  portraitAgeLabel's — one vocabulary for staleness. */}
                    <span className="text-meta leading-relaxed text-ink-faint">
                      {[line.detail, portraitAgeLabel(line.ageDays)].filter(Boolean).join(' ・ ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {portraitCounts && (
              <p className="text-meta leading-relaxed text-ink-faint">{portraitCounts}</p>
            )}
            {/* What the stand-in actually READS, and when it was last built.
             *  Detail, so it lives here rather than standing on the stage. */}
            {status && (
              <p className="text-meta leading-relaxed text-ink-faint">
                {`${t('persona.meta.memory')} ${countLabel('persona.meta.count', status.memoryCount)} ・ ${t('persona.meta.manual')} ${countLabel('persona.meta.count', status.manualCount)}`}
                <span className="block">
                  {`${t('persona.meta.updated')} ${updatedAt ?? t('persona.meta.never')}`}
                </span>
              </p>
            )}
            <div className="flex">
              <Btn variant="subtle" size="xs" onClick={() => setReading(null)}>
                {t('persona.node.close')}
              </Btn>
            </div>
          </section>
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
              <ul className="flex flex-col gap-2.5">
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
                        : t('persona.course.state.new', {
                            count: c.itemCount,
                            region: regionLabel(c.region),
                          })
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() =>
                          state === 'running'
                            ? quitCourse()
                            : state === 'done'
                              ? void openCourseResult(c)
                              : startCourse(c.id)
                        }
                        className="group flex w-full items-baseline gap-2.5 text-left"
                      >
                        {/* Tokenised here, unlike on the stage: this dot sits on
                         *  `bg-bg-card`, which DOES invert with the theme, so a
                         *  painted hex would be a dark smudge at noon. */}
                        <span
                          aria-hidden="true"
                          className={`mt-[7px] block h-[5px] w-[5px] flex-none rounded-full ${
                            state === 'done'
                              ? 'bg-moss'
                              : state === 'running'
                                ? 'bg-accent'
                                : 'bg-line-strong'
                          }`}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-ui leading-relaxed text-ink transition-colors group-hover:text-accent">
                            {c.name}
                          </span>
                          {/* The instrument's own one-liner. It had nowhere to go
                           *  while this was a rail of single lines, so the owner
                           *  was choosing between four names with no idea what
                           *  any of them asked. */}
                          <span className="text-meta leading-relaxed text-ink-faint">
                            {[c.sub, metaLine].filter(Boolean).join(' ・ ')}
                          </span>
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
          onClose={() => setSheet(null)}
          onRetake={retakeCourse}
        />
      )}
    </div>
  )
}
