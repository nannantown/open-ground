// electron/selfUpdate.js — the UNMANNED self-update cycle for the in-app swarm
// engine, as a pure, Electron-free orchestration so the whole thing is unit-
// testable without a build, a real socket, or a forked process
// (server/__tests__/selfUpdate.test.ts).
//
// THE PROBLEM IT SOLVES — a running OPEN GROUND engine (the bundled Hono server
// electron/main.js forked) keeps executing the code that was on disk when it was
// forked. So when the in-app swarm improves OPEN GROUND's OWN source and lands it
// on main, the live engine never reflects that improvement: it is still its old
// self. This module is the mechanism that lets the engine REPLACE ITSELF after a
// self-improvement merge — the foundation of a fully unmanned self-improvement
// loop:
//
//     merge → rebuild → canary (separate port/process) → /api/health → switch
//
// SAFETY IS THE WHOLE POINT. The cutover only ever happens once a CANARY copy of
// the freshly-built engine has proven, on a SEPARATE port, that it boots and
// echoes its bootId through /api/health. If the rebuild fails, or the canary
// never becomes healthy, we DO NOT switch — the old engine keeps running
// untouched (the "stay on old, safe side" branch). The old process holds its
// code in memory, so an in-place rebuild on disk can never disturb it; only an
// explicit, validated switch ever swaps the live engine.
//
// THE SWITCH PATH IS DELIBERATELY SEPARATED (performEngineSwitch). A later task
// (rollback — 402d34a0) rides on this exact cutover: if the new engine fails to
// come up healthy on the fixed port, performEngineSwitch calls its injected
// onSwitchFailure hook, which is where rollback restores the previous engine.
// Keeping the switch in its own function with that single failure seam means the
// rollback work never has to reach into the cycle above it.
//
// Plain CommonJS (no `electron` import), like cacheReset.js / forkEnv.js /
// startup.js, so electron/main.js can require it directly and the vitest suite
// can run it in plain node.

/** Format an unknown error for a log line without throwing. */
function errText(err) {
  if (!err) return 'unknown'
  if (err instanceof Error) return err.message || String(err)
  return String(err)
}

/**
 * SIGKILL a child AND its whole process group, so a tool that forks workers (the
 * vitest fork pool, vite/esbuild) never leaves orphans that spin a core to
 * saturation — the known vitest-orphan hazard (task 402d34a0 MUST-FIX1). The child
 * MUST have been spawned `detached` on POSIX for the negative-pid group signal to
 * reach the workers; if it wasn't a group leader (group gone / already exited), or
 * on Windows where process groups differ, we fall back to a plain child.kill. Pure:
 * the signal sender is injectable so the test can fork a real detached tree and
 * assert every descendant dies.
 *
 * @param {{ pid?: number, killed?: boolean, exitCode?: number|null, kill?: (s?: string) => void } | null | undefined} child
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {(pid: number, signal: string) => void} [opts.kill=process.kill]
 */
function killProcessTree(child, opts) {
  if (!child || child.killed || child.exitCode != null) return
  const platform = (opts && opts.platform) || process.platform
  const killFn = (opts && opts.kill) || process.kill
  // POSIX: the child leads its own group (spawned detached) → a NEGATIVE pid signals
  // the WHOLE group (npm + its vitest / vite / esbuild forks), not just npm itself.
  if (platform !== 'win32' && child.pid) {
    try {
      killFn(-child.pid, 'SIGKILL')
      return
    } catch {
      /* not a group leader / already gone — fall through to a direct kill */
    }
  }
  try {
    if (child.kill) child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * List the distinct process GROUPS (pgids) in the subtree rooted at `rootPid` — the
 * root's own group AND any group a descendant re-grouped itself into. The e2e step is
 * npm(G1) → playwright(G1) → sh(G2) → node webServer(G2): playwright launches its
 * webServer in its OWN process group, so a kill that only signals G1 leaves the
 * webServer (port 47876) ORPHANED. Capturing G2's pgid here — while the tree is intact
 * — lets gracefulGroupKill signal it DIRECTLY, so it dies regardless of whether the
 * runner reaps it. Pure given the injected process lister (default: `ps`); returns
 * [rootPid]'s-group-only if the listing is empty/unavailable. Never throws.
 *
 * @param {number} rootPid
 * @param {() => Array<{ pid: number, ppid: number, pgid: number }>} [listProcs]
 * @returns {number[]} distinct pgids (the root's group first)
 */
function processSubtreeGroups(rootPid, listProcs) {
  const list = listProcs || defaultListProcs
  let procs
  try {
    procs = list()
  } catch {
    return [rootPid]
  }
  if (!Array.isArray(procs) || procs.length === 0) return [rootPid]
  const childrenOf = new Map()
  const pgidOf = new Map()
  for (const p of procs) {
    if (!p || typeof p.pid !== 'number') continue
    pgidOf.set(p.pid, p.pgid)
    const kids = childrenOf.get(p.ppid) || []
    kids.push(p.pid)
    childrenOf.set(p.ppid, kids)
  }
  const groups = []
  const addGroup = (g) => {
    if (typeof g === 'number' && !groups.includes(g)) groups.push(g)
  }
  addGroup(pgidOf.has(rootPid) ? pgidOf.get(rootPid) : rootPid)
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const cur = queue.shift()
    for (const kid of childrenOf.get(cur) || []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      queue.push(kid)
      addGroup(pgidOf.get(kid))
    }
  }
  return groups
}

/** Default process lister for processSubtreeGroups: `ps` (POSIX). Returns one row per
 *  process with its pid / ppid / pgid. */
function defaultListProcs() {
  const { execSync } = require('child_process')
  const out = execSync('ps -eo pid=,ppid=,pgid=', {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  const rows = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3] })
  }
  return rows
}

/**
 * Forced teardown for a child that spawns a SEPARATE process group — namely the e2e
 * step's `playwright`, which launches its webServer (`npm run build` → vite/esbuild →
 * a node server on port 47876) in its OWN group. killProcessTree SIGKILLs only the
 * child's group, so the webServer group ORPHANS, squats port 47876, and the NEXT e2e
 * run fails EADDRINUSE forever — the self-update gate WEDGES (task c76cb3f3 review-B
 * M1). Unlike killProcessTree's single immediate SIGKILL, this:
 *   1. discovers EVERY group in the child's subtree (the runner's + the webServer's),
 *      captured while the tree is intact;
 *   2. SIGINTs each — playwright tears its webServer down on SIGINT (Ctrl-C); a plain
 *      SIGTERM does NOT trigger that teardown (verified empirically on the dev machine),
 *      and a direct SIGINT to the webServer's group also makes it exit on its own, so
 *      the port frees whether or not playwright cooperates;
 *   3. resolves as soon as the child exits (teardown finished) within `graceMs`;
 *   4. otherwise ESCALATES to a SIGKILL of EVERY captured group — so nothing orphans
 *      even if a group ignored SIGINT — then resolves.
 * vitest / `npm run build` spawn only same-group forks, so they have no second group to
 * reap and keep using killProcessTree (an immediate group SIGKILL). Pure & injectable
 * (kill / setTimer / clearTimer / listProcs), like killProcessTree, so it is unit-
 * testable; the real proof is a two-group process tree. Never throws; always resolves.
 *
 * @param {{ pid?: number, killed?: boolean, exitCode?: number|null, kill?: (s?: string) => void, once?: (ev: string, cb: () => void) => void } | null | undefined} child
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {(pid: number, signal: string) => void} [opts.kill=process.kill]
 * @param {number} [opts.graceMs=5000]
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer=setTimeout]
 * @param {(handle: any) => void} [opts.clearTimer=clearTimeout]
 * @param {() => Array<{ pid: number, ppid: number, pgid: number }>} [opts.listProcs]
 * @returns {Promise<void>}
 */
function gracefulGroupKill(child, opts) {
  const platform = (opts && opts.platform) || process.platform
  const killFn = (opts && opts.kill) || process.kill
  const graceMs = opts && opts.graceMs != null ? opts.graceMs : 5000
  const setTimer = (opts && opts.setTimer) || setTimeout
  const clearTimer = (opts && opts.clearTimer) || clearTimeout
  const listProcs = opts && opts.listProcs
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) {
      resolve()
      return
    }
    let settled = false
    let timer
    const done = () => {
      if (settled) return
      settled = true
      if (timer != null) clearTimer(timer)
      resolve()
    }
    // The groups to reap: the runner's own group AND the webServer's separate group,
    // captured NOW while the tree is intact (POSIX only — Windows has no pgids).
    const groups =
      platform !== 'win32' && child.pid ? processSubtreeGroups(child.pid, listProcs) : []
    if (groups.length) {
      for (const g of groups) {
        try {
          killFn(-g, 'SIGINT')
        } catch {
          /* group already gone */
        }
      }
    } else {
      // Not enumerable / Windows → best-effort direct child SIGINT.
      try {
        if (child.kill) child.kill('SIGINT')
      } catch {
        /* already gone */
      }
    }
    // The runner exiting === teardown finished → resolve, no escalation needed.
    if (child.once) child.once('exit', done)
    // Escalate after the grace: SIGKILL every captured group (incl. the webServer's),
    // so nothing orphans even if a group ignored SIGINT.
    timer = setTimer(() => {
      if (groups.length) {
        for (const g of groups) {
          try {
            killFn(-g, 'SIGKILL')
          } catch {
            /* gone */
          }
        }
      } else {
        killProcessTree(child, { platform, kill: killFn })
      }
      done()
    }, graceMs)
  })
}

/**
 * Run an ORDERED list of regression test steps as the canary-promotion gate,
 * FAIL-FAST: the first RED step rejects the whole gate and the returned reason
 * NAMES that step (`unit` / `e2e`), so runSelfUpdateCycle's caller can log WHICH
 * test went red (task c76cb3f3 condition 4). Later steps are skipped once one fails.
 *
 * This is the multi-step body behind the single `runRegressionTests` dep of
 * runSelfUpdateCycle. Health (bootId echo) only proves the new build STARTS; a
 * self-modification can break the LOGIC while still booting, so these steps prove the
 * freshly-built engine is also CORRECT before the live engine is cut over to it
 * (`npm test` = full vitest suite, then `npm run test:e2e` = playwright smoke). Every
 * step's runner is INJECTED (main.js spawns the real commands), so the ordering /
 * fail-fast / naming logic is unit-testable in plain node with no child process.
 * NEVER throws — a runner that throws is treated as that step failing red. An
 * empty/absent step list passes vacuously (matching the "no regression gate" branch).
 *
 * @param {object} deps
 * @param {Array<{ name: string, cmd?: string[] }>} deps.steps  Ordered gate steps.
 * @param {(step: { name: string, cmd?: string[] }) => Promise<{ ok: boolean, reason?: string }>} deps.runStep
 *   Run ONE step: resolve { ok:true } on success, { ok:false, reason } on failure.
 * @param {(level: string, msg: string) => void} deps.log
 * @returns {Promise<{ ok: boolean, reason?: string, failedStep?: string }>}
 */
async function runRegressionSteps(deps) {
  const { steps, runStep, log } = deps
  for (const step of steps || []) {
    let res
    try {
      res = await runStep(step)
    } catch (err) {
      res = { ok: false, reason: errText(err) }
    }
    if (!res || res.ok === false) {
      const detail = (res && res.reason) || 'unknown'
      log('warn', `regression: step '${step.name}' RED (${detail}) — failing the gate, skipping any later steps`)
      return { ok: false, reason: `${step.name}: ${detail}`, failedStep: step.name }
    }
    log('info', `regression: step '${step.name}' GREEN`)
  }
  return { ok: true }
}

/** Stop the canary, swallowing any teardown error (a dead/absent canary is
 *  fine — we are about to either switch or stay regardless). */
async function safeStop(stop, child, log) {
  try {
    await stop(child)
  } catch (err) {
    log('warn', `self-update: canary teardown best-effort failed (${errText(err)})`)
  }
}

/**
 * Run the full unmanned self-update cycle. Every side effect is injected so the
 * test can drive each branch (rebuild-fail / canary-unhealthy / happy) without
 * Electron. Returns a structured verdict — { rebuilt, canaryHealthy, switched,
 * reason } — so the caller and the test can assert exactly which arm ran.
 *
 * @param {object} deps
 * @param {() => Promise<{ ok: boolean, reason?: string }>} deps.rebuild
 *   Run `npm run build` (or equivalent). ok:false (or a throw) → stay on old.
 * @param {() => Promise<{ child: unknown, port: number, bootId: string }>} deps.startCanary
 *   Fork the freshly-built engine on a SEPARATE port with a fresh bootId.
 * @param {(arg: { port: number, bootId: string }) => Promise<boolean>} deps.checkHealth
 *   Poll the canary's /api/health until it echoes bootId, or time out → false.
 * @param {(child: unknown) => Promise<void>} deps.stopCanary  Tear the canary down.
 * @param {(() => Promise<{ ok: boolean, reason?: string }>)} [deps.runRegressionTests]
 *   OPTIONAL regression gate (task 402d34a0). Run after the canary proves the build
 *   boots and before the switch: ok:false (or a throw) → stay on old (reason
 *   'regression-failed'), never switch. Omitted → the gate is skipped.
 * @param {() => Promise<{ ok: boolean, reason?: string }>} deps.performSwitch
 *   Cut over on the fixed port (wraps performEngineSwitch). Only called once the
 *   canary is healthy AND (if provided) the regression gate is green.
 * @param {(() => void | Promise<void>)} [deps.onSwitchSucceeded]
 *   OPTIONAL hook fired ONLY after a successful switch (task 402d34a0 MUST-FIX2):
 *   the one in-cycle moment on-disk == the live healthy engine, so main.js refreshes
 *   the known-good rollback snapshot here. Never fired on a reject. Best-effort.
 * @param {(level: string, msg: string) => void} deps.log
 * @returns {Promise<{ rebuilt: boolean, canaryHealthy: boolean, switched: boolean, reason: string }>}
 */
async function runSelfUpdateCycle(deps) {
  const {
    rebuild,
    startCanary,
    checkHealth,
    stopCanary,
    runRegressionTests,
    performSwitch,
    onSwitchSucceeded,
    log,
  } = deps
  log('info', 'self-update: cycle start (merge → rebuild → canary → health → switch)')

  // 1. Rebuild the engine from the just-merged source (npm run build 相当).
  let built
  try {
    built = await rebuild()
  } catch (err) {
    built = { ok: false, reason: errText(err) }
  }
  if (!built || built.ok === false) {
    const reason = (built && built.reason) || 'unknown'
    log('warn', `self-update: rebuild FAILED (${reason}) — staying on current engine`)
    return { rebuilt: false, canaryHealthy: false, switched: false, reason: 'rebuild-failed' }
  }
  log('info', 'self-update: rebuild OK')

  // 2. Spawn the new build as a CANARY on a separate port/process (never the
  //    live fixed port — the old engine still owns it).
  let canary
  try {
    canary = await startCanary()
  } catch (err) {
    log('warn', `self-update: canary spawn FAILED (${errText(err)}) — staying on current engine`)
    return { rebuilt: true, canaryHealthy: false, switched: false, reason: 'canary-spawn-failed' }
  }
  log('info', `self-update: canary up on port ${canary.port} (bootId ${canary.bootId}) — probing /api/health`)

  // 3. Prove the canary boots and echoes ITS bootId through /api/health.
  let healthy = false
  try {
    healthy = await checkHealth({ port: canary.port, bootId: canary.bootId })
  } catch {
    healthy = false
  }

  // 4a. Canary unhealthy → SAFE SIDE: tear the canary down, DO NOT switch.
  if (!healthy) {
    log('warn', 'self-update: canary health NG (no bootId echo / timeout) — NOT switching, staying on current engine')
    await safeStop(stopCanary, canary.child, log)
    return { rebuilt: true, canaryHealthy: false, switched: false, reason: 'canary-unhealthy' }
  }
  log('info', 'self-update: canary health OK (bootId echo confirmed) — proceeding to switch')

  // 4b. Canary proved the build BOOTS → retire the canary.
  await safeStop(stopCanary, canary.child, log)

  // 4c. REGRESSION GATE (task 402d34a0, condition 2: "回帰テスト赤"). The canary
  //     proved the new build BOOTS; now prove it is CORRECT before cutting the live
  //     engine over to it. Optional dep — when absent the gate is skipped and the
  //     health proof alone gates the switch (preserves the pre-rollback contract).
  //     Tests RED → SAFE SIDE: do NOT switch, stay on the old engine (still running
  //     the last known-good build, untouched). No rollback is needed here because we
  //     never stopped the old engine — the rollback path (performRollback) is only
  //     for a switch that already stopped the old engine and then failed.
  if (runRegressionTests) {
    let tested
    try {
      tested = await runRegressionTests()
    } catch (err) {
      tested = { ok: false, reason: errText(err) }
    }
    if (!tested || tested.ok === false) {
      const reason = (tested && tested.reason) || 'unknown'
      log('warn', `self-update: regression tests RED (${reason}) — NOT switching, staying on current engine`)
      return { rebuilt: true, canaryHealthy: true, switched: false, reason: 'regression-failed' }
    }
    log('info', 'self-update: regression tests GREEN — proceeding to switch')
  }

  // 4d. Build proven (boots + correct) → cut over on the fixed port via the
  //     SEPARATED switch path (the rollback seam, performRollback, hooks in there).
  let switched
  try {
    switched = await performSwitch()
  } catch (err) {
    switched = { ok: false, reason: errText(err) }
  }
  if (!switched || switched.ok === false) {
    const reason = (switched && switched.reason) || 'switch-failed'
    log('warn', `self-update: switch did NOT complete (${reason})`)
    return { rebuilt: true, canaryHealthy: true, switched: false, reason }
  }

  // 4e. Switch SUCCEEDED → the on-disk build IS now what the new live engine runs and
  //     it is PROVEN healthy (canary + switch health both passed). This is the ONLY
  //     moment inside the cycle when on-disk == the live healthy engine, so this — not
  //     rebuild time — is where the known-good rollback snapshot is refreshed (task
  //     402d34a0 MUST-FIX2). Snapshotting at rebuild time would capture whatever is on
  //     disk then, which after a previously-rejected cycle (canary-unhealthy /
  //     regression-red leave the rejected build in place, un-restored) is a BROKEN
  //     build wrongly stamped good. Best-effort: a snapshot failure must not undo a
  //     switch that already completed.
  if (onSwitchSucceeded) {
    try {
      await onSwitchSucceeded()
    } catch (err) {
      log('warn', `self-update: post-switch known-good snapshot failed (${errText(err)}) — keeping the previous snapshot`)
    }
  }

  log('info', 'self-update: cycle complete — engine replaced with its new self')
  return { rebuilt: true, canaryHealthy: true, switched: true, reason: 'ok' }
}

/**
 * THE SWITCH PATH — cut the live engine over to the freshly-built one on the
 * FIXED port. Separated from runSelfUpdateCycle so the rollback task (402d34a0)
 * can hook recovery into onSwitchFailure without touching the cycle.
 *
 * Order: stop the old engine (frees the fixed port) → fork the new build on the
 * fixed port with a fresh bootId → wait for ITS /api/health bootId echo → reload
 * the window onto it. If the new engine never spawns or never becomes healthy,
 * we call onSwitchFailure (the rollback seam) and report ok:false — we never
 * pretend the switch succeeded.
 *
 * NOTE the canary has ALREADY proven this same build boots healthy on another
 * port, so reaching the failure arm here means a fixed-port-specific problem
 * (e.g. the old engine didn't release the port in time) — precisely the case the
 * rollback task is designed to recover from.
 *
 * @param {object} deps
 * @param {() => Promise<void>} deps.stopOldEngine  SIGTERM/▸KILL the live engine.
 * @param {() => Promise<{ child: unknown, port: number, bootId: string }>} deps.startNewEngine
 *   Fork the new build on the fixed port with a fresh bootId.
 * @param {(arg: { port: number, bootId: string, child: unknown }) => Promise<boolean>} deps.waitHealthy
 *   Poll the fixed port until it echoes the new bootId, or time out → false.
 * @param {() => void} deps.reloadWindow  Point the renderer at the new engine.
 * @param {((child: unknown) => Promise<void>)} [deps.stopNewEngine]
 *   Tear down the new engine when it spawned but never went healthy (task 402d34a0,
 *   R2). It is still holding the FIXED port, so we stop it BEFORE the rollback seam
 *   so the known-good engine the rollback forks there finds the port free. Always
 *   invoked on the health-failure arm (defence in depth) even with the default
 *   log-only handler — a failed switch must never orphan a port-squatting zombie.
 * @param {(info: { stage: string, error?: string }) => (void | Promise<void>)} [deps.onSwitchFailure]
 *   ROLLBACK SEAM (task 402d34a0). Default: log-only. Wired in main.js to
 *   performRollback (restore the last known-good build → re-fork → health → reload).
 * @param {(level: string, msg: string) => void} deps.log
 * @returns {Promise<{ ok: boolean, reason?: string, child?: unknown, bootId?: string }>}
 */
async function performEngineSwitch(deps) {
  const {
    stopOldEngine,
    startNewEngine,
    waitHealthy,
    reloadWindow,
    stopNewEngine,
    onSwitchFailure,
    log,
  } = deps

  const fail = onSwitchFailure || ((info) => log('error', `switch: no rollback handler wired — engine down at stage=${info.stage}`))

  // 1. Stop the old engine so the fixed port is free for the new one.
  log('info', 'switch: stopping old engine to free the fixed port')
  await stopOldEngine()

  // 2. Fork the new build on the fixed port.
  let next
  try {
    next = await startNewEngine()
  } catch (err) {
    const error = errText(err)
    log('error', `switch: new engine FAILED to spawn (${error}) — invoking rollback seam`)
    await fail({ stage: 'spawn', error })
    return { ok: false, reason: 'new-engine-spawn-failed' }
  }
  log('info', `switch: new engine forked on fixed port ${next.port} (bootId ${next.bootId}) — awaiting health`)

  // 3. Require the new engine's own bootId echo before we trust it.
  let ok = false
  try {
    ok = await waitHealthy({ port: next.port, bootId: next.bootId, child: next.child })
  } catch {
    ok = false
  }
  if (!ok) {
    // R2: the new engine spawned but never went healthy — it is STILL holding the
    // fixed port. Tear it down before the rollback seam so the known-good engine the
    // rollback forks there finds the port free. Best-effort (a teardown error must
    // not block the rollback) and always attempted, even with the default handler.
    if (stopNewEngine) {
      try {
        await stopNewEngine(next.child)
      } catch (err) {
        log('warn', `switch: tearing down the unhealthy new engine failed (${errText(err)})`)
      }
    }
    log('error', 'switch: new engine never became healthy on the fixed port — invoking rollback seam')
    await fail({ stage: 'health' })
    return { ok: false, reason: 'new-engine-unhealthy' }
  }

  // 4. Healthy — point the renderer at the new engine. The cutover is done.
  reloadWindow()
  log('info', 'switch: new engine healthy on fixed port, window reloaded — cutover done')
  return { ok: true, child: next.child, bootId: next.bootId }
}

/**
 * THE ROLLBACK — recover from a switch that left the live engine DOWN (task
 * 402d34a0). performEngineSwitch stops the old engine to free the fixed port, then
 * forks the new build there; if that new engine never comes up healthy (spawn fail
 * or health timeout) the old engine is already gone, so without recovery the app is
 * bricked until a manual relaunch. This is that recovery: restore the last
 * known-good build artifacts over the (broken) on-disk build, fork a fresh engine
 * from them on the fixed port, prove ITS health, and reload the window — so the
 * engine SURVIVES a broken self-update by returning to its previous good self.
 *
 * Wired into performEngineSwitch.onSwitchFailure in main.js. The known-good
 * artifacts were snapshotted at the START of the cycle (before the rebuild
 * overwrote them), when the live engine was provably healthy.
 *
 * Every side effect is injected so the whole recovery is unit-testable without
 * Electron, a build, or a socket — the same contract as runSelfUpdateCycle. It
 * NEVER throws: each failure arm logs, notifies, and returns ok:false so the caller
 * (and the operator) sees a clear "rollback failed — engine down" rather than an
 * unhandled rejection. A successful rollback returns ok:true.
 *
 * @param {object} deps
 * @param {() => Promise<void>} deps.restoreArtifacts
 *   Copy the snapshotted known-good build (server/dist + dist-web) back over the
 *   broken on-disk build. A throw → 'restore-failed' (engine stays down).
 * @param {() => Promise<{ child: unknown, port: number, bootId: string }>} deps.startEngine
 *   Fork a fresh live engine from the restored build on the FIXED port.
 * @param {(handle: { child: unknown, port: number, bootId: string }) => Promise<boolean>} deps.waitHealthy
 *   Poll the fixed port until the restored engine echoes its bootId, else false.
 * @param {() => void} deps.reloadWindow  Point the renderer back at the restored engine.
 * @param {(info: { ok: boolean, stage: string, goodSha?: string, reason: string }) => void} deps.notify
 *   Surface the rollback to the user (condition 3: "通知"). Called on every arm.
 * @param {string} deps.stage     The switch stage that failed ('spawn' | 'health').
 * @param {string} [deps.goodSha] The known-good commit sha, for logs + notification.
 * @param {(level: string, msg: string) => void} deps.log
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function performRollback(deps) {
  const {
    restoreArtifacts,
    startEngine,
    waitHealthy,
    reloadWindow,
    notify,
    stage,
    goodSha,
    log,
  } = deps
  const sha = goodSha || 'unknown'
  const note = (info) => {
    try {
      if (notify) notify(info)
    } catch (err) {
      log('warn', `rollback: notify hook threw (${errText(err)})`)
    }
  }
  log('error', `rollback: switch failed at stage=${stage} — restoring last known-good build (sha ${sha})`)

  // 1. Restore the known-good artifacts over the broken build on disk.
  try {
    await restoreArtifacts()
  } catch (err) {
    const reason = errText(err)
    log('error', `rollback: FAILED to restore known-good artifacts (${reason}) — engine is DOWN`)
    note({ ok: false, stage, goodSha: sha, reason: 'restore-failed' })
    return { ok: false, reason: 'restore-failed' }
  }
  log('info', 'rollback: known-good artifacts restored — re-forking engine on the fixed port')

  // 2. Fork a fresh live engine from the restored (known-good) build.
  let handle
  try {
    handle = await startEngine()
  } catch (err) {
    const reason = errText(err)
    log('error', `rollback: known-good engine FAILED to spawn (${reason}) — engine is DOWN`)
    note({ ok: false, stage, goodSha: sha, reason: 'respawn-failed' })
    return { ok: false, reason: 'respawn-failed' }
  }

  // 3. The restored build booted healthy before, so this should pass — but require
  //    the bootId echo anyway: we never trust an engine we haven't proven.
  let healthy = false
  try {
    healthy = await waitHealthy(handle)
  } catch {
    healthy = false
  }
  if (!healthy) {
    log('error', 'rollback: known-good engine never became healthy on the fixed port — engine is DOWN')
    note({ ok: false, stage, goodSha: sha, reason: 'respawn-unhealthy' })
    return { ok: false, reason: 'respawn-unhealthy' }
  }

  // 4. Recovered — point the renderer back at the restored engine and announce it.
  reloadWindow()
  log('info', `rollback: OK — restored known-good build (sha ${sha}), engine healthy on the fixed port; survived a broken self-update`)
  note({ ok: true, stage, goodSha: sha, reason: 'ok' })
  return { ok: true, reason: 'ok' }
}

module.exports = {
  runSelfUpdateCycle,
  performEngineSwitch,
  performRollback,
  killProcessTree,
  gracefulGroupKill,
  processSubtreeGroups,
  runRegressionSteps,
}
