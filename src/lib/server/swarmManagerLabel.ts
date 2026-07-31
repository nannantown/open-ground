// swarmManagerLabel — the commander desk's owner-facing name, alone in its own
// module so it can be imported without pulling in the spawner.
//
// It lives here because swarmManagerRuntime.ts needs it to FIND a commander
// desk, while swarmManager.ts needs swarmManagerRuntime.ts to decide whether to
// spawn one. Left in swarmManager.ts that is a cycle whose resolution depends on
// which module a bundler happens to evaluate first — the kind of thing that
// works in vitest and is `undefined` in the esbuild bundle. A leaf constant has
// no such failure mode.
//
// swarmManager.ts re-exports it, so every historical import keeps working.

/** The owner-facing name of the commander desk, carried onto its pool entry
 *  (`TerminalInfo.deskLabel` for a PTY desk). It is not decoration: it is the
 *  IDENTITY by which "does this project already have a commander?" is decided,
 *  in the one place that cannot desynchronise from itself — the pool. A desk the
 *  owner started by hand carries no label, so it is never mistaken for this one. */
export const MANAGER_DESK_LABEL = '司令官'
