// ghCli — presence/auth probe for the GitHub CLI, mirroring claudeCli.ts.
// The PR completion flow shells out to `gh pr create` from claude's task
// session; discovering a missing/unauthenticated gh only at that moment is
// too late (F051), so Project settings pre-checks when "Open a PR" is picked.
//
// `gh auth status` exits 0 when at least one host is authenticated, non-zero
// when installed-but-unauthenticated; a spawn ENOENT means not installed.
// Cached briefly on globalThis (survives tsx-watch reloads) — the dialog can
// re-probe freely without spawning gh per keystroke.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

export interface GhStatus {
  installed: boolean
  authenticated: boolean
}

const TTL_MS = 60_000

const g = globalThis as typeof globalThis & {
  __openground_gh_status?: { at: number; status: GhStatus }
}

export const probeGhCli = async (force = false): Promise<GhStatus> => {
  const cached = g.__openground_gh_status
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.status
  let status: GhStatus
  try {
    await execFile('gh', ['auth', 'status'], { timeout: 8_000 })
    status = { installed: true, authenticated: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string | number }
    status =
      err.code === 'ENOENT'
        ? { installed: false, authenticated: false }
        : { installed: true, authenticated: false }
  }
  g.__openground_gh_status = { at: Date.now(), status }
  return status
}
