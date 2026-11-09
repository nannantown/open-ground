import { mkdir, open, opendir, readFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { atomicWriteJson } from './atomicWrite'
import { openGroundHome } from './paths'
import { runtimeOwnerKey } from './runtimeOwner'
import { getSettings, isSwarmManualStopPersisted } from './store'
import { readEngineIntent } from './swarmEnginePersistence'
import { readSwarmSessions } from './swarmSessions'
import { readRoster } from './swarmWorkerRoster'
import { isAgentConversationOccupied } from './liveDesks'
import { isSessionHeldByProcess } from './swarmTranscriptProof'
import { inspectSwarmNativeConversation } from './swarmNativeTranscript'
import { claudeDirName } from './claudeProjectDir'

export interface NativeRecoverySource { projectId: string; projectPath: string; cwd: string; role: 'supply' | 'manager' | 'worker'; sessionId: string; requestedFingerprint?: string }
const marker = z.object({ ownerKey: z.string().min(1).max(128), projectId: z.string().min(1).max(128), role: z.enum(['supply', 'manager', 'worker']),
  sessionId: z.string().min(1).max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().trim().min(1).max(1000),
  operationId: z.string().min(1).max(128), reviewedAt: z.string().datetime() }).strict()
export type NativeRecoveryAdmission = z.infer<typeof marker>
const saved = z.object({ version: z.literal(1), review: marker }).strict()
let writer: Promise<unknown> = Promise.resolve()
const key = (owner: string, source: NativeRecoverySource) => createHash('sha256').update(JSON.stringify([owner, source.projectId, source.role, source.sessionId])).digest('hex')
const markerFile = (owner: string, source: NativeRecoverySource) => join(openGroundHome(), 'runtime', 'native-conversation-reviews', `${key(owner, source)}.json`)
const pending = z.object({ version: z.literal(1), ownerKey: z.string().min(1).max(128), projectId: z.string().min(1).max(128),
  projectPath: z.string().min(1).max(4096), cwd: z.string().min(1).max(4096), role: z.literal('supply'), sessionId: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestedAt: z.string().datetime() }).strict()
type PendingReview = z.infer<typeof pending>
const PENDING_LIMIT = 128
const PENDING_BYTES = 16 * 1024
const pendingDir = () => join(openGroundHome(), 'runtime', 'native-review-requests')
const pendingFile = (owner: string, source: NativeRecoverySource) => join(pendingDir(), `${key(owner, source)}.json`)
const syncDirectory = async (path: string) => {
  if (process.platform === 'win32') return
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}
/** Only explicit recovery requests are scanned; dormant native histories are
 * never enrolled merely because their project is registered. */
const pendingReviews = async (): Promise<PendingReview[]> => {
  let directory: Awaited<ReturnType<typeof opendir>>
  try { directory = await opendir(pendingDir()) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const result: PendingReview[] = []
  let entries = 0
  for await (const entry of directory) {
    if (++entries > PENDING_LIMIT * 2 + 8) throw new Error('Native recovery requests exceed their storage limit.')
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
    if (!entry.isFile()) throw new Error('Invalid native recovery request storage.')
    let bytes: string
    try { bytes = await readFile(join(pendingDir(), entry.name), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (Buffer.byteLength(bytes) > PENDING_BYTES) throw new Error('Native recovery request exceeds its inspection limit.')
    const request = pending.parse(JSON.parse(bytes))
    if (entry.name !== `${key(request.ownerKey, request)}.json`) throw new Error('Invalid native recovery request identity.')
    result.push(request)
    if (result.length > PENDING_LIMIT) throw new Error('Native recovery requests exceed their storage limit.')
  }
  return result
}
const read = async (owner: string, target: NativeRecoverySource): Promise<NativeRecoveryAdmission | undefined> => {
  try {
    const source = await readFile(markerFile(owner, target), 'utf8')
    if (Buffer.byteLength(source) > 8192) throw new Error('Native review storage exceeds its inspection limit.')
    const review = saved.parse(JSON.parse(source)).review
    if (review.ownerKey !== owner || review.projectId !== target.projectId || review.role !== target.role || review.sessionId !== target.sessionId) throw new Error('The native review belongs to another conversation.')
    return review
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export interface NativeConversationRecoveryIssue {
  id: string
  scope: string
  kind: 'conversation'
  conversationId: string
  tool?: string
  state: 'uncertain'
  /** A bounded inspection failed; never a raw filesystem/provider error. */
  inspectionError?: 'native-history-unavailable'
}
export interface NativeRecoveryDeps {
  sources(): Promise<NativeRecoverySource[]>
  inspect(cwd: string, sessionId: string): ReturnType<typeof inspectSwarmNativeConversation>
  held(sessionId: string): Promise<boolean>
  owner(expected?: string): Promise<string>
  reviewed?(source: NativeRecoverySource, owner: string): Promise<void>
}
export const createNativeConversationRecovery = (deps: NativeRecoveryDeps) => {
  const inspectedState = async (source: NativeRecoverySource, owner: string, proof: Awaited<ReturnType<NativeRecoveryDeps['inspect']>>) => {
    if (source.requestedFingerprint && source.requestedFingerprint !== proof.fingerprint) throw new Error('The requested native conversation changed. Inspect it again before reviewing.')
    const review = await read(owner, source)
    return { proof, review: review?.fingerprint === proof.fingerprint ? review : undefined }
  }
  const state = async (source: NativeRecoverySource, owner: string) => {
    if (await deps.held(source.sessionId)) throw new Error('The native conversation is still running. Stop it before reviewing its work.')
    return inspectedState(source, owner, await deps.inspect(source.cwd, source.sessionId))
  }
  const review = async (options: { id: string; projectId: string; sessionId: string; note: string; operationId: string; expectedOwnerKey: string }): Promise<void> => {
    const owner = await deps.owner(options.expectedOwnerKey)
    if (options.id !== `native-${options.sessionId}`) throw new Error('Invalid native recovery identity.')
    const sources = (await deps.sources()).filter(source => source.projectId === options.projectId && source.sessionId === options.sessionId)
    if (sources.length !== 1) throw new Error('The native recovery source changed.')
    const source = sources[0], initial = await state(source, owner)
    if (!initial.proof.unfinishedTools.length) throw new Error('This native conversation has no unfinished action to review.')
    const next = marker.parse({ ownerKey: owner, projectId: source.projectId, role: source.role, sessionId: source.sessionId,
      fingerprint: initial.proof.fingerprint, note: options.note, operationId: options.operationId, reviewedAt: new Date().toISOString() })
    const write = writer.then(async () => {
      await deps.owner(owner)
      const current = (await deps.sources()).find(item => item.projectId === source.projectId && item.role === source.role && item.sessionId === source.sessionId && item.cwd === source.cwd)
      if (!current || await deps.held(source.sessionId) || (await deps.inspect(source.cwd, source.sessionId)).fingerprint !== next.fingerprint) throw new Error('The native conversation changed before its review could be saved.')
      const previous = await read(owner, source)
      if (previous?.operationId === next.operationId) {
        if (previous.note !== next.note || previous.fingerprint !== next.fingerprint) throw new Error('This review operation was already used for different work.')
        await deps.reviewed?.(source, owner)
        return
      }
      const file = markerFile(owner, source)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await deps.owner(owner)
      await atomicWriteJson(file, { version: 1, review: next }, { mode: 0o600, fsync: true })
      await deps.reviewed?.(source, owner)
    })
    writer = write.catch(() => {})
    await write
  }
  return { review, state, list: async () => {
    const owner = await deps.owner(), issues: NativeConversationRecoveryIssue[] = []
    for (const source of await deps.sources()) {
      await deps.owner(owner)
      if (await deps.held(source.sessionId)) continue
      let proof: Awaited<ReturnType<NativeRecoveryDeps['inspect']>>
      try { proof = await deps.inspect(source.cwd, source.sessionId) }
      catch (error) {
        await deps.owner(owner)
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        const held = await deps.held(source.sessionId)
        await deps.owner(owner)
        if (held) continue
        // Isolate only the transcript inspection. An oversized, unreadable or
        // changing file cannot hide other launch/effect recovery. Its review
        // and admission still use state(), so unavailable proof grants nothing.
        issues.push({ id: `native-${source.sessionId}`, scope: source.projectId, kind: 'conversation', conversationId: source.sessionId, state: 'uncertain', inspectionError: 'native-history-unavailable' })
        continue
      }
      const held = await deps.held(source.sessionId)
      await deps.owner(owner)
      if (held) continue
      // Requested source fingerprints and saved marker identities are security
      // checks, not inspection failures; keep them outside the isolated catch.
      const current = await inspectedState(source, owner, proof)
      if (current.proof.unfinishedTools.length && !current.review) issues.push({ id: `native-${source.sessionId}`, scope: source.projectId, kind: 'conversation', conversationId: source.sessionId, tool: current.proof.unfinishedTools[0].name, state: 'uncertain' })
    }
    await deps.owner(owner)
    return issues
  } }
}

const sources = async (): Promise<NativeRecoverySource[]> => {
  const settings = await getSettings(), result: NativeRecoverySource[] = []
  if (settings.swarmProvider === 'chatgpt') return result
  for (const project of settings.projects ?? []) {
    const intent = await readEngineIntent(project.path), sessions = await readSwarmSessions(project.path)
    for (const role of ['supply', 'manager'] as const) {
      const session = sessions[role]
      if (session && claudeDirName(session.cwd) === claudeDirName(project.path) && (role === 'supply' ? intent.supplyDesired : intent.managerDesired)) result.push({ projectId: project.id, projectPath: project.path, cwd: session.cwd, sessionId: session.sessionId, role })
    }
    if (intent.desiredRunning && !await isSwarmManualStopPersisted(project.path)) for (const worker of await readRoster(project.path)) {
      if (!worker.sessionId.startsWith('chatgpt-')) result.push({ projectId: project.id, projectPath: project.path, cwd: worker.worktree, role: 'worker', sessionId: worker.sessionId })
    }
  }
  const owner = await runtimeOwnerKey()
  for (const request of await pendingReviews()) {
    if (request.ownerKey !== owner || result.some(source => key(owner, source) === key(owner, request))) continue
    if (!settings.projects?.some(project => project.id === request.projectId && project.path === request.projectPath)) continue
    const current = await presidentSource(request.projectPath)
    if (!current || !sameSource(current, request)) continue
    try {
      if ((await inspectSwarmNativeConversation(current.cwd, current.sessionId)).fingerprint === request.fingerprint) result.push({ ...current, requestedFingerprint: request.fingerprint })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // The request's schema, identity and current source were already checked.
      // Retain its exact fingerprint for list() to report unavailable proof;
      // state()/review() must still inspect successfully before any admission.
      result.push({ ...current, requestedFingerprint: request.fingerprint })
    }
  }
  return result
}
const sameSource = (a: NativeRecoverySource, b: NativeRecoverySource) => a.projectId === b.projectId && a.projectPath === b.projectPath && a.cwd === b.cwd && a.role === b.role && a.sessionId === b.sessionId
const removePendingReview = async (source: NativeRecoverySource, owner: string) => {
  await runtimeOwnerKey(owner)
  // atomicWriteJson fsyncs file data but its directory sync is best effort.
  // Request removal requires a durable marker entry, including a new directory.
  await syncDirectory(dirname(markerFile(owner, source)))
  await syncDirectory(dirname(dirname(markerFile(owner, source))))
  try { await unlink(pendingFile(owner, source)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  await syncDirectory(pendingDir())
}
const deps: NativeRecoveryDeps = { sources, inspect: inspectSwarmNativeConversation, owner: runtimeOwnerKey,
  held: async sessionId => isAgentConversationOccupied(sessionId) || await isSessionHeldByProcess(sessionId) !== false, reviewed: removePendingReview }
const recovery = createNativeConversationRecovery(deps)
export const listNativeConversationRecoveryIssues = recovery.list
export const reviewNativeConversationRecovery: typeof recovery.review = async options => {
  const owner = await runtimeOwnerKey(options.expectedOwnerKey)
  const project = (await getSettings()).projects?.find(project => project.id === options.projectId)
  const source = project && await presidentSource(project.path)
  if (source?.sessionId === options.sessionId && options.id === `native-${source.sessionId}`) {
    const existing = (await recovery.state(source, owner)).review
    // Marker durability precedes request removal. The enclosing control receipt
    // may still have failed to fsync, so its exact reviewed operation can retry
    // without enrolling every stopped conversation in global recovery.
    if (existing?.operationId === options.operationId) {
      if (existing.note !== options.note.trim()) throw new Error('This review operation was already used for different work.')
      const replay = writer.then(async () => {
        await runtimeOwnerKey(owner)
        const current = await presidentSource(source.projectPath)
        if (!current || !sameSource(current, source)) throw new Error('The native recovery source changed.')
        const review = (await recovery.state(current, owner)).review
        if (review?.operationId !== options.operationId || review.note !== options.note.trim()) throw new Error('The reviewed native conversation changed.')
        await removePendingReview(current, owner)
      })
      writer = replay.catch(() => {})
      await replay
      return
    }
  }
  return recovery.review(options)
}
export const nativeConversationRecoveryReviewed = async (projectId: string, cwd: string, sessionId: string): Promise<boolean> => {
  const owner = await runtimeOwnerKey(), source = (await sources()).find(source => source.projectId === projectId && source.cwd === cwd && source.sessionId === sessionId)
  return !!source && !!(await recovery.state(source, owner)).review
}

const presidentSource = async (projectPath: string): Promise<NativeRecoverySource | undefined> => {
  const { projectUUIDFromPath } = await import('./projectDataPath')
  const projectId = await projectUUIDFromPath(projectPath)
  const settings = await getSettings(), project = settings.projects?.find(project => project.id === projectId)
  if (!project) throw new Error('The president project is not registered.')
  if (settings.swarmProvider === 'chatgpt') return undefined
  const session = (await readSwarmSessions(projectPath)).supply
  return session && claudeDirName(session.cwd) === claudeDirName(projectPath) ? { projectId: project.id, projectPath, cwd: session.cwd, sessionId: session.sessionId, role: 'supply' } : undefined
}
const requestPresidentReview = async (source: NativeRecoverySource, owner: string, fingerprint: string): Promise<void> => {
  const write = writer.then(async () => {
    await runtimeOwnerKey(owner)
    const current = await presidentSource(source.projectPath)
    if (!current || !sameSource(current, source) || await deps.held(source.sessionId)
      || (await inspectSwarmNativeConversation(source.cwd, source.sessionId)).fingerprint !== fingerprint) throw new Error('The native conversation changed before recovery could be requested.')
    const request = pending.parse({ version: 1, ownerKey: owner, ...source, fingerprint, requestedAt: new Date().toISOString() })
    const savedRequests = await pendingReviews()
    if (savedRequests.some(saved => saved.ownerKey === owner && sameSource(saved, source) && saved.fingerprint === fingerprint)) {
      await syncDirectory(dirname(pendingDir()))
      await syncDirectory(pendingDir())
      return
    }
    if (savedRequests.length >= PENDING_LIMIT && !savedRequests.some(saved => saved.ownerKey === owner && sameSource(saved, source))) throw new Error('Native recovery requests exceed their storage limit.')
    if (Buffer.byteLength(JSON.stringify(request, null, 2)) > PENDING_BYTES) throw new Error('Native recovery request exceeds its inspection limit.')
    await mkdir(pendingDir(), { recursive: true, mode: 0o700 })
    await syncDirectory(dirname(pendingDir()))
    await runtimeOwnerKey(owner)
    await atomicWriteJson(pendingFile(owner, source), request, { mode: 0o600, fsync: true })
    await syncDirectory(pendingDir())
  })
  writer = write.catch(() => {})
  await write
}
export const nativePresidentRecoveryAdmission = async (projectPath: string, expectedOwnerKey: string): Promise<NativeRecoveryAdmission | undefined> => {
  const owner = await runtimeOwnerKey(expectedOwnerKey), source = await presidentSource(projectPath)
  if (!source) return undefined
  let current: Awaited<ReturnType<typeof recovery.state>>
  try { current = await recovery.state(source, owner) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!current.proof.unfinishedTools.length) return undefined
  if (!current.review) {
    await requestPresidentReview(source, owner, current.proof.fingerprint)
    throw new Error('Review the previous native conversation’s actual work before starting a new conversation.')
  }
  return current.review
}
export const validateNativePresidentRecoveryAdmission = async (projectPath: string, expected: NativeRecoveryAdmission): Promise<void> => {
  const current = await nativePresidentRecoveryAdmission(projectPath, expected.ownerKey)
  if (!current || current.sessionId !== expected.sessionId || current.projectId !== expected.projectId || current.role !== 'supply'
    || current.fingerprint !== expected.fingerprint || current.note !== expected.note || current.operationId !== expected.operationId) throw new Error('The native recovery review changed. Inspect the current work before launching.')
}
