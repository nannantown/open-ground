import { describe, it, expect, beforeEach } from 'vitest'
import {
  runSupplyContextCapPass,
  resetSupplyContextCapState,
  COMPACT_RETRY_MS,
  type SupplyContextCapDeps,
} from './supplyContextCap'

// The supply desk's early compaction (owner decision 2026-09-18). Screens are
// LITERALS in the shape noticeDeliverable was measured against on a live desk
// (swarmOrchestrator.test.ts) — the three live-desk write refusals are the
// safety property, so they are exercised with real frames, not a stubbed gate.
const RULE = '─'.repeat(40)
const frame = (boxText: string, footer: string) =>
  ['⏺ done.', '', RULE, `❯ ${boxText}`, RULE, `  ${footer}`].join('\n')
const IDLE = frame('', '⏵⏵ bypass permissions on (shift+tab to cycle)')
const BUSY = frame('', '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt')
const HALF_TYPED = frame('次のカードは', '⏵⏵ bypass permissions on (shift+tab to cycle)')

const DESK = { id: 'term-s', cwd: '/repo/og', agentSessionId: 'supply-sid' }

const harness = (init: { tokens: number | null; screen?: string | null; cap?: number }) => {
  const h = {
    tokens: init.tokens,
    screen: init.screen === undefined ? IDLE : init.screen,
    cap: init.cap ?? 300_000,
    now: 1_000_000,
    sends: [] as string[],
    logs: [] as { path: string; level: string; msg: string }[],
  }
  const deps: Partial<SupplyContextCapDeps> = {
    desks: () => [DESK],
    isAlive: () => true,
    contextTokens: async () => h.tokens,
    cap: async () => h.cap,
    screen: () => h.screen,
    sendCompact: (id) => {
      h.sends.push(id)
      return true
    },
    log: (path, level, msg) => h.logs.push({ path, level, msg }),
    now: () => h.now,
  }
  return { h, deps }
}

beforeEach(() => resetSupplyContextCapState())

describe('supply desk context cap', () => {
  it('UNDER the cap ⇒ nothing is typed (the desk keeps growing as before)', async () => {
    const { h, deps } = harness({ tokens: 299_999 })
    await runSupplyContextCapPass(deps)
    expect(h.sends).toEqual([])
  })

  it('OVER the cap on an idle, empty desk ⇒ ONE compaction is typed', async () => {
    const { h, deps } = harness({ tokens: 346_000 })
    const r = await runSupplyContextCapPass(deps)
    expect(h.sends).toEqual(['term-s'])
    expect(r.sent).toEqual(['term-s'])
  })

  it('⚠ never writes into a busy desk, a half-typed box, or an unreadable screen', async () => {
    for (const screen of [BUSY, HALF_TYPED, null, '']) {
      resetSupplyContextCapState()
      const { h, deps } = harness({ tokens: 900_000, screen })
      await runSupplyContextCapPass(deps)
      expect(h.sends).toEqual([])
    }
  })

  it('sends once, waits for the compaction, then logs 「圧縮した(文脈 N → M)」 exactly once', async () => {
    const { h, deps } = harness({ tokens: 346_000 })
    await runSupplyContextCapPass(deps)
    // Still over the cap while it compacts (no boundary yet) — must NOT resend.
    h.now += 60_000
    await runSupplyContextCapPass(deps)
    expect(h.sends).toHaveLength(1)
    expect(h.logs).toEqual([])
    // The boundary lands: the fill now reads the post-compaction size.
    h.tokens = 12_345
    h.now += 60_000
    const r = await runSupplyContextCapPass(deps)
    expect(r.compacted).toEqual(['term-s'])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0].path).toBe('/repo/og')
    expect(h.logs[0].msg).toBe('補給官の卓を圧縮した(文脈 346,000 → 12,345)')
    await runSupplyContextCapPass(deps)
    expect(h.logs).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
  })

  it('a compaction that never lands is retried — after the retry window, not every pass', async () => {
    const { h, deps } = harness({ tokens: 346_000 })
    await runSupplyContextCapPass(deps)
    h.now += COMPACT_RETRY_MS - 1
    await runSupplyContextCapPass(deps)
    expect(h.sends).toHaveLength(1)
    h.now += 2
    await runSupplyContextCapPass(deps)
    expect(h.sends).toHaveLength(2)
  })

  it('cap 0 (off), an unmeasurable fill, or a desk with no session id ⇒ nothing typed', async () => {
    for (const init of [{ tokens: 900_000, cap: 0 }, { tokens: null }]) {
      resetSupplyContextCapState()
      const { h, deps } = harness(init)
      await runSupplyContextCapPass(deps)
      expect(h.sends).toEqual([])
    }
    const { h, deps } = harness({ tokens: 900_000 })
    await runSupplyContextCapPass({ ...deps, desks: () => [{ id: 'x', cwd: '/r' }] })
    expect(h.sends).toEqual([])
  })
})

