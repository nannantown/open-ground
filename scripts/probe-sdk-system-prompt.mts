#!/usr/bin/env tsx
// probe-sdk-system-prompt — does an SDK session get Claude Code's system prompt,
// and does `append` reach the model?
//
// WHY IT MATTERS. The PTY path gives every OPEN GROUND desk its app-context card
// via `--append-system-prompt` (claudeTerminal.ts), on top of the CLI's own
// system prompt. The SDK's equivalent is
// `systemPrompt: {type:'preset', preset:'claude_code', append}` — and the Agent
// SDK is documented as NOT using Claude Code's prompt unless you ask for the
// preset. If that is true, an SDK session with the option omitted is a BARE
// agent wearing Claude Code's tools, which is not what any PTY twin is.
//
// FIRST ATTEMPT, recorded so nobody repeats it: capturing argv (and even stdin)
// from a stubbed `spawnClaudeCodeProcess` answers nothing. The system prompt
// never rides the command line, and the SDK sends its options only AFTER the
// CLI answers the control handshake — which a stub process never does. The only
// way to see this is to run the real thing and ask the model.
//
//   npx tsx scripts/probe-sdk-system-prompt.mts
//
// Cost: 3 one-turn sessions on the user's own subscription.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { absoluteClaudeOnPath } from '../src/lib/server/claudeConnection'

const MARKER = 'OG_PROBE_MARKER_7F3A'

const ask = async (label: string, systemPrompt: unknown, question: string): Promise<void> => {
  const bin = absoluteClaudeOnPath()
  if (!bin) throw new Error('cannot locate the user claude binary')
  const out: string[] = []
  const q = query({
    prompt: (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: question }] },
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
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    } as Record<string, unknown>,
  })
  for await (const m of q as AsyncIterable<any>) {
    if (m?.type === 'assistant') {
      for (const b of m.message?.content ?? []) if (b?.type === 'text') out.push(b.text)
    }
    if (m?.type === 'result') break
  }
  console.log(`\n── ${label}\n${out.join('').trim().slice(0, 400) || '(no text)'}`)
}

const main = async () => {
  await ask(
    'A. systemPrompt OMITTED — is the Claude Code preset there?',
    undefined,
    'Answer in ONE short line, no tools: does your system prompt identify you as "Claude Code, Anthropic\'s official CLI"? Reply exactly YES or NO, then a 6-word quote from your system prompt.',
  )
  await ask(
    'B. preset claude_code — same question',
    { type: 'preset', preset: 'claude_code' },
    'Answer in ONE short line, no tools: does your system prompt identify you as "Claude Code, Anthropic\'s official CLI"? Reply exactly YES or NO, then a 6-word quote from your system prompt.',
  )
  await ask(
    'C. preset + append — does the appended text arrive?',
    { type: 'preset', preset: 'claude_code', append: `OPEN GROUND probe token: ${MARKER}` },
    `Answer with ONE token only, no tools: what token follows "OPEN GROUND probe token:" in your system prompt? If there is no such text, reply NONE.`,
  )
}

void main()
