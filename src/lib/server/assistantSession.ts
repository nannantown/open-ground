// assistantSession — the owner's assistant as ONE live Claude session that stays
// up between lines (owner request 2026-10-06: "返答がすごく遅い … 人と会話してる
// ぐらいの速さで"). Before, every line started a fresh claude in a hidden PTY and
// waited for a file; now a line is one more user message to a session that is
// already running (Agent SDK, streaming input), warmed when the owner opens the
// window.
//
// Two models, one talk (owner decision 2026-10-07: "頭の良さで、なるべく速さもキープ",
// "考えるときは opus 使ってもいいよ"): every line starts on ASSISTANT_MODEL (sonnet,
// thinking off — fast enough to sound like talk). A line that needs real thought
// is handed on by the model itself: it calls `think_deeper`, the app says a
// wait-line, and the SAME session switches to ASSISTANT_DEEP_MODEL (opus, which
// thinks) for the rest of that line (Query.setModel applies to the turn's next
// API call — measured 2026-10-07, SDK 0.3.220 / CLI 2.1.292). The next line
// starts back on the fast one. Both go through the owner's usable-models mask
// (and the swarm's limit table): no opus allowed ⇒ the line stays on sonnet.
// That is "auto". The owner can instead pick one model and/or an effort
// (Settings.assistantModel / assistantEffort, owner 2026-11-01): a picked model
// answers every line (no move); a picked effort starts the session at it.
//
// Subscription only (claudeTerminal RULE 1): the SDK runs the owner's own claude
// CLI on their login, as the SDK commander and workers do. RULE 2's reasons for a
// PTY (Remote Control, screen sensors) do not apply to a session nobody sees.
//
// What it can touch: NOTHING of Claude Code's own (`tools: []` — no Read, Bash,
// Write, Edit, web — links go through its own read_link, assistantLinks.ts), no
// settings, hooks or MCP from disk (`settingSources: []`,
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
import { assertClaudeSubscriptionLaunch } from './subscriptionOnly'
import type { ToolResult } from './assistantTools'
import type { CardInput } from './assistantProposals'
import type { ClaudeEffort } from '../types'
import { SEARCH_WHERE, type SearchWhere } from './assistantLinks'
import { getAllowedModelTiers, getSettings } from './store'
import { resolveAvailableTier } from './swarmLaunch'
import { MODEL_TIER_LADDER, isModelTier, markRateLimited, type ModelTier } from './swarmQuota'
import { matchesQuotaRefusal } from './sdkEvents'
import { selectedRuntime } from './chatgptRuntime'
import { isLocalClaudeAssistantScope } from './assistantRuntimeStore'
import { chatGptAssistantModel, closeChatGptAssistant } from './chatgptAssistant'

/** Every line starts here: fast enough to sound like talk; its tools do the looking up. */
export const ASSISTANT_MODEL = 'sonnet'
/** A line the model hands on with `think_deeper` is finished here. */
export const ASSISTANT_DEEP_MODEL = 'opus'
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
  /** A link the owner gave: a YouTube video's subtitles, or a page's text (assistantLinks.ts). */
  read_link(a: { url: string; feed?: boolean }): Promise<ToolResult>
  /** Look something up on the web, Reddit or GitHub — read only (assistantLinks.ts). */
  web_search(a: { where: SearchWhere; query: string }): Promise<ToolResult>
  make_card(a: CardInput): Promise<ToolResult>
  tell_commander(a: { projectId: string; message: string }): Promise<ToolResult>
  tell_president(a: { projectId: string; message: string }): Promise<ToolResult>
  withdraw(a: Record<string, never>): Promise<ToolResult>
  /** The line needs real thought: the session moves to the deep model first (here). */
  think_deeper(a: Record<string, never>): Promise<ToolResult>
}
type ToolName = keyof AssistantToolSet

export interface AssistantAsk {
  /** Recheck the admitted owner/epoch immediately before native launch/input. */
  authorize?: () => Promise<void>
  runtimeOwnerKey?: string
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
  /** The model that wrote the line's answer (the SDK's model id), once it is done. */
  onModel?: (model: string) => void
}

/** One owner line in the live talk → the final words. Tests stand in for it. */
export interface AssistantModel {
  ask(o: AssistantAsk): Promise<string>
  /** Start (or keep) a session so the next line skips the start-up. */
  warm(o: Pick<AssistantAsk, 'key' | 'system' | 'authorize' | 'runtimeOwnerKey'>): Promise<void>
}

export const ASSISTANT_TOOL_SHAPES = {
  read_file: { path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
  list_dir: { path: z.string() },
  search: { path: z.string(), pattern: z.string(), glob: z.string().optional() },
  status: {},
  read_link: { url: z.string(), feed: z.boolean().optional() },
  web_search: { where: z.enum(SEARCH_WHERE), query: z.string() },
  make_card: { projectId: z.string(), title: z.string(), goal: z.string(), done: z.array(z.string()) },
  tell_commander: { projectId: z.string(), message: z.string() },
  tell_president: { projectId: z.string(), message: z.string() },
  withdraw: {},
  think_deeper: {},
} satisfies Record<ToolName, z.ZodRawShape>

export const ASSISTANT_TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_file: 'Read a file (absolute path) in a registered project or OPEN GROUND data. Text comes with line numbers, at most 400 lines from `offset`; images come as the image. A directory is listed.',
  list_dir: 'List a directory (absolute path) in a registered project or OPEN GROUND data.',
  search: 'Find lines holding `pattern` (words taken literally, case-insensitive; "a|b" = either) in the files under a directory or in one file (absolute path). `glob` limits file names, e.g. "*.ts". node_modules, .git and build output are skipped. Code is mostly in English: when a word in the owner\'s language finds nothing, search its English words too (for 送料, try "shipping|fee").',
  status: "Every project's state right now: Board columns, what is stuck / worked on / awaiting integration, and questions waiting for the owner.",
  read_link:
    "Read a link the owner wrote in their own words: a YouTube video comes as its subtitles, a Reddit thread with its comments, a GitHub repo (README) or issue, a feed's items (`feed: true` when it is a feed without .rss/.xml in its name), any other page as its text. Read only; long ones are cut. Says so plainly when it can't be read (no subtitles, page unreachable, channel not set up on this computer).",
  web_search:
    'Search, read only: `where` "web" (the web), "reddit" (Reddit threads) or "github" (GitHub repositories); `query` is one short line of words. Use it when the owner asks what is out there, what people say, or for news. Says so plainly when that channel is not set up on this computer.',
  make_card: "PROPOSE one short work card for a project's Board: shown to the owner in a frame; only their button puts it on the Board. title, goal and done are each one short line; about 10 lines of 20 Japanese characters in all, or it is refused.",
  tell_commander: "PROPOSE one message for a project's commander: shown to the owner in a frame; only their button sends it. One line, plain words.",
  tell_president:
    "PROPOSE one message or question for a project's president: shown to the owner in a frame; only their button sends it, and the president's answer comes back to you as an App note. One line, plain words.",
  withdraw: 'Drop every proposal still waiting (the owner said stop / never mind).',
  think_deeper:
    'Hand THIS line to a stronger, slower model before answering. Call it FIRST — nothing written before it — when the line needs real thought: advice or a decision with trade-offs, comparing options, planning, a why about their work, or digging through several files to answer. Never for small talk, a simple fact or one quick look-up.',
}

/** The full MCP names of the tools above — the only ones the gate lets through. */
const SHAPES = ASSISTANT_TOOL_SHAPES
const DESCRIPTIONS = ASSISTANT_TOOL_DESCRIPTIONS
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
export const assistantSessionOptions = (o: { cwd: string; claudeBin: string; env: NodeJS.ProcessEnv; system: string; server: unknown; model?: string; effort?: ClaudeEffort }): Record<string, unknown> => ({
  cwd: o.cwd,
  model: o.model ?? ASSISTANT_MODEL,
  pathToClaudeCodeExecutable: o.claudeBin,
  env: o.env,
  systemPrompt: o.system,
  tools: [],
  mcpServers: { og: o.server },
  strictMcpConfig: true,
  settingSources: [],
  allowedTools: ASSISTANT_TOOL_NAMES,
  permissionMode: 'dontAsk',
  hooks: { PreToolUse: [{ hooks: [assistantToolGate] }] },
  persistSession: false,
  // Auto: off for the fast model's turns. The deep model thinks anyway once the
  // session is switched to it (seen 2026-10-07: opus wrote a thinking block).
  // An effort the owner picked: thinking is left to the CLI's default for the
  // model (adaptive where supported), guided by that effort.
  ...(o.effort ? { effort: o.effort } : { thinking: { type: 'disabled' } }),
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
  q: { close?: () => void; interrupt?: () => Promise<unknown>; setModel?: (m?: string) => Promise<void> }
  /** The model the session is on now. */
  model: string
  /** Where `think_deeper` moves this line (= `model` when nothing better is usable). */
  deep: string
  /** The effort the session was started at (fixed for its life). */
  effort?: ClaudeEffort
  it: AsyncIterator<unknown>
  box: ReturnType<typeof inbox>
  dir: string
  turns: number
  tokens: number
  tools: AssistantToolSet | null
  authorize?: () => Promise<void>
  idle?: ReturnType<typeof setTimeout>
  dead: boolean
  /** The SDK's own usage-limit refusal wording (USAGE_LIMIT_ERROR_PREFIXES). */
  refusals: readonly string[]
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

/** The two models as the owner's usable-models mask (and the swarm's limit table)
 *  allow them right now: the fast one, and the one a deep line moves to — opus
 *  switched off or spent ⇒ sonnet, i.e. no move. */
export const assistantModels = async (now = Date.now()): Promise<{ base: string; deep: string; effort?: ClaudeEffort }> => {
  const allowed = await getAllowedModelTiers()
  // The owner's pick (Settings.assistantModel / assistantEffort): one model for
  // the whole line, no move. A pick the mask turns off reads as auto; a spent one
  // walks down like any launch.
  const { assistantModel: pick, assistantEffort: effort } = await getSettings()
  if (pick && allowed[pick]) {
    const m = resolveAvailableTier(pick, now, allowed) ?? pick
    return { base: m, deep: m, effort }
  }
  const deep = resolveAvailableTier(ASSISTANT_DEEP_MODEL, now, allowed) ?? ASSISTANT_MODEL
  const fast = resolveAvailableTier(ASSISTANT_MODEL, now, allowed) ?? deep
  // Never above the deep one: with sonnet and haiku both off or spent the walk
  // goes UP (to fable) — then every line is on the deep model instead.
  const rank = (t: string) => MODEL_TIER_LADDER.indexOf(t as ModelTier)
  return { base: rank(fast) < rank(deep) ? deep : fast, deep, effort }
}

/** `think_deeper`: the rest of the line on the deep model. A failed switch
 *  leaves it on the fast one (the line is still answered). */
const deepen = async (live: Live) => {
  if (live.deep === live.model || !live.q.setModel) return
  try {
    await live.q.setModel(live.deep)
    live.model = live.deep
  } catch {
    /* stays on the fast model */
  }
}

const start = async (key: string, system: string, authorize?: () => Promise<void>): Promise<Live> => {
  const { base, effort } = await assistantModels()
  const sdk = (await importSdkModule()) as typeof Sdk & { USAGE_LIMIT_ERROR_PREFIXES?: string[] }
  const claudeBin = resolveUserClaudeBin()
  if (!claudeBin) throw new Error('claude CLI not found')
  const dir = await mkdtemp(join(tmpdir(), 'openground-assistant-'))
  const box = inbox()
  const live = { key, box, dir, turns: 0, tokens: 0, tools: null, dead: false, model: base, deep: base, effort, refusals: sdk.USAGE_LIMIT_ERROR_PREFIXES ?? [] } as unknown as Live
  const server = sdk.createSdkMcpServer({
    name: 'og',
    version: '1',
    tools: (Object.keys(SHAPES) as ToolName[]).map((n) =>
      sdk.tool(n, DESCRIPTIONS[n], SHAPES[n], async (args) => {
        // Tools act only inside a turn, for that turn's context.
        const t = live.tools
        if (!t) return toCall({ text: 'Not now.' })
        await live.authorize?.()
        // think_deeper: its wait-line goes out first, then the switch.
        const r = await (t[n] as (a: unknown) => Promise<ToolResult>)(args)
        await live.authorize?.()
        if (n === 'think_deeper') await deepen(live)
        return toCall(r)
      }),
    ),
  })
  let q: ReturnType<typeof sdk.query>
  try {
    // This assistant owns its query rather than using the SDK pool wrapper.
    // Verify its exact executable/cwd and retain the returned child overlay so
    // an ambient API credential cannot become a paid fallback at this boundary.
    const env = await assertClaudeSubscriptionLaunch(dir, { ...sdkSessionEnv(), OPENGROUND_CLAUDE_BIN: claudeBin })
    await authorize?.()
    q = sdk.query({ prompt: box as AsyncIterable<Sdk.SDKUserMessage>, options: assistantSessionOptions({ cwd: dir, claudeBin, env, system, server, model: base, effort }) as Sdk.Options })
  } catch (error) { box.end(); await rm(dir, { recursive: true, force: true }); throw error }
  g.__openground_assistant_gen = assistantSessionGen() + 1
  live.q = q
  live.it = q[Symbol.asyncIterator]()
  g.__openground_assistant_live = live
  armIdle(live)
  return live
}

type Block = { type?: string; text?: string }
type StreamEvent = { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } }
type Msg = { type?: string; subtype?: string; is_error?: boolean; terminal_reason?: string; result?: string; message?: { content?: Block[]; model?: string }; usage?: Record<string, number>; event?: StreamEvent; parent_tool_use_id?: string | null }

/** The answer = the turn's final text. Text written before a tool call is not
 *  part of it (the app says its own "let me look" when a look-up starts — see
 *  phoneAssistant's turnTools). */
const readTurn = async (live: Live, heard: () => void, stream?: AssistantAsk['onStream']): Promise<{ text: string; model: string; refused?: string }> => {
  let said: string[] = []
  let model = live.model
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
    if (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.model) model = m.message.model
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
      // A usage-limit refusal comes as a FAILED result (is_error, terminal_reason
      // api_error, subtype still 'success' — sdkEvents.test's fixture) worded with
      // the SDK's own prefixes; an answer that merely starts "You've hit your…" is
      // a success and stays an answer.
      const failed = m.subtype !== 'success' || m.is_error || m.terminal_reason === 'api_error'
      if (failed && m.result && matchesQuotaRefusal(m.result, live.refusals)) return { text: '', model, refused: m.result }
      if (m.subtype !== 'success' || m.is_error) throw new Error(`claude: ${m.result ?? m.subtype ?? 'failed'}`)
      return { text: (m.result ?? '').trim() || said.join('\n'), model }
    }
  }
}

const usable = (live: Live | null | undefined, key: string): live is Live =>
  !!live && !live.dead && live.key === key && live.turns < MAX_TURNS && live.tokens < MAX_TOKENS

const current = async (o: Pick<AssistantAsk, 'key' | 'system' | 'authorize'>): Promise<Live> => {
  const live = g.__openground_assistant_live
  // A changed effort needs a new session (it is set at start).
  if (usable(live, o.key) && live.effort === (await assistantModels()).effort) return live
  if (live) close(live)
  return start(o.key, await o.system(), o.authorize)
}

/** One line on `live`: the final text, or a throw (the session is closed then). */
const turnOn = async (live: Live, o: AssistantAsk, heard: () => void): Promise<string> => {
  clearTimeout(live.idle)
  let timer: ReturnType<typeof setTimeout> | undefined
  let base = live.model
  try {
    const text = await Promise.race([
      (async () => {
        // Each line starts on the fast model (the last one may have gone deep), as the mask allows now.
        const m = await assistantModels()
        base = m.base
        if (live.model !== base && live.q.setModel) {
          await live.q.setModel(base)
          live.model = base
        }
        // Timed out (and closed) meanwhile: the line never goes in.
        if (live.dead) throw new Error('the assistant session ended')
        await o.authorize?.()
        if (live.dead) throw new Error('the assistant session ended')
        live.deep = m.deep
        live.tools = o.tools
        live.authorize = o.authorize
        live.box.push({ type: 'user', message: { role: 'user', content: o.line }, parent_tool_use_id: null, session_id: '' })
        return readTurn(live, heard, o.onStream)
      })(),
      new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error('the assistant timed out')), TURN_MS))),
    ])
    // The deep model's limit is spent ("You've reached your Opus limit"): told
    // to the limit table (the next lines then stay on the fast model — the
    // swarm's too), and this line is answered again on the fast one (ask).
    if (text.refused) {
      if (live.model === base || !isModelTier(live.model)) throw new Error(`claude: ${text.refused}`)
      markRateLimited(live.model, { ptyText: text.refused, now: Date.now() })
      throw new DeepRefused(text.refused)
    }
    live.turns++
    // Which model answered — for the log (phoneAssistant writes it next to the answer).
    console.info(`[assistant] answered by ${text.model}${live.model !== base ? ' (thought deeper)' : ''}`)
    o.onModel?.(text.model)
    return text.text
  } catch (e) {
    // Its state is unknown now: the next line starts afresh.
    close(live)
    throw e
  } finally {
    clearTimeout(timer)
    live.tools = null
    live.authorize = undefined
    if (!live.dead) armIdle(live)
  }
}

class DeepRefused extends Error {}

/** The real model: one live SDK session. Callers serialize (phoneAssistant's queue). */
const claudeAssistantModel: AssistantModel = {
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
      if (e instanceof DeepRefused && ended === closedOnPurpose) return turnOn(await current(o), o, () => {})
      if (!reused || heard || ended !== closedOnPurpose || /timed out/.test(String((e as Error)?.message))) throw e
      return turnOn(await current(o), o, () => {})
    }
  },
}

let closedOnPurpose = 0

/** The owner's choice is checked at every turn, including after logout or a
 * work-mode change. Each provider keeps its own context and spending boundary. */
export const liveAssistantModel: AssistantModel = {
  warm: async (o) => {
    const provider = await selectedRuntime('assistant')
    if (isLocalClaudeAssistantScope() && provider !== 'claude') throw new Error('Owner sign-in is required for ChatGPT.')
    if (provider === 'chatgpt') {
      const live = g.__openground_assistant_live
      if (live) close(live)
      return chatGptAssistantModel.warm(o)
    }
    closeChatGptAssistant()
    return claudeAssistantModel.warm(o)
  },
  ask: async (o) => {
    const provider = await selectedRuntime('assistant')
    if (isLocalClaudeAssistantScope() && provider !== 'claude') throw new Error('Owner sign-in is required for ChatGPT.')
    if (provider === 'chatgpt') {
      const live = g.__openground_assistant_live
      if (live) close(live)
      return chatGptAssistantModel.ask(o)
    }
    closeChatGptAssistant()
    return claudeAssistantModel.ask(o)
  },
}
/** Deletes / tests / shutdown: end the live session. */
export const closeAssistantSession = (): void => {
  closedOnPurpose++
  closeChatGptAssistant()
  const live = g.__openground_assistant_live
  if (live) close(live)
}
