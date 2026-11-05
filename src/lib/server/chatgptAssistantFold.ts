import { ChatGptConversation, type ChatGptConversationOptions } from './chatgptResponses'
import { chatGptLaunchConfig, selectedRuntime } from './chatgptRuntime'

/** Memo maintenance follows the assistant's provider too. Write is a bounded
 * in-memory handoff, never filesystem authority or a second billing route. */
export const runChatGptAssistantFold = async (
  prompt: string,
  file: string,
  defaults: Pick<ChatGptConversationOptions, 'fetch' | 'accessToken' | 'accountKey'> = {},
): Promise<string> => {
  const config = await chatGptLaunchConfig('assistant')
  let answer: string | null = null
  const conversation = new ChatGptConversation({
    ...defaults,
    ...config,
    persist: false,
    instructions: prompt,
    authorize: async () => {
      if (await selectedRuntime('assistant') !== 'chatgpt') throw new Error('ChatGPT is no longer selected for the assistant.')
    },
    tools: [{
      name: 'Write',
      description: 'Return the complete JSON answer to the requested answer file. Only that exact answer path is accepted.',
      parameters: { type: 'object', properties: { file_path: { type: 'string', const: file }, content: { type: 'string', maxLength: 128_000 } }, required: ['file_path', 'content'], additionalProperties: false },
      invoke: async (raw) => {
        const args = raw as Record<string, unknown>
        if (args.file_path !== file || typeof args.content !== 'string' || args.content.length > 128_000) throw new Error('Memo handoff accepts only the requested answer file.')
        answer = args.content
        return 'Answer received.'
      },
    }],
  })
  try {
    await conversation.run('Write the complete JSON answer described in your instructions using the Write tool.', { signal: AbortSignal.timeout(180_000) })
    if (answer === null) throw new Error('ChatGPT did not return a memo answer.')
    return answer
  } finally { conversation.close() }
}
