// landing/functions/api/download.js — "Download for Mac" redirect.
//
// The landing page can't hardcode a release asset URL (the filename carries
// the version: OPEN-GROUND-<x.y.z>-arm64.dmg), so this edge Function asks the
// GitHub API for the LATEST published release of the public distribution repo
// and 302s straight to its .dmg asset. Falls back to the releases page when
// anything is off (rate limit, no published release yet, no dmg asset) — the
// user always lands somewhere they can download from.
//
// Cached at the edge for 5 minutes so a download spike never touches GitHub's
// unauthenticated rate limit (60/h per IP — the cache makes this a non-issue).

const RELEASES_PAGE = 'https://github.com/nannantown/open-ground/releases/latest'
const API_LATEST = 'https://api.github.com/repos/nannantown/open-ground/releases/latest'

export async function onRequestGet(context) {
  try {
    const res = await fetch(API_LATEST, {
      headers: {
        'user-agent': 'open-ground-landing',
        accept: 'application/vnd.github+json',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    })
    if (!res.ok) return Response.redirect(RELEASES_PAGE, 302)
    const rel = await res.json()
    const dmg = (rel.assets ?? []).find((a) => a.name?.endsWith('.dmg'))
    return Response.redirect(dmg?.browser_download_url ?? RELEASES_PAGE, 302)
  } catch {
    return Response.redirect(RELEASES_PAGE, 302)
  }
}
