// swarmLaunch — the launch defaults EVERY in-app swarm role (補給官 supply /
// worker / future 司令官 commander) shares, so the three stay in lockstep
// instead of each role hard-coding — and silently drifting on — its own model /
// effort. Mirrors the shell swarm launchers (swarm-supply.sh / swarm-new.sh),
// which all run `--model opus --effort max`.
//
// effort is guarded against CLAUDE_EFFORTS so a rename here can never emit a
// broken `--effort` argv — the same discipline launchOptsFromPrefs and the old
// inline swarmSupply guard applied. Centralizing it means a future commander
// launch inherits opus/max (and, once added, Remote Control) for free, without
// re-deriving the guard.

import { CLAUDE_EFFORTS, type ClaudeEffort } from '../types'

/** Model every swarm role launches at — opus (full capability). */
export const SWARM_LAUNCH_MODEL = 'opus'

/** The effort literal the swarm runs at. Kept as a raw string so the
 *  CLAUDE_EFFORTS membership check below is a REAL guard: a typo'd rename
 *  degrades to undefined ("CLI default"), never a broken `--effort` argv. */
const SWARM_LAUNCH_EFFORT_RAW = 'max'

/** Effort every swarm role launches at — 'max' while the CLI still accepts it,
 *  else undefined (fall through to the CLI default rather than emit junk). */
export const SWARM_LAUNCH_EFFORT: ClaudeEffort | undefined = CLAUDE_EFFORTS.includes(
  SWARM_LAUNCH_EFFORT_RAW as ClaudeEffort,
)
  ? (SWARM_LAUNCH_EFFORT_RAW as ClaudeEffort)
  : undefined

export interface SwarmLaunchDefaults {
  model: string
  effort?: ClaudeEffort
  /** Remote Control session name (`--remote-control <name>`): the role launches
   *  controllable from claude.ai / mobile under this label, with NO manual
   *  toggle. ALWAYS a non-empty, explicit name — claude's `--remote-control
   *  [name]` takes an OPTIONAL value, so a bare flag would swallow the following
   *  positional prompt as the name (buildClaudeArgv emits it accordingly). */
  remoteControl: string
}

/** The shared launch defaults a swarm role runs with — opus + max + Remote
 *  Control ON — spread into the role's LaunchClaudeOpts so supply / worker /
 *  (future) commander stay identical. `remoteName` is the role's Remote Control
 *  label so it's identifiable on claude.ai / mobile (supply / worker / …).
 *  `effort` is omitted entirely when the CLAUDE_EFFORTS guard rejected it (so
 *  the spread never sets `effort: undefined`). */
export const swarmLaunchDefaults = (remoteName: string): SwarmLaunchDefaults => ({
  model: SWARM_LAUNCH_MODEL,
  ...(SWARM_LAUNCH_EFFORT ? { effort: SWARM_LAUNCH_EFFORT } : {}),
  remoteControl: remoteName,
})
