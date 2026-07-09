// customModules.sourceRace.test.ts — deterministic reproduction of the
// audit-856daefb hot-reload pinning race: readModuleSource must return a
// self-consistent {source, mtimeMs} snapshot even when updateModule's
// atomicWriteText (temp write + rename, i.e. an inode swap) lands in the
// middle of the read. A mismatched {old source, new mtime} pair is what
// permanently pinned the client on the stale source: CustomModuleView adopts
// a poll body only when mtimeMs moved, so the follow-up {new source, same new
// mtime} poll was discarded until the NEXT edit bumped mtime again.
//
// The fs/promises mock arms ONE race window per test: as soon as
// readModuleSource has grabbed the module's source file — open() for the
// single-fd implementation, readFile() for a path-based one — the pending
// rewrite completes before the mtime is sampled. A path-based stat()
// additionally waits until the file was grabbed AND the rewrite landed, which
// made the old broken implementation (Promise.all([readFile(path),
// stat(path)])) fail deterministically with {old source, new mtime}, while
// the single-fd implementation keeps reading the inode it opened.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createModule, readModuleSource, updateModule } from './customModules'
import { customModuleSourceFile } from './paths'

const race = vi.hoisted(() => {
  const state = {
    path: null as string | null,
    write: null as (() => Promise<unknown>) | null,
    writePromise: null as Promise<unknown> | null,
    grabbed: null as Promise<void> | null,
    signalGrabbed: null as (() => void) | null,
  }
  return {
    state,
    isTarget: (p: unknown) => state.path !== null && p === state.path,
    // First grab of the target fires the rewrite exactly once; later calls
    // just await its completion.
    async fire() {
      state.signalGrabbed?.()
      state.signalGrabbed = null
      if (!state.writePromise && state.write) state.writePromise = state.write()
      await state.writePromise
    },
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    // Single-fd read path: the handle is opened on the OLD inode, then the
    // rewrite renames a new inode into place before anything is read off it.
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (race.isTarget(args[0])) await race.fire()
      return handle
    }) as typeof actual.open,
    // Path-based read: the OLD content is returned, then the rewrite lands.
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...(args as Parameters<typeof actual.readFile>))
      if (race.isTarget(args[0])) await race.fire()
      return result
    }) as typeof actual.readFile,
    // Path-based stat: sampled only after the grab + completed rewrite, so a
    // two-syscall implementation deterministically sees the NEW mtime.
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (race.isTarget(args[0])) {
        await race.state.grabbed
        await race.fire()
      }
      return actual.stat(...(args as Parameters<typeof actual.stat>))
    }) as typeof actual.stat,
  }
})

const armRace = (path: string, write: () => Promise<unknown>) => {
  race.state.path = path
  race.state.write = write
  race.state.writePromise = null
  race.state.grabbed = new Promise<void>((resolve) => {
    race.state.signalGrabbed = resolve
  })
}

const disarmRace = () => {
  race.state.path = null
  race.state.write = null
  race.state.writePromise = null
  race.state.grabbed = null
  race.state.signalGrabbed = null
}

let home: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-module-source-race-'))
  process.env.OPENGROUND_HOME = home
  disarmRace()
})

afterEach(async () => {
  disarmRace()
  process.env.OPENGROUND_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('readModuleSource vs atomicWriteText rename (audit 856daefb)', () => {
  it('returns a self-consistent snapshot when a rewrite lands mid-read, so the mtime-gated client converges on the new source', async () => {
    const def = await createModule({ label: 'Race', description: '' })
    const path = customModuleSourceFile(def.id, 'react')
    const before = await readModuleSource(def.id)
    expect(before).not.toBeNull()

    // Keep the rewrite's mtime measurably apart from the original's.
    await new Promise((resolve) => setTimeout(resolve, 15))

    const NEW_SOURCE = 'export default () => <div>v2</div>\n'
    armRace(path, () => updateModule(def.id, { source: NEW_SOURCE }))
    const racy = await readModuleSource(def.id)
    disarmRace()
    expect(racy).not.toBeNull()

    // The next (un-raced) poll sees the settled new state.
    const after = await readModuleSource(def.id)
    expect(after?.source).toBe(NEW_SOURCE)
    expect(after?.mtimeMs).not.toBe(before?.mtimeMs)

    // Core invariant: the racy read is ONE snapshot — fully old or fully new.
    // {old source, new mtime} is the broken pair that pinned the hot reload.
    if (racy?.source === before?.source) {
      expect(racy?.mtimeMs).toBe(before?.mtimeMs)
    } else {
      expect(racy?.source).toBe(NEW_SOURCE)
      expect(racy?.mtimeMs).toBe(after?.mtimeMs)
    }

    // And therefore CustomModuleView's adopt rule (take the body only when
    // mtimeMs moved) reaches the new source instead of pinning the old one.
    const adopt = (
      prev: { source: string; mtimeMs: number } | null,
      body: { source: string; mtimeMs: number },
    ) => (prev && prev.mtimeMs === body.mtimeMs ? prev : body)
    let view = adopt(null, racy as { source: string; mtimeMs: number })
    view = adopt(view, after as { source: string; mtimeMs: number })
    expect(view.source).toBe(NEW_SOURCE)
  })
})
