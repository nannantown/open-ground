import type { CanvasElement, CanvasState } from './types'
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

const validPolicy = (policy: CanvasState['automation']): boolean => !!policy &&
  policy.version === 1 && Number.isSafeInteger(policy.revision) && policy.revision >= 0 &&
  typeof policy.enabled === 'boolean' && (policy.frameId === null || typeof policy.frameId === 'string')

export function automationFrame(canvas: CanvasState): CanvasElement | undefined {
  const policy = canvas.automation
  if (!validPolicy(policy) || !policy?.enabled || !policy.frameId || !Array.isArray(canvas.elements)) return
  const roles = canvas.elements.filter((element) => element.groundRole !== undefined)
  if (roles.length !== 1) return
  const frame = roles[0]
  if (frame.groundRole !== 'automation' || frame.id !== policy.frameId ||
      canvas.elements.filter((element) => element.id === frame.id).length !== 1 || frame.type !== 'frame' || frame.hidden || resolveOpacity(frame) === 0 ||
      groupCascadeSets(canvas.elements).hiddenViaGroup.has(frame.id)) return
  const bounds = [frame.x, frame.y, frame.width ?? 400, frame.height ?? 280, frame.rotation ?? 0]
  if (!bounds.every(Number.isFinite) || bounds[2] <= 0 || bounds[3] <= 0) return
  return frame
}

/** Nested/overlapping decorative frames do not change the dedicated region.
 *  The card centre is the same membership rule the Ground uses for grouping. */
export function automationFrameMembership(
  canvas: CanvasState,
  projectIds: Iterable<string>,
): AutomationFrameMembership {
  const policy = canvas.automation
  // Only a recognized explicit disable can restore legacy/manual control.
  const roles = Array.isArray(canvas.elements) ? canvas.elements.filter((element) => element.groundRole !== undefined) : []
  const invalidRoles = roles.length > 1 || roles.some((element) => element.groundRole !== 'automation' || element.type !== 'frame' || element.id !== policy?.frameId)
  const roleWithoutPolicy = policy === undefined && roles.length > 0
  const enabled = invalidRoles || roleWithoutPolicy || policy !== undefined && !(validPolicy(policy) && policy?.enabled === false)
  const frame = automationFrame(canvas)
  const result: AutomationFrameMembership = {
    enabled,
    frameId: frame?.id ?? null,
    projectIds: new Set(),
  }
  if (!enabled || !frame || !canvas.positions || typeof canvas.positions !== 'object') return result
  const width = frame.width ?? 400
  const height = frame.height ?? 280
  for (const id of Array.from(projectIds)) {
    const position = canvas.positions[id]
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue
    const x = position.x + GROUND_PROJECT_CARD_WIDTH / 2
    const y = position.y + GROUND_PROJECT_CARD_HEIGHT / 2
    if (pointInRotatedBox({ x: frame.x, y: frame.y, w: width, h: height }, frame.rotation ?? 0, { x, y })) {
      result.projectIds.add(id)
    }
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
  if (automationFrame(canvas)) return canvas
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
