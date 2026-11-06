// Stateless Responses transport. Only host function tools are advertised; no
// provider-native shell, filesystem, browser, or MCP capability is enabled.
import { randomUUID } from 'crypto'
import { mkdir, open, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { openGroundHome } from './paths'
import { getChatGptAccessToken, getChatGptAccountKey } from './chatgptAuth'
import { ChatGptQuotaError, markChatGptRateLimited } from './chatgptQuota'
import type { SdkEvent, SdkTurnUsage } from './sdkEvents'
import { atomicWriteJson } from './atomicWrite'
import { ChatGptHostOutcomeUncertainError } from './chatgptTools'

export interface ChatGptTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  invoke(args: unknown, signal: AbortSignal): Promise<unknown>
}

type Item = Record<string, unknown>
export interface ChatGptConversationOptions {
  id?: string
  cwd?: string
  /** The assistant already owns its approved log/memory; do not persist tool data. */
  persist?: boolean
  resume?: boolean
  model: string
  effort?: string
  instructions?: string
  tools: ChatGptTool[]
  fetch?: typeof fetch
  accessToken?: () => Promise<string>
  accountKey?: () => Promise<string>
  /** Recheck owner/provider/work mode before each network request. */
  authorize?: () => Promise<void>
  storeDir?: string
  maxHistoryBytes?: number
  maxToolRounds?: number
  requestTimeoutMs?: number
}
export interface ChatGptRunOptions {
  signal?: AbortSignal
  onText?: (delta: string) => void
  onEvent?: (event: SdkEvent) => void
  /** A persistent actor may continue the SAME accepted turn after a bounded
   * batch of confirmed tools. No turn_end/input settlement happens here.
   * Without this host callback, short-lived reviewers retain their hard cap. */
  onCheckpoint?: () => Promise<void>
}
export interface ChatGptRunResult { text: string; model: string; usage: SdkTurnUsage }
export class ChatGptResponseError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly code?: string) {
    super(message)
    this.name = 'ChatGptResponseError'
  }
}

const ENDPOINT = 'https://api.openai.com/v1/responses'
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024
const MAX_HISTORY_BYTES = 2 * 1024 * 1024
const validId = (id: string): boolean => /^chatgpt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const abortError = () => new DOMException('ChatGPT turn stopped', 'AbortError')
const signalError = (signal?: AbortSignal): Error => signal?.reason instanceof Error ? signal.reason : abortError()
const object = (v: unknown): v is Item => !!v && typeof v === 'object' && !Array.isArray(v)
const shortError = (v: unknown): string => (v instanceof Error ? v.message : String(v)).slice(0, 800)
const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const usageOf = (raw: unknown): SdkTurnUsage => {
  const u = object(raw) ? raw : {}
  const details = object(u.input_tokens_details) ? u.input_tokens_details : {}
  return { inputTokens: number(u.input_tokens), outputTokens: number(u.output_tokens), cacheReadTokens: number(details.cached_tokens), cacheCreationTokens: 0, costUsd: null }
}
const sumUsage = (a: SdkTurnUsage, b: SdkTurnUsage): SdkTurnUsage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: 0, costUsd: null })
export const chatGptConversationFile = (id: string, storeDir?: string): string => {
  if (!validId(id)) throw new Error('Invalid ChatGPT conversation id')
  return join(storeDir ?? join(openGroundHome(), 'chatgpt', 'conversations'), `${id}.json`)
}
const unresolvedTool = (items: Item[]): boolean => {
  const returned = new Set(items.filter((item) => item.type === 'function_call_output').map((item) => item.call_id))
  return items.some((item) => item.type === 'function_call' && !returned.has(item.call_id))
}
const validHistoryItem = (item: Item): boolean => {
  if (item.role === 'user' && typeof item.content === 'string') return true
  if (item.type === 'reasoning') return typeof item.encrypted_content === 'string' || Array.isArray(item.summary)
  if (item.type === 'message') return item.role === 'assistant' && Array.isArray(item.content) && item.content.every((part) => object(part) && ((part.type === 'output_text' && typeof part.text === 'string') || (part.type === 'refusal' && typeof part.refusal === 'string')))
  if (item.type === 'function_call') return item.namespace === 'openground' && typeof item.name === 'string' && typeof item.call_id === 'string' && typeof item.arguments === 'string'
  if (item.type === 'function_call_output') return typeof item.call_id === 'string' && (typeof item.output === 'string' || Array.isArray(item.output))
  return false
}
const streamedOutputIndex = (event: Item): number => {
  const index = event.output_index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 4096) throw new ChatGptResponseError('ChatGPT returned an invalid streamed output index')
  return index
}
const validStreamedItem = (item: unknown): item is Item => object(item)
  && (item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call')
  && (item.id === undefined || (typeof item.id === 'string' && !!item.id))
const validCompletedStreamedItem = (item: unknown): item is Item => {
  if (!validStreamedItem(item) || !validHistoryItem(item) || (item.status !== undefined && item.status !== 'completed')) return false
  if (item.type !== 'function_call') return true
  if (typeof item.name !== 'string' || !item.name || typeof item.call_id !== 'string' || !item.call_id) return false
  try { return object(JSON.parse(item.arguments as string)) } catch { return false }
}
const readHistory = async (file: string, maxBytes = MAX_HISTORY_BYTES, allowUnresolved = false): Promise<{ input: Item[]; accountKey: string }> => {
  const handle = await open(file, 'r')
  let source: string
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maxBytes + 1024) throw new Error('ChatGPT history file exceeds its limit')
    const data = Buffer.alloc(maxBytes + 1025)
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead > maxBytes + 1024) throw new Error('ChatGPT history file exceeds its limit')
    source = data.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
  const parsed: unknown = JSON.parse(source)
  if (!object(parsed) || parsed.version !== 1 || typeof parsed.accountKey !== 'string' || !parsed.accountKey || !Array.isArray(parsed.input) || !parsed.input.every((item): item is Item => object(item) && validHistoryItem(item))) throw new Error('Invalid ChatGPT conversation history')
  if (Buffer.byteLength(JSON.stringify(parsed.input)) > maxBytes) throw new Error('ChatGPT history file exceeds its limit')
  if (!allowUnresolved && unresolvedTool(parsed.input)) throw new ChatGptUncertainActionError()
  return { input: parsed.input, accountKey: parsed.accountKey }
}
export const chatGptConversationExists = async (id: string): Promise<boolean> => {
  try { const saved = await readHistory(chatGptConversationFile(id)); return saved.accountKey === await getChatGptAccountKey() } catch { return false }
}
export class ChatGptUncertainActionError extends Error {
  constructor() { super('ChatGPT history contains an unfinished tool call. Inspect its result before starting a new conversation.'); this.name = 'ChatGptUncertainActionError' }
}
export const chatGptConversationRecovery = async (id: string): Promise<'missing' | 'resumable' | 'uncertain' | 'invalid'> => {
  try { const saved = await readHistory(chatGptConversationFile(id)); return saved.accountKey === await getChatGptAccountKey() ? 'resumable' : 'invalid' }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return error instanceof ChatGptUncertainActionError ? 'uncertain' : 'invalid'
  }
}
type PublicConversationLine = { kind: 'input' | 'text'; text: string }
const publicConversationFile = (id: string, storeDir?: string) => chatGptConversationFile(id, storeDir).replace(/\.json$/, '.public.json')
const assertPublicLines: (lines: unknown) => asserts lines is PublicConversationLine[] = (lines) => {
  if (!Array.isArray(lines) || lines.length > 20_000 || lines.some((line) => !object(line) || (line.kind !== 'input' && line.kind !== 'text') || typeof line.text !== 'string') || Buffer.byteLength(JSON.stringify(lines)) > 256 * 1024) throw new Error('The public conversation needs an approved summary before handoff. Its native history was retained.')
}
/** Shared public words only. Tool outputs and reasoning never cross providers. */
export const chatGptPublicConversation = async (id: string, options: { accountKey?: () => Promise<string>; storeDir?: string } = {}): Promise<PublicConversationLine[]> => {
  const saved = await readHistory(chatGptConversationFile(id, options.storeDir))
  if (saved.accountKey !== await (options.accountKey ?? getChatGptAccountKey)()) throw new Error('The ChatGPT account changed.')
  let sidecar: string
  try { sidecar = await readFile(publicConversationFile(id, options.storeDir), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const legacy: PublicConversationLine[] = []
    for (const item of saved.input) {
      if (item.role === 'user' && typeof item.content === 'string') legacy.push({ kind: 'input', text: item.content })
      if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) for (const part of item.content) if (object(part) && part.type === 'output_text' && typeof part.text === 'string') legacy.push({ kind: 'text', text: part.text })
    }
    assertPublicLines(legacy)
    return legacy
  }
  if (Buffer.byteLength(sidecar) > 256 * 1024 + 2048) throw new Error('The public conversation exceeds its inspection limit.')
  const record: unknown = JSON.parse(sidecar)
  if (!object(record) || record.version !== 1 || record.accountKey !== saved.accountKey || record.overflow === true) throw new Error('The public conversation needs inspection before handoff.')
  assertPublicLines(record.lines)
  return record.lines.map(({ kind, text }) => ({ kind, text }))
}
/** The SDK capture excludes host-generated kickoff prompts, preserving its seed
 * separately so repeated switches/restarts cannot amplify old handoff prompts. */
export const saveChatGptPublicConversation = async (id: string, lines: PublicConversationLine[], overflow = false, options: { accountKey?: () => Promise<string>; storeDir?: string } = {}): Promise<void> => {
  assertPublicLines(lines)
  const saved = await readHistory(chatGptConversationFile(id, options.storeDir))
  if (saved.accountKey !== await (options.accountKey ?? getChatGptAccountKey)()) throw new Error('The ChatGPT account changed.')
  await atomicWriteJson(publicConversationFile(id, options.storeDir), { version: 1, accountKey: saved.accountKey, lines, overflow }, { mode: 0o600, fsync: true })
}
export const listChatGptUncertainActions = async (): Promise<{ conversationId: string; callId: string; tool: string }[]> => {
  const dir = join(openGroundHome(), 'chatgpt', 'conversations')
  let names: string[]
  try { names = await readdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  names = names.filter(name => name.endsWith('.json') && validId(name.slice(0, -5)))
  if (names.length > 4096) throw new Error('ChatGPT recovery history exceeds its inspection limit.')
  const issues: { conversationId: string; callId: string; tool: string }[] = []
  const account = await getChatGptAccountKey()
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!validId(id)) continue
    const saved = await readHistory(chatGptConversationFile(id), MAX_HISTORY_BYTES, true)
    if (saved.accountKey !== account) continue
    const returned = new Set(saved.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id))
    for (const item of saved.input) if (item.type === 'function_call' && !returned.has(item.call_id)) issues.push({ conversationId: id, callId: item.call_id as string, tool: item.name as string })
  }
  return issues
}
/** An explicit owner review replaces no effect and fabricates no tool success. */
const reviewChatGptAction = async (id: string, callId: string, note: string, operationId: string, expectedOwnerKey?: string): Promise<void> => {
  const { runtimeOwnerKey } = await import('./runtimeOwner')
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  if (note.length > 1000) throw new Error('Review note is too long.')
  const file = chatGptConversationFile(id)
  const { isAgentConversationOccupied } = await import('./liveDesks')
  if (isAgentConversationOccupied(id)) throw new Error('The conversation is still in use. Wait until its actor has stopped before reviewing the result.')
  const saved = await readHistory(file, MAX_HISTORY_BYTES, true)
  if (saved.accountKey !== await getChatGptAccountKey()) throw new Error('The ChatGPT account changed.')
  const call = saved.input.find((item) => item.type === 'function_call' && item.call_id === callId)
  const existing = saved.input.find((item) => item.type === 'function_call_output' && item.call_id === callId)
  if (existing && typeof existing.output === 'string') {
    const result: unknown = JSON.parse(existing.output)
    if (object(result) && result.ownerReviewed === true && result.operationId === operationId && result.note === note) return
  }
  if (!call || existing) throw new Error('The action receipt changed. Refresh before reviewing it.')
  saved.input.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ ownerReviewed: true, operationId, result: 'The owner inspected the actual work. No automatic replay was performed.', note }) })
  if (Buffer.byteLength(JSON.stringify(saved.input)) > MAX_HISTORY_BYTES) throw new Error('ChatGPT history exceeds its size limit.')
  await runtimeOwnerKey(owner)
  if (isAgentConversationOccupied(id)) throw new Error('The conversation became occupied before its review could be saved.')
  await atomicWriteJson(file, { version: 1, accountKey: saved.accountKey, input: saved.input }, { mode: 0o600, fsync: true })
}
const reviewWriters = new Map<string, Promise<unknown>>()
export const reviewChatGptUncertainAction = async (id: string, callId: string, note: string, operationId: string, expectedOwnerKey?: string): Promise<void> => {
  const key = chatGptConversationFile(id)
  const result = (reviewWriters.get(key) ?? Promise.resolve()).catch(() => {}).then(() => reviewChatGptAction(id, callId, note, operationId, expectedOwnerKey))
  reviewWriters.set(key, result)
  try { await result } finally { if (reviewWriters.get(key) === result) reviewWriters.delete(key) }
}
const retryAt = (response: Response): number | undefined => {
  const retry = response.headers.get('retry-after')
  if (!retry) return undefined
  const seconds = Number(retry)
  const at = Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000 : Date.parse(retry)
  return Number.isFinite(at) && at > Date.now() ? at : undefined
}

/** Incremental SSE decoding: bounded even when a peer never sends a separator. */
export async function* readChatGptSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Item> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      if (signal?.aborted) throw signalError(signal)
      const chunk = await reader.read()
      if (signal?.aborted) throw signalError(signal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new ChatGptResponseError('ChatGPT response exceeded the stream limit')
      buffer += decoder.decode(chunk.value, { stream: true })
      // Normalize CRLF only after both bytes have arrived.
      buffer = buffer.replace(/\r\n/g, '\n')
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end < 0) break
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new ChatGptResponseError('ChatGPT SSE frame exceeded the limit')
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n')
        if (!data || data === '[DONE]') continue
        let parsed: unknown
        try { parsed = JSON.parse(data) } catch { throw new ChatGptResponseError('ChatGPT returned invalid SSE JSON') }
        if (!object(parsed) || typeof parsed.type !== 'string') throw new ChatGptResponseError('ChatGPT returned an invalid SSE event')
        yield parsed
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new ChatGptResponseError('ChatGPT SSE frame exceeded the limit')
    }
    if (buffer.trim()) throw new ChatGptResponseError('ChatGPT stream ended inside an SSE frame')
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const responseError = (raw: unknown, status: number | null = null): Error => {
  const root = object(raw) ? raw : {}
  const err = object(root.error) ? root.error : root
  const code = typeof err.code === 'string' ? err.code : undefined
  const message = typeof err.message === 'string' ? err.message.slice(0, 800) : 'ChatGPT request failed'
  if (status === 429 || code === 'subscription_sharing_usage_limit_exceeded' || code === 'insufficient_quota' || code === 'usage_limit_reached' || code === 'rate_limit_exceeded') {
    const until = Date.now() + 20 * 60_000
    markChatGptRateLimited(until)
    return new ChatGptQuotaError(until)
  }
  return new ChatGptResponseError(message, status, code)
}

/** Own local history: no previous_response_id, no server-side conversation store. */
export class ChatGptConversation {
  readonly id: string
  private history: Item[] = []
  private loaded = false
  private busy = false
  private closed = false
  private settlementRequired = false
  private active: AbortController | null = null
  private accountKey: string | null = null
  private readonly tools: Map<string, ChatGptTool>
  constructor(private readonly options: ChatGptConversationOptions) {
    this.id = options.id ?? `chatgpt-${randomUUID()}`
    if (!validId(this.id)) throw new Error('Invalid ChatGPT conversation id')
    if (options.maxToolRounds !== undefined && (!Number.isSafeInteger(options.maxToolRounds) || options.maxToolRounds < 1)) throw new Error('Invalid ChatGPT tool round budget')
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]))
    if (this.tools.size !== options.tools.length || options.tools.some((tool) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name))) throw new Error('Invalid or duplicate ChatGPT tool name')
  }
  private file(): string { return chatGptConversationFile(this.id, this.options.storeDir) }
  private checkSize(items: Item[]): void {
    if (Buffer.byteLength(JSON.stringify(items)) > (this.options.maxHistoryBytes ?? MAX_HISTORY_BYTES)) throw new ChatGptResponseError('ChatGPT conversation reached its context limit; start a new conversation. Its history has been preserved.')
  }
  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.options.resume && this.options.persist !== false) {
      // A crash after a host action but before its receipt cannot authorize a
      // repeated action. Preserve the file and require the owner to inspect it.
      const saved = await readHistory(this.file(), this.options.maxHistoryBytes)
      this.history = saved.input
      this.accountKey = saved.accountKey
    }
    this.loaded = true
  }
  private async save(): Promise<void> {
    this.checkSize(this.history)
    if (this.options.persist === false) return
    const file = this.file()
    const dir = this.options.storeDir ?? join(openGroundHome(), 'chatgpt', 'conversations')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await atomicWriteJson(file, { version: 1, accountKey: this.accountKey, input: this.history }, { mode: 0o600, fsync: true })
  }
  close(): void { this.closed = true; this.active?.abort() }
  interrupt(): void { this.active?.abort() }
  /** A cancelled generation can accept another turn; an unconfirmed host
   * effect cannot. Persist the control boundary before releasing its input. */
  async settleInterruptedTurn(reason: 'owner' | 'quota' = 'owner'): Promise<boolean> {
    if (this.busy || this.closed || unresolvedTool(this.history)) return false
    this.history.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reason === 'owner' ? '[OPEN GROUND control: the owner stopped this turn. Do not continue its request unless the owner asks again.]' : '[OPEN GROUND control: the plan usage limit stopped this turn before completion. Do not retry it without an owner choice. No paid fallback is allowed.]' }] })
    await this.save()
    this.settlementRequired = false
    return true
  }
  private async verifyAccount(): Promise<void> {
    const current = await (this.options.accountKey ?? getChatGptAccountKey)()
    if (!current || (this.accountKey !== null && this.accountKey !== current)) {
      this.closed = true
      throw new Error('ChatGPT connection changed. Start a new conversation for this account.')
    }
    this.accountKey ??= current
  }
  async run(input: string, run: ChatGptRunOptions = {}): Promise<ChatGptRunResult> {
    if (this.closed || this.busy) throw new Error(this.closed ? 'ChatGPT conversation is closed' : 'ChatGPT conversation already has a running turn')
    if (this.settlementRequired) throw new Error('ChatGPT conversation is awaiting explicit interruption settlement')
    if (run.signal?.aborted) throw abortError()
    this.busy = true
    const active = new AbortController()
    const stop = () => active.abort()
    run.signal?.addEventListener('abort', stop, { once: true })
    this.active = active
    let usage = usageOf(null)
    try {
      await this.load()
      await this.verifyAccount()
      const next = [...this.history, { role: 'user', content: input }]
      this.checkSize(next)
      this.history = next
      await this.save()
      const batchLimit = this.options.maxToolRounds ?? 32
      for (let round = 0; ; round++) {
        if (active.signal.aborted) throw abortError()
        if (round === batchLimit) {
          if (!run.onCheckpoint) throw new ChatGptResponseError('ChatGPT reached the tool-turn limit. Its history has been preserved.')
          // All calls in the previous response have durable results. Yield to
          // the owning actor without ending its input, replaying a call, or
          // inventing a new user "Continue" message. Authorization/account
          // checks below still gate the very next request, including after a
          // provider switch or an owner interrupt at this checkpoint.
          if (unresolvedTool(this.history)) throw new ChatGptUncertainActionError()
          await this.save()
          await run.onCheckpoint()
          await new Promise<void>((resolve) => setImmediate(resolve))
          if (active.signal.aborted) throw abortError()
          round = 0
        }
        await this.options.authorize?.()
        await this.verifyAccount()
        const token = await (this.options.accessToken ?? getChatGptAccessToken)()
        await this.verifyAccount()
        // Own the deadline until this response has finished reading. Node 20
        // keeps AbortSignal.any sources weakly, so an inline timeout signal can
        // be collected under load and silently leave a stalled stream unbounded.
        const requestController = new AbortController()
        const stopRequest = () => requestController.abort(signalError(active.signal))
        active.signal.addEventListener('abort', stopRequest, { once: true })
        const requestTimer = setTimeout(() => requestController.abort(new DOMException('ChatGPT response deadline exceeded', 'TimeoutError')), this.options.requestTimeoutMs ?? 120_000)
        if (active.signal.aborted) stopRequest()
        const requestSignal = requestController.signal
        let completed: Item | null = null
        let deltaText = ''
        try {
          const response = await (this.options.fetch ?? fetch)(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            signal: requestSignal,
            body: JSON.stringify({ model: this.options.model, instructions: this.options.instructions, store: false, stream: true, input: this.history, include: ['reasoning.encrypted_content'], ...(this.options.effort ? { reasoning: { effort: this.options.effort } } : {}), tools: this.tools.size ? [{ type: 'namespace', name: 'openground', description: 'OPEN GROUND host tools. Every action is checked by the host.', tools: Array.from(this.tools.values()).map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters, strict: false })) }] : [] }),
          })
          if (!response.ok) {
            // Error bodies are bounded too; do not read a peer-controlled body
            // into an unbounded string, and never include request headers in errors.
            const errorReader = response.body?.getReader()
            let data = ''
            if (errorReader) {
              try { for (;;) { const part = await errorReader.read(); if (part.done) break; data += new TextDecoder().decode(part.value); if (data.length > 8192) break } } finally { await errorReader.cancel().catch(() => {}); errorReader.releaseLock() }
            }
            let parsed: unknown = {}
            try { parsed = JSON.parse(data) } catch { /* status remains authoritative */ }
            if (response.status === 429) {
              const until = retryAt(response) ?? Date.now() + 20 * 60_000
              markChatGptRateLimited(until)
              throw new ChatGptQuotaError(until)
            }
            throw responseError(parsed, response.status)
          }
          if (!response.body) throw new ChatGptResponseError('ChatGPT returned no response stream')
          const addedItems = new Map<number, Item>()
          const completedItems = new Map<number, Item>()
          for await (const event of readChatGptSse(response.body, requestSignal)) {
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') { deltaText += event.delta; run.onText?.(event.delta) }
            if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') run.onEvent?.({ kind: 'thinking', chars: event.delta.length })
            if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw responseError(event.response ?? event)
            if (event.type === 'response.output_item.added') {
              const index = streamedOutputIndex(event)
              if (!validStreamedItem(event.item)) throw new ChatGptResponseError('ChatGPT returned a malformed streamed output item')
              if (addedItems.has(index) || completedItems.has(index)) throw new ChatGptResponseError('ChatGPT returned a duplicate streamed output index')
              addedItems.set(index, event.item)
            }
            if (event.type === 'response.output_item.done') {
              const index = streamedOutputIndex(event)
              if (!validCompletedStreamedItem(event.item)) throw new ChatGptResponseError('ChatGPT returned a malformed completed streamed output item')
              if (completedItems.has(index)) throw new ChatGptResponseError('ChatGPT returned a duplicate streamed output index')
              const added = addedItems.get(index)
              if (added && (added.type !== event.item.type || (added.id !== undefined && added.id !== event.item.id))) throw new ChatGptResponseError('ChatGPT changed a streamed output item identity')
              addedItems.delete(index)
              completedItems.set(index, event.item)
            }
            if (event.type === 'response.completed') {
              if (!object(event.response) || event.response.status !== 'completed' || !Array.isArray(event.response.output) || !event.response.output.every(object)) throw new ChatGptResponseError('ChatGPT completed event has an invalid response')
              if (addedItems.size) throw new ChatGptResponseError('ChatGPT completed with an unfinished streamed output item')
              // SIWC may send the full items only in output_item.done and leave
              // the terminal response's output empty. Collect evidence now, but
              // never execute it before the whole response successfully completes.
              const ordered = Array.from(completedItems.entries()).sort(([a], [b]) => a - b)
              if (ordered.some(([index], position) => index !== position)) throw new ChatGptResponseError('ChatGPT returned a missing streamed output index')
              completed = { ...event.response, output: event.response.output.length ? event.response.output : ordered.map(([, item]) => item) }
              break
            }
          }
        } finally {
          clearTimeout(requestTimer)
          active.signal.removeEventListener('abort', stopRequest)
        }
        if (!completed) throw new ChatGptResponseError('ChatGPT stream ended without response.completed')
        usage = sumUsage(usage, usageOf(completed.usage))
        const output = completed.output as Item[]
        const previousCalls = new Set(this.history.filter((item) => item.type === 'function_call').map((item) => item.call_id))
        for (const item of output) {
          if (item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'function_call') throw new ChatGptResponseError('ChatGPT returned an unsupported output item')
          if (item.type === 'function_call') {
            if (typeof item.call_id !== 'string' || previousCalls.has(item.call_id)) throw new ChatGptResponseError('ChatGPT returned a duplicate or invalid tool call id')
            previousCalls.add(item.call_id)
          }
        }
        this.checkSize([...this.history, ...output])
        this.history.push(...output)
        await this.save()
        // SdkEvent.text is one COMPLETE prose block, just as in the Claude SDK
        // adapter. Token deltas belong only to onText (the live assistant).
        // Emitting each delta as a block makes the shared transcript render a
        // paragraph per character and spends its bounded tail on a few words.
        const prose = output.filter((item) => item.type === 'message').flatMap((item) => Array.isArray(item.content) ? item.content : [])
          .filter((item): item is Item => object(item) && ((item.type === 'output_text' && typeof item.text === 'string') || (item.type === 'refusal' && typeof item.refusal === 'string')))
          .map((item) => (item.type === 'refusal' ? item.refusal : item.text) as string)
        for (const text of prose) if (text) run.onEvent?.({ kind: 'text', text })
        const calls = output.filter((item) => item.type === 'function_call')
        if (!calls.length) {
          // Preserve the accepted delta-only completion fallback as one block.
          if (!prose.length && deltaText) run.onEvent?.({ kind: 'text', text: deltaText })
          let finalRoundText = deltaText
          if (!deltaText) {
            const finalText = prose.join('')
            if (finalText) { finalRoundText = finalText; run.onText?.(finalText) }
          }
          run.onEvent?.({ kind: 'turn_end', reason: 'completed', isError: false, usage })
          return { text: finalRoundText, usage, model: typeof completed.model === 'string' ? completed.model : this.options.model }
        }
        for (const call of calls) {
          if (active.signal.aborted) throw abortError()
          if (call.namespace !== 'openground' || typeof call.name !== 'string' || typeof call.call_id !== 'string' || typeof call.arguments !== 'string' || !this.tools.has(call.name)) throw new ChatGptResponseError('ChatGPT requested an unadvertised or malformed tool')
          let args: unknown
          try { args = JSON.parse(call.arguments) } catch { throw new ChatGptResponseError('ChatGPT returned invalid tool arguments') }
          if (!object(args)) throw new ChatGptResponseError('ChatGPT tool arguments must be an object')
          run.onEvent?.({ kind: 'tool_use', name: call.name, detail: call.arguments.slice(0, 160) })
          let result: unknown
          let ok = true
          await this.options.authorize?.()
          await this.verifyAccount()
          try { result = await this.tools.get(call.name)!.invoke(args, active.signal) } catch (error) {
            if (active.signal.aborted) throw abortError()
            // A bounded process cleanup can finish without proof of its
            // external effects. Keep the saved call unfinished; an ordinary
            // tool-error receipt would authorize continuation/replay.
            if (error instanceof ChatGptHostOutcomeUncertainError) throw error
            // A child Agent shares this plan. A usage wall stops the whole
            // turn, rather than buying a parent continuation to discuss it.
            if (error instanceof ChatGptQuotaError) {
              if (call.name === 'Agent') {
                const returned = new Set(this.history.filter((item) => item.type === 'function_call_output').map((item) => item.call_id))
                for (const pending of calls) if (!returned.has(pending.call_id)) this.history.push({ type: 'function_call_output', call_id: pending.call_id, output: JSON.stringify({ error: pending.call_id === call.call_id ? 'The read-only review stopped at the plan usage limit. No approval or external action was performed.' : 'This tool call was cancelled before execution because the plan usage limit stopped the turn.' }) })
                await this.save()
              }
              throw error
            }
            ok = false; result = { error: shortError(error) }
          }
          const content: unknown = typeof result === 'string' || Array.isArray(result) ? result : JSON.stringify(result ?? null)
          if (Array.isArray(content) && !content.every((part) => object(part) && ((part.type === 'input_text' && typeof part.text === 'string') || (part.type === 'input_image' && typeof part.image_url === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(part.image_url))))) throw new ChatGptResponseError('ChatGPT host tool returned invalid content')
          const serialized = JSON.stringify(content)
          if (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) throw new ChatGptResponseError('ChatGPT host tool result exceeded its limit')
          this.history.push({ type: 'function_call_output', call_id: call.call_id, output: content })
          await this.save()
          run.onEvent?.({ kind: 'tool_result', ok, head: typeof content === 'string' ? content.slice(0, 160) : '[image content]' })
        }
      }
    } catch (error) {
      if (unresolvedTool(this.history)) this.closed = true
      if (error instanceof ChatGptQuotaError) { this.settlementRequired = true; run.onEvent?.({ kind: 'quota_refusal', raw: error.message }) }
      else if (!active.signal.aborted) run.onEvent?.({ kind: 'api_error', status: error instanceof ChatGptResponseError ? error.status : null, head: shortError(error) })
      run.onEvent?.({ kind: 'turn_end', reason: active.signal.aborted ? 'aborted_streaming' : 'api_error', isError: !active.signal.aborted, usage })
      throw error
    } finally {
      run.signal?.removeEventListener('abort', stop)
      this.active = null
      this.busy = false
    }
  }
}
