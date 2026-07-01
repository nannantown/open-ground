// swarmSelfSupply — the commander engine's SELF-SUPPLY (自己供給) stage: the
// engine discovers improvement points on its OWN and proposes them as observable
// Board cards, so the autonomy loop can fuel itself without a human topping up
// the todo column (the last piece of the self-improvement loop, card b3fbbfba).
//
// WHY IT IS SAFE (暴走防止が最優先 — the whole point of this module's shape)
//   The risk of an engine that writes its own work queue is a runaway: a flood of
//   low-value cards, or cards that dispatch themselves into an infinite churn.
//   FOUR independent guards bound it, every one fail-safe:
//     1. OFF BY DEFAULT — `engine.selfSupply.enabled` starts false and is only
//        ever flipped by the owner-gated route (setSelfSupply). Ignition waits for
//        the rest of the safety net (regression gate + rollback + notifications)
//        to land; until armed, this stage does NOTHING. A server restart re-arms
//        OFF (the flag is in-memory, like autoMerge) — fail-safe to silent.
//     2. PER-CARD OWNER APPROVAL — a proposed card carries `selfSupplyKey` and
//        `selfSupplyApproved:false`. selectDispatch SKIPS such a card until the
//        owner approves it (approveSelfSupplyCard → selfSupplyApproved:true). So
//        even when armed, a self-supplied card is an inert PROPOSAL the owner must
//        green-light before any worker spawns — it never auto-dispatches.
//     3. CAPS — at most `maxPerPass` cards land per scan AND at most `maxPerDay`
//        per UTC day. Excess findings are HELD (and logged), never carded.
//     4. THROTTLE — a scan runs at most once per `intervalMs` (default hourly), so
//        the 3s engine tick does not re-scan (and re-spawn tsc/lint/test) every
//        pass.
//   On top of those: DEDUP (a finding already queued as an open card is skipped),
//   and the pass NEVER throws into the engine tick (every scanner is guarded; a
//   board-read/write failure logs and yields, re-proposing next scan).
//
// DISCOVERY SOURCES (発見ソース)
//   - anomalies — orphan-doing / worktree-missing / worker-stale / move-stuck /
//                 rework-exhausted, read straight off engine.anomalies (already
//                 computed each pass; zero extra cost, highest signal → carded first).
//   - tsc       — `tsc --noEmit` type errors.
//   - lint      — `eslint --format json` errors (severity 2 only).
//   - test      — `vitest run --reporter=json` failed assertions.
//   - todo      — `git grep` TODO/FIXME comments in tracked files (carded last).
//   Each source is a PURE parser (parseTscFindings / parseEslintFindings / …) fed
//   raw tool output, so the carding pipeline is unit-tested with synthetic findings
//   and the parsers are unit-tested with sample output — NO subprocess in tests.
//   The default scanners (which actually spawn the tools) only ever run inside an
//   ARMED pass, so `npm test` (self-supply OFF everywhere) never spawns them.
//
// BOARD ACCESS
//   Card reads + the append write go through readProjectData / writeProjectData —
//   the SAME CAS-guarded store the Board HTTP route wraps (the route is a thin
//   adapter over these). The engine is already server-side, so it calls the data
//   layer directly (no loopback hop) and stays unit-testable against an isolated
//   HOME without a running server. The append is ONE compare-and-swap write per
//   scan (read → decide caps/dedup in memory → write all new cards atomically); a
//   CAS conflict holds every card for the next scan (nothing half-lands).

import { randomUUID } from 'crypto'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { readProjectData, writeProjectData } from './projectData'
import type { OrchestratorAnomaly, ProjectData, ProjectTask } from '../types'

const execFile = promisify(execFileCb)

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Self-supply caps + cadence. Defaults are deliberately conservative (runaway
 *  defense): a handful of proposals a day, scanned at most hourly. Overridable
 *  per call so tests can drive the caps with small numbers + a zero interval. */
export interface SelfSupplyConfig {
  /** Max cards proposed in ONE scan (a single pass). */
  maxPerPass: number
  /** Max cards proposed per UTC day across all scans (the headline runaway cap). */
  maxPerDay: number
  /** Minimum wall-clock (ms) between scans — the engine tick is 3s, but a scan
   *  (which may spawn tsc/lint/test) must not run every tick. */
  intervalMs: number
}

export const DEFAULT_SELF_SUPPLY_CONFIG: SelfSupplyConfig = {
  maxPerPass: 3,
  maxPerDay: 5,
  intervalMs: 60 * 60 * 1000, // hourly
}

/** Per-engine self-supply state. In-memory only (lives on the ProjectEngine,
 *  which is held on globalThis) — a server restart resets it, which also means
 *  `enabled` falls back to OFF (fail-safe). */
export interface SelfSupplyRuntime {
  /** Armed? Default OFF — only the owner-gated setSelfSupply flips it. */
  enabled: boolean
  /** Wall-clock (ms) of the last scan — the intervalMs throttle gate. */
  lastScanAt: number
  /** UTC day ('YYYY-MM-DD') the dayCount below is counting — rolled over at the
   *  first scan of a new day. */
  dayKey: string
  /** Cards proposed so far in `dayKey` — the maxPerDay gate. */
  dayCount: number
}

export const initSelfSupplyRuntime = (): SelfSupplyRuntime => ({
  enabled: false,
  lastScanAt: 0,
  dayKey: '',
  dayCount: 0,
})

// ── Findings ─────────────────────────────────────────────────────────────────

/** Which discovery source surfaced a finding (display + log only). */
export type SelfSupplySource = 'anomaly' | 'tsc' | 'lint' | 'test' | 'todo'

/** One improvement point the engine discovered. `key` is its STABLE dedup
 *  identity (source-prefixed so cross-source collision is impossible, and chosen
 *  to survive line-number drift so the same issue is not re-proposed every scan);
 *  `title` + `body` become the proposed card (body always states an OBSERVABLE
 *  completion condition). */
export interface SelfSupplyFinding {
  source: SelfSupplySource
  key: string
  title: string
  body: string
}

/** Title prefix marking a card as engine-proposed + awaiting approval (human
 *  triage hint; provenance is also carried programmatically by selfSupplyKey). */
const TITLE_PREFIX = '自動提案: '

/** Folded comparison form (NFKC, whitespace-collapsed, lowercased) — for stable
 *  dedup keys that ignore trivial spacing/width drift. */
const fold = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/** Map the engine's already-computed anomalies → findings. Pure. The card for
 *  each anomaly states the observable "the anomaly is gone" completion condition. */
export const anomalyFindings = (anomalies: readonly OrchestratorAnomaly[]): SelfSupplyFinding[] =>
  anomalies.map((a): SelfSupplyFinding => {
    const key = `anomaly:${a.kind}:${a.ref}`
    const who = a.taskTitle ? `"${a.taskTitle}"` : a.ref
    const branch = a.branch ? ` (branch \`${a.branch}\`)` : ''
    switch (a.kind) {
      case 'orphan-doing':
        return {
          source: 'anomaly',
          key,
          title: `${TITLE_PREFIX}orphan-doing を解消 — ${who}`,
          body: `doing 列に残ったまま worker/worktree が消えたカード${branch}。完了条件: 当該カードが再 dispatch されるか done/blocked へ正しく移り、engine の anomalies から orphan-doing(ref=${a.ref}) が消える。`,
        }
      case 'worktree-missing':
        return {
          source: 'anomaly',
          key,
          title: `${TITLE_PREFIX}worktree 消失を解消 — ${who}`,
          body: `engine がまだ数える worker の worktree${branch} が消えている。完了条件: worker を停止して再 dispatch するか worktree を復元し、worktree-missing anomaly が消える。`,
        }
      case 'worker-stale':
        return {
          source: 'anomaly',
          key,
          title: `${TITLE_PREFIX}stale worker を回収 — ${who}`,
          body: `worker${branch} が${a.staleMinutes != null ? ` ${a.staleMinutes} 分` : '長時間'} heartbeat を更新していない。完了条件: worker を nudge/再起動するか停止して card を再 home し、worker-stale anomaly が消える。`,
        }
      case 'move-stuck':
        return {
          source: 'anomaly',
          key,
          title: `${TITLE_PREFIX}停滞した列移動を解消 — ${who}`,
          body: `Board の列移動(intent=${a.intent ?? '?'})が${a.attempts != null ? ` ${a.attempts} 回` : ''}連続で失敗し、作業と card の列が食い違っている。完了条件: 当該カードを正しい列へ移し、move-stuck anomaly が消える。`,
        }
      case 'rework-exhausted':
        return {
          source: 'anomaly',
          key,
          title: `${TITLE_PREFIX}差し戻し上限超過を対処 — ${who}`,
          body: `review→doing の差し戻しが上限を超えて blocked 入りした${branch}。完了条件: 人手で原因を解消して card を done にするか設計を見直し、rework-exhausted anomaly が消える。`,
        }
      // A future anomaly kind (this module is intentionally forward-compatible —
      // a concurrent change may add a kind) still gets a generic, observable card
      // rather than breaking the build or being silently dropped.
      default:
        return {
          source: 'anomaly',
          key,
          title: `${TITLE_PREFIX}engine anomaly を解消 — ${a.kind}: ${who}`,
          body: `engine が anomaly "${a.kind}"(ref=${a.ref})${branch} を検出。完了条件: 原因を解消し、当該 anomaly が engine の anomalies から消える。`,
        }
    }
  })

/** Parse `tsc --noEmit` stderr/stdout → findings, one per (file, error-code).
 *  Keyed by file+code (NOT line) so the same class of error is one stable card
 *  that does not churn as the file's line numbers shift. Pure. */
export const parseTscFindings = (output: string): SelfSupplyFinding[] => {
  const out: SelfSupplyFinding[] = []
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line)
    if (!m) continue
    const [, file, , , code, message] = m
    const key = `tsc:${file}:${code}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      source: 'tsc',
      key,
      title: `${TITLE_PREFIX}型エラーを解消 — ${file} ${code}`,
      body: `\`${file}\` の型エラー \`${code}: ${message}\`。完了条件: \`npx tsc --noEmit\` が exit 0。`,
    })
  }
  return out
}

/** Strip a leading absolute `root/` so a card shows a repo-relative path. Pure. */
const relativize = (filePath: string, root: string): string => {
  if (!root) return filePath
  const prefix = root.endsWith('/') ? root : `${root}/`
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

/** Parse `eslint --format json` → findings, ERRORS only (severity 2 — warnings
 *  are not worth a card). Keyed by file+rule. Pure (defensive over unknown JSON). */
export const parseEslintFindings = (jsonText: string, root = ''): SelfSupplyFinding[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: SelfSupplyFinding[] = []
  const seen = new Set<string>()
  for (const fileRes of parsed) {
    if (!fileRes || typeof fileRes !== 'object') continue
    const fp = (fileRes as { filePath?: unknown }).filePath
    const messages = (fileRes as { messages?: unknown }).messages
    if (typeof fp !== 'string' || !Array.isArray(messages)) continue
    const rel = relativize(fp, root)
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      if ((m as { severity?: unknown }).severity !== 2) continue // errors only
      const ruleId = (m as { ruleId?: unknown }).ruleId
      const message = (m as { message?: unknown }).message
      const rule = typeof ruleId === 'string' && ruleId ? ruleId : 'lint'
      const key = `lint:${rel}:${rule}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        source: 'lint',
        key,
        title: `${TITLE_PREFIX}lint エラーを解消 — ${rule} @ ${rel}`,
        body: `\`${rel}\` の lint エラー \`${rule}\`${typeof message === 'string' ? `: ${message}` : ''}。完了条件: \`npm run lint\` が緑。`,
      })
    }
  }
  return out
}

/** Parse `vitest run --reporter=json` (Jest-compatible shape) → findings, one per
 *  failed assertion. Keyed by the test's full name. Pure (defensive). */
export const parseVitestFindings = (jsonText: string): SelfSupplyFinding[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  const testResults = (parsed as { testResults?: unknown } | null)?.testResults
  if (!Array.isArray(testResults)) return []
  const out: SelfSupplyFinding[] = []
  const seen = new Set<string>()
  for (const fileRes of testResults) {
    if (!fileRes || typeof fileRes !== 'object') continue
    const assertions = (fileRes as { assertionResults?: unknown }).assertionResults
    const nameRaw = (fileRes as { name?: unknown }).name
    const fileName = typeof nameRaw === 'string' ? nameRaw : ''
    if (!Array.isArray(assertions)) continue
    for (const a of assertions) {
      if (!a || typeof a !== 'object') continue
      if ((a as { status?: unknown }).status !== 'failed') continue
      const full = (a as { fullName?: unknown }).fullName
      const title = (a as { title?: unknown }).title
      const name = typeof full === 'string' && full ? full : typeof title === 'string' ? title : ''
      if (!name) continue
      const key = `test:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        source: 'test',
        key,
        title: `${TITLE_PREFIX}失敗テストを修正 — ${name}`,
        body: `テスト "${name}"${fileName ? ` (${fileName})` : ''} が失敗。完了条件: 当該テストが緑になり \`npm test\` が緑。`,
      })
    }
  }
  return out
}

/** Parse `git grep -n` TODO/FIXME output (`path:line:content`) → findings, one per
 *  (file, comment-text). Keyed by file + folded text (NOT line) so moving a TODO
 *  does not re-propose it. Pure. */
export const parseTodoFindings = (grepOutput: string): SelfSupplyFinding[] => {
  const out: SelfSupplyFinding[] = []
  const seen = new Set<string>()
  for (const line of grepOutput.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^(.+?):(\d+):(.*)$/.exec(line)
    if (!m) continue
    const [, file, , rest] = m
    const text = rest.trim().slice(0, 200)
    const key = `todo:${file}:${fold(text)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      source: 'todo',
      key,
      title: `${TITLE_PREFIX}TODO/FIXME を解消 — ${file}`,
      body: `\`${file}\` の TODO/FIXME: "${text}"。完了条件: 当該 TODO の作業が実装され、コメントが除去される。`,
    })
  }
  return out
}

/** Dedup findings by key, keeping the FIRST occurrence (so the higher-signal
 *  source — anomalies are gathered first — wins any collision). Pure. */
const dedupeFindings = (findings: readonly SelfSupplyFinding[]): SelfSupplyFinding[] => {
  const seen = new Set<string>()
  const out: SelfSupplyFinding[] = []
  for (const f of findings) {
    if (seen.has(f.key)) continue
    seen.add(f.key)
    out.push(f)
  }
  return out
}

/** The selfSupplyKeys already represented by an OPEN (non-done) card — the dedup
 *  set. A `done` card is excluded: if the same issue is re-detected after a card
 *  for it landed, that is a regression worth re-proposing. Pure. */
export const openSelfSupplyKeys = (tasks: readonly ProjectTask[]): Set<string> => {
  const keys = new Set<string>()
  for (const t of tasks) {
    const col = t.boardColumn ?? (t.done ? 'done' : 'todo')
    if (col === 'done') continue
    if (typeof t.selfSupplyKey === 'string' && t.selfSupplyKey) keys.add(t.selfSupplyKey)
  }
  return keys
}

// ── Injectable dependencies ──────────────────────────────────────────────────

/** CAS-guarded board IO — the same store the Board HTTP route wraps. Injected so
 *  the pass is unit-tested against an in-memory board (and an isolated-HOME test
 *  drives the REAL read/write). */
export interface SelfSupplyBoard {
  read: (projectPath: string) => Promise<ProjectData>
  write: (
    projectPath: string,
    data: ProjectData,
    opts?: { expectUpdatedAt?: string },
  ) => Promise<ProjectData>
}

export const defaultBoard = (): SelfSupplyBoard => ({ read: readProjectData, write: writeProjectData })

/** Everything the pass needs from the outside world. Each scanner returns the
 *  findings for ONE source and MUST NOT throw (the pass also guards, but a
 *  scanner is the natural place to swallow a spawn/parse failure → []). */
export interface SelfSupplyDeps {
  now: () => number
  board: SelfSupplyBoard
  scanTypeErrors: (projectPath: string) => Promise<SelfSupplyFinding[]>
  scanLintErrors: (projectPath: string) => Promise<SelfSupplyFinding[]>
  scanTestFailures: (projectPath: string) => Promise<SelfSupplyFinding[]>
  scanTodoComments: (projectPath: string) => Promise<SelfSupplyFinding[]>
}

/** Run a tool and capture its stdout EVEN on a non-zero exit — tsc/eslint/vitest
 *  exit non-zero precisely WHEN they find problems, and that output is the
 *  payload we parse. A missing binary / timeout / kill yields '' → no findings
 *  (never throws). */
const runCapture = async (
  cwd: string,
  file: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> => {
  try {
    const { stdout } = await execFile(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    const stdout = (e as { stdout?: unknown }).stdout
    return typeof stdout === 'string' ? stdout : ''
  }
}

const binIn = (projectPath: string, name: string): string =>
  join(projectPath, 'node_modules', '.bin', name)

/** Build the REAL scanners (spawn the project's own tooling). Cached so the 3s
 *  engine tick does not re-allocate the closures. These only ever run inside an
 *  ARMED pass — `npm test` (self-supply OFF) never reaches them. */
let cachedDefaults: SelfSupplyDeps | null = null
export const defaultSelfSupplyDeps = (): SelfSupplyDeps =>
  (cachedDefaults ??= {
    now: () => Date.now(),
    board: defaultBoard(),
    scanTypeErrors: async (p) => parseTscFindings(await runCapture(p, binIn(p, 'tsc'), ['--noEmit'])),
    scanLintErrors: async (p) =>
      parseEslintFindings(
        await runCapture(p, binIn(p, 'eslint'), ['.', '--ext', '.ts,.tsx', '--format', 'json']),
        p,
      ),
    scanTestFailures: async (p) =>
      parseVitestFindings(await runCapture(p, binIn(p, 'vitest'), ['run', '--reporter=json'], 240_000)),
    scanTodoComments: async (p) =>
      parseTodoFindings(await runCapture(p, 'git', ['grep', '-n', '-I', '-E', '(TODO|FIXME)'])),
  })

// ── The pass ─────────────────────────────────────────────────────────────────

/** The minimal engine surface the pass reads + mutates — a structural subset of
 *  ProjectEngine (so the module needs no back-import of swarmOrchestrator, no
 *  cycle). */
export interface SelfSupplyEngine {
  path: string
  anomalies: readonly OrchestratorAnomaly[]
  selfSupply: SelfSupplyRuntime
}

/** Why a discovered finding was NOT carded this scan. */
export type SelfSupplySuppressReason = 'duplicate' | 'per-pass-cap' | 'daily-cap'

export interface SelfSupplyOutcome {
  /** False when the pass short-circuited (disarmed, or throttled) without scanning. */
  scanned: boolean
  /** Findings carded into todo this scan. */
  proposed: SelfSupplyFinding[]
  /** Findings discovered but held back, with why. */
  suppressed: { finding: SelfSupplyFinding; reason: SelfSupplySuppressReason }[]
}

/** A sink for the engine journal — wired to logLine by the orchestrator hook,
 *  collected by an array in tests. */
export type SelfSupplyLog = (level: 'info' | 'warn', message: string) => void

const NOOP_LOG: SelfSupplyLog = () => {}

const dayKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const safeScan = async (
  fn: (projectPath: string) => Promise<SelfSupplyFinding[]>,
  projectPath: string,
): Promise<SelfSupplyFinding[]> => {
  try {
    return await fn(projectPath)
  } catch {
    return []
  }
}

const buildCard = (finding: SelfSupplyFinding, nowMs: number): ProjectTask => ({
  id: randomUUID(),
  title: finding.title,
  notes: `${finding.body}\n\n(engine 自己供給 — owner が承認するまで dispatch されません。)`,
  done: false,
  createdAt: new Date(nowMs).toISOString(),
  boardColumn: 'todo',
  selfSupplyKey: finding.key,
  selfSupplyApproved: false,
})

/** ONE self-supply scan. No-op (scanned:false) when disarmed or throttled. When
 *  it scans: gathers findings from every source, dedups against open cards,
 *  applies the per-pass + per-day caps, appends the survivors to todo as
 *  approval-gated cards in ONE CAS write, and logs every fire + every
 *  suppression. NEVER throws — a board failure logs + yields (re-proposed next
 *  scan). */
export const runSelfSupplyPass = async (
  engine: SelfSupplyEngine,
  log: SelfSupplyLog = NOOP_LOG,
  deps: SelfSupplyDeps = defaultSelfSupplyDeps(),
  config: SelfSupplyConfig = DEFAULT_SELF_SUPPLY_CONFIG,
): Promise<SelfSupplyOutcome> => {
  const empty: SelfSupplyOutcome = { scanned: false, proposed: [], suppressed: [] }
  const ss = engine.selfSupply
  if (!ss.enabled) return empty // guard 1: OFF by default

  const now = deps.now()
  if (config.intervalMs > 0 && now - ss.lastScanAt < config.intervalMs) return empty // guard 4: throttle

  // Read the board first (cheap) — needed for dedup AND it is the write target. A
  // transient read failure is not an anomaly to surface AND must NOT burn the
  // throttle window (we did no scan), so advance lastScanAt only AFTER it succeeds:
  // the next tick retries the read instead of waiting a full intervalMs.
  let data: ProjectData
  try {
    data = await deps.board.read(engine.path)
  } catch (e) {
    log('warn', `self-supply: board read failed — ${e instanceof Error ? e.message : String(e)}`)
    return { scanned: false, proposed: [], suppressed: [] }
  }
  ss.lastScanAt = now

  // Roll the per-day window (guard 3: the headline runaway cap).
  const dk = dayKeyOf(now)
  if (ss.dayKey !== dk) {
    ss.dayKey = dk
    ss.dayCount = 0
  }
  const tasks = data.tasks ?? []
  const openKeys = openSelfSupplyKeys(tasks)

  // Gather: anomalies first (highest signal, zero cost), then the tool scanners.
  const findings = dedupeFindings([
    ...anomalyFindings(engine.anomalies),
    ...(await safeScan(deps.scanTypeErrors, engine.path)),
    ...(await safeScan(deps.scanLintErrors, engine.path)),
    ...(await safeScan(deps.scanTestFailures, engine.path)),
    ...(await safeScan(deps.scanTodoComments, engine.path)),
  ])

  const toCard: SelfSupplyFinding[] = []
  const suppressed: SelfSupplyOutcome['suppressed'] = []
  for (const f of findings) {
    if (openKeys.has(f.key)) {
      suppressed.push({ finding: f, reason: 'duplicate' })
      continue
    }
    if (ss.dayCount + toCard.length >= config.maxPerDay) {
      suppressed.push({ finding: f, reason: 'daily-cap' })
      continue
    }
    if (toCard.length >= config.maxPerPass) {
      suppressed.push({ finding: f, reason: 'per-pass-cap' })
      continue
    }
    toCard.push(f)
    openKeys.add(f.key) // within-scan dedup guard
  }

  const proposed: SelfSupplyFinding[] = []
  if (toCard.length > 0) {
    const cards = toCard.map((f) => buildCard(f, now))
    const next: ProjectData = { ...data, tasks: [...tasks, ...cards] }
    try {
      await deps.board.write(engine.path, next, { expectUpdatedAt: data.updatedAt })
      ss.dayCount += cards.length
      for (const f of toCard) {
        proposed.push(f)
        log('info', `self-supply: 提案 "${f.title}" (${f.source}) — owner 承認待ち`)
      }
    } catch (e) {
      // CAS conflict / write error: nothing landed — re-propose next scan.
      log(
        'warn',
        `self-supply: board 書込みを保留 (${cards.length} 件 held) — ${e instanceof Error ? e.message : String(e)}`,
      )
      return { scanned: true, proposed: [], suppressed }
    }
  }

  // Suppression journal (guard observability — condition 5). Summaries, so a
  // crowded codebase does not flood the log every scan.
  const dupCount = suppressed.filter((s) => s.reason === 'duplicate').length
  if (dupCount > 0) log('info', `self-supply: 既出 ${dupCount} 件をスキップ (重複検出)`)
  const cappedCount = suppressed.filter((s) => s.reason !== 'duplicate').length
  if (cappedCount > 0) {
    log(
      'warn',
      `self-supply: 上限到達 — ${cappedCount} 件を保留 (pass ${config.maxPerPass} / day ${ss.dayCount}/${config.maxPerDay})`,
    )
  }

  return { scanned: true, proposed, suppressed }
}

// ── Owner approval (the per-card dispatch gate, guard 2) ──────────────────────

/** Approve ONE self-supplied card for dispatch — the owner-gated route calls
 *  this. Sets selfSupplyApproved:true (persisted on the card) so selectDispatch
 *  stops skipping it. Idempotent: a non-self-supplied / already-approved / absent
 *  card is a no-op. Uses a CAS write with one retry against a concurrent edit. */
export const approveSelfSupplyCard = async (
  projectPath: string,
  cardId: string,
  board: SelfSupplyBoard = defaultBoard(),
): Promise<{ approved: boolean }> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await board.read(projectPath)
    const tasks = data.tasks ?? []
    const card = tasks.find((t) => t.id === cardId)
    // Only a self-supplied, not-yet-approved card is actionable.
    if (!card || !card.selfSupplyKey || card.selfSupplyApproved) return { approved: false }
    const next: ProjectData = {
      ...data,
      tasks: tasks.map((t) => (t.id === cardId ? { ...t, selfSupplyApproved: true } : t)),
    }
    try {
      await board.write(projectPath, next, { expectUpdatedAt: data.updatedAt })
      return { approved: true }
    } catch {
      // CAS lost to a concurrent edit — re-read and retry once.
    }
  }
  return { approved: false }
}
