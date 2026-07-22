import { readFile, readdir, realpath, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { basename, join, sep } from 'path'
import { homedir } from 'os'
import { openGroundHome } from './paths'
import { claudeDirName } from './claudeProjectDir'

// ---------------------------------------------------------------------------
// swarm token audit — the PERMANENT consumption meter (card: swarm-token).
//
// Answers "what did one card COST?" from the claude session JSONLs the CLI
// already writes (~/.claude/projects/<cwd-hyphenated>/<session-id>.jsonl) —
// the same storage transcript.ts reads. Everything here is READ-ONLY: no
// JSONL is ever written, and nothing under ~/.openground is touched.
//
// Two consumers share this module:
//   - scripts/swarm-token-audit.ts (`npm run swarm:audit`) — the on-demand
//     table over a period of swarm sessions (main repo + worker worktrees).
//   - swarmOrchestrator's promote site — one `consumption:` journal line the
//     moment a worker is judged done (readWorkerConsumptionLine below), so
//     every finished card leaves its cost in the engine journal.
//
// Metric definitions (2026-07-18 baseline: 手数/カード=101〜345 median 191,
// 束ね率=1.00, 文脈max=165k〜336k, 出力=175k〜347k per card):
//   - A RESPONSE (手数 unit) is one unique assistant message.id. The CLI
//     splits one API response across several JSONL lines (one per content
//     block — thinking / text / tool_use), each repeating the SAME usage
//     object, so counting lines (or summing their usage) double-counts;
//     measured 910 assistant lines = 461 unique ids on a real worker.
//   - 手数 (turns)      = unique non-sidechain responses carrying usage.
//   - 束ね率 (bundle)    = tool_use blocks ÷ responses containing ≥1 tool_use
//                         (1.00 = one tool per turn — no batching).
//   - 文脈 max          = max(input + cache_creation + cache_read) over
//                         non-sidechain responses — how big the context grew.
//   - 出力 (output)      = Σ output_tokens over non-sidechain responses.
//     Subagent (sidechain) cost is kept OUT of all of the above and summed
//     separately (sidechainTurns / sidechainOutputTokens) so main-loop cost
//     stays comparable card to card.
//
// WHERE SUBAGENT COST ACTUALLY LIVES (measured 2026-07-18, and the reason this
// module reads two places): the CLI does NOT write sidechain lines into the
// session file — `isSidechain:true` appears 0 times across 127 recent main
// JSONLs. Every subagent transcript goes to a SIBLING DIRECTORY instead:
//     ~/.claude/projects/<dir>/<session-id>.jsonl          ← main loop
//     ~/.claude/projects/<dir>/<session-id>/subagents/
//         agent-<id>.jsonl                                  ← Task/Explore agent
//         agent-<id>.meta.json                              ← {agentType,…}
//         workflows/wf_<id>/agent-<id>.jsonl                ← Workflow-tool fleet
//         workflows/wf_<id>/journal.jsonl                   ← started/result only
// Those lines carry the PARENT `sessionId`, so they attribute to the same card.
// Reading only the top-level file (as this module first did) silently dropped
// every Explore / adversarial-review-panel subagent from the bill. All 226
// subagents dirs on disk have their sibling .jsonl, so keying the lookup off
// the main session file misses nothing.
//   - Read 再読         = Read calls WITH a readable file_path, minus the unique
//                         paths among them. A Read whose tool input never parsed
//                         (`{__unparsedToolInput:{raw}}` — 3 of 629 measured)
//                         still counts in readCount but cannot be a re-read.
//   - bash 内訳         = Bash commands classified tsc/test/lint/git/other
//                         (first match wins, in that order).
// ---------------------------------------------------------------------------

/** Per-session (= per-card) consumption summary. All counts are derived from
 *  the session's OWN JSONL only (a re-dispatched card's second session is a
 *  second row — the CLI lists both; the journal line covers the promoted
 *  worker's session). */
export interface SessionTokenAudit {
  /** Session uuid (from the JSONL lines; '' when the file never says). */
  sessionId: string
  /** The session's working directory (first `cwd` seen; '' when absent). */
  cwd: string
  /** ISO timestamp of the first/last stamped line ('' when none). */
  firstAt: string
  lastAt: string
  /** 手数 — unique non-sidechain assistant responses carrying usage. */
  turns: number
  /** tool_use blocks across those responses (unique by block id). */
  toolUses: number
  /** Responses containing at least one tool_use. */
  toolTurns: number
  /** toolUses / toolTurns, or null when no tools ran. */
  bundleRate: number | null
  /** max(input + cache_creation + cache_read) over those responses. */
  maxContext: number
  /** Σ output_tokens over those responses. */
  outputTokens: number
  /** Subagent (sidechain) responses — from <session-id>/subagents/agent-*.jsonl,
   *  kept apart from 手数/出力 so main-loop cost stays comparable. */
  sidechainTurns: number
  sidechainOutputTokens: number
  /** Every Read tool_use call. */
  readCount: number
  /** Re-reads of an already-read file_path, counted only among the reads whose
   *  file_path was readable — so readCount ≥ readRereads, and a Read with an
   *  unparsed input inflates neither. */
  readRereads: number
  /** Bash command classification (first match wins: tsc→test→lint→git). */
  bash: { tsc: number; test: number; lint: number; git: number; other: number }
}

/** One assistant response being accumulated across its split JSONL lines. */
interface ResponseAcc {
  sidechain: boolean
  usage: { input: number; cacheCreation: number; cacheRead: number; output: number }
  /** tool_use blocks by block id (split lines never repeat a block, but the
   *  id-key makes a replayed line harmless). */
  tools: Map<string, { name: string; input: unknown }>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Classify one Bash command for the 内訳. First match wins — a compound
 *  `npx tsc --noEmit && npm test` counts as tsc (the leading intent). */
export const classifyBashCommand = (command: string): keyof SessionTokenAudit['bash'] => {
  if (/\btsc\b/.test(command)) return 'tsc'
  if (/\bvitest\b|\bnpm\s+(run\s+)?test\b|\bplaywright\b/.test(command)) return 'test'
  if (/\beslint\b|\bnpm\s+run\s+lint\b/.test(command)) return 'lint'
  if (/\bgit\b/.test(command)) return 'git'
  return 'other'
}

/** A batch of JSONL lines plus WHERE they came from. Subagent transcripts sit
 *  in their own files, so origin — not a per-line flag — is what makes a
 *  response sidechain (see the header note: the flag never appears in the main
 *  file on real data). */
export interface SessionLineGroup {
  lines: string[]
  /** True for lines read out of <session-id>/subagents/agent-*.jsonl. */
  sidechain: boolean
}

/** Analyze one session across its main + subagent line groups. Pure — no IO,
 *  no clock. Returns null when nothing carries usage at all (an aborted launch
 *  writes only system lines — nothing to meter). */
export const analyzeSession = (groups: SessionLineGroup[]): SessionTokenAudit | null => {
  const responses = new Map<string, ResponseAcc>()
  let anonCounter = 0
  let sessionId = ''
  let cwd = ''
  let firstAt = ''
  let lastAt = ''

  for (const group of groups) {
    for (const line of group.lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: any
      try {
        obj = JSON.parse(trimmed)
      } catch {
        continue // stray CLI banner — not an event
      }
      if (typeof obj?.timestamp === 'string' && obj.timestamp) {
        if (!firstAt || obj.timestamp < firstAt) firstAt = obj.timestamp
        if (!lastAt || obj.timestamp > lastAt) lastAt = obj.timestamp
      }
      if (!sessionId && typeof obj?.sessionId === 'string') sessionId = obj.sessionId
      if (!cwd && typeof obj?.cwd === 'string') cwd = obj.cwd

      if (obj?.type !== 'assistant') continue
      const usage = obj.message?.usage
      if (!usage || typeof usage !== 'object') continue

      // One API response = one message.id, split across lines; a line without an
      // id can't be joined to anything, so it stands alone as its own response.
      const id = typeof obj.message?.id === 'string' && obj.message.id ? obj.message.id : `anon-${anonCounter++}`
      let acc = responses.get(id)
      if (!acc) {
        acc = {
          // Origin decides; the per-line flag is honoured too, purely so a future
          // CLI that DOES inline sidechain lines degrades gracefully. Production
          // coverage comes from the subagents/ group, not from this flag.
          sidechain: group.sidechain || obj.isSidechain === true,
          usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
          tools: new Map(),
        }
        responses.set(id, acc)
      }
      // The split lines of one response usually REPEAT the same usage — but not
      // always: output_tokens can ramp as the response streams (measured
      // 2026-07-18 over 3292 multi-line responses: 3291 identical, 1 ramping
      // 3→3→2660→2660). The ramp is monotonic and the LAST line always carries
      // the final value (lastIsMax 3292/3292), so the latest snapshot wins —
      // summing double-counts, and pinning the FIRST would have booked 3 tokens
      // for a 2660-token response. input/cache_* never vary at all (0 of 3292).
      acc.usage = {
        input: num(usage.input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        output: num(usage.output_tokens),
      }
      const content = obj.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use') continue
          const blockId = typeof block.id === 'string' && block.id ? block.id : `t-${id}-${acc.tools.size}`
          if (!acc.tools.has(blockId)) acc.tools.set(blockId, { name: String(block.name ?? ''), input: block.input })
        }
      }
    }
  }

  if (responses.size === 0) return null

  let turns = 0
  let toolUses = 0
  let toolTurns = 0
  let maxContext = 0
  let outputTokens = 0
  let sidechainTurns = 0
  let sidechainOutputTokens = 0
  let readCount = 0
  let readsWithPath = 0
  const readPaths = new Set<string>()
  const bash = { tsc: 0, test: 0, lint: 0, git: 0, other: 0 }

  for (const acc of Array.from(responses.values())) {
    if (acc.sidechain) {
      sidechainTurns++
      sidechainOutputTokens += acc.usage.output
      continue
    }
    turns++
    outputTokens += acc.usage.output
    const context = acc.usage.input + acc.usage.cacheCreation + acc.usage.cacheRead
    if (context > maxContext) maxContext = context
    if (acc.tools.size > 0) {
      toolTurns++
      toolUses += acc.tools.size
    }
    for (const tool of Array.from(acc.tools.values())) {
      const input: any = tool.input
      if (tool.name === 'Read') {
        readCount++
        // A Read whose input never parsed carries no path to compare, so it must
        // stay OUT of the re-read arithmetic. The CLI writes those as
        // `{__unparsedToolInput:{raw:'…'}}` — measured 3 of 629 real Read calls —
        // and counting them only in readCount booked each one as a phantom
        // re-read (readCount grew, the unique-path set did not).
        const p = typeof input?.file_path === 'string' ? input.file_path : ''
        if (p) {
          readsWithPath++
          readPaths.add(p)
        }
      } else if (tool.name === 'Bash') {
        bash[classifyBashCommand(String(input?.command ?? ''))]++
      }
    }
  }

  if (turns === 0 && sidechainTurns === 0) return null

  return {
    sessionId,
    cwd,
    firstAt,
    lastAt,
    turns,
    toolUses,
    toolTurns,
    bundleRate: toolTurns > 0 ? toolUses / toolTurns : null,
    maxContext,
    outputTokens,
    sidechainTurns,
    sidechainOutputTokens,
    readCount,
    // Only reads with a known path can be judged re-reads; ≥0 by construction.
    readRereads: readsWithPath - readPaths.size,
    bash,
  }
}

/** Main-file-only convenience wrapper (pure). Callers that want a card's FULL
 *  bill — subagents included — must go through auditSessionFile. */
export const analyzeSessionLines = (lines: string[]): SessionTokenAudit | null =>
  analyzeSession([{ lines, sidechain: false }])

/** Where claude keeps a session's subagent transcripts: the session file minus
 *  its `.jsonl`, then `subagents/` (see the header note). */
export const subagentsDirForSession = (sessionFile: string): string =>
  join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')

/** The subagents tree is NOT flat — measured 2026-07-18, two shapes coexist:
 *      subagents/agent-<id>.jsonl                    ← Task / Explore subagents (882 on disk)
 *      subagents/workflows/wf_<id>/agent-<id>.jsonl  ← Workflow-tool fleets    (425 on disk)
 *  so the walk RECURSES; a flat readdir drops a third of all subagent cost.
 *  Depth is bounded purely as a runaway guard (real depth is 2). */
const SUBAGENT_WALK_MAX_DEPTH = 4

/** Collect every `agent-*.jsonl` line under a subagents tree. The name filter is
 *  load-bearing on both ends: it skips the `agent-*.meta.json` sidecars AND a
 *  workflow's `journal.jsonl` (started/result bookkeeping — no usage today, but
 *  reading it would silently start double-counting if that ever changes).
 *  READ-ONLY; an absent dir or one unreadable transcript never sinks the rest. */
const readAgentTranscripts = async (dir: string, depth: number): Promise<string[]> => {
  if (depth > SUBAGENT_WALK_MAX_DEPTH) return []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return [] // no subagent ever ran — the common case, not an error
  }
  const out: string[] = []
  // NEVER `out.push(...lines)` below. Spread passes every element as a separate
  // argument and V8 throws RangeError past roughly 114k of them (measured
  // 2026-07-18: 100k fine, 124k throws) — and BOTH sites here accumulate an
  // unbounded line count: one transcript, or an entire workflows/ subtree. The
  // two failure modes are different and both bad:
  //   - the file site sits inside a try/catch, so its RangeError would be
  //     SWALLOWED and that agent's cost would vanish from the bill in silence;
  //   - the directory site has no catch, so its RangeError unwinds through
  //     auditSessionFile and kills the whole `npm run swarm:audit` run.
  // Today's biggest real subtree is 4550 lines, so this is a latent guard rather
  // than a live bug — the loops keep it latent as fleets grow.
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const line of await readAgentTranscripts(full, depth + 1)) out.push(line)
    } else if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
      let content: string
      try {
        content = await readFile(full, 'utf8')
      } catch {
        continue
      }
      for (const line of content.split('\n')) out.push(line)
    }
  }
  return out
}

/** Every subagent transcript line for a session, flattened. */
const readSubagentLines = (sessionFile: string): Promise<string[]> =>
  readAgentTranscripts(subagentsDirForSession(sessionFile), 0)

/** Read + analyze one session: the main JSONL PLUS its subagents/ transcripts,
 *  so a card's bill includes the Explore / review-panel agents it spawned.
 *  READ-ONLY; resolves null when the main file is missing/unreadable/unmeterable
 *  — the fail-safe every caller relies on. */
export const auditSessionFile = async (path: string): Promise<SessionTokenAudit | null> => {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return null
  }
  // A broken subagents tree costs only the subagent numbers — never the card.
  // (readAgentTranscripts already swallows per-file errors; this catches the
  // walk itself, so the documented "resolves, never throws" contract the
  // promote site relies on holds for unforeseen failures too.)
  let subLines: string[] = []
  try {
    subLines = await readSubagentLines(path)
  } catch {
    subLines = []
  }
  try {
    return analyzeSession([
      { lines: content.split('\n'), sidechain: false },
      { lines: subLines, sidechain: true },
    ])
  } catch {
    return null
  }
}

/** Compact token display: 336_000 → '336k', 900 → '900'. */
const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** The one-line summary the engine journal records on a worker's done —
 *  mirrors the goal's example: 「consumption: 手数191 束ね1.0 文脈max336k 出力347k」. */
export const formatConsumptionLine = (audit: SessionTokenAudit): string => {
  const bundle = audit.bundleRate === null ? '-' : audit.bundleRate.toFixed(2)
  // Subagents are appended only when the card actually spawned some — with the
  // turn count, since 出力 alone can't say whether it was one Explore or a
  // four-lens review panel.
  const side =
    audit.sidechainTurns > 0
      ? ` sub出力${k(audit.sidechainOutputTokens)}(手数${audit.sidechainTurns})`
      : ''
  return `手数${audit.turns} 束ね${bundle} 文脈max${k(audit.maxContext)} 出力${k(audit.outputTokens)}${side}`
}

/** The promote-site helper: meter the just-finished worker's session and
 *  render the journal line. Null (silently — fail-safe by contract: never
 *  disturb spawn/monitoring) when the JSONL can't be found or read. */
export const readWorkerConsumptionLine = async (
  jsonlPath: string,
): Promise<string | null> => {
  const audit = await auditSessionFile(jsonlPath)
  return audit ? formatConsumptionLine(audit) : null
}

// ── Session discovery (the CLI's walk) ──────────────────────────────────────

/** Root claude persists sessions under. Overridable for tests (isolated HOME
 *  fixtures) and resolved per call — never cached — so a test's HOME swap wins. */
export const defaultClaudeProjectsRoot = (): string => join(homedir(), '.claude', 'projects')

/** Does this ~/.claude/projects entry name a SWARM WORKER worktree session dir?
 *  Worker cwds live under ~/.openground/projects/<uuid>/worktrees/<branch>, which
 *  claude hyphenates to `…--openground-projects-<uuid>-worktrees-<branch>` — the
 *  two markers together are the swarm signature (a scanned user repo can't
 *  produce them: the central data root is not a registrable project). When
 *  `projectUuid` is given, only that project's worktrees match. */
export const isSwarmWorktreeSessionDir = (dirName: string, projectUuid?: string): boolean => {
  if (!dirName.includes('-openground-projects-') || !dirName.includes('-worktrees-')) return false
  if (projectUuid && !dirName.includes(projectUuid)) return false
  return true
}

export interface SessionFileRef {
  /** Absolute path of the session JSONL. */
  file: string
  /** The ~/.claude/projects entry it sits in (the hyphenated cwd). */
  dir: string
  /** File mtime (epoch ms) — the cheap period pre-filter. */
  mtimeMs: number
}

/** Enumerate candidate swarm session JSONLs under `root` (default:
 *  ~/.claude/projects): every worker-worktree dir, plus `extraDirs` (the main
 *  repo's own dir, where the commander/supply desks run). Files whose mtime is
 *  older than `sinceMs` are skipped without being read. READ-ONLY. */
export const collectSwarmSessionFiles = async (opts: {
  root?: string
  projectUuid?: string
  extraDirs?: string[]
  sinceMs?: number
}): Promise<SessionFileRef[]> => {
  const root = opts.root ?? defaultClaudeProjectsRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const dirs = new Set<string>(entries.filter((d) => isSwarmWorktreeSessionDir(d, opts.projectUuid)))
  for (const extra of opts.extraDirs ?? []) if (entries.includes(extra)) dirs.add(extra)

  const out: SessionFileRef[] = []
  for (const dir of Array.from(dirs)) {
    let files: string[]
    try {
      files = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const file = join(root, dir, f)
      try {
        const s = await stat(file)
        if (!s.isFile()) continue
        if (opts.sinceMs !== undefined && s.mtimeMs < opts.sinceMs) continue
        out.push({ file, dir, mtimeMs: s.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/** Where the DESK sessions in scope came from. Named rather than boolean because
 *  the header has to tell 'nothing was there' apart from 'nothing was looked
 *  at' — the distinction the whole scope line exists to make. */
export type DeskOrigin =
  | 'project' // --project <path>
  | 'worktree-main-repo' // cwd is a worker worktree → its registered main repo
  | 'cwd' // plain run from a repo
  | 'none' // cwd is a worktree whose main repo could not be resolved

/** What a run scans BEYOND the worker worktrees. Deliberately NOT a finished
 *  label: the text is built afterwards by describeAuditScope from what actually
 *  arrived, because an intent-derived label is exactly how this lied before. */
export interface AuditScope {
  /** ~/.claude/projects dir names to add to the worktree walk. */
  extraDirs: string[]
  /** The dir desk sessions would land in — the key for counting what arrived. */
  deskDir: string | null
  /** Repo basename for the header. */
  deskName: string | null
  origin: DeskOrigin
}

/** Decide the scan scope. A bare `npm run swarm:audit` used to walk worker
 *  worktrees ONLY, so the commander / supply DESK sessions — which run in the
 *  repo itself, never in a worktree — were invisible unless you passed
 *  --project, and the card's "本体 repo + worktree" goal was half met by default.
 *
 *  The subtlety that made the first fix wrong: reading "the desks of the cwd"
 *  is a NO-OP when the cwd is itself a worker worktree, because that dir is
 *  already in the worker walk and Set-dedupes away — and commanders, workers and
 *  reviewers nearly always run from inside a worktree. Measured 2026-07-19:
 *  37 sessions from a worktree vs 60 from the main repo, the 23 missing rows
 *  being the desk sessions, which are the heaviest ones. So when the cwd is a
 *  worktree we aim at its REGISTERED MAIN REPO instead (resolved by the caller
 *  via mainRepoForWorktreeCwd), and if that cannot be resolved we say so rather
 *  than claim a coverage the walk never delivered.
 *
 *  `cwdIsWorktree` is decided with isSwarmWorktreeSessionDir — the very
 *  predicate the worker walk uses — so "would this dedupe?" cannot drift apart
 *  from "did this dedupe?". */
export const resolveAuditScope = (opts: {
  project?: string
  cwd: string
  /** Registered main repo when cwd is a worktree; see mainRepoForWorktreeCwd. */
  worktreeMainRepo?: string | null
}): AuditScope => {
  const pick = (path: string, origin: DeskOrigin): AuditScope => ({
    extraDirs: [claudeDirName(path)],
    deskDir: claudeDirName(path),
    deskName: basename(path),
    origin,
  })
  if (opts.project) return pick(opts.project, 'project')
  if (opts.worktreeMainRepo) return pick(opts.worktreeMainRepo, 'worktree-main-repo')
  if (!isSwarmWorktreeSessionDir(claudeDirName(opts.cwd))) return pick(opts.cwd, 'cwd')
  return { extraDirs: [], deskDir: null, deskName: null, origin: 'none' }
}

/** The header's scope line. Takes the number of desk rows that ACTUALLY landed,
 *  so the sentence can never outrun the walk: an empty desk reads "none in this
 *  period", an unscanned one reads "not scanned", and they never look alike. */
export const describeAuditScope = (scope: AuditScope, deskRows: number): string => {
  const workers = scope.origin === 'project' ? `worker worktrees of ${scope.deskName}` : 'worker worktrees (all projects)'
  if (scope.origin === 'none') {
    return `${workers} · desk sessions NOT scanned — cwd is a worker worktree and its main repo is not in the registry (pass --project <repo>)`
  }
  const via = scope.origin === 'worktree-main-repo' ? ', resolved from this worktree' : ''
  const got = deskRows > 0 ? `${deskRows} session(s)` : 'none in this period'
  return `${workers} + desk sessions of ${scope.deskName}${via} (${got})`
}

/** When `cwd` sits inside a project's central worktrees dir
 *  (`<openGroundHome>/projects/<uuid>/worktrees/<name>`), the REGISTERED main
 *  repo path for that uuid — i.e. the repo whose commander / supply desks the
 *  reader means. null when the cwd is not such a worktree, when the registry is
 *  unreadable, or when the uuid is absent from it; every caller treats null as
 *  "no desk in scope" and says so out loud. Read-only. */
export const mainRepoForWorktreeCwd = async (
  cwd: string,
  opts: { home?: string } = {},
): Promise<string | null> => {
  // openGroundHome() — NOT a private copy of its resolution. This line used to
  // re-implement the OPENGROUND_HOME → homedir() fallback inline (the §5 "3b"
  // check in docs/commander/07-test-isolation-contract.md has the exact shape;
  // spelling it out here trips the repo PII guard's encoded-path regex). This
  // was the last place in the codebase that resolved the app home WITHOUT the
  // fail-closed fence — routing around the choke point. Two independent reviews
  // found it on 2026-07-19, and it was measured rather than reasoned about:
  // inside a vitest process with the fence armed, unsetting OPENGROUND_HOME and
  // calling mainRepoForWorktreeCwd() READ the real ~/.openground/settings.json
  // and returned a genuinely registered project path. Nothing here writes, so
  // the damage was read-only — but "there is exactly one home resolver" is the
  // property the whole contract rests on, and a second copy voids it. A guard is
  // only a guard if nothing routes around it.
  const home = opts.home ?? openGroundHome()
  const canonical = await realpath(cwd).catch(() => cwd)
  const projectsRoot = await realpath(join(home, 'projects')).catch(() => join(home, 'projects'))
  if (!canonical.startsWith(projectsRoot + sep)) return null
  // <uuid>/worktrees/<name>… — the layout projectDataPath.ts owns.
  const rest = canonical.slice(projectsRoot.length + 1).split(sep)
  if (rest.length < 3 || rest[1] !== 'worktrees') return null
  const uuid = rest[0]
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))
  } catch {
    return null
  }
  const projects = (parsed as { projects?: unknown })?.projects
  if (!Array.isArray(projects)) return null
  for (const e of projects) {
    const entry = e as { id?: unknown; path?: unknown }
    if (entry?.id === uuid && typeof entry.path === 'string') return entry.path
  }
  return null
}

/** A bare `YYYY-MM-DD` → the epoch ms of that LOCAL day's start or end; null for
 *  any other shape (the caller falls through to Date.parse) and for a rolled-over
 *  date like 2026-02-31, which must be refused rather than silently reported as
 *  March 3rd. `Date.parse('2026-07-18')` is UTC MIDNIGHT, so `--until 2026-07-18`
 *  used to exclude every session of the 18th (one finishing 09:00Z is already
 *  past it) — an off-by-a-day that quietly truncated the newest rows. */
export const localDayEdgeMs = (s: string, edge: 'start' | 'end'): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt =
    edge === 'end' ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d, 0, 0, 0, 0)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt.getTime()
}
