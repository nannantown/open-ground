// Type declarations for the plain-CJS electron/selfUpdate.js. The module stays JS
// (Electron loads electron/main.js directly and cannot import TypeScript); the
// vitest suite gets types from here. Runtime resolves the .js; TypeScript resolves
// this .d.ts — the same split as electron/startup.d.ts / electron/forkEnv.d.ts.

/** A spawned engine handle: the child process plus where it listens and the
 *  bootId it will echo through /api/health. `child` is opaque to the pure module
 *  (it only ever hands it back to stop/wait deps), so it stays `unknown`. */
export interface EngineHandle {
  child: unknown
  port: number
  bootId: string
}

/** Verdict of one self-update cycle — which arm ran, for the caller and tests. */
export interface SelfUpdateResult {
  /** The rebuild (npm run build) succeeded. */
  rebuilt: boolean
  /** The canary booted and echoed its bootId through /api/health. */
  canaryHealthy: boolean
  /** The live engine was actually cut over to the new build. */
  switched: boolean
  /** 'ok' on a completed switch, else the arm that stopped the cycle
   *  ('rebuild-failed' | 'canary-spawn-failed' | 'canary-unhealthy' | …). */
  reason: string
}

/** Injectable side effects of the unmanned self-update cycle. */
export interface SelfUpdateCycleDeps {
  rebuild: () => Promise<{ ok: boolean; reason?: string }>
  startCanary: () => Promise<EngineHandle>
  checkHealth: (arg: { port: number; bootId: string }) => Promise<boolean>
  stopCanary: (child: unknown) => Promise<void>
  /** Optional regression gate (task 402d34a0): runs on the new build after the
   *  canary proves it boots and before the switch. ok:false → stay on old
   *  (reason 'regression-failed'). Omitted → the gate is skipped. */
  runRegressionTests?: () => Promise<{ ok: boolean; reason?: string }>
  performSwitch: () => Promise<{ ok: boolean; reason?: string }>
  /** Fired ONLY after a successful switch (task 402d34a0 MUST-FIX2): the one
   *  in-cycle moment on-disk == the live healthy engine, where main.js refreshes the
   *  known-good rollback snapshot. Never fired on a reject. Best-effort. */
  onSwitchSucceeded?: () => void | Promise<void>
  log: (level: string, msg: string) => void
}

/** One regression-gate step: a named test command (task c76cb3f3). `cmd` is opaque
 *  to the pure module (only the injected runStep spawns it), so it is optional.
 *  `ownsServerGroup` flags a step whose child spawns a SEPARATE process group it
 *  reaps only on SIGTERM (the e2e step's playwright + its webServer) — read by
 *  main.js to pick gracefulGroupKill over killProcessTree on a forced kill. */
export interface RegressionStep {
  name: string
  cmd?: string[]
  ownsServerGroup?: boolean
}

/** Injectable side effects of the ordered, fail-fast regression gate (task c76cb3f3). */
export interface RegressionStepsDeps {
  /** Ordered gate steps (unit → e2e smoke). Run in order; the first red one stops it. */
  steps: RegressionStep[]
  /** Run ONE step: resolve { ok:true } on success, { ok:false, reason } on failure. */
  runStep: (step: RegressionStep) => Promise<{ ok: boolean; reason?: string }>
  log: (level: string, msg: string) => void
}

/** Injectable side effects of the (separated) fixed-port switch path. */
export interface EngineSwitchDeps {
  stopOldEngine: () => Promise<void>
  startNewEngine: () => Promise<EngineHandle>
  waitHealthy: (arg: { port: number; bootId: string; child: unknown }) => Promise<boolean>
  reloadWindow: () => void
  /** Tear down the new engine when it spawned but never went healthy, freeing the
   *  fixed port before the rollback seam (task 402d34a0, R2). */
  stopNewEngine?: (child: unknown) => Promise<void>
  /** Rollback seam (task 402d34a0). Default: log-only; wired to performRollback. */
  onSwitchFailure?: (info: { stage: string; error?: string }) => void | Promise<void>
  log: (level: string, msg: string) => void
}

/** Injectable side effects of the rollback path (task 402d34a0). */
export interface RollbackDeps {
  restoreArtifacts: () => Promise<void>
  startEngine: () => Promise<EngineHandle>
  waitHealthy: (handle: EngineHandle) => Promise<boolean>
  reloadWindow: () => void
  notify: (info: { ok: boolean; stage: string; goodSha?: string; reason: string }) => void
  stage: string
  goodSha?: string
  log: (level: string, msg: string) => void
}

/** Run the full unmanned cycle: rebuild → canary → health → (regression) → switch / stay. */
export function runSelfUpdateCycle(deps: SelfUpdateCycleDeps): Promise<SelfUpdateResult>

/** The canary-promotion gate (task c76cb3f3): run the ordered test steps (unit → e2e
 *  smoke) fail-fast and NAME the red step. The body behind runSelfUpdateCycle's
 *  runRegressionTests dep; ANY step red → { ok:false } so the cycle stays on old. */
export function runRegressionSteps(
  deps: RegressionStepsDeps,
): Promise<{ ok: boolean; reason?: string; failedStep?: string }>

/** The separated switch path: stop old → start new on the fixed port → health →
 *  reload, with onSwitchFailure as the rollback seam. */
export function performEngineSwitch(
  deps: EngineSwitchDeps,
): Promise<{ ok: boolean; reason?: string; child?: unknown; bootId?: string }>

/** The rollback: restore the last known-good build → re-fork on the fixed port →
 *  health → reload, so the engine survives a broken self-update. Never throws. */
export function performRollback(deps: RollbackDeps): Promise<{ ok: boolean; reason: string }>

/** SIGKILL a child and its whole process group (negative-pid on POSIX, direct kill
 *  fallback) so vitest/vite/esbuild fork workers never orphan (task 402d34a0 MUST-FIX1).
 *  The `kill` signature (signal?: NodeJS.Signals) is the one type both a real
 *  child_process.ChildProcess and a test mock are assignable to. */
export function killProcessTree(
  child:
    | { pid?: number; killed?: boolean; exitCode?: number | null; kill?: (signal?: NodeJS.Signals) => unknown }
    | null
    | undefined,
  opts?: { platform?: string; kill?: (pid: number, signal: string) => void },
): void

/** One row of the process table — the input to processSubtreeGroups. */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
}

/** Distinct process GROUPS (pgids) in the subtree rooted at `rootPid` — the root's own
 *  group AND any a descendant re-grouped into (the e2e step's playwright + its separate
 *  webServer group). Lets gracefulGroupKill signal the webServer's group directly so it
 *  never orphans (task c76cb3f3 review-B M1). Pure given the injected lister. */
export function processSubtreeGroups(rootPid: number, listProcs?: () => ProcRow[]): number[]

/** Graceful forced teardown for a child that spawns a SEPARATE process group (the e2e
 *  step's playwright + its webServer): discover EVERY group in the subtree → SIGINT each
 *  (playwright reaps its webServer on SIGINT; SIGTERM does NOT) → wait graceMs →
 *  escalate to a SIGKILL of every captured group. Use INSTEAD of killProcessTree for
 *  such a child, else its server group orphans and squats port 47876 (task c76cb3f3
 *  review-B M1). Never throws; always resolves. */
export function gracefulGroupKill(
  child:
    | {
        pid?: number
        killed?: boolean
        exitCode?: number | null
        kill?: (signal?: NodeJS.Signals) => unknown
        once?: (event: string, cb: () => void) => unknown
      }
    | null
    | undefined,
  opts?: {
    platform?: string
    kill?: (pid: number, signal: string) => void
    graceMs?: number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
    listProcs?: () => ProcRow[]
  },
): Promise<void>
