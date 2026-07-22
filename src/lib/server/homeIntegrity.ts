// homeIntegrity — the BOOT-TIME DAMAGE CHECK for the two irreplaceable home
// files (settings.json = the project registry, canvas.json = the card layout).
//
// The companion to homeBackup.ts: backups mean damage is RECOVERABLE, this means
// damage is NOTICED. On 2026-07-18 the registry went 45 → 3 entries and nothing
// said a word — the loss was found by hand, long after, and the card layout was
// already unrecoverable by then.
//
// THREE RULES THIS MODULE OBEYS, and none of them is negotiable:
//
//   1. IT NEVER WRITES THE FILES IT JUDGES. Not to repair, not to normalise, not
//      to "clean up". It reads settings.json / canvas.json and writes only its
//      OWN watermark (integrity.json) plus a notification. A checker that edits
//      is a checker that can destroy the evidence — and the very failure it
//      hunts for is "something overwrote the registry".
//   2. IT NEVER AUTO-RESTORES. A shrink can be legitimate (the user really did
//      remove those projects), and silently reviving deleted projects would be
//      its own data-loss bug in the opposite direction. The output is a WARNING
//      plus RESTORE CANDIDATES; choosing is the human's act.
//   3. NO BASELINE ⇒ NO ALERT. A fresh install has no watermark to compare
//      against, so the first boot only records. Alerting requires evidence of a
//      BEFORE, never a guess from the current state alone.
//
// DEDUPE: a damaged file is damaged on every boot, and re-alerting each launch
// would train the user to ignore the bell. `lastAlert` records the transition
// already reported and suppresses the identical one. It is CLEARED by any clean
// boot, so a SECOND, later incident from the same baseline still alerts (an
// earlier draft deduped on the baseline alone and would have swallowed exactly
// that case).

import { readFile } from 'fs/promises'
import { atomicWriteJson } from './atomicWrite'
import {
  DIMENSIONS,
  PROTECTED_KINDS,
  PROTECTED_LABELS,
  backupDirFor,
  countEntriesFor,
  describeCounts,
  highWaterFromGenerations,
  listRestoreCandidates,
  liveFileFor,
  stampFor,
  type ProtectedKind,
  type RestoreCandidate,
} from './homeBackup'
import { backupsRootDir, ensureOpenGroundHome, integrityFile } from './paths'
import { createSwarmFatalNotification } from './swarmNotifications'

// ─── Thresholds ──────────────────────────────────────────────────────────────
// A shrink must clear BOTH bars to alert. Requiring both is what keeps routine
// tidying quiet: removing 5 projects out of 45 is a ratio of 0.11 and stays
// silent, while 45 → 3 is a ratio of 0.93 and does not.

/** Minimum entries lost before a shrink is even considered. */
export const MIN_ABSOLUTE_LOSS = 5
/** …and the fraction of the previous count that must be gone. */
export const MIN_LOSS_RATIO = 0.5
/** A drop to ZERO from a non-trivial baseline always alerts, even below
 *  MIN_ABSOLUTE_LOSS — "everything is gone" is never routine tidying, and a
 *  4-project user losing all 4 would otherwise slip under the absolute bar. */
export const WIPE_ALERT_MIN_PREVIOUS = 3

/** The cumulative bar, measured against `highWater` instead of the last boot.
 *  Looser on purpose — it exists to catch a slow bleed no single step trips, so
 *  it must not double as a second opinion on ordinary tidying. */
export const HIGHWATER_MIN_LOSS = 10
export const HIGHWATER_LOSS_RATIO = 0.5

/**
 * Values that PROVE a test fixture wrote into the real home. Each is a literal a
 * test hard-codes and NO user action can produce, so a hit is certain
 * contamination — not a heuristic.
 *
 * All of these come from ONE test, `src/lib/server/storeSettingsRace.test.ts`,
 * which calls the real `setSettings` and is the only test in the suite that
 * hard-codes `projectsMigratedAt`. It writes all three keys in a single
 * `Promise.all`, so they are CO-SIGNATURES: seeing any one of them means that
 * test ran against the real `~/.openground` instead of an isolated temp home.
 * Checking all three rather than only the timestamp matters because the three
 * writes race — a partial escape can land just one of them.
 *
 * `'OLD'` is the same file's `beforeEach` baseline, which survives on disk if a
 * run is aborted mid-test (the documented "never kill vitest mid-run" trap).
 *
 * KNOWN TRADE-OFF (recorded in review, 2026-07-19): only `projectsMigratedAt` is
 * strictly impossible for a user to produce — it is stamped server-side from the
 * wall clock. A user COULD in principle set `defaultWorkspace` to `/tmp/og-ws`,
 * and `archiveDirName` to `_arc` (a deprecated field no UI writes any more).
 * They stay in the table because the three writes RACE, so a partial escape can
 * land only the weak ones, and missing a real contamination costs more than the
 * false positive does: this finding never touches data, it produces one
 * dismissible notice asking the owner to check.
 *
 * Extend this table; never loosen an entry into a pattern match. A false
 * positive here tells the owner their real data is fake.
 */
export const TEST_FIXTURE_VALUES: Readonly<Record<string, readonly string[]>> = {
  projectsMigratedAt: ['2026-01-02T03:04:05.000Z', 'OLD'],
  defaultWorkspace: ['/tmp/og-ws', 'OLD'],
  archiveDirName: ['_arc', 'OLD'],
}

// ─── Watermark ───────────────────────────────────────────────────────────────

export interface IntegrityWatermark {
  /** Counts last observed per protected file, ONE PER DIMENSION (homeBackup's
   *  DIMENSIONS). Follows the file on every boot. */
  counts?: Partial<Record<ProtectedKind, (number | null)[]>>
  /** The HIGHEST count seen since the last high-water alert. `counts` follows
   *  the file down, which alone makes a SLOW bleed invisible: 45→40→35→…→3 one
   *  step per boot never trips the per-boot bar and ends at 3 with nothing ever
   *  reported (adversarial review 2026-07-19 — and under `tsx watch`, where
   *  every file save restarts the server, "per boot" is minutes apart). This is
   *  the second, much looser bar that catches the cumulative drop. Reset to the
   *  current count whenever it fires, so repairing afterwards cannot nag. */
  highWater?: Partial<Record<ProtectedKind, number[]>>
  /** When those counts were observed (epoch ms). */
  observedAt?: number
  /** The transition already reported, so it is not re-reported every launch.
   *  Cleared by any clean boot — see the DEDUPE note in the file header. */
  lastAlert?: { signature: string; at: number }
  /** The FULL warning text of the most recent detection, kept so the evidence
   *  outlives the console scrollback and the 50-record notification cap. The
   *  bell shows a one-line summary; the restore candidates and their paths live
   *  here. Cleared by a clean boot. */
  lastReport?: { at: number; message: string }
  /** When the owner last accepted the current state as normal
   *  (acknowledgeIntegrityReport). Recorded for the report surface; the silence
   *  itself comes from counts/highWater having been pinned to that state. */
  acknowledgedAt?: number
  /**
   * Generations at or before this moment do not count toward the derived peak.
   * Advanced when a loss is REPORTED and when the owner ACKNOWLEDGES; never
   * cleared by a quiet boot.
   *
   * It is deliberately NOT `lastAlert.at`, even though they are usually set
   * together. `lastAlert` is the dedupe record and a clean boot drops it on
   * purpose (so a second, separate incident still alerts). Reusing it as the
   * window anchor made the window disappear on the first quiet boot, the pinned
   * pre-damage generation resurrected the old peak, and every project the owner
   * restored rang a fresh alarm — the exact nagging this window exists to stop.
   * Two jobs, two fields.
   */
  peakWindowFrom?: number
}

const readWatermark = async (): Promise<IntegrityWatermark | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(integrityFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as IntegrityWatermark
  } catch {
    return null // absent (fresh install) or corrupt ⇒ no baseline ⇒ rule 3
  }
}

const writeWatermark = async (w: IntegrityWatermark): Promise<void> => {
  await ensureOpenGroundHome()
  await atomicWriteJson(integrityFile(), w)
}

// ─── Reading the judged files RAW ────────────────────────────────────────────
// Deliberately NOT via getSettings(): that applies defaults and coerces a
// malformed `projects` to [], which would render a CORRUPT file indistinguishable
// from an EMPTY one — and telling those apart is most of this module's job.

type RawState =
  | { ok: true; counts: (number | null)[]; fields: Record<string, unknown> }
  | { ok: false; reason: 'missing' | 'unparseable' }

const readRaw = async (kind: ProtectedKind): Promise<RawState> => {
  let text: string
  try {
    text = await readFile(liveFileFor(kind), 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'unparseable' }
    }
    const obj = parsed as Record<string, unknown>
    // ONE definition of "how much is in here", shared with the backup pin
    // (countEntriesFor) so the two can never disagree — and PER DIMENSION, so a
    // canvas that gained stickies while losing every card position is not scored
    // as unchanged (review, 2026-07-19).
    const counts = countEntriesFor(kind, text)
    if (counts.every((c) => c === null)) return { ok: false, reason: 'unparseable' }
    return { ok: true, counts, fields: obj }
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
}

// ─── Findings ────────────────────────────────────────────────────────────────

export type FindingKind = 'shrink' | 'unreadable' | 'test-fixture-value'

export interface IntegrityFinding {
  kind: FindingKind
  file: ProtectedKind
  /** Which independent quantity shrank (homeBackup DIMENSIONS key) — shrink
   *  findings only. Present so "the canvas lost entries" can never be ambiguous
   *  between card positions and elements. */
  dimension?: string
  /** Entry count last seen (shrink / unreadable only). */
  previous?: number
  /** Entry count now (shrink only). */
  current?: number
  /** The settings field that carried a fixture value (test-fixture-value only). */
  field?: string
  /** The contaminating value found (test-fixture-value only). */
  value?: string
}

export interface IntegrityReport {
  checkedAt: number
  findings: IntegrityFinding[]
  /** Restore options, best first — populated ONLY when there are findings. */
  candidates: Partial<Record<ProtectedKind, RestoreCandidate[]>>
  /** The full plain-Japanese warning (empty when there are no findings). */
  message: string
  /** True when a bell notification was raised for this report (false when the
   *  identical transition was already reported on an earlier boot). */
  notified: boolean
}

/** Stable per-transition key for the dedupe record. */
const signatureOf = (findings: IntegrityFinding[]): string =>
  findings
    .map(
      (f) =>
        `${f.file}:${f.kind}:${f.previous ?? ''}>${f.current ?? ''}:${f.field ?? ''}=${f.value ?? ''}`,
    )
    .sort()
    .join('|')

// ─── Plain-Japanese wording ──────────────────────────────────────────────────
// The reader is the OWNER, who is not a programmer. Every warning answers three
// questions in this order and nothing else: WHAT HAPPENED / WHAT YOU CAN CHOOSE /
// WHAT EACH CHOICE DOES. No jargon ("registry", "パース", "スキーマ"), no file
// format talk, no instruction to run a command. Paths appear only as the label of
// a restore option, because a path is the one thing the user may have to hand to
// someone else.

const fmtDate = (ms: number): string => {
  // A hand-planted / malformed backup name yields NaN, and "NaN年NaN月NaN日" in
  // a warning about lost data reads as a second bug on top of the first.
  if (!Number.isFinite(ms)) return '日時不明'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

const describeCandidate = (kind: ProtectedKind, c: RestoreCandidate): string => {
  const origin =
    c.source === 'backup'
      ? '自動で作られた控え'
      : 'アプリが前回保存しきれずに残したファイル（内容は使えます）'
  // Every dimension named — a candidate must never look rich because one
  // quantity hid another (that is the bug this whole rework is about).
  return `  ・${fmtDate(c.at)} の${origin}（${describeCounts(kind, c.entryCounts)}）\n    ${c.path}`
}

/** Build the warning text. Pure and exported so the wording itself is testable —
 *  the three required sections are a contract, not a formatting detail. */
export const buildWarningMessage = (
  findings: IntegrityFinding[],
  candidates: Partial<Record<ProtectedKind, RestoreCandidate[]>>,
): string => {
  if (findings.length === 0) return ''
  const what: string[] = []
  for (const f of findings) {
    const label = PROTECTED_LABELS[f.file]
    if (f.kind === 'shrink') {
      // NOTE the second sentence. A user who really did delete many projects in
      // one sitting trips this same threshold (the watermark only refreshes at
      // boot, deliberately — refreshing it on every write would let the exact
      // 2026-07-18 mechanism, a stray process calling the normal save path,
      // move the baseline down and erase its own tracks). So the wording must
      // NOT insist something is broken. It reports the fact and lets the owner,
      // who alone knows whether they did it, judge.
      const di = dimensionIndex(f)
      const what_ = di >= 0 ? DIMENSIONS[f.file][di] : null
      what.push(
        `・${what_ ? what_.label : label}が、前回の ${f.previous} ${what_?.unit ?? '件'}から ` +
          `${f.current} ${what_?.unit ?? '件'}に減っていました。` +
          `ご自身で整理された場合は、そのままで問題ありません。` +
          `心当たりがない場合は、意図しない消え方をした可能性があります。`,
      )
    } else if (f.kind === 'unreadable') {
      what.push(
        `・${label}が読めなくなっていました（前回は ${f.previous} 件ありました）。` +
          `ファイルが壊れた可能性があります。`,
      )
    } else {
      what.push(
        `・${label}に、動作テスト用の目印（${f.value}）が混ざっていました。` +
          `本来のあなたのデータではないものが書き込まれた可能性があります。`,
      )
    }
  }

  const choices: string[] = ['1) このまま使う — 今の状態のまま、いつもどおりアプリを使います。']
  const lines: string[] = []
  let anyCandidate = false
  for (const kind of PROTECTED_KINDS) {
    const list = (candidates[kind] ?? []).slice(0, 5)
    if (list.length === 0) continue
    anyCandidate = true
    lines.push(`  【${PROTECTED_LABELS[kind]}】（置き場所: ${backupDirFor(kind)}）`)
    for (const c of list) lines.push(describeCandidate(kind, c))
  }
  if (anyCandidate) {
    choices.push('2) 前の状態に戻す — 下の控えから選んで、減る前の内容に戻します。')
    choices.push(...lines)
  } else {
    choices.push(
      '2) （今回は戻せる控えが見つかりませんでした。これ以降の変更は自動で控えが作られます。）',
    )
  }

  return [
    '【何が起きたか】',
    ...what,
    '',
    '【何を選べるか】',
    ...choices,
    '',
    '【選ぶとどうなるか】',
    '・OPEN GROUND が勝手に元へ戻すことはありません。あなたが選ぶまで、今の状態のままです。',
    anyCandidate
      ? '・「前の状態に戻す」を選ぶと、今の内容は控えの内容に置きかわります。置きかえる直前の内容も自動で控えに残るので、やり直せます。'
      : '・このまま使っても、以降の変更は毎回控えが作られるので、次からは戻せます。',
    '・判断がつかないときは、まず「このまま使う」で問題ありません。控えは消えません。',
  ].join('\n')
}

/** The bell's first line: what happened, in one sentence. */
export const notificationDetail = (
  findings: IntegrityFinding[],
  candidates: Partial<Record<ProtectedKind, RestoreCandidate[]>>,
): string => {
  const first = findings[0]
  if (!first) return ''
  const d = dimensionIndex(first)
  // Name the DIMENSION that shrank, not just the file: "the canvas lost entries"
  // is ambiguous between card positions and stickies, and only one of those is
  // what the owner lost on 2026-07-18.
  const label =
    first.dimension && d >= 0 ? DIMENSIONS[first.file][d].label : PROTECTED_LABELS[first.file]
  const unit = d >= 0 ? DIMENSIONS[first.file][d].unit : '件'
  const best = (candidates[first.file] ?? []).find(
    (c) => (c.entryCounts[Math.max(d, 0)] ?? 0) > 0,
  )
  const rescue = best
    ? `${best.entryCounts[Math.max(d, 0)]} ${unit}ぶんの控えが残っています（自動では戻しません）。`
    : '控えは見つかりませんでした。'
  if (first.kind === 'shrink') {
    return `${label}が ${first.previous} ${unit}から ${first.current} ${unit}に減っていました。${rescue}`
  }
  if (first.kind === 'unreadable') {
    return `${PROTECTED_LABELS[first.file]}が読めなくなっていました。${rescue}`
  }
  return `${PROTECTED_LABELS[first.file]}に、動作テスト用の目印（${first.value}）が混ざっていました。中身をご確認ください。`
}

/** Dimension index a finding refers to, or -1. */
export const dimensionIndex = (f: IntegrityFinding): number =>
  f.dimension ? DIMENSIONS[f.file].findIndex((d) => d.key === f.dimension) : -1

/** The bell's second line: WHERE the backups are. An absolute path, because the
 *  owner may need to hand it to someone else, and because there is no restore
 *  button yet — this is the導線 or there is none. */
export const restoreHint = (
  candidates: Partial<Record<ProtectedKind, RestoreCandidate[]>>,
): string => {
  const parts: string[] = []
  for (const kind of PROTECTED_KINDS) {
    const list = candidates[kind] ?? []
    if (list.length === 0) continue
    const best = list[0]
    parts.push(
      `${PROTECTED_LABELS[kind]}: ${list.length} 世代（最良 ${describeCounts(kind, best.entryCounts)}）` +
        ` — ${backupDirFor(kind)}`,
    )
  }
  return parts.length > 0
    ? `控えの置き場所 → ${parts.join(' / ')}`
    : `控えの置き場所 → ${backupsRootDirLabel()}（今回は該当する控えがありませんでした）`
}

/** The backups root, for the "nothing to restore" case. Uses the path builder,
 *  NOT a `/settings` string strip — on Windows join() emits backslashes and the
 *  strip silently no-ops, printing a wrong location in the one message whose job
 *  is telling the owner where to look. (Same trap the sweepStrayTemps comment
 *  records; caught again in review 2026-07-19.) */
const backupsRootDirLabel = (): string => backupsRootDir()

// ─── The read-only report surface (GET /api/home-integrity) ──────────────────
// The boot check runs once, at startup, and its console output scrolls away.
// These let a UI (or the owner, or an assistant helping them) ask "what did it
// find, and what can I restore from?" at any time. Both are READS — no route may
// ever restore, because that is a destructive act the owner has to perform
// deliberately (rule 2).

/** The full text of the most recent detection, or null if nothing was found. */
export const readLastIntegrityReport = async (): Promise<{
  at: number
  message: string
} | null> => (await readWatermark())?.lastReport ?? null

/**
 * ACKNOWLEDGE the current report: accept today's state as the new normal.
 *
 * The one action the owner has that is neither "restore by hand" nor "keep being
 * told". It only ever writes integrity.json — never the protected files — so the
 * worst it can do is make the app stop mentioning a loss the owner has already
 * decided about. The counts and high-water marks are pinned to what is on disk
 * right now, and the stored report is cleared.
 *
 * Backups are NOT touched: acknowledging is "stop telling me", not "throw away
 * my only copy". The pinned generation stays restorable indefinitely.
 */
export const acknowledgeIntegrityReport = async (
  opts: { now?: number } = {},
): Promise<IntegrityWatermark> => {
  const now = opts.now ?? Date.now()
  const counts: Partial<Record<ProtectedKind, (number | null)[]>> = {}
  const highWater: Partial<Record<ProtectedKind, number[]>> = {}
  for (const kind of PROTECTED_KINDS) {
    const raw = await readRaw(kind)
    if (!raw.ok) continue
    counts[kind] = raw.counts
    highWater[kind] = raw.counts.map((c) => c ?? 0)
  }
  const next: IntegrityWatermark = {
    counts,
    highWater,
    observedAt: now,
    acknowledgedAt: now,
    // Older generations (including the pinned pre-damage one, which is kept
    // forever) must stop counting toward the peak, or the very next boot would
    // re-derive the old number and undo the acknowledgement.
    peakWindowFrom: now,
  }
  await writeWatermark(next)
  return next
}

/** Every restore option for every protected file, best first, with the directory
 *  they live in — so the answer to "where are my backups?" is one call. */
export const listRestoreCandidatesForAll = async (): Promise<
  Record<string, { dir: string; candidates: RestoreCandidate[] }>
> => {
  const out: Record<string, { dir: string; candidates: RestoreCandidate[] }> = {}
  for (const kind of PROTECTED_KINDS) {
    out[kind] = {
      dir: backupDirFor(kind),
      candidates: await listRestoreCandidates(kind).catch(() => []),
    }
  }
  return out
}

// ─── The check ───────────────────────────────────────────────────────────────

/**
 * Compare the protected files against the last boot's watermark and report
 * damage. Read-only with respect to the judged files (rule 1); never restores
 * (rule 2); silent without a baseline (rule 3).
 *
 * `opts.notify: false` suppresses the bell/OS notification (used by tests and by
 * any caller that only wants the report).
 */
export const checkHomeIntegrity = async (
  opts: { now?: number; notify?: boolean } = {},
): Promise<IntegrityReport> => {
  const now = opts.now ?? Date.now()
  const previous = await readWatermark()
  const findings: IntegrityFinding[] = []
  const counts: Partial<Record<ProtectedKind, (number | null)[]>> = {}
  /** `<kind>:<dimension index>` entries reported this boot — their high-water
   *  mark resets to the current count so repairing afterwards cannot re-trip. */
  const firedHighWater = new Set<string>()

  for (const kind of PROTECTED_KINDS) {
    const raw = await readRaw(kind)
    const before = previous?.counts?.[kind]

    if (!raw.ok) {
      // A file we have a BASELINE for is now unreadable ⇒ real damage. Without a
      // baseline it is just a fresh install (rule 3).
      if (before?.some((c) => typeof c === 'number' && c > 0)) {
        findings.push({
          kind: 'unreadable',
          file: kind,
          previous: Math.max(...before.map((c) => c ?? 0)),
        })
      }
      // Do NOT record counts for an unreadable file — writing 0 here would let
      // the next boot see "0 → 0, all normal" and forget the damage entirely.
      if (before) counts[kind] = before
      continue
    }

    counts[kind] = raw.counts

    // EVERY DIMENSION IS JUDGED ON ITS OWN. Collapsing canvas into one number
    // let a rising element count hide a collapsing position count entirely
    // (45pos/0el → 45pos/100el → 0pos/100el reported nothing, because the summed
    // 145 → 100 is a 31% drop). See DIMENSIONS in homeBackup.ts.
    //
    // The generation-derived peak is windowed to AFTER the last alert: the pin
    // keeps the pre-damage generation alive forever, so an unwindowed derivation
    // resurrects the old peak on every boot and re-alerts at each step of the
    // owner's repair (review, 2026-07-19).
    const derived = await highWaterFromGenerations(kind, {
      sinceStamp: previous?.peakWindowFrom ? stampFor(previous.peakWindowFrom) : undefined,
    }).catch(() => [])

    for (let d = 0; d < DIMENSIONS[kind].length; d++) {
      const now_ = raw.counts[d]
      if (typeof now_ !== 'number') continue
      const dim = DIMENSIONS[kind][d]
      let reported = false

      // Bar 1 — the drop since the LAST boot (a sudden clobber).
      const was = before?.[d]
      if (typeof was === 'number' && was > 0) {
        const lost = was - now_
        const wipe = now_ === 0 && was >= WIPE_ALERT_MIN_PREVIOUS
        if (wipe || (lost >= MIN_ABSOLUTE_LOSS && lost / was >= MIN_LOSS_RATIO)) {
          findings.push({
            kind: 'shrink',
            file: kind,
            dimension: dim.key,
            previous: was,
            current: now_,
          })
          reported = true
        }
      }

      // Bar 2 — the drop since the HIGH WATER mark (a slow bleed, or a loss that
      // began and ended between two boots). Skipped when bar 1 already spoke for
      // this dimension, so one incident is never two findings.
      const peak = Math.max(previous?.highWater?.[kind]?.[d] ?? 0, derived[d] ?? 0)
      if (!reported && peak > 0) {
        const lost = peak - now_
        if (lost >= HIGHWATER_MIN_LOSS && lost / peak >= HIGHWATER_LOSS_RATIO) {
          findings.push({
            kind: 'shrink',
            file: kind,
            dimension: dim.key,
            previous: peak,
            current: now_,
          })
          reported = true
        }
      }
      if (reported) firedHighWater.add(`${kind}:${d}`)
    }

    // Fixture contamination is checked on EVERY boot regardless of the watermark
    // — unlike a shrink it needs no baseline, because the value alone is proof.
    if (kind === 'settings') {
      for (const [field, bad] of Object.entries(TEST_FIXTURE_VALUES)) {
        const got = raw.fields[field]
        if (typeof got === 'string' && bad.includes(got)) {
          findings.push({ kind: 'test-fixture-value', file: 'settings', field, value: got })
        }
      }
    }
  }

  // The watermark ALWAYS moves to what is on disk now, including right after a
  // detection. It is the comparison point for the NEXT transition, not a
  // historical record — the evidence lives in `lastReport` (full text with the
  // numbers and restore paths), in the bell notification, and in the backups
  // themselves, all of which outlive it.
  //
  // Holding the pre-damage number instead (an earlier draft did) reads as the
  // safer choice and is not: after a 45 → 3 detection the baseline would stay 45
  // forever, so every project the owner adds back re-computes a DIFFERENT shrink
  // (45→3, then 45→4, 45→5 …). Each has its own signature, so each defeats the
  // dedupe and alerts again — the owner gets warned about the same lost data
  // repeatedly, precisely while they are busy repairing it.
  const nextCounts: Partial<Record<ProtectedKind, (number | null)[]>> = { ...counts }

  // The high-water mark rises with the file and resets to the current count for
  // any DIMENSION reported this boot (so a repair cannot re-trip bar 2).
  const nextHighWater: Partial<Record<ProtectedKind, number[]>> = {}
  for (const kind of PROTECTED_KINDS) {
    const cur = counts[kind]
    const carried = previous?.highWater?.[kind]
    // Carry the recorded peak forward even when the file is UNREADABLE this
    // boot. Dropping it (an earlier version did) meant a corrupt file silently
    // erased the only record of how much used to be there.
    if (!cur) {
      if (carried) nextHighWater[kind] = carried
      continue
    }
    nextHighWater[kind] = DIMENSIONS[kind].map((_, d) => {
      const now_ = cur[d]
      if (typeof now_ !== 'number') return carried?.[d] ?? 0
      return firedHighWater.has(`${kind}:${d}`) ? now_ : Math.max(now_, carried?.[d] ?? 0)
    })
  }

  const candidates: Partial<Record<ProtectedKind, RestoreCandidate[]>> = {}
  if (findings.length > 0) {
    for (const kind of PROTECTED_KINDS) {
      const f = findings.find((x) => x.file === kind)
      if (!f) continue
      // Rank by the dimension that was LOST, so the top candidate is the one that
      // still holds what went missing — not the one with the most stickies.
      candidates[kind] = await listRestoreCandidates(kind, {
        rankBy: Math.max(dimensionIndex(f), 0),
      }).catch(() => [])
    }
  }

  const message = buildWarningMessage(findings, candidates)
  const signature = signatureOf(findings)
  const alreadyReported = findings.length > 0 && previous?.lastAlert?.signature === signature

  await writeWatermark({
    counts: nextCounts,
    highWater: nextHighWater,
    observedAt: now,
    // A clean boot CLEARS the dedupe record (so a later, separate incident from
    // the same baseline is still reported) but CARRIES THE REPORT FORWARD. Since
    // a shrink is now detected exactly once, the very next boot is clean — an
    // earlier version dropped lastReport there, which erased the evidence one
    // relaunch after the incident while a comment claimed it outlived the
    // watermark (adversarial review, 2026-07-19).
    ...(previous?.lastReport ? { lastReport: previous.lastReport } : {}),
    ...(previous?.acknowledgedAt ? { acknowledgedAt: previous.acknowledgedAt } : {}),
    // The peak window survives quiet boots — see the field's note.
    ...(previous?.peakWindowFrom ? { peakWindowFrom: previous.peakWindowFrom } : {}),
    ...(findings.length > 0
      ? {
          lastAlert: alreadyReported ? previous?.lastAlert : { signature, at: now },
          lastReport: { at: now, message },
          // Everything up to this report is now "already accounted for"; only a
          // LATER generation can evidence a new loss.
          peakWindowFrom: now,
        }
      : {}),
  }).catch((e) => console.error('[homeIntegrity] watermark write failed', e))

  let notified = false
  if (findings.length > 0 && !alreadyReported) {
    console.warn(`[homeIntegrity] データの異常を検知しました\n${message}`)
    if (opts.notify !== false) {
      await createSwarmFatalNotification(
        {
          event: 'data-integrity',
          detail: notificationDetail(findings, candidates),
          // `logHint` is the row's second line. This is the ONLY place the owner
          // is told WHERE their backups are, so it carries an absolute path
          // rather than a hint: telling someone "you can restore" without
          // telling them from what is not a warning, it is a taunt.
          logHint: restoreHint(candidates),
        },
        { now },
      ).catch((e) => console.error('[homeIntegrity] notification failed', e))
      notified = true
    }
  }

  return { checkedAt: now, findings, candidates, message, notified }
}
