import { describe, it, expect, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, statSync, writeFileSync, utimesSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CONTEXT_WINDOW_TOKENS,
  collectClaudeUsage,
  collectUsageBreakdown,
  resetJsonlWalkMemo,
  resetTranscriptScans,
  USAGE_BREAKDOWN_MAX_DAYS,
  sessionContextTokens,
} from './claudeUsage'

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

// sessionContextTokens — ONE session's current context fill (card 2's main source
// for the per-session gauge). Distinct from collectClaudeUsage's 5h QUOTA window:
// this reads the newest assistant line of ONE session's transcript, keyed by its
// uuid filename, and sums the tokens that turn carried in.
describe('sessionContextTokens — one session’s current context fill', () => {
  it('sums input + cache_read + cache_creation of the LAST assistant line', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    mkdirSync(join(dir, 'projX'), { recursive: true })
    const opus = 'claude-opus-4-8'
    // Keyed by the SESSION id (the filename), not the message id. Two turns; the
    // NEWEST (last) line is the current fill. Numbers are the card-1 spike's exact
    // readout (§3-B3): 10 + 21633 + 17205 = 38,848, which matched the CLI's own
    // `/context` 38.8k.
    writeFileSync(
      join(dir, 'projX', 'sess-abc.jsonl'),
      [
        rec(now, 'm1', 5, { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }, opus),
        rec(now, 'm2', 1, { input_tokens: 10, cache_read_input_tokens: 21633, cache_creation_input_tokens: 17205 }, opus),
      ].join('\n'),
    )
    expect(await sessionContextTokens('sess-abc', dir)).toBe(38_848)
  })

  it('is null for an unknown session, a missing dir, or an empty id', async () => {
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    writeFileSync(join(dir, 'sess-1.jsonl'), rec(Date.now(), 'm', 1, { input_tokens: 5 }, 'claude-opus-4-8'))
    expect(await sessionContextTokens('nope', dir)).toBeNull()
    expect(await sessionContextTokens('', dir)).toBeNull()
    expect(await sessionContextTokens('x', join(tmpdir(), 'og-usage-missing-xyz'))).toBeNull()
  })

  it('is null when the session file has no assistant line yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    writeFileSync(
      join(dir, 'sess-2.jsonl'),
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'hi' } }),
    )
    expect(await sessionContextTokens('sess-2', dir)).toBeNull()
  })

  // A compaction newer than the last reply IS the current fill (2026-09-18). The
  // boundary line's shape is the one claude actually wrote on a real supply desk
  // and on both throwaway probe desks (scripts/probe-desk-compact.mts).
  const boundary = (pre: number, post: unknown, trigger = 'manual') =>
    JSON.stringify({
      parentUuid: null,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      compactMetadata: { trigger, preTokens: pre, postTokens: post },
      timestamp: new Date().toISOString(),
    })

  it('after a compaction with no reply since, reports the POST-compaction fill', async () => {
    resetJsonlWalkMemo()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    const opus = 'claude-opus-4-8'
    writeFileSync(
      join(dir, 'sess-c1.jsonl'),
      [
        rec(Date.now(), 'm1', 1, { input_tokens: 10, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 5 }, opus),
        boundary(400_015, 15_794),
      ].join('\n'),
    )
    // Without the boundary rule this reads 400,015 — a desk that already
    // compacted would be compacted again every pass.
    expect(await sessionContextTokens('sess-c1', dir)).toBe(15_794)
  })

  it('a reply AFTER the compaction wins again (the boundary is only the latest fact until then)', async () => {
    resetJsonlWalkMemo()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    const opus = 'claude-opus-4-8'
    writeFileSync(
      join(dir, 'sess-c2.jsonl'),
      [
        rec(Date.now(), 'm1', 1, { input_tokens: 10, cache_read_input_tokens: 400_000 }, opus),
        boundary(400_010, 15_794, 'auto'),
        rec(Date.now(), 'm2', 1, { input_tokens: 3, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1_000 }, opus),
      ].join('\n'),
    )
    expect(await sessionContextTokens('sess-c2', dir)).toBe(21_003)
  })

  it('a boundary with no readable postTokens is "unknown" (null), never the stale pre-compaction number', async () => {
    resetJsonlWalkMemo()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    writeFileSync(
      join(dir, 'sess-c3.jsonl'),
      [rec(Date.now(), 'm1', 1, { input_tokens: 500_000 }, 'claude-opus-4-8'), boundary(500_000, undefined)].join('\n'),
    )
    expect(await sessionContextTokens('sess-c3', dir)).toBeNull()
  })

  it('pins the auto-compact denominator at 200k', () => {
    expect(CONTEXT_WINDOW_TOKENS).toBe(200_000)
  })

  // The context gauge polls the beacon, and the beacon resolves EVERY live
  // claude pane — so without memoisation one recursive listing of
  // ~/.claude/projects ran per pane per tick (the card-2 integration review's
  // hand-off #2). The listing is therefore reused for a few seconds.
  //
  // Its ONE observable cost is asserted here rather than left implicit: a
  // session file created inside that window is not listed yet, so a brand-new
  // session reads as "no number yet" for a tick. (The FILE behind a listed path
  // is still read fresh every call — see the next case — so a live session's
  // token count is never stale, which is the property that actually matters.)
  // Delete the memo and this case goes red: the new file would resolve at once.
  it('reuses the directory listing for a few seconds (new files land a tick late)', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    resetJsonlWalkMemo()
    writeFileSync(
      join(dir, 'sess-first.jsonl'),
      rec(now, 'm1', 1, { input_tokens: 100 }, 'claude-opus-4-8'),
    )
    expect(await sessionContextTokens('sess-first', dir)).toBe(100)

    // Appears AFTER the listing was taken — invisible until the memo expires.
    writeFileSync(
      join(dir, 'sess-second.jsonl'),
      rec(now, 'm2', 1, { input_tokens: 200 }, 'claude-opus-4-8'),
    )
    expect(await sessionContextTokens('sess-second', dir)).toBeNull()

    // …and the reset seam (what a test mutating one directory across ticks
    // reaches for) makes it visible immediately.
    resetJsonlWalkMemo()
    expect(await sessionContextTokens('sess-second', dir)).toBe(200)
  })

  it('re-reads a listed file every call, so a live session is never stale', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-'))
    resetJsonlWalkMemo()
    const file = join(dir, 'sess-live.jsonl')
    writeFileSync(file, rec(now, 'm1', 1, { input_tokens: 100 }, 'claude-opus-4-8'))
    expect(await sessionContextTokens('sess-live', dir)).toBe(100)

    // Same path, new turn appended (m2 is the NEWER line): the memo holds
    // PATHS, not contents.
    writeFileSync(
      file,
      [
        rec(now, 'm1', 1, { input_tokens: 100 }, 'claude-opus-4-8'),
        rec(now, 'm2', 0, { input_tokens: 4_200 }, 'claude-opus-4-8'),
      ].join('\n'),
    )
    expect(await sessionContextTokens('sess-live', dir)).toBe(4_200)
  })
})

// ── Who is burning the weekly budget (2026-09-02) ───────────────────────────
// The owner's question the HUD could not answer: half a weekly Fable budget
// gone with no heavy card running. Attribution is by the ONE thing the file
// path can prove — the cwd the session ran in — and the 'project' bucket is
// deliberately coarse (a desk and the owner's own claude both sit in the repo
// root, and nothing in the transcript separates them).
//
// MUTATIONS that turn this red: bill cache_read too (it is heavily discounted
// and would drown the real signal); drop the dedupe (resume/subagent copies
// inflate the same turn); widen the window past `days`; classify a worktree
// session as 'project'.
describe('collectUsageBreakdown — model × source over a multi-day window', () => {
  const DAY = 24 * HOUR
  it('splits swarm workers, the project (desks + own work) and everything else', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-breakdown-'))
    const wt = join(dir, '-Users-k--openground-projects-abc-worktrees-swarm-300-x')
    const proj = join(dir, '-Users-k-dev-QRmenu')
    const other = join(dir, '-Users-k-dev-somewhere-else')
    for (const d of [wt, proj, other]) mkdirSync(d, { recursive: true })
    // A worker turn, a desk/own turn in the registered project, and an unrelated one.
    writeFileSync(join(wt, 'a.jsonl'), rec(now, 'm1', 60, { input_tokens: 100, output_tokens: 10 }, 'claude-fable-5-1') + '\n')
    writeFileSync(join(proj, 'b.jsonl'), rec(now, 'm2', 60, { input_tokens: 40, cache_creation_input_tokens: 5 }, 'claude-fable-5-1') + '\n')
    writeFileSync(join(other, 'c.jsonl'), rec(now, 'm3', 60, { input_tokens: 7 }, 'claude-opus-5') + '\n')
    resetJsonlWalkMemo()
    const b = await collectUsageBreakdown({
      projectsDir: dir,
      days: 7,
      now,
      projectDirs: ['-Users-k-dev-QRmenu'],
    })
    expect(b.days).toBe(7)
    expect(b.rows).toEqual([
      { model: 'claude-fable-5-1', source: 'swarm-worker', tokens: 110 },
      { model: 'claude-fable-5-1', source: 'project', tokens: 45 },
      { model: 'claude-opus-5', source: 'other', tokens: 7 },
    ])
    expect(b.total).toBe(162)
  })

  it('ignores cache READS, dedupes a resumed turn, and stops at the window edge', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-breakdown-'))
    const d1 = join(dir, '-Users-k-dev-QRmenu')
    mkdirSync(d1, { recursive: true })
    // The SAME turn written twice (resume/subagent fan-out) must count once…
    const turn = rec(now, 'dup', 30, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 9_000 }, 'claude-fable-5-1')
    writeFileSync(join(d1, 'x.jsonl'), turn + '\n')
    writeFileSync(join(d1, 'y.jsonl'), turn + '\n')
    // …and a turn OUTSIDE the window must not count at all (fresh file mtime, old line).
    writeFileSync(
      join(d1, 'z.jsonl'),
      rec(now, 'old', 3 * 24 * 60, { input_tokens: 500 }, 'claude-fable-5-1') + '\n',
    )
    resetJsonlWalkMemo()
    const b = await collectUsageBreakdown({ projectsDir: dir, days: 1, now, projectDirs: ['-Users-k-dev-QRmenu'] })
    // 20 + 2, with the 9,000 cache READ excluded — billing matches the headline metric.
    expect(b.rows).toEqual([{ model: 'claude-fable-5-1', source: 'project', tokens: 22 }])
  })

  it('is empty (never throws) when the projects dir does not exist', async () => {
    resetJsonlWalkMemo()
    const b = await collectUsageBreakdown({ projectsDir: join(tmpdir(), 'og-nope-' + Date.now()), days: 7 })
    expect(b.rows).toEqual([])
    expect(b.total).toBe(0)
  })
})

// ── Incremental reading (2026-10-06) ─────────────────────────────────────────
// The beacon and the HUD poll these readers every few seconds; re-reading whole
// transcripts on every call was the server's largest idle CPU cost (≈160 MB of
// desk transcripts per beacon poll on the owner's machine). Each file is now
// read once and then only from where the last read stopped.
describe('transcripts are read incrementally', () => {
  const opus = 'claude-opus-4-8'

  // MUTATION that turns this red: drop the size/mtime early return in
  // advanceScan (re-read every call). The file's bytes change under a restored
  // size and mtime — only a reader that re-reads would see the new number.
  it('does not re-read a transcript whose size and mtime are unchanged', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-inc-'))
    resetTranscriptScans()
    resetJsonlWalkMemo()
    const file = join(dir, 'sess-still.jsonl')
    // Whole-second mtime so it can be restored exactly after the rewrite.
    const t = Math.floor(now / 1000) - 60
    writeFileSync(file, rec(now, 'm1', 1, { input_tokens: 100 }, opus) + '\n')
    utimesSync(file, t, t)
    expect(await sessionContextTokens('sess-still', dir)).toBe(100)
    const size = statSync(file).size
    writeFileSync(file, rec(now, 'm1', 1, { input_tokens: 900 }, opus) + '\n')
    utimesSync(file, t, t)
    expect(statSync(file).size).toBe(size)
    expect(await sessionContextTokens('sess-still', dir)).toBe(100)
  })

  it('picks up appended turns without counting earlier ones twice', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-inc-'))
    resetTranscriptScans()
    resetJsonlWalkMemo()
    const file = join(dir, 'sess-grow.jsonl')
    writeFileSync(file, rec(now, 'a1', 3, { input_tokens: 10, output_tokens: 1 }, opus) + '\n')
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(10)
    // Half a line first (claude mid-write), then the rest.
    const line = rec(now, 'a2', 1, { input_tokens: 20, cache_read_input_tokens: 5 }, opus)
    appendFileSync(file, line.slice(0, 30))
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(10)
    appendFileSync(file, line.slice(30) + '\n')
    const u = await collectClaudeUsage(dir)
    expect(u.tokens.input).toBe(30)
    expect(u.messageCount).toBe(2)
    expect(await sessionContextTokens('sess-grow', dir)).toBe(25)
  })

  it('counts an unterminated last line, and counts it once when it is finished', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-inc-'))
    resetTranscriptScans()
    resetJsonlWalkMemo()
    const file = join(dir, 'sess-tail.jsonl')
    writeFileSync(file, rec(now, 't1', 1, { input_tokens: 7 }, opus))
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(7)
    appendFileSync(file, '\n' + rec(now, 't2', 0, { input_tokens: 8 }, opus) + '\n')
    const u = await collectClaudeUsage(dir)
    expect(u.tokens.input).toBe(15)
    expect(u.messageCount).toBe(2)
  })

  // MUTATION that turns this red: skip the guard-bytes comparison — the resume
  // offset then lands inside the rewritten content and the old turn survives.
  it('re-reads from the start when a transcript is rewritten rather than appended to', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-inc-'))
    resetTranscriptScans()
    resetJsonlWalkMemo()
    const file = join(dir, 'sess-rw.jsonl')
    writeFileSync(file, rec(now, 'r1', 1, { input_tokens: 100 }, opus) + '\n')
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(100)
    writeFileSync(
      file,
      rec(now, 'r9', 2, { input_tokens: 4 }, opus) + '\n' + rec(now, 'r10', 1, { input_tokens: 5 }, opus) + '\n',
    )
    const u = await collectClaudeUsage(dir)
    expect(u.tokens.input).toBe(9)
    expect(u.messageCount).toBe(2)
  })

  // MUTATION that turns this red: drop pruneScans — the deleted file's scan
  // survives, and a new file at the same path with the same size and mtime is
  // answered from it.
  it('forgets a transcript once the walk no longer lists it', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-usage-inc-'))
    resetTranscriptScans()
    resetJsonlWalkMemo()
    const file = join(dir, 'sess-gone.jsonl')
    const t = Math.floor(now / 1000) - 60
    writeFileSync(file, rec(now, 'g1', 1, { input_tokens: 100 }, opus) + '\n')
    utimesSync(file, t, t)
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(100)
    rmSync(file)
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(0)
    writeFileSync(file, rec(now, 'g1', 1, { input_tokens: 900 }, opus) + '\n')
    utimesSync(file, t, t)
    expect((await collectClaudeUsage(dir)).tokens.input).toBe(900)
  })
})

describe('breakdown window cap', () => {
  // The scans keep entries for USAGE_BREAKDOWN_MAX_DAYS only, so a wider ask
  // must be served as the capped window — never a silently partial wider one.
  it('serves at most USAGE_BREAKDOWN_MAX_DAYS, however many days are asked for', async () => {
    const now = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'og-breakdown-cap-'))
    resetTranscriptScans()
    const sub = join(dir, '-Users-k-other')
    mkdirSync(sub)
    writeFileSync(
      join(sub, 's.jsonl'),
      [
        rec(now, 'old', 10 * 24 * 60, { input_tokens: 1_000 }, 'claude-opus-4-8'),
        rec(now, 'new', 60, { input_tokens: 5 }, 'claude-opus-4-8'),
      ].join('\n') + '\n',
    )
    const b = await collectUsageBreakdown({ projectsDir: dir, days: 30, now })
    expect(b.days).toBe(USAGE_BREAKDOWN_MAX_DAYS)
    expect(b.total).toBe(5)
  })
})
