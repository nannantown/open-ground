// THE CAP AT WAKE NEVER CLOSES A BUSY COMMANDER DESK (AUTONOMY-SPEC R-D3b).
//
// The engine asks idleManagerDeskOverCap (swarmManager.ts) at a wake; when it
// answers, it closes the desk through the unresponsive-desk teardown with
// {idleOnly:true} (swarmOrchestrator defaultRecycleManagerDesk). The teardown
// awaits several reads before it closes, so a turn can be pushed into the desk
// between the probe and the close. Its last synchronous managerDeskIdle check is
// the only thing that keeps that turn from being cut off — and review B-S6 deleted
// that line with 40 tests staying green (the idle-desks test injects the seam
// and only asserts the flag was passed). Pinned here on the real pool and the
// production teardown, with a provider that only records turns.

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addProjectEntry } from './registry'
import { recordSwarmSession } from './swarmSessions'
import { initializeRuntimeTransitions } from './runtimeTransitionStore'
import { getSdkSession, pushSdkInput, spawnSdkSession, terminateSdkSession } from './sdkSession'
import type { SdkEvent } from './sdkEvents'
import { idleManagerDeskOverCap } from './swarmManager'
import { defaultDeps } from './swarmOrchestrator'

// The policy read is the teardown's first await: the seam where a turn arrives
// mid-teardown in this test.
const automation = vi.hoisted(() => ({ onCall: null as null | (() => void) }))
vi.mock('./automationPolicy', async (original) => ({
  ...await original<typeof import('./automationPolicy')>(),
  automaticOperationAllowed: async () => {
    const hook = automation.onCall
    automation.onCall = null
    hook?.()
    return true
  },
}))

let project: string
let release: () => void = () => {}
const handles: string[] = []

beforeEach(async () => {
  automation.onCall = null
  const home = join(process.env.OPENGROUND_HOME!, `manager-cap-recycle-${randomUUID()}`)
  project = join(home, 'project')
  await mkdir(project, { recursive: true })
  await mkdir(join(home, 'og'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('OPENGROUND_HOME', join(home, 'og'))
  await addProjectEntry(project)
  await initializeRuntimeTransitions({ assistant: { provider: 'claude' }, swarm: { provider: 'claude' } })
})
afterEach(async () => {
  release()
  for (const id of handles.splice(0)) {
    terminateSdkSession(id)
    await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true))
  }
  vi.unstubAllEnvs()
})

/** A commander desk on the real pool: its first turn ends at once (the desk is
 *  then idle); any later turn runs until the test releases it. */
const idleCommanderDesk = async (): Promise<{ id: string; sessionId: string; turns: string[] }> => {
  const sessionId = randomUUID()
  const turns: string[] = []
  const session = spawnSdkSession({
    cwd: project, role: 'manager', agentSessionId: sessionId, options: {}, initialPrompt: 'start',
    distillMessage: (message) => [message as SdkEvent],
    queryFn: (params) => ({
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        for await (const input of params.prompt) {
          turns.push((input as { message: { content: { text: string }[] } }).message.content[0].text)
          yield { kind: 'text', text: 'ok' }
          if (turns.length > 1) await new Promise<void>((resolve) => { release = resolve })
          yield { kind: 'turn_end', reason: 'completed', isError: false }
        }
      },
    }),
  })
  handles.push(session.id)
  await recordSwarmSession(project, 'manager', sessionId)
  await vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe('waiting'))
  return { id: session.id, sessionId, turns }
}

const overCap = { cap: async () => 100, contextTokens: async () => 500, backgroundTaskAt: async () => null }

describe('the cap-at-wake recycle and a busy desk', () => {
  it('control: an idle desk over the cap is closed (the teardown reaches the close)', async () => {
    const desk = await idleCommanderDesk()
    expect(await idleManagerDeskOverCap(project, overCap)).toEqual({ agentSessionId: desk.sessionId, tokens: 500 })
    expect(await defaultDeps().recycleManagerDesk!(project, { idleOnly: true })).toBe(true)
    expect(getSdkSession(desk.id)?.status).not.toBe('waiting')
  })

  it('a turn pushed after the probe, while the teardown awaits, is not cut off: the desk stays open and works', async () => {
    const desk = await idleCommanderDesk()
    expect(await idleManagerDeskOverCap(project, overCap), 'the probe saw an idle desk over the cap').not.toBeNull()
    automation.onCall = () => { expect(pushSdkInput(desk.id, 'the owner asks something')).toBe(true) }
    expect(await defaultDeps().recycleManagerDesk!(project, { idleOnly: true })).toBe(false)
    expect(getSdkSession(desk.id)?.status).toBe('working')
    await vi.waitFor(() => expect(desk.turns).toEqual(['start', 'the owner asks something']))
    release()
    await vi.waitFor(() => expect(getSdkSession(desk.id)?.status, 'the turn finished on an open desk').toBe('waiting'))
  })

  it('the unresponsive-desk escalation (no idleOnly) still closes a desk that is working', async () => {
    const desk = await idleCommanderDesk()
    expect(pushSdkInput(desk.id, 'a turn')).toBe(true)
    expect(await defaultDeps().recycleManagerDesk!(project)).toBe(true)
  })
})
