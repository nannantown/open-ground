import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatGptQuery } from './chatgptQuery'
import { chatGptConversationFile } from './chatgptResponses'
import type { SdkEvent } from './sdkEvents'

const host = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./chatgptTools', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chatgptTools')>(),
  createChatGptHostTools: () => [{
    name: 'fixture_step',
    description: 'A side-effect counter used only by this regression fixture.',
    parameters: {
      type: 'object', properties: { step: { type: 'integer' } },
      required: ['step'], additionalProperties: false,
    },
    invoke: host.invoke,
  }],
}))

type Item = Record<string, unknown>
const roots: string[] = []
afterEach(async () => {
  host.invoke.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const completed = (output: Item[]): Response => new Response(`data: ${JSON.stringify({
  type: 'response.completed',
  response: {
    status: 'completed', model: 'fixture-model', output,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })

describe('ChatGPT accepted-turn continuation across tool checkpoints', () => {
  it.each([35, 65])('finishes %i tool rounds without replaying tools or settling the owner turn early', async (rounds) => {
    const storeDir = await mkdtemp(join(tmpdir(), 'og-chatgpt-continuation-'))
    roots.push(storeDir)
    const id = `chatgpt-${randomUUID()}`
    const ownerWords = 'Complete this one accepted owner task.'
    const finalText = `Completed all ${rounds} steps.`
    const events: SdkEvent[] = []
    const requests: Item[][] = []
    const executed: number[] = []
    const checkpointRounds: number[] = []
    const settled = vi.fn(async () => {
      expect(executed).toHaveLength(rounds)
      const saved = JSON.parse(await readFile(chatGptConversationFile(id, storeDir), 'utf8'))
      expect(saved.input.at(-1)).toMatchObject({
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }],
      })
    })
    host.invoke.mockImplementation(async (args: unknown, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      const step = (args as { step: number }).step
      // A repeated model call would repeat a useful host action: fail at the
      // action boundary rather than just checking the eventual transcript.
      expect(executed).not.toContain(step)
      executed.push(step)
      return { confirmedStep: step }
    })
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string)
      const input = request.input as Item[]
      requests.push(input)
      const finished = requests.length - 1
      expect(input.filter((item) => item.role === 'user')).toEqual([{ role: 'user', content: ownerWords }])
      expect(settled).not.toHaveBeenCalled()
      const calls = input.filter((item) => item.type === 'function_call')
      const outputs = input.filter((item) => item.type === 'function_call_output')
      expect(calls).toHaveLength(finished)
      expect(outputs).toHaveLength(finished)
      expect(executed).toHaveLength(finished)
      for (let step = 1; step <= finished; step++) {
        const callId = `fixture-call-${step}`
        expect(calls.filter((item) => item.call_id === callId)).toHaveLength(1)
        expect(outputs.filter((item) => item.call_id === callId)).toEqual([{
          type: 'function_call_output', call_id: callId,
          output: JSON.stringify({ confirmedStep: step }),
        }])
      }
      // The next request must read already-confirmed local history across each
      // 32-round boundary, without turning it into another accepted user input.
      if (finished > 0 && finished % 32 === 0) {
        const saved = JSON.parse(await readFile(chatGptConversationFile(id, storeDir), 'utf8'))
        expect(saved.input).toEqual(input)
        checkpointRounds.push(finished)
      }
      if (finished === rounds) return completed([{
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }],
      }])
      expect(finished).toBeLessThan(rounds)
      const step = finished + 1
      return completed([{
        type: 'function_call', namespace: 'openground', name: 'fixture_step',
        call_id: `fixture-call-${step}`, arguments: JSON.stringify({ step }),
      }])
    })
    const query = createChatGptQuery({
      storeDir, fetch: fetcher as unknown as typeof fetch,
      accountKey: async () => 'fixture-account', accessToken: async () => 'fixture-only',
      authorize: async () => {}, roleInstructions: async () => 'Finish the accepted task using fixture_step.',
    })
    const handle = query({
      prompt: { async *[Symbol.asyncIterator]() {
        yield { message: { content: [{ type: 'text', text: ownerWords }] } }
      } },
      options: { cwd: storeDir, model: 'fixture-model', runtimeRole: 'manager', sessionId: id },
      onTurnSettled: settled,
    })
    await expect((async () => { for await (const event of handle) events.push(event) })()).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(rounds + 1)
    expect(host.invoke).toHaveBeenCalledTimes(rounds)
    expect(executed).toEqual(Array.from({ length: rounds }, (_, i) => i + 1))
    expect(checkpointRounds).toEqual(rounds === 35 ? [32] : [32, 64])
    expect(events.filter((event) => event.kind === 'text')).toEqual([{ kind: 'text', text: finalText }])
    expect(events.filter((event) => event.kind === 'turn_end')).toEqual([{
      kind: 'turn_end', reason: 'completed', isError: false,
      usage: { inputTokens: rounds + 1, outputTokens: rounds + 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    }])
    expect(events.filter((event) => event.kind === 'api_error')).toEqual([])
    expect(settled).toHaveBeenCalledOnce()
  })
})
