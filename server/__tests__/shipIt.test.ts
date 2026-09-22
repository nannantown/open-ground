import { describe, it, expect } from 'vitest'
import {
  shipItLabel,
  launchdDomain,
  parseDisabledFlag,
  parseServicePrint,
  decideInstallPreflight,
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
