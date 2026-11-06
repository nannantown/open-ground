import { automationFrameMembership } from '../automationFrame'
import { canonicalize } from './canonicalize'
import { getCanvasWithHealth, getSettings } from './store'
import { hasChatGptAccess } from './chatgptAccess'

export interface ProjectAutomationPolicy {
  enabled: boolean
  allowed: boolean
  healthy: boolean
  frameId: string | null
}
export class AutomationPolicyError extends Error {
  constructor(message = 'This project is outside the automatic-operation frame. New automatic work is paused; accepted work and manual conversation are preserved.', readonly code = 'automation-frame-off') {
    super(message)
    this.name = 'AutomationPolicyError'
  }
}

/** Always read persisted authority again after awaits. Neither a cached UI
 * position nor an old engine intent grants admission to a new operation. */
export const readProjectAutomationPolicy = async (projectPath: string): Promise<ProjectAutomationPolicy> => {
  const closed: ProjectAutomationPolicy = { enabled: true, allowed: false, healthy: false, frameId: null }
  try {
    const { value, health } = await getCanvasWithHealth()
    if (health === 'unreadable') return closed
    if (!value || !Array.isArray(value.elements) || !value.positions || typeof value.positions !== 'object' || Array.isArray(value.positions)) return closed
    if (!automationFrameMembership(value, []).enabled) return { enabled: false, allowed: true, healthy: true, frameId: null }
    const projects = (await getSettings()).projects ?? []
    const path = await canonicalize(projectPath)
    const matches = []
    for (const project of projects) if (await canonicalize(project.path) === path) matches.push(project)
    // Identity resolution can yield to a saved OFF toggle. Read authority last,
    // with no settings/path awaits between this snapshot and its decision.
    const latest = await getCanvasWithHealth()
    if (latest.health === 'unreadable' || !latest.value || !Array.isArray(latest.value.elements) ||
        !latest.value.positions || typeof latest.value.positions !== 'object' || Array.isArray(latest.value.positions)) return closed
    const membership = automationFrameMembership(latest.value, projects.map((project) => project.id))
    if (!membership.enabled) return { enabled: false, allowed: true, healthy: true, frameId: null }
    return { enabled: true, allowed: matches.length === 1 && membership.projectIds.has(matches[0].id), healthy: true, frameId: membership.frameId }
  } catch { return closed }
}

export const automaticOperationAllowed = async (projectPath: string): Promise<boolean> => {
  const policy = await readProjectAutomationPolicy(projectPath)
  if (!policy.allowed) return false
  if (!policy.enabled) return true // legacy grants never acquire an owner requirement
  if (!await hasChatGptAccess()) return false
  // Auth IO may also yield to a durable move/toggle OFF. Never return its older
  // allowed snapshot to a launch leaf after the capability check settles.
  return (await readProjectAutomationPolicy(projectPath)).allowed
}

export const assertAutomaticOperationAllowed = async (projectPath: string): Promise<void> => {
  if (!await automaticOperationAllowed(projectPath)) throw new AutomationPolicyError()
}

export interface AutomationReconciliation {
  started: string[]
  paused: string[]
  failures: { path: string; reason: string }[]
}
let reconciliation: Promise<unknown> = Promise.resolve()
/** Canvas durability precedes this projection. A failed launch does not undo
 * membership; the caller reports the failure and a later reconciliation retries. */
export const reconcileAutomationPolicy = (): Promise<AutomationReconciliation> => {
  const next = reconciliation.then(async () => (await import('./swarmOrchestrator')).reconcileAutomationOrchestrators())
  reconciliation = next.catch(() => {})
  return next
}

let policyTimer: ReturnType<typeof setInterval> | undefined
let loopInFlight = false
/** Started only by the normal background/recovery lifecycle, never by a GET
 * or a mounted UI. Unconfigured legacy Ground cannot start work from this loop. */
export const startAutomationPolicyLoop = (intervalMs = 15_000): void => {
  if (policyTimer) return
  const tick = async () => {
    if (loopInFlight) return
    loopInFlight = true
    try {
      const { value, health } = await getCanvasWithHealth()
      if (health === 'unreadable' || automationFrameMembership(value, []).enabled) await reconcileAutomationPolicy()
    } catch { /* persisted policy remains authoritative; the next tick retries */ }
    finally { loopInFlight = false }
  }
  policyTimer = setInterval(() => { void tick() }, Math.max(1000, intervalMs))
  policyTimer.unref?.()
  void tick()
}
export const stopAutomationPolicyLoop = (): void => {
  clearInterval(policyTimer)
  policyTimer = undefined
}
