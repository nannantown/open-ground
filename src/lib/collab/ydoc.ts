import * as Y from 'yjs'

// ── Shared Y.Doc helpers — FLAT-MAP encoding ─────────────────────────────────
//
// CRITICAL design note (learned the hard way; see docs/COLLAB_PLAN.md):
// OPEN GROUND's collab is "client-driven" — each client builds its Y.Doc from
// its OWN local disk and they converge over the wire. With Yjs, two docs only
// converge cleanly when they share key/op identity. NESTED Y types (a Y.Map per
// card) and SEQUENCES (Y.Array order, Y.Text notes) do NOT: independently
// constructed they duplicate / one whole side is dropped by LWW.
//
// So we store EVERYTHING as flat keys on a SINGLE Y.Map per scope:
//   t:<id>:<field>  one key per card/element field   (per-field LWW — different
//                   fields of the same card both survive; same field = LWW)
//   m:order         the id order, as ONE JSON value  (whole-array LWW)
//   m:notes         board notes, as ONE string       (whole-string LWW)
//   m:description / m:config / ...   board/canvas meta (LWW)
// Flat string keys converge under independent construction (Y.Map merges by key
// with LWW on conflicts), which is exactly what the architecture needs.

/** Origin tag for authoritative seed/disk-apply transactions. The client
 *  binding filters it out of its LOCAL onRemote callback so a seed isn't treated
 *  as a peer change. (Seed updates ARE still broadcast — that is how a local
 *  edit reaches peers.) */
export const ORIGIN_SEED = Symbol('og-collab-seed')

type Json = unknown

const stableStringify = (v: Json): string => {
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const obj = v as Record<string, Json>
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  )
}

/** Order-independent structural equality, so re-applying unchanged data writes
 *  zero keys (the basis of the "mirror every local persist" loop-safety). */
export const jsonEqual = (a: Json, b: Json): boolean => {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return stableStringify(a) === stableStringify(b)
}

const cloneValue = (v: Json): Json =>
  v !== null && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as Json) : v

/** Set or delete one flat key (undefined → delete; object/array → whole JSON;
 *  no-op when unchanged). */
export const setKey = (map: Y.Map<unknown>, key: string, value: Json): void => {
  if (value === undefined) {
    if (map.has(key)) map.delete(key)
    return
  }
  const next = cloneValue(value)
  if (!jsonEqual(map.get(key), next)) map.set(key, next)
}

const fieldKey = (prefix: string, id: string, field: string): string => `${prefix}${id}:${field}`

/** Make the `prefix`-namespaced flat keys mirror `items` exactly: one key per
 *  defined field, stale keys (removed items / removed fields) deleted. O(keys +
 *  items*fields); only changed keys are written. */
export const reconcileCollectionFlat = <T extends { id: string }>(
  map: Y.Map<unknown>,
  prefix: string,
  items: T[],
): void => {
  const desired = new Map<string, Json>()
  for (const item of items) {
    // ids are UUIDs (no ':'); anything else can't be flat-key encoded safely.
    if (typeof item.id !== 'string' || item.id.includes(':')) {
      console.warn('[og:collab] skipping item with unencodable id', item.id)
      continue
    }
    const obj = item as unknown as Record<string, Json>
    for (const k of Object.keys(obj)) {
      // `id` IS the key namespace — never store it as a field (avoids a
      // duplicate source of truth). Skip a field name containing ':' (it would
      // corrupt the id/field split on read) and undefined values.
      if (k === 'id' || k.includes(':') || obj[k] === undefined) continue
      desired.set(fieldKey(prefix, item.id, k), obj[k])
    }
  }
  for (const key of Array.from(map.keys())) {
    if (key.startsWith(prefix) && !desired.has(key)) map.delete(key)
  }
  for (const [k, v] of Array.from(desired)) setKey(map, k, v)
}

/** Read the `prefix`-namespaced keys back into ordered plain objects. Order
 *  follows the `order` id-list (LWW); ids present in the map but missing from
 *  the order are appended (e.g. a peer added a card and the order delta hasn't
 *  landed yet). */
export const readCollectionFlat = (
  map: Y.Map<unknown>,
  prefix: string,
  order: string[],
): Record<string, Json>[] => {
  const byId = new Map<string, Record<string, Json>>()
  for (const [key, v] of Array.from(map.entries())) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    const sep = rest.indexOf(':')
    if (sep < 0) continue
    const id = rest.slice(0, sep)
    const field = rest.slice(sep + 1)
    let o = byId.get(id)
    if (!o) {
      o = { id } // id comes from the key namespace, not a stored field
      byId.set(id, o)
    }
    o[field] = v
  }
  const out: Record<string, Json>[] = []
  const seen = new Set<string>()
  for (const id of Array.isArray(order) ? order : []) {
    const o = byId.get(id)
    if (o) {
      out.push(o)
      seen.add(id)
    }
  }
  // Ids present in the map but missing from `order` (an order delta hasn't
  // landed yet) are appended in a DETERMINISTIC order (by id) so converged peers
  // agree on ordering even before the order key catches up.
  const remainder = Array.from(byId.keys())
    .filter((id) => !seen.has(id))
    .sort()
  for (const id of remainder) out.push(byId.get(id)!)
  return out
}
