import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readdir, realpath } from 'fs/promises'
import {
  KNOWN_EDITORS,
  detectInstalledEditors,
  resolveAllowedEditorBundle,
} from './editorDetect'

// detectInstalledEditors scans the macOS Applications dirs (readdir) and maps
// known editor .app bundles to launchable {name, path, mode:'open'} OpenApps,
// in KNOWN_EDITORS priority order (NOT directory order). os.homedir is pinned
// so the per-user Applications dir is deterministic.

vi.mock('fs/promises', () => ({ readdir: vi.fn(), realpath: vi.fn() }))
vi.mock('os', () => ({ homedir: () => '/Users/test' }))

const realPlatform = process.platform
const setPlatform = (p: string) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true })

afterEach(() => {
  setPlatform(realPlatform)
  vi.mocked(readdir).mockReset()
  vi.mocked(realpath).mockReset()
})

describe('detectInstalledEditors', () => {
  it('returns [] on non-macOS without touching the filesystem', async () => {
    setPlatform('win32')
    expect(await detectInstalledEditors()).toEqual([])
    expect(readdir).not.toHaveBeenCalled()
  })

  it('maps installed bundles to OpenApps in catalogue priority order', async () => {
    setPlatform('darwin')
    // The directory listing order is deliberately NOT the catalogue order.
    vi.mocked(readdir).mockImplementation(async (dir: any) => {
      if (dir === '/Applications')
        return ['Zed.app', 'Visual Studio Code.app', 'Numbers.app'] as any
      if (dir === '/Users/test/Applications') return ['Cursor.app'] as any
      return [] as any
    })
    const editors = await detectInstalledEditors()
    // Cursor (1st in catalogue) → VS Code → Zed, regardless of where each lives.
    expect(editors.map((e) => e.name)).toEqual(['Cursor', 'Visual Studio Code', 'Zed'])
    expect(editors[0]).toEqual({
      name: 'Cursor',
      path: '/Users/test/Applications/Cursor.app',
      mode: 'open',
    })
  })

  it('resolves an alias bundle to its canonical display name', async () => {
    setPlatform('darwin')
    vi.mocked(readdir).mockImplementation(
      async (dir: any) => (dir === '/Applications' ? ['IntelliJ IDEA CE.app'] : []) as any,
    )
    expect(await detectInstalledEditors()).toEqual([
      { name: 'IntelliJ IDEA', path: '/Applications/IntelliJ IDEA CE.app', mode: 'open' },
    ])
  })

  it('lists one entry per editor even when several variants are installed', async () => {
    setPlatform('darwin')
    vi.mocked(readdir).mockImplementation(
      async (dir: any) =>
        (dir === '/Applications' ? ['PyCharm.app', 'PyCharm CE.app'] : []) as any,
    )
    const editors = await detectInstalledEditors()
    expect(editors.filter((e) => e.name === 'PyCharm')).toHaveLength(1)
    // The primary bundle wins over the alias when both exist.
    expect(editors[0].path).toBe('/Applications/PyCharm.app')
  })

  it('skips unreadable dirs and non-.app entries', async () => {
    setPlatform('darwin')
    vi.mocked(readdir).mockImplementation(async (dir: any) => {
      if (dir === '/Applications') return ['Cursor.app', 'README.txt', '.DS_Store'] as any
      throw new Error('ENOENT') // /System/Applications + ~/Applications absent
    })
    expect(await detectInstalledEditors()).toEqual([
      { name: 'Cursor', path: '/Applications/Cursor.app', mode: 'open' },
    ])
  })

  it('returns [] when no known editor is installed', async () => {
    setPlatform('darwin')
    vi.mocked(readdir).mockResolvedValue(['Numbers.app', 'Safari.app'] as any)
    expect(await detectInstalledEditors()).toEqual([])
  })
})

describe('KNOWN_EDITORS catalogue', () => {
  it('has unique, non-empty display names', () => {
    const names = KNOWN_EDITORS.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
    for (const e of KNOWN_EDITORS) expect(e.name.trim()).toBeTruthy()
  })

  it('no alias collides with a primary name (so mapping is unambiguous)', () => {
    const primaries = new Set(KNOWN_EDITORS.map((e) => e.name))
    const aliases = KNOWN_EDITORS.flatMap((e) => e.aliases ?? [])
    expect(new Set(aliases).size).toBe(aliases.length) // aliases unique
    for (const a of aliases) expect(primaries.has(a)).toBe(false)
  })
})

describe('resolveAllowedEditorBundle (launch allowlist)', () => {
  // realpath: Applications dirs resolve to themselves; bundles resolve as noted
  // (one symlink deliberately escapes the allowlist); everything else ENOENT.
  beforeEach(() => {
    const known: Record<string, string> = {
      '/Applications': '/Applications',
      '/System/Applications': '/System/Applications',
      '/Users/test/Applications': '/Users/test/Applications',
      '/Applications/Cursor.app': '/Applications/Cursor.app',
      '/System/Applications/Xcode.app': '/System/Applications/Xcode.app',
      '/Users/test/Applications/Foo.app': '/Users/test/Applications/Foo.app',
      '/tmp/evil.app': '/tmp/evil.app',
      '/Applications/link.app': '/tmp/evil.app', // symlink escaping the allowlist
    }
    vi.mocked(realpath).mockImplementation(async (p: any) => {
      if (p in known) return known[p] as any
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  })

  it('rejects a path that is not a .app (no launch surface)', async () => {
    expect(await resolveAllowedEditorBundle('/Applications/Cursor')).toBeNull()
    expect(await resolveAllowedEditorBundle('/etc/passwd')).toBeNull()
  })

  it('rejects a bundle that does not exist', async () => {
    expect(await resolveAllowedEditorBundle('/Applications/Gone.app')).toBeNull()
  })

  it('accepts a real .app directly inside an Applications dir', async () => {
    expect(await resolveAllowedEditorBundle('/Applications/Cursor.app')).toBe(
      '/Applications/Cursor.app',
    )
    expect(await resolveAllowedEditorBundle('/System/Applications/Xcode.app')).toBe(
      '/System/Applications/Xcode.app',
    )
    expect(await resolveAllowedEditorBundle('/Users/test/Applications/Foo.app')).toBe(
      '/Users/test/Applications/Foo.app',
    )
  })

  it('rejects a .app outside the allowlist (e.g. /tmp) — the open -a RCE vector', async () => {
    expect(await resolveAllowedEditorBundle('/tmp/evil.app')).toBeNull()
  })

  it('rejects a symlink inside /Applications that resolves outside the allowlist', async () => {
    // realpath collapses /Applications/link.app → /tmp/evil.app, whose parent
    // /tmp is not allowed, so the launch is refused.
    expect(await resolveAllowedEditorBundle('/Applications/link.app')).toBeNull()
  })
})
