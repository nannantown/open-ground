import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, realpath } from 'fs/promises'
import { join } from 'path'
const auth = vi.hoisted(() => ({
  account: 'synthetic-account-a', provider: 'chatgpt', denied: false,
  config: { model: 'synthetic-catalog-model', effort: 'high' },
}))
vi.mock('./chatgptAuth', () => ({
  getChatGptAccountKey: async () => auth.account,
  getChatGptAccessToken: async () => 'synthetic-unit-test-token',
}))
vi.mock('./chatgptRuntime', () => ({
  swarmRunPreflight: async () => ({ ok: true }),
  chatGptLaunchConfig: async () => auth.config,
  selectedRuntime: async () => { if (auth.denied) throw new Error('owner access ended'); return auth.provider },
}))
import { chatGptAssistantModel, closeChatGptAssistant } from './chatgptAssistant'
import { ASSISTANT_TOOL_SHAPES, type AssistantAsk, type AssistantToolSet } from './assistantSession'
import { openGroundHome } from './paths'
import { registerTestProject } from '../../test/registerProject'
import { __resetAssistantMemory, askAssistant, pressProposal } from './phoneAssistant'
import { __resetProposals, openProposals, proposalHash } from './assistantProposals'
import { clearAssistantLog, clearAssistantMemory } from './assistantMemory'
import { setLockdownCache } from './lockdown'
import { setSettings } from './store'

const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const call = (name: string, args: object, id = 'call-1') => ({ type: 'function_call', namespace: 'openground', name, call_id: id, arguments: JSON.stringify(args) })
const response = (output: unknown[], delta?: string) => new Response([
  ...(delta ? [{ type: 'response.output_text.delta', delta }] : []),
  { type: 'response.completed', response: { status: 'completed', model: 'synthetic-catalog-model', output, usage: { input_tokens: 4, output_tokens: 2 } } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const requestBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>
const tools = (): AssistantToolSet => Object.fromEntries(Object.keys(ASSISTANT_TOOL_SHAPES).map((name) => [name, vi.fn(async () => ({ text: 'read or proposed result' }))])) as unknown as AssistantToolSet
const ask = (overrides: Partial<AssistantAsk> = {}): AssistantAsk => ({ key: 'same-style-and-owner-memory', system: async () => 'Private assistant instructions.', line: 'Please help.', tools: tools(), ...overrides })
const transcripts = () => readdir(join(openGroundHome(), 'chatgpt', 'conversations')).catch(() => [] as string[])

beforeEach(() => {
  closeChatGptAssistant()
  auth.account = 'synthetic-account-a'; auth.provider = 'chatgpt'; auth.denied = false
  auth.config = { model: 'synthetic-catalog-model', effort: 'high' }
})
afterEach(() => { closeChatGptAssistant(); vi.unstubAllGlobals() })

describe('the ChatGPT assistant wrapper with the real stateless transport', () => {
  it('advertises only assistant tools, preserves the proposal boundary and returns only the final words after a lookup', async () => {
    const requests: Record<string, unknown>[] = []
    const turnTools = tools()
    const proposal = { projectId: 'project-a', title: 'Small task', goal: 'Make a small change', done: ['Change can be reviewed'] }
    vi.mocked(turnTools.make_card).mockResolvedValue({ text: 'A proposal is shown. The owner must press its button.' })
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(requestBody(init))
      if (requests.length === 1) return response([message('Let me check.'), call('make_card', proposal)], 'Let me check.')
      return response([message('The proposal is ready.')], 'The proposal is ready.')
    }))
    const streamed: unknown[] = []
    const reportedModel = vi.fn()
    expect(await chatGptAssistantModel.ask(ask({ tools: turnTools, onStream: (event) => streamed.push(event), onModel: reportedModel }))).toBe('The proposal is ready.')
    const namespace = (requests[0].tools as { name: string; tools: { name: string }[] }[])[0]
    expect(namespace.name).toBe('openground')
    expect(namespace.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(ASSISTANT_TOOL_SHAPES).filter((name) => name !== 'think_deeper').sort())
    expect(namespace.tools.map((tool) => tool.name)).not.toContain('Bash')
    expect(turnTools.make_card).toHaveBeenCalledWith(proposal)
    expect(turnTools.tell_commander).not.toHaveBeenCalled()
    expect(requests[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', output: 'A proposal is shown. The owner must press its button.' })]))
    expect(streamed).toEqual([{ text: 'Let me check.' }, { tool: true }, { text: 'The proposal is ready.' }])
    expect(reportedModel).toHaveBeenCalledWith('synthetic-catalog-model')
    expect(requests.every((body) => body.store === false)).toBe(true)
  })

  it('does not invoke a proposed action after the owner/provider gate closes', async () => {
    const turnTools = tools()
    const fetcher = vi.fn(async () => {
      auth.provider = 'claude'
      return response([call('withdraw', {})])
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(chatGptAssistantModel.ask(ask({ tools: turnTools }))).rejects.toThrow('no longer selected')
    expect(turnTools.withdraw).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rechecks authorization before the inference following a tool, without falling back to Claude', async () => {
    const turnTools = tools()
    vi.mocked(turnTools.status).mockImplementation(async () => { auth.denied = true; return { text: 'Current Board state' } })
    const fetcher = vi.fn(async () => response([call('status', {})]))
    vi.stubGlobal('fetch', fetcher)
    await expect(chatGptAssistantModel.ask(ask({ tools: turnTools }))).rejects.toThrow('owner access ended')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(turnTools.status).toHaveBeenCalledOnce()
  })

  it('starts a fresh context after an account change and never writes raw assistant conversations to disk', async () => {
    const before = await transcripts()
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(requestBody(init)); return response([message('A short answer.')])
    }))
    await chatGptAssistantModel.ask(ask({ line: 'Private words for account A.' }))
    auth.account = 'synthetic-account-b'
    await chatGptAssistantModel.ask(ask({ line: 'New words for account B.' }))
    expect(JSON.stringify(requests[1].input)).not.toContain('Private words for account A.')
    expect(requests[1].input).toEqual([{ role: 'user', content: 'New words for account B.' }])
    expect(await transcripts()).toEqual(before)
  })

  it('maps an assistant image result to image tool content rather than a base64 text answer', async () => {
    const requests: Record<string, unknown>[] = []
    const turnTools = tools()
    vi.mocked(turnTools.read_file).mockResolvedValue({ image: { mimeType: 'image/png', data: 'aGVsbG8=' } })
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(requestBody(init))
      return requests.length === 1 ? response([call('read_file', { path: '/registered/photo.png' })]) : response([message('I can see the image.')])
    }))
    expect(await chatGptAssistantModel.ask(ask({ tools: turnTools }))).toBe('I can see the image.')
    expect(requests[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', output: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] })]))
  })

  it('keeps a real president proposal visible across a typed yes and relays exactly its shown words only after its button check', async () => {
    __resetAssistantMemory()
    __resetProposals()
    setLockdownCache(false)
    await clearAssistantLog()
    await clearAssistantMemory()
    await setSettings({ language: 'en' })
    await mkdir(openGroundHome(), { recursive: true })
    const cwd = await realpath(await mkdtemp(join(openGroundHome(), 'president-handoff-')))
    const projectId = await registerTestProject(cwd)
    const words = 'Please explain the current progress.'
    const requests: Record<string, unknown>[] = []
    const digest = async () => ({ text: 'A registered synthetic project.', projects: [{ id: projectId, name: 'Fixture', path: cwd }] })
    const president = vi.fn(async () => ({ ok: true as const, woke: false, waiting: 0 }))
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses')
      const body = requestBody(init)
      requests.push(body)
      const namespace = (body.tools as { name: string; tools: { name: string }[] }[])[0]
      expect(namespace.tools.some((tool) => tool.name === 'tell_president')).toBe(true)
      return requests.length === 1
        ? response([call('tell_president', { projectId, message: words })])
        : response([message('The message is ready. Press Send if it looks right.')])
    }))
    try {
      const answer = await askAssistant('Ask the Fixture president about its progress.', { model: chatGptAssistantModel, digest, via: 'screen' })
      const shown = answer.proposals?.[0]
      expect(shown).toMatchObject({ kind: 'president', projectId, title: 'To the president', body: words, state: 'open', via: 'screen' })
      expect(president).not.toHaveBeenCalled()
      expect(requests).toHaveLength(2)
      expect(requests[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', output: expect.stringContaining('only if they press its button') })]))
      await askAssistant('Yes, please send it.', { model: chatGptAssistantModel, digest, via: 'screen' })
      expect(openProposals().map((proposal) => proposal.id)).toContain(shown!.id)
      expect(president).not.toHaveBeenCalled()
      expect(await pressProposal(shown!.id, 'wrong-shown-text-check', { via: 'screen', president })).toEqual({ error: 'mismatch' })
      expect(president).not.toHaveBeenCalled()
      expect(await pressProposal(shown!.id, proposalHash(shown!), { via: 'screen', president })).toMatchObject({ proposal: { kind: 'president', state: 'done', body: words } })
      expect(president).toHaveBeenCalledExactlyOnceWith(cwd, words, expect.objectContaining({ reply: expect.any(Function), landed: expect.any(Function) }))
      expect(await pressProposal(shown!.id, proposalHash(shown!), { via: 'screen', president })).toEqual({ error: 'closed' })
      expect(president).toHaveBeenCalledOnce()
    } finally {
      __resetAssistantMemory()
      __resetProposals()
    }
  })
})
