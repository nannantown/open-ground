// landing/functions/api/download.js — "Download for Mac" redirect.
//
// The landing page can't hardcode a release asset URL (the filename carries
// the version: OPEN-GROUND-<x.y.z>-<arch>.dmg), so this edge Function asks the
// GitHub API for the LATEST published release of the public distribution repo
// and 302s straight to its .dmg asset. `?arch=x64` picks the Intel build;
// anything else (or nothing) picks Apple Silicon (arm64). Falls back to the
// releases page when anything is off (rate limit, no published release yet,
// no matching dmg asset) — the user always lands somewhere they can download
// from.
//
// Cached at the edge for 5 minutes so a download spike never touches GitHub's
// unauthenticated rate limit (60/h per IP — the cache makes this a non-issue).

const RELEASES_PAGE = 'https://github.com/nannantown/open-ground/releases/latest'
const API_LATEST = 'https://api.github.com/repos/nannantown/open-ground/releases/latest'

export async function onRequestGet(context) {
  try {
    const arch = new URL(context.request.url).searchParams.get('arch') === 'x64' ? 'x64' : 'arm64'
    const res = await fetch(API_LATEST, {
      headers: {
        'user-agent': 'open-ground-landing',
        accept: 'application/vnd.github+json',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    })
    if (!res.ok) return Response.redirect(RELEASES_PAGE, 302)
    const rel = await res.json()
    const dmgs = (rel.assets ?? []).filter((a) => a.name?.endsWith('.dmg'))
    const wanted =
      arch === 'x64'
        ? dmgs.find((a) => a.name.includes('x64') && !a.name.includes('arm64'))
        : // Pre-Intel releases shipped a single arm64 dmg — "any dmg" keeps
          // the default CTA working against those.
          (dmgs.find((a) => a.name.includes('arm64')) ?? dmgs[0])
    // No dmg for the REQUESTED arch (e.g. Intel asked before an x64 release
    // exists): send the releases page, never the wrong architecture.
    return Response.redirect(wanted?.browser_download_url ?? RELEASES_PAGE, 302)
  } catch {
    return Response.redirect(RELEASES_PAGE, 302)
  }
}
