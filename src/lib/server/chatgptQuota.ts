// ChatGPT plan usage is independent of Claude's tier quota. Only a refusal
// received from the authenticated inference endpoint may cool this account.
declare global {
  // eslint-disable-next-line no-var
  var __openground_chatgpt_quota: { until: number } | undefined
}

const state = globalThis.__openground_chatgpt_quota ??=
  { until: 0 }

export class ChatGptQuotaError extends Error {
  constructor(public readonly until: number) {
    super(`ChatGPT usage limit; retry after ${new Date(until).toISOString()}`)
    this.name = 'ChatGptQuotaError'
  }
}

export const markChatGptRateLimited = (until = Date.now() + 20 * 60_000): void => {
  if (Number.isFinite(until) && until > Date.now()) state.until = Math.max(state.until, until)
}

export const chatGptCoolingUntil = (now = Date.now()): number | null =>
  state.until > now ? state.until : null

export const clearChatGptCooling = (): void => { state.until = 0 }
