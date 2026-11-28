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
  // Review A S5 (2026-11-28): the resume check counted ANY tool_result as completed,
  // so a call cut off while running (the CLI's interrupted shapes, the same reading
  // runtimeToolEvidence.resultInterrupted makes) let the conversation be resumed.
  const INTERRUPTED_RESULTS: [string, string][] = [
    ['user-rejected with no toolDenialBeforeRun (cut while running)', JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use',
      message: { content: [{ type: 'tool_result', tool_use_id: 'cut', content: "The user doesn't want to proceed with this tool use.", is_error: true }] } }) + '\n'],
    ['interruptedByShutdown', JSON.stringify({ type: 'user', interruptedByShutdown: true, message: { content: [{ type: 'tool_result', tool_use_id: 'cut', content: 'partial', is_error: true }] } }) + '\n'],
    ['the session-ended stand-in', JSON.stringify({ type: 'user', toolDenialKind: 'interrupted',
      message: { content: [{ type: 'tool_result', tool_use_id: 'cut', content: "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]", is_error: true }] } }) + '\n'],
  ]
  it.each(INTERRUPTED_RESULTS)('keeps a call whose result is interrupted (%s) unfinished while nothing came after it', async (_what, result) => {
    const f = await fixture(line('assistant', [{ type: 'tool_use', id: 'cut', name: 'Bash', input: { command: 'never executed by this test' } }]) + result
      + line('user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).rejects.toThrow('unfinished tool receipts')
  })
  const cutCall = (msgId: string) => JSON.stringify({ type: 'assistant', message: { id: msgId, model: 'claude-fable-5-2', role: 'assistant',
    content: [{ type: 'tool_use', id: 'cut', name: 'Bash', input: { command: 'never executed by this test' } }] } }) + '\n'
  const modelLine = (msgId: string | undefined, text: string) => JSON.stringify({ type: 'assistant', message: { ...(msgId ? { id: msgId } : {}),
    model: 'claude-fable-5-2', role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  it('settles an interrupted call once the conversation itself went on past it (a later MODEL turn)', async () => {
    const f = await fixture(cutCall('msg_A') + INTERRUPTED_RESULTS[0][1]
      + line('user', 'what happened?')
      + modelLine('msg_B', 'The command was stopped; I checked the state.'))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).resolves.toBeUndefined()
  })
  // Review R3 S1 (2026-11-28): the CLI records a tool result while the SAME response
  // is still streaming, so a later block of that response (same message.id) was
  // written before the model saw the cut result. Only a different response counts,
  // and a model line with no message.id (never seen on disk) releases nothing.
  it('keeps the cut call unfinished when the only later model line is the same response (same message.id)', async () => {
    const f = await fixture(cutCall('msg_A') + INTERRUPTED_RESULTS[0][1] + modelLine('msg_A', 'Next, I will check the logs.'))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).rejects.toThrow('unfinished tool receipts')
  })
  it('keeps the cut call unfinished when the later model line carries no message.id', async () => {
    const f = await fixture(cutCall('msg_A') + INTERRUPTED_RESULTS[0][1] + line('user', 'what happened?') + modelLine(undefined, 'I checked the state.'))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).rejects.toThrow('unfinished tool receipts')
  })
  // Review R2 N-M1 (2026-11-28): the exception above also fired on an assistant line
  // no model wrote. The real round-1 M1 worker (CLI 2.1.329) ends exactly so: the
  // Bash cut 163 s in, the interrupt line, two task notifications, then the CLI's
  // synthetic usage-limit error — the model never received the cut result.
  it.each([
    ['the real tail: a synthetic usage-limit error (isApiErrorMessage, <synthetic>)', { isApiErrorMessage: true, error: 'rate_limit', apiError: 'usage_limit_reached', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)" }] } }],
    ['an assistant line with no model at all', { message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } }],
    ['a synthetic assistant line', { isSynthetic: true, message: { model: 'claude-fable-5-2', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } }],
    // each marker alone (the real tail carries all three)
    ['model <synthetic> alone', { message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } }],
    ['isApiErrorMessage alone', { isApiErrorMessage: true, message: { model: 'claude-fable-5-2', role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } }],
    ['an error field alone', { error: 'rate_limit', message: { model: 'claude-fable-5-2', role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } }],
  ])('keeps the cut call unfinished when the only later assistant line is %s', async (_what, after) => {
    // Every line carries its own message.id, as on disk (review R4 S1: 514 of 514
    // `<synthetic>` lines and every API-error line have one) — so these five checks,
    // not the missing-id rule, are what hold the call.
    const f = await fixture(JSON.stringify({ type: 'assistant', message: { id: 'msg_A', model: 'claude-fable-5-2', role: 'assistant',
      content: [{ type: 'tool_use', id: 'cut', name: 'Bash', input: { command: 'never executed by this test', description: 'Run full verification on current fixed page', timeout: 600000 } }] } }) + '\n'
      + INTERRUPTED_RESULTS[0][1]
      + line('user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }])
      + line('user', '<task-notification>\n<task-id>fixture-1</task-id>\n</task-notification>')
      + line('user', '<task-notification>\n<task-id>fixture-2</task-id>\n</task-notification>')
      + JSON.stringify({ type: 'assistant', ...after, message: { id: randomUUID(), ...after.message } }) + '\n')
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).rejects.toThrow('unfinished tool receipts')
  })
  it('settles a refusal proven to precede the run (toolDenialBeforeRun)', async () => {
    const f = await fixture(line('assistant', [{ type: 'tool_use', id: 'refused', name: 'Bash', input: { command: 'never executed by this test' } }])
      + JSON.stringify({ type: 'user', toolDenialKind: 'user-rejected', toolDenialBeforeRun: true, message: { content: [{ type: 'tool_result', tool_use_id: 'refused', content: 'rejected', is_error: true }] } }) + '\n')
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).resolves.toBeUndefined()
  })
  it('does not require a handoff summary merely to verify receipts before a same-provider resume', async () => {
    const f = await fixture(line('user', 'x'.repeat(256 * 1024)))
    await expect(assertSwarmNativeConversationSettled(f.cwd, f.id)).resolves.toBeUndefined()
    await expect(readSwarmNativePublicConversation(f.cwd, f.id)).rejects.toThrow('approved summary')
  })
})
