// personaGate.ts — the Persona surface's PUBLIC opt-in, the sibling of
// swarmGate's swarmOptIn. Persona was owner-only; the owner promoted it to a
// public beta (2026-08-20: 「ペルソナ機能もベータ版に上げてしまおう」), the same
// shape as the swarm opt-in but WITHOUT the macOS gate.
//
// WHY ALL PLATFORMS (unlike swarmOptIn). The swarm opt-in is macOS-only because
// its unattended workers lean on the deterministic PreToolUse guard, which is
// unmeasured on Windows. A persona turn is NOT that: it is a single
// marker-scraped `claude` run with a deny-list (no Bash / no Task / no writes
// outside a scratch dir — personaChat.ts) and cwd = a scratch dir, never the
// user's repo. There is no unattended worker and no guard dependency, so the
// Windows-guard reservation does not apply — the opt-in is offered everywhere.
//
// WHY IT IS SAFE TO EXPOSE. The persona routes are loopback-local over the
// caller's OWN corpus in ~/.openground/ (youCorpus.ts) — no cross-user data,
// same posture as /api/settings. Opening the surface for a non-owner shows them
// THEIR own (empty) corpus on THEIR own machine. The in-app warning discloses
// the two real properties: a persona turn runs `claude` with permission prompts
// skipped (inside the deny-listed scratch session above), and it spends the
// user's own `claude` subscription.
//
// The value is request-settable via POST /api/settings (Settings.personaOptIn,
// narrowed to a literal boolean in store.ts) — acceptable because the persona
// gate is feature-visibility, not a security boundary (the routes are already
// loopback-local per-machine state).

import { getSettings } from './store'

/** Persona opt-in is offered on EVERY platform (see header — no unattended
 *  worker, so no Windows-guard reservation). Kept as a function mirroring
 *  swarmGate.isSwarmOptInAvailable so the two read the same at every call site. */
export const isPersonaOptInAvailable = (): boolean => true

/** The PUBLIC persona opt-in resolved: available (always) AND the user turned it
 *  on. This is what opens the Persona surface for a non-owner. */
export const isPersonaOptInEnabled = async (): Promise<boolean> =>
  isPersonaOptInAvailable() && (await getSettings()).personaOptIn === true
