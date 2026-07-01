import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectClaudeUsage } from './claudeUsage'

// The local "~/.claude log aggregation" measurement source — one of the two
// sources behind GET /api/usage. (The other, which is what the gauge actually
// DISPLAYS as a %, is the authoritative `claude /usage` CLI scrape; see
// claudeUsageCli.parse.test.ts.) collectClaudeUsage emits ABSOLUTE token counts
// — there's no public subscription cap to turn them into a cap-relative % — so
// the HUD does not render these today; the API exposes them and this test pins
// their correctness. We point it at a throwaway fixture dir (collectClaudeUsage
// takes an optional projectsDir) so the real home is never touched, and seed
// records that exercise the behaviours the aggregation must get right:
//   1. dedupe the SAME assistant turn written into multiple jsonl files
//      (resume / branch / subagent fan-out) — else totals inflate wildly,
//   2. drop lines older than the 5-hour window by timestamp,
//   3. skip whole files whose mtime predates the window (never even read),
//   4. treat same messageId + DIFFERENT requestId as distinct turns.

const MIN = 60_000
const HOUR = 60 * MIN

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
const rec = (
  now: number,
  id: string,
  minutesAgo: number,
  usage: Usage,
  model: string,
  requestId?: string,
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(now - minutesAgo * MIN).toISOString(),
    requestId,
    message: { id, model, usage },
  })

describe('collectClaudeUsage — local jsonl aggregation', () => {
  it('dedupes turns, filters by window, and sums per model', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    mkdirSync(join(dir, 'projA'), { recursive: true })
    mkdirSync(join(dir, 'projB'), { recursive: true })

    const opus = 'claude-opus-4-8'
    const haiku = 'claude-haiku-4-5-20251001'

    // projA/a.jsonl — m1 (in window), an exact duplicate of m1, an
    // out-of-window m2 with huge tokens, plus noise lines that must be ignored.
    writeFileSync(
      join(dir, 'projA', 'a.jsonl'),
      [
        rec(now, 'm1', 1, { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 }, opus),
        rec(now, 'm1', 1, { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 }, opus),
        rec(now, 'm2', 360, { input_tokens: 999999, output_tokens: 999999, cache_creation_input_tokens: 999999, cache_read_input_tokens: 999999 }, opus),
        JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(), message: { content: 'hi' } }),
        'not even json{',
        '',
      ].join('\n'),
    )

    // projB/b.jsonl — m3 (in window, different model) and m1 again (dup across
    // files → must NOT be double-counted).
    writeFileSync(
      join(dir, 'projB', 'b.jsonl'),
      [
        rec(now, 'm3', 3, { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 2000 }, haiku),
        rec(now, 'm1', 2, { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 }, opus),
      ].join('\n'),
    )

    // projA/old.jsonl — an in-window-looking record, but the FILE mtime is
    // backdated past the window+slack so the whole file is skipped before read.
    const oldFile = join(dir, 'projA', 'old.jsonl')
    writeFileSync(
      oldFile,
      rec(now, 'mOld', 1, { input_tokens: 5000, output_tokens: 5000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 5000 }, opus),
    )
    const sevenHoursAgoSec = (now - 7 * HOUR) / 1000
    utimesSync(oldFile, sevenHoursAgoSec, sevenHoursAgoSec)

    const u = await collectClaudeUsage(dir)

    // Only m1 + m3 survive (dedup + window + mtime). m2 (out of window) and
    // mOld (stale file) contribute nothing despite their huge token counts.
    expect(u.tokens.input).toBe(300)
    expect(u.tokens.output).toBe(150)
    expect(u.tokens.cacheWrite).toBe(30)
    expect(u.tokens.cacheRead).toBe(3000)
    // total is the headline metric: input + output + cacheWrite (cache reads
    // are excluded — heavily discounted and would dwarf real consumption).
    expect(u.tokens.total).toBe(480)
    expect(u.messageCount).toBe(2)

    // Per-model billing uses the same metric (in + out + cacheWrite).
    expect(u.byModel[opus]).toBe(160)
    expect(u.byModel[haiku]).toBe(320)

    // currentModel = the most recent in-window turn (m1 @ 1min ago = opus).
    expect(u.currentModel).toBe(opus)
    expect(u.windowHours).toBe(5)

    // windowStart = oldest in-window turn (m3 @ 3min ago); reset = +5h.
    const expectedStart = new Date(now - 3 * MIN).toISOString()
    expect(u.windowStart).toBe(expectedStart)
    expect(u.nextResetAt).toBe(new Date(now - 3 * MIN + 5 * HOUR).toISOString())
  })

  it('same messageId with different requestId counts as distinct turns', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    const opus = 'claude-opus-4-8'
    // Claude Code can reuse a message id across requests, so the dedup key is
    // messageId|requestId — only an identical PAIR is a true duplicate. Here:
    // (dup,r1) and (dup,r2) are two real turns; the second (dup,r2) is dropped.
    writeFileSync(
      join(dir, 'c.jsonl'),
      [
        rec(now, 'dup', 1, { input_tokens: 10, output_tokens: 5 }, opus, 'r1'),
        rec(now, 'dup', 1, { input_tokens: 10, output_tokens: 5 }, opus, 'r2'),
        rec(now, 'dup', 1, { input_tokens: 10, output_tokens: 5 }, opus, 'r2'),
      ].join('\n'),
    )

    const u = await collectClaudeUsage(dir)
    expect(u.messageCount).toBe(2)
    expect(u.tokens.input).toBe(20)
    expect(u.tokens.output).toBe(10)
  })

  it('returns an empty (non-throwing) result when the dir is missing', async () => {
    const u = await collectClaudeUsage(join(tmpdir(), 'og-usage-does-not-exist-xyz'))
    expect(u.tokens.total).toBe(0)
    expect(u.messageCount).toBe(0)
    expect(u.currentModel).toBeNull()
    expect(u.windowStart).toBeNull()
  })
})
