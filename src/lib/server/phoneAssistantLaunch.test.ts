// The claude a FOLD run of the assistant's memo REALLY starts (the talk itself
// is the live SDK session — assistantSession.test.ts): foldIdleAssistantTalk
// without a stand-in runner, through defaultRun → canvasAi.runFileTask → launchClaude. Only the PTY
// itself is replaced (the launch options are captured and turned into the argv
// the real CLI would get). Guards both seams: phoneAssistant passing
// ASSISTANT_LAUNCH, and runFileTask letting it override its bypass default.
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ launches: [] as unknown[] }))
vi.mock('./claudeTerminal', async (orig) => ({
  ...(await orig<typeof import('./claudeTerminal')>()),
  launchClaude: (opts: unknown) => (h.launches.push(opts), { terminalId: 't-assistant' }),
}))
vi.mock('./claudePreflight', () => ({ claudeRunPreflight: async () => ({ ok: true }) }))
vi.mock('./terminal', async (orig) => ({
  ...(await orig<typeof import('./terminal')>()),
  // The session "ends" at once without writing its answer: the line fails, and
  // what matters here is how it was started.
  subscribeTerminal: (_id: string, _onData: unknown, onExit: () => void) => (onExit(), { info: {}, unsubscribe: () => {} }),
  killTerminal: () => {},
  killTerminalsByCwdAndWait: async () => true,
}))

import { ASSISTANT_KICKOFF, foldIdleAssistantTalk, __resetAssistantMemory } from './phoneAssistant'
import { appendAssistantEntries, clearAssistantLog, writeAssistantMemory } from './assistantMemory'

/** Talk two days old, so a fold run is due. */
const oldTalk = async (text: string) => {
  await clearAssistantLog()
  await appendAssistantEntries([{ at: Date.now() - 2 * 86_400_000, who: 'owner', text, via: 'phone' }])
}
import { buildClaudeArgv, type LaunchClaudeOpts } from './claudeTerminal'

describe('the claude a fold run starts', () => {
  it('has Write as its only tool, confined to its temp dir, no MCP, no bypass, no pane', async () => {
    __resetAssistantMemory()
    await oldTalk('全体どう?')
    await expect(foldIdleAssistantTalk()).rejects.toBeTruthy()
    expect(h.launches).toHaveLength(1)
    const opts = h.launches[0] as LaunchClaudeOpts
    expect(opts.hidden).toBe(true)
    const argv = buildClaudeArgv(opts, null)
    const at = (flag: string) => (argv[argv.indexOf(flag) + 1] ?? '').replace(/['"]/g, '')
    expect(at('--tools')).toBe('Write')
    expect(argv).toContain('--restricted')
    expect(at('--permission-mode')).toBe('acceptEdits')
    expect(at('--disallowed-tools')).toBe('mcp__*')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it("keeps the owner's words and the memo out of claude's prompt history: only a fixed line is the prompt", async () => {
    h.launches.length = 0
    __resetAssistantMemory()
    await writeAssistantMemory('ヒミツのメモ', 4000)
    await oldTalk('ヒミツの話')
    await expect(foldIdleAssistantTalk()).rejects.toBeTruthy()
    const opts = h.launches[0] as LaunchClaudeOpts
    // The positional prompt is what ~/.claude/history.jsonl records (no time limit).
    expect(opts.initialPrompt).toBe(ASSISTANT_KICKOFF)
    expect(opts.initialPrompt).not.toContain('ヒミツ')
    // Everything else rides --append-system-prompt, which is not recorded.
    expect(opts.systemPrompt).toContain('ヒミツの話')
    expect(opts.systemPrompt).toContain('ヒミツのメモ')
    expect(buildClaudeArgv(opts, '/tmp/p.txt', '/tmp/ctx.md')).toContain('--append-system-prompt')
  })
})
