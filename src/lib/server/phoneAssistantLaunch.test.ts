// The claude the phone assistant REALLY starts: askAssistant without a stand-in
// runner, through defaultRun → canvasAi.runFileTask → launchClaude. Only the PTY
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

import { askAssistant, __resetAssistantMemory } from './phoneAssistant'
import { buildClaudeArgv, type LaunchClaudeOpts } from './claudeTerminal'

describe('the claude each assistant line starts', () => {
  it('has Write as its only tool, confined to its temp dir, no MCP, no bypass, no pane', async () => {
    __resetAssistantMemory()
    await expect(askAssistant('全体どう?', { digest: async () => ({ text: '', projects: [] }) })).rejects.toBeTruthy()
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
})
