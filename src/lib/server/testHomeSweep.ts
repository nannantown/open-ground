// Removes test sandboxes left in the temp dir by vitest runs that never reached
// their afterAll (a killed / reaped worker, a crash). src/test/setup-home.ts
// makes one `openground-test-home-*` dir per test file and deletes it itself;
// this collects only what that missed, plus the backlog from before it did
// (153,830 dirs / 13 GB on the owner's machine, 2026-09-26).
//
// "Certainly ours" = all of: directly in the temp dir, name starts with the
// prefix below (used nowhere else — setup-home.ts imports it from here), a real
// directory (not a symlink), owned by this user, untouched for STALE_MS. Other
// temp dirs (og-*, remotion-*, …) are never looked at: their names are not
// unique enough to be sure who made them.
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const TEST_HOME_PREFIX = 'openground-test-home-'
/** A full suite run takes minutes (fullSuiteGate MAX_RUN_MS = 1 h); 3 h is safely past any live run. */
export const TEST_HOME_STALE_MS = 3 * 60 * 60_000

export async function sweepStaleTestHomes(
  opts: { root?: string; now?: number; staleMs?: number } = {},
): Promise<number> {
  const root = opts.root ?? tmpdir()
  const cutoff = (opts.now ?? Date.now()) - (opts.staleMs ?? TEST_HOME_STALE_MS)
  const uid = process.getuid?.()
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(TEST_HOME_PREFIX)) continue
    const p = join(root, name)
    try {
      const st = await fs.lstat(p)
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue
      if (uid !== undefined && st.uid !== uid) continue
      await fs.rm(p, { recursive: true, force: true })
      removed++
    } catch {
      // vanished or unreadable — skip
    }
  }
  return removed
}
