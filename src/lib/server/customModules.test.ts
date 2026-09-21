import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createModule,
  deleteModule,
  getModule,
  isValidModuleId,
  listModules,
  readModuleSource,
  starterSource,
  updateModule,
} from './customModules'
import { customModuleDir, customModuleSourceFile, customModulesIndexFile } from './paths'

// Disk CRUD for custom tab modules. Each test gets its own OPENGROUND_HOME so
// index.json / module dirs are hermetic (the suite-wide tmp HOME from
// setup-home.ts is also fine, but a per-test dir keeps cases independent).

let home: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-custom-modules-'))
  process.env.OPENGROUND_HOME = home
})

afterEach(async () => {
  process.env.OPENGROUND_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('isValidModuleId — the traversal guard', () => {
  it('accepts a bare uuid (either case)', () => {
    expect(isValidModuleId('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
    expect(isValidModuleId('123E4567-E89B-42D3-A456-426614174000')).toBe(true)
  })

  it('rejects traversal and non-uuid shapes before any path is built', () => {
    for (const bad of [
      '',
      '..',
      '../../../etc/passwd',
      '123e4567-e89b-42d3-a456-426614174000/../other',
      'x123e4567-e89b-42d3-a456-426614174000',
      '123e4567e89b42d3a456426614174000',
      'index',
    ]) {
      expect(isValidModuleId(bad)).toBe(false)
    }
  })
})

describe('createModule / listModules / getModule', () => {
  it('creates a local module with a starter source file and indexes it', async () => {
    const def = await createModule({ label: 'My Tab', description: 'A test tab' })
    expect(isValidModuleId(def.id)).toBe(true)
    expect(def.origin).toBe('local')
    expect(def.framework).toBe('react')

    expect(await listModules()).toEqual([def])
    expect(await getModule(def.id)).toEqual(def)

    const source = await readFile(customModuleSourceFile(def.id, 'react'), 'utf8')
    expect(source).toContain('"My Tab"')
    expect(source).toContain('"A test tab"')
    expect(source).toContain('export default function')
  })

  it('html framework writes source.html instead', async () => {
    const def = await createModule({ label: 'H', description: 'd', framework: 'html' })
    expect(def.framework).toBe('html')
    const source = await readFile(customModuleSourceFile(def.id, 'html'), 'utf8')
    expect(source).toContain('<!doctype html>')
  })

  it('survives concurrent creates (serialized index writes)', async () => {
    const defs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createModule({ label: `Tab ${i}`, description: '' }),
      ),
    )
    const listed = await listModules()
    expect(listed).toHaveLength(5)
    expect(new Set(listed.map((d) => d.id))).toEqual(new Set(defs.map((d) => d.id)))
  })

  it('getModule rejects an invalid id without touching the index', async () => {
    expect(await getModule('../../etc')).toBeNull()
  })
})

describe('readModuleSource', () => {
  it('returns the source + mtimeMs for a known module', async () => {
    const def = await createModule({ label: 'T', description: '' })
    const res = await readModuleSource(def.id)
    expect(res?.source).toContain('export default function')
    expect(typeof res?.mtimeMs).toBe('number')
  })

  it('null for invalid / unknown ids', async () => {
    expect(await readModuleSource('../traversal')).toBeNull()
    expect(await readModuleSource('123e4567-e89b-42d3-a456-426614174000')).toBeNull()
  })

  it('null when the source file vanished under a known module', async () => {
    const def = await createModule({ label: 'V', description: '' })
    await rm(customModuleSourceFile(def.id, 'react'))
    expect(await readModuleSource(def.id)).toBeNull()
  })
})

describe('updateModule', () => {
  it('patches label/description and overwrites the source', async () => {
    const def = await createModule({ label: 'Before', description: 'old' })
    const updated = await updateModule(def.id, {
      label: 'After',
      source: 'export default () => null\n',
    })
    expect(updated?.label).toBe('After')
    expect(updated?.description).toBe('old')
    expect((await readModuleSource(def.id))?.source).toBe('export default () => null\n')
  })

  it('null for invalid / unknown ids', async () => {
    expect(await updateModule('../nope', { label: 'x' })).toBeNull()
    expect(await updateModule('123e4567-e89b-42d3-a456-426614174000', { label: 'x' })).toBeNull()
  })
})

describe('deleteModule', () => {
  it('removes the dir and the index entry', async () => {
    const def = await createModule({ label: 'Gone', description: '' })
    expect(await deleteModule(def.id)).toBe(true)
    expect(await listModules()).toEqual([])
    await expect(stat(customModuleDir(def.id))).rejects.toThrow()
    // index.json itself survives (empty array).
    expect(JSON.parse(await readFile(customModulesIndexFile(), 'utf8'))).toEqual([])
  })

  it('false for invalid / unknown ids', async () => {
    expect(await deleteModule('../nope')).toBe(false)
    expect(await deleteModule('123e4567-e89b-42d3-a456-426614174000')).toBe(false)
  })
})

describe('starterSource', () => {
  it('inlines label/description safely (quotes cannot break out)', () => {
    const src = starterSource('He said "hi"', 'line\nbreak', 'react')
    expect(src).toContain(JSON.stringify('He said "hi"'))
    expect(src).toContain(JSON.stringify('line\nbreak'))
  })

  it('escapes HTML entities in the html flavor', () => {
    const src = starterSource('<script>', 'a & b', 'html')
    expect(src).toContain('&lt;script&gt;')
    expect(src).toContain('a &amp; b')
    expect(src).not.toContain('<script>')
  })
})
