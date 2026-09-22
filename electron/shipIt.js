// electron/shipIt.js — what the app can know about Squirrel.Mac's ShipIt
// launchd service, factored out of electron/main.js so the parsing and the
// decision are unit-testable WITHOUT an Electron runtime or a Mac
// (server/__tests__/shipIt.test.ts) — the same plain-CJS split as
// electron/updaterLog.js / autoUpdate.js.
//
// ⚠ THE CAUSE THIS ADDRESSES (found by the 2026-09-21 release operator, see
// docs/commander/PRODUCT-HANDOFF-2026-09-21.md): after "Restart now" the app
// quit and came back on the OLD version because "the registered app-specific
// ShipIt service had zero runs" — Squirrel.Mac had submitted its launchd job
// (`<bundle id>.ShipIt`) and launchd never ran it. Starting the service by hand
// and repeating the update installed and relaunched normally. That is the same
// shape as the owner's 2026-09-13 report (app quit, nothing installed, no
// ShipIt log line at all), and it is invisible from inside the app: the
// install happens after the process is gone, and the only symptom is a launchd
// job that exists but does not run. macOS 13+ can leave a submitted launch
// agent in exactly that state when it is disabled under System Settings →
// General → Login Items & Extensions → "Allow in the Background".
//
// So the app now (1) LOGS the service's launchd state at boot and immediately
// before every install, into ~/.openground/updater.log — the diagnostic that
// did not exist on 2026-09-13 — and (2) refuses to tear itself down for an
// install that launchd has already decided not to run: if the label is
// disabled it tries `launchctl enable`, and if it is still disabled it says so
// and points at the setting, instead of quitting into nothing.
//
// Everything here is pure: main.js runs `launchctl` and feeds the text in.

'use strict'

const SHIPIT_LABEL_SUFFIX = '.ShipIt'

/** The ShipIt job label Squirrel.Mac submits: `<bundle id>.ShipIt`. */
function shipItLabel(appId) {
  return `${appId}${SHIPIT_LABEL_SUFFIX}`
}

/** The per-user launchd domain the job lives in (`gui/<uid>`). */
function launchdDomain(uid) {
  return `gui/${uid}`
}

/**
 * Read one label's flag out of `launchctl print-disabled gui/<uid>`, whose
 * output lists only services with an explicit override:
 *
 *     disabled services = {
 *     	"com.apple.foo" => disabled
 *     	"local.openground.app.ShipIt" => enabled
 *     }
 *
 * A label that is NOT listed has no override, which launchd treats as enabled.
 * Empty / unparseable output ⇒ 'unknown' (never guessed either way).
 * @param {string} output
 * @param {string} label
 * @returns {'disabled' | 'enabled' | 'unknown'}
 */
function parseDisabledFlag(output, label) {
  if (typeof output !== 'string' || !/disabled services\s*=/.test(output)) return 'unknown'
  const quoted = `"${label}"`
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line.includes(quoted) || !line.includes('=>')) continue
    const rhs = line.slice(line.indexOf('=>') + 2).trim()
    if (rhs.startsWith('disabled')) return 'disabled'
    if (rhs.startsWith('enabled')) return 'enabled'
    return 'unknown'
  }
  return 'enabled' // not overridden ⇒ launchd's default
}

/**
 * Read the essentials out of `launchctl print gui/<uid>/<label>`:
 *
 *     gui/501/local.openground.app.ShipIt = {
 *     	state = not running
 *     	...
 *     	runs = 0
 *     	last exit code = (never exited)
 *
 * `null` when the text is not a service print at all (typically "Could not
 * find service …" — the job is not loaded).
 * @param {string} output
 * @returns {{ state: string, runs: number | null, lastExitCode: string | null, pid: number | null } | null}
 */
function parseServicePrint(output) {
  if (typeof output !== 'string') return null
  const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(output)
  if (!state) return null
  const runs = /^\s*runs\s*=\s*(\d+)\s*$/m.exec(output)
  const last = /^\s*last exit code\s*=\s*(.+?)\s*$/m.exec(output)
  const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(output)
  return {
    state: state[1],
    runs: runs ? Number.parseInt(runs[1], 10) : null,
    lastExitCode: last ? last[1] : null,
    pid: pid ? Number.parseInt(pid[1], 10) : null,
  }
}

/**
 * Pure decision: may the app tear itself down for an install?
 *   'proceed' — the label is not disabled (or we could not tell: uncertainty
 *               never blocks an update; the boot check reports a failure).
 *   'block'   — it WAS disabled, an enable was attempted, and it is STILL
 *               disabled: quitting now would install nothing. Say so instead.
 * @param {{ disabledBefore: 'disabled'|'enabled'|'unknown', disabledAfterEnable?: 'disabled'|'enabled'|'unknown' }} input
 * @returns {'proceed' | 'block'}
 */
function decideInstallPreflight(input) {
  if (input.disabledBefore !== 'disabled') return 'proceed'
  if (input.disabledAfterEnable === 'disabled') return 'block'
  return 'proceed'
}

/**
 * One line for the updater log: everything a reader needs to tell "never
 * loaded" from "loaded, never ran" from "disabled".
 * @param {{ label: string, disabled: string, service: ReturnType<typeof parseServicePrint> }} s
 */
function describeShipItState(s) {
  const svc = s.service
    ? `loaded: state=${s.service.state}, runs=${s.service.runs ?? '?'}, last exit=${s.service.lastExitCode ?? '?'}` +
      (s.service.pid != null ? `, pid=${s.service.pid}` : '')
    : 'not loaded'
  return `${s.label} — ${svc}; background-items flag=${s.disabled}`
}

module.exports = {
  SHIPIT_LABEL_SUFFIX,
  shipItLabel,
  launchdDomain,
  parseDisabledFlag,
  parseServicePrint,
  decideInstallPreflight,
  describeShipItState,
}
