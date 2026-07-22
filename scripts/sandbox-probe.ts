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
 * SAFE BY CONSTRUCTION — with ONE stated exception: every probe but one runs
 * against a THROWAWAY home + cwd under tmp (built into the profile + passed as
 * $HOME to the sandboxed command), so the real ~/.ssh / ~/.claude / ~/.openground
 * are never read or written even if a containment rule were wrong. The exception
 * is the KEYCHAIN credential-read row, which MUST use the real home to be
 * meaningful (the deny it guards is anchored at `<home>/Library/Keychains`);
 * there, safety rests on the command being read-only by CHOICE — `security
 * find-generic-password` WITHOUT `-w`, i.e. attributes only, no secret, no write.
 * Keep it that way if you add real-home rows. Exits 0 iff every probe matched.
 */
import { execFileSync, execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { buildSandboxProfile } from '../src/lib/server/sandbox'
import { createEgressProxy, BRAIN_EGRESS_ALLOW_HOSTS } from '../src/lib/server/egressProxy'

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
const brainProfilePath = join(root, 'brain-profile.sb')
// A profile built for the REAL home — used by exactly ONE probe, the login-keychain
// read that guards the "sandboxed claude starts Not-logged-in" regression. It has to
// be the real home: the deny that caused that bug is anchored at `<home>/Library/
// Keychains`, so a fake-home profile could never reproduce or catch it. The only
// command run under it is a read-only `security find-generic-password` WITHOUT `-w`
// (attributes only — no secret is read, nothing is written).
const realHomeProfilePath = join(root, 'realhome-profile.sb')
// That probe must ALSO run with the real $HOME in env, not the fake one every other
// probe gets: `security` resolves the login keychain under $HOME, so with the fake
// home it reports "could not be found" and the row would silently SKIP forever —
// a regression guard that can never fire (observed while writing it).
const REAL_HOME = realpathSync(homedir())
// Precondition for that row, resolved UNSANDBOXED: is claude actually logged in on
// this machine? It must NOT be inferred from the sandboxed run — a kernel read-deny
// makes the item *invisible*, so `security` reports the same "could not be found" as
// a machine that never logged in, and a skip-on-message rule would swallow the exact
// regression the row exists to catch (observed: with the deny re-added the row
// SKIPPED instead of failing). Absent here = genuinely absent, the row may skip;
// present here = the row is REQUIRED to pass.
const claudeLoggedIn = (() => {
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
// A THROWAWAY keychain inside the FAKE home, for the write half of the same rule
// (claude persists its refreshed OAuth token back into the keychain). It is named
// `login.keychain` on purpose: the profile scopes the write-allow to that file
// FAMILY rather than the whole dir, so the probe has to sit in the family to test
// the real rule. It is still entirely a throwaway under the fake home — the user's
// actual login keychain is never opened or written by this script.
const probeKeychain = join(HOME, 'Library', 'Keychains', 'login.keychain')

const cleanup = () => {
  try {
    execFileSync('/usr/bin/security', ['delete-keychain', probeKeychain], { stdio: 'ignore' })
  } catch {} // never created, or already gone
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}

const main = async (): Promise<never> => {
  // The profile the worker/interactive launch would use for THIS cwd, built for
  // the FAKE home. (.git + node_modules sit inside cwd here, so no extra write
  // carve-outs are needed; the worker's cross-tree .git case is sandbox.test.ts.)
  writeFileSync(profilePath, buildSandboxProfile({ cwd, home: HOME }))
  // The OVERSEER-BRAIN profile: same home/cwd shape but network:'loopback' — the
  // egress-close battery below proves off-machine outbound is KERNEL-denied while
  // the loopback allowlist proxy remains reachable (docs/SANDBOX_EXPERIMENT.md
  // egress-proxy follow-up; wired in swarmOverseerBrain.makeOverseerBrain).
  writeFileSync(brainProfilePath, buildSandboxProfile({ cwd, home: HOME, network: 'loopback' }))
  // See realHomeProfilePath above — real home, one read-only keychain probe.
  writeFileSync(realHomeProfilePath, buildSandboxProfile({ cwd, home: REAL_HOME }))
  // Create the throwaway keychain UNsandboxed (its dir must exist first), so the
  // in-sandbox probe tests the WRITE rule rather than ENOENT on a missing parent.
  mkdirSync(join(HOME, 'Library', 'Keychains'), { recursive: true })
  try {
    execFileSync('/usr/bin/security', ['create-keychain', '-p', 'probe', probeKeychain], { stdio: 'ignore' })
  } catch {} // if this fails the probe below reports deny and the row fails loudly
  // A stand-in for the per-UUID data-protection keychain + its keybag, which share
  // ~/Library/Keychains with the login keychain and must stay READ-denied: the
  // carve-in is deny-the-dir + re-allow-the-login-family, and this is what proves
  // the deny half still bites. (Named like the real thing; entirely in the fake home.)
  const dpDir = join(HOME, 'Library', 'Keychains', 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB')
  mkdirSync(dpDir, { recursive: true })
  writeFileSync(join(dpDir, 'keychain-2.db'), 'SENTINEL-DP-KEYCHAIN')
  writeFileSync(join(dpDir, 'user.kb'), 'SENTINEL-KEYBAG')
  // The DP metadata store, at depth 1 — BOTH spellings. The legacy
  // `metadata.keychain` is not hypothetical (present on the dev machine, 0600,
  // 2016) and was measurably read-ALLOWED while only the `-db` twin was denied:
  // the depth regex starts at depth 2, so each needs its own literal, and a
  // one-spelling fix looks correct until you look at the directory.
  writeFileSync(join(HOME, 'Library', 'Keychains', 'metadata.keychain'), 'SENTINEL-DP-META-LEGACY')
  writeFileSync(join(HOME, 'Library', 'Keychains', 'metadata.keychain-db'), 'SENTINEL-DP-META')
  // Certificate TRUST SETTINGS — read-allowed (not a secret) but WRITE-denied,
  // since a planted root is policy an UN-sandboxed process honours. It lives
  // beside the keychains and is NOT matched by the login-family write regex.
  // Absent on the dev machine, so only a fake-home stand-in can fire this row —
  // which is exactly how the legacy-metadata gap stayed invisible.
  writeFileSync(join(HOME, 'Library', 'Keychains', 'TrustSettings.plist'), 'SENTINEL-TRUST')
  // BROWSER credential stores. The keychain carve-in hands a contained worker
  // `Chrome Safe Storage` (the vault's master key); these are the vault itself.
  // Every real profile-directory SHAPE is represented, because the depth differs
  // per browser and per user-created profile — a deny that only covered
  // `Chrome/Default` would leave the rest open and still look green.
  const browserSecrets = [
    ['Google/Chrome/Default', 'Login Data'],
    ['Google/Chrome/Profile 1', 'Login Data'], // user-created profile (deeper name w/ space)
    ['Google/Chrome/Default', 'Cookies'],
    ['Google/Chrome/Default', 'Web Data'], // autofill, incl. stored cards
    ['Microsoft Edge/Default', 'Login Data'], // shallower vendor dir
    ['BraveSoftware/Brave-Browser/Default', 'Login Data'],
    ['Firefox/Profiles/probe.default', 'key4.db'], // Firefox master key
    ['Firefox/Profiles/probe.default', 'cookies.sqlite'],
  ] as const
  for (const [dir, file] of browserSecrets) {
    mkdirSync(join(HOME, 'Library', 'Application Support', dir), { recursive: true })
    writeFileSync(join(HOME, 'Library', 'Application Support', dir, file), 'SENTINEL-BROWSER-SECRET')
  }
  // NEGATIVE CONTROLS for the same rules: non-credential files in the very same
  // dirs must stay READABLE. The deny is the credential DBs, not the browser
  // dirs — claude is legitimately asked to work on a Chrome extension's source.
  writeFileSync(join(HOME, 'Library', 'Application Support', 'Google/Chrome', 'Local State'), 'not-a-secret')
  mkdirSync(join(HOME, 'Library', 'Application Support', 'my-extension'), { recursive: true })
  writeFileSync(join(HOME, 'Library', 'Application Support', 'my-extension', 'index.js'), 'extension-source')
  // Safari / NSHTTPCookieStorage — the Safari-side twin of the Chromium jars.
  mkdirSync(join(HOME, 'Library', 'Cookies'), { recursive: true })
  writeFileSync(join(HOME, 'Library', 'Cookies', 'Cookies.binarycookies'), 'SENTINEL-SAFARI-COOKIES')
  // A NON-login keychain the realpath-escape probe aims at: the `login.keychain*`
  // write regex ends in `.*`, so a `login.keychain…`-PREFIXED DIR can be created
  // and written under. The claim under test is that this cannot be used as a
  // springboard OUT of the family — the kernel matches the RESOLVED path.
  writeFileSync(join(HOME, 'Library', 'Keychains', 'escape-target.keychain'), 'SENTINEL-NONLOGIN')
  // …and the springboard dir itself, created UNSANDBOXED. An in-sandbox
  // `mkdir && write` would exit non-zero whether the KERNEL denied the write (the
  // thing under test) or the mkdir merely failed — a false green of exactly the
  // kind this file already pre-creates gitdirs to avoid.
  mkdirSync(join(HOME, 'Library', 'Keychains', 'login.keychainDIR'), { recursive: true })
  // The REAL allowlist CONNECT proxy (running UNsandboxed, as it does in the app)
  // — the brain probes tunnel through it exactly like the brain's claude would.
  const egress = await createEgressProxy({ allowHosts: BRAIN_EGRESS_ALLOW_HOSTS })
  const proxyEnv = {
    HTTPS_PROXY: `http://127.0.0.1:${egress.port}`,
    https_proxy: `http://127.0.0.1:${egress.port}`,
    NO_PROXY: '',
    no_proxy: '',
  }

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
    /** Skip (rather than fail) when the failure output matches — for rows whose
     *  precondition is machine state, e.g. the keychain probe on a machine where
     *  claude was never logged in. Widens `optional`'s default tool-absent test. */
    skipIf?: RegExp
    /** Which profile to run under (default: the worker/interactive one). */
    profile?: string
    /** Extra env for the sandboxed command (the brain probes carry HTTPS_PROXY). */
    env?: Record<string, string>
  }
  // ASYNC (execFile, not execFileSync) — the egress proxy above lives in THIS
  // process, and a synchronous child wait would block the event loop, leaving the
  // proxy unable to answer the very CONNECT the probe is making (the TCP connect
  // itself would still succeed — kernel backlog — masking the hang as a timeout).
  const pExecFile = promisify(execFile)
  const sandboxed = async (
    argv: string[],
    profile: string = profilePath,
    extraEnv?: Record<string, string>,
  ): Promise<{ code: number; out: string }> => {
    try {
      const { stdout } = await pExecFile('sandbox-exec', ['-f', profile, ...argv], {
        timeout: 30_000,
        env: { ...process.env, HOME, ...(extraEnv ?? {}) }, // sandboxed cmd sees the FAKE home
      })
      return { code: 0, out: String(stdout) }
    } catch (e) {
      const err = e as { code?: number | string; stdout?: unknown; stderr?: unknown }
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        // stderr too: the tools that report a missing precondition (`security`,
        // `command -v`) say so there, and the skip tests below match on `out`.
        out: String(err.stdout ?? '') + String(err.stderr ?? ''),
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
    // KEYCHAIN — the one credential store that must stay OPEN. Denying it does not
    // trim an exfil surface, it breaks auth outright: claude's subscription
    // credential lives in the login keychain and Security.framework does that db's
    // file I/O from the CLIENT process. sandbox.test.ts pins the profile TEXT; only
    // these two rows prove the real kernel behaviour behind it.
    //   • read  — the exact reported bug (a sandboxed `claude -p` answered
    //     `Not logged in · Please run /login`). Needs the REAL-home profile, since
    //     the deny that caused it is anchored at `<home>/Library/Keychains`.
    //     Attributes only (no `-w`): no secret is read. Skips when this machine
    //     never logged claude in.
    //   • write — claude persists its REFRESHED OAuth token back to the item, so a
    //     read-only carve-in would start fine and then EPERM hours later. Runs
    //     against the THROWAWAY keychain in the fake home, never the login one.
    {
      name: "KEYCHAIN: read claude's credential (Not-logged-in regression)",
      expect: 'allow',
      // Skippable ONLY when claude was never logged in here (checked unsandboxed).
      // When it IS logged in this row is mandatory, so a re-added deny FAILS loudly.
      optional: !claudeLoggedIn,
      skipIf: /could not be found in the keychain/i,
      profile: realHomeProfilePath,
      env: { HOME: REAL_HOME }, // see REAL_HOME — the fake home makes this row un-fireable
      cmd: ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials'],
    },
    {
      name: 'KEYCHAIN: add item (OAuth token-refresh write path)',
      expect: 'allow',
      cmd: ['/usr/bin/security', 'add-generic-password', '-s', 'og-probe', '-a', 'p', '-w', 'x', probeKeychain],
    },
    // …and the write-allow is the login-keychain FAMILY, not the whole dir: the
    // per-UUID data-protection keychains that share it (Safari / iCloud / app
    // secrets) must stay write-denied. Without this row the rule could silently
    // widen back to `(subpath …/Library/Keychains)` and nothing would notice.
    {
      name: 'KEYCHAIN: write a NON-login keychain path (dir is NOT wide open)',
      expect: 'deny',
      cmd: ['sh', '-c', w(join(HOME, 'Library', 'Keychains', 'other.keychain'))],
    },
    // …and the READ side of the same shape. The first cut of the launch fix dropped
    // the dir-wide read-deny outright, which handed the co-resident
    // data-protection keychain + keybag (Safari / iCloud / app secrets) to a
    // contained worker. These two rows are why that cannot come back silently.
    {
      name: 'KEYCHAIN: read a per-UUID data-protection keychain (co-resident secrets)',
      expect: 'deny',
      cmd: ['sh', '-c', `cat $HOME/Library/Keychains/AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB/keychain-2.db`],
    },
    {
      name: 'KEYCHAIN: read its keybag (user.kb)',
      expect: 'deny',
      cmd: ['sh', '-c', `cat $HOME/Library/Keychains/AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB/user.kb`],
    },
    // …and the DP metadata store at depth 1, in BOTH spellings. The depth regex
    // above starts at depth 2, so these need their own literals — and the legacy
    // spelling was measurably read-ALLOWED on the dev machine while only the `-db`
    // twin was denied. One row per spelling so a re-narrowed fix names itself.
    {
      name: 'KEYCHAIN: read metadata.keychain-db (DP metadata, depth 1)',
      expect: 'deny',
      cmd: ['sh', '-c', 'cat $HOME/Library/Keychains/metadata.keychain-db'],
    },
    {
      name: 'KEYCHAIN: read metadata.keychain (LEGACY spelling — the missed twin)',
      expect: 'deny',
      cmd: ['sh', '-c', 'cat $HOME/Library/Keychains/metadata.keychain'],
    },
    // The `login.keychain*` write regex ends in `.*`, so a `login.keychain…`-PREFIXED
    // DIRECTORY can be created and written under (documented as accepted). What must
    // NOT follow is using it as a springboard OUT of the family: the kernel matches
    // the RESOLVED path, so `..` out of that dir lands on a non-family sibling and is
    // denied. Without this row the acceptance rests on an argument; with it, on a
    // measurement.
    {
      name: 'KEYCHAIN: escape the login family via a login.keychain*-prefixed dir (realpath)',
      expect: 'deny',
      cmd: ['sh', '-c', w('$HOME/Library/Keychains/login.keychainDIR/../escape-target.keychain')],
    },
    // …while writing INSIDE that dir IS allowed — the accepted half of the same
    // trade. Pinning it keeps the row above honest: if a future tightening made the
    // whole prefix unwritable, the escape row would still pass for the wrong reason.
    {
      name: 'KEYCHAIN: write INSIDE a login.keychain*-prefixed dir (accepted inert scratch)',
      expect: 'allow',
      cmd: ['sh', '-c', w('$HOME/Library/Keychains/login.keychainDIR/scratch')],
    },
    // TRUST SETTINGS — read-allowed (not a secret), WRITE-denied. A planted root
    // certificate is policy an UN-sandboxed process honours, which makes this the
    // sharper worry than the keychain items themselves; the login-family write
    // regex deliberately does not reach it. Absent on the dev machine, so it can
    // only be proven against the fake-home stand-in — the same blind spot that let
    // the legacy-metadata gap through.
    {
      name: 'TRUST: write ~/Library/Keychains/TrustSettings.plist (planted root CA)',
      expect: 'deny',
      cmd: ['sh', '-c', w('$HOME/Library/Keychains/TrustSettings.plist')],
    },
    {
      name: 'TRUST: read TrustSettings.plist (not a secret — must NOT be over-denied)',
      expect: 'allow',
      cmd: ['sh', '-c', 'cat $HOME/Library/Keychains/TrustSettings.plist > /dev/null'],
    },
    // BROWSER credential stores — the other half of the keychain carve-in's blast
    // radius. The login keychain holds `Chrome Safe Storage` (the vault's master
    // key) and is now reachable by design; if the vault FILES are reachable too, a
    // contained worker with open egress lifts every saved password. One row per
    // profile-directory SHAPE, since the depth differs per browser and per
    // user-created profile.
    {
      name: 'BROWSER: read Chrome Default/Login Data (saved passwords)',
      expect: 'deny',
      cmd: ['sh', '-c', 'cat "$HOME/Library/Application Support/Google/Chrome/Default/Login Data"'],
    },
    {
      name: 'BROWSER: read Chrome "Profile 1"/Login Data (user-created profile)',
      expect: 'deny',
      cmd: ['sh', '-c', 'cat "$HOME/Library/Application Support/Google/Chrome/Profile 1/Login Data"'],
    },
    {
      name: 'BROWSER: read Chrome Cookies + Web Data (session tokens / stored cards)',
      expect: 'deny',
      cmd: [
        'sh',
        '-c',
        'cat "$HOME/Library/Application Support/Google/Chrome/Default/Cookies" "$HOME/Library/Application Support/Google/Chrome/Default/Web Data"',
      ],
    },
    {
      name: 'BROWSER: read Edge + Brave Login Data (other Chromium vendors)',
      expect: 'deny',
      cmd: [
        'sh',
        '-c',
        'cat "$HOME/Library/Application Support/Microsoft Edge/Default/Login Data" "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data"',
      ],
    },
    {
      name: 'BROWSER: read Firefox key4.db + cookies.sqlite (master key / cookie jar)',
      expect: 'deny',
      cmd: [
        'sh',
        '-c',
        'cat "$HOME/Library/Application Support/Firefox/Profiles/probe.default/key4.db" "$HOME/Library/Application Support/Firefox/Profiles/probe.default/cookies.sqlite"',
      ],
    },
    {
      name: 'BROWSER: read Safari cookie jar (~/Library/Cookies)',
      expect: 'deny',
      cmd: ['sh', '-c', 'cat $HOME/Library/Cookies/Cookies.binarycookies'],
    },
    // …and the NEGATIVE controls, which are what keep the rules narrow. Without
    // these the deny could quietly widen to a subpath of the browser dirs and every
    // row above would still be green — while claude lost the ability to work on a
    // Chrome extension whose source legitimately lives there.
    {
      name: 'BROWSER: read Chrome Local State (non-credential — must stay readable)',
      expect: 'allow',
      cmd: ['sh', '-c', 'cat "$HOME/Library/Application Support/Google/Chrome/Local State" > /dev/null'],
    },
    {
      name: 'BROWSER: read an extension source under Application Support (NOT over-denied)',
      expect: 'allow',
      cmd: ['sh', '-c', 'cat "$HOME/Library/Application Support/my-extension/index.js" > /dev/null'],
    },
    {
      name: 'KEYCHAIN: read the login keychain itself (depth-1, must stay readable)',
      expect: 'allow',
      // `security create-keychain foo.keychain` actually writes `foo.keychain-db`
      // on current macOS, so resolve what landed — pointing at the wrong name makes
      // this row fail with ENOENT, which the runner cannot tell from a kernel deny.
      cmd: ['sh', '-c', `cat ${existsSync(probeKeychain) ? probeKeychain : `${probeKeychain}-db`} > /dev/null`],
    },
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

    // ── OVERSEER-BRAIN profile (network:'loopback') — the egress close ────────
    // Direct off-machine outbound must be KERNEL-denied (EPERM → exit 7): by IP
    // (no DNS in the path — deterministic) — the exfil a prompt-injected brain
    // would attempt if a future tool reopened what --disallowed-tools closes.
    { name: 'BRAIN: OUTBOUND → 1.1.1.1:443 (external, direct)', expect: 'deny', profile: brainProfilePath, cmd: ['node', '-e', `const s=require('net').connect(443,'1.1.1.1');s.on('connect',()=>process.exit(0));s.on('error',e=>process.exit((e.code==='EPERM'||e.code==='EACCES')?7:0))`] },
    // DNS still resolves (libinfo rides mach IPC / a local unix socket, both
    // allowed) — resolution without connectability is the designed pairing.
    { name: 'BRAIN: DNS lookup api.anthropic.com (resolution path open)', expect: 'allow', profile: brainProfilePath, cmd: ['node', '-e', `require('dns').lookup('api.anthropic.com',(e)=>process.exit(e?7:0))`] },
    // The ONE hole: loopback — the allowlist proxy is reachable…
    { name: 'BRAIN: OUTBOUND → 127.0.0.1 (the egress proxy)', expect: 'allow', profile: brainProfilePath, cmd: ['node', '-e', `const s=require('net').connect(${egress.port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(7))`] },
    // …and through it, ONLY the allowlist passes: a real TLS round-trip to
    // api.anthropic.com via CONNECT succeeds (any HTTP status — reaching the
    // server is the point), while a non-allowlisted host gets the proxy's 403.
    { name: 'BRAIN: https api.anthropic.com via allowlist proxy', expect: 'allow', profile: brainProfilePath, env: proxyEnv, cmd: ['sh', '-c', 'curl -sS -o /dev/null --max-time 20 https://api.anthropic.com/'] },
    { name: 'BRAIN: https example.com via proxy (403 — not allowlisted)', expect: 'deny', profile: brainProfilePath, env: proxyEnv, cmd: ['sh', '-c', 'curl -sS -o /dev/null --max-time 20 https://example.com/'] },
    // Listeners stay denied under the brain profile too (no backdoor).
    { name: 'BRAIN: BIND 127.0.0.1 (listener still denied)', expect: 'deny', profile: brainProfilePath, cmd: ['node', '-e', `const s=require('net').createServer();s.on('error',()=>process.exit(7));s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})`] },
    { name: 'BRAIN: claude --version (startup smoke, loopback profile)', expect: 'allow', optional: true, profile: brainProfilePath, cmd: ['sh', '-c', 'command -v claude >/dev/null && claude --version'] },
  ]

  // ── compile check (both profiles) ─────────────────────────────────────────
  const compile = await sandboxed(['true'])
  if (compile.code !== 0) {
    console.error('✗ profile FAILED to compile under sandbox-exec:\n' + compile.out)
    console.error('\n--- profile ---\n' + buildSandboxProfile({ cwd, home: HOME }))
    await egress.close()
    cleanup()
    process.exit(2)
  }
  const compileBrain = await sandboxed(['true'], brainProfilePath)
  if (compileBrain.code !== 0) {
    console.error('✗ BRAIN profile FAILED to compile under sandbox-exec:\n' + compileBrain.out)
    console.error('\n--- brain profile ---\n' + buildSandboxProfile({ cwd, home: HOME, network: 'loopback' }))
    await egress.close()
    cleanup()
    process.exit(2)
  }

  // ── run ─────────────────────────────────────────────────────────────────
  let failed = 0
  let skipped = 0
  const rows: string[] = []
  for (const p of probes) {
    const { code, out } = await sandboxed(p.cmd, p.profile ?? profilePath, p.env)
    if (p.optional && code !== 0 && (p.skipIf ?? /not found|command not/).test(out)) {
      rows.push(`  —  SKIP  ${p.name} (precondition absent on this machine)`)
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
  await egress.close()
  cleanup()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  cleanup()
  console.error('sandbox-probe: unexpected error', e)
  process.exit(2)
})
