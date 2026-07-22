// swarmTierProbe — the COLD-BINARY self-warm path (2026-07-19 root cause of the 11-desk
// commander multiplication). This file is SEPARATE from swarmTierProbe.test.ts because it
// mocks './claudeConnection' at module scope to make resolvedClaudeBin() flip null → a
// binary the moment the preflight runs — the one thing the other file deliberately never
// does (it pins bin explicitly / asserts the null-bin tripwire).
//
// WHY THIS EXISTS. findClaudeBinary() reads a module-level cache in claudeConnection that
// ONLY claudeConnection() ever fills, and every spawn ROUTE runs that preflight — but the
// ENGINE's resuscitation reflex calls spawnSwarmManager directly, through NO route, so on
// that path resolvedClaudeBin() is whatever the last unrelated caller left: null after a
// cold start or a transient `auth status` timeout. A null binary made probeOnce answer
// 'unknown' WITHOUT SPAWNING A CHILD — the probe never ran on the one path that was burned
// in 2026-07-13 and burned again in 07-19 (four commander desks seated on a spent fable,
// each dying to "You've reached your Fable 5 limit."). The fix: the probe runs the
// preflight ITSELF when the binary is cold. The VITEST tripwire requires `connect` to be
// injected before it will warm, so a suite that injects neither bin nor connect still
// can't shell out to the developer's real CLI — that guard is exercised here too.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// The claude-connection cache, made mutable so a probe's own preflight can WARM it.
// resolvedClaudeBin() starts null (cold, the engine path); an injected `connect` is what
// flips `bin` — exactly what production's default claudeConnection() does after it
// validates the CLI. vi.hoisted because vi.mock factories hoist above module lets.
const conn = vi.hoisted(() => ({ bin: null as string | null }))
vi.mock('./claudeConnection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudeConnection')>()
  return {
    ...actual,
    resolvedClaudeBin: () => conn.bin,
    // A fallback warmer (unused by these tests — they inject `connect` — but keeps the
    // module shape honest if some other path ever reaches the default).
    claudeConnection: async () => {
      conn.bin = '/warm/claude'
      return {}
    },
  }
})

import { ensureTierProbed, __resetTierProbeForTest, type TierProbeExec } from './swarmTierProbe'
import { isTierCooling, __resetQuotaForTest } from './swarmQuota'

const NOW = 1_760_000_000_000
const FABLE_NOTICE =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

beforeEach(() => {
  __resetTierProbeForTest()
  __resetQuotaForTest()
  conn.bin = null // cold — nobody has preflighted (the engine's resuscitation path)
})

describe('swarmTierProbe — the cold engine path warms the binary ITSELF (2026-07-19 root cause)', () => {
  it('a COLD binary no longer makes the probe silently inert — it preflights, warms, then PROBES for real', async () => {
    let connectCalls = 0
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      calls.push(args[args.indexOf('--model') + 1])
      return { stdout: FABLE_NOTICE, stderr: '', failed: true } // the spent tier's refusal
    }
    expect(conn.bin).toBeNull() // cold at entry — the exact 07-19 state on the engine path

    const verdict = await ensureTierProbed('fable', {
      exec,
      // Models production's default claudeConnection(): it validates + warms resolvedClaudeBin.
      connect: async () => {
        connectCalls += 1
        conn.bin = '/warm/claude'
      },
      now: () => NOW,
      launchWaitMs: Number.POSITIVE_INFINITY, // await the full verdict (no race)
    })

    expect(connectCalls).toBe(1) // the probe warmed the binary ITSELF (was never called pre-fix)
    expect(calls).toEqual(['fable']) // …and then actually RAN a probe (calls was 0 before the fix)
    expect(verdict).toBe('wall') // the spent fable was detected
    expect(isTierCooling('fable', NOW)).toBe(true) // …and cooled, so the next spawn drops a tier
  })

  it('a preflight that STILL yields no binary stays fail-open (unknown, uncached) — retried next call', async () => {
    let connectCalls = 0
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      calls.push(args[args.indexOf('--model') + 1])
      return { stdout: 'PROBE_OK', stderr: '', failed: false }
    }
    const deps = {
      exec,
      connect: async () => {
        connectCalls += 1 /* the CLI is unreachable — bin stays null */
      },
      now: () => NOW,
      launchWaitMs: Number.POSITIVE_INFINITY,
    }
    expect(await ensureTierProbed('fable', deps)).toBe('unknown') // not knowing ≠ a wall
    expect(connectCalls).toBe(1) // it TRIED to warm
    expect(calls).toHaveLength(0) // no binary ⇒ no child spawned
    expect(isTierCooling('fable', NOW)).toBe(false) // fail-open: a cold CLI never cools a tier

    // NOT cached (no child ran) — the moment the binary warms, the very next call probes.
    conn.bin = '/warm/claude'
    expect(await ensureTierProbed('fable', { exec, now: () => NOW })).toBe('ok')
    expect(calls).toEqual(['fable']) // it re-probed immediately — the null-bin answer wasn't wedged
  })

  it('once the preflight has warmed the cache, a later probe needs NO connect (the route-warmed path)', async () => {
    conn.bin = '/warm/claude' // a spawn ROUTE already ran the preflight
    const calls: string[] = []
    const exec: TierProbeExec = async (_bin, args) => {
      calls.push(args[args.indexOf('--model') + 1])
      return { stdout: 'PROBE_OK', stderr: '', failed: false }
    }
    // No `connect` injected: warm bin short-circuits resolveBinWarming before the guard.
    expect(await ensureTierProbed('fable', { exec, now: () => NOW })).toBe('ok')
    expect(calls).toEqual(['fable'])
  })
})
