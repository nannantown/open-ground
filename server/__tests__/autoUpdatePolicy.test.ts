import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Plain-CJS main-process module (no Electron runtime needed) — same import
// style as updateMenu.test.ts / autoUpdate.test.ts.
import {
  AUTO_APPLY_INPUT_QUIET_MS,
  AUTO_APPLY_POLL_MS,
  AUTO_APPLY_MAX_DEFER_MS,
  AUTO_APPLY_TYPING_GUARD_MS,
  AUTO_APPLY_TYPING_RETRY_MS,
  isOwnerInputEvent,
  USER_TERMINAL_GRACE_MS,
  NUDGE_MIN_GAP_MS,
  ASAP_WINDOW_MS,
  asapWindowActive,
  autoUpdateFromSettingsRaw,
  decideAutoApply,
  decideDownloadedAction,
  shouldNudgeCheck,
} from '../../electron/autoUpdatePolicy'

// The hands-free apply decision (electron/autoUpdatePolicy.js). Every input is
// supplied by main.js; this pins the FAIL-CLOSED shape: any missing/negative
// condition defers, and only the full conjunction applies. A flipped branch
// here is an unattended restart on top of running work — the exact incident
// class the shipped dialog design existed to prevent.

const base = {
  enabled: true,
  lockdown: false,
  hasDownloaded: true,
  inputIdleMs: AUTO_APPLY_INPUT_QUIET_MS,
  heldMs: 0,
  safety: { safe: true, generating: 0, userPtys: 0 },
}

describe('autoUpdateFromSettingsRaw', () => {
  it('only a literal boolean is an OPINION — everything else is not consent', () => {
    // The `{}` case moved out on 2026-08-15: an unset value is now the DEFAULT
    // (ON), not a refusal. See the default-is-ON block at the bottom of this
    // file. The narrowing itself is unchanged — a forged value still never
    // reads as consent.
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: true }))).toBe(true)
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: false }))).toBe(false)
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: 'true' }))).toBe(false)
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: 1 }))).toBe(false)
  })
  it('corrupt json reads as OFF (fail closed)', () => {
    expect(autoUpdateFromSettingsRaw('{not json')).toBe(false)
  })
})

describe('decideAutoApply', () => {
  it('applies only on the full conjunction', () => {
    expect(decideAutoApply(base).apply).toBe(true)
  })
  it('defers when the toggle is off', () => {
    expect(decideAutoApply({ ...base, enabled: false }).apply).toBe(false)
  })
  it('defers under work mode (lockdown)', () => {
    expect(decideAutoApply({ ...base, lockdown: true }).apply).toBe(false)
  })
  it('defers with nothing downloaded', () => {
    expect(decideAutoApply({ ...base, hasDownloaded: false }).apply).toBe(false)
  })
  it('defers while the owner is typing into the window', () => {
    expect(decideAutoApply({ ...base, inputIdleMs: 0 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, inputIdleMs: AUTO_APPLY_INPUT_QUIET_MS - 1 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, inputIdleMs: NaN }).apply, 'NaN reads as typing').toBe(false)
  })
  it('defers when the safety probe is unreachable (fail closed)', () => {
    expect(decideAutoApply({ ...base, safety: null }).apply).toBe(false)
  })
})

// ─── CLAUDE GENERATING NEVER HOLDS THE UPDATE (owner decision 2026-09-23) ───
//
// 「自動アップデートが ON なら、作業途中でもアップデートするようにしよう」. Measured
// the day before: 0.11.125 stayed installed while 0.11.126–130 sat downloaded,
// because restart-safety answered {safe:false, generating:2} all day — with
// Swarm on, something is always generating. And the old ≥30-min-unfocused gate
// never opened for an owner who keeps the app in front. Both are gone; desks
// and workers resume after the restart. Put either gate back and this is red.
describe('decideAutoApply — AI at work is not a reason to wait', () => {
  it('applies while Claude is generating (safe:false only because of generating)', () => {
    const r = decideAutoApply({ ...base, safety: { safe: false, generating: 2, userPtys: 0 } })
    expect(r.apply).toBe(true)
    expect(r.reason).toContain('generating=2')
  })

  it('applies with the window in front all day, once the owner stops typing', () => {
    // The window has never lost focus; the only thing that matters is the
    // last keystroke.
    expect(decideAutoApply({ ...base, inputIdleMs: AUTO_APPLY_INPUT_QUIET_MS }).apply).toBe(true)
    expect(AUTO_APPLY_INPUT_QUIET_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it("the owner's own busy terminal holds it — but only for a bounded grace", () => {
    const busy = { safe: false, generating: 0, userPtys: 1 }
    expect(decideAutoApply({ ...base, safety: busy, heldMs: 0 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, safety: busy, heldMs: USER_TERMINAL_GRACE_MS - 1 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, safety: busy, heldMs: USER_TERMINAL_GRACE_MS }).apply).toBe(true)
    // "within about an hour of release": ≤1h discovery poll + this grace must
    // not turn into a day.
    expect(USER_TERMINAL_GRACE_MS).toBeLessThanOrEqual(60 * 60 * 1000)
  })

  it('an unreadable terminal count reads as busy (fail closed within the grace)', () => {
    for (const safety of [{ safe: true }, { safe: true, userPtys: Number.NaN }]) {
      expect(decideAutoApply({ ...base, safety, heldMs: 0 }).apply).toBe(false)
    }
    expect(decideAutoApply({ ...base, heldMs: NaN, safety: { userPtys: 2 } }).apply).toBe(false)
  })

  it('autoUpdate OFF is unchanged: never applies, whatever the probe says', () => {
    for (const safety of [base.safety, { safe: false, generating: 2, userPtys: 0 }]) {
      expect(decideAutoApply({ ...base, enabled: false, safety }).apply).toBe(false)
    }
  })
})

// ─── THE INVERSION (2026-08-04) ─────────────────────────────────────────────
//
// Turning hands-free updates ON used to SUPPRESS the restart prompt: main.js
// armed the auto-apply loop and returned early. That left the ON path with two
// ways to land an update (the unattended moment, and a normal quit) against the
// OFF path's three — because OFF also just asks, which always works.
//
// And the unattended moment never came. Measured on the owner's own running app
// on 2026-08-04: `GET /api/update/restart-safety` → {safe:false, generating:0,
// userPtys:2}, and both PTYs were empty login shells with no child process, open
// for 1h23m. The gate wanted userPtys === 0 from someone who always has a
// terminal open, so the answer was structurally always "defer".
//
// **ON delivered updates less reliably than OFF.** These pin the fix: arming the
// loop and telling the user are independent decisions, and hands-free means "no
// modal interrupting you", never "no way to know".

describe('decideDownloadedAction — hands-free never means silent', () => {
  it('ON still notifies (this is the whole bug)', () => {
    const r = decideDownloadedAction({ enabled: true, lockdown: false, waitedDays: 0 })
    expect(r.armLoop, 'the unattended loop is still armed').toBe(true)
    expect(r.notify, 'and the user is told anyway').toBe(true)
  })

  it('the notice escalates the longer an update sits unapplied', () => {
    const at = (waitedDays: number) =>
      decideDownloadedAction({ enabled: true, lockdown: false, waitedDays }).escalation
    expect(at(0)).toBe('quiet')
    expect(at(2)).toBe('quiet')
    expect(at(3)).toBe('banner')
    expect(at(6)).toBe('banner')
    expect(at(7)).toBe('dialog')
    expect(at(30)).toBe('dialog')
  })

  it('OFF keeps the shipped flow — ask once, immediately, no loop', () => {
    const r = decideDownloadedAction({ enabled: false, lockdown: false, waitedDays: 0 })
    expect(r).toEqual({ armLoop: false, notify: true, escalation: 'dialog' })
  })

  it('work mode suppresses everything, both directions', () => {
    for (const enabled of [true, false]) {
      expect(decideDownloadedAction({ enabled, lockdown: true, waitedDays: 99 })).toEqual({
        armLoop: false,
        notify: false,
        escalation: 'none',
      })
    }
  })

  it('a nonsense waitedDays does not silence the notice', () => {
    // NaN / negative must never fall through to "say nothing" — the failure
    // direction that produced the original bug.
    for (const waitedDays of [NaN, -5, Infinity]) {
      const r = decideDownloadedAction({ enabled: true, lockdown: false, waitedDays })
      expect(r.notify, `waitedDays=${waitedDays}`).toBe(true)
      expect(['quiet', 'banner', 'dialog']).toContain(r.escalation)
    }
  })
})

// The release-time bell (POST /api/update/check-now → IPC → maybeCheck). The
// route is reachable by anything on loopback, so without this gap a tight loop
// could drive one GitHub fetch per request through the MAIN process — the gap
// is the ONLY thing standing between the two.
describe('shouldNudgeCheck', () => {
  it('the first ring ever passes (lastNudgeAt starts at 0)', () => {
    expect(shouldNudgeCheck({ lastNudgeAt: 0, now: Date.now() })).toBe(true)
  })

  it('a second ring inside the gap is swallowed', () => {
    const now = 1_000_000
    expect(shouldNudgeCheck({ lastNudgeAt: now - NUDGE_MIN_GAP_MS + 1, now })).toBe(false)
  })

  it('rings exactly at and past the gap pass', () => {
    const now = 1_000_000
    expect(shouldNudgeCheck({ lastNudgeAt: now - NUDGE_MIN_GAP_MS, now })).toBe(true)
    expect(shouldNudgeCheck({ lastNudgeAt: now - NUDGE_MIN_GAP_MS * 10, now })).toBe(true)
  })

  it('the gap is long enough to matter and short enough not to', () => {
    // Shorter than ~10s stops being a rate limit; longer than the ~5min apply
    // poll would start swallowing legitimate consecutive releases.
    expect(NUDGE_MIN_GAP_MS).toBeGreaterThanOrEqual(10_000)
    expect(NUDGE_MIN_GAP_MS).toBeLessThanOrEqual(AUTO_APPLY_POLL_MS)
  })
})

// {apply:'asap'} — the user COMMANDED this update. The command waives exactly
// one gate (the typing check) and nothing else. The dangerous direction is
// a command that silently overrides work mode or the owner-terminal hold.
// (Claude mid-generation no longer holds ANY apply — see the block above.)
describe('decideAutoApply with asap', () => {
  const focusedBase = {
    enabled: true,
    lockdown: false,
    hasDownloaded: true,
    inputIdleMs: 0, // typing RIGHT NOW — the case the typing check blocks
    heldMs: 0,
    safety: { safe: true, generating: 0, userPtys: 0 },
  }

  it('waives the typing check: typing + asap applies', () => {
    expect(decideAutoApply({ ...focusedBase }).apply).toBe(false) // without asap
    const r = decideAutoApply({ ...focusedBase, asap: true })
    expect(r.apply).toBe(true)
    expect(r.reason).toContain('commanded')
  })

  it('waives NOTHING else — each remaining gate still blocks', () => {
    expect(decideAutoApply({ ...focusedBase, asap: true, enabled: false }).apply).toBe(false)
    expect(decideAutoApply({ ...focusedBase, asap: true, lockdown: true }).apply).toBe(false)
    expect(decideAutoApply({ ...focusedBase, asap: true, hasDownloaded: false }).apply).toBe(false)
    expect(decideAutoApply({ ...focusedBase, asap: true, safety: null }).apply).toBe(false)
    expect(
      decideAutoApply({
        ...focusedBase,
        asap: true,
        safety: { safe: false, generating: 0, userPtys: 1 },
      }).apply,
    ).toBe(false)
  })
})

describe('asapWindowActive — the command expires', () => {
  it('never armed → inactive', () => {
    expect(asapWindowActive({ armedAt: 0, now: 1_000_000_000 })).toBe(false)
  })

  it('fresh command → active; expired command → inactive', () => {
    const now = 1_000_000_000
    expect(asapWindowActive({ armedAt: now - 1000, now })).toBe(true)
    expect(asapWindowActive({ armedAt: now - ASAP_WINDOW_MS - 1, now })).toBe(false)
  })

  it('the window outlives at least one apply-poll tick but not an evening', () => {
    // Shorter than one poll and a slow download could outlive its own command;
    // hours long and a noon bell surprise-restarts the app at night.
    expect(ASAP_WINDOW_MS).toBeGreaterThanOrEqual(AUTO_APPLY_POLL_MS)
    expect(ASAP_WINDOW_MS).toBeLessThanOrEqual(30 * 60 * 1000)
  })
})

describe('the DEFAULT is ON — an unset setting means hands-free (2026-08-15)', () => {
  // The owner asked twice. The first ask produced this feature defaulted OFF,
  // so it never ran for them and they kept asking a human to install releases
  // by hand. A default that makes the feature not happen is the same as not
  // having built it.
  it('no opinion recorded ⇒ ON', () => {
    expect(autoUpdateFromSettingsRaw('{}')).toBe(true)
    expect(autoUpdateFromSettingsRaw('{"language":"ja"}')).toBe(true)
  })

  it('an explicit false ⇒ OFF — the user turning it off still means something', () => {
    expect(autoUpdateFromSettingsRaw('{"autoUpdate":false}')).toBe(false)
  })

  it('an explicit true ⇒ ON', () => {
    expect(autoUpdateFromSettingsRaw('{"autoUpdate":true}')).toBe(true)
  })

  it('a FORGED or corrupt value is never read as consent', () => {
    // Same strict narrowing as before: only a real boolean is an opinion.
    for (const raw of ['{"autoUpdate":"yes"}', '{"autoUpdate":1}', '{"autoUpdate":null}']) {
      expect(autoUpdateFromSettingsRaw(raw), raw).toBe(false)
    }
    // And an unreadable file fails CLOSED — if we cannot read settings we
    // cannot read work-mode either, and restarting blind is nobody's default.
    expect(autoUpdateFromSettingsRaw('{ not json')).toBe(false)
    expect(autoUpdateFromSettingsRaw('[]')).toBe(false)
    expect(autoUpdateFromSettingsRaw('null')).toBe(false)
  })
})

// main.js wiring. The pure decision fails CLOSED on a missing input
// (`inputIdleMs: undefined` reads as "typing"), so a main.js that kept passing
// the old `unfocusedMs` would defer forever with every test above still green.
describe('main.js feeds the policy the inputs it reads', () => {
  const main = readFileSync(join(__dirname, '../../electron/main.js'), 'utf8')
  it('stamps the last keystroke and passes typing-idle + held time', () => {
    expect(main).toMatch(/before-input-event[\s\S]{0,300}lastUserInputAt = Date\.now\(\)/)
    // Mouse/wheel counts as presence too (dragging on the Canvas, scrolling).
    expect(main).toMatch(/'input-event'[\s\S]{0,120}lastUserInputAt = Date\.now\(\)/)
    expect(main).toContain('inputIdleMs: now - lastUserInputAt')
    expect(main).toContain('heldMs: now - downloadedUpdateAt')
    expect(main).not.toContain('unfocusedMs')
  })
})

// Review 292ed010 B1: a version whose install already FAILED (the boot verdict
// found the app still on the old version) must not be retried by the
// hands-free loop — relaunch → re-download → apply → fail every few minutes
// cuts every desk each lap and trips the swarm crash-loop breaker.
describe('a failed install is never retried hands-free', () => {
  it('defers the failed version, even under asap', () => {
    expect(decideAutoApply({ ...base, failedBefore: true }).apply).toBe(false)
    expect(decideAutoApply({ ...base, failedBefore: true, asap: true, inputIdleMs: 0 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, failedBefore: false }).apply).toBe(true)
  })
})

describe('main.js: launch is presence, failures are remembered, staging is re-checked', () => {
  const main = readFileSync(join(__dirname, '../../electron/main.js'), 'utf8')
  it('seeds the last input with launch time (0 read as idle-forever at boot)', () => {
    expect(main).toContain('let lastUserInputAt = Date.now()')
  })
  it('the boot verdict feeds failedBefore', () => {
    const boot = main.slice(main.indexOf('function reportFailedInstallOnBoot'))
    expect(boot.slice(0, 1500)).toMatch(/kind !== 'failed'\) return[\s\S]{0,300}failedInstallVersion = verdict\.to/)
    expect(main).toMatch(/failedBefore:\s*\n?\s*failedInstallVersion !== null/)
  })
  it('re-evaluates after the staging wait and before the teardown (review A3)', () => {
    const fn = main.slice(main.indexOf('async function applyUpdateWhenStaged'))
    const wait = fn.indexOf('await waitForInstallStaged')
    const recheck = fn.indexOf('await opts.recheck()')
    const teardown = fn.indexOf('await applyDownloadedUpdate(')
    expect(wait).toBeGreaterThan(-1)
    expect(recheck).toBeGreaterThan(wait)
    expect(teardown).toBeGreaterThan(recheck)
    expect(main).toContain('applyUpdateWhenStaged(downloadedUpdate && downloadedUpdate.version, { recheck: evaluateAutoApply })')
  })
})

// ─── FALSE "OWNER ACTIVE" + THE CEILING (owner report 2026-09-24) ───
//
// 「自動で更新されないんだけど」: 0.11.136 sat downloaded 03:11→04:11Z while every
// 5-min tick said "owner active (last input ~25s ago)". Pointer move/enter/
// leave reach the window whenever the cursor rests over it, so they counted
// as the owner working. Now only real input counts, and a downloaded update
// that has waited AUTO_APPLY_MAX_DEFER_MS goes in unless the owner is typing
// this second.
describe('only real input is the owner; a ceiling bounds the wait', () => {
  it('pointer hover/move/enter/leave is NOT owner input', () => {
    for (const t of ['mouseMove', 'mouseEnter', 'mouseLeave', 'undefined', '', 'contextMenu'])
      expect(isOwnerInputEvent(t), t).toBe(false)
    expect(isOwnerInputEvent(undefined)).toBe(false)
  })
  it('keys, clicks, wheel/trackpad scroll and pinch ARE owner input', () => {
    for (const t of ['keyDown', 'rawKeyDown', 'char', 'keyUp', 'mouseDown', 'mouseUp', 'mouseWheel', 'gestureScrollUpdate', 'gesturePinchUpdate'])
      expect(isOwnerInputEvent(t), t).toBe(true)
  })
  it('a periodic stamp every 5 min cannot hold the update past the ceiling', () => {
    // The measured shape: every tick sees input ~25s ago, forever.
    const held = (min: number) => decideAutoApply({ ...base, inputIdleMs: 25_000, heldMs: min * 60_000 })
    expect(held(5).apply, 'inside the ceiling the quiet window still holds').toBe(false)
    expect(held(AUTO_APPLY_MAX_DEFER_MS / 60_000).apply, 'at the ceiling it goes in').toBe(true)
    expect(held(AUTO_APPLY_MAX_DEFER_MS / 60_000).reason).toContain('ceiling')
  })
  it('the ceiling lands a publish within about an hour', () => {
    // publish → download (a few min) + ceiling + at most one poll ≤ 60 min
    expect(AUTO_APPLY_MAX_DEFER_MS + AUTO_APPLY_POLL_MS).toBeLessThanOrEqual(55 * 60_000)
  })
  it('past the ceiling, typing THIS SECOND still holds it — and asks again soon', () => {
    const d = decideAutoApply({ ...base, inputIdleMs: 1_000, heldMs: AUTO_APPLY_MAX_DEFER_MS + 1 })
    expect(d.apply).toBe(false)
    expect(d.retryInMs).toBe(AUTO_APPLY_TYPING_RETRY_MS)
    expect(AUTO_APPLY_TYPING_RETRY_MS).toBeLessThan(AUTO_APPLY_POLL_MS)
    expect(decideAutoApply({ ...base, inputIdleMs: AUTO_APPLY_TYPING_GUARD_MS - 1, heldMs: AUTO_APPLY_MAX_DEFER_MS }).apply).toBe(false)
    expect(decideAutoApply({ ...base, inputIdleMs: NaN, heldMs: AUTO_APPLY_MAX_DEFER_MS }).apply, 'NaN reads as typing').toBe(false)
  })
  it('the ceiling waives only the quiet window — every other gate still blocks', () => {
    const over = { ...base, inputIdleMs: 25_000, heldMs: AUTO_APPLY_MAX_DEFER_MS }
    expect(decideAutoApply({ ...over, enabled: false }).apply).toBe(false)
    expect(decideAutoApply({ ...over, lockdown: true }).apply).toBe(false)
    expect(decideAutoApply({ ...over, failedBefore: true }).apply).toBe(false)
    expect(decideAutoApply({ ...over, safety: null }).apply).toBe(false)
  })
  it('main.js filters input-event through isOwnerInputEvent and honours retryInMs', () => {
    const main = readFileSync(join(__dirname, '../../electron/main.js'), 'utf8')
    expect(main).toMatch(/'input-event',[\s\S]{0,80}if \(!isOwnerInputEvent\(input && input\.type\)\) return[\s\S]{0,40}lastUserInputAt = Date\.now\(\)/)
    expect(main).toMatch(/decision\.retryInMs[\s\S]{0,200}setTimeout\([\s\S]{0,120}maybeAutoApplyUpdate\(\)[\s\S]{0,40}decision\.retryInMs\)/)
  })
})
