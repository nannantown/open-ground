import type { CanvasState } from '../types'
import { automationFrame, automationFrameMembership } from '../automationFrame'
import { mutateCanvas } from './store'
import { runtimeRequestOwnerKey, runtimeOwnerKey } from './runtimeOwner'

export class GroundCanvasError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, message: string) { super(message) }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Validate the Ground envelope before using any geometry as execution consent. */
function validate(value: unknown): asserts value is CanvasState {
  if (!object(value) || !object(value.positions) || !object(value.viewport) || !Array.isArray(value.elements)) {
    throw new GroundCanvasError(400, 'Invalid Ground canvas.')
  }
  if (![value.viewport.x, value.viewport.y, value.viewport.zoom].every(finite) || !finite(value.viewport.zoom) || value.viewport.zoom <= 0) {
    throw new GroundCanvasError(400, 'Invalid Ground viewport.')
  }
  for (const position of Object.values(value.positions)) {
    if (!object(position) || !finite(position.x) || !finite(position.y)) throw new GroundCanvasError(400, 'Invalid project position.')
  }
  const ids = new Set<string>()
  for (const element of value.elements) {
    if (!object(element) || typeof element.id !== 'string' || ids.has(element.id) ||
        typeof element.type !== 'string' || !finite(element.x) || !finite(element.y)) {
      throw new GroundCanvasError(400, 'Invalid Ground element.')
    }
    ids.add(element.id)
    if (element.groundRole !== undefined && (element.groundRole !== 'automation' || element.type !== 'frame')) {
      throw new GroundCanvasError(400, 'Invalid automation frame role.')
    }
  }
  if (value.automation !== undefined) {
    const policy = value.automation
    if (!object(policy) || policy.version !== 1 || typeof policy.enabled !== 'boolean' ||
        !Number.isSafeInteger(policy.revision) || Number(policy.revision) < 0 ||
        !(policy.frameId === null || typeof policy.frameId === 'string')) {
      throw new GroundCanvasError(400, 'Invalid automation policy.')
    }
    const frames = value.elements.filter((element) => element.groundRole === 'automation')
    if (frames.length > 1 || (frames.length === 1 && frames[0].id !== policy.frameId)) {
      throw new GroundCanvasError(400, 'Automation requires one designated frame.')
    }
    const designated = value.elements.find((element) => element.id === policy.frameId)
    if (designated && (designated.groundRole !== 'automation' || designated.type !== 'frame' ||
        designated.rotation !== undefined && !finite(designated.rotation) ||
        !finite(designated.width ?? 400) || !finite(designated.height ?? 280) ||
        (designated.width ?? 400) <= 0 || (designated.height ?? 280) <= 0)) {
      throw new GroundCanvasError(400, 'Invalid designated automation frame.')
    }
  } else if (value.elements.some((element) => element.groundRole !== undefined)) {
    throw new GroundCanvasError(400, 'An automation frame requires its policy.')
  }
}

/** Include designated geometry, not just today's membership: a stale canvas
 *  must not relocate the region and change admission for a later registration. */
const authority = (canvas: CanvasState): string => {
  const policy = canvas.automation
  if (!policy) return 'legacy'
  const { revision: _revision, ...configuration } = policy
  const roles = canvas.elements.filter((element) => element.groundRole === 'automation')
    .map(({ id, type, x, y, width, height, rotation, hidden, opacity, groundRole }) => ({ id, type, x, y, width, height, rotation, hidden, opacity, groundRole }))
  const members = Array.from(automationFrameMembership(canvas, Object.keys(canvas.positions)).projectIds).sort()
  return JSON.stringify({ configuration, roles, members, visibleFrameId: automationFrame(canvas)?.id ?? null })
}

/** Serialize read/CAS/owner recheck/durable write. An omitted policy in an old
 *  client's snapshot can never implicitly disable the persisted authority. */
export function saveGroundCanvas(body: unknown, claimedOwnerId?: string): Promise<CanvasState> {
  return mutateCanvas(async (current) => {
    try { validate(current) }
    catch { throw new GroundCanvasError(503, 'Ground canvas is invalid; restore it before saving.') }
    validate(body)
    const next: CanvasState = structuredClone(body)
    if (current.automation && !next.automation) {
      // Missing metadata is a stale client, not an explicit disable operation.
      throw new GroundCanvasError(409, 'Ground automation changed. Reload before saving.')
    }
    const changed = authority(current) !== authority(next)
    let owner: string | undefined
    if (changed) {
      try { owner = await runtimeRequestOwnerKey(claimedOwnerId) }
      catch { throw new GroundCanvasError(403, 'Owner sign-in is required to change automatic operation.') }
      if ((next.automation?.revision ?? 0) !== (current.automation?.revision ?? 0)) {
        throw new GroundCanvasError(409, 'Ground automation changed. Reload before saving.')
      }
    }
    // Ignore a client supplied revision for an unrelated viewport/label edit.
    if (next.automation) next.automation.revision = (current.automation?.revision ?? 0) + (changed ? 1 : 0)
    if (owner) {
      try { await runtimeOwnerKey(owner) }
      catch { throw new GroundCanvasError(403, 'The owner account changed before the save.') }
    }
    return next
  })
}
