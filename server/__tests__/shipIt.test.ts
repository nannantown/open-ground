import { describe, it, expect } from 'vitest'
import {
  shipItLabel,
  launchdDomain,
  parseDisabledFlag,
  parseServicePrint,
  parseShipItRequest,
  decideInstallPreflight,
  decideBootRecovery,
  decideArmedRecoveryAtQuit,
  versionFromPlistJson,
  describeShipItState,
} from '../../electron/shipIt'

// The 2026-09-21 finding (docs/commander/PRODUCT-HANDOFF-2026-09-21.md): after
// "Restart now" the app came back on the old version because the ShipIt launchd
// job "had zero runs" — submitted, never run. These pin the parsers that turn
// launchctl's text into that fact, and the one decision built on it: never tear
// the app down for an install launchd has already declined to run.

const LABEL = 'local.openground.app.ShipIt'

// Verbatim shapes of `launchctl print-disabled gui/501` (macOS 13–15).
const DISABLED_LIST = `disabled services = {
\t"com.apple.SafariBookmarksSyncAgent" => disabled
\t"local.openground.app.ShipIt" => disabled
\t"com.example.other" => enabled
}
`
const ENABLED_LIST = DISABLED_LIST.replace('"local.openground.app.ShipIt" => disabled', '"local.openground.app.ShipIt" => enabled')
const NOT_LISTED = `disabled services = {
\t"com.apple.SafariBookmarksSyncAgent" => disabled
}
`

// `launchctl print gui/501/local.openground.app.ShipIt` for a submitted job
// that launchd never ran — the exact shape of the incident.
const ZERO_RUNS = `gui/501/local.openground.app.ShipIt = {
\tactive count = 0
\tpath = (submitted by OPEN GROUND.12345)
\ttype = Submitted
\tstate = not running

\tprogram = /Applications/OPEN GROUND.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt
\targuments = {
\t\t/Applications/OPEN GROUND.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt
\t\tlocal.openground.app.ShipIt
\t}

\truns = 0
\tlast exit code = (never exited)
}
`
const RUNNING = ZERO_RUNS.replace('state = not running', 'state = running').replace('runs = 0', 'runs = 3') + '\tpid = 64585\n'
const NOT_FOUND = 'Could not find service "local.openground.app.ShipIt" in domain for port: 0x1234\n'

describe('shipIt — label + domain', () => {
  it('derives the label Squirrel.Mac uses from the bundle id, and the per-user domain', () => {
    expect(shipItLabel('local.openground.app')).toBe(LABEL)
    expect(launchdDomain(501)).toBe('gui/501')
  })
})

describe('parseDisabledFlag — the Background Items override', () => {
  it('reads disabled / enabled for the label', () => {
    expect(parseDisabledFlag(DISABLED_LIST, LABEL)).toBe('disabled')
    expect(parseDisabledFlag(ENABLED_LIST, LABEL)).toBe('enabled')
  })
  it('a label with no override is enabled (launchd default), never "disabled" by omission', () => {
    expect(parseDisabledFlag(NOT_LISTED, LABEL)).toBe('enabled')
  })
  it('does not match a label that merely CONTAINS ours, and never guesses from garbage', () => {
    expect(parseDisabledFlag('disabled services = {\n\t"x.local.openground.app.ShipIt.y" => disabled\n}\n', LABEL)).toBe('enabled')
    expect(parseDisabledFlag('', LABEL)).toBe('unknown')
    expect(parseDisabledFlag('Could not find domain\n', LABEL)).toBe('unknown')
  })
})

describe('parseServicePrint — loaded / never ran / running / not loaded', () => {
  it('THE INCIDENT SHAPE: loaded, state "not running", runs 0, never exited', () => {
    expect(parseServicePrint(ZERO_RUNS)).toEqual({ state: 'not running', runs: 0, lastExitCode: '(never exited)', pid: null })
  })
  it('a running job carries its pid and run count', () => {
    expect(parseServicePrint(RUNNING)).toEqual({ state: 'running', runs: 3, lastExitCode: '(never exited)', pid: 64585 })
  })
  it('"Could not find service" is NOT a service — null, so it reads as not loaded', () => {
    expect(parseServicePrint(NOT_FOUND)).toBeNull()
    expect(parseServicePrint('')).toBeNull()
  })
})

// ── The 2026-09-22 shape: ENABLED, and launchd still never ran it ────────────
// 0.11.118 failed to apply with `background-items flag=enabled`, so the
// disabled-only gate waved it through and the app quit into nothing. Squirrel's
// submitted job carries NO RunAtLoad (SQRLShipItLauncher.m), so it is on-demand
// only; Squirrel pokes it over XPC after submitting (:165) and what we observe
// is that poke not producing a launch. The remedy is a `will-quit` kickstart,
// NOT a refusal at pre-flight — the pre-flight decision below is unchanged.

describe('decideInstallPreflight — never quit into nothing', () => {
  it('proceeds when the job is enabled, not overridden, or simply unknown (uncertainty never blocks)', () => {
    expect(decideInstallPreflight({ disabledBefore: 'enabled' })).toBe('proceed')
    expect(decideInstallPreflight({ disabledBefore: 'unknown' })).toBe('proceed')
  })
  it('BLOCKS only when it was disabled AND is still disabled after the enable attempt', () => {
    expect(decideInstallPreflight({ disabledBefore: 'disabled', disabledAfterEnable: 'disabled' })).toBe('block')
  })
  it('proceeds once the enable took, and when the re-read could not tell', () => {
    expect(decideInstallPreflight({ disabledBefore: 'disabled', disabledAfterEnable: 'enabled' })).toBe('proceed')
    expect(decideInstallPreflight({ disabledBefore: 'disabled', disabledAfterEnable: 'unknown' })).toBe('proceed')
    expect(decideInstallPreflight({ disabledBefore: 'disabled' })).toBe('proceed')
  })
})

describe('decideBootRecovery — arm the self-repair once, never a loop', () => {
  const failed = { kind: 'failed', from: '0.11.117', to: '0.11.118' }

  it('arms when the version we failed to install is the one still staged', () => {
    expect(decideBootRecovery({ verdict: failed, lastRecovery: null, stagedVersion: '0.11.118' })).toBe(true)
  })
  it('THE MEASURED FALSE POSITIVE: a leftover staged bundle of ANOTHER version never arms', () => {
    // ShipItState.plist and update.*/ survive a SUCCESSFUL install (verified on
    // a real Mac, 2026-09-22), so "some update dir exists" is not evidence of a
    // pending install — only the version is.
    expect(decideBootRecovery({ verdict: failed, lastRecovery: null, stagedVersion: '0.11.115' })).toBe(false)
    expect(decideBootRecovery({ verdict: failed, lastRecovery: null, stagedVersion: null })).toBe(false)
  })
  it('NEVER twice for the same from→to — a permanently broken launchd must not retry every launch', () => {
    expect(
      decideBootRecovery({ verdict: failed, lastRecovery: { from: '0.11.117', to: '0.11.118' }, stagedVersion: '0.11.118' }),
    ).toBe(false)
  })
  it('but a DIFFERENT pair gets its own single attempt', () => {
    expect(
      decideBootRecovery({ verdict: failed, lastRecovery: { from: '0.11.117', to: '0.11.119' }, stagedVersion: '0.11.118' }),
    ).toBe(true)
    expect(
      decideBootRecovery({ verdict: failed, lastRecovery: { from: '0.11.116', to: '0.11.118' }, stagedVersion: '0.11.118' }),
    ).toBe(true)
  })
  it('only "failed" arms — an install that worked, or never happened, is left alone', () => {
    for (const kind of ['installed', 'stale', 'none']) {
      expect(decideBootRecovery({ verdict: { ...failed, kind }, lastRecovery: null, stagedVersion: '0.11.118' })).toBe(false)
    }
    expect(decideBootRecovery({ verdict: { kind: 'failed', from: '0.11.117' }, lastRecovery: null, stagedVersion: '0.11.118' })).toBe(
      false,
    )
  })
})

describe('decideArmedRecoveryAtQuit — never write an older build over a newer one', () => {
  it('fires when the app on disk is still the version this process is running', () => {
    expect(decideArmedRecoveryAtQuit({ runningVersion: '0.11.117', installedVersion: '0.11.117' })).toBe(true)
  })
  it('THE DOWNGRADE IT PREVENTS: the user hand-installed a newer build since boot', () => {
    // The install-failed dialog offers the release page. Taking it and then
    // quitting would otherwise let the armed kickstart put the older staged
    // build over the newer one the user just installed.
    expect(decideArmedRecoveryAtQuit({ runningVersion: '0.11.117', installedVersion: '0.11.120' })).toBe(false)
  })
  it('an unreadable bundle means DO NOTHING — this path replaces the user\'s application', () => {
    expect(decideArmedRecoveryAtQuit({ runningVersion: '0.11.117', installedVersion: null })).toBe(false)
  })
  // "Is it armed at all?" is NOT this function's job — `armedKickstartReason`'s
  // early return in main.js kickstartShipItBeforeExit is the arm gate, and
  // autoUpdate.test.ts pins that line. Taking `armed` as an argument here too
  // was a second, always-true copy of a decision made elsewhere.
})

describe('parseShipItRequest — ask the REQUEST, never the directory', () => {
  // A kicked ShipIt replays ShipItState.plist and nothing else. The file is
  // named .plist but Squirrel writes JSON into it (SQRLShipItRequest.m:184-200,
  // Mantle → NSJSONSerialization; keys at :63-70).
  const REAL = JSON.stringify({
    updateBundleURL: 'file:///Users/me/Library/Caches/local.openground.app.ShipIt/update.oJJWrU6/OPEN%20GROUND.app/',
    targetBundleURL: 'file:///Applications/OPEN%20GROUND.app/',
    launchAfterInstallation: true,
  })

  it('names the bundle the request points at — percent-decoded, no trailing slash, not a URL', () => {
    expect(parseShipItRequest(REAL)?.bundlePath).toBe(
      '/Users/me/Library/Caches/local.openground.app.ShipIt/update.oJJWrU6/OPEN GROUND.app',
    )
  })

  it('THE BUG IT REPLACES: it must not be satisfiable by "some update.* dir exists"', () => {
    // The request is what gets replayed, so a state file that names NOTHING is
    // "nothing staged" however many update.* directories are lying around.
    expect(parseShipItRequest(JSON.stringify({ targetBundleURL: 'file:///Applications/OPEN%20GROUND.app/' }))).toBeNull()
  })

  it('absent / truncated / non-JSON / wrong shape ⇒ null, and NEVER throws', () => {
    for (const raw of ['', '   ', 'not json', '<?xml version="1.0"?><plist/>', 'null', '[]', '{"updateBundleURL":123}', '{"updateBundleURL":""}']) {
      expect(() => parseShipItRequest(raw)).not.toThrow()
      expect(parseShipItRequest(raw), raw).toBeNull()
    }
  })

  it('a relative or non-file URL is not a bundle we can read ⇒ null', () => {
    expect(parseShipItRequest('{"updateBundleURL":"https://example.com/OPEN GROUND.app"}')).toBeNull()
    expect(parseShipItRequest('{"updateBundleURL":"update.X/OPEN GROUND.app"}')).toBeNull()
  })

  it('accepts a bare absolute path too — the request is Squirrel\'s to format, not ours', () => {
    expect(parseShipItRequest('{"updateBundleURL":"/tmp/update.X/OPEN GROUND.app/"}')?.bundlePath).toBe(
      '/tmp/update.X/OPEN GROUND.app',
    )
  })

  it('reports whether the install would RELAUNCH — only a literal true counts', () => {
    // `launchAfterInstallation` is YES only between quitAndInstall and the next
    // -prepareUpdateForInstallation:. A download landing after the self-repair
    // was armed rewrites it to NO, and kicking then installs WITHOUT reopening
    // the app — while the armed dialog promised it would reopen. Inferring the
    // flag from a missing key would break exactly that promise silently.
    expect(parseShipItRequest(REAL)?.relaunchesAfterInstall).toBe(true)
    for (const v of ['false', '0', '"true"', 'null']) {
      expect(
        parseShipItRequest(`{"updateBundleURL":"/tmp/x.app","launchAfterInstallation":${v}}`)?.relaunchesAfterInstall,
        v,
      ).toBe(false)
    }
    // Key absent entirely ⇒ false, never "probably yes".
    expect(parseShipItRequest('{"updateBundleURL":"/tmp/x.app"}')?.relaunchesAfterInstall).toBe(false)
  })
})

describe('versionFromPlistJson — the one fact read out of a bundle', () => {
  it('reads CFBundleShortVersionString out of plutil JSON', () => {
    expect(versionFromPlistJson('{"CFBundleShortVersionString":"0.11.118","CFBundleVersion":"0.11.118"}')).toBe('0.11.118')
  })
  it('anything else is null — every caller reads null as "do nothing"', () => {
    expect(versionFromPlistJson('{"CFBundleVersion":"0.11.118"}')).toBeNull()
    expect(versionFromPlistJson('{"CFBundleShortVersionString":""}')).toBeNull()
    expect(versionFromPlistJson('{"CFBundleShortVersionString":123}')).toBeNull()
    expect(versionFromPlistJson('not json')).toBeNull()
    expect(versionFromPlistJson('null')).toBeNull()
  })
})

describe('describeShipItState — one log line that tells the three cases apart', () => {
  it('names not-loaded vs loaded-never-ran vs running, plus the override flag', () => {
    expect(describeShipItState({ label: LABEL, disabled: 'enabled', service: null })).toBe(
      `${LABEL} — not loaded; background-items flag=enabled`,
    )
    expect(describeShipItState({ label: LABEL, disabled: 'disabled', service: parseServicePrint(ZERO_RUNS) })).toBe(
      `${LABEL} — loaded: state=not running, runs=0, last exit=(never exited); background-items flag=disabled`,
    )
    expect(describeShipItState({ label: LABEL, disabled: 'enabled', service: parseServicePrint(RUNNING) })).toContain('pid=64585')
  })
})
