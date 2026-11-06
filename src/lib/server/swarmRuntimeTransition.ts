import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getSettings, isSwarmManualStopPersisted } from './store'
import { getRuntimeJournal, getRuntimeTransition, updateRuntimeCheckpoint, updateRuntimeJournal, runtimeAdmissionBlocked, type RuntimeProfile } from './runtimeTransitionStore'
import { runtimeOwnerKey } from './runtimeOwner'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, listConversationReceipts, readConversationReceipt, readConversationContext } from './conversationReceipts'
import { acceptPresidentInput, cancelQueuedPresidentInputs, cancelUnsubmittedPresidentInput, awaitPresidentInputSettlement } from './presidentInbox'
import { awaitSwarmRuntimeLaunches, type SwarmRuntimeHandoff } from './swarmRuntimeAdmission'
import { drainSwarmEngines, replaceSwarmTransitionWorker, swarmTransitionWorkStillNeeded, swarmTransitionCurrentAssignment, type SwarmTransitionEngine } from './swarmOrchestrator'
import { drainSdkSession, getSdkSession, listSdkSessions, terminateSdkSession, pushSdkInput, interruptSdkSession, currentSdkTurnId, sdkInputAdmissionPaused, resumeSdkInputAdmission } from './sdkSession'
import { getTerminal, getTerminalScreen, isTerminalProcessAlive, killTerminal, listOwnerDeskTerminals, waitForTerminalGone } from './terminal'
import { noticeHoldReason } from './deskDeliverable'
import { sendInterrupt } from './claudeTerminal'
import { classifyQuotaRefusal } from './swarmRateLimitText'
import { sessionJsonlPath } from './transcript'
import { readSwarmNativePublicConversation, assertSwarmNativeConversationSettled, NativeUnfinishedToolsError } from './swarmNativeTranscript'
import { spawnSwarmWorker } from './swarmWorker'
import { spawnSwarmManager } from './swarmManager'
import { spawnSwarmSupply } from './swarmSupply'
import { listLiveSupplyDesks, SUPPLY_DESK_LABEL, type SupplyDeskHandle } from './swarmSupplyRuntime'
import { drainSupplyNoticeDeliveries, ownerSayLine } from './supplyNotice'
import { MANAGER_DESK_LABEL } from './swarmManagerLabel'
import { readRoster } from './swarmWorkerRoster'
import { readEngineIntent } from './swarmEnginePersistence'
import { readSwarmSessions } from './swarmSessions'
import { chatGptConversationRecovery, chatGptPublicConversation } from './chatgptResponses'
import { chatGptConversationFile } from './chatgptResponses'
import { nativePresidentRecoveryAdmission, validateNativePresidentRecoveryAdmission, nativeConversationRecoveryReviewed } from './swarmNativeRecovery'
export { listNativeConversationRecoveryIssues, reviewNativeConversationRecovery } from './swarmNativeRecovery'
import { isSessionHeldByProcess } from './swarmTranscriptProof'
import type { SpawnSwarmWorkerResponse } from '../types'

const execFile = promisify(execFileCallback)
const publicLine = z.object({ kind: z.enum(['input', 'text']), text: z.string() }).strict()
const pendingInput = z.object({ text: z.string(), operationId: z.string().optional() }).strict()
const actorSchema = z.object({
  id: z.string().min(1), runtime: z.enum(['sdk', 'pty']), role: z.enum(['worker', 'manager', 'supply']),
  provider: z.enum(['claude', 'chatgpt']), projectPath: z.string().min(1), cwd: z.string().min(1),
  agentSessionId: z.string().optional(),
  transcript: z.array(publicLine), pendingInputs: z.array(pendingInput),
  repository: z.object({ head: z.string(), branch: z.string(), status: z.string() }).strict(),
  retired: z.boolean().optional(),
  settledAt: z.number().finite().optional(),
  launch: z.object({ operationId: z.string().uuid(), phase: z.enum(['planned', 'starting', 'started', 'activating', 'restored', 'finished']), handleId: z.string().optional(), pausedStart: z.boolean().optional(),
    profile: z.object({ provider: z.enum(['claude', 'chatgpt']), model: z.string().optional(), effort: z.string().optional() }).strict().optional(),
    reviewed: z.object({ operationId: z.string().uuid(), note: z.string().trim().min(1).max(4000) }).strict().optional() }).strict().optional(),
}).strict()
export type SwarmTransitionActor = z.infer<typeof actorSchema>
export interface SwarmRuntimeCheckpoint {
  version: 1
  revision: number
  ownerKey?: string
  capturedAt: string
  actors: SwarmTransitionActor[]
  engines: SwarmTransitionEngine[]
}

export interface SwarmTransitionDeps {
  engines(): Promise<SwarmTransitionEngine[]>
  actors(engines: SwarmTransitionEngine[]): Promise<SwarmTransitionActor[]>
  drain(actor: SwarmTransitionActor, signal?: AbortSignal): Promise<Pick<SwarmTransitionActor, 'transcript' | 'pendingInputs' | 'settledAt'>>
  inspect(cwd: string): Promise<SwarmTransitionActor['repository']>
  retire(actor: SwarmTransitionActor): Promise<void>
  start(actor: SwarmTransitionActor, handoff: SwarmRuntimeHandoff, worker?: SwarmTransitionEngine['workers'][number]): Promise<string | null>
  send(id: string, text: string): boolean
  persist?(checkpoint: SwarmRuntimeCheckpoint, actor: SwarmTransitionActor): Promise<void>
  find?(actor: SwarmTransitionActor, profile: RuntimeProfile): Promise<string | null>
  enqueue?(actor: SwarmTransitionActor, id: string, text: string, index: number, profile: RuntimeProfile, sourceOperationId?: string, ownerKey?: string): Promise<void>
  ready?(actor: SwarmTransitionActor, id: string): Promise<void>
  finalize?(actors: SwarmTransitionActor[]): Promise<void>
  supportsPausedStart?(actor: SwarmTransitionActor, profile: RuntimeProfile): boolean
  safeBeforeInput?(actor: SwarmTransitionActor, profile: RuntimeProfile, ownerKey?: string): Promise<boolean>
  workStillNeeded?(actor: SwarmTransitionActor, worker?: SwarmTransitionEngine['workers'][number]): Promise<boolean>
  reviewContext?(actor: SwarmTransitionActor, ownerKey?: string): Promise<{ confirmedReceipts: unknown[]; pendingInputs: SwarmTransitionActor['pendingInputs'] }>
  recoverIntent?(actor: SwarmTransitionActor, ownerKey?: string): Promise<Pick<SwarmTransitionActor, 'transcript' | 'pendingInputs'>>
}

export interface SwarmLaunchRecoveryIssue { id: string; revision: number; actorOperationId: string; role: string }

const engineWorkerOf = (checkpoint: SwarmRuntimeCheckpoint, actor: SwarmTransitionActor) => checkpoint.engines
  .find((engine) => engine.path === actor.projectPath)?.workers.find(({ worker }) => worker.worktree === actor.cwd)

const missingLaunchIssues = async (deps: SwarmTransitionDeps, profile: RuntimeProfile, value: unknown): Promise<SwarmLaunchRecoveryIssue[]> => {
  const checkpoint = checkpointOf(value), issues: SwarmLaunchRecoveryIssue[] = []
  for (const actor of checkpoint.actors) {
    if (!actor.launch || ['planned', 'finished'].includes(actor.launch.phase)) continue
    const target = actor.launch.profile ?? profile
    if (await deps.find?.(actor, target)) continue
    if (deps.workStillNeeded && !await deps.workStillNeeded(actor, engineWorkerOf(checkpoint, actor))) continue
    // A paused SDK with proof of zero admitted inputs has a safe retry path.
    if (actor.launch.pausedStart && ['starting', 'started'].includes(actor.launch.phase)
      && await deps.safeBeforeInput?.(actor, target, checkpoint.ownerKey)) continue
    issues.push({ id: actor.launch.operationId, revision: checkpoint.revision, actorOperationId: actor.launch.operationId, role: actor.role })
  }
  return issues
}

const checkpointOf = (value: unknown): SwarmRuntimeCheckpoint => {
  if (!value || typeof value !== 'object') throw new Error('Missing agent runtime checkpoint.')
  const checkpoint = value as SwarmRuntimeCheckpoint
  if (checkpoint.version !== 1 || !Number.isInteger(checkpoint.revision) || checkpoint.revision < 0 || !Array.isArray(checkpoint.engines) || typeof checkpoint.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(checkpoint.capturedAt))) throw new Error('Invalid agent runtime checkpoint.')
  const actors = z.array(actorSchema).max(128).parse(checkpoint.actors)
  if (new Set(actors.map((actor) => `${actor.runtime}:${actor.id}`)).size !== actors.length) throw new Error('Duplicate checkpoint actor.')
  if (Buffer.byteLength(JSON.stringify(checkpoint)) > 3 * 1024 * 1024) throw new Error('Agent runtime checkpoint exceeds its bounded size.')
  return { ...checkpoint, actors }
}

/** Factory is a full offline seam: tests never need a real model or actor. */
export const createSwarmRuntimeTransition = (deps: SwarmTransitionDeps) => ({
  issues: (profile: RuntimeProfile, value: unknown) => missingLaunchIssues(deps, profile, value),
  review: async (profile: RuntimeProfile, value: unknown, id: string, note: string): Promise<void> => {
    const checkpoint = checkpointOf(value)
    const validated = z.string().trim().min(1).max(4000).parse(note)
    const previous = checkpoint.actors.find((actor) => actor.launch?.reviewed?.operationId === id)
    if (previous) {
      if (previous.launch!.reviewed!.note !== validated) throw new Error('This launch was already reviewed with a different note.')
      return
    }
    if (!(await missingLaunchIssues(deps, profile, checkpoint)).some((issue) => issue.id === id)) throw new Error('This launch no longer needs the requested recovery review.')
    const actor = checkpoint.actors.find((actor) => actor.launch?.operationId === id)!
    actor.launch!.reviewed = { operationId: id, note: validated }
    await deps.persist?.(checkpoint, actor)
  },
  drain: async (signal?: AbortSignal, seed?: unknown): Promise<SwarmRuntimeCheckpoint> => {
    const current = () => { if (signal?.aborted) throw new Error('The runtime drain was cancelled.') }
    current()
    await awaitSwarmRuntimeLaunches()
    const startedAt = Date.now()
    const initialEngines = await deps.engines()
    const actors = await deps.actors(initialEngines)
    for (const actor of actors) {
      current()
      Object.assign(actor, await deps.drain(actor, signal))
      current()
      actor.launch = { operationId: randomUUID(), phase: 'planned' }
    }
    await deps.finalize?.(actors)
    current()
    const previous = seed === undefined ? undefined : checkpointOf(seed)
    if (previous) for (const intent of previous.actors) {
      current()
      if (actors.some((actor) => actor.role === intent.role && actor.cwd === intent.cwd && actor.projectPath === intent.projectPath)) continue
      if (deps.workStillNeeded && !await deps.workStillNeeded(intent, engineWorkerOf(previous, intent))) continue
      if (!deps.recoverIntent) throw new Error('A missing actor intent needs its confirmed state recovered before reversing this switch.')
      const recovered = await deps.recoverIntent(intent, previous.ownerKey)
      actors.push({ ...structuredClone(intent), ...recovered, retired: true,
        launch: { operationId: randomUUID(), phase: 'planned', ...(intent.launch?.reviewed ? { reviewed: intent.launch.reviewed } : {}) } })
    }
    for (const actor of actors) { current(); actor.repository = await deps.inspect(actor.cwd) }
    const engines = await deps.engines()
    if (previous) for (const engine of previous.engines) for (const worker of engine.workers) {
      if (!actors.some((actor) => actor.role === 'worker' && actor.projectPath === engine.path && actor.cwd === worker.worker.worktree)) continue
      let target = engines.find((item) => item.path === engine.path)
      if (!target) { target = { path: engine.path, workers: [] }; engines.push(target) }
      if (!target.workers.some((item) => item.worker.worktree === worker.worker.worktree)) target.workers.push(structuredClone(worker))
    }
    for (const engine of engines) for (const worker of engine.workers) {
      const initialEngine = initialEngines.find((item) => item.path === engine.path)
      const initial = initialEngine?.workers.find((item) => item.worker.worktree === worker.worker.worktree)
      const actor = actors.find((item) => item.role === 'worker' && item.cwd === worker.worker.worktree)
      if (initial && actor?.settledAt) worker.budget.workedMs = initial.budget.workedMs + Math.max(0, actor.settledAt - (initialEngine?.capturedAt ?? startedAt))
    }
    return checkpointOf({ version: 1, revision: getRuntimeTransition('swarm')?.revision ?? 0,
      ownerKey: getRuntimeJournal()?.pending?.ownerKey, capturedAt: new Date().toISOString(), actors, engines })
  },
  retire: async (value: unknown): Promise<void> => {
    const checkpoint = checkpointOf(value)
    for (const actor of checkpoint.actors) {
      if (actor.retired) continue
      if (checkpoint.ownerKey) await runtimeOwnerKey(checkpoint.ownerKey)
      await deps.retire(actor)
      actor.retired = true
      await deps.persist?.(checkpoint, actor)
    }
  },
  resume: async (profile: RuntimeProfile, value: unknown): Promise<void> => {
    const checkpoint = checkpointOf(value)
    for (const actor of checkpoint.actors) {
      if (checkpoint.ownerKey) await runtimeOwnerKey(checkpoint.ownerKey)
      if (!actor.launch) throw new Error('The actor has no durable launch identity.')
      if (actor.launch.phase === 'finished') continue
      if (!actor.retired) throw new Error('The previous actor has not been durably retired.')
      const engineWorker = engineWorkerOf(checkpoint, actor)
      if (actor.role === 'worker' && !engineWorker) throw new Error('A worker has no confirmed Board assignment; inspect recovery before restarting it.')
      let found: string | null | undefined
      if (actor.launch.phase !== 'planned') {
        found = await deps.find?.(actor, profile)
        if (actor.launch.phase === 'restored' && found) continue
        if (!found && deps.workStillNeeded && !await deps.workStillNeeded(actor, engineWorker)) {
          if (actor.pendingInputs.some((input) => !input.operationId)) throw new Error('A finished worker has preserved instructions that require inspection; it will not be restarted.')
          actor.launch.phase = 'finished'
          await deps.persist?.(checkpoint, actor)
          continue
        }
      }
      let reviewedContext: { confirmedReceipts: unknown[]; pendingInputs: SwarmTransitionActor['pendingInputs'] } | undefined
      const review = actor.launch.reviewed
      if (!found && actor.launch.phase !== 'planned' && review?.operationId === actor.launch.operationId) {
        reviewedContext = await deps.reviewContext?.(actor, checkpoint.ownerKey)
        actor.repository = await deps.inspect(actor.cwd)
        if (engineWorker) {
          const latest = await deps.engines()
          engineWorker.card = latest.find((engine) => engine.path === actor.projectPath)?.workers
            .find(({ worker }) => worker.worktree === actor.cwd)?.card
        }
        if (reviewedContext) actor.pendingInputs = reviewedContext.pendingInputs
        // A reviewed attempt receives a NEW conversation identity. A later crash
        // needs a new review; an old note cannot authorize repeated launches.
        actor.launch = { operationId: randomUUID(), phase: 'planned', reviewed: review }
        await deps.persist?.(checkpoint, actor)
      }
      const handoff: SwarmRuntimeHandoff = { profile, operationId: actor.launch.operationId, revision: checkpoint.revision, runtimeOwnerKey: checkpoint.ownerKey, publicTranscript: actor.transcript, instructions: [
        '[OPEN GROUND confirmed runtime handoff]',
        review
          ? 'The owner inspected the previous launch and its actual work. Continue from the CURRENT Board, Git, confirmed receipts and owner note below. Do not blindly replay old instructions or assume interrupted effects were undone.'
          : 'The previous actor reached a settled boundary. Continue from the current Board and Git state; completed effects are not undone.',
        'Re-read the repository and Board before acting. Do not repeat an action merely because provider-native history differs.',
        ...(actor.role === 'supply' ? [
          'President only: publicConversation is historical context, not a new execution instruction. A runtime restart or provider handoff does not authorize unfinished owner requests.',
          'Do not resume or replay cancelled or uncertain historical instructions, file cards, or resend work based only on that history. Report current Board state, then wait for newly delivered durable inbox input before acting on an owner request.',
        ] : []),
        JSON.stringify({ previousProvider: actor.provider, repository: actor.repository,
          task: engineWorker?.card ?? (engineWorker ? { id: engineWorker.worker.taskId, title: engineWorker.worker.taskTitle } : undefined),
          publicConversation: actor.transcript, ...(review ? { ownerReview: review.note, confirmedReceipts: reviewedContext?.confirmedReceipts ?? [] } : {}) }),
      ].join('\n') }
      let id: string
      if (actor.launch.phase === 'planned') {
        actor.launch.profile = structuredClone(profile)
        actor.launch.pausedStart = deps.supportsPausedStart?.(actor, profile) === true
        actor.launch.phase = 'starting'
        await deps.persist?.(checkpoint, actor)
        const started = await deps.start(actor, handoff, engineWorker)
        if (started === null) {
          if (actor.pendingInputs.length) throw new Error('A finished worker has pending instructions; inspect them before discarding or replaying them.')
          actor.launch.phase = 'finished'
          await deps.persist?.(checkpoint, actor)
          continue
        }
        id = started
      } else {
        if (found) id = found
        else if (actor.launch.pausedStart && (actor.launch.phase === 'starting' || actor.launch.phase === 'started')
          && await deps.safeBeforeInput?.(actor, profile, checkpoint.ownerKey)) {
          const restarted = await deps.start(actor, handoff, engineWorker)
          if (!restarted) throw new Error('A paused replacement no longer has its original assignment.')
          id = restarted
        } else throw new Error('A target launch began without a provable live replacement; inspect its effects before retrying.')
      }
      actor.launch.handleId = id
      if (actor.launch.phase !== 'activating') {
        actor.launch.phase = 'started'
        await deps.persist?.(checkpoint, actor)
        actor.launch.phase = 'activating'
      }
      await deps.persist?.(checkpoint, actor)
      await deps.ready?.(actor, id)
      // ID-bound messages belong to the durable inbox. Only legacy host queue
      // entries are carried here, never replaying a consumed durable operation.
      for (let index = 0; index < actor.pendingInputs.length; index++) {
        const input = actor.pendingInputs[index]
        if (input.operationId && (actor.role === 'supply' || !input.operationId.startsWith('handoff-'))) continue
        if (deps.enqueue) await deps.enqueue(actor, id, input.text, index, profile, input.operationId, checkpoint.ownerKey)
        else if (!deps.send(id, input.text)) throw new Error('The replacement actor refused a preserved queued input.')
      }
      actor.launch.phase = 'restored'
      await deps.persist?.(checkpoint, actor)
    }
  },
})

const nativeTranscript = async (actor: SwarmTransitionActor): Promise<SwarmTransitionActor['transcript']> => {
  if (!actor.agentSessionId) throw new Error('The legacy actor has no verifiable conversation identity.')
  return readSwarmNativePublicConversation(actor.cwd, actor.agentSessionId)
}

const inspectRepository = async (cwd: string): Promise<SwarmTransitionActor['repository']> => {
  const git = async (...args: string[]): Promise<string> => (await execFile('git', ['-c', 'core.fsmonitor=false', '--no-pager', ...args],
    { cwd, timeout: 10_000, maxBuffer: 256 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) {
    const path = resolve(cwd, await git('rev-parse', '--git-path', marker))
    try { await stat(path); throw new Error('A Git operation is still in progress; inspect it before handing off integration.') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return { head: await git('rev-parse', 'HEAD'), branch: await git('branch', '--show-current'),
    status: await git('status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all') }
}

const sameActor = (actor: SwarmTransitionActor): boolean => {
  if (actor.runtime === 'sdk') {
    const current = getSdkSession(actor.id)
    return !!current && current.cwd === actor.cwd && current.role === actor.role && current.agentSessionId === actor.agentSessionId
  }
  const current = getTerminal(actor.id)
  return !!current && current.cwd === actor.cwd && current.agentSessionId === actor.agentSessionId
}
const retireActor = async (actor: SwarmTransitionActor): Promise<void> => {
  const current = actor.runtime === 'sdk' ? getSdkSession(actor.id) : getTerminal(actor.id)
  if (!current) {
    if (actor.agentSessionId && await isSessionHeldByProcess(actor.agentSessionId) === false) return
    throw new Error('The previous actor has no confirmed process release. Inspect it before continuing.')
  }
  if (!sameActor(actor)) throw new Error('The recorded actor changed; refusing to retire a different session.')
  if (actor.runtime === 'sdk') {
    terminateSdkSession(actor.id)
    const deadline = Date.now() + 30_000
    while (!getSdkSession(actor.id)?.reaped) {
      if (Date.now() >= deadline) throw new Error('The old actor has not released its worktree yet.')
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
  } else {
    // Native terminal input can still arrive outside the app's owner queue.
    // A checkpoint never licenses killing a newly started turn or typed draft.
    await nativeTranscript(actor)
    if (!nativePresidentDrainable(getTerminalScreen(actor.id))) throw new Error('New native input arrived after the checkpoint; wait for its confirmed boundary before retiring it.')
    killTerminal(actor.id)
    if (!(await waitForTerminalGone(actor.id))) throw new Error('The old native actor is still alive.')
  }
}

const pausedForTransition = new Set<string>()
let activeDrain: AbortController | undefined
const defaults: SwarmTransitionDeps = {
  engines: drainSwarmEngines,
  actors: async (engines) => {
    const projects = (await getSettings()).projects ?? []
    const actors: SwarmTransitionActor[] = []
    const add = (id: string, runtime: 'sdk' | 'pty', role: SwarmTransitionActor['role'], cwd: string, projectPath: string, agentSessionId?: string) => {
      if (actors.some((actor) => actor.runtime === runtime && actor.id === id)) return
      actors.push({ id, runtime, role, cwd, projectPath, ...(agentSessionId ? { agentSessionId } : {}),
        provider: agentSessionId?.startsWith('chatgpt-') ? 'chatgpt' : 'claude', transcript: [], pendingInputs: [], repository: { head: '', branch: '', status: '' } })
    }
    for (const engine of engines) for (const { worker } of engine.workers) {
      const id = worker.runtime === 'sdk' ? worker.sdkSessionId : worker.terminalId
      if (id && (worker.runtime === 'sdk' ? !!getSdkSession(id) && !getSdkSession(id)?.reaped : isTerminalProcessAlive(id)))
        add(id, worker.runtime ?? 'pty', 'worker', worker.worktree, engine.path, worker.sessionId)
    }
    for (const session of listSdkSessions().filter((session) => session.role && !session.reaped && !session.closed)) {
      if (actors.some((actor) => actor.runtime === 'sdk' && actor.id === session.id)) continue
      const project = projects.find((project) => resolve(project.path) === resolve(session.cwd))
      if (!project || session.role === 'worker') throw new Error('An untracked worker needs its Board assignment recovered before switching.')
      add(session.id, 'sdk', session.role!, session.cwd, project.path, session.agentSessionId)
    }
    for (const terminal of listOwnerDeskTerminals().filter((terminal) => isTerminalProcessAlive(terminal.id))) {
      const role = terminal.deskLabel === SUPPLY_DESK_LABEL ? 'supply' : terminal.deskLabel === MANAGER_DESK_LABEL ? 'manager' : null
      const project = projects.find((project) => resolve(project.path) === resolve(terminal.cwd))
      if (role && project) add(terminal.id, 'pty', role, terminal.cwd, project.path, terminal.agentSessionId)
    }
    return actors
  },
  drain: async (actor, signal) => {
    if (signal?.aborted) throw new Error('The runtime drain was cancelled.')
    if (actor.runtime === 'sdk') {
      if (signal && !sdkInputAdmissionPaused(actor.id)) pausedForTransition.add(actor.id)
      const checkpoint = await drainSdkSession(actor.id, 120_000, signal)
      if (actor.provider === 'claude' && actor.agentSessionId) checkpoint.transcript = await nativeTranscript(actor)
      if (actor.provider === 'chatgpt' && actor.agentSessionId) checkpoint.transcript = await chatGptPublicConversation(actor.agentSessionId)
      return { transcript: checkpoint.transcript, pendingInputs: checkpoint.pendingInputs, settledAt: checkpoint.settledAt }
    }
    const deadline = Date.now() + 120_000
    while (!nativePresidentDrainable(getTerminalScreen(actor.id))) {
      if (signal?.aborted) throw new Error('The runtime drain was cancelled.')
      if (!isTerminalProcessAlive(actor.id) || Date.now() >= deadline) throw new Error('The native president has not reached an empty settled prompt.')
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    const size = (await stat(sessionJsonlPath(actor.cwd, actor.agentSessionId!))).size
    const transcript = await nativeTranscript(actor)
    const handle = await open(sessionJsonlPath(actor.cwd, actor.agentSessionId!), 'r+')
    try {
      await handle.sync()
      if ((await handle.stat()).size !== size) throw new Error('The native transcript changed before its boundary became durable.')
    } finally { await handle.close() }
    if (!sameActor(actor) || !nativePresidentDrainable(getTerminalScreen(actor.id))) throw new Error('The native president changed before its boundary became durable.')
    return { transcript, pendingInputs: [], settledAt: Date.now() }
  },
  finalize: async (actors) => {
    await awaitPresidentInputSettlement()
    for (const actor of actors) if (actor.runtime === 'pty') actor.transcript = await nativeTranscript(actor)
  },
  inspect: inspectRepository,
  retire: retireActor,
  start: async (actor, handoff, worker) => {
    if (actor.role === 'worker') {
      if (!worker) throw new Error('Missing worker assignment.')
      const card = await swarmTransitionCurrentAssignment(actor.projectPath, worker.worker)
      if (!card) return null
      const spawn: SpawnSwarmWorkerResponse = await spawnSwarmWorker({ projectPath: actor.projectPath,
        title: card.title, hint: worker.worker.taskTitle, notes: card.notes,
        tier: card.tier, worktree: actor.cwd, runtimeHandoff: handoff })
      await replaceSwarmTransitionWorker(actor.projectPath, worker, spawn)
      return spawn.sdkSessionId!
    }
    const spawn = actor.role === 'manager'
      ? await spawnSwarmManager({ projectPath: actor.projectPath, fresh: true, runtimeHandoff: handoff })
      : await spawnSwarmSupply({ projectPath: actor.projectPath, fresh: true, runtimeHandoff: handoff })
    return spawn.sdkSessionId ?? spawn.terminalId
  },
  send: pushSdkInput,
  ready: async (actor, id) => {
    if (getSdkSession(id)) resumeSdkInputAdmission(id)
    const deadline = Date.now() + 120_000
    for (;;) {
      const session = getSdkSession(id)
      if (session) {
        if (session.closed || session.reaped || session.status === 'failed' || session.status === 'quota-parked') throw new Error('The target AI could not begin its handoff. Its recorded state was retained.')
        if (session.status === 'working' || session.status === 'waiting') return
      } else {
        if (!isTerminalProcessAlive(id)) throw new Error('The target native president exited before accepting the handoff.')
        const current = getTerminal(id)
        if (current && noticeHoldReason(getTerminalScreen(id)) === null) {
          const transcript = await nativeTranscript({ ...actor, id, runtime: 'pty', agentSessionId: current.agentSessionId })
          if (transcript.some((line) => line.kind === 'text')) return
        }
      }
      if (Date.now() >= deadline) throw new Error('The target AI has not confirmed startup yet; retry recovery without launching a duplicate.')
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
  },
  supportsPausedStart: (actor, profile) => profile.provider === 'chatgpt' || actor.role !== 'supply',
  recoverIntent: async (actor, ownerKey) => {
    if (!ownerKey || !actor.agentSessionId) throw new Error('The saved actor intent has no confirmed owner or conversation identity.')
    await runtimeOwnerKey(ownerKey)
    const sdk = getSdkSession(actor.id)
    if (sdk && !sdk.reaped || actor.runtime === 'pty' && isTerminalProcessAlive(actor.id)
      || await isSessionHeldByProcess(actor.agentSessionId) !== false) throw new Error('The saved actor has not released its original conversation.')
    const launch = actor.launch
    if (launch && !['planned', 'finished'].includes(launch.phase)) {
      const safe = launch.profile && launch.pausedStart && ['starting', 'started'].includes(launch.phase)
        && await defaults.safeBeforeInput!(actor, launch.profile, ownerKey)
      if (!safe && launch.reviewed?.operationId !== launch.operationId) throw new Error('The previous target launch needs an owner work review before reversing it.')
    }
    const context = await defaults.reviewContext!(actor, ownerKey)
    return { transcript: actor.transcript, pendingInputs: context.pendingInputs }
  },
  workStillNeeded: async (actor, worker) => actor.role !== 'worker' || !!worker && await swarmTransitionWorkStillNeeded(actor.projectPath, worker.worker),
  reviewContext: async (actor, ownerKey) => {
    if (!ownerKey || !actor.launch) throw new Error('The launch review has no admitted owner identity.')
    await runtimeOwnerKey(ownerKey)
    const { projectUUIDFromPath } = await import('./projectDataPath')
    const scope = actor.role === 'supply' ? await projectUUIDFromPath(actor.projectPath) : 'swarm-handoff'
    const receipts = await listConversationReceipts(ownerKey)
    const pendingInputs: SwarmTransitionActor['pendingInputs'] = []
    for (let index = 0; index < actor.pendingInputs.length; index++) {
      const input = actor.pendingInputs[index]
      if (input.operationId && !input.operationId.startsWith('handoff-')) { pendingInputs.push(input); continue }
      const previousId = `handoff-${actor.launch.operationId}-${index}`
      const previous = receipts.find((receipt) => receipt.scope === scope && receipt.id === previousId)
      if (!previous) { pendingInputs.push(input); continue }
      if (previous.state === 'executing' || previous.state === 'uncertain') throw new Error('A previous instruction still has an unconfirmed result; review that receipt before relaunching.')
      if (previous.state === 'queued') pendingInputs.push({ ...input, operationId: previousId })
      // Delivered or explicitly cancelled/rejected input must not run again.
    }
    return { pendingInputs, confirmedReceipts: receipts.filter((receipt) => ['delivered', 'rejected', 'cancelled'].includes(receipt.state)
      && ((receipt.body as { cwd?: string } | null)?.cwd === actor.cwd || receipt.scope === scope && actor.role === 'supply'))
      .map(({ id, state, updatedAt, hash }) => ({ id, state, updatedAt, hash })) }
  },
  safeBeforeInput: async (actor, profile, ownerKey) => {
    if (!ownerKey || !actor.launch?.pausedStart) return false
    await runtimeOwnerKey(ownerKey)
    const sessionId = profile.provider === 'chatgpt' ? `chatgpt-${actor.launch.operationId}` : actor.launch.operationId
    if (listSdkSessions().some((session) => !session.reaped && session.agentSessionId === sessionId)) return false
    if (await isSessionHeldByProcess(sessionId) !== false) return false
    if ((await listConversationReceipts(ownerKey)).some((receipt) => (receipt.body as { sessionId?: string } | null)?.sessionId === sessionId)) return false
    const path = profile.provider === 'chatgpt' ? chatGptConversationFile(sessionId) : sessionJsonlPath(actor.cwd, sessionId)
    try {
      const metadata = await stat(path)
      if (profile.provider === 'chatgpt' || metadata.size > 2 * 1024 * 1024) return false
      for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) {
        const item = JSON.parse(line) as { type?: string }
        if (item.type === 'user' || item.type === 'assistant') return false
      }
      return true // native init only, never a model input
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
  },
  persist: async (checkpoint, actor) => {
    await updateRuntimeCheckpoint('swarm', checkpoint.revision, (stored) => {
      const current = checkpointOf(stored)
      const index = current.actors.findIndex((item) => item.id === actor.id && item.runtime === actor.runtime)
      if (index < 0) throw new Error('The checkpoint no longer owns this actor.')
      current.actors[index] = structuredClone(actor)
      return current
    })
  },
  find: async (actor, profile) => {
    const agentId = profile.provider === 'chatgpt' ? `chatgpt-${actor.launch!.operationId}` : actor.launch!.operationId
    const sdk = listSdkSessions().filter((session) => !session.reaped && !session.closed && session.agentSessionId === agentId)
    const pty = listOwnerDeskTerminals().filter((session) => isTerminalProcessAlive(session.id) && session.agentSessionId === agentId)
    if (sdk.length + pty.length > 1) throw new Error('More than one replacement owns the launch identity.')
    const session = sdk[0] ?? pty[0]
    if (sdk[0] && sdk[0].role !== actor.role) throw new Error('The replacement identity belongs to a different role.')
    if (pty[0] && pty[0].deskLabel !== (actor.role === 'supply' ? SUPPLY_DESK_LABEL : MANAGER_DESK_LABEL)) throw new Error('The replacement identity belongs to a different native role.')
    if (session && resolve(session.cwd) !== resolve(actor.cwd)) throw new Error('The replacement identity belongs to a different worktree.')
    return session?.id ?? null
  },
  enqueue: async (actor, _id, text, index, profile, sourceOperationId, ownerKey) => {
    if (!ownerKey) throw new Error('The handoff has no admitted owner identity.')
    await runtimeOwnerKey(ownerKey)
    const id = `handoff-${actor.launch!.operationId}-${index}`
    if (actor.role === 'supply') { await acceptPresidentInput(actor.projectPath, text, { id, expectedOwnerKey: ownerKey }); return }
    if (sourceOperationId) {
      const previous = await readConversationReceipt('swarm-handoff', sourceOperationId, ownerKey)
      if (!previous) throw new Error('A queued handoff message has no durable receipt.')
      if (previous.state === 'delivered') return
      if (previous.state === 'queued') await finishConversationReceipt('swarm-handoff', sourceOperationId, 'cancelled', { forwardedTo: id }, ownerKey)
      else if (previous.state !== 'cancelled' || (previous.result as { forwardedTo?: string } | undefined)?.forwardedTo !== id)
        throw new Error('A previous input may already have executed; inspect its receipt before forwarding it.')
    }
    await acceptConversationReceipt('swarm-handoff', id, { kind: 'swarm-handoff-input', text, cwd: actor.cwd,
      projectPath: actor.projectPath, role: actor.role,
      agentSessionId: profile.provider === 'chatgpt' ? `chatgpt-${actor.launch!.operationId}` : actor.launch!.operationId }, undefined, ownerKey)
  },
}
const participant = createSwarmRuntimeTransition(defaults)
export const drainSwarmRuntime = async (seed?: unknown): Promise<SwarmRuntimeCheckpoint> => {
  const { assertNoUncertainRuntimeActions } = await import('./runtimeActionReceipts')
  activeDrain?.abort()
  const controller = new AbortController()
  activeDrain = controller
  await assertNoUncertainRuntimeActions(undefined, false)
  await drainSupplyNoticeDeliveries(controller.signal)
  if (seed !== undefined && checkpointOf(seed).ownerKey !== getRuntimeJournal()?.pending?.ownerKey) throw new Error('The reverse transition belongs to a different owner.')
  const checkpoint = await participant.drain(controller.signal, seed)
  await assertNoUncertainRuntimeActions()
  return checkpoint
}
export const cancelSwarmRuntimeDrain = async (): Promise<void> => {
  activeDrain?.abort()
  activeDrain = undefined
  for (const id of Array.from(pausedForTransition)) resumeSdkInputAdmission(id)
  pausedForTransition.clear()
}
export const retireSwarmRuntime = participant.retire
export const resumeSwarmRuntime = async (profile: RuntimeProfile, checkpoint: unknown): Promise<void> => {
  await participant.resume(profile, checkpoint)
  pausedForTransition.clear()
}

const launchRecoveryState = async (expectedOwnerKey?: string) => {
  const journal = getRuntimeJournal(), state = journal?.scopes.swarm
  if (!journal?.pending || state?.phase !== 'attention' || !journal.pending.scopes.includes('swarm')) return undefined
  await runtimeOwnerKey(expectedOwnerKey ?? journal.pending.ownerKey)
  if (expectedOwnerKey && journal.pending.ownerKey !== expectedOwnerKey) throw new Error('This recovery belongs to a different owner.')
  const source = journal.pending.checkpoints.swarm === undefined ? 'seeds' : 'checkpoints'
  const value = journal.pending[source]?.swarm
  if (value === undefined) return undefined
  const checkpoint = checkpointOf(value)
  if (source === 'checkpoints' && checkpoint.revision !== state.revision || checkpoint.ownerKey !== journal.pending.ownerKey) throw new Error('The launch recovery checkpoint changed.')
  return { checkpoint, state, ownerKey: journal.pending.ownerKey, source: source as 'checkpoints' | 'seeds' }
}
export const listSwarmLaunchRecoveryIssues = async (): Promise<SwarmLaunchRecoveryIssue[]> => {
  const recovery = await launchRecoveryState()
  return recovery ? (await participant.issues(recovery.state.desired, recovery.checkpoint)).map((issue) => ({ ...issue, revision: recovery.state.revision })) : []
}
export const reviewSwarmLaunchRecovery = async (options: { id: string; note: string; expectedOwnerKey: string }): Promise<void> => {
  const recovery = await launchRecoveryState(options.expectedOwnerKey)
  if (!recovery) throw new Error('There is no pending team launch recovery.')
  const reviewer = createSwarmRuntimeTransition({ ...defaults, persist: async (_checkpoint, actor) => {
    await runtimeOwnerKey(options.expectedOwnerKey)
    await updateRuntimeJournal((journal) => {
      if (journal.scopes.swarm.phase !== 'attention' || journal.scopes.swarm.revision !== recovery.state.revision || journal.pending?.ownerKey !== options.expectedOwnerKey) throw new Error('The recovery review changed.')
      const current = checkpointOf(journal.pending[recovery.source]?.swarm)
      const target = current.actors.find((item) => item.id === actor.id && item.runtime === actor.runtime)
      if (!target?.launch || target.launch.operationId !== options.id || target.launch.phase !== actor.launch?.phase) throw new Error('The reviewed launch changed.')
      if (target.launch.reviewed && target.launch.reviewed.note !== actor.launch!.reviewed!.note) throw new Error('This launch was already reviewed with a different note.')
      target.launch.reviewed = actor.launch!.reviewed
      journal.pending[recovery.source]!.swarm = current
    })
  } })
  await reviewer.review(recovery.state.desired, recovery.checkpoint, options.id, options.note)
}

/** Run before ordinary boot resume. An existing unconfirmed history is not a
 * missing session and must never silently become a fresh task execution. */
export const assertSavedSwarmRuntimeSafe = async (): Promise<void> => {
  const { assertNoUncertainRuntimeActions } = await import('./runtimeActionReceipts')
  await assertNoUncertainRuntimeActions()
  const settings = await getSettings()
  const provider = settings.swarmProvider ?? 'claude'
  for (const project of settings.projects ?? []) {
    const intent = await readEngineIntent(project.path)
    if (!intent.desiredRunning && !intent.managerDesired && !intent.supplyDesired) continue
    const workers = intent.desiredRunning && !await isSwarmManualStopPersisted(project.path) ? await readRoster(project.path) : []
    const sessions = await readSwarmSessions(project.path)
    const ids = new Map(workers.filter((worker) => worker.sessionId.startsWith('chatgpt-') === (provider === 'chatgpt')).map((worker) => [worker.sessionId, worker.worktree]))
    for (const role of ['supply', 'manager'] as const) {
      if (!(role === 'supply' ? intent.supplyDesired : intent.managerDesired)) continue
      const record = provider === 'chatgpt' ? sessions.chatgpt?.[role] : sessions[role]
      if (record) ids.set(record.sessionId, record.cwd)
    }
    for (const [id, cwd] of Array.from(ids)) {
      if (id.startsWith('chatgpt-')) {
        const recovery = await chatGptConversationRecovery(id)
        if (recovery === 'uncertain' || recovery === 'invalid') throw new Error('Saved agent work has unconfirmed actions or invalid history. Inspect it before automatic restart.')
      } else {
        try { await assertSwarmNativeConversationSettled(cwd, id) }
        catch (error) {
          if (error instanceof NativeUnfinishedToolsError && await nativeConversationRecoveryReviewed(project.id, cwd, id)) continue
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }
}

const handoffInput = z.object({ kind: z.literal('swarm-handoff-input'), text: z.string(), cwd: z.string(),
  projectPath: z.string(), role: z.enum(['worker', 'manager']), agentSessionId: z.string() }).strict()
const scheduledHandoffInputs = new Set<string>()
/** Root calls after stable and at boot. Queued is safe; executing-after-crash is
 * uncertain in the shared ledger and is NEVER automatically replayed here. */
export const flushSwarmHandoffInputs = async (): Promise<void> => {
  if (runtimeAdmissionBlocked('swarm')) return
  const { projectUUIDFromPath } = await import('./projectDataPath')
  for (const receipt of await listConversationReceipts()) {
    if (runtimeAdmissionBlocked('swarm')) return
    const body = handoffInput.safeParse(receipt.body)
    if (receipt.scope !== 'swarm-handoff' || receipt.state !== 'queued' || !body.success || scheduledHandoffInputs.has(receipt.id)) continue
    await projectUUIDFromPath(body.data.projectPath)
    const session = listSdkSessions().find((session) => !session.closed && !session.reaped && session.role === body.data.role
      && session.cwd === body.data.cwd && session.agentSessionId === body.data.agentSessionId)
    if (!session) continue
    scheduledHandoffInputs.add(receipt.id)
    const queued = pushSdkInput(session.id, body.data.text, { operationId: receipt.id,
      onConsumed: () => claimConversationReceipt(receipt.scope, receipt.id, undefined, receipt.owner),
      onReleased: async () => { scheduledHandoffInputs.delete(receipt.id) },
      onSettled: async () => { await finishConversationReceipt(receipt.scope, receipt.id, 'delivered', undefined, receipt.owner); scheduledHandoffInputs.delete(receipt.id) },
      onInterrupted: async (safe) => { await finishConversationReceipt(receipt.scope, receipt.id, safe ? 'cancelled' : 'uncertain', undefined, receipt.owner); scheduledHandoffInputs.delete(receipt.id) },
      onRefused: async () => { await finishConversationReceipt(receipt.scope, receipt.id, 'rejected', { reason: 'usage-limit', fulfilled: false }, receipt.owner); scheduledHandoffInputs.delete(receipt.id) },
    })
    if (!queued) scheduledHandoffInputs.delete(receipt.id)
  }
}

/** SDK turns have an exact pool identity; native phone turns use the immutable
 * inbox receipt bound to the current handle, session, project and epoch. */
export const presidentActiveTurnId = async (projectPath: string, expectedOwnerKey?: string): Promise<string | null> => {
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const desk = listLiveSupplyDesks(projectPath).find(desk => !desk.stopping)
  if (!desk) return null
  if (desk.runtime === 'sdk') return currentSdkTurnId(desk.handleId)
  const { projectUUIDFromPath } = await import('./projectDataPath')
  const scope = await projectUUIDFromPath(projectPath), context = await readConversationContext(scope)
  const active = (await listConversationReceipts(owner)).filter(receipt => receipt.scope === scope && receipt.state === 'executing'
    && receipt.conversationId === context.conversationId && receipt.epoch === context.epoch
    && receipt.execution?.runtime === 'pty' && receipt.execution.handleId === desk.handleId && receipt.execution.sessionId === desk.agentSessionId
    && (receipt.body as { kind?: string } | null)?.kind === 'president-input')
  return active.length === 1 ? active[0].id : null
}

export const controlPresidentConversation = async (projectPath: string, operation: { action: 'stop-turn' | 'new-conversation'; turnId?: string; operationId?: string; conversationId?: string; epoch?: number; expectedOwnerKey?: string }): Promise<void> => {
  if (getRuntimeTransition('swarm')?.phase && getRuntimeTransition('swarm')?.phase !== 'stable') throw new Error('Finish runtime recovery before controlling this conversation.')
  const ownerKey = await runtimeOwnerKey(operation.expectedOwnerKey)
  const { projectUUIDFromPath } = await import('./projectDataPath')
  const scope = await projectUUIDFromPath(projectPath)
  let context = await readConversationContext(scope)
  if (operation.conversationId !== undefined || operation.epoch !== undefined) {
    if (operation.conversationId !== context.conversationId || operation.epoch !== context.epoch) throw new Error('This control request names a stale president conversation.')
  }
  const assertCurrent = async () => {
    await runtimeOwnerKey(ownerKey)
    const current = await readConversationContext(scope)
    if (current.conversationId !== context.conversationId || current.epoch !== context.epoch) throw new Error('The president conversation changed before this control could take effect.')
  }
  const desk = listLiveSupplyDesks(projectPath).find((desk) => !desk.stopping)
  if (!desk) {
    if (operation.action !== 'new-conversation') throw new Error('The president conversation is not running.')
    const unsettled = (await listConversationReceipts(ownerKey)).some(receipt => receipt.scope === scope && ['executing', 'uncertain'].includes(receipt.state)
      && (receipt.body as { kind?: string } | null)?.kind === 'president-input')
    if (unsettled) throw new Error('Review the previous president instruction’s result before starting a new conversation.')
    const admission = await nativePresidentRecoveryAdmission(projectPath, ownerKey)
    const selected = (await getSettings()).swarmProvider ?? 'claude'
    const previous = (await readSwarmSessions(projectPath)).chatgpt?.supply
    if (selected === 'chatgpt' && previous) {
      if (listSdkSessions().some(session => !session.reaped && session.agentSessionId === previous.sessionId)) throw new Error('The previous president has not released its conversation.')
      const state = await chatGptConversationRecovery(previous.sessionId)
      if (state === 'uncertain' || state === 'invalid') throw new Error('Review the saved ChatGPT conversation’s actual work before starting another conversation.')
    }
    const repository = admission ? await inspectRepository(projectPath) : undefined
    const recoveryInstructions = admission ? [
      '[OPEN GROUND owner-reviewed native recovery]',
      'This is a NEW conversation. The owner inspected the actual previous work. Do not resume or blindly replay the previous request. Re-read the CURRENT Board and Git before proposing any action.',
      JSON.stringify({ ownerReview: admission.note, repository: repository && { head: repository.head, branch: repository.branch,
        ...(repository.status.length <= 8000 ? { status: repository.status } : { statusNeedsReread: true }) } }),
    ].join('\n') : undefined
    await assertCurrent()
    if (admission) await validateNativePresidentRecoveryAdmission(projectPath, admission)
    context = await cancelQueuedPresidentInputs(projectPath)
    await assertCurrent()
    await spawnSwarmSupply({ projectPath, fresh: true, cause: 'owner', ...(admission ? { nativeRecovery: admission, recoveryInstructions } : {}),
      beforeLaunch: async () => { await assertCurrent(); if (admission) await validateNativePresidentRecoveryAdmission(projectPath, admission) } })
    return
  }
  if (operation.action === 'stop-turn') {
    if (desk.runtime === 'sdk') {
      await assertCurrent()
      if (!await interruptSdkSession(desk.handleId, operation.turnId)) throw new Error('This stop request names a stale president turn or the president could not be interrupted.')
      return
    }
    const candidates = (await listConversationReceipts()).filter((receipt) => receipt.scope === scope
      && ['queued', 'executing'].includes(receipt.state) && (!operation.turnId || receipt.id === operation.turnId)
      && receipt.execution?.runtime === 'pty' && receipt.execution.handleId === desk.handleId && receipt.execution.sessionId === desk.agentSessionId)
    if (candidates.length !== 1) throw new Error('This stop request has no uniquely confirmed current president turn.')
    const receipt = candidates[0]
    await assertCurrent()
    if (await cancelUnsubmittedPresidentInput(projectPath, receipt.id)) return
    const body = receipt.body as { text?: unknown }
    if (typeof body.text !== 'string' || receipt.execution?.nativeOffset === undefined) throw new Error('The native turn has no recorded submission boundary.')
    let requested = false
    try {
      const result = await interruptNativePresidentTurn({ desk, sentText: body.text, transcriptOffsetBeforeSend: receipt.execution.nativeOffset,
        beforeInterrupt: assertCurrent, onInterruptRequested: () => { requested = true } })
      await finishConversationReceipt(scope, receipt.id, result.completed ? 'delivered' : 'cancelled', { interrupted: !result.completed, effectsRolledBack: false }, receipt.owner)
    } catch (error) {
      if (requested) await finishConversationReceipt(scope, receipt.id, 'uncertain', { interrupted: true, effectsRolledBack: false }, receipt.owner)
      throw error
    }
    return
  }
  const actor: SwarmTransitionActor = { id: desk.handleId, runtime: desk.runtime, role: 'supply', cwd: desk.cwd,
    projectPath, provider: desk.agentSessionId?.startsWith('chatgpt-') ? 'chatgpt' : 'claude', agentSessionId: desk.agentSessionId ?? undefined,
    transcript: [], pendingInputs: [], repository: { head: '', branch: '', status: '' } }
  const paused = desk.runtime === 'sdk' && sdkInputAdmissionPaused(desk.handleId)
  let retired = false
  try {
    await defaults.drain(actor)
    await assertCurrent()
    await defaults.retire(actor)
    retired = true
    await assertCurrent()
    context = await cancelQueuedPresidentInputs(projectPath)
    await assertCurrent()
    await spawnSwarmSupply({ projectPath, fresh: true, cause: 'owner', beforeLaunch: assertCurrent })
  } finally {
    if (!retired && desk.runtime === 'sdk' && !paused) resumeSdkInputAdmission(desk.handleId)
  }
}

/** A known CLI quota refusal is a positive idle boundary too. A typed draft is
 * never retired merely because the conversation contains quota wording. */
export const nativePresidentDrainable = (screen: string | null): boolean => {
  const hold = noticeHoldReason(screen)
  return hold === null || hold !== 'typed' && classifyQuotaRefusal(screen) !== null
}

type NativePresidentDesk = Pick<SupplyDeskHandle, 'handleId' | 'cwd' | 'agentSessionId'>
export interface NativePresidentProofDeps {
  file(desk: NativePresidentDesk): string
  current(desk: NativePresidentDesk): boolean
  screen(desk: NativePresidentDesk): string | null
  interrupt?(desk: NativePresidentDesk): boolean
}
const nativeProofDeps: NativePresidentProofDeps = {
  file: (desk) => {
    if (!desk.agentSessionId) throw new Error('The native president has no recorded conversation identity.')
    return sessionJsonlPath(desk.cwd, desk.agentSessionId)
  },
  current: (desk) => {
    const terminal = getTerminal(desk.handleId)
    return !!terminal && terminal.cwd === desk.cwd && terminal.agentSessionId === desk.agentSessionId && isTerminalProcessAlive(desk.handleId)
  },
  screen: (desk) => getTerminalScreen(desk.handleId),
  interrupt: (desk) => sendInterrupt(desk.handleId),
}
export const nativePresidentTranscriptOffset = async (desk: NativePresidentDesk, deps = nativeProofDeps): Promise<number> => {
  if (!deps.current(desk)) throw new Error('The recorded native president is no longer current.')
  try { return (await stat(deps.file(desk))).size }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}

/** Heard/Enter is only submission. This proves a NEW matching owner turn and
 * its final public reply, then fsyncs the native log before delivery is durable. */
export const waitForNativePresidentTurnSettled = async (options: {
  desk: NativePresidentDesk
  sentText: string
  transcriptOffsetBeforeSend: number
  timeoutMs?: number
  signal?: AbortSignal
}, deps = nativeProofDeps): Promise<{ agentSessionId: string; transcriptOffset: number; refused?: true }> => {
  const { desk, transcriptOffsetBeforeSend: offset } = options
  if (!desk.agentSessionId || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid native turn proof boundary.')
  const expected = ownerSayLine(options.sentText)
  if (!expected) throw new Error('An empty native turn cannot be confirmed.')
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  for (;;) {
    if (options.signal?.aborted) throw new Error('The native turn proof observer was cancelled.')
    if (!deps.current(desk)) throw new Error('The native actor retired before its turn could be confirmed.')
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(deps.file(desk), 'r+')
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size < offset || metadata.size - offset > 2 * 1024 * 1024) throw new Error('The native turn log changed outside its bounded proof window.')
      const buffer = Buffer.alloc(metadata.size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const source = buffer.subarray(0, bytesRead).toString('utf8')
      let matched = false, replied = false, apiError = false
      const pending = new Set<string>(), completed = new Set<string>()
      for (const line of source.slice(0, source.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as { type?: string; isMeta?: boolean; isCompactSummary?: boolean; isApiErrorMessage?: boolean; message?: { content?: unknown } }
        if (entry.isMeta || entry.isCompactSummary) continue
        const content = entry.message?.content
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content as { type?: string; text?: string; id?: string; tool_use_id?: string }[] : []
        const text = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        if (entry.type === 'user' && text) {
          if (!matched && ownerSayLine(text) === expected) matched = true
          else if (matched) throw new Error('Another native input interleaved before this reply was confirmed.')
        }
        if (!matched) continue
        if (entry.type === 'assistant' && entry.isApiErrorMessage) apiError = true
        if (entry.type === 'assistant' && !entry.isApiErrorMessage && text.trim()) replied = true
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id && !completed.has(block.id)) pending.add(block.id)
          if (block.type === 'tool_result' && block.tool_use_id) { pending.delete(block.tool_use_id); completed.add(block.tool_use_id) }
        }
      }
      const screen = deps.screen(desk)
      const refused = matched && !pending.size && nativePresidentDrainable(screen) && classifyQuotaRefusal(screen) !== null
      if (matched && apiError && !refused) throw new Error('The native provider refused this turn; it is not a fulfilled reply.')
      if (matched && (replied || refused) && !pending.size && (noticeHoldReason(screen) === null || refused)) {
        await handle.sync()
        const synced = await handle.stat()
        const finalScreen = deps.screen(desk)
        const finalBoundary = refused ? nativePresidentDrainable(finalScreen) && classifyQuotaRefusal(finalScreen) !== null : noticeHoldReason(finalScreen) === null
        if (synced.size === metadata.size && deps.current(desk) && finalBoundary) return { agentSessionId: desk.agentSessionId, transcriptOffset: synced.size, ...(refused ? { refused: true } : {}) }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    finally { await handle?.close() }
    if (Date.now() >= deadline) throw new Error('The native president turn has not reached a confirmed boundary; its effects remain held for inspection.')
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

/** A stop is safe only for this exact submitted turn, with no unfinished tool
 * before Ctrl-C or new tool admitted during it. Completed effects remain real. */
export const interruptNativePresidentTurn = async (options: {
  desk: NativePresidentDesk; sentText: string; transcriptOffsetBeforeSend: number; timeoutMs?: number
  onInterruptRequested?: () => void
  beforeInterrupt?: () => Promise<void>
}, deps = nativeProofDeps): Promise<{ completed: boolean }> => {
  const { desk, transcriptOffsetBeforeSend: offset } = options
  const expected = ownerSayLine(options.sentText)
  if (!desk.agentSessionId || !expected || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid native stop boundary.')
  const read = async () => {
    if (!deps.current(desk)) throw new Error('The recorded native president changed before stopping.')
    const handle = await open(deps.file(desk), 'r+')
    try {
      const metadata = await handle.stat()
      if (metadata.size < offset || metadata.size - offset > 2 * 1024 * 1024) throw new Error('The native stop log changed outside its proof window.')
      const buffer = Buffer.alloc(metadata.size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const source = buffer.subarray(0, bytesRead).toString('utf8')
      let matched = false, replied = false, apiError = false
      const tools = new Set<string>(), pending = new Set<string>(), completed = new Set<string>()
      for (const line of source.slice(0, source.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
        const item = JSON.parse(line) as { type?: string; isMeta?: boolean; isCompactSummary?: boolean; isApiErrorMessage?: boolean; message?: { content?: unknown } }
        if (item.isMeta || item.isCompactSummary) continue
        const content = item.message?.content
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content as { type?: string; text?: string; id?: string; tool_use_id?: string }[] : []
        const text = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
        if (item.type === 'user' && text) {
          if (!matched && ownerSayLine(text) === expected) matched = true
          else if (matched) throw new Error('Another owner turn interleaved with this stop request.')
        }
        if (!matched) continue
        if (item.type === 'assistant' && item.isApiErrorMessage) apiError = true
        if (item.type === 'assistant' && !item.isApiErrorMessage && text.trim()) replied = true
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) { tools.add(block.id); if (!completed.has(block.id)) pending.add(block.id) }
          if (block.type === 'tool_result' && block.tool_use_id) { pending.delete(block.tool_use_id); completed.add(block.tool_use_id) }
        }
      }
      if (matched && apiError) throw new Error('The native provider refused this turn; it is not a fulfilled reply.')
      return { handle, size: metadata.size, matched, replied, tools, pending }
    } catch (error) { await handle.close(); throw error }
  }
  const before = await read()
  try {
    if (!before.matched) throw new Error('The native turn has an unconfirmed submission. Inspect it before continuing.')
    if (noticeHoldReason(deps.screen(desk)) === null && before.pending.size) throw new Error('The native turn has an unconfirmed tool effect despite its idle screen.')
    if (noticeHoldReason(deps.screen(desk)) === null && before.replied) {
      await before.handle.sync()
      if ((await before.handle.stat()).size !== before.size || !deps.current(desk) || noticeHoldReason(deps.screen(desk)) !== null) throw new Error('The native turn changed while confirming its completed result.')
      return { completed: true }
    }
    await options.beforeInterrupt?.()
    if (!deps.current(desk) || noticeHoldReason(deps.screen(desk)) !== 'generating' || !deps.interrupt?.(desk)) throw new Error('The native desk is not in a verifiable running turn; its draft was preserved.')
    options.onInterruptRequested?.()
    if (before.pending.size) throw new Error('The native tool was interrupted with an unconfirmed effect. Inspect it before continuing.')
  } finally { await before.handle.close() }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  for (;;) {
    const after = await read()
    try {
      if (!after.matched || after.pending.size || Array.from(after.tools).some((id) => !before.tools.has(id))) throw new Error('A native tool began or remained unconfirmed during interruption. Inspect its effects before continuing.')
      if (noticeHoldReason(deps.screen(desk)) === null) {
        await after.handle.sync()
        if ((await after.handle.stat()).size === after.size && deps.current(desk) && noticeHoldReason(deps.screen(desk)) === null) return { completed: false }
      }
    } finally { await after.handle.close() }
    if (Date.now() >= deadline) throw new Error('The native stop has not reached a confirmed empty prompt. Its effects remain held.')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
