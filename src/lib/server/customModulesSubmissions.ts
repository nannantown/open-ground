// customModulesSubmissions.ts — Supabase glue for the module-submission review
// queue (docs/CUSTOM_TABS_PLAN.md — submit → review → publish).
//
// A tester builds a custom tab locally and SUBMITS its source to the owner for
// review; the owner approves (→ published into og_custom_modules, the public
// marketplace) or rejects. Same posture as the feedback proxy + customModules-
// Market: the server is the only thing that talks to Supabase, so no key ever
// lands in the client bundle. Two key tiers, mirroring feedback:
//   - submit → SUPABASE_ANON_KEY (RLS: anon may INSERT a pending row only)
//   - review (list/get/mark) → SUPABASE_SERVICE_ROLE_KEY (owner machine only;
//     bypasses RLS to read + moderate the PRIVATE queue — there is no anon SELECT)
// Table: env SUPABASE_SUBMISSIONS_TABLE, default 'og_module_submissions'.
//
// GRACEFUL DEGRADE: missing env → the config readers return null and the route
// answers 503 (never a crash, never a hardcoded secret). Env is read lazily per
// request (the feedback readConfig pattern) so tests can vi.stubEnv per case.

import type { CustomModuleFramework, ModuleSubmissionItem } from '../types'
import { sanitizeModuleSubmission } from '../schemas'

export interface SubmissionsConfig {
  url: string
  key: string
  table: string
}

// SUPABASE_URL + the chosen key env + optional table. Null unless BOTH url and
// key are present — the route's 503 trigger.
const readConfig = (
  keyEnv: 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY',
): SubmissionsConfig | null => {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env[keyEnv]?.trim()
  if (!url || !key) return null
  const table = process.env.SUPABASE_SUBMISSIONS_TABLE?.trim() || 'og_module_submissions'
  return { url: url.replace(/\/+$/, ''), key, table }
}

// Submit path: the anon key (RLS = insert a pending row only). Present on every
// build that wants to COLLECT submissions.
export const readSubmitConfig = () => readConfig('SUPABASE_ANON_KEY')

// Review path: the service-role key — reads + moderates past the insert-only
// RLS. Owner machine only; never shipped in the public build.
export const readSubmissionAdminConfig = () => readConfig('SUPABASE_SERVICE_ROLE_KEY')

// One PostgREST call with this feature's auth + a 10s timeout (mirrors the
// feedback / market supabaseFetch so headers/timeout can't drift).
const supabaseFetch = (
  config: SubmissionsConfig,
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
export class SubmissionError extends Error {
  constructor(
    public readonly label: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`submissions ${label}: supabase responded ${status}`)
  }
}

const ensureOk = async (res: Response, label: string): Promise<Response> => {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new SubmissionError(label, res.status, detail)
  }
  return res
}

// --- submit (anon key) -------------------------------------------------------

export interface SubmitInput {
  name: string
  description: string
  framework: CustomModuleFramework
  source: string
  /** Display-only contact (the signed-in account's email); never trusted. */
  submitterEmail?: string | null
}

// INSERT a fresh pending row (return=minimal — we never read rows back over the
// anon key). The table's RLS with_check pins status='pending'.
export const submitModule = async (
  config: SubmissionsConfig,
  input: SubmitInput,
): Promise<void> => {
  const res = await supabaseFetch(config, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      framework: input.framework,
      source: input.source,
      submitter_email: input.submitterEmail ?? null,
      status: 'pending',
    }),
  })
  await ensureOk(res, 'submit')
}

// --- review reads/writes (service-role key) ----------------------------------

const LIST_CAP = 200

// List the queue (default: pending), newest first. Fetches one past the cap to
// flag truncation without a 2nd query. Source bodies are NOT selected here (only
// getSubmission fetches source) so the inbox list stays light. Each row is
// re-validated (sanitizeModuleSubmission) so a crafted row can't crash the inbox.
export const listSubmissions = async (
  config: SubmissionsConfig,
  opts: { status?: 'pending' | 'approved' | 'rejected' } = {},
): Promise<{ items: ModuleSubmissionItem[]; truncated: boolean }> => {
  const status = opts.status ?? 'pending'
  const res = await supabaseFetch(
    config,
    `?status=eq.${status}&select=id,created_at,submitter_email,name,description,framework,status,published_remote_id&order=created_at.desc&limit=${LIST_CAP + 1}`,
  )
  await ensureOk(res, 'list')
  const rows = (await res.json()) as unknown
  const arr = Array.isArray(rows) ? rows : []
  const truncated = arr.length > LIST_CAP
  const page = truncated ? arr.slice(0, LIST_CAP) : arr
  const items = page
    .map(sanitizeModuleSubmission)
    .filter((r): r is ModuleSubmissionItem => r !== null)
  return { items, truncated }
}

// Count pending submissions newer than `since` (ISO) — the unread badge feed for
// the settings-gear dot. HEAD + count=exact so Supabase reports the total in the
// Content-Range header without transferring any rows. 0 when the count is
// missing/unparseable (a dropped Prefer header), never a thrown badge.
export const countPendingSince = async (
  config: SubmissionsConfig,
  since?: string,
): Promise<number> => {
  const filter = since ? `&created_at=gt.${encodeURIComponent(since)}` : ''
  const res = await supabaseFetch(config, `?select=id&status=eq.pending${filter}`, {
    method: 'HEAD',
    headers: { Prefer: 'count=exact' },
  })
  // PostgREST answers HEAD count requests with 200 or 206.
  if (!res.ok && res.status !== 206) {
    const detail = await res.text().catch(() => '')
    throw new SubmissionError('unread', res.status, detail)
  }
  const range = res.headers.get('content-range') || ''
  const total = Number.parseInt(range.split('/')[1] ?? '', 10)
  return Number.isFinite(total) ? total : 0
}

// Fetch one row INCLUDING its source (the review preview + the approve copy).
// null when the id matches no row (the route's 404).
export const getSubmission = async (
  config: SubmissionsConfig,
  id: string,
): Promise<ModuleSubmissionItem | null> => {
  const res = await supabaseFetch(
    config,
    `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  )
  await ensureOk(res, 'get')
  const rows = (await res.json()) as unknown
  const row = Array.isArray(rows) ? rows[0] : undefined
  return row ? sanitizeModuleSubmission(row) : null
}

export interface MarkInput {
  status: 'approved' | 'rejected'
  /** Set on approve — the og_custom_modules row id the source was published as. */
  publishedRemoteId?: string | null
}

// PATCH status + reviewed_at (+ published_remote_id on approve). return=minimal.
export const markSubmission = async (
  config: SubmissionsConfig,
  id: string,
  patch: MarkInput,
): Promise<void> => {
  const body: Record<string, unknown> = {
    status: patch.status,
    reviewed_at: new Date().toISOString(),
  }
  if (patch.publishedRemoteId !== undefined) {
    body.published_remote_id = patch.publishedRemoteId
  }
  const res = await supabaseFetch(config, `?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  await ensureOk(res, 'mark')
}
