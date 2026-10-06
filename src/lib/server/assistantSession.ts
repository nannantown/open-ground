// assistantSession — the owner's assistant as ONE live Claude session that stays
// up between lines (owner request 2026-10-06: "返答がすごく遅い … 人と会話してる
// ぐらいの速さで"). Before, every line started a fresh claude in a hidden PTY and
// waited for a file; now a line is one more user message to a session that is
// already running (Agent SDK, streaming input), on a fast model, warmed when the
// owner opens the window.
//
// Subscription only (claudeTerminal RULE 1): the SDK runs the owner's own claude
// CLI on their login, as the SDK commander and workers do. RULE 2's reasons for a
// PTY (Remote Control, screen sensors) do not apply to a session nobody sees.
//
// What it can touch: NOTHING of Claude Code's own (`tools: []` — no Read, Bash,
// Write, Edit, web), no settings, hooks or MCP from disk (`settingSources: []`,
// `strictMcpConfig`), no transcript on disk (`persistSession: false`). Its only
// tools are the in-process ones below (assistantTools.ts decides what they may
// read and do), and a PreToolUse gate denies every other name — a hook that
// throws must deny too (sdkGuardHook.ts: a throwing hook fails OPEN).
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { importSdkModule } from './sdkSession'
import { resolveUserClaudeBin, sdkSessionEnv } from './swarmWorkerSdk'
import type { ToolResult } from './assistantTools'
import type { CardInput } from './assistantProposals'

/** Fast enough to sound like talk; its tools do the looking up. */
export const ASSISTANT_MODEL = 'haiku'
/** A turn that has not finished by then is given up (the session is restarted). */
const TURN_MS = 120_000
/** Nobody talking this long: the session is closed (its claude process ends). */
const IDLE_MS = 15 * 60_000
/** Past these the next line starts a fresh session (its context stays small and fast). */
const MAX_TURNS = 40
const MAX_TOKENS = 120_000

export interface AssistantToolSet {
  read_file(a: { path: string; offset?: number; limit?: number }): Promise<ToolResult>
  list_dir(a: { path: string }): Promise<ToolResult>
  search(a: { path: string; pattern: string; glob?: string }): Promise<ToolResult>
  status(a: Record<string, never>): Promise<ToolResult>
  make_card(a: CardInput): Promise<ToolResult>
  tell_commander(a: { projectId: string; message: string }): Promise<ToolResult>
  withdraw(a: Record<string, never>): Promise<ToolResult>
}
type ToolName = keyof AssistantToolSet

export interface AssistantAsk {
  /** Changes when what the session was started with is no longer true (style,
   *  name, language, a delete): the next line then starts a fresh session. */
  key: string
  /** The system prompt, built only when a session starts. */
  system: () => Promise<string>
  /** The owner's line as the model reads it. */
  line: string
  tools: AssistantToolSet
  /** While the turn is written: `{text}` = everything written since the turn (or
   *  its last tool call) began, each time it grows; `{tool}` = a tool call starts. */
  onStream?: (e: { text: string } | { tool: true }) => void
}

/** One owner line in the live talk → the final words. Tests stand in for it. */
export interface AssistantModel {
  ask(o: AssistantAsk): Promise<string>
  /** Start (or keep) a session so the next line skips the start-up. */
  warm(o: Pick<AssistantAsk, 'key' | 'system'>): Promise<void>
}

const SHAPES = {
  read_file: { path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
  list_dir: { path: z.string() },
  search: { path: z.string(), pattern: z.string(), glob: z.string().optional() },
  status: {},
  make_card: { projectId: z.string(), title: z.string(), goal: z.string(), done: z.array(z.string()) },
  tell_commander: { projectId: z.string(), message: z.string() },
  withdraw: {},
} satisfies Record<ToolName, z.ZodRawShape>

const DESCRIPTIONS: Record<ToolName, string> = {
  read_file: 'Read a file (absolute path) in a registered project or OPEN GROUND data. Text comes with line numbers, at most 400 lines from `offset`; images come as the image. A directory is listed.',
  list_dir: 'List a directory (absolute path) in a registered project or OPEN GROUND data.',
  search: 'Find lines holding `pattern` (words taken literally, case-insensitive; "a|b" = either) in the files under a directory or in one file (absolute path). `glob` limits file names, e.g. "*.ts". node_modules, .git and build output are skipped. Code is mostly in English: when a word in the owner\'s language finds nothing, search its English words too (for 送料, try "shipping|fee").',
  status: "Every project's state right now: Board columns, what is stuck / worked on / awaiting integration, and questions waiting for the owner.",
  make_card: "PROPOSE one short work card for a project's Board: shown to the owner in a frame; only their button puts it on the Board. title, goal and done are each one short line; about 10 lines of 20 Japanese characters in all, or it is refused.",
  tell_commander: "PROPOSE one message for a project's commander: shown to the owner in a frame; only their button sends it. One line, plain words.",
  withdraw: 'Drop every proposal still waiting (the owner said stop / never mind).',
}

/** The full MCP names of the tools above — the only ones the gate lets through. */
export const ASSISTANT_TOOL_NAMES = (Object.keys(SHAPES) as ToolName[]).map((n) => `mcp__og__${n}`)

const decide = (permissionDecision: 'allow' | 'deny', reason?: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, ...(reason ? { permissionDecisionReason: reason } : {}) },
})
/** PreToolUse gate: the assistant's own tools only — anything else, or any error, is denied. */
export const assistantToolGate = async (input: unknown) => {
  try {
    const name = (input as { tool_name?: unknown } | null)?.tool_name
    return typeof name === 'string' && ASSISTANT_TOOL_NAMES.includes(name) ? decide('allow') : decide('deny', 'The assistant has only its own tools.')
  } catch {
    return decide('deny', 'The assistant has only its own tools.')
  }
}

/** The SDK options a session starts with (exported for the launch guard test). */
export const assistantSessionOptions = (o: { cwd: string; claudeBin: string; system: string; server: unknown }): Record<string, unknown> => ({
  cwd: o.cwd,
  model: ASSISTANT_MODEL,
  pathToClaudeCodeExecutable: o.claudeBin,
  env: sdkSessionEnv(),
  systemPrompt: o.system,
  tools: [],
  mcpServers: { og: o.server },
  strictMcpConfig: true,
  settingSources: [],
  allowedTools: ASSISTANT_TOOL_NAMES,
  permissionMode: 'dontAsk',
  hooks: { PreToolUse: [{ hooks: [assistantToolGate] }] },
  persistSession: false,
  thinking: { type: 'disabled' },
  // The words as they are written (stream_event), so the first sentence can be
  // read aloud before the last is written (phoneAssistant's spokenSoFar).
  includePartialMessages: true,
})

const toCall = (r: ToolResult) => ({
  content: 'image' in r ? [{ type: 'image' as const, data: r.image.data, mimeType: r.image.mimeType }] : [{ type: 'text' as const, text: r.text }],
})

/** The user messages fed to the live session, one per owner line. */
const inbox = () => {
  const items: unknown[] = []
  let wake: (() => void) | null = null
  let ended = false
  const poke = () => {
    wake?.()
    wake = null
  }
  return {
    push: (x: unknown) => (items.push(x), poke()),
    end: () => ((ended = true), poke()),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift()
        if (ended) return
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
}

interface Live {
  key: string
  q: { close?: () => void; interrupt?: () => Promise<unknown> }
  it: AsyncIterator<unknown>
  box: ReturnType<typeof inbox>
  dir: string
  turns: number
  tokens: number
  tools: AssistantToolSet | null
  idle?: ReturnType<typeof setTimeout>
  dead: boolean
}

// On globalThis: a dev reload must not orphan the running claude.
const g = globalThis as typeof globalThis & { __openground_assistant_live?: Live | null; __openground_assistant_gen?: number }

/** Which live session this is: a new number each time one starts (0 = none yet). */
export const assistantSessionGen = (): number => g.__openground_assistant_gen ?? 0

const close = (live: Live) => {
  if (live.dead) return
  live.dead = true
  if (g.__openground_assistant_live === live) g.__openground_assistant_live = null
  clearTimeout(live.idle)
  live.box.end()
  try {
    live.q.close?.()
  } catch {
    /* already gone */
  }
  // After the process has let go of its cwd (a removed cwd under a live process can wedge it).
  setTimeout(() => void rm(live.dir, { recursive: true, force: true }).catch(() => {}), 3000).unref?.()
}

const armIdle = (live: Live) => {
  clearTimeout(live.idle)
  live.idle = setTimeout(() => close(live), IDLE_MS)
  live.idle.unref?.()
}

const start = async (key: string, system: string): Promise<Live> => {
  const sdk = (await importSdkModule()) as typeof Sdk
  const claudeBin = resolveUserClaudeBin()
  if (!claudeBin) throw new Error('claude CLI not found')
  const dir = await mkdtemp(join(tmpdir(), 'openground-assistant-'))
  const box = inbox()
  const live = { key, box, dir, turns: 0, tokens: 0, tools: null, dead: false } as unknown as Live
  g.__openground_assistant_gen = assistantSessionGen() + 1
  const server = sdk.createSdkMcpServer({
    name: 'og',
    version: '1',
    tools: (Object.keys(SHAPES) as ToolName[]).map((n) =>
      sdk.tool(n, DESCRIPTIONS[n], SHAPES[n], async (args) => {
        // Tools act only inside a turn, for that turn's context.
        const t = live.tools
        return toCall(t ? await (t[n] as (a: unknown) => Promise<ToolResult>)(args) : { text: 'Not now.' })
      }),
    ),
  })
  const q = sdk.query({ prompt: box as AsyncIterable<Sdk.SDKUserMessage>, options: assistantSessionOptions({ cwd: dir, claudeBin, system, server }) as Sdk.Options })
  live.q = q
  live.it = q[Symbol.asyncIterator]()
  g.__openground_assistant_live = live
  armIdle(live)
  return live
}

type Block = { type?: string; text?: string }
type StreamEvent = { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } }
type Msg = { type?: string; subtype?: string; is_error?: boolean; result?: string; message?: { content?: Block[] }; usage?: Record<string, number>; event?: StreamEvent; parent_tool_use_id?: string | null }

/** The answer = the turn's final text. Text written before a tool call is not
 *  part of it (the app says its own "let me look" when a look-up starts — see
 *  phoneAssistant's turnTools). */
const readTurn = async (live: Live, heard: () => void, stream?: AssistantAsk['onStream']): Promise<string> => {
  let said: string[] = []
  let writing = ''
  for (;;) {
    const { value, done } = await live.it.next()
    if (done) throw new Error('the assistant session ended without an answer')
    heard()
    const m = value as Msg
    if (m.type === 'stream_event' && !m.parent_tool_use_id && stream) {
      const e = m.event
      if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        writing = ''
        stream({ tool: true })
      } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) stream({ text: (writing += e.delta.text) })
    }
    if (m.type === 'assistant')
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) said.push(b.text.trim())
        else if (b.type === 'tool_use') said = []
      }
    if (m.type === 'result') {
      // The usage of the turn's API calls (summed over a multi-tool turn, so it
      // can over-count the context — a restart then comes early, the safe side).
      const u = m.usage ?? {}
      live.tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (m.subtype !== 'success' || m.is_error) throw new Error(`claude: ${m.result ?? m.subtype ?? 'failed'}`)
      return (m.result ?? '').trim() || said.join('\n')
    }
  }
}

const usable = (live: Live | null | undefined, key: string): live is Live =>
  !!live && !live.dead && live.key === key && live.turns < MAX_TURNS && live.tokens < MAX_TOKENS

const current = async (o: Pick<AssistantAsk, 'key' | 'system'>): Promise<Live> => {
  const live = g.__openground_assistant_live
  if (usable(live, o.key)) return live
  if (live) close(live)
  return start(o.key, await o.system())
}

/** One line on `live`: the final text, or a throw (the session is closed then). */
const turnOn = async (live: Live, o: AssistantAsk, heard: () => void): Promise<string> => {
  clearTimeout(live.idle)
  live.tools = o.tools
  live.box.push({ type: 'user', message: { role: 'user', content: o.line }, parent_tool_use_id: null, session_id: '' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const text = await Promise.race([
      readTurn(live, heard, o.onStream),
      new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error('the assistant timed out')), TURN_MS))),
    ])
    live.turns++
    return text
  } catch (e) {
    // Its state is unknown now: the next line starts afresh.
    close(live)
    throw e
  } finally {
    clearTimeout(timer)
    live.tools = null
    if (!live.dead) armIdle(live)
  }
}

/** The real model: one live SDK session. Callers serialize (phoneAssistant's queue). */
export const liveAssistantModel: AssistantModel = {
  warm: async (o) => void (await current(o)),
  ask: async (o) => {
    const reused = usable(g.__openground_assistant_live, o.key)
    const ended = closedOnPurpose
    let heard = false
    try {
      return await turnOn(await current(o), o, () => (heard = true))
    } catch (e) {
      // A session that died while it sat idle is only found by the next line:
      // when nothing at all came back for it, that line gets ONE fresh session
      // instead of failing (a timeout is not retried — it already took its time;
      // nor a session ended on purpose, e.g. the owner deleted the talk it held).
      if (!reused || heard || ended !== closedOnPurpose || /timed out/.test(String((e as Error)?.message))) throw e
      return turnOn(await current(o), o, () => {})
    }
  },
}

let closedOnPurpose = 0
/** Deletes / tests / shutdown: end the live session. */
export const closeAssistantSession = (): void => {
  closedOnPurpose++
  const live = g.__openground_assistant_live
  if (live) close(live)
}
