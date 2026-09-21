// gateEnv.test.ts — the untrusted-child ENV HANDOFF invariant (2026-07-19).
//
// WHAT IS BEING PROVEN. The merge gate runs `vitest` / `eslint` / `tsc` from
// INSIDE the worktree it is judging. Loading that worktree's `vitest.config.ts`
// and its `setupFiles` is arbitrary code execution before a single assertion
// runs. Until this change those spawns were handed `{ ...process.env }` — the
// engine's real OPENGROUND_HOME — and the safety argument written at each site
// was "the suite re-pins OPENGROUND_HOME to a tmp dir itself
// (src/test/setup-home.ts)". That argument is circular: setup-home.ts and the
// vitest.config.ts that loads it are PART OF THE ARTIFACT BEING JUDGED. The
// engine was trusting untrusted code to disarm itself on the engine's behalf.
//
// The tests below pin the inversion (the engine decides, mkdtemps a throwaway
// home, hands over THAT) at three levels:
//   1. policy   — gateEnvFor is pure and the real home never survives it
//   2. lifetime — withGateEnv creates under tmpdir and always cleans up
//   3. wiring   — no code-execution spawn anywhere reverts to a raw env handoff
//
// This file is a member of SWARM_SAFETY_TESTS, so it is deliberately CHEAP and
// spawns nothing (review round 1, nit 6). The end-to-end demonstration against a
// tampered fixture worktree — which does spawn a real vitest — lives next door in
// gateEnvTamper.test.ts and runs via the full suite.
//
// TEETH. (3) fails the moment any site is reverted textually, including the
// three this file cannot exercise end-to-end (tsc / lint / swarm-safety) and the
// two in electron/main.js that no vitest process can spawn. Its limits are real
// and stated at the assertion: it is a tripwire for the shapes a revert actually
// takes, not a proof of absence.

import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'fs'
import { readFile, } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { GATE_HOME_PREFIX, gateEnvFor, withGateEnv } from './gateProcess'

// Intercept ONLY the spawn primitive. withGateEnv (the thing under test) stays
// real — mocking it would make the behavioural assertion below vacuous.
vi.mock('./gateProcess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gateProcess')>()),
  runGateProcess: vi.fn(async () => ({ stdout: '', stderr: '' })),
}))

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// ─────────────────────────────────────────────────────────────────────────────
// 1. Policy — gateEnvFor
// ─────────────────────────────────────────────────────────────────────────────

describe('gateEnvFor — the handoff policy', () => {
  const engineHome = '/Users/someone/.openground'
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    OPENGROUND_HOME: engineHome,
    OPENGROUND_MEMORY_DIR: '/Users/someone/.claude/projects/x/memory',
    OPENGROUND_CONCEPT_PATH: '/Users/someone/repo/CONCEPT.md',
    SUPABASE_SERVICE_ROLE_KEY: 'sb-secret',
    SUPABASE_URL: 'https://real.supabase.co',
    FEEDBACK_ADMIN_EMAILS: 'owner@example.com',
    OPENGROUND_LOCAL_OWNER: '1',
    OPENGROUND_CLAUDE_BIN: '/usr/local/bin/claude',
  }

  it('redirects every production-data pointer into the throwaway home', () => {
    const env = gateEnvFor('/tmp/throwaway', base)
    expect(env.OPENGROUND_HOME).toBe('/tmp/throwaway')
    expect(env.OPENGROUND_MEMORY_DIR).toBe(join('/tmp/throwaway', 'memory'))
    expect(env.OPENGROUND_CONCEPT_PATH).toBe(join('/tmp/throwaway', 'CONCEPT.md'))
  })

  it('REDIRECTS rather than deletes — an unset var falls back to the production path', () => {
    // The distinction is the whole point: `delete env.OPENGROUND_HOME` would send
    // paths.ts openGroundHome() to homedir()/.openground, i.e. hand the real home
    // over by omission. Every pointer must carry a throwaway VALUE, never nothing.
    const env = gateEnvFor('/tmp/throwaway', base)
    for (const key of ['OPENGROUND_HOME', 'OPENGROUND_MEMORY_DIR', 'OPENGROUND_CONCEPT_PATH']) {
      expect(env[key], `${key} must be redirected, not unset`).toBeTruthy()
    }
  })

  it('strips the secrets/authority the engine really carries', () => {
    const env = gateEnvFor('/tmp/throwaway', base)
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
    expect(env.SUPABASE_URL).toBeUndefined()
    expect(env.FEEDBACK_ADMIN_EMAILS).toBeUndefined()
    // The local-owner bypass unlocks every owner-gated route (swarmGate.ts).
    expect(env.OPENGROUND_LOCAL_OWNER).toBeUndefined()
  })

  it('leaves everything else alone (the gate must still == what a human runs)', () => {
    const env = gateEnvFor('/tmp/throwaway', base)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.OPENGROUND_CLAUDE_BIN).toBe('/usr/local/bin/claude')
  })

  it('never lets the engine home survive into ANY value — hostile code cannot even learn it', () => {
    // The residual documented in docs/commander/03 §2.9 is that in-process code
    // can still DERIVE homedir()/.openground. What it must never be able to do is
    // READ the engine's actual home out of its own environment.
    const env = gateEnvFor('/tmp/throwaway', base)
    expect(Object.values(env).some((v) => typeof v === 'string' && v.includes(engineHome))).toBe(false)
  })

  it('does not mutate the base env', () => {
    const snapshot = { ...base }
    gateEnvFor('/tmp/throwaway', base)
    expect(base).toEqual(snapshot)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lifetime — withGateEnv
// ─────────────────────────────────────────────────────────────────────────────

describe('withGateEnv — throwaway home lifetime', () => {
  it('creates a real dir under tmpdir with the gate prefix, and removes it after', async () => {
    let seen = ''
    await withGateEnv(async (env) => {
      seen = env.OPENGROUND_HOME as string
      expect(seen.startsWith(tmpdir())).toBe(true)
      expect(seen).toContain(GATE_HOME_PREFIX)
      expect(existsSync(seen)).toBe(true)
      return 'ok'
    })
    expect(existsSync(seen)).toBe(false)
  })

  it('cleans up on rejection AND re-throws the error unchanged (tail-capture keeps working)', async () => {
    let seen = ''
    const boom = Object.assign(new Error('vitest exited with code 1'), { stdout: 'FAIL probe.test.ts' })
    await expect(
      withGateEnv(async (env) => {
        seen = env.OPENGROUND_HOME as string
        throw boom
      }),
    ).rejects.toBe(boom)
    // Each check's catch reads e.stdout to build the RED tail — it must survive.
    expect((boom as { stdout?: string }).stdout).toBe('FAIL probe.test.ts')
    expect(existsSync(seen)).toBe(false)
  })

  it('hands a DIFFERENT home to every call (no shared scratch between branches)', async () => {
    const a = await withGateEnv(async (env) => env.OPENGROUND_HOME as string)
    const b = await withGateEnv(async (env) => env.OPENGROUND_HOME as string)
    expect(a).not.toBe(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Wiring — no code-execution spawn may reintroduce the raw handoff
// ─────────────────────────────────────────────────────────────────────────────

describe('no spawn site hands untrusted code the raw engine env', () => {
  // A SOURCE-TEXT pin, in the same spirit as the SKILL.md wording pin next door:
  // the four gate checks, the self-supply scanners and the two electron
  // self-update steps cannot all be driven end-to-end from one vitest process
  // (electron's cannot be driven from any), so the guard is textual. Git spawns
  // are the deliberate exception — `git` is a trusted binary invoked with an argv
  // array, and a worktree shares its hooks dir with the main checkout via
  // GIT_COMMON_DIR, so a branch cannot install a hook by committing a file.
  //
  // KNOWN LIMIT (measured in review round 1): this is a TRIPWIRE, not a proof.
  // It matches the shapes a revert actually takes — a spread, and the
  // `Object.assign` rewrite of the same thing — but any sufficiently different
  // spelling (a helper that returns process.env, a computed key) walks past it.
  // Textual pins cannot be exhaustive; the value here is catching the copy-paste
  // regression, and the docs must not claim more than that.
  const files = [
    'src/lib/server/swarmOrchestrator.ts',
    'electron/main.js',
  ]

  /** Both spellings of "hand the whole ambient env to a child". */
  const RAW_HANDOFF = /\.\.\.process\.env|Object\.assign\([^)]*process\.env/

  for (const rel of files) {
    it(`${rel} passes process.env wholesale only into git spawns`, async () => {
      const src = await readFile(join(repoRoot, rel), 'utf8')
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => RAW_HANDOFF.test(line))
        // Comments DESCRIBE the banned pattern (this control is documented at
        // several sites, and doc text that quotes the pattern must not read as a
        // violation of it). Only executable lines count.
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        // git spawns are the deliberate exception (see above).
        .filter(({ line }) => !line.includes('GIT_TERMINAL_PROMPT'))
        .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`)

      expect(
        offenders,
        'a child that runs project code must get its env from withGateEnv (TS) / buildGateEnv or ' +
          'buildProducerEnv (electron), never the ambient env wholesale — see gateProcess.ts',
      ).toEqual([])
    })
  }

  it('the pin catches BOTH spellings a revert would use', () => {
    // Guards the guard: nit 3 was that `Object.assign({}, process.env, { PATH })`
    // slipped through while the spread form was caught.
    expect(RAW_HANDOFF.test('    env: { ...process.env, PATH: enrichedPath },')).toBe(true)
    expect(RAW_HANDOFF.test('    env: Object.assign({}, process.env, { PATH: enrichedPath }),')).toBe(true)
    // …and does not fire on an ordinary single-variable read.
    expect(RAW_HANDOFF.test('  const port = Number(process.env.PORT) || 47776')).toBe(false)
  })
})
