// gateProcess — the fork-pool-safe child-process runner shared by every engine
// stage that spawns a tool which itself FORKS a worker pool (vitest, eslint).
//
// It lives in its own module — rather than inside swarmOrchestrator, where it was
// born — because swarmSelfSupply needs the same reaper and swarmOrchestrator
// already imports swarmSelfSupply. A back-import would close an import cycle the
// self-supply module's header explicitly rules out; a leaf module both can import
// keeps the graph acyclic. swarmOrchestrator re-exports `runGateProcess` so its
// existing importers (and tests) keep their path.

import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'

// ── Shutdown reaper for in-flight gate groups (2026-07-29) ───────────────────
//
// `detached: true` below is LOAD-BEARING and stays: it is what makes the
// negative-pid SIGKILL reach the whole fork pool. Its cost is that the child
// also survives US — a detached child is in no process group of ours, so when
// the SERVER dies it receives nothing: no terminal signal, no 'close', no
// `settle`, no reapGroup. A merge-gate `vitest run` then outlives its own engine
// with its forks intact, and if its worktree is removed underneath it that is
// precisely the "cwd deleted while it runs" shape that wedges a process in
// uninterruptible sleep, where SIGKILL no longer reaches it (07 章 §7).
//
// So: remember every LIVE group, and offer one SYNCHRONOUS call that kills them
// all. Detection (stuckProcessWatch) is the last resort; this is the prevention.
declare global {
  // On globalThis: a `tsx watch` reload re-evaluates this module, but the
  // children it already spawned are still running and still ours to reap.
  // eslint-disable-next-line no-var
  var __openground_gate_groups: Set<number> | undefined
  // eslint-disable-next-line no-var
  var __openground_gate_reaper_installed: boolean | undefined
}

const liveGateGroups: Set<number> =
  globalThis.__openground_gate_groups ?? (globalThis.__openground_gate_groups = new Set())

/** SIGKILL every gate group still in flight. SYNCHRONOUS by requirement — it runs
 *  inside `process.on('exit')`, where nothing async can be awaited. Idempotent
 *  (the set is drained as it goes); returns how many groups were signalled. Same
 *  negative-pid-then-direct fallback as {@link runGateProcess}'s own reapGroup. */
export const reapAllGateGroups = (): number => {
  let killed = 0
  for (const pid of Array.from(liveGateGroups)) {
    liveGateGroups.delete(pid)
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
      else process.kill(pid, 'SIGKILL')
      killed += 1
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
        killed += 1
      } catch {
        /* already gone */
      }
    }
  }
  return killed
}

/** Wire the reaper to THIS process's death. Call ONCE, and only from the real
 *  server entry — importing this module in a vitest worker or a script must not
 *  change that process's signal disposition. Idempotent; no-op on win32.
 *
 *  BOTH handlers are required and neither suffices alone: 'exit' does NOT run on
 *  a default SIGTERM (Node terminates without it), and SIGTERM is the likely path
 *  — Electron SIGTERMs the forked server on quit. Installing a SIGTERM/SIGINT
 *  listener SUPPRESSES Node's default termination, so each handler must exit
 *  itself; 128+signum keeps the status a shell sees honest. A SIGKILL of the
 *  server is uncatchable and stays uncovered by construction — that residue is
 *  exactly what stuckProcessWatch is for. */
export const installGateGroupReaper = (): void => {
  if (globalThis.__openground_gate_reaper_installed) return
  globalThis.__openground_gate_reaper_installed = true
  if (process.platform === 'win32') return
  process.on('exit', () => {
    reapAllGateGroups()
  })
  const onSignal = (code: number) => () => {
    reapAllGateGroups()
    process.exit(code)
  }
  process.on('SIGTERM', onSignal(143))
  process.on('SIGINT', onSignal(130))
}

/** A child-process runner for any engine stage that spawns a tool which itself FORKS a
 *  worker pool — the merge gate's two vitest suites + eslint, and the self-supply
 *  scanners (vitest / eslint / tsc). It differs from `execFile` in exactly
 *  one way that matters: the child is spawned DETACHED (its own process-group leader) and, on
 *  EVERY exit path (timeout, spawn error, OR a normal close), the WHOLE group is SIGKILLed via a
 *  negative-pid signal — reaping the tool AND its forks together.
 *
 *  WHY: vitest with no explicit pool uses the default FORK pool (child_process workers).
 *  execFile's `timeout` SIGTERMs ONLY the direct pid, so on a wedged-suite timeout — precisely
 *  when the suite is stuck and the forks are live — the fork workers ORPHAN, each spinning a
 *  core to machine saturation. That is this repo's own documented hazard
 *  (feedback_vitest_no_midrun_kill: killing only the parent orphans the forks worker), and the
 *  very orphan the engine's self-update path already group-kills (electron/selfUpdate.js
 *  killProcessTree). A negative-pid SIGKILL reaches the group leader and every fork in it. The
 *  forks share the leader's group (vitest/eslint never re-group the way playwright's webServer
 *  does), so an IMMEDIATE group SIGKILL — not the SIGINT-then-escalate gracefulGroupKill — is the
 *  correct reaper here. We do NOT `unref()` the child: the caller still awaits it; `detached`
 *  only changes its process group, not the parent's wait.
 *
 *  FAIL-CLOSED is preserved exactly: resolves `{ stdout, stderr }` on a clean exit 0, and REJECTS
 *  with an Error carrying `stdout`/`stderr` (so the existing `errMsg`/tail catch keeps working) on
 *  non-zero exit, spawn error, OR timeout — so each check turns a timeout into RED, never a silent
 *  pass. The `stdout` on the rejection is what lets a *scanner* (which reads a tool's output
 *  precisely when it exits non-zero) keep its payload; see swarmSelfSupply's runCapture.
 *  (tscCheck's own gate and the git helper keep using execFile: a single process with no worker
 *  pool has no fork to orphan, so the negative-pid machinery would buy nothing.) */
export const runGateProcess = (
  bin: string,
  args: readonly string[],
  opts: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, rejectPromise) => {
    // detached → the child leads its own process group (pgid == pid on POSIX), so a later kill
    // of -pid reaches the WHOLE group (the child + its vitest/eslint forks).
    const child = spawn(bin, [...args], { cwd: opts.cwd, env: opts.env, detached: true })
    // Registered for the SHUTDOWN reaper below: between here and `settle` this
    // group is reachable by nothing but us — that is exactly what `detached`
    // bought — so if the SERVER dies in this window nobody will ever kill it.
    if (typeof child.pid === 'number') liveGateGroups.add(child.pid)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    // A const holder (not a reassigned `let`) so the timeout handle is referenced by
    // `settle` AND assigned below without any forward reference between the two.
    const timerRef: { id?: ReturnType<typeof setTimeout> } = {}

    // SIGKILL the child's whole process group; on POSIX a negative pid hits every member
    // (forks included). A group already gone (ESRCH — e.g. just after a clean exit) is a
    // harmless no-op; non-POSIX / non-leader falls back to a direct child kill.
    const reapGroup = () => {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          /* not a group leader / already gone — fall through to a direct kill */
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }

    const settle = (emit: () => void) => {
      if (settled) return
      settled = true
      if (timerRef.id) clearTimeout(timerRef.id)
      // Reap on the way out on EVERY path. After a clean close vitest has already reaped its
      // own forks (this is then a no-op), but the defensive group kill guarantees no straggler
      // fork survives the gate regardless of how the run ended.
      reapGroup()
      // Deregistered only AFTER the group kill, so a shutdown racing this settle
      // still finds the pid and fires a harmless second SIGKILL rather than
      // missing a live group.
      if (typeof child.pid === 'number') liveGateGroups.delete(child.pid)
      emit()
    }

    // Cap captured output like execFile's maxBuffer (guard against a runaway suite eating
    // memory) but keep DRAINING the pipes so the child never blocks on a full buffer; the
    // captured prefix is enough for the RED tail.
    const append = (cur: string, chunk: string): string =>
      cur.length >= opts.maxBuffer ? cur : (cur + chunk).slice(0, opts.maxBuffer)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, String(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, String(chunk))
    })

    timerRef.id = setTimeout(() => {
      timedOut = true
      settle(() => {
        const e = new Error(`${basename(bin)} timed out after ${opts.timeout}ms`) as Error & {
          stdout?: string
          stderr?: string
          killed?: boolean
        }
        e.stdout = stdout
        e.stderr = stderr
        e.killed = true
        rejectPromise(e)
      })
    }, opts.timeout)

    child.on('error', (err: Error) => {
      settle(() => {
        const e = err as Error & { stdout?: string; stderr?: string }
        e.stdout = stdout
        e.stderr = stderr
        rejectPromise(e)
      })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return // the timer already settled (and reaped) this run
      settle(() => {
        if (code === 0) {
          resolvePromise({ stdout, stderr })
          return
        }
        const e = new Error(
          `${basename(bin)} exited ${code != null ? `with code ${code}` : `via signal ${signal ?? 'unknown'}`}`,
        ) as Error & { stdout?: string; stderr?: string; code?: number | null }
        e.stdout = stdout
        e.stderr = stderr
        e.code = code
        rejectPromise(e)
      })
    })
  })

// ── The untrusted-child environment (2026-07-19) ──────────────────────────────
//
// THE HOLE THIS CLOSES. Every gate/scanner spawn in this repo runs CODE THAT
// COMES FROM THE ARTIFACT BEING JUDGED: eslint loads the worktree's .eslintrc and
// its plugins, vitest loads the worktree's `vitest.config.ts` and every file in
// its `setupFiles` — arbitrary execution at CONFIG-LOAD time, before a single
// assertion runs. Those spawns used to be handed `{ ...process.env }`, i.e. the
// engine's real `OPENGROUND_HOME`, and the comment at each site argued this was
// safe because the suite "re-pins OPENGROUND_HOME to a tmp dir itself
// (src/test/setup-home.ts runs as a vitest setupFile before any test module
// loads)".
//
// That argument is CIRCULAR. `setup-home.ts` and the `vitest.config.ts` that
// loads it BOTH LIVE IN THE WORKTREE — they are part of the untrusted artifact.
// The engine was handing the production home to untrusted code and depending on
// that same untrusted code to disarm itself. No malice is required to break it:
// a branch that merely drops `setupFiles` in a bad rebase points the entire
// suite at the owner's real ~/.openground.
//
// THE INVERSION. The engine decides instead of asking. It mkdtemps a throwaway
// home and hands THAT over, so the production path never enters the child's env
// at all. An honest branch is unaffected (its setup-home re-points
// OPENGROUND_HOME at its own tmp dir — tmp → tmp, same as today); a branch whose
// isolation is gone still cannot NAME the real home, because it was never told
// it. Proven end-to-end against deliberately tampered fixtures in
// gateEnv.test.ts.
//
// WHAT THIS IS NOT. This is an ENV-HANDOFF control, not a sandbox. `HOME` itself
// is deliberately left alone (~20 server modules resolve real paths through
// `homedir()` — ~/.claude transcripts, trust, skills, hooks — and the suite's own
// git-backed tests need the owner's git identity), so code that ACTIVELY deletes
// the injected var can still derive `homedir()/.openground`. Confining that
// requires OS-level confinement (the `sandbox` experiment, docs/SANDBOX_EXPERIMENT.md),
// not another in-process assertion. Reasoning + the rejected alternatives:
// docs/commander/03-integration-review.md §2.9.
//
// SCOPE — VERIFIERS ONLY. Every TS caller here only INSPECTS the tree (tsc,
// eslint, vitest, the self-supply scanners), so stripping is free. A step that
// PRODUCES the shipped artifact must not be starved of its build inputs — see
// electron/gateEnv.js `buildProducerEnv`, which exempts the public BAKED_KEYS for
// `npm run build`. If a producer step is ever added on this side, it needs the
// same exemption.

/** mkdtemp prefix for the throwaway home handed to gate/scanner children. Exported
 *  so a test can assert the child was pointed at OUR dir and not merely at "some
 *  tmp dir" it made for itself. */
export const GATE_HOME_PREFIX = 'openground-gate-home-'

/** Env vars that hand a child a POINTER INTO THE OWNER'S REAL DATA. Each is
 *  REDIRECTED into the throwaway home rather than deleted, because deleting is
 *  strictly worse here: every one of these readers falls back to a
 *  `homedir()`-derived production path when its var is unset
 *  (`paths.ts openGroundHome` → ~/.openground; `youCorpus.defaultAutoMemoryDir` →
 *  ~/.claude/projects/<key>/memory). Unsetting would hand over the real path by
 *  omission — the exact failure mode this module exists to remove. */
export const gateRedirects = (home: string): Record<string, string> => ({
  OPENGROUND_HOME: home,
  OPENGROUND_MEMORY_DIR: join(home, 'memory'),
  OPENGROUND_CONCEPT_PATH: join(home, 'CONCEPT.md'),
  // Same class, found in review round 3: claudeTrust.ts resolves
  // `CLAUDE_CONFIG_PATH || join(homedir(), '.claude.json')` and WRITES to it
  // (trusted-folder entries). It is not in src/test/setup-home.ts either — the
  // suite relies on each test stubbing it — so an untrusted branch's test could
  // reach the owner's real ~/.claude.json. Redirect, don't unset: unset is the
  // homedir fallback. (Every existing test sets it in beforeEach, so pointing it
  // at the throwaway home changes nothing for an honest branch.)
  CLAUDE_CONFIG_PATH: join(home, 'claude.json'),
})

/** Secrets + identity that the engine's own process really does carry (the owner's
 *  dev shell exports them; a claude session launched from inside the packaged app
 *  inherits the Electron server's live env) and that untrusted branch code has no
 *  business receiving.
 *
 *  This list is deliberately THE SAME SET `src/test/setup-home.ts` deletes at the
 *  top of every suite — which is the same anti-pattern in miniature: the untrusted
 *  artifact scrubbing the engine's secrets on the engine's behalf. Stripping them
 *  HERE makes the guarantee independent of the branch, and changes nothing for an
 *  honest one (its setup-home deletes them anyway, so no green test can depend on
 *  them being set). */
/** Secrets + AUTHORITY: never handed to untrusted code, and never bakeable.
 *  MIRRORS `GATE_ENV_FORBIDDEN` in electron/secretPolicy.js (a TS server module
 *  cannot import electron/); the parity test pins the two equal. */
export const GATE_ENV_FORBIDDEN: readonly string[] = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_FEEDBACK_TABLE',
  'SUPABASE_MODULES_TABLE',
  'SUPABASE_ROLES_TABLE',
  'SUPABASE_SUBMISSIONS_TABLE',
  'FEEDBACK_ADMIN_EMAILS',
  'MODULE_ADMIN_EMAILS',
  'OPENGROUND_OWNER_EMAILS',
  'OPENGROUND_TESTER_EMAILS',
  // The local-owner bypass that unlocks every owner-gated route (swarmGate.ts).
  'OPENGROUND_LOCAL_OWNER',
]

/** PUBLIC values stripped from a verifier for TEST HERMETICITY only — the same set
 *  `src/test/setup-home.ts` deletes. They are legitimately baked into the shipped
 *  app and handed BACK to producer steps, which is why they must not live in
 *  {@link GATE_ENV_FORBIDDEN}: the bake guard rejects everything forbidden, and
 *  rejecting these would make `npm run build` emit an empty runtime-config.json.
 *  MIRRORS `GATE_ENV_HERMETIC` in electron/secretPolicy.js. */
export const GATE_ENV_HERMETIC: readonly string[] = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'OPENGROUND_REALTIME',
  'OPENGROUND_COLLAB_WS_URL',
]

/** Everything a verifier child has stripped by NAME LIST. Kept as one exported
 *  array so existing importers keep working. */
export const GATE_ENV_STRIPPED: readonly string[] = [...GATE_ENV_FORBIDDEN, ...GATE_ENV_HERMETIC]

/** Catch-all for secret-NAMED vars no hand list has caught up with — a hand list is
 *  always behind. Round 2 found `OPENGROUND_COLLAB_TICKET_SECRET` (the HMAC shared
 *  secret worker/README.md tells the owner to put in .env.local) missing from the
 *  list; round 4 found the pattern itself blind to the names most likely to exist
 *  on a developer machine — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 *  `AWS_ACCESS_KEY_ID`, `api_key`, `MY_CREDENTIALS`, `DB_PASSWD`, `SIGNING_KEY` —
 *  because it knew nothing of KEY / CREDENTIAL / PASSWD. Substring + `/i`, so
 *  camelCase (`supabaseAuthToken`) is covered. False positives cost a verifier
 *  nothing; producers are protected by the BAKED_KEYS exemption.
 *  MIRRORS `SECRET_NAME_RE` in electron/secretPolicy.js — pinned by the parity test. */
export const SECRET_NAME_RE = /SERVICE_ROLE|SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|KEY|CREDENTIAL/i

/** Is this env var stripped from an untrusted child? (list OR secret-shaped name)
 *  MUST match `isStrippedKey` in electron/gateEnv.js. */
export const isStrippedKey = (key: string): boolean =>
  GATE_ENV_STRIPPED.includes(key) || SECRET_NAME_RE.test(key)

/** Build the env for a child that runs untrusted project code: `base` with every
 *  production-data pointer REDIRECTED into `home` and every secret STRIPPED. Pure
 *  (no I/O, no mutation of `base`) so the policy itself is unit-testable without
 *  spawning anything. */
export const gateEnvFor = (home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base, ...gateRedirects(home) }
  // Iterate the ENV, not the list: the secret-name catch-all can only see keys
  // that are actually present. (No `keep` here — every TS site is a verifier.)
  for (const key of Object.keys(env)) if (isStrippedKey(key)) delete env[key]
  return env
}

/** Run `fn` with a freshly-mkdtemp'd throwaway home wired into a gate env, and
 *  remove that home afterwards on EVERY path (including a thrown/rejected `fn` —
 *  the rejection is re-thrown unchanged so each check's existing
 *  `catch (e) { …e.stdout… }` tail-capture keeps working). The child is already
 *  awaited-and-reaped by {@link runGateProcess} / execFile before the cleanup
 *  runs; a cleanup failure is swallowed (a leftover tmp dir must never turn a
 *  green gate red). */
export const withGateEnv = async <T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> => {
  const home = await mkdtemp(join(tmpdir(), GATE_HOME_PREFIX))
  try {
    return await fn(gateEnvFor(home))
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}
