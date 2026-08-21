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
// THE RULE (changed 2026-08-20, persona promoted to a public beta): the surface
// opens on the `persona` flag ALONE. It used to be an any-of over
// `['persona', 'swarm']` — the idea being that a swarm operator should see the
// corpus their stand-in reads. But the overseer reads that corpus SERVER-SIDE
// regardless of this UI gate, so the coupling bought nothing except a real
// leak: once swarm became a public opt-in (0.11.94), every swarm opt-in user's
// `flags.swarm` was true, so the any-of opened the PERSONAL corpus screen for
// them too. The coupling now lives INSIDE the server flag (experiments.ts:
// persona = owner's persona toggle OR the public persona opt-in — swarm no
// longer reaches it), so this gate reads one flag and the door and the room
// cannot disagree. Closed keeps it invisible: the flags are owner-ANDed /
// opt-in-gated server-side and a forged settings.json never opens them.
//
// ONE predicate, so the door and the room cannot disagree about who may see
// this: App passes `onOpenPersona` to the Toolbar only when this returns true
// (an undefined handler is what hides the entry — the established pattern for
// every conditional toolbar control), and re-asks it before mounting the panel.

import type { ExperimentFlags, ExperimentId } from '../types'

/** The experiment that opens the Persona surface. Just `persona` now — the
 *  owner/opt-in coupling with swarm was moved server-side into the flag itself
 *  (experiments.ts), so swarm no longer reaches this surface. See the header. */
export const PERSONA_EXPERIMENTS: readonly ExperimentId[] = ['persona']

/**
 * Whether the Persona surface is open for this user. Fails CLOSED: absent flags
 * (the pre-fetch state, and every non-owner build) hide it, and only a literal
 * `true` counts — never a truthy value off the wire.
 */
export const isPersonaOpen = (flags: ExperimentFlags | undefined | null): boolean =>
  !!flags && PERSONA_EXPERIMENTS.some((id) => flags[id] === true)
