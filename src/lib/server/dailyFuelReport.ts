import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { ProjectTask } from '../types'
import { atomicWriteJson } from './atomicWrite'
import { dailyFuelReportFile, ensureOpenGroundHome } from './paths'
import { getSettings } from './store'
import { mutateProjectData, readProjectData } from './projectData'
import { createSwarmInfoNotification } from './swarmNotifications'
import {
  auditSessionFile,
  collectSwarmSessionFiles,
  type SessionTokenAudit,
} from './swarmTokenAudit'

// ---------------------------------------------------------------------------
// dailyFuelReport — the swarm's DAILY self-analysis loop (card:
// swarm-token-blocked). Once a day, at a fixed local hour, it re-reads the
// session JSONLs the consumption meter (swarmTokenAudit.ts, card swarm-token)
// already knows how to analyze, and turns them into:
//   1. a plain-language daily report, persisted to the Ground お知らせ bell
//      (createSwarmInfoNotification, event 'daily-fuel-report'), and
//   2. ON A DEGRADED DAY ONLY: one improvement-proposal card auto-filed into
//      the Board's **blocked** column — the human-judgment lane. The engine
//      only dispatches from 'todo' (selectDispatch's isTodo predicate), so the
//      owner MOVING the card to todo IS the approval step; nothing runs until
//      then. Deliberately NO selfSupplyKey on the card: that gate guards
//      engine-proposed cards placed straight into todo, and adding it here
//      would make the owner's todo-move insufficient (the card would sit
//      unapproved in todo — breaking the "todoへの復活=承認" contract).
//
// Design rules (the goal's own):
//   - DETERMINISTIC: no LLM call anywhere — the analysis re-uses the pure
//     read-only audit (zero tokens). The loop runs on APP uptime (wired in
//     server/index.ts like the retention sweep), independent of whether the
//     swarm engine is on.
//   - One report per LOCAL day, surviving restarts: the persisted sentinel
//     (~/.openground/daily-fuel-report.json) carries lastReportDate; a boot
//     after REPORT_HOUR_LOCAL catches up exactly once. The same guard is ALSO
//     held in memory (globalThis) and armed BEFORE every side effect, so a
//     sentinel file that can never be written costs at most a missed report —
//     never one proposal card per tick.
//   - Windows never overlap, never leak, and never grow past a day: each
//     report covers [lastCutoffMs, now - QUIET_MS), clamped to MAX_WINDOW_MS.
//     A session still being written (active in the last QUIET_MS) falls PAST
//     the right edge and is counted the day it actually goes quiet — so a card
//     is reported exactly once, and never with half-done numbers.
//   - Dedup of proposals: while the previously-filed proposal card is still
//     unresolved (exists and not in 'done'), no new card is filed — the
//     report just mentions it is still waiting.
// ---------------------------------------------------------------------------

/** Local hour (0-23) the daily report fires at. A constant by design — the
 *  goal explicitly waives a settings UI for this. */
export const REPORT_HOUR_LOCAL = 9

/** A session whose last JSONL line is younger than this is considered STILL
 *  RUNNING and is left for the day it goes quiet (prevents double-counting a
 *  card across two reports and prevents reporting half-done numbers). */
export const QUIET_MS = 30 * 60 * 1000

/** First-ever run (no sentinel): analyze this much history. */
const INITIAL_WINDOW_MS = 24 * 60 * 60 * 1000

/** Hard cap on one report's window. Normally the window is just the gap since
 *  the last report (~24h), but if the app was OFF for days the gap would
 *  otherwise stretch across the whole outage. That is wrong twice over: the
 *  report calls its window 「きのう」, and — worse — the degradation check
 *  would get biased, because 文脈の最大 is a MAX over the window, so a longer
 *  window trips the 300k threshold more easily and files a proposal card that
 *  a single day's data would not have justified. Clamping keeps the DAILY
 *  report daily: sessions older than the cap are not reported at all (they
 *  belong to days the app was not running to report on). 26h, not 24h, so the
 *  normal cadence plus a DST hour plus tick jitter never clips a real day. */
export const MAX_WINDOW_MS = 26 * 60 * 60 * 1000

/** Degradation thresholds (2026-07-18 baseline — see the goal). Checked only
 *  on a day with at least DEGRADE_MIN_CARDS finished cards, so a single
 *  outlier card can never trip the alarm. */
export const DEGRADE_MIN_CARDS = 2
export const DEGRADE_BUNDLE_LT = 1.3
export const DEGRADE_MEDIAN_TURNS_GT = 150
export const DEGRADE_MAX_CONTEXT_GT = 300_000

/** Loop tick. Each tick is one sentinel read + a date/hour compare — the
 *  actual analysis runs at most once a day. */
const FUEL_REPORT_TICK_MS = 60_000

/** The aggregate the report (and the 前回比) is built from. */
export interface DailyFuelSummary {
  /** Sessions (= cards) that went quiet inside the window. */
  cards: number
  /** Median of per-card 手数 (unique assistant responses). */
  medianTurns: number
  /** Σ toolUses / Σ toolTurns across the window — null when no tools ran. */
  bundleRate: number | null
  /** Max per-card max-context over the window. */
  maxContext: number
  /** Σ main-loop output tokens over the window. */
  outputTokens: number
  /** Σ sidechain (subagent) output tokens — kept apart, same as the meter. */
  sidechainOutputTokens: number
}

/** The improvement-proposal card the LAST degraded day filed — the dedup
 *  guard. Cleared when the card resolves (moves to done / disappears). */
export interface DailyFuelProposalRef {
  projectPath: string
  taskId: string
  createdAt: number
}

/** The persisted sentinel (~/.openground/daily-fuel-report.json). */
export interface DailyFuelSentinel {
  /** Local 'YYYY-MM-DD' of the last report — the once-a-day guard. */
  lastReportDate: string
  /** Right edge of the last analysis window → next window's left edge. */
  lastCutoffMs: number
  /** Last report's numbers (for the 前回比 line); null when that day had 0. */
  lastSummary: DailyFuelSummary | null
  /** Open improvement proposal, if any. */
  proposal: DailyFuelProposalRef | null
}

/** Local calendar date key ('YYYY-MM-DD') — LOCAL on purpose: "09:00 every
 *  day" is a human schedule, not a UTC one. */
export const localDateKey = (nowMs: number): string => {
  const d = new Date(nowMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Is a report due at `nowMs`? True once per local day, at or after the fixed
 *  hour — which also gives the catch-up semantics: booting at 14:00 with no
 *  report today yet reports immediately (exactly once). */
export const shouldReportNow = (
  sentinel: DailyFuelSentinel | null,
  nowMs: number,
): boolean => {
  if (new Date(nowMs).getHours() < REPORT_HOUR_LOCAL) return false
  return localDateKey(nowMs) !== sentinel?.lastReportDate
}

/** Aggregate per-session audits into the day's summary. Pure. Bundle rate is
 *  the WEIGHTED aggregate (Σ toolUses / Σ toolTurns), not a mean of ratios —
 *  a 3-turn card must not outvote a 300-turn card. */
export const summarizeAudits = (audits: SessionTokenAudit[]): DailyFuelSummary => {
  const turns = audits.map((a) => a.turns).sort((a, b) => a - b)
  const mid = Math.floor(turns.length / 2)
  const medianTurns =
    turns.length === 0 ? 0 : turns.length % 2 === 1 ? turns[mid] : (turns[mid - 1] + turns[mid]) / 2
  let toolUses = 0
  let toolTurns = 0
  let maxContext = 0
  let outputTokens = 0
  let sidechainOutputTokens = 0
  for (const a of audits) {
    toolUses += a.toolUses
    toolTurns += a.toolTurns
    if (a.maxContext > maxContext) maxContext = a.maxContext
    outputTokens += a.outputTokens
    sidechainOutputTokens += a.sidechainOutputTokens
  }
  return {
    cards: audits.length,
    medianTurns,
    bundleRate: toolTurns > 0 ? toolUses / toolTurns : null,
    maxContext,
    outputTokens,
    sidechainOutputTokens,
  }
}

/** Which thresholds a summary breaks — [] means healthy. Plain-language, each
 *  entry readable on its own (they go into the notification + the card). A
 *  null bundle rate (no tools at all) never trips the bundle clause. */
export const degradationReasons = (s: DailyFuelSummary): string[] => {
  const reasons: string[] = []
  if (s.bundleRate !== null && s.bundleRate < DEGRADE_BUNDLE_LT) {
    reasons.push(
      `道具の束ね率が ${s.bundleRate.toFixed(2)}(基準 ${DEGRADE_BUNDLE_LT} 未満は悪化)— 1回の応答でまとめて道具を使えていません`,
    )
  }
  if (s.medianTurns > DEGRADE_MEDIAN_TURNS_GT) {
    reasons.push(
      `1枚あたりの手数(中央値)が ${fmtNum(s.medianTurns)} 手(基準 ${DEGRADE_MEDIAN_TURNS_GT} 手超は悪化)— 仕事の刻みが細かすぎます`,
    )
  }
  if (s.maxContext > DEGRADE_MAX_CONTEXT_GT) {
    reasons.push(
      `文脈の最大が ${plainCount(s.maxContext)}(基準 ${plainCount(DEGRADE_MAX_CONTEXT_GT)} 超は悪化)— ひとつの作業が一度に抱える量が多すぎます`,
    )
  }
  return reasons
}

/** 前回比 — one plain-language line on the DIRECTION (better / worse / flat),
 *  keyed on median turns (the goal's primary efficiency number). '' when there
 *  is nothing meaningful to compare against. */
export const trendLine = (
  prev: DailyFuelSummary | null,
  cur: DailyFuelSummary,
): string => {
  if (!prev || prev.cards === 0 || cur.cards === 0) return ''
  if (prev.medianTurns <= 0) return ''
  const ratio = cur.medianTurns / prev.medianTurns
  if (ratio <= 0.9) return '前回より少ない手数で終わっており、燃費は良くなっています。'
  if (ratio >= 1.1) return '前回より手数が増えており、燃費は悪くなっています。'
  return '燃費は前回とほぼ同じです。'
}

/** Token counts in OWNER-READABLE Japanese: 336_000 → '33.6万', 1_200_000 →
 *  '120万'. The meter's own 'k' notation (→ '1200k') is engineer shorthand — the
 *  bell and the proposal card are read by a non-programmer, and 万 is how large
 *  numbers are actually read in Japanese. One decimal below 100万 keeps小さめの
 *  差 visible; above it the decimal is noise. */
export const plainCount = (n: number): string => {
  if (n < 10_000) return String(n)
  const man = n / 10_000
  return `${man >= 100 ? Math.round(man) : Math.round(man * 10) / 10}万`
}
/** 101.5 → '101.5', 101 → '101' (median of an even count can be .5). */
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** The bell notification's detail — plain language for the owner (①what
 *  happened ②the numbers ③the direction), one short paragraph. */
export const buildReportDetail = (
  summary: DailyFuelSummary,
  trend: string,
  proposalNote: string,
  windowHours: number,
): string => {
  // The window is NOT always "yesterday": after a multi-day outage the catch-up
  // run reports the clamped tail (MAX_WINDOW_MS), and the first-ever run covers
  // INITIAL_WINDOW_MS. Naming the real span keeps the sentence true in all three
  // cases instead of claiming 「きのう」 for a window that is not yesterday.
  const span = `直近${windowHours}時間`
  if (summary.cards === 0) {
    // Policy (goal §2 left it to the design): the zero day still NOTIFIES —
    // a report that reliably arrives every day is how the owner can tell
    // "no work finished" apart from "the loop silently died". (It costs no bell
    // slot from the fatal lane — see capNotificationsByKind in
    // swarmNotifications.ts, which caps info and fatal independently.)
    return `${span}のスウォーム燃費: 終わったカードはありませんでした。`
  }
  const bundle = summary.bundleRate === null ? '—' : summary.bundleRate.toFixed(2)
  // Spelled out, not parenthesised jargon: 「…は別枠」 told the owner a number was
  // excluded without saying from what or why.
  const side =
    summary.sidechainOutputTokens > 0
      ? `このほかに、下請けの調査役が出した文章が${plainCount(summary.sidechainOutputTokens)}あります(上の合計には含めていません)。`
      : ''
  const parts = [
    `${span}のスウォーム燃費: カード${summary.cards}枚が終わりました。`,
    `1枚あたりの手数(中央値)${fmtNum(summary.medianTurns)}手・道具の束ね率${bundle}・文脈の最大${plainCount(summary.maxContext)}・文章の出力合計${plainCount(summary.outputTokens)}。`,
  ]
  if (side) parts.push(side)
  if (trend) parts.push(trend)
  if (proposalNote) parts.push(proposalNote)
  return parts.join(' ')
}

// ── Sentinel: the disk file + the in-process guard ──────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __openground_fuel_report_timer: ReturnType<typeof setInterval> | null | undefined
  // eslint-disable-next-line no-var
  var __openground_fuel_tick_inflight: boolean | undefined
  // eslint-disable-next-line no-var
  var __openground_fuel_memo: DailyFuelSentinel | null | undefined
}

/** Read the sentinel FILE; null on missing/corrupt. Tolerant ON PURPOSE
 *  (unlike a fail-closed guard): the worst a lost sentinel can cause is ONE
 *  duplicate daily report and a ~24h analysis window — strictly better than a
 *  report loop that stays silent forever because its state file got mangled.
 *
 *  That tolerance is only safe because WRITE failure is handled separately.
 *  A file that cannot be READ self-heals — the next successful write replaces
 *  it. A file that cannot be WRITTEN (EISDIR / EACCES / ENOSPC / immutable)
 *  never self-heals, so a once-a-day guard living ONLY on disk would re-arm on
 *  every tick — and on a degraded day that means a fresh proposal card every
 *  60 seconds. {@link globalThis.__openground_fuel_memo} closes that: an
 *  in-process shadow of the sentinel, armed BEFORE any side effect, so the
 *  guard holds even when the file never lands. It lives on globalThis (not in
 *  a module variable) so a `tsx watch` reload cannot drop it. */
export const readFuelSentinel = async (): Promise<DailyFuelSentinel | null> => {
  try {
    const raw = JSON.parse(await readFile(dailyFuelReportFile(), 'utf8')) as
      Partial<DailyFuelSentinel> | null
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.lastReportDate !== 'string' || typeof raw.lastCutoffMs !== 'number') return null
    return {
      lastReportDate: raw.lastReportDate,
      lastCutoffMs: raw.lastCutoffMs,
      lastSummary:
        raw.lastSummary && typeof raw.lastSummary === 'object' ? (raw.lastSummary as DailyFuelSummary) : null,
      proposal:
        raw.proposal &&
        typeof raw.proposal === 'object' &&
        typeof (raw.proposal as DailyFuelProposalRef).projectPath === 'string' &&
        typeof (raw.proposal as DailyFuelProposalRef).taskId === 'string'
          ? (raw.proposal as DailyFuelProposalRef)
          : null,
    }
  } catch {
    return null
  }
}

/** Arm/refresh the in-process guard. Synchronous and infallible BY DESIGN —
 *  it is the half of the memory a broken disk cannot take away. */
const setFuelMemo = (s: DailyFuelSentinel): void => {
  globalThis.__openground_fuel_memo = s
}

/** The state the loop decides on: the NEWER of (file, in-process shadow),
 *  compared on `lastCutoffMs` (monotonic — it is always `now - QUIET_MS`).
 *  Ties go to memory, which is the same run's own, freshest value. */
export const effectiveFuelSentinel = async (): Promise<DailyFuelSentinel | null> => {
  const disk = await readFuelSentinel()
  const memo = globalThis.__openground_fuel_memo ?? null
  if (!memo) return disk
  if (!disk) return memo
  return memo.lastCutoffMs >= disk.lastCutoffMs ? memo : disk
}

/** Persist the sentinel. Memory first, then the file BEST-EFFORT: a write that
 *  can never succeed must not re-arm the report (see readFuelSentinel). The
 *  cost of swallowing it is bounded — cross-restart memory degrades to "one
 *  duplicate report after a restart", exactly the corrupt-read worst case. */
const commitFuelSentinel = async (s: DailyFuelSentinel): Promise<void> => {
  setFuelMemo(s)
  try {
    await ensureOpenGroundHome()
    await atomicWriteJson(dailyFuelReportFile(), s)
  } catch (e) {
    console.error(
      '[openground:fuel-report] sentinel write failed — today stays marked in memory, but a restart will report twice',
      e,
    )
  }
}

// ── Proposal card (degraded day only) ───────────────────────────────────────

/** Extract the project uuid from a ~/.claude/projects session dir name
 *  (`…-openground-projects-<uuid>-worktrees-<branch>`). Null when the dir is
 *  not a swarm worker dir (defensive — callers pre-filter). */
export const uuidFromSessionDir = (dir: string): string | null => {
  const afterRoot = dir.split('-openground-projects-')[1]
  if (!afterRoot) return null
  const uuid = afterRoot.split('-worktrees-')[0]
  return uuid || null
}

/** The Board column a card actually sits in (absent ⇒ the legacy done/todo
 *  fallback the whole codebase uses). */
const columnOf = (t: ProjectTask): string => t.boardColumn ?? (t.done ? 'done' : 'todo')

/** The marker every auto-filed fuel proposal carries
 *  ({@link ProjectTask.fuelProposalKey}) — written on the card, read back off
 *  the Board. Constant rather than per-reason: the dedup unit is "an
 *  undecided proposal exists", so ANY open one suppresses the next; two cards
 *  would ask the owner to decide the same thing twice. */
export const FUEL_PROPOSAL_KEY = 'daily-fuel'

/** The OPEN (non-done) fuel proposals on a board — BOARD TRUTH, the real dedup
 *  set. Deliberately mirrors swarmSelfSupply's `openSelfSupplyKeys` (same column
 *  rule, same "done ⇒ resolved, re-propose if it recurs" semantics) so the two
 *  auto-filing lanes dedup the same way.
 *
 *  WHY this exists and the sentinel is not enough: the sentinel
 *  (daily-fuel-report.json + the in-process memo) is the once-a-day clock, and
 *  it is deliberately TOLERANT — unreadable ⇒ null. A null there used to mean
 *  "no proposal is open", so a sentinel that was lost (home migration, restore
 *  from backup) or could never be written (EACCES / immutable) let every app
 *  start file another identical card, and the 26h clamp re-counted the same
 *  sessions so even the CONTENT repeated. The Board cannot drift that way: the
 *  cards are the thing being deduped. Matches on the key's PRESENCE, not its
 *  exact value, so a future per-reason key still suppresses older cards. Pure. */
export const openFuelProposals = (tasks: readonly ProjectTask[]): ProjectTask[] =>
  tasks.filter((t) => !!t.fuelProposalKey && columnOf(t) !== 'done')

/** Is the previously-filed proposal card still OPEN (exists, not in done)?
 *  The sentinel-keyed check — kept ALONGSIDE the Board scan because it is the
 *  only one that reaches a proposal filed into a DIFFERENT project than today's
 *  target (the Board scan only ever sees the target's board).
 *  An unreadable/unregistered project counts as RESOLVED — refusing to file
 *  forever because the old target got unregistered would silently kill the
 *  whole proposal lane. */
const findOpenProposal = async (p: DailyFuelProposalRef): Promise<ProjectTask | null> => {
  try {
    const data = await readProjectData(p.projectPath)
    const card = data.tasks.find((t) => t.id === p.taskId)
    if (!card) return null
    return columnOf(card) !== 'done' ? card : null
  } catch {
    return null
  }
}

/** The "not filing a second one" line, phrased for WHERE the existing proposal
 *  actually sits. 'Open' means every column except done, so the old fixed
 *  「まだ保留列にあるので」 kept telling the owner their card was still awaiting
 *  their decision AFTER they had already approved it and work was underway. */
const openProposalNote = (card: ProjectTask): string => {
  const where =
    {
      blocked: '前回の改善提案カードがまだ保留列にあり、あなたの判断待ちです',
      todo: '前回の改善提案カードは承認済みで、着手を待っています',
      doing: '前回の改善提案カードは現在作業中です',
      review: '前回の改善提案カードは作業が終わり、確認待ちです',
    }[columnOf(card)] ?? '前回の改善提案カードがまだ残っています'
  return `⚠ 燃費が基準より悪化しています。${where}ので、新しい起票はしていません。`
}

/** Pick the Board the proposal card goes to: the REGISTERED project with the
 *  most sessions in this window (ties broken by uuid order — deterministic).
 *  Null when no session maps to a registered project. */
const resolveProposalTarget = async (
  sessionDirs: string[],
): Promise<{ id: string; path: string } | null> => {
  const settings = await getSettings().catch(() => null)
  if (!settings) return null
  const byId = new Map((settings.projects ?? []).map((p) => [p.id, p.path]))
  const counts = new Map<string, number>()
  for (const dir of sessionDirs) {
    const uuid = uuidFromSessionDir(dir)
    if (!uuid || !byId.has(uuid)) continue
    counts.set(uuid, (counts.get(uuid) ?? 0) + 1)
  }
  const best = Array.from(counts.entries()).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )[0]
  if (!best) return null
  return { id: best[0], path: byId.get(best[0])! }
}

/** The proposal card. Filed into **blocked** — the human-judgment lane the
 *  engine never dispatches from — with the analysis summary baked into notes
 *  so the card is self-explaining even weeks later. */
const buildProposalTask = (
  summary: DailyFuelSummary,
  reasons: string[],
  nowMs: number,
  windowHours: number,
): ProjectTask => {
  const date = localDateKey(nowMs)
  const bundle = summary.bundleRate === null ? '—' : summary.bundleRate.toFixed(2)
  // Two ADDRESSEES, kept in separate blocks and labelled as such. The owner
  // reads this in the Board drawer to decide; but the moment they approve it
  // (move to todo) the SAME notes become the worker's prompt verbatim
  // (composeTaskPrompt). Interleaved 「このカードを todo へ動かしてください」
  // reads to a worker as an instruction it cannot carry out — so the owner's
  // half says "作業者は読み飛ばして", and the worker's half is a self-contained
  // brief that never refers back to the approval step.
  const notes = [
    `毎日の燃費チェックが基準超えを見つけたため、自動で起票しました(チェック自体に消費はありません)。`,
    ``,
    `## 計測結果(${date} 時点・直近${windowHours}時間)`,
    `- 終わったカード: ${summary.cards}枚`,
    `- 手数(中央値): ${fmtNum(summary.medianTurns)}手`,
    `- 道具の束ね率: ${bundle}`,
    `- 文脈の最大: ${plainCount(summary.maxContext)}`,
    `- 文章の出力合計: ${plainCount(summary.outputTokens)}` +
      (summary.sidechainOutputTokens > 0
        ? `(このほかに下請けの調査役が${plainCount(summary.sidechainOutputTokens)}。合計には含めていません)`
        : ''),
    ``,
    `## 超えた基準`,
    ...reasons.map((r) => `- ${r}`),
    ``,
    `---`,
    ``,
    `## ▼ オーナーへ — 判断のお願い(作業者はこの節を読み飛ばしてください)`,
    `- これは提案です。まだ何も実行されていません。`,
    `- 実施する場合: このカードを todo 列へ動かしてください(それが承認になり、そこで初めて実装が動きます)。`,
    `- 見送る場合: このカードを削除するか done へ動かしてください(翌日以降、同じ劣化が続けば改めて起票されます)。`,
    ``,
    `---`,
    ``,
    `## ▼ 作業者へ — ここから下だけが作業指示です`,
    `目的: 上の「超えた基準」に挙がった項目を、次回の日次計測で基準内に戻す。`,
    `着手前に: \`npm run swarm:audit\` で現状を自分の目で確認する(計測器は既にあります — 新しく作らないこと)。`,
    `対応(「超えた基準」に挙がったものだけをやる。挙がっていない項目には触らない):`,
    `- 「道具の束ね率」が低い → worker 向け指示書に「調べものはできるだけまとめて一度に」を明記する。`,
    `  少ない往復で同じ仕事が終わるようになる。変更は指示書の文面のみ。`,
    `- 「手数」が多い → カード1枚に詰め込む量を減らす方向で、起票テンプレ/分割の目安を見直す。`,
    `  1枚あたりが軽くなる代わりにカード枚数は増える — そのトレードオフを説明に残すこと。`,
    `- 「文脈」が大きい → 長い調べものを subagent に切り出す導線を用意する。`,
    `  1作業が一度に抱える量が減る代わりに段取りが1段増える。`,
    `完了条件: 上記のうち該当する手が実装され、なぜそれが指標を戻すのかがカードに1行で書かれていること。`,
    `(効果そのものは翌日以降の日次燃費日報で確認されます — このカードの中では待たないこと。)`,
  ].join('\n')
  return {
    id: randomUUID(),
    // Japanese-only title: 「[swarm]」 is engineer jargon on a card whose first
    // reader is the owner. 燃費 is the metaphor already in use for this loop.
    title: `【燃費】改善提案 ${date} — 燃費が基準を下回りました`,
    notes,
    done: false,
    boardColumn: 'blocked',
    createdAt: new Date(nowMs).toISOString(),
    fuelProposalKey: FUEL_PROPOSAL_KEY,
  }
}

// ── The daily run ───────────────────────────────────────────────────────────

/** What one report run did — returned for tests/observability. */
export interface DailyFuelReportResult {
  summary: DailyFuelSummary
  degraded: boolean
  /** 'filed' = new card created this run; 'already-open' = dedup guard held;
   *  'no-target' = degraded but no registered project to file into;
   *  'none' = healthy day. */
  proposalOutcome: 'none' | 'filed' | 'already-open' | 'no-target'
  proposal: DailyFuelProposalRef | null
  detail: string
}

/** Run ONE daily analysis + report + (maybe) proposal filing. Deterministic
 *  and read-only apart from: the bell notification, the sentinel, and — on a
 *  degraded day — the proposal card. Never calls an LLM. The caller decides
 *  WHEN (shouldReportNow); this function only does the work. */
export const runDailyFuelReport = async (
  opts: { now?: number; claudeRoot?: string } = {},
): Promise<DailyFuelReportResult> => {
  const now = opts.now ?? Date.now()
  const sentinel = await effectiveFuelSentinel()

  // Window: [lastCutoff, now - QUIET). Clock weirdness (a cutoff in the
  // future after a manual clock change) falls back to the initial 24h window;
  // a multi-day outage is clamped so this stays a DAILY report (MAX_WINDOW_MS).
  const cutoff = now - QUIET_MS
  let windowStart = sentinel?.lastCutoffMs ?? cutoff - INITIAL_WINDOW_MS
  if (!(windowStart < cutoff)) windowStart = cutoff - INITIAL_WINDOW_MS
  if (cutoff - windowStart > MAX_WINDOW_MS) windowStart = cutoff - MAX_WINDOW_MS
  // The REAL span this report covers — normally ~26h, but the first-ever run and
  // any catch-up after an outage differ, and the owner-facing text names it
  // rather than always saying 「きのう」.
  const windowHours = Math.max(1, Math.round((cutoff - windowStart) / 3_600_000))

  // Enumerate candidate worker sessions (mtime pre-filter skips files whose
  // last write predates the window — cheap), then confirm by the JSONL's own
  // lastAt stamp. Worker worktree dirs ONLY (no extraDirs): the report's unit
  // is the CARD, and commander/supply desks are not cards.
  const files = await collectSwarmSessionFiles({
    root: opts.claudeRoot,
    sinceMs: windowStart,
  })
  const audits: SessionTokenAudit[] = []
  const auditDirs: string[] = []
  for (const f of files) {
    const audit = await auditSessionFile(f.file)
    if (!audit) continue
    const lastMs = Date.parse(audit.lastAt)
    if (!Number.isFinite(lastMs)) continue
    if (lastMs < windowStart || lastMs >= cutoff) continue
    audits.push(audit)
    auditDirs.push(f.dir)
  }
  const summary = summarizeAudits(audits)

  // Degradation check — only meaningful with a real sample (≥2 cards).
  const reasons = summary.cards >= DEGRADE_MIN_CARDS ? degradationReasons(summary) : []
  const degraded = reasons.length > 0

  // Re-validate the dedup guard against the live Board: a resolved (done /
  // deleted) proposal frees the lane again.
  let proposal = sentinel?.proposal ?? null
  let proposalCard: ProjectTask | null = null
  if (proposal) {
    proposalCard = await findOpenProposal(proposal)
    if (!proposalCard) proposal = null
  }

  // ARM THE ONCE-A-DAY GUARD BEFORE ANY SIDE EFFECT. Everything below — the
  // proposal card, the bell, the sentinel file — can fail permanently, and if
  // the guard existed only inside what those steps write, a permanent failure
  // would re-run the whole report on the next tick: on a degraded day, a NEW
  // proposal card every 60 seconds. Marking the day up front costs at most one
  // skipped report; not marking it costs an unbounded flood of cards.
  const armed: DailyFuelSentinel = {
    lastReportDate: localDateKey(now),
    lastCutoffMs: cutoff,
    lastSummary: summary,
    proposal,
  }
  setFuelMemo(armed)

  let proposalOutcome: DailyFuelReportResult['proposalOutcome'] = 'none'
  let proposalNote = ''
  if (degraded) {
    if (proposal && proposalCard) {
      proposalOutcome = 'already-open'
      proposalNote = openProposalNote(proposalCard)
    } else {
      const target = await resolveProposalTarget(auditDirs)
      if (target) {
        const task = buildProposalTask(summary, reasons, now, windowHours)
        // BOARD-TRUTH DEDUP, decided INSIDE the write lock. mutateProjectData
        // re-reads the board inside its lock, so checking there (rather than a
        // read-then-write outside it) is atomic: two ticks racing cannot both
        // observe an empty board and both push a card.
        //
        // This is the guard that survives what the sentinel cannot. The sentinel
        // is tolerant by design (unreadable ⇒ null) and its in-process half dies
        // with the process — so a daily-fuel-report.json that is lost or can
        // never be written used to read as "nothing open" on every single app
        // start, filing an identical card into blocked day after day. The board
        // is the thing being deduped, so it cannot drift out of sync with itself.
        let existing: ProjectTask | null = null
        await mutateProjectData(target.path, (data) => {
          existing = openFuelProposals(data.tasks)[0] ?? null
          if (existing) return // someone's proposal is already waiting — file nothing
          data.tasks.push(task)
        })
        const open = existing as ProjectTask | null
        if (open) {
          // Adopt the card we found into the sentinel, so the next run has a
          // precise reference again even though the old sentinel was lost.
          proposal = { projectPath: target.path, taskId: open.id, createdAt: now }
          proposalCard = open
          setFuelMemo({ ...armed, proposal })
          proposalOutcome = 'already-open'
          proposalNote = openProposalNote(open)
        } else {
          proposal = { projectPath: target.path, taskId: task.id, createdAt: now }
          proposalCard = task
          // Into the guard IMMEDIATELY — before the bell and before the disk
          // write, either of which can throw. (If the card write itself throws,
          // `proposal` stays null and the lane simply retries tomorrow.)
          setFuelMemo({ ...armed, proposal })
          proposalOutcome = 'filed'
          proposalNote =
            '⚠ 燃費が基準より悪化したため、改善提案カードを保留列(blocked)に起票しました。実施するなら todo 列へ動かしてください — それが承認になります。'
        }
      } else {
        proposalOutcome = 'no-target'
        proposalNote =
          '⚠ 燃費が基準より悪化しています(起票先のプロジェクトが見つからないため、お知らせのみ)。'
      }
    }
  }

  const detail = buildReportDetail(
    summary,
    trendLine(sentinel?.lastSummary ?? null, summary),
    proposalNote,
    windowHours,
  )
  // The card's TITLE is the only 導線 the bell can actually render — the panel's
  // swarm-info row shows `taskTitle` + `branch` and nothing else, so a taskId
  // alone left the "起票しました" line pointing at nothing the owner could see.
  const proposalTitle =
    proposalOutcome === 'filed' || proposalOutcome === 'already-open'
      ? (proposalCard?.title ?? null)
      : null

  // The two remaining side effects are BEST-EFFORT — the day is already marked
  // in memory, so a permanently failing bell must not re-fire the whole report
  // (and with it another proposal card) on the next tick. OS toast only on a
  // degraded day; the routine daily report stays a quiet bell entry (the
  // "propose only when degraded" philosophy).
  try {
    await createSwarmInfoNotification(
      {
        event: 'daily-fuel-report',
        detail,
        ...(proposal && proposalTitle
          ? { projectPath: proposal.projectPath, taskId: proposal.taskId, taskTitle: proposalTitle }
          : {}),
      },
      { now, os: degraded },
    )
  } catch (e) {
    console.error('[openground:fuel-report] bell notification failed — today stays marked, no retry', e)
  }

  await commitFuelSentinel({ ...armed, proposal })

  return { summary, degraded, proposalOutcome, proposal, detail }
}

// ── The app-uptime loop ─────────────────────────────────────────────────────

/** One loop tick: a cheap date/hour check against the sentinel; the analysis
 *  itself runs at most once a day. A thrown tick is logged and retried on the
 *  next one — safe because the once-a-day guard is armed BEFORE the side
 *  effects, so a retry can no longer re-file a proposal card.
 *
 *  The re-entrancy flag lives on globalThis, like the timer: `tsx watch`
 *  re-evaluates this module on reload, and a module-scoped flag would leave
 *  the old and new copies guarding two different booleans — two ticks at once,
 *  and on a degraded day two proposal cards. */
const fuelReportTick = async (): Promise<void> => {
  if (globalThis.__openground_fuel_tick_inflight) return
  globalThis.__openground_fuel_tick_inflight = true
  try {
    const now = Date.now()
    const sentinel = await effectiveFuelSentinel()
    if (shouldReportNow(sentinel, now)) {
      const r = await runDailyFuelReport({ now })
      console.log(
        `[openground:fuel-report] daily report sent — cards=${r.summary.cards} degraded=${r.degraded} proposal=${r.proposalOutcome}`,
      )
    }
  } catch (e) {
    console.error('[openground:fuel-report] tick failed (will retry next tick)', e)
  } finally {
    globalThis.__openground_fuel_tick_inflight = false
  }
}

/** Start the daily fuel-report loop. Same shape as startTerminalSweepLoop:
 *  wired ONCE at real-server boot (server/index.ts — unit tests mount the
 *  Hono app, not the entry), idempotent + reload-safe via the globalThis
 *  timer, unref'd so it never keeps the process alive. Runs one immediate
 *  tick for the boot catch-up ("started at 14:00 → report now"). */
export const startDailyFuelReportLoop = (intervalMs: number = FUEL_REPORT_TICK_MS): void => {
  if (globalThis.__openground_fuel_report_timer) {
    clearInterval(globalThis.__openground_fuel_report_timer)
  }
  const timer = setInterval(() => {
    void fuelReportTick()
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_fuel_report_timer = timer
  void fuelReportTick()
}

/** Stop the loop (shutdown / test cleanup). Idempotent. */
export const stopDailyFuelReportLoop = (): void => {
  if (globalThis.__openground_fuel_report_timer) {
    clearInterval(globalThis.__openground_fuel_report_timer)
    globalThis.__openground_fuel_report_timer = null
  }
}
