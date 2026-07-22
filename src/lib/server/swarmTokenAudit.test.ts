import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeSession,
  analyzeSessionLines,
  auditSessionFile,
  classifyBashCommand,
  collectSwarmSessionFiles,
  describeAuditScope,
  formatConsumptionLine,
  isSwarmWorktreeSessionDir,
  localDayEdgeMs,
  mainRepoForWorktreeCwd,
  readWorkerConsumptionLine,
  resolveAuditScope,
  subagentsDirForSession,
  type SessionTokenAudit,
} from './swarmTokenAudit'

// ── Synthetic JSONL builders (the fixture language of every test here — no
//    real ~/.claude is ever read; file tests run in an mkdtemp sandbox) ──────

interface UsageOver {
  input?: number
  cacheCreation?: number
  cacheRead?: number
  output?: number
}

const usage = (over: UsageOver = {}) => ({
  input_tokens: over.input ?? 100,
  cache_creation_input_tokens: over.cacheCreation ?? 0,
  cache_read_input_tokens: over.cacheRead ?? 0,
  output_tokens: over.output ?? 10,
})

let blockN = 0
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id: `toolu_${++blockN}`,
  name,
  input,
})

const assistantLine = (opts: {
  id?: string
  sidechain?: boolean
  usage?: UsageOver
  content?: unknown[]
  timestamp?: string
  cwd?: string
  sessionId?: string
}): string =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    timestamp: opts.timestamp ?? '2026-07-18T00:00:00.000Z',
    cwd: opts.cwd ?? '/wt/x',
    sessionId: opts.sessionId ?? 'sess-fixture',
    message: {
      id: opts.id ?? `msg_${Math.abs(JSON.stringify(opts).length)}_${blockN}`,
      usage: usage(opts.usage),
      content: opts.content ?? [{ type: 'text', text: 'hi' }],
    },
  })

const userLine = (): string =>
  JSON.stringify({ type: 'user', timestamp: '2026-07-18T00:00:01.000Z', message: { content: [] } })

describe('analyzeSessionLines', () => {
  it('dedupes split lines by message.id and keeps the LAST usage snapshot — a ramping response bills its final output, not its first', () => {
    // The CLI writes one response as several lines, one per content block
    // (measured 910 lines = 461 ids on a real worker). Those lines usually
    // repeat the same usage — but not always: output_tokens RAMPS as the
    // response streams. Measured 2026-07-18 over 3292 multi-line responses:
    // 3291 identical, one going 3→3→2660→2660.
    //
    // So this fixture is deliberately UNEVEN. An all-500 fixture (what this test
    // used to carry) passes whether the implementation keeps the first, the last
    // or the max snapshot, which left the meter's core rule unpinned — mutating
    // it to first-wins kept the suite 29/29 green while undercounting that real
    // response 3 tokens instead of 2660.
    const lines = [
      assistantLine({ id: 'msg_1', usage: { output: 1 }, content: [{ type: 'thinking' }] }),
      assistantLine({ id: 'msg_1', usage: { output: 1 }, content: [{ type: 'text', text: 'a' }] }),
      assistantLine({ id: 'msg_1', usage: { output: 500 }, content: [toolUse('Bash', { command: 'ls' })] }),
    ]
    const audit = analyzeSessionLines(lines)!
    expect(audit.turns).toBe(1)
    // 500 = the last snapshot. NOT 1 (first-wins) and NOT 502 (summing).
    expect(audit.outputTokens).toBe(500)
    // The context fields never vary across split lines (0 of 3292 measured), so
    // they pin the no-summing rule on the other half of the usage object: the
    // three lines carry input 100 each, and the answer is 100, not 300.
    expect(audit.maxContext).toBe(100)
    expect(audit.toolUses).toBe(1)
    expect(audit.toolTurns).toBe(1)
    // NOTE: last-wins and max-wins stay indistinguishable here on purpose. Every
    // real ramp is monotonic and its last line always holds the peak (lastIsMax
    // 3292/3292), so only a decreasing fixture could separate them — and that
    // shape does not exist in the data this meter reads.
  })

  it('bills the subagents group apart from the main loop — ORIGIN decides, not a per-line flag', () => {
    // The regression guard for the bug this module shipped with. Subagent
    // responses arrive as their own FILE group; the per-line isSidechain flag is
    // deliberately left false here because real main JSONLs never carry it
    // (measured 2026-07-18: 0 occurrences across 127 recent session files). A
    // flag-based implementation passes the old test and bills nothing here.
    const audit = analyzeSession([
      { lines: [assistantLine({ id: 'msg_main', usage: { output: 100 } })], sidechain: false },
      {
        lines: [
          assistantLine({ id: 'msg_sub_a', usage: { output: 40 }, content: [toolUse('Read', { file_path: '/deep.ts' })] }),
          assistantLine({ id: 'msg_sub_b', usage: { output: 25, cacheRead: 900_000 } }),
        ],
        sidechain: true,
      },
    ])!
    expect(audit.turns).toBe(1)
    expect(audit.outputTokens).toBe(100)
    expect(audit.sidechainTurns).toBe(2)
    expect(audit.sidechainOutputTokens).toBe(65)
    // Subagent work must not leak into the card's main-loop shape metrics.
    expect(audit.readCount).toBe(0)
    expect(audit.toolUses).toBe(0)
    expect(audit.maxContext).toBe(100)
  })

  it('still honours an inline isSidechain flag (defensive only — not the production path)', () => {
    const audit = analyzeSessionLines([
      assistantLine({ id: 'msg_main', usage: { output: 100 } }),
      assistantLine({ id: 'msg_side', sidechain: true, usage: { output: 40 } }),
    ])!
    expect(audit.turns).toBe(1)
    expect(audit.sidechainOutputTokens).toBe(40)
  })

  it('束ね率 = tool_use blocks ÷ tool-carrying responses (tool-less turns excluded from the denominator)', () => {
    const lines = [
      assistantLine({ id: 'msg_a', content: [toolUse('Read', { file_path: '/a' }), toolUse('Read', { file_path: '/b' })] }),
      assistantLine({ id: 'msg_b', content: [toolUse('Bash', { command: 'ls' })] }),
      assistantLine({ id: 'msg_c', content: [{ type: 'text', text: 'no tools' }] }),
    ]
    const audit = analyzeSessionLines(lines)!
    expect(audit.turns).toBe(3)
    expect(audit.toolUses).toBe(3)
    expect(audit.toolTurns).toBe(2)
    expect(audit.bundleRate).toBeCloseTo(1.5)
  })

  it('bundleRate is null when no tool ever ran', () => {
    const audit = analyzeSessionLines([assistantLine({ id: 'msg_1' })])!
    expect(audit.bundleRate).toBeNull()
  })

  it('文脈max is the peak of input+cache_creation+cache_read across responses', () => {
    const lines = [
      assistantLine({ id: 'msg_1', usage: { input: 1000, cacheCreation: 2000, cacheRead: 3000 } }), // 6000
      assistantLine({ id: 'msg_2', usage: { input: 10, cacheCreation: 20, cacheRead: 336_000 } }), // 336030
    ]
    expect(analyzeSessionLines(lines)!.maxContext).toBe(336_030)
  })

  it('Read 再読 = total Read calls minus unique file_paths', () => {
    const lines = [
      assistantLine({ id: 'msg_1', content: [toolUse('Read', { file_path: '/same.ts' })] }),
      assistantLine({ id: 'msg_2', content: [toolUse('Read', { file_path: '/same.ts' })] }),
      assistantLine({ id: 'msg_3', content: [toolUse('Read', { file_path: '/other.ts' })] }),
    ]
    const audit = analyzeSessionLines(lines)!
    expect(audit.readCount).toBe(3)
    expect(audit.readRereads).toBe(1)
  })

  it('keeps a Read whose input never parsed OUT of 再読 — it carries no path to have re-read', () => {
    // Real shape, not a hypothetical: when the CLI cannot parse a tool input it
    // writes `{__unparsedToolInput:{raw:'…'}}` instead of the fields — measured
    // 3 of 629 Read calls across 80 recent sessions. Each one used to inflate
    // 再読 by one, because readCount grew while the unique-path set did not.
    const truncated = (raw: string) => toolUse('Read', { __unparsedToolInput: { raw } })
    const lines = [
      assistantLine({ id: 'msg_1', content: [toolUse('Read', { file_path: '/a.ts' })] }),
      assistantLine({ id: 'msg_2', content: [truncated('{"file_path": "/a.ts')] }),
      assistantLine({ id: 'msg_3', content: [truncated('{"file_path": "/b.ts')] }),
    ]
    const audit = analyzeSessionLines(lines)!
    expect(audit.readCount).toBe(3) // all three really were Read calls
    expect(audit.readRereads).toBe(0) // …but only one had a path: nothing is known to be re-read
  })

  it('classifies Bash commands tsc/test/lint/git/other, first match winning on compounds', () => {
    const cmds = [
      'npx tsc --noEmit',
      'npm test',
      'npx vitest run src/x.test.ts',
      'npx eslint . --ext .ts',
      'git status',
      'ls -la',
      'npx tsc --noEmit && npm test && npm run lint', // compound → leading intent (tsc)
    ]
    const lines = cmds.map((command, i) =>
      assistantLine({ id: `msg_${i}`, content: [toolUse('Bash', { command })] }),
    )
    expect(analyzeSessionLines(lines)!.bash).toEqual({ tsc: 2, test: 2, lint: 1, git: 1, other: 1 })
  })

  it('tolerates blank lines, non-JSON banners and usage-less events without skewing counts', () => {
    const lines = [
      '',
      'Welcome to Claude Code! (a stray CLI banner)',
      userLine(),
      JSON.stringify({ type: 'system', subtype: 'init' }),
      assistantLine({ id: 'msg_1', usage: { output: 7 } }),
    ]
    const audit = analyzeSessionLines(lines)!
    expect(audit.turns).toBe(1)
    expect(audit.outputTokens).toBe(7)
  })

  it('returns null when no assistant line carries usage (nothing to meter)', () => {
    expect(analyzeSessionLines([userLine(), ''])).toBeNull()
    expect(analyzeSessionLines([])).toBeNull()
  })

  it('extracts sessionId / cwd / first / last timestamps', () => {
    const lines = [
      assistantLine({ id: 'msg_1', timestamp: '2026-07-18T03:00:00.000Z', sessionId: 's-1', cwd: '/wt/card' }),
      assistantLine({ id: 'msg_2', timestamp: '2026-07-18T01:00:00.000Z', sessionId: 's-1', cwd: '/wt/card' }),
    ]
    const audit = analyzeSessionLines(lines)!
    expect(audit.sessionId).toBe('s-1')
    expect(audit.cwd).toBe('/wt/card')
    expect(audit.firstAt).toBe('2026-07-18T01:00:00.000Z')
    expect(audit.lastAt).toBe('2026-07-18T03:00:00.000Z')
  })
})

describe('classifyBashCommand', () => {
  it('maps each family and defaults to other', () => {
    expect(classifyBashCommand('npx tsc --noEmit')).toBe('tsc')
    expect(classifyBashCommand('npm run test')).toBe('test')
    expect(classifyBashCommand('npx playwright test')).toBe('test')
    expect(classifyBashCommand('npm run lint')).toBe('lint')
    expect(classifyBashCommand('git log --oneline')).toBe('git')
    expect(classifyBashCommand('bash ~/.claude/swarm-beat.sh done true "x"')).toBe('other')
  })
})

describe('formatConsumptionLine', () => {
  const base: SessionTokenAudit = {
    sessionId: 's',
    cwd: '/wt/x',
    firstAt: '',
    lastAt: '',
    turns: 191,
    toolUses: 200,
    toolTurns: 200,
    bundleRate: 1,
    maxContext: 336_000,
    outputTokens: 347_000,
    sidechainTurns: 0,
    sidechainOutputTokens: 0,
    readCount: 0,
    readRereads: 0,
    bash: { tsc: 0, test: 0, lint: 0, git: 0, other: 0 },
  }

  it("renders the goal's example shape — 手数/束ね/文脈max/出力 with k units", () => {
    expect(formatConsumptionLine(base)).toBe('手数191 束ね1.00 文脈max336k 出力347k')
  })

  it('appends sub出力(手数) only when the card actually spawned subagents, and dashes a tool-less bundle', () => {
    expect(formatConsumptionLine({ ...base, sidechainTurns: 23, sidechainOutputTokens: 12_400 })).toBe(
      '手数191 束ね1.00 文脈max336k 出力347k sub出力12k(手数23)',
    )
    // No subagents → no noise in the journal line.
    expect(formatConsumptionLine(base)).not.toContain('sub出力')
    expect(formatConsumptionLine({ ...base, bundleRate: null })).toContain('束ね-')
  })

  it('keeps sub-1000 numbers unscaled', () => {
    expect(formatConsumptionLine({ ...base, maxContext: 900, outputTokens: 42 })).toBe(
      '手数191 束ね1.00 文脈max900 出力42',
    )
  })
})

describe('auditSessionFile / readWorkerConsumptionLine (isolated fs)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-token-audit-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads and meters a session file', async () => {
    const p = join(dir, 'sess.jsonl')
    await writeFile(p, [assistantLine({ id: 'msg_1', usage: { output: 55 } }), ''].join('\n'))
    const audit = await auditSessionFile(p)
    expect(audit?.turns).toBe(1)
    expect(audit?.outputTokens).toBe(55)
  })

  // ── The real on-disk layout claude writes (verified 2026-07-18 against 226
  //    subagents dirs): the transcripts are a SIBLING DIRECTORY of the session
  //    file, never lines inside it.
  //        <dir>/<session-id>.jsonl
  //        <dir>/<session-id>/subagents/agent-<id>.jsonl
  //        <dir>/<session-id>/subagents/agent-<id>.meta.json
  const writeSessionWithSubagents = async (
    sessionFile: string,
    mainLines: string[],
    agents: Record<string, string[]>,
  ): Promise<void> => {
    await writeFile(sessionFile, mainLines.join('\n') + '\n')
    const subDir = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
    await mkdir(subDir, { recursive: true })
    for (const [agentId, lines] of Object.entries(agents)) {
      await writeFile(join(subDir, `agent-${agentId}.jsonl`), lines.join('\n') + '\n')
      // The sidecar claude drops next to each transcript — must never be parsed
      // as JSONL (it is a single JSON object, not one event per line).
      await writeFile(
        join(subDir, `agent-${agentId}.meta.json`),
        JSON.stringify({ agentType: 'Explore', description: 'map the thing', toolUseId: 'toolu_x', spawnDepth: 1 }),
      )
    }
  }

  it('bills subagents from the sibling subagents/ dir — the cost a main-file-only read dropped', async () => {
    const p = join(dir, 'sess.jsonl')
    await writeSessionWithSubagents(
      p,
      [assistantLine({ id: 'msg_main', usage: { output: 100 } })],
      {
        // Two agents, as a 4-lens review panel or an Explore fan-out produces.
        a1: [
          assistantLine({ id: 'msg_a1', usage: { output: 300 }, content: [toolUse('Read', { file_path: '/x.ts' })] }),
          assistantLine({ id: 'msg_a2', usage: { output: 200 } }),
        ],
        b2: [assistantLine({ id: 'msg_b1', usage: { output: 50 } })],
      },
    )
    const audit = (await auditSessionFile(p))!
    expect(audit.turns).toBe(1)
    expect(audit.outputTokens).toBe(100)
    expect(audit.sidechainTurns).toBe(3)
    expect(audit.sidechainOutputTokens).toBe(550)
    expect(audit.readCount).toBe(0) // subagent tools stay out of main-loop shape
  })

  it('descends into workflows/wf_*/ — the Workflow-tool fleet is a third of all subagent cost on disk', async () => {
    // Measured 2026-07-18: 882 flat agent transcripts vs 425 nested under
    // workflows/. A flat readdir bills the first group and silently drops the
    // second — the same class of miss as reading the session file alone.
    const p = join(dir, 'wf.jsonl')
    await writeSessionWithSubagents(p, [assistantLine({ id: 'msg_main', usage: { output: 100 } })], {
      flat: [assistantLine({ id: 'msg_flat', usage: { output: 30 } })],
    })
    const wfDir = join(dir, 'wf', 'subagents', 'workflows', 'wf_4ee1a58a-e99')
    await mkdir(wfDir, { recursive: true })
    await writeFile(join(wfDir, 'agent-a1.jsonl'), assistantLine({ id: 'msg_wf1', usage: { output: 400 } }) + '\n')
    await writeFile(join(wfDir, 'agent-a2.jsonl'), assistantLine({ id: 'msg_wf2', usage: { output: 250 } }) + '\n')
    // The workflow's own journal — started/result bookkeeping, never usage. It
    // must not be parsed even if a future version starts echoing agent output.
    await writeFile(
      join(wfDir, 'journal.jsonl'),
      [
        JSON.stringify({ type: 'started', agentId: 'a1' }),
        JSON.stringify({ type: 'result', agentId: 'a1', message: { usage: { output_tokens: 999_999 } } }),
      ].join('\n'),
    )

    const audit = (await auditSessionFile(p))!
    expect(audit.turns).toBe(1)
    expect(audit.sidechainTurns).toBe(3) // flat + both workflow agents
    expect(audit.sidechainOutputTokens).toBe(680) // 30 + 400 + 250 — journal excluded
  })

  // ── Spread-argument guard. `out.push(...lines)` hands V8 one argument per
  //    element and throws RangeError past roughly 114k of them (measured
  //    2026-07-18 on this runtime: 100k fine, 124k throws) — while the walk
  //    pushes whole transcripts AND whole subtrees, neither of which is bounded.
  //    Both fixtures below sit well past that so the guard is exercised even on
  //    a roomier stack. Blank lines are the cheap filler: the analyzer skips
  //    them, but they still occupy an argument slot.
  const OVER_SPREAD_LIMIT = 200_000

  it('fixture still exceeds THIS runtime\'s spread ceiling — the check that keeps the two guard tests below from going vacuous', () => {
    // The ceiling is a V8 implementation detail, not a spec'd constant, so a
    // future runtime may raise it above OVER_SPREAD_LIMIT. If that happens the
    // two tests below keep passing while testing nothing — a silent loss of
    // coverage that looks exactly like success. So measure it here instead of
    // trusting the 2026-07-18 number, and fail loudly when it stops holding.
    let threw: unknown = null
    try {
      const sink: number[] = []
      sink.push(...new Array(OVER_SPREAD_LIMIT).fill(0))
    } catch (e) {
      threw = e
    }
    expect(
      threw,
      `push(...) of ${OVER_SPREAD_LIMIT} elements no longer throws here, so the spread-guard tests below prove nothing — raise OVER_SPREAD_LIMIT until this fails again`,
    ).toBeInstanceOf(RangeError)
  })

  it('bills a transcript longer than the spread-argument limit — that RangeError is SWALLOWED, so the loss is silent', async () => {
    const p = join(dir, 'huge.jsonl')
    await writeFile(p, assistantLine({ id: 'msg_main', usage: { output: 10 } }) + '\n')
    const subDir = join(dir, 'huge', 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(
      join(subDir, 'agent-huge.jsonl'),
      '\n'.repeat(OVER_SPREAD_LIMIT) + assistantLine({ id: 'msg_huge', usage: { output: 42 } }) + '\n',
    )
    const audit = (await auditSessionFile(p))!
    // The per-file push sits inside a try/catch that `continue`s, so before the
    // fix this agent vanished from the bill with no error anywhere — a card that
    // ran one big subagent simply looked cheaper than it was.
    expect(audit.sidechainTurns).toBe(1)
    expect(audit.sidechainOutputTokens).toBe(42)
  })

  it('survives a SUBTREE longer than the spread-argument limit — that RangeError has no catch and kills the whole run', async () => {
    const p = join(dir, 'fleet.jsonl')
    await writeFile(p, assistantLine({ id: 'msg_main', usage: { output: 10 } }) + '\n')
    const wfDir = join(dir, 'fleet', 'subagents', 'workflows', 'wf_big')
    await mkdir(wfDir, { recursive: true })
    // Each file stays UNDER the limit; only their sum crosses it. That aims the
    // failure at the directory-level push — the site with no try/catch, whose
    // RangeError unwinds out of auditSessionFile and takes `npm run swarm:audit`
    // down with it (scripts/swarm-token-audit.ts awaits it bare).
    const per = Math.ceil(OVER_SPREAD_LIMIT / 4)
    for (const n of ['a1', 'a2', 'a3', 'a4']) {
      await writeFile(
        join(wfDir, `agent-${n}.jsonl`),
        '\n'.repeat(per) + assistantLine({ id: `msg_${n}`, usage: { output: 25 } }) + '\n',
      )
    }
    const audit = await auditSessionFile(p) // pre-fix: rejects with RangeError
    expect(audit!.sidechainTurns).toBe(4)
    expect(audit!.sidechainOutputTokens).toBe(100)
  })

  it('reports zero subagent cost when the dir is absent (the common case)', async () => {
    const p = join(dir, 'plain.jsonl')
    await writeFile(p, assistantLine({ id: 'msg_1', usage: { output: 55 } }) + '\n')
    const audit = (await auditSessionFile(p))!
    expect(audit.sidechainTurns).toBe(0)
    expect(audit.sidechainOutputTokens).toBe(0)
  })

  it('survives an unreadable agent transcript without losing the others', async () => {
    const p = join(dir, 'partial.jsonl')
    await writeSessionWithSubagents(p, [assistantLine({ id: 'msg_main', usage: { output: 10 } })], {
      good: [assistantLine({ id: 'msg_g', usage: { output: 70 } })],
    })
    // A half-written transcript (worker killed mid-flush) is skipped, not fatal.
    await writeFile(join(dir, 'partial', 'subagents', 'agent-torn.jsonl'), '{"type":"assist')
    const audit = (await auditSessionFile(p))!
    expect(audit.sidechainTurns).toBe(1)
    expect(audit.sidechainOutputTokens).toBe(70)
  })

  it('points subagentsDirForSession at the sibling dir', () => {
    expect(subagentsDirForSession('/root/proj/abc-123.jsonl')).toBe(join('/root/proj/abc-123', 'subagents'))
  })

  it('resolves null (never throws) for a missing or unmeterable file — the fail-safe contract', async () => {
    expect(await auditSessionFile(join(dir, 'nope.jsonl'))).toBeNull()
    const empty = join(dir, 'empty.jsonl')
    await writeFile(empty, 'not json at all\n')
    expect(await auditSessionFile(empty)).toBeNull()
    expect(await readWorkerConsumptionLine(join(dir, 'nope.jsonl'))).toBeNull()
  })

  it('renders the journal line for a real file', async () => {
    const p = join(dir, 'sess.jsonl')
    await writeFile(
      p,
      [
        assistantLine({ id: 'msg_1', usage: { output: 1000, cacheRead: 100_000 }, content: [toolUse('Bash', { command: 'ls' })] }),
        assistantLine({ id: 'msg_2', usage: { output: 500, cacheRead: 120_000 } }),
      ].join('\n'),
    )
    expect(await readWorkerConsumptionLine(p)).toBe('手数2 束ね1.00 文脈max120k 出力2k')
  })
})

describe('isSwarmWorktreeSessionDir', () => {
  const wt = '-Users-me--openground-projects-3de870a6-79fa-worktrees-card-0718-abc'
  it('matches only the openground-projects × worktrees signature', () => {
    expect(isSwarmWorktreeSessionDir(wt)).toBe(true)
    expect(isSwarmWorktreeSessionDir('-Users-me-projects-OPEN-GROUND')).toBe(false)
    expect(isSwarmWorktreeSessionDir('-Users-me--openground-projects-3de870a6-79fa')).toBe(false) // central data, no worktree
  })
  it('narrows by project uuid when given', () => {
    expect(isSwarmWorktreeSessionDir(wt, '3de870a6')).toBe(true)
    expect(isSwarmWorktreeSessionDir(wt, 'ffffffff')).toBe(false)
  })
})

describe('resolveAuditScope', () => {
  // A worktree cwd, in the exact on-disk shape isSwarmWorktreeSessionDir matches.
  const WT = '/Users/me/.openground/projects/3de870a679fa/worktrees/swarm-card-0718-abc'

  it('reads the cwd repo desks by default — a bare run covers 本体 repo + worktree, not worktrees alone', () => {
    // The gap this closes: worker worktrees were the whole default scan, so the
    // commander / supply desk sessions (which run in the repo, never in a
    // worktree) only appeared when you remembered --project.
    const scope = resolveAuditScope({ cwd: '/Users/me/projects/OPEN GROUND' })
    expect(scope.extraDirs).toEqual(['-Users-me-projects-OPEN-GROUND'])
    expect(scope.origin).toBe('cwd')
  })

  it('aims the desk read at --project instead of the cwd when one is given', () => {
    const scope = resolveAuditScope({
      project: '/Users/me/projects/other',
      cwd: '/Users/me/projects/OPEN GROUND',
    })
    expect(scope.extraDirs).toEqual(['-Users-me-projects-other'])
    expect(scope.deskName).toBe('other')
    expect(scope.origin).toBe('project')
  })

  // ── The must-fix. Aiming the desk read at a WORKTREE cwd adds nothing: that
  //    dir is already in the worker walk and Set-dedupes away. Commanders,
  //    workers and reviewers all run from a worktree, so this was the common
  //    path — and it under-reported by the heaviest sessions in the fleet
  //    (measured 2026-07-19: 37 rows from a worktree vs 60 from the main repo)
  //    while the header still announced desks were covered.
  it('resolves a WORKTREE cwd to its registered main repo — aiming at the worktree itself would add zero dirs', () => {
    const scope = resolveAuditScope({ cwd: WT, worktreeMainRepo: '/Users/me/projects/OPEN GROUND' })
    expect(scope.extraDirs).toEqual(['-Users-me-projects-OPEN-GROUND'])
    expect(scope.origin).toBe('worktree-main-repo')
    // The dir must NOT be the worktree's own — that is the no-op this replaced.
    expect(scope.extraDirs[0]).not.toContain('worktrees')
  })

  it('scans NO desk dir when a worktree cwd has no registered main repo — and never a dir the worker walk already holds', () => {
    const scope = resolveAuditScope({ cwd: WT, worktreeMainRepo: null })
    // Pre-fix this returned the worktree's own dir: a dir that changes nothing,
    // dressed up by the label as desk coverage.
    expect(scope.extraDirs).toEqual([])
    expect(scope.origin).toBe('none')
  })
})

describe('describeAuditScope', () => {
  const at = (origin: 'cwd' | 'none' | 'worktree-main-repo', rows: number) =>
    describeAuditScope(
      {
        extraDirs: origin === 'none' ? [] : ['-Users-me-projects-OPEN-GROUND'],
        deskDir: origin === 'none' ? null : '-Users-me-projects-OPEN-GROUND',
        deskName: origin === 'none' ? null : 'OPEN GROUND',
        origin,
      },
      rows,
    )

  it('states the desk count it actually got, so the sentence cannot outrun the walk', () => {
    expect(at('cwd', 23)).toContain('23 session(s)')
    expect(at('cwd', 23)).toContain('OPEN GROUND')
  })

  it('keeps "nothing was there" apart from "nothing was looked at" — the whole point of the line', () => {
    // Same shape on screen before the fix: both printed as desk coverage.
    const empty = at('cwd', 0)
    const unscanned = at('none', 0)
    expect(empty).toContain('none in this period')
    expect(unscanned).toContain('NOT scanned')
    expect(unscanned).not.toContain('none in this period')
    expect(empty).not.toEqual(unscanned)
  })

  it('never claims desk coverage when none was scanned', () => {
    // The regression in one assertion: the old label said "+ this repo's desk
    // sessions (…)" even when the walk had added no desk dir at all.
    const unscanned = at('none', 0)
    expect(unscanned).not.toMatch(/\+ desk sessions of/)
    expect(unscanned).toContain('--project')
  })

  it('says the desks came from the worktree\'s main repo, so the number is attributable', () => {
    expect(at('worktree-main-repo', 23)).toContain('resolved from this worktree')
  })
})

describe('mainRepoForWorktreeCwd (isolated home)', () => {
  // A real settings.json in a temp home — the resolver reads the registry, and a
  // fake would not prove the layout it depends on is the one on disk.
  let home: string
  const UUID = '3de870a679fa'

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'og-audit-home-'))
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({ projects: [{ id: UUID, path: '/Users/me/projects/OPEN GROUND', addedAt: 1 }] }),
    )
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const wt = (uuid: string) => join(home, 'projects', uuid, 'worktrees', 'swarm-card-0718-abc')

  it('maps a worktree cwd back to the repo registered under that uuid', async () => {
    expect(await mainRepoForWorktreeCwd(wt(UUID), { home })).toBe('/Users/me/projects/OPEN GROUND')
  })

  it('returns null for a cwd that is not a worktree — a plain repo keeps reading its own desks', async () => {
    expect(await mainRepoForWorktreeCwd('/Users/me/projects/OPEN GROUND', { home })).toBeNull()
    // …and for the projects dir itself, which is not under any worktrees/.
    expect(await mainRepoForWorktreeCwd(join(home, 'projects', UUID), { home })).toBeNull()
  })

  it('returns null for an unregistered uuid rather than guessing a repo', async () => {
    // Caller turns this into an out-loud "NOT scanned", never a silent no-op.
    expect(await mainRepoForWorktreeCwd(wt('deadbeefdead'), { home })).toBeNull()
  })

  it('returns null when the registry is unreadable instead of throwing into the run', async () => {
    await rm(join(home, 'settings.json'))
    expect(await mainRepoForWorktreeCwd(wt(UUID), { home })).toBeNull()
  })
})

describe('localDayEdgeMs', () => {
  it('spans the whole LOCAL day, so --until <day> keeps that day\'s sessions', () => {
    const start = localDayEdgeMs('2026-07-18', 'start')!
    const end = localDayEdgeMs('2026-07-18', 'end')!
    expect(new Date(start).getHours()).toBe(0)
    expect(new Date(end).getHours()).toBe(23)
    expect(end - start).toBe(86_400_000 - 1)
    // The bug this replaces: Date.parse() reads a bare date as UTC MIDNIGHT, so
    // a session finishing that morning already sorted past --until and got cut.
    const thatMorning = Date.parse('2026-07-18T06:00:00Z')
    expect(thatMorning).toBeGreaterThan(Date.parse('2026-07-18')) // dropped before
    expect(thatMorning).toBeLessThan(end) // kept now, in every timezone
  })

  it('returns null for any non-date form and for a rolled-over date', () => {
    expect(localDayEdgeMs('7d', 'start')).toBeNull()
    expect(localDayEdgeMs('2026-07-18T10:00:00Z', 'end')).toBeNull() // full ISO keeps exact semantics
    expect(localDayEdgeMs('2026-02-31', 'end')).toBeNull() // would silently mean Mar 3
    expect(localDayEdgeMs('2026-13-01', 'start')).toBeNull()
  })
})

describe('collectSwarmSessionFiles (isolated root — never the real ~/.claude)', () => {
  let root: string
  const wtDirA = '-Users-me--openground-projects-aaaa1111-worktrees-card-a'
  const wtDirB = '-Users-me--openground-projects-bbbb2222-worktrees-card-b'
  const repoDir = '-Users-me-projects-OPEN-GROUND'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'og-claude-root-'))
    for (const d of [wtDirA, wtDirB, repoDir]) {
      await mkdir(join(root, d), { recursive: true })
      await writeFile(join(root, d, 'sess-1.jsonl'), assistantLine({ id: 'msg_1' }) + '\n')
    }
    await writeFile(join(root, wtDirA, 'not-a-session.txt'), 'ignored')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds worker-worktree session files; plain repo dirs only via extraDirs', async () => {
    const bare = await collectSwarmSessionFiles({ root })
    expect(bare.map((r) => r.dir).sort()).toEqual([wtDirA, wtDirB])
    expect(bare.every((r) => r.file.endsWith('.jsonl'))).toBe(true)

    const withRepo = await collectSwarmSessionFiles({ root, extraDirs: [repoDir] })
    expect(withRepo.map((r) => r.dir).sort()).toEqual([wtDirA, wtDirB, repoDir].sort())
  })

  it('narrows workers by project uuid', async () => {
    const only = await collectSwarmSessionFiles({ root, projectUuid: 'aaaa1111' })
    expect(only.map((r) => r.dir)).toEqual([wtDirA])
  })

  it('pre-filters by file mtime without reading old files', async () => {
    const old = new Date('2026-01-01T00:00:00Z')
    await utimes(join(root, wtDirA, 'sess-1.jsonl'), old, old)
    const refs = await collectSwarmSessionFiles({ root, sinceMs: Date.parse('2026-07-01T00:00:00Z') })
    expect(refs.map((r) => r.dir)).toEqual([wtDirB])
  })

  it('resolves [] for a missing root (no throw)', async () => {
    expect(await collectSwarmSessionFiles({ root: join(root, 'does-not-exist') })).toEqual([])
  })
})
