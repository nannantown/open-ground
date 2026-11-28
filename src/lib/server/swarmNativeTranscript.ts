import { readFile, stat } from 'node:fs/promises'
import { sessionJsonlPath } from './transcript'
import { createHash } from 'node:crypto'
import { resultInterrupted } from './runtimeToolEvidence'

/** One tool call a saved conversation started without a recorded result. `at`
 *  and `description` (the call's own description input) let the owner's question
 *  and a fresh desk's opening name it (AUTONOMY-SPEC R-B3/R-B4). */
export interface UnfinishedNativeTool { id: string; name: string; at?: string; description?: string }
export class NativeUnfinishedToolsError extends Error {
  constructor(readonly tools: UnfinishedNativeTool[] = [], readonly sessionId?: string) { super('The native conversation has unfinished tool receipts. Inspect its actual work before resuming, or explicitly start a new conversation.'); this.name = 'NativeUnfinishedToolsError' }
}

/** Native history is evidence, not a command to replay. Inspect every receipt,
 * not merely its first parseable line, before resuming a saved conversation. */
const inspect = async (cwd: string, sessionId: string, collectPublic: boolean) => {
  const file = sessionJsonlPath(cwd, sessionId)
  const before = await stat(file)
  if (before.size > 32 * 1024 * 1024) throw new Error('The native conversation exceeds its safe inspection limit.')
  const bytes = await readFile(file), source = bytes.toString('utf8'), after = await stat(file)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('The native conversation changed during inspection.')
  const pending = new Map<string, string>(), completed = new Set<string>(), detail = new Map<string, { at?: string; description?: string }>()
  // A result that leaves the effect unknown (runtimeToolEvidence.resultInterrupted:
  // cut off while running, written on shutdown, the session-ended stand-in) keeps
  // its call unfinished — until the conversation itself went on past it: a later
  // turn a MODEL wrote (it already saw the interruption and acted on it, so resuming
  // hands it nothing new). Review A S5, 2026-11-28. An assistant line no model wrote
  // does not count (review R2 N-M1): the CLI's API-error lines (`isApiErrorMessage`,
  // model '<synthetic>' — "You've hit your 5-hour limit"), synthetic lines, lines
  // with no model — after them the model never received the cut result. Nor does a
  // later block of the SAME response (same message.id): the CLI records a tool result
  // while its response is still streaming, so that block was written before the model
  // saw the result; a model line with no message.id releases nothing (review R3 S1).
  const cut = new Map<string, { name: string; msgId?: string }>()
  const useMsg = new Map<string, string>()
  if (!Buffer.from(source).equals(bytes)) pending.set('unknown-native-encoding', 'Unconfirmed native record')
  const text: { kind: 'input' | 'text'; text: string }[] = []
  let index = 0
  for (const line of source.split('\n').filter(Boolean)) {
    index++
    let item: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; isSynthetic?: boolean; isApiErrorMessage?: boolean; error?: unknown; timestamp?: unknown; message?: { id?: unknown; content?: unknown; model?: unknown } }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native record')
      item = parsed
    } catch { pending.set(`unknown-native-record-${index}`, 'Unconfirmed native record'); continue }
    if (item.isMeta || item.isCompactSummary || item.type !== 'user' && item.type !== 'assistant') continue
    const msgId = typeof item.message?.id === 'string' ? item.message.id : undefined
    if (item.type === 'assistant' && msgId !== undefined && typeof item.message?.model === 'string' && item.message.model !== '<synthetic>'
      && item.isApiErrorMessage !== true && item.isSynthetic !== true && item.error === undefined) {
      for (const [id, c] of Array.from(cut)) if (c.msgId !== msgId) cut.delete(id)
    }
    const content = item.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content as { type?: string; text?: string; id?: string; name?: string; tool_use_id?: string; input?: { description?: unknown } }[] : []
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && !completed.has(block.id)) {
        pending.set(block.id, block.name ?? 'tool')
        if (msgId !== undefined) useMsg.set(block.id, msgId)
        detail.set(block.id, { ...(typeof item.timestamp === 'string' ? { at: item.timestamp } : {}),
          ...(typeof block.input?.description === 'string' && ['Bash', 'Agent', 'Task'].includes(block.name ?? '') ? { description: block.input.description.slice(0, 500) } : {}) })
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        const name = pending.get(block.tool_use_id)
        pending.delete(block.tool_use_id); completed.add(block.tool_use_id)
        if (resultInterrupted(item as Record<string, unknown>, block as Record<string, unknown>)) cut.set(block.tool_use_id, { name: name ?? 'tool', msgId: useMsg.get(block.tool_use_id) })
      }
      if (collectPublic && block.type === 'text' && typeof block.text === 'string') text.push({ kind: item.type === 'user' ? 'input' : 'text', text: block.text })
    }
  }
  cut.forEach((c, id) => pending.set(id, c.name))
  return { publicLines: text, fingerprint: createHash('sha256').update(bytes).digest('hex'), unfinishedTools: Array.from(pending, ([id, name]): UnfinishedNativeTool => ({ id, name: name.slice(0, 128), ...detail.get(id) })) }
}

export const inspectSwarmNativeConversation = async (cwd: string, sessionId: string): Promise<{ fingerprint: string; unfinishedTools: UnfinishedNativeTool[] }> => {
  const { fingerprint, unfinishedTools } = await inspect(cwd, sessionId, false)
  return { fingerprint, unfinishedTools }
}
export const readSwarmNativePublicConversation = async (cwd: string, sessionId: string, collectPublic = true): Promise<{ kind: 'input' | 'text'; text: string }[]> => {
  const result = await inspect(cwd, sessionId, collectPublic)
  if (result.unfinishedTools.length) throw new NativeUnfinishedToolsError(result.unfinishedTools, sessionId)
  if (Buffer.byteLength(JSON.stringify(result.publicLines)) > 256 * 1024) throw new Error('The public native conversation needs an approved summary before handoff.')
  return result.publicLines
}

export const assertSwarmNativeConversationSettled = async (cwd: string, sessionId: string): Promise<void> => {
  await readSwarmNativePublicConversation(cwd, sessionId, false)
}
