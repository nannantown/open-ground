// electron/gateEnv.js — the untrusted-child environment for the SELF-UPDATE
// regression steps (`npm run build`, `npm test`, `npm run test:e2e`), extracted
// from electron/main.js so the policy is unit-testable without spawning a process
// (server/__tests__/gateEnvParity.test.ts).
//
// WHY THE MAIN PROCESS NEEDS ITS OWN COPY. The identical policy lives in
// src/lib/server/gateProcess.ts (`gateEnvFor` / `withGateEnv`) and guards the
// merge gate's spawns. But the self-update rebuild+regression runs in the
// ELECTRON MAIN process, which cannot import the TypeScript server module (and
// must not: pulling electron/ into the esbuild server bundle is exactly the
// coupling the plain-CJS split — autoUpdate.js / forkEnv.js / lockdown.js —
// exists to avoid). So the list is duplicated here, and
// server/__tests__/gateEnvParity.test.ts PINS the two copies equal so they
// cannot drift apart silently.
//
// WHAT IT PROTECTS. These steps run `npm run build` / `npm test` against the
// POST-MERGE app root — code the swarm just landed, driven by that tree's own
// package.json scripts, vitest.config.ts and setupFiles. Handing it the engine's
// real OPENGROUND_HOME meant the freshly-landed (and only just-being-verified)
// code was pointed straight at the owner's live data, with nothing but the
// landed code's own setup-home.ts standing between the two. The engine now
// mkdtemps a throwaway home and hands over THAT. See gateProcess.ts's header for
// the full argument and the limits (HOME itself is deliberately untouched).
//
// Plain CommonJS (no `electron` import), like forkEnv.js / lockdown.js, so
// electron/main.js can require it directly and the vitest suite can run it in node.

'use strict'

const { mkdtempSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { BAKED_KEYS } = require('./runtimeConfig')
const {
  SECRET_NAME_RE,
  GATE_ENV_FORBIDDEN,
  GATE_ENV_HERMETIC,
  isStrippedKey,
} = require('./secretPolicy')

/** mkdtemp prefix — MUST match GATE_HOME_PREFIX in src/lib/server/gateProcess.ts. */
const GATE_HOME_PREFIX = 'openground-gate-home-'

/**
 * Production-data pointers, REDIRECTED into the throwaway home (never deleted:
 * every reader falls back to a homedir()-derived production path when its var is
 * unset, so unsetting would hand the real path over by omission).
 * MUST match `gateRedirects` in src/lib/server/gateProcess.ts.
 * @param {string} home
 * @returns {Record<string, string>}
 */
function gateRedirects(home) {
  return {
    OPENGROUND_HOME: home,
    OPENGROUND_MEMORY_DIR: join(home, 'memory'),
    OPENGROUND_CONCEPT_PATH: join(home, 'CONCEPT.md'),
    // claudeTrust.ts: `CLAUDE_CONFIG_PATH || join(homedir(), '.claude.json')`,
    // and it WRITES there. Redirected for the same reason as the others — unset
    // means the homedir fallback (review round 3).
    CLAUDE_CONFIG_PATH: join(home, 'claude.json'),
  }
}

// The strip policy — both lists AND the secret-name catch-all — is IMPORTED from
// electron/secretPolicy.js, which is also what the BAKE guard enforces
// (electron/runtimeConfig.js). One definition, because `buildProducerEnv` exempts
// BAKED_KEYS from stripping: whatever the bake guard admits is handed to
// untrusted post-merge code. Two review rounds found the two drifting apart (see
// secretPolicy.js's header for both). src/lib/server/gateProcess.ts keeps a
// mirror (a TS server module cannot import electron/), pinned equal by
// server/__tests__/gateEnvParity.test.ts.
//
// Re-exported below under the old name so existing importers keep their path.
const GATE_ENV_STRIPPED = GATE_ENV_FORBIDDEN.concat(GATE_ENV_HERMETIC)

/**
 * Build the env for a self-update child that runs post-merge project code.
 * Pure: no I/O, `base` is not mutated. `extra` is applied LAST (that is where
 * main.js's resolved login-shell PATH goes — a Finder-launched .app has a
 * stripped PATH and npm/node must stay reachable).
 *
 * @param {object} opts
 * @param {string} opts.home  Throwaway home (see makeGateHome).
 * @param {NodeJS.ProcessEnv} [opts.base]  Defaults to process.env.
 * @param {NodeJS.ProcessEnv} [opts.extra]  Applied after the redirects.
 * @param {readonly string[]} [opts.keep]  Keys EXEMPT from stripping — see
 *   buildProducerEnv, the only caller that passes it.
 * @returns {NodeJS.ProcessEnv}
 */
function buildGateEnv(opts) {
  const base = opts.base || process.env
  const keep = new Set(opts.keep || [])
  const env = Object.assign({}, base, gateRedirects(opts.home), opts.extra || {})
  // Iterate the ENV, not the list: the secret-name catch-all can only see keys
  // that are actually present. `keep` wins over both the list and the pattern.
  for (const key of Object.keys(env)) if (!keep.has(key) && isStrippedKey(key)) delete env[key]
  return env
}

// ── VERIFIER vs PRODUCER (2026-07-19, review round 1) ────────────────────────
//
// Stripping env is right for a step that only INSPECTS the tree — tsc, eslint,
// vitest, the self-supply scanners. It is WRONG for a step that PRODUCES the
// artifact, because the build's env is a build INPUT: strip it and "the build a
// human runs" and "the build the engine runs" emit different artifacts, and the
// canary then verifies something other than what ships.
//
// `npm run build` is a producer. Its first stage is `npm run build:config` →
// scripts/write-runtime-config.js → runtimeConfig.writeRuntimeConfig(process.env),
// which BAKES BAKED_KEYS (SUPABASE_URL / SUPABASE_ANON_KEY / OPENGROUND_REALTIME /
// OPENGROUND_COLLAB_WS_URL) into electron/runtime-config.json — and ALWAYS writes
// the file, `{}` included, so a stripped env does not leave the old values behind:
// it erases them. The observed failure: an owner who exported SUPABASE_* launches
// the app, a swarm card lands, self-update rebuilds, and the checkout's
// (gitignored, so invisible in any diff) runtime-config.json becomes `{}` —
// after which that checkout ships with "Sign in" gone and collab off for
// everyone. The canary's health probe never looks at auth, so the switch lands.
//
// Exempting BAKED_KEYS costs nothing: runtimeConfig.js:19-27 documents each as a
// PUBLIC value (the Supabase anon key is public by design — RLS is the boundary;
// the other two are a feature flag and a WS endpoint), and runtimeConfig.js's
// `assertNoSecretKeys` hard-refuses to put a secret-named key in that list —
// using the SAME `SECRET_NAME_RE` this file strips by, so the exemption can
// never be wider than the strip policy (that gap existed until review round 3).
// The keys that actually
// matter — SUPABASE_SERVICE_ROLE_KEY, the admin/owner allowlists,
// OPENGROUND_LOCAL_OWNER — stay stripped.

/**
 * Env for the one PRODUCER step (`npm run build`): the gate policy, minus the
 * public values the build bakes into the shipped artifact. Reads BAKED_KEYS from
 * runtimeConfig.js rather than re-listing it, so a future baked key is exempted
 * automatically instead of silently erased.
 *
 * @param {object} opts  Same shape as buildGateEnv (minus `keep`).
 * @returns {NodeJS.ProcessEnv}
 */
function buildProducerEnv(opts) {
  return buildGateEnv(Object.assign({}, opts, { keep: BAKED_KEYS }))
}

/**
 * Env for one self-update regression step. A step is a PRODUCER when it runs the
 * build — directly or TRANSITIVELY.
 *
 * The transitive case is the one that bit us twice (review round 2): the `e2e`
 * step runs `npm run test:e2e` → playwright → and playwright.config.ts's
 * `webServer.command` STARTS WITH `npm run build && …`. The webServer pins its own
 * HOME/OPENGROUND_HOME, but only for the `node server/dist/index.cjs` at the END of
 * that command — the `npm run build` at the FRONT inherits this step's env. So a
 * verifier env there re-ran build:config with BAKED_KEYS stripped and overwrote
 * electron/runtime-config.json with `{}` AGAIN, minutes after runBuild had baked it
 * correctly — and `performEngineSwitch` → `forkEngine` re-reads readBakedAuthEnv()
 * on the spot, so sign-in disappeared from the RUNNING app, not just the next launch.
 *
 * `producer` is declared per-step in SELF_UPDATE_TEST_STEPS (electron/main.js) and
 * cross-checked against the repo's real build topology by
 * server/__tests__/gateEnvParity.test.ts, so adding `npm run build` to another
 * step's script fails a test instead of silently erasing the config.
 *
 * @param {{producer?: boolean}} step
 * @param {object} opts  Same shape as buildGateEnv.
 * @returns {NodeJS.ProcessEnv}
 */
function buildStepEnv(step, opts) {
  return step && step.producer ? buildProducerEnv(opts) : buildGateEnv(opts)
}

/**
 * mkdtemp a throwaway home. Sync on purpose: main.js's spawn helpers assemble
 * their env inside an already-running promise chain, and a sync mkdtemp keeps
 * that assembly a single expression with no extra await to forget.
 * @returns {string}
 */
function makeGateHome() {
  return mkdtempSync(join(tmpdir(), GATE_HOME_PREFIX))
}

/**
 * Remove a throwaway home. Never throws — a leftover tmp dir must never turn a
 * green regression step red (or, worse, abort a self-update rollback).
 * @param {string|null|undefined} home
 */
function removeGateHome(home) {
  if (!home) return
  // SELF-GUARD (review round 2, nit 3): this is an exported recursive-force
  // delete. Every production caller passes a makeGateHome() result, but nothing
  // structural said so. Anything that is not one of OUR throwaway homes is a
  // silent no-op rather than a delete — which also keeps the "a path that does
  // not exist must not throw" contract intact.
  if (typeof home !== 'string' || !home.startsWith(tmpdir()) || home.indexOf(GATE_HOME_PREFIX) === -1) return
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* best-effort: the OS reaps tmpdir anyway */
  }
}

module.exports = {
  GATE_HOME_PREFIX,
  GATE_ENV_STRIPPED,
  SECRET_NAME_RE,
  isStrippedKey,
  gateRedirects,
  buildGateEnv,
  buildProducerEnv,
  buildStepEnv,
  makeGateHome,
  removeGateHome,
}
