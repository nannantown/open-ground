import { describe, it, expect, beforeEach } from 'vitest'
import {
  VIEW_KEY,
  loadPersistedView,
  parsePersistedView,
  savePersistedView,
  type PersistedView,
} from '@/lib/persistView'

// persistView is what makes a page reload land back where the user was: the
// open project + the panel tab. The save/restore logic is the only place a
// stale / hostile / partial localStorage blob is parsed, so these tests pin
// down that it always degrades to a safe `{}` (→ Ground) and that partial
// updates merge instead of clobbering the other field.

// Minimal in-memory Storage stand-in so the pure logic runs under the default
// `node` vitest environment (no real `window.localStorage`).
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

describe('parsePersistedView — tolerant parsing', () => {
  it('returns {} for null / empty / non-JSON input', () => {
    expect(parsePersistedView(null)).toEqual({})
    expect(parsePersistedView('')).toEqual({})
    expect(parsePersistedView('not json')).toEqual({})
  })

  it('returns {} for valid JSON that is not an object', () => {
    expect(parsePersistedView('42')).toEqual({})
    expect(parsePersistedView('"hi"')).toEqual({})
    expect(parsePersistedView('[1,2]')).toEqual({})
    expect(parsePersistedView('null')).toEqual({})
  })

  it('keeps a string projectId and a known panelTab', () => {
    expect(parsePersistedView('{"projectId":"abc","panelTab":"canvas"}')).toEqual({
      projectId: 'abc',
      panelTab: 'canvas',
    })
  })

  it('drops an empty-string projectId', () => {
    expect(parsePersistedView('{"projectId":""}')).toEqual({})
  })

  it('drops a non-string projectId and an unknown panelTab', () => {
    expect(parsePersistedView('{"projectId":123,"panelTab":"bogus"}')).toEqual({})
  })

  it('ignores unrelated extra keys', () => {
    expect(parsePersistedView('{"projectId":"abc","junk":true}')).toEqual({
      projectId: 'abc',
    })
  })
})

describe('save / load round-trip', () => {
  let storage: Storage
  beforeEach(() => {
    storage = fakeStorage()
  })

  it('persists the open project and reads it back', () => {
    savePersistedView({ projectId: 'proj-1' }, storage)
    expect(loadPersistedView(storage)).toEqual({ projectId: 'proj-1' })
  })

  it('merges partial patches instead of clobbering the other field', () => {
    savePersistedView({ projectId: 'proj-1' }, storage)
    savePersistedView({ panelTab: 'terminal' }, storage)
    expect(loadPersistedView(storage)).toEqual({
      projectId: 'proj-1',
      panelTab: 'terminal',
    })
  })

  it('clears a field when the patch sets it to undefined', () => {
    savePersistedView({ projectId: 'proj-1', panelTab: 'canvas' }, storage)
    savePersistedView({ projectId: undefined }, storage)
    expect(loadPersistedView(storage)).toEqual({ panelTab: 'canvas' })
  })

  it('removes the key entirely once both fields are cleared', () => {
    savePersistedView({ projectId: 'proj-1' }, storage)
    savePersistedView({ projectId: undefined }, storage)
    expect(storage.getItem(VIEW_KEY)).toBeNull()
    expect(loadPersistedView(storage)).toEqual({})
  })

  it('overwrites a field on a second save', () => {
    // 'tasks' is a retired tab id — a stale persisted blob may still carry it.
    // Cast through `any` to mimic that legacy value being overwritten.
    savePersistedView({ panelTab: 'tasks' as never }, storage)
    savePersistedView({ panelTab: 'canvas' }, storage)
    expect(loadPersistedView(storage)).toEqual({ panelTab: 'canvas' })
  })

  it('a patch that omits a key leaves that stored field untouched', () => {
    savePersistedView({ projectId: 'proj-1', panelTab: 'canvas' }, storage)
    // No `projectId` key in this patch → it must survive.
    const patch: PersistedView = { panelTab: 'terminal' }
    savePersistedView(patch, storage)
    expect(loadPersistedView(storage)).toEqual({
      projectId: 'proj-1',
      panelTab: 'terminal',
    })
  })
})

describe('no-storage (SSR / locked-down) safety', () => {
  it('loadPersistedView returns {} with a null storage', () => {
    expect(loadPersistedView(null)).toEqual({})
  })

  it('savePersistedView is a no-op with a null storage (does not throw)', () => {
    expect(() => savePersistedView({ projectId: 'x' }, null)).not.toThrow()
  })
})

// ─── Custom tabs (docs/CUSTOM_TABS_PLAN.md) ─────────────────────────────────
// A `custom:<uuid>` panel tab persists like a built-in. Only the SHAPE is
// validated here — existence against the live module list is ProjectPanel's
// job once the fetch lands (a vanished module falls back to the first tab).

describe('persistView with custom tab ids', () => {
  const CUSTOM = 'custom:aaaaaaaa-0000-4000-8000-000000000001'

  it('parses a custom panelTab', () => {
    expect(parsePersistedView(`{"panelTab":"${CUSTOM}"}`)).toEqual({
      panelTab: CUSTOM,
    })
  })

  it('drops the bare prefix (no module id)', () => {
    expect(parsePersistedView('{"panelTab":"custom:"}')).toEqual({})
  })

  it('round-trips a custom panelTab through save/load', () => {
    const storage = (() => {
      const map = new Map<string, string>()
      return {
        get length() {
          return map.size
        },
        clear: () => map.clear(),
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        removeItem: (k: string) => void map.delete(k),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
      } as Storage
    })()
    savePersistedView({ projectId: 'proj-1', panelTab: CUSTOM as PersistedView['panelTab'] }, storage)
    expect(loadPersistedView(storage)).toEqual({
      projectId: 'proj-1',
      panelTab: CUSTOM,
    })
  })
})
