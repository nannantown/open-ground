import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setSettings } from './store'

// Regression guard for the setSettings lost-update race. setSettings is a
// read-modify-write (read current → merge patch → write). Before serialisation,
// two concurrent calls patching DIFFERENT keys would each read the same
// `current` and the second write would revert the first caller's key. The
// single-flight chain makes each call re-read inside the lock, so all patches
// survive. HOME is isolated to a tmp dir by the global test setup, so these
// writes never touch the real ~/.openground.

describe('setSettings concurrent-patch serialisation (lost-update race)', () => {
  beforeEach(async () => {
    // Known baseline so a reverted key is detectable.
    await setSettings({ defaultWorkspace: 'OLD', projectsMigratedAt: 'OLD', archiveDirName: 'OLD' })
  })

  it('concurrent patches to different keys all survive (none reverted)', async () => {
    await Promise.all([
      setSettings({ defaultWorkspace: '/tmp/og-ws' }),
      setSettings({ projectsMigratedAt: '2026-01-02T03:04:05.000Z' }),
      setSettings({ archiveDirName: '_arc' }),
    ])
    const s = await getSettings()
    // The bug: a concurrent patch read stale `current` and wrote it back,
    // reverting another caller's key to 'OLD'. With serialisation all three win.
    expect(s.defaultWorkspace).toBe('/tmp/og-ws')
    expect(s.projectsMigratedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(s.archiveDirName).toBe('_arc')
  })
})
