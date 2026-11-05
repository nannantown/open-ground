import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { registerTestProject } from '../../test/registerProject'
import { openGroundHome } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
import * as receipts from './conversationReceipts'
import { spawnSdkSession, terminateSdkSession, getSdkSession, sdkInputAdmissionPaused } from './sdkSession'
import { controlPresidentConversation, reviewNativeConversationRecovery } from './swarmRuntimeTransition'
import { recordSwarmSession } from './swarmSessions'
import { patchEngineIntent } from './swarmEnginePersistence'
import { sessionJsonlPath } from './transcript'
const h = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('./runtimeOwner', async (original) => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (expected && expected !== 'synthetic-owner') throw new Error('owner changed')
  return 'synthetic-owner'
} }))
vi.mock('./swarmSupply', async (original) => ({ ...(await original<typeof import('./swarmSupply')>()), spawnSwarmSupply: h.launch }))
const ids: string[] = []
beforeEach(() => { h.launch.mockReset().mockRejectedValue(new Error('Unexpected actor launch in a stale-control fixture')) })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of ids.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) }
})
const fixture = async () => {
  await mkdir(openGroundHome(), { recursive: true })
  const path = await realpath(await mkdtemp(join(openGroundHome(), 'president-control-')))
  await registerTestProject(path)
  const scope = await projectUUIDFromPath(path), context = await receipts.readConversationContext(scope)
  let stop = () => {}
  const stopped = new Promise<void>(resolve => { stop = resolve })
  const interrupt = vi.fn(async () => { stop() })
  const session = spawnSdkSession({ cwd: path, role: 'supply', options: {}, queryFn: () => ({
    async *[Symbol.asyncIterator]() { await stopped; yield* [] }, interrupt,
  }) })
  ids.push(session.id)
  return { path, scope, context, session, interrupt }
}
const nativeFixture = async () => {
  const f = await fixture()
  terminateSdkSession(f.session.id)
  await vi.waitFor(() => expect(getSdkSession(f.session.id)?.reaped).toBe(true))
  execFileSync('git', ['init', '--template=', f.path], { stdio: 'pipe' })
  const hooks = join(f.path, 'empty-fixture-hooks'); await mkdir(hooks)
  execFileSync('git', ['-C', f.path, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '--allow-empty', '-m', 'synthetic fixture'], { stdio: 'pipe' })
  const sessionId = randomUUID(), file = sessionJsonlPath(f.path, sessionId)
  await mkdir(dirname(file), { recursive: true })
  const old = JSON.stringify({ type: 'user', message: { content: 'OLD REQUEST MUST NOT BE REPLAYED' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unconfirmed-tool', name: 'Bash' }] } }) + '\n'
  await writeFile(file, old)
  await recordSwarmSession(f.path, 'supply', sessionId)
  await patchEngineIntent(f.path, { supplyDesired: true })
  const review = { id: `native-${sessionId}`, projectId: f.scope, sessionId, note: 'Owner inspected the actual Git changes and current work.', operationId: randomUUID(), expectedOwnerKey: 'synthetic-owner' }
  return { ...f, file, old, review }
}
describe('president controls bind the current durable conversation', () => {
  it('rejects an old conversation/epoch without interrupting or resetting the current desk', async () => {
    const f = await fixture()
    await receipts.rotateConversationContext(f.scope, f.context)
    await expect(controlPresidentConversation(f.path, { action: 'new-conversation', ...f.context, expectedOwnerKey: 'synthetic-owner' })).rejects.toThrow('stale president conversation')
    expect(getSdkSession(f.session.id)).not.toBeNull()
    expect(getSdkSession(f.session.id)?.closed).not.toBe(true); expect(f.interrupt).not.toHaveBeenCalled()
  })
  it('rechecks the context after draining and before retiring the recorded actor', async () => {
    const f = await fixture()
    vi.spyOn(receipts, 'readConversationContext').mockResolvedValueOnce(f.context)
      .mockResolvedValue({ conversationId: 'replacement-conversation', epoch: f.context.epoch + 1 })
    await expect(controlPresidentConversation(f.path, { action: 'new-conversation', ...f.context, expectedOwnerKey: 'synthetic-owner' })).rejects.toThrow('conversation changed')
    expect(getSdkSession(f.session.id)).not.toBeNull()
    expect(getSdkSession(f.session.id)?.closed).not.toBe(true); expect(f.interrupt).not.toHaveBeenCalled()
    expect(sdkInputAdmissionPaused(f.session.id)).toBe(false)
  })
  it('requires work review with no actor, then rotates the exact context and launches fresh from Board/Git and the note only', async () => {
    const f = await nativeFixture()
    await expect(controlPresidentConversation(f.path, { action: 'new-conversation', ...f.context, expectedOwnerKey: 'synthetic-owner' })).rejects.toThrow('Review the previous native')
    expect(h.launch).not.toHaveBeenCalled()
    await reviewNativeConversationRecovery(f.review)
    h.launch.mockImplementation(async (options: { beforeLaunch?: () => Promise<void> }) => { await options.beforeLaunch?.(); return { terminalId: 'synthetic-new-president' } })
    await controlPresidentConversation(f.path, { action: 'new-conversation', ...f.context, expectedOwnerKey: 'synthetic-owner' })
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.launch.mock.calls[0][0]).toMatchObject({ fresh: true, nativeRecovery: { sessionId: f.review.sessionId, note: f.review.note } })
    expect(h.launch.mock.calls[0][0].recoveryInstructions).toContain('CURRENT Board and Git')
    expect(h.launch.mock.calls[0][0].recoveryInstructions).not.toContain('OLD REQUEST MUST NOT BE REPLAYED')
    expect((await receipts.readConversationContext(f.scope)).epoch).toBe(f.context.epoch + 1)
    expect(await readFile(f.file, 'utf8')).toBe(f.old)
  })
  it('does not use a stale fingerprint review to rotate or launch a changed native conversation', async () => {
    const f = await nativeFixture()
    await reviewNativeConversationRecovery(f.review)
    await appendFile(f.file, JSON.stringify({ type: 'assistant', message: { content: 'native work changed after review' } }) + '\n')
    await expect(controlPresidentConversation(f.path, { action: 'new-conversation', ...f.context, expectedOwnerKey: 'synthetic-owner' })).rejects.toThrow('Review the previous native')
    expect(h.launch).not.toHaveBeenCalled()
    expect(await receipts.readConversationContext(f.scope)).toEqual(f.context)
  })
})
