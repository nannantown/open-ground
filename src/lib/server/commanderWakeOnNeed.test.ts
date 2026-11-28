// commanderWakeOnNeed.test.ts — every commander need wakes an ABSENT commander
// (docs/AUTONOMY-SPEC.md R-A1 / R-D3a, unit U4, 2026-11-28).
//
// The boot no longer revives the commander (an idle start must bill nothing), so
// the needs themselves have to start it. Three of the four do it on their own lane:
//   • a review-ready card  — the engine's integrate pass, absent arm
//                            (swarmOrchestrator.idleDesks.test.ts);
//   • a `manager/say` relay — the route (server/routes/__tests__/managerSayWake.routes.test.ts);
//   • a worker's question routed to the commander, and an owner's answer owed to
//     the commander — the question sweep. THIS file: the sweep's DEFAULT delivery
//     (not an injected `tell`) must reach a commander that is not there yet.
//
// Everything expensive is mocked at the module boundary: no `claude`, no PTY.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const spawns: string[] = []
const said: string[] = []
let desks: { runtime: 'sdk'; handleId: string; cwd: string; stopping?: boolean }[] = []

vi.mock('./swarmManager', () => ({
  spawnSwarmManager: async ({ projectPath }: { projectPath: string }) => {
    spawns.push(projectPath)
    desks = [{ runtime: 'sdk', handleId: 'sdk-manager-1', cwd: projectPath }]
    return { sdkSessionId: 'sdk-manager-1', runtime: 'sdk' }
  },
  MANAGER_DESK_LABEL: '司令官',
}))
vi.mock('./swarmManagerRuntime', async (orig) => {
  const actual = await orig<typeof import('./swarmManagerRuntime')>()
  return {
    ...actual,
    listManagerDesks: () => desks,
    sayToManagerDesk: (_h: unknown, text: string) => {
      said.push(text)
      return { ok: true }
    },
  }
})
vi.mock('./claudePreflight', () => ({ claudeRunPreflight: async () => ({ ok: true }) }))
vi.mock('./swarmEnvPreflight', () => ({ swarmEnvPreflight: async () => ({ ok: true, issues: [] }) }))
vi.mock('./automationPolicy', async (orig) => {
  const actual = await orig<typeof import('./automationPolicy')>()
  return { ...actual, automaticOperationAllowed: async () => true }
})

import { openEscalation, answerEscalation, redeliverAnswerToCommander } from './swarmEscalations'
import { sweepCommanderQuestions } from './commanderQuestions'

let home: string
let project: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-cmd-wake-')))
  process.env.OPENGROUND_HOME = home
  project = join(home, 'proj')
  await mkdir(project, { recursive: true })
  spawns.length = 0
  said.length = 0
  desks = []
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

describe('the question sweep wakes an absent commander', () => {
  it("a worker's question in the commander lane", async () => {
    const { escalation } = await openEscalation(
      {
        projectPath: project,
        question: '日付の整形は既存の formatDate を使いますか？',
        context: 'worker swarm/x が blocked',
        whyEscalated: 'policy',
        taskId: 'card-1',
        branch: 'swarm/card-1',
        runtime: 'sdk',
        sdkSessionId: 'sdk-1',
        askCommanderFirst: true,
      },
      { notify: async () => {} },
    )
    expect(escalation.routedTo).toBe('commander')
    // Default `tell` — the production delivery, which must wake.
    const out = await sweepCommanderQuestions(project, { raise: async () => undefined })
    expect(spawns, 'no desk was up: the sweep must start one').toEqual([project])
    expect(out.told).toEqual([escalation.id])
    expect(said.some((t) => t.includes(escalation.id))).toBe(true)
  })

  it("an owner's answer owed to the commander's own question", async () => {
    const { escalation } = await openEscalation(
      { projectPath: project, question: 'Land it?', context: 'ctx', whyEscalated: 'policy', receiptKey: 'commander:blocked:none:wake' },
      { notify: async () => {} },
    )
    // The answer arrives while no desk can take it.
    await answerEscalation(escalation.id, 'A', { isPathAllowed: async () => true, tellCommander: async () => false })
    // Default `tellCommander` — the production delivery, which must wake.
    expect(await redeliverAnswerToCommander(escalation.id, { isPathAllowed: async () => true })).toBe(true)
    expect(spawns).toEqual([project])
    expect(said.some((t) => t.includes('オーナーの回答「A」'))).toBe(true)
  })
})
