import { join } from 'path'
import { readFile, rename, stat, writeFile } from 'fs/promises'

// Per-project storage used to live in `.pmmap/`, then `.hove/`. Migrate it
// once per project to `.openground/` and rewrite the project's .gitignore so
// the new path is still excluded. Idempotent and cached so repeated reads
// don't churn the disk.
const migrated = new Set<string>()

export const ensureOpenGroundProjectDir = async (projectPath: string) => {
  if (migrated.has(projectPath)) return
  migrated.add(projectPath)
  const fresh = join(projectPath, '.openground')
  // Walk the legacy lineage. Prefer the most recent codename if both are
  // present; never clobber a real .openground. The legacy dir might already
  // be gone (out-of-band migration), but the .gitignore still needs a sweep.
  if (!(await dirExists(fresh))) {
    for (const legacyName of ['.hove', '.pmmap']) {
      const legacy = join(projectPath, legacyName)
      if (await dirExists(legacy)) {
        try {
          await rename(legacy, fresh)
          break
        } catch {
          // Cross-device, perms, etc. — leave the legacy dir for manual cleanup
          // and let the caller mkdir(fresh) as usual.
        }
      }
    }
  }
  await rewriteGitignore(projectPath)
}

const dirExists = async (p: string) => {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

// Swap `.pmmap` / `.hove` lines for `.openground` in the project's
// .gitignore, preserving trailing slashes and inline comments. Never creates
// a .gitignore that didn't exist.
const rewriteGitignore = async (projectPath: string) => {
  const giPath = join(projectPath, '.gitignore')
  let raw: string
  try {
    raw = await readFile(giPath, 'utf8')
  } catch {
    return
  }
  // Match `.pmmap` or `.hove` (with optional leading `/`, optional negation,
  // optional trailing `/` and trailing comment), leaving any indentation and
  // inline comment intact.
  const LEGACY = /^(\s*!?\s*\/?)\.(?:pmmap|hove)(\/?)(\s*(?:#.*)?)$/
  const lines = raw.split('\n')
  let touched = false
  const next = lines.map((line) => {
    const m = line.match(LEGACY)
    if (m) {
      touched = true
      return `${m[1]}.openground${m[2]}${m[3]}`
    }
    return line
  })
  if (touched) {
    if (next.at(-1) !== '') next.push('')
    await writeFile(giPath, next.join('\n'), 'utf8')
  }
}
