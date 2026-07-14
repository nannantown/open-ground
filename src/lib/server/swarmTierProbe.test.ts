// swarmTierProbe — the pre-launch wall detector. Every case drives the exec
// SEAM (TierProbeDeps.exec) — CI never runs a real `claude` binary (realExec
// additionally trips a loud throw under vitest) — and the clock/TTL/wait
// window through deps, so verdict caching, collapse, the fail-open race and
// the cooling-table write are all deterministic. HOME is isolated suite-wide
// (setup-home.ts), so the markRateLimited disk mirror lands in a throwaway
// tmp dir.

import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import {
  classifyProbeOutput,
  ensureTierProbed,
  warmTierProbeAtBoot,
  TIER_PROBE_PROMPT,
  TIER_PROBE_RESULT_TTL_MS,
  TIER_PROBE_TIMEOUT_MS,
  __resetTierProbeForTest,
  type TierProbeExec,
  type TierProbeOutput,
} from './swarmTierProbe'
import { isTierCooling, markCoolingUntil, __resetQuotaForTest } from './swarmQuota'

// The CLI's per-model exhaustion notice, verbatim off the 2026-07-13 live probe
// (same wording as the 2026-07-09 worker sighting pinned in the orchestrator
// suite). THIS is the string /usage cannot express — the whole reason the
// probe exists.
const FABLE_LIMIT_NOTICE =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

const NOW = 1_760_000_000_000

const out = (o: Partial<TierProbeOutput>): TierProbeOutput => ({
  stdout: '',
  stderr: '',
  failed: false,
  ...o,
})

/** An exec mock that records calls and replies from a per-tier script. */
const makeExec = (
  reply: (tier: string) => TierProbeOutput | Promise<TierProbeOutput>,
): {
  exec: TierProbeExec
  calls: { bin: string; args: string[]; opts: { timeoutMs: number; cwd: string } }[]
} => {
  const calls: { bin: string; args: string[]; opts: { timeoutMs: number; cwd: string } }[] = []
  const exec: TierProbeExec = async (bin, args, opts) => {
    calls.push({ bin, args, opts })
    const tier = args[args.indexOf('--model') + 1]
    return reply(tier)
  }
  return { exec, calls }
}

/** Let a detached probe (started by an earlier ensureTierProbed whose wait
 *  window elapsed) finish recording: its exec has resolved, so one macrotask
 *  turn is enough for probeOnce's mark/cache writes to land. */
const flushDetached = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  __resetTierProbeForTest()
  __resetQuotaForTest()
})

// ── classifyProbeOutput (pure) — quota refusals ONLY, transients are unknown ─
//
// The polarity check (2026-07-13 review): here a false 'wall' KILLS a healthy
// tier for 20 persisted minutes across every spawn path, so the classifier may
// only trust quota-exhaustion wording — layer B's broader transient markers
// (529/500/backoff/too-many-requests) must classify 'unknown', not 'wall'.

describe('classifyProbeOutput — the CLI quota refusal is the ONLY wall signal', () => {
  it('reads the verbatim fable exhaustion notice as a wall', () => {
    expect(classifyProbeOutput(out({ stdout: FABLE_LIMIT_NOTICE }))).toBe('wall')
  })

  it('wall wins over the exit code — a refusal routinely arrives with failed:true', () => {
    expect(classifyProbeOutput(out({ stderr: FABLE_LIMIT_NOTICE, failed: true }))).toBe('wall')
  })

  it('sees the notice through ANSI escapes (normalizeScreen)', () => {
    const ESC = '\x1b'
    expect(
      classifyProbeOutput(out({ stdout: `${ESC}[31m${FABLE_LIMIT_NOTICE}${ESC}[0m` })),
    ).toBe('wall')
  })

  it('a clean answer is ok', () => {
    expect(classifyProbeOutput(out({ stdout: 'PROBE_OK' }))).toBe('ok')
  })

  it('a failure with NO refusal wording is unknown (fail-open), never a wall', () => {
    expect(classifyProbeOutput(out({ failed: true }))).toBe('unknown')
    expect(classifyProbeOutput(out({ stderr: 'spawn ETIMEDOUT', failed: true }))).toBe('unknown')
  })

  it('TRANSIENT faults are unknown — never a wall (the measured polarity flip)', () => {
    // Each of these matched layer B's broad RATE_LIMIT_PATTERNS and would have
    // cooled a healthy fable for 20 persisted minutes (2026-07-13 review).
    const transients = [
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', // 529
      'API Error (500) — internal server error', // api error … 500
      'Retrying in 30 seconds… (attempt 2/10)', // backoff
      '{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}', // 429
    ]
    for (const s of transients) {
      expect(classifyProbeOutput(out({ stderr: s, failed: true }))).toBe('unknown')
    }
  })

  it('a healthy answer that merely MENTIONS transient wording is ok (rc=0)', () => {
    expect(
      classifyProbeOutput(
        out({ stdout: 'PROBE_OK (note: too many requests can cause retries)' }),
      ),
    ).toBe('ok')
  })

  it('quota wording qualified by the model/usage/session forms is a wall', () => {
    expect(classifyProbeOutput(out({ stdout: 'usage limit reached', failed: true }))).toBe('wall')
  })
})

// ── ensureTierProbed — probe only when UNKNOWN, record what it learns ────────

describe('ensureTierProbed', () => {
  it('probes an unknown tier once: strict-mcp argv, neutral cwd, completion timeout', async () => {
    const { exec, calls } = makeExec(() => out({ stdout: 'PROBE_OK' }))
    const verdict = await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })
    expect(verdict).toBe('ok')
    expect(calls).toEqual([
      {
        bin: '/fake/claude',
        // --strict-mcp-config is load-bearing (security: no user-scope MCP
        // spawned outside a sandbox; latency: no repo/MCP boot) — pinned here.
        args: ['--model', 'fable', '-p', TIER_PROBE_PROMPT, '--strict-mcp-config'],
        // A neutral cwd, never the server's (the OG repo — measured 45s+ when
        // the probe boots the repo's CLAUDE.md/skills/MCP).
        opts: { timeoutMs: TIER_PROBE_TIMEOUT_MS, cwd: tmpdir() },
      },
    ])
  })

  it('a wall verdict COOLS the tier via the sensor write path (markRateLimited)', async () => {
    const { exec } = makeExec(() => out({ stdout: FABLE_LIMIT_NOTICE, failed: true }))
    expect(isTierCooling('fable', NOW)).toBe(false)
    const verdict = await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })
    expect(verdict).toBe('wall')
    expect(isTierCooling('fable', NOW)).toBe(true)
    // No reset wording in the notice ⇒ the flat 20-min grace applies.
    expect(isTierCooling('fable', NOW + 19 * 60_000)).toBe(true)
    expect(isTierCooling('fable', NOW + 21 * 60_000)).toBe(false)
  })

  it('a reset time embedded in the refusal sets the cooling horizon (ptyText ride-along)', async () => {
    const { exec } = makeExec(() =>
      out({ stdout: `${FABLE_LIMIT_NOTICE} Your limit resets in 45 minutes.`, failed: true }),
    )
    await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })
    expect(isTierCooling('fable', NOW + 44 * 60_000)).toBe(true)
    expect(isTierCooling('fable', NOW + 46 * 60_000)).toBe(false)
  })

  it('a TRANSIENT fault never cools the tier (fail-open end to end)', async () => {
    const { exec } = makeExec(() =>
      out({ stderr: '{"type":"error","error":{"type":"overloaded_error"}}', failed: true }),
    )
    expect(await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })).toBe(
      'unknown',
    )
    expect(isTierCooling('fable', NOW)).toBe(false)
  })

  it('an already-cooling tier is answered from the table — no child spawned', async () => {
    markCoolingUntil('fable', NOW + 60_000)
    const { exec, calls } = makeExec(() => out({ stdout: 'PROBE_OK' }))
    expect(await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })).toBe(
      'wall',
    )
    expect(calls).toHaveLength(0)
  })

  it('an ok verdict is cached for the TTL — launches do not re-probe every time', async () => {
    const { exec, calls } = makeExec(() => out({ stdout: 'PROBE_OK' }))
    let now = NOW
    const deps = { exec, bin: '/fake/claude', now: () => now }
    await ensureTierProbed('fable', deps)
    await ensureTierProbed('fable', deps)
    now += TIER_PROBE_RESULT_TTL_MS - 1
    await ensureTierProbed('fable', deps)
    expect(calls).toHaveLength(1) // one probe served three launches
    now += 2 // TTL elapsed
    await ensureTierProbed('fable', deps)
    expect(calls).toHaveLength(2)
  })

  it('an exec-failure unknown IS cached (a probe ran and learned nothing new)', async () => {
    const { exec, calls } = makeExec(() => out({ failed: true }))
    const deps = { exec, bin: '/fake/claude', now: () => NOW }
    expect(await ensureTierProbed('fable', deps)).toBe('unknown')
    expect(await ensureTierProbed('fable', deps)).toBe('unknown')
    expect(calls).toHaveLength(1)
    expect(isTierCooling('fable', NOW)).toBe(false)
  })

  it('concurrent launches COLLAPSE onto one in-flight probe per tier', async () => {
    let release!: (v: TierProbeOutput) => void
    const gate = new Promise<TierProbeOutput>((r) => {
      release = r
    })
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      calls.push(args[1])
      return gate
    }
    const deps = { exec, bin: '/fake/claude', now: () => NOW }
    const race = Promise.all([
      ensureTierProbed('fable', deps),
      ensureTierProbed('fable', deps),
      ensureTierProbed('fable', deps),
    ])
    release(out({ stdout: 'PROBE_OK' }))
    expect(await race).toEqual(['ok', 'ok', 'ok'])
    expect(calls).toHaveLength(1)
  })

  it('a non-ladder model string is never probed (unknown, fail-open)', async () => {
    const { exec, calls } = makeExec(() => out({ stdout: 'PROBE_OK' }))
    expect(await ensureTierProbed('gpt-5', { exec, bin: '/fake/claude', now: () => NOW })).toBe(
      'unknown',
    )
    expect(calls).toHaveLength(0)
  })

  it('a throwing exec seam degrades to unknown — a broken probe cannot break a launch', async () => {
    const exec: TierProbeExec = async () => {
      throw new Error('boom')
    }
    expect(await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })).toBe(
      'unknown',
    )
    expect(isTierCooling('fable', NOW)).toBe(false)
  })

  it('after a wall cools the tier, later calls answer from the table (no re-probe)', async () => {
    const { exec, calls } = makeExec(() => out({ stdout: FABLE_LIMIT_NOTICE, failed: true }))
    const deps = { exec, bin: '/fake/claude', now: () => NOW }
    expect(await ensureTierProbed('fable', deps)).toBe('wall')
    expect(await ensureTierProbed('fable', deps)).toBe('wall')
    expect(calls).toHaveLength(1)
  })

  // ── the no-binary path: uncached, and it must never wedge the tier ─────────

  it('spawn paths cannot reach a real CLI from a test: with no preflight, the default bin is null', async () => {
    // `bin` deliberately OMITTED — the resolver falls back to resolvedClaudeBin(),
    // which is null in any process that never ran claudeConnection(). Unit
    // suites exercising spawn paths (worker / manager / supply / brain / panel)
    // therefore never leak a probe onto the developer's installed `claude`; the
    // realExec vitest tripwire backs this up loudly.
    const { exec, calls } = makeExec(() => out({ stdout: 'PROBE_OK' }))
    expect(await ensureTierProbed('fable', { exec, now: () => NOW })).toBe('unknown')
    expect(calls).toHaveLength(0)
  })

  it('a null-bin unknown is NOT cached and does NOT wedge inFlight: the next call probes for real', async () => {
    // Regression (2026-07-13 review, MUST-FIX 4): the no-binary path settles
    // its promise without ever awaiting; a body-side finally used to delete
    // from inFlight BEFORE the caller's set(), leaving a settled 'unknown'
    // promise in the map that step 4 served FOREVER once the TTL cache lapsed
    // — permanently killing the probe for that tier. The fix registers first
    // and deregisters via .finally. Assert the EXEC CALL COUNT, not just the
    // verdict: the binary warming up (deps.bin now a string) must run a real
    // probe immediately (null-bin is also uncached — it is not a probe result).
    const { exec, calls } = makeExec(() => out({ stdout: 'PROBE_OK' }))
    expect(await ensureTierProbed('fable', { exec, bin: null, now: () => NOW })).toBe('unknown')
    expect(calls).toHaveLength(0)
    // Same clock — no TTL has elapsed. A cached/wedged 'unknown' would be
    // served here; the fixed path resolves the (now warm) binary and probes.
    expect(await ensureTierProbed('fable', { exec, bin: '/fake/claude', now: () => NOW })).toBe(
      'ok',
    )
    expect(calls).toHaveLength(1)
  })

  // ── the fail-open launch-wait race (probes measured 19-73s; launches wait 8s) ─

  it("a slow probe answers 'unknown' inside the wait window, completes detached, and the NEXT launch knows", async () => {
    let release!: (v: TierProbeOutput) => void
    const gate = new Promise<TierProbeOutput>((r) => {
      release = r
    })
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      calls.push(args[1])
      return gate
    }
    const deps = { exec, bin: '/fake/claude', now: () => NOW, launchWaitMs: 5 }
    // Launch 1: the probe is slower than the window — fail-open, launch proceeds.
    expect(await ensureTierProbed('fable', deps)).toBe('unknown')
    expect(isTierCooling('fable', NOW)).toBe(false)
    // …the DETACHED probe then completes with the real wall.
    release(out({ stdout: FABLE_LIMIT_NOTICE, failed: true }))
    await flushDetached()
    // Learning landed in the (persistent) cooling table: launch 2 steps down
    // without spawning another child.
    expect(isTierCooling('fable', NOW)).toBe(true)
    expect(await ensureTierProbed('fable', deps)).toBe('wall')
    expect(calls).toHaveLength(1)
  })

  it('a shared in-flight probe still honours EACH caller\'s wait window', async () => {
    const gate = new Promise<TierProbeOutput>(() => {}) // never resolves
    const exec: TierProbeExec = async () => gate
    const deps = { exec, bin: '/fake/claude', now: () => NOW }
    const first = ensureTierProbed('fable', { ...deps, launchWaitMs: 5 })
    // Second caller collapses onto the same child but must NOT block past its
    // own window either.
    const second = ensureTierProbed('fable', { ...deps, launchWaitMs: 5 })
    expect(await first).toBe('unknown')
    expect(await second).toBe('unknown')
  })

  it('launchWaitMs: 0 never blocks; Infinity awaits the full verdict', async () => {
    const { exec } = makeExec(() => out({ stdout: FABLE_LIMIT_NOTICE, failed: true }))
    const deps = { exec, bin: '/fake/claude', now: () => NOW }
    expect(await ensureTierProbed('fable', { ...deps, launchWaitMs: 0 })).toBe('unknown')
    await flushDetached() // the detached probe still completes and cools
    expect(isTierCooling('fable', NOW)).toBe(true)
    __resetQuotaForTest()
    __resetTierProbeForTest()
    expect(
      await ensureTierProbed('fable', { ...deps, launchWaitMs: Number.POSITIVE_INFINITY }),
    ).toBe('wall')
  })
})

// ── warmTierProbeAtBoot — detached, preflight-first, never throws ────────────

describe('warmTierProbeAtBoot', () => {
  it('preflights the connection, then probes the ladder head with an unbounded wait', async () => {
    const seen: { tier: string; waitMs?: number }[] = []
    let connected = false
    warmTierProbeAtBoot({
      connect: async () => {
        connected = true
      },
      probe: async (tier, deps) => {
        expect(connected).toBe(true) // preflight strictly BEFORE the probe
        seen.push({ tier, waitMs: deps.launchWaitMs })
        return 'ok'
      },
    })
    await flushDetached()
    expect(seen).toEqual([{ tier: 'fable', waitMs: Number.POSITIVE_INFINITY }])
  })

  it('a failing preflight is swallowed — boot never sees a rejection', async () => {
    let probed = false
    warmTierProbeAtBoot({
      connect: async () => {
        throw new Error('auth status timeout')
      },
      probe: async () => {
        probed = true
        return 'ok'
      },
    })
    await flushDetached()
    expect(probed).toBe(false) // no preflight ⇒ no probe, and no unhandled rejection
  })
})
