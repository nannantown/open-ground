import { describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openGroundHome } from './paths'
import { sessionJsonlPath } from './transcript'
import { assertSwarmNativeConversationSettled, readSwarmNativePublicConversation } from './swarmNativeTranscript'
const line = (type: string, content: unknown) => JSON.stringify({ type, message: { content } }) + '\n'
const fixture = async (source: string) => {
  await mkdir(openGroundHome(), { recursive: true })
  const cwd = await mkdtemp(join(openGroundHome(), 'native-history-proof-')), id = randomUUID()
  const file = sessionJsonlPath(cwd, id)
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, source)
  return { cwd, id, file }
}
describe('saved native conversation action proof', () => {
  it('rejects an unfinished tool even when the session head is valid and public prose exists', async () => {
    const f = await fixture(line('user', 'saved goal') + line('assistant', [{ type: 'text', text: 'Started.' }, { type: 'tool_use', id: 'unfinished', input: { command: 'never executed by this test' } }]))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).rejects.toThrow('unfinished tool receipts')
    await appendFile(f.file, line('user', [{ type: 'tool_result', tool_use_id: 'unfinished', content: 'failed, confirmed', is_error: true }]))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).resolves.toBeUndefined()
  })
  it('shares public words without hidden reasoning, tool arguments, or tool output', async () => {
    const f = await fixture(line('user', 'owner words') + line('assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'tool_use', id: 'done', input: { secret: 'private arguments' } }])
      + line('user', [{ type: 'tool_result', tool_use_id: 'done', content: 'private tool output' }]) + line('assistant', [{ type: 'text', text: 'Public answer' }]))
    expect(await readSwarmNativePublicConversation(f.cwd, f.id)).toEqual([{ kind: 'input', text: 'owner words' }, { kind: 'text', text: 'Public answer' }])
  })
  it('does not require a handoff summary merely to verify receipts before a same-provider resume', async () => {
    const f = await fixture(line('user', 'x'.repeat(256 * 1024)))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).resolves.toBeUndefined()
    await expect(readSwarmNativePublicConversation(f.cwd, f.id)).rejects.toThrow('approved summary')
  })
})
