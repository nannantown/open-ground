// Client side of the git-shared data feature (docs/SHARED_DATA_PLAN.md).
//
// Thin fetch wrappers over the /api/project/share/* routes plus the pure
// remote-name parser the Sync button shows. Deliberately raw `fetch` (not the
// typed hc client): the share routes land in a parallel track, so this client
// must degrade gracefully when they don't exist yet — a 404 (or any network
// failure) reads as "share status unknown" and the UI hides itself quietly.
// Once the routes are merged and chained on the Hono app these can be
// converted to `api.api.project.share.*` like every other call site.

import type {
  ShareAutoStatus,
  ShareConflict,
  ShareEnableConfig,
  ShareStatus,
  ShareSyncResult,
} from '@/lib/types'

/** `owner/repo` from a git remote URL, for the faint label next to Sync.
 *
 *  Handles the three remote shapes git produces in practice:
 *    - scp-like      git@github.com:owner/repo.git
 *    - real URLs     https://host/owner/repo.git, ssh://git@host:22/owner/repo
 *    - local paths   /srv/git/repo.git
 *  Keeps the LAST TWO path segments (so a GitLab sub-group remote stays a
 *  short `group/repo`, not the whole nested path) and strips a trailing
 *  `.git`. Returns null when nothing presentable can be parsed.
 */
export const remoteShortName = (remoteUrl: string | null): string | null => {
  if (!remoteUrl) return null
  const s = remoteUrl.trim()
  if (!s) return null
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // Real URL (https://, ssh://, git://, file://…) — let URL split off the
    // host/port so `ssh://git@host:2222/owner/repo` doesn't eat the port.
    try {
      path = new URL(s).pathname
    } catch {
      return null
    }
  } else {
    // scp-like `user@host:path` — everything after the first colon is path.
    const scp = s.match(/^[^@/\s]+@[^:/\s]+:(.+)$/)
    path = scp ? scp[1] : s // else: a plain local-path remote
  }
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) return null
  const short = segs.slice(-2).join('/').replace(/\.git$/i, '')
  return short || null
}

/** GET /api/project/share/status — null on ANY failure (route not deployed,
 *  network error, malformed body): the caller hides all share UI quietly. */
export const fetchShareStatus = async (
  path: string,
): Promise<ShareStatus | null> => {
  try {
    const res = await fetch(
      `/api/project/share/status?path=${encodeURIComponent(path)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | Partial<ShareStatus>
      | null
    if (!body || typeof body.shared !== 'boolean') return null
    return {
      shared: body.shared,
      gitRepo: body.gitRepo === true,
      remoteUrl: typeof body.remoteUrl === 'string' ? body.remoteUrl : null,
      dirty: body.dirty === true,
      ahead: typeof body.ahead === 'number' ? body.ahead : 0,
      behind: typeof body.behind === 'number' ? body.behind : 0,
      upstream: body.upstream === true,
      ...(body.forcedUpdate === true ? { forcedUpdate: true } : {}),
      ...(typeof body.branch === 'string' && body.branch ? { branch: body.branch } : {}),
      ...(normalizeAuto(body.auto) ? { auto: normalizeAuto(body.auto)! } : {}),
    }
  } catch {
    return null
  }
}

const AUTO_MODES: ShareAutoStatus['mode'][] = [
  'live',
  'syncing',
  'paused-code',
  'conflict',
  'offline',
  'blocked',
  'error',
  'disabled',
]

/** Defensive read of ShareStatus.auto — absent/malformed reads as undefined
 *  (the UI then falls back to the manual Sync button). */
const normalizeAuto = (raw: unknown): ShareAutoStatus | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Partial<ShareAutoStatus>
  if (typeof a.enabled !== 'boolean') return undefined
  const mode = AUTO_MODES.includes(a.mode as ShareAutoStatus['mode'])
    ? (a.mode as ShareAutoStatus['mode'])
    : 'live'
  return {
    enabled: a.enabled,
    mode,
    lastSyncAt: typeof a.lastSyncAt === 'number' ? a.lastSyncAt : null,
    pendingPush: a.pendingPush === true,
    intervalMs: typeof a.intervalMs === 'number' ? a.intervalMs : 0,
    ...(typeof a.message === 'string' ? { message: a.message } : {}),
  }
}

export type ShareToggleResult = { ok: true } | { ok: false; error: string }

const postShareToggle = async (
  action: 'enable' | 'disable',
  path: string,
  config?: ShareEnableConfig,
): Promise<ShareToggleResult> => {
  try {
    const res = await fetch(`/api/project/share/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...(config ? { config } : {}) }),
    })
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null
    if (res.ok && body?.ok) return { ok: true }
    return {
      ok: false,
      error: body?.error ?? res.statusText ?? `HTTP ${res.status}`,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' }
  }
}

/** POST /api/project/share/enable — create .openground/ + migrate data in.
 *  `config` (optional) seeds the shared policy (completionFlow /
 *  targetBranch / members) in the same call — the ShareStartDialog's
 *  "confirm the team's rules before sharing" step. Omitted = legacy shape. */
export const enableShare = (path: string, config?: ShareEnableConfig) =>
  postShareToggle('enable', path, config)
/** POST /api/project/share/disable — migrate data back + delete the folder. */
export const disableShare = (path: string) => postShareToggle('disable', path)

/** Normalize a server ShareSyncResult body, dropping malformed fields. */
const normalizeSyncResult = (body: Partial<ShareSyncResult>): ShareSyncResult => ({
  ok: body.ok === true,
  committed: body.committed === true,
  pulled: body.pulled === true,
  pushed: body.pushed === true,
  ...(body.conflict !== undefined ? { conflict: body.conflict } : {}),
  ...(Array.isArray(body.conflictFiles)
    ? { conflictFiles: body.conflictFiles.filter((f): f is string => typeof f === 'string') }
    : {}),
  ...(Array.isArray(body.conflicts)
    ? {
        conflicts: body.conflicts.filter(
          (c): c is ShareConflict =>
            !!c && typeof c === 'object' && typeof c.file === 'string' && typeof c.label === 'string',
        ),
      }
    : {}),
  ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
  ...(body.offline === true ? { offline: true } : {}),
  ...(body.noRemote === true ? { noRemote: true } : {}),
  ...(body.forcedUpdate === true ? { forcedUpdate: true } : {}),
  ...(typeof body.message === 'string' ? { message: body.message } : {}),
})

const postSyncShaped = async (
  url: string,
  payload: Record<string, unknown>,
): Promise<{ result: ShareSyncResult } | { error: string }> => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = (await res.json().catch(() => null)) as
      | (Partial<ShareSyncResult> & { error?: string })
      | null
    if (body && typeof body.ok === 'boolean') return { result: normalizeSyncResult(body) }
    return { error: body?.error ?? res.statusText ?? `HTTP ${res.status}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'network error' }
  }
}

/** POST /api/project/share/sync — commit (scoped to .openground/) → pull
 *  --rebase → push. `{result}` when the server answered with the contract
 *  shape (even ok:false / conflict), `{error}` for transport-level failures. */
export const syncShare = (
  path: string,
): Promise<{ result: ShareSyncResult } | { error: string }> =>
  postSyncShaped('/api/project/share/sync', { path })

/** POST /api/project/share/resolve — re-run the sync resolving each
 *  conflicted file to the chosen side ('mine' | 'theirs'). */
export const resolveShare = (
  path: string,
  choices: Record<string, 'mine' | 'theirs'>,
): Promise<{ result: ShareSyncResult } | { error: string }> =>
  postSyncShaped('/api/project/share/resolve', { path, choices })
