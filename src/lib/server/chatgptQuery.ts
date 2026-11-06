import { mkdir, open, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { resolveHookSourceRoot } from './hooksInstall'
import { ChatGptConversation, chatGptConversationFile, ChatGptUncertainActionError, saveChatGptPublicConversation, type ChatGptConversationOptions } from './chatgptResponses'
import { createChatGptHostTools, type ChatGptToolGuard } from './chatgptTools'
import type { SdkEvent } from './sdkEvents'
import { ChatGptQuotaError } from './chatgptQuota'
import { admitChatGptRuntime } from './runtimeLease'
import { openGroundHome } from './paths'
import { getChatGptAccountKey } from './chatgptAuth'
import { createChatGptReviewTool } from './chatgptReview'

type RuntimeRole = 'worker' | 'manager' | 'supply'
/** Phone readers tail this append-only stream by byte offset. Tool/file outputs
 * stay in the separate bounded conversation history, never in this transcript. */
export const chatGptTranscriptFile = (id: string): string => {
  chatGptConversationFile(id) // validate the provider-owned id before path use
  return join(openGroundHome(), 'chatgpt', 'transcripts', `${id}.jsonl`)
}
const appendSupplyTranscript = async (id: string, type: 'user' | 'assistant', text: string): Promise<void> => {
  const file = chatGptTranscriptFile(id)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(file, 'a', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content: [{ type: 'text', text }] } }) + '\n')
    await handle.sync()
  } finally { await handle.close() }
}
interface ChatGptQueryHandle extends AsyncIterable<SdkEvent> { interrupt: () => Promise<void> }
type ChatGptQueryFn = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown>; onTurnSettled?: () => Promise<void>; onTurnInterrupted?: (safeToContinue: boolean) => Promise<void>; onTurnRefused?: () => Promise<void>; onPublicText?: (text: string) => void; publicConversation?: () => { lines: { kind: 'input' | 'text'; text: string }[]; overflow: boolean } }) => ChatGptQueryHandle
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const knownEvents = new Set(['status', 'text', 'input', 'thinking', 'tool_use', 'tool_result', 'turn_end', 'rate_limit', 'api_error', 'quota_refusal', 'compact'])
/** The adapter emits these events itself; provider wire events never enter the pool. */
export const distillChatGptMessage = (message: unknown): SdkEvent[] => object(message) && typeof message.kind === 'string' && knownEvents.has(message.kind) ? [message as unknown as SdkEvent] : []

const skillForRole = async (role: RuntimeRole): Promise<string> => {
  const source = resolveHookSourceRoot()
  if (!source.root) throw new Error(source.problem ?? 'OPEN GROUND packaged skills could not be found')
  const skill = role === 'worker' ? 'order' : role === 'manager' ? 'og-manage' : 'supply'
  const body = await readFile(join(source.root, 'skills', skill, 'SKILL.md'), 'utf8')
  if (!body.trim() || Buffer.byteLength(body) > 256 * 1024) throw new Error('OPEN GROUND runtime skill is missing or exceeds its limit')
  return body
}
const hookFrom = (options: Record<string, unknown>): ChatGptToolGuard | undefined => {
  const hooks = object(options.hooks) ? options.hooks : null
  const entries = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const callbacks = entries.flatMap((entry) => object(entry) && Array.isArray(entry.hooks) ? entry.hooks : [])
  if (!callbacks.length) return undefined
  if (callbacks.some((hook) => typeof hook !== 'function')) throw new Error('ChatGPT worker has invalid guard wiring')
  return async (input) => {
    for (const callback of callbacks) {
      const out: unknown = await callback(input)
      if (!object(out) || !object(out.hookSpecificOutput) || out.hookSpecificOutput.permissionDecision !== 'allow') return out
    }
    return { hookSpecificOutput: { permissionDecision: 'allow' } }
  }
}
const inputText = (message: unknown): string => {
  if (!object(message) || !object(message.message) || !Array.isArray(message.message.content)) throw new Error('ChatGPT pool input has an invalid envelope')
  const blocks = message.message.content
  if (blocks.some((block) => !object(block) || block.type !== 'text' || typeof block.text !== 'string')) throw new Error('ChatGPT pool input contains unsupported content')
  return blocks.map((block) => (block as { text: string }).text).join('\n')
}

class EventQueue {
  private items: SdkEvent[] = []
  private wake: (() => void) | null = null
  private ended = false
  private error: unknown = null
  push(event: SdkEvent): void {
    if (this.ended) return
    if (this.items.length >= 4096) throw new Error('ChatGPT output consumer fell behind the bounded event buffer')
    this.items.push(event); this.wake?.(); this.wake = null
  }
  end(error?: unknown): void { this.ended = true; this.error = error; this.wake?.(); this.wake = null }
  async *read(): AsyncGenerator<SdkEvent> {
    for (;;) {
      if (this.items.length) yield this.items.shift()!
      else if (this.ended) { if (this.error) throw this.error; return }
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

export interface ChatGptQueryDefaults extends Pick<ChatGptConversationOptions, 'fetch' | 'accessToken' | 'accountKey' | 'storeDir' | 'maxHistoryBytes' | 'maxToolRounds' | 'authorize'> {
  /** Tests can supply a role skill without reading the installed package. */
  roleInstructions?: (role: RuntimeRole) => Promise<string>
}

export const createChatGptQuery = (defaults: ChatGptQueryDefaults = {}): ChatGptQueryFn => ({ prompt, options, onTurnSettled, onTurnInterrupted, onTurnRefused, onPublicText, publicConversation }): ChatGptQueryHandle => {
  if (typeof options.cwd !== 'string' || typeof options.model !== 'string') throw new Error('ChatGPT runtime requires cwd and model')
  const role = options.runtimeRole
  if (role !== 'worker' && role !== 'manager' && role !== 'supply') throw new Error('ChatGPT runtime requires an explicit role')
  const guard = hookFrom(options)
  let admitted: Promise<() => Promise<void>> | undefined
  const expectedOwnerKey = typeof options.runtimeOwnerKey === 'string' ? options.runtimeOwnerKey : undefined
  const authorize = defaults.authorize ?? (async () => { await (await (admitted ??= admitChatGptRuntime('swarm', expectedOwnerKey)))() })
  // One immutable account identity for this parent and every independent child.
  // Capturing only inside a newly created child would permit an account switch
  // between the parent's check and that child's first check.
  const readAccountKey = defaults.accountKey ?? getChatGptAccountKey
  let initialAccount: Promise<string> | undefined
  const accountKey = async (): Promise<string> => {
    const expected = await (initialAccount ??= readAccountKey())
    const current = await readAccountKey()
    if (!expected || current !== expected) throw new Error('ChatGPT connection changed. Start a new conversation for this account.')
    return current
  }
  const tools = createChatGptHostTools({ cwd: options.cwd, env: object(options.env) ? options.env as NodeJS.ProcessEnv : undefined, guard, trusted: role !== 'worker', authorize })
  tools.push(createChatGptReviewTool({ cwd: options.cwd, model: options.model, effort: typeof options.effort === 'string' ? options.effort : undefined, fetch: defaults.fetch, accessToken: defaults.accessToken, accountKey, authorize, guard }))
  const id = typeof options.resume === 'string' ? options.resume : typeof options.sessionId === 'string' ? options.sessionId : undefined
  const system = typeof options.systemPrompt === 'string' ? options.systemPrompt : object(options.systemPrompt) && typeof options.systemPrompt.append === 'string' ? options.systemPrompt.append : ''
  const queue = new EventQueue()
  const persistPublic = async () => {
    if (!conversation || !publicConversation || options.persist === false) return
    const capture = publicConversation()
    await saveChatGptPublicConversation(conversation.id, capture.lines, capture.overflow, { accountKey, storeDir: defaults.storeDir })
  }
  let conversation: ChatGptConversation | null = null
  let consumed = false
  let stopped = false
  const handle: ChatGptQueryHandle = {
    interrupt: async () => { conversation?.interrupt() },
    async *[Symbol.asyncIterator]() {
      if (consumed) throw new Error('ChatGPT query stream can only be consumed once')
      consumed = true
      const pump = async () => {
        try {
          const skill = await (defaults.roleInstructions ?? skillForRole)(role)
          if (stopped) return
          conversation = new ChatGptConversation({ ...defaults, accountKey, authorize, id, cwd: options.cwd as string, persist: options.persist !== false, resume: typeof options.resume === 'string', model: options.model as string, effort: typeof options.effort === 'string' ? options.effort : undefined, instructions: [
            'You are running an OPEN GROUND local agent role through host function tools. Your tools are in the openground namespace. Calls such as Read, Bash, Write and Edit refer to those host tools. There is no native shell or filesystem tool and no persistent shell session. Follow the role protocol below. A leading /order, /og-manage, or /supply in a user message invokes this same protocol; do not search for a separate slash-command implementation.',
            'Agent starts an independent read-only reviewer or researcher using the same connected ChatGPT plan and chosen model. Use Agent for the mandatory independent adversarial review; it investigates with Read and fixed Git tools in this project or one of its registered worktrees. If the role protocol mentions Task or sub-agents, this Agent is available only for read-only review/research: it cannot implement changes, delegate again, or run in the background. Implement code in this parent role and do not claim to have delegated implementation.',
            skill, system,
          ].join('\n\n'), tools })
          for await (const message of prompt) {
            if (stopped) break
            const text = inputText(message)
            if (role === 'supply' && options.persist !== false) await appendSupplyTranscript(conversation.id, 'user', text)
            try {
              const answer = await conversation.run(text, {
                onEvent: (event) => { if (event.kind === 'text') onPublicText?.(event.text); queue.push(event) },
                // A role can span many bounded batches. The public transcript
                // is durable here, but the accepted owner turn remains open
                // until the model actually finishes it below.
                onCheckpoint: persistPublic,
              })
              if (role === 'supply' && options.persist !== false) await appendSupplyTranscript(conversation.id, 'assistant', answer.text)
              await persistPublic()
              await onTurnSettled?.()
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') {
                const safe = await conversation.settleInterruptedTurn()
                if (safe) await persistPublic()
                await onTurnInterrupted?.(safe)
                if (!safe) throw new ChatGptUncertainActionError()
                continue
              }
              // A genuine usage wall remains visible/parked until the engine
              // stops this session; no automatic retry burns another request.
              if (error instanceof ChatGptQuotaError) {
                const safe = await conversation.settleInterruptedTurn('quota')
                if (!safe) { await onTurnInterrupted?.(false); throw new ChatGptUncertainActionError() }
                await persistPublic()
                await onTurnRefused?.()
                if (!onTurnRefused) break
                continue
              }
              throw error
            }
          }
          queue.end()
        } catch (error) { queue.end(error) } finally { conversation?.close() }
      }
      const running = pump()
      try { yield* queue.read() } finally { stopped = true; conversation?.close(); void running.catch(() => {}) }
    },
  }
  return handle
}
