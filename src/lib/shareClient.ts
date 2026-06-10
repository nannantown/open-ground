// Client side of the git-shared data feature (docs/SHARED_DATA_PLAN.md).
//
// Thin fetch wrappers over the /api/project/share/* routes plus the pure
// remote-name parser the Sync button shows. Deliberately raw `fetch` (not the
// typed hc client): the share routes land in a parallel track, so this client
// must degrade gracefully when they don't exist yet — a 404 (or any network
// failure) reads as "share status unknown" and the UI hides itself quietly.
// Once the routes are merged and chained on the Hono app these can be
// converted to `api.api.project.share.*` like every other call site.

import type { ShareStatus, ShareSyncResult } from '@/lib/types'

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
    }
  } catch {
    return null
  }
}

export type ShareToggleResult = { ok: true } | { ok: false; error: string }

const postShareToggle = async (
  action: 'enable' | 'disable',
  path: string,
): Promise<ShareToggleResult> => {
  try {
    const res = await fetch(`/api/project/share/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
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

/** POST /api/project/share/enable — create .openground/ + migrate data in. */
export const enableShare = (path: string) => postShareToggle('enable', path)
/** POST /api/project/share/disable — migrate data back + delete the folder. */
export const disableShare = (path: string) => postShareToggle('disable', path)

/** POST /api/project/share/sync — commit (scoped to .openground/) → pull
 *  --rebase → push. `{result}` when the server answered with the contract
 *  shape (even ok:false / conflict), `{error}` for transport-level failures. */
export const syncShare = async (
  path: string,
): Promise<{ result: ShareSyncResult } | { error: string }> => {
  try {
    const res = await fetch('/api/project/share/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const body = (await res.json().catch(() => null)) as
      | (Partial<ShareSyncResult> & { error?: string })
      | null
    if (body && typeof body.ok === 'boolean') {
      return {
        result: {
          ok: body.ok,
          committed: body.committed === true,
          pulled: body.pulled === true,
          pushed: body.pushed === true,
          ...(body.conflict !== undefined ? { conflict: body.conflict } : {}),
          ...(typeof body.message === 'string' ? { message: body.message } : {}),
        },
      }
    }
    return { error: body?.error ?? res.statusText ?? `HTTP ${res.status}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'network error' }
  }
}
