// electron/autoUpdatePolicy.js — hands-free update policy for the Electron MAIN
// process, factored out of main.js so it is unit-testable WITHOUT an Electron
// runtime (the same plain-CJS split as lockdown.js / autoUpdate.js /
// updateMenu.js). server/__tests__/autoUpdatePolicy.test.ts locks it.
//
// WHAT THIS DECIDES. With settings.autoUpdate on, the app applies a downloaded
// update BY ITSELF instead of showing the restart dialog — but only at a moment
// that provably destroys nothing:
//   1. the user is AWAY: the window has been unfocused for ≥30 minutes, and
//   2. the SERVER says it is safe (GET /api/update/restart-safety — no claude
//      mid-generation in either pool, no open user terminal panes; resting
//      desks and swarm workers resume by design, see liveDesks.ts).
// The decision itself is pure; main.js supplies the inputs and performs the
// teardown-then-quitAndInstall side effect (electron/autoUpdate.js ordering).
//
// FAIL DIRECTION. Everything here fails CLOSED to "defer": a missing/corrupt
// settings.json reads as OFF (same `=== true` narrowing the server stores —
// store.ts setUserSettings), and an unreachable/errored safety probe reads as
// UNSAFE. Deferring only costs waiting for the next tick (or the app-quit
// backstop: autoInstallOnAppQuit applies the update on any normal quit).

'use strict'

/** The user must have been away this long before an unattended restart. */
const AUTO_APPLY_UNFOCUSED_MIN_MS = 30 * 60 * 1000

/** Re-evaluate this often while an update sits downloaded. */
const AUTO_APPLY_POLL_MS = 5 * 60 * 1000

/** Bound the safety-probe fetch — a hung server must not hang the policy. */
const SAFETY_FETCH_TIMEOUT_MS = 3000

/**
 * Pure decision: does this settings.json CONTENT say hands-free updates are on?
 * Only a literal `true` counts — mirrors lockdownFromSettingsRaw and the
 * server-side narrowing, so main and server can never disagree on a broken or
 * forged value.
 * @param {string} raw
 * @returns {boolean}
 */
function autoUpdateFromSettingsRaw(raw) {
  try {
    const parsed = JSON.parse(raw)
    return !!parsed && typeof parsed === 'object' && parsed.autoUpdate === true
  } catch {
    return false
  }
}

/**
 * Pure decision: apply the downloaded update right now?
 * @param {{
 *   enabled: boolean,             // settings.autoUpdate (already narrowed)
 *   lockdown: boolean,            // work mode suppresses ALL updater activity
 *   hasDownloaded: boolean,       // an update is on disk waiting
 *   unfocusedMs: number,          // ms since the window lost focus (0 = focused)
 *   safety: { safe: boolean, generating?: number, userPtys?: number } | null, // server probe; null = unreachable
 * }} input
 * @returns {{ apply: boolean, reason: string }}
 */
function decideAutoApply(input) {
  if (!input.enabled) return { apply: false, reason: 'autoUpdate off' }
  if (input.lockdown) return { apply: false, reason: 'work mode (lockdown) on' }
  if (!input.hasDownloaded) return { apply: false, reason: 'nothing downloaded' }
  if (input.unfocusedMs < AUTO_APPLY_UNFOCUSED_MIN_MS)
    return { apply: false, reason: `window in use (unfocused ${Math.round(input.unfocusedMs / 60000)}min)` }
  if (!input.safety) return { apply: false, reason: 'safety probe unreachable (fail closed)' }
  if (!input.safety.safe)
    return {
      apply: false,
      reason: `server reports busy (generating=${input.safety.generating ?? '?'} userPtys=${input.safety.userPtys ?? '?'})`,
    }
  return { apply: true, reason: 'idle + server safe' }
}

/**
 * Pure decision: an update just finished downloading — what happens now?
 *
 * THE INVERSION THIS EXISTS TO FIX. Turning hands-free updates ON used to
 * SUPPRESS the "restart now?" prompt entirely: main.js armed the auto-apply loop
 * and returned. So the ON path had exactly two ways to land an update — the
 * unattended moment, and a normal quit — while the OFF path had a third that
 * always worked: asking. And the unattended moment never came for a user who
 * keeps terminals open (measured on the owner's own app: userPtys never reached
 * 0). **ON delivered updates less reliably than OFF.** A setting that makes the
 * thing it promises less likely is worse than a missing feature, because the
 * user stops looking.
 *
 * So: arming the loop and telling the user are independent. Hands-free still
 * means "no modal interrupting you", never "no way to know". The notice
 * escalates the longer an update sits unapplied, and any of its forms restarts
 * in one click.
 *
 * @param {{
 *   enabled: boolean,     // settings.autoUpdate
 *   lockdown: boolean,    // work mode suppresses ALL updater activity
 *   waitedDays: number,   // days this update has been sitting downloaded
 * }} input
 * @returns {{ armLoop: boolean, notify: boolean, escalation: 'none'|'quiet'|'banner'|'dialog' }}
 */
function decideDownloadedAction(input) {
  // Work mode blocks updater activity outright — no loop, no notice.
  if (input.lockdown) return { armLoop: false, notify: false, escalation: 'none' }
  if (!input.enabled) {
    // The shipped conservative flow: ask, once, right away.
    return { armLoop: false, notify: true, escalation: 'dialog' }
  }
  const d = Number.isFinite(input.waitedDays) ? Math.max(0, input.waitedDays) : 0
  const escalation = d >= 7 ? 'dialog' : d >= 3 ? 'banner' : 'quiet'
  return { armLoop: true, notify: true, escalation }
}

/** Two release-nudges inside this window collapse into one GitHub fetch. */
const NUDGE_MIN_GAP_MS = 60 * 1000

/**
 * Pure decision: honour a server-sent "check for updates now" nudge?
 * The nudge endpoint (POST /api/update/check-now) is reachable by anything on
 * loopback, so without this gap a tight loop could drive one GitHub fetch per
 * request through the MAIN process. Time comes in as an input so the decision
 * stays clock-free and testable.
 * @param {{ lastNudgeAt: number, now: number }} input
 * @returns {boolean}
 */
function shouldNudgeCheck(input) {
  return input.now - input.lastNudgeAt >= NUDGE_MIN_GAP_MS
}

module.exports = {
  AUTO_APPLY_UNFOCUSED_MIN_MS,
  AUTO_APPLY_POLL_MS,
  SAFETY_FETCH_TIMEOUT_MS,
  NUDGE_MIN_GAP_MS,
  autoUpdateFromSettingsRaw,
  decideDownloadedAction,
  decideAutoApply,
  shouldNudgeCheck,
}
