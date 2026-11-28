import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { claudeDirName } from './claudeProjectDir'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeRuntimeToolAudit, guardClaudeRuntimeTools, assertNoUncertainRuntimeActions, interruptRuntimeActions } from './runtimeActionReceipts'
import { acceptConversationReceipt, claimConversationReceipt, listConversationReceipts } from './conversationReceipts'
import * as receipts from './conversationReceipts'
import * as atomic from './atomicWrite'
import * as ownerIdentity from './runtimeOwner'
import { openGroundHome } from './paths'
import { __resetSdkSessionsForTests, __setQuotaPrefixesForTests, __setSdkImporterForTests, getSdkSession, preloadSdk, sdkQuotaPause, spawnSdkSession, terminateSdkSession, type SdkQueryParams } from './sdkSession'

const h = vi.hoisted(() => ({ owner: 'owner-a', access: true, occupied: false, liveHandle: 'fixture-handle', projects: '' }))
// Claude's transcripts are read from a throwaway folder, never the real ~/.claude.
vi.mock('./transcript', async original => ({ ...(await original<typeof import('./transcript')>()), claudeProjectsRoot: () => h.projects }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner || expected && expected !== h.owner) throw new Error('owner changed')
  return h.owner
} }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => h.access }))
vi.mock('./projectDataPath', () => ({ projectUUIDFromPath: async () => 'project-a' }))
vi.mock('./subscriptionOnly', () => ({ assertClaudeSubscriptionLaunch: async () => ({ PATH: '/synthetic/bin' }) }))
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
const vetoResult = (callId = 'call-a') => ({ type: 'user', session_id: 'session-a',
  tool_use_result: 'Error: openground-guard BLOCKED: synthetic forbidden operation', message: { content: [{ type: 'tool_result', tool_use_id: callId, is_error: true,
    content: 'PreToolUse:Bash hook error: openground-guard BLOCKED: synthetic forbidden operation' }] } })
const nativePreFailure = (callId = 'call-a') => {
  const content = 'PreToolUse:Bash hook error: [bash /synthetic/swarm-guard.sh]: swarm-guard BLOCKED: synthetic constraint\n'
  return { type: 'user', session_id: 'session-a', parent_tool_use_id: null, isSynthetic: false, tool_use_result: `Error: ${content}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: true, content }] } }
}
const claimedVeto = async (raw?: Parameters<typeof createClaudeRuntimeToolAudit>[2], opts: {
  observe?: boolean; observations?: number; claimedInput?: unknown; observedInput?: unknown
} = {}) => {
  h.occupied = true
  const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', raw ?? { PreToolUse: [{ hooks: [async () => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' },
  })] }] }, 'owner-a')
  const tool_input = opts.claimedInput ?? { command: 'synthetic, never executed' }
  if (opts.observe !== false) await audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: {
    content: Array.from({ length: opts.observations ?? 1 }, () => ({ type: 'tool_use', id: 'call-a', name: 'Bash', input: opts.observedInput ?? tool_input })),
  } })
  const value = { ...input('PreToolUse'), tool_input } as HookInput
  await Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => hook(value, 'call-a', { signal: new AbortController().signal }))))
  return audit
}
beforeEach(async () => { h.owner = 'owner-a'; h.access = true; h.occupied = false; h.liveHandle = 'fixture-handle'; await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true })
  h.projects = await mkdtemp(join(tmpdir(), 'claude-projects-')) })
afterEach(() => vi.restoreAllMocks())

describe('strict native Bash PreToolUse failures', () => {
  it.each(['none', 'pass', 'deny'])('settles a returned native failure with %s local hooks without claiming no effects', async hook => {
    const raw = hook === 'none' ? {} : { PreToolUse: [{ hooks: [async () => hook === 'deny'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'synthetic external policy' } } : {}] }] }
    const audit = await claimedVeto(raw)
    await audit.observeSdkMessage(nativePreFailure())
    const receipt = (await listConversationReceipts())[0]
    expect(receipt.state).toBe('delivered')
    expect(receipt.result).toEqual({ confirmed: true, failed: true, source: 'sdk-native-pretool-failure', automaticReplay: false, effectsRolledBack: false })
  })
  it.each(['not-error', 'synthetic', 'foreign-session', 'missing-session', 'foreign-parent', 'foreign-id', 'missing-structured', 'wrong-string-pair', 'stdout-object', 'background-object', 'detached-object', 'interrupt-block', 'interrupt-top', 'interrupt-message', 'duplicate-results', 'wrong-role', 'ordinary-error', 'empty-reason'])('holds %s rather than accepting a forged or incomplete native terminal result', async kind => {
    const audit = await claimedVeto({}), result = nativePreFailure()
    const block = result.message.content[0]
    if (kind === 'not-error') block.is_error = false
    if (kind === 'synthetic') result.isSynthetic = true
    if (kind === 'foreign-session') result.session_id = 'other-session'
    if (kind === 'missing-session') delete (result as Partial<typeof result>).session_id
    if (kind === 'foreign-parent') Object.assign(result, { parent_tool_use_id: 'other-parent' })
    if (kind === 'foreign-id') block.tool_use_id = 'other-call'
    if (kind === 'missing-structured') delete (result as Partial<typeof result>).tool_use_result
    if (kind === 'wrong-string-pair') result.tool_use_result += 'changed'
    if (kind === 'stdout-object') Object.assign(result, { tool_use_result: { stdout: block.content, stderr: '', interrupted: false } })
    if (kind === 'background-object') Object.assign(result, { tool_use_result: { backgroundTaskId: 'ongoing', interrupted: false } })
    if (kind === 'detached-object') Object.assign(result, { tool_use_result: { detachedToolCall: true } })
    if (kind === 'interrupt-block') Object.assign(block, { is_interrupt: true })
    if (kind === 'interrupt-top') Object.assign(result, { is_interrupt: true })
    if (kind === 'interrupt-message') Object.assign(result.message, { is_interrupt: true })
    if (kind === 'duplicate-results') result.message.content.push({ ...block })
    if (kind === 'wrong-role') result.message.role = 'assistant'
    if (kind === 'ordinary-error') { block.content = 'Exit code 1\nPreToolUse:Bash hook error: printed to stdout'; result.tool_use_result = `Error: ${block.content}` }
    if (kind === 'empty-reason') { block.content = 'PreToolUse:Bash hook error:   \n'; result.tool_use_result = `Error: ${block.content}` }
    await audit.observeSdkMessage(result)
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it.each(['unobserved', 'duplicate-same-frame', 'duplicate-later-frame', 'background-request', 'changed-input', 'duplicate-claim'])('retains a %s claim instead of borrowing another invocation’s evidence', async kind => {
    const audit = await claimedVeto({}, { ...(kind === 'unobserved' ? { observe: false } : {}),
      ...(kind === 'duplicate-same-frame' ? { observations: 2 } : {}),
      ...(kind === 'background-request' ? { claimedInput: { command: 'synthetic, never executed', run_in_background: true } } : {}),
      ...(kind === 'changed-input' ? { observedInput: { command: 'different synthetic input' } } : {}),
    })
    if (kind === 'duplicate-later-frame') await audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: {
      content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'synthetic, never executed' } }],
    } })
    if (kind === 'duplicate-claim') await invoke(last(audit.hooks, 'PreToolUse'), 'PreToolUse')
    await audit.observeSdkMessage(nativePreFailure())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('does not settle a prior query’s receipt or an unclaimed ID', async () => {
    await claimedVeto({})
    const next = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', {}, 'owner-a')
    await next.observeSdkMessage(nativePreFailure())
    await next.observeSdkMessage(nativePreFailure('unclaimed'))
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it.each(['owner', 'handle'])('refuses a late native result after its %s changed', async kind => {
    const audit = await claimedVeto({})
    if (kind === 'owner') h.owner = 'owner-b'
    else h.liveHandle = 'replacement-handle'
    await expect(audit.observeSdkMessage(nativePreFailure())).rejects.toThrow()
    h.owner = 'owner-a'
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('propagates a native-failure fsync error and refuses a later tool', async () => {
    const audit = await claimedVeto({})
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic native result fsync failure'))
    await expect(audit.observeSdkMessage(nativePreFailure())).rejects.toThrow('native result fsync failure')
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
    expect(decision(await invoke(last(audit.hooks, 'PreToolUse'), 'PreToolUse', 'next-call'))).toBe('deny')
  })
  it.each(['receipt-read', 'owner-check'])('keeps repeated observations ambiguous during the awaited %s', async stage => {
    const audit = await claimedVeto({})
    let release = () => {}, entered = () => {}
    const waiting = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
    const read = receipts.readConversationReceipt, owner = ownerIdentity.runtimeOwnerKey
    vi.spyOn(receipts, 'readConversationReceipt').mockImplementationOnce(async (...args) => {
      const receipt = await read(...args)
      if (stage === 'receipt-read') { entered(); await waiting }
      else vi.spyOn(ownerIdentity, 'runtimeOwnerKey').mockImplementationOnce(async (...expected) => { entered(); await waiting; return owner(...expected) })
      return receipt
    })
    const observing = audit.observeSdkMessage(nativePreFailure())
    try {
      await reached
      await audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: {
        content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'synthetic, never executed' } }],
      } })
    } finally { release() }
    await observing
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it.each([false, true])('requires native result durability before the actual SDK pool continues (fsync failure: %s)', async fail => {
    let afterYield: string | undefined
    const query = vi.fn(({ prompt, options }: SdkQueryParams) => ({ async *[Symbol.asyncIterator]() {
      for await (const _input of prompt) {
        yield { type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'synthetic, never executed' } }] } }
        const hooks = options.hooks as Awaited<ReturnType<typeof guardClaudeRuntimeTools>>
        await invoke(last(hooks, 'PreToolUse'), 'PreToolUse')
        if (fail) vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic native result fsync failure'))
        yield nativePreFailure()
        afterYield = (await listConversationReceipts())[0]?.state
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    }, interrupt: async () => {} }))
    let sessionId: string | undefined
    try {
      h.occupied = true
      __setSdkImporterForTests(async () => ({ query, USAGE_LIMIT_ERROR_PREFIXES: [] }))
      const sdk = await preloadSdk()
      const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'manager', sdk, agentSessionId: 'session-a', initialPrompt: 'synthetic',
        options: { cwd: '/synthetic/project', sessionId: 'session-a', runtimeOwnerKey: 'owner-a' } })
      sessionId = session.id; h.liveHandle = session.id
      await vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe(fail ? 'failed' : 'waiting'))
      expect(afterYield).toBe(fail ? undefined : 'delivered')
      expect((await listConversationReceipts())[0]?.state).toBe(fail ? 'executing' : 'delivered')
    } finally {
      if (sessionId) { terminateSdkSession(sessionId); await vi.waitFor(() => expect(getSdkSession(sessionId!)?.reaped).toBe(true)) }
      __setSdkImporterForTests(null)
    }
  })
})

describe('durable Claude tool audit hooks', () => {
  it.each([
    { order: 'root', observed: { command: 'synthetic, never executed', description: 'fixture', timeout: 1234, run_in_background: false },
      guarded: { command: 'synthetic, never executed', timeout: 1234, description: 'fixture', run_in_background: false } },
    { order: 'nested', observed: { command: 'synthetic, never executed', options: { targets: [{ left: 'a', right: 'b' }], enabled: true } },
      guarded: { command: 'synthetic, never executed', options: { enabled: true, targets: [{ right: 'b', left: 'a' }] } } },
    { order: 'distinct Unicode', observed: { command: 'synthetic, never executed', options: { '\u00e9': 'composed', 'e\u0301': 'decomposed' } },
      guarded: { command: 'synthetic, never executed', options: { 'e\u0301': 'decomposed', '\u00e9': 'composed' } } },
  ])('records a real guard-veto with reordered $order keys before the SDK pool exposes it, keeping the persisted plain hash', async ({ observed, guarded }) => {
    let stateAfterYield: string | undefined
    const query = vi.fn(({ prompt, options }: SdkQueryParams) => ({
      async *[Symbol.asyncIterator]() {
        for await (const _input of prompt) {
          yield { type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'guard-veto', name: 'Bash', input: observed }] } }
          const hooks = options.hooks as Awaited<ReturnType<typeof guardClaudeRuntimeTools>>
          const value = { ...input('PreToolUse', 'guard-veto'), tool_input: guarded } as HookInput
          await Promise.all(hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => hook(value, 'guard-veto', { signal: new AbortController().signal }))))
          yield { type: 'user', session_id: 'session-a', message: { content: [{ type: 'tool_result', tool_use_id: 'guard-veto', is_error: true,
            content: 'PreToolUse:Bash hook error: openground-guard BLOCKED: synthetic forbidden operation' }] } }
          // This runs only once the query wrapper has released the raw result.
          stateAfterYield = (await listConversationReceipts())[0]?.state
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        }
      }, interrupt: async () => {},
    }))
    let sessionId: string | undefined
    try {
      h.occupied = true
      __setSdkImporterForTests(async () => ({ query, USAGE_LIMIT_ERROR_PREFIXES: [] }))
      const sdk = await preloadSdk()
      const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'worker', sdk, agentSessionId: 'session-a', initialPrompt: 'synthetic',
        options: { cwd: '/synthetic/project', sessionId: 'session-a', runtimeOwnerKey: 'owner-a',
          hooks: { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' } })] }] } } })
      sessionId = session.id; h.liveHandle = session.id
      await vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe('waiting'))
      expect(stateAfterYield).toBe('rejected')
      expect((await listConversationReceipts())[0]).toMatchObject({ state: 'rejected', body: {
        inputHash: createHash('sha256').update(JSON.stringify(guarded)).digest('hex'),
      } })
    } finally {
      if (sessionId) { terminateSdkSession(sessionId); await vi.waitFor(() => expect(getSdkSession(sessionId!)?.reaped).toBe(true)) }
      __setSdkImporterForTests(null)
    }
  })
  it('matches a real guard and its claimed input by JSON value while retaining the claim’s original persisted hash', async () => {
    h.occupied = true
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' },
    })] }] }, 'owner-a')
    const guarded = { description: 'fixture', command: 'synthetic, never executed' }
    const claimed = { command: 'synthetic, never executed', description: 'fixture' }
    await audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: guarded }] } })
    const pre = (tool_input: unknown): HookInput => ({ ...input('PreToolUse'), tool_input } as HookInput)
    await audit.hooks.PreToolUse![0].hooks[0](pre(guarded), 'call-a', { signal: new AbortController().signal })
    await last(audit.hooks, 'PreToolUse')(pre(claimed), 'call-a', { signal: new AbortController().signal })
    const saved = (await listConversationReceipts())[0]
    await audit.observeSdkMessage(vetoResult())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'rejected', hash: saved.hash, body: saved.body })
    expect(saved.body).toMatchObject({ inputHash: createHash('sha256').update(JSON.stringify(claimed)).digest('hex') })
  })
  it.each([
    { difference: 'nested value', observed: { command: 'synthetic, never executed', options: { target: 'a' } }, guarded: { command: 'synthetic, never executed', options: { target: 'b' } } },
    { difference: 'array order', observed: { command: 'synthetic, never executed', targets: ['a', 'b'] }, guarded: { command: 'synthetic, never executed', targets: ['b', 'a'] } },
    { difference: 'Unicode key bytes', observed: { command: 'synthetic, never executed', options: { '\u00e9': 'fixture' } }, guarded: { command: 'synthetic, never executed', options: { 'e\u0301': 'fixture' } } },
  ])('does not equate an actual $difference change', async ({ observed, guarded }) => {
    h.occupied = true
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' },
    })] }] }, 'owner-a')
    await audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: observed }] } })
    const value = { ...input('PreToolUse'), tool_input: guarded } as HookInput
    await Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => hook(value, 'call-a', { signal: new AbortController().signal }))))
    await expect(audit.observeSdkMessage(vetoResult())).rejects.toThrow('does not match')
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('rejects cyclic assistant input before any outcome can be accepted', async () => {
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', {}, 'owner-a')
    const value: Record<string, unknown> = { command: 'synthetic, never executed' }
    value.self = value
    await expect(audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: value }] } })).rejects.toThrow()
    expect(await listConversationReceipts()).toEqual([])
  })
  it('fails closed on cyclic real guard input without creating a receipt or authorizing a later call', async () => {
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' },
    })] }] }, 'owner-a')
    const value: Record<string, unknown> = { command: 'synthetic, never executed' }
    value.self = value
    const pre = { ...input('PreToolUse'), tool_input: value } as HookInput
    const outcomes = await Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => hook(pre, 'call-a', { signal: new AbortController().signal }))))
    expect(outcomes.map(decision)).toEqual(['deny', 'deny'])
    expect(decision(await invoke(last(audit.hooks, 'PreToolUse'), 'PreToolUse', 'next-call'))).toBe('deny')
    expect(await listConversationReceipts()).toEqual([])
  })
  it('does not accept command stdout spoofing a veto without the real guard denying that exact call', async () => {
    const audit = await claimedVeto({})
    await audit.observeSdkMessage(vetoResult())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('never settles another query invocation’s claim from historical tool-result messages', async () => {
    await claimedVeto()
    const next = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', {}, 'owner-a')
    await next.observeSdkMessage(vetoResult())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('does not reject the first allowed execution when a same-ID duplicate is denied by the real guard', async () => {
    h.occupied = true
    let deny = false
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [async () => deny
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' } } : {}] }] }, 'owner-a')
    const pre = () => Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => invoke(hook, 'PreToolUse'))))
    expect(decision((await pre()).at(-1))).toBeUndefined()
    deny = true
    expect(decision((await pre()).at(-1))).toBe('deny')
    await audit.observeSdkMessage(vetoResult())
    await audit.observeSdkMessage(vetoResult())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('keeps a same-ID duplicate ambiguous while the first audit is still awaiting durable acceptance', async () => {
    h.occupied = true
    let deny = false, release = () => {}, entered = () => {}
    const waiting = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
    const original = receipts.acceptConversationReceipt
    vi.spyOn(receipts, 'acceptConversationReceipt').mockImplementationOnce(async (...args) => { entered(); await waiting; return original(...args) })
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [async () => deny
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' } } : {}] }] }, 'owner-a')
    const pre = () => Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => invoke(hook, 'PreToolUse'))))
    const first = pre()
    try { await reached; deny = true; await pre() } finally { release() }
    await first
    await audit.observeSdkMessage(vetoResult())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('rechecks sticky ambiguity when another Pre hook arrives during the observer’s receipt read', async () => {
    const audit = await claimedVeto()
    let release = () => {}, entered = () => {}
    const waiting = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
    const original = receipts.readConversationReceipt
    vi.spyOn(receipts, 'readConversationReceipt').mockImplementationOnce(async (...args) => { entered(); await waiting; return original(...args) })
    const observing = audit.observeSdkMessage(vetoResult())
    try {
      await reached
      await Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => invoke(hook, 'PreToolUse'))))
    } finally { release() }
    await observing
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('passes the original guard exactly the same input, tool ID and signal and returns its unchanged decision', async () => {
    const output = { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' } }
    const guard = vi.fn<HookCallback>(async () => output)
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ matcher: 'Bash', timeout: 7, hooks: [guard] }] }, 'owner-a')
    const value = input('PreToolUse'), options = { signal: new AbortController().signal }
    expect(audit.hooks.PreToolUse![0]).toMatchObject({ matcher: 'Bash', timeout: 7 })
    expect(await audit.hooks.PreToolUse![0].hooks[0](value, 'call-a', options)).toBe(output)
    expect(guard).toHaveBeenCalledExactlyOnceWith(value, 'call-a', options)
  })
  it('preserves the original guard’s exception instead of converting it to a grant or retry', async () => {
    const error = new Error('Synthetic original guard exception'), guard = vi.fn<HookCallback>(async () => { throw error })
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [guard] }] }, 'owner-a')
    await expect(invoke(audit.hooks.PreToolUse![0].hooks[0], 'PreToolUse')).rejects.toBe(error)
    expect(guard).toHaveBeenCalledOnce()
    expect(await listConversationReceipts()).toEqual([])
  })
  it.each(['generic-error', 'wrong-native-wrapper', 'not-error', 'interrupted-block', 'interrupted-message', 'background', 'structured-output'])('leaves %s results unconfirmed rather than inferring nonexecution', async kind => {
    const audit = await claimedVeto(), result = vetoResult()
    if (kind === 'generic-error') result.message.content[0].content = 'Permission denied'
    if (kind === 'wrong-native-wrapper') result.message.content[0].content = 'PreToolUse:Bash hook blocking error: openground-guard BLOCKED: synthetic forbidden operation'
    if (kind === 'not-error') result.message.content[0].is_error = false
    if (kind === 'interrupted-block') Object.assign(result.message.content[0], { is_interrupt: true })
    if (kind === 'interrupted-message') Object.assign(result, { is_interrupt: true })
    if (kind === 'background') Object.assign(result, { tool_use_result: { backgroundTaskId: 'still-running', interrupted: false } })
    if (kind === 'structured-output') Object.assign(result, { tool_use_result: { stdout: result.message.content[0].content, stderr: '', interrupted: false } })
    await audit.observeSdkMessage(result)
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it.each(['foreign-id', 'foreign-session'])('does not settle a %s result in this invocation', async kind => {
    const audit = await claimedVeto(), result = vetoResult()
    if (kind === 'foreign-id') result.message.content[0].tool_use_id = 'other-call'
    else result.session_id = 'other-session'
    await audit.observeSdkMessage(result)
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
    await audit.observeSdkMessage(vetoResult())
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'rejected' })
  })
  it('holds a tool whose observed input hash differs from the claimed guard input', async () => {
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'openground-guard BLOCKED: synthetic forbidden operation' },
    })] }] }, 'owner-a')
    h.occupied = true
    await audit.observeSdkMessage({ type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'different synthetic input' } }] } })
    await Promise.all(audit.hooks.PreToolUse!.flatMap(matcher => matcher.hooks.map(hook => invoke(hook, 'PreToolUse'))))
    await expect(audit.observeSdkMessage(vetoResult())).rejects.toThrow('does not match')
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it.each(['owner', 'handle'])('does not accept a late denied result after its %s changed', async kind => {
    const audit = await claimedVeto()
    if (kind === 'owner') h.owner = 'owner-b'
    else h.liveHandle = 'replacement-handle'
    await expect(audit.observeSdkMessage(vetoResult())).rejects.toThrow()
    h.owner = 'owner-a'
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
  })
  it('preserves an already settled receipt and makes repeated terminal veto observations immutable', async () => {
    const audit = await claimedVeto()
    await audit.observeSdkMessage(vetoResult())
    const saved = (await listConversationReceipts())[0]
    expect(saved).toMatchObject({ state: 'rejected', result: { denied: true, source: 'sdk-guard-veto', automaticReplay: false, effectsRolledBack: false } })
    const write = vi.spyOn(atomic, 'atomicWriteJson')
    await audit.observeSdkMessage(vetoResult())
    await invoke(last(audit.hooks, 'PostToolUse'), 'PostToolUse')
    expect((await listConversationReceipts())[0]).toEqual(saved)
    expect(write).not.toHaveBeenCalled()
  })
  it('does not downgrade a failed veto-result fsync to an advisory hook failure or admit another call', async () => {
    const audit = await claimedVeto()
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic veto-result fsync failure'))
    await expect(audit.observeSdkMessage(vetoResult())).rejects.toThrow('veto-result fsync failure')
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'executing' })
    expect(decision(await invoke(last(audit.hooks, 'PreToolUse'), 'PreToolUse', 'next-call'))).toBe('deny')
    expect(await listConversationReceipts()).toHaveLength(1)
  })
  it('forgets finished observations instead of growing with a long-lived query', async () => {
    const audit = await createClaudeRuntimeToolAudit('/synthetic/project', 'session-a', {}, 'owner-a')
    for (let index = 0; index < 300; index++) {
      const id = `observed-${index}`
      await audit.observeSdkMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } })
      await audit.observeSdkMessage(vetoResult(id))
    }
    expect(await listConversationReceipts()).toEqual([])
  })
  it('does not downgrade a revoked owner actor to legacy passthrough guards', async () => {
    const raw = { PreToolUse: [{ hooks: [vi.fn(async () => ({}))] }] }
    h.access = false
    await expect(guardClaudeRuntimeTools('/synthetic/project', 'session-a', raw, 'owner-a')).rejects.toThrow('owner account changed')
    expect(await guardClaudeRuntimeTools('/synthetic/project', 'session-a', raw)).toBe(raw)
  })
  it('retains existing permission denials and never returns an affirmative permission grant', async () => {
    const deny = vi.fn<HookCallback>(async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }))
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a', { PreToolUse: [{ hooks: [deny] }] })
    expect(decision(await invoke(hooks.PreToolUse![0].hooks[0], 'PreToolUse'))).toBe('deny')
    expect(deny).toHaveBeenCalledOnce()
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

// R-B1 (docs/AUTONOMY-SPEC.md): a tool call whose outcome the native transcript
// records never holds anything. Measured 2026-11-28: seven of the owner's eight
// holds had their result in a transcript — five of them in a sub-agent file,
// four vetoed by a settings hook the audit does not wrap.
describe('a tool receipt settled from the native Claude transcript', () => {
  const NATIVE = { confirmed: true, source: 'native-transcript', automaticReplay: false }
  const TOOL_INPUT = { command: 'synthetic, never executed' }
  const VETO = 'PreToolUse:Bash hook error: [bash /Users/me/.claude/swarm-guard.sh]: swarm-guard BLOCKED: git worktree remove --force. (manager guardrail — never do this; do it the safe way or ask the user.)\n'
  const ENDED = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]"
  const toolUse = (callId: string, agentId?: string, input: unknown = TOOL_INPUT, name = 'Bash') => JSON.stringify({ type: 'assistant', isSidechain: !!agentId,
    ...(agentId ? { agentId } : {}), sessionId: 'session-a', message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] } })
  const toolResult = (callId: string, content: string, isError: boolean, extra: Record<string, unknown> = {}, agentId?: string) => JSON.stringify({ type: 'user',
    isSidechain: !!agentId, ...(agentId ? { agentId } : {}), sessionId: 'session-a', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content, is_error: isError }] }, ...extra })
  const vetoed = (callId: string, agentId?: string) => toolResult(callId, VETO, true, { toolUseResult: `Error: ${VETO}`, toolDenialKind: 'permission-rule' }, agentId)
  const writeTranscript = async (cwd: string, files: { main?: string[]; sub?: string[] }) => {
    const dir = join(h.projects, claudeDirName(cwd))
    await mkdir(join(dir, 'session-a', 'subagents'), { recursive: true })
    if (files.main) await writeFile(join(dir, 'session-a.jsonl'), files.main.join('\n') + '\n')
    if (files.sub) await writeFile(join(dir, 'session-a', 'subagents', 'agent-fixture.jsonl'), files.sub.join('\n') + '\n')
  }
  const started = async () => {
    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    h.occupied = true
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse'))).toBeUndefined()
    return hooks
  }

  it('(a) settles a sub-agent call a settings hook denied, once its actor has ended', async () => {
    await started()
    await writeTranscript('/synthetic/project', { main: [toolUse('task-call')], sub: [toolUse('call-a', 'agent-fixture'), vetoed('call-a', 'agent-fixture')] })
    h.occupied = false
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).resolves.toBeUndefined()
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'delivered', result: { ...NATIVE, failed: true } })
  })
  it('settles an old-build receipt (no cwd) that a restart left uncertain, finding its folder by session id', async () => {
    await acceptConversationReceipt('project-a', 'tool-old-build', { kind: 'runtime-tool', provider: 'claude', sessionId: 'session-a', toolId: 'call-a', tool: 'Bash',
      inputHash: createHash('sha256').update(JSON.stringify(TOOL_INPUT)).digest('hex') })
    await claimConversationReceipt('project-a', 'tool-old-build', { sessionId: 'session-a', handleId: 'fixture-handle', runtime: 'sdk' })
    vi.resetModules()
    const restarted = await import('./runtimeActionReceipts'), journal = await import('./conversationReceipts')
    expect((await journal.listConversationReceipts()).map(r => r.state)).toEqual(['uncertain'])
    await expect(restarted.assertNoUncertainRuntimeActions('/synthetic/project', false)).rejects.toThrow('unconfirmed result')
    await writeTranscript('/Users/me/projects/old-build-cwd', { sub: [toolUse('call-a', 'agent-fixture'), vetoed('call-a', 'agent-fixture')] })
    await expect(restarted.assertNoUncertainRuntimeActions('/synthetic/project', false)).resolves.toBeUndefined()
    expect((await journal.listConversationReceipts())[0]).toMatchObject({ state: 'delivered', result: { ...NATIVE, failed: true } })
  })
  it('(b) heals a session whose PostToolUse write failed once, when the transcript has that result', async () => {
    const hooks = await started()
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic post fsync failure'))
    await expect(invoke(last(hooks, 'PostToolUse'), 'PostToolUse')).rejects.toThrow('post fsync failure')
    await writeTranscript('/synthetic/project', { main: [toolUse('call-a'), toolResult('call-a', 'done', false, { toolUseResult: { stdout: 'done', stderr: '', interrupted: false } })] })
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'call-after-healed-post'))).toBeUndefined()
    const saved = await listConversationReceipts()
    expect(saved.find(r => (r.body as { toolId?: string }).toolId === 'call-a')).toMatchObject({ state: 'delivered', result: { ...NATIVE, failed: false } })
    expect(saved.find(r => (r.body as { toolId?: string }).toolId === 'call-after-healed-post')?.state).toBe('executing')
  })
  it.each([
    { what: 'started without a result', lines: [toolUse('call-a')] },
    { what: 'interrupted (the CLI’s session-ended stand-in)', lines: [toolUse('call-a'), toolResult('call-a', ENDED, true, { toolUseResult: ENDED, toolDenialKind: 'interrupted' })] },
    // Review A-M1: `user-rejected` without toolDenialBeforeRun is how the CLI writes a
    // call an interrupt or a shutdown cut off WHILE RUNNING (real worker, a Bash 163 s in).
    { what: 'cut off while running (user-rejected, no toolDenialBeforeRun)', lines: [toolUse('call-a'),
      toolResult('call-a', "The user doesn't want to proceed with this tool use.", true, { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected' }),
      JSON.stringify({ type: 'user', sessionId: 'session-a', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })] },
    { what: 'written on shutdown (interruptedByShutdown)', lines: [toolUse('call-a'), toolResult('call-a', 'partial', true, { toolUseResult: 'Error: partial', interruptedByShutdown: true })] },
    { what: 'not in any transcript', lines: [] },
    { what: 'recorded only for other arguments under its ID', lines: [toolUse('call-a', undefined, { command: 'something else' }), toolResult('call-a', 'done', false)] },
    { what: 'recorded only for another tool under its ID', lines: [toolUse('call-a', undefined, TOOL_INPUT, 'Write'), toolResult('call-a', 'done', false)] },
  ])('(c) still holds a call that is $what once its actor ended', async ({ lines }) => {
    await started()
    await writeTranscript('/synthetic/project', { main: lines })
    h.occupied = false
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).rejects.toThrow('unconfirmed result')
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['executing'])
  })
  it('(c) keeps a poisoned session refused while the transcript shows its call started without a result', async () => {
    const hooks = await started()
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic post fsync failure'))
    await expect(invoke(last(hooks, 'PostToolUse'), 'PostToolUse')).rejects.toThrow('post fsync failure')
    await writeTranscript('/synthetic/project', { main: [toolUse('call-a')] })
    expect(decision(await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'call-after-failed-post'))).toBe('deny')
    expect(await listConversationReceipts()).toHaveLength(1)
  })
  it('(d) never rewrites a rejected or owner-reviewed receipt, nor one its own callback recorded as interrupted', async () => {
    const audit = await claimedVeto()
    await audit.observeSdkMessage(vetoResult())
    const rejected = (await listConversationReceipts())[0]
    expect(rejected).toMatchObject({ state: 'rejected', result: { source: 'sdk-guard-veto' } })
    await writeTranscript('/synthetic/project', { main: [toolUse('call-a'), toolResult('call-a', 'done', false)] })
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).resolves.toBeUndefined()
    expect(await receipts.settleReceiptFromEvidence(rejected, { failed: false })).toMatchObject({ state: 'rejected', result: rejected.result })

    await acceptConversationReceipt('project-a', 'tool-reviewed', { kind: 'runtime-tool', sessionId: 'session-a' })
    await claimConversationReceipt('project-a', 'tool-reviewed', { sessionId: 'session-a', handleId: 'fixture-handle', runtime: 'sdk' })
    await receipts.finishConversationReceipt('project-a', 'tool-reviewed', 'uncertain')
    const reviewed = await receipts.reviewConversationReceipt('project-a', 'tool-reviewed', 'checked by the owner', 'review-op')
    expect(await receipts.settleReceiptFromEvidence(reviewed, { failed: true })).toMatchObject({ state: 'delivered', result: { ownerReviewed: true, note: 'checked by the owner' } })

    const hooks = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    await invoke(last(hooks, 'PreToolUse'), 'PreToolUse', 'call-b')
    await last(hooks, 'PostToolUseFailure')({ ...input('PostToolUseFailure', 'call-b'), is_interrupt: true } as HookInput, 'call-b', { signal: new AbortController().signal })
    await writeTranscript('/synthetic/project', { main: [toolUse('call-a'), toolResult('call-a', 'done', false), toolUse('call-b'), toolResult('call-b', 'done', false)] })
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).rejects.toThrow('unconfirmed result')
    const all = await listConversationReceipts(), interrupted = all.find(r => (r.body as { toolId?: string }).toolId === 'call-b')!
    expect(all.find(r => r.id === rejected.id)).toEqual(rejected)
    expect(interrupted).toMatchObject({ state: 'uncertain', result: { failed: true, interrupted: true } })
    expect(await receipts.settleReceiptFromEvidence(interrupted, { failed: false })).toEqual(interrupted)
  })
  it('(d) settles only the tool receipt it read, and nothing that is not a tool receipt', async () => {
    await started()
    const tool = (await listConversationReceipts())[0]
    await acceptConversationReceipt('project-a', 'president-input', { kind: 'president-input', sessionId: 'session-a' })
    await claimConversationReceipt('project-a', 'president-input', { sessionId: 'session-a', handleId: 'fixture-handle', runtime: 'sdk' })
    const president = (await listConversationReceipts()).find(r => r.id === 'president-input')!
    expect(await receipts.settleReceiptFromEvidence({ ...tool, hash: '0'.repeat(64) }, { failed: false })).toBeUndefined()
    expect(await receipts.settleReceiptFromEvidence(president, { failed: false })).toBeUndefined()
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['executing', 'executing'])
  })
})

// R-B3 (docs/AUTONOMY-SPEC.md, owner decision 2026-11-28 §7-1 = A): a truly
// unknown result holds only the conversation that issued it. The only actor that
// can run that call again is that conversation; refusing every other session in
// the project protected nothing more and turned one stale receipt into days of no
// automation (§1.1).
describe('an unknown result holds only the conversation that issued it', () => {
  const interrupted = async () => {
    h.occupied = true // both sessions are alive
    const s1 = await guardClaudeRuntimeTools('/synthetic/project', 'session-a')
    expect(decision(await invoke(last(s1, 'PreToolUse'), 'PreToolUse', 'call-a'))).toBeUndefined()
    // S1's call is cut off (a native abort): its result is unknown while S1 lives on.
    await interruptRuntimeActions('session-a')
    expect((await listConversationReceipts())[0]).toMatchObject({ state: 'uncertain' })
    return s1
  }
  it('a tool call in another session of the same project is allowed while S1 holds', async () => {
    await interrupted()
    const s2 = await guardClaudeRuntimeTools('/synthetic/project', 'session-b')
    expect(decision(await invoke(last(s2, 'PreToolUse'), 'PreToolUse', 'call-b'))).toBeUndefined()
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false, 'session-b')).resolves.toBeUndefined()
  })
  it('S1 itself stays refused: its next tool call is denied and its launch is refused', async () => {
    const s1 = await interrupted()
    expect(decision(await invoke(last(s1, 'PreToolUse'), 'PreToolUse', 'call-a2'))).toBe('deny')
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false, 'session-a')).rejects.toThrow('unconfirmed result')
    // No session named — the whole-app and review callers — still sees it.
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false)).rejects.toThrow('unconfirmed result')
  })
  it('a receipt that names no session holds every conversation (unattributable evidence holds)', async () => {
    await acceptConversationReceipt('project-a', 'nameless', { kind: 'president-input' })
    await receipts.finishConversationReceipt('project-a', 'nameless', 'uncertain')
    await expect(assertNoUncertainRuntimeActions('/synthetic/project', false, 'session-b')).rejects.toThrow('unconfirmed result')
  })
})

// A USAGE REFUSAL IS NOT AN ABORT (2026-11-23 22:21 / 11-24 04:38).
//
// Measured: three workers on one project, one 5-hour limit. The two that were
// refused while the third was in the middle of a command ended on the spot —
// the refused turn asked "is anything in this project unconfirmed?" and counted
// the third worker's RUNNING command as unconfirmed. The engine read a quota
// stop as a crash (cards → blocked, never resumed). The same check ended the
// commander while its own helper's command was running; that command was killed
// with it, and the unconfirmed operation it left held the project for 8 hours.
describe('a usage refusal while a command is still running somewhere in the project', () => {
  const REFUSAL = "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)"
  const refusedSession = () => spawnSdkSession({ cwd: '/synthetic/project', role: 'worker', options: {}, initialPrompt: 'synthetic',
    queryFn: ({ prompt }) => ({ async *[Symbol.asyncIterator]() {
      for await (const _input of prompt) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    } }) })
  // Written through the module instance the session's own check will load: an
  // earlier test in this file restarts the modules (vi.resetModules), and a
  // receipt claimed by the instance from before that "restart" reads as left
  // over from a previous boot — unconfirmed by definition, whoever is alive.
  const running = async () => {
    const live = await import('./conversationReceipts')
    await live.acceptConversationReceipt('project-a', 'ongoing', { kind: 'runtime-tool', sessionId: 'another-worker' })
    await live.claimConversationReceipt('project-a', 'ongoing', { sessionId: 'another-worker', handleId: 'fixture-handle', runtime: 'sdk' })
  }
  beforeEach(() => __setQuotaPrefixesForTests(["You've hit your"]))
  afterEach(() => { __setQuotaPrefixesForTests(null); __resetSdkSessionsForTests() })

  it('parks the refused session — it is not ended, and the running command is left alone', async () => {
    await running()
    h.occupied = true // the actor running that command is alive
    const session = refusedSession()
    await vi.waitFor(() => expect(sdkQuotaPause(session.id)).not.toBeNull())
    expect(getSdkSession(session.id)).toMatchObject({ status: 'quota-parked' })
    expect(getSdkSession(session.id)?.exitReason).toBeUndefined()
    expect((await (await import('./conversationReceipts')).listConversationReceipts())[0]?.state).toBe('executing')
  })
  it('a named session is not ended by ANOTHER conversation\'s unconfirmed command (R-B3)', async () => {
    await running()
    h.occupied = false // the other worker's actor is gone: its command is unconfirmed
    const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'worker', agentSessionId: 'session-refused', options: {}, initialPrompt: 'synthetic',
      queryFn: ({ prompt }) => ({ async *[Symbol.asyncIterator]() {
        for await (const _input of prompt) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        }
      } }) })
    await vi.waitFor(() => expect(sdkQuotaPause(session.id)).not.toBeNull())
    expect(getSdkSession(session.id)?.exitReason).toBeUndefined()
  })
  it('still ends the session when the command really is unconfirmed (its actor is gone)', async () => {
    await running()
    h.occupied = false
    const session = refusedSession()
    await vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe('failed'))
    expect(getSdkSession(session.id)?.exitReason).toContain('unconfirmed result')
  })
})
