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

// A SECOND flavour lives at the bottom of this file: `installManagedSection`,
// which owns a marked BLOCK inside a file the user also writes in (their
// ~/.claude/CLAUDE.md). Same ownership vocabulary, different unit — see there.

import { readFile, mkdir, stat, lstat } from 'fs/promises'
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
    // ENOENT (readFile could not resolve the path) is the only case allowed to
    // fall through to a fresh install. Anything else — EACCES on a chmod-000
    // file, EISDIR — is a real existing object we cannot verify the ownership
    // marker of; treating it as "missing" would let atomicWriteText's rename
    // silently replace a file that might be user-authored (rename only needs
    // directory write permission, not permission on the target itself).
    // Fail closed instead: report it and touch nothing.
    //
    // KNOWN GAP, whole-file flavour only: a SYMLINKED target is NOT caught here
    // (an earlier version of this comment claimed it was — it is not). readFile
    // follows the link, so a live one reads as its destination and a dangling
    // one reports ENOENT, i.e. it looks "missing"; either way the rename below
    // drops a regular file ONTO the link and detaches a chezmoi/stow-managed
    // path from its dotfiles repo. The block flavour refuses that outright
    // ('kept-symlink' — see installManagedSection); doing the same here would
    // change ogManageSkill / swarmToolingInstall behaviour, so it is left to
    // its own change rather than smuggled in with this one.
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

// ─── Section flavour ─────────────────────────────────────────────────────────
//
// `installManagedFile` above owns a WHOLE file, which only works when OPEN
// GROUND is the only writer (a skill file, swarm-beat.sh). It cannot be used
// for ~/.claude/CLAUDE.md: that file is the user's own prose, so whole-file
// ownership would either clobber everything they wrote or — with the kept-user
// shield — report 'kept-user' forever and install nothing at all.
//
// So this flavour owns a marked BLOCK and nothing else. Everything outside the
// BEGIN/END delimiters is copied through byte-for-byte.
//
// Ownership contract (same vocabulary as above, one unit down):
//   - block present            → OURS; rewrite in place when the body drifted.
//   - block absent, create     → append the block (creating the file if needed).
//   - block absent, no create  → 'opted-out'. The caller's one-shot sentinel
//     says we already installed once, so an absent block means the user DELETED
//     it. Re-adding text somebody deliberately removed from their own memory
//     file is the one thing this installer must never do.
//   - a user-authored section with the SAME heading, outside our block
//                              → 'kept-user'. Never install a second one:
//     Claude Code's memory docs warn that two contradicting instructions make
//     it "pick one arbitrarily", so a duplicate heading is worse than nothing.
//   - BEGIN without END (or markers out of order / duplicated)
//                              → 'error'. We cannot tell where the user's text
//     resumes, and guessing means truncating their file. Fail closed.
//   - target is a SYMLINK      → 'kept-symlink'. The path is driven by the
//     user's own dotfiles manager; writing through it is impossible without
//     destroying the link (see the lstat check below), so we stay out.

export type ManagedSectionOutcome =
  | 'installed' // block was absent — appended (file created if it was missing)
  | 'refreshed' // block was ours and stale — body rewritten in place
  | 'unchanged' // block was ours and already byte-identical
  | 'kept-user' // user already wrote their own section with this heading
  | 'opted-out' // block absent and createIfAbsent=false — user removed it, stay out
  | 'kept-symlink' // target is a symlink (dotfiles-managed) — nothing written
  | 'error' // target unreadable / delimiters malformed / write failed

export interface ManagedSectionResult {
  outcome: ManagedSectionOutcome
  path: string
  error?: string
}

/** Every index at which `needle` occurs in `hay`. Plain string scanning, not a
 *  RegExp: the markers are HTML comments full of regex metacharacters, and a
 *  literal search cannot be tricked by them. */
const findAll = (hay: string, needle: string): number[] => {
  const out: number[] = []
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i)
  return out
}

/** Idempotently install/refresh a marked block inside `target`, preserving every
 *  byte outside the block. Never throws (a boot-time install must not crash the
 *  server) — problems come back as `outcome: 'error'`.
 *
 *  `beginMarker`/`endMarker` are written verbatim on their own lines and are the
 *  ownership marker; `body` is the text between them. `headingRe`, when given,
 *  detects a user-authored section of the same kind outside our block
 *  (→ 'kept-user'). */
export const installManagedSection = async (opts: {
  target: string
  beginMarker: string
  endMarker: string
  body: string
  createIfAbsent: boolean
  headingRe?: RegExp
}): Promise<ManagedSectionResult> => {
  const { target, beginMarker, endMarker, body, createIfAbsent, headingRe } = opts

  if (!beginMarker || !endMarker || beginMarker === endMarker) {
    return { outcome: 'error', path: target, error: 'begin/end markers must be distinct and non-empty' }
  }

  // A symlinked target belongs to somebody else's tooling: a dotfiles manager
  // (chezmoi, stow, a bare git repo) points ~/.claude/CLAUDE.md at its own copy.
  // Nothing further down would notice — readFile FOLLOWS the link, so a live one
  // reads as its destination and a dangling one reports ENOENT (it looks
  // "missing") — and atomicWriteText then renames a fresh temp ONTO the link.
  // The user keeps their bytes but loses the LINK: the path becomes an ordinary
  // file and their dotfiles manager silently stops driving it. There is no way
  // to add our block without breaking that setup, so the only correct move is to
  // write nothing at all. lstat does not follow, so it can tell us before we read.
  try {
    if ((await lstat(target)).isSymbolicLink()) return { outcome: 'kept-symlink', path: target }
  } catch {
    // Missing (ENOENT) or unreadable for some other reason — the read below is
    // what decides, and it already fails closed on anything but ENOENT.
  }

  let existing: string | null = null
  try {
    existing = await readFile(target, 'utf8')
  } catch (e) {
    // Same fail-closed stance as installManagedFile: only a genuinely missing
    // file may fall through to a fresh write. An EACCES/EISDIR target is a real
    // object whose contents we cannot check, and atomicWriteText's rename would
    // replace it regardless (rename needs the DIRECTORY's write bit, not the
    // target's) — so a user's CLAUDE.md could be destroyed without ever being read.
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

  const text = existing ?? ''
  const begins = findAll(text, beginMarker)
  const ends = findAll(text, endMarker)

  if (begins.length > 1 || ends.length > 1) {
    return { outcome: 'error', path: target, error: 'duplicate managed-section markers — refusing to guess which block is ours' }
  }
  if (begins.length !== ends.length) {
    return { outcome: 'error', path: target, error: 'unbalanced managed-section markers (begin without end, or end without begin)' }
  }

  const block = `${beginMarker}\n${body.replace(/\s+$/, '')}\n${endMarker}`

  if (begins.length === 1) {
    const start = begins[0]
    const stop = ends[0] + endMarker.length
    if (start >= ends[0]) {
      return { outcome: 'error', path: target, error: 'managed-section end marker precedes its begin marker' }
    }
    const next = text.slice(0, start) + block + text.slice(stop)
    if (next === text) return { outcome: 'unchanged', path: target }
    // Carry the user's permissions across. atomicWriteText renames a fresh temp
    // over the target, so without this a CLAUDE.md the user kept at 0600 would
    // come back 0644 — a silent loosening of a file we do not own.
    let mode: number | undefined
    try {
      mode = (await stat(target)).mode & 0o777
    } catch { /* fall back to the default mode */ }
    try {
      await atomicWriteText(target, next, mode != null ? { mode } : undefined)
    } catch (e) {
      return { outcome: 'error', path: target, error: `refresh failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    return { outcome: 'refreshed', path: target }
  }

  // No block of ours in the file. Rebuild headingRe without `g`/`y` — a sticky
  // or global regex carries `lastIndex` between calls, so the SECOND boot would
  // silently miss a user heading the first boot found (and install a duplicate).
  if (headingRe && new RegExp(headingRe.source, headingRe.flags.replace(/[gy]/g, '')).test(text)) {
    return { outcome: 'kept-user', path: target }
  }
  if (!createIfAbsent) return { outcome: 'opted-out', path: target }

  // Append, leaving exactly one blank line between the user's last line and ours.
  const head = text.length === 0 ? '' : `${text.replace(/\s+$/, '')}\n\n`
  let appendMode: number | undefined
  if (existing !== null) {
    try {
      appendMode = (await stat(target)).mode & 0o777
    } catch { /* fall back to the default mode */ }
  }
  try {
    await mkdir(dirname(target), { recursive: true })
    await atomicWriteText(target, `${head}${block}\n`, appendMode != null ? { mode: appendMode } : undefined)
  } catch (e) {
    return { outcome: 'error', path: target, error: `install failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { outcome: 'installed', path: target }
}
