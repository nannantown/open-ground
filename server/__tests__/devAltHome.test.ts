// scripts/dev-alt.mjs never runs a second instance on the app's own data folder.
// 2026-11-20: a dev:alt on the shared ~/.openground marked the live app's
// in-flight tool calls 'uncertain', and two teams stood still for three days.
//
// The real script runs; only `npx` is a stub that records the data folder it was
// handed, so no server starts.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

interface Paths { sandbox: string; user: string }
const run = (env: (paths: Paths) => Record<string, string>) => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-alt-')))
  const bin = join(sandbox, 'bin'), user = join(sandbox, 'user'), handed = join(sandbox, 'handed-home')
  // The app's data folder exists, as it does on any machine that ran the app.
  for (const dir of [bin, join(user, '.openground')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nprintf '%s' "$OPENGROUND_HOME" > '${handed}'\n`)
  chmodSync(join(bin, 'npx'), 0o755)
  const result = spawnSync(process.execPath, [resolve('scripts/dev-alt.mjs')], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: user, TMPDIR: sandbox, ...env({ sandbox, user }) },
  })
  return { status: result.status, stderr: result.stderr, handed: existsSync(handed) ? readFileSync(handed, 'utf8') : undefined, sandbox, user }
}

describe.skipIf(process.platform === 'win32')('npm run dev:alt', () => {
  it('gives the second instance its own throwaway data folder by default', () => {
    const r = run(() => ({}))
    expect(r.status).toBe(0)
    expect(r.handed).toMatch(new RegExp(`^${r.sandbox}/openground-alt-home-`))
    expect(existsSync(r.handed!)).toBe(true)
  })

  it('passes a folder chosen on purpose through', () => {
    const r = run(({ sandbox }) => { mkdirSync(join(sandbox, 'copy')); return { OPENGROUND_HOME: join(sandbox, 'copy') } })
    expect(r.status).toBe(0)
    expect(r.handed).toBe(join(r.sandbox, 'copy'))
  })

  it('refuses the app\'s own data folder, however the path is spelled', () => {
    for (const spelling of [(p: Paths) => join(p.user, '.openground'), (p: Paths) => {
      symlinkSync(join(p.user, '.openground'), join(p.sandbox, 'link-to-real-home'))
      return join(p.sandbox, 'link-to-real-home')
    }]) {
      const r = run((paths) => ({ OPENGROUND_HOME: spelling(paths) }))
      expect(r.status).toBe(1)
      expect(r.handed).toBeUndefined()
      expect(r.stderr).toMatch(/refuses OPENGROUND_HOME=.*the app's own data folder/)
    }
  })

  // macOS volumes ignore letter case by default: ~/.OpenGround is the same folder.
  const ignoresCase = (() => { const probe = mkdtempSync(join(tmpdir(), 'case-probe-')); return existsSync(join(dirname(probe), basename(probe).toUpperCase())) })()
  it.runIf(ignoresCase)('refuses it in another letter case where the file system ignores case', () => {
    const r = run(({ user }) => ({ OPENGROUND_HOME: join(user, '.OpenGround') }))
    expect(r.status).toBe(1)
    expect(r.handed).toBeUndefined()
  })
})
