// The adoption path of installManagedFile (managedFileInstall.ts §adoptDigests)
// and the shipped digest lists that use it (swarmToolingInstall.ts).
//
// WHAT IT PROTECTS. The ownership contract shields any target without our
// managed-by marker as user-authored. That shield was introduced AFTER some of
// those targets had already been installed by hand (the tmux-cockpit era
// ~/.claude/skills/order + skills/supply), which made OPEN GROUND's own older
// copies permanently unmanageable: every skill update after 2026-07-22 reported
// 'kept-user' and silently did not apply. Adoption closes that by NAMING the
// exact bytes we claim as ours.
//
// The risk it must never become: a heuristic that overwrites somebody's file.
// Hence the two halves below — adoption happens for listed digests and for
// NOTHING else, and one changed byte takes the file back forever.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { installManagedFile, managedFileDigest } from './managedFileInstall'
import {
  ORDER_SKILL_ADOPT_DIGESTS,
  SUPPLY_SKILL_ADOPT_DIGESTS,
  SWARM_BEAT_ADOPT_DIGESTS,
  SWARM_LIB_BASENAME,
} from './swarmToolingInstall'

const MARKER = 'managed-by: openground'

let dir: string
let source: string
let target: string

// The "previously shipped, pre-marker" text — note it carries NO marker, which
// is exactly what makes it indistinguishable from a user's file by that test.
const legacyText = '---\nname: supply\n---\n\n# supply — tmux コックピットの窓口\n'
const shippedText = `---\nname: supply\n---\n<!-- ${MARKER} -->\n\n# supply — アプリ内の窓口\n`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-adopt-'))
  source = join(dir, 'src.md')
  target = join(dir, 'home', '.claude', 'skills', 'supply', 'SKILL.md')
  await writeFile(source, shippedText, 'utf8')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const seedTarget = async (text: string) => {
  await mkdir(join(dir, 'home', '.claude', 'skills', 'supply'), { recursive: true })
  await writeFile(target, text, 'utf8')
}

describe('installManagedFile — adoption of pre-marker copies', () => {
  it('adopts a marker-less target whose digest is listed, and brings it up to date', async () => {
    await seedTarget(legacyText)
    const r = await installManagedFile({
      source,
      target,
      marker: MARKER,
      adoptDigests: [managedFileDigest(legacyText)],
    })
    expect(r.outcome).toBe('adopted')
    expect(await readFile(target, 'utf8')).toBe(shippedText)
  })

  it('is a ONE-TIME transition — the adopted file now carries the marker, so the next run is unchanged', async () => {
    await seedTarget(legacyText)
    const digests = [managedFileDigest(legacyText)]
    expect((await installManagedFile({ source, target, marker: MARKER, adoptDigests: digests })).outcome).toBe('adopted')
    // Second boot: the file is ours by marker now, and byte-identical.
    expect((await installManagedFile({ source, target, marker: MARKER, adoptDigests: digests })).outcome).toBe('unchanged')
  })

  it('does NOT adopt a marker-less target whose digest is not listed', async () => {
    const users = '---\nname: supply\n---\n\n# my own supply protocol\n'
    await seedTarget(users)
    const r = await installManagedFile({
      source,
      target,
      marker: MARKER,
      adoptDigests: [managedFileDigest(legacyText)],
    })
    expect(r.outcome).toBe('kept-user')
    expect(await readFile(target, 'utf8')).toBe(users)
  })

  it('a HAND-EDITED legacy copy is never adopted — one changed byte takes the file back', async () => {
    // The whole safety argument: adoption keys on exact bytes, so the moment a
    // user touches the file it stops being ours, permanently.
    await seedTarget(legacyText + '\n<!-- my note -->\n')
    const r = await installManagedFile({
      source,
      target,
      marker: MARKER,
      adoptDigests: [managedFileDigest(legacyText)],
    })
    expect(r.outcome).toBe('kept-user')
    expect(await readFile(target, 'utf8')).toBe(legacyText + '\n<!-- my note -->\n')
  })

  it('without adoptDigests the behaviour is byte-for-byte the old contract (kept-user)', async () => {
    await seedTarget(legacyText)
    const r = await installManagedFile({ source, target, marker: MARKER })
    expect(r.outcome).toBe('kept-user')
    expect(await readFile(target, 'utf8')).toBe(legacyText)
  })

  it('an empty adopt list adopts nothing', async () => {
    await seedTarget(legacyText)
    const r = await installManagedFile({ source, target, marker: MARKER, adoptDigests: [] })
    expect(r.outcome).toBe('kept-user')
  })

  it('a MISSING target still installs (adoption never shadows the fresh-install path)', async () => {
    const r = await installManagedFile({
      source,
      target,
      marker: MARKER,
      adoptDigests: [managedFileDigest(legacyText)],
    })
    expect(r.outcome).toBe('installed')
    expect(await readFile(target, 'utf8')).toBe(shippedText)
  })
})

describe('managedFileDigest', () => {
  it('is plain sha256 over the utf8 bytes (multibyte text included)', () => {
    const text = '補給官 — supply 窓口\n'
    expect(managedFileDigest(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(managedFileDigest(text)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('shipped adopt-digest lists', () => {
  const shipped: Record<string, string> = {
    order: join(process.cwd(), 'skills', 'order', 'SKILL.md'),
    supply: join(process.cwd(), 'skills', 'supply', 'SKILL.md'),
    'swarm-beat.sh': join(process.cwd(), 'scripts', 'swarm-beat.sh'),
  }
  const lists = [ORDER_SKILL_ADOPT_DIGESTS, SUPPLY_SKILL_ADOPT_DIGESTS, SWARM_BEAT_ADOPT_DIGESTS]

  it('are non-empty and well-formed lowercase sha256 hex', () => {
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0)
      for (const d of list) expect(d).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('never list the CURRENTLY shipped text', async () => {
    // Listing the current file would be meaningless at best (it carries the
    // marker, so adoption never runs) and actively wrong at worst: it would let
    // a shipped file that LOST its marker still be written over the user's copy.
    for (const path of Object.values(shipped)) {
      const d = managedFileDigest(await readFile(path, 'utf8'))
      for (const list of lists) expect(list).not.toContain(d)
    }
  })

  it('no digest appears in two lists (each list names its own file)', () => {
    const all = lists.flatMap((l) => [...l])
    expect(new Set(all).size).toBe(all.length)
  })

  it('the adopted swarm-beat.sh moves the heartbeat helper onto OUR installed lib', async () => {
    // The one functional change adoption makes to swarm-beat.sh. If the shipped
    // script ever went back to sourcing the user's hand-written `swarm-lib.sh`,
    // adopting would hand every worker's heartbeat to a file we do not ship.
    const beat = await readFile(shipped['swarm-beat.sh'], 'utf8')
    expect(beat).toContain(`$(dirname "$0")/${SWARM_LIB_BASENAME}`)
    expect(beat).not.toContain('"$0")/swarm-lib.sh')
  })
})
