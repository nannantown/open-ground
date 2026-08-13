// swarmLandedLedger — the DURABLE record of swarm work that landed (着地台帳).
//
// WHY IT EXISTS (2026-08-12). The KPI panel's "landed" count is paired from the
// engine journal's `promote` lines against done Board cards (countLandedFromBoard)
// — but the journal is a 200-line in-memory ring that dies on every restart, so
// the one number that answers「この swarm は意味があるか」(outward landed work
// per week) could never be charted over time: every release restart zeroed it.
// This module gives that pairing a disk life of its own:
//
//   ~/.openground/projects/<uuid>/swarm-landed.json
//   { version: 1, entries: [{ taskId, title, branch?, promotedAt, landedAt? }] }
//
// One entry per card the ENGINE carried into review (both moveToReview sites:
// the normal promote and the ready-worker recovery promote). `landedAt` is
// stamped by the sweep when the Board later shows that card done — the same
// "outcome, not who pressed merge" semantic the 2026-08-04 KPI repair
// established: hand-made work (done but never engine-promoted) is not counted,
// and a promoted card only counts once it actually lands.
//
// TIMESTAMP HONESTY: ProjectTask carries no updatedAt, so `landedAt` is the
// SWEEP's detection time, not the human's merge moment. While the engine runs
// (which it must for promotes to happen at all) detection lags the merge by at
// most a pass (~3s); across an engine stop / restart the lag is the gap itself.
// Weekly buckets tolerate that; per-minute analytics must not be built on this.
//
// WRITE REGIME (mirrors swarmEnginePersistence): single writer — both writers
// run inside the engine's dispatch pass (runExclusive per project), the API
// route only reads. atomicWriteJson (tmp→rename). A write fault is FAIL-OPEN
// (never throws into the pass; the promote/land it records already happened),
// a read fault is FAIL-QUIET-TO-EMPTY (missing/corrupt/unregistered project ⇒
// []). The ledger is analytics, never a decision input — nothing in the engine
// reads it back to choose behaviour, so degraded = a dimmer chart, never a
// wrong dispatch.
//
// SELF vs EXTERNAL (外向き判定): the aggregate KPI splits landed work into
// 「OG 自身への着地」 and 「それ以外(外向き)」. A project is SELF when its
// package.json `name` equals the name THIS server was built from (inlined at
// build time, same pattern as the health route's APP_VERSION) — deterministic,
// checkout-independent (two OG clones both classify self, which is the right
// semantic: work on OG is work on OG), and it degrades to `external` when the
// project has no readable package.json. Never a path heuristic.

import { readFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { projectDataFile } from './projectDataPath'
// Inlined at build time (resolveJsonModule / esbuild) — cwd-independent, same
// pattern the health route uses for APP_VERSION.
import { name as APP_PACKAGE_NAME } from '../../../package.json'
import type { ProjectTask } from '../types'

// ─── Shape ────────────────────────────────────────────────────────────────────

export interface LandedLedgerEntry {
  /** Full Board card id (the 掟-1 full-UUID key — never shortened). */
  taskId: string
  /** Card title at promote time (display only — refreshed on re-promote). */
  title: string
  /** The worker branch the promote recorded (display/debug only). */
  branch?: string
  /** When the ENGINE first carried this card into review (ISO). Kept across a
   *  差し戻し re-promote — the first delivery attempt, not the last. */
  promotedAt: string
  /** When the sweep first saw the Board show this card done (ISO). Set once,
   *  never cleared — a card reopened and landed again stays one land. */
  landedAt?: string
}

interface LedgerFileShape {
  version: 1
  entries: LandedLedgerEntry[]
}

const LEDGER_BASENAME = 'swarm-landed.json'

const ledgerFile = (projectPath: string): Promise<string> =>
  projectDataFile(projectPath, LEDGER_BASENAME)

/** Strict-enough entry filter: a hand-edited / partially-written file degrades
 *  to the entries that still parse, never to a throw. */
const isEntry = (e: unknown): e is LandedLedgerEntry => {
  if (typeof e !== 'object' || e === null) return false
  const r = e as Record<string, unknown>
  return (
    typeof r.taskId === 'string' &&
    r.taskId.length > 0 &&
    typeof r.title === 'string' &&
    typeof r.promotedAt === 'string' &&
    (r.branch === undefined || typeof r.branch === 'string') &&
    (r.landedAt === undefined || typeof r.landedAt === 'string')
  )
}

// ─── Read / write ─────────────────────────────────────────────────────────────

/** Read a project's landed ledger. FAIL-QUIET-TO-EMPTY: missing file, corrupt
 *  JSON, wrong shape, or an unregistered/vanished project path all resolve to
 *  [] — analytics must never throw into a caller. Never throws. */
export const readLandedLedger = async (projectPath: string): Promise<LandedLedgerEntry[]> => {
  try {
    const raw = await readFile(await ledgerFile(projectPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LedgerFileShape>
    if (!Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(isEntry)
  } catch {
    return []
  }
}

/** Write the whole ledger back (atomicWriteJson: tmp→rename). Returns false on
 *  any failure — FAIL-OPEN, the caller keeps running. */
const writeLandedLedger = async (
  projectPath: string,
  entries: LandedLedgerEntry[],
): Promise<boolean> => {
  try {
    const file = await ledgerFile(projectPath)
    // The central data dir may not exist yet on a project that never stored
    // tasks/canvases — atomicWriteJson's tmp file needs the dir to be there.
    await mkdir(dirname(file), { recursive: true })
    await atomicWriteJson(file, { version: 1, entries } satisfies LedgerFileShape)
    return true
  } catch {
    return false
  }
}

// ─── The two writers (both called from inside the engine's dispatch pass) ────

/** Record「エンジンがこのカードを review へ運んだ」— called at BOTH moveToReview
 *  sites (the normal promote and the ready-worker recovery). Idempotent per
 *  taskId: a 差し戻し re-promote refreshes title/branch but keeps the first
 *  promotedAt and any landedAt. Never throws (fail-open). */
export const recordPromoted = async (
  projectPath: string,
  sign: { taskId: string; title: string; branch?: string },
  nowIso: string = new Date().toISOString(),
): Promise<void> => {
  try {
    if (!sign.taskId) return
    const entries = await readLandedLedger(projectPath)
    const existing = entries.find((e) => e.taskId === sign.taskId)
    if (existing) {
      existing.title = sign.title
      if (sign.branch) existing.branch = sign.branch
    } else {
      entries.push({
        taskId: sign.taskId,
        title: sign.title,
        ...(sign.branch ? { branch: sign.branch } : {}),
        promotedAt: nowIso,
      })
    }
    await writeLandedLedger(projectPath, entries)
  } catch {
    /* fail-open — the promote already happened; a lost analytics row must not disturb the pass */
  }
}

/** Same column fold as the orchestrator's isDoneCard (undefined boardColumn →
 *  'done' iff the card's `done` flag is set) — restated here, NOT imported, so
 *  the ledger never creates an import cycle with swarmOrchestrator. */
const isDoneCard = (t: Pick<ProjectTask, 'done' | 'boardColumn'>): boolean =>
  (t.boardColumn ?? (t.done ? 'done' : 'todo')) === 'done'

/** Stamp `landedAt` on every promoted entry whose card the Board now shows
 *  done. Called once per dispatch pass with the pass's own fresh task list —
 *  costs one small readFile when nothing is pending, one write only when a new
 *  land is found. Returns how many entries were newly stamped. Never throws. */
export const sweepLanded = async (
  projectPath: string,
  tasks: readonly Pick<ProjectTask, 'id' | 'done' | 'boardColumn'>[],
  nowIso: string = new Date().toISOString(),
): Promise<number> => {
  try {
    const entries = await readLandedLedger(projectPath)
    if (entries.length === 0) return 0
    const pending = entries.filter((e) => !e.landedAt)
    if (pending.length === 0) return 0
    const doneIds = new Set(tasks.filter(isDoneCard).map((t) => t.id))
    let stamped = 0
    for (const e of pending) {
      if (doneIds.has(e.taskId)) {
        e.landedAt = nowIso
        stamped++
      }
    }
    if (stamped > 0) await writeLandedLedger(projectPath, entries)
    return stamped
  } catch {
    return 0
  }
}

// ─── Pure aggregation helpers (unit-tested without IO) ────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** The Monday-start UTC week containing `ms`, as 'YYYY-MM-DD'. UTC on purpose:
 *  no DST edges, and every machine buckets a given land into the same week. */
export const utcWeekStart = (ms: number): string => {
  const d = new Date(ms)
  const sinceMonday = (d.getUTCDay() + 6) % 7
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday)
  return new Date(monday).toISOString().slice(0, 10)
}

export interface LandedWeekCount {
  /** Monday of the bucket's week, 'YYYY-MM-DD' (UTC). */
  weekStart: string
  landed: number
}

/** The last `weeks` weekly buckets (oldest→newest, FIXED length — empty weeks
 *  are zero, so a chart never silently compresses a dry spell away). Entries
 *  without landedAt / with unparseable landedAt / outside the window are
 *  ignored. Pure (`now` injected). */
export const weeklyLandedSeries = (
  entries: readonly LandedLedgerEntry[],
  opts: { weeks: number; now?: number },
): LandedWeekCount[] => {
  const now = opts.now ?? Date.now()
  const weeks = Math.max(1, Math.floor(opts.weeks))
  const currentStartMs = Date.parse(`${utcWeekStart(now)}T00:00:00Z`)
  const starts: string[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    starts.push(new Date(currentStartMs - i * WEEK_MS).toISOString().slice(0, 10))
  }
  const counts = new Map<string, number>(starts.map((s) => [s, 0]))
  for (const e of entries) {
    if (!e.landedAt) continue
    const t = Date.parse(e.landedAt)
    if (!Number.isFinite(t)) continue
    const ws = utcWeekStart(t)
    const c = counts.get(ws)
    if (c !== undefined) counts.set(ws, c + 1)
  }
  return starts.map((s) => ({ weekStart: s, landed: counts.get(s) ?? 0 }))
}

/** 「このプロジェクトは OG 自身か」— package.json `name` equality against the
 *  name this server was BUILT from. Checkout-independent (any OG clone is
 *  self); no readable package.json / no match ⇒ false (counts as 外向き —
 *  documented degradation, never a throw). */
export const isSelfProject = async (projectPath: string): Promise<boolean> => {
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name === APP_PACKAGE_NAME
  } catch {
    return false
  }
}
