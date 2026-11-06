import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptConversation, ChatGptUncertainActionError, chatGptConversationFile } from './chatgptResponses'
import { ChatGptHostOutcomeUncertainError } from './chatgptTools'
import { ChatGptQuotaError, clearChatGptCooling } from './chatgptQuota'
import type { SdkEvent } from './sdkEvents'

const roots: string[] = []
afterEach(async () => {
  clearChatGptCooling()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), 'og-checkpoint-safety-'))
  roots.push(root)
  return root
}
const completed = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
  status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 },
} })}\n\n`)
const call = (n: number) => ({ type: 'function_call', namespace: 'openground', name: 'step', call_id: `step-${n}`, arguments: '{}' })
const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'finished' }] }

describe('confirmed ChatGPT tool checkpoints retain control and outcome boundaries', () => {
  it('keeps the hard round cap for a short-lived reviewer without a checkpoint host', async () => {
    const storeDir = await temporary()
    let n = 0
    const invoke = vi.fn(async () => ({ confirmed: true }))
    const conversation = new ChatGptConversation({ storeDir, model: 'fixture', maxToolRounds: 2,
      accountKey: async () => 'fixture-account', accessToken: async () => 'fixture-token',
      tools: [{ name: 'step', description: '', parameters: {}, invoke }],
      fetch: vi.fn(async () => completed([call(++n)])) as unknown as typeof fetch,
    })
    await expect(conversation.run('bounded review')).rejects.toThrow(/tool-turn limit/)
    expect(n).toBe(2)
    expect(invoke).toHaveBeenCalledTimes(2)
    const saved = JSON.parse(await readFile(chatGptConversationFile(conversation.id, storeDir), 'utf8'))
    expect(saved.input.filter((item: { type?: string }) => item.type === 'function_call_output')).toHaveLength(2)
  })

  it.each(['interrupt', 'owner-change', 'account-change', 'checkpoint-write-failure'] as const)(
    'does not request or execute another step after %s at a confirmed checkpoint', async (control) => {
      const storeDir = await temporary()
      let n = 0
      let account = 'fixture-account'
      let ownerChanged = false
      const events: SdkEvent[] = []
      const invoke = vi.fn(async () => ({ confirmed: true }))
      const fetcher = vi.fn(async () => completed([call(++n)]))
      const conversation = new ChatGptConversation({ storeDir, model: 'fixture', maxToolRounds: 2,
        accountKey: async () => account, accessToken: async () => 'fixture-token',
        authorize: async () => { if (ownerChanged) throw new Error('owner changed') },
        tools: [{ name: 'step', description: '', parameters: {}, invoke }], fetch: fetcher as unknown as typeof fetch,
      })
      const checkpoint = vi.fn(async () => {
        const saved = JSON.parse(await readFile(chatGptConversationFile(conversation.id, storeDir), 'utf8'))
        expect(saved.input.filter((item: { type?: string }) => item.type === 'function_call_output')).toHaveLength(2)
        if (control === 'interrupt') conversation.interrupt()
        if (control === 'owner-change') ownerChanged = true
        if (control === 'account-change') account = 'other-account'
        if (control === 'checkpoint-write-failure') throw new Error('checkpoint write failed')
      })
      const error = control === 'interrupt' ? /stopped/ : control === 'owner-change' ? /owner changed/ : control === 'account-change' ? /connection changed/ : /checkpoint write failed/
      await expect(conversation.run('finish owner task', { onCheckpoint: checkpoint, onEvent: event => events.push(event) })).rejects.toThrow(error)
      expect(checkpoint).toHaveBeenCalledOnce()
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(events.filter(event => event.kind === 'turn_end' && event.reason === 'completed')).toEqual([])
      const saved = JSON.parse(await readFile(chatGptConversationFile(conversation.id, storeDir), 'utf8'))
      expect(saved.input.filter((item: { role?: string }) => item.role === 'user')).toEqual([{ role: 'user', content: 'finish owner task' }])
    },
  )

  it('stops at a plan limit after a checkpoint without another continuation or paid fallback', async () => {
    let n = 0
    const checkpoint = vi.fn(async () => {})
    const fetcher = vi.fn(async () => ++n <= 2 ? completed([call(n)]) : new Response('{}', { status: 429 }))
    const conversation = new ChatGptConversation({ persist: false, model: 'fixture', maxToolRounds: 2,
      accountKey: async () => 'fixture-account', accessToken: async () => 'fixture-token',
      tools: [{ name: 'step', description: '', parameters: {}, invoke: async () => ({ confirmed: true }) }],
      fetch: fetcher as unknown as typeof fetch,
    })
    await expect(conversation.run('owner task', { onCheckpoint: checkpoint })).rejects.toBeInstanceOf(ChatGptQuotaError)
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(3)
    await expect(conversation.run('automatic retry is forbidden')).rejects.toThrow(/settlement/)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('preserves an uncertain host action without converting it to a failed-tool receipt or replaying it', async () => {
    const storeDir = await temporary()
    const invoke = vi.fn(async () => { throw new ChatGptHostOutcomeUncertainError() })
    const fetcher = vi.fn(async () => completed([call(1)]))
    const options = { storeDir, model: 'fixture', accountKey: async () => 'fixture-account', accessToken: async () => 'fixture-token',
      tools: [{ name: 'step', description: '', parameters: {}, invoke }], fetch: fetcher as unknown as typeof fetch,
    }
    const conversation = new ChatGptConversation(options)
    const events: SdkEvent[] = []
    await expect(conversation.run('perform once', { onEvent: event => events.push(event) })).rejects.toBeInstanceOf(ChatGptHostOutcomeUncertainError)
    const saved = JSON.parse(await readFile(chatGptConversationFile(conversation.id, storeDir), 'utf8'))
    expect(saved.input.filter((item: { type?: string }) => item.type === 'function_call')).toHaveLength(1)
    expect(saved.input.filter((item: { type?: string }) => item.type === 'function_call_output')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'tool_result')).toEqual([])
    expect(await conversation.settleInterruptedTurn()).toBe(false)
    const reopened = new ChatGptConversation({ ...options, id: conversation.id, resume: true })
    await expect(reopened.run('do not replay')).rejects.toBeInstanceOf(ChatGptUncertainActionError)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledOnce()
  })
})
