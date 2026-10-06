// The live session the assistant talks through (assistantSession.ts): what the
// claude it starts may touch, that it stays up between lines, and that a
// "let me look" said before a tool goes out ahead of the answer. The SDK module
// is replaced at its one import seam (sdkSession's importer); everything else
// is the production code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./swarmWorkerSdk', async (orig) => ({ ...(await orig<typeof import('./swarmWorkerSdk')>()), resolveUserClaudeBin: () => '/usr/local/bin/claude' }))

import { __setSdkImporterForTests } from './sdkSession'
import { ASSISTANT_TOOL_NAMES, assistantToolGate, closeAssistantSession, liveAssistantModel, type AssistantToolSet } from './assistantSession'

type Msg = Record<string, unknown>
/** A fake SDK: each query records its options, and answers each user message with the scripted messages. */
const fakeSdk = (script: (line: string, tools: Record<string, (a: unknown) => Promise<unknown>>) => Promise<Msg[]>) => {
  const queries: { options: Record<string, unknown> }[] = []
  /** Each session's message stream — returning one is the claude process dying. */
  const streams: AsyncGenerator<unknown>[] = []
  const toolDefs: Record<string, (a: unknown) => Promise<unknown>> = {}
  const mod = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: unknown) => Promise<unknown>) => ((toolDefs[name] = handler), { name }),
    createSdkMcpServer: (o: unknown) => ({ type: 'sdk', instance: o }),
    query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
      queries.push({ options })
      async function* run() {
        for await (const m of prompt) for (const out of await script(m.message.content, toolDefs)) yield out
      }
      const gen = run()
      streams.push(gen)
      return Object.assign(gen, { close: () => void gen.return(undefined) })
    },
  }
  __setSdkImporterForTests(async () => mod)
  return { queries, toolDefs, streams }
}
const said = (text: string): Msg => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolUse = (): Msg => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__og__status' }] } })
const result = (text: string): Msg => ({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10 } })

const noTools = {} as AssistantToolSet
const ask = (line: string, key = 'k', tools = noTools) => liveAssistantModel.ask({ key, system: async () => 'SYSTEM', line, tools })

beforeEach(() => closeAssistantSession())

describe('what the claude behind the assistant may touch', () => {
  it("none of Claude Code's own tools, settings or MCP; only its own tools, no bypass, no transcript, the fast model", async () => {
    const sdk = fakeSdk(async () => [result('うん')])
    await ask('やあ')
    const o = sdk.queries[0].options
    expect(o).toMatchObject({
      model: 'haiku',
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      persistSession: false,
      systemPrompt: 'SYSTEM',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
    })
    expect(o.allowedTools).toEqual(ASSISTANT_TOOL_NAMES)
    expect(Object.keys(o.mcpServers as object)).toEqual(['og'])
    expect(o).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(Object.keys(sdk.toolDefs).sort()).toEqual(['list_dir', 'make_card', 'read_file', 'search', 'status', 'tell_commander', 'withdraw'])
  })

  it('the gate lets only its own tools through — anything else, or a malformed call, is denied', async () => {
    const verdict = async (input: unknown) => (await assistantToolGate(input)).hookSpecificOutput.permissionDecision
    expect(await verdict({ tool_name: 'mcp__og__read_file' })).toBe('allow')
    for (const name of ['Read', 'Bash', 'Write', 'WebFetch', 'mcp__og__shell', 'mcp__other__read_file']) expect(await verdict({ tool_name: name })).toBe('deny')
    expect(await verdict(null)).toBe('deny')
    expect(await verdict({ get tool_name() { throw new Error('boom') } })).toBe('deny')
  })
})

describe('one live session, not a start-up per line', () => {
  it('two lines go to the same claude; a changed key (style, name, a delete) starts a fresh one', async () => {
    const sdk = fakeSdk(async (line) => [result(`re:${line}`)])
    expect(await ask('一つ目')).toBe('re:一つ目')
    expect(await ask('二つ目')).toBe('re:二つ目')
    expect(sdk.queries).toHaveLength(1)
    expect(await ask('三つ目', 'other')).toBe('re:三つ目')
    expect(sdk.queries).toHaveLength(2)
  })

  it('a failed turn closes the session: the next line starts afresh', async () => {
    let fail = true
    const sdk = fakeSdk(async () => (fail ? ((fail = false), [{ type: 'result', subtype: 'error_during_execution', is_error: true }]) : [result('ok')]))
    await expect(ask('やあ')).rejects.toThrow(/claude/)
    expect(await ask('もう一回')).toBe('ok')
    expect(sdk.queries).toHaveLength(2)
  })
})

describe('the words as they are written (read aloud a sentence at a time)', () => {
  const delta = (text: string, parent: string | null = null): Msg => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  const toolStart = (): Msg => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })

  it('the session asks for them, and the turn hands on its text as it grows; a tool call starts it over', async () => {
    const sdk = fakeSdk(async () => [delta('見て'), delta('みるね。'), toolStart(), toolUse(), delta('順調'), delta('だよ。'), delta('別', 'sub-agent'), said('順調だよ。'), result('順調だよ。')])
    const seen: unknown[] = []
    expect(await liveAssistantModel.ask({ key: 'k', system: async () => 'SYSTEM', line: 'どう?', tools: noTools, onStream: (e) => seen.push(e) })).toBe('順調だよ。')
    expect(sdk.queries[0].options.includePartialMessages).toBe(true)
    expect(seen).toEqual([{ text: '見て' }, { text: '見てみるね。' }, { tool: true }, { text: '順調' }, { text: '順調だよ。' }])
  })
})

describe('the answer is the final text of the line', () => {
  it('text written before a tool call is not part of the answer (the app says its own wait-line)', async () => {
    fakeSdk(async () => [said('ちょっと待ってね'), toolUse(), said('もう少し'), toolUse(), said('全部順調だよ。'), result('全部順調だよ。')])
    expect(await ask('状況どう?')).toBe('全部順調だよ。')
  })

  it('between lines the tools act for nobody (a late call cannot reach the last line\'s tools)', async () => {
    const sdk = fakeSdk(async () => [result('ok')])
    const seen: unknown[] = []
    await ask('やあ', 'k', { status: async (a: unknown) => (seen.push(a), { text: 'S' }) } as unknown as AssistantToolSet)
    expect(await sdk.toolDefs.status({})).toEqual({ content: [{ type: 'text', text: 'Not now.' }] })
    expect(seen).toEqual([])
  })
})

describe('how long a session lives — each bound is what keeps a process, its context and the plan from growing', () => {
  afterEach(() => vi.useRealTimers())

  it('15 quiet minutes close it; the next line starts a new one', async () => {
    vi.useFakeTimers()
    const sdk = fakeSdk(async () => [result('ok')])
    await ask('やあ')
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    await ask('まだいる?')
    expect(sdk.queries).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    await ask('おーい')
    expect(sdk.queries).toHaveLength(2)
  })

  it('40 lines, then a fresh session', async () => {
    const sdk = fakeSdk(async () => [result('ok')])
    for (let i = 0; i < 40; i++) await ask(`${i}`)
    expect(sdk.queries).toHaveLength(1)
    await ask('41')
    expect(sdk.queries).toHaveLength(2)
  })

  it('about 120k tokens of context, then a fresh session', async () => {
    let big = false
    const sdk = fakeSdk(async () => [{ ...result('ok'), usage: { input_tokens: big ? 130_000 : 10 } }])
    await ask('a')
    big = true
    await ask('b')
    expect(sdk.queries).toHaveLength(1)
    await ask('c')
    expect(sdk.queries).toHaveLength(2)
  })

  it('a line not answered in 2 minutes fails (no second try — it took its time) and the next line starts afresh', async () => {
    vi.useFakeTimers()
    let hang = false
    const sdk = fakeSdk(async () => (hang ? new Promise<Msg[]>(() => {}) : [result('ok')]))
    expect(await ask('一つ目')).toBe('ok')
    hang = true
    const late = ask('二つ目')
    const seen = expect(late).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(120_001)
    await seen
    hang = false
    // One try only for the late line (no retry), then a new session for the next.
    expect(sdk.queries).toHaveLength(1)
    expect(await ask('三つ目')).toBe('ok')
    expect(sdk.queries).toHaveLength(2)
  })

  it('a session that died while idle costs no line: nothing came back, so the line goes to one fresh session', async () => {
    const sdk = fakeSdk(async (line) => [result(`re:${line}`)])
    expect(await ask('やあ')).toBe('re:やあ')
    // The claude process ends while nobody talks.
    await sdk.streams[0].return(undefined)
    expect(await ask('まだいる?')).toBe('re:まだいる?')
    expect(sdk.queries).toHaveLength(2)
  })

  it('a session ended on purpose (the owner deleted the talk it held) is not retried with the old talk', async () => {
    let hold: ((m: Msg[]) => void) | null = null
    let held = false
    const sdk = fakeSdk(async (line) => (held ? new Promise<Msg[]>((r) => (hold = r)) : [result(`re:${line}`)]))
    expect(await ask('やあ')).toBe('re:やあ')
    held = true
    const line = ask('消される話')
    await vi.waitFor(() => expect(hold).not.toBeNull())
    // Deleted while it thinks: the session ends with nothing said back.
    closeAssistantSession()
    held = false
    hold!([])
    await expect(line).rejects.toThrow()
    expect(sdk.queries).toHaveLength(1)
  })
})
