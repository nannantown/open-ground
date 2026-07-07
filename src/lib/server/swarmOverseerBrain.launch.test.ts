// @vitest-environment node
//
// makeOverseerBrain LAUNCH wiring — the containment flags the REAL brain runner
// hands launchClaude (OVERSEER_DESIGN §5 D4 + the corpus-egress deny list). The
// pure orchestration (answerAsOwner) is covered in swarmOverseerBrain.test.ts;
// THIS file pins the launch seam with launchClaude mocked (no PTY, no `claude`):
//   • disallowedTools carries OVERSEER_BRAIN_DISALLOWED_TOOLS — WebFetch/WebSearch
//     (the direct network-egress tools) + Bash (the curl/wget bypass), so a
//     prompt-injected brain holding the private you-corpus has NO tool that can
//     exfiltrate it. Deny-listing rides claude's permission layer, which wins
//     even under `--dangerously-skip-permissions`.
//   • The pre-existing containment stays armed: strictMcpConfig / bypass /
//     hidden / appContext:false / the L4 write-guard on the scratch dir.
//   • The SAME opts fed to the REAL buildClaudeArgv produce a --disallowed-tools
//     argv token containing WebFetch and WebSearch (the Done-condition proof
//     that the deny list actually reaches the claude argv).
// The app home is mocked to a tmp dir so the scratch mkdtemp never touches the
// real ~/.openground (feedback_tests_isolate_home).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  killTerminal: vi.fn(() => true),
  subscribeTerminal: vi.fn(),
  removeClaudeFolderTrust: vi.fn(),
  isExperimentEnabled: vi.fn(async () => false),
}))

vi.mock('./claudeTerminal', () => ({ launchClaude: mocks.launchClaude }))
vi.mock('./terminal', () => ({
  killTerminal: mocks.killTerminal,
  subscribeTerminal: mocks.subscribeTerminal,
}))
vi.mock('./claudeTrust', () => ({ removeClaudeFolderTrust: mocks.removeClaudeFolderTrust }))
vi.mock('./experiments', () => ({ isExperimentEnabled: mocks.isExperimentEnabled }))
vi.mock('./paths', async () => {
  const { mkdtempSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const home = mkdtempSync(join(tmpdir(), 'og-overseer-brain-home-'))
  return {
    openGroundHome: () => home,
    youCorpusFile: () => join(home, 'you-corpus.md'),
  }
})

import { makeOverseerBrain, OVERSEER_BRAIN_DISALLOWED_TOOLS } from './swarmOverseerBrain'
import type { LaunchClaudeOpts } from './claudeTerminal'

const launchedOpts = (): LaunchClaudeOpts => {
  expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
  return mocks.launchClaude.mock.calls[0][0] as LaunchClaudeOpts
}

describe('makeOverseerBrain — launch containment wiring (D4 + the no-egress deny list)', () => {
  beforeEach(() => {
    mocks.launchClaude.mockReset()
    mocks.launchClaude.mockReturnValue({ terminalId: 'term-brain', agentSessionId: 'sid', info: {} })
    mocks.subscribeTerminal.mockReset()
    // finishedAt set → were the poll loop ever entered it would exit at once;
    // with timeoutMs:1 the deadline expires before the first poll anyway.
    mocks.subscribeTerminal.mockReturnValue({ unsubscribe: vi.fn(), info: { finishedAt: 1 } })
    mocks.isExperimentEnabled.mockResolvedValue(false)
  })

  it('denies WebFetch/WebSearch/Bash and keeps every existing containment flag armed', async () => {
    const runner = makeOverseerBrain({ timeoutMs: 1 })
    await runner({ prompt: 'p', projectPath: '/proj' })
    const opts = launchedOpts()
    // MF2 — the corpus-holding brain gets NO network-egress tool, nor a Task
    // sub-agent that could launch one (the adversarial-review Task-vector close):
    expect(opts.disallowedTools).toEqual([...OVERSEER_BRAIN_DISALLOWED_TOOLS])
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Bash', 'Task']))
    // The pre-existing containment must stay green alongside it:
    expect(opts.strictMcpConfig).toBe(true)
    expect(opts.permissionMode).toBe('bypass')
    expect(opts.hidden).toBe(true)
    expect(opts.appContext).toBe(false)
    expect(opts.guard).toEqual({ writeRoots: [opts.cwd] }) // L4 confined to the scratch dir
    expect(opts.initialPrompt).toBe('p')
  })

  it('those exact opts reach the claude argv as --disallowed-tools with WebFetch AND WebSearch', async () => {
    const runner = makeOverseerBrain({ timeoutMs: 1 })
    await runner({ prompt: 'p', projectPath: '/proj' })
    const opts = launchedOpts()
    // Feed the REAL argv builder (not the mock) the very opts the brain launched
    // with — proving the deny list lands on the command line, not just in an
    // options bag someone could drop.
    const { buildClaudeArgv } =
      await vi.importActual<typeof import('./claudeTerminal')>('./claudeTerminal')
    const argv = buildClaudeArgv(opts, null, null, null, 'darwin')
    const i = argv.indexOf('--disallowed-tools')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(argv[i + 1]).toContain('WebFetch')
    expect(argv[i + 1]).toContain('WebSearch')
    expect(argv[i + 1]).toContain('Bash')
    expect(argv[i + 1]).toContain('Task')
    // bypass still rides the argv (deny rules beat it at the permission layer).
    expect(argv).toContain('--dangerously-skip-permissions')
  })

  it('an abort BEFORE launch never spawns a PTY (and still resolves)', async () => {
    const ac = new AbortController()
    ac.abort()
    const runner = makeOverseerBrain({ timeoutMs: 1 })
    const out = await runner({ prompt: 'p', projectPath: '/proj', signal: ac.signal })
    expect(out).toBe('')
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })
})
