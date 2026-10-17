// The live session the assistant talks through (assistantSession.ts): what the
// claude it starts may touch, that it stays up between lines, and that a
// "let me look" said before a tool goes out ahead of the answer. The SDK module
// is replaced at its one import seam (sdkSession's importer); everything else
// is the production code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./swarmWorkerSdk', async (orig) => ({ ...(await orig<typeof import('./swarmWorkerSdk')>()), resolveUserClaudeBin: () => '/usr/local/bin/claude' }))

import { __setSdkImporterForTests } from './sdkSession'
import { setSettings } from './store'
import { __resetQuotaForTest, isTierCooling } from './swarmQuota'
import { ASSISTANT_TOOL_NAMES, assistantToolGate, closeAssistantSession, liveAssistantModel, type AssistantToolSet } from './assistantSession'

type Msg = Record<string, unknown>
/** A fake SDK: each query records its options, and answers each user message
 *  with the scripted messages. `model` = what the query is on now (setModel
 *  switches it; each switch is recorded in `switches`). */
const fakeSdk = (script: (line: string, tools: Record<string, (a: unknown) => Promise<unknown>>, model: () => string) => Promise<Msg[]>) => {
  const queries: { options: Record<string, unknown> }[] = []
  const switches: string[] = []
  /** Each session's message stream — returning one is the claude process dying. */
  const streams: AsyncGenerator<unknown>[] = []
  const toolDefs: Record<string, (a: unknown) => Promise<unknown>> = {}
  const mod = {
    USAGE_LIMIT_ERROR_PREFIXES: ["You've hit your", "You've reached your"],
    tool: (name: string, _d: string, _s: unknown, handler: (a: unknown) => Promise<unknown>) => ((toolDefs[name] = handler), { name }),
    createSdkMcpServer: (o: unknown) => ({ type: 'sdk', instance: o }),
    query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) => {
      queries.push({ options })
      let model = String(options.model)
      async function* run() {
        for await (const m of prompt) for (const out of await script(m.message.content, toolDefs, () => model)) yield out
      }
      const gen = run()
      streams.push(gen)
      const setModel = async (m?: string) => void (switches.push(m ?? ''), (model = m ?? ''))
      return Object.assign(gen, { close: () => void gen.return(undefined), setModel })
    },
  }
  __setSdkImporterForTests(async () => mod)
  return { queries, toolDefs, streams, switches }
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
      model: 'sonnet',
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
    expect(Object.keys(sdk.toolDefs).sort()).toEqual(['list_dir', 'make_card', 'read_file', 'search', 'status', 'tell_commander', 'think_deeper', 'withdraw'])
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

describe('every line on sonnet; a line it hands to think_deeper finishes on opus, in the same session', () => {
  /** Answers name the model they were written on, as the SDK's assistant messages do. */
  const switching = (deep: (line: string) => boolean) =>
    fakeSdk(async (line, tools, model) => {
      if (deep(line)) await tools.think_deeper({})
      const text = `${model()}:${line}`
      return [{ type: 'assistant', parent_tool_use_id: null, message: { model: model(), content: [{ type: 'text', text }] } }, result(text)]
    })
  const tools = { think_deeper: async () => ({ text: 'think' }) } as unknown as AssistantToolSet
  const askWith = (line: string, seen: string[] = []) => liveAssistantModel.ask({ key: 'k', system: async () => 'S', line, tools, onModel: (m) => seen.push(m) })

  afterEach(async () => {
    __resetQuotaForTest()
    await setSettings({ swarmAllowedModels: undefined })
  })

  it('think_deeper moves the line to opus; the next line is back on sonnet; the model that answered is told', async () => {
    const sdk = switching((l) => l === '深い')
    const seen: string[] = []
    expect(await askWith('やあ', seen)).toBe('sonnet:やあ')
    expect(await askWith('深い', seen)).toBe('opus:深い')
    expect(await askWith('またね', seen)).toBe('sonnet:またね')
    expect(sdk.switches).toEqual(['opus', 'sonnet'])
    expect(seen).toEqual(['sonnet', 'opus', 'sonnet'])
    expect(sdk.queries).toHaveLength(1)
  })

  it("opus's limit is spent: the line is answered again on sonnet (the refusal is never the answer), opus cools, the next deep line stays on sonnet", async () => {
    const sdk = fakeSdk(async (line, tools, model) => {
      await tools.think_deeper({})
      if (model() !== 'opus') return [said(`${model()}:${line}`), result(`${model()}:${line}`)]
      // The CLI's refusal as it really comes (sdkEvents.test): a failed result, subtype still 'success'.
      const no = "You've reached your Opus limit · resets 5pm"
      return [said(no), { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: no }]
    })
    expect(await askWith('深い')).toBe('sonnet:深い')
    expect(isTierCooling('opus', Date.now())).toBe(true)
    expect(await askWith('もう一つ深い')).toBe('sonnet:もう一つ深い')
    // One move to opus (refused), none after it cooled.
    expect(sdk.switches).toEqual(['opus'])
  })

  it("an answer that only starts like a refusal is an answer: nothing cools", async () => {
    const sdk2 = fakeSdk(async (_line, tools) => {
      await tools.think_deeper({})
      return [said("You've hit your September target."), result("You've hit your September target.")]
    })
    expect(await askWith('どう?')).toBe("You've hit your September target.")
    expect(isTierCooling('opus', Date.now())).toBe(false)
    expect(sdk2.switches).toEqual(['opus'])
  })

  it('sonnet and haiku both off: every line on opus, never on fable; no move', async () => {
    await setSettings({ swarmAllowedModels: { fable: true, opus: true, sonnet: false, haiku: false } })
    const sdk = switching(() => true)
    expect(await askWith('深い')).toBe('opus:深い')
    expect(sdk.queries[0].options.model).toBe('opus')
    expect(sdk.switches).toEqual([])
  })

  it('opus switched off in the usable models: the deep line stays on sonnet (no switch at all)', async () => {
    await setSettings({ swarmAllowedModels: { fable: true, opus: false, sonnet: true, haiku: true } })
    const sdk = switching(() => true)
    expect(await askWith('深い')).toBe('sonnet:深い')
    expect(sdk.switches).toEqual([])
  })

  it('sonnet switched off: the session starts on the next usable model down', async () => {
    await setSettings({ swarmAllowedModels: { fable: true, opus: true, sonnet: false, haiku: true } })
    const sdk = switching(() => false)
    expect(await askWith('やあ')).toBe('haiku:やあ')
    expect(sdk.queries[0].options.model).toBe('haiku')
  })

  it('the mask changed while the session was up: the next line moves to what is allowed now', async () => {
    const sdk = switching(() => false)
    expect(await askWith('やあ')).toBe('sonnet:やあ')
    await setSettings({ swarmAllowedModels: { fable: true, opus: true, sonnet: false, haiku: true } })
    expect(await askWith('まだいる?')).toBe('haiku:まだいる?')
    expect(sdk.switches).toEqual(['haiku'])
    expect(sdk.queries).toHaveLength(1)
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
