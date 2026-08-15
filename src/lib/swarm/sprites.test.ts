import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  ACTIVITY_STATE,
  BEACON_SPRITE,
  SPRITES,
  SPRITE_COLORS,
  SPRITE_EYE,
  SPRITE_SIZE,
  spriteStateFor,
  type SpriteRole,
} from './sprites'

const ROLES: SpriteRole[] = ['supply', 'commander', 'worker']

describe('the sprites are drawable at all', () => {
  it('every role is exactly 16×16, with no stray characters', () => {
    // A ragged row shifts every pixel after it, and at 16px that is the
    // difference between an animal and a smear. Cheap to check, impossible to
    // see in a diff.
    for (const role of ROLES) {
      const map = SPRITES[role]
      expect(map, role).toHaveLength(SPRITE_SIZE)
      for (let i = 0; i < map.length; i++) {
        expect(map[i].length, `${role} row ${i}`).toBe(SPRITE_SIZE)
        expect(map[i], `${role} row ${i}`).toMatch(/^[.#oew]+$/)
      }
    }
  })

  it('every role has EYES — the one thing that makes it read as a face', () => {
    for (const role of ROLES) {
      const eyes = SPRITES[role].join('').split('').filter((c) => c === 'e').length
      expect(eyes, `${role} has no eyes`).toBeGreaterThanOrEqual(2)
    }
  })

  it('the three roles are actually DIFFERENT drawings', () => {
    // The failure this guards: copying a map to add a role and forgetting to
    // change it, which at 16px nobody would notice on a card.
    const joined = ROLES.map((r) => SPRITES[r].join('\n'))
    expect(new Set(joined).size).toBe(ROLES.length)
  })

  it('the ROLES are told apart by silhouette, not only by colour', () => {
    // Colour is the STATE. If two roles share an outline they are
    // indistinguishable on a card that is showing the same state for both —
    // which is the normal case when a commander and a worker are both running.
    const silhouette = (r: SpriteRole) =>
      SPRITES[r].map((row) => row.replace(/[#oew]/g, '#')).join('\n')
    const sils = ROLES.map(silhouette)
    expect(new Set(sils).size).toBe(ROLES.length)
  })
})

describe('the state palette', () => {
  it('covers EVERY state, read from the type in this file', () => {
    // Derived from the source rather than a transcribed list, so a sixth state
    // cannot be added with no colour and render an invisible figure. (The
    // Record type already makes that a build error; this proves the claim and
    // catches a `Partial<>` weakening it.)
    const src = readFileSync(path.join(process.cwd(), 'src/lib/swarm/sprites.ts'), 'utf8')
    const decl = 'export type SpriteState ='
    const start = src.indexOf(decl)
    expect(start, 'SpriteState not found — renamed or moved?').toBeGreaterThan(-1)
    const body = src.slice(start + decl.length).split('\n')[0]
    const members = Array.from(body.matchAll(/'([^']+)'/g), (m) => m[1])
    expect(members.length).toBeGreaterThanOrEqual(5)   // parser self-check
    expect(members).toContain('asking')
    for (const m of members) {
      const c = SPRITE_COLORS[m as keyof typeof SPRITE_COLORS]
      expect(c, `state '${m}' has no colour`).toBeTruthy()
      for (const k of ['body', 'shade', 'light'] as const) {
        expect(c[k], `${m}.${k}`).toMatch(/^#[0-9A-Fa-f]{6}$/)
      }
    }
  })

  it('the EYE never takes a state colour', () => {
    // A figure whose eyes turn green stops reading as a face at 16px.
    const eye = SPRITE_EYE.toLowerCase()
    for (const c of Object.values(SPRITE_COLORS)) {
      expect(c.body.toLowerCase()).not.toBe(eye)
      expect(c.light.toLowerCase()).not.toBe(eye)
    }
  })

  it('gives each ATTENTION level a distinct colour', () => {
    // working / waiting / asking must never share a body colour — they are the
    // three the owner reads at a glance to decide whether to look.
    const three = ['working', 'waiting', 'asking'] as const
    expect(new Set(three.map((s) => SPRITE_COLORS[s].body)).size).toBe(3)
  })
})

describe('spriteStateFor — what a card shows', () => {
  it('maps each worker activity straight through', () => {
    for (const a of ['starting', 'working', 'waiting', 'done'] as const) {
      expect(spriteStateFor({ activity: a })).toBe(ACTIVITY_STATE[a])
    }
  })

  it('ASKING outranks everything, including working', () => {
    // A swarm carrying on elsewhere does not make the owner's answer less
    // needed, and this is the only state that is a claim on their attention.
    for (const a of ['starting', 'working', 'waiting', 'done'] as const) {
      expect(spriteStateFor({ activity: a, asking: true }), a).toBe('asking')
    }
  })

  it('asking=false is not asking', () => {
    expect(spriteStateFor({ activity: 'working', asking: false })).toBe('working')
  })
})

describe('BEACON_SPRITE — the Swarm tab tiles', () => {
  it('gives every LIVE beacon word a figure', () => {
    for (const s of ['working', 'waiting', 'starting'] as const) {
      expect(BEACON_SPRITE[s], s).toBeTruthy()
    }
  })

  it('draws NOTHING for a process that has exited', () => {
    // ⚠ Every state in the set is a claim that somebody is THERE. A dimmed
    // animal on a dead tile is a picture of a worker who does not exist — and
    // the tiles it appears on are the ones the owner uses to decide whether the
    // swarm is still running.
    expect(BEACON_SPRITE.exited).toBeNull()
  })

  it('does not invent a state the palette cannot draw', () => {
    for (const st of Object.values(BEACON_SPRITE)) {
      if (st === null) continue
      expect(SPRITE_COLORS[st], st).toBeTruthy()
    }
  })
})
