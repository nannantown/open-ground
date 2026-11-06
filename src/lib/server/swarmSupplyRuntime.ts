// A president has one address across either pool. Occupancy includes stopping
// SDK sessions until their pump is reaped; adoption excludes them.
import { listOwnerDeskTerminals, listLiveDesksIn, isTerminalProcessAlive, killTerminal } from './terminal'
import { resolve } from 'node:path'
import { listSdkSessions, pushSdkInput, terminateSdkSession, getSdkPublicConversation, type SdkSessionInfo } from './sdkSession'

export const SUPPLY_DESK_LABEL = '補給官'
export interface SupplyDeskHandle {
  runtime: 'pty' | 'sdk'
  handleId: string
  cwd: string
  agentSessionId: string | null
  lastOutputAt: number | null
  startedAt: number
  stopping: boolean
}
export const listAllLiveSupplyDesks = (deps: {
  pty?: typeof listOwnerDeskTerminals
  alive?: typeof isTerminalProcessAlive
  sdk?: () => SdkSessionInfo[]
} = {}): SupplyDeskHandle[] => {
  const pty = (deps.pty ?? listOwnerDeskTerminals)().filter((d) => d.deskLabel === SUPPLY_DESK_LABEL
    && (deps.alive ?? isTerminalProcessAlive)(d.id)).map<SupplyDeskHandle>((d) => ({
    runtime: 'pty', handleId: d.id, cwd: d.cwd, agentSessionId: d.agentSessionId ?? null,
    lastOutputAt: d.lastOutputAt ?? null, startedAt: d.startedAtMs, stopping: false,
  }))
  const sdk = (deps.sdk ?? listSdkSessions)().filter((d) => d.role === 'supply' && !d.reaped)
    .map<SupplyDeskHandle>((d) => ({ runtime: 'sdk', handleId: d.id, cwd: d.cwd,
      agentSessionId: d.agentSessionId ?? null, lastOutputAt: d.seq > (d.inputs ?? 0) ? d.lastEventAt : null,
      startedAt: d.startedAt, stopping: d.closed === true || d.status === 'exited' || d.status === 'failed',
    }))
  return [...pty, ...sdk].sort((a, b) => b.startedAt - a.startedAt)
}
export const listLiveSupplyDesks = (projectPath: string): SupplyDeskHandle[] =>
  listAllLiveSupplyDesks({ pty: () => listLiveDesksIn(projectPath, SUPPLY_DESK_LABEL) })
    .filter((d) => resolve(d.cwd) === resolve(projectPath))
export const stopSupplyDesk = (desk: SupplyDeskHandle): boolean => {
  if (desk.runtime === 'sdk') return terminateSdkSession(desk.handleId)
  killTerminal(desk.handleId)
  return true
}
export const pushSupplyInput = (id: string, text: string): boolean => {
  if (!listSdkSessions().some((desk) => desk.id === id && desk.role === 'supply'
    && !desk.closed && !desk.reaped)) return false
  return pushSdkInput(id, text)
}
export const sendToSupplyDesk = async (desk: SupplyDeskHandle, text: string): Promise<boolean> => {
  if (desk.stopping) return false
  if (desk.runtime === 'sdk') return pushSupplyInput(desk.handleId, text)
  const { injectAnswerIntoWorker } = await import('./swarmEscalations')
  return injectAnswerIntoWorker(desk.handleId, text)
}

/** The selected president's append-only talk log. Phone cursors must never
 * tail the transport's rewritten JSON conversation state. */
export const supplyTranscriptFile = async (projectPath: string): Promise<string | null> => {
  const { readSwarmSessions } = await import('./swarmSessions')
  const { selectedRuntime } = await import('./chatgptRuntime')
  const stored = await readSwarmSessions(projectPath)
  const live = listLiveSupplyDesks(projectPath).find((desk) => !desk.stopping)
  const session = live?.agentSessionId ? { sessionId: live.agentSessionId, cwd: live.cwd }
    : await selectedRuntime('swarm') === 'chatgpt' ? stored.chatgpt?.supply : stored.supply
  if (!session) return null
  if (session.sessionId.startsWith('chatgpt-')) {
    return (await import('./chatgptQuery')).chatGptTranscriptFile(session.sessionId)
  }
  return (await import('./transcript')).sessionJsonlPath(session.cwd, session.sessionId)
}

/** Owner-bound public words for a specific SDK president handle. Runtime pool
 * access stays here; route code cannot redirect a worker or another project. */
export const getSupplyPublicConversation = (projectPath: string, handleId: string, ownerKey: string) => {
  const current = listLiveSupplyDesks(projectPath).filter(desk => !desk.stopping)
  if (current.length !== 1 || current[0].runtime !== 'sdk' || current[0].handleId !== handleId) return null
  return getSdkPublicConversation(handleId, { ownerKey, cwd: projectPath, role: 'supply' })
}
