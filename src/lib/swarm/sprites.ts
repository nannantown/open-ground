// sprites — the three swarm roles as 16×16 pixel figures.
//
// WHY PIXEL MAPS AS TEXT, not image files. A sprite sheet is opaque: nobody can
// review it, a one-pixel fix needs an editor, and it cannot take the theme's
// colours. These are rows of characters, so an ear gets longer by changing one
// letter in a diff, and the palette is applied at draw time — which is what lets
// ONE drawing serve every state instead of five near-identical pictures.
//
// WHAT THE ANIMALS MEAN (owner's design, 2026-08-15):
//   otter  = 供給係   the front desk. Takes a vague request and files it as a card.
//   owl    = 司令官   the floor manager. Deals cards out, inspects, integrates.
//   rabbit = 作業者   one per card, in its own isolated worktree. Many at once.
//
// THE SIZE IS THE CONSTRAINT. These render at 16px on a Board card, so the test
// is not "is it cute at 5×" but "can you tell the role and the state apart at
// actual size". That is why the eye is the one thing that never takes the state
// colour (a face must stay a face), and why each state MOVES differently — at
// 16px motion reads before hue does.

import type { WorkerBeaconStatus } from '@/lib/workerBeacon'

/** Who is on the card. */
export type SpriteRole = 'supply' | 'commander' | 'worker'

/** What they are doing. Four of these mirror WorkerActivity exactly; `asking` is
 *  the fifth and comes from a DIFFERENT source — an open escalation naming the
 *  card — so it is deliberately not folded into that union. Confusing "the
 *  worker is idle" with "the worker is asking you something" would be the same
 *  class of lie this app has spent the week removing. */
export type SpriteState = 'starting' | 'working' | 'waiting' | 'asking' | 'done'

/** Palette per state. EXHAUSTIVE over SpriteState on purpose: adding a sixth
 *  state fails this line at build time rather than rendering an invisible
 *  figure, which is the repo's rule for a mapping whose gap would be silent. */
export const SPRITE_COLORS: Record<
  SpriteState,
  { body: string; shade: string; light: string }
> = {
  // og-line-strong — alive but not yet doing anything
  starting: { body: '#6B5A48', shade: '#4A3D31', light: '#8A7660' },
  // og-moss — the running lamp, same green the rest of the app uses for "going"
  working: { body: '#9DB36B', shade: '#71834C', light: '#D6E0BE' },
  // og-ochre — the waiting lamp
  waiting: { body: '#DDAE58', shade: '#A67F3B', light: '#F0DCB4' },
  // og-accent — reserved for the one state that is a claim on the owner
  asking: { body: '#F29580', shade: '#B96A58', light: '#FBD3C8' },
  // fades out; drawn in the starting palette because it is leaving, not working
  done: { body: '#6B5A48', shade: '#4A3D31', light: '#8A7660' },
}

/** The eye. Never takes the state colour — a figure whose eyes turn green stops
 *  reading as a face at 16px, which is the only size that matters here. */
export const SPRITE_EYE = '#1A1410'

/** Pixel legend: `.` transparent · `#` body · `o` shadow · `e` eye · `w` light */
export const SPRITES: Record<SpriteRole, readonly string[]> = {
  // カワウソ — round head, small ears, thick tail, holding its ledger.
  supply: [
    '................',
    '................',
    '....########....',
    '...##########...',
    '..############..',
    '..##e######e##..',
    '..############..',
    '...###wwww###...',
    '....##.ww.##....',
    '...##########...',
    '..############..',
    '..###ww#####o...',
    '..###ww#####oo..',
    '...#########oo..',
    '....##...##.....',
    '................',
  ],
  // フクロウ — ear tufts and big eyes, the two things that survive at 16px and
  // keep it from being mistaken for the otter.
  commander: [
    '................',
    '..##........##..',
    '..###......###..',
    '..############..',
    '.##############.',
    '.###ee####ee###.',
    '.##eeee##eeee##.',
    '.###ee####ee###.',
    '..#####oo#####..',
    '..############..',
    '..####ooo#####..',
    '..###ooooo####..',
    '..############..',
    '...##########...',
    '....##....##....',
    '................',
  ],
  // ウサギ — the ears run the full height, which is the one silhouette cue that
  // still works when the figure is 16 pixels tall.
  worker: [
    '..##........##..',
    '..##........##..',
    '..##........##..',
    '..###......###..',
    '...##########...',
    '...##e####e##...',
    '...##########...',
    '....###ww###....',
    '....########....',
    '...##########...',
    '..############..',
    '..###......###..',
    '..###......###..',
    '...##########...',
    '....##....##....',
    '................',
  ],
}

/** Width and height of every sprite, in pixels. */
export const SPRITE_SIZE = 16

/** WorkerActivity → SpriteState. Exhaustive, so the day a fifth activity is
 *  added this stops compiling instead of rendering the wrong animal state.
 *  `asking` is absent BY DESIGN — nothing in WorkerActivity means it. */
export const ACTIVITY_STATE: Record<'starting' | 'working' | 'waiting' | 'done', SpriteState> = {
  starting: 'starting',
  working: 'working',
  waiting: 'waiting',
  done: 'done',
}

/** Swarm-tab beacon word → the figure's state, for the panes that show a live
 *  desk or worker tile.
 *
 *  EXHAUSTIVE, and `exited` maps to `null` — no figure — on purpose. Every state
 *  in the set is a claim that somebody is THERE; drawing a dimmed animal for a
 *  process that has gone would be a picture of a worker that no longer exists.
 *  Those tiles keep their plain dot, which says "off" without pretending. */
export const BEACON_SPRITE: Record<WorkerBeaconStatus, SpriteState | null> = {
  working: 'working',
  waiting: 'waiting',
  starting: 'starting',
  exited: null,
}

/**
 * The state to draw for a card.
 *
 * `asking` OUTRANKS everything, including `working`: a swarm that carries on
 * elsewhere does not make the owner's answer less needed, and this is the only
 * state that is a claim on their attention.
 */
export const spriteStateFor = (input: {
  activity: 'starting' | 'working' | 'waiting' | 'done'
  /** An open question names this card. */
  asking?: boolean
}): SpriteState => (input.asking ? 'asking' : ACTIVITY_STATE[input.activity])
