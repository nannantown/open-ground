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
// ⚠ AND THE SECOND SHAPE (2026-09-22, 0.11.118 did not apply). The same failure
// happened with the label ENABLED, so the disabled-only gate above waved it
// through: `updater.log`'s pre-flight line read `loaded: state=not running,
// runs=0, last exit=(never exited); background-items flag=enabled`, the app
// quit, and the next boot logged `pending install 0.11.117 → 0.11.118 —
// failed`. ShipIt's own stderr log had not one line for the attempt and
// `log show --predicate 'process == "ShipIt"'` was empty: launchd held a
// submitted job and never started it, with no override to explain it. It is
// INTERMITTENT (five failures across 0.11.112–0.11.118; 0.11.117 succeeded).
// The mechanism is upstream: the job dict Squirrel.Mac submits carries NO
// `RunAtLoad` (SQRLShipItLauncher.m), so it is purely on-demand — Squirrel
// itself pokes it over XPC right after submitting (SQRLShipItLauncher.m:165),
// and what we observe is that poke NOT resulting in a launch. `launchctl
// kickstart` runs a service regardless of its launch conditions, which is why
// the release operator's manual fix works where the XPC trigger did not.
//
// ⚠⚠ WHERE THE NUDGE GOES, AND WHY NOT AT PRE-FLIGHT. Squirrel writes the
// request and submits the job in `-prepareUpdateForInstallation:`
// (SQRLUpdater.m:1070-1089), which runs at DOWNLOAD/STAGE time — called from
// `-downloadAndPrepareUpdate:` (:526), before `update-downloaded` is emitted —
// and the launcher is memoised for the session (shipItSubmitted:400-424), so
// there is exactly ONE submission per session. `quitAndInstall` then only runs
// `-relaunchToInstallUpdate` (:1092-1110): re-read the request, set
// `launchAfterInstallation = YES`, write it back, terminate. Two consequences
// decide the placement:
//   (a) `applyUpdateWhenStaged` calls the pre-flight BEFORE it waits for
//       staging (electron/main.js), so at pre-flight the job may genuinely not
//       exist yet — there is nothing to kick and nothing to conclude from.
//   (b) `launchAfterInstallation` is only flipped to YES inside
//       `quitAndInstall`. Kicking at pre-flight would therefore run an install
//       that swaps the app and then does NOT relaunch it — the user quits into
//       a version that never comes back up.
// So the pre-flight gate stays exactly what it was: a DISABLED-label check.
//
// THE ONE MOMENT THAT WORKS is `will-quit`: `quitAndInstall` has by then
// written `launchAfterInstallation = YES`, the job has been submitted since
// staging, and this process is about to exit. Kicking THERE starts the right
// job with the right request (a kickstart on an already-running job is a
// no-op, so racing Squirrel's own XPC trigger is harmless). Recovery from a
// PAST failure rides the same rail: the boot check arms it, and it fires at
// the next `will-quit` — never while the app is alive, because a ShipIt parked
// mid-session installs its staged version over whatever the user does next
// (including a newer build they installed by hand).
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
 *
 * ⚠ Deliberately NOT extended to "the job has never run". See the header: the
 * pre-flight runs before staging is awaited, so the job may not exist yet, and
 * `launchAfterInstallation` is not set until `quitAndInstall` — a kick from
 * here would install without relaunching. Its run count therefore cannot
 * justify refusing an update that was going to work. The remedy for the
 * never-run shape is the `will-quit` kickstart, not a refusal.
 * @param {{ disabledBefore: 'disabled'|'enabled'|'unknown', disabledAfterEnable?: 'disabled'|'enabled'|'unknown' }} input
 * @returns {'proceed' | 'block'}
 */
function decideInstallPreflight(input) {
  if (input.disabledBefore !== 'disabled') return 'proceed'
  if (input.disabledAfterEnable === 'disabled') return 'block'
  return 'proceed'
}

/**
 * Pure decision: the previous quit installed NOTHING — should this run ARM a
 * self-repair kickstart for its own next quit?
 *
 * Preconditions, all three required:
 *  • the boot verdict is 'failed' (we came back as the version we quit FROM);
 *  • `stagedVersion` — the version actually unpacked under
 *    `~/Library/Caches/<label>/update.*` — is still the one we failed to
 *    install. ShipIt abandons an install whose bundle is gone, and that bundle
 *    (and the state file) SURVIVE a successful install, so mere existence is a
 *    measured false positive: the version has to match;
 *  • we have not already spent this pair's one attempt.
 * That last rule is what keeps a permanently broken launchd from turning every
 * single launch into another attempt. ⚠ The marker remembers only the MOST
 * RECENT pair, so A→B, then A→C, then A→B again does get a second attempt for
 * A→B — deliberate: reaching it requires B to have been downloaded and staged
 * afresh, which is a new situation, not the loop this guards against.
 * @param {{ verdict: { kind: string, from?: string, to?: string }, lastRecovery: { from: string, to: string } | null, stagedVersion: string | null }} input
 */
function decideBootRecovery(input) {
  const v = input && input.verdict
  if (!v || v.kind !== 'failed' || !v.to) return false
  if (!input.stagedVersion || input.stagedVersion !== v.to) return false
  const last = input.lastRecovery
  if (last && last.from === v.from && last.to === v.to) return false
  return true
}

/**
 * Pure decision at `will-quit`: fire the armed self-repair kickstart, or drop it?
 *
 * Only reached once `armedKickstartReason` is set — that flag IS the "armed?"
 * gate (electron/main.js `kickstartShipItBeforeExit`, pinned by
 * autoUpdate.test.ts), so it is deliberately not re-taken as an argument here.
 *
 * Dropped when the app bundle on disk is no longer the version WE are running:
 * something replaced it since boot — almost certainly the user taking the
 * `install-failed` dialog's "open the release page" route and installing by
 * hand. Kicking ShipIt then would write the older staged build over their
 * newer one, which is worse than the failure being recovered from.
 * @param {{ runningVersion: string, installedVersion: string | null }} input
 */
function decideArmedRecoveryAtQuit(input) {
  if (!input) return false
  // Unreadable ⇒ do nothing: this path replaces the user's application bundle,
  // so "not sure" must mean "leave it alone".
  if (!input.installedVersion) return false
  return input.installedVersion === input.runningVersion
}

/**
 * Pure decision for an UNARMED quit (electron/main.js
 * `relaunchUnarmedStagedInstall`): does the staged request deserve the
 * "reopen the app afterwards" flag?
 *
 * Only when the staged version is strictly NEWER than the one running.
 *  • EQUAL ⇒ litter. Both the request and the `update.*` bundle survive a
 *    successful install, so a readable staged bundle of the running version is
 *    the steady state of any Mac that has ever updated (measured on the owner's
 *    machine, 2026-09-22) — writing there would arm every future quit.
 *  • OLDER ⇒ a DOWNGRADE, and litter of a different shape. The arrangement
 *    that explains it: the job was submitted, launchd sat on it, and the owner
 *    installed a newer build by hand in the meantime. Blessing that with a relaunch turns a
 *    silent stale install into a visible one. (`allowDowngrade` is never set
 *    here, and electron-updater 6.8.3 defaults it to false — AppUpdater.js:138 —
 *    so no legitimate flow stages an older version.)
 *  • UNPARSEABLE on either side ⇒ false, like every other decision on this path:
 *    "not sure" must mean "leave it alone".
 * @param {{ stagedVersion: string | null, runningVersion: string | null }} input
 */
function decideUnarmedStagedRelaunch(input) {
  if (!input) return false
  const staged = parseTriple(input.stagedVersion)
  const running = parseTriple(input.runningVersion)
  if (!staged || !running) return false
  for (let i = 0; i < 3; i++) {
    if (staged[i] !== running[i]) return staged[i] > running[i]
  }
  return false // equal
}

/** `[major, minor, patch]`, or null for anything that is not a plain x.y.z.
 *  Deliberately strict: a version this cannot read is undecidable, and every
 *  caller on this path treats undecidable as "do nothing". */
function parseTriple(v) {
  const m = typeof v === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * The pending ShipIt request, out of the contents of
 * `~/Library/Caches/<label>/ShipItState.plist`.
 *
 * That file is named `.plist` but Squirrel writes JSON into it
 * (SQRLShipItRequest.m:184-200 — Mantle → NSJSONSerialization; the keys are
 * `updateBundleURL` / `targetBundleURL` / `launchAfterInstallation`, :63-70).
 * A kicked ShipIt replays exactly THIS request, so it — not a walk of the
 * `update.*` directories — is the only thing that answers both "what would a
 * kickstart install?" and "would it bring the app back?".
 *
 * `relaunchesAfterInstall` matters because `launchAfterInstallation` is only
 * YES between `quitAndInstall` and the next `-prepareUpdateForInstallation:`:
 * a fresh download mid-session rewrites the request with it back to NO
 * (SQRLUpdater.m), which would turn an armed self-repair kick into an install
 * that never reopens the app — exactly what the armed dialog promises it will.
 *
 * `null` for absent / truncated / non-JSON / no usable bundle URL: every
 * caller reads that as "do nothing", which is the safe side of a path that
 * replaces the user's application.
 * @param {string} raw
 * @returns {{ bundlePath: string, relaunchesAfterInstall: boolean } | null} a filesystem path, never a URL
 */
function parseShipItRequest(raw) {
  try {
    const request = JSON.parse(raw)
    if (!request || typeof request !== 'object' || Array.isArray(request)) return null
    const url = request.updateBundleURL
    if (typeof url !== 'string' || !url) return null
    const path = url.startsWith('file://') ? decodeURIComponent(new URL(url).pathname) : url
    // Only an absolute local path can be a bundle we are able to read.
    if (!path.startsWith('/')) return null
    return {
      bundlePath: path.replace(/\/+$/, ''),
      // Anything but a literal true reads as "will not relaunch" — this gates a
      // promise made to the user, so it may not be inferred from a missing key.
      relaunchesAfterInstall: request.launchAfterInstallation === true,
    }
  } catch {
    return null
  }
}

/**
 * `CFBundleShortVersionString` out of `plutil -convert json -o - Info.plist`.
 * `null` for anything unparseable — every caller treats that as "do nothing".
 * @param {string} json
 */
function versionFromPlistJson(json) {
  try {
    const parsed = JSON.parse(json)
    const v = parsed && parsed.CFBundleShortVersionString
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
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

/**
 * The IO pair `ensureRelaunchAfterInstall` needs for a REAL request file.
 *
 * It lives here, not in main.js, for two reasons: the write is the part with
 * teeth (a truncating `writeFileSync` that dies halfway leaves ShipIt a request
 * it cannot parse — no install AND no relaunch, on a quit that has already told
 * the next boot it was installing), and a closure defined inside Electron code
 * can only ever be pinned by grepping its source. Here the production closure
 * itself is what the tests and `scripts/probe-shipit-relaunch.mts` run.
 *
 * Write = tmp file + rename, atomic on APFS: on any failure Squirrel's request
 * is still the one on disk, untouched. ANY failure — a tmp write that dies on
 * ENOSPC as much as a rename that fails — takes the tmp file with it (ShipIt's
 * own directory is not ours to litter), and the error is rethrown so the caller
 * reports `write-failed` and stands down.
 * @param {string} statePath
 * @param {{ readFileSync: Function, writeFileSync: Function, renameSync: Function, unlinkSync: Function }} [fsImpl]
 */
function shipItRequestIO(statePath, fsImpl) {
  const fs = fsImpl || require('fs')
  const tmp = `${statePath}.og-tmp`
  return {
    read: () => fs.readFileSync(statePath, 'utf8'),
    write: (text) => {
      try {
        fs.writeFileSync(tmp, text)
        fs.renameSync(tmp, statePath)
      } catch (err) {
        // Covers the half-written tmp too: a writeFileSync that dies partway
        // still leaves a file behind, and it is no more ours to keep than the
        // one a failed rename leaves.
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* best effort — the write already failed, this is only tidying */
        }
        throw err
      }
    },
  }
}


/**
 * Make the pending ShipIt request RELAUNCH the app after it installs — by
 * WRITING that instruction, not by trusting that someone else already did.
 *
 * ⚠ WHAT IS AND IS NOT CLAIMED HERE (owner report + commander's re-measurement,
 * 2026-09-22). `launchAfterInstallation` is NO in every request Squirrel writes
 * at stage time (`-prepareUpdateForInstallation:`, SQRLUpdater.m:1082-1083) and
 * is flipped to YES in exactly one place: `-relaunchToInstallUpdate`
 * (:1092-1111), i.e. inside `quitAndInstall`. So ANY install that reaches ShipIt
 * without that call installs the new version and leaves the app closed.
 *
 * Two different quits can reach it, and they are NOT the same case:
 *   (a) a quit THIS APP started to install an update ("Restart now", or the
 *       hands-free auto-apply). That is what this function is for: the app
 *       promised to come back, so the relaunch is ours to state.
 *   (b) a quit the app did not start — an ordinary ⌘Q with an update staged.
 *       Squirrel installs it on termination anyway, with NO. **Owner decision,
 *       2026-09-22: that install should reopen the app as well**, so this
 *       function is called for (b) too — from `relaunchUnarmedStagedInstall`
 *       (electron/main.js), at the arm gate, when the staged bundle reads AND
 *       its version differs from the running one (same version ⇒ leftovers of a
 *       past install, which survive it — measured on the owner's Mac).
 *       (The earlier policy here was the opposite — "the user closed the app,
 *       so it stays closed". It was a pending owner question; it is decided,
 *       and docs/DISTRIBUTION.md records the decision.) What (b) still does
 *       NOT do is kickstart launchd: an unarmed quit writes the request and
 *       nothing more.
 *
 * The owner's 2026-09-22 install is NOT classified here, because the logs do
 * not support a classification. What IS measured about it is a negative: there
 * is NO `quitting to install 0.11.120` line in `~/.openground/updater.log`, and
 * that line is written only by `beforeInstall` — so nothing armed whatever
 * applied it. (Nor would the 2026-09-22 unarmed-quit change have altered it:
 * that one writes from `will-quit`, and the `auto-apply deferred` counter below
 * shows the running process never quit.) Everything else is unexplained — and
 * mind the CLOCKS, because the two logs disagree: ShipIt writes LOCAL time,
 * `updater.log` writes UTC, so every time below is given as JST (= Z + 9).
 * The same process's `auto-apply deferred (unfocused Nmin)` counter rises
 * straight THROUGH the install (…24min at 10:22 JST, 29min at 10:27 JST)
 * instead of resetting, and there is no `boot:` line between 07:22 and 10:35
 * JST — i.e. the app neither quit nor started, yet ShipIt completed an install
 * at 10:25 JST (= 01:25Z). That is NOT safely called an upstream bug:
 * `-waitForTermination` waits only for processes whose `bundleURL` matches
 * `targetBundleURL` (the `filter:` in SQRLTerminationListener.m), so a live
 * process running from a DIFFERENT bundle is documented behaviour, not a
 * violation. What the follow-up card should establish first is which bundle
 * that running process was executing from.
 * Do not repeat the earlier mistake of naming the incident (a) or (b) —
 * measured, it is neither.
 *
 * (a) is nonetheless reachable with a NO request, which is why writing beats
 * assuming: `beforeInstall` arms the kickstart and only then calls
 * `quitAndInstall`, which on macOS can return WITHOUT quitting (MacUpdater.js
 * :236-252 — the `squirrelDownloadedUpdate === false` branch). That path is
 * real, not yet observed in a log here, and the arm is dropped when the install
 * watchdog fires precisely so it cannot ride a later, unrelated quit.
 *
 * Two properties make the write safe where it happens:
 *   • ShipIt re-reads the request AFTER the app has terminated (ShipIt-main.m
 *     subscribes `readRequestSignal` twice — :121 before
 *     `waitForTerminationIfNecessary`, :126 after — and `+readUsingURL:` is not
 *     cached), so a write from the dying process still lands in time;
 *   • every caller gates on being able to READ what it is blessing — the armed
 *     one on the staged version matching what it quit for, the unarmed one on
 *     the staged bundle being readable at all — and this function refuses any
 *     request it cannot recognise, so "unsure" always means "write nothing".
 *
 * IO is injected so this is testable against a real file without Electron.
 * Every failure is a return value, never a throw: this runs with the event loop
 * already ending, where an exception would take the kickstart down with it.
 * @param {{ read: () => string, write: (text: string) => void }} io
 * @returns {'set' | 'already-set' | 'unusable' | 'write-failed'}
 */
function ensureRelaunchAfterInstall(io) {
  let raw = null
  try {
    raw = io.read()
  } catch {
    return 'unusable'
  }
  let request = null
  try {
    request = JSON.parse(raw)
  } catch {
    return 'unusable'
  }
  // A file we cannot recognise as a ShipIt request is one we must not write:
  // the same conservatism as parseShipItRequest, for the same reason (this path
  // ends in replacing the user's application bundle).
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'unusable'
  if (typeof request.updateBundleURL !== 'string' || !request.updateBundleURL) return 'unusable'
  // AND the target, as a PRESENCE CHECK only: `launchAfterInstallation` means
  // "reopen targetBundleURL" (ShipIt-main.m launches the TARGET, not the staged
  // copy), so a request without one is a relaunch with no subject. It does NOT
  // check that the target is the app we are running, deliberately — Squirrel
  // owns that string, and a stricter comparison would reject legitimate
  // installs (a relocated bundle, a differently-encoded URL) to guard against
  // something never observed. Checked here rather than plumbed through
  // parseShipItRequest, which answers a different question ("what would a
  // kickstart install?") and has its own callers.
  if (typeof request.targetBundleURL !== 'string' || !request.targetBundleURL) return 'unusable'
  if (request.launchAfterInstallation === true) return 'already-set'
  try {
    // Spread, so every other key Squirrel put there (targetBundleURL,
    // bundleIdentifier, useUpdateBundleName) survives verbatim — ShipIt needs
    // them all, and we only have an opinion about one.
    io.write(JSON.stringify({ ...request, launchAfterInstallation: true }))
  } catch {
    return 'write-failed'
  }
  return 'set'
}

module.exports = {
  SHIPIT_LABEL_SUFFIX,
  shipItLabel,
  launchdDomain,
  parseDisabledFlag,
  parseServicePrint,
  parseShipItRequest,
  decideInstallPreflight,
  decideBootRecovery,
  decideArmedRecoveryAtQuit,
  decideUnarmedStagedRelaunch,
  versionFromPlistJson,
  describeShipItState,
  shipItRequestIO,
  ensureRelaunchAfterInstall,
}
