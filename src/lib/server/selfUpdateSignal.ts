// selfUpdateSignal — the server→Electron seam that kicks off the unmanned
// self-update cycle (rebuild → canary → health → switch; electron/selfUpdate.js)
// after the in-app swarm lands a self-improvement on OPEN GROUND's OWN source.
//
// WHY HERE, AND WHY SO NARROW. The merge happens server-side (swarmIntegrate /
// swarmOrchestrator). The bundled Hono server is a CHILD of electron/main.js,
// forked with an IPC channel, so `process.send` reaches the Electron main
// process — which owns process management (forking the engine, the fixed port)
// and is the only place that can rebuild + cut the engine over. This module is
// the one-line call the merge path makes; all the heavy lifting lives in
// electron/main.js + electron/selfUpdate.js.
//
// TWO GATES, BOTH FAIL-SAFE (a no-op return, never a throw), so wiring this into
// the integration path can never affect a merge:
//
//   1. process.send must exist — i.e. we are the engine FORKED BY electron/main.js
//      (prod fork has an IPC channel). In dev `tsx`, vitest, or a bare `node` run
//      there is no parent listening, so we stay silent.
//   2. The project that just integrated must BE this engine's own source repo.
//      electron/main.js sets OPENGROUND_SOURCE_ROOT to the dev checkout root when
//      (and only when) it arms self-update (a non-packaged electron:prod run). A
//      swarm merge on any OTHER project — the user's test repo, say — must never
//      rebuild/restart OPEN GROUND, so we match canonical paths and bail if they
//      differ. No OPENGROUND_SOURCE_ROOT (the normal shipped app, or any run that
//      didn't arm self-update) → no source to rebuild → no-op.
//
// electron/main.js additionally refuses to act on this message unless self-update
// is armed, so this is defence-in-depth: even a stray send can't trigger a switch
// in a context that shouldn't self-update.

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** The IPC message electron/main.js listens for. Kept here as the single source
 *  of truth; main.js compares against this exact string. */
export const SELF_UPDATE_MESSAGE = 'openground:self-update'

/** Canonicalize a path for comparison: resolve symlinks when the path exists,
 *  else fall back to a lexical resolve so two spellings of the same dir match. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** True iff `a` and `b` name the same directory after canonicalization. */
function sameDir(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}

/**
 * Ask the Electron main process to run the self-update cycle, IF and ONLY IF the
 * project that just integrated a self-improvement is this engine's own source
 * repo AND we are the forked engine with an IPC channel. Both gates fail safe.
 *
 * @param integratedProjectPath the path of the project whose swarm branch just
 *   landed on its trunk (the integration pass's `engine.path`).
 * @returns true iff the self-update request was actually sent.
 */
export function requestEngineSelfUpdate(integratedProjectPath: string): boolean {
  const send = typeof process.send === 'function' ? process.send.bind(process) : null
  if (!send) return false // not a child with an IPC channel (dev/tsx/vitest/bare node)

  const sourceRoot = process.env.OPENGROUND_SOURCE_ROOT
  if (!sourceRoot) return false // self-update not armed → no source repo to rebuild

  if (!integratedProjectPath || !sameDir(integratedProjectPath, sourceRoot)) {
    return false // a merge on some OTHER project — never rebuild OPEN GROUND for it
  }

  try {
    send({ type: SELF_UPDATE_MESSAGE, projectPath: canonical(integratedProjectPath) })
    return true
  } catch {
    // A failed IPC send must never disturb the merge path that called us.
    return false
  }
}
