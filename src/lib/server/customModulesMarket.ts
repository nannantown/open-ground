// customModulesMarket.ts — Supabase glue for publishing / listing / installing
// custom tab modules (docs/CUSTOM_TABS_PLAN.md).
//
// Same posture as the feedback proxy (server/routes/feedback.ts): the server is
// the only thing that talks to Supabase, so no key ever lands in the client
// bundle. Two key tiers:
//   - publish  → SUPABASE_SERVICE_ROLE_KEY (owner's machine only; the table's
//     RLS allows anon SELECT but never anon writes)
//   - list / install → SUPABASE_ANON_KEY (read-only under RLS)
// Table: env SUPABASE_MODULES_TABLE, default 'og_custom_modules'.
//
// GRACEFUL DEGRADE: missing env → the config readers return null and the route
// answers 503 (never a crash, never a hardcoded secret). Env is read lazily per
// request (the feedback readConfig pattern) so tests can vi.stubEnv per case.

import { createHash } from 'crypto'

import type { CustomModuleDef, CustomModuleFramework, MarketplaceModule } from '../types'

export interface ModulesMarketConfig {
  url: string
  key: string
  table: string
}

// SUPABASE_URL + the chosen key env + optional table. Null unless BOTH url and
// key are present — the route's 503 trigger.
const readConfig = (
  keyEnv: 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY',
): ModulesMarketConfig | null => {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env[keyEnv]?.trim()
  if (!url || !key) return null
  const table = process.env.SUPABASE_MODULES_TABLE?.trim() || 'og_custom_modules'
  return { url: url.replace(/\/+$/, ''), key, table }
}

// Write path (publish): the service-role key, owner machine only.
export const readPublishConfig = () => readConfig('SUPABASE_SERVICE_ROLE_KEY')

// Read path (marketplace list / install): the anon key (RLS = select only).
export const readMarketConfig = () => readConfig('SUPABASE_ANON_KEY')

// One PostgREST call with this feature's auth + a 10s timeout (mirrors the
// feedback supabaseFetch so headers/timeout can't drift).
const supabaseFetch = (
  config: ModulesMarketConfig,
  path: string,
  init: RequestInit = {},
) =>
  fetch(`${config.url}/rest/v1/${config.table}${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(10_000),
  })

// Raised on a non-ok Supabase response. The route logs the detail server-side
// and returns a generic 502 — url/key context never leaks to the client.
export class MarketError extends Error {
  constructor(
    public readonly label: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`marketplace ${label}: supabase responded ${status}`)
  }
}

const ensureOk = async (res: Response, label: string): Promise<Response> => {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new MarketError(label, res.status, detail)
  }
  return res
}

// The PostgREST row shape (subset we read back).
interface ModuleRow {
  id: string
  name: string
  description: string
  framework: string
  source?: string
  version: number
  published_at: string
}

const toFramework = (raw: string): CustomModuleFramework => (raw === 'html' ? 'html' : 'react')

const toMarketplaceModule = (row: ModuleRow): MarketplaceModule => ({
  remoteId: row.id,
  name: row.name,
  description: row.description,
  framework: toFramework(row.framework),
  version: row.version,
  publishedAt: row.published_at,
})

// --- publish (service-role key) ----------------------------------------------

export interface PublishResult {
  remoteId: string
  version: number
  publishedAt: string
}

// --- deterministic publish ids (approve idempotency) --------------------------
//
// The approve route must be able to re-run publish after a crash/retry without
// inserting a second marketplace row, which needs a stable row id it can derive
// again. The submission id itself must NEVER be that id: a submitter holding
// the anon key can INSERT a queue row with an id of their choosing, so using it
// verbatim would let them aim the publish at an EXISTING og_custom_modules row
// and (with an upsert) overwrite a module that isn't theirs.
//
// So the id is derived server-side: sha256(namespace ‖ submissionId), laid out
// as a UUID. The submitter still influences the input, but cannot steer the
// output onto a chosen target row — that would take a preimage of a specific
// 128-bit digest. Paired with publishModule's INSERT-only path (no UPDATE when
// rowId is set), an approve can never modify a marketplace row it didn't create.
const PUBLISH_ID_NAMESPACE = 'openground:module-submission:v1:'

export const marketplaceRowIdForSubmission = (submissionId: string): string => {
  const digest = createHash('sha256')
    .update(PUBLISH_ID_NAMESPACE)
    .update(submissionId)
    .digest()
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80 // RFC 9562 version 8 (custom)
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 9562 variant
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

// Read back a row we lost the INSERT race for (409). Selects no source — the
// caller only needs the publish coordinates.
const readPublishedRow = async (
  config: ModulesMarketConfig,
  rowId: string,
): Promise<PublishResult> => {
  const res = await supabaseFetch(
    config,
    `?id=eq.${encodeURIComponent(rowId)}&select=id,version,published_at&limit=1`,
  )
  await ensureOk(res, 'publish-replay')
  const rows = (await res.json()) as unknown
  const row = Array.isArray(rows) ? (rows as ModuleRow[])[0] : undefined
  if (!row?.id) throw new MarketError('publish-replay', 502, 'conflicting row vanished')
  return { remoteId: row.id, version: row.version ?? 1, publishedAt: row.published_at }
}

// First publish: INSERT (Prefer: return=representation so we get the row id
// back). Re-publish: UPDATE the existing row by remoteId, version+1. Throws
// MarketError / fetch errors for the route to translate into a 502.
//
// opts.rowId (approve passes marketplaceRowIdForSubmission(sub.id)) makes the
// INSERT "publish exactly once": the row carries that explicit primary key, so
// a replayed publish — a double-click, or a retry after the INSERT landed but
// the follow-up markSubmission failed — hits the PK and comes back 409, which
// we resolve by READING the existing row. There is deliberately no upsert: an
// approve never UPDATEs a marketplace row, so it cannot clobber one.
// Callers without a rowId keep the plain generated-id INSERT.
export const publishModule = async (
  config: ModulesMarketConfig,
  def: CustomModuleDef,
  source: string,
  opts: { rowId?: string } = {},
): Promise<PublishResult> => {
  if (def.remoteId) {
    const nextVersion = (def.version ?? 1) + 1
    const res = await supabaseFetch(config, `?id=eq.${encodeURIComponent(def.remoteId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        name: def.label,
        description: def.description,
        framework: def.framework,
        source,
        version: nextVersion,
        updated_at: new Date().toISOString(),
      }),
    })
    await ensureOk(res, 'update')
    const rows = (await res.json().catch(() => [])) as ModuleRow[]
    // A PATCH matching zero rows (row deleted remotely) is a silent no-op in
    // PostgREST — fall back to a fresh INSERT so publish always lands.
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0]
      return { remoteId: row.id, version: row.version, publishedAt: row.published_at }
    }
  }
  const res = await supabaseFetch(config, '', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      ...(opts.rowId ? { id: opts.rowId } : {}),
      name: def.label,
      description: def.description,
      framework: def.framework,
      source,
      version: 1,
    }),
  })
  // Publish-once: the PK conflict means this exact submission already published
  // (retry / concurrent approve). Replay its coordinates; never overwrite it.
  if (opts.rowId && res.status === 409) return readPublishedRow(config, opts.rowId)
  await ensureOk(res, 'insert')
  const rows = (await res.json()) as ModuleRow[]
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (!row?.id) throw new MarketError('insert', 502, 'insert returned no row')
  return { remoteId: row.id, version: row.version ?? 1, publishedAt: row.published_at }
}

// --- marketplace reads (anon key) --------------------------------------------

// List published modules, newest first. Source bodies are NOT fetched here —
// only on install — to keep the listing light.
export const listMarketplace = async (
  config: ModulesMarketConfig,
): Promise<MarketplaceModule[]> => {
  const res = await supabaseFetch(
    config,
    '?select=id,name,description,framework,version,published_at&order=published_at.desc&limit=200',
  )
  await ensureOk(res, 'list')
  const rows = (await res.json()) as unknown
  return Array.isArray(rows) ? (rows as ModuleRow[]).map(toMarketplaceModule) : []
}

export interface MarketplaceModuleWithSource extends MarketplaceModule {
  source: string
}

// Fetch one row INCLUDING its source for install. null when the id matches no
// row (the route's 404).
export const fetchMarketplaceModule = async (
  config: ModulesMarketConfig,
  remoteId: string,
): Promise<MarketplaceModuleWithSource | null> => {
  const res = await supabaseFetch(
    config,
    `?id=eq.${encodeURIComponent(remoteId)}&select=id,name,description,framework,source,version,published_at&limit=1`,
  )
  await ensureOk(res, 'install')
  const rows = (await res.json()) as unknown
  const row = Array.isArray(rows) ? (rows as ModuleRow[])[0] : undefined
  if (!row?.id) return null
  return { ...toMarketplaceModule(row), source: row.source ?? '' }
}
