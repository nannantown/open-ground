import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, open } from 'fs/promises'
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

// Goal condition (1): a save FAILURE or process interruption mid-write must
// never corrupt or lose the data already on disk. The temp+rename design
// guarantees this — these tests prove the failure paths actually honour it.
describe('atomicWrite — failure & interruption resilience', () => {
  // Inject a DETERMINISTIC rename failure with no mocks: rename(file, existing
  // dir) throws EISDIR on every POSIX fs. The catch must drop the orphan temp,
  // rethrow, and leave whatever is at the destination completely untouched.
  it('a failed rename cleans up the temp file and leaves the destination intact', async () => {
    // The destination path is an existing, non-empty directory → rename over it
    // fails. Its contents stand in for "data already safely on disk".
    const dest = join(dir, 'data.json')
    await mkdir(dest)
    await writeFile(join(dest, 'precious.txt'), 'do-not-lose-me', 'utf8')

    await expect(atomicWriteJson(dest, { fresh: 1 })).rejects.toMatchObject({ code: 'EISDIR' })

    // The destination (and its contents) survived the failed write…
    expect(await readFile(join(dest, 'precious.txt'), 'utf8')).toBe('do-not-lose-me')
    // …and no orphan temp file was left behind in the parent dir.
    const orphans = (await readdir(dir)).filter((f) => f.includes('.tmp-'))
    expect(orphans).toEqual([])
  })

  it('rejects a non-serialisable value WITHOUT touching the existing file or leaving a temp', async () => {
    const path = join(dir, 'data.json')
    await atomicWriteJson(path, { good: true })
    // JSON.stringify(undefined) === undefined → writeFile rejects before any
    // rename; the existing file must be left exactly as it was.
    await expect(atomicWriteJson(path, undefined)).rejects.toBeTruthy()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ good: true })
    const entries = await readdir(dir)
    expect(entries).toEqual(['data.json']) // no orphan temp
  })

  it('a circular structure rejects and leaves the prior file intact', async () => {
    const path = join(dir, 'data.json')
    await atomicWriteJson(path, { v: 1 })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(atomicWriteJson(path, circular)).rejects.toBeTruthy()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ v: 1 })
    expect(await readdir(dir)).toEqual(['data.json'])
  })

  it('many concurrent writes to the same path all resolve to a complete, valid file (no torn write)', async () => {
    const path = join(dir, 'data.json')
    const N = 20
    // Distinct payloads; the per-process seq counter keeps each temp name unique
    // so concurrent writers never collide, and rename atomicity means the final
    // file is always ONE complete payload — never a half-written interleave.
    await Promise.all(
      Array.from({ length: N }, (_, i) => atomicWriteJson(path, { writer: i })),
    )
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { writer: number }
    expect(parsed).toHaveProperty('writer')
    expect(parsed.writer).toBeGreaterThanOrEqual(0)
    expect(parsed.writer).toBeLessThan(N)
    // No temp files survive the storm.
    const orphans = (await readdir(dir)).filter((f) => f.includes('.tmp-'))
    expect(orphans).toEqual([])
  })
})

// Goal condition (1), durability half: `fsync: true` must actually flush the
// file data (and the directory) so a POWER CUT right after a save can't surface
// an empty/zero target. We prove fsync is invoked by spying on the FileHandle
// prototype's `sync` (shared by every handle `open()` returns), which the spy
// still calls through to — so the real fsync happens AND is observed.
describe('atomicWrite — fsync durability (opt-in)', () => {
  let syncSpy: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    // Grab the shared FileHandle prototype via a throwaway handle, then spy.
    const probe = await open(join(dir, '.fsync-probe'), 'w')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncSpy = vi.spyOn(Object.getPrototypeOf(probe) as any, 'sync')
    await probe.close()
    await rm(join(dir, '.fsync-probe'), { force: true })
    syncSpy.mockClear() // ignore any sync from setup
  })
  afterEach(() => {
    syncSpy.mockRestore()
  })

  it('fsync:true flushes the data (and directory) to disk', async () => {
    await atomicWriteJson(join(dir, 'durable.json'), { a: 1 }, { fsync: true })
    // At least the file fsync; on POSIX the directory fsync adds a second call.
    expect(syncSpy).toHaveBeenCalled()
    expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('the DEFAULT write path does NOT fsync (no per-write durability cost)', async () => {
    await atomicWriteJson(join(dir, 'plain.json'), { a: 1 })
    expect(syncSpy).not.toHaveBeenCalled()
  })

  it('a durable write round-trips and leaves no temp behind', async () => {
    const path = join(dir, 'd.json')
    await atomicWriteJson(path, { x: [1, 2, 3], s: 'こんにちは' }, { fsync: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ x: [1, 2, 3], s: 'こんにちは' })
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('a durable write that fails to rename still cleans the temp and preserves the destination', async () => {
    const dest = join(dir, 'dir-target.json')
    await mkdir(dest)
    await writeFile(join(dest, 'keep.txt'), 'precious', 'utf8')
    await expect(atomicWriteJson(dest, { a: 1 }, { fsync: true })).rejects.toBeTruthy()
    expect(await readFile(join(dest, 'keep.txt'), 'utf8')).toBe('precious')
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})
