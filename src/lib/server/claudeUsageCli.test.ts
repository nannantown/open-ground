import { describe, it, expect, vi, beforeEach } from 'vitest'

// The /usage HUD polls GET /api/usage every 60s, which calls fetchClaudeUsageCli.
// A signed-OUT interactive `claude` (spawned with no args) drops to claude's own
// sign-in screen and opens an OAuth browser — the same loop the run-route gate
// (claudeRunPreflight) was added to stop. So fetchClaudeUsageCli must gate on
// claudeConnection().loggedIn and NEVER spawn while signed out. These tests pin
// that: claudeConnection + node-pty + fs are mocked so nothing touches the real
// CLI, the keychain, or ~/.claude (existsSync→true makes findClaudeBinary
// resolve; watch→no-op keeps the activity watcher inert).

const { spawnMock, connMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  connMock: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('./claudeConnection', () => ({ claudeConnection: connMock }))
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
  invalidateUsageCache()
})

describe('fetchClaudeUsageCli — sign-in gate (no signed-out claude spawn)', () => {
  it('signed out → returns null and never spawns claude', async () => {
    connMock.mockResolvedValue({ installed: true, loggedIn: false })
    const result = await fetchClaudeUsageCli()
    expect(result).toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('not installed → returns null and never spawns claude', async () => {
    connMock.mockResolvedValue({ installed: false, loggedIn: false })
    const result = await fetchClaudeUsageCli()
    expect(result).toBeNull()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('signed in → the gate passes and the spawn is attempted', async () => {
    connMock.mockResolvedValue({ installed: true, loggedIn: true })
    // Throw from spawn so drive() resolves immediately (no PTY, no boot timers)
    // — we only assert the gate let it through. A real failure here degrades to
    // null, and the HUD falls back to its local-jsonl estimate.
    spawnMock.mockImplementation(() => {
      throw new Error('no pty in test')
    })
    const result = await fetchClaudeUsageCli()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()
  })
})
