import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWriteJson } from './atomicWrite'

// All writes go to a throwaway tmpdir — never touches the real ~/.openground.
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-atomic-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWriteJson', () => {
  it('writes pretty-printed JSON that round-trips', async () => {
    const path = join(dir, 'data.json')
    const data = { a: 1, nested: { b: [1, 2, 3] }, s: 'こんにちは' }
    await atomicWriteJson(path, data)
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toEqual(data)
    expect(raw).toContain('\n  ') // indent: 2
  })

  it('overwrites an existing file', async () => {
    const path = join(dir, 'data.json')
    await writeFile(path, JSON.stringify({ old: true }), 'utf8')
    await atomicWriteJson(path, { fresh: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ fresh: 1 })
  })

  it('leaves no temp file behind on success', async () => {
    const path = join(dir, 'data.json')
    await atomicWriteJson(path, { ok: 1 })
    const entries = await readdir(dir)
    expect(entries).toEqual(['data.json'])
  })

  it('applies the requested file mode', async () => {
    const path = join(dir, 'secret.json')
    await atomicWriteJson(path, { token: 'x' }, { mode: 0o600 })
    const s = await stat(path)
    // low 9 perm bits should be owner-only rw
    expect(s.mode & 0o777).toBe(0o600)
  })
})
