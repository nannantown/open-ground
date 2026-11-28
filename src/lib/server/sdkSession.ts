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
import { currentRuntimeOwnerKey } from './runtimeOwner'
import { resolveCoolingUntil, spentUsageResetsAt } from './swarmQuota'
import { recordRateLimitEvent, rejectedResetOf, rejectedUntil } from './usageWindows'
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
  /** Custom providers call only AFTER history, receipts and transcripts are durable. */
  onTurnSettled?: () => Promise<void>
  onTurnInterrupted?: (safeToContinue: boolean) => Promise<void>
  onTurnRefused?: () => Promise<void>
  /** Custom providers capture public text before queuing their UI events. */
  onPublicText?: (text: string) => void
  publicConversation?: () => { lines: { kind: 'input' | 'text'; text: string }[]; overflow: boolean }
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
  /** Shared public context is seeded without re-recording the role/handoff prompt. */
  handoffTranscript?: readonly { kind: 'input' | 'text'; text: string }[]
  /** Handoff actors cannot consume their first prompt until their handle is durable. */
  startPaused?: boolean
  /** Provider event decoding belongs to the backend; the pool owns lifecycle. */
  provider?: 'chatgpt'
  distillMessage?: (message: unknown) => SdkEvent[]
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
 *  that fails at birth. Today that fails the spawn loudly (fail-fast, 2026-08-13);
 *  in the fallback era it silently degraded to a PTY,
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
  provider?: 'chatgpt'
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
  /** Commands (tool calls) running right now; absent when none. The engine
   *  reads it so it never cuts a worker off in the middle of one. */
  toolCallsInFlight?: number
  /** The pump has actually unwound — see {@link Entry.reaped}. EXPOSED because
   *  "is this session still there?" must be answerable the SAME way by every
   *  consumer: `status` is flipped synchronously by terminateSdkSession and is
   *  therefore blind to a session that was asked to stop but is still running.
   *  Absent means NOT reaped (still live, or still unwinding). */
  reaped?: boolean
  /** How many of the `seq` frames are 'input' frames — turns the desk was
   *  handed, which are not output. `seq > (inputs ?? 0)` is "has this desk
   *  produced anything": a freshly spawned desk takes its first prompt at once,
   *  so `seq > 0` alone reads a silent desk as having painted at spawn
   *  (swarmManagerRuntime lastOutputAt). Absent means 0. */
  inputs?: number
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

export interface SdkInputReceipt {
  operationId?: string
  /** False refuses just this input before any provider bytes are yielded. */
  onConsumed?: () => Promise<void | boolean>
  /** Release an unconsumed queue reservation; never claims execution. */
  onReleased?: () => Promise<void>
  onSettled?: () => Promise<void>
  onInterrupted?: (safeToContinue: boolean) => Promise<void>
  onRefused?: () => Promise<void>
}
interface PendingSdkInput extends SdkInputReceipt { text: string; initial?: boolean; submitted?: boolean; cancelBeforeSubmit?: boolean; turnId?: string }

interface Entry {
  publicTranscript?: { kind: 'input' | 'text'; text: string }[]
  publicTranscriptBytes?: number
  publicTranscriptOverflow?: boolean
  activeRefused?: boolean
  runtimeOwnerKey?: string
  provider?: 'chatgpt'
  distillMessage?: (message: unknown) => SdkEvent[]
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
  /** How many of the `seq` frames are 'input' (turns the desk was HANDED,
   *  not output it produced) — see {@link SdkSessionInfo.inputs}. */
  inputs: number
  /** True once the buffer has dropped at least one frame. */
  truncated: boolean
  listeners: Set<Listener>
  /** Pending turns waiting to be yielded into the SDK. */
  queue: PendingSdkInput[]
  activeInput?: PendingSdkInput
  /** Parked resolver of the input generator, when it is waiting. */
  wake: (() => void) | null
  /** Do not let a provider prefetch a second input before the first settles. */
  outstanding?: boolean
  settledInputs?: number
  lastSettledAt?: number
  inputPaused?: boolean
  /** Set when {@link inputPaused} came from a usage refusal (refuseInput), not a
   *  runtime drain: when the limit says it resets, and its words. The pause's
   *  exit — see {@link pushSdkInput} and {@link resumeSdkQuotaPauses}. Before
   *  2026-11-23 a refused desk stayed deaf until the app restarted. */
  quotaPause?: { until: number; text?: string }
  /** Ends {@link quotaPause} at its stated reset (refuseInput). */
  quotaResumeTimer?: ReturnType<typeof setTimeout>
  /** The active turn has called a tool — it has had effects, so a refusal that
   *  ends it does not put its message back (refuseInput). */
  activeActed?: boolean
  /** The newest `quota_refusal` sentence this session saw. */
  lastRefusalText?: string
  /** The reset its newest `rate_limit` event stated, when that event was a
   *  refusal (usageWindows.rejectedResetOf) — the wall that refused THIS session. */
  ownRejectedUntil?: number | null
  gateWake?: (() => void) | null
  closed: boolean
  /** When the pump finished (ms epoch) — the retention clock. Unset while live. */
  closedAt?: number
  /** Set only after the SDK iterator returns AND its input receipts settle.
   *  A finished transport with unsaved receipts still holds this lease.
   *
   *  ⚠ THE DISTINCTION THAT MATTERS. `closed` and `status:'exited'` are set
   *  SYNCHRONOUSLY by {@link terminateSdkSession} — they mean "we asked it to
   *  stop", not "it stopped". `interrupt()` is fire-and-forget there, and the
   *  claude behind it keeps unwinding (it is still running `git`, still writing
   *  files) for as long as that takes. Anything that must not touch the session's
   *  working directory until it is really gone has to wait on THIS flag; waiting
   *  on `isSdkSessionAlive` returns true on the first poll and gates nothing. */
  reaped?: boolean
  /** The transport ended; durable input callbacks still gate retirement. */
  retirementReady?: boolean
  retirementPending?: Promise<void>
  /** Turn boundaries seen since this session parked on a quota refusal. The
   *  first belongs to the refusing turn itself; the second means a whole new
   *  turn completed, i.e. the worker moved on. Reset whenever the park clears. */
  parkTurnEnds?: number
  /** tool_use ids whose tool_result has not come back yet (2026-11-17). A restart
   *  inside this window leaves the transcript with an unfinished tool call, which
   *  the boot resume must hold for the owner's review — so the hands-free update
   *  waits for this to empty (liveDesks.ts updateRestartSafety). */
  toolCallsInFlight?: Set<string>
  /** The same for a custom provider (ChatGPT), whose stream reaches us already
   *  converted to events without call ids. It runs one call at a time, so a
   *  per-session count is exact (rework 2026-11-17). */
  providerToolCalls?: number
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
    // The cost of that choice was argued twice in review, in the slot-cap era:
    // such an entry held an SDK slot forever, and once the cap filled every
    // later worker fell back to PTY. Both halves of that trade are gone
    // (2026-08-13 — no cap, no fallback), which only strengthens the choice:
    // today a wedged entry costs a stale pool row and nothing else, while the
    // commander's own stall check still fires on the frozen desk. Trading that
    // for a possible deleted-out-from-under-claude is the wrong direction, so
    // there is no reaper timeout here on purpose.
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
 *  synchronously by {@link sdkNow}, which is what keeps the failure-at-the-spawn
 *  contract described on {@link preloadSdk} intact.
 *
 *  ⚠ EVICT ON FAILURE. `??=` alone memoises the FAILURE for the life of the
 *  process — and because this promise RESOLVES rather than rejects, it memoises
 *  it as a success, so nothing ever retries. One transient miss (EMFILE, an NFS
 *  blip, a dispatch racing an install) would then mean "every worker spawn on
 *  this machine FAILS until the app restarts" (in the fallback era: every worker
 *  silently ran as a PTY), and in a packaged app the server lives as long as
 *  the app does. paths.ts:203-209 and
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
   *  recorded `failed`, and the callers still fail the spawn. The value here is
   *  entirely in catching the accident (a new call site that forgot), and nobody
   *  writes that property by accident. */
  readonly __sdkPreloaded: true
  /** The ESM module resolved and its exports are in hand. */
  loaded: boolean
  /** Why not, when `loaded` is false — the sentence the spawn failure quotes. */
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
 *  "this spawn FAILED" (fail-fast since 2026-08-13; a PTY fallback before that)
 *  from the status `spawnSdkSession` returns SYNCHRONOUSLY,
 *  and both say so in a comment at the call site. A module-load failure has to
 *  be visible in that return value or a broken SDK seats a DEAD SDK desk that
 *  looks spawned, which is the exact failure this ordering exists to
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
  // the spawn, and the spawn is what turns a missing module into the failed
  // session both call sites already turn into their own typed throw. Rejecting
  // would need a try/catch at every site and would route around that one path.
  if (!sdkModule) {
    return { __sdkPreloaded: true, loaded: false, error: sdkLoadError ?? 'unknown', quotaPrefixCount: 0 }
  }
  return { __sdkPreloaded: true, loaded: true, quotaPrefixCount: (await quotaPrefixes()).length }
}

/** The loaded module, or a SYNCHRONOUS throw that the spawn path records as a
 *  failed session (and the callers turn into their fail-fast throw). */
const sdkNow = (): SdkModule => {
  if (sdkModule) return sdkModule
  if (sdkLoadError) throw new Error(`could not load @anthropic-ai/claude-agent-sdk: ${sdkLoadError}`)
  throw new Error('@anthropic-ai/claude-agent-sdk is not loaded — await preloadSdk() before spawning')
}

/** The whole SDK module, loaded the same way as for a spawn, for a caller that
 *  needs more than `query` — the assistant's own session (createSdkMcpServer).
 *  Rejects with the load error. Reaches no session and no desk. */
export const importSdkModule = async (): Promise<unknown> => {
  await loadSdkModule()
  if (!sdkModule) throw new Error(`claude sdk could not load: ${sdkLoadError ?? 'unknown'}`)
  return sdkModule
}

// The SDK's own refusal vocabulary. Falls back to an EMPTY list — which makes
// quota detection silent rather than wrong; a private copy of Anthropic's
// wording is the thing sdkEvents exists to avoid.
let cachedPrefixes: readonly string[] | null = null
/** Also read by the pre-launch tier probe (swarmTierProbe.classifyProbeOutput). */
export const quotaPrefixes = async (): Promise<readonly string[]> => {
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
const subscriptionQuery: SdkQueryFn = (params) => {
  const sdk = sdkNow() // keep the synchronous preload proof / failure contract
  let inner: SdkQueryHandle | null = null
  let stopped = false
  return {
    interrupt: async () => { stopped = true; await inner?.interrupt?.() },
    async *[Symbol.asyncIterator]() {
      const { assertClaudeSubscriptionLaunch } = await import('./subscriptionOnly')
      const { createClaudeRuntimeToolAudit, assertNoUncertainRuntimeActions } = await import('./runtimeActionReceipts')
      const { runtimeOwnerKey: expectedOwner, ...vendorOptions } = params.options
      if (typeof params.options.cwd !== 'string') throw new Error('A subscription launch requires an explicit working directory.')
      const id = typeof params.options.resume === 'string' ? params.options.resume : params.options.sessionId
      if (typeof id !== 'string') throw new Error('A subscription launch requires its recorded conversation identity.')
      const source = { ...((params.options.env as NodeJS.ProcessEnv | undefined) ?? process.env) }
      if (typeof params.options.pathToClaudeCodeExecutable === 'string') source.OPENGROUND_CLAUDE_BIN = params.options.pathToClaudeCodeExecutable
      const env = await assertClaudeSubscriptionLaunch(params.options.cwd, source)
      // R-B3: only this conversation's own unknown results refuse its launch.
      await assertNoUncertainRuntimeActions(params.options.cwd, false, id)
      const audit = await createClaudeRuntimeToolAudit(params.options.cwd, id, params.options.hooks, typeof expectedOwner === 'string' ? expectedOwner : undefined)
      if (stopped) return
      inner = sdk.query({ prompt: params.prompt, options: { ...vendorOptions, env, hooks: refuseWhileStopping(audit.hooks) } })
      for await (const message of inner) {
        await audit.observeSdkMessage(message)
        yield message
      }
    },
  }
}
let defaultQueryFn: SdkQueryFn = subscriptionQuery

/** Test seam: replace the real `query` for tests that must drive the POOL (and
 *  everything built on it) without a subscription. `null` restores production. */
export const __setDefaultQueryFnForTests = (fn: SdkQueryFn | null): void => {
  defaultQueryFn = fn ?? subscriptionQuery
}

/** Test seam: pin the prefix list without loading the SDK. */
export const __setQuotaPrefixesForTests = (p: readonly string[] | null): void => {
  cachedPrefixes = p
}

const capturePublicLine = (e: Entry, line: { kind: 'input' | 'text'; text: string }): void => {
  if (e.publicTranscriptOverflow) return
  const size = Buffer.byteLength(JSON.stringify(line)) + 1
  const total = (e.publicTranscriptBytes ?? 0) + size
  if (total > 256 * 1024) { e.publicTranscriptOverflow = true; return }
  const transcript = e.publicTranscript ??= []
  transcript.push(line)
  e.publicTranscriptBytes = total
}

const emit = (e: Entry, ev: SdkEvent): void => {
  if (ev.kind === 'text' && !ev.fromSubagent && e.provider !== 'chatgpt') capturePublicLine(e, { kind: 'text', text: ev.text })
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

/** How much of a received turn the 'input' event carries — the seat shows a
 *  few lines of it; the full text is the CLI's, not the ring buffer's. */
const INPUT_EVENT_MAX = 2000

const settleInput = async (e: Entry): Promise<void> => {
  await e.activeInput?.onSettled?.()
  e.activeInput = undefined
  e.outstanding = false
  e.settledInputs = e.inputs
  e.lastSettledAt = Date.now()
  const wake = e.gateWake
  e.gateWake = null
  wake?.()
}

const refuseInput = async (e: Entry): Promise<void> => {
  const refused = e.activeInput
  await refused?.onRefused?.()
  // A usage refusal is a confirmed non-fulfilment, never delivery/cancellation.
  // Do not admit the next queued turn into the same exhausted connection —
  // until the limit says it resets. Without that bound the desk stayed deaf
  // after the limit came back: the commander took no message until a restart
  // (2026-11-23). The refusal is read as the sentence it is, handed over just
  // now (a time already past today is tomorrow's), then the spent usage
  // window's reset, then the flat grace — the cooling resolver's order. Read as
  // a stale screen, "resets 2:50am" at 22:21 paused for 20 minutes only, and the
  // turn admitted after that met the same wall (review 2026-11-26).
  const now = Date.now()
  const a5 = e.provider === 'chatgpt' ? null : spentUsageResetsAt((await import('./claudeUsageCli')).peekCachedUsage())
  // The SDK's structured refusal (rate_limit_event → usageWindows) states the
  // reset outright: this session's own refusal event first, else an
  // account-wide window another session saw refused — never another session's
  // per-model week (review 2026-11-28 B-M1). The sentence chain below is for a
  // session that saw neither.
  const own = e.ownRejectedUntil != null && e.ownRejectedUntil > now ? e.ownRejectedUntil : null
  const until = (e.provider === 'chatgpt' ? null : own ?? rejectedUntil(now)) ?? resolveCoolingUntil({ ptyText: e.lastRefusalText, a5ResetsAt: a5, now, fresh: true })
  e.quotaPause = { until, ...(e.lastRefusalText ? { text: e.lastRefusalText } : {}) }
  e.inputPaused = true
  // A message the limit refused before the desk did anything with it was never
  // worked on, and its sender was told it was delivered: keep it and hand it
  // over when the limit lifts. One with a receipt of its own (an owner's turn)
  // has just been settled as refused; one that ran a tool has had effects —
  // neither is put back (never replay).
  if (refused && !refused.onRefused && !e.activeActed) e.queue.unshift(refused)
  e.activeInput = undefined
  // The pause ends by itself at the stated reset, so a kept message does not
  // wait for some later sender to knock (pushSdkInput) to be handed over.
  clearTimeout(e.quotaResumeTimer)
  e.quotaResumeTimer = setTimeout(() => {
    if (e.quotaPause?.until === until) resumeSdkInputAdmission(e.id)
  }, Math.min(Math.max(0, until - now) + 1000, 2 ** 31 - 1))
  e.quotaResumeTimer.unref?.()
  await settleInput(e)
}

/** Only receipt bookkeeping is retried after transport exit. Provider input is
 * never replayed, and the actor lease stays held until its final state is saved. */
const finishRetirement = (e: Entry): Promise<void> => {
  if (e.reaped || !e.retirementReady) return Promise.resolve()
  if (e.retirementPending) return e.retirementPending
  const work = Promise.resolve().then(async () => {
    try {
      if (e.activeInput) {
        await e.activeInput.onInterrupted?.(false)
        e.activeInput = undefined
      }
      while (e.queue.length) {
        await e.queue[0].onReleased?.()
        e.queue.shift()
      }
      e.outstanding = false
      e.closedAt = Date.now()
      // Announce retirement only AFTER the durable callbacks have completed.
      e.reaped = true
      announceStatus(e, e.exitReason?.startsWith('error:') ? 'failed' : 'exited', e.exitReason)
    } catch {
      // A normal pool read retries this same settlement, not the original turn.
      setStatus(e, 'failed', 'The SDK transport ended, but its input receipt could not be saved. Retirement is held until that receipt is confirmed.')
    } finally { e.retirementPending = undefined }
  })
  e.retirementPending = work
  return work
}

const makeInputIterable =(e: Entry): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (!e.closed && (e.outstanding || e.inputPaused)) {
        await new Promise<void>((resolve) => { e.gateWake = resolve })
      }
      if (e.closed) return
      let input: PendingSdkInput
      if (e.queue.length) input = e.queue.shift()!
      else if (e.closed) return
      else {
        await new Promise<void>((resolve) => { e.wake = resolve })
        continue // re-check pause/closed before consuming a newly queued input
      }
      e.outstanding = true
      e.activeInput = input
      input.turnId ??= input.operationId ?? `sdk-turn-${randomUUID()}`
      e.activeRefused = false
      e.activeActed = false
      if (await input.onConsumed?.() === false) {
        await input.onReleased?.()
        e.activeInput = undefined
        await settleInput(e)
        if (!e.closed) setStatus(e, 'waiting')
        continue
      }
      if (e.runtimeOwnerKey) await (await import('./runtimeOwner')).runtimeOwnerKey(e.runtimeOwnerKey)
      if (e.closed) return
      if (input.cancelBeforeSubmit) {
        await input.onInterrupted?.(true)
        e.activeInput = undefined
        await settleInput(e)
        if (!e.closed) setStatus(e, 'waiting')
        continue
      }
      const text = input.text
      if (!input.initial) capturePublicLine(e, { kind: 'input', text })
      // Record the turn as RECEIVED — the seat's transcript shows what the desk
      // was told (sdkEvents 'input'). lastEventAt is restored: it means "the
      // desk produced something" to the stall readers (workerRuntime
      // lastOutputAt, liveDesks), and a nudge the engine pushes into a stuck
      // worker must not read as the worker waking up.
      const at = e.lastEventAt
      emit(e, {
        kind: 'input',
        text: text.length > INPUT_EVENT_MAX ? `${text.slice(0, INPUT_EVENT_MAX)}…` : text,
      })
      e.lastEventAt = at
      e.inputs += 1
      input.submitted = true
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      }
    }
  },
})

/** Keep {@link Entry.toolCallsInFlight} in step with the raw SDK stream: an
 *  assistant tool_use opens a call, its tool_result closes it, and a turn's
 *  `result` closes whatever is left (an aborted turn has no results to wait for). */
const trackToolCalls = (e: Entry, msg: unknown): void => {
  if (e.distillMessage) return // provider shapes are not Claude's — see trackToolEvent
  const m = msg as { type?: unknown; message?: { content?: unknown } } | null
  if (m?.type === 'result') { e.toolCallsInFlight?.clear(); return }
  const blocks = m?.message?.content
  if (!Array.isArray(blocks)) return
  for (const b of blocks as ({ type?: unknown; id?: unknown; tool_use_id?: unknown } | null)[]) {
    if (m?.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') (e.toolCallsInFlight ??= new Set()).add(b.id)
    else if (m?.type === 'user' && b?.type === 'tool_result') e.toolCallsInFlight?.delete(String(b.tool_use_id))
  }
}

/** A custom provider's converted events: tool_use opens a call, tool_result
 *  closes it, a turn's end (completed, aborted or failed) closes whatever is left. */
const trackToolEvent = (e: Entry, ev: SdkEvent): void => {
  if (!e.distillMessage) return
  if (ev.kind === 'tool_use') e.providerToolCalls = (e.providerToolCalls ?? 0) + 1
  else if (ev.kind === 'tool_result') e.providerToolCalls = Math.max(0, (e.providerToolCalls ?? 0) - 1)
  else if (ev.kind === 'turn_end') e.providerToolCalls = 0
}

/** How many tool calls are running right now across every SDK session, native
 *  and custom-provider alike. */
export const sdkToolCallsInFlight = (): number => {
  let n = 0
  pool.sessions.forEach((e) => { n += (e.toolCallsInFlight?.size ?? 0) + (e.providerToolCalls ?? 0) })
  return n
}

// ── stops that wait (AUTONOMY-SPEC R-B2, 2026-11-28) ─────────────────────────
// Every stop the app starts (owner quit, "Restart now", update install, engine
// switch) reaches this process as SIGTERM from electron/autoUpdate.js
// terminateChild. Exiting on the spot cut off whatever command was running, and
// its receipt then held the whole project at the next start. So a stop first
// refuses NEW calls before any receipt is claimed (refuseWhileStopping), then
// waits for the calls already running. A call that outlives the bound is cut as
// before. The signal wiring is liveDesks.exitAfterShutdownOnSignals.

/** How long a stop waits for tool calls in flight. Electron's hard kill
 *  (CHILD_SIGTERM_GRACE_MS in electron/autoUpdate.js) is this plus 5 s, pinned
 *  by server/__tests__/autoUpdate.test.ts, so it cannot land inside the wait. */
export const SHUTDOWN_TOOL_GRACE_MS = 20_000
const SHUTDOWN_POLL_MS = 200
/** What the model reads when a call is refused because the app is stopping. */
export const SHUTDOWN_DENIAL = 'OPEN GROUND is restarting; this call did not run.'
/** What a launch is refused with once a stop has begun. The owner reads it in a
 *  launch-failed line, so plain words. */
export const SHUTDOWN_LAUNCH_REFUSAL = 'OPEN GROUND is shutting down, so no new conversation was started.'
// Process-local on purpose (not globalThis): a stop belongs to this process only.
let shutdown: Promise<void> | null = null

/** Has a stop begun? The engine reads it so no pass dispatches during the wait. */
export const sdkShutdownBegun = (): boolean => shutdown !== null

/** One-way and idempotent: refuse new tool calls AND new launches
 *  ({@link spawnSdkSession}) from now on — a conversation started now would bill
 *  its first turn only to be killed at exit — and resolve when no call is in
 *  flight or after {@link SHUTDOWN_TOOL_GRACE_MS}, whichever is first. */
export const beginShutdown = (): Promise<void> => shutdown ??= new Promise<void>((resolve) => {
  const done = () => { clearInterval(poll); clearTimeout(bound); resolve() }
  const poll = setInterval(() => { if (sdkToolCallsInFlight() === 0) done() }, SHUTDOWN_POLL_MS)
  const bound = setTimeout(done, SHUTDOWN_TOOL_GRACE_MS)
  if (sdkToolCallsInFlight() === 0) done()
})

type PreToolUseCallback = (...args: never[]) => Promise<unknown>
/** Every PreToolUse callback of a launch — the existing guards AND the receipt
 *  audit's own (runtimeActionReceipts.createClaudeRuntimeToolAudit) — answers
 *  "deny" without running once a stop has begun, so no receipt is claimed for a
 *  call that will not run. Wrapping, not an extra refusing hook: the CLI runs a
 *  call's hooks side by side, so a separate deny would not stop the audit from
 *  claiming first. Read at call time, so sessions started before the stop are
 *  covered. Order and matchers are kept (readers take the audit's as the last).
 *  ponytail: a launch with no PreToolUse hook at all (a non-owner session without
 *  guards) is waited for but not refused — it has no receipts to protect. */
const refuseWhileStopping = (hooks: unknown): unknown => {
  const all = (hooks ?? {}) as { PreToolUse?: { hooks: PreToolUseCallback[] }[] }
  if (!all.PreToolUse) return hooks
  const refusal = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: SHUTDOWN_DENIAL } }
  const gate = (hook: PreToolUseCallback): PreToolUseCallback => (...args) => shutdown ? Promise.resolve(refusal) : hook(...args)
  return { ...all, PreToolUse: all.PreToolUse.map((m) => ({ ...m, hooks: m.hooks.map(gate) })) }
}

/** Drain the SDK's output into the ring buffer until it ends. */
const pump = async (e: Entry): Promise<void> => {
  // Awaited, not synchronous: the vocabulary comes out of the ESM SDK, which a
  // CJS bundle can only reach through `import()`. Free in practice — the spawn
  // that started this pump already awaited the same one-shot load.
  const prefixes = e.distillMessage ? [] : await quotaPrefixes()
  const distill = e.distillMessage ?? ((message: unknown) => distillSdkMessage(message, prefixes))
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
      trackToolCalls(e, msg)
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
        for (const ev of distill(msg)) {
          emit(e, ev)
          trackToolEvent(e, ev)
          if (ev.kind === 'quota_refusal') e.lastRefusalText = ev.raw
          sawAbort = ev.kind === 'turn_end' && ev.reason === 'aborted_streaming'
        }
        continue
      }
      for (const ev of distill(msg)) {
        emit(e, ev)
        trackToolEvent(e, ev)
        if (ev.kind === 'tool_use') e.activeActed = true
        if (ev.kind === 'rate_limit' && e.provider !== 'chatgpt') {
          recordRateLimitEvent(ev)
          e.ownRejectedUntil = rejectedResetOf(ev)
        }
        if (ev.kind === 'quota_refusal') {
          e.activeRefused = true
          e.lastRefusalText = ev.raw
        }
        // Native SDK results are turn boundaries. Custom providers have a
        // stronger, explicit durability callback and must never use this hint.
        if (ev.kind === 'turn_end' && e.provider !== 'chatgpt') {
          if (ev.reason === 'aborted_streaming') {
            let safe = true
            try {
              const actions = await import('./runtimeActionReceipts')
              if (e.agentSessionId) await actions.interruptRuntimeActions(e.agentSessionId, e.runtimeOwnerKey)
              await actions.assertNoUncertainRuntimeActions(e.cwd, false, e.agentSessionId)
            } catch { safe = false }
            await e.activeInput?.onInterrupted?.(safe)
            if (safe) { e.activeInput = undefined; await settleInput(e) }
            else { e.exitReason = 'error: An interrupted native action has an unconfirmed result.'; terminateSdkSession(e.id) }
          } else if (e.activeRefused) {
            // A refusal cut nothing off, so ask what the launch guard and the
            // abort branch above ask (`false`): a command some actor in this
            // project is still RUNNING — another worker's, or this session's own
            // background helper's — is not an unconfirmed result. Counting it
            // (the default) ended the refused session on the spot whenever
            // anything in the project was mid-command. Measured 2026-11-23
            // 22:21: three workers, one limit; the two refused while the third
            // ran a command died here and the engine read a quota stop as a
            // crash (cards → blocked). 11-24 04:38: the commander died here with
            // its own helper's command running, that command was killed with
            // it, and the unconfirmed operation this very check exists to
            // prevent held the project for eight hours. A result that really is
            // unconfirmed (its actor gone) still ends the session.
            const actions = await import('./runtimeActionReceipts')
            await actions.assertNoUncertainRuntimeActions(e.cwd, false, e.agentSessionId)
            await refuseInput(e)
          } else await settleInput(e)
        }
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
    e.toolCallsInFlight?.clear()
    e.providerToolCalls = 0
    e.closed = true
    e.retirementReady = true
    const gate = e.gateWake
    e.gateWake = null
    gate?.()
    if (e.wake) {
      const w = e.wake
      e.wake = null
      w()
    }
    await finishRetirement(e)
  }
}

export const spawnSdkSession = (opts: SpawnSdkSessionOpts): SdkSessionInfo => {
  // Every launch, the owner's own included (review C-S2): see beginShutdown.
  if (shutdown) throw new Error(SHUTDOWN_LAUNCH_REFUSAL)
  const admittedOwner = currentRuntimeOwnerKey()
  if (admittedOwner && opts.options.runtimeOwnerKey !== undefined && opts.options.runtimeOwnerKey !== admittedOwner)
    throw new Error('The SDK launch belongs to a different admitted owner.')
  if (admittedOwner) opts = { ...opts, options: { ...opts.options, runtimeOwnerKey: admittedOwner } }
  // The pool grows here and only here — the natural edge to bound it at.
  sweepClosedSessions()
  const id = opts.id ?? randomUUID()
  const now = Date.now()
  const e: Entry = {
    ...(typeof opts.options.runtimeOwnerKey === 'string' ? { runtimeOwnerKey: opts.options.runtimeOwnerKey } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.distillMessage ? { distillMessage: opts.distillMessage } : {}),
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
    inputs: 0,
    listeners: new Set(),
    queue: [],
    wake: null,
    outstanding: false,
    settledInputs: 0,
    lastSettledAt: now,
    inputPaused: opts.startPaused === true,
    gateWake: null,
    closed: false,
    handle: null,
  }
  pool.sessions.set(id, e)
  for (const line of opts.handoffTranscript ?? []) capturePublicLine(e, { ...line })

  if (opts.initialPrompt) e.queue.push({ text: opts.initialPrompt, initial: true })

  const queryFn: SdkQueryFn = opts.queryFn ?? defaultQueryFn

  try {
    e.handle = queryFn({ prompt: makeInputIterable(e), options: opts.options,
      onPublicText: (text) => capturePublicLine(e, { kind: 'text', text }),
      publicConversation: () => ({ lines: structuredClone(e.publicTranscript ?? []), overflow: e.publicTranscriptOverflow === true }),
      onTurnSettled: () => settleInput(e), onTurnRefused: () => refuseInput(e),
      onTurnInterrupted: async (safeToContinue) => {
        await e.activeInput?.onInterrupted?.(safeToContinue)
        if (safeToContinue) {
          e.activeInput = undefined
          await settleInput(e)
        }
      },
    })
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

const snapshot = (e: Entry): SdkSessionInfo => {
  if (e.retirementReady && !e.reaped) void finishRetirement(e)
  return {
  ...(e.provider ? { provider: e.provider } : {}),
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
  ...((e.toolCallsInFlight?.size ?? 0) + (e.providerToolCalls ?? 0) > 0
    ? { toolCallsInFlight: (e.toolCallsInFlight?.size ?? 0) + (e.providerToolCalls ?? 0) }
    : {}),
  seq: e.seq,
  ...(e.inputs ? { inputs: e.inputs } : {}),
  }
}

/** The newest frames after `after`, at most `limit` of them — the POLLED twin
 *  of the SSE replay, for the Agent Team bar's seats, which must not hold a
 *  connection each (streamBudget.ts). Null for an unknown session. */
export const readSdkFrames = (
  id: string,
  after: number,
  limit: number,
): { frames: SdkStreamFrame[]; seq: number; status: SdkSessionStatus; reaped: boolean } | null => {
  const e = pool.sessions.get(id)
  if (!e) return null
  if (e.retirementReady && !e.reaped) void finishRetirement(e)
  const newer: SdkStreamFrame[] = []
  for (let i = e.buffer.length - 1; i >= 0 && newer.length < limit && e.buffer[i].seq > after; i--) {
    newer.unshift(e.buffer[i])
  }
  return { frames: newer, seq: e.seq, status: e.status, reaped: !!e.reaped }
}

export const getSdkSession = (id: string): SdkSessionInfo | null => {
  const e = pool.sessions.get(id)
  return e ? snapshot(e) : null
}

/** Read-only UI projection. Unlike the frame ring, this includes the bounded
 * public handoff seed and survives a renderer reload. No tools or reasoning
 * enter it, and an actor with no admitted owner cannot leak into a new login. */
export const getSdkPublicConversation = (id: string, expected: { ownerKey: string; cwd: string; role: SdkSessionRole }): {
  lines: { kind: 'input' | 'text'; text: string }[]; overflow: boolean; seq: number; revision: string
} | null => {
  const entry = pool.sessions.get(id)
  if (!entry || entry.runtimeOwnerKey !== expected.ownerKey || entry.role !== expected.role
    || pathResolve(entry.cwd) !== pathResolve(expected.cwd)) return null
  const lines = entry.publicTranscript ?? [], overflow = entry.publicTranscriptOverflow === true
  return { lines: lines.map(({ kind, text }) => ({ kind, text })), overflow, seq: entry.seq, revision: `${lines.length}:${overflow ? 1 : 0}` }
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
export const pushSdkInput = (id: string, text: string, receipt: SdkInputReceipt = {}): boolean => {
  const e = pool.sessions.get(id)
  // A usage refusal's pause ends when the limit said it resets — checked here,
  // where every sender (the commander relay, the engine's nudge, the notice
  // lanes) arrives, so none of them meets a desk that stays deaf after it.
  if (e?.inputPaused && e.quotaPause && Date.now() >= e.quotaPause.until) resumeSdkInputAdmission(id)
  if (!e || e.closed || e.inputPaused) return false
  if (receipt.operationId) {
    const existing = [e.activeInput, ...e.queue].find((item) => item?.operationId === receipt.operationId)
    if (existing) return existing.text === text
  }
  const input = { text, ...receipt }
  e.queue.push(input)
  if (e.status === 'waiting' || e.status === 'quota-parked') setStatus(e, 'working')
  if (e.wake) {
    const w = e.wake
    e.wake = null
    w()
  }
  return true
}

export interface SdkRuntimeCheckpoint {
  id: string
  cwd: string
  role?: SdkSessionRole
  provider: 'claude' | 'chatgpt'
  agentSessionId?: string
  settledInputs: number
  settledAt: number
  pendingInputs: { text: string; operationId?: string }[]
  /** Public owner/assistant prose only; no thinking or tool arguments/results. */
  transcript: { kind: 'input' | 'text'; text: string }[]
}

export const currentSdkInputOperationId = (id: string): string | null => pool.sessions.get(id)?.activeInput?.operationId ?? null
/** Server-observed turn identity, including a host role kickoff with no receipt. */
export const currentSdkTurnId = (id: string): string | null => {
  const input = pool.sessions.get(id)?.activeInput
  return input?.operationId ?? input?.turnId ?? null
}
export const sdkInputAdmissionPaused = (id: string): boolean => pool.sessions.get(id)?.inputPaused === true
export const resumeSdkInputAdmission = (id: string): void => {
  const e = pool.sessions.get(id)
  if (!e || e.closed) return
  e.inputPaused = false
  e.quotaPause = undefined
  clearTimeout(e.quotaResumeTimer)
  const wake = e.gateWake
  e.gateWake = null
  wake?.()
}

/** Why this session takes no input because of a usage refusal: when the limit
 *  said it resets and its words. Null when it is not paused by one. */
export const sdkQuotaPause = (id: string): { until: number; text?: string } | null => {
  const e = pool.sessions.get(id)
  return e && !e.closed && e.inputPaused && e.quotaPause ? { ...e.quotaPause } : null
}

/** The owner says the limit came back before its stated reset: every session
 *  paused by a usage refusal takes input again (a runtime drain's pause is not
 *  touched). If the limit is in fact still spent, the next turn is refused again
 *  and the session pauses again — nothing is replayed. Returns how many. */
export const resumeSdkQuotaPauses = (): number => {
  let n = 0
  pool.sessions.forEach((e) => {
    if (e.closed || !e.inputPaused || !e.quotaPause) return
    resumeSdkInputAdmission(e.id)
    n++
  })
  return n
}

/** Freeze admission before awaiting the current durable turn. Never interrupts
 * an action or drains a queued input into the retiring provider. */
export const drainSdkSession = async (id: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<SdkRuntimeCheckpoint> => {
  const e = pool.sessions.get(id)
  if (!e) throw new Error('The recorded SDK actor is missing; inspect recovery before replaying its work.')
  if (signal?.aborted) throw new Error('The runtime drain was cancelled.')
  e.inputPaused = true
  e.quotaPause = undefined // the drain owns this pause now; only its resume ends it
  const deadline = Date.now() + timeoutMs
  while (e.outstanding || e.settledInputs === undefined) {
    if (signal?.aborted) throw new Error('The runtime drain was cancelled.')
    if (e.reaped) throw new Error('The SDK actor ended with an unsettled turn; its effects require inspection.')
    if (Date.now() >= deadline) throw new Error('The SDK actor has not reached a durable turn boundary yet.')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  if (e.publicTranscriptOverflow) throw new Error('The public conversation needs an approved summary before handoff; its full context was not silently truncated.')
  const transcript = e.publicTranscript ?? []
  if (Buffer.byteLength(JSON.stringify({ transcript, pendingInputs: e.queue })) > 256 * 1024) {
    throw new Error('The actor handoff exceeds its bounded checkpoint; inspect and reduce it before switching.')
  }
  return { id, cwd: e.cwd, ...(e.role ? { role: e.role } : {}),
    provider: e.provider === 'chatgpt' ? 'chatgpt' : 'claude',
    ...(e.agentSessionId ? { agentSessionId: e.agentSessionId } : {}),
    settledInputs: e.settledInputs, settledAt: e.lastSettledAt ?? Date.now(), pendingInputs: e.queue.filter((input) => !input.initial)
      .map(({ text, operationId }) => ({ text, ...(operationId ? { operationId } : {}) })), transcript }
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
export const interruptSdkSession = async (id: string, expectedTurnId?: string): Promise<boolean> => {
  const e = pool.sessions.get(id)
  if (!e || e.closed || !e.handle?.interrupt) return false
  // No await may separate this identity check from the interrupt invocation.
  if (expectedTurnId !== undefined && currentSdkTurnId(id) !== expectedTurnId) return false
  if (e.activeInput && !e.activeInput.submitted) {
    e.activeInput.cancelBeforeSubmit = true
    return true
  }
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
    const gate = e.gateWake
    e.gateWake = null
    gate?.()
    if (e.wake) {
      const w = e.wake
      e.wake = null
      w()
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
  if (!e || !e.reaped) return false
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
  shutdown = null
}

/** Test seam: rewind a finished session's `closedAt` by `ms`, so the retention
 *  sweep can be exercised without a wall-clock wait. Never call from server code. */
export const __ageClosedSessionForTests = (id: string, ms: number): void => {
  const e = pool.sessions.get(id)
  if (e?.closedAt !== undefined) e.closedAt -= ms
}
