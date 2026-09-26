import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepStaleTestHomes, TEST_HOME_PREFIX } from './testHomeSweep'

const OLD = new Date(Date.now() - 24 * 60 * 60_000)

describe('sweepStaleTestHomes', () => {
  let root = ''
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('removes only stale openground-test-home-* dirs, never anything else', async () => {
    root = mkdtempSync(join(tmpdir(), 'og-sweep-'))
    const mk = (name: string, old: boolean) => {
      const p = join(root, name)
      mkdirSync(p)
      writeFileSync(join(p, 'f'), 'x')
      if (old) utimesSync(p, OLD, OLD)
      return p
    }
    const stale = mk(`${TEST_HOME_PREFIX}aaa`, true)
    const live = mk(`${TEST_HOME_PREFIX}bbb`, false)
    const remotion = mk('remotion-webpack-bundle-ccc', true)
    const og = mk('og-reg-ddd', true)
    const target = mk('owner-data', true)
    const link = join(root, `${TEST_HOME_PREFIX}link`)
    symlinkSync(target, link)

    expect(await sweepStaleTestHomes({ root })).toBe(1)
    expect(existsSync(stale)).toBe(false)
    for (const kept of [live, remotion, og, target, link, join(target, 'f')]) expect(existsSync(kept)).toBe(true)
  })
})

describe('setup-home sandbox', () => {
  it('points the temp dir into the per-file sandbox that setup-home deletes', () => {
    // setup-home.ts ran before this file: the home and the temp dir share one sandbox.
    const home = process.env.OPENGROUND_HOME ?? ''
    expect(join(tmpdir(), 'home')).toBe(home)
    expect(tmpdir().split(/[\\/]/).pop()?.startsWith(TEST_HOME_PREFIX)).toBe(true)
  })
})

describe('setup-home removes what a test file leaves in the temp dir', () => {
  // Two files in ONE process (--no-isolate): the second must still get a sandbox
  // after the first deleted its own (which TMPDIR pointed at).
  it('a finished vitest run (also --no-isolate) leaves nothing in the temp dir it was given', () => {
    const root = mkdtempSync(join(tmpdir(), 'og-leak-root-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root }
      delete env.OPENGROUND_TEST_BASE_TMP // this process's base, not the child's
      const r = spawnSync(
        'npx',
        [
          'vitest', 'run', '--no-isolate', '--maxWorkers=1',
          'src/lib/server/__fixtures__/tmpLeakProbe.test.ts',
          'src/lib/server/claudeProjectDir.test.ts',
        ],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 120_000 },
      )
      expect(r.status, r.stdout + r.stderr).toBe(0)
      // node-compile-cache is Node's own shared module cache (reused, not a leak).
      expect(readdirSync(root).filter((n) => n !== 'node-compile-cache')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
