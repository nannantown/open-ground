// swarmEscalations — the Escalations inbox (C1 of the overseer EPIC; spec:
// docs/OVERSEER_DESIGN.md §8). The HUMAN VALVE of the unmanned swarm: when the
// overseer (or, until C-core lands, a manual API caller) hits a question that is
// IRREVERSIBLE or beyond the proxy's knowledge, it lands here instead of being
// auto-answered — {question, context/stakes, the proxy's provisional answer,
// why it was raised, the blocked worker's ADDRESS, an evidence tail} — and the
// REAL user answers it. The answer is (1) delivered into the blocked worker on
// ITS OWN RUNTIME so it resumes (bracketed paste + Enter for a PTY, one queued
// turn for an SDK session — deliverAnswerToWorker), or queued for the card's
// next dispatch when the worker is gone, and (2) written back to you-corpus
// memory (owner Q→A only) — the proxy-you training pipeline.
//
// ⚠ THE ADDRESS IS TWO FIELDS, NOT ONE. `runtime` + the single handle it names
// (pty ⇔ terminalId, sdk ⇔ sdkSessionId — workerRuntime.ts). A record built from
// `terminalId` alone cannot name an SDK worker, whose terminalId is the EMPTY
// STRING: every answer to one silently fell through to the next-dispatch queue
// while the worker sat waiting. Anything here that reaches a worker must go
// through the record's address, never through one id it happens to like.
//
// INVARIANTS this module owns (§8; the tests pin them):
//  1. FAIL-CLOSED: there is NO code path that moves a record out of 'open'
//     except the owner's explicit answer/dismiss. An unanswered irreversible
//     question stays open forever (the retention sweep never touches 'open').
//  2. receiptKey idempotency: while an 'open' record with the same receiptKey
//     exists, re-raising is a no-op returning the existing record — an overseer
//     restart (edge-dedup reset, §6) can never grow the inbox or re-toast.
//  3. Appends are single-flight; a corrupt file is preserved aside as
//     `.corrupt-<ts>` (same contract as you-corpus additions — never silently
//     clobbered), and the inbox is NOT capped (unlike swarm-notifications.json:
//     losing an unanswered irreversible decision would violate K6).
//  4. Memory write-back is the OWNER's answered Q→A only — never the proxy's
//     auto-answer, never worker-derived text (one-way mislearning guard).
//  5. Notification delivery is best-effort and never a correctness precondition
//     — the persisted record is the source of truth (§8 invariant 7).

import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { WORKING_FOOTER_RE } from '@/lib/claudeScreen'
import { ensureOpenGroundHome, escalationsFile, escalationShotsDir } from './paths'
import { atomicWriteJson } from './atomicWrite'
import { getTerminal, getTerminalScreen, writeInput } from './terminal'
import { getSdkSession, isSdkSessionLive, pushSdkInput } from './sdkSession'
import {
  runtimeOf,
  workerRuntimeKind,
  type WorkerHandle,
  type WorkerRuntimeKind,
} from './workerRuntime'
import { bracketedPaste } from './pastePrompt'
import { appendJudgment } from './youCorpus'
import { createSwarmInfoNotification } from './swarmNotifications'
import { isValidProjectPath, projectUUIDFromPath } from './projectDataPath'
import { canonicalize } from './canonicalize'
import type {
  Escalation,
  EscalationDelivery,
  EscalationProxyDraft,
  EscalationStatus,
  EscalationView,
  EscalationWhy,
} from '../types'

// ─── Limits (shared by the routes' 400 validation and this module's clamps) ──

export const MAX_ESCALATION_QUESTION = 4 * 1024
export const MAX_ESCALATION_CONTEXT = 16 * 1024
export const MAX_ESCALATION_ANSWER = 16 * 1024
/** Clamp for the plain-language question (平易文 — same budget as `question`:
 *  it replaces it as the PRIMARY text on the owner's decision surface). */
export const MAX_ESCALATION_PLAIN_QUESTION = 4 * 1024
/** Clamp for id-like fields (receiptKey / taskId / branch / terminalId). */
export const MAX_ESCALATION_SHORT_FIELD = 512
/** The worker-gone fallback rides the /order goal line of the card's NEXT
 *  dispatch (one slash-command argument) — clamp what we contribute so a long
 *  answer can't blow the goal size / Windows argv ceiling. The FULL answer
 *  stays on the escalation record. */
export const MAX_ESCALATION_ORDER_LINE = 2000
/** Evidence-tail clamp — the LAST N chars of the worker's screen (PTY) or of its
 *  recent distilled events (SDK). The TAIL, because what matters is what the
 *  worker said last before it stopped. */
export const MAX_ESCALATION_SHOT_CHARS = 8 * 1024
/** Days a RESOLVED (answered/injected/dismissed) record is kept before the boot
 *  retention sweep prunes it. 'open' records are NEVER pruned (fail-closed). */
export const ESCALATION_RETENTION_DAYS = 90

/** Delay between the bracketed-paste write and the submitting Enter, giving the
 *  worker's TUI time to finish processing the paste before the CR arrives (the
 *  in-app cousin of the tmux "trailing Enter got swallowed" lesson). */
export const ESCALATION_ENTER_DELAY_MS = 200
/** After the submitting CR: how many times the landing is re-checked — and the
 *  CR re-sent while the pasted text still sits unsent in the input box — before
 *  the delivery is reported failed (C3's Enter-resend hardening of W16). */
export const ENTER_RETRY_MAX = 3
/** Interval between landing checks. Long enough for the TUI to repaint after a
 *  CR; short enough that the whole bounded retry stays under ~4s. */
export const ENTER_RETRY_INTERVAL_MS = 900
/** Footer marker claude's TUI shows ONLY while generating — its appearance
 *  after our CR is positive proof the submitted turn LANDED. (Verified against
 *  live frames 2026-07-06; the idle counterpart is "? for shortcuts".) Defined
 *  with the rest of the frame anatomy in @/lib/claudeScreen and re-exported
 *  under this module's historical name for its existing importers. */
export { WORKING_FOOTER_RE as CLAUDE_WORKING_FOOTER_RE } from '@/lib/claudeScreen'

const ESCALATION_STATUSES: readonly EscalationStatus[] = [
  'open',
  'answered',
  'injected',
  'dismissed',
]
const ESCALATION_WHYS: readonly EscalationWhy[] = ['irreversible', 'insufficient-info', 'policy']

// ─── Typed errors (the routes map these to 404 / 409) ────────────────────────

export class EscalationNotFoundError extends Error {
  constructor(id: string) {
    super(`escalation not found: ${id}`)
    this.name = 'EscalationNotFoundError'
  }
}

/** An operation that contradicts the record's lifecycle (e.g. answering a
 *  DISMISSED question) — refused loudly rather than silently "succeeding". */
export class EscalationStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EscalationStateError'
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

interface EscalationsState {
  items: Escalation[]
}

/** Structural check for one record. Records failing this are dropped by the
 *  element filter (file-level corruption is handled by the `.corrupt` move —
 *  see readForWrite); optional fields are NOT validated here so a forward-compat
 *  field can never eat the inbox. */
const isEscalation = (v: unknown): v is Escalation => {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<Escalation>
  return (
    typeof e.id === 'string' &&
    typeof e.receiptKey === 'string' &&
    typeof e.createdAt === 'string' &&
    typeof e.projectPath === 'string' &&
    typeof e.question === 'string' &&
    typeof e.context === 'string' &&
    ESCALATION_WHYS.includes(e.whyEscalated as EscalationWhy) &&
    ESCALATION_STATUSES.includes(e.status as EscalationStatus)
  )
}

/** Tolerant read for the LIST path: a mangled file yields [] rather than
 *  throwing (the write path below preserves the damaged file — this read never
 *  writes anything). */
const readTolerant = async (): Promise<Escalation[]> => {
  await ensureOpenGroundHome()
  try {
    const raw = await readFile(escalationsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<EscalationsState>
    if (!Array.isArray(parsed.items)) return []
    return parsed.items.filter(isEscalation)
  } catch {
    return []
  }
}

/** The write-path view of the inbox: `all` is the raw element array as stored
 *  (persisted back verbatim), `known` the recognisable records (SAME references
 *  — mutating a known record mutates it inside `all`). */
interface EscalationsForWrite {
  all: unknown[]
  known: Escalation[]
}

/** Strict read for the WRITE path (same contract as you-corpus additions): the
 *  inbox is accumulate-only and uncapped, so existing records must never be
 *  silently lost. Three protections:
 *   • ONLY ENOENT means "legitimately empty". Any other read failure (EACCES /
 *     EMFILE / EIO…) ABORTS the caller — returning [] there would let the next
 *     persist() clobber every existing record (open ones included) while the
 *     file was merely unreadable for a moment.
 *   • A parse failure moves the damaged file aside as `.corrupt-<ts>`
 *     (recoverable) before we continue from empty — and if even that rename
 *     fails, the rename's throw propagates rather than clobbering.
 *   • Elements THIS build can't recognise (a newer build's enum values after a
 *     self-update rollback, hand-added records…) are PRESERVED verbatim in
 *     `all` and simply excluded from the operable `known` view — an unknown
 *     open record can never be dropped by the next write. */
const readForWrite = async (): Promise<EscalationsForWrite> => {
  const file = escalationsFile()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { all: [], known: [] }
    throw e
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const items = (parsed as Partial<EscalationsState>)?.items
    if (!Array.isArray(items)) throw new Error('escalations file is not {items: []}')
    return { all: items, known: items.filter(isEscalation) }
  } catch {
    await rename(file, `${file}.corrupt-${Date.now()}`)
    return { all: [], known: [] }
  }
}

// Serialise every read-modify-write through a single-flight chain (mirrors
// swarmNotifications / youCorpus): two concurrent opens/answers can't lose each
// other. Keeps advancing even if one write throws.
let chain: Promise<unknown> = Promise.resolve()
const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
  const run = chain.then(work)
  chain = run.catch(() => {})
  return run
}

// ─── LOCK ORDER — the permanent deadlock this shape exists to prevent ─────────
// There are TWO locks in this process:
//   L1 = the `chain` above (single-flight over the escalations JSON, module-wide)
//   L2 = swarmOrchestrator's per-engine critical section (`runExclusive`)
// Only ONE direction is legal: **L2 → L1**. The engine tick holds L2 for its
// whole body and calls openEscalation (= L1) from monitorWorkers via
// `deps.raiseQuestion` — that direction is structural and cannot be removed.
// Therefore NOTHING may hold L1 while taking L2. answerEscalation used to do
// exactly that (enqueue() → deliverAnswer → recordEscalationAnswerForNextDispatch
// = runExclusive): an owner answering while a tick was in flight left both sides
// waiting on each other forever — the engine AND the inbox frozen, with no
// timeout on either await and nothing in any log to say why.
// THE RULE: inside enqueue(), do file read-modify-write ONLY. No PTY injection,
// no orchestrator call, no import of swarmOrchestrator. Delivery happens after
// the chain has been released (see answerEscalation's two phases).

/** Persist ONLY the 'injected' transition, re-reading from disk first.
 *  Delivery now runs OUTSIDE the chain, so the `all` array read before delivery
 *  is stale by the time we come back — writing it wholesale would clobber any
 *  record a concurrent openEscalation appended (the inbox is append-only and
 *  uncapped BY DESIGN: losing an unanswered irreversible decision violates K6).
 *  Re-read, find by id, write that one field. A record that vanished meanwhile
 *  is a no-op — the delivery itself already happened. */
const markInjected = async (id: string, injectedAt: string): Promise<void> =>
  enqueue(async () => {
    const { all, known } = await readForWrite()
    const fresh = known.find((e) => e.id === id)
    if (!fresh) return
    fresh.status = 'injected'
    fresh.injectedAt = injectedAt
    await persist(all)
  })

/** Records whose DELIVERY leg is in flight right now. The chain used to
 *  serialise delivery as a side effect of covering it; now that delivery is
 *  outside, two concurrent answers to the same record would interleave their
 *  bracketed-paste writes into the same worker PTY (a spliced prompt the worker
 *  then acts on). In-memory only — a restart correctly clears it, because
 *  nothing is in flight after a restart. */
const deliveringIds = new Set<string>()

// fsync — the inbox is the ONE durable record of unanswered irreversible
// decisions (the notification side channels are best-effort); a power cut must
// not surface a 0-byte file. mode 0600: questions/answers are personal data
// (same posture as you-corpus). `items` is the raw `all` array so unknown
// elements ride along untouched.
const persist = async (items: unknown[]): Promise<void> => {
  await atomicWriteJson(escalationsFile(), { items }, { mode: 0o600, fsync: true })
}

/** A screenshotRef is only ever a file THIS module minted under the shots dir —
 *  but the record rides a JSON file on disk, so treat it as untrusted on the
 *  way back in: a tampered ref must not become an arbitrary-path read (list)
 *  or, worse, an arbitrary-path unlink (prune). Lexical containment check. */
const isSafeShotRef = (ref: string): boolean => {
  const dir = resolve(escalationShotsDir())
  return resolve(ref).startsWith(dir + sep)
}

// ─── Read (the GET route) ─────────────────────────────────────────────────────

/** The inbox, newest-first, optionally filtered to one project and/or one
 *  status (the SwarmModule panel polls ?status=open every 10s — without the
 *  filter it would re-download every resolved record plus its expanded PTY
 *  capture just to discard them). Expands each returned record's capture
 *  (screenshotRef → screenshot) server-side so the client needs no extra
 *  asset route. PURE read — never mutates (K8). */
export const listEscalations = async (opts?: {
  projectPath?: string
  status?: EscalationStatus
}): Promise<EscalationView[]> => {
  let items = await readTolerant()
  if (opts?.projectPath) {
    const canon = await canonicalize(opts.projectPath)
    items = items.filter((e) => e.projectPath === canon)
  }
  if (opts?.status) items = items.filter((e) => e.status === opts.status)
  items.sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0))
  return Promise.all(
    items.map(async (e): Promise<EscalationView> => {
      if (!e.screenshotRef || !isSafeShotRef(e.screenshotRef)) return e
      try {
        const screenshot = await readFile(e.screenshotRef, 'utf8')
        return { ...e, screenshot }
      } catch {
        return e // capture pruned / unreadable — the record still stands
      }
    }),
  )
}

/** STRICT receipt read for the overseer's S3/S10 fatal check: every receiptKey
 *  ever persisted for one project, whatever the record's status (open records
 *  would dedup anyway; answered/DISMISSED are exactly the ones whose receipt
 *  must outlive a restart). readTolerant is WRONG for that consumer: it folds
 *  every failure (EACCES/EMFILE/EIO, corrupt JSON) into [], which a fail-closed
 *  caller cannot tell from "no receipts" — and raising on that empty set would
 *  re-post already-dismissed fatals (the exact bug the receipt check exists to
 *  prevent). Same contract as {@link readForWrite}: ONLY ENOENT means
 *  "legitimately empty"; every other failure THROWS so the caller defers.
 *  Pure read — a corrupt file is left in place (the next WRITE owns the
 *  `.corrupt` quarantine); elements are matched on shape (receiptKey +
 *  projectPath), not {@link isEscalation}, so a record this build can't fully
 *  recognise (newer enum values after a rollback) still counts as receipted —
 *  the fail-closed direction. */
export const listEscalationReceiptKeys = async (projectPath: string): Promise<Set<string>> => {
  const canon = await canonicalize(projectPath)
  await ensureOpenGroundHome()
  let raw: string
  try {
    raw = await readFile(escalationsFile(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set()
    throw e
  }
  const parsed: unknown = JSON.parse(raw) // corrupt JSON THROWS — never reads as empty
  const items = (parsed as Partial<EscalationsState>)?.items
  if (!Array.isArray(items)) throw new Error('escalations file is not {items: []}')
  const keys = new Set<string>()
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const e = it as { receiptKey?: unknown; projectPath?: unknown }
    if (typeof e.receiptKey === 'string' && e.projectPath === canon) keys.add(e.receiptKey)
  }
  return keys
}

// ─── Open (raise a question) ──────────────────────────────────────────────────

export interface OpenEscalationInput {
  projectPath: string
  question: string
  /** Why this is being asked + what is at stake. Required — a question without
   *  stakes is not decidable at a glance (§8's "1 画面で判断できる粒度"). */
  context: string
  /** 平易文 for a non-programmer owner (①決めること ②選択肢 ③各選択の影響を
   *  生活言語で) — see {@link Escalation.plainQuestion}. Optional: template
   *  raisers (overseer S1/S2/S3/S5/S10, no-model) supply it; worker-derived
   *  question text arrives already-plain per the /order worker rules. */
  plainQuestion?: string
  whyEscalated: EscalationWhy
  /** See EscalationRecord.declineEffect — what answering B actually does. */
  declineEffect?: 'park' | 'drop-integration'
  /** Idempotency key; defaults to sha1(taskId|projectPath|normalized question). */
  receiptKey?: string
  taskId?: string
  branch?: string
  /** The blocked worker's ADDRESS. `runtime` picks which handle names it —
   *  absent ⇒ 'pty' ⇒ `terminalId`; 'sdk' ⇒ `sdkSessionId` (and `terminalId` is
   *  empty for such a worker, by the identity invariant in workerRuntime.ts).
   *  A raiser that knows a worker MUST pass all three the same way every other
   *  worker-touching call site in the engine does: omitting `runtime` on an SDK
   *  worker makes the record un-deliverable, and nothing anywhere says so. */
  runtime?: WorkerRuntimeKind
  terminalId?: string
  sdkSessionId?: string
  proxyDraft?: EscalationProxyDraft
}

export interface OpenEscalationDeps {
  /** DI for tests: the PTY-tail capture (default getTerminalScreen). */
  captureScreen?: (terminalId: string) => string | null
  /** DI for tests: the SDK evidence tail — the session's recent distilled events
   *  (default: the SDK runtime's own `recentOutput`, i.e. exactly the text the
   *  engine's classifier reads). A SEPARATE seam from `captureScreen` on purpose:
   *  the two are keyed by DIFFERENT ids, and one dep taking "an id" is precisely
   *  the shape that lets a caller hand the PTY arm an SDK session id. */
  captureSdk?: (sdkSessionId: string) => string | null
  /** DI for tests: the bell/OS-toast firer (default createSwarmInfoNotification). */
  notify?: (n: Parameters<typeof createSwarmInfoNotification>[0]) => Promise<unknown>
  now?: () => Date
}

/** The persisted ADDRESS of a blocked worker, normalized to the identity
 *  invariant: exactly one handle, plus the runtime that says which one it is.
 *
 *  Built ONCE, at the write boundary, so a record on disk can never carry an
 *  `sdkSessionId` from this incarnation next to a `terminalId` from the last one
 *  — a mixed record delivers to whichever the reader happens to look at first,
 *  which is the same "answered the wrong desk" failure as answering none.
 *  `runtime: 'pty'` is left OFF the record: absent already means pty everywhere,
 *  and writing it would make old and new records differ for no reason. */
const addressOf = (h: WorkerHandle): Pick<Escalation, 'runtime' | 'terminalId' | 'sdkSessionId'> =>
  workerRuntimeKind(h) === 'sdk'
    ? h.sdkSessionId
      ? { runtime: 'sdk', sdkSessionId: h.sdkSessionId.slice(0, MAX_ESCALATION_SHORT_FIELD) }
      : {} // 'sdk' with no session id names nothing — store no address at all
    : h.terminalId
      ? { terminalId: h.terminalId.slice(0, MAX_ESCALATION_SHORT_FIELD) }
      : {}

/** Does this address name a worker at all? (An escalation may legitimately have
 *  none — the overseer's project-level raises are not worker-rooted.) */
const hasAddress = (a: Pick<Escalation, 'terminalId' | 'sdkSessionId'>): boolean =>
  !!(a.terminalId || a.sdkSessionId)

/** The evidence tail for one worker, from ITS OWN runtime.
 *
 *  This used to be `if (input.terminalId) getTerminalScreen(...)`, which is the
 *  one-pool question in its purest form: an SDK worker has no terminalId, so its
 *  escalation reached the owner with NO record of what the worker was doing when
 *  it stopped — the single most useful thing on the card. The SDK runtime's
 *  `recentOutput` returns the real distilled event tail (tool calls, API errors,
 *  the text of the turn), which is the same string the engine's own classifier
 *  reads, so the owner sees the evidence the machine saw.
 *
 *  Best-effort by contract: null / a throw means "no evidence", NEVER "nothing
 *  was wrong" — a capture failure must not block the escalation itself. */
const captureEvidence = (h: WorkerHandle, deps?: OpenEscalationDeps): string | null => {
  try {
    if (workerRuntimeKind(h) === 'sdk') {
      const id = h.sdkSessionId
      if (!id) return null
      const cap =
        deps?.captureSdk ??
        ((sid: string) => runtimeOf(h).recentOutput({ runtime: 'sdk', sdkSessionId: sid }))
      return cap(id)
    }
    const id = h.terminalId
    if (!id) return null
    return (deps?.captureScreen ?? getTerminalScreen)(id)
  } catch {
    return null
  }
}

/** The default receiptKey: stable across restarts for "the same card asking the
 *  same thing" (whitespace/case wobble folded), distinct across cards/projects. */
export const defaultReceiptKey = (input: {
  projectPath: string
  taskId?: string
  question: string
}): string => {
  const norm = input.question.replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha1')
    .update(`${input.taskId ?? ''}|${input.projectPath}|${norm}`)
    .digest('hex')
}

/**
 * Raise a question to the real user: append one 'open' record (idempotent on
 * receiptKey while open), capture the worker's PTY tail when a terminal is
 * given, and fire the bell + OS toast. The notification is best-effort — the
 * persisted record is the escalation (§8 invariant 7).
 */
export const openEscalation = async (
  input: OpenEscalationInput,
  deps?: OpenEscalationDeps,
): Promise<{ escalation: Escalation; deduped: boolean }> => {
  const question = (input.question ?? '').trim().slice(0, MAX_ESCALATION_QUESTION)
  const context = (input.context ?? '').trim().slice(0, MAX_ESCALATION_CONTEXT)
  // Optional — empty collapses to "absent" so the UI's `plainQuestion ?? question`
  // fallback can never render a blank primary line.
  const plainQuestion = (input.plainQuestion ?? '').trim().slice(0, MAX_ESCALATION_PLAIN_QUESTION)
  if (!question) throw new Error('question is required')
  if (!context) throw new Error('context is required')
  if (!ESCALATION_WHYS.includes(input.whyEscalated)) throw new Error('invalid whyEscalated')
  // Canonical so the stored path matches the registry / engine key form.
  const projectPath = await canonicalize(input.projectPath)
  const receiptKey =
    (input.receiptKey ?? '').trim() ||
    defaultReceiptKey({ projectPath, taskId: input.taskId, question })

  const result = await enqueue(async (): Promise<{ escalation: Escalation; deduped: boolean }> => {
    await ensureOpenGroundHome()
    const { all, known } = await readForWrite()
    // Idempotency: while an OPEN record with this key exists IN THIS PROJECT,
    // re-raising is a no-op (existing record returned, nothing appended,
    // nothing re-toasted). Scoped by projectPath so an explicitly-supplied key
    // colliding across projects can never swallow another project's question.
    // Once it resolves (answered/dismissed), the same key may open anew — a
    // genuinely recurring question deserves a fresh row.
    const existing = known.find(
      (e) => e.receiptKey === receiptKey && e.status === 'open' && e.projectPath === projectPath,
    )
    if (existing) {
      // Refresh the WORKER COORDINATES on the dedup hit: a re-raise after a
      // worker respawn carries the LIVE worker's desk/branch — the answer must
      // target that one, not the dead desk recorded at first raise.
      let touched = false
      // The address is replaced WHOLESALE (runtime + both handles), never
      // field-by-field. A respawn can land on the OTHER runtime — the sdk dial
      // falling back to a PTY, or an sdk worker replacing a pty one — and merging
      // a fresh sdkSessionId into a record that still holds the old terminalId
      // leaves a record whose runtime and ids disagree. Field-by-field is also
      // how the pre-SDK version silently ignored an SDK re-raise entirely: it
      // only ever looked at `input.terminalId`, which is empty for those workers.
      const addr = addressOf(input)
      if (
        hasAddress(addr) &&
        (addr.runtime !== existing.runtime ||
          addr.terminalId !== existing.terminalId ||
          addr.sdkSessionId !== existing.sdkSessionId)
      ) {
        delete existing.runtime
        delete existing.terminalId
        delete existing.sdkSessionId
        Object.assign(existing, addr)
        touched = true
      }
      if (input.branch && input.branch !== existing.branch) {
        existing.branch = input.branch
        touched = true
      }
      if (touched) await persist(all)
      return { escalation: existing, deduped: true }
    }

    const id = randomUUID()
    const createdAt = (deps?.now?.() ?? new Date()).toISOString()

    // Evidence tail (§8 screenshotRef): what the blocked worker was doing when
    // the question was raised — its PTY screen, or an SDK session's recent event
    // transcript, asked of the worker's OWN runtime (see captureEvidence).
    // Best-effort — a capture failure never blocks the escalation itself.
    const address = addressOf(input)
    let screenshotRef: string | undefined
    if (hasAddress(address)) {
      try {
        const tail = captureEvidence(input, deps)?.trimEnd().slice(-MAX_ESCALATION_SHOT_CHARS)
        if (tail) {
          // Private like the inbox itself (0600/0700): the capture shows what a
          // worker was doing in the user's project — the most sensitive part of
          // the record must not be the only world-readable one.
          await mkdir(escalationShotsDir(), { recursive: true, mode: 0o700 })
          const shot = join(escalationShotsDir(), `${id}.txt`)
          await writeFile(shot, tail, { encoding: 'utf8', mode: 0o600 })
          screenshotRef = shot
        }
      } catch {
        /* best-effort */
      }
    }

    // Clamp the short/loosely-validated fields too (the routes 400 oversizes,
    // but this module is also called in-process): the inbox is uncapped, so
    // nothing unbounded may enter it.
    const proxyDraft = input.proxyDraft
      ? { ...input.proxyDraft, answer: input.proxyDraft.answer.slice(0, MAX_ESCALATION_ANSWER) }
      : undefined
    const escalation: Escalation = {
      id,
      receiptKey: receiptKey.slice(0, MAX_ESCALATION_SHORT_FIELD),
      createdAt,
      projectPath,
      ...(input.taskId ? { taskId: input.taskId.slice(0, MAX_ESCALATION_SHORT_FIELD) } : {}),
      ...(input.branch ? { branch: input.branch.slice(0, MAX_ESCALATION_SHORT_FIELD) } : {}),
      // ONE normalized address (runtime + the single handle it names), already
      // clamped — see addressOf. Never both ids.
      ...address,
      question,
      context,
      ...(plainQuestion ? { plainQuestion } : {}),
      ...(screenshotRef ? { screenshotRef } : {}),
      ...(proxyDraft ? { proxyDraft } : {}),
      whyEscalated: input.whyEscalated,
      // Narrowed, not trusted: an unknown value degrades to the safe default
      // ('park' = leave the card alone), never to the acting one.
      ...(input.declineEffect === 'drop-integration'
        ? { declineEffect: 'drop-integration' as const }
        : {}),
      status: 'open',
    }
    all.push(escalation)
    await persist(all)
    return { escalation, deduped: false }
  })

  if (!result.deduped) {
    // Fire AFTER the record is durably persisted; failure to notify is not
    // failure to escalate (the record IS the escalation).
    try {
      const notify = deps?.notify ?? createSwarmInfoNotification
      // The toast is an OWNER surface — lead with the plain-language text when
      // the raiser supplied one (same precedence as the inbox UI).
      const teaser = plainQuestion || question
      await notify({
        event: 'escalation-open',
        detail: `質問が届いています: ${teaser.length > 120 ? `${teaser.slice(0, 120)}…` : teaser}`,
        projectPath,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        escalationId: result.escalation.id,
      })
    } catch {
      /* best-effort — §8 invariant 7 */
    }
  }
  return result
}

// ─── Answer (the owner's decision → worker → memory) ─────────────────────────

/** The text pasted into the blocked worker's PTY when the owner answers. Pure +
 *  exported so the byte contract is unit-testable; C3 (free-text question
 *  detection) reuses this same helper — W16 is implemented ONCE, here.
 *
 *  `plainQuestion` — MISATTRIBUTION GUARD, load-bearing. An answer only means
 *  something next to the question it answered, and when a raiser supplied a
 *  plainQuestion THAT is what the owner read (the UI folds the technical
 *  `question` into a details pane). Pairing their reply with the technical
 *  original instead lets the worker re-bind it to its own wording: the routing
 *  lane makes this concrete — the worker asks an A/B technical menu, the owner is
 *  shown the routing question, and a reply meant for the routing question would
 *  land under the technical menu as if it picked an option there. So when a
 *  plainQuestion exists BOTH texts go in, explicitly labelled, and the answer
 *  hangs off the one the owner actually saw. (The word-not-letter choice tokens
 *  in swarmDecisionRouting are the other half of this fix; this side is the one
 *  that holds even when the owner answers in free text.) Same precedence the
 *  corpus write-back and the toast already use — this was the odd surface out.
 *
 *  NOTE (deliberate): the overseer's PROXY answers reuse this helper too
 *  (swarmOverseer's brain-result drain, swarmQuestions), so they also render
 *  `オーナーの回答:`. That is not a new claim — the 【本人からの回答】 header has always
 *  framed a proxy answer that way, and it matches the proxy's contract
 *  (`answerAsOwner`: answer AS the owner when the corpus grounds it, escalate
 *  otherwise). The line that must NOT blur is the corpus write-back, and that one
 *  is reached only from the owner-gated answer route — §8 invariant 6 holds. */
export const buildAnswerInjection = (
  question: string,
  answer: string,
  plainQuestion?: string,
): string =>
  [
    '【本人からの回答】エスカレーションした質問に、本人（オーナー）が回答しました。',
    ...(plainQuestion
      ? [
          `オーナーに表示された質問（下の回答はこれに対するものです）: ${plainQuestion}`,
          `あなたが出した元の質問: ${question}`,
        ]
      : [`Q: ${question}`]),
    // The answer is labelled in WORDS on BOTH branches, never `A:`. Escalation
    // questions carry an option list by design — the worker rules REQUIRE
    // 「②選択肢(A/B など)」 (swarmWorker.ts), and the overseer's templates render one —
    // so an `A:` answer prefix would sit next to an `A:` option meaning something
    // else entirely. The bare branch is not the safe one here: it is precisely the
    // lane that carries WORKER-authored questions, which have no template to render
    // a plainQuestion from and therefore always bring their own A/B menu.
    `オーナーの回答: ${answer}`,
    'この回答を前提に、ブロックされていた作業を再開してください。',
  ].join('\n')

// Control bytes that must never reach the PTY inside a paste: all C0 except
// \t/\n (kept — safe and meaningful inside a bracketed paste), DEL, and the C1
// range — an 8-bit CSI (0x9b) could end the paste span without any ESC byte,
// which pastePrompt's ESC-only strip would miss. \r is normalised to \n first
// (a raw CR inside the payload must never read as "submit").
// eslint-disable-next-line no-control-regex
const PASTE_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g

/** Sanitize untrusted-ish text for PTY paste injection. Exported for tests and
 *  for C3, whose question text will be WORKER-derived (untrusted). */
export const sanitizeForPaste = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(PASTE_CONTROL_BYTES, '')

/**
 * Guard: is this PTY one we may TYPE AN ANSWER INTO? Three独立 conditions:
 *  • it hosts a `claude` TUI (a plain user shell would EXECUTE the paste as
 *    commands — writeInput itself checks nothing but liveness);
 *  • no interactive menu is open (a bare CR into a permission prompt would
 *    CONFIRM its default — an approval the owner never made);
 *  • its cwd belongs to the SAME registered project as the escalation (a
 *    tampered/mis-set terminalId must not reach an unrelated live PTY). The
 *    comparison is by registry UUID, so a worker running in the project's
 *    central worktree matches its project.
 */
export const defaultCanInjectInto = async (
  terminalId: string,
  projectPath: string,
  deps?: {
    get?: typeof getTerminal
    uuidOf?: typeof projectUUIDFromPath
  },
): Promise<boolean> => {
  const get = deps?.get ?? getTerminal
  const uuidOf = deps?.uuidOf ?? projectUUIDFromPath
  const t = get(terminalId)
  if (!t || t.tag !== 'claude' || t.menuOpen) return false
  try {
    const [a, b] = await Promise.all([uuidOf(t.cwd), uuidOf(projectPath)])
    return a === b
  } catch {
    return false // either side unresolvable → refuse (fail-closed)
  }
}

/** Is (the head of) the pasted text still sitting in the INPUT BOX — i.e. the
 *  submitting Enter was swallowed? Only the LAST `❯` prompt row plus its
 *  wrapped continuation (down to the closing rule / end of frame) is searched:
 *  after a successful submit the same text reappears ABOVE as a
 *  conversation-log row, which must NOT read as residue. Whitespace is
 *  stripped from both haystack and needle so TUI wrapping/padding can't hide
 *  a match. No prompt row / no usable needle ⇒ false (nothing provably
 *  pending — callers treat that as landed). */
export const pasteStillInInputBox = (screen: string, pastedText: string): boolean => {
  const firstLine = pastedText
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  const needle = (firstLine ?? '').replace(/\s+/g, '').slice(0, 24)
  if (!needle) return false
  const rows = screen.split('\n')
  let prompt = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^\s*❯/.test(rows[i])) {
      prompt = i
      break
    }
  }
  if (prompt < 0) return false
  const zone: string[] = [rows[prompt].replace(/^\s*❯/, '')]
  for (let i = prompt + 1; i < rows.length; i++) {
    if (/^\s*[─━]{6,}\s*$/.test(rows[i])) break
    zone.push(rows[i])
  }
  return zone.join('').replace(/\s+/g, '').includes(needle)
}

/**
 * W16 — the shared PTY answer-injection helper (owned by C1; C3 reuses it).
 * Sanitized bracketed paste (control bytes stripped here, ESC re-stripped by
 * pastePrompt.ts — the payload can never close the paste span early), then —
 * after a short settle delay — a bare CR to submit, then a bounded
 * landing-confirmation loop (C3): scrape the screen and, while the pasted text
 * still sits unsent in the input box, re-send the CR (a CR racing the TUI's
 * paste processing gets swallowed — the tmux-era "trailing Enter" trap).
 * Returns true only when the writes landed AND the paste is no longer pending
 * (working footer visible, or the input box free of the pasted text; a scrape
 * that yields no frame keeps the pre-C3 both-writes-landed contract). false
 * lets the caller fall back to the next-dispatch queue. Callers are
 * responsible for the TARGETING guard ({@link defaultCanInjectInto}) — this
 * helper only delivers.
 */
export const injectAnswerIntoWorker = async (
  terminalId: string,
  text: string,
  deps?: {
    write?: typeof writeInput
    sleep?: (ms: number) => Promise<void>
    /** DI for tests: the landing-check scrape (default getTerminalScreen). */
    readScreen?: (id: string) => string | null
  },
): Promise<boolean> => {
  const write = deps?.write ?? writeInput
  const sleep =
    deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const readScreen = deps?.readScreen ?? getTerminalScreen
  const payload = sanitizeForPaste(text)
  if (!write(terminalId, bracketedPaste(payload))) return false
  await sleep(ESCALATION_ENTER_DELAY_MS)
  if (!write(terminalId, '\r')) return false
  for (let attempt = 0; ; attempt++) {
    await sleep(ENTER_RETRY_INTERVAL_MS)
    let screen: string | null = null
    try {
      screen = readScreen(terminalId)
    } catch {
      screen = null
    }
    if (screen === null) return true // no frame to judge by — both writes landed
    if (WORKING_FOOTER_RE.test(screen)) return true // generating ⇒ landed
    if (!pasteStillInInputBox(screen, payload)) return true // box clear ⇒ landed
    if (attempt >= ENTER_RETRY_MAX) return false // still pending after N resends
    if (!write(terminalId, '\r')) return false // PTY died mid-retry
  }
}

/**
 * Guard: may we push a turn into this SDK session? The SDK counterpart of
 * {@link defaultCanInjectInto}, and deliberately SHORTER — two of that guard's
 * three conditions do not exist on this runtime, and saying so is the point:
 *  • "it hosts a `claude` TUI" — an SDK session IS a `claude` conversation by
 *    construction (there is no shell to hand a command line to);
 *  • "no interactive menu is open" — there is no menu, and no bare CR that could
 *    confirm one; a pushed turn is a message, never a keystroke.
 * What DOES carry over is the third and only security-relevant one: the session
 * must belong to the SAME registered project as the escalation, compared by
 * registry UUID so a worker running in the project's central worktree matches.
 *
 * ⚠ LIVENESS IS `isSdkSessionLive`, NEVER `status`. `terminateSdkSession` flips
 * status to 'exited' synchronously while the claude behind it is still unwinding;
 * a status-based guard would refuse to deliver an answer to a session that is
 * still perfectly able to take one (and, on the other seams, authorise deleting
 * its worktree). Delivery itself is still gated by `pushSdkInput`, which refuses
 * a session that has actually been closed — so this is the containment check,
 * not a second liveness opinion.
 */
export const defaultCanPushIntoSdkWorker = async (
  sdkSessionId: string,
  projectPath: string,
  deps?: {
    get?: typeof getSdkSession
    uuidOf?: typeof projectUUIDFromPath
  },
): Promise<boolean> => {
  const get = deps?.get ?? getSdkSession
  const uuidOf = deps?.uuidOf ?? projectUUIDFromPath
  const s = get(sdkSessionId)
  if (!s || !isSdkSessionLive(s)) return false
  try {
    const [a, b] = await Promise.all([uuidOf(s.cwd), uuidOf(projectPath)])
    return a === b
  } catch {
    return false // either side unresolvable → refuse (fail-closed)
  }
}

export interface DeliverAnswerDeps {
  write?: typeof writeInput
  sleep?: (ms: number) => Promise<void>
  readScreen?: (id: string) => string | null
  /** DI for tests: the PTY targeting guard (default {@link defaultCanInjectInto}). */
  canInjectInto?: (terminalId: string, projectPath: string) => Promise<boolean>
  /** DI for tests: the SDK targeting guard (default {@link defaultCanPushIntoSdkWorker}). */
  canPushInto?: (sdkSessionId: string, projectPath: string) => Promise<boolean>
  /** DI for tests: the SDK delivery (default `pushSdkInput`). */
  push?: (sdkSessionId: string, text: string) => boolean
}

/**
 * THE answer conduit to a live worker, whatever runtime carries it — guard and
 * delivery in one call, so no caller has to know that the two runtimes need
 * different bytes.
 *
 * WHY THIS EXISTS. Every path that answers a blocked worker — the owner's inbox
 * answer ({@link deliverAnswer}) and the overseer's proxy answer (swarmOverseer's
 * brain-result drain) — was written as `canInjectInto(terminalId) &&
 * injectAnswerIntoWorker(terminalId)`. An SDK worker's terminalId is EMPTY by the
 * identity invariant (workerRuntime.ts), so for those workers both calls were a
 * silent no-op: the proxy's answer was reported as "injection failed" and thrown
 * back at the owner on EVERY pass, and an answer the owner actually typed reached
 * the worker never. Not a degraded path — a path that could not fire once.
 *
 * The two deliveries are genuinely different mechanisms, and that is the whole
 * reason this is a seam rather than a shared string:
 *  • PTY — bracketed paste, a settle delay, a submitting CR, then a bounded
 *    landing check that re-sends the CR while the text still sits unsent
 *    ({@link injectAnswerIntoWorker}). None of it can confirm more than "the
 *    writes landed on a live pty".
 *  • SDK — one queued turn. Accepted synchronously, mid-turn is fine (the CLI
 *    queues it), and there is no input box to clear, no draft to erase, and no
 *    Enter to be swallowed.
 *
 * Returns whether the worker actually received it; false lets the caller fall
 * back (the inbox, or the card's next-dispatch queue).
 */
export const deliverAnswerToWorker = async (
  target: WorkerHandle,
  projectPath: string,
  text: string,
  deps?: DeliverAnswerDeps,
): Promise<boolean> => {
  if (workerRuntimeKind(target) === 'sdk') {
    const id = target.sdkSessionId
    // No handle ⇒ nothing to deliver to. Deliberately NOT `workerKey(target)`:
    // that throws, and a missing handle here must degrade to the caller's
    // fallback (inbox / next dispatch), not blow up an answer already recorded.
    if (!id) return false
    if (!(await (deps?.canPushInto ?? defaultCanPushIntoSdkWorker)(id, projectPath))) return false
    return (deps?.push ?? pushSdkInput)(id, text)
  }
  const id = target.terminalId
  if (!id) return false
  if (!(await (deps?.canInjectInto ?? defaultCanInjectInto)(id, projectPath))) return false
  return injectAnswerIntoWorker(id, text, deps)
}

export interface AnswerEscalationDeps {
  write?: typeof writeInput
  sleep?: (ms: number) => Promise<void>
  /** DI for tests: the PTY landing check ({@link injectAnswerIntoWorker} re-reads
   *  the worker's frame to decide whether the submitting CR landed; default
   *  `getTerminalScreen`).
   *
   *  ⚠ Declared because this type is passed WHOLE to {@link deliverAnswerToWorker}
   *  as its {@link DeliverAnswerDeps} — so a `readScreen` handed to
   *  `answerEscalation` already reached the landing check STRUCTURALLY, through a
   *  field this interface did not admit existed. Callers were relying on an
   *  undeclared dep: TypeScript's excess-property check only fires on object
   *  LITERALS, so every test that built its seam bag in a helper (the normal
   *  shape) passed silently, while inlining the same bag would have failed to
   *  compile. Declaring it makes the contract the callers already use the one the
   *  type states. */
  readScreen?: (id: string) => string | null
  /** DI for tests: the you-corpus write-back (default appendJudgment). */
  appendMemory?: (input: { text: string; tags?: string[]; context?: string }) => Promise<unknown>
  /** DI for tests: the worker-gone fallback (default: the engine's rework-reason
   *  slot via a lazy import — lazy so swarmOrchestrator can import THIS module
   *  later (C-core, T3) without a static cycle). */
  queueForNextDispatch?: (
    projectPath: string,
    taskId: string,
    line: string,
    opts?: { workerAddressed?: boolean; answer?: string },
  ) => Promise<void>
  /** DI for tests: the registry allowlist check (default validateProjectPath). */
  isPathAllowed?: (p: string) => Promise<boolean>
  /** DI for tests: execute a declared 「見送る」 (default
   *  {@link import('./swarmOrchestrator').abandonCardIntegration}). Declared here
   *  so a test can observe the ARGUMENTS; the board effect itself is pinned in
   *  swarmOrchestrator's own suite, where the fake board can be read back. */
  dropIntegration?: (
    projectPath: string,
    taskId: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  /** DI for tests: the PTY injection-target guard (default {@link defaultCanInjectInto}). */
  canInjectInto?: (terminalId: string, projectPath: string) => Promise<boolean>
  /** DI for tests: the SDK targeting guard (default {@link defaultCanPushIntoSdkWorker}).
   *  Present here, and not only on {@link DeliverAnswerDeps}, because the owner's
   *  answer route reaches the SDK arm THROUGH this type — a test that can only
   *  inject the PTY seams can only ever exercise the PTY half. */
  canPushInto?: (sdkSessionId: string, projectPath: string) => Promise<boolean>
  /** DI for tests: the SDK delivery (default `pushSdkInput`). */
  push?: (sdkSessionId: string, text: string) => boolean
  now?: () => Date
}

/** The delivery leg, shared by the first answer and a re-delivery retry:
 *  inject into the live worker PTY ('injected'), or queue for the card's next
 *  dispatch, or skip when there is nothing to deliver to. The record must
 *  already carry `answer`.
 *
 *  MUST RUN OUTSIDE THE CHAIN (see the LOCK ORDER note above): the `queued` lane
 *  calls into swarmOrchestrator, which takes L2 — holding L1 across that is the
 *  deadlock. This function therefore does NOT persist; it only reports what it
 *  did. The caller re-enters the chain via {@link markInjected} to record an
 *  'injected' promotion, so the write is a fresh read-modify-write of one field
 *  rather than a write-back of a now-stale array. */
const deliverAnswer = async (
  record: Escalation,
  deps: AnswerEscalationDeps | undefined,
): Promise<EscalationDelivery> => {
  const answer = record.answer ?? ''
  // Registry re-check: a project removed since the question was raised must
  // not be injected into (records only ever store validated paths, but the
  // registry may have shrunk since).
  const isPathAllowed = deps?.isPathAllowed ?? isValidProjectPath
  if (!(await isPathAllowed(record.projectPath))) return 'skipped'

  // Delivery goes through the RUNTIME-AGNOSTIC conduit, which carries the target
  // guard with it (see {@link deliverAnswerToWorker}): a PTY worker gets the
  // bracketed paste + Enter + landing check, an SDK worker gets a queued turn,
  // and this call site does not have to know which.
  //
  // The handle is rebuilt from the record's PERSISTED ADDRESS — `runtime` decides
  // which id names the worker, exactly as {@link addressOf} wrote it. Reading the
  // record's `runtime` (rather than "whichever id is truthy") is what keeps a
  // record that somehow carries both from delivering to the stale one. Records
  // written before `runtime` existed have none, which resolves to 'pty' — the
  // only thing they could ever have been.
  const target: WorkerHandle = {
    ...(record.runtime ? { runtime: record.runtime } : {}),
    ...(record.terminalId ? { terminalId: record.terminalId } : {}),
    ...(record.sdkSessionId ? { sdkSessionId: record.sdkSessionId } : {}),
  }
  if (
    await deliverAnswerToWorker(
      target,
      record.projectPath,
      buildAnswerInjection(record.question, answer, record.plainQuestion),
      deps,
    )
  ) {
    // The 'injected' PROMOTION is persisted by the caller (markInjected) — this
    // leg runs outside the chain and must not write the array it never read.
    record.status = 'injected'
    record.injectedAt = (deps?.now?.() ?? new Date()).toISOString()
    return 'injected'
  }
  if (record.taskId) {
    // Worker gone (or not injectable) → ride the learning-loop slot so the
    // NEXT dispatch of this card carries the owner's decision
    // (engine.reworkReasons → /order). Lazy import to stay cycle-free with
    // swarmOrchestrator. Q/A are shortened here — the /order goal is ONE
    // argv-bound line; the full text stays on this record.
    //
    // Carries the SAME attribution as the live injection above: the next
    // dispatch is just a later delivery of the same answer, so a plainQuestion
    // record must not lose the question the owner read on the way (that was the
    // second half of the misattribution — the queued lane re-introduced it).
    const queue =
      deps?.queueForNextDispatch ??
      (await import('./swarmOrchestrator')).recordEscalationAnswerForNextDispatch
    // Fold whitespace BEFORE clamping: a plainQuestion is a multi-line block, so
    // folding first spends the budget on words rather than on newlines. (The
    // receiver folds again — this keeps the "ONE argv-bound line" promise true
    // here, where it is written, instead of borrowing it from the callee.)
    const brief = (s: string, n: number) => {
      const flat = s.replace(/\s+/g, ' ').trim()
      return flat.length > n ? `${flat.slice(0, n)}…` : flat
    }
    // Did a WORKER ever ask this? The record's persisted address is the answer:
    // an S4 worker question carries one, an overseer/board raise (S1/S5 — "this
    // card has been stuck, what should I do?") carries none. Passed through
    // because the receiver's unpark is only meaningful in the first case: for a
    // card nobody was working on, 'blocked' is the OWNER's placement and an
    // answer like 「このまま保留」 must not move it (cycle-3 finding — the
    // owner's "leave it" was itself moving the card).
    const workerAddressed = !!(record.terminalId || record.sdkSessionId)
    await queue(
      record.projectPath,
      record.taskId,
      record.plainQuestion
        ? `オーナーに表示された質問(回答はこれに対するもの): ${brief(record.plainQuestion, 400)} / あなたが出した元の質問: ${brief(record.question, 300)} → オーナーの回答: ${brief(answer, 600)} — この回答を前提に再開すること`
        : // `オーナーの回答:` here too — and this branch needs it MOST. It is the lane
          // that carries worker-authored questions (which always bring their own A/B
          // menu), and `brief()` folds the menu onto this single line, so an `A:`
          // answer label would sit inline next to the question's own `A: …`.
          `Q: ${brief(record.question, 600)} → オーナーの回答: ${brief(answer, 900)} — この回答を前提に再開すること`,
      // ⚠ THE ANSWER GOES SEPARATELY. `line` is question+answer CONCATENATED —
      // and the question carries the menu ("A: … B: …"), so a receiver that
      // parses the owner's choice out of `line` reads the QUESTION's first
      // option every time (measured 2026-08-04: 「B: このまま保留」 resolved as
      // resume, and the card moved anyway). The line stays what the worker
      // reads; the choice is read from the answer alone.
      { workerAddressed, answer },
    )
    return 'queued'
  }
  return 'skipped'
}

/**
 * The owner answers an escalation. Ordered for crash-safety: (1) persist the
 * answer ('answered') FIRST, (2) write the Q→A back to you-corpus memory
 * (owner answers only — best-effort, never blocks the unblock), (3) deliver
 * (see {@link deliverAnswer}). Lifecycle edges: answering a DISMISSED record is
 * a state error; re-answering an INJECTED record is an idempotent no-op; and
 * re-answering an ANSWERED (not yet injected) record retries the DELIVERY leg
 * only — the recorded first answer stands — so a crash (or a dead PTY) between
 * "answered" and delivery is recoverable instead of a dead end.
 */
export const answerEscalation = async (
  id: string,
  answer: string,
  deps?: AnswerEscalationDeps,
): Promise<{ escalation: Escalation; delivery: EscalationDelivery; memoryWritten: boolean }> => {
  const text = (answer ?? '').trim().slice(0, MAX_ESCALATION_ANSWER)
  if (!text) throw new Error('answer is required')

  // PHASE 1 — under the chain (L1): validate + persist + learn. File
  // read-modify-write ONLY; nothing here may reach the orchestrator (L2).
  // Returns either a finished answer, or the record that still needs delivering.
  const staged = await enqueue(async (): Promise<
    | { done: true; escalation: Escalation; delivery: EscalationDelivery; memoryWritten: boolean }
    | { done: false; record: Escalation; memoryWritten: boolean }
  > => {
    await ensureOpenGroundHome()
    const { all, known } = await readForWrite()
    const record = known.find((e) => e.id === id)
    if (!record) throw new EscalationNotFoundError(id)
    if (record.status === 'dismissed') {
      throw new EscalationStateError('escalation was dismissed — reopen it by raising it again')
    }
    if (record.status === 'injected') {
      // Fully delivered — nothing to redo (the first answer is already inside
      // the worker's context).
      return { done: true, escalation: record, delivery: 'skipped' as const, memoryWritten: false }
    }
    if (record.status === 'answered') {
      // RE-DELIVERY: the decision is already recorded (and learned); a re-POST
      // retries only the delivery leg. Without this escape hatch an 'answered'
      // record whose delivery was lost (crash / dead PTY at first attempt)
      // would be a permanent dead end behind the idempotent no-op.
      return { done: false, record, memoryWritten: false }
    }

    // (1) Persist the answer FIRST — a crash below never loses the decision.
    record.answer = text
    record.answeredAt = (deps?.now?.() ?? new Date()).toISOString()
    record.status = 'answered'
    await persist(all)

    // (2) Memory write-back — the proxy-you training pipeline. OWNER answers
    // only (this function is reached only via the owner-gated route / the
    // owner's UI). Best-effort: a corpus failure must not block the worker.
    let memoryWritten = false
    try {
      const appendMemory = deps?.appendMemory ?? appendJudgment
      // Learn the question the owner ACTUALLY ANSWERED. When a raiser supplied a
      // plainQuestion it is what the UI shows as the primary text (the technical
      // `question` is folded into a details pane), so pairing their answer with
      // the technical original would MISATTRIBUTE it. The routing question makes
      // the hazard concrete: it asks "is this yours to decide?", and if its choices
      // were bare letters (they are not — swarmDecisionRouting uses WORDS precisely
      // for this reason) an "A" recorded against "which library should we use?"
      // would read to the next brain as the owner picking library A — the exact
      // inversion this routing layer exists to prevent. The technical text is not lost:
      // it stays verbatim on the escalation record (and in the injection the
      // worker receives, which correctly keeps the technical wording).
      await appendMemory({
        // `→ オーナーの回答:` not `→ A:` — same reason as the injection above. This
        // is the surface the BRAIN reads back live, so an answer sitting under an
        // `A:` prefix next to the question's own `A: …` option is the misreading
        // this card exists to prevent, one level further downstream.
        text: `Q: ${record.plainQuestion || record.question}\n→ オーナーの回答: ${text}`,
        tags: ['escalation', record.whyEscalated],
        ...(record.branch || record.taskId
          ? { context: `swarm escalation (${record.branch ?? record.taskId})` }
          : { context: 'swarm escalation' }),
      })
      memoryWritten = true
    } catch {
      /* best-effort — reported via memoryWritten */
    }

    return { done: false, record, memoryWritten }
  })

  if (staged.done) {
    return {
      escalation: staged.escalation,
      delivery: staged.delivery,
      memoryWritten: staged.memoryWritten,
    }
  }

  // PHASE 2 — the chain is RELEASED. Only now may we touch the PTY or the
  // orchestrator (L2). The answer is already durable on disk, so a crash here
  // loses nothing: the record sits at 'answered' and the re-delivery escape
  // hatch above retries this leg.
  const { record, memoryWritten } = staged

  // PHASE 2a — EXECUTE THE DECLARED DECLINE, before (and independently of)
  // delivery. If the raiser said B means 「この作業は見送る」 and the owner chose
  // B, the work must stop being integratable — that is the whole point of the
  // question, and it must not depend on whether a worker was still around to
  // receive a message. Placed before deliverAnswer for exactly that reason: the
  // delivery lane can legitimately end in 'skipped'.
  //
  // ⚠ The CHOICE is read from the answer; the EFFECT comes from the record. The
  // parser only has to tell A from B (readUnparkIntent already does), and the
  // meaning of B is whatever the raiser declared.
  if (record.declineEffect === 'drop-integration' && record.taskId) {
    const { readUnparkIntent, abandonCardIntegration } = await import('./swarmOrchestrator')
    if (readUnparkIntent(text) === 'hold') {
      const res = await (deps?.dropIntegration ?? abandonCardIntegration)(
        record.projectPath,
        record.taskId,
      ).catch(() => ({ ok: false, reason: 'write-failed' as const }))
      if (!res.ok) {
        // Say so in the record's own lane rather than swallowing it: the owner
        // decided something irreversible-adjacent and it did not take.
        // eslint-disable-next-line no-console
        console.warn(
          `[swarmEscalations] 見送りを実行できませんでした (${res.reason}): card=${record.taskId}`,
        )
      }
    }
  }

  if (deliveringIds.has(record.id)) {
    // A delivery for this very record is in flight; a second bracketed paste
    // would interleave inside the same worker's prompt. The first one stands.
    return { escalation: record, delivery: 'skipped' as const, memoryWritten }
  }
  deliveringIds.add(record.id)
  let delivery: EscalationDelivery
  try {
    delivery = await deliverAnswer(record, deps)
  } finally {
    deliveringIds.delete(record.id)
  }
  // PHASE 3 — record the promotion, back under the chain, as a fresh
  // read-modify-write of the ONE field (see markInjected).
  if (delivery === 'injected' && record.injectedAt) {
    await markInjected(record.id, record.injectedAt).catch(() => {})
  }
  return { escalation: record, delivery, memoryWritten }
}

// ─── Dismiss (close unanswered) ───────────────────────────────────────────────

/** The owner closes an OPEN question without answering: nothing is injected,
 *  nothing is learned. Idempotent on already-resolved records (returned as-is —
 *  an answered record is NOT retroactively dismissed). */
export const dismissEscalation = async (
  id: string,
  deps?: { now?: () => Date },
): Promise<Escalation> => {
  return enqueue(async () => {
    await ensureOpenGroundHome()
    const { all, known } = await readForWrite()
    const record = known.find((e) => e.id === id)
    if (!record) throw new EscalationNotFoundError(id)
    if (record.status !== 'open') return record
    record.status = 'dismissed'
    record.dismissedAt = (deps?.now?.() ?? new Date()).toISOString()
    await persist(all)
    return record
  })
}

// ─── Retention (boot sweep — W17) ────────────────────────────────────────────

/** Prune RESOLVED records (answered/injected/dismissed) older than
 *  {@link ESCALATION_RETENTION_DAYS}, unlinking their PTY-tail captures.
 *  'open' records are NEVER pruned regardless of age — the fail-closed
 *  invariant lives here as much as in the state machine. Returns the number
 *  of records removed. */
export const pruneResolvedEscalations = async (opts?: { now?: number }): Promise<number> => {
  const now = opts?.now ?? Date.now()
  const cutoff = now - ESCALATION_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return enqueue(async () => {
    await ensureOpenGroundHome()
    const { all, known } = await readForWrite()
    const drop = new Set<Escalation>()
    for (const e of known) {
      if (e.status === 'open') continue // fail-closed: never prune an unanswered question
      const resolvedAt = Date.parse(e.answeredAt ?? e.dismissedAt ?? e.createdAt)
      if (!Number.isNaN(resolvedAt) && resolvedAt < cutoff) drop.add(e)
    }
    if (drop.size === 0) return 0
    // `known` shares element references with `all`, so identity filtering keeps
    // every unknown/foreign element in place.
    await persist(all.filter((x) => !drop.has(x as Escalation)))
    for (const e of Array.from(drop)) {
      if (e.screenshotRef && isSafeShotRef(e.screenshotRef)) {
        try {
          await unlink(e.screenshotRef)
        } catch {
          /* best-effort */
        }
      }
    }
    return drop.size
  })
}
