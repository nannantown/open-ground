// swarmEscalations — the Escalations inbox (C1 of the overseer EPIC; spec:
// docs/OVERSEER_DESIGN.md §8). The HUMAN VALVE of the unmanned swarm: when the
// overseer (or, until C-core lands, a manual API caller) hits a question that is
// IRREVERSIBLE or beyond the proxy's knowledge, it lands here instead of being
// auto-answered — {question, context/stakes, the proxy's provisional answer,
// why it was raised, the blocked worker's coordinates, a PTY-tail capture} —
// and the REAL user answers it. The answer is (1) injected into the blocked
// worker's live PTY so it resumes, or queued for the card's next dispatch when
// the worker is gone, and (2) written back to you-corpus memory (owner Q→A
// only) — the proxy-you training pipeline.
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
import { ensureOpenGroundHome, escalationsFile, escalationShotsDir } from './paths'
import { atomicWriteJson } from './atomicWrite'
import { getTerminal, getTerminalScreen, writeInput } from './terminal'
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
/** Clamp for id-like fields (receiptKey / taskId / branch / terminalId). */
export const MAX_ESCALATION_SHORT_FIELD = 512
/** The worker-gone fallback rides the /order goal line of the card's NEXT
 *  dispatch (one slash-command argument) — clamp what we contribute so a long
 *  answer can't blow the goal size / Windows argv ceiling. The FULL answer
 *  stays on the escalation record. */
export const MAX_ESCALATION_ORDER_LINE = 2000
/** PTY-tail capture clamp — the LAST N chars of the worker's screen. */
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
 *  live frames 2026-07-06; the idle counterpart is "? for shortcuts".) */
export const CLAUDE_WORKING_FOOTER_RE = /esc to interrupt/i

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
  whyEscalated: EscalationWhy
  /** Idempotency key; defaults to sha1(taskId|projectPath|normalized question). */
  receiptKey?: string
  taskId?: string
  branch?: string
  terminalId?: string
  proxyDraft?: EscalationProxyDraft
}

export interface OpenEscalationDeps {
  /** DI for tests: the PTY-tail capture (default getTerminalScreen). */
  captureScreen?: (terminalId: string) => string | null
  /** DI for tests: the bell/OS-toast firer (default createSwarmInfoNotification). */
  notify?: (n: Parameters<typeof createSwarmInfoNotification>[0]) => Promise<unknown>
  now?: () => Date
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
      // worker respawn carries the LIVE worker's terminal/branch — the answer
      // must target that one, not the dead PTY recorded at first raise.
      let touched = false
      if (input.terminalId && input.terminalId !== existing.terminalId) {
        existing.terminalId = input.terminalId
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

    // PTY-tail capture (§8 screenshotRef): what the blocked worker's screen
    // showed when the question was raised. Best-effort — a capture failure
    // never blocks the escalation itself.
    let screenshotRef: string | undefined
    if (input.terminalId) {
      try {
        const capture = deps?.captureScreen ?? getTerminalScreen
        const tail = capture(input.terminalId)?.trimEnd().slice(-MAX_ESCALATION_SHOT_CHARS)
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
      ...(input.terminalId
        ? { terminalId: input.terminalId.slice(0, MAX_ESCALATION_SHORT_FIELD) }
        : {}),
      question,
      context,
      ...(screenshotRef ? { screenshotRef } : {}),
      ...(proxyDraft ? { proxyDraft } : {}),
      whyEscalated: input.whyEscalated,
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
      await notify({
        event: 'escalation-open',
        detail: `質問が届いています: ${question.length > 120 ? `${question.slice(0, 120)}…` : question}`,
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
 *  detection) reuses this same helper — W16 is implemented ONCE, here. */
export const buildAnswerInjection = (question: string, answer: string): string =>
  [
    '【本人からの回答】エスカレーションした質問に、本人（オーナー）が回答しました。',
    `Q: ${question}`,
    `A: ${answer}`,
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
    if (CLAUDE_WORKING_FOOTER_RE.test(screen)) return true // generating ⇒ landed
    if (!pasteStillInInputBox(screen, payload)) return true // box clear ⇒ landed
    if (attempt >= ENTER_RETRY_MAX) return false // still pending after N resends
    if (!write(terminalId, '\r')) return false // PTY died mid-retry
  }
}

export interface AnswerEscalationDeps {
  write?: typeof writeInput
  sleep?: (ms: number) => Promise<void>
  /** DI for tests: the you-corpus write-back (default appendJudgment). */
  appendMemory?: (input: { text: string; tags?: string[]; context?: string }) => Promise<unknown>
  /** DI for tests: the worker-gone fallback (default: the engine's rework-reason
   *  slot via a lazy import — lazy so swarmOrchestrator can import THIS module
   *  later (C-core, T3) without a static cycle). */
  queueForNextDispatch?: (projectPath: string, taskId: string, line: string) => Promise<void>
  /** DI for tests: the registry allowlist check (default validateProjectPath). */
  isPathAllowed?: (p: string) => Promise<boolean>
  /** DI for tests: the injection-target guard (default {@link defaultCanInjectInto}). */
  canInjectInto?: (terminalId: string, projectPath: string) => Promise<boolean>
  now?: () => Date
}

/** The delivery leg, shared by the first answer and a re-delivery retry:
 *  inject into the live worker PTY ('injected', persisting the promotion), or
 *  queue for the card's next dispatch, or skip when there is nothing to
 *  deliver to. The record must already carry `answer`. */
const deliverAnswer = async (
  all: unknown[],
  record: Escalation,
  deps: AnswerEscalationDeps | undefined,
): Promise<EscalationDelivery> => {
  const answer = record.answer ?? ''
  // Registry re-check: a project removed since the question was raised must
  // not be injected into (records only ever store validated paths, but the
  // registry may have shrunk since).
  const isPathAllowed = deps?.isPathAllowed ?? isValidProjectPath
  if (!(await isPathAllowed(record.projectPath))) return 'skipped'

  // Target guard BEFORE any byte reaches the PTY: only a live `claude` TUI,
  // with no menu open, belonging to this record's project (see
  // defaultCanInjectInto for why each condition is load-bearing).
  const canInject = deps?.canInjectInto ?? defaultCanInjectInto
  if (
    record.terminalId &&
    (await canInject(record.terminalId, record.projectPath)) &&
    (await injectAnswerIntoWorker(
      record.terminalId,
      buildAnswerInjection(record.question, answer),
      deps,
    ))
  ) {
    record.status = 'injected'
    record.injectedAt = (deps?.now?.() ?? new Date()).toISOString()
    await persist(all)
    return 'injected'
  }
  if (record.taskId) {
    // Worker gone (or not injectable) → ride the learning-loop slot so the
    // NEXT dispatch of this card carries the owner's decision
    // (engine.reworkReasons → /order). Lazy import to stay cycle-free with
    // swarmOrchestrator. Q/A are shortened here — the /order goal is ONE
    // argv-bound line; the full text stays on this record.
    const queue =
      deps?.queueForNextDispatch ??
      (await import('./swarmOrchestrator')).recordEscalationAnswerForNextDispatch
    const brief = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
    await queue(
      record.projectPath,
      record.taskId,
      `Q: ${brief(record.question, 600)} → A: ${brief(answer, 900)} — この回答を前提に再開すること`,
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

  return enqueue(async () => {
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
      return { escalation: record, delivery: 'skipped' as const, memoryWritten: false }
    }
    if (record.status === 'answered') {
      // RE-DELIVERY: the decision is already recorded (and learned); a re-POST
      // retries only the delivery leg. Without this escape hatch an 'answered'
      // record whose delivery was lost (crash / dead PTY at first attempt)
      // would be a permanent dead end behind the idempotent no-op.
      const delivery = await deliverAnswer(all, record, deps)
      return { escalation: record, delivery, memoryWritten: false }
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
      await appendMemory({
        text: `Q: ${record.question}\n→ A: ${text}`,
        tags: ['escalation', record.whyEscalated],
        ...(record.branch || record.taskId
          ? { context: `swarm escalation (${record.branch ?? record.taskId})` }
          : { context: 'swarm escalation' }),
      })
      memoryWritten = true
    } catch {
      /* best-effort — reported via memoryWritten */
    }

    // (3) Deliver.
    const delivery = await deliverAnswer(all, record, deps)
    return { escalation: record, delivery, memoryWritten }
  })
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
