import { z } from 'zod'
import { runtimeAdmissionBlocked, getRuntimeTransition } from './runtimeTransitionStore'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, markConversationReceiptHeard, listConversationReceipts, readConversationReceipt, publicConversationReceipt, readConversationContext, rotateConversationContext, type ConversationContext, type ConversationReceipt } from './conversationReceipts'
import { projectUUIDFromPath } from './projectDataPath'
import { listLiveSupplyDesks } from './swarmSupplyRuntime'
import { pushSdkInput } from './sdkSession'
import { ownerSayLine, ownerSayTooLong, queueSupplyOwnerSay, cancelSupplyOwnerSay } from './supplyNotice'
import { clearAcceptedConversationDraft } from './conversationDrafts'
import { getSettings } from './store'
import { getChatGptAccountKey } from './chatgptAuth'
import { onConversationReceipt } from './conversationReceipts'

const bodySchema = z.object({ kind: z.literal('president-input'), path: z.string().min(1).max(4096), text: z.string().min(1).max(32768), draftClientId: z.string().max(128).optional(), draftRevision: z.number().int().nonnegative().optional() }).strict()
export interface PresidentInputOptions extends Partial<ConversationContext> { id: string; draftClientId?: string; draftRevision?: number; expectedOwnerKey?: string }
const scheduled = new Set<string>()
const nativeQueued = new Map<string, { path: string; onDone: (heard: boolean) => void; phase: 'waiting' | 'preparing' | 'released' }>()
const nativeRunning = new Map<string, string>()
const nativeProofs = new Map<string, Promise<unknown>>()
const nativeControllers = new Map<string, AbortController>()
interface NativeFinal { lane: string; scope: string; id: string; owner: string; state: 'delivered' | 'uncertain' | 'cancelled' | 'rejected'; result?: unknown }
const nativeFinals = new Map<string, NativeFinal>()
/** A known result awaiting fsync must retry its journal write, never its input. */
export const presidentInputHasKnownFinal = (receipt: ConversationReceipt): boolean => nativeFinals.has(`${receipt.owner}:${receipt.scope}:${receipt.id}`)
const persistNativeFinal = async (key: string, final: NativeFinal): Promise<void> => {
  nativeFinals.set(key, final)
  await finishConversationReceipt(final.scope, final.id, final.state, final.result, final.owner)
  nativeFinals.delete(key); scheduled.delete(key); nativeRunning.delete(final.lane)
}
/** Accepted means the Mac durably owns the line, not that a model has executed it. */
export const acceptPresidentInput = async (projectPath: string, text: string, options: PresidentInputOptions) => {
  const scope = await projectUUIDFromPath(projectPath)
  if (!text.trim() || text.length > 32768) throw new Error('Invalid message.')
  const transition = getRuntimeTransition('swarm')
  const provider = transition?.desired.provider ?? (await getSettings()).swarmProvider ?? 'claude'
  const accountKey = provider === 'chatgpt' ? await getChatGptAccountKey().catch((error) => { if (transition && transition.phase !== 'stable') return undefined; throw error }) : undefined
  const receipt = await acceptConversationReceipt(scope, options.id, bodySchema.parse({ kind: 'president-input', path: projectPath, text, draftClientId: options.draftClientId, draftRevision: options.draftRevision }), options, options.expectedOwnerKey, { provider, ...(accountKey ? { accountKey } : {}) })
  let draft
  if (options.draftClientId !== undefined && options.draftRevision !== undefined) draft = await clearAcceptedConversationDraft(scope, options.draftClientId, options.draftRevision, receipt.owner).catch(() => undefined)
  void flushPresidentInbox().catch(() => {})
  return { queued: true, delivered: receipt.state === 'delivered', receipt: publicConversationReceipt(receipt), ...(draft ? { draft } : {}) }
}

/** Only unconsumed receipts can be delivered. A crash after consumption is held. */
export const flushPresidentInbox = async (): Promise<void> => {
  // Retrying a saved result never replays its command. If fsync is still
  // unavailable the original native lane remains held.
  for (const [key, final] of Array.from(nativeFinals.entries())) await persistNativeFinal(key, final).catch(() => {})
  if (runtimeAdmissionBlocked('swarm')) return
  const receipts = await listConversationReceipts()
  for (const receipt of receipts) {
    if (runtimeAdmissionBlocked('swarm')) return
    const parsed = bodySchema.safeParse(receipt.body)
    if (!parsed.success || receipt.state !== 'queued') continue
    if (receipts.some((other) => other.scope === receipt.scope && other.state === 'uncertain' && bodySchema.safeParse(other.body).success)) continue
    const { path, text } = parsed.data
    // Resolve the registered path afresh before every effect.
    if (await projectUUIDFromPath(path).catch(() => null) !== receipt.scope) continue
    const key = `${receipt.owner}:${receipt.scope}:${receipt.id}`
    if (scheduled.has(key)) continue
    const desk = listLiveSupplyDesks(path).find((d) => !d.stopping)
    if (!desk?.agentSessionId) continue
    if (desk.agentSessionId.startsWith('chatgpt-') && receipt.acceptedRuntime?.provider === 'chatgpt' && receipt.acceptedRuntime.accountKey && receipt.acceptedRuntime.accountKey !== await getChatGptAccountKey()) {
      await finishConversationReceipt(receipt.scope, receipt.id, 'uncertain', { reason: 'account-changed', automaticReplay: false }, receipt.owner)
      continue
    }
    const execution: NonNullable<ConversationReceipt['execution']> = { sessionId: desk.agentSessionId, handleId: desk.handleId, runtime: desk.runtime }
    scheduled.add(key)
    if (desk.runtime === 'sdk') {
      const queued = pushSdkInput(desk.handleId, text, {
        operationId: receipt.id,
        onConsumed: () => claimConversationReceipt(receipt.scope, receipt.id, execution, receipt.owner),
        onReleased: async () => { scheduled.delete(key) },
        onSettled: async () => {
          await finishConversationReceipt(receipt.scope, receipt.id, 'delivered', undefined, receipt.owner)
          scheduled.delete(key)
        },
        onInterrupted: async (safeToContinue) => {
          await finishConversationReceipt(receipt.scope, receipt.id, safeToContinue ? 'cancelled' : 'uncertain', undefined, receipt.owner)
          scheduled.delete(key)
        },
        onRefused: async () => {
          await finishConversationReceipt(receipt.scope, receipt.id, 'rejected', { reason: 'usage-limit', fulfilled: false }, receipt.owner)
          scheduled.delete(key)
        },
      })
      if (!queued) scheduled.delete(key)
    } else {
      const lane = `${receipt.owner}:${receipt.scope}`
      if (nativeRunning.has(lane) || receipts.some((other) => other.scope === receipt.scope && other.state === 'executing' && other.execution?.runtime === 'pty')) { scheduled.delete(key); continue }
      if (ownerSayTooLong(text)) { await finishConversationReceipt(receipt.scope, receipt.id, 'rejected', { reason: 'too-long' }, receipt.owner); scheduled.delete(key); continue }
      try {
        const { nativePresidentTranscriptOffset, waitForNativePresidentTurnSettled } = await import('./swarmRuntimeTransition')
        const onDone = (heard: boolean) => {
          nativeQueued.delete(key)
          const controller = new AbortController()
          nativeControllers.set(key, controller)
          const proof = (async () => {
            if (!heard || execution.nativeOffset === undefined) throw new Error('Native submission has an unconfirmed result.')
            await markConversationReceiptHeard(receipt.scope, receipt.id, receipt.owner)
            const settled = await waitForNativePresidentTurnSettled({ desk, sentText: text, transcriptOffsetBeforeSend: execution.nativeOffset, signal: controller.signal })
            const refused = (settled as { refused?: boolean }).refused === true
            await persistNativeFinal(key, { lane, scope: receipt.scope, id: receipt.id, owner: receipt.owner, state: refused ? 'rejected' : 'delivered', result: { heard: true, settled: true, ...(refused ? { reason: 'usage-limit', fulfilled: false } : {}), ...settled } })
          })().catch(async () => {
            if (!nativeFinals.has(key)) await persistNativeFinal(key, { lane, scope: receipt.scope, id: receipt.id, owner: receipt.owner, state: 'uncertain' })
          }).finally(() => { nativeProofs.delete(key); nativeControllers.delete(key) })
          nativeProofs.set(key, proof)
          void proof.catch(() => {})
        }
        nativeQueued.set(key, { path, onDone, phase: 'waiting' })
        await queueSupplyOwnerSay(path, ownerSayLine(text), onDone, {}, { beforeSend: async () => {
          const queued = nativeQueued.get(key)
          if (!queued) throw new Error('The native input was cancelled.')
          queued.phase = 'preparing'
          if (runtimeAdmissionBlocked('swarm') || nativeRunning.has(lane)) throw new Error('The native conversation is draining or already answering.')
          const currentReceipts = await listConversationReceipts(receipt.owner)
          if (currentReceipts.some((other) => other.scope === receipt.scope && other.id !== receipt.id && (other.state === 'uncertain' || other.state === 'executing' && other.execution?.runtime === 'pty'))) throw new Error('A previous native instruction still has an unconfirmed result.')
          execution.nativeOffset = await nativePresidentTranscriptOffset(desk)
          if (runtimeAdmissionBlocked('swarm')) throw new Error('The native conversation is draining.')
          if (!await claimConversationReceipt(receipt.scope, receipt.id, execution, receipt.owner)) throw new Error('This message is no longer eligible for execution.')
          nativeRunning.set(lane, receipt.id)
          queued.phase = 'released'
        } })
      } catch {
        const latest = await readConversationReceipt(receipt.scope, receipt.id, receipt.owner)
        const queued = nativeQueued.get(key)
        if (queued) { cancelSupplyOwnerSay(queued.path, queued.onDone); nativeQueued.delete(key) }
        if (latest?.state === 'executing') await persistNativeFinal(key, { lane, scope: receipt.scope, id: receipt.id, owner: receipt.owner, state: 'uncertain' }).catch(() => {})
        else { scheduled.delete(key); nativeRunning.delete(lane) }
      }
    }
  }
}

/** A retired SDK queue contains no consumed message. Durable inbox owns re-entry. */
export const releaseRetiredPresidentInputs = (): void => {
  for (const { path, onDone } of Array.from(nativeQueued.values())) cancelSupplyOwnerSay(path, onDone)
  nativeQueued.clear(); scheduled.clear()
}
export const awaitPresidentInputSettlement = async (): Promise<void> => {
  await Promise.all(Array.from(nativeProofs.values()))
  const unsettled = (await listConversationReceipts()).some((receipt) => bodySchema.safeParse(receipt.body).success && (receipt.state === 'executing' || receipt.state === 'uncertain'))
  if (unsettled) throw new Error('A president instruction has an unconfirmed result. Inspect it before handing off or resuming automatic work.')
}
/** Cancellation is proven only before the beforeSend hook has returned. Heard
 * false alone is insufficient: paste/Enter may already be in flight. */
export const cancelUnsubmittedPresidentInput = async (projectPath: string, id: string): Promise<boolean> => {
  const scope = await projectUUIDFromPath(projectPath)
  const receipt = await readConversationReceipt(scope, id)
  if (!receipt || !['queued', 'executing'].includes(receipt.state)) return false
  const key = `${receipt.owner}:${scope}:${id}`
  const queued = nativeQueued.get(key)
  if (!queued || queued.phase === 'released' || !cancelSupplyOwnerSay(queued.path, queued.onDone)) return false
  nativeQueued.delete(key)
  await persistNativeFinal(key, { lane: `${receipt.owner}:${scope}`, scope, id, owner: receipt.owner, state: 'cancelled', result: { notSubmitted: true } })
  return true
}
export const cancelQueuedPresidentInputs = async (projectPath: string): Promise<ConversationContext> => {
  const scope = await projectUUIDFromPath(projectPath)
  const context = await rotateConversationContext(scope, await readConversationContext(scope))
  for (const [key, queued] of Array.from(nativeQueued.entries())) if (key.split(':')[1] === scope) { cancelSupplyOwnerSay(queued.path, queued.onDone); nativeQueued.delete(key) }
  for (const key of Array.from(scheduled)) if (key.split(':')[1] === scope) scheduled.delete(key)
  return context
}
export const presidentInputReceipt = async (scope: string, id: string, expectedOwnerKey?: string) => {
  const receipt = await readConversationReceipt(scope, id, expectedOwnerKey)
  return receipt ? publicConversationReceipt(receipt) : null
}
onConversationReceipt((receipt) => {
  if (receipt.state === 'cancelled' || receipt.state === 'rejected') nativeControllers.get(`${receipt.owner}:${receipt.scope}:${receipt.id}`)?.abort()
})
