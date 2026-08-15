import { describe, it, expect } from 'vitest'
// Plain-CJS main-process module (no Electron runtime needed) — same import
// style as updateMenu.test.ts / autoUpdate.test.ts.
import {
  AUTO_APPLY_UNFOCUSED_MIN_MS,
  AUTO_APPLY_POLL_MS,
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
  unfocusedMs: AUTO_APPLY_UNFOCUSED_MIN_MS,
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
  it('defers while the user is (recently) at the window', () => {
    expect(decideAutoApply({ ...base, unfocusedMs: 0 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, unfocusedMs: AUTO_APPLY_UNFOCUSED_MIN_MS - 1 }).apply).toBe(false)
  })
  it('defers when the safety probe is unreachable (fail closed)', () => {
    expect(decideAutoApply({ ...base, safety: null }).apply).toBe(false)
  })
  it('defers when the server reports busy', () => {
    expect(
      decideAutoApply({ ...base, safety: { safe: false, generating: 1, userPtys: 0 } }).apply,
    ).toBe(false)
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
// one gate (the 30-min away-timer) and nothing else. The dangerous direction is
// a command that silently overrides the safety probe or work mode: "update now"
// must never become "destroy the claude that is mid-generation now".
describe('decideAutoApply with asap', () => {
  const focusedBase = {
    enabled: true,
    lockdown: false,
    hasDownloaded: true,
    unfocusedMs: 0, // window focused RIGHT NOW — the case the away-timer blocks
    safety: { safe: true, generating: 0, userPtys: 0 },
  }

  it('waives the away-timer: focused window + asap applies', () => {
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
        safety: { safe: false, generating: 1, userPtys: 0 },
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
