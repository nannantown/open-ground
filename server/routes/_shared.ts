// server/routes/_shared.ts — small helpers shared across route sub-routers.
// These are NOT business logic (that lives in src/lib/server/*); they are the
// thin request-shape validators the Next handlers carried inline and that two
// Hono routes (project rename + projects/new) duplicated verbatim.

/**
 * Validate a proposed project folder name. Stays friendly to macOS Finder /
 * git / shells: no slashes, no traversal, no leading dot (would be hidden +
 * skipped by scan), no collision with the archive sentinel folder.
 *
 * Returns an error string to surface to the client, or null when the name is
 * acceptable. Behaviour is byte-for-byte the copy that lived in
 * project.ts (rename) and misc.ts (projects/new).
 */
export const validateName = (name: string, archiveDir: string): string | null => {
  if (!name) return 'name is required'
  if (name.length > 64) return 'name is too long (max 64 chars)'
  if (name.startsWith('.')) return 'name must not start with "."'
  if (name === archiveDir) return `"${archiveDir}" is reserved for archived projects`
  if (/[\\/]/.test(name)) return 'name must not contain "/" or "\\"'
  if (name === '.' || name === '..') return 'invalid name'
  if (/[\x00-\x1f]/.test(name)) return 'name contains invalid characters'
  return null
}
