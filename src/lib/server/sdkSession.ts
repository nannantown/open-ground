// sdkSession — the Agent SDK session pool. The SDK-side sibling of terminal.ts.
//
// One entry is one running `claude` driven through the Agent SDK: an input
// queue we push turns into, a ring buffer of distilled {@link SdkEvent}s the UI
// and the engine read, and a status the engine steers on.
//
// WHY A POOL AND NOT A PROMISE. The engine outlives any one turn: it dispatches
// a worker, walks away, and comes back on the next monitor tick to ask how it
// is doing. That is the same shape terminal.ts serves for PTYs, so this mirrors
// its contracts deliberately — including keeping state on `globalThis` so a
// `tsx watch` reload in dev does not orphan live sessions (CLAUDE.md records
// that pattern as the rule for any new in-memory server state).
//
// TESTABILITY IS A REQUIREMENT, NOT A NICETY. `queryFn` is injected. Nothing in
// the unit suite may spawn a real `claude`: besides being slow and quota-hungry,
// an isolated HOME cannot even authenticate (measured — migration plan appendix
// B-6), so a "real" test would either touch the owner's own session state or
// fail for the wrong reason. Live behaviour is pinned by the probes in
// scripts/probe-sdk-*.mts instead.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §3.1 / §6.

import { randomUUID } from 'crypto'
import { resolve as pathResolve, sep } from 'path'
import {
  distillSdkMessage,
  isWorkEvidence,
  statusAfter,
  type SdkEvent,
  type SdkSessionStatus,
} from './sdkEvents'

// ── injected shapes ─────────────────────────────────────────────────────────
// Structural, not imported from the SDK: the pool must be constructible in a
// test with a hand-rolled async generator and no SDK types in sight.

/** What `query()` returns: an async iterable of raw messages, plus controls. */
export interface SdkQueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => Promise<unknown>
}

export interface SdkQueryParams {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
}

export type SdkQueryFn = (params: SdkQueryParams) => SdkQueryHandle

/** Which OPEN GROUND role a session carries. The pool is otherwise anonymous,
 *  and "is a commander desk alive in this project?" must be answerable from the
 *  POOL rather than from a store any spawn can overwrite — that is the exact
 *  desync that produced eleven PTY commander desks in three hours (swarmManager
 *  `adoptLiveDesk`). A pool cannot desynchronise from itself, so the SDK pool
 *  has to be able to answer the same question the PTY pool answers via
 *  `TerminalInfo.deskLabel`. */
export type SdkSessionRole = 'worker' | 'manager' | 'supply'

interface SpawnSdkSessionCore {
  /** Working directory the session runs in (a worker's worktree). */
  cwd: string
  /** What this session IS, for pool queries (see {@link SdkSessionRole}). */
  role?: SdkSessionRole
  /** The CLAUDE session id this session drives (`sessionId`/`resume` in the SDK
   *  options). Distinct from the pool id: the pool id addresses the session in
   *  OG's own API surface, this one addresses the CONVERSATION on disk and is
   *  what swarmSessions persists so a restart can resume it. */
  agentSessionId?: string
  /** Options handed to `query()` verbatim. Built by the caller (swarmWorkerSdk
   *  for a worker) so this module owns no policy — not permissions, not the
   *  guard, not the model. */
  options: Record<string, unknown>
  /** First turn, sent as soon as the session starts. Omit for a session the
   *  caller will drive with {@link pushSdkInput}. */
  initialPrompt?: string
  /** Injected id (tests / deterministic resume). Defaults to a fresh uuid. */
  id?: string
}

/** ⚠ EITHER INJECT `queryFn`, OR HAND OVER PROOF THAT THE MODULE IS LOADED.
 *
 *  This spawn is SYNCHRONOUS and the SDK is an ESM package a CJS bundle can only
 *  reach with `await import()`, so a caller that has not preloaded gets a session
 *  that fails at birth. That is safe — it degrades to a PTY — but it is SILENT,
 *  and silence is how it got missed: `scripts/probe-sdk-manager-launch.mts` (the
 *  canonical "boot a real commander" verifier, docs/SDK_CLIENT_INVESTIGATION.md
 *  §662) called this without preloading, so the verifier would have started
 *  failing at the exact moment production started working. `scripts/` sits
 *  outside every inventory guard, so nothing would have said a word.
 *
 *  A presence-check guard cannot close that: it can see that TODAY's callers call
 *  preloadSdk, not that TOMORROW's does, nor that it does so BEFORE this. Making
 *  the proof an ARGUMENT moves the whole class from "silent at runtime" to "does
 *  not compile" — the direction CLAUDE.md asks for when a guard has to choose
 *  between under- and over-approximating.
 *
 *  ⚠ "DOES NOT COMPILE" IS ONLY TRUE WHERE A COMPILER LOOKS, AND IT DID NOT LOOK
 *  HERE. tsconfig.json includes `scripts/**\/*.ts` — not `.mts` — so all 14
 *  scripts/*.mts, INCLUDING the probe above, were outside `tsc --noEmit`
 *  entirely, and `npm run lint` (`--ext .ts,.tsx`) skipped them too. Measured on
 *  review: deleting the proof from that probe left the root typecheck at exit 0
 *  with zero errors, i.e. this rule was real for src/ and server/ and absent from
 *  the one directory the defect came from. `tsconfig.scripts.json` now covers
 *  them and scriptsTypecheck.test.ts runs it from the suite, so the claim holds
 *  for every caller in the repo — verified by deleting the argument and watching
 *  it go red.
 *
 *  Tests are exempt by construction rather than by exception: injecting `queryFn`
 *  means the module is never read, so there is nothing to prove. */
export type SpawnSdkSessionOpts = SpawnSdkSessionCore &
  (
    | {
        /** Injected for tests — the real SDK `query` is then never reached. */
        queryFn: SdkQueryFn
        sdk?: SdkPreloadResult
      }
    | {
        /** What {@link preloadSdk} returned. */
        sdk: SdkPreloadResult
        queryFn?: undefined
      }
  )

export interface SdkSessionInfo {
  id: string
  cwd: string
  role?: SdkSessionRole
  agentSessionId?: string
  status: SdkSessionStatus
  startedAt: number
  /** Wall-clock of the newest event — the liveness signal that replaces
   *  guessing from a heartbeat file's mtime. */
  lastEventAt: number
  /** Why the session ended, once it has. */
  exitReason?: string
  /** The pump has actually unwound — see {@link Entry.reaped}. EXPOSED because
   *  "is this session still there?" must be answerable the SAME way by every
   *  consumer: `status` is flipped synchronously by terminateSdkSession and is
   *  therefore blind to a session that was asked to stop but is still running.
   *  Absent means NOT reaped (still live, or still unwinding). */
  reaped?: boolean
  /** The pool will no longer ACCEPT input or an interrupt for this session —
   *  `pushSdkInput` and `interruptSdkSession` both reject on it, and
   *  `terminateSdkSession` sets it SYNCHRONOUSLY, long before {@link reaped}.
   *
   *  A DIFFERENT QUESTION FROM LIVENESS, and conflating them cost a window: the
   *  tile gated its composer and its ⏹ button on `reaped`, so through the whole
   *  terminate→reap unwind both stayed rendered and enabled while every press
   *  was refused. Absent means still accepting. */
  closed?: boolean
  /** Highest sequence number emitted so far. */
  seq: number
}

export interface SdkStreamFrame {
  seq: number
  ev: SdkEvent
}

type Listener = (frame: SdkStreamFrame) => void

interface Entry {
  id: string
  cwd: string
  role?: SdkSessionRole
  agentSessionId?: string
  status: SdkSessionStatus
  startedAt: number
  lastEventAt: number
  exitReason?: string
  seq: number
  /** Ring buffer. Bounded so a long-lived worker cannot grow without limit;
   *  a reader that has fallen further behind than this is told so rather than
   *  being served a silently incomplete history. */
  buffer: SdkStreamFrame[]
  /** True once the buffer has dropped at least one frame. */
  truncated: boolean
  listeners: Set<Listener>
  /** Pending turns waiting to be yielded into the SDK. */
  queue: string[]
  /** Parked resolver of the input generator, when it is waiting. */
  wake: ((text: string | null) => void) | null
  closed: boolean
  /** When the pump finished (ms epoch) — the retention clock. Unset while live. */
  closedAt?: number
  /** Set ONLY by the pump's `finally`, i.e. once the SDK's async iterator has
   *  actually returned and the transport is done.
   *
   *  ⚠ THE DISTINCTION THAT MATTERS. `closed` and `status:'exited'` are set
   *  SYNCHRONOUSLY by {@link terminateSdkSession} — they mean "we asked it to
   *  stop", not "it stopped". `interrupt()` is fire-and-forget there, and the
   *  claude behind it keeps unwinding (it is still running `git`, still writing
   *  files) for as long as that takes. Anything that must not touch the session's
   *  working directory until it is really gone has to wait on THIS flag; waiting
   *  on `isSdkSessionAlive` returns true on the first poll and gates nothing. */
  reaped?: boolean
  /** Turn boundaries seen since this session parked on a quota refusal. The
   *  first belongs to the refusing turn itself; the second means a whole new
   *  turn completed, i.e. the worker moved on. Reset whenever the park clears. */
  parkTurnEnds?: number
  handle: SdkQueryHandle | null
}

const RING_CAPACITY = 4096

/** How long a FINISHED session stays addressable before the sweep drops it.
 *
 *  Same idea as the PTY pool's 30s linger + sweep, sized much larger because
 *  the ring buffer IS the transcript here: the owner reasonably comes back to a
 *  finished worker's tile minutes later to read how it ended, and a PTY tile
 *  answers that from claude's own session file, which an SDK tile cannot.
 *  What this bounds is the true leak — WITHOUT any retention, every finished
 *  session held its full ring buffer forever, so a week of engine dispatches
 *  accumulated hundreds of dead transcripts in one long-lived process
 *  (removeSdkSession existed but had zero callers).
 *
 *  Swept LAZILY rather than on a timer: the pool only grows when sessions are
 *  created, so sweeping at that edge bounds it without a standing interval to
 *  lose across `tsx watch` reloads.
 *
 *  EXACTLY TWO EDGES CALL IT — `spawnSdkSession` (the only place the pool
 *  grows) and `listSdkSessionsIn` (a read every engine poll passes through, the
 *  safety net for a process that stops spawning but keeps serving). This used
 *  to read "on spawn / list / attach", which named one edge that does not exist
 *  and one that never did: `attachSdkListener` does not sweep, and neither does
 *  `listSdkSessions`. Deliberately left that way — attach is the one edge where
 *  sweeping could delete the entry the caller is in the middle of subscribing
 *  to, turning a readable tile into an instant 'gone'. Count the call sites
 *  before trusting a list like this; the previous one was never true. */
export const SDK_SESSION_LINGER_MS = 30 * 60_000

/** Drop finished sessions past the linger window. Cheap (one pass over a small
 *  map), called from the pool's growth/read edges. */
const sweepClosedSessions = (now = Date.now()): void => {
  // forEach, not for..of: the repo's tsconfig has no downlevelIteration, so a
  // Map is not directly iterable here. Deleting during forEach is safe for Map.
  pool.sessions.forEach((e, id) => {
    // ⚠ `reaped`, NOT `closed` — AND NOT A TIMEOUT ON TOP OF IT. Deleting an
    // entry makes every liveness seam answer "nothing is here", which is the
    // answer that AUTHORISES `git worktree remove`. So the sweep must never
    // reach a session that was merely ASKED to stop: `terminateSdkSession` sets
    // `closed` and deliberately leaves `closedAt` unset, so a claude wedged in
    // D-state git (the 2026-07-28 machine freeze) keeps its tree protected
    // forever rather than having it deleted out from under it after 30 minutes.
    //
    // The cost of that choice is real and was argued twice in review: such an
    // entry also holds an SDK slot forever, so once the cap fills every later
    // worker falls back to PTY. That is the tolerable half — the fallback works,
    // it announces itself (`fellBackBecause: "SDK worker slots are full"`), and
    // the commander's own stall check still fires on the frozen desk. Trading a
    // visible degradation for a possible deleted-out-from-under-claude is the
    // wrong direction, so there is no reaper timeout here on purpose.
    //
    // `closedAt !== undefined` used to be equivalent to `reaped` by accident
    // (both are written in the pump's finally). Stating the real predicate keeps
    // the next person from "fixing" the wedge by stamping closedAt in terminate.
    if (e.reaped && e.closedAt !== undefined && now - e.closedAt > SDK_SESSION_LINGER_MS) {
      // Listeners are already gone (the pump's finally cleared the streams via
      // status 'exited'/'failed' and SSE readers detach on 'end') — but clear
      // defensively so a straggler cannot pin the entry's buffer via closure.
      e.listeners.clear()
      pool.sessions.delete(id)
    }
  })
}

// Survive `tsx watch` reloads, exactly like the PTY pool.
interface PoolShape {
  sessions: Map<string, Entry>
}
const g = globalThis as unknown as { __openground_sdk_sessions?: PoolShape }
const pool: PoolShape = (g.__openground_sdk_sessions ??= { sessions: new Map() })

// ── loading the ESM-only SDK out of a CJS bundle ─────────────────────────────
//
// ⚠ `require()` CANNOT LOAD THIS PACKAGE IN THE SHIPPED APP, AND NOTHING IN THIS
// SUITE COULD SEE IT. @anthropic-ai/claude-agent-sdk is ESM-only
// (`"type":"module"`, main `sdk.mjs`) and is deliberately `external` in
// scripts/build-server.js, so inside `server/dist/index.cjs` — the CommonJS
// bundle Electron forks in the packaged app — a `require()` of it lands on a
// real ES module. Electron 31.7.7 carries Node 20.18.0, and `require(esm)`
// exists only from Node 20.19 / 22.12 onward. So every SDK spawn in a shipped
// build threw ERR_REQUIRE_ESM and degraded to a PTY: the 0.11.47 / 0.11.48
// "default is SDK" flip never started ONE SDK desk as a product, while dev
// (tsx, real ESM) and vitest (ESM) both worked perfectly. Same shape as the
// import.meta bundle defect — see sdkGuardBundleShape.test.ts, and now
// sdkEsmLoadFromCjsBundle.test.ts which measures THIS one on the real options.
//
// Dynamic `import()` is the fix and it needs no esbuild trick. esbuild rewrites
// `import()` into `require()` in CJS output only when the target lacks the
// dynamic-import feature, or when the imported module is BUNDLED rather than
// external; here the target is node20 and the SDK is external, so the `import()`
// survives verbatim into the .cjs. That is measured against the production
// build options rather than assumed — lower the target or drop the SDK from
// `external` and the bundle test goes red, instead of the packaged app going
// quiet again.

interface SdkModule {
  query: SdkQueryFn
  USAGE_LIMIT_ERROR_PREFIXES?: string[]
}

let sdkModule: SdkModule | null = null
let sdkLoadError: string | null = null
let sdkLoad: Promise<void> | null = null

/** How the module is fetched. A named indirection ONLY so a test can force the
 *  fetch to fail; the default is the literal `import()` the CJS bundle depends
 *  on, and `sdkEsmLoadFromCjsBundle.test.ts` executes THAT — it runs the built
 *  `.cjs` in a child process where no seam is applied — so this indirection
 *  cannot hide a regression in the thing that actually ships. */
type SdkImporter = () => Promise<unknown>
const realSdkImport: SdkImporter = () => import('@anthropic-ai/claude-agent-sdk')
let importSdk: SdkImporter = realSdkImport

/** Import the SDK once. NEVER REJECTS — the failure is recorded and re-thrown
 *  synchronously by {@link sdkNow}, which is what keeps the degrade contract
 *  described on {@link preloadSdk} intact.
 *
 *  ⚠ EVICT ON FAILURE. `??=` alone memoises the FAILURE for the life of the
 *  process — and because this promise RESOLVES rather than rejects, it memoises
 *  it as a success, so nothing ever retries. One transient miss (EMFILE, an NFS
 *  blip, a dispatch racing an install) would then mean "every worker on this
 *  machine runs as a PTY until the app restarts", and in a packaged app the
 *  server lives as long as the app does. It would also be SILENT: the degrade
 *  only ever announces itself in `fellBackBecause`. paths.ts:203-209 and
 *  registry.ts:39-42 each learned this same rule the hard way. Retrying costs
 *  one import per spawn attempt, which is rate-limited by dispatch itself.
 *
 *  Still lazy: importing this module must not require the SDK to be resolvable,
 *  because the unit suite constructs the pool with an injected `queryFn` on
 *  machines that may not have it installed at all. */
const loadSdkModule = (): Promise<void> =>
  (sdkLoad ??= importSdk()
    .then((m) => {
      sdkModule = m as SdkModule
      sdkLoadError = null
    })
    .catch((e: unknown) => {
      sdkLoadError = String((e as Error)?.message ?? e).slice(0, 200)
      // The eviction itself. `sdkLoad` is the one with teeth — drop it alone and
      // sdkLoaderEvict.test.ts goes red.
      sdkLoad = null
      // Defence in depth, and DELIBERATELY redundant today: `quotaPrefixes`
      // already refuses to memoise on a failed load, so there is normally
      // nothing here to clear, and removing this line changes no test. It stays
      // because the two rules have to agree for the recovery to work, and the
      // cheapest way to keep them agreeing is for each to hold on its own.
      cachedPrefixes = null
    }))

/** Test seam: force the module fetch to fail (or hand back a stub) so the
 *  eviction rule above can be MEASURED rather than asserted in a comment.
 *  `null` restores the real `import()` and clears every memo. */
export const __setSdkImporterForTests = (fn: SdkImporter | null): void => {
  importSdk = fn ?? realSdkImport
  sdkLoad = null
  sdkModule = null
  sdkLoadError = null
  cachedPrefixes = null
}

export interface SdkPreloadResult {
  /** The marker {@link SpawnSdkSessionOpts} demands, so that "I awaited the
   *  loader" is something the compiler checks rather than something a reviewer
   *  has to notice.
   *
   *  ⚠ IT STOPS FORGETTING, NOT FORGING. TypeScript is structural, so hand-
   *  writing `{ __sdkPreloaded: true, loaded: true, quotaPrefixCount: 0 }` type-
   *  checks fine — measured, rather than assumed, on review. Making it truly
   *  unmintable needs a `unique symbol`, which was NOT done because there is
   *  nothing to protect: `spawnSdkSession` never reads `opts.sdk` at runtime, so
   *  a forged one changes nothing — `sdkNow()` still throws, the session is still
   *  recorded `failed`, and the callers still degrade to a PTY. The value here is
   *  entirely in catching the accident (a new call site that forgot), and nobody
   *  writes that property by accident. */
  readonly __sdkPreloaded: true
  /** The ESM module resolved and its exports are in hand. */
  loaded: boolean
  /** Why not, when `loaded` is false — the sentence a degrade should quote. */
  error?: string
  /** How many usage-limit prefixes the SDK actually exposes. CONTENT, not just
   *  "some module object came back": this is the number that lets a bundle test
   *  claim the real `sdk.mjs` executed, rather than that a call did not throw. */
  quotaPrefixCount: number
}

/** Resolve the SDK module BEFORE spawning, so {@link spawnSdkSession} can stay
 *  synchronous.
 *
 *  ⚠ WHY THE CALLERS AWAIT THIS INSTEAD OF THE POOL AWAITING IT ITSELF. Both
 *  spawn callers — swarmWorker's SDK arm and swarmManager.launchSdkDesk — decide
 *  "fall back to a PTY" from the status `spawnSdkSession` returns SYNCHRONOUSLY,
 *  and both say so in a comment at the call site. A module-load failure has to
 *  be visible in that return value or a broken SDK seats a DEAD SDK desk instead
 *  of a working PTY one, which is the exact failure the fallback exists to
 *  prevent. Making the pool async would move the decision after the fact;
 *  handing back a handle that loads lazily on first iteration would do the same
 *  thing more quietly. So the async step happens HERE, before the spawn, and
 *  everything downstream of it stays synchronous.
 *
 *  Idempotent, and it never rejects: an awaiting caller needs no try/catch, and
 *  a failure surfaces at the spawn in the shape those callers already handle. */
export const preloadSdk = async (): Promise<SdkPreloadResult> => {
  await loadSdkModule()
  // Returned — NOT thrown — even on failure: the caller's job is to hand this to
  // the spawn, and the spawn is what turns a missing module into the PTY degrade
  // both call sites already implement. Rejecting would need a try/catch at every
  // site and would route around that one path.
  if (!sdkModule) {
    return { __sdkPreloaded: true, loaded: false, error: sdkLoadError ?? 'unknown', quotaPrefixCount: 0 }
  }
  return { __sdkPreloaded: true, loaded: true, quotaPrefixCount: (await quotaPrefixes()).length }
}

/** The loaded module, or a SYNCHRONOUS throw that the spawn path records as a
 *  failed session (and the callers turn into a PTY fallback). */
const sdkNow = (): SdkModule => {
  if (sdkModule) return sdkModule
  if (sdkLoadError) throw new Error(`could not load @anthropic-ai/claude-agent-sdk: ${sdkLoadError}`)
  throw new Error('@anthropic-ai/claude-agent-sdk is not loaded — await preloadSdk() before spawning')
}

// The SDK's own refusal vocabulary. Falls back to an EMPTY list — which makes
// quota detection silent rather than wrong; a private copy of Anthropic's
// wording is the thing sdkEvents exists to avoid.
let cachedPrefixes: readonly string[] | null = null
const quotaPrefixes = async (): Promise<readonly string[]> => {
  if (cachedPrefixes) return cachedPrefixes
  await loadSdkModule()
  // ⚠ DO NOT MEMOISE THE EMPTY LIST WHEN THE LOAD FAILED. `[]` is truthy, so the
  // guard above would return it forever — and since the loader now evicts itself
  // and retries, a later SUCCESSFUL load would come back with quota detection
  // still, and silently, switched off. Returning without caching keeps the
  // failure re-askable; only a real module populates the memo.
  if (!sdkModule) return []
  cachedPrefixes = sdkModule.USAGE_LIMIT_ERROR_PREFIXES ?? []
  return cachedPrefixes
}
/** How a session talks to the CLI when the caller does not say. Production never
 *  passes `queryFn`, so THIS is the real path — which is exactly why it needs a
 *  seam.
 *
 *  ⚠ WHY A SEAM AND NOT `vi.mock`. Injecting HERE keeps everything above it real
 *  for a test — the pool, the singleton guard, the per-project spawn lock — and
 *  replaces only the piece that needs a subscription. A module factory for the
 *  SDK specifier would swap the module out for the whole file, taking the loader
 *  and its memo with it, so the test would stop exercising the production path
 *  it means to be testing.
 *
 *  (HISTORY — THE REASON CHANGED UNDER THIS FILE, so the old one is kept but
 *  labelled. While the load was a `require()` inside a CJS interop hop, a factory
 *  registered for the ESM specifier did NOT intercept it at all: measured
 *  2026-08-02, when a test that believed it had faked the SDK was in fact
 *  spawning a real Agent SDK session on a machine with no `claude`. The session
 *  died and landed in the pool as `failed`/`reaped`, and two concurrency tests
 *  still passed, because at the moment they counted the desk it had not finished
 *  dying yet. Since the load became a dynamic `import()`, a factory DOES
 *  intercept — re-measured on review 2026-08-02 — so interception is no longer
 *  the argument; the paragraph above is. A green that depends on winning a race
 *  with a crash is still worse than a red.) */
let defaultQueryFn: SdkQueryFn = (params) => sdkNow().query(params)

/** Test seam: replace the real `query` for tests that must drive the POOL (and
 *  everything built on it) without a subscription. `null` restores production. */
export const __setDefaultQueryFnForTests = (fn: SdkQueryFn | null): void => {
  defaultQueryFn = fn ?? ((params) => sdkNow().query(params))
}

/** Test seam: pin the prefix list without loading the SDK. */
export const __setQuotaPrefixesForTests = (p: readonly string[] | null): void => {
  cachedPrefixes = p
}

const emit = (e: Entry, ev: SdkEvent): void => {
  e.seq += 1
  const frame: SdkStreamFrame = { seq: e.seq, ev }
  e.buffer.push(frame)
  if (e.buffer.length > RING_CAPACITY) {
    e.buffer.shift()
    e.truncated = true
  }
  e.lastEventAt = Date.now()
  // forEach, not for..of: tsconfig sets no `target` (⇒ ES5), where iterating an
  // iterator is a TS2802 — the same trap swarmOrchestrator's exec-loop records.
  e.listeners.forEach((l) => {
    try {
      l(frame)
    } catch {
      // A broken listener (a disconnected SSE write) must never take down the
      // pump — the session keeps running and the listener is simply noisy.
    }
  })
}

const setStatus = (e: Entry, status: SdkSessionStatus, detail?: string): void => {
  if (e.status === status) return
  announceStatus(e, status, detail)
}

/** Write a status AND emit its frame even when the status is UNCHANGED.
 *
 *  This is the WRITE ITSELF; `setStatus` is this plus a dedupe. So it has two
 *  kinds of caller, and the distinction between them is the whole point:
 *
 *   • `setStatus` — the ordinary path. Every transition inside the pump goes
 *     through it, and skipping a no-op transition there is correct.
 *   • directly, from the paths that announce a REAP (the pump's `finally`). Those
 *     must not dedupe, because `terminateSdkSession` has ALREADY written 'exited'
 *     synchronously by then, so the dedupe made the pump's own terminal write
 *     emit NOTHING. "We asked it to stop" and "it actually stopped" produced ONE
 *     frame between them, minutes apart, and the second — the only one that is
 *     evidence — was invisible to every stream reader. The SSE route ends its
 *     stream on the reap, so with no frame to carry the news it had to wait out
 *     a 25 s heartbeat on every stopped desk.
 *
 *  (The earlier wording here claimed "exactly one caller — the pump's finally".
 *  That was false the moment it was written: `setStatus` is defined directly
 *  above and delegates to this. A docstring that miscounts its own callers is
 *  how the next reader concludes the dedupe is unreachable.)
 *
 *  A duplicate 'exited' frame is harmless to the readers we have (the tile
 *  renders status frames as nothing and applies them idempotently; the ring
 *  scanners key on other kinds) — an unannounced reap is not. */
const announceStatus = (e: Entry, status: SdkSessionStatus, detail?: string): void => {
  e.status = status
  emit(e, { kind: 'status', status, ...(detail ? { detail } : {}) })
}

const makeInputIterable = (e: Entry): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    for (;;) {
      let text: string | null
      if (e.queue.length) text = e.queue.shift()!
      else if (e.closed) return
      else text = await new Promise<string | null>((res) => (e.wake = res))
      if (text === null) return
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      }
    }
  },
})

/** Drain the SDK's output into the ring buffer until it ends. */
const pump = async (e: Entry): Promise<void> => {
  // Awaited, not synchronous: the vocabulary comes out of the ESM SDK, which a
  // CJS bundle can only reach through `import()`. Free in practice — the spawn
  // that started this pump already awaited the same one-shot load.
  const prefixes = await quotaPrefixes()
  // Was the LAST event we saw an aborted turn boundary? Deliberately a
  // most-recent-event flag and NOT a "has this session ever been aborted" one.
  //
  // It started as the latter, back when an interrupt was believed to END the
  // session — one abort, one throw, one exit, so the distinction never came up.
  // It is measurably not so (see {@link interruptSdkSession}): a session SURVIVES
  // an interrupt and keeps working for hours afterwards. A sticky flag therefore
  // disguised every LATER death as a clean stop — a worker interrupted once in
  // the morning that dies of a transport error in the afternoon was recorded as
  // 'interrupted' / 'exited' instead of 'error: …' / 'failed', so the owner and
  // the engine could no longer tell a crashed desk from a stopped one. Any event
  // arriving after the abort is proof the session moved on, and clears it.
  let sawAbort = false
  try {
    for await (const msg of e.handle!) {
      // ⚠ TERMINATE IS THE END OF STATUS. Once `closed` is set the session has
      // been ended by us; the iterator may keep yielding for a while, and every
      // status write below would then RESURRECT a terminated session — turn_end
      // pushing it back to 'waiting', and (since the promotion added in round 4)
      // the next message pushing it on to 'working'. A desk the owner stopped
      // would announce itself as working. Stop transitioning; keep draining.
      if (e.closed) {
        // …but KEEP READING THE EVIDENCE. `terminateSdkSession` sets `closed`
        // BEFORE it fires `interrupt()`, so the aborted turn's own result — the
        // one piece of proof that this stop was asked for — always arrives on
        // this side of the branch. Emitting it and dropping `sawAbort` on the
        // floor made the catch below read a normal terminate as a crash and land
        // every cleanly-stopped SDK worker on 'failed'.
        for (const ev of distillSdkMessage(msg, prefixes)) {
          emit(e, ev)
          sawAbort = ev.kind === 'turn_end' && ev.reason === 'aborted_streaming'
        }
        continue
      }
      for (const ev of distillSdkMessage(msg, prefixes)) {
        emit(e, ev)
        sawAbort = ev.kind === 'turn_end' && ev.reason === 'aborted_streaming'
        const next = statusAfter(ev)
        // Promote out of 'waiting' as well as 'starting'. A turn injected while
        // the session was BUSY is queued, and by the time it runs the previous
        // turn_end has already moved the status to 'waiting' — so the whole
        // injected turn executed while every reader (the tile, the Ground
        // beacon, the engine's liveness) was told the worker sat idle.
        // pushSdkInput can only promote what it can see: a turn pushed mid-turn
        // is invisible to it.
        //
        // ⚠ ON EVIDENCE OF WORK, NEVER ON A MESSAGE ARRIVING. Written at the top
        // of the loop this fired for every raw SDK message — including the
        // between-turn ones that distil to nothing (`background_tasks_changed`
        // when a `npm test` the worker BACKGROUNDED finishes, and
        // `session_state_changed`(idle) which lands AFTER the result). Those say
        // "no turn is running"; the promotion read them as "working", and with
        // no turn left to end, nothing could ever put it back. See
        // {@link isWorkEvidence} for the full argument and for why this is NOT
        // the park's exit rule.
        //
        // 'quota-parked' is deliberately NOT promoted here — it has its own exit
        // rules below (real work, or a second turn boundary).
        if ((e.status === 'starting' || e.status === 'waiting') && isWorkEvidence(ev))
          setStatus(e, 'working')
        // ⚠ A PARK OUTRANKS THE TURN BOUNDARY THAT FOLLOWS IT. The CLI's refusal
        // arrives as assistant text and its `result` lands in the SAME message
        // batch, so the distiller yields [quota_refusal, …, turn_end] — and
        // applying both in order set 'quota-parked' and then immediately
        // overwrote it with 'waiting'. The park was unobservable: the tile drew a
        // limit-stopped worker as merely "waiting", and every reader keyed on
        // status saw an idle session rather than a blocked one. A turn ending is
        // not evidence that the limit lifted; only the NEXT turn's work is (and
        // pushSdkInput moves it back to 'working' when that happens).
        //
        // …but the park must not become a ONE-WAY DOOR either. Swallowing the
        // turn boundary removes the only event-driven exit from 'quota-parked',
        // so a session that resumed on a turn already in its queue (or because
        // the CLI carried on once the limit lifted) would work for hours while
        // every reader — the tile, the beacon, the engine — still saw it parked.
        //
        // The exit conditions are deliberately IDENTICAL to what
        // lastQuotaRefusalText decays on: a tool call (unambiguous work) or a
        // SECOND turn boundary. One question — "has this worker moved on?" — with
        // one answer, in one file. `text` is NOT one of them: the distiller emits
        // the refusal AND the same block as ordinary text, so treating text as
        // progress un-parks the session on the refusal's own sentence (measured
        // twice — the decay rule was written wrong the same way first).
        if (e.status === 'quota-parked') {
          if (ev.kind === 'tool_use' || ev.kind === 'tool_result') {
            e.parkTurnEnds = 0
            setStatus(e, 'working')
            continue
          }
          if (ev.kind === 'turn_end') {
            // The first belongs to the refusing turn itself.
            if ((e.parkTurnEnds = (e.parkTurnEnds ?? 0) + 1) < 2) continue
            e.parkTurnEnds = 0
            setStatus(e, 'waiting')
            continue
          }
        }
        // ⚠ EVERY park starts its count at ZERO. Without this reset, the counter
        // carried over between parks: park #1 counted its own turn_end (=1), the
        // owner's input resumed the session, and when the still-standing limit
        // refused AGAIN, park #2 inherited that stale 1 — so its own turn_end
        // made 2 and cleared it INSTANTLY. The "not a one-way door" fix thereby
        // built a door that stopped latching from the second slam onward: every
        // park after the first was unobservable.
        if (next === 'quota-parked') e.parkTurnEnds = 0
        if (next) setStatus(e, next)
      }
    }
    // ⚠ `??=`, NEVER `=`. WHY A STOP WE ASKED FOR REACHES THIS LINE AT ALL:
    // `terminateSdkSession` wakes the input generator with `null`, so it RETURNS;
    // the SDK then closes the CLI's stdin, the CLI exits 0, and this iterator
    // ends NORMALLY — no throw. That is the ordinary path for stopping an idle
    // desk, and it lands here, not in the catch. Written as a plain assignment
    // this stamped 'completed' over the 'terminated' terminate had just written,
    // so "I stopped this worker" and "this worker finished on its own" became
    // the same record — for the owner reading the tile and for the engine
    // deciding whether to re-dispatch. The sibling invariant already lives in
    // the catch below ("an exitReason terminate wrote is kept"); it was stated
    // there and broken here, in the same function, twelve lines apart.
    e.exitReason ??= 'completed'
  } catch (err) {
    // WHEN THE ITERATOR THROWS AT ALL — measured 2026-08-01 against a
    // protocol-speaking fake CLI (scripts/probe-sdk-interrupt-survival.mts):
    // ONLY when the claude process itself dies. The SDK's read loop replaces the
    // process-exit error with the last error RESULT's text, which is why the
    // exception reads `Claude Code returned an error result: [ede_diagnostic] …`
    // after an aborted turn and looks like the interrupt threw it. It did not —
    // an interrupt on a live CLI does not end this iterator at all. So the
    // exception text is not evidence of anything; the distinguishing evidence is
    // the turn_end we already saw, and only when it was the LAST thing we saw.
    //
    // ⚠ AND A STOP WE ASKED FOR IS NEVER A FAILURE, evidence or no evidence.
    // `sawAbort` covers the case terminate cannot: a CLI that died on its own
    // right after an interrupt aborted its turn, where nothing of ours is set.
    // But it is a SECOND-HAND signal for terminate itself: nothing guarantees
    // the CLI delivers that result before the iterator throws. `e.closed` is
    // first-hand — it is true here only because WE set it — so it decides on its
    // own, and an exitReason terminate already wrote ('terminated') is kept
    // rather than relabelled.
    e.exitReason =
      sawAbort || e.closed
        ? (e.exitReason ?? 'interrupted')
        : `error: ${String((err as Error)?.message ?? err).slice(0, 200)}`
  } finally {
    e.closed = true
    e.closedAt = Date.now()
    // The iterator has RETURNED — the only in-process evidence that the claude
    // behind this session is actually done, as opposed to merely asked to stop.
    e.reaped = true
    if (e.wake) {
      const w = e.wake
      e.wake = null
      w(null)
    }
    // ⚠ REAPED IS SET **ABOVE** THIS LINE, AND THE ORDER IS PART OF THE
    // CONTRACT. This frame IS the announcement of the reap, and `emit` hands it
    // to every listener SYNCHRONOUSLY — so a listener that answers "is it really
    // gone?" out of the pool on receipt must find the flag already true. Emit
    // first and such a listener is told the session is still live and then never
    // hears about it again: it waits out routes/sdkSession.ts's 25 s heartbeat,
    // which is the lag this announcement exists to remove.
    //
    // (Measured 2026-08-01: the SSE route as written survives the inversion by
    // luck — it re-reads the pool from the write promise's `.then`, a microtask
    // later. That is not a reason to invert it; it is a reason the guard in
    // server/routes/__tests__/sdkSessionStreamEnd.test.ts pins the ORDER
    // directly, from a listener, instead of trusting an end-to-end test to
    // notice.)
    //
    // `announceStatus`, NOT `setStatus`: after a terminate the status is already
    // 'exited' and the dedupe would swallow the one frame that proves the claude
    // actually let go. See {@link announceStatus}.
    announceStatus(
      e,
      e.exitReason && e.exitReason.startsWith('error:') ? 'failed' : 'exited',
      e.exitReason,
    )
  }
}

export const spawnSdkSession = (opts: SpawnSdkSessionOpts): SdkSessionInfo => {
  // The pool grows here and only here — the natural edge to bound it at.
  sweepClosedSessions()
  const id = opts.id ?? randomUUID()
  const now = Date.now()
  const e: Entry = {
    id,
    cwd: opts.cwd,
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {}),
    status: 'starting',
    startedAt: now,
    lastEventAt: now,
    seq: 0,
    buffer: [],
    truncated: false,
    listeners: new Set(),
    queue: [],
    wake: null,
    closed: false,
    handle: null,
  }
  pool.sessions.set(id, e)

  if (opts.initialPrompt) e.queue.push(opts.initialPrompt)

  const queryFn: SdkQueryFn = opts.queryFn ?? defaultQueryFn

  try {
    e.handle = queryFn({ prompt: makeInputIterable(e), options: opts.options })
  } catch (err) {
    e.closed = true
    // ⚠ THIS ENTRY MUST LOOK FINISHED IN EVERY SENSE. `pump` never runs here, so
    // its `finally` — the only other place that stamps these — never will
    // either. Leaving them unset used to be harmless bookkeeping; it stopped
    // being harmless the moment two things started keying on them:
    //   • the retention sweep needs `closedAt`, or this entry is immortal;
    //   • the worktree DELETE GATE selects `!reaped`, so an unreaped ghost would
    //     be reported as "still running in this directory" FOREVER — the tree
    //     could never be removed, and the engine would retry the teardown for the
    //     life of the process. A gate that can never open is as broken as one
    //     that never closes.
    //
    // ⚠ THE SAME "A REAP IS ALWAYS ANNOUNCED, AND THE FLAG IS SET FIRST" RULE AS
    // THE PUMP'S `finally` APPLIES HERE — it was stated there and not here, which
    // is the shape half the defects in this migration had. Asked whether it is
    // actually needed on this path, the answer is yes, for the reader the pump's
    // note does not mention: no listener can exist yet (spawnSdkSession has not
    // returned, so nobody holds the id), but the frame still lands in the RING
    // BUFFER, and an SSE reader attaching a moment later gets it as `replay` and
    // must find `reaped` already true when it reads the pool. Set the flag after
    // the announcement and that reader is told "still live" by a session that
    // ended before it ever existed.
    //
    // `announceStatus`, not `setStatus`, for the same reason as the pump: the
    // rule must hold by construction rather than by luck. It is behaviourally
    // identical TODAY (a fresh entry is 'starting', so the dedupe cannot fire) —
    // which is exactly why it should not be left resting on that fact.
    e.reaped = true
    e.closedAt = Date.now()
    e.exitReason = `spawn failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`
    announceStatus(e, 'failed', e.exitReason)
    return snapshot(e)
  }

  void pump(e)
  return snapshot(e)
}

const snapshot = (e: Entry): SdkSessionInfo => ({
  id: e.id,
  cwd: e.cwd,
  ...(e.role ? { role: e.role } : {}),
  ...(e.agentSessionId ? { agentSessionId: e.agentSessionId } : {}),
  status: e.status,
  startedAt: e.startedAt,
  lastEventAt: e.lastEventAt,
  ...(e.exitReason ? { exitReason: e.exitReason } : {}),
  ...(e.reaped ? { reaped: true } : {}),
  // ⚠ THREE DIFFERENT QUESTIONS, AND THE TILE NEEDS THE THIRD ONE.
  //   status  — what the desk is doing (display).
  //   reaped  — has claude actually gone (liveness; what authorises a delete).
  //   closed  — will this pool still ACCEPT input (`pushSdkInput` and
  //             `interruptSdkSession` both reject on it, and terminate sets it
  //             SYNCHRONOUSLY, long before `reaped`).
  // Gating the composer and the ⏹ button on `reaped` left both of them rendered
  // and clickable through the whole terminate→reap window, where every press is
  // refused — a button that exists only to produce an error. Exposed so the tile
  // can ask the question it actually has.
  ...(e.closed ? { closed: true } : {}),
  seq: e.seq,
})

export const getSdkSession = (id: string): SdkSessionInfo | null => {
  const e = pool.sessions.get(id)
  return e ? snapshot(e) : null
}

export const listSdkSessions = (): SdkSessionInfo[] => {
  // forEach for the same ES5-target reason as emit().
  const out: SdkSessionInfo[] = []
  pool.sessions.forEach((e) => out.push(snapshot(e)))
  return out
}

/** The cwds of every LIVE SDK session — the SDK pool's half of "is anything
 *  working in this directory right now?".
 *
 *  The exact counterpart of terminal.ts's `listActiveTerminalCwds`, and it
 *  exists because that one was the ONLY thing the worktree cleaner consulted:
 *  an SDK worker has no PTY entry, so a clean-but-live worktree read as
 *  abandoned and was `git worktree remove`d OUT FROM UNDER a running claude —
 *  the "deleting a running session's cwd is never acceptable" rule the cleaner
 *  documents, defeated by a second pool it did not know about.
 *
 *  Includes 'starting' (spawned, first message not yet seen — very much a live
 *  process) and excludes only finished sessions. Deduped, unordered. */
export const listActiveSdkCwds = (): string[] => {
  const out = new Set<string>()
  pool.sessions.forEach((e) => {
    // ⚠ `!reaped`, NEVER status — the SAME rule terminateSdkSessionsInDir states.
    // It was written there and NOT here, seventy lines apart in one file, and
    // this is the seam the worktree CLEANER stands on (liveDesks
    // → listAllLiveDeskCwds → worktreeCleanup). `terminateSdkSession` flips
    // status to 'exited' synchronously, so a status filter drops the one session
    // that matters most — asked to stop, claude still unwinding — and the cleaner
    // reads the tree as abandoned and removes it out from under a running
    // process. A rule applied to one of two sibling functions is not a rule.
    if (!e.reaped) out.add(e.cwd)
  })
  return Array.from(out)
}

/** ⚠ NOT A LIVENESS PREDICATE, despite the name. Has a TERMINAL STATUS been
 *  written for this id? That is "did anyone ask this session to stop", not "is
 *  the claude behind it gone" — `terminateSdkSession` writes 'exited'
 *  synchronously while the process keeps unwinding for as long as its `git`
 *  takes.
 *
 *  @deprecated Zero production callers, deliberately: nine seams asked "is this
 *  session still there?" and answered with this, and every one of them was a
 *  silent defect (a worktree deleted under a running claude, a twin commander
 *  desk, an SSE stream cut before its last events). The NAME is the trap — it is
 *  the first thing a new reader reaches for. Use {@link isSdkSessionLive} for a
 *  snapshot, {@link isSdkSessionReaped} for an id.
 *
 *  Kept ONLY because the two suites that still name it are pinning the trap
 *  itself ("the old signal already says gone, the real one does not") —
 *  src/lib/server/sdkSession.test.ts and swarmOrchestrator.test.ts. Deleting it
 *  means rewriting those assertions in terms of `getSdkSession(id).status`,
 *  which is strictly better and is the intended follow-up; it was not done here
 *  only because those files belong to another editor in this round. A guard in
 *  server/routes/__tests__/sdkSessionStreamEnd.test.ts fails the moment any
 *  PRODUCTION file names it again. */
export const isSdkSessionAlive = (id: string): boolean => {
  const e = pool.sessions.get(id)
  return !!e && e.status !== 'exited' && e.status !== 'failed'
}

/** The CLI's own most recent "you've hit your limit" sentence for this session,
 *  or null when it has not refused.
 *
 *  Read straight out of the ring buffer's `quota_refusal` event, so the text is
 *  the CLI's VERBATIM wording — never a private mirror of Anthropic's phrasing,
 *  which is the maintenance trap swarmRateLimitText documents. It exists so the
 *  engine's existing rate-limit classifier (which reads TEXT) can see an SDK
 *  worker's quota stop: without it the adapter handed back `[sdk session
 *  waiting]`, which classifies as ordinary output, so a quota-parked worker was
 *  diagnosed as merely stalled — nudged, reclaimed, and re-dispatched straight
 *  into the same wall. */
export const lastQuotaRefusalText = (id: string): string | null => {
  const e = pool.sessions.get(id)
  if (!e) return null
  // ⚠ THE NOTICE MUST DECAY, and the stop condition is subtle.
  //
  // Without decay the scan walked the whole 4096-frame ring buffer, so a worker
  // that hit a limit ONCE returned that sentence forever: the engine's
  // classifier read "rate-limited" on every later pass and reclaimed a perfectly
  // healthy worker. The PTY path gets this for free — its notice scrolls off the
  // screen — which is exactly the kind of implicit behaviour a second runtime
  // has to reproduce ON PURPOSE.
  //
  // But `text` is NOT the stop signal: the distiller emits `quota_refusal` and
  // then the SAME block as `text` (sdkEvents — the refusal arrives as ordinary
  // assistant text and the prefix match only tags it), so stopping at text would
  // never find any refusal at all. The honest markers of "this worker has moved
  // on" are a tool call (unambiguous work) or a SECOND turn boundary — one
  // turn_end belongs to the refusing turn itself.
  let turnEnds = 0
  for (let i = e.buffer.length - 1; i >= 0; i--) {
    const ev = e.buffer[i].ev
    if (ev.kind === 'quota_refusal') return ev.raw
    if (ev.kind === 'tool_use' || ev.kind === 'tool_result') return null
    if (ev.kind === 'turn_end' && ++turnEnds >= 2) return null
  }
  return null
}

/** THE liveness predicate, for any consumer holding a session SNAPSHOT.
 *
 *  Six separate seams asked "is this session still there?" and five of them
 *  answered with `status`, which `terminateSdkSession` flips synchronously while
 *  the claude behind it keeps running. Each was fixed one at a time over four
 *  review rounds; this exists so the seventh consumer does not have to be found
 *  by a reviewer. If you are about to write `status !== 'exited'`, use this.
 *
 *  Deliberately NOT the inverse of "is it doing something" — a session that is
 *  waiting for input is live. It answers only: is this process still there? */
export const isSdkSessionLive = (s: { reaped?: boolean }): boolean => !s.reaped

/** Has this session's pump actually unwound? (An unknown id counts as reaped —
 *  there is nothing left to wait for.)
 *
 *  This — NOT `isSdkSessionAlive` — is what a caller must wait on before it may
 *  touch the session's working directory. See {@link Entry.reaped}: terminate
 *  flips `alive` to false synchronously, so a wait built on it is a 0 ms gate. */
export const isSdkSessionReaped = (id: string): boolean => {
  const e = pool.sessions.get(id)
  return !e || e.reaped === true
}

/** Terminate every LIVE SDK session whose cwd is `dir` OR sits under it, and
 *  return their ids so the caller can wait for them to be reaped.
 *
 *  AT-OR-UNDER, deliberately wider than the PTY counterpart's exact-cwd match:
 *  this is the destructive direction (the caller is about to delete `dir`), and
 *  a session working in a SUBDIRECTORY is just as fatal to interrupt by yanking
 *  the tree out from under it. */
export const terminateSdkSessionsInDir = (dir: string): string[] => {
  const root = pathResolve(dir)
  const ids: string[] = []
  pool.sessions.forEach((e) => {
    // ⚠ SELECT ON `reaped`, NEVER ON STATUS. `terminateSdkSession` flips status
    // to 'exited' SYNCHRONOUSLY, so a status filter is blind to exactly the
    // session that matters most: one already asked to stop whose claude is still
    // unwinding. The engine's main teardown terminates FIRST and only then
    // removes the worktree, so on the path where the reap wait times out this
    // filter would have found nothing, reported the directory clear, and let the
    // delete run under a live claude — the very hole this whole seam exists to
    // close, reintroduced inside the fix for it.
    if (e.reaped) return
    const cwd = pathResolve(e.cwd)
    if (cwd !== root && !cwd.startsWith(root + sep)) return
    ids.push(e.id)
  })
  // Terminating an already-terminated session is a no-op by design, so asking
  // again costs nothing and keeps this function's contract simple: every id it
  // returns is one the caller must wait for.
  for (const id of ids) terminateSdkSession(id)
  return ids
}

/** Every LIVE session of `role` whose cwd is `cwd` — the SDK counterpart of
 *  terminal.ts's `listLiveDesksIn`, and the authority for "does this project
 *  already have a commander desk?".
 *
 *  Paths are compared RESOLVED, exactly as the PTY side compares them, so a
 *  symlinked or trailing-slash spelling of the same directory can never look
 *  like a different project and earn itself a second desk. */
export const listSdkSessionsIn = (cwd: string, role: SdkSessionRole): SdkSessionInfo[] => {
  // A read edge every poll passes through — the sweep's safety net for a
  // process that stops spawning but keeps serving (lost-timer analogue of the
  // PTY pool's sweep loop).
  sweepClosedSessions()
  const want = pathResolve(cwd)
  const out: SdkSessionInfo[] = []
  pool.sessions.forEach((e) => {
    if (e.role !== role) return
    // ⚠ `reaped`, NOT status. This is the SINGLETON guard: swarmManager's
    // adoptLiveDesk asks it "is a commander desk already up in this project?".
    // terminate flips status synchronously, so a status filter answers NO while
    // the old commander is still unwinding — and a TWIN desk is spawned into the
    // same project. That is the 2026-07-19 eleven-desk incident, by construction.
    if (e.reaped) return
    if (pathResolve(e.cwd) !== want) return
    out.push(snapshot(e))
  })
  return out
}

/** Queue one turn. Returns false when the session is gone or already finished.
 *
 *  Mid-turn is FINE: a message pushed while the model is generating is queued
 *  by the CLI and handled when the current turn ends (measured 2026-07-30 —
 *  migration plan appendix B-3). That is what lets the engine inject a rework
 *  instruction without the bracketed-paste + screen-re-read dance the PTY path
 *  needs to confirm the text ever landed. */
export const pushSdkInput = (id: string, text: string): boolean => {
  const e = pool.sessions.get(id)
  if (!e || e.closed) return false
  if (e.status === 'waiting' || e.status === 'quota-parked') setStatus(e, 'working')
  if (e.wake) {
    const w = e.wake
    e.wake = null
    w(text)
  } else {
    e.queue.push(text)
  }
  return true
}

/** Stop the CURRENT turn but keep the session usable (the graceful stop the PTY
 *  path never had — there, stopping a worker meant killing it).
 *
 *  ⚠ THIS PROMISE IS MEASURED, not inferred — it was believed to be a LIE for a
 *  while, and the i18n string next to the button ("the session stays open") was
 *  nearly rewritten to admit it. Measured 2026-08-01 against a protocol-speaking
 *  fake CLI (scripts/probe-sdk-interrupt-survival.mts, no auth or quota needed):
 *  with a CLI that stays alive, `interrupt()` aborts the running turn, delivers
 *  its `aborted_streaming` result, and the async iterator KEEPS GOING — a turn
 *  pushed afterwards runs to completion. The session really does survive.
 *
 *  What made it look otherwise: the stage-0 spike recorded "exception: yes" for
 *  interrupt. That exception is the CLI PROCESS DYING, not the interrupt — the
 *  SDK only ends its own iterator when the child exits, and it relabels that
 *  exit error with the last error result's text, so the throw reads
 *  `[ede_diagnostic] …` and looks caused by the abort. The spike used a STRING
 *  prompt; the SDK sets `isSingleUserTurn` from `typeof prompt === 'string'` and
 *  closes the CLI's stdin on the first result, so its CLI was always going to
 *  die. We pass an AsyncIterable (see makeInputIterable), which is a different
 *  arrangement — the trap "measure the arrangement you actually ship" names.
 *
 *  Deliberately does NOT set `closed`: this is not a stop, and closing here would
 *  reap a session that is still perfectly able to take the next instruction. If
 *  the CLI dies anyway, the pump's catch records 'interrupted', not 'failed'. */
export const interruptSdkSession = async (id: string): Promise<boolean> => {
  const e = pool.sessions.get(id)
  if (!e || e.closed || !e.handle?.interrupt) return false
  try {
    await e.handle.interrupt()
    return true
  } catch {
    // The interrupt path is inherently racy (the turn may have just ended).
    // A failed interrupt is not a failed session.
    return false
  }
}

/** End the session. Idempotent — the engine stops workers defensively on paths
 *  where the process may already be gone. */
export const terminateSdkSession = (id: string): boolean => {
  const e = pool.sessions.get(id)
  if (!e) return false
  if (!e.closed) {
    e.closed = true
    if (e.wake) {
      const w = e.wake
      e.wake = null
      w(null)
    }
    void e.handle?.interrupt?.().catch(() => {})
    e.exitReason ??= 'terminated'
    setStatus(e, 'exited', e.exitReason)
  }
  return true
}

/** Drop a finished session from the pool. Live sessions are never dropped —
 *  terminate first. */
export const removeSdkSession = (id: string): boolean => {
  const e = pool.sessions.get(id)
  if (!e || !e.closed) return false
  pool.sessions.delete(id)
  return true
}

export interface AttachResult {
  /** Frames from `fromSeq` (exclusive) that are still in the buffer. */
  replay: SdkStreamFrame[]
  /** True when frames older than `replay[0]` have been dropped — the reader is
   *  looking at an incomplete history and must be told, not quietly served. */
  truncated: boolean
  detach: () => void
}

/** Subscribe to a session's events, replaying what the buffer still holds. */
export const attachSdkListener = (
  id: string,
  fromSeq: number,
  cb: Listener,
): AttachResult | null => {
  const e = pool.sessions.get(id)
  if (!e) return null
  const replay = e.buffer.filter((f) => f.seq > fromSeq)
  const oldest = e.buffer.length ? e.buffer[0].seq : e.seq + 1
  const missed = e.truncated && oldest > fromSeq + 1
  e.listeners.add(cb)
  return {
    replay,
    truncated: missed,
    detach: () => {
      e.listeners.delete(cb)
    },
  }
}

/** Test seam: forget every session. Never call from server code. */
export const __resetSdkSessionsForTests = (): void => {
  pool.sessions.clear()
}

/** Test seam: rewind a finished session's `closedAt` by `ms`, so the retention
 *  sweep can be exercised without a wall-clock wait. Never call from server code. */
export const __ageClosedSessionForTests = (id: string, ms: number): void => {
  const e = pool.sessions.get(id)
  if (e?.closedAt !== undefined) e.closedAt -= ms
}
