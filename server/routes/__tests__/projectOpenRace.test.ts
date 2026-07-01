import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import * as store from '@/lib/server/store'
import { getSettings, setSettings } from '@/lib/server/store'
import { addProjectEntry } from '@/lib/server/registry'

// Regression guard for the PUT /api/project/open lost-update (audit MAJOR).
//
// THE BUG: the handler did
//     const s = await getSettings()              // full snapshot, OFF the lock
//     await setSettings({ ...s, openApps: cleaned })
// setSettings is a single-flight read-modify-write: it re-reads `current` INSIDE
// its lock and writes `{...current, ...patch}`. That serialisation only protects
// concurrent writers when each PATCHES JUST THE KEYS IT OWNS — the re-read picks
// up everyone else's changes. By spreading the entire stale snapshot `s` into the
// patch, the handler re-injected the read-time value of EVERY key (incl.
// `projects`, the validateProjectPath allowlist) on write. So a project
// registered between this handler's read and its write was REVERTED — silently
// dropped from the registry/allowlist. The fix patches only `{ openApps }`.
//
// HOME is redirected to a throwaway tmp dir by ./src/test/setup-home.ts, so every
// write here lands in an isolated registry — never the real ~/.openground.

const putOpen = (apps: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apps }),
})

describe('PUT /api/project/open — lost-update (stale snapshot spread) guard', () => {
  beforeEach(async () => {
    // Known openApps baseline so a leftover value can't mask a failure. Projects
    // are left as-is (this file's tests only ever ADD them and assert by id).
    await setSettings({ openApps: [] })
  })

  it('patches ONLY openApps — it must not spread a full settings snapshot', async () => {
    // Deterministic teeth: assert the exact patch shape. The bug passed
    // `{...s, openApps}` (every key, incl. `projects`); the fix passes just
    // `{ openApps }`. spyOn calls through, so persistence still happens.
    const spy = vi.spyOn(store, 'setSettings')
    try {
      const res = await app.request('/api/project/open', putOpen([{ name: 'Cursor' }]))
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)
      const patch = spy.mock.calls[0][0] as Record<string, unknown>
      expect(Object.keys(patch)).toEqual(['openApps'])
      expect('projects' in patch).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('still persists the openApps save (the route’s actual job)', async () => {
    const res = await app.request(
      '/api/project/open',
      // duplicate + bare-string forms prove normalizeOpenApps still runs
      putOpen([{ name: 'Warp' }, { name: 'Warp' }, 'Ghostty']),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { apps: unknown }
    expect(body.apps).toEqual([
      { name: 'Warp', mode: 'open' },
      { name: 'Ghostty', mode: 'open' },
    ])
    const s = await getSettings()
    expect(s.openApps).toEqual([
      { name: 'Warp', mode: 'open' },
      { name: 'Ghostty', mode: 'open' },
    ])
  })

  it('a project registered CONCURRENTLY with the open-save is not reverted', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'og-open-race-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'og-open-race-b-'))
    const a = await addProjectEntry(dirA) // baseline registered project

    // Fire the openApps save and a SECOND registration concurrently. With the
    // bug, PUT open's stale-snapshot write reverts `projects` to the value it
    // read before B was added (dropping B from the validateProjectPath
    // allowlist). With the fix, the openApps-only patch leaves `projects`
    // intact under any interleaving — both registrations survive and the
    // open-save still lands.
    const [res, b] = await Promise.all([
      app.request('/api/project/open', putOpen([{ name: 'iTerm' }])),
      addProjectEntry(dirB),
    ])
    expect(res.status).toBe(200)

    const s = await getSettings()
    const ids = (s.projects ?? []).map((e) => e.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(s.openApps).toEqual([{ name: 'iTerm', mode: 'open' }])
  })
})
