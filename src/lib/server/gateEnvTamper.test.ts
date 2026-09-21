import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { GATE_HOME_PREFIX, runGateProcess, withGateEnv } from './gateProcess'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Build a fixture that mimics a branch whose HOME isolation has been removed:
 *  `vitest.config.ts` no longer lists `setupFiles`, and `src/test/setup-home.ts`
 *  is gutted to a no-op. Nothing in the tree re-pins OPENGROUND_HOME — so
 *  whatever the ENGINE hands over is what the suite gets, which is the property
 *  under test. node_modules is symlinked from the main checkout so the fixture uses
 *  the project's real vitest binary. */
const buildTamperedFixture = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'og-gate-tamper-fixture-'))
  await mkdir(join(dir, 'src', 'test'), { recursive: true })
  await symlink(join(repoRoot, 'node_modules'), join(dir, 'node_modules'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'gate-tamper-fixture', private: true }))

  // TAMPER 1 — the config that loads the isolation is missing `setupFiles`.
  await writeFile(
    join(dir, 'vitest.config.ts'),
    [
      "import { defineConfig } from 'vitest/config'",
      '// TAMPERED: the real vitest.config.ts carries',
      "//   setupFiles: ['./src/test/setup-home.ts', './src/test/setup-dom.ts']",
      '// This branch dropped it — which a bad rebase does without any malice.',
      'export default defineConfig({',
      '  test: {',
      "    include: ['probe.test.ts'],",
      "    environment: 'node',",
      '    // Single fork, no file parallelism. NOT part of the tamper (that is the',
      '    // missing setupFiles above) — this caps what the NESTED vitest costs the',
      '    // outer suite. Measured: without it, this test pushed the real-git tests',
      '    // in selfUpdateOnIntegrate.test.ts past their 5s default timeout (7 of 13',
      '    // red; green again with this file excluded).',
      "    pool: 'forks',",
      '    poolOptions: { forks: { singleFork: true, minForks: 1, maxForks: 1 } },',
      '    fileParallelism: false,',
      '  },',
      '})',
    ].join('\n'),
  )

  // TAMPER 2 — the isolation file itself, gutted.
  await writeFile(
    join(dir, 'src', 'test', 'setup-home.ts'),
    '// TAMPERED: the real file mkdtemps a home and pins OPENGROUND_HOME to it.\nexport {}\n',
  )

  // The probe: report the OPEN GROUND home this suite can reach, and try to write
  // into it. SAFETY BELT — it writes ONLY when the resolved home is under tmpdir,
  // so even a catastrophic regression of the code under test cannot make this
  // fixture touch a real ~/.openground. The REPORT is the actual assertion; the
  // write only proves the reachability is not theoretical.
  await writeFile(
    join(dir, 'probe.test.ts'),
    [
      "import { it, expect } from 'vitest'",
      "import { mkdirSync, writeFileSync } from 'fs'",
      "import { homedir, tmpdir } from 'os'",
      "import { dirname, join } from 'path'",
      "import { fileURLToPath } from 'url'",
      '',
      'const here = dirname(fileURLToPath(import.meta.url))',
      '',
      "it('reports the OPEN GROUND home it can reach', () => {",
      // Verbatim paths.ts openGroundHome().
      "  const home = process.env.OPENGROUND_HOME || join(homedir(), '.openground')",
      "  writeFileSync(join(here, 'resolved-home.txt'), home)",
      '  if (home.startsWith(tmpdir())) {',
      '    mkdirSync(home, { recursive: true })',
      "    writeFileSync(join(home, 'GATE-ESCAPE-CANARY.txt'), 'reached')",
      '  }',
      '  expect(true).toBe(true)',
      '})',
    ].join('\n'),
  )
  return dir
}

describe('the gate against a worktree whose HOME isolation was removed', () => {
  it(
    'hands the suite a throwaway home — the engine home is unreachable and unnamed',
    async () => {
      // This suite's own OPENGROUND_HOME stands in for "the engine's real home":
      // it is precisely the value a raw `{ ...process.env }` would leak downward.
      const engineHome = process.env.OPENGROUND_HOME
      expect(engineHome, 'setup-home must have pinned a home for this to mean anything').toBeTruthy()

      const dir = await buildTamperedFixture()
      try {
        const result = await withGateEnv((env) => runGateProcess(
          process.execPath,
          [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1'],
          { cwd: dir, timeout: 120_000, maxBuffer: 2_000_000, env },
        ))

        // Vacuity guard: if the probe never ran, every assertion below is empty.
        const reportPath = join(dir, 'resolved-home.txt')
        expect(
          existsSync(reportPath),
          `the probe never ran — the fixture is broken, not the code. check output: ${result.stdout + result.stderr}`,
        ).toBe(true)
        const childHome = (await readFile(reportPath, 'utf8')).trim()

        // THE INVARIANT: what the untrusted suite could reach was OUR throwaway.
        // TEETH (verified by hand): revert the launcher to `{ ...process.env }` and
        // childHome becomes byte-identical to engineHome, failing right here.
        expect(childHome).not.toBe(engineHome)
        expect(childHome.startsWith(tmpdir())).toBe(true)
        expect(childHome).toContain(GATE_HOME_PREFIX)

        // And the reachable write really did land in the throwaway, not in the
        // engine's home. (The throwaway is already gone — withGateEnv removed it
        // when the check returned — so its absence here is expected, and the
        // engine home's cleanliness is the assertion that has teeth.)
        expect(existsSync(join(engineHome as string, 'GATE-ESCAPE-CANARY.txt'))).toBe(false)
        expect(existsSync(join(homedir(), '.openground', 'GATE-ESCAPE-CANARY.txt'))).toBe(false)

        // A green fixture suite must still read as green through the gate.
        expect(result.stdout).toContain('1 passed')
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
    180_000, // spawns a real vitest; generous under a saturated machine
  )
})
