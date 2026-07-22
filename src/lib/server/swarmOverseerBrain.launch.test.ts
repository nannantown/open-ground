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
//   • The DURABLE egress close (macOS): the brain launch is ALWAYS sandboxed —
//     sandbox:true + sandboxNetwork:'loopback' + HTTPS_PROXY at the host-side
//     allowlist proxy — NOT gated on the owner experiment. Off-darwin (or
//     without sandbox-exec) it degrades gracefully to the deny-list stop-gap.
//     Both branches are pinned via the sandboxAvailable/egressProxyPort seams
//     (deterministic on any host — no real proxy, no real /usr/bin probe).
//   • The pre-existing containment stays armed: strictMcpConfig / bypass /
//     hidden / appContext:false / the L4 write-guard on the scratch dir.
//   • The SAME opts fed to the REAL buildClaudeArgv produce a --disallowed-tools
//     argv token containing WebFetch and WebSearch (the Done-condition proof
//     that the deny list actually reaches the claude argv).
// The app home is PINNED (not mocked) to a tmp dir so the scratch mkdtemp never
// touches the real ~/.openground (feedback_tests_isolate_home). It used to
// `vi.mock('./paths')`, which is a structural bypass of the production-home
// fence: mocking the choke point removes the check for the whole module graph,
// so a future edit to the SUT could reach the real home with nothing left to
// stop it. Pinning OPENGROUND_HOME gets the identical tmp home THROUGH the
// fence. A meta-test in testHomeGuard.test.ts keeps './paths' unmocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  killTerminal: vi.fn(() => true),
  subscribeTerminal: vi.fn(),
  removeClaudeFolderTrust: vi.fn(),
}))

vi.mock('./claudeTerminal', () => ({ launchClaude: mocks.launchClaude }))
vi.mock('./terminal', () => ({
  killTerminal: mocks.killTerminal,
  subscribeTerminal: mocks.subscribeTerminal,
}))
vi.mock('./claudeTrust', () => ({ removeClaudeFolderTrust: mocks.removeClaudeFolderTrust }))
// The tmp app home, reached through the REAL paths.ts (see the note above).
const brainHome = mkdtempSync(join(tmpdir(), 'og-overseer-brain-home-'))
const prevOgHome = process.env.OPENGROUND_HOME
beforeEach(() => {
  process.env.OPENGROUND_HOME = brainHome
})
afterEach(() => {
  // Restore, never delete — an unset OPENGROUND_HOME retargets the real home.
  if (prevOgHome !== undefined) process.env.OPENGROUND_HOME = prevOgHome
})

import {
  makeOverseerBrain,
  brainSandboxAvailable,
  OVERSEER_BRAIN_DISALLOWED_TOOLS,
} from './swarmOverseerBrain'
import {
  setAllowedModelTiersCache,
  __resetAllowedModelsForTest,
} from './swarmAllowedModels'
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
  })

  it('denies WebFetch/WebSearch/Bash and keeps every existing containment flag armed', async () => {
    const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
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
    const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
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

  it('macOS: the brain launch is ALWAYS sandboxed — loopback network + HTTPS_PROXY at the allowlist proxy', async () => {
    const runner = makeOverseerBrain({
      timeoutMs: 1,
      sandboxAvailable: true,
      egressProxyPort: async () => 39_999,
    })
    await runner({ prompt: 'p', projectPath: '/proj' })
    const opts = launchedOpts()
    // The durable egress close (structural, not experiment-gated): kernel-denied
    // off-machine outbound; the ONE hole is the loopback allowlist proxy.
    expect(opts.sandbox).toBe(true)
    expect(opts.sandboxNetwork).toBe('loopback')
    expect(opts.env?.HTTPS_PROXY).toBe('http://127.0.0.1:39999')
    expect(opts.env?.HTTP_PROXY).toBe('http://127.0.0.1:39999')
    expect(opts.env?.NO_PROXY).toBe('') // an inherited NO_PROXY=* must not dodge the proxy
    // The permission-layer deny list stays armed UNDER the sandbox (defense-in-depth).
    expect(opts.disallowedTools).toEqual([...OVERSEER_BRAIN_DISALLOWED_TOOLS])
  })

  it('off-darwin / no sandbox-exec: graceful fallback to the permission-layer stop-gap', async () => {
    const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
    await runner({ prompt: 'p', projectPath: '/proj' })
    const opts = launchedOpts()
    expect(opts.sandbox).toBe(false)
    expect(opts.sandboxNetwork).toBeUndefined()
    expect(opts.env).toBeUndefined()
    expect(opts.disallowedTools).toEqual([...OVERSEER_BRAIN_DISALLOWED_TOOLS])
  })

  it('fail-closed: a proxy that cannot start aborts the launch — no un-proxied loopback PTY', async () => {
    const runner = makeOverseerBrain({
      timeoutMs: 1,
      sandboxAvailable: true,
      egressProxyPort: async () => {
        throw new Error('proxy could not bind')
      },
    })
    // The runner rejects → answerAsOwner catches → escalates to the owner
    // (insufficient-info). It must NOT fall back to an un-sandboxed launch.
    await expect(runner({ prompt: 'p', projectPath: '/proj' })).rejects.toThrow('proxy could not bind')
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it('an abort BEFORE launch never spawns a PTY (and still resolves)', async () => {
    const ac = new AbortController()
    ac.abort()
    const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
    const out = await runner({ prompt: 'p', projectPath: '/proj', signal: ac.signal })
    expect(out).toBe('')
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  // The cerebrum is a claude spawn like any other, so it obeys the owner's model
  // hard mask. Left un-masked it was the third "half-lung" (with the reviewer panel
  // and the worker ladder): a brain pinned to a retired top tier answers nothing.
  describe('model hard mask (Settings.swarmAllowedModels)', () => {
    beforeEach(() => __resetAllowedModelsForTest())

    it('launches on the DEFAULT top tier when every tier is enabled', async () => {
      const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
      await runner({ prompt: 'p', projectPath: '/proj' })
      expect(launchedOpts().model).toBe('fable')
    })

    it('steps DOWN the ladder when the top tier is switched OFF', async () => {
      setAllowedModelTiersCache({ fable: false })
      const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
      await runner({ prompt: 'p', projectPath: '/proj' })
      expect(launchedOpts().model).toBe('opus')
    })

    it('honors the mask even against an EXPLICIT model the caller asked for', async () => {
      setAllowedModelTiersCache({ fable: false, opus: false })
      const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false, model: 'fable' })
      await runner({ prompt: 'p', projectPath: '/proj' })
      expect(launchedOpts().model).toBe('sonnet')
    })

    it('fails CLOSED with every tier OFF — no PTY, no scratch, the runner rejects', async () => {
      setAllowedModelTiersCache({ fable: false, opus: false, sonnet: false, haiku: false })
      const runner = makeOverseerBrain({ timeoutMs: 1, sandboxAvailable: false })
      await expect(runner({ prompt: 'p', projectPath: '/proj' })).rejects.toThrow(
        /no model tier is enabled/,
      )
      expect(mocks.launchClaude).not.toHaveBeenCalled()
    })
  })
})

describe('brainSandboxAvailable', () => {
  it('is false off-darwin regardless of the filesystem', () => {
    expect(brainSandboxAvailable('linux')).toBe(false)
    expect(brainSandboxAvailable('win32')).toBe(false)
  })
})
