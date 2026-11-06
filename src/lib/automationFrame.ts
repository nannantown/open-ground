import type { CanvasAutomationPolicy, CanvasElement, CanvasState } from './types'
import { pointInRotatedBox, resolveOpacity } from './canvasTransform'
import { groupCascadeSets } from './canvasGroup'

/** The rendered Ground project card, shared by grouping and execution policy. */
export const GROUND_PROJECT_CARD_WIDTH = 256
export const GROUND_PROJECT_CARD_HEIGHT = 140

export interface AutomationFrameMembership {
  enabled: boolean
  frameId: string | null
  projectIds: Set<string>
}

/** Unknown or malformed authority is never an implicit legacy opt-out. */
export const isCanvasAutomationPolicy = (value: unknown): value is CanvasAutomationPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  if (!Number.isSafeInteger(policy.revision) || Number(policy.revision) < 0) return false
  if (policy.version === 1) return typeof policy.enabled === 'boolean' &&
    (policy.frameId === null || typeof policy.frameId === 'string') && policy.frameIds === undefined
  return policy.version === 2 && policy.enabled === true && Array.isArray(policy.frameIds) &&
    policy.frameIds.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(policy.frameIds).size === policy.frameIds.length &&
    Object.keys(policy).every((key) => ['version', 'revision', 'enabled', 'frameIds'].includes(key))
}

const rolesMatchPolicy = (canvas: CanvasState): boolean => {
  if (!Array.isArray(canvas.elements)) return false
  const roles = canvas.elements.filter((element) => element.groundRole !== undefined)
  const policy = canvas.automation
  if (policy?.version === 2) return roles.length === 0
  return roles.length <= 1 && roles.every((element) => element.groundRole === 'automation' &&
    element.type === 'frame' && element.id === policy?.frameId)
}

/** Configured IDs remain ON even while a frame is hidden or deleted. Visibility
 * only affects admission; reading configuration never migrates or writes it. */
export const configuredFrameIds = (canvas: CanvasState): string[] => {
  const policy = canvas.automation
  if (!isCanvasAutomationPolicy(policy) || !rolesMatchPolicy(canvas)) return []
  return policy.version === 2 ? [...policy.frameIds] : policy.enabled && policy.frameId ? [policy.frameId] : []
}
export const isFrameAutomationOn = (canvas: CanvasState, id: string): boolean => configuredFrameIds(canvas).includes(id)

/** First explicit switch migrates the old dedicated setting. Existing ON IDs
 * survive; an ordinary new or cloned frame has a new ID and therefore is OFF. */
export function setFrameAutomation(canvas: CanvasState, id: string, on: boolean): CanvasState {
  if (!id || !Array.isArray(canvas.elements) || canvas.automation !== undefined && !isCanvasAutomationPolicy(canvas.automation) || !rolesMatchPolicy(canvas)) return canvas
  const targets = canvas.elements.filter((element) => element.id === id)
  if (on && (targets.length !== 1 || targets[0].type !== 'frame')) return canvas
  const previous = configuredFrameIds(canvas)
  if (canvas.automation?.version === 2 && previous.includes(id) === on) return canvas
  const frameIds = on ? Array.from(new Set([...previous, id])).sort() : previous.filter((key) => key !== id).sort()
  return { ...canvas,
    automation: { version: 2, revision: canvas.automation?.revision ?? 0, enabled: true, frameIds },
    elements: canvas.elements.map((element) => {
      if (element.groundRole === undefined) return element
      const { groundRole: _role, ...ordinary } = element
      return ordinary
    }),
  }
}

/** Only visible, finite, uniquely identified ON frames grant admission. A bad
 * or deleted frame grants nothing without disabling a different valid frame. */
export function automationFrames(canvas: CanvasState): CanvasElement[] {
  const ids = new Set(configuredFrameIds(canvas))
  if (!ids.size) return []
  const hidden = groupCascadeSets(canvas.elements).hiddenViaGroup
  return canvas.elements.filter((frame) => {
    if (!ids.has(frame.id) || frame.type !== 'frame' || canvas.automation?.version === 1 && frame.groundRole !== 'automation' || frame.hidden || resolveOpacity(frame) === 0 || hidden.has(frame.id) ||
        canvas.elements.filter((element) => element.id === frame.id).length !== 1) return false
    const bounds = [frame.x, frame.y, frame.width ?? 400, frame.height ?? 280, frame.rotation ?? 0]
    return bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0
  })
}
/** Backward-compatible singleton diagnostic, never an arbitrary multi-frame pick. */
export function automationFrame(canvas: CanvasState): CanvasElement | undefined {
  const frames = automationFrames(canvas)
  return frames.length === 1 ? frames[0] : undefined
}

/** Card-centre membership is the union of visible ON frame regions. Nested or
 * overlapping frames neither subtract projects nor start a second project. */
export function automationFrameMembership(canvas: CanvasState, projectIds: Iterable<string>): AutomationFrameMembership {
  const policy = canvas.automation
  const enabled = policy === undefined ? !rolesMatchPolicy(canvas) :
    !isCanvasAutomationPolicy(policy) || !rolesMatchPolicy(canvas) || policy.version === 2 || policy.enabled
  const frames = automationFrames(canvas)
  const result: AutomationFrameMembership = { enabled, frameId: frames.length === 1 ? frames[0].id : null, projectIds: new Set() }
  if (!enabled || !frames.length || !canvas.positions || typeof canvas.positions !== 'object') return result
  for (const id of Array.from(projectIds)) {
    const position = canvas.positions[id]
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue
    const point = { x: position.x + GROUND_PROJECT_CARD_WIDTH / 2, y: position.y + GROUND_PROJECT_CARD_HEIGHT / 2 }
    if (frames.some((frame) => pointInRotatedBox({ x: frame.x, y: frame.y, w: frame.width ?? 400, h: frame.height ?? 280 }, frame.rotation ?? 0, point))) result.projectIds.add(id)
  }
  return result
}

export const isAutomationAllowed = (canvas: CanvasState, projectId: string): boolean => {
  const membership = automationFrameMembership(canvas, [projectId])
  return !membership.enabled || membership.projectIds.has(projectId)
}

/** Creation is an explicit opt-in. Start empty, to the right of existing cards
 *  and drawings, so enabling the policy never silently admits an old project. */
export function createAutomationFrame(canvas: CanvasState, id: string, label: string): CanvasState {
  if (canvas.automation?.version === 2 || automationFrame(canvas)) return canvas
  const rightEdges = [0,
    ...Object.values(canvas.positions).map((position) => position.x + GROUND_PROJECT_CARD_WIDTH),
    ...canvas.elements.map((element) => element.x + (element.width ?? 400)),
  ].filter(Number.isFinite)
  const frame: CanvasElement = {
    id, type: 'frame', groundRole: 'automation', text: label,
    x: Math.max(...rightEdges) + 80, y: 80, width: 680, height: 440,
  }
  return {
    ...canvas,
    automation: { version: 1, revision: canvas.automation?.revision ?? 0, enabled: true, frameId: id },
    elements: [...canvas.elements.map((element) => {
      if (!element.groundRole) return element
      const { groundRole: _role, ...ordinary } = element
      return ordinary
    }), frame],
  }
}
