import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { getEventListeners } from 'events'
import { ChatGptConversation, chatGptConversationExists, chatGptConversationFile, readChatGptSse, type ChatGptTool } from './chatgptResponses'
import { ChatGptQuotaError, chatGptCoolingUntil, clearChatGptCooling } from './chatgptQuota'
import { coolingSnapshot } from './swarmQuota'
import type { SdkEvent } from './sdkEvents'

const roots: string[] = []
afterEach(async () => { clearChatGptCooling(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'og-chatgpt-responses-')); roots.push(root); return root }
const sse = (events: unknown[], width = 17) => {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const done = (output: unknown[], usage = { input_tokens: 3, output_tokens: 2 }) => ({ type: 'response.completed', response: { status: 'completed', model: 'test-model', output, usage } })
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const tool: ChatGptTool = { name: 'look', description: 'Test read', parameters: { type: 'object', properties: {}, additionalProperties: false }, invoke: async () => ({ value: 'a fact' }) }

describe('ChatGPT stateless function harness', () => {
  it('assembles completed streamed items by output_index when terminal output is empty, then executes tools and returns final text', async () => {
    const requests: Record<string, unknown>[] = []
    const invoke = vi.fn(tool.invoke)
    const reasoning = { id: 'reasoning-1', type: 'reasoning', summary: [], encrypted_content: 'encrypted-reasoning' }
    const functionCall = { id: 'function-1', type: 'function_call', namespace: 'openground', name: 'look', call_id: 'assembled-call', arguments: '{}', status: 'completed' }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(init!.body as string))
      if (requests.length === 1) return sse([
        { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
        { type: 'response.output_item.added', output_index: 1, item: { ...functionCall, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'function-1', delta: '{}' },
        { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'function-1', arguments: '{}' },
        // Completion order need not be array order; output_index owns order.
        { type: 'response.output_item.done', output_index: 1, item: functionCall },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        done([]),
      ], 1)
      return sse([
        { type: 'response.output_item.added', output_index: 0, item: { ...message(''), id: 'message-1', status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item: { ...message('An independently read fact.'), id: 'message-1', status: 'completed' } },
        done([]),
      ], 2)
    })
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: fetcher as unknown as typeof fetch })
    expect((await conversation.run('Inspect it')).text).toBe('An independently read fact.')
    expect(invoke).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(2)
    expect(requests[1].input).toEqual([{ role: 'user', content: 'Inspect it' }, reasoning, functionCall, { type: 'function_call_output', call_id: 'assembled-call', output: JSON.stringify({ value: 'a fact' }) }])
  })

  it('does not execute a completed item twice when the terminal response also supplies it', async () => {
    const invoke = vi.fn(tool.invoke)
    const functionCall = { type: 'function_call', namespace: 'openground', name: 'look', call_id: 'one-call', arguments: '{}' }
    let requests = 0
    const fetcher = vi.fn(async () => ++requests === 1 ? sse([
      { type: 'response.output_item.done', output_index: 0, item: functionCall }, done([functionCall]),
    ]) : sse([done([message('finished')])]))
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: fetcher as unknown as typeof fetch })
    expect((await conversation.run('Inspect')).text).toBe('finished')
    expect(invoke).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['EOF', 'failed', 'incomplete', 'unfinished-item'] as const)('does not execute streamed items before successful response completion: %s', async (ending) => {
    const invoke = vi.fn(tool.invoke)
    const functionCall = { id: 'pending-call', type: 'function_call', namespace: 'openground', name: 'look', call_id: 'not-authorized-yet', arguments: '{}' }
    const events: unknown[] = [{ type: 'response.output_item.added', output_index: 0, item: functionCall }]
    if (ending !== 'unfinished-item') events.push({ type: 'response.output_item.done', output_index: 0, item: functionCall })
    if (ending === 'failed') events.push({ type: 'response.failed', response: { status: 'failed', error: { message: 'generation failed' } } })
    if (ending === 'incomplete') events.push({ type: 'response.incomplete', response: { status: 'incomplete' } })
    if (ending === 'unfinished-item') events.push(done([]))
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse(events)) as typeof fetch })
    await expect(conversation.run('Inspect')).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, '0', undefined, 4096])('rejects a malformed streamed output index %s before any tool execution', async (output_index) => {
    const invoke = vi.fn(tool.invoke)
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse([
      { type: 'response.output_item.done', output_index, item: { type: 'function_call', namespace: 'openground', name: 'look', call_id: 'invalid-index', arguments: '{}' } }, done([]),
    ])) as typeof fetch })
    await expect(conversation.run('Inspect')).rejects.toThrow(/index|streamed/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['duplicate-index', 'malformed-item', 'changed-item', 'incomplete-item', 'missing-index'] as const)('rejects %s in streamed output without executing any tool', async (control) => {
    const invoke = vi.fn(tool.invoke)
    const item = { id: 'function-1', type: 'function_call', namespace: 'openground', name: 'look', call_id: 'guarded-call', arguments: '{}' }
    const events: unknown[] = []
    if (control === 'changed-item') events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, id: 'another-function' } })
    events.push({ type: 'response.output_item.done', output_index: control === 'missing-index' ? 1 : 0,
      item: control === 'malformed-item' ? { ...item, arguments: 7 } : control === 'incomplete-item' ? { ...item, status: 'in_progress' } : item })
    if (control === 'duplicate-index') events.push({ type: 'response.output_item.done', output_index: 0, item: { ...item, call_id: 'another-call' } })
    events.push(done([]))
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse(events)) as typeof fetch })
    await expect(conversation.run('Inspect')).rejects.toThrow(/index|streamed|item/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('streams split UTF-8 frames, dispatches only completed calls, and sends full encrypted reasoning/tool history with store:false', async () => {
    const requests: Record<string, unknown>[] = []
    const invoke = vi.fn(tool.invoke)
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(JSON.parse(init!.body as string))
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer local-test-token' })
      if (requests.length === 1) return sse([done([{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', namespace: 'openground', name: 'look', call_id: 'c1', arguments: '{}' }])], 1)
      return sse([{ type: 'response.output_text.delta', delta: '日本語' }, done([message('日本語')])], 2)
    }) as unknown as typeof fetch
    const events: SdkEvent[] = []
    const conversation = new ChatGptConversation({ storeDir: await temp(), model: 'test-model', tools: [{ ...tool, invoke }], fetch: fetcher, accountKey: async () => 'test-account', accessToken: async () => 'local-test-token' })
    expect(await conversation.run('hello', { onEvent: (event) => events.push(event) })).toMatchObject({ text: '日本語', usage: { inputTokens: 6, outputTokens: 4, costUsd: null } })
    expect(invoke).toHaveBeenCalledOnce()
    expect(requests[0]).toMatchObject({ store: false, stream: true, include: ['reasoning.encrypted_content'], tools: [{ type: 'namespace', name: 'openground', tools: [{ type: 'function', name: 'look', strict: false }] }] })
    expect(requests[1].input).toEqual([{ role: 'user', content: 'hello' }, { type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', namespace: 'openground', name: 'look', call_id: 'c1', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: '{"value":"a fact"}' }])
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'completed', isError: false })
    expect(JSON.parse(await readFile(chatGptConversationFile(conversation.id, roots[0]), 'utf8')).input.at(-1)).toEqual(message('日本語'))
  })

  it.each([
    ['EOF', []],
    ['failed', [{ type: 'response.failed', response: { error: { message: 'request failed' } } }]],
    ['incomplete', [{ type: 'response.incomplete', response: { status: 'incomplete' } }]],
  ])('fails visibly on %s instead of reporting a completed turn', async (_label, events) => {
    const emitted: SdkEvent[] = []
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse(events)) as typeof fetch })
    await expect(conversation.run('hello', { onEvent: (event) => emitted.push(event) })).rejects.toThrow()
    expect(emitted.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'api_error', isError: true })
  })

  it('does not run delta tool arguments or an unadvertised namespace/name', async () => {
    const invoke = vi.fn(tool.invoke)
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse([{ type: 'response.function_call_arguments.done', name: 'look', arguments: '{}' }, done([{ type: 'function_call', namespace: 'other', name: 'look', call_id: 'bad', arguments: '{}' }])])) as typeof fetch })
    await expect(conversation.run('hello')).rejects.toThrow(/unadvertised/)
    expect(invoke).not.toHaveBeenCalled()
    await expect(conversation.run('next')).rejects.toThrow(/closed/)
  })

  it('uses genuine HTTP usage refusal and retry deadline, never quoted assistant words', async () => {
    const until = Date.now() + 5000
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => new Response('{}', { status: 429, headers: { 'retry-after': new Date(until).toUTCString() } })) as typeof fetch })
    const events: SdkEvent[] = []
    await expect(conversation.run('hello', { onEvent: (event) => events.push(event) })).rejects.toBeInstanceOf(ChatGptQuotaError)
    expect(events.some((event) => event.kind === 'quota_refusal')).toBe(true)
    const quoted: SdkEvent[] = []
    const okay = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse([done([message('You said: usage limit reached')])])) as typeof fetch })
    await okay.run('quote it', { onEvent: (event) => quoted.push(event) })
    expect(quoted.some((event) => event.kind === 'quota_refusal')).toBe(false)
  })

  it('parks a streamed subscription usage refusal after HTTP 200 without cooling Claude or retrying', async () => {
    const now = Date.now()
    const claudeBefore = coolingSnapshot(now)
    const events: SdkEvent[] = []
    const fetcher = vi.fn(async () => sse([
      { type: 'response.output_text.delta', delta: 'partial output' },
      { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'App usage limit reached' } } },
    ]))
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], accountKey: async () => 'test-account', accessToken: async () => 'plan-test', fetch: fetcher as unknown as typeof fetch })
    await expect(conversation.run('hello', { onEvent: (event) => events.push(event) })).rejects.toBeInstanceOf(ChatGptQuotaError)
    expect(chatGptCoolingUntil()).toBeGreaterThan(now)
    expect(coolingSnapshot(now)).toEqual(claudeBefore)
    expect(events.filter((event) => event.kind === 'quota_refusal')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'api_error', isError: true })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('propagates a child Agent streamed quota refusal without sending a parent continuation', async () => {
    const parentEvents: SdkEvent[] = []
    const childEvents: SdkEvent[] = []
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) return sse([done([{ type: 'function_call', namespace: 'openground', name: 'Agent', call_id: 'delegate', arguments: '{}' }])])
      if (fetcher.mock.calls.length === 2) return sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'App usage limit reached' } } }])
      return sse([done([message('A quota refusal must never cause this continuation')])])
    })
    const connection = { persist: false, model: 'test-model', accountKey: async () => 'same-plan-account', accessToken: async () => 'same-plan-token', fetch: fetcher as unknown as typeof fetch }
    const child = new ChatGptConversation({ ...connection, tools: [] })
    const delegate: ChatGptTool = { ...tool, name: 'Agent', invoke: (_args, signal) => child.run('Inspect independently', { signal, onEvent: (event) => childEvents.push(event) }) }
    const parent = new ChatGptConversation({ ...connection, tools: [delegate] })
    await expect(parent.run('Delegate a review', { onEvent: (event) => parentEvents.push(event) })).rejects.toBeInstanceOf(ChatGptQuotaError)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(chatGptCoolingUntil()).toBeGreaterThan(Date.now())
    expect(childEvents.some((event) => event.kind === 'quota_refusal')).toBe(true)
    expect(parentEvents.some((event) => event.kind === 'quota_refusal')).toBe(true)
    expect(parentEvents.some((event) => event.kind === 'tool_result')).toBe(false)
    await expect(parent.run('Do not retry the unfinished delegation')).rejects.toThrow(/closed/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('still lets an ordinary host tool error return a receipt and recover in the next response', async () => {
    const requests: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(init!.body as string))
      return requests.length === 1 ? sse([done([{ type: 'function_call', namespace: 'openground', name: 'look', call_id: 'ordinary-error', arguments: '{}' }])]) : sse([done([message('The requested file was unavailable.')])])
    })
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke: async () => { throw new Error('file not found') } }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: fetcher as unknown as typeof fetch })
    const events: SdkEvent[] = []
    expect((await conversation.run('Read it', { onEvent: (event) => events.push(event) })).text).toBe('The requested file was unavailable.')
    expect((requests[1].input as Record<string, unknown>[]).at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'ordinary-error', output: JSON.stringify({ error: 'file not found' }) })
    expect(events).toContainEqual({ kind: 'tool_result', ok: false, head: JSON.stringify({ error: 'file not found' }) })
    expect(chatGptCoolingUntil()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['chatpass_v2_scope_not_authorized', 'subscription_sharing_unsupported_capability', 'subscription_sharing_user_not_eligible'])(
    'keeps %s separate from quota and does not retry it', async (code) => {
      const events: SdkEvent[] = []
      const fetcher = vi.fn(async () => sse([{ type: 'response.failed', response: { status: 'failed', error: { code, message: 'Request denied' } } }]))
      const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], accountKey: async () => 'test-account', accessToken: async () => 'plan-test', fetch: fetcher as unknown as typeof fetch })
      await expect(conversation.run('hello', { onEvent: (event) => events.push(event) })).rejects.toMatchObject({ name: 'ChatGptResponseError', code })
      expect(chatGptCoolingUntil()).toBeNull()
      expect(events.some((event) => event.kind === 'quota_refusal')).toBe(false)
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )

  it('preserves history and rejects oversized context without issuing a request or deleting older messages', async () => {
    const storeDir = await temp()
    const fetcher = vi.fn(async () => sse([done([message('ok')])]))
    const conversation = new ChatGptConversation({ storeDir, model: 'test-model', tools: [], maxHistoryBytes: 300, accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: fetcher as unknown as typeof fetch })
    await conversation.run('small')
    const before = await readFile(chatGptConversationFile(conversation.id, storeDir), 'utf8')
    await expect(conversation.run('x'.repeat(400))).rejects.toThrow(/context limit/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readFile(chatGptConversationFile(conversation.id, storeDir), 'utf8')).toBe(before)
  })

  it('does not persist assistant input/tool output when persist:false', async () => {
    const storeDir = await temp()
    const conversation = new ChatGptConversation({ storeDir, persist: false, model: 'test-model', tools: [], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => sse([done([message('private answer')])])) as typeof fetch })
    await conversation.run('private words')
    await expect(readFile(chatGptConversationFile(conversation.id, storeDir))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('passes image tool output as Responses image content, never base64 JSON text', async () => {
    const requests: Record<string, unknown>[] = []
    const image = [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }]
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke: async () => image }], accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async (_url, init) => {
      requests.push(JSON.parse(init!.body as string))
      return requests.length === 1 ? sse([done([{ type: 'function_call', namespace: 'openground', name: 'look', call_id: 'image', arguments: '{}' }])]) : sse([done([message('image read')])])
    }) as typeof fetch })
    expect((await conversation.run('look')).text).toBe('image read')
    expect((requests[1].input as Record<string, unknown>[]).at(-1)).toEqual({ type: 'function_call_output', call_id: 'image', output: image })
  })

  it('stops before host side effects when the authenticated account changes during inference', async () => {
    let account = 'first-account'
    const invoke = vi.fn(tool.invoke)
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], accountKey: async () => account, accessToken: async () => 'test', fetch: (async () => {
      account = 'second-account'
      return sse([done([{ type: 'function_call', namespace: 'openground', name: 'look', call_id: 'c1', arguments: '{}' }])])
    }) as typeof fetch })
    await expect(conversation.run('do something')).rejects.toThrow(/connection changed/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rechecks server authorization on tool continuations and surfaces a stalled response deadline', async () => {
    let allowed = true
    const invoke = vi.fn(tool.invoke)
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], authorize: async () => { if (!allowed) throw new Error('owner signed out') }, accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => {
      allowed = false
      return sse([done([{ type: 'function_call', namespace: 'openground', name: 'look', call_id: 'c1', arguments: '{}' }])])
    }) as typeof fetch })
    await expect(conversation.run('do something')).rejects.toThrow(/signed out/)
    expect(invoke).not.toHaveBeenCalled()
    let cancelled = false
    const stalled = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], requestTimeoutMs: 20, accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))) as typeof fetch })
    const events: SdkEvent[] = []
    await expect(stalled.run('hello', { onEvent: (event) => events.push(event) })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(cancelled).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'api_error', isError: true })
  })

  it('retains its response deadline across forced GC on Node 20 as well as newer Node versions', async () => {
    // Run actual transport code in a GC-enabled process. Node 20 holds the
    // sources of AbortSignal.any only weakly; a temporary timeout source can
    // otherwise disappear during the full suite even though an idle test passes.
    const source = pathToFileURL(resolve('src/lib/server/chatgptResponses.ts')).href
    const script = `
      const loaded = await import(${JSON.stringify(source)});
      const { ChatGptConversation } = loaded.default ?? loaded;
      let cancelled = false, watchdogFired = false;
      const conversation = new ChatGptConversation({
        persist: false, model: 'synthetic', tools: [], requestTimeoutMs: 250,
        accountKey: async () => 'synthetic-account', accessToken: async () => 'synthetic-token',
        fetch: async () => new Response(new ReadableStream({
          start() { setTimeout(() => global.gc(), 20); },
          cancel() { cancelled = true; }
        }))
      });
      const watchdog = setTimeout(() => { watchdogFired = true; conversation.close(); }, 1500);
      try { await conversation.run('synthetic'); process.stdout.write(JSON.stringify({ name: 'unexpected completion' })); }
      catch (error) { process.stdout.write(JSON.stringify({ name: error.name, cancelled, watchdogFired })); }
      finally { clearTimeout(watchdog); }
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, NODE_OPTIONS: '' } })
    expect(JSON.parse(stdout)).toEqual({ name: 'TimeoutError', cancelled: true, watchdogFired: false })
  })

  it('cleans up the response deadline before a later host tool finishes its own work', async () => {
    const requestSignals: AbortSignal[] = []
    const invoke = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      await new Promise((doneWaiting) => setTimeout(doneWaiting, 80))
      expect(signal.aborted).toBe(false)
      expect(requestSignals[0].aborted).toBe(false)
      return 'finished host work'
    })
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignals.push(init!.signal as AbortSignal)
      return requestSignals.length === 1 ? sse([done([{ type: 'function_call', namespace: 'openground', name: 'look', call_id: 'long-host-work', arguments: '{}' }])]) : sse([done([message('done')])])
    })
    const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [{ ...tool, invoke }], requestTimeoutMs: 40, accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: fetcher as unknown as typeof fetch })
    expect((await conversation.run('Inspect')).text).toBe('done')
    expect(invoke).toHaveBeenCalledOnce()
    expect(requestSignals.every((signal) => !signal.aborted)).toBe(true)
  })

  it.each(['failed', 'abort'] as const)('cleans up owned timers and cancellation listeners after %s', async (ending) => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let started!: () => void
      let requestSignal!: AbortSignal
      const requestStarted = new Promise<void>((resolveStarted) => { started = resolveStarted })
      const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], requestTimeoutMs: 1000, accountKey: async () => 'test-account', accessToken: async () => 'test', fetch: (async (_url, init) => {
        requestSignal = init!.signal as AbortSignal
        started()
        return ending === 'failed' ? sse([{ type: 'response.failed', response: { error: { message: 'generation failed' } } }]) : new Response(new ReadableStream<Uint8Array>())
      }) as typeof fetch })
      const observed = conversation.run('hello', { signal: controller.signal }).then(() => null, (error: unknown) => error)
      await requestStarted
      if (ending === 'abort') controller.abort()
      expect(await observed).toBeInstanceOf(Error)
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(requestSignal.aborted).toBe(ending === 'abort')
    } finally { vi.useRealTimers() }
  })

  it('never falls back to a metered API key when the ChatGPT connection is signed out', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-metered-key-must-never-be-used')
    try {
      const fetcher = vi.fn()
      // No token/account override: exercise the real OAuth credential reader in
      // the isolated test home. An unrelated API key grants no plan connection.
      const conversation = new ChatGptConversation({ persist: false, model: 'test-model', tools: [], fetch: fetcher })
      await expect(conversation.run('hello')).rejects.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })

  it('never resumes an unfinished tool receipt and validates local ids', async () => {
    const id = `chatgpt-${randomUUID()}`
    const file = chatGptConversationFile(id)
    const { mkdir } = await import('fs/promises')
    const { dirname } = await import('path')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, accountKey: 'test-account', input: [{ type: 'function_call', namespace: 'openground', name: 'look', call_id: 'pending', arguments: '{}' }] }))
    expect(await chatGptConversationExists(id)).toBe(false)
    expect(await chatGptConversationExists('../../elsewhere')).toBe(false)
    const fetcher = vi.fn()
    const conversation = new ChatGptConversation({ id, resume: true, model: 'test-model', tools: [tool], fetch: fetcher, accountKey: async () => 'test-account', accessToken: async () => 'test' })
    await expect(conversation.run('resume')).rejects.toThrow(/unfinished tool/)
    expect(fetcher).not.toHaveBeenCalled()
    await rm(file)
  })

  it('cancels an incomplete stream and rejects malformed JSON/bounded oversized frames', async () => {
    let cancelled = false
    const control = new AbortController()
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const reading = (async () => { for await (const _event of readChatGptSse(body, control.signal)) { /* drain */ } })()
    control.abort()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    const bad = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: invalid\n\n')); controller.close() } })
    await expect((async () => { for await (const _event of readChatGptSse(bad)) { /* drain */ } })()).rejects.toThrow(/JSON/)
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(2 * 1024 * 1024))); controller.close() } })
    await expect((async () => { for await (const _event of readChatGptSse(oversized)) { /* drain */ } })()).rejects.toThrow(/frame exceeded/)
  })
})
