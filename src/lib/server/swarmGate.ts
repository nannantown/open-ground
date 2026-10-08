// Swarm requires Owner, or an active Pro subscription on a verified platform.
import { getCustomTabRole } from './roles'
import { getSettings } from './store'
import { getBillingState } from './billing'

/** The explicit local unlock: env var or a hand-edited settings.json flag.
 *  Both are server-local; no request value can reach either. */
export const isSwarmLocalOwnerUnlocked = async (): Promise<boolean> => {
  if (process.env.OPENGROUND_LOCAL_OWNER === '1') return true
  return (await getSettings()).swarmLocalOwner === true
}

/** macOS-gated. The deterministic PreToolUse guard (scripts/openground-guard.js)
 *  is unmeasured on Windows and there is no OS sandbox layer there, so a
 *  non-macOS opt-in never opens the gate — Windows users stay owner-only until
 *  the guard has a real-Windows verification pass. Injectable platform for tests. */
export const isSwarmOptInAvailable = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'darwin'

/** The setting is consent, never proof of a paid subscription. */
export const isSwarmOptInEnabled = async (): Promise<boolean> =>
  isSwarmOptInAvailable() && (await getSettings()).swarmOptIn === true &&
  (await getBillingState()).plan !== 'free'

/** Kept under the existing name so every control-plane caller uses one gate. */
export const hasSwarmOwnerAccess = async (): Promise<boolean> =>
  (await getCustomTabRole()) === 'owner' ||
  (isSwarmOptInAvailable() && (await getBillingState()).plan === 'pro')
