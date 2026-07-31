#!/usr/bin/env tsx
// probe-sdk-skill-resolution — does an SDK session resolve OPEN GROUND's SKILLS?
//
// THE QUESTION THAT DECIDES THE COMMANDER MIGRATION. Every OG role is delivered
// as a skill handed to claude as its FIRST message: the worker gets `/order …`,
// the supply desk `/supply`, the commander `/og-manage`. In an interactive PTY
// that is a slash command the TUI expands. An SDK session has no TUI — the first
// message is just a user message whose text happens to start with a slash. If
// the CLI does not expand it, the commander boots with NO protocol at all: it
// would be a bare agent sitting in the repo, and every guarantee /og-manage
// carries (never force-push, integrate only swarm/*, adversarial review before
// merge) would silently not exist.
//
// Measured here rather than assumed, because "it looked like it worked" is how
// the PTY path accumulated its scraping tax.
//
//   npx tsx scripts/probe-sdk-skill-resolution.mts
//
// Cost: 2 short sessions on the user's own subscription. Neither is allowed to
// act — maxTurns 1, and the questions ask for a description, not an action.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { absoluteClaudeOnPath } from '../src/lib/server/claudeConnection'

interface Seen {
  text: string[]
  tools: string[]
  slashCommandCount: number | null
  slashHasOgManage: boolean | null
  systemLine: string | null
}

const run = async (
  label: string,
  firstMessage: string,
  extra: Record<string, unknown> = {},
): Promise<Seen> => {
  const bin = absoluteClaudeOnPath()
  if (!bin) throw new Error('cannot locate the user claude binary')
  const seen: Seen = { text: [], tools: [], slashCommandCount: null, slashHasOgManage: null, systemLine: null }
  const q = query({
    prompt: (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: firstMessage }] },
        parent_tool_use_id: null,
        session_id: '',
      }
    })(),
    options: {
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: bin,
      permissionMode: 'bypassPermissions',
      strictMcpConfig: true,
      mcpServers: {},
      maxTurns: 1,
      ...extra,
    } as Record<string, unknown>,
  })
  for await (const m of q as AsyncIterable<any>) {
    // The `system`/`init` message is where the CLI advertises what it loaded.
    if (m?.type === 'system') {
      if (Array.isArray(m.slash_commands)) {
        seen.slashCommandCount = m.slash_commands.length
        seen.slashHasOgManage = m.slash_commands.some((s: unknown) => String(s).includes('og-manage'))
      }
      if (Array.isArray(m.tools)) seen.tools = m.tools.map(String)
    }
    if (m?.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b?.type === 'text') seen.text.push(b.text)
        if (b?.type === 'tool_use') seen.tools.push(`USED:${b.name}`)
      }
    }
    if (m?.type === 'result') break
  }
  console.log(
    `\n── ${label}` +
      `\n   slash commands advertised : ${seen.slashCommandCount ?? '(none in init)'}` +
      `\n   /og-manage among them     : ${seen.slashHasOgManage === null ? '(unknown)' : seen.slashHasOgManage}` +
      `\n   Skill tool offered        : ${seen.tools.includes('Skill')}` +
      `\n   tools used this turn      : ${seen.tools.filter((t) => t.startsWith('USED:')).join(', ') || '(none)'}` +
      `\n   said: ${seen.text.join('').trim().slice(0, 300) || '(no text)'}`,
  )
  return seen
}

const main = async () => {
  await run(
    'A. plain question — what does the session see?',
    'Do not use any tool. In one line: is there a skill or slash command named "og-manage" available to you right now? Answer YES or NO.',
  )
  await run(
    'B. the PRODUCTION arrangement — first message is literally "/og-manage"',
    '/og-manage これはスキル解決の確認です。実際の司令官業務は何もしないでください。あなたが今読み込んだ手順書の名前と、その手順書が禁じている git 操作を1つだけ、1行で答えて終了してください。',
  )
}

void main()
