import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeConnection, knownClaudeLocations } from './claudeConnection'

// Unit coverage for the connection probe — replaces the coverage the deleted
// claudeCli.test.ts gave the old presence probe. We drive `claudeConnection`
// through the OPENGROUND_CLAUDE_BIN seam (an executable stub that answers
// `auth status`), so nothing touches the real `claude` / keychain / ~/.openground.
// `force` bypasses the 10s cache so each case is independent.

const stub = (sh: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'og-claude-stub-')), 'claude')
  writeFileSync(p, sh)
  chmodSync(p, 0o755)
  return p
}

// A stub that emits `body` (verbatim) on `auth status`, else exits non-zero.
const authStub = (body: string): string =>
  stub(`#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = status ]; then cat <<'EOF'\n${body}\nEOF\nexit 0\nfi\nexit 1\n`)

const orig = process.env.OPENGROUND_CLAUDE_BIN
afterEach(() => {
  if (orig === undefined) delete process.env.OPENGROUND_CLAUDE_BIN
  else process.env.OPENGROUND_CLAUDE_BIN = orig
})

describe('claudeConnection', () => {
  it('connected: maps loggedIn + subscriptionType + email from auth status JSON', async () => {
    process.env.OPENGROUND_CLAUDE_BIN = authStub(
      '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"x@y.z"}',
    )
    const c = await claudeConnection(true)
    expect(c.installed).toBe(true)
    expect(c.loggedIn).toBe(true)
    expect(c.plan).toBe('max')
    expect(c.email).toBe('x@y.z')
  })

  it('installed but signed out: loggedIn false, still installed', async () => {
    process.env.OPENGROUND_CLAUDE_BIN = authStub('{"loggedIn":false,"authMethod":"none"}')
    const c = await claudeConnection(true)
    expect(c.installed).toBe(true)
    expect(c.loggedIn).toBe(false)
    expect(c.plan).toBeNull()
  })

  it('not installed: a missing binary returns installed:false (never throws)', async () => {
    process.env.OPENGROUND_CLAUDE_BIN = join(tmpdir(), 'definitely-not-a-real-claude-bin')
    const c = await claudeConnection(true)
    expect(c.installed).toBe(false)
    expect(c.loggedIn).toBe(false)
  })

  it('tolerates a leading noise line before the JSON object', async () => {
    process.env.OPENGROUND_CLAUDE_BIN = authStub('a stray line\n{"loggedIn":true,"subscriptionType":"pro"}')
    const c = await claudeConnection(true)
    expect(c.installed).toBe(true)
    expect(c.loggedIn).toBe(true)
    expect(c.plan).toBe('pro')
  })

  it('non-JSON output is treated as not-usable (installed:false), not a crash', async () => {
    process.env.OPENGROUND_CLAUDE_BIN = authStub('not json at all')
    const c = await claudeConnection(true)
    expect(c.installed).toBe(false)
  })

  it('knownClaudeLocations lists absolute candidates (incl. ~/.local/bin on POSIX)', () => {
    const locs = knownClaudeLocations()
    expect(locs.length).toBeGreaterThan(0)
    expect(locs.every((p) => p.includes('claude'))).toBe(true)
    if (process.platform !== 'win32') {
      expect(locs.some((p) => p.endsWith('/.local/bin/claude'))).toBe(true)
    }
  })
})
