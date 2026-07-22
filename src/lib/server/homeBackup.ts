// homeBackup — GENERATIONAL BACKUPS for the two irreplaceable ~/.openground
// files: settings.json (the project registry = the validateProjectPath
// allowlist) and canvas.json (the Ground card layout).
//
// WHY: on 2026-07-18 the registry shrank 45 → 3 entries. settings.json was only
// recoverable because an orphaned `.settings.json.tmp-27332-1` — the litter of a
// crashed atomic write — happened to still be in the home dir. canvas.json had no
// such accident and its card positions were unrecoverable. This module removes the
// luck: every write to a protected file first copies the CURRENT on-disk content
// into ~/.openground/backups/<kind>/, so the previous generation always survives.
//
// THREE INVARIANTS, in priority order:
//
//   1. A BACKUP FAILURE MUST NEVER FAIL THE WRITE. Everything here is wrapped and
//      logged; snapshotBeforeWrite resolves to null rather than throwing. A full
//      disk or a permission error degrades to "no new backup", never to "the user
//      can't save". The whole point is protecting data — refusing writes would be
//      the opposite.
//   2. NEVER PRUNE THE GENERATION WORTH RESTORING. Two separate rules, because
//      the obvious one is not enough:
//        - KEEP_FLOOR: at least N generations per kind survive every pass.
//        - THE PIN: the RICHEST generation (most entries) is exempt from every
//          pruning path, always.
//      KEEP_FLOOR alone was a trap. It keeps the NEWEST few, and after a data
//      loss the newest few are all copies of the DAMAGED state. Because
//      KEEP_RECENT counts WRITES, not time, eleven ordinary saves on the same
//      day — minutes of card dragging — pushed the pre-damage generation out of
//      the recent window, and the daily rule could not save it either (same
//      calendar day, already represented). The one generation the owner actually
//      needed was the first to go, while three worthless copies of the damage
//      were protected (found in review, 2026-07-19). The pin fixes that directly:
//      whatever holds the most entries stays until something richer replaces it.
//   3. CONTENT-ADDRESSED DEDUPE. canvas.json is rewritten on every card drag; a
//      naive per-write copy would fill the disk with identical files. A snapshot
//      whose content hash matches the newest existing generation is skipped, so
//      backups accumulate per CHANGE, not per WRITE.
//
// FILE NAMING: `<compact ISO>-<sha256:8>-n<entries>-<seq>.json`, e.g.
// `20260719T120000123Z-a1b2c3d4-n45-3.json`. Deliberately chosen so that
//   - it sorts LEXICOGRAPHICALLY into chronological order (no date parsing to
//     order generations),
//   - the calendar day for the daily policy is just `slice(0, 8)` (no timezone
//     math, no Date construction),
//   - the ENTRY COUNT is readable without opening the file, so pruning can find
//     the richest generation to pin without reading every candidate on every
//     save (`x` when the content did not parse), and
//   - it stays readable to a human browsing the folder in Finder: "n45" is
//     exactly the question ("how many projects were in this one?") they came to
//     the folder to answer.
// `<seq>` is a per-process counter that only breaks ties — two snapshots in the
// same millisecond with the same content hash would otherwise collide on one
// filename and silently overwrite an older generation.

import { createHash } from 'crypto'
import { lstat, mkdir, readFile, readdir, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { atomicWriteText } from './atomicWrite'
import { backupsRootDir, canvasFile, openGroundHome, settingsFile } from './paths'

/** The protected files. The string is the backup subdir name. */
export type ProtectedKind = 'settings' | 'canvas'
export const PROTECTED_KINDS: readonly ProtectedKind[] = ['settings', 'canvas']

/** Human labels for the plain-Japanese surfaces (homeIntegrity). */
export const PROTECTED_LABELS: Record<ProtectedKind, string> = {
  settings: 'プロジェクトの登録一覧',
  canvas: 'カードの並び（配置）',
}

// ─── Retention policy ────────────────────────────────────────────────────────
// Three rules layered newest→oldest. The goal is "enough history to undo a bad
// day" with a HARD ceiling, not an archive.

/** Newest N generations per kind are ALWAYS kept, however old or churny. */
export const KEEP_RECENT = 10
/** Beyond KEEP_RECENT: keep the newest generation of each calendar day for this
 *  many days, and drop everything older outright. */
export const KEEP_DAILY_DAYS = 14
/** Total ceiling across the WHOLE backups tree. Oldest generations are dropped
 *  (never below KEEP_FLOOR per kind) until the tree fits. settings.json+canvas.json
 *  are single-digit KB, so 20MB is thousands of generations — the cap is a runaway
 *  guard (a pathologically large canvas, a write loop), not a routine limit. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
/** Generations per kind that NO pruning path may ever delete (invariant 2). */
export const KEEP_FLOOR = 3
/** How far past KEEP_RECENT generations may pile up before a write bothers to
 *  prune. Pruning is the expensive half of a snapshot (it re-lists both kinds and
 *  stats them for the size cap), and running it on EVERY changed write buys
 *  nothing — the policy is not time-sensitive. With slack it runs about once per
 *  PRUNE_SLACK writes and trims back to the policy, so the steady-state ceiling
 *  is just (KEEP_RECENT + daily window + PRUNE_SLACK) files per kind. */
export const PRUNE_SLACK = 5
/** …but always prune after writing something big, so the size cap cannot be
 *  outrun by a handful of very large generations while the count stays low. */
export const PRUNE_ALWAYS_ABOVE_BYTES = 512 * 1024

/** The only filename shape treated as a generation. Anything else in the dir (a
 *  stray atomic-write temp, .DS_Store, a file the user dropped in) is ignored by
 *  every policy below rather than deleted on a guess. */
const GENERATION_RE =
  /^(\d{8}T\d{9}Z)-([0-9a-f]{8})-n((?:\d+|x)(?:\.(?:\d+|x))*)-([0-9a-z]+)\.json$/

/** Ties-breaker for two snapshots landing in the same millisecond. */
let snapshotSeq = 0

/** Epoch ms → `20260719T120000123Z`. Lexicographically sortable, day = slice(0,8). */
const compactIso = (ms: number): string =>
  new Date(ms).toISOString().replace(/[-:.]/g, '').replace(/(\d{8}T\d{9})Z?$/, '$1Z')

const sha8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8)

/**
 * The part of a protected file whose LOSS is what we are insuring against —
 * what decides "is this change worth spending a generation on?".
 *
 * canvas.json carries `viewport`, the pan/zoom the user happens to be sitting
 * at. It changes on every navigation gesture and holds nothing recoverable.
 * Hashing it meant ten pans — under a minute of ordinary navigating — minted
 * ten generations and pushed the last copy holding real CARD POSITIONS out of
 * the KEEP_RECENT window. That is precisely the loss this module exists to
 * prevent, so viewport is excluded (adversarial review, 2026-07-19; measured:
 * after 10 viewport-only saves the best restore candidate held 0 positions).
 *
 * The stored FILE is always the full original bytes — a restore has to be
 * faithful. This projection only ever decides whether to store one.
 */
const significantContent = (kind: ProtectedKind, raw: string): string => {
  if (kind !== 'canvas') return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    const { viewport: _viewport, ...rest } = parsed as Record<string, unknown>
    return JSON.stringify(rest)
  } catch {
    return raw // unparseable ⇒ treat every byte as significant (fail safe)
  }
}

export const backupDirFor = (kind: ProtectedKind): string => join(backupsRootDir(), kind)

/** Absolute path of the live file a kind protects. Resolved through the SAME
 *  getters store.ts writes through, so an OPENGROUND_HOME-redirected test home
 *  matches exactly — never a basename comparison, which would also match a
 *  `settings.json` somewhere else on disk. */
export const liveFileFor = (kind: ProtectedKind): string =>
  kind === 'settings' ? settingsFile() : canvasFile()

/** Which protected kind (if any) this absolute path is. Exact-path match. */
export const protectedKindOf = (path: string): ProtectedKind | null =>
  PROTECTED_KINDS.find((k) => liveFileFor(k) === path) ?? null

/**
 * The INDEPENDENT quantities a protected file holds. canvas.json carries two —
 * card positions and canvas elements — and they must never be collapsed into one
 * number.
 *
 * The first version counted only positions, so wiping every ELEMENT scored the
 * same before and after. The obvious repair was to add them together; that
 * traded one blind spot for a worse one, because a growing quantity then MASKS a
 * collapsing one. Measured (review, 2026-07-19): 45 positions → 3 positions (the
 * loss), then sixty ordinary saves that only added stickies — the pin followed
 * the rising total to n50, n60 …, the generation holding 45 card POSITIONS was
 * pruned, and the best recoverable layout was 3. That is this card's own subject
 * matter — the card layout lost on 2026-07-18 — reproduced by the code meant to
 * prevent it. The detector failed the same way: 45pos/0el → 45pos/100el →
 * 0pos/100el reported nothing, because 145 → 100 is a 31% drop.
 *
 * So: one count per dimension, ranked and compared per dimension, always.
 */
export interface Dimension {
  /** Stable key (appears in findings). */
  key: string
  /** Plain-Japanese name for the owner-facing surfaces. */
  label: string
  /** Counting unit, e.g. 「個」. */
  unit: string
}

export const DIMENSIONS: Record<ProtectedKind, readonly Dimension[]> = {
  settings: [{ key: 'projects', label: 'プロジェクトの登録', unit: '件' }],
  canvas: [
    { key: 'positions', label: 'カードの配置', unit: '個' },
    { key: 'elements', label: 'キャンバスの要素', unit: '個' },
  ],
}

/**
 * One count per {@link DIMENSIONS} entry for this kind, aligned by index. A
 * dimension is null when THAT part of the content did not parse — independently
 * of the others, so a malformed `elements` never hides a readable `positions`.
 *
 * The single definition, shared by homeBackup and homeIntegrity, so the pin and
 * the detector can never disagree about what "how much is in here" means.
 */
export const countEntriesFor = (kind: ProtectedKind, raw: string): (number | null)[] => {
  const miss = DIMENSIONS[kind].map(() => null as number | null)
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return miss
    obj = parsed as Record<string, unknown>
  } catch {
    return miss
  }
  if (kind === 'settings') {
    return [Array.isArray(obj.projects) ? obj.projects.length : null]
  }
  const positions = obj.positions
  const positionCount =
    positions !== null && typeof positions === 'object' && !Array.isArray(positions)
      ? Object.keys(positions as Record<string, unknown>).length
      : null
  return [positionCount, Array.isArray(obj.elements) ? obj.elements.length : null]
}

/** Filename form: one count per dimension, dot-separated, `x` for unknown. */
const encodeCounts = (counts: (number | null)[]): string =>
  counts.map((c) => (c === null ? 'x' : String(c))).join('.')

const decodeCounts = (encoded: string): (number | null)[] =>
  encoded.split('.').map((s) => (s === 'x' ? null : Number(s)))

export interface Generation {
  /** Absolute path of the backup file. */
  path: string
  /** Filename stamp, e.g. `20260719T120000123Z` (sorts chronologically). */
  stamp: string
  /** `YYYYMMDD` — the calendar day used by the daily policy. */
  day: string
  /** First 8 hex of the significant content's sha256. */
  hash: string
  /** One count per {@link DIMENSIONS} entry, straight from the filename (null
   *  where that part did not parse when it was written). What the pin ranks by —
   *  PER DIMENSION, never summed. */
  entryCounts: (number | null)[]
  /** Size in bytes — 0 unless listed with `{sizes: true}` (only the size cap
   *  needs it; see listGenerations). */
  bytes: number
}

/** List a kind's generations, NEWEST FIRST. Unreadable dir ⇒ empty (a missing
 *  backups dir is the normal state before the first write, not an error).
 *
 *  `sizes` is OFF by default: only the size-cap pass needs bytes, while the two
 *  hot callers (the write-time dedupe check and the age policy) need only names.
 *  Statting every generation on each of those cost ~30 syscalls per save for a
 *  number nobody read (adversarial review, 2026-07-19). */
export const listGenerations = async (
  kind: ProtectedKind,
  opts: { sizes?: boolean } = {},
): Promise<Generation[]> => {
  const dir = backupDirFor(kind)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: Generation[] = []
  for (const name of names) {
    const m = GENERATION_RE.exec(name)
    if (!m) continue
    const path = join(dir, name)
    let bytes = 0
    if (opts.sizes) {
      try {
        bytes = (await stat(path)).size
      } catch {
        continue // vanished under us (concurrent prune) — not a generation anymore
      }
    }
    out.push({
      path,
      stamp: m[1],
      day: m[1].slice(0, 8),
      hash: m[2],
      entryCounts: decodeCounts(m[3]),
      bytes,
    })
  }
  // Stamp sorts chronologically as a string by construction; ties (same
  // millisecond) fall back to the sequence counter and then the hash for a total
  // order, so "newest" is deterministic rather than readdir-order dependent.
  return out.sort(
    (a, b) => b.stamp.localeCompare(a.stamp) || b.path.localeCompare(a.path),
  )
}

/**
 * Copy a protected file's CURRENT content into its backup dir, then prune.
 * Call this BEFORE overwriting the file — the content it captures is the
 * generation about to be replaced.
 *
 * Returns the new generation's path, or null when nothing was written: an
 * unprotected path, a file that doesn't exist yet, content identical to the
 * newest generation (dedupe), or ANY failure (logged, never thrown — invariant 1).
 */
export const snapshotBeforeWrite = async (
  targetPath: string,
  opts: { now?: number } = {},
): Promise<string | null> => {
  // Inside the try: resolving the kind reads env/homedir, and invariant 1 says
  // NOTHING in this function may reject into the caller's save path.
  try {
    const kind = protectedKindOf(targetPath)
    if (!kind) return null
    let current: string
    try {
      current = await readFile(targetPath, 'utf8')
    } catch {
      return null // first-ever write: no previous generation to preserve
    }
    // An EMPTY file is the shape a torn write leaves behind. Backing it up would
    // push a real generation one slot closer to the prune line and add nothing
    // recoverable, so skip it — the useful copy is the non-empty one already there.
    if (current.trim().length === 0) return null

    // Hash the SIGNIFICANT projection, not the raw bytes — a canvas save that
    // only moved the viewport must not consume a generation slot.
    const hash = sha8(significantContent(kind, current))
    const existing = await listGenerations(kind)
    if (existing[0]?.hash === hash) return null // nothing meaningful changed

    const dir = backupDirFor(kind)
    await mkdir(dir, { recursive: true })
    // The entry count goes in the NAME so pruning can rank generations without
    // opening any of them (see the pin, and the FILE NAMING note up top).
    const n = encodeCounts(countEntriesFor(kind, current))
    const seq = (snapshotSeq++).toString(36)
    const path = join(dir, `${compactIso(opts.now ?? Date.now())}-${hash}-n${n}-${seq}.json`)
    await atomicWriteText(path, current)
    // Amortised: nothing can be over the policy until the count passes it, so
    // most writes skip the (comparatively costly) prune entirely.
    if (existing.length + 1 > KEEP_RECENT + PRUNE_SLACK || current.length > PRUNE_ALWAYS_ABOVE_BYTES) {
      await pruneBackups({ now: opts.now }).catch(() => {})
    }
    return path
  } catch (e) {
    // Invariant 1: a backup failure is a LOG, never a thrown error the caller's
    // save has to survive.
    console.error(
      `[homeBackup] snapshot of ${basename(targetPath)} failed (the save itself proceeds)`,
      e,
    )
    return null
  }
}

export interface PruneOptions {
  now?: number
  /** Overrides {@link MAX_TOTAL_BYTES}. A TEST SEAM: proving the size cap for
   *  real would mean writing 20MB of fixtures per assertion, which buys nothing
   *  the same logic at 2KB doesn't. Production never passes it. */
  maxTotalBytes?: number
  /** Overrides {@link KEEP_RECENT} — same rationale. */
  keepRecent?: number
}

export interface PruneReport {
  /** Generation files deleted, by kind. */
  removed: string[]
  /** Total bytes still held after pruning. */
  totalBytes: number
}

/**
 * Apply the retention policy. Two passes:
 *
 *   A. PER KIND, by age — keep the newest KEEP_RECENT outright; older ones keep
 *      only the newest generation of each calendar day, and only for
 *      KEEP_DAILY_DAYS days.
 *   B. GLOBALLY, by size — while the tree exceeds MAX_TOTAL_BYTES, drop the
 *      oldest remaining generation whose kind still has more than KEEP_FLOOR.
 *
 * Both passes respect KEEP_FLOOR (invariant 2).
 *
 * SERIALISED through a single-flight chain (the house pattern — see store.ts's
 * settingsChain). Two overlapping prunes used to be able to delete EVERY
 * generation: each listed the same 8 files, the first deleted down to the floor,
 * and the second — whose unlinks all failed because the files were already gone
 * — kept counting them as present, walked straight past KEEP_FLOOR and took the
 * survivors too (adversarial review 2026-07-19, measured 8 → 0). Overlap is easy
 * to reach because setCanvas is not chained, so two in-flight POST /api/canvas
 * both prune. The chain removes the overlap; the accounting fix in pass B
 * removes the underlying miscount as well, so neither alone is load-bearing.
 */
let pruneChain: Promise<unknown> = Promise.resolve()
export const pruneBackups = (opts: PruneOptions = {}): Promise<PruneReport> => {
  const run = pruneChain.then(() => pruneBackupsUnsafe(opts))
  // Keep the chain advancing even if one prune throws, so a single failure can't
  // wedge every later prune (mirrors settingsChain).
  pruneChain = run.catch(() => {})
  return run
}

const pruneBackupsUnsafe = async (opts: PruneOptions = {}): Promise<PruneReport> => {
  const now = opts.now ?? Date.now()
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES
  const keepRecent = opts.keepRecent ?? KEEP_RECENT
  const report: PruneReport = { removed: [], totalBytes: 0 }
  const kept = new Map<ProtectedKind, Generation[]>()

  // ── Pass A: per-kind age policy ────────────────────────────────────────────
  const dayFloor = compactIso(now - KEEP_DAILY_DAYS * 24 * 60 * 60 * 1000).slice(0, 8)
  const pinned = new Set<string>()
  for (const kind of PROTECTED_KINDS) {
    const gens = await listGenerations(kind) // newest first

    // THE PIN (invariant 2), ONE PER DIMENSION. For each independent quantity,
    // the generation holding the most of it is exempt from every rule below.
    //
    // Per dimension is the whole point. Ranking canvas by a positions+elements
    // SUM let a rising element count carry the pin away from the generation that
    // still held the card positions, and that generation was then pruned like
    // anything else — the exact loss this module exists to prevent, measured in
    // review 2026-07-19. Two small pinned files per kind is a trivial price.
    //
    // Self-releasing by construction: once the file grows back, a newer
    // generation holds at least as much of that dimension and the pin moves
    // there, so a legitimate shrink does not preserve stale data forever. Ties go
    // to the NEWEST such generation (gens is newest-first).
    for (let d = 0; d < DIMENSIONS[kind].length; d++) {
      let best: Generation | null = null
      for (const g of gens) {
        const c = g.entryCounts[d]
        if (c === null || c === undefined || c <= 0) continue
        if (best === null || c > (best.entryCounts[d] ?? -1)) best = g
      }
      if (best) pinned.add(best.path)
    }

    const survivors: Generation[] = []
    const seenDays = new Set<string>()
    for (let i = 0; i < gens.length; i++) {
      const g = gens[i]
      const keep =
        pinned.has(g.path) || // the richest generation — never pruned
        i < keepRecent || // always-keep window
        survivors.length < KEEP_FLOOR || // floor
        (g.day >= dayFloor && !seenDays.has(g.day)) // newest of each recent day
      if (keep) {
        survivors.push(g)
        seenDays.add(g.day)
      } else if (await tryUnlink(g.path)) {
        report.removed.push(g.path)
      } else {
        survivors.push(g) // unlink failed — it is still on disk, so still counted
      }
    }
    kept.set(kind, survivors)
  }

  // ── Pass B: global size cap, oldest first ─────────────────────────────────
  // Sizes are read HERE and nowhere else — pass A and the write-time dedupe get
  // a statless listing (see listGenerations).
  const withSizes = new Map<ProtectedKind, Generation[]>()
  for (const kind of PROTECTED_KINDS) {
    const survivorPaths = new Set((kept.get(kind) ?? []).map((g) => g.path))
    withSizes.set(
      kind,
      (await listGenerations(kind, { sizes: true })).filter((g) => survivorPaths.has(g.path)),
    )
  }
  const all = PROTECTED_KINDS.flatMap((kind) =>
    (withSizes.get(kind) ?? []).map((g) => ({ kind, g })),
  )
  let total = all.reduce((n, x) => n + x.g.bytes, 0)
  if (total > maxTotalBytes) {
    const perKind = new Map(PROTECTED_KINDS.map((k) => [k, kept.get(k)?.length ?? 0]))
    // Oldest first — ascending stamp.
    const oldestFirst = [...all].sort((a, b) => a.g.stamp.localeCompare(b.g.stamp))
    for (const { kind, g } of oldestFirst) {
      if (total <= maxTotalBytes) break
      if (pinned.has(g.path)) continue // the richest generation outranks the cap
      if ((perKind.get(kind) ?? 0) <= KEEP_FLOOR) continue // floor
      if (await tryUnlink(g.path)) report.removed.push(g.path)
      // Decrement whether or not WE were the one who removed it. A failed unlink
      // here means the file is gone (a racing prune took it) far more often than
      // it means a permission error — and counting a gone file as still present
      // is exactly what let two prunes walk past KEEP_FLOOR and empty the dir.
      // In the rarer permission case this under-counts, which only makes us stop
      // pruning EARLIER: the safe direction for a backup store.
      perKind.set(kind, (perKind.get(kind) ?? 1) - 1)
      total -= g.bytes
    }
  }
  report.totalBytes = total

  await sweepStrayTemps(now).catch(() => {})
  return report
}

const tryUnlink = async (path: string): Promise<boolean> => {
  try {
    await unlink(path)
    return true
  } catch {
    return false // racing prune already took it, or perms — either way, not ours to force
  }
}

/** Drop atomic-write temps orphaned inside OUR backup dirs by a crash. Only
 *  files older than an hour, so a snapshot in flight right now is never yanked
 *  out from under its own rename.
 *
 *  Scoped strictly to backups/<kind>/, so it never touches the home dir, where
 *  an orphaned `.settings.json.tmp-*` is a RESTORE CANDIDATE (it is what saved
 *  the registry on 2026-07-18), not litter. That scoping is enforced, not
 *  assumed: `lstat` rejects a backups/<kind> that is itself a SYMLINK, which
 *  would otherwise make readdir+unlink operate in whatever directory it points
 *  at — including the home dir, deleting exactly the rescue file this module
 *  promises to preserve. The docstring used to assert the guarantee without
 *  implementing it (nit, review 2026-07-19). */
const STRAY_TEMP_MIN_AGE_MS = 60 * 60 * 1000
const sweepStrayTemps = async (now: number): Promise<void> => {
  for (const kind of PROTECTED_KINDS) {
    const dir = backupDirFor(kind)
    let names: string[]
    try {
      // Refuse a symlinked backup dir — see the docstring. lstat does NOT follow
      // the link, so this is the check that actually confines the sweep.
      if (!(await lstat(dir)).isDirectory()) continue
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('.') || !name.includes('.tmp-')) continue
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (now - st.mtimeMs > STRAY_TEMP_MIN_AGE_MS) await unlink(path)
      } catch {
        /* skip */
      }
    }
  }
}

// ─── Restore candidates ──────────────────────────────────────────────────────

export interface RestoreCandidate {
  /** Absolute path of the file the user could restore FROM. */
  path: string
  /** Where it came from — decides how it is described to the user. */
  source: 'backup' | 'orphan-temp'
  /** Epoch ms the content is from (backup stamp / temp file mtime). */
  at: number
  /** One count per {@link DIMENSIONS} entry, never summed. */
  entryCounts: (number | null)[]
  bytes: number
}

/** "カードの配置 45 個・キャンバスの要素 0 個" — every dimension named, so a
 *  candidate can never look rich because one quantity hid another. */
export const describeCounts = (kind: ProtectedKind, counts: (number | null)[]): string =>
  DIMENSIONS[kind]
    .map((d, i) => `${d.label} ${counts[i] === null || counts[i] === undefined ? '不明' : counts[i]} ${d.unit}`)
    .join('・')

/**
 * Everything the user could restore a protected file from, BEST FIRST
 * (most entries, then most recent). Two sources:
 *
 *   - `backup`      — our own generations (the designed path).
 *   - `orphan-temp` — `~/.openground/.<file>.tmp-*` left by a crashed atomic
 *     write. Not a designed backup, but on 2026-07-18 it was the ONLY thing that
 *     saved the registry, so the recovery surface reports it rather than
 *     pretending it isn't there. sweepStrayTemps deliberately never deletes these.
 *
 * Read-only: this function only ever reads and reports. Restoring is the user's
 * explicit act, never a side effect of looking.
 */
export const listRestoreCandidates = async (
  kind: ProtectedKind,
  /** Which dimension to rank by — the one that was LOST. Ranking canvas by a
   *  summed total would put a sticky-heavy but layout-empty generation above the
   *  one that still holds the card positions, i.e. offer the owner the wrong
   *  file first. Defaults to dimension 0. */
  opts: { rankBy?: number } = {},
): Promise<RestoreCandidate[]> => {
  const rankBy = opts.rankBy ?? 0
  const out: RestoreCandidate[] = []

  // `sizes: true` — a candidate reported with bytes:0 is a lie the caller may
  // show to the owner (nit, review 2026-07-19).
  for (const g of await listGenerations(kind, { sizes: true })) {
    let raw = ''
    try {
      raw = await readFile(g.path, 'utf8')
    } catch {
      continue
    }
    out.push({
      path: g.path,
      source: 'backup',
      at: Date.parse(
        `${g.stamp.slice(0, 4)}-${g.stamp.slice(4, 6)}-${g.stamp.slice(6, 8)}T` +
          `${g.stamp.slice(9, 11)}:${g.stamp.slice(11, 13)}:${g.stamp.slice(13, 15)}.${g.stamp.slice(15, 18)}Z`,
      ),
      entryCounts: countEntriesFor(kind, raw),
      bytes: g.bytes,
    })
  }

  // Orphaned atomic-write temps sit NEXT TO the live file, named
  // `.<basename>.tmp-<pid>-<seq>` (see atomicWrite.ts).
  // `basename`, NOT split('/'): on Windows join() emits backslashes, so the
  // split returned the WHOLE PATH and the prefix could never match a readdir
  // entry — silently never offering the orphaned temp, which is the one thing
  // that saved the registry on 2026-07-18 (adversarial review, 2026-07-19).
  const tempPrefix = `.${basename(liveFileFor(kind))}.tmp-`
  try {
    for (const name of await readdir(openGroundHome())) {
      if (!name.startsWith(tempPrefix)) continue
      const path = join(openGroundHome(), name)
      try {
        const st = await stat(path)
        if (!st.isFile()) continue
        out.push({
          path,
          source: 'orphan-temp',
          at: st.mtimeMs,
          entryCounts: countEntriesFor(kind, await readFile(path, 'utf8')),
          bytes: st.size,
        })
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no home dir listing — backups alone still stand */
  }

  // Best first: the candidate with the MOST entries is the most likely rescue
  // (the 2026-07-18 case was exactly "find the copy that still has 45"), then
  // most recent. Nulls (unparseable) sort last — they may not be restorable.
  return out.sort(
    (a, b) => (b.entryCounts[rankBy] ?? -1) - (a.entryCounts[rankBy] ?? -1) || b.at - a.at,
  )
}

/**
 * The most any surviving generation holds, PER DIMENSION — "how much did this
 * file ever have?", answered from filenames alone (no reads).
 *
 * This is what lets the damage check see a loss that happened entirely BETWEEN
 * boots. Its watermark is only written at startup, so on a long-running Electron
 * session the sequence "fresh install (0 projects) → owner imports 45 → something
 * wipes it to 3" left both bars blind: the last RECORDED count was 0, so nothing
 * looked like a drop (review, 2026-07-19). The backups, though, were written
 * throughout that session and remember the 45.
 *
 * `sinceStamp` EXCLUDES generations at or before a moment — pass the last alert's
 * time. Without it this became a nagging machine: the pin keeps the pre-damage
 * generation alive forever BY DESIGN, so re-deriving the peak from all
 * generations resurrected "45" on every single boot, and every project the owner
 * restored by hand produced a new signature that slipped the dedupe and rang a
 * fresh alarm (45→4, 45→5, 45→6 … measured in review). Once a loss has been
 * reported, only what happened AFTER that report can constitute a new one.
 *
 * A dimension with nothing to go on is 0, which the caller reads as "no
 * baseline" rather than "the file was empty".
 */
export const highWaterFromGenerations = async (
  kind: ProtectedKind,
  opts: { sinceStamp?: string } = {},
): Promise<number[]> => {
  const gens = (await listGenerations(kind).catch(() => [])).filter(
    (g) => !opts.sinceStamp || g.stamp > opts.sinceStamp,
  )
  return DIMENSIONS[kind].map((_, d) =>
    gens.reduce((max, g) => Math.max(max, g.entryCounts[d] ?? 0), 0),
  )
}

/** Epoch ms → the filename stamp form, so callers can compare against a
 *  generation's `stamp` without re-deriving the encoding. */
export const stampFor = (ms: number): string => compactIso(ms)
