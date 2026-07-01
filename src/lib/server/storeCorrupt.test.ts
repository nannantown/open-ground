import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { dirname } from 'path'
import { getSettings, getCanvas, getNotificationState } from './store'
import { settingsFile, canvasFile, notificationsFile } from './paths'

// Goal condition (2) for the home config store: a hand-corrupted settings.json /
// canvas.json / notifications.json must never crash a reader or the boot path.
// readJson rejects a non-OBJECT top level; getSettings additionally coerces its
// array fields so a per-field type error can't crash an iterator downstream
// (scan.ts does `(settings.projects ?? []).filter(...)`). HOME is the throwaway
// test home (setup-home.ts).

const writeRaw = async (path: string, raw: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, raw, 'utf8')
}

describe('store readers — corrupt config resilience', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    // Leave a clean slate for the next test in this file.
    await rm(settingsFile(), { force: true })
    await rm(canvasFile(), { force: true })
    await rm(notificationsFile(), { force: true })
  })

  it('getSettings on unparseable JSON returns the typed defaults', async () => {
    await writeRaw(settingsFile(), '{ not valid json ,,,')
    const s = await getSettings()
    expect(Array.isArray(s.projects)).toBe(true)
    expect(s.projects).toEqual([])
  })

  it('getSettings on a non-object top level (bare string/array) returns defaults — no key pollution', async () => {
    for (const raw of ['"a string"', '[1,2,3]', '42', 'null']) {
      await writeRaw(settingsFile(), raw)
      const s = await getSettings()
      expect(Array.isArray(s.projects)).toBe(true)
      expect(Object.keys(s).some((k) => /^\d+$/.test(k))).toBe(false)
    }
  })

  it('getSettings coerces a NON-ARRAY projects field to [] (prevents the scan.ts .filter crash)', async () => {
    await writeRaw(settingsFile(), JSON.stringify({ projects: 'oops-not-an-array', defaultWorkspace: '/ws' }))
    const s = await getSettings()
    expect(s.projects).toEqual([])
    // A valid sibling field is still honoured (only the malformed one is reset).
    expect(s.defaultWorkspace).toBe('/ws')
    // The coerced list is safe to iterate the way the boot path does.
    expect(() => (s.projects ?? []).filter(Boolean)).not.toThrow()
  })

  it('getSettings drops non-object entries inside projects', async () => {
    await writeRaw(
      settingsFile(),
      JSON.stringify({
        projects: [
          { id: 'a', path: '/p/a', addedAt: 'x' },
          'garbage-string',
          null,
          42,
          { id: 'b', path: '/p/b', addedAt: 'y' },
        ],
      }),
    )
    const s = await getSettings()
    expect((s.projects ?? []).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('getSettings coerces non-array openApps / excludePatterns to safe defaults', async () => {
    await writeRaw(settingsFile(), JSON.stringify({ openApps: 'x', excludePatterns: 7 }))
    const s = await getSettings()
    expect(Array.isArray(s.openApps)).toBe(true)
    expect(s.openApps).toEqual([])
    expect(Array.isArray(s.excludePatterns)).toBe(true)
    expect(s.excludePatterns.length).toBeGreaterThan(0) // fell back to the defaults
  })

  it('getCanvas on a non-object file returns the canvas defaults', async () => {
    await writeRaw(canvasFile(), '"corrupt"')
    const c = await getCanvas()
    expect(c.positions).toEqual({})
    expect(c.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('getNotificationState on a corrupt file returns the default empty read set', async () => {
    await writeRaw(notificationsFile(), '[not, an, object')
    const n = await getNotificationState()
    expect(n.readIds).toEqual([])
  })
})
