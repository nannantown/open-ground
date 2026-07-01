import { describe, it, expect } from 'vitest'
import { buildSandboxProfile, wrapWithSandboxExec } from '@/lib/server/sandbox'

// The Seatbelt profile is the security contract of the owner-only sandbox
// experiment, so its shape is pinned here (the kernel-level proof — that these
// rules actually confine — lives in scripts/sandbox-probe.ts, run on macOS).

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
      '/home/u/Library/Keychains',
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
