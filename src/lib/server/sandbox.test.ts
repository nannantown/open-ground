import { describe, it, expect } from 'vitest'
import { buildSandboxProfile, wrapWithSandboxExec } from '@/lib/server/sandbox'

// The Seatbelt profile is the security contract of the owner-only sandbox
// experiment, so its shape is pinned here (the kernel-level proof — that these
// rules actually confine — lives in scripts/sandbox-probe.ts, run on macOS).

/**
 * Evaluate the profile's emitted READ-deny rules against a CONCRETE path.
 *
 * Deliberately behavioural rather than a `toContain` on the rule text: a test
 * that transcribes the implementation passes for any rewrite that keeps the
 * spelling and fails for every rewrite that changes it — exactly backwards. This
 * re-runs the rules, so an equivalent refactor still passes while a profile that
 * stops covering a path fails, whatever the new spelling is.
 *
 * POSIX ERE (what sandbox-exec compiles) and JS RegExp agree on every construct
 * this profile uses — anchors, alternation, escaped dots, and `.`, which matches
 * `/` in both — so JS evaluation is a faithful stand-in. The kernel-level proof
 * is scripts/sandbox-probe.ts.
 */
const deniedForRead = (profile: string, path: string): boolean =>
  profile.split('\n').some((line) => {
    const sub = line.match(/^\(deny file-read\* \(subpath "(.*)"\)\)$/)
    if (sub) return path === sub[1] || path.startsWith(`${sub[1]}/`)
    const lit = line.match(/^\(deny file-read\* \(literal "(.*)"\)\)$/)
    if (lit) return path === lit[1]
    const re = line.match(/^\(deny file-read\* \(regex #"(.*)"\)\)$/)
    if (re) return new RegExp(re[1]).test(path)
    return false
  })

describe('buildSandboxProfile', () => {
  const profile = buildSandboxProfile({ cwd: '/work/proj', home: '/home/u' })

  it('is deny-by-default', () => {
    expect(profile.startsWith('(version 1)\n(deny default)\n')).toBe(true)
  })

  it('confines WRITES to the cwd', () => {
    expect(profile).toContain('(allow file-write* (subpath "/work/proj"))')
  })

  it('allows BROAD read so the toolchain works', () => {
    expect(profile).toContain('(allow file-read* (subpath "/"))')
  })

  it('re-denies credential reads — keys, cloud/cluster/container, package/git/IaC tokens', () => {
    for (const p of [
      '/home/u/.ssh',
      '/home/u/.aws',
      '/home/u/.gnupg',
      '/home/u/.config/gh',
      '/home/u/.config/gcloud',
      '/home/u/.docker',
      '/home/u/.kube',
      '/home/u/.azure',
      '/home/u/.wrangler',
      '/home/u/.config/.wrangler',
      // NB: ~/Library/Keychains is deliberately absent — see the keychain test below.
    ]) {
      expect(profile).toContain(`(deny file-read* (subpath "${p}"))`)
    }
    for (const p of [
      '/home/u/.netrc',
      '/home/u/.git-credentials',
      '/home/u/.config/git/credentials',
      '/home/u/.npmrc',
      '/home/u/.yarnrc.yml',
      '/home/u/.pypirc',
      '/home/u/.cargo/credentials.toml',
      '/home/u/.cargo/credentials',
      '/home/u/.gem/credentials',
      '/home/u/.terraform.d/credentials.tfrc.json',
      '/home/u/.vault-token',
      '/home/u/.gradle/gradle.properties',
      '/home/u/.m2/settings.xml',
    ]) {
      expect(profile).toContain(`(deny file-read* (literal "${p}"))`)
    }
    // …but the cred-FILE denies must NOT deny the whole dir (build data lives there).
    for (const dir of ['/home/u/.cargo', '/home/u/.gem', '/home/u/.gradle', '/home/u/.m2']) {
      expect(profile).not.toContain(`(deny file-read* (subpath "${dir}"))`)
    }
  })

  it('orders the credential deny AFTER the broad read (SBPL last-match-wins)', () => {
    // The whole containment hinges on this: a read of ~/.ssh/id_rsa matches the
    // broad allow THEN the deny; only because the deny is LAST does it win.
    const broadRead = profile.indexOf('(allow file-read* (subpath "/"))')
    const denySsh = profile.indexOf('(deny file-read* (subpath "/home/u/.ssh"))')
    expect(broadRead).toBeGreaterThanOrEqual(0)
    expect(denySsh).toBeGreaterThan(broadRead)
  })

  it('allows the ~/.claude.json family via a regex anchored at BOTH ends (no over-match)', () => {
    // End-anchored + dot-led suffix so .claude.json[.tmp/.lock] match but
    // .claude.jsonEVIL / .claude.jsonDIR do not (the kernel proof is in the probe).
    expect(profile).toContain('(allow file-write* (regex #"^/home/u/\\.claude\\.json(\\..*)?$"))')
  })

  it('grants the claude + app state + tool-cache + temp write dirs', () => {
    for (const p of [
      '/home/u/.claude',
      '/home/u/.openground',
      '/home/u/.npm',
      '/home/u/.cache',
      '/home/u/Library/Caches',
      '/private/tmp',
      '/private/var/folders',
    ]) {
      expect(profile).toContain(`(allow file-write* (subpath "${p}"))`)
    }
  })

  it('re-denies WRITE to auto-executing config — GLOBAL and PROJECT-LOCAL (path-agnostic)', () => {
    // The escape this closes: a contained claude planting a payload that runs
    // OUTSIDE the sandbox later. Path-agnostic regexes so <cwd>/.claude/… and
    // <cwd>/.mcp.json (inside the writable cwd, auto-triggered by OG's
    // non-sandboxed sessions) are covered too — not just the global ~/.claude.
    expect(profile).toContain('(deny file-write* (regex #".*/\\.claude/settings(\\.local)?\\.json$"))')
    // hooks/plugins/skills anchored at the ENTRY ($), not just children, so the
    // dir can't be `mv`'d + symlink-swapped (the parent is write-allowed).
    expect(profile).toContain('(deny file-write* (regex #".*/\\.claude/(hooks|plugins|skills)(/.*)?$"))')
    expect(profile).toContain('(deny file-write* (regex #".*/\\.mcp\\.json$"))')
    // git hooks at ANY gitdir level (top + submodule/worktree).
    expect(profile).toContain('(deny file-write* (regex #".*/\\.git/(modules/.*/|worktrees/.*/)?hooks(/.*)?$"))')
    // git config in all forms (fsmonitor / alias RCE): main, submodule
    // .git/modules/*/config, and per-worktree .git/worktrees/*/config.worktree.
    expect(profile).toContain(
      '(deny file-write* (regex #".*/\\.git/(modules/.*/|worktrees/.*/)?config(\\.worktree)?$"))',
    )
    // the intermediate gitdirs .git/modules, .git/worktrees + per-name entries (and
    // nested-submodule levels via (modules/[^/]+/)*), so they can't be
    // symlink-swapped to redirect the config/hooks below them.
    expect(profile).toContain('(deny file-write* (regex #".*/\\.git/(modules/[^/]+/)*(modules|worktrees)(/[^/]+)?$"))')
    // the .git / .claude / .openground dir ENTRIES themselves (block whole-dir
    // symlink swap) + custom-module code (no sandboxed module registration).
    expect(profile).toContain('(deny file-write* (regex #".*/\\.git$"))')
    expect(profile).toContain('(deny file-write* (regex #".*/\\.claude$"))')
    expect(profile).toContain('(deny file-write* (regex #".*/\\.openground$"))')
    expect(profile).toContain('(deny file-write* (regex #".*/\\.openground/custom-modules(/.*)?$"))')
    // OG's projects allowlist + global claude instructions stay literal-denied.
    expect(profile).toContain('(deny file-write* (literal "/home/u/.openground/settings.json"))')
    expect(profile).toContain('(deny file-write* (literal "/home/u/.claude/CLAUDE.md"))')
  })

  it('orders the execution-config write-deny AFTER the write-allows (last-match-wins)', () => {
    // These denies must override even the cwd / .git carve-out write-allow, so a
    // hook can never be planted in any allowed tree — only because they come LAST.
    const cwdAllow = profile.indexOf('(allow file-write* (subpath "/work/proj"))')
    const denyHooks = profile.indexOf('(deny file-write* (regex #".*/\\.git/(modules/.*/|worktrees/.*/)?hooks(/.*)?$"))')
    const denyClaudeCfg = profile.indexOf('(deny file-write* (regex #".*/\\.claude/settings(\\.local)?\\.json$"))')
    expect(cwdAllow).toBeGreaterThanOrEqual(0)
    expect(denyHooks).toBeGreaterThan(cwdAllow)
    expect(denyClaudeCfg).toBeGreaterThan(cwdAllow)
  })

  it('omits iokit-open (claude/node need no hardware access — trims surface)', () => {
    expect(profile).not.toContain('iokit-open')
  })

  it('includes caller-supplied extra write subpaths (the worker .git carve-out)', () => {
    const p = buildSandboxProfile({
      cwd: '/wt',
      home: '/home/u',
      extraWriteSubpaths: ['/proj/.git', '/extra/dir'],
    })
    expect(p).toContain('(allow file-write* (subpath "/proj/.git"))')
    expect(p).toContain('(allow file-write* (subpath "/extra/dir"))')
  })

  it('allows OUTBOUND only — every listener (bind/inbound, public AND loopback) falls through to deny', () => {
    expect(profile).toContain('(allow network-outbound)')
    // No listener of any kind: no inbound, no bind, no blanket network*.
    expect(profile).not.toContain('(allow network-inbound)')
    expect(profile).not.toContain('network-bind')
    expect(profile).not.toContain('(allow network*)')
  })

  it("network:'loopback' — outbound ONLY to loopback + unix sockets, NO bare outbound allow, still no listeners", () => {
    // The overseer-brain egress close: every off-machine destination must fall to
    // (deny default). A bare `(allow network-outbound)` ANYWHERE would reopen it
    // (SBPL last-match-wins) — pin its absence, not just the loopback lines'
    // presence. (The kernel-level proof — 1.1.1.1:443 EPERMs while 127.0.0.1
    // connects — lives in scripts/sandbox-probe.ts.)
    const p = buildSandboxProfile({ cwd: '/work/proj', home: '/home/u', network: 'loopback' })
    expect(p).toContain('(allow network-outbound (remote ip "localhost:*"))')
    expect(p).toContain('(allow network-outbound (remote unix-socket))')
    expect(p).not.toContain('(allow network-outbound)\n')
    expect(p).not.toContain('(allow network-inbound)')
    expect(p).not.toContain('network-bind')
    expect(p).not.toContain('(allow network*)')
  })

  it('login keychain family is read+write allowed in BOTH modes, the rest of the keychain dir stays denied', () => {
    // REGRESSION GUARD — do not "harden" this back. Security.framework does the
    // keychain db file I/O from the CLIENT process, so a Seatbelt deny here is not
    // an exfil-surface trim, it is an auth outage:
    //   • READ denied  → a real `claude -p` under this exact profile answers
    //     `Not logged in · Please run /login` (real-kernel verified 2026-07-19).
    //   • WRITE denied → claude cannot persist its REFRESHED OAuth token
    //     (`SecKeychainItemCreateFromContent: UNIX[Operation not permitted]`), so
    //     read-only would fix start-up and then fail hours in.
    // The historical deny was dropped for 'loopback' only, which left every swarm
    // worker / interactive launch ('all') unable to start while the experiment was on.
    const loopback = buildSandboxProfile({ cwd: '/work/proj', home: '/home/u', network: 'loopback' })
    const DIR = '/home/u/Library/Keychains'
    const FAMILY = '#"^/home/u/Library/Keychains/login\\.keychain.*$"'
    for (const p of [profile, loopback]) {
      // READ: the co-resident stores are denied by DEPTH (everything two levels
      // below the dir = the per-UUID data-protection keychains + keybags) plus the
      // DP metadata file — NOT by denying the dir, which would authenticate fine
      // and then kill the keychain WRITE (real-kernel measured).
      const denyDeep = p.indexOf('(deny file-read* (regex #"^/home/u/Library/Keychains/.+/.+"))')
      const broadRead = p.indexOf('(allow file-read* (subpath "/"))')
      expect(broadRead).toBeGreaterThanOrEqual(0)
      expect(denyDeep).toBeGreaterThan(broadRead) // deny must beat the broad read
      // BOTH spellings of the DP metadata store, which sits at depth 1 and so is
      // missed by the depth regex. The legacy `metadata.keychain` is not
      // hypothetical: it is present on the dev machine (0600, 23 KB, 2016) and was
      // measurably read-ALLOWED while only the `-db` twin was denied.
      expect(deniedForRead(p, `${DIR}/metadata.keychain`)).toBe(true)
      expect(deniedForRead(p, `${DIR}/metadata.keychain-db`)).toBe(true)
      // …the per-UUID DP keychains + keybags stay denied by depth…
      expect(deniedForRead(p, `${DIR}/AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB/keychain-2.db`)).toBe(true)
      expect(deniedForRead(p, `${DIR}/AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB/user.kb`)).toBe(true)
      // …while the login family itself stays READABLE. That is the whole fix: a
      // deny here is the `Not logged in` launch failure, not a secrecy trim.
      expect(deniedForRead(p, `${DIR}/login.keychain-db`)).toBe(false)
      expect(deniedForRead(p, `${DIR}/login.keychain`)).toBe(false)
      // The dir itself must NOT be denied — that is the shape that breaks writes.
      expect(p).not.toContain(`(deny file-read* (subpath "${DIR}"))`)
      // WRITE: the login family only — never the whole dir, whose other occupants
      // are the per-UUID data-protection keychains + keybags (Safari / iCloud /
      // app secrets), Octagon trust state and TrustSettings.plist.
      expect(p).toContain(`(allow file-write* (regex ${FAMILY}))`)
      expect(p).not.toContain(`(allow file-write* (subpath "${DIR}"))`)
      // No LATER rule of any form may claw the keychain back — check every deny
      // line mentioning the dir, not just the subpath spelling (the profile emits
      // both subpath and regex denies, so a presence check on one form would miss).
      const clawback = p.split('\n').filter((l) => l.startsWith('(deny file-write*') && l.includes('Keychains'))
      expect(clawback).toEqual([])
      // The rest of the credential wall is untouched in both modes.
      for (const kept of ['/home/u/.ssh', '/home/u/.aws', '/home/u/.gnupg']) {
        expect(p).toContain(`(deny file-read* (subpath "${kept}"))`)
      }
      expect(p).toContain('(deny file-read* (literal "/home/u/.netrc"))')
    }
  })

  it('re-denies BROWSER credential stores at every profile depth, without over-denying the browser dirs', () => {
    // The keychain carve-in above makes `Chrome Safe Storage` — the master key to
    // Chromium's password vault — reachable, and the vault FILES were reachable all
    // along via the broad read. Either half alone is inert; together they hand a
    // contained worker with open egress every saved browser password. The keychain
    // half cannot be closed (denying it is the launch failure the carve-in fixes),
    // so this half must stay closed.
    const AS = '/home/u/Library/Application Support'
    const loopback = buildSandboxProfile({ cwd: '/work/proj', home: '/home/u', network: 'loopback' })
    for (const p of [profile, loopback]) {
      for (const denied of [
        // Chromium family. The profile dir level differs per browser AND per
        // user-created profile, so every real shape is pinned — a fix that only
        // covered `Chrome/Default` would leave `Profile 1`, Edge and Brave open.
        `${AS}/Google/Chrome/Default/Login Data`,
        `${AS}/Google/Chrome/Profile 1/Login Data`,
        `${AS}/Google/Chrome/Default/Login Data For Account`,
        `${AS}/Google/Chrome/Default/Login Data-journal`, // SQLite sidecar
        `${AS}/Google/Chrome/Default/Cookies`,
        `${AS}/Google/Chrome/Default/Cookies-wal`,
        `${AS}/Google/Chrome/Default/Web Data`, // autofill, incl. stored cards
        `${AS}/Microsoft Edge/Default/Login Data`,
        `${AS}/BraveSoftware/Brave-Browser/Default/Login Data`,
        // Firefox family: password store, its master key, the cookie jar.
        `${AS}/Firefox/Profiles/b3eq95yh.default/logins.json`,
        `${AS}/Firefox/Profiles/b3eq95yh.default/key4.db`,
        `${AS}/Firefox/Profiles/b3eq95yh.default/key3.db`,
        `${AS}/Firefox/Profiles/b3eq95yh.default/cert9.db`,
        `${AS}/Firefox/Profiles/b3eq95yh.default/cookies.sqlite`,
        `${AS}/Firefox/Profiles/b3eq95yh.default/cookies.sqlite-wal`,
        // Safari / NSHTTPCookieStorage — a live session cookie is a bearer credential.
        '/home/u/Library/Cookies/Cookies.binarycookies',
      ]) {
        expect(deniedForRead(p, denied)).toBe(true)
      }
      // NEGATIVE CONTROL — the deny is the credential DBs, NOT the browser dirs.
      // claude is legitimately asked to work on a Chrome extension whose source
      // lives under Application Support, and a project file may share a filename.
      for (const allowed of [
        `${AS}/Google/Chrome/Local State`,
        `${AS}/Google/Chrome/Default/Preferences`,
        `${AS}/my-extension/src/index.ts`,
        '/work/proj/fixtures/Login Data', // same name INSIDE the project
        '/work/proj/src/cookies.sqlite',
      ]) {
        expect(deniedForRead(p, allowed)).toBe(false)
      }
    }
  })

  it("network:'all' and omitted both keep the historical open-outbound line (worker profile unchanged)", () => {
    const all = buildSandboxProfile({ cwd: '/work/proj', home: '/home/u', network: 'all' })
    expect(all).toContain('(allow network-outbound)\n')
    expect(profile).toContain('(allow network-outbound)\n') // omitted = same default
    expect(all).not.toContain('(remote ip "localhost:*")')
  })

  it('escapes a double-quote in a path so it cannot break out of the SBPL literal', () => {
    const p = buildSandboxProfile({ cwd: '/a"b', home: '/home/u' })
    expect(p).toContain('(allow file-write* (subpath "/a\\"b"))')
  })
})

describe('wrapWithSandboxExec', () => {
  it('prepends `/usr/bin/sandbox-exec -f <quoted profile>` to the argv', () => {
    expect(wrapWithSandboxExec(['claude', '--session-id', 'x'], '/tmp/p.sb')).toEqual([
      '/usr/bin/sandbox-exec',
      '-f',
      "'/tmp/p.sb'",
      'claude',
      '--session-id',
      'x',
    ])
  })

  it('POSIX-quotes a profile path containing a single quote', () => {
    expect(wrapWithSandboxExec(['claude'], "/tmp/o'x/p.sb")[2]).toBe("'/tmp/o'\\''x/p.sb'")
  })
})
