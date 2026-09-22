// swarmDeskLedger — which Claude sessions were RESIDENT DESKS (the commander /
// the supply officer), so the 7-day usage breakdown can attribute their tokens
// to the desk instead of to "your projects" (owner card 5a11ac62, 2026-09-22).
//
// Why a ledger and not the sessions file: swarmSessions.ts keeps ONE current
// session id per role per project — enough to resume, useless for attribution
// once a desk has been recycled (the context cap recycles the commander on
// purpose) or a project has run several supply desks in a week. A desk's
// transcript sits in the project's own ~/.claude/projects/<dir>/, exactly where
// the owner's own sessions sit, so the directory cannot tell them apart; only
// "this session id was launched as a desk" can. That fact is recorded here at
// every desk launch (fresh or resumed — re-recording an id is a no-op).
//
// HONESTY CONTRACT. Attribution is exact for sessions the ledger names and
// silent for the rest: a project-dir session it does not name stays 'project',
// which the UI labels as "you, or a desk from before the ledger". Nothing here
// back-fills history, guesses from cwd, or promotes a match to "personal".
//
// Storage: ONE file for the whole home (~/.openground/swarm-desks.json) —
// the breakdown reads across every project, so it wants one read, not one per
// project. Append-only with a cap; fail-quiet like every analytics store
// (a failed write must never keep a desk from launching).

import { readFile } from 'fs/promises'
import { join } from 'path'
import { openGroundHome } from './paths'
import { atomicWriteJson } from './atomicWrite'

export type DeskRole = 'manager' | 'supply'

export interface DeskLedgerEntry {
  role: DeskRole
  sessionId: string
  /** The project the desk served (canonical path) — display / audit only. */
  projectPath: string
  /** ISO timestamp of the FIRST time this session id was recorded. */
  at: string
}

export interface DeskLedgerFile {
  entries: DeskLedgerEntry[]
}

/** Newest entries kept; the breakdown looks back 7 days and a desk lives for
 *  hours, so this is months of history at any realistic launch rate. */
export const DESK_LEDGER_CAP = 2000

export const DESK_LEDGER_FILE = 'swarm-desks.json'

export const deskLedgerPath = (): string => join(openGroundHome(), DESK_LEDGER_FILE)

const isRole = (v: unknown): v is DeskRole => v === 'manager' || v === 'supply'

/** Parse defensively: a hand-corrupted file reads as empty, never throws. */
export const parseDeskLedger = (raw: string): DeskLedgerFile => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { entries: [] }
    const list = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(list)) return { entries: [] }
    const entries: DeskLedgerEntry[] = []
    for (const e of list) {
      if (!e || typeof e !== 'object') continue
      const o = e as Record<string, unknown>
      if (!isRole(o.role) || typeof o.sessionId !== 'string' || !o.sessionId) continue
      entries.push({
        role: o.role,
        sessionId: o.sessionId,
        projectPath: typeof o.projectPath === 'string' ? o.projectPath : '',
        at: typeof o.at === 'string' ? o.at : '',
      })
    }
    return { entries }
  } catch {
    return { entries: [] }
  }
}

export const readDeskLedger = async (path = deskLedgerPath()): Promise<DeskLedgerFile> => {
  try {
    return parseDeskLedger(await readFile(path, 'utf8'))
  } catch {
    return { entries: [] } // no ledger yet — nothing attributed, nothing invented
  }
}

/** The map the usage breakdown consumes: session id → desk role. */
export const readDeskSessionMap = async (path = deskLedgerPath()): Promise<Map<string, DeskRole>> => {
  const { entries } = await readDeskLedger(path)
  const map = new Map<string, DeskRole>()
  for (const e of entries) map.set(e.sessionId, e.role)
  return map
}

/** Pure: the ledger after recording `entry`. Idempotent on session id (a
 *  resumed desk re-records the same id every launch); capped to the newest. */
export const appendDeskEntry = (
  ledger: DeskLedgerFile,
  entry: DeskLedgerEntry,
  cap = DESK_LEDGER_CAP,
): DeskLedgerFile => {
  if (ledger.entries.some((e) => e.sessionId === entry.sessionId)) return ledger
  const entries = [...ledger.entries, entry]
  return { entries: entries.length > cap ? entries.slice(entries.length - cap) : entries }
}

/**
 * Record "this session id is a `role` desk for `projectPath`". Called from
 * recordSwarmSession (the one seam every desk launch passes through). Returns
 * false on any failure — the launch must never wait on, or fail for, analytics.
 */
export const recordDeskSession = async (
  role: DeskRole,
  sessionId: string,
  projectPath: string,
  opts: { path?: string; now?: Date } = {},
): Promise<boolean> => {
  if (!sessionId.trim()) return false
  const path = opts.path ?? deskLedgerPath()
  try {
    const current = await readDeskLedger(path)
    const next = appendDeskEntry(current, {
      role,
      sessionId,
      projectPath,
      at: (opts.now ?? new Date()).toISOString(),
    })
    if (next === current) return true // already known — nothing to write
    await atomicWriteJson(path, next)
    return true
  } catch {
    return false
  }
}
