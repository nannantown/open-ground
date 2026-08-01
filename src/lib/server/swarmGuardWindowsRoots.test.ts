// THE VETO'S WRITE ROOTS MUST SURVIVE A DRIVE LETTER.
//
// `OPENGROUND_GUARD_WRITE_ROOTS` carries the absolute directories a guarded
// worker may write to. It was produced with `roots.join(':')` and consumed with
// `.split(':')` — which is correct on POSIX and nonsense on Windows, where an
// absolute path CONTAINS a colon. `C:\wt\swarm-a` splits into `['C',
// '\wt\swarm-a']`, both of which resolve to something the worker is not in, so
// EVERY write is outside the roots and denied — including the worker's own
// worktree. Measured 2026-08-01 by feeding Windows-shaped input to the real
// guard: the worker could not write one byte, in EITHER runtime.
//
// It fails CLOSED, so it was never a security hole — it was a worker that
// cannot work, on a platform nobody had run a guarded worker on yet. That is
// precisely the kind of thing an acceptance pass is for, and precisely the kind
// of thing no amount of code review on macOS was ever going to surface.
//
// There is no Windows machine here, so the platform is injected: the guard reads
// `OPENGROUND_GUARD_ROOT_DELIM` when set, `path.delimiter` otherwise. That seam
// can only ever produce roots that match LESS (a wrong delimiter yields
// unparseable roots ⇒ deny), never more — so it cannot widen a permission.

import { describe, it, expect } from 'vitest'
import { delimiter, join } from 'path'
import { loadGuardEvaluate, type GuardEvaluate } from './sdkGuardHook'

const guard: GuardEvaluate = loadGuardEvaluate(
  join(__dirname, '..', '..', '..', 'scripts', 'openground-guard.js'),
)

/** ⚠ WHY THE WINDOWS CASE IS SIMULATED WITH POSIX PATHS.
 *
 *  `path` is bound to the RUNNING platform, so `path.resolve('C:\\wt\\a')` on a Mac
 *  yields `<cwd>/C:\wt\a` and containment is judged by POSIX rules — a literal
 *  Windows path cannot be evaluated here at all, and a test that pretended
 *  otherwise would be measuring the wrong arrangement (this repo has paid for
 *  that mistake before).
 *
 *  What CAN be measured, and is the entire defect, is this: **a root that
 *  contains the separator must not be shredded**. On Windows every root does
 *  (`C:\…`); on POSIX a directory may legally be named `a:b`. Same bug, same
 *  fix, and reproducible here. */
const envFor = (delim: string, roots: string[]) => ({
  OPENGROUND_GUARD: '1',
  OPENGROUND_GUARD_ROOT_DELIM: delim,
  OPENGROUND_GUARD_WRITE_ROOTS: roots.join(delim),
  HOME: '/Users/u',
})

const write = (env: Record<string, string>, file: string) =>
  guard({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }, env)

describe('the write-root list survives a separator inside a root (the Windows shape)', () => {
  it('a root CONTAINING the separator is not shredded — the Windows shape', () => {
    // `/wt/C:x` stands in for `C:\\wt` : a legal absolute root whose text holds a
    // colon. Joined and split with ';' (what Windows uses) it must survive whole.
    const env = envFor(';', ['/wt/C:x'])
    expect(write(env, '/wt/C:x/file.txt').decision).toBe('allow')
    expect(write(env, '/wt/C:x/deep/nested/y.ts').decision).toBe('allow')
  })

  it('…and still confines — the half that must not be traded away', () => {
    const env = envFor(';', ['/wt/C:x'])
    expect(write(env, '/etc/passwd').decision).toBe('deny')
    expect(write(env, '/wt/other/file.txt').decision).toBe('deny')
    // The shrapnel a ':' split would have produced must NOT become a root.
    expect(write(env, '/wt/x.txt').decision).toBe('deny')
  })

  it('several such roots parse as several, not as confetti', () => {
    const env = envFor(';', ['/wt/C:a', '/wt/D:b'])
    expect(write(env, '/wt/C:a/x.txt').decision).toBe('allow')
    expect(write(env, '/wt/D:b/note.md').decision).toBe('allow')
    expect(write(env, '/wt/C:c/x.txt').decision).toBe('deny')
  })

  it('POSIX is unchanged — the fix must not cost the platform that worked', () => {
    const env = envFor(':', ['/wt/swarm-a'])
    expect(write(env, '/wt/swarm-a/file.txt').decision).toBe('allow')
    expect(write(env, '/etc/passwd').decision).toBe('deny')
  })

  it('two roots on POSIX still parse as two', () => {
    const env = envFor(':', ['/wt/a', '/home/u/attachments'])
    expect(write(env, '/wt/a/x.txt').decision).toBe('allow')
    expect(write(env, '/home/u/attachments/n.md').decision).toBe('allow')
    expect(write(env, '/wt/b/x.txt').decision).toBe('deny')
  })

  it('no roots at all still confines nothing — the unguarded contract is untouched', () => {
    // An empty list means "not a confined session" (the owner's own desk), and
    // that must not become "deny everything" by accident.
    const env = { OPENGROUND_GUARD: '1', OPENGROUND_GUARD_WRITE_ROOTS: '', HOME: '/Users/u' }
    expect(write(env, '/Users/u/anything.txt').decision).toBe('allow')
  })

  it('the delimiter defaults to the PLATFORM, not to a hardcoded colon', () => {
    // Without the override the guard must use path.delimiter — which is what
    // makes it correct on a real Windows box, where no test can set the env.
    const env = {
      OPENGROUND_GUARD: '1',
      OPENGROUND_GUARD_WRITE_ROOTS: ['/wt/a', '/wt/b'].join(delimiter),
      HOME: '/Users/u',
    }
    expect(write(env, '/wt/a/x.txt').decision).toBe('allow')
    expect(write(env, '/wt/b/x.txt').decision).toBe('allow')
  })

  it('the producers join with the same separator they are parsed with', () => {
    // The two halves are in different files (and one is not even TypeScript), so
    // pin that neither drifts back to a literal ':'.
    const { readFileSync } = require('fs') as typeof import('fs')
    const root = join(__dirname, '..', '..', '..')
    for (const rel of ['src/lib/server/sdkGuardHook.ts', 'src/lib/server/claudeTerminal.ts']) {
      const src = readFileSync(join(root, rel), 'utf8').replace(/\/\/.*$/gm, '')
      expect(src, `${rel} must not colon-join the write roots`).not.toMatch(
        /WRITE_ROOTS:\s*[^\n]*\.join\(':'\)/,
      )
      expect(src, `${rel} must join with path.delimiter`).toMatch(
        /WRITE_ROOTS:\s*[^\n]*\.join\(delimiter\)/,
      )
    }
  })
})
