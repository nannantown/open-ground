import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ provider: 'chatgpt', tokenError: false, claude: vi.fn() }))
vi.mock('./chatgptRuntime', () => ({
  swarmRunPreflight: async () => ({ ok: true }),
  selectedRuntime: async () => h.provider,
  chatGptLaunchConfig: async () => ({ model: 'subscription-test-model', effort: 'high' }),
}))
vi.mock('./chatgptAuth', () => ({
  getChatGptAccountKey: async () => 'test-owner-account',
  getChatGptAccessToken: async () => { if (h.tokenError) throw new Error('ChatGPT signed out'); return 'synthetic-test-token' },
}))
vi.mock('./canvasAi', async (original) => ({
  ...await original<typeof import('./canvasAi')>(),
  runFileTask: h.claude,
}))
import { foldIdleAssistantTalk, plainAssistantError, __resetAssistantMemory } from './phoneAssistant'
import { appendAssistantEntries, clearAssistantLog, clearAssistantMemory, readAssistantMemory } from './assistantMemory'
import { setLockdownCache } from './lockdown'

const response = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'subscription-test-model', output } })}\n\n`)
const oldTalk = () => appendAssistantEntries([{ at: Date.now() - 2 * 86_400_000, who: 'owner', text: 'My cat is Miki.', via: 'phone' }])

beforeEach(async () => {
  h.provider = 'chatgpt'; h.tokenError = false; h.claude.mockReset()
  __resetAssistantMemory(); setLockdownCache(false)
  await clearAssistantLog(); await clearAssistantMemory(); await oldTalk()
})
afterEach(() => vi.unstubAllGlobals())

describe('the assistant background memo follows its subscription provider', () => {
  it('saves the validated memo through ChatGPT without starting a Claude run', async () => {
    let count = 0
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      if (++count === 1) {
        const tool = body.tools[0].tools[0]
        return response([{ type: 'function_call', namespace: 'openground', name: 'Write', call_id: 'memo-1', arguments: JSON.stringify({ file_path: tool.parameters.properties.file_path.const, content: JSON.stringify({ reply: 'Saved.', memory: 'The owner has a cat named Miki.' }) }) }])
      }
      return response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved.' }] }])
    }))
    expect(await foldIdleAssistantTalk()).toBe(true)
    expect(await readAssistantMemory()).toBe('The owner has a cat named Miki.')
    expect(h.claude).not.toHaveBeenCalled()
    expect(count).toBe(2)
    expect(bodies.every((body) => body.store === false && body.model === 'subscription-test-model')).toBe(true)
  })

  it('preserves the memo and never switches to Claude when ChatGPT authentication fails', async () => {
    h.tokenError = true
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(foldIdleAssistantTalk()).rejects.toThrow('signed out')
    expect(await readAssistantMemory()).toBe('')
    expect(h.claude).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(plainAssistantError(new Error('ChatGPT signed out'), 'en').message).toContain('ChatGPT')
  })
})
