// Durable assistant inbox and effect journal. Small, bounded transactions are
// synchronous so legacy proposal buttons and withdrawals cannot acknowledge a
// state change before it is on disk. Model streams never write token deltas here.
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { openGroundHome } from './paths'

const id = z.string().min(1).max(100).regex(/^[\w.:-]+$/)
const profile = z.object({ provider: z.enum(['claude', 'chatgpt']), model: z.string().max(128).optional(), effort: z.string().max(32).optional() })
const turn = z.object({
  id, bodyHash: z.string().length(64), text: z.string().max(20_000), via: z.enum(['phone', 'screen']), photo: z.string().max(240).optional(), photoDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  conversationId: id, epoch: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  acceptedAt: z.number(), updatedAt: z.number(), state: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'uncertain']),
  attemptId: id.optional(), profile: profile.optional(), accountKey: z.string().max(256).optional(),
  ownerKey: z.string().max(128).optional(),
  result: z.object({ reply: z.string().max(30_000), speak: z.string().max(30_000).optional(), said: z.boolean().optional(), proposals: z.array(z.record(z.string(), z.unknown())).max(6).optional(), entries: z.array(z.record(z.string(), z.unknown())).max(2).optional() }).optional(),
  error: z.string().max(500).optional(), draftClientId: id.optional(), draftRevision: z.number().int().nonnegative().optional(),
})
const proposal = z.object({ id, kind: z.enum(['card', 'commander', 'president']), projectId: id, project: z.string().max(1000),
  title: z.string().max(1000), body: z.string().max(4000), path: z.string().max(32_000), at: z.number(), expiresAt: z.number(),
  state: z.enum(['open', 'done', 'dropped', 'expired']), via: z.enum(['phone', 'screen']), closedAt: z.number().optional(),
  originTurnId: id.optional(), about: id.optional(), pressing: z.boolean().optional(), cancel: z.boolean().optional() })
const action = z.object({ id, proposalId: id, hash: z.string().length(64), conversationId: id, epoch: z.number().int(),
  state: z.enum(['approved', 'started', 'completed', 'uncertain', 'cancelled']), at: z.number(),
  proposal: proposal.optional(),
  receipt: z.record(z.string(), z.unknown()).optional(), error: z.string().max(500).optional() })
const schema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), conversationId: id,
  epoch: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), memoryRevision: z.number().int().nonnegative(),
  paused: z.boolean(), drainPaused: z.boolean().default(false), profile: profile.optional(), turns: z.array(turn).max(2000),
  ownerKey: z.string().max(128).optional(),
  proposals: z.array(proposal).max(100), actions: z.array(action).max(2000),
  operations: z.array(z.object({ id, hash: z.string().length(64), conversationId: id, epoch: z.number().int(),
    kind: z.enum(['stop-turn', 'new-conversation', 'delete-memory', 'delete-history']).optional(), turnId: id.optional(),
    phase: z.enum(['prepared', 'completed']).default('completed'), resumePaused: z.boolean().optional() })).max(2000),
})
export type AssistantRuntimeState = z.infer<typeof schema>
export type AssistantTurnReceipt = z.infer<typeof turn>
export type AssistantActionReceipt = z.infer<typeof action>
export type AssistantRuntimeProfile = z.infer<typeof profile>
export type AssistantResetKind = 'stop-turn' | 'new-conversation' | 'delete-memory' | 'delete-history'
export class AssistantRuntimeConflict extends Error {
  readonly status = 409
  constructor(readonly reason: string) { super(reason); this.name = 'AssistantRuntimeConflict' }
}
const fresh = (): AssistantRuntimeState => ({ version: 1, revision: 0, conversationId: randomUUID(), epoch: 0, generation: 0,
  memoryRevision: 0, paused: false, drainPaused: false, turns: [], proposals: [], actions: [], operations: [] })
const scope = new AsyncLocalStorage<'local-claude'>()
const ownerScope = new AsyncLocalStorage<string>()
export const withOwnerAssistantScope = <T>(ownerKey: string, run: () => T): T => ownerScope.run(ownerKey, run)
export const assistantScopeOwnerKey = (): string | undefined => ownerScope.getStore()
export const withLocalClaudeAssistantScope = <T>(run: () => T): T => scope.run('local-claude', run)
export const isLocalClaudeAssistantScope = (): boolean => scope.getStore() === 'local-claude'
export const assistantRuntimeDirectory = (): string => join(openGroundHome(), isLocalClaudeAssistantScope() ? 'assistant-local' : 'assistant')
const directory = assistantRuntimeDirectory
const file = () => join(directory(), 'runtime.json')
const archiveDirectory = () => join(directory(), 'archive')
let sequence = 0
const secureDirectory = (): void => {
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory())
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Assistant runtime directory is unsafe')
}
const readState = (path: string): AssistantRuntimeState => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Assistant runtime journal is unsafe')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { return schema.parse(JSON.parse(readFileSync(fd, 'utf8'))) } finally { closeSync(fd) }
}
export const readAssistantRuntime = (): AssistantRuntimeState => {
  secureDirectory()
  if (!existsSync(file())) { const state = fresh(); writeState(state); return state }
  return readState(file())
}
const writeState = (state: AssistantRuntimeState, destination = file()): void => {
  const bytes = JSON.stringify(schema.parse(state))
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('Assistant runtime journal is full; archive the conversation before continuing')
  const tmp = join(directory(), `.runtime-${process.pid}-${sequence++}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(tmp, destination)
    if (process.platform !== 'win32') { const dir = openSync(dirname(destination), constants.O_RDONLY); try { fsyncSync(dir) } finally { closeSync(dir) } }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(tmp) } catch { /* renamed or write failed before creation */ }
  }
}
const archives = (): string[] => {
  if (!existsSync(archiveDirectory())) return []
  const stat = lstatSync(archiveDirectory())
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Assistant archive directory is unsafe')
  return readdirSync(archiveDirectory()).filter(name => /^[\w.:-]+\.json$/.test(name)).sort().map(name => join(archiveDirectory(), name))
}
const archivedTurn = (turnId: string): AssistantTurnReceipt | undefined => {
  for (const path of archives()) { const found = readState(path).turns.find(turn => turn.id === turnId); if (found) return found }
  return undefined
}
export const getAssistantResetOperation = (operationId: string) => {
  const current = readAssistantRuntime().operations.find(operation => operation.id === operationId)
  if (current) return current
  for (const path of archives()) { const found = readState(path).operations.find(operation => operation.id === operationId); if (found) return found }
  return undefined
}
export const clearAssistantRuntimeHistoryPayloads = (): void => {
  const erase = (state: AssistantRuntimeState) => { for (const t of state.turns) { t.text = ''; delete t.photo; delete t.result } }
  mutateAssistantRuntime(erase)
  for (const path of archives()) { const state = readState(path); erase(state); writeState(state, path) }
}
export const mutateAssistantRuntime = <T>(change: (state: AssistantRuntimeState) => T): T => {
  const state = readAssistantRuntime()
  const result = change(state)
  if (result instanceof Promise) throw new Error('Assistant runtime transaction must be synchronous')
  state.revision++
  writeState(state)
  return structuredClone(result)
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const acceptAssistantTurn = (input: { id: string; text: string; via?: 'phone' | 'screen'; photo?: string; photoDigest?: string;
  conversationId?: string; epoch?: number; draftClientId?: string; draftRevision?: number; accountKey?: string; ownerKey?: string }): AssistantTurnReceipt => mutateAssistantRuntime(state => {
  id.parse(input.id)
  if (state.ownerKey && state.ownerKey !== input.ownerKey) throw new AssistantRuntimeConflict('owner-changed')
  if (input.ownerKey) state.ownerKey = input.ownerKey
  if (input.photoDigest) z.string().regex(/^[a-f0-9]{64}$/).parse(input.photoDigest)
  const hash = digest([input.text, input.photoDigest ? ['sha256', input.photoDigest] : input.photo ?? null, input.via ?? 'phone'])
  const existing = state.turns.find(t => t.id === input.id) ?? archivedTurn(input.id)
  if (existing) {
    if (existing.bodyHash !== hash) throw new AssistantRuntimeConflict('request-id-content-mismatch')
    if (existing.accountKey && existing.accountKey !== input.accountKey) throw new AssistantRuntimeConflict('account-changed')
    return existing
  }
  if (input.conversationId !== undefined && input.conversationId !== state.conversationId || input.epoch !== undefined && input.epoch !== state.epoch)
    throw new AssistantRuntimeConflict('conversation-changed')
  if (state.turns.filter(t => t.state === 'queued' || t.state === 'running').length >= 2) throw new AssistantRuntimeConflict('busy')
  const at = Date.now()
  const accepted = turn.parse({ ...input, via: input.via ?? 'phone', conversationId: state.conversationId,
    epoch: state.epoch, generation: state.generation, bodyHash: hash, acceptedAt: at, updatedAt: at, state: 'queued' })
  state.turns.push(accepted)
  return accepted
})
export const claimAssistantTurn = (turnId: string, runtime?: AssistantRuntimeProfile, accountKey?: string): AssistantTurnReceipt | null => mutateAssistantRuntime(state => {
  if (state.paused || state.turns.some(t => t.state === 'running')) return null
  const first = state.turns.find(t => t.state === 'queued' && t.epoch === state.epoch)
  if (!first || first.id !== turnId) return null
  // An explicit provider handoff transfers owner-authored queued text, not the
  // old provider's credential lease. Active attempts keep their original key.
  if (runtime?.provider === 'claude') delete first.accountKey
  if (first.accountKey && first.accountKey !== accountKey) { first.state = 'uncertain'; first.error = 'account-changed'; return null }
  first.state = 'running'; first.attemptId = randomUUID(); first.generation = state.generation; first.updatedAt = Date.now()
  if (runtime) first.profile = runtime
  if (accountKey) first.accountKey = accountKey
  return first
})
export const assistantTurnCurrent = (receipt: AssistantTurnReceipt): boolean => {
  const state = readAssistantRuntime()
  const current = state.turns.find(t => t.id === receipt.id)
  return state.epoch === receipt.epoch && state.generation === receipt.generation && current?.state === 'running' && current.attemptId === receipt.attemptId
}
export const publicAssistantTurnReceipt = (receipt: AssistantTurnReceipt): Omit<AssistantTurnReceipt, 'accountKey' | 'ownerKey' | 'bodyHash' | 'attemptId' | 'photoDigest'> => {
  const { accountKey: _accountKey, ownerKey: _ownerKey, bodyHash: _bodyHash, attemptId: _attemptId, photoDigest: _photoDigest, ...publicReceipt } = receipt
  return publicReceipt
}
export const getAssistantTurnReceipt = (turnId: string, ownerKey?: string): ReturnType<typeof publicAssistantTurnReceipt> | null => {
  const state = readAssistantRuntime()
  if (state.ownerKey && state.ownerKey !== ownerKey) return null
  const receipt = state.turns.find(t => t.id === turnId) ?? archivedTurn(turnId)
  return receipt ? publicAssistantTurnReceipt(receipt) : null
}
export const listAcceptedAssistantDrafts = (clientId: string, ownerKey?: string): { draftRevision: number }[] => {
  const state = readAssistantRuntime()
  if (state.ownerKey && state.ownerKey !== ownerKey) return []
  const turns = [...state.turns, ...archives().flatMap(path => readState(path).turns)]
  return turns.filter(t => t.draftClientId === clientId && t.draftRevision !== undefined && t.ownerKey === ownerKey)
    .map(t => ({ draftRevision: t.draftRevision! }))
}
export const settleAssistantTurn = (receipt: AssistantTurnReceipt, result?: AssistantTurnReceipt['result'], error?: string): boolean => mutateAssistantRuntime(state => {
  const current = state.turns.find(t => t.id === receipt.id)
  if (!current || current.state !== 'running' || current.attemptId !== receipt.attemptId || state.epoch !== receipt.epoch || state.generation !== receipt.generation) return false
  current.state = result ? 'completed' : 'failed'; current.updatedAt = Date.now()
  if (result) current.result = result
  if (error) current.error = error.slice(0, 500)
  return true
})
export const recoverAssistantRuntime = (): AssistantRuntimeState => mutateAssistantRuntime(state => {
  for (const t of state.turns) if (t.state === 'running') { t.state = 'interrupted'; t.error = 'app-restarted'; t.updatedAt = Date.now() }
  for (const a of state.actions) if (a.state === 'started') { a.state = 'uncertain'; a.error = 'effect-result-unconfirmed' }
  for (const a of state.actions) if (a.state === 'approved') {
    a.state = 'cancelled'
    const p = state.proposals.find(p => p.id === a.proposalId)
    if (p?.state === 'done' && !p.cancel && p.expiresAt > Date.now()) { p.state = 'open'; p.pressing = false; delete p.closedAt }
  }
  return state
})
export const resetAssistantRuntimeState = (operationId: string, kind: AssistantResetKind, turnId?: string): AssistantRuntimeState => mutateAssistantRuntime(state => {
  id.parse(operationId)
  const hash = digest([kind, turnId ?? null])
  const existing = getAssistantResetOperation(operationId)
  if (existing) { if (existing.hash !== hash) throw new AssistantRuntimeConflict('operation-id-content-mismatch'); return state }
  if (state.operations.some(operation => operation.phase === 'prepared')) throw new AssistantRuntimeConflict('reset-in-progress')
  if (kind === 'stop-turn' && turnId && !state.turns.some(turn => turn.id === turnId && turn.state === 'running')) {
    state.operations.push({ id: operationId, hash, conversationId: state.conversationId, epoch: state.epoch, kind, turnId, phase: 'completed' })
    return state
  }
  // Reset and drain are independent pause owners. Cancelling the drain must
  // neither release an unfinished reset nor let that reset revive a stale pause.
  const resumePaused = state.paused && !state.drainPaused
  state.paused = true
  state.generation++
  if (kind === 'new-conversation' || kind === 'delete-history') {
    const oldConversationId = state.conversationId
    state.epoch++; state.conversationId = randomUUID()
    for (const t of state.turns) if (t.state === 'queued' || t.state === 'running') { t.state = 'cancelled'; t.error = 'conversation-reset' }
    for (const p of state.proposals) if (p.state === 'open') { p.state = 'dropped'; p.closedAt = Date.now(); p.cancel = true }
    for (const a of state.actions) { if (a.state === 'approved') a.state = 'cancelled'; else if (a.state === 'started') a.state = 'uncertain' }
    // Archive before clearing the hot journal. A crash before the final rename
    // leaves the old current journal authoritative; retries still find its IDs.
    mkdirSync(archiveDirectory(), { recursive: true, mode: 0o700 })
    archives() // refuse a substituted symlink directory
    writeState({ ...state, conversationId: oldConversationId }, join(archiveDirectory(), `${oldConversationId}.json`))
    state.turns = []; state.operations = []; state.proposals = []
    state.actions = state.actions.filter(action => action.state === 'uncertain')
  } else {
    if (kind === 'delete-memory') state.memoryRevision++
    for (const t of state.turns) if (t.state === 'running' && (!turnId || t.id === turnId)) { t.state = 'interrupted'; t.error = kind }
  }
  if (kind === 'delete-history') for (const t of state.turns) { t.text = ''; delete t.photo; delete t.result }
  state.operations.push({ id: operationId, hash, conversationId: state.conversationId, epoch: state.epoch, kind,
    ...(turnId ? { turnId } : {}), phase: 'prepared', resumePaused })
  return state
})
export const __resetAssistantRuntimeForTest = (): void => {
  try { unlinkSync(file()) } catch { /* no journal */ }
  rmSync(archiveDirectory(), { recursive: true, force: true })
}
