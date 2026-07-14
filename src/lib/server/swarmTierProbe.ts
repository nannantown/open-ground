// swarmTierProbe — the PRE-LAUNCH wall detector: ask the CLI itself whether a
// model tier can actually launch, BEFORE seating a swarm role on it.
//
// WHY THIS EXISTS (measured live, 2026-07-13): `/usage` (claude 2.1.207) prints
// only the two ACCOUNT-WIDE rows (Current session / Current week (all models));
// where 2.1.196 rendered per-model rows, a "Per-model breakdown unavailable"
// placeholder now sits. So a wall that belongs to ONE tier alone — that day,
// `claude --model fable -p …` refused with "You've reached your Fable 5 limit."
// while /usage read session 8% / week-all 64% — is INVISIBLE to every /usage
// reading (layer D is dormant for it, see docs/commander/04-quota-models.md
// §5.7). The only reliable pre-launch signal is the CLI's own refusal string:
// probe the tier with one short headless `-p` call and READ THE ANSWER.
//
// TIMING, measured on the dev machine (2026-07-13 review): a HEALTHY tier's
// probe is NOT fast — `claude -p` runs a full agent turn. Naked (no
// --strict-mcp-config, cwd = the OG repo) it loaded the repo's CLAUDE.md +
// skills + .mcp.json and took 45–73s; with --strict-mcp-config and a neutral
// cwd it measured ~19s (fable) / ~10s (haiku). A DRY tier's refusal latency is
// UNMEASURED (no wall was standing when this was written — do not assume it is
// fast). Those numbers drive two design choices:
//   • The probe NEVER holds a launch hostage: a launch waits at most
//     TIER_PROBE_LAUNCH_WAIT_MS (8s) for a verdict, then proceeds fail-open on
//     the desired tier while the probe RUNS TO COMPLETION detached
//     (TIER_PROBE_TIMEOUT_MS, 90s) and records what it learned — a wall lands
//     in the PERSISTENT cooling table, so the NEXT launch avoids it. Learning
//     is once-and-durable even when the first launch couldn't wait.
//   • Boot warms the top tier once, detached ({@link warmTierProbeAtBoot}), so
//     the first real launch after a restart usually finds the verdict already
//     cached instead of racing the 8s window.
//
// CONTRACT (card 2026-07-13, B+C "wait until you know"):
//   • Probe ONLY when the tier is UNKNOWN — no cooling mark (layer A) and no
//     usage veto (layer D). The cooling table is the wall-side cache; an
//     ok/unknown verdict is cached here (TTL) so launches don't re-probe every
//     time. Concurrent launches COLLAPSE onto one in-flight probe per tier.
//   • WALL ⇒ record it via the SAME write path the rate-limit sensor uses
//     (swarmQuota.markRateLimited — mirrored to disk by card f7857d9e), so the
//     ladder walk drops a rung and the mark survives a restart. A wall verdict
//     may ONLY come from the CLI's quota-refusal wording
//     (QUOTA_EXHAUSTION_PATTERNS) — a transient 529/500/backoff reads as
//     'unknown', because here a false positive would cool a HEALTHY tier for
//     20 persisted minutes (the sensor's broad patterns are safe only where a
//     false positive cannot kill; see swarmRateLimitText).
//   • FAIL-OPEN: timeout / spawn failure / unparseable output = "we still don't
//     know" — the launch proceeds on the desired tier. Not knowing is never a
//     reason to kill a tier (the 2026-07-12 user-confirmed policy).
//
// DEPENDENCIES are deliberately thin and one-way: swarmQuota (the cooling
// table), swarmRateLimitText (the quota-refusal wording), and
// claudeConnection's PREFLIGHTED binary. No engine import, no usage-cache
// import (the usage veto is applied by the caller's resolver walk, not here).

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { resolvedClaudeBin, claudeConnection } from './claudeConnection'
import { normalizeScreen, matchesQuotaExhaustion } from './swarmRateLimitText'
import {
  isTierCooling,
  markRateLimited,
  isModelTier,
  MODEL_TIER_LADDER,
  type ModelTier,
} from './swarmQuota'

const execFile = promisify(execFileCb)
const isWindows = process.platform === 'win32'

/** What one probe learned about a tier:
 *    • 'wall'    — the CLI refused with QUOTA-exhaustion wording; the tier
 *                  cannot launch (and has been cooled).
 *    • 'ok'      — the CLI answered; the tier has headroom right now.
 *    • 'unknown' — the probe couldn't say either (still running past the
 *                  launch-wait window / timeout / no binary / spawn error /
 *                  transient API fault). FAIL-OPEN: treat as launchable. */
export type TierProbeVerdict = 'wall' | 'ok' | 'unknown'

/** Hard ceiling on one probe CHILD's runtime — the detached completion budget,
 *  NOT what a launch waits (that is {@link TIER_PROBE_LAUNCH_WAIT_MS}). Sized
 *  from measurement: a healthy-tier probe ran 72.9s worst-case on the dev
 *  machine (2026-07-13, with --strict-mcp-config from the repo cwd), ~19s in
 *  the best case — so 90s covers the observed spread with margin. Past it the
 *  child is killed and the verdict is 'unknown' (fail-open). */
export const TIER_PROBE_TIMEOUT_MS = 90_000

/** The longest a LAUNCH may block on a probe verdict. Measured healthy-tier
 *  probes (19–73s) overrun any tolerable spawn delay, so a launch waits only
 *  this long: if the wall's refusal arrives inside the window (dry-tier
 *  latency is UNMEASURED — this is a chance to catch it, not a promise), the
 *  ladder steps down immediately; otherwise the launch proceeds fail-open on
 *  the desired tier and the probe keeps running detached — its verdict lands
 *  in the cooling table / TTL cache for the NEXT launch. Also bounds how long
 *  the engine's dispatch tick can stall on a spawn (worst case one window per
 *  wall actually confirmed, walking down the ladder). */
export const TIER_PROBE_LAUNCH_WAIT_MS = 8_000

/** How long an 'ok'/'unknown' verdict is trusted before the next launch may
 *  probe again. This is the "don't probe on every launch" cache (the card's
 *  Done ③): within it, launches reuse the verdict — a healthy tier costs one
 *  trivial prompt per window, not one per spawn. Deliberately SHORT of the
 *  cooling grace (20 min): a tier that dries up mid-window is caught by the
 *  existing reactive sensor (layer B) on the launch that hits it, exactly as
 *  before this module existed. Wall verdicts are NOT cached here — the cooling
 *  table itself is the wall-side memory (persistent, disk-mirrored). */
export const TIER_PROBE_RESULT_TTL_MS = 10 * 60_000

/** The fixed one-liner a probe sends. Trivial on purpose — though NOT free on a
 *  healthy tier: `claude -p` is a full agent turn (see the header timing), so
 *  the TTL cache above is what keeps the cost at one turn per window. */
export const TIER_PROBE_PROMPT = 'reply with exactly: PROBE_OK'

/** One probe attempt's raw outcome — what the child process said, plus whether
 *  it failed to run cleanly (non-zero exit / timeout / spawn error). The refusal
 *  wording routinely arrives WITH a non-zero exit, which is why `failed` alone
 *  never decides the verdict (see {@link classifyProbeOutput}). */
export interface TierProbeOutput {
  stdout: string
  stderr: string
  failed: boolean
}

/** The exec seam — injected by tests so CI NEVER runs a real `claude` binary
 *  (the suite mocks this; production uses the execFile default below). */
export type TierProbeExec = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string },
) => Promise<TierProbeOutput>

/** Classify one probe attempt. ORDER MATTERS: the refusal wording wins over the
 *  exit code — a dry tier both prints the refusal AND exits non-zero, and that
 *  is a confirmed wall, not an "unknown". Only a failure with NO refusal
 *  wording stays unknown (fail-open).
 *
 *  The patterns are the QUOTA-EXHAUSTION SUBSET of layer B's list
 *  (swarmRateLimitText.QUOTA_EXHAUSTION_PATTERNS) — NOT the full
 *  RATE_LIMIT_PATTERNS. The full list reads transient faults (529 overload,
 *  api error 500, "retrying in 30s", rate_limit_error, too many requests) as
 *  limits, which is safe for the sensor (a false positive only grants a live
 *  worker grace) but WRONG here, where it would markRateLimited a healthy tier
 *  for 20 persisted minutes off one flaky HTTP response (measured polarity
 *  flip, 2026-07-13 review). A transient fault therefore classifies 'unknown'
 *  — and a healthy answer that merely MENTIONS such wording (rc=0, "PROBE_OK
 *  (note: too many requests…)") classifies 'ok'. Pure. */
export const classifyProbeOutput = (out: TierProbeOutput): TierProbeVerdict => {
  const text = normalizeScreen(`${out.stdout}\n${out.stderr}`)
  if (text && matchesQuotaExhaustion(text)) return 'wall'
  return out.failed ? 'unknown' : 'ok'
}

// ── Probe state (globalThis singleton — survives tsx watch reloads) ──────────
//
// `known` caches ok/unknown verdicts (wall lives in the cooling table, not
// here); `inFlight` collapses concurrent launches onto one child process per
// tier. Same globalThis discipline as the cooling table and the usage cache —
// a dev reload must not forget an in-flight probe and double-spawn.
interface TierProbeState {
  known: Map<string, { verdict: 'ok' | 'unknown'; at: number }>
  inFlight: Map<string, Promise<TierProbeVerdict>>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_swarm_tier_probe: TierProbeState | undefined
}

const state: TierProbeState =
  globalThis.__openground_swarm_tier_probe ??
  (globalThis.__openground_swarm_tier_probe = { known: new Map(), inFlight: new Map() })

/** The `claude` binary a probe runs: EXACTLY the one the connection preflight
 *  validated (resolvedClaudeBin) — deliberately NOT the /usage scrape's wider
 *  PATH-walk fallback, and NOT the env override directly (claudeConnection
 *  already honours OPENGROUND_CLAUDE_BIN and folds it into resolvedClaudeBin).
 *  Production is warm where it matters — every spawn ROUTE runs the shared
 *  claude preflight (server/routes/swarm.ts), the UsageHud's 60s /api/usage
 *  poll re-runs claudeConnection(), and boot itself warms it
 *  ({@link warmTierProbeAtBoot}) — though none of that is a guarantee: a
 *  transient `auth status` timeout resets resolvedClaudeBin to null until the
 *  next preflight. A cold/reset resolution probes as 'unknown' = fail-open,
 *  and is NOT cached (no child ran — retry as soon as it warms). It also keeps
 *  a test that never preflights from reaching the developer's real CLI; the
 *  {@link realExec} vitest tripwire is the second, louder line of defence. */
const findClaudeBinary = (): string | null => resolvedClaudeBin()

/** Default exec: one headless `claude --model <tier> -p <prompt>
 *  --strict-mcp-config` child in a NEUTRAL cwd. Never rejects — a non-zero
 *  exit / timeout resolves with `failed: true` and whatever output the child
 *  managed (execFile attaches partial stdout/stderr to its error), because a
 *  refusal IS delivered through that path. shell:true on Windows so a
 *  `claude.cmd` shim actually executes (same as claudeConnection.authStatusOf). */
const realExec: TierProbeExec = async (bin, args, opts) => {
  // Tripwire, not a code path: unit suites must inject TierProbeDeps.exec. If
  // one ever reaches this default, fail loudly INSIDE vitest rather than spawn
  // the developer's real CLI (probeOnce reads the throw as 'unknown').
  if (process.env.VITEST)
    throw new Error('swarmTierProbe.realExec under vitest — inject TierProbeDeps.exec')
  try {
    const { stdout, stderr } = await execFile(bin, args, {
      timeout: opts.timeoutMs,
      cwd: opts.cwd,
      shell: isWindows,
      windowsHide: true,
    })
    return { stdout: String(stdout), stderr: String(stderr), failed: false }
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown }
    return {
      stdout: typeof err?.stdout === 'string' ? err.stdout : '',
      stderr: typeof err?.stderr === 'string' ? err.stderr : '',
      failed: true,
    }
  }
}

/** Injection points for tests (CI must never spawn a real CLI — the exec seam
 *  is mocked; `bin` short-circuits resolution; `now` drives the TTL cache;
 *  `launchWaitMs` drives the fail-open race — pass Infinity to await the full
 *  probe, as the boot warm-up does). */
export interface TierProbeDeps {
  exec?: TierProbeExec
  /** Explicit binary: a string runs it, null means "none found" (⇒ 'unknown').
   *  Omitted ⇒ resolve for real ({@link findClaudeBinary}). */
  bin?: string | null
  now?: () => number
  timeoutMs?: number
  ttlMs?: number
  /** How long THIS call blocks awaiting the verdict before answering 'unknown'
   *  (the probe itself keeps running detached). Default
   *  {@link TIER_PROBE_LAUNCH_WAIT_MS}; Infinity ⇒ await completion. */
  launchWaitMs?: number
}

/** Run ONE probe child to completion and RECORD what it learned. This is the
 *  detached body — {@link ensureTierProbed} registers it in `inFlight` and
 *  races the caller's wait window against it; by the time it settles, its
 *  verdict is already in the cooling table (wall) or the TTL cache
 *  (ok/unknown), so even a caller that stopped waiting benefits next launch.
 *
 *  A plain async function with the recording INSIDE — never throws:
 *    • no binary ⇒ 'unknown', NOT cached (no child ran; this is "preflight
 *      hasn't warmed yet", not a probe result — retry on the next call);
 *    • wall ⇒ markRateLimited (the sensor's own write path — mirrored to disk,
 *      lazy expiry; the raw output rides as ptyText so an embedded reset time
 *      beats the flat grace);
 *    • ok / unknown ⇒ cached here for the TTL (a throwing exec seam lands
 *      here too — a broken probe must not break launches, and 10 quiet
 *      minutes beats hammering a broken spawn). */
const probeOnce = async (
  tier: ModelTier,
  deps: TierProbeDeps,
  nowFn: () => number,
): Promise<TierProbeVerdict> => {
  try {
    const bin = deps.bin !== undefined ? deps.bin : findClaudeBinary()
    if (!bin) return 'unknown' // not a probe result — deliberately uncached
    const out = await (deps.exec ?? realExec)(
      bin,
      // --strict-mcp-config is NON-OPTIONAL (2026-07-13 review, two reasons):
      //  • SECURITY — the probe is exactly claudeTerminal's "non-sandboxed,
      //    auto-triggered utility session" class: without strict mode it would
      //    spawn every user-scope MCP server in ~/.claude.json OUTSIDE any
      //    sandbox, re-opening the RCE trigger OG deliberately closed (see
      //    claudeTerminal.ts strictMcpConfig), and could hang on an
      //    auth-pending server (the 0.11.12 incident class).
      //  • LATENCY — measured: without it (and with the repo as cwd) a probe
      //    loads CLAUDE.md + skills + MCP and ran 45–73s, past any usable
      //    window.
      ['--model', tier, '-p', TIER_PROBE_PROMPT, '--strict-mcp-config'],
      {
        timeoutMs: deps.timeoutMs ?? TIER_PROBE_TIMEOUT_MS,
        // A NEUTRAL cwd, never process.cwd(): the server's cwd is the OG repo,
        // and a probe launched there reads the repo's CLAUDE.md / .claude /
        // .mcp.json and becomes a fully-loaded agent session (measured 45s+).
        cwd: tmpdir(),
      },
    )
    const verdict = classifyProbeOutput(out)
    if (verdict === 'wall') {
      const until = markRateLimited(tier, {
        ptyText: `${out.stdout}\n${out.stderr}`,
        now: nowFn(),
      })
      console.warn(
        `[openground:swarm-probe] tier '${tier}' refused the pre-launch probe (wall) — cooling until ${new Date(until).toISOString()}`,
      )
    } else {
      state.known.set(tier, { verdict, at: nowFn() })
    }
    return verdict
  } catch {
    // A throwing exec seam (or any unexpected fault) must not break a launch:
    // not knowing is fail-open by contract.
    state.known.set(tier, { verdict: 'unknown', at: nowFn() })
    return 'unknown'
  }
}

/** Await `run` for at most `waitMs`, else answer 'unknown' while `run` keeps
 *  going (the fail-open race — see TIER_PROBE_LAUNCH_WAIT_MS). Infinity ⇒ no
 *  race. The timer never outlives the race (cleared + unref'd). */
const verdictWithin = async (
  run: Promise<TierProbeVerdict>,
  waitMs: number,
): Promise<TierProbeVerdict> => {
  if (!Number.isFinite(waitMs)) return run
  if (waitMs <= 0) return 'unknown'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run,
      new Promise<TierProbeVerdict>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), waitMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Probe `tier` iff nothing already knows its state, and RECORD what the probe
 *  learns. The single entry point the launch resolver calls
 *  (swarmLaunch.resolveAvailableTierProbed) — semantics, in order:
 *
 *    1. Not a ladder tier ⇒ 'unknown' (never probe arbitrary model strings).
 *    2. Cooling already marked ⇒ 'wall', no child spawned (the table IS the
 *       wall-side cache; this also terminates the resolver's walk-down loop).
 *    3. A fresh ok/unknown verdict (≤ ttl) ⇒ reuse it, no child spawned.
 *    4. A probe already in flight ⇒ share ITS verdict (concurrent launches
 *       collapse onto one child) — but still under THIS call's wait window.
 *    5. Otherwise start ONE detached probe ({@link probeOnce}) and wait at
 *       most `launchWaitMs` for its verdict; past that, answer 'unknown'
 *       (fail-open) while the probe completes in the background and records
 *       its result for the next launch.
 *
 *  NEVER throws, and never blocks longer than the wait window. */
export const ensureTierProbed = async (
  tier: string,
  deps: TierProbeDeps = {},
): Promise<TierProbeVerdict> => {
  if (!isModelTier(tier)) return 'unknown'
  const nowFn = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? TIER_PROBE_RESULT_TTL_MS
  const waitMs = deps.launchWaitMs ?? TIER_PROBE_LAUNCH_WAIT_MS

  if (isTierCooling(tier, nowFn())) return 'wall' // already known — the table is the cache
  const hit = state.known.get(tier)
  if (hit && nowFn() - hit.at < ttl) return hit.verdict

  const inFlight = state.inFlight.get(tier)
  if (inFlight) return verdictWithin(inFlight, waitMs)

  const run = probeOnce(tier, deps, nowFn)
  // Register BEFORE any chance to settle, and deregister via .finally — never
  // from inside the body. An async body runs synchronously to its first await,
  // so a body-side `finally { delete }` executes BEFORE the caller's set() on
  // the no-binary path (which awaits nothing) — leaving a SETTLED promise in
  // the map that step 4 would then serve forever once the TTL cache expired,
  // permanently killing the probe for that tier (2026-07-13 review). A settled
  // promise's .finally still runs as a microtask AFTER this set, so the
  // ordering holds by construction — for every early return the body has now
  // or grows later.
  state.inFlight.set(tier, run)
  void run.finally(() => state.inFlight.delete(tier))
  return verdictWithin(run, waitMs)
}

/** Warm the TOP tier's verdict at boot, detached — so the first launch after a
 *  restart (usually minutes later, and usually the commander) finds the answer
 *  already in the cooling table / TTL cache instead of racing its 8s window.
 *  Runs the claude preflight first: boot is exactly the moment
 *  resolvedClaudeBin is still cold, and the probe deliberately refuses to
 *  PATH-walk on its own. Fire-and-forget by contract: never throws, never
 *  blocks boot, and a failure costs nothing (the per-launch probe still runs).
 *  Deps are injectable for tests; production callers pass none. */
export const warmTierProbeAtBoot = (
  deps: {
    connect?: () => Promise<unknown>
    probe?: (tier: string, deps: TierProbeDeps) => Promise<TierProbeVerdict>
  } = {},
): void => {
  void (async () => {
    try {
      await (deps.connect ?? claudeConnection)() // validates + warms resolvedClaudeBin
      // Infinity: nothing is waiting on this verdict — let the child finish and
      // record, however long it takes (bounded by TIER_PROBE_TIMEOUT_MS).
      await (deps.probe ?? ensureTierProbed)(MODEL_TIER_LADDER[0], {
        launchWaitMs: Number.POSITIVE_INFINITY,
      })
    } catch {
      /* fail-open — the warm-up is a shortcut, never a dependency */
    }
  })()
}

/** Test-only: drop the verdict cache and in-flight map (globalThis singletons
 *  leak across cases otherwise — same discipline as __resetQuotaForTest). Not
 *  used in production. */
export const __resetTierProbeForTest = (): void => {
  state.known.clear()
  state.inFlight.clear()
}
