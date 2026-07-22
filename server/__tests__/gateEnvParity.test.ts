import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  buildGateEnv,
  buildProducerEnv,
  buildStepEnv,
  makeGateHome,
  removeGateHome,
  gateRedirects as electronRedirects,
  GATE_ENV_STRIPPED as ELECTRON_STRIPPED,
  GATE_HOME_PREFIX as ELECTRON_PREFIX,
  SECRET_NAME_RE as ELECTRON_SECRET_RE,
} from '../../electron/gateEnv'
import { writeRuntimeConfig, BAKED_KEYS } from '../../electron/runtimeConfig'
import {
  SECRET_NAME_RE as POLICY_SECRET_RE,
  GATE_ENV_FORBIDDEN as POLICY_FORBIDDEN,
  GATE_ENV_HERMETIC as POLICY_HERMETIC,
  isBakeable,
  assertBakeable,
} from '../../electron/secretPolicy'
import {
  gateEnvFor,
  gateRedirects as serverRedirects,
  GATE_ENV_STRIPPED as SERVER_STRIPPED,
  GATE_ENV_FORBIDDEN as SERVER_FORBIDDEN,
  GATE_ENV_HERMETIC as SERVER_HERMETIC,
  GATE_HOME_PREFIX as SERVER_PREFIX,
  SECRET_NAME_RE as SERVER_SECRET_RE,
} from '@/lib/server/gateProcess'

// electron/gateEnv.js is a deliberate DUPLICATE of the policy in
// src/lib/server/gateProcess.ts: the Electron main process runs the self-update
// rebuild + regression steps and cannot import the TypeScript server module
// (and must not — pulling electron/ into the esbuild server bundle is the
// coupling the plain-CJS split exists to avoid).
//
// Duplicated policy drifts, so this file makes drift RED. The comparison is
// deliberately done TWO ways, because output-equality alone has teeth in only
// ONE direction (measured in review round 1):
//   • REMOVING a key from one copy, or changing a redirect → caught by output
//     equality, because `base` carries that key.
//   • ADDING a key to one copy → NOT caught by output equality: the key is
//     absent from `base`, so `delete` is a no-op on both sides and the outputs
//     still match. This is the direction drift actually takes (a new secret env
//     var gets added to the TS list and forgotten in the JS one).
// So the lists are compared AS SETS first, and `base` is then GENERATED from the
// union of both lists — which keeps the output comparison total even if someone
// adds a key and skips the set assertion.

/** Every key either policy claims to strip, so `base` can never fall behind. */
// Array.from, not [...set] — the repo's tsconfig target rejects spreading a Set
// (TS2802 without downlevelIteration).
const strippedUnion = Array.from(new Set([...SERVER_STRIPPED, ...ELECTRON_STRIPPED]))

/** A base env carrying one of everything: the production-data pointers both
 *  policies redirect, every key either policy strips, and innocuous passthrough. */
/** Names that must be caught by the secret-NAME pattern rather than the hand list
 *  — including the real one review round 2 found missing (the collab HMAC secret). */
const patternProbes = [
  'OPENGROUND_COLLAB_TICKET_SECRET',
  'SOME_VENDOR_SERVICE_ROLE',
  'CI_DEPLOY_TOKEN',
  'DB_PASSWORD',
  'SIGNING_PRIVATE_MATERIAL',
  // Round 4: names that LEAKED before KEY/CREDENTIAL/PASSWD were added. These are
  // the ones most likely to exist on the owner's own machine, which is what made
  // the omission serious rather than theoretical.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'api_key',
  'MY_CREDENTIALS',
  'DB_PASSWD',
  'SIGNING_KEY',
  // camelCase must be covered too (substring + /i) — this one always was.
  'supabaseAuthToken',
]

const base: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'ja_JP.UTF-8',
  ...Object.fromEntries(Object.keys(serverRedirects('/x')).map((k) => [k, `/Users/someone/real-${k}`])),
  ...Object.fromEntries(Object.keys(electronRedirects('/x')).map((k) => [k, `/Users/someone/real-${k}`])),
  ...Object.fromEntries(strippedUnion.map((k) => [k, `secret-value-of-${k}`])),
  ...Object.fromEntries(patternProbes.map((k) => [k, `secret-value-of-${k}`])),
}

describe('electron/gateEnv.js ⟷ gateProcess.ts policy parity', () => {
  it('strips the SAME SET of keys (catches a key added to only one copy)', () => {
    expect(new Set(ELECTRON_STRIPPED)).toEqual(new Set(SERVER_STRIPPED))
  })

  it('redirects the SAME SET of keys, to the same values', () => {
    expect(electronRedirects('/tmp/h')).toEqual(serverRedirects('/tmp/h'))
  })

  it('produces a byte-identical env for the same throwaway home', () => {
    const home = '/tmp/throwaway-home'
    expect(buildGateEnv({ home, base })).toEqual(gateEnvFor(home, base))
  })

  it('agrees on the mkdtemp prefix (so one grep finds every gate home)', () => {
    expect(ELECTRON_PREFIX).toBe(SERVER_PREFIX)
  })

  it('agrees on the secret-NAME catch-all, and it actually catches', () => {
    expect(ELECTRON_SECRET_RE.source).toBe(SERVER_SECRET_RE.source)
    expect(ELECTRON_SECRET_RE.flags).toBe(SERVER_SECRET_RE.flags)
    // The hand list is always behind; the pattern is what covers a secret nobody
    // remembered to enumerate. OPENGROUND_COLLAB_TICKET_SECRET is the real one
    // (worker/README.md tells the owner to configure it) that was slipping through.
    const env = buildGateEnv({ home: '/tmp/h', base })
    for (const key of patternProbes) expect(env[key], `${key} must be stripped by name`).toBeUndefined()
    // …and it must not eat ordinary vars the child legitimately needs.
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.LANG).toBe('ja_JP.UTF-8')
  })

  it('actually strips and redirects (the parity assertions are not comparing two no-ops)', () => {
    const env = buildGateEnv({ home: '/tmp/h', base })
    for (const key of strippedUnion) expect(env[key], `${key} must be stripped`).toBeUndefined()
    expect(env.OPENGROUND_HOME).toBe('/tmp/h')
    expect(strippedUnion.length).toBeGreaterThan(5)
  })

  it('applies `extra` last — the resolved login-shell PATH must survive', () => {
    // A Finder-launched .app inherits a stripped PATH; main.js resolves the
    // login-shell PATH and passes it as `extra`. If the policy ever clobbered it,
    // npm/node would vanish and every self-update regression step would fail.
    const env = buildGateEnv({ home: '/tmp/h', base, extra: { PATH: '/opt/homebrew/bin:/usr/bin' } })
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
    expect(env.OPENGROUND_HOME).toBe('/tmp/h')
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
  })

  it('does not mutate the base env', () => {
    const snapshot = { ...base }
    buildGateEnv({ home: '/tmp/h', base })
    buildProducerEnv({ home: '/tmp/h', base })
    expect(base).toEqual(snapshot)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The PRODUCER exemption — `npm run build` bakes an artifact from its env
// ─────────────────────────────────────────────────────────────────────────────

describe('buildProducerEnv — the self-update build must still bake runtime-config.json', () => {
  /** The env a real build would see: the public baked values plus a real secret. */
  const buildBase: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    SUPABASE_URL: 'https://real.supabase.co',
    SUPABASE_ANON_KEY: 'anon-public-key',
    OPENGROUND_REALTIME: '1',
    OPENGROUND_COLLAB_WS_URL: 'wss://collab.example',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-must-not-leak',
    OPENGROUND_LOCAL_OWNER: '1',
  }
  const configIn = (env: NodeJS.ProcessEnv): Record<string, string> => {
    const dir = mkdtempSync(join(tmpdir(), 'og-gate-runtimecfg-'))
    try {
      // Same call scripts/write-runtime-config.js makes, against a scratch file.
      writeRuntimeConfig(env, join(dir, 'runtime-config.json'))
      return JSON.parse(readFileSync(join(dir, 'runtime-config.json'), 'utf8'))
    } finally {
      // rmSync, not removeGateHome: since review round 2 the latter refuses any
      // path that is not one of OUR gate homes, so it would no-op here.
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('keeps every BAKED_KEY, so the engine build emits the same artifact a human build does', () => {
    // TEETH: with the pre-review policy (no exemption) this object was `{}` —
    // runtimeConfig ALWAYS writes the file, so a stripped env does not preserve
    // the previous values, it erases them. The shipped result was an app with
    // "Sign in" gone and collab off for everyone, invisible in any diff because
    // electron/runtime-config.json is gitignored.
    const baked = configIn(buildProducerEnv({ home: '/tmp/h', base: buildBase }))
    expect(baked).toEqual({
      SUPABASE_URL: 'https://real.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public-key',
      OPENGROUND_REALTIME: '1',
      OPENGROUND_COLLAB_WS_URL: 'wss://collab.example',
    })
  })

  it('still strips the real secrets and still redirects the home', () => {
    const env = buildProducerEnv({ home: '/tmp/h', base: buildBase })
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
    expect(env.OPENGROUND_LOCAL_OWNER).toBeUndefined()
    expect(env.OPENGROUND_HOME).toBe('/tmp/h')
  })

  it('all three copies of the policy agree (pattern AND both lists)', () => {
    // buildProducerEnv exempts all of BAKED_KEYS from stripping, so the bake guard
    // and the strip policy are one argument: whatever the guard admits is handed to
    // untrusted post-merge code. They must therefore be the SAME rules, not merely
    // similar ones. Rounds 3 and 4 both found them diverging (pattern missing
    // TOKEN; guard checking only the pattern while stripping was pattern ∪ list).
    expect(POLICY_SECRET_RE.source).toBe(SERVER_SECRET_RE.source)
    expect(POLICY_SECRET_RE.flags).toBe(SERVER_SECRET_RE.flags)
    expect(ELECTRON_SECRET_RE.source).toBe(SERVER_SECRET_RE.source)
    expect(new Set(POLICY_FORBIDDEN)).toEqual(new Set(SERVER_FORBIDDEN))
    expect(new Set(POLICY_HERMETIC)).toEqual(new Set(SERVER_HERMETIC))
    // The two categories must stay disjoint — a key in both would be simultaneously
    // "never bakeable" and "deliberately baked".
    expect(POLICY_FORBIDDEN.filter((k) => POLICY_HERMETIC.includes(k))).toEqual([])
  })

  it('NOTHING the strip policy forbids may be baked — the exemption cannot outrun the guard', () => {
    // THE round-4 invariant. `keep` (BAKED_KEYS) overrides stripping, so a key that
    // is stripped-but-bakeable is handed to untrusted code by both producer steps.
    // Measured before the fix: adding FEEDBACK_ADMIN_EMAILS to BAKED_KEYS passed
    // the guard and all 34 tests, and the owner's admin allowlist rode along.
    for (const key of BAKED_KEYS) {
      expect(POLICY_FORBIDDEN, `${key} is exempt from stripping and must not be forbidden`).not.toContain(key)
      expect(isBakeable(key), `${key} is in BAKED_KEYS but the bake guard rejects it`).toBe(true)
    }
    // Every forbidden key must be refused by the guard, by name, not by luck.
    for (const key of POLICY_FORBIDDEN) {
      expect(() => assertBakeable([key]), `${key} must never be bakeable`).toThrow(/refusing to bake/)
    }
    // The exact experiments from the review, as regressions.
    expect(() => assertBakeable(['FEEDBACK_ADMIN_EMAILS'])).toThrow(/refusing to bake/)
    expect(() => assertBakeable(['OPENGROUND_OWNER_EMAILS'])).toThrow(/refusing to bake/)
    expect(() => assertBakeable(['SUPABASE_ROLES_TABLE'])).toThrow(/refusing to bake/)
    expect(() => assertBakeable(['OPENGROUND_LOCAL_OWNER'])).toThrow(/refusing to bake/)
    expect(() => assertBakeable(['OPENGROUND_COLLAB_TICKET_TOKEN'])).toThrow(/refusing to bake/) // round 3
    expect(() => assertBakeable(['ANTHROPIC_API_KEY'])).toThrow(/refusing to bake/) // round 4
    expect(() => assertBakeable(BAKED_KEYS)).not.toThrow()
  })

  it('the hermetic set is stripped from verifiers but NOT forbidden (round-1 regression)', () => {
    // These are public and legitimately baked. If a future edit "tidies" them into
    // FORBIDDEN, the bake guard would throw at module load and `npm run build`
    // would emit `{}` — the exact sign-in-disappears bug from round 1.
    const env = buildGateEnv({ home: '/tmp/h', base })
    for (const key of POLICY_HERMETIC) {
      expect(env[key], `${key} must be stripped from a verifier`).toBeUndefined()
      expect(isBakeable(key), `${key} must stay bakeable`).toBe(true)
    }
  })

  it('exempts EXACTLY the runtimeConfig allowlist — not a hand-copied list', () => {
    // buildProducerEnv reads BAKED_KEYS from runtimeConfig.js, so a future baked
    // key is exempted automatically. runtimeConfig.js's assertNoSecretKeys refuses
    // to put a secret-named key in that list — using the same SECRET_NAME_RE the
    // strip policy uses (pinned above), which is what makes the exemption safe.
    const producer = buildProducerEnv({ home: '/tmp/h', base })
    const verifier = buildGateEnv({ home: '/tmp/h', base })
    const extra = Object.keys(producer).filter((k) => !(k in verifier))
    expect(new Set(extra)).toEqual(new Set(BAKED_KEYS.filter((k: string) => k in base)))
  })

  it('the VERIFIER env still strips them — the distinction is the whole point', () => {
    // Pins the asymmetry: verifier steps (tsc/eslint/vitest/scanners) inspect the
    // tree and get nothing; only the producer step gets its build inputs.
    expect(configIn(buildGateEnv({ home: '/tmp/h', base: buildBase }))).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Which steps are producers — DERIVED from the repo, not trusted from a comment
// ─────────────────────────────────────────────────────────────────────────────

describe('producer/verifier assignment matches the repo build topology', () => {
  // Review round 2, must-fix 2: swapping buildProducerEnv → buildGateEnv at a call
  // site left all 26 tests green, because the source pin only knew about the
  // `...process.env` spellings. These tests close that: the producer decision is
  // pinned as BEHAVIOUR (buildStepEnv), as a DECLARATION (the steps table), and —
  // crucially — the declaration is CROSS-CHECKED against what the scripts really
  // run, so adding `npm run build` to another step's script fails here instead of
  // silently erasing runtime-config.json.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8')

  it('buildStepEnv keeps BAKED_KEYS for a producer step and strips them for a verifier', () => {
    const opts = { home: '/tmp/h', base: { SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'nope' } }
    expect(buildStepEnv({ producer: true }, opts).SUPABASE_ANON_KEY).toBe('anon')
    expect(buildStepEnv({ producer: false }, opts).SUPABASE_ANON_KEY).toBeUndefined()
    expect(buildStepEnv(undefined as never, opts).SUPABASE_ANON_KEY).toBeUndefined() // default = verifier
    // A producer never becomes a way to smuggle real secrets out.
    expect(buildStepEnv({ producer: true }, opts).SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
  })

  /** Does this npm script transitively run the build? Follows `npm run X` one hop
   *  through package.json, and — for a playwright step — through the config's
   *  `webServer.command`, which is exactly where the transitive build hides. */
  const runsBuild = (script: string, scripts: Record<string, string>): boolean => {
    // Array.from over matchAll — same tsconfig-target restriction as [...set].
    let text = script
    for (const m of Array.from(script.matchAll(/npm run ([\w:-]+)/g))) text += '\n' + (scripts[m[1]] ?? '')
    if (/playwright/.test(text)) text += '\n' + read('playwright.config.ts')
    return /npm run build\b/.test(text)
  }

  it('the e2e step really does run a build (the premise of its producer flag)', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(runsBuild(scripts['test:e2e'], scripts), 'playwright webServer.command should start with `npm run build &&`').toBe(true)
    expect(runsBuild(scripts.test, scripts), '`npm test` must not run a build').toBe(false)
  })

  it('every self-update step that runs a build is DECLARED producer (and no other is)', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    const main = read('electron/main.js')
    const table = main.slice(main.indexOf('const SELF_UPDATE_TEST_STEPS'), main.indexOf('KNOWN_GOOD_BACKUP_DIR'))
    expect(table, 'steps table not found — update this test, not the guard').toContain("name: 'e2e'")

    // Split the table into per-step chunks and read each step's declared command +
    // producer flag straight out of the source.
    const chunks = table.split(/\n\s*\{\s*\n/).slice(1)
    const declared = chunks.map((chunk) => {
      // Strip comment lines FIRST: the steps table is heavily commented, and
      // `// producer: true,` must not read as a declaration. (Caught while
      // teeth-testing this very test — commenting the flag out left it green.)
      const code = chunk
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      return {
        name: code.match(/name: '([^']+)'/)?.[1] ?? '?',
        cmd: code.match(/\|\| '([^']+)'/)?.[1] ?? '',
        producer: /producer:\s*true/.test(code),
      }
    })
    expect(declared.map((s) => s.name).sort()).toEqual(['e2e', 'unit'])

    for (const step of declared) {
      const scriptName = step.cmd.replace(/^npm (run )?/, '')
      const body = scripts[scriptName] ?? step.cmd
      expect(
        step.producer,
        `step '${step.name}' runs \`${step.cmd}\`. If that transitively runs \`npm run build\` it MUST be ` +
          `declared producer: true (else build:config re-bakes runtime-config.json from a stripped env and ` +
          `writes {}); if it does not, it must NOT be. See electron/gateEnv.js buildStepEnv.`,
      ).toBe(runsBuild(body, scripts))
    }
  })

  it('the build spawns actually use the producer-aware helpers', () => {
    // The remaining textual link: these two spawns cannot be driven from vitest.
    // Anchor on the spawn's own `env:` LINE rather than a fixed character window
    // (review round 3, nit 2 — a few extra comment lines used to push the helper
    // out of the window and the assertion passed vacuously).
    const main = read('electron/main.js')
    const envArgOf = (spawnMarker: string): string => {
      const at = main.indexOf(spawnMarker)
      expect(at, `spawn site not found: ${spawnMarker} — update this test, not the guard`).toBeGreaterThan(-1)
      const envLine = main
        .slice(at)
        .split('\n')
        .find((l) => /^\s*env:/.test(l))
      expect(envLine, `no env: option on the spawn at ${spawnMarker}`).toBeDefined()
      return envLine as string
    }
    expect(envArgOf("spawn('npm', ['run', 'build']"), 'runBuild must use buildProducerEnv').toContain(
      'buildProducerEnv(',
    )
    expect(envArgOf('const child = spawn(cmd, cmdArgs'), 'spawnTestStep must use buildStepEnv(step, …)').toContain(
      'buildStepEnv(step,',
    )
  })
})

describe('electron/gateEnv.js throwaway home lifecycle', () => {
  it('makeGateHome creates under tmpdir; removeGateHome removes it and tolerates junk', () => {
    const home = makeGateHome()
    try {
      expect(home.startsWith(tmpdir())).toBe(true)
      expect(home).toContain(ELECTRON_PREFIX)
      expect(existsSync(home)).toBe(true)
    } finally {
      removeGateHome(home)
    }
    expect(existsSync(home)).toBe(false)
    // settle() may run twice / before a home was made — must never throw, since a
    // throw there would abort a self-update rollback.
    expect(() => removeGateHome(home)).not.toThrow()
    expect(() => removeGateHome(null)).not.toThrow()
    // NB: this literal deliberately avoids the substring `-home-<word>` — the repo
    // PII guard reads that as an encoded ~/ path (claude session-key form) and
    // flags the next word as a username (repoPiiGuard.test.ts HOME_PATH_ENCODED).
    expect(() => removeGateHome(join(tmpdir(), 'og-gate-absent-dir'))).not.toThrow()
  })

  it('refuses to delete anything that is not one of our throwaway homes', () => {
    // Review round 2, nit 3: this is an exported recursive-force delete, so it
    // self-guards instead of trusting every future caller.
    const outsider = mkdtempSync(join(tmpdir(), 'og-not-a-gate-'))
    try {
      removeGateHome(outsider) // wrong prefix → silent no-op, NOT a delete
      expect(existsSync(outsider)).toBe(true)
      removeGateHome(join('/etc', ELECTRON_PREFIX + 'pretend')) // right marker, wrong root
      expect(existsSync('/etc')).toBe(true)
    } finally {
      rmSync(outsider, { recursive: true, force: true })
    }
  })
})
