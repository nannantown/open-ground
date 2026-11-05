import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { guardClaudeRuntimeTools, assertNoUncertainRuntimeActions } from './runtimeActionReceipts'
import { acceptConversationReceipt, claimConversationReceipt, listConversationReceipts } from './conversationReceipts'
import * as atomic from './atomicWrite'
import { openGroundHome } from './paths'

const h = vi.hoisted(() => ({ owner: 'owner-a', access: true, occupied: false, liveHandle: 'fixture-handle' }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner || expected && expected !== h.owner) throw new Error('owner changed')
  return h.owner
} }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => h.access }))
vi.mock('./projectDataPath', () => ({ projectUUIDFromPath: async () => 'project-a' }))
vi.mock('./liveDesks', () => ({ isAgentConversationOccupied: () => h.occupied,
  agentConversationHandles: () => [{ runtime: 'sdk', handleId: h.liveHandle }],
  isRecordedRuntimeHandleOccupied: (_runtime: string, handleId: string) => h.occupied && handleId === h.liveHandle,
}))

const input = (event: string, callId = 'call-a'): HookInput => ({ session_id: 'session-a', transcript_path: '/synthetic/unused.jsonl', cwd: '/synthetic/project',
  hook_event_name: event, tool_use_id: callId, tool_name: 'Bash', tool_input: { command: 'synthetic, never executed' }, tool_response: {}, is_interrupt: false,
} as HookInput)
const invoke = (hook: HookCallback, event: string, callId = 'call-a') => hook(input(event, callId), callId, { signal: new AbortController().signal })
const decision = (value: unknown) => (value as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
const last = (hooks: Awaited<ReturnType<typeof guardClaudeRuntimeTools>>, name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure') => hooks[name]!.at(-1)!.hooks[0]
beforeEach(async () => { h.owner = 'owner-a'; h.access = true; h.occupied = false; h.liveHandle = 'fixture-handle'; await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true }) })
afterEach(() => vi.restoreAllMocks())

describe('durable Claude tool audit hooks', () => {
  it('does not downgrade a revoked owner actor to legacy passthrough guards', async () => {
    const raw = { PreToolUse: [{ hooks: [vi.fn(async () => ({}))] }] }
    h.access = false
    await expect(guardClaudeRuntimeTools('/synthetic/project', 'session-a', raw, 'owner-a')).rejects.toThrow('owner account changed')
    expect(await guardClaudeRuntimeTools('/synthetic/project', 'session-a', raw)).toBe(raw)
  })
  it('retains existing permission denials and never returns an affirmative permission grant', async () => {
    const deny: HookCallback = async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [deny] }] })
    expect(hooks.PreToolUse![0].hooks[0]).toBe(deny)
    expect(decision(await invoke(hooks.PreToolUse![0].hooks[0], 'PreToolUse'))).toBe('deny')
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).not.toBe('allow')
  })
  it('explicitly denies a native action when durable acceptance fails', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic fsync failure'))
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).toBe('deny')
    expect(await listConversationReceipts()).toEqual([])
  })
  it('explicitly denies when claiming execution cannot be durably saved, retaining its queued receipt', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    const write = atomic.atomicWriteJson
    vi.spyOn(atomic, 'atomicWriteJson').mockImplementationOnce(write).mockRejectedValueOnce(new Error('synthetic claim fsync failure'))
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).toBe('deny')
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['queued'])
  })
  it('claims one execution, denies its duplicate, and records a confirmed post result', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    h.occupied = true
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).toBeUndefined()
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).toBe('deny')
    await invoke(last(hooks, 'PostToolUse'), 'PostToolUse')
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['delivered'])
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).toBe('deny')
  })
  it('does not continue to another native tool when its previous post receipt could not be saved', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    h.occupied = true
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse')
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic post fsync failure'))
    await expect(invoke(last(hooks, 'PostToolUse'), 'PostToolUse')).rejects.toThrow('post fsync failure')
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['executing'])
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'call-after-failed-post'))).toBe('deny')
    expect(await listConversationReceipts()).toHaveLength(1)
  })
  it('does not let another successful parallel post erase a different call recording fault', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    h.occupied = true
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'parallel-a')
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'parallel-b')
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic parallel post failure'))
    await expect(invoke(last(hooks, 'PostToolUse'), 'PostToolUse', 'parallel-a')).rejects.toThrow('parallel post failure')
    await invoke(last(hooks, 'PostToolUse'), 'PostToolUse', 'parallel-b')
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'parallel-c'))).toBe('deny')
    expect((await listConversationReceipts()).map(r => r.state).sort()).toEqual(['delivered', 'executing'])
  })
  it('records a returned failure as a result and an interrupted effect as uncertain', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    h.occupied = true
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'failed-call')
    await invoke(last(hooks, 'PostToolUseFailure'), 'PostToolUseFailure', 'failed-call')
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'delivered', result: { failed: true, interrupted: false } })
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'interrupted-call')
    await last(hooks, 'PostToolUseFailure')({ ...input('PostToolUseFailure', 'interrupted-call'), is_interrupt: true } as HookInput, 'interrupted-call', { signal: new AbortController().signal })
    expect((await listConversationReceipts()).find(r => r.state === 'uncertain')?.result).toEqual({ failed: true, interrupted: true })
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'after-interruption'))).toBe('deny')
  })
  it('does not let an old-owner post callback complete another owner receipt with the same native IDs', async () => {
    const old = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    await invoke(last(old, 'PreToolUse'), 'PreToolUse')
    h.owner = 'owner-b'
    const next = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    await invoke(last(next, 'PreToolUse'), 'PreToolUse')
    await expect(invoke(last(old, 'PostToolUse'), 'PostToolUse')).rejects.toThrow()
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['executing'])
  })
  it('restores a fresh-module started receipt as uncertain and cannot replay it', async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse')
    vi.resetModules()
    const restarted = await import('./conversationReceipts')
    expect((await restarted.listConversationReceipts()).map(r => r.state)).toEqual(['uncertain'])
    await expect(assertNoUncertainRuntimeActions('/synthetic/project')).rejects.toThrow('unconfirmed result')
    const pending = (await restarted.listConversationReceipts())[0]
    expect(await restarted.claimConversationReceipt(pending.scope, pending.id)).toBe(false)
  })
  it('holds a started action across two real processes without invoking a provider or native tool', async () => {
    await writeFile(join(openGroundHome(), 'auth.json'), JSON.stringify({ user: { id: 'synthetic-process-owner', email: 'fixture-owner@example.test' },
      accessToken: 'synthetic-local-test-only', refreshToken: 'synthetic-local-test-only', expiresAt: 0 }), { mode: 0o600 })
    const source = pathToFileURL(resolve('src/lib/server/conversationReceipts.ts')).href
    const child = async (phase: 'start' | 'recover') => {
      const program = `
        globalThis.fetch = async () => { throw new Error('Network forbidden in receipt process fixture'); };
        const loaded = await import(${JSON.stringify(source)});
        const receipts = loaded.default ?? loaded;
        if (${JSON.stringify(phase)} === 'start') {
          await receipts.acceptConversationReceipt('process-project', 'process-action', { kind: 'runtime-tool', sessionId: 'synthetic' });
          const claimed = await receipts.claimConversationReceipt('process-project', 'process-action');
          const state = (await receipts.listConversationReceipts())[0].state;
          process.stdout.write(JSON.stringify({ claimed, state }));
        } else {
          const state = (await receipts.listConversationReceipts())[0].state;
          const claimed = await receipts.claimConversationReceipt('process-project', 'process-action');
          process.stdout.write(JSON.stringify({ claimed, state }));
        }
      `
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
        timeout: 10_000, maxBuffer: 8192, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
          VITEST: 'true', OPENGROUND_HOME: openGroundHome(), OPENGROUND_OWNER_EMAILS: 'fixture-owner@example.test', OPENGROUND_TESTER_EMAILS: '' },
      })
      return JSON.parse(stdout)
    }
    expect(await child('start')).toEqual({ claimed: true, state: 'executing' })
    expect(await child('recover')).toEqual({ claimed: false, state: 'uncertain' })
  })
  it('distinguishes a live ongoing action from a lost actor when checking the next guard', async () => {
    await acceptConversationReceipt('project-a', 'ongoing', { kind: 'runtime-tool', sessionId: 'session-a' })
    await claimConversationReceipt('project-a', 'ongoing', { sessionId: 'session-a', handleId: 'fixture-handle', runtime: 'sdk' })
    h.occupied = true
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).resolves.toBeUndefined()
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', true)).rejects.toThrow('unconfirmed result')
    h.occupied = false
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).rejects.toThrow('unconfirmed result')
  })
  it('holds the original executing handle even when its native conversation has resumed under a replacement actor', async () => {
    await acceptConversationReceipt('project-a', 'old-execution', { kind: 'runtime-tool', sessionId: 'same-native-conversation' })
    await claimConversationReceipt('project-a', 'old-execution', { sessionId: 'same-native-conversation', handleId: 'fixture-handle', runtime: 'sdk' })
    h.occupied = true
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).resolves.toBeUndefined()
    h.liveHandle = 'replacement-handle'
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).rejects.toThrow('unconfirmed result')
  })
})
