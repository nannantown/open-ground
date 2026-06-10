import { realpath } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'

// Resolve a path to its canonical form (symlinks followed). For paths that
// don't fully exist yet (creation flows), realpath the nearest existing
// ancestor and re-append the not-yet-created tail, so creation flows still work
// while existing symlinks are fully resolved. ENOENT walks up; any other error
// falls back to the lexical path.
//
// Lives in its own module (not projectData.ts) so both the security boundary
// (validateProjectPath) and the project registry (registry.ts) can share it
// without an import cycle.
export const canonicalize = async (p: string): Promise<string> => {
  let cur = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return cur
      const parent = dirname(cur)
      if (parent === cur) return resolve(p) // hit the fs root, nothing real
      tail.push(basename(cur))
      cur = parent
    }
  }
}
