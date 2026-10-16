// Owner experiments and licensed macOS Swarm consent. The server is authoritative.
import { getCustomTabRole } from './roles'
import { isSwarmLocalOwnerUnlocked, isSwarmOptInAvailable, isSwarmOptInEnabled, hasSwarmOwnerAccess } from './swarmGate'
import { getSettings } from './store'
import { getBillingState } from './billing'
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
// unlock) contributes only for an actual Owner. Pro uses the licensed opt-in.
export const computeExperiments = (
  role: CustomTabRole,
  settings: Pick<Settings, 'experiments'>,
  opts?: {
    swarmLocalOwner?: boolean
    /** The resolved licensed opt-in (macOS && paid && Settings.swarmOptIn) — opens swarm
     *  for a non-owner. See swarmGate.isSwarmOptInEnabled. */
    swarmOptInEnabled?: boolean
    /** Whether this machine can offer the opt-in at all (macOS) — drives the
     *  Settings toggle's visibility, NOT the gate. */
    swarmOptInAvailable?: boolean
  },
): ExperimentsResponse => {
  const eligible = role === 'owner'
  return {
    eligible,
    flags: {
      swarm:
        (eligible && settings.experiments?.swarm === true) ||
        (eligible && opts?.swarmLocalOwner === true) ||
        opts?.swarmOptInEnabled === true,
      sandbox: eligible && settings.experiments?.sandbox === true,
    },
    // The public opt-ins are reported separately from `flags` so a non-owner can
    // see + drive the Settings toggles without `eligible` (which stays owner-only
    // and would reveal sandbox). `enabled` mirrors the resolved gate.
    swarmOptIn: {
      available: opts?.swarmOptInAvailable === true,
      enabled: opts?.swarmOptInEnabled === true,
    },
  }
}

// Resolve the caller's experiment gate from the live session role + settings
// (+ the server-local swarm unlock + the public macOS opt-in).
export const resolveExperiments = async (): Promise<ExperimentsResponse> =>
  computeExperiments(await getCustomTabRole(), await getSettings(), {
    swarmLocalOwner: await isSwarmLocalOwnerUnlocked(),
    swarmOptInEnabled: await isSwarmOptInEnabled(),
    swarmOptInAvailable: isSwarmOptInAvailable() && (await getBillingState()).plan !== 'free',
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
  // AND the licensed macOS opt-in (swarmGate.ts) retain the consent requirement — otherwise a hot launch path would see the flag closed while
  // the UI shows the tab.
  if (id === 'swarm') return await hasSwarmOwnerAccess() && ((await isSwarmLocalOwnerUnlocked()) || (await isSwarmOptInEnabled()) || (await getSettings()).experiments?.swarm === true)
  const settings = await getSettings()
  if (settings.experiments?.[id] !== true) return false
  return (await getCustomTabRole()) === 'owner'
}
