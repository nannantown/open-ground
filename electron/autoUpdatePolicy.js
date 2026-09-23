// electron/autoUpdatePolicy.js — hands-free update policy for the Electron MAIN
// process, factored out of main.js so it is unit-testable WITHOUT an Electron
// runtime (the same plain-CJS split as lockdown.js / autoUpdate.js /
// updateMenu.js). server/__tests__/autoUpdatePolicy.test.ts locks it.
//
// WHAT THIS DECIDES. With settings.autoUpdate on, the app applies a downloaded
// update BY ITSELF instead of showing the restart dialog, as soon as:
//   1. the owner is not using the window right now (no key/mouse input for
//      AUTO_APPLY_INPUT_QUIET_MS), and
//   2. the SERVER answers the safety probe (GET /api/update/restart-safety), and
//      nothing WITHOUT resume machinery is busy (a terminal the owner opened,
//      a hidden one-off claude run — the probe's `userPtys`) — or that has
//      already held this update for USER_TERMINAL_GRACE_MS.
// AI work in progress is NOT a reason to wait (owner decision 2026-09-23:
// 「自動アップデートが ON なら、作業途中でもアップデートするようにしよう」).
// Measured the day before: 0.11.125 stayed installed while 0.11.126–130 sat
// downloaded, because the probe answered {safe:false, generating:2} all day —
// with Swarm on, SOMETHING is always generating, so "wait for a quiet moment"
// meant "never". Desks and swarm workers resume after a restart by design
// (liveDesks.ts, swarm recovery), so an interrupted generation is a pause, not
// a loss. The old "window unfocused ≥30 min" gate went with it: the owner keeps
// the app in front all day, so that gate also meant "never".
// The decision itself is pure; main.js supplies the inputs and performs the
// teardown-then-quitAndInstall side effect (electron/autoUpdate.js ordering).
//
// FAIL DIRECTION. Everything here fails CLOSED to "defer": a missing/corrupt
// settings.json reads as OFF (same `=== true` narrowing the server stores —
// store.ts setUserSettings), and an unreachable/errored safety probe reads as
// UNSAFE. Deferring only costs waiting for the next tick (or the app-quit
// backstop: autoInstallOnAppQuit applies the update on any normal quit).

'use strict'

/** Key/mouse input in the window this recently means the owner is using it
 *  right now — don't restart under their fingers. Long enough to span the pause
 *  between two sentences, short enough that someone who works in the app all
 *  day still leaves gaps (they wait on Claude often). */
const AUTO_APPLY_INPUT_QUIET_MS = 3 * 60 * 1000

/** How long a terminal the OWNER opened (not a desk, not a swarm worker) may
 *  hold a downloaded update while something runs in it. It is their own work,
 *  which nothing restores, so it gets a grace — but a bounded one: a dev server
 *  left running all day must not become "never update" again. */
const USER_TERMINAL_GRACE_MS = 30 * 60 * 1000

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
    // Array.isArray FIRST: `[]` is typeof 'object' and truthy, so without this
    // a settings.json holding an array reached the `undefined` branch below and
    // was read as consent. (Caught by this change's own guard, not by review.)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    // ABSENT ⇒ ON (2026-08-15, owner: 「こっちで命令するんじゃなくて」 — the second
    // time they have asked for this; the first produced the feature, defaulted
    // OFF, and it therefore never ran).
    //
    // The three cases are deliberately different:
    //   • no opinion recorded  → the new default, ON
    //   • an explicit `false`  → the user turned it off; that stands
    //   • anything else        → OFF, same strict narrowing as before, so a
    //     forged or corrupt value can never be read as consent
    // An UNPARSEABLE settings.json still fails closed below: if we cannot read
    // the file we also cannot read work-mode, and restarting blind is not a
    // default anyone chose.
    if (parsed.autoUpdate === undefined) return true
    return parsed.autoUpdate === true
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
 *   failedBefore?: boolean,       // THIS version's install already failed (boot verdict) — manual only
 *   inputIdleMs: number,          // ms since the last key/mouse input in the window
 *   heldMs: number,               // ms since the first waiting update finished downloading
 *   asap?: boolean,               // live user command (bell {apply:'asap'}) — waives ONLY the typing check
 *   safety: { safe?: boolean, generating?: number, userPtys?: number } | null, // server probe; null = unreachable
 * }} input
 * @returns {{ apply: boolean, reason: string }}
 */
function decideAutoApply(input) {
  if (!input.enabled) return { apply: false, reason: 'autoUpdate off' }
  if (input.lockdown) return { apply: false, reason: 'work mode (lockdown) on' }
  if (!input.hasDownloaded) return { apply: false, reason: 'nothing downloaded' }
  // THE FAILED-INSTALL LOOP (review 292ed010 B1). The app woke up still on the
  // old version after quitting to install THIS one. Retrying by itself would
  // be: relaunch → re-download → apply → fail, every few minutes, cutting every
  // desk and worker each lap — and three boots of one version in 10 min trips
  // the swarm crash-loop breaker, after which not even the desks come back.
  // So a version that failed once waits for a human: the boot's install-failed
  // dialog, or "Restart now" (which does not come through here). Not waived by
  // `asap` either — a bell is a script, not someone watching the result.
  if (input.failedBefore)
    return { apply: false, reason: 'this version failed to install last time — manual restart only' }
  // `asap` waives ONLY the typing check: the user COMMANDED this update (bell
  // rung with {apply:'asap'}), so "don't restart under their fingers" no longer
  // applies. Every other gate stays.
  if (!input.asap && !(input.inputIdleMs >= AUTO_APPLY_INPUT_QUIET_MS))
    return { apply: false, reason: `owner active (last input ${Math.round(input.inputIdleMs / 1000)}s ago)` }
  // A dead server means mid-boot or mid-teardown — wrong moments to restart on
  // top of. Fail closed; the next tick asks again.
  if (!input.safety) return { apply: false, reason: 'safety probe unreachable (fail closed)' }
  // ⚠ `safety.safe` and `safety.generating` are deliberately NOT read: both
  // count Claude generating, and that must never hold the update (see the
  // header). Only the owner's own terminals do, for a bounded grace. A missing
  // or non-numeric count cannot be told apart from "busy", so it holds too.
  const userPtys = input.safety.userPtys
  const userBusy = !(typeof userPtys === 'number' && userPtys === 0)
  if (userBusy && !(input.heldMs >= USER_TERMINAL_GRACE_MS))
    return {
      apply: false,
      reason: `owner terminal busy (userPtys=${userPtys ?? '?'}, held ${Math.round(input.heldMs / 60000)}min)`,
    }
  const why = input.asap ? 'commanded (asap)' : 'owner idle'
  const note = `generating=${input.safety.generating ?? '?'} userPtys=${userPtys ?? '?'}`
  return { apply: true, reason: `${why}; ${note}` }
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

/** How long an {apply:'asap'} command stays live. Long enough for the check +
 *  download it triggered to finish; short enough that a bell rung at noon can
 *  never surprise-restart the app in the evening. */
const ASAP_WINDOW_MS = 10 * 60 * 1000

/**
 * Pure decision: is a previously received {apply:'asap'} command still live?
 * @param {{ armedAt: number, now: number }} input — armedAt 0 = never armed
 * @returns {boolean}
 */
function asapWindowActive(input) {
  return input.armedAt > 0 && input.now - input.armedAt <= ASAP_WINDOW_MS
}

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
  AUTO_APPLY_INPUT_QUIET_MS,
  USER_TERMINAL_GRACE_MS,
  AUTO_APPLY_POLL_MS,
  SAFETY_FETCH_TIMEOUT_MS,
  NUDGE_MIN_GAP_MS,
  ASAP_WINDOW_MS,
  asapWindowActive,
  autoUpdateFromSettingsRaw,
  decideDownloadedAction,
  decideAutoApply,
  shouldNudgeCheck,
}
