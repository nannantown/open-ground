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
// ONE exception, scoped to `swarm` alone: the server-local owner unlock
// (swarmGate.ts — env OPENGROUND_LOCAL_OWNER=1 / a hand-edited
// settings.swarmLocalOwner, for login-disabled machines) opens the swarm flag
// DIRECTLY, with no login and no experiments toggle — it is the same unlock
// the /api/swarm routes honour, mirrored here so the Swarm tab actually
// appears. It never touches `eligible` (the experiments toggle UI stays
// owner-only) nor any other experiment (`sandbox` / `persona` keep requiring
// the owner).

import { getCustomTabRole } from './roles'
import { isSwarmLocalOwnerUnlocked } from './swarmGate'
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
  opts?: { swarmLocalOwner?: boolean },
): ExperimentsResponse => {
  const eligible = role === 'owner'
  return {
    eligible,
    flags: {
      swarm:
        (eligible && settings.experiments?.swarm === true) ||
        opts?.swarmLocalOwner === true,
      sandbox: eligible && settings.experiments?.sandbox === true,
      // The Persona tab reads the owner's PERSONAL corpus, so it takes the
      // strict gate only — the swarm local unlock (a control-plane convenience
      // for login-disabled machines) deliberately does NOT reach it.
      persona: eligible && settings.experiments?.persona === true,
    },
  }
}

// Resolve the caller's experiment gate from the live session role + settings
// (+ the server-local swarm unlock).
export const resolveExperiments = async (): Promise<ExperimentsResponse> =>
  computeExperiments(await getCustomTabRole(), await getSettings(), {
    swarmLocalOwner: await isSwarmLocalOwnerUnlocked(),
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
  // (swarmGate.ts) opens it without a login or the toggle — otherwise a future
  // caller here would see the flag closed while the UI shows the tab.
  if (id === 'swarm' && (await isSwarmLocalOwnerUnlocked())) return true
  const settings = await getSettings()
  if (settings.experiments?.[id] !== true) return false
  return (await getCustomTabRole()) === 'owner'
}
