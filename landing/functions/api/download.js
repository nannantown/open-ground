// landing/functions/api/download.js — "Download" redirect (macOS + Windows).
//
// The landing page can't hardcode a release asset URL (the filename carries
// the version: OPEN-GROUND-<x.y.z>-<arch>.dmg / OPEN-GROUND-Setup-<x.y.z>.exe),
// so this edge Function asks the GitHub API for the LATEST published release of
// the public distribution repo and 302s straight to the right installer.
//
// Which installer:
//   - ?os=win            → the Windows NSIS installer (.exe)
//   - ?arch=x64          → the Intel macOS build (.dmg, x64)
//   - (nothing)          → auto-detect the visitor's OS from client hints
//                          (sec-ch-ua-platform) then User-Agent: Windows → .exe,
//                          otherwise macOS → Apple-Silicon .dmg (the original
//                          default). A bare /api/download therefore serves the
//                          correct installer to Mac AND Windows visitors.
//
// Falls back to the releases page when anything is off (rate limit, no
// published release yet, no matching asset) so the user always lands somewhere
// they can download from — and never the wrong platform/arch.
//
// The GitHub API response is cached at the edge for 5 minutes (a download spike
// never touches GitHub's 60/h-per-IP unauthenticated limit). The 302 itself is
// computed per request (it varies by OS) and marked no-store + Vary so no edge
// or browser cache pins one visitor's platform onto another's.

const RELEASES_PAGE = 'https://github.com/nannantown/open-ground/releases/latest'
const API_LATEST = 'https://api.github.com/repos/nannantown/open-ground/releases/latest'

// A 302 that varies by client. Response.redirect() is immutable, so build it by
// hand to attach Vary + no-store — the redirect target depends on the visitor's
// OS hints, and must not be cached and replayed for a different platform.
function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'cache-control': 'no-store',
      vary: 'sec-ch-ua-platform, user-agent',
    },
  })
}

// Does this request want the Windows build? Explicit ?os wins; otherwise an
// ?arch param implies macOS (no Windows arch variants are shipped); otherwise
// sniff the OS. sec-ch-ua-platform is a low-entropy client hint Chromium sends
// by default on https; Safari/Firefox omit it, so fall back to the UA string.
function wantsWindows(url, request) {
  const os = (url.searchParams.get('os') || '').toLowerCase()
  if (os === 'win' || os === 'windows') return true
  if (os === 'mac' || os === 'macos' || os === 'osx') return false
  if (url.searchParams.get('arch')) return false

  const platform = (request.headers.get('sec-ch-ua-platform') || '')
    .replace(/"/g, '')
    .trim()
    .toLowerCase()
  if (platform === 'windows') return true
  if (platform === 'macos' || platform === 'mac os x') return false

  const ua = (request.headers.get('user-agent') || '').toLowerCase()
  // Match Windows but not "Windows Phone"; Mac/iOS fall through to the default.
  if (ua.includes('windows nt') || (ua.includes('windows') && !ua.includes('phone'))) {
    return true
  }
  return false // default: macOS (preserves the original behaviour)
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url)
    const res = await fetch(API_LATEST, {
      headers: {
        'user-agent': 'open-ground-landing',
        accept: 'application/vnd.github+json',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    })
    if (!res.ok) return redirect(RELEASES_PAGE)
    const rel = await res.json()
    const assets = rel.assets ?? []

    if (wantsWindows(url, context.request)) {
      // Windows NSIS installer: OPEN-GROUND-Setup-<ver>.exe. `.endsWith('.exe')`
      // excludes the sibling `.exe.blockmap` (electron-updater delta metadata).
      const exe = assets.find((a) => a.name?.endsWith('.exe'))
      // No .exe yet (e.g. a release that predates the Windows build): send the
      // releases page, never a macOS .dmg to a Windows visitor.
      return redirect(exe?.browser_download_url ?? RELEASES_PAGE)
    }

    // macOS: Apple Silicon (arm64) by default, Intel (x64) on ?arch=x64.
    const arch = url.searchParams.get('arch') === 'x64' ? 'x64' : 'arm64'
    const dmgs = assets.filter((a) => a.name?.endsWith('.dmg'))
    const wanted =
      arch === 'x64'
        ? dmgs.find((a) => a.name.includes('x64') && !a.name.includes('arm64'))
        : // Pre-Intel releases shipped a single arm64 dmg — "any dmg" keeps
          // the default CTA working against those.
          (dmgs.find((a) => a.name.includes('arm64')) ?? dmgs[0])
    // No dmg for the REQUESTED arch (e.g. Intel asked before an x64 release
    // exists): send the releases page, never the wrong architecture.
    return redirect(wanted?.browser_download_url ?? RELEASES_PAGE)
  } catch {
    return redirect(RELEASES_PAGE)
  }
}
