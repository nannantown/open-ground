// Who may see the Persona surface.
//
// WHY THIS IS A GROUND GATE AND NOT A MODULE GATE (2026-08-14). The Persona
// surface is about the OWNER, not a repo: its data lives in `~/.openground/`
// (you-corpus.md, persona-courses.json, persona-interview.json) and is
// therefore identical on every project — the same screen, whichever card you
// had open. It sat in the per-project tab row only because that is where the
// tab machinery was. Ground is where app-wide / owner-wide things live
// (Settings, Manual, Skills), so that is its address now, and its visibility
// rule moved out of moduleRegistry — which knows only about per-project tabs —
// into this file.
//
// THE RULE IS UNCHANGED from the tab's `experiments: ['persona', 'swarm']`
// any-of gate: the surface opens when EITHER experiment is open. The people
// running a swarm are exactly the people whose stand-in judges on their behalf,
// so hiding the persona from them hides the thing the swarm reads; the
// `persona` flag is a second, independent way in. Both closed keeps it
// invisible — which is the shipped, signed-out and non-owner state, because the
// flags are owner-ANDed server-side (src/lib/server/experiments.ts) and a
// forged settings.json never opens them.
//
// ONE predicate, so the door and the room cannot disagree about who may see
// this: App passes `onOpenPersona` to the Toolbar only when this returns true
// (an undefined handler is what hides the entry — the established pattern for
// every conditional toolbar control), and re-asks it before mounting the panel.

import type { ExperimentFlags, ExperimentId } from '../types'

/** The experiments that open the Persona surface — ANY of them is enough. */
export const PERSONA_EXPERIMENTS: readonly ExperimentId[] = ['persona', 'swarm']

/**
 * Whether the Persona surface is open for this user. Fails CLOSED: absent flags
 * (the pre-fetch state, and every non-owner build) hide it, and only a literal
 * `true` counts — never a truthy value off the wire.
 */
export const isPersonaOpen = (flags: ExperimentFlags | undefined | null): boolean =>
  !!flags && PERSONA_EXPERIMENTS.some((id) => flags[id] === true)
