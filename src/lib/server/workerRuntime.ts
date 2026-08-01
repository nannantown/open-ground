// workerRuntime — the ONE seam between the swarm engine's brain and HOW a
// worker's `claude` is actually running.
//
// WHY THIS EXISTS. The engine's dispatch / roster / integration / quota logic
// does not care whether a worker is a PTY hosting an interactive `claude` or an
// Agent SDK session. It only needs a handful of facts about it: is it alive,
// what is it saying, stop it, talk to it. Today every one of those is a direct
// call into the node-pty pool, which is why adding a second way to run a worker
// would otherwise mean scattering `if (runtime === 'sdk')` through a 10k-line
// orchestrator. Everything runtime-specific goes behind this interface instead.
//
// SCOPE OF THIS FILE TODAY: the interface plus the PTY implementation, which is
// a pure delegation to the functions the orchestrator already called. That is
// deliberate — this step must be BEHAVIOUR-NEUTRAL, and the existing swarm test
// suite passing unchanged is the proof. The SDK implementation lands separately
// (docs/SDK_WORKER_MIGRATION_PLAN.md W5/W6).
//
// ── the identity invariant ────────────────────────────────────────────────
// A worker is addressed by EXACTLY ONE handle:
//     runtime 'pty' ⇔ terminalId present, sdkSessionId absent
//     runtime 'sdk' ⇔ sdkSessionId present, terminalId absent
// `runtime` is optional on the persisted roster and ABSENT MEANS 'pty', so a
// roster.json written before this existed keeps loading and keeps meaning what
// it meant. A magic prefix on a single id field was rejected on purpose: when a
// worker misbehaves the first question is always "which kind is it?", and an
// encoded answer is one that can be misread at exactly the wrong moment.

import { getTerminal, getTerminalScreen, killTerminal, writeInput } from './terminal'
import {
  attachSdkListener,
  getSdkSession,
  lastQuotaRefusalText,
  isSdkSessionLive,
  pushSdkInput,
  terminateSdkSession,
} from './sdkSession'
import type { SdkEvent } from './sdkEvents'

export type WorkerRuntimeKind = 'pty' | 'sdk'

/** The minimum a worker record must carry for the runtime layer to act on it.
 *  Both {@link import('../types').OrchestratorWorker} and
 *  {@link import('../types').SwarmWorkerRecord} structurally satisfy this. */
export interface WorkerHandle {
  runtime?: WorkerRuntimeKind
  terminalId?: string
  sdkSessionId?: string
}

/** ABSENT ⇒ 'pty'. Every pre-existing roster entry and every fake-deps test
 *  literal predates the field, and all of them mean the PTY worker. */
export const workerRuntimeKind = (w: WorkerHandle): WorkerRuntimeKind => w.runtime ?? 'pty'

/** Thrown when a worker record violates the identity invariant above. The engine
 *  keys in-memory maps by {@link workerKey}, so a handle-less record would
 *  silently collide with another one — louder is safer than shared state. */
export class WorkerHandleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerHandleError'
  }
}

/** Stable per-worker key for the engine's in-memory maps (rate-limit sightings,
 *  stall clocks, …). Was `w.terminalId` everywhere; that is still exactly what
 *  it returns for a PTY worker, so those maps keep their existing contents.
 *
 *  ⚠ THE RULE THIS FILE EXISTS TO ENFORCE — read before touching any code that
 *  reaches a worker. **Address a worker by `workerKey(w)`, and act on it through
 *  `runtimeOf(w)`. Never by `w.terminalId`, and never by a pool call chosen at
 *  the call site.** An SDK worker's terminalId is EMPTY, so a call site that
 *  forgets this does not fail — it does NOTHING, or it hits a DIFFERENT worker.
 *  Five review rounds in 2026-07 found six instances, every one silent:
 *    • the worktree cleaner asked only the PTY pool → `git worktree remove`d a
 *      live worker's tree out from under claude;
 *    • the teardown killed only a PTY → salvaged and deleted the tree while the
 *      worker was still writing to it;
 *    • "stop" matched `x.terminalId === id` → `''` hit the FIRST SDK worker, and
 *      the drop that followed removed EVERY SDK worker from the roster while
 *      their processes kept running;
 *    • the worker list omitted the runtime → a healthy SDK worker rendered as an
 *      EXITED terminal, making the whole runtime look broken;
 *    • consumption + the Ground beacon read the PTY pool → no fuel accounting,
 *      and a busy project showed a quiet card.
 *  The pattern is always the same: a question about a worker answered by one
 *  pool. The property is pinned by swarmSdkWorkerContract.test.ts; the "ask both
 *  pools" seam for location/activity questions is liveDesks.ts. */
export const workerKey = (w: WorkerHandle): string => {
  const kind = workerRuntimeKind(w)
  const id = kind === 'sdk' ? w.sdkSessionId : w.terminalId
  if (!id) {
    throw new WorkerHandleError(
      `worker has runtime '${kind}' but no ${kind === 'sdk' ? 'sdkSessionId' : 'terminalId'}`,
    )
  }
  return id
}

/** The facts the engine needs about a running worker, independent of HOW it runs.
 *  Kept deliberately small: every method here is one the orchestrator already
 *  performs today. Growth belongs with the SDK implementation, not ahead of it. */
export interface WorkerRuntime {
  readonly kind: WorkerRuntimeKind
  /** Is the underlying process/session still there? (Liveness only — says
   *  nothing about whether it is making progress.)
   *
   *  ⚠ "Still there" is NOT "not marked finished". Both pools stamp a terminal
   *  marker BEFORE the process is actually gone — the PTY's `finishedAt` lands on
   *  an async onExit, and an SDK session's `status:'exited'` is written
   *  synchronously by `terminateSdkSession` while its claude keeps unwinding. A
   *  false "dead" here is what authorises a worktree teardown under a live
   *  process, so each arm must answer from its pool's REAL evidence
   *  (`isSdkSessionLive` = `!reaped` on the SDK side). */
  isAlive(w: WorkerHandle): boolean
  /** The worker's recent output, as the text the engine classifies (rate-limit
   *  notice / permission wait / free-text question). null = nothing readable,
   *  which every caller must treat as "no evidence", never as "nothing wrong". */
  recentOutput(w: WorkerHandle): string | null
  /** Stop the worker. Best-effort and idempotent: an already-dead worker is not
   *  an error, because the engine kills defensively on paths where the process
   *  may already be gone. */
  kill(w: WorkerHandle): void
  /** Wall-clock ms of the worker's newest output, or null when unknown.
   *  ⚠ null means NO EVIDENCE, never "silent since forever" — every caller
   *  must keep treating it that way. */
  lastOutputAt(w: WorkerHandle): number | null
  /** Poke a quiet worker. Returns false when there was nothing to poke. */
  nudge(w: WorkerHandle): boolean
  /** Send the worker a one-line instruction (the 差し戻し / escalation conduit).
   *  Returns whether it was accepted. */
  say(w: WorkerHandle, text: string): Promise<boolean>
}

export const ptyWorkerRuntime: WorkerRuntime = {
  kind: 'pty',
  isAlive: (w) => {
    const info = getTerminal(workerKey(w))
    // A session lingers ~30s after exit with finishedAt set so the client can
    // drain its buffer; an exited-but-lingering PTY is NOT a live slot.
    return !!info && !info.finishedAt
  },
  recentOutput: (w) => getTerminalScreen(workerKey(w)),
  kill: (w) => {
    killTerminal(workerKey(w))
  },
  lastOutputAt: (w) => getTerminal(workerKey(w))?.lastOutputAt ?? null,
  nudge: (w) => writeInput(workerKey(w), '\r'),
  say: async (w, text) => writeInput(workerKey(w), text),
}

/** How far back {@link sdkWorkerRuntime.recentOutput} reads, and how much of it
 *  it hands the engine. Deliberately the SAME window `lastQuotaRefusalText`
 *  decays on — the newest turn plus the one before it — so "what is this worker
 *  saying right now" has ONE definition in the SDK runtime instead of two that
 *  can drift apart. */
const SDK_TAIL_TURNS = 2
const SDK_TAIL_MAX_CHARS = 4000

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The session's buffered events, oldest first.
 *
 *  `attachSdkListener` is the pool's ONLY public read of the ring buffer, so
 *  this attaches and detaches in the SAME synchronous turn: nothing can be
 *  emitted between the two (the pump emits from an async loop), so the no-op
 *  listener can never fire and the entry is not left pinned by our closure. */
const bufferedSdkEvents = (id: string): SdkEvent[] => {
  const att = attachSdkListener(id, 0, () => {})
  if (!att) return []
  att.detach()
  return att.replay.map((f) => f.ev)
}

/** One event as the line the engine reads. null ⇒ contributes nothing.
 *
 *  ⚠ MARKERS, NOT TUI GLYPHS. The CLI's own `⏺` / `⎿` are deliberately NOT used:
 *  `@/lib/claudeScreen` classifies those rows as SCREEN CHROME, so borrowing them
 *  would make this text read as a half-rendered frame to any consumer that ever
 *  passes it through the frame model — a resemblance nothing here is entitled to.
 *
 *  `thinking` is COUNTED, never carried (sdkEvents) — its content never leaves
 *  the model, and a "thought 812 chars" line is furniture, not output.
 *  `status`/`turn_end` are the session machine's own bookkeeping; the status is
 *  already stated by the header line the caller puts above this. */
const renderSdkEvent = (ev: SdkEvent): string | null => {
  switch (ev.kind) {
    case 'text':
      return ev.text.trim() || null
    case 'tool_use':
      return `[tool] ${ev.name}${ev.detail ? `(${ev.detail})` : ''}`
    case 'tool_result':
      return `[tool ${ev.ok ? 'ok' : 'error'}] ${ev.head}`
    case 'api_error':
      return `API Error${ev.status === null ? '' : `: ${ev.status}`} ${ev.head}`.trim()
    case 'compact':
      return `[compacted ${ev.preTokens}→${ev.postTokens ?? '?'} tokens]`
    default:
      return null
  }
}

/** The recent transcript of an SDK session, as the text the engine classifies.
 *
 *  ⚠ THE QUOTA CHANNEL HAS EXACTLY ONE OWNER, and it is NOT this function.
 *  `lastQuotaRefusalText` returns the refusal while it is current and DECAYS it
 *  once the worker moves on — a rule that exists because, without it, a worker
 *  that hit a limit once read as rate-limited forever and was reclaimed while
 *  perfectly healthy. Rendering the refusal here as ordinary transcript text
 *  would put that sentence back in front of the classifier AFTER the decay, i.e.
 *  rebuild the bug the decay rule was written to kill. So a `quota_refusal` — and
 *  the `text` twin the distiller emits for the SAME block — is dropped here; the
 *  caller has already asked the owning channel first. */
const renderSdkTail = (events: readonly SdkEvent[]): string => {
  const refusals = new Set<string>()
  for (const ev of events) if (ev.kind === 'quota_refusal') refusals.add(oneLine(ev.raw))
  const lines: string[] = []
  let turnEnds = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind === 'turn_end' && ++turnEnds >= SDK_TAIL_TURNS) break
    if (ev.kind === 'quota_refusal') continue
    if (ev.kind === 'text' && refusals.has(oneLine(ev.text))) continue
    const line = renderSdkEvent(ev)
    if (line) lines.unshift(line)
  }
  const out = lines.join('\n')
  // Keep the NEWEST end: a stall/limit sighting is about what the worker said
  // last, and a head-clamped string would hide exactly that.
  return out.length > SDK_TAIL_MAX_CHARS ? `…${out.slice(-SDK_TAIL_MAX_CHARS)}` : out
}

/** The Agent SDK runtime.
 *
 *  The point of the migration is visible in how short these are: every one of
 *  them is a LOOKUP where the PTY implementation is an INFERENCE. "Is it
 *  alive" stops being "does a pool entry exist and has it not been marked
 *  finished"; it becomes "is the stream still open". "What is it saying" stops
 *  being a rendered frame that has to be told apart from the CLI's own
 *  furniture; it becomes the distilled events themselves. */
export const sdkWorkerRuntime: WorkerRuntime = {
  kind: 'sdk',
  // ⚠ `isSdkSessionLive`, NEVER `isSdkSessionAlive`. The latter reads `status`,
  // which `terminateSdkSession` flips to 'exited' SYNCHRONOUSLY — it means "we
  // asked it to stop", not "it stopped" — so a worker whose claude is still
  // unwinding (still running `git`, still writing files) reported DEAD here.
  // That is the answer that authorises the teardown to remove its worktree out
  // from under it, which is the 2026-07-28 wedged-git incident by construction.
  // This file introduced `isSdkSessionLive` as THE predicate and then kept
  // asking the old question one function below the comment saying not to.
  isAlive: (w) => {
    const s = getSdkSession(workerKey(w))
    return !!s && isSdkSessionLive(s)
  },
  recentOutput: (w) => {
    const id = workerKey(w)
    const s = getSdkSession(id)
    if (!s) return null
    // ⚠ THE QUOTA STOP MUST BE VISIBLE HERE. The engine's rate-limit detection
    // reads this string and runs it through classifyOutput. Returning only the
    // status line meant a quota-parked SDK worker classified as ORDINARY output:
    // diagnosed as a plain stall, nudged, reclaimed, and re-dispatched straight
    // into the same wall — burning a fresh worktree per attempt against a limit
    // that will not lift for hours.
    //
    // The refusal text is the CLI's OWN sentence, taken verbatim from the
    // session's `quota_refusal` event (sdkEvents matched it against the SDK's
    // exported prefix list). No private mirror of Anthropic's wording is created
    // here — that is the maintenance trap swarmRateLimitText exists to end.
    const refusal = lastQuotaRefusalText(id)
    if (refusal) return refusal
    // Otherwise: the status line, PLUS what the worker has actually been saying.
    //
    // The status line alone was not "honest but undetailed", it was BLIND: every
    // consumer of this string is a text reader (classifyOutput, the escalation's
    // tail capture, the engine's log), and `[sdk session working]` carries no
    // evidence of anything. A worker melting down with `API Error: 529` on every
    // turn, or repeating one failing tool call for an hour, was indistinguishable
    // from one quietly working. The ring buffer holds the real events; refusing
    // to render them was choosing to know less than the PTY runtime knew.
    //
    // What this is NOT: a fabricated `claude` TUI frame. The screen-shaped
    // detectors (swarmQuestions' free-text-question arm) key on the CLI's own
    // furniture — the idle footer, the `❯` input box — and manufacturing those
    // rows here would make an SDK worker's behaviour depend on claudeScreen's
    // regexes, which is precisely the coupling this runtime exists to delete.
    // Question detection for an SDK worker belongs on a runtime-aware seam at the
    // classifier's call site (swarmOrchestrator's classifyOutput), not on a
    // counterfeit screen — that is still OPEN, and until it lands an SDK worker's
    // question reaches the owner only through the overseer's S4 heartbeat path.
    const head = `[sdk session ${s.status}${s.exitReason ? ` — ${s.exitReason}` : ''}]`
    const tail = renderSdkTail(bufferedSdkEvents(id))
    return tail ? `${head}\n${tail}` : head
  },
  kill: (w) => {
    terminateSdkSession(workerKey(w))
  },
  // Real liveness, not a guess: the timestamp of the newest event on the wire.
  lastOutputAt: (w) => getSdkSession(workerKey(w))?.lastEventAt ?? null,
  // A bare CR means nothing to a stream. The equivalent poke is an actual turn.
  nudge: (w) => pushSdkInput(workerKey(w), 'Continue.'),
  say: async (w, text) => pushSdkInput(workerKey(w), text),
}

/** Resolve the runtime for one worker. The engine calls this instead of reaching
 *  into the PTY pool directly. */
export const runtimeOf = (w: WorkerHandle): WorkerRuntime =>
  workerRuntimeKind(w) === 'sdk' ? sdkWorkerRuntime : ptyWorkerRuntime
