// experiments.ts — resolves which owner-only experiments are OPEN for the
// caller (docs/CUSTOM_TABS_PLAN.md is the sibling role machinery).
//
// An experiment is a hidden feature gated behind TWO conditions, ANDed here so
// the SERVER is the single authority:
//   1. the caller is the OWNER (decided from the stored app-login session via
//      the Supabase `og_roles` table — see roles.ts; the client never computes
//      this), and
//   2. the owner has turned that experiment ON in settings.json
//      (settings.experiments.<id>, default off).
//
// Because the owner check is ANDed in, a non-owner who forges
// `experiments.swarm: true` in their own settings.json STILL resolves to
// `swarm: false` — the gate never opens for anyone but the owner. `eligible`
// surfaces condition 1 alone so the client can show the owner the toggle
// (without it, the toggle itself would betray the feature's existence).
//
// TWO public opt-ins bypass the owner-AND, each scoped to ONE experiment and
// reported separately from `flags` so they never touch `eligible` (which stays
// owner-only, so the toggle UI for the still-owner-only `sandbox` is not
// revealed):
//   • `swarm` — the server-local owner unlock (swarmGate.ts — env
//     OPENGROUND_LOCAL_OWNER=1 / a hand-edited settings.swarmLocalOwner, for
//     login-disabled machines) AND the public macOS opt-in (Settings.swarmOptIn).
//   • `persona` — the public all-platforms opt-in (Settings.personaOptIn —
//     personaGate.ts), added 2026-08-20 when persona was promoted to a beta.
// `sandbox` keeps requiring the owner. Persona is DECOUPLED from swarm here: a
// swarm opt-in no longer opens the persona surface (the old any-of UI gate did,
// which contradicted this resolver — see the persona flag below).

import { getCustomTabRole } from './roles'
import { isSwarmLocalOwnerUnlocked, isSwarmOptInAvailable, isSwarmOptInEnabled } from './swarmGate'
import { isPersonaOptInAvailable, isPersonaOptInEnabled } from './personaGate'
import { getSettings } from './store'
import type {
  CustomTabRole,
  ExperimentId,
  ExperimentsResponse,
  Settings,
} from '../types'

// Pure resolver — separated from the I/O wiring below so it unit-tests without
// mocking the session / Supabase / disk. `eligible` is owner-only; each flag is
// `eligible && the stored toggle`, so non-owners get all-false regardless of
// what their settings.json claims. `opts.swarmLocalOwner` (the resolved local
// unlock — see the header) opens ONLY the swarm flag, bypassing both.
export const computeExperiments = (
  role: CustomTabRole,
  settings: Pick<Settings, 'experiments'>,
  opts?: {
    swarmLocalOwner?: boolean
    /** The resolved PUBLIC opt-in (macOS && Settings.swarmOptIn) — opens swarm
     *  for a non-owner. See swarmGate.isSwarmOptInEnabled. */
    swarmOptInEnabled?: boolean
    /** Whether this machine can offer the opt-in at all (macOS) — drives the
     *  Settings toggle's visibility, NOT the gate. */
    swarmOptInAvailable?: boolean
    /** The resolved PUBLIC persona opt-in (Settings.personaOptIn, all
     *  platforms) — opens the Persona surface for a non-owner. */
    personaOptInEnabled?: boolean
    /** Whether this machine can offer the persona opt-in — always true (all
     *  platforms); kept for symmetry with swarmOptInAvailable. */
    personaOptInAvailable?: boolean
  },
): ExperimentsResponse => {
  const eligible = role === 'owner'
  return {
    eligible,
    flags: {
      swarm:
        (eligible && settings.experiments?.swarm === true) ||
        opts?.swarmLocalOwner === true ||
        opts?.swarmOptInEnabled === true,
      sandbox: eligible && settings.experiments?.sandbox === true,
      // Persona is its OWN gate now (2026-08-20 — promoted to a public beta):
      // the owner's `experiments.persona` toggle, OR the public persona opt-in.
      // Deliberately DECOUPLED from swarm — a swarm opt-in no longer reveals the
      // personal corpus (it did via the old any-of gate, contradicting this
      // resolver's own intent), and the swarm local unlock never reaches it.
      persona:
        (eligible && settings.experiments?.persona === true) ||
        opts?.personaOptInEnabled === true,
    },
    // The public opt-ins are reported separately from `flags` so a non-owner can
    // see + drive the Settings toggles without `eligible` (which stays owner-only
    // and would reveal sandbox). `enabled` mirrors the resolved gate.
    swarmOptIn: {
      available: opts?.swarmOptInAvailable === true,
      enabled: opts?.swarmOptInEnabled === true,
    },
    personaOptIn: {
      available: opts?.personaOptInAvailable === true,
      enabled: opts?.personaOptInEnabled === true,
    },
  }
}

// Resolve the caller's experiment gate from the live session role + settings
// (+ the server-local swarm unlock + the public macOS opt-in).
export const resolveExperiments = async (): Promise<ExperimentsResponse> =>
  computeExperiments(await getCustomTabRole(), await getSettings(), {
    swarmLocalOwner: await isSwarmLocalOwnerUnlocked(),
    swarmOptInEnabled: await isSwarmOptInEnabled(),
    swarmOptInAvailable: isSwarmOptInAvailable(),
    personaOptInEnabled: await isPersonaOptInEnabled(),
    personaOptInAvailable: isPersonaOptInAvailable(),
  })

// Is ONE experiment open for the caller? Same gate as resolveExperiments (owner
// && the toggle) but TOGGLE-FIRST: it reads settings (cheap, local) and only
// consults the owner role when the toggle is on — so the common path (toggle
// off, which is the shipped default) never pays for a role lookup. Used by the
// hot launch paths (every claude spawn), where resolving ALL experiments + a
// possible Supabase round-trip on each launch would be wasteful. Still
// server-authoritative: a non-owner with a forged toggle fails the role check.
export const isExperimentEnabled = async (id: ExperimentId): Promise<boolean> => {
  // Keep the swarm flag consistent with resolveExperiments: the local unlock
  // AND the public macOS opt-in (swarmGate.ts) open it without a login or the
  // owner toggle — otherwise a hot launch path would see the flag closed while
  // the UI shows the tab.
  if (id === 'swarm' && ((await isSwarmLocalOwnerUnlocked()) || (await isSwarmOptInEnabled())))
    return true
  // Persona has its own public opt-in (all platforms) — same consistency rule.
  if (id === 'persona' && (await isPersonaOptInEnabled())) return true
  const settings = await getSettings()
  if (settings.experiments?.[id] !== true) return false
  return (await getCustomTabRole()) === 'owner'
}
