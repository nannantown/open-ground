#!/usr/bin/env node
/* eslint-disable no-console */

// Lint for `src/designs/**/*.tsx` — every module must have a default export
// (the React component). src/screen/ScreenPage.tsx loads these inside a
// sandboxed iframe via Vite's `import.meta.glob('@/designs/**/*.tsx')` and
// renders `mod.default` with React.lazy. A module without a default export
// fails to render and the screen iframe silently shows the missing-module
// fallback — so we require one, which keeps Claude's edits from breaking the
// Canvas screen render.
//
// (Pre-Hono this checked for the `'use client'` directive, which Next's App
// Router needed to keep these modules out of server-component rendering. Vite
// is a plain SPA — there is no server component, 'use client' is a no-op — so
// the meaningful invariant is now "has a default export".)
//
// Run via `npm run check:screens`. Exits 1 with a file list when any module
// is missing a default export.

import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'

const DESIGNS_ROOT = resolve(process.cwd(), 'src', 'designs')

const collectTsxFiles = async (dir: string): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    // .gitkeep, .DS_Store etc. are uninteresting.
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let s
    try {
      s = await stat(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      const sub = await collectTsxFiles(full)
      out.push(...sub)
      continue
    }
    if (!name.endsWith('.tsx')) continue
    out.push(full)
  }
  return out
}

// A module is valid if it exposes a default export — either `export default`
// (function/class/expression) or `export { Foo as default }`.
const hasDefaultExport = (src: string): boolean => {
  if (/^\s*export\s+default\b/m.test(src)) return true
  if (/export\s*\{[^}]*\bas\s+default\b[^}]*\}/m.test(src)) return true
  return false
}

const main = async () => {
  const files = await collectTsxFiles(DESIGNS_ROOT)
  if (files.length === 0) {
    console.log('check:screens — no .tsx files under src/designs/, nothing to check')
    return
  }
  const offenders: string[] = []
  for (const f of files) {
    let src: string
    try {
      src = await readFile(f, 'utf8')
    } catch {
      offenders.push(f + ' (unreadable)')
      continue
    }
    if (!hasDefaultExport(src)) offenders.push(f)
  }
  if (offenders.length > 0) {
    console.error(`check:screens — ${offenders.length} file(s) missing a default export:`)
    for (const f of offenders) {
      console.error('  ' + f.replace(process.cwd() + '/', ''))
    }
    process.exit(1)
  }
  console.log(`check:screens — ${files.length} file(s) OK`)
}

main().catch((err) => {
  console.error('check:screens — unexpected error:', err)
  process.exit(1)
})
