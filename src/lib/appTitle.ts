// Window title carries the RUNNING app's version (Electron mirrors document.title
// into the window title). Source is the live server's /api/health `version`,
// not a value baked into the SPA, so it can't drift from what is actually running.
export const BASE_TITLE = 'OPEN GROUND · the shore for your AI work'

export function titleWithVersion(version: unknown): string {
  return typeof version === 'string' && version
    ? `OPEN GROUND ${version} · the shore for your AI work`
    : BASE_TITLE
}

export async function applyVersionTitle(): Promise<void> {
  try {
    const res = await fetch('/api/health')
    const h = await res.json()
    document.title = titleWithVersion(h?.version)
  } catch {
    /* keep the static <title> */
  }
}
