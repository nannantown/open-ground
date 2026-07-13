// swarmQuotaStore — the PERSISTENCE seam under swarmQuota's cooling table.
//
// WHY THIS EXISTS. The cooling table (tier → reset epoch ms) used to live only on
// globalThis, so every process death forgot it — and the app is restarted after
// every release. The observed cost (2026-07-13, 0.11.25): fable had been dry
// since the previous day, but a freshly-booted app reported `cooling:false` /
// `launchTier:"fable"`, dispatched a worker into the wall, ate the limit screen,
// and only THEN called markRateLimited. One session burned per restart, forever,
// to re-learn a fact the app already knew yesterday. This module is the disk half
// that closes that loop: swarmQuota mirrors every mutation here, and hydrates
// from here at boot.
//
// DESIGN — three properties, in priority order:
//
//   • FAIL-SAFE, never fail-closed. Every read degrades to "no cooling" and lets
//     the app boot: an unreadable / corrupt / hand-edited file must never wedge
//     startup. The worst case of a lost mark is exactly TODAY'S behaviour (one
//     burned session); the worst case of a throw here is a cockpit that won't
//     start. So the read swallows, logs ONE line, and returns {}. Note this is
//     the OPPOSITE of swarmEscalations' strict readForWrite — and deliberately:
//     that inbox accumulates irreplaceable records, so a tolerant read there
//     would let the next write clobber them. Here the IN-MEMORY table is the
//     authority and every write serialises it WHOLE (never disk-merge-disk), so a
//     tolerant read cannot lose data that a strict one would have saved.
//
//   • ONE-WAY DEPS (no cycle). Imports only paths + atomicWrite + types — all
//     leaves. It must NOT import swarmQuota (which imports THIS), so the tier
//     guard is re-derived from the shared SWARM_MODEL_TIERS ladder rather than
//     borrowing swarmQuota.isModelTier. It must NOT import store.ts either:
//     store → swarmAllowedModels → swarmQuota → here, so that would close a
//     cycle. Hence a dedicated file rather than a settings.json field (see
//     paths.swarmQuotaFile for the full rationale).
//
//   • VERBATIM MIRROR, expiry on READ. The file is written exactly as the table
//     stands; elapsed marks are dropped when they are LOADED, not when they are
//     saved. That keeps the write path clock-free (markCoolingUntil / clearCooling
//     have no `now` to inject) and gives the persisted table the SAME lazy-expiry
//     semantics as the live one (swarmQuota.isTierCooling). Growth is bounded by
//     construction: the table is keyed by the 4-rung ladder, so the file holds at
//     most 4 numbers.

import { readFile } from 'fs/promises'
import { ensureOpenGroundHome, swarmQuotaFile } from './paths'
import { atomicWriteJson } from './atomicWrite'
import { SWARM_MODEL_TIERS, type SwarmModelTier } from '../types'

/** The persisted cooling table: tier → reset epoch ms. Partial — an absent tier
 *  simply has no mark (= available), which is also the whole-file fallback. */
export type CoolingMarks = Partial<Record<SwarmModelTier, number>>

/** On-disk shape. A wrapper object (not a bare map) so the file can grow a
 *  sibling key later without breaking readers — same discipline as
 *  escalations.json's `{items}`. */
interface QuotaFileShape {
  cooling: CoolingMarks
}

/** The engine log line for a quota-persistence fault. Everything here is
 *  advisory state, so a fault is a WARNING that the app continues past — never a
 *  throw. One line, one prefix, greppable. */
const warn = (msg: string, e?: unknown): void => {
  const detail = e instanceof Error ? e.message : e != null ? String(e) : ''
  console.warn(`[openground:swarm-quota] ${msg}${detail ? `: ${detail}` : ''}`)
}

/** Narrow an untrusted key to a ladder tier. Re-derived from the shared
 *  SWARM_MODEL_TIERS rather than imported from swarmQuota — see the header's
 *  one-way-deps note. Unknown aliases in the file (a newer build's tier after a
 *  self-update rollback, a hand-edited typo) are DROPPED, never cooled by guess:
 *  the same fail-closed rule the /cool route applies to a request body. */
const isTierKey = (v: string): v is SwarmModelTier =>
  (SWARM_MODEL_TIERS as readonly string[]).includes(v)

/** Load the persisted cooling marks. NEVER throws and NEVER returns garbage:
 *    • no file (first boot / never cooled) ⇒ {} silently — the normal case.
 *    • unreadable (EACCES/EIO) or unparseable / wrong shape ⇒ {} + ONE log line.
 *    • per-entry garbage (unknown tier, non-finite `until`) ⇒ that ENTRY is
 *      dropped; the sound entries still load.
 *  Elapsed marks are NOT filtered here — that is the caller's `now`-injected job
 *  (swarmQuota.hydrateCoolingTable), keeping this module clock-free. */
export const loadCoolingMarks = async (): Promise<CoolingMarks> => {
  await ensureOpenGroundHome()
  const file = swarmQuotaFile()

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    // ENOENT is the ordinary "nothing has ever cooled" state — not a fault, so
    // it must not log (a warning on every fresh install would be pure noise).
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      warn('cooling table unreadable — starting with NO cooling', e)
    }
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    const cooling = (parsed as Partial<QuotaFileShape> | null)?.cooling
    if (cooling === null || typeof cooling !== 'object' || Array.isArray(cooling)) {
      throw new Error('expected {"cooling": {tier: untilMs}}')
    }
    const out: CoolingMarks = {}
    for (const [tier, until] of Object.entries(cooling as Record<string, unknown>)) {
      if (!isTierKey(tier)) continue
      if (typeof until !== 'number' || !Number.isFinite(until)) continue
      out[tier] = until
    }
    return out
  } catch (e) {
    // A corrupt file is left ON DISK, untouched: the next mutation overwrites it
    // atomically anyway, and moving it aside (as escalations does) buys nothing
    // for a table whose every value is re-learnable. Boot continues cold.
    warn('cooling table corrupt — starting with NO cooling', e)
    return {}
  }
}

/** Persist the cooling marks, replacing the file WHOLE. Callers hand in the full
 *  in-memory table (the authority), so there is no read-modify-write here and
 *  therefore no lost-update race between two savers.
 *
 *  `fsync` — the file exists precisely to survive a process ending. Atomicity
 *  alone already covers a crash/force-quit (the page cache outlives the process),
 *  so fsync only buys the power-cut / kernel-panic case; on a laptop app that IS
 *  a real event, the file is ~100 bytes, and writes are rare (a handful a day, on
 *  a rate-limit sighting or an owner's manual cool). Cheap insurance for the one
 *  promise this module makes. Throws on write failure — the caller decides (and
 *  swarmQuota's persist chain logs and carries on, keeping marks in memory). */
export const saveCoolingMarks = async (cooling: CoolingMarks): Promise<void> => {
  await ensureOpenGroundHome()
  await atomicWriteJson(swarmQuotaFile(), { cooling } satisfies QuotaFileShape, { fsync: true })
}
