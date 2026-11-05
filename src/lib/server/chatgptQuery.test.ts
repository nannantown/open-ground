import { describe, expect, it, vi } from 'vitest'
import { readFile, rm, mkdtemp } from 'fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'crypto'
import { createChatGptQuery, distillChatGptMessage, chatGptTranscriptFile } from './chatgptQuery'
import { chatGptConversationFile, chatGptPublicConversation } from './chatgptResponses'

const envelope = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
const response = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'test-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`)

describe('ChatGPT pool adapter', () => {
  it('persists captured public text before reporting settlement even when the event consumer has not drained it', async () => {
    const storeDir = await mkdtemp(join(tmpdir(), 'og-query-public-')), id = `chatgpt-${randomUUID()}`
    const lines: { kind: 'input' | 'text'; text: string }[] = [{ kind: 'input', text: 'owner words' }]
    const options = { storeDir, accountKey: async () => 'test-account' }
    const settled = vi.fn(async () => {
      expect(await chatGptPublicConversation(id, options)).toEqual([...lines])
      expect(lines.at(-1)).toEqual({ kind: 'text', text: 'done' })
    })
    try {
      const query = createChatGptQuery({ ...options, fetch: (async () => response()) as typeof fetch, accessToken: async () => 'fixture-only', roleInstructions: async () => 'role protocol', authorize: async () => {} })
      const handle = query({ prompt: { async *[Symbol.asyncIterator]() { yield envelope('owner words') } }, options: { cwd: '/tmp', model: 'test-model', runtimeRole: 'manager', sessionId: id }, onPublicText: text => lines.push({ kind: 'text', text }), publicConversation: () => ({ lines, overflow: false }), onTurnSettled: settled })
      for await (const _event of handle) { /* real adapter settlement owns persistence */ }
      expect(settled).toHaveBeenCalledOnce()
    } finally { await rm(storeDir, { recursive: true, force: true }) }
  })

  it('requires the worker veto before constructing a query', () => {
    expect(() => createChatGptQuery()({ prompt: { async *[Symbol.asyncIterator]() {} }, options: { cwd: '/tmp', model: 'test-model', runtimeRole: 'worker' } })).toThrow(/guard/)
  })

  it('embeds the packaged role protocol and emits typed events for the pool without spawning Claude', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string)
      expect(request.instructions).toContain('role-skill-body')
      expect(request.instructions).toContain('app context')
      expect(request.input).toEqual([{ role: 'user', content: 'do work' }])
      return response()
    })
    const query = createChatGptQuery({ fetch: fetcher as unknown as typeof fetch, accountKey: async () => 'test-account', accessToken: async () => 'local-test', roleInstructions: async () => 'role-skill-body', authorize: async () => {} })
    const handle = query({ prompt: { async *[Symbol.asyncIterator]() { yield envelope('do work') } }, options: { cwd: '/tmp', model: 'test-model', runtimeRole: 'manager', systemPrompt: { append: 'app context' }, persist: false } })
    const events: unknown[] = []
    for await (const event of handle) events.push(...distillChatGptMessage(event))
    expect(events).toContainEqual({ kind: 'text', text: 'done' })
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'completed', isError: false })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(distillChatGptMessage({ type: 'untrusted_provider_event' })).toEqual([])
  })

  it('appends supply user/final assistant lines once without duplicating streamed deltas or tool data', async () => {
    const id = `chatgpt-${randomUUID()}`
    const query = createChatGptQuery({ fetch: (async () => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'done' })}\n\n` + await response().text())) as typeof fetch, accountKey: async () => 'test-account', accessToken: async () => 'test', roleInstructions: async () => 'supply protocol', authorize: async () => {} })
    try {
      const handle = query({ prompt: { async *[Symbol.asyncIterator]() { yield envelope('owner words') } }, options: { cwd: '/tmp', model: 'test-model', runtimeRole: 'supply', sessionId: id } })
      for await (const _event of handle) { /* drain */ }
      const lines = (await readFile(chatGptTranscriptFile(id), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => [line.type, line.message.content])).toEqual([['user', [{ type: 'text', text: 'owner words' }]], ['assistant', [{ type: 'text', text: 'done' }]]])
      expect(lines.every((line) => typeof line.timestamp === 'string')).toBe(true)
    } finally { await Promise.all([rm(chatGptTranscriptFile(id), { force: true }), rm(chatGptConversationFile(id), { force: true })]) }
  })

  it('runs Agent in a fresh same-model read-only context and returns its independent finding to the parent', async () => {
    const requests: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string)
      requests.push(request)
      if (requests.length === 1) {
        expect(request.tools[0].tools.map((tool: { name: string }) => tool.name)).toContain('Agent')
        return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'test-model', output: [{ type: 'function_call', namespace: 'openground', name: 'Agent', call_id: 'independent-review', arguments: JSON.stringify({ prompt: 'Inspect the code independently' }) }] } })}\n\n`)
      }
      if (requests.length === 2) {
        expect(request).toMatchObject({ model: 'test-model', reasoning: { effort: 'high' }, store: false, input: [{ role: 'user', content: 'Inspect the code independently' }] })
        expect(request.tools[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['Read', 'Git'])
        expect(request.instructions).toContain('independent adversarial reviewer')
        return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'test-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Independent finding: check the boundary.' }] }] } })}\n\n`)
      }
      const receipt = JSON.parse(request.input.at(-1).output)
      expect(receipt).toMatchObject({ independent: true, readOnly: true, text: 'Independent finding: check the boundary.' })
      return response()
    })
    const query = createChatGptQuery({ fetch: fetcher as unknown as typeof fetch, accountKey: async () => 'same-account', accessToken: async () => 'plan-fixture', roleInstructions: async () => 'role protocol', authorize: async () => {} })
    const handle = query({ prompt: { async *[Symbol.asyncIterator]() { yield envelope('parent private context') } }, options: { cwd: '/tmp', model: 'test-model', effort: 'high', runtimeRole: 'manager', persist: false } })
    const events: unknown[] = []
    for await (const event of handle) events.push(event)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'completed', isError: false })
  })

  it('never starts a review request for a different account than the parent context', async () => {
    let reads = 0
    const accountKey = async () => ++reads < 5 ? 'parent-account' : 'changed-account'
    const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'test-model', output: [{ type: 'function_call', namespace: 'openground', name: 'Agent', call_id: 'review', arguments: JSON.stringify({ prompt: 'Inspect independently' }) }] } })}\n\n`))
    const query = createChatGptQuery({ fetch: fetcher as unknown as typeof fetch, accountKey, accessToken: async () => 'plan-fixture', roleInstructions: async () => 'role protocol', authorize: async () => {} })
    const handle = query({ prompt: { async *[Symbol.asyncIterator]() { yield envelope('private parent context') } }, options: { cwd: '/tmp', model: 'test-model', runtimeRole: 'manager', persist: false } })
    await expect((async () => { for await (const _event of handle) { /* drain */ } })()).rejects.toThrow(/connection changed/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
