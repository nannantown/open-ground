import { readFile, stat } from 'node:fs/promises'
import { sessionJsonlPath } from './transcript'
import { createHash } from 'node:crypto'

export class NativeUnfinishedToolsError extends Error {
  constructor() { super('The native conversation has unfinished tool receipts. Inspect its actual work before resuming, or explicitly start a new conversation.'); this.name = 'NativeUnfinishedToolsError' }
}

/** Native history is evidence, not a command to replay. Inspect every receipt,
 * not merely its first parseable line, before resuming a saved conversation. */
const inspect = async (cwd: string, sessionId: string, collectPublic: boolean) => {
  const file = sessionJsonlPath(cwd, sessionId)
  const before = await stat(file)
  if (before.size > 32 * 1024 * 1024) throw new Error('The native conversation exceeds its safe inspection limit.')
  const bytes = await readFile(file), source = bytes.toString('utf8'), after = await stat(file)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('The native conversation changed during inspection.')
  const pending = new Map<string, string>(), completed = new Set<string>()
  if (!Buffer.from(source).equals(bytes)) pending.set('unknown-native-encoding', 'Unconfirmed native record')
  const text: { kind: 'input' | 'text'; text: string }[] = []
  let index = 0
  for (const line of source.split('\n').filter(Boolean)) {
    index++
    let item: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native record')
      item = parsed
    } catch { pending.set(`unknown-native-record-${index}`, 'Unconfirmed native record'); continue }
    if (item.isMeta || item.isCompactSummary || item.type !== 'user' && item.type !== 'assistant') continue
    const content = item.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content as { type?: string; text?: string; id?: string; name?: string; tool_use_id?: string }[] : []
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && !completed.has(block.id)) pending.set(block.id, block.name ?? 'tool')
      if (block.type === 'tool_result' && block.tool_use_id) { pending.delete(block.tool_use_id); completed.add(block.tool_use_id) }
      if (collectPublic && block.type === 'text' && typeof block.text === 'string') text.push({ kind: item.type === 'user' ? 'input' : 'text', text: block.text })
    }
  }
  return { publicLines: text, fingerprint: createHash('sha256').update(bytes).digest('hex'), unfinishedTools: Array.from(pending, ([id, name]) => ({ id, name: name.slice(0, 128) })) }
}

export const inspectSwarmNativeConversation = async (cwd: string, sessionId: string): Promise<{ fingerprint: string; unfinishedTools: { id: string; name: string }[] }> => {
  const { fingerprint, unfinishedTools } = await inspect(cwd, sessionId, false)
  return { fingerprint, unfinishedTools }
}
export const readSwarmNativePublicConversation = async (cwd: string, sessionId: string, collectPublic = true): Promise<{ kind: 'input' | 'text'; text: string }[]> => {
  const result = await inspect(cwd, sessionId, collectPublic)
  if (result.unfinishedTools.length) throw new NativeUnfinishedToolsError()
  if (Buffer.byteLength(JSON.stringify(result.publicLines)) > 256 * 1024) throw new Error('The public native conversation needs an approved summary before handoff.')
  return result.publicLines
}

export const assertSwarmNativeConversationSettled = async (cwd: string, sessionId: string): Promise<void> => {
  await readSwarmNativePublicConversation(cwd, sessionId, false)
}
