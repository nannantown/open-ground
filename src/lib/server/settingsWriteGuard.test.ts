// A SETTINGS FILE WE CANNOT READ MUST NOT BE OVERWRITTEN.
//
// Every settings writer in store.ts is a READ-MODIFY-WRITE: read current, merge
// the patch, write the whole object back. That is safe exactly as long as "read
// current" tells the truth. It did not: readJson swallowed every failure and
// returned DEFAULT_SETTINGS, so on a settings.json we could not read, the
// read-modify-write merged the owner's patch into the DEFAULTS and persisted
// that as the new truth.
//
// Measured 2026-08-02 (isolated HOME), before the fix:
//
//     seed  {"projects":[{a},{b}], "defaultWorkspace":"/tmp/ws"} → chmod 000
//     call  setSettings({ swarmManagerRuntime: { mode: 'pty' } })
//     after {"projects":[], "defaultWorkspace":null, …}
//
// Two registered projects to zero, no exception, no log. `atomicWriteJson` is
// tmp→rename, so the file's own 000 mode does not stop it — write permission is
// the DIRECTORY's. And `projects` is not just a list: it is the
// validateProjectPath allowlist, so losing it also unhooks every project's
// central data dir (keyed by the registry UUID).
//
// This is the shape of the 2026-07-18 incident — 45 projects to 3, canvas layout
// gone with no backup — reached by a different road. The generational backup
// added after that incident does not save this one either: snapshotBeforeWrite
// copies the CURRENT content aside, and the current content is precisely what we
// cannot read.
//
// WHY THE SWARM CARD ABOUT A RUNTIME DIAL CLOSES THIS: the same change made the
// panel and the server disagree on a broken machine (panel draws SDK, server
// runs PTY), which gives the owner a REASON to press the toggle — POST
// /api/settings → setSettings → the registry is gone. The signal needed to stop
// it (ConfigReadHealth) arrived in that same change.
//
// ABSENT IS NOT THIS CASE and must keep working: a fresh install has no
// settings.json and has to be able to write its first one.

import { describe, it, expect, afterEach } from 'vitest'
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { settingsFile } from './paths'
import {
  setSettings,
  rememberSwarmAutonomy,
  forgetSwarmAutonomy,
  rememberSwarmManualStop,
  forgetSwarmManualStop,
} from './store'

/** Two registered projects + a workspace — the state a real machine has and the
 *  state the bug erased. */
const SEED = {
  projects: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', path: '/tmp/proj-a', addedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', path: '/tmp/proj-b', addedAt: '2026-01-02T00:00:00.000Z' },
  ],
  defaultWorkspace: '/tmp/ws',
}

const seed = async (raw: string = JSON.stringify(SEED)) => {
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), raw, 'utf8')
}

/** Make the file unreadable and report whether that ACTUALLY blocks a read —
 *  root ignores the mode bits and Windows has no equivalent. */
const denyRead = async (): Promise<boolean> => {
  await chmod(settingsFile(), 0o000)
  try {
    await readFile(settingsFile(), 'utf8')
    return false
  } catch {
    return true
  }
}

/** Read the file back through fs, NOT through the store — the whole question is
 *  what is on disk, and the store's reader is the thing that was lying. */
const onDisk = async (): Promise<string> => {
  await chmod(settingsFile(), 0o600).catch(() => {})
  return readFile(settingsFile(), 'utf8')
}

afterEach(async () => {
  await chmod(settingsFile(), 0o600).catch(() => {})
  await rm(settingsFile(), { force: true }).catch(() => {})
})

describe('settings writers refuse to overwrite a settings.json they cannot read', () => {
  it('setSettings on an UNREADABLE file rejects — and the registry survives', async (ctx) => {
    await seed()
    if (!(await denyRead())) ctx.skip()

    await expect(setSettings({ swarmManagerRuntime: { mode: 'pty' } })).rejects.toThrow()

    // THE assertion. "It threw" is not enough — the bug wrote DEFAULTS and
    // returned normally, so the only proof is what is on disk afterwards.
    const after = JSON.parse(await onDisk())
    expect(after.projects).toHaveLength(2)
    expect(after.projects.map((p: { id: string }) => p.id)).toEqual(SEED.projects.map((p) => p.id))
    expect(after.defaultWorkspace).toBe('/tmp/ws')
  })

  it('setSettings on an UNPARSEABLE file rejects — the bytes are left exactly as they were', async () => {
    // The corrupt-JSON road to the same place, and the one that bites on every
    // platform (chmod does not, see denyRead). A human may still be able to
    // repair this file by hand; overwriting it destroys that chance.
    const raw = '{ "projects": [{"id":"aaaa"}],,, truncated'
    await seed(raw)

    await expect(setSettings({ defaultWorkspace: '/tmp/other' })).rejects.toThrow()
    expect(await onDisk()).toBe(raw)
  })

  it('the error says what happened in words the owner can act on', async () => {
    await seed('{ broken')
    await expect(setSettings({ defaultWorkspace: '/x' })).rejects.toThrow(/settings\.json/)
  })

  it('ABSENT still writes — a fresh install must be able to save its first settings', async () => {
    // The boundary. Closing the hole must not brick a machine that simply has
    // not written anything yet.
    await rm(settingsFile(), { force: true })
    await setSettings({ defaultWorkspace: '/tmp/fresh' })
    expect(JSON.parse(await onDisk()).defaultWorkspace).toBe('/tmp/fresh')
  })

  it('the swarm autonomy + manual-stop writers refuse too — they fire on an owner toggle', async () => {
    // These four are the ones an owner reaches by turning Autonomy on/off or
    // stopping the engine, i.e. the most likely finger on the trigger while the
    // file is broken. Same read-modify-write, same erasure.
    const raw = '{ "projects": [{"id":"aaaa"}] ,,, broken'
    for (const write of [
      () => rememberSwarmAutonomy('/tmp/proj-a'),
      () => forgetSwarmAutonomy('/tmp/proj-a'),
      () => rememberSwarmManualStop('/tmp/proj-a'),
      () => forgetSwarmManualStop('/tmp/proj-a'),
    ]) {
      await seed(raw)
      await expect(write()).rejects.toThrow()
      expect(await onDisk()).toBe(raw)
    }
  })

  it('a write to a DANGLING SYMLINK is refused — the link is not replaced by a real file', async () => {
    // docs/commander/03 claims this outcome in words ("otherwise the write
    // replaces the owner's symlink with a plain file"), and until this case
    // nothing observed it: runtimeDialFileHealth's C2 only proves the READ side
    // (the dial falls to pty). The write side is a different guarantee and it is
    // the destructive one — `atomicWriteJson` finishes with rename(tmp, path)
    // (atomicWrite.ts), which does not follow the link; it REPLACES it. A
    // dotfiles user would be silently detached from their own synced settings.
    await rm(settingsFile(), { force: true })
    await symlink(join(dirname(settingsFile()), 'nowhere.json'), settingsFile())

    await expect(setSettings({ defaultWorkspace: '/x' })).rejects.toThrow()

    // THE assertion: still a symlink, i.e. the rename never happened.
    expect((await lstat(settingsFile())).isSymbolicLink()).toBe(true)
  })

  it('a rejected write does not wedge the single-flight chain for the next caller', async () => {
    // All five writers share `settingsChain`. A guard that left a rejection
    // parked on it would turn one broken file into a permanently unsaveable
    // cockpit even after the file is repaired.
    await seed('{ broken')
    await expect(setSettings({ defaultWorkspace: '/x' })).rejects.toThrow()

    await rm(settingsFile(), { force: true })
    await setSettings({ defaultWorkspace: '/tmp/recovered' })
    expect(JSON.parse(await onDisk()).defaultWorkspace).toBe('/tmp/recovered')
  })
})
