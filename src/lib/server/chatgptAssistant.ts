import { z } from 'zod'
import {
  ASSISTANT_TOOL_SHAPES,
  ASSISTANT_TOOL_DESCRIPTIONS,
  type AssistantAsk,
  type AssistantModel,
} from './assistantSession'
import { ChatGptConversation, type ChatGptTool } from './chatgptResponses'
import { chatGptLaunchConfig } from './chatgptRuntime'
import { admitChatGptRuntime } from './runtimeLease'
import type { ToolResult } from './assistantTools'
import { getChatGptAccountKey } from './chatgptAuth'

interface Talk {
  key: string
  turns: number
  conversation: ChatGptConversation
  current: AssistantAsk | null
  controller?: AbortController
  idle?: ReturnType<typeof setTimeout>
}

const g = globalThis as typeof globalThis & { __openground_chatgpt_assistant?: Talk }

export const closeChatGptAssistant = (): void => {
  const talk = g.__openground_chatgpt_assistant
  if (!talk) return
  g.__openground_chatgpt_assistant = undefined
  clearTimeout(talk.idle)
  talk.controller?.abort()
  talk.conversation.close()
}

const current = async (o: Pick<AssistantAsk, 'key' | 'system' | 'authorize' | 'runtimeOwnerKey'>): Promise<Talk> => {
  await o.authorize?.()
  const config = await chatGptLaunchConfig('assistant')
  const key = JSON.stringify([o.key, config, await getChatGptAccountKey(), o.runtimeOwnerKey])
  await o.authorize?.()
  const existing = g.__openground_chatgpt_assistant
  if (existing?.key === key && existing.turns < 40) return existing
  closeChatGptAssistant()
  const talk: Talk = { key, turns: 0, current: null, conversation: null! }
  const lease = await admitChatGptRuntime('assistant', o.runtimeOwnerKey)
  const authorize = async () => { await lease(); await (talk.current?.authorize ?? o.authorize)?.() }
  const tools: ChatGptTool[] = Object.entries(ASSISTANT_TOOL_SHAPES).filter(([name]) => name !== 'think_deeper').map(([name, shape]) => {
    const schema = z.object(shape)
    return {
      name,
      description: ASSISTANT_TOOL_DESCRIPTIONS[name as keyof typeof ASSISTANT_TOOL_DESCRIPTIONS],
      parameters: z.toJSONSchema(schema),
      invoke: async (input, signal) => {
        if (signal.aborted || !talk.current) throw new Error('Assistant turn is no longer active.')
        await authorize()
        const args = schema.parse(input)
        const tool = talk.current.tools[name as keyof AssistantAsk['tools']]
        const result = await (tool as (a: unknown) => Promise<ToolResult>)(args)
        if ('image' in result) return [{ type: 'input_image', image_url: `data:${result.image.mimeType};base64,${result.image.data}` }]
        return result.text
      },
    }
  })
  talk.conversation = new ChatGptConversation({
    ...config,
    instructions: await o.system(),
    tools,
    persist: false,
    authorize,
  })
  g.__openground_chatgpt_assistant = talk
  return talk
}

const idle = (talk: Talk): void => {
  clearTimeout(talk.idle)
  talk.idle = setTimeout(() => {
    if (g.__openground_chatgpt_assistant === talk) closeChatGptAssistant()
  }, 15 * 60_000)
  talk.idle.unref?.()
}

export const chatGptAssistantModel: AssistantModel = {
  warm: async (o) => idle(await current(o)),
  ask: async (o) => {
    const talk = await current(o)
    if (talk.current) throw new Error('The assistant is already answering.')
    clearTimeout(talk.idle)
    talk.current = o
    talk.controller = new AbortController()
    const timer = setTimeout(() => talk.controller?.abort(), 120_000)
    let text = ''
    try {
      await o.authorize?.()
      const answer = await talk.conversation.run(o.line, {
        signal: talk.controller.signal,
        onText: (delta) => { text += delta; o.onStream?.({ text }) },
        onEvent: (event) => {
          if (event.kind === 'tool_use') { text = ''; o.onStream?.({ tool: true }) }
        },
      })
      o.onModel?.(answer.model)
      talk.turns++
      return answer.text
    } catch (error) {
      closeChatGptAssistant()
      throw error
    } finally {
      clearTimeout(timer)
      talk.current = null
      talk.controller = undefined
      if (g.__openground_chatgpt_assistant === talk) idle(talk)
    }
  },
}
