// managedFileInstall — generic idempotent installer that backs ogManageSkill.ts
// and swarmToolingInstall.ts. Extracted so every "ship a file from the repo
// checkout into the user's ~/.claude" case (og-manage skill, order/supply
// skills, swarm-beat.sh + openground-swarm-lib.sh) shares one ownership contract instead
// of re-implementing it per file.
//
// Ownership contract (mirrors hooksInstall's "never touch user-authored"):
//   - target missing                       → install (first boot / new machine).
//   - target carries the given marker      → OURS; rewrite when content drifted
//                                             from the shipped source (version-follow).
//   - target WITHOUT the marker            → user-authored file that happens to
//     share the name; NEVER overwritten ('kept-user'). Removing the marker is the
//     documented way for a user to take ownership of the file.

import { readFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteText } from './atomicWrite'

export type ManagedFileOutcome =
  | 'installed' // target was missing — first install
  | 'refreshed' // target was ours (marker) and stale — rewritten to the shipped text
  | 'unchanged' // target was ours and already byte-identical
  | 'kept-user' // target exists WITHOUT our marker — user-authored, never touched
  | 'error' // source unreadable / write failed — reported, never thrown

export interface ManagedFileResult {
  outcome: ManagedFileOutcome
  /** The target path (for the boot log). */
  path: string
  error?: string
}

/** Idempotently install/refresh `target` from `source`, never throwing (a boot-
 *  time install must not crash the server). `mode` (e.g. 0o755 for a script)
 *  is applied to the written file. */
export const installManagedFile = async (opts: {
  source: string
  target: string
  marker: string
  mode?: number
}): Promise<ManagedFileResult> => {
  const { source, target, marker, mode } = opts

  let desired: string
  try {
    desired = await readFile(source, 'utf8')
  } catch (e) {
    return {
      outcome: 'error',
      path: target,
      error: `source unreadable: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  // A shipped source that lost its marker would make every fresh install look
  // user-authored to the NEXT boot (never refreshed again) — fail loudly here
  // instead of quietly shipping an unmanageable file.
  if (!desired.includes(marker)) {
    return { outcome: 'error', path: target, error: 'source is missing the managed-by marker' }
  }

  let existing: string | null = null
  try {
    existing = await readFile(target, 'utf8')
  } catch (e) {
    // ENOENT (genuinely missing) is the only case allowed to fall through to a
    // fresh install. Anything else (EACCES on a chmod-000 file, a broken
    // symlink, …) is a real existing object we cannot verify the ownership
    // marker of — treating it as "missing" would let atomicWriteText's rename
    // silently replace a file that might be user-authored (rename only needs
    // directory write permission, not permission on the target itself).
    // Fail closed instead: report it and touch nothing.
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      return {
        outcome: 'error',
        path: target,
        error: `target unreadable (not missing — refusing to guess ownership): ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    existing = null
  }

  if (existing !== null) {
    if (!existing.includes(marker)) {
      return { outcome: 'kept-user', path: target }
    }
    if (existing === desired) {
      return { outcome: 'unchanged', path: target }
    }
  }

  try {
    await mkdir(dirname(target), { recursive: true })
    await atomicWriteText(target, desired, mode != null ? { mode } : undefined)
  } catch (e) {
    return {
      outcome: 'error',
      path: target,
      error: `install failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  return { outcome: existing === null ? 'installed' : 'refreshed', path: target }
}
