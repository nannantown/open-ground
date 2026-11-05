import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openGroundHome } from './paths'
import { sessionJsonlPath } from './transcript'
import { inspectSwarmNativeConversation } from './swarmNativeTranscript'
import { createNativeConversationRecovery, listNativeConversationRecoveryIssues, nativePresidentRecoveryAdmission, reviewNativeConversationRecovery, type NativeRecoverySource } from './swarmNativeRecovery'
import { registerTestProject } from '../../test/registerProject'
import { patchEngineIntent, readEngineIntent } from './swarmEnginePersistence'
import { recordSwarmSession } from './swarmSessions'
import { setSettings } from './store'
import * as atomic from './atomicWrite'
const currentOwner = vi.hoisted(() => ({ key: 'synthetic-owner' }))
vi.mock('./runtimeOwner', async (original) => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (expected && expected !== currentOwner.key) throw new Error('owner changed')
  return currentOwner.key
} }))
vi.mock('./swarmTranscriptProof', async (original) => ({ ...(await original<typeof import('./swarmTranscriptProof')>()), isSessionHeldByProcess: async () => false }))
beforeEach(() => { currentOwner.key = 'synthetic-owner' })
afterEach(() => vi.restoreAllMocks())
const fixture = async () => {
  await mkdir(openGroundHome(), { recursive: true })
  const cwd = await mkdtemp(join(openGroundHome(), 'native-recovery-')), sessionId = randomUUID()
  const source: NativeRecoverySource = { projectId: randomUUID(), projectPath: cwd, cwd, role: 'supply', sessionId }
  const file = sessionJsonlPath(cwd, sessionId)
  const original = JSON.stringify({ type: 'user', message: { content: 'Old request must never be replayed' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unknown-action', name: 'Bash', input: { command: 'never executed by this test' } }] } }) + '\n'
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, original)
  let owner = 'owner-a', held = false
  const deps = { sources: async () => [source], inspect: inspectSwarmNativeConversation, held: async () => held,
    owner: async (expected?: string) => { if (expected && expected !== owner) throw new Error('owner changed'); return owner } }
  const options = { id: `native-${sessionId}`, projectId: source.projectId, sessionId, note: 'Owner checked the actual Git changes and command result.', operationId: randomUUID(), expectedOwnerKey: 'owner-a' }
  return { source, file, original, options, deps, recovery: createNativeConversationRecovery(deps), owner: (value: string) => { owner = value }, held: (value: boolean) => { held = value } }
}
const stoppedPresident = async () => {
  await mkdir(openGroundHome(), { recursive: true })
  const path = await realpath(await mkdtemp(join(openGroundHome(), 'stopped-president-')))
  const projectId = await registerTestProject(path), sessionId = randomUUID(), file = sessionJsonlPath(path, sessionId)
  const original = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unfinished-tool', name: 'Bash' }] } }) + '\n'
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, original)
  await recordSwarmSession(path, 'supply', sessionId)
  await setSettings({ swarmProvider: 'claude' })
  await patchEngineIntent(path, { supplyDesired: false })
  const issue = { id: `native-${sessionId}`, scope: projectId, kind: 'conversation', conversationId: sessionId, tool: 'Bash', state: 'uncertain' }
  const review = { id: issue.id, projectId, sessionId, note: 'Inspected the actual command result and repository.', operationId: randomUUID(), expectedOwnerKey: currentOwner.key }
  const hash = createHash('sha256').update(JSON.stringify([currentOwner.key, projectId, 'supply', sessionId])).digest('hex')
  return { path, projectId, sessionId, file, original, issue, review, pending: join(openGroundHome(), 'runtime', 'native-review-requests', `${hash}.json`) }
}
describe('owner-reviewed native recovery markers', () => {
  it('makes only an explicitly requested stopped president reviewable without reviving dormant project intent', async () => {
    const f = await stoppedPresident(), dormant = await stoppedPresident()
    await patchEngineIntent(f.path, { supplyDesired: true })
    expect(await listNativeConversationRecoveryIssues()).toContainEqual(f.issue)
    // This is the exact persisted change made by the manual stop route. Its
    // native session slot and unfinished transcript remain as actual evidence.
    await patchEngineIntent(f.path, { supplyDesired: false })
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(f.issue)
    await expect(nativePresidentRecoveryAdmission(f.path, currentOwner.key)).rejects.toThrow('Review the previous native')
    expect(await listNativeConversationRecoveryIssues()).toContainEqual(f.issue)
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(dormant.issue)
    expect(await readFile(f.pending, 'utf8')).not.toContain('unfinished-tool')
    if (process.platform !== 'win32') {
      expect((await stat(f.pending)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(f.pending))).mode & 0o777).toBe(0o700)
    }
    await reviewNativeConversationRecovery(f.review)
    await expect(stat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
    // A crash after marker fsync + pending removal but before the enclosing
    // control receipt commits must allow only this exact reviewed replay.
    await reviewNativeConversationRecovery(f.review)
    await expect(reviewNativeConversationRecovery({ ...f.review, note: 'Changed actual result' })).rejects.toThrow('different work')
    expect(await nativePresidentRecoveryAdmission(f.path, currentOwner.key)).toMatchObject({ note: f.review.note, sessionId: f.sessionId })
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(f.issue)
    expect((await readEngineIntent(f.path)).supplyDesired).not.toBe(true)
    expect(await readFile(f.file, 'utf8')).toBe(f.original)
  })
  it('never treats an unsaved request or unsaved review marker as reviewed work', async () => {
    const f = await stoppedPresident(), persist = atomic.atomicWriteJson
    const fault = vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, value, options) => {
      if (String(path).includes('/native-review-requests/')) throw Object.assign(new Error('synthetic request fsync failure'), { code: 'EIO' })
      return persist(path, value, options)
    })
    await expect(nativePresidentRecoveryAdmission(f.path, currentOwner.key)).rejects.toThrow('request fsync failure')
    await expect(stat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(f.issue)
    fault.mockRestore()
    await expect(nativePresidentRecoveryAdmission(f.path, currentOwner.key)).rejects.toThrow('Review the previous native')
    const markerFault = vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, value, options) => {
      if (String(path).includes('/native-conversation-reviews/')) throw new Error('synthetic marker fsync failure')
      return persist(path, value, options)
    })
    await expect(reviewNativeConversationRecovery(f.review)).rejects.toThrow('marker fsync failure')
    expect(await stat(f.pending)).toBeDefined()
    expect(await listNativeConversationRecoveryIssues()).toContainEqual(f.issue)
    markerFault.mockRestore()
    await reviewNativeConversationRecovery(f.review)
    expect(await readFile(f.file, 'utf8')).toBe(f.original)
  })
  it('requires the admitted owner, current session slot and exact inspected fingerprint', async () => {
    const f = await stoppedPresident()
    await expect(nativePresidentRecoveryAdmission(f.path, currentOwner.key)).rejects.toThrow('Review the previous native')
    currentOwner.key = 'replacement-owner'
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(f.issue)
    await expect(reviewNativeConversationRecovery(f.review)).rejects.toThrow('owner changed')
    currentOwner.key = 'synthetic-owner'
    await appendFile(f.file, JSON.stringify({ type: 'assistant', message: { content: 'Work changed after inspection.' } }) + '\n')
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(f.issue)
    await expect(reviewNativeConversationRecovery(f.review)).rejects.toThrow('source changed')
    await expect(nativePresidentRecoveryAdmission(f.path, currentOwner.key)).rejects.toThrow('Review the previous native')
    expect(await listNativeConversationRecoveryIssues()).toContainEqual(f.issue)
    await recordSwarmSession(f.path, 'supply', randomUUID())
    expect(await listNativeConversationRecoveryIssues()).not.toContainEqual(f.issue)
    await expect(reviewNativeConversationRecovery(f.review)).rejects.toThrow('source changed')
  })
  it('holds a new explicit request when bounded storage is full without evicting unresolved requests', async () => {
    const f = await stoppedPresident(), directory = dirname(f.pending)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const before = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)), seeded: string[] = []
    try {
      for (let index = before.length; index < 128; index++) {
        const request = { version: 1, ownerKey: 'unrelated-owner', projectId: randomUUID(), projectPath: f.path, cwd: f.path, role: 'supply', sessionId: randomUUID(), fingerprint: 'a'.repeat(64), requestedAt: new Date().toISOString() }
        const hash = createHash('sha256').update(JSON.stringify([request.ownerKey, request.projectId, request.role, request.sessionId])).digest('hex')
        const file = join(directory, `${hash}.json`)
        await writeFile(file, JSON.stringify(request), { mode: 0o600 }); seeded.push(file)
      }
      await expect(nativePresidentRecoveryAdmission(f.path, currentOwner.key)).rejects.toThrow('storage limit')
      await expect(stat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(128)
      expect(await readFile(f.file, 'utf8')).toBe(f.original)
    } finally { await Promise.all(seeded.map(file => unlink(file))) }
  })
  it('saves an idempotent fingerprint-bound review without editing the CLI history or fabricating a tool result', async () => {
    const f = await fixture()
    expect(await f.recovery.list()).toEqual([{ id: f.options.id, scope: f.source.projectId, kind: 'conversation', conversationId: f.source.sessionId, tool: 'Bash', state: 'uncertain' }])
    await f.recovery.review(f.options); await f.recovery.review(f.options)
    expect((await f.recovery.state(f.source, 'owner-a')).review).toMatchObject({ note: f.options.note, operationId: f.options.operationId })
    expect(await f.recovery.list()).toEqual([])
    expect(await readFile(f.file, 'utf8')).toBe(f.original)
    await expect(f.recovery.review({ ...f.options, note: 'Changed meaning with the same ID' })).rejects.toThrow('different work')
  })
  it('invalidates a review when the transcript changes or a different owner asks to use it', async () => {
    const f = await fixture()
    await f.recovery.review(f.options)
    f.owner('owner-b')
    expect((await f.recovery.state(f.source, 'owner-b')).review).toBeUndefined()
    await expect(f.recovery.review(f.options)).rejects.toThrow('owner changed')
    f.owner('owner-a')
    await appendFile(f.file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'new content after inspection' }] } }) + '\n')
    expect((await f.recovery.state(f.source, 'owner-a')).review).toBeUndefined()
    expect(await f.recovery.list()).toHaveLength(1)
  })
  it('refuses live processes, stale project identity, empty notes and account replacement during review', async () => {
    const f = await fixture()
    f.held(true)
    await expect(f.recovery.review(f.options)).rejects.toThrow('still running')
    f.held(false)
    await expect(f.recovery.review({ ...f.options, projectId: 'another-project' })).rejects.toThrow('source changed')
    await expect(f.recovery.review({ ...f.options, note: ' ' })).rejects.toThrow()
    const inspect = f.deps.inspect
    f.deps.inspect = async (...args) => { const proof = await inspect(...args); f.owner('owner-b'); return proof }
    await expect(f.recovery.review(f.options)).rejects.toThrow('owner changed')
    expect((await readFile(f.file, 'utf8'))).toBe(f.original)
  })
  it('keeps a truncated native record held but permits explicit work review without repairing or editing that record', async () => {
    const f = await fixture()
    await appendFile(f.file, '{"type":"assistant","message":')
    const bytes = await readFile(f.file)
    expect(await f.recovery.list()).toHaveLength(1)
    await f.recovery.review(f.options)
    expect((await f.recovery.state(f.source, 'owner-a')).review).toBeDefined()
    expect(await readFile(f.file)).toEqual(bytes)
  })
})
