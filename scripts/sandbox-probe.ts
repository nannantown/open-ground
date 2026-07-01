/**
 * sandbox-probe.ts — kernel-level proof of the owner-only `experiments.sandbox`
 * containment (macOS only). Builds the EXACT profile the app uses
 * (src/lib/server/sandbox.ts → buildSandboxProfile) and runs a battery of
 * `sandbox-exec -f <profile> …` probes, asserting each is allowed or denied as
 * designed. Pairs with sandbox.test.ts (which pins the profile TEXT in CI, where
 * there is no kernel to enforce it).
 *
 *   npx tsx scripts/sandbox-probe.ts
 *
 * SAFE BY CONSTRUCTION: every probe runs against a THROWAWAY home + cwd under
 * tmp (built into the profile + passed as $HOME to the sandboxed command), so the
 * real ~/.ssh / ~/.claude / ~/.openground are never read or written, even if a
 * containment rule were wrong. Exits 0 iff every probe matched its expectation.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { buildSandboxProfile } from '../src/lib/server/sandbox'

if (process.platform !== 'darwin') {
  console.error('sandbox-probe: macOS only (sandbox-exec); skipping.')
  process.exit(0)
}

// ── setup (UNsandboxed), entirely under a throwaway root ────────────────────
// The root sits under the REAL home (a /Users path, like a production home),
// NOT under /tmp or /var/folders — those are (a) symlinked (/var → /private/var,
// so the kernel-resolved path wouldn't match an unresolved rule) and (b) blanket
// write-allowed in the profile (TMPDIR), which would mask the "write outside cwd
// is denied" probe. Real ~/.ssh / ~/.claude are NEVER touched: the fixtures live
// under <root>/home/, a sibling of them, and the root is removed on exit.
const root = realpathSync(mkdtempSync(join(homedir(), '.og-sandbox-probe-')))
const HOME = join(root, 'home') // fake $HOME — real home is never touched
const cwd = join(root, 'cwd')
for (const d of [HOME, cwd, join(HOME, '.ssh'), join(HOME, '.claude'), join(HOME, '.openground'), join(HOME, 'Documents'), join(HOME, '.cache'), join(HOME, '.docker'), join(HOME, '.azure'), join(HOME, '.cargo'), join(HOME, '.cargo', 'registry'), join(HOME, '.config', 'git'), join(HOME, '.gradle', 'caches'), join(HOME, '.m2', 'repository')]) {
  mkdirSync(d, { recursive: true })
}
// Fixtures the deny-probes target (so a wrongly-allowed write lands on a fake).
writeFileSync(join(HOME, '.ssh', 'id_rsa'), 'SENTINEL-SECRET')
writeFileSync(join(HOME, '.claude', 'settings.json'), '{"real":"do-not-clobber"}')
writeFileSync(join(HOME, '.openground', 'settings.json'), '{"projects":[]}')
writeFileSync(join(HOME, '.npmrc'), '//registry.npmjs.org/:_authToken=SENTINEL')
writeFileSync(join(HOME, '.yarnrc.yml'), 'npmAuthToken: SENTINEL')
writeFileSync(join(HOME, '.docker', 'config.json'), '{"auths":{"x":{"auth":"SENTINEL"}}}')
writeFileSync(join(HOME, '.azure', 'accessTokens.json'), '[{"accessToken":"SENTINEL"}]')
writeFileSync(join(HOME, '.cargo', 'credentials.toml'), '[registry]\ntoken="SENTINEL"')
writeFileSync(join(HOME, '.cargo', 'registry', 'marker'), 'build-data-readable') // parent dir must stay readable
writeFileSync(join(HOME, '.config', 'git', 'credentials'), 'https://x:SENTINEL@h') // XDG git store
writeFileSync(join(HOME, '.vault-token'), 'SENTINEL')
writeFileSync(join(HOME, '.gradle', 'gradle.properties'), 'signing.password=SENTINEL')
writeFileSync(join(HOME, '.gradle', 'caches', 'marker'), 'build-data-readable')
writeFileSync(join(HOME, '.m2', 'settings.xml'), '<settings><servers>SENTINEL</servers></settings>')
writeFileSync(join(HOME, '.m2', 'repository', 'marker'), 'build-data-readable')

// A worker worktree's node_modules is a SYMLINK to the MAIN checkout's. Recreate
// that: <root>/mainco/node_modules with a package + vite dep slice + a .bin shim,
// then symlink <cwd>/node_modules at it. The profile carves out NONE of it, so
// writes (the RCE poisoning vector) must be DENIED while reads (build needs them)
// stay allowed.
const mainNm = join(root, 'mainco', 'node_modules')
for (const d of [join(mainNm, 'somepkg'), join(mainNm, '.vite', 'deps'), join(mainNm, '.bin')]) {
  mkdirSync(d, { recursive: true })
}
writeFileSync(join(mainNm, 'somepkg', 'index.js'), 'module.exports=1') // build reads this
writeFileSync(join(mainNm, '.vite', 'deps', 'dep.js'), 'export default 1') // dev-server serves this
symlinkSync(mainNm, join(cwd, 'node_modules'))
const profilePath = join(root, 'profile.sb')

const cleanup = () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}

try {
  // The profile the worker/interactive launch would use for THIS cwd, built for
  // the FAKE home. (.git + node_modules sit inside cwd here, so no extra write
  // carve-outs are needed; the worker's cross-tree .git case is sandbox.test.ts.)
  writeFileSync(profilePath, buildSandboxProfile({ cwd, home: HOME }))

  // A committable git repo + an in-cwd bare remote (configured UNsandboxed) so the
  // git-commit and git-push probes exercise real .git writes under the sandbox.
  const g = (...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' })
  execFileSync('git', ['init', '-q', '--bare', join(cwd, 'remote.git')], { stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 'probe@local')
  g('config', 'user.name', 'probe')
  g('remote', 'add', 'origin', join(cwd, 'remote.git'))
  writeFileSync(join(cwd, 'seed.txt'), 'seed')
  g('add', '-A')
  g('commit', '-q', '-m', 'seed')
  // A neutral subdir for the symlink-swap exploit probes (creating a `.git` /
  // `.claude` ENTRY here must be denied even though the parent is writable).
  mkdirSync(join(cwd, 'swaptest'), { recursive: true })
  // Pre-create the submodule/worktree gitdirs UNsandboxed (their entry creation
  // is itself denied in-sandbox), so the deny/allow probes below test real
  // sandbox decisions, not ENOENT on a missing parent.
  mkdirSync(join(cwd, '.git', 'modules', 'm'), { recursive: true })
  mkdirSync(join(cwd, '.git', 'worktrees', 'wt'), { recursive: true })
  // a NESTED submodule gitdir, to prove the deep-nesting entry-anchor.
  mkdirSync(join(cwd, '.git', 'modules', 'm', 'modules', 'n'), { recursive: true })

  // ── probe runner ──────────────────────────────────────────────────────────
  type Expect = 'allow' | 'deny'
  interface Probe {
    name: string
    expect: Expect
    cmd: string[]
    optional?: boolean
  }
  const sandboxed = (argv: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync('sandbox-exec', ['-f', profilePath, ...argv], {
        stdio: 'pipe',
        timeout: 30_000,
        env: { ...process.env, HOME }, // sandboxed cmd sees the FAKE home
      })
      return { code: 0, out: out.toString() }
    } catch (e) {
      const err = e as { status?: number; stdout?: unknown }
      return {
        code: typeof err.status === 'number' ? err.status : 1,
        out: String(err.stdout ?? ''),
      }
    }
  }
  const w = (p: string) => `echo x > ${p}`

  const probes: Probe[] = [
    // core containment
    { name: 'WRITE inside cwd', expect: 'allow', cmd: ['sh', '-c', w(`${cwd}/probe-in.txt`)] },
    { name: 'WRITE outside cwd (~/…)', expect: 'deny', cmd: ['sh', '-c', w('$HOME/OUTSIDE.txt')] },
    { name: 'WRITE outside cwd (~/Documents/x)', expect: 'deny', cmd: ['sh', '-c', w('$HOME/Documents/OUTSIDE.txt')] },
    { name: 'READ ~/.ssh/id_rsa', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.ssh/id_rsa'] },
    { name: 'READ ~/.npmrc (npm token)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.npmrc'] },
    { name: 'READ ~/.docker/config.json (registry auth)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.docker/config.json'] },
    { name: 'READ ~/.cargo/credentials.toml (crates token)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.cargo/credentials.toml'] },
    { name: 'READ ~/.yarnrc.yml (yarn-berry token)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.yarnrc.yml'] },
    { name: 'READ ~/.azure/accessTokens.json (Azure token)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.azure/accessTokens.json'] },
    { name: 'READ ~/.config/git/credentials (XDG git store)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.config/git/credentials'] },
    { name: 'READ ~/.vault-token', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.vault-token'] },
    { name: 'READ ~/.gradle/gradle.properties (signing creds)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.gradle/gradle.properties'] },
    { name: 'READ ~/.m2/settings.xml (Maven repo creds)', expect: 'deny', cmd: ['sh', '-c', 'cat $HOME/.m2/settings.xml'] },
    { name: 'READ ~/.cargo/registry/* (build data — NOT over-denied)', expect: 'allow', cmd: ['sh', '-c', 'cat $HOME/.cargo/registry/marker > /dev/null'] },
    { name: 'READ ~/.gradle/caches/* + ~/.m2/repository/* (build data)', expect: 'allow', cmd: ['sh', '-c', 'cat $HOME/.gradle/caches/marker $HOME/.m2/repository/marker > /dev/null'] },
    { name: 'READ normal file (/etc/hosts)', expect: 'allow', cmd: ['sh', '-c', 'cat /etc/hosts > /dev/null'] },
    { name: 'SPAWN node + write cwd (build proxy)', expect: 'allow', cmd: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(join(cwd, 'built.js'))},'1')`] },
    // node_modules symlink (worker worktree → main checkout): reads ALLOWED (build
    // needs deps), writes DENIED — incl. the vite dev-server slices + .bin shims
    // that would otherwise run un-sandboxed in main (the round-5 RCE-class fix).
    { name: 'READ cwd/node_modules/somepkg (symlink→main dep)', expect: 'allow', cmd: ['sh', '-c', `cat ${cwd}/node_modules/somepkg/index.js > /dev/null`] },
    { name: 'WRITE cwd/node_modules/.vite/deps (dev-server slice)', expect: 'deny', cmd: ['sh', '-c', w(`${cwd}/node_modules/.vite/deps/poison.js`)] },
    { name: 'WRITE cwd/node_modules/.bin (exec shim)', expect: 'deny', cmd: ['sh', '-c', w(`${cwd}/node_modules/.bin/poison`)] },
    // git commit + a REAL push to the in-cwd bare remote
    { name: 'git commit (writes .git in cwd)', expect: 'allow', cmd: ['sh', '-c', `cd ${cwd} && echo more >> seed.txt && git add -A && git commit -q -m probe`] },
    { name: 'git push → in-cwd bare remote', expect: 'allow', cmd: ['sh', '-c', `cd ${cwd} && git push -q origin HEAD:refs/heads/probe`] },
    // BLOCKER-A: out-of-sandbox persistence vectors must be DENIED for write
    { name: 'WRITE ~/.claude/settings.json (hook persist)', expect: 'deny', cmd: ['sh', '-c', w('$HOME/.claude/settings.json')] },
    { name: 'WRITE ~/.claude/hooks/evil.sh', expect: 'deny', cmd: ['sh', '-c', `mkdir -p $HOME/.claude/hooks 2>/dev/null; ${w('$HOME/.claude/hooks/evil.sh')}`] },
    { name: 'WRITE ~/.openground/settings.json (allowlist)', expect: 'deny', cmd: ['sh', '-c', w('$HOME/.openground/settings.json')] },
    { name: 'WRITE cwd/.git/hooks/pre-commit', expect: 'deny', cmd: ['sh', '-c', w(`${cwd}/.git/hooks/pre-commit`)] },
    { name: 'WRITE cwd/.git/config', expect: 'deny', cmd: ['sh', '-c', w(`${cwd}/.git/config`)] },
    { name: 'WRITE cwd/.git/modules/m/config (submodule)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p ${cwd}/.git/modules/m 2>/dev/null; ${w(`${cwd}/.git/modules/m/config`)}`] },
    { name: 'WRITE cwd/.git/worktrees/wt/config.worktree', expect: 'deny', cmd: ['sh', '-c', `mkdir -p ${cwd}/.git/worktrees/wt 2>/dev/null; ${w(`${cwd}/.git/worktrees/wt/config.worktree`)}`] },
    { name: 'WRITE cwd/.git/config.lock (atomic tmp — NOT over-matched)', expect: 'allow', cmd: ['sh', '-c', w(`${cwd}/.git/config.lock`)] },
    // PROJECT-LOCAL auto-executing config (the round-2 residual): inside the
    // writable cwd, auto-triggered by OG's non-sandboxed sessions — must be DENIED.
    { name: 'WRITE cwd/.claude/settings.json (project hook)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p ${cwd}/.claude 2>/dev/null; ${w(`${cwd}/.claude/settings.json`)}`] },
    { name: 'WRITE cwd/.mcp.json (project MCP server)', expect: 'deny', cmd: ['sh', '-c', w(`${cwd}/.mcp.json`)] },
    { name: 'WRITE cwd/.claude/hooks/evil.sh (project hook)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p ${cwd}/.claude/hooks 2>/dev/null; ${w(`${cwd}/.claude/hooks/evil.sh`)}`] },
    { name: 'WRITE ~/.claude/skills/evil.sh (global skill script)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p $HOME/.claude/skills 2>/dev/null; ${w('$HOME/.claude/skills/evil.sh')}`] },
    { name: 'WRITE cwd/.claude/skills/evil.sh (project skill script)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p ${cwd}/.claude/skills 2>/dev/null; ${w(`${cwd}/.claude/skills/evil.sh`)}`] },
    // SYMLINK-SWAP escape (round-6): the dir ENTRY itself must be deny, not just
    // its children — else `mv X X.bak && ln -s /evil X` redirects every child.
    { name: 'SWAP create .git ENTRY (ln -s)', expect: 'deny', cmd: ['sh', '-c', `ln -s /tmp/og-evil ${cwd}/swaptest/.git`] },
    { name: 'SWAP create .claude ENTRY (ln -s)', expect: 'deny', cmd: ['sh', '-c', `ln -s /tmp/og-evil ${cwd}/swaptest/.claude`] },
    { name: 'SWAP create .openground ENTRY (ln -s)', expect: 'deny', cmd: ['sh', '-c', `ln -s /tmp/og-evil ${cwd}/swaptest/.openground`] },
    { name: 'WRITE ~/.openground/custom-modules/index.json (module register)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p $HOME/.openground/custom-modules 2>/dev/null; ${w('$HOME/.openground/custom-modules/index.json')}`] },
    { name: 'WRITE ~/.openground/swarm/x.json (heartbeat — still allowed)', expect: 'allow', cmd: ['sh', '-c', `mkdir -p $HOME/.openground/swarm 2>/dev/null; ${w('$HOME/.openground/swarm/x.json')}`] },
    { name: 'SWAP create ~/.claude/hooks ENTRY (ln -s)', expect: 'deny', cmd: ['sh', '-c', 'ln -s /tmp/og-evil $HOME/.claude/hooks'] },
    // rename the EXISTING .git/hooks entry (the proven exploit's step 1) — denied.
    // Placed AFTER the git commit/push probes so a (wrongly) allowed mv can't break them.
    { name: 'SWAP rename .git/hooks ENTRY (mv)', expect: 'deny', cmd: ['sh', '-c', `mv ${cwd}/.git/hooks ${cwd}/.git/hooks.bak`] },
    // round-7: the INTERMEDIATE gitdirs (.git/modules, .git/worktrees, per-name)
    // must be entry-anchored too — else swap them to redirect config/hooks below.
    { name: 'SWAP rename .git/modules ENTRY (mv)', expect: 'deny', cmd: ['sh', '-c', `mv ${cwd}/.git/modules ${cwd}/.git/modules.bak`] },
    { name: 'SWAP rename .git/worktrees ENTRY (mv)', expect: 'deny', cmd: ['sh', '-c', `mv ${cwd}/.git/worktrees ${cwd}/.git/worktrees.bak`] },
    { name: 'SWAP rename .git/modules/m per-name ENTRY (mv)', expect: 'deny', cmd: ['sh', '-c', `mv ${cwd}/.git/modules/m ${cwd}/.git/modules/m.bak`] },
    { name: 'WRITE .git/modules/m/hooks/pre-commit (submodule hook)', expect: 'deny', cmd: ['sh', '-c', `mkdir -p ${cwd}/.git/modules/m/hooks 2>/dev/null; ${w(`${cwd}/.git/modules/m/hooks/pre-commit`)}`] },
    // NESTED submodule intermediate (round-7 upgrade): .git/modules/m/modules[/n].
    { name: 'SWAP nested .git/modules/m/modules ENTRY (mv)', expect: 'deny', cmd: ['sh', '-c', `mv ${cwd}/.git/modules/m/modules ${cwd}/.git/modules/m/modules.bak`] },
    { name: 'SWAP create nested .git/modules/m/modules/fresh ENTRY (ln -s)', expect: 'deny', cmd: ['sh', '-c', `ln -s /tmp/og-evil ${cwd}/.git/modules/m/modules/fresh`] },
    // …but DEEP children (commit state) stay writable, so commit/push are unchanged.
    { name: 'WRITE .git/modules/m/HEAD (deep child — commit state)', expect: 'allow', cmd: ['sh', '-c', w(`${cwd}/.git/modules/m/HEAD`)] },
    { name: 'WRITE .git/modules/m/modules/n/HEAD (nested deep child)', expect: 'allow', cmd: ['sh', '-c', w(`${cwd}/.git/modules/m/modules/n/HEAD`)] },
    // …but INSTRUCTION content (project CLAUDE.md) stays writable (not auto-exec).
    { name: 'WRITE cwd/CLAUDE.md (legit project content)', expect: 'allow', cmd: ['sh', '-c', w(`${cwd}/CLAUDE.md`)] },
    // MAJOR-A: tightened ~/.claude.json regex must NOT over-match
    { name: 'WRITE ~/.claude.jsonEVIL (regex over-match)', expect: 'deny', cmd: ['sh', '-c', w('$HOME/.claude.jsonEVIL')] },
    // claude's own state writes MUST still work (functionality)
    { name: 'WRITE ~/.claude/projects/x.jsonl (session)', expect: 'allow', cmd: ['sh', '-c', `mkdir -p $HOME/.claude/projects 2>/dev/null; ${w('$HOME/.claude/projects/x.jsonl')}`] },
    { name: 'WRITE ~/.claude.json (claude rewrites it)', expect: 'allow', cmd: ['sh', '-c', w('$HOME/.claude.json')] },
    { name: 'WRITE ~/.cache/x (toolchain cache)', expect: 'allow', cmd: ['sh', '-c', w('$HOME/.cache/x')] },
    // network: outbound allowed, no listeners
    { name: 'OUTBOUND → 127.0.0.1 (app-context curl)', expect: 'allow', cmd: ['node', '-e', `const s=require('net').connect(9,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',e=>process.exit((e.code==='EPERM'||e.code==='EACCES')?7:0))`] },
    { name: 'BIND 0.0.0.0 (public listener)', expect: 'deny', cmd: ['node', '-e', `const s=require('net').createServer();s.on('error',()=>process.exit(7));s.listen(0,'0.0.0.0',()=>process.exit(0))`] },
    { name: 'BIND 127.0.0.1 (loopback listener — also denied)', expect: 'deny', cmd: ['node', '-e', `const s=require('net').createServer();s.on('error',()=>process.exit(7));s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})`] },
    { name: 'claude --version (startup smoke)', expect: 'allow', optional: true, cmd: ['sh', '-c', 'command -v claude >/dev/null && claude --version'] },
  ]

  // ── compile check ─────────────────────────────────────────────────────────
  const compile = sandboxed(['true'])
  if (compile.code !== 0) {
    console.error('✗ profile FAILED to compile under sandbox-exec:\n' + compile.out)
    console.error('\n--- profile ---\n' + buildSandboxProfile({ cwd, home: HOME }))
    cleanup()
    process.exit(2)
  }

  // ── run ─────────────────────────────────────────────────────────────────
  let failed = 0
  let skipped = 0
  const rows: string[] = []
  for (const p of probes) {
    const { code, out } = sandboxed(p.cmd)
    if (p.optional && code !== 0 && /not found|command not/.test(out)) {
      rows.push(`  —  SKIP  ${p.name} (tool absent)`)
      skipped++
      continue
    }
    const actual: Expect = code === 0 ? 'allow' : 'deny'
    const ok = actual === p.expect
    if (!ok) failed++
    rows.push(`  ${ok ? '✓' : '✗'}  want=${p.expect.padEnd(5)} got=${actual.padEnd(5)} ${p.name}`)
  }

  console.log('\nSandbox containment probes (real macOS Seatbelt, throwaway home)\n' + '='.repeat(64))
  console.log(rows.join('\n'))
  console.log('='.repeat(64))
  console.log(`${probes.length - failed - skipped} passed · ${failed} failed · ${skipped} skipped`)
  cleanup()
  process.exit(failed === 0 ? 0 : 1)
} catch (e) {
  cleanup()
  console.error('sandbox-probe: unexpected error', e)
  process.exit(2)
}
