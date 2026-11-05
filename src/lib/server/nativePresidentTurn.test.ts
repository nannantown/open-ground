import { describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openGroundHome } from './paths'
import { nativePresidentDrainable, nativePresidentTranscriptOffset, waitForNativePresidentTurnSettled, interruptNativePresidentTurn, type NativePresidentProofDeps } from './swarmRuntimeTransition'
const RULE = '─'.repeat(40)
const idle = ['⏺ done.', '', RULE, '❯ ', RULE, '⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const busy = idle + ' · esc to interrupt'
const line = (type: string, content: unknown) => JSON.stringify({ type, message: { content } }) + '\n'
const fixture = async () => {
  await mkdir(openGroundHome(), { recursive: true })
  const directory = await mkdtemp(join(openGroundHome(), 'native-president-proof-'))
  const file = join(directory, 'conversation.jsonl')
  await writeFile(file, line('user', 'older words') + line('assistant', [{ type: 'text', text: 'older answer' }]))
  const desk = { handleId: 'synthetic-president', cwd: directory, agentSessionId: '11111111-1111-4111-8111-111111111111' }
  const deps: NativePresidentProofDeps = { file: () => file, current: () => true, screen: () => idle }
  return { file, desk, deps, offset: await nativePresidentTranscriptOffset(desk, deps) }
}
describe('native president durable reply proof', () => {
  it('confirms a new matching owner/reply pair and fsyncs the bounded native log', async () => {
    const f = await fixture()
    await appendFile(f.file, line('user', 'please report') + line('assistant', [{ type: 'text', text: 'confirmed answer' }]))
    const result = await waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, f.deps)
    expect(result.agentSessionId).toBe(f.desk.agentSessionId)
    expect(result.transcriptOffset).toBeGreaterThan(f.offset)
  })
  it('does not borrow an older answer or another user turn as this receipt’s reply', async () => {
    const f = await fixture()
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset, timeoutMs: 0 }, f.deps)).rejects.toThrow('confirmed boundary')
    await appendFile(f.file, line('user', 'please report') + line('user', 'another turn') + line('assistant', 'other reply'))
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, f.deps)).rejects.toThrow('interleaved')
  })
  it('keeps an unfinished tool effect unconfirmed even when the screen looks idle', async () => {
    const f = await fixture()
    await appendFile(f.file, line('user', 'please report') + line('assistant', [
      { type: 'text', text: 'Working on it.' }, { type: 'tool_use', id: 'unconfirmed-tool' },
    ]))
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset, timeoutMs: 0 }, f.deps)).rejects.toThrow('confirmed boundary')
  })
  it('rejects a retired actor and a truncated log instead of confirming a different conversation', async () => {
    const f = await fixture()
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'words', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, current: () => false })).rejects.toThrow('retired')
    await writeFile(f.file, '')
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'words', transcriptOffsetBeforeSend: f.offset }, f.deps)).rejects.toThrow('proof window')
  })
  it('cancels only the proof observer when its durable input receipt was already settled elsewhere', async () => {
    const f = await fixture(), controller = new AbortController()
    controller.abort()
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'words', transcriptOffsetBeforeSend: f.offset, signal: controller.signal }, f.deps)).rejects.toThrow('observer was cancelled')
  })
  it('stops a matching generation with no unfinished tools and confirms the empty prompt without undoing work', async () => {
    const f = await fixture()
    await appendFile(f.file, line('user', 'please report'))
    let screen = busy
    const interrupt = vi.fn(() => { screen = idle; return true })
    const deps = { ...f.deps, screen: () => screen, interrupt }
    expect(await interruptNativePresidentTurn({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, deps)).toEqual({ completed: false })
    expect(interrupt).toHaveBeenCalledOnce()
  })
  it('preserves a typed draft and refuses a stale turn before sending Ctrl-C', async () => {
    const f = await fixture(), interrupt = vi.fn(() => true)
    await appendFile(f.file, line('user', 'current words'))
    await expect(interruptNativePresidentTurn({ desk: f.desk, sentText: 'stale words', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, interrupt })).rejects.toThrow('unconfirmed submission')
    await expect(interruptNativePresidentTurn({ desk: f.desk, sentText: 'current words', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, screen: () => idle.replace('❯ ', '❯ unfinished draft'), interrupt })).rejects.toThrow('draft was preserved')
    expect(interrupt).not.toHaveBeenCalled()
  })
  it('interrupts an active tool but holds its unknown effect instead of claiming safe cancellation', async () => {
    const f = await fixture(), interrupt = vi.fn(() => true)
    await appendFile(f.file, line('user', 'please report') + line('assistant', [{ type: 'tool_use', id: 'unknown-action' }]))
    await expect(interruptNativePresidentTurn({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, screen: () => busy, interrupt })).rejects.toThrow('unconfirmed effect')
    expect(interrupt).toHaveBeenCalledOnce()
  })
  it('never confirms an unfinished tool as delivered merely because stop observed an idle screen and assistant prose', async () => {
    const f = await fixture(), interrupt = vi.fn(() => true)
    await appendFile(f.file, line('user', 'please report') + line('assistant', [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'unknown-action' }]))
    await expect(interruptNativePresidentTurn({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, interrupt })).rejects.toThrow('unconfirmed')
    expect(interrupt).not.toHaveBeenCalled()
  })
  it('does not turn a native provider API refusal into a successful reply or completed stop', async () => {
    const f = await fixture(), interrupt = vi.fn(() => true)
    await appendFile(f.file, line('user', 'please report') + line('assistant', [{ type: 'text', text: 'Starting.' }])
      + JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: "You've reached your model limit." }] } }) + '\n')
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset, timeoutMs: 0 }, f.deps)).rejects.toThrow('provider refused')
    await expect(interruptNativePresidentTurn({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, interrupt })).rejects.toThrow('provider refused')
    expect(interrupt).not.toHaveBeenCalled()
  })
  it('accepts the existing positive quota classifier as a drain boundary while protecting drafts and unknown screens', () => {
    const quota = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
    expect(nativePresidentDrainable(quota)).toBe(true)
    expect(nativePresidentDrainable(quota + '\n' + idle.replace('⏺ done.', '').replace('❯ ', '❯ my draft'))).toBe(false)
    expect(nativePresidentDrainable('unrecognized terminal frame')).toBe(false)
    expect(nativePresidentDrainable(quota + '\n' + busy)).toBe(false)
  })
  it('confirms a known usage wall as refused, never fulfilled, after matching the new owner input and checking receipts', async () => {
    const f = await fixture()
    const screen = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
    await appendFile(f.file, line('user', 'please report') + JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: screen }] } }) + '\n')
    expect(await waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset }, { ...f.deps, screen: () => screen })).toMatchObject({ refused: true, agentSessionId: f.desk.agentSessionId })
    await appendFile(f.file, line('assistant', [{ type: 'tool_use', id: 'unknown-effect' }]))
    await expect(waitForNativePresidentTurnSettled({ desk: f.desk, sentText: 'please report', transcriptOffsetBeforeSend: f.offset, timeoutMs: 0 }, { ...f.deps, screen: () => screen })).rejects.toThrow('provider refused')
  })
})
