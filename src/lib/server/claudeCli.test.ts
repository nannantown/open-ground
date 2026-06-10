import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolve } from 'path'
import { probeClaudeCli } from './claudeCli'

// The launch-binary seam (OPENGROUND_CLAUDE_BIN) must apply to the readiness
// probe too, otherwise a machine without the real `claude` (CI, the E2E suite)
// gets installed:false and every run is 503'd before it can spawn the stub.
const FAKE = resolve(__dirname, '../../../e2e/fixtures/fake-claude.sh')

describe('probeClaudeCli launch-binary seam (OPENGROUND_CLAUDE_BIN)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reports installed when OPENGROUND_CLAUDE_BIN points at the stub', async () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', FAKE)
    // force=true bypasses the 10s cache so we read this env, not a prior probe.
    const probe = await probeClaudeCli(true)
    expect(probe.installed).toBe(true)
    expect(probe.version).toContain('fake-claude')
  })

  it('reports missing when pointed at a nonexistent binary', async () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', '/no/such/claude-binary-xyz')
    const probe = await probeClaudeCli(true)
    expect(probe.installed).toBe(false)
    expect(probe.version).toBeNull()
  })
})
