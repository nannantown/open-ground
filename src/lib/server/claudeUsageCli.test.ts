import { describe, it, expect, vi, beforeEach } from 'vitest'

// The /usage HUD polls GET /api/usage every 60s, which calls fetchClaudeUsageCli.
// A signed-OUT interactive `claude` (spawned with no args) drops to claude's own
// sign-in screen and opens an OAuth browser — the same loop the run-route gate
// (claudeRunPreflight) was added to stop. So fetchClaudeUsageCli must gate on
// claudeConnection().loggedIn and NEVER spawn while signed out. These tests pin
// that AND the explicit-status contract that replaced the old "return null on
// any failure" — every result carries a `status` reason so the HUD never shows
// a silent "—". claudeConnection + node-pty + fs are mocked so nothing touches
// the real CLI, the keychain, or ~/.claude (binMock makes findClaudeBinary
// resolve a path; watch→no-op keeps the activity watcher inert).

const { spawnMock, connMock, binMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  connMock: vi.fn(),
  binMock: vi.fn<() => string | null>(() => '/usr/local/bin/claude'),
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
// findClaudeBinary resolves through claudeConnection's robust resolver
// (resolvedClaudeBin → absoluteClaudeOnPath); both are mocked to binMock so the
// gate tests control whether a binary "exists" without touching the real PATH.
vi.mock('./claudeConnection', () => ({
  claudeConnection: connMock,
  resolvedClaudeBin: () => binMock(),
  absoluteClaudeOnPath: () => binMock(),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: () => true,
    watch: () => ({ unref: () => {}, close: () => {} }),
  }
})

import { fetchClaudeUsageCli, invalidateUsageCache } from './claudeUsageCli'

beforeEach(() => {
  spawnMock.mockReset()
  connMock.mockReset()
  binMock.mockReset()
  binMock.mockReturnValue('/usr/local/bin/claude')
  invalidateUsageCache()
})

describe('fetchClaudeUsageCli — sign-in gate + explicit status', () => {
  it('signed out → status "signed-out", null slots, never spawns claude', async () => {
    connMock.mockResolvedValue({ installed: true, loggedIn: false })
    const result = await fetchClaudeUsageCli()
    expect(result.status).toBe('signed-out')
    expect(result.session).toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('not installed → status "not-installed", never spawns claude', async () => {
    connMock.mockResolvedValue({ installed: false, loggedIn: false })
    const result = await fetchClaudeUsageCli()
    expect(result.status).toBe('not-installed')
    expect(result.session).toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('signed in but no binary found → status "not-installed", never spawns', async () => {
    // Defensive: loggedIn normally implies installed, but if the binary resolver
    // comes back empty we report not-installed rather than spawning a bare name.
    connMock.mockResolvedValue({ installed: true, loggedIn: true })
    binMock.mockReturnValue(null)
    const result = await fetchClaudeUsageCli()
    expect(result.status).toBe('not-installed')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('signed in → the gate passes, spawn attempted, failure → scrape-failed', async () => {
    connMock.mockResolvedValue({ installed: true, loggedIn: true })
    // Throw from spawn so drive() resolves immediately (no PTY, no boot timers)
    // — we assert the gate let it through AND that a spawn failure surfaces as
    // an explicit scrape-failed reason (the HUD then falls back to local jsonl).
    spawnMock.mockImplementation(() => {
      throw new Error('no pty in test')
    })
    const result = await fetchClaudeUsageCli()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('scrape-failed')
    expect(result.session).toBeNull()
  })
})
