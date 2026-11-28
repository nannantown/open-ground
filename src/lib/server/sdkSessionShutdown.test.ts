import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { listConversationReceipts } from './conversationReceipts'
import { openGroundHome } from './paths'
import { exitAfterShutdownOnSignals } from './liveDesks'
import {
  beginShutdown,
  SHUTDOWN_TOOL_GRACE_MS,
  SHUTDOWN_LAUNCH_REFUSAL,
  sdkShutdownBegun,
  listSdkSessions,
  spawnSdkSession,
  sdkToolCallsInFlight,
  getSdkSession,
  terminateSdkSession,
  preloadSdk,
  __setSdkImporterForTests,
  __resetSdkSessionsForTests,
  type SdkQueryFn,
  type SdkQueryParams,
} from './sdkSession'

// STOPS THAT WAIT (AUTONOMY-SPEC R-B2). Every stop the app starts — owner quit,
// "Restart now", an update install, a relaunch — reaches the server as SIGTERM.
// The server used to exit on the spot, cutting off whatever command a worker was
// running; that call's receipt stayed `executing`, became `uncertain` at the next
// start, and held the whole project (three starts in 75 minutes on 11-26/27 match
// two of the eight holds in §1.1). Now the stop first refuses new calls WITHOUT
// claiming a receipt, then waits for the calls already running, bounded.
//
// The receipt journal lives under the isolated test home (setup-home.ts); no
// real `claude` is spawned — the pool is driven through its `queryFn` seam, or
// through the production launch (`subscriptionQuery`) with a fake SDK module.

vi.mock('./runtimeOwner', async (original) => ({
  ...(await original<typeof import('./runtimeOwner')>()),
  runtimeOwnerKey: async (expected?: string) => {
    if (expected && expected !== 'owner-a') throw new Error('owner changed')
    return 'owner-a'
  },
}))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => true }))
vi.mock('./projectDataPath', () => ({ projectUUIDFromPath: async () => 'project-a' }))
vi.mock('./subscriptionOnly', () => ({ assertClaudeSubscriptionLaunch: async () => ({ PATH: '/synthetic/bin' }) }))
vi.mock('./liveDesks', async (original) => ({
  ...(await original<typeof import('./liveDesks')>()),
  isAgentConversationOccupied: () => true,
  agentConversationHandles: () => [{ runtime: 'sdk', handleId: 'fixture-handle' }],
  isRecordedRuntimeHandleOccupied: () => true,
}))

type Decision = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
const preInput = (callId: string) => ({ session_id: 'session-a', transcript_path: '/synthetic/unused.jsonl', cwd: '/synthetic/project',
  hook_event_name: 'PreToolUse', tool_use_id: callId, tool_name: 'Bash', tool_input: { command: 'synthetic, never executed' } } as HookInput)

/** One owner-role launch through the PRODUCTION path (subscriptionQuery → the
 *  receipt audit → the stop gate), with a fake SDK. Its one tool call reaches
 *  PreToolUse only when `release()` is called; then every PreToolUse hook runs
 *  side by side, as the CLI runs them, and the call's result comes back. */
const launchWithOneCall = async () => {
  let release = () => {}
  const released = new Promise<void>((r) => { release = r })
  const decisions: Decision[] = []
  const query = vi.fn(({ prompt, options }: SdkQueryParams) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _input of prompt) {
        void _input
        yield { type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'synthetic, never executed' } }] } }
        await released
        const hooks = options.hooks as { PreToolUse: { hooks: HookCallback[] }[] }
        decisions.push(...(await Promise.all(hooks.PreToolUse.flatMap((m) => m.hooks.map((hook) =>
          hook(preInput('call-a'), 'call-a', { signal: new AbortController().signal }))))) as Decision[])
        const deny = decisions.find((d) => d.hookSpecificOutput?.permissionDecision === 'deny')
        yield { type: 'user', session_id: 'session-a', message: { content: [{ type: 'tool_result', tool_use_id: 'call-a',
          is_error: Boolean(deny), content: deny?.hookSpecificOutput?.permissionDecisionReason ?? 'ok' }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    },
    interrupt: async () => {},
  }))
  __setSdkImporterForTests(async () => ({ query, USAGE_LIMIT_ERROR_PREFIXES: [] }))
  const sdk = await preloadSdk()
  const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'worker', sdk, agentSessionId: 'session-a', initialPrompt: 'synthetic',
    options: { cwd: '/synthetic/project', sessionId: 'session-a', runtimeOwnerKey: 'owner-a' } })
  launched.push(session.id)
  await vi.waitFor(() => expect(sdkToolCallsInFlight()).toBe(1))
  return { release, decisions, answered: () => vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe('waiting')) }
}
const launched: string[] = []
afterEach(async () => {
  for (const id of launched.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) }
  __setSdkImporterForTests(null)
})

/** A session whose one tool call stays open until `finish()` is called. */
const sessionWithOneRunningCall = async () => {
  let finish = () => {}
  const finished = new Promise<void>((r) => { finish = r })
  const queryFn: SdkQueryFn = ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _msg of prompt) {
        void _msg
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'sleep 8' } }] } }
        await finished
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] } }
        await new Promise(() => {}) // the session stays open; only the call ends
      }
    },
    interrupt: async () => {},
  })
  spawnSdkSession({ cwd: '/synthetic/worktree', options: {}, initialPrompt: 'go', queryFn })
  await vi.waitFor(() => expect(sdkToolCallsInFlight()).toBe(1))
  return finish
}

beforeEach(async () => {
  __resetSdkSessionsForTests()
  await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true })
})
afterEach(() => { vi.useRealTimers() })

describe('beginShutdown — new tool calls are refused without a receipt', () => {
  it('control: with no stop, the call is allowed and the audit claims its receipt', async () => {
    const call = await launchWithOneCall()
    call.release()
    await call.answered()
    expect(call.decisions.some((d) => d.hookSpecificOutput?.permissionDecision === 'deny')).toBe(false)
    expect((await listConversationReceipts()).map((r) => r.state), 'the audit really runs on this path').toEqual(['executing'])
  })

  it('a stop begun while a session runs: its next PreToolUse denies with the restart reason, no receipt is written, and the wait ends with that call', async () => {
    const call = await launchWithOneCall()
    let stopped = false
    const stop = beginShutdown().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped, 'the tool_use is already out — the stop waits for it').toBe(false)
    call.release()
    await call.answered()
    const reasons = call.decisions.map((d) => d.hookSpecificOutput?.permissionDecision === 'deny' ? d.hookSpecificOutput.permissionDecisionReason : 'allowed')
    expect(reasons.length, 'every hook of the call answered').toBeGreaterThan(0)
    expect(new Set(reasons), 'every hook — the audit\'s own included — refused').toEqual(new Set(['OPEN GROUND is restarting; this call did not run.']))
    expect(await listConversationReceipts(), 'nothing was claimed, so nothing can be left unconfirmed').toEqual([])
    await stop
  })
})

// Review C-S2 (2026-11-28): the stop refused only tool calls. For the ~20 s wait
// the engine kept dispatching and new SDK sessions still launched — a worker's
// first turn is billed inference, then every call it makes is refused and the
// process kills it at exit. Every SDK launch (worker, commander, ChatGPT
// president, owner-initiated or not) goes through spawnSdkSession.
describe('beginShutdown — no new SDK conversation starts once a stop has begun', () => {
  const recordingQuery = () => {
    const calls: string[] = []
    const queryFn: SdkQueryFn = ({ prompt }) => {
      calls.push('called')
      return {
        async *[Symbol.asyncIterator]() {
          for await (const _input of prompt) {
            void _input
            yield { type: 'system', subtype: 'init' }
          }
        },
        interrupt: async () => {},
      }
    }
    return { calls, queryFn }
  }

  it('control: before a stop, a launch reaches its provider and joins the pool', () => {
    const q = recordingQuery()
    const s = spawnSdkSession({ cwd: '/synthetic/worktree', role: 'worker', options: {}, initialPrompt: 'go', queryFn: q.queryFn })
    launched.push(s.id)
    expect(q.calls).toEqual(['called'])
    expect(listSdkSessions().map((x) => x.id)).toContain(s.id)
  })

  it('after the stop: the launch throws a plain reason, its provider is never called, and the pool does not grow', () => {
    void beginShutdown()
    const q = recordingQuery()
    const before = listSdkSessions().length
    expect(() => spawnSdkSession({ cwd: '/synthetic/worktree', role: 'worker', options: {}, initialPrompt: 'go', queryFn: q.queryFn }))
      .toThrow(SHUTDOWN_LAUNCH_REFUSAL)
    expect(q.calls).toEqual([])
    expect(listSdkSessions()).toHaveLength(before)
    expect(sdkShutdownBegun()).toBe(true)
  })
})

describe('beginShutdown — the calls already running are waited for, bounded', () => {
  it('nothing in flight: resolves at once (a plain quit does not wait)', async () => {
    vi.useFakeTimers()
    let resolved = false
    void beginShutdown().then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('one call in flight: resolves when its tool_result arrives, not before', async () => {
    const finish = await sessionWithOneRunningCall()
    vi.useFakeTimers()
    let resolved = false
    void beginShutdown().then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TOOL_GRACE_MS - 1_000)
    expect(resolved, 'the command is still running').toBe(false)
    finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(sdkToolCallsInFlight()).toBe(0)
    expect(resolved, 'its result arrived, well inside the bound').toBe(true)
  })

  it('a call that outlives the bound: resolves exactly at SHUTDOWN_TOOL_GRACE_MS and the call is cut as today', async () => {
    await sessionWithOneRunningCall()
    vi.useFakeTimers()
    let resolved = false
    void beginShutdown().then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TOOL_GRACE_MS - 1)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
    expect(sdkToolCallsInFlight(), 'still running — R-B1 decides at the next start').toBe(1)
  })
})

describe('the server entry is the only owner of SIGTERM / SIGINT', () => {
  // Both reapers used to add a SIGTERM/SIGINT listener that called process.exit
  // at once. Node runs every listener, so either one ended the process inside the
  // entry's wait no matter what the entry did. They hook 'exit' only now.
  it('installing the gate and host reapers adds no signal listener', async () => {
    const { installGateGroupReaper } = await import('./gateProcess')
    const { installChatGptHostReaper } = await import('./chatgptTools')
    const g = globalThis as { __openground_gate_reaper_installed?: boolean; __openground_chatgpt_host_reaper_installed?: boolean }
    const saved = [g.__openground_gate_reaper_installed, g.__openground_chatgpt_host_reaper_installed] as const
    const proc: NodeJS.EventEmitter = process
    const events = ['exit', 'SIGTERM', 'SIGINT']
    const listenersBefore = new Map(events.map((e) => [e, proc.listeners(e)]))
    const counts = () => [proc.listenerCount('SIGTERM'), proc.listenerCount('SIGINT')]
    const before = counts()
    g.__openground_gate_reaper_installed = undefined
    g.__openground_chatgpt_host_reaper_installed = undefined
    try {
      installGateGroupReaper()
      installChatGptHostReaper()
      if (process.platform !== 'win32') expect(proc.listenerCount('exit'), 'the reapers did install (not a vacuous pass)').toBeGreaterThan(listenersBefore.get('exit')!.length)
      expect(counts()).toEqual(before)
    } finally {
      for (const e of events) for (const l of proc.listeners(e)) if (!listenersBefore.get(e)!.includes(l)) proc.removeListener(e, l as () => void)
      ;[g.__openground_gate_reaper_installed, g.__openground_chatgpt_host_reaper_installed] = saved
    }
  })
})

describe('exitAfterShutdownOnSignals — the server entry exits only after the wait', () => {
  it.each([['SIGTERM', 143], ['SIGINT', 130]] as const)('%s exits with %i once the running call is done, and repeats do not cut it short', async (signal, code) => {
    const finish = await sessionWithOneRunningCall()
    vi.useFakeTimers()
    const handlers = new Map<string, () => void>()
    const exit = vi.fn()
    exitAfterShutdownOnSignals({ on: (name: string, fn: () => void) => { handlers.set(name, fn) }, exit } as unknown as Pick<NodeJS.Process, 'on' | 'exit'>)
    handlers.get(signal)!()
    handlers.get(signal)!()
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TOOL_GRACE_MS - 1_000)
    expect(exit, 'a command is still running — the process must stay up').not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(exit).toHaveBeenCalledWith(code)
  })
})
