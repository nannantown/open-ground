import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  openEscalation,
  answerEscalation,
  raiseEscalationToOwner,
  listEscalations,
  countOpenEscalationsByProject,
  EscalationStateError,
  type OpenEscalationInput,
} from './swarmEscalations'
import { sweepCommanderQuestions, commanderQuestionText } from './commanderQuestions'
import { needsOwnerDirectly } from './swarmDecisionRouting'
import { indexEscalationsByTask } from '../boardEscalation'

// The commander question lane (owner decision 2026-09-23 — 「僕が喋るのは社長さんだけ」):
// a worker's ordinary question is settled by the commander and never rings the
// owner; a boundary question still goes straight to the owner; and nothing can
// sit in the commander lane past the window without reaching the owner.

let home: string
let project: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-cmdq-')))
  process.env.OPENGROUND_HOME = home
  project = join(home, 'proj')
  await mkdir(project, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const workerQ = (over: Partial<OpenEscalationInput> = {}): OpenEscalationInput => ({
  projectPath: project,
  question: '日付の整形は既存の formatDate を使いますか、それとも新しく書きますか？',
  context: 'worker swarm/x が blocked',
  whyEscalated: 'policy',
  taskId: 'card-1',
  branch: 'swarm/card-1',
  runtime: 'sdk',
  sdkSessionId: 'sdk-1',
  askCommanderFirst: true,
  ...over,
})

const notifier = () => {
  const calls: any[] = []
  return { calls, notify: async (n: unknown) => void calls.push(n) }
}

describe('openEscalation — the commander lane', () => {
  it('holds an ordinary worker question with the commander and rings nothing', async () => {
    const n = notifier()
    const { escalation } = await openEscalation(workerQ(), { notify: n.notify })
    expect(escalation.routedTo).toBe('commander')
    expect(n.calls).toHaveLength(0)
    // Not the owner's turn: no Ground lamp count, no Board badge, not in the owner lane.
    expect((await countOpenEscalationsByProject())?.get(escalation.projectPath) ?? 0).toBe(0)
    expect(indexEscalationsByTask(await listEscalations({ status: 'open' })).byTask.size).toBe(0)
    expect(await listEscalations({ lane: 'owner', status: 'open' })).toHaveLength(0)
    expect(await listEscalations({ lane: 'commander', status: 'open' })).toHaveLength(1)
  })

  it('sends a boundary question straight to the owner even when asked to try the commander', async () => {
    const n = notifier()
    const { escalation } = await openEscalation(
      workerQ({ question: 'この変更をリリースしてもいいですか？' }),
      { notify: n.notify },
    )
    expect(escalation.routedTo).toBeUndefined()
    expect(n.calls).toHaveLength(1)
    expect(n.calls[0].event).toBe('escalation-open')
  })

  it('template raises (no askCommanderFirst) stay in the owner lane', async () => {
    const n = notifier()
    const { escalation } = await openEscalation(workerQ({ askCommanderFirst: undefined }), { notify: n.notify })
    expect(escalation.routedTo).toBeUndefined()
    expect(n.calls).toHaveLength(1)
  })
})

describe('answerEscalation — who may answer', () => {
  const sdkDeps = (pushed: string[]) => ({
    isPathAllowed: async () => true,
    canPushInto: async () => true,
    push: (_id: string, text: string) => {
      pushed.push(text)
      return true
    },
  })

  it('the commander answers its own lane, and the worker is told it was the commander', async () => {
    const { escalation } = await openEscalation(workerQ(), { notify: async () => {} })
    const pushed: string[] = []
    const res = await answerEscalation(escalation.id, '既存の formatDate を使ってください', sdkDeps(pushed), {
      by: 'commander',
    })
    expect(res.delivery).toBe('injected')
    expect(res.escalation.answeredBy).toBe('commander')
    expect(pushed[0]).toContain('【司令官からの回答】')
    expect(pushed[0]).not.toContain('本人（オーナー）が回答')
  })

  it('the commander can NOT answer a question waiting on the owner', async () => {
    const { escalation } = await openEscalation(workerQ({ askCommanderFirst: undefined }), {
      notify: async () => {},
    })
    await expect(
      answerEscalation(escalation.id, 'やっておきます', sdkDeps([]), { by: 'commander' }),
    ).rejects.toBeInstanceOf(EscalationStateError)
    const [still] = await listEscalations({ status: 'open' })
    expect(still?.id).toBe(escalation.id)
  })

  it('once handed on, the commander can no longer answer it', async () => {
    const { escalation } = await openEscalation(workerQ(), { notify: async () => {} })
    await raiseEscalationToOwner(escalation.id, undefined, { notify: async () => {} })
    await expect(
      answerEscalation(escalation.id, 'x', sdkDeps([]), { by: 'commander' }),
    ).rejects.toBeInstanceOf(EscalationStateError)
  })
})

describe('raiseEscalationToOwner', () => {
  it('moves the question to the owner, rings once, and is idempotent', async () => {
    const { escalation } = await openEscalation(workerQ(), { notify: async () => {} })
    const n = notifier()
    const first = await raiseEscalationToOwner(escalation.id, { plainQuestion: 'どちらにしますか？' }, { notify: n.notify })
    const second = await raiseEscalationToOwner(escalation.id, undefined, { notify: n.notify })
    expect(first.raised).toBe(true)
    expect(second.raised).toBe(false)
    expect(n.calls).toHaveLength(1)
    const [rec] = await listEscalations({ lane: 'owner', status: 'open' })
    expect(rec?.plainQuestion).toBe('どちらにしますか？')
    expect(rec?.raisedToOwnerAt).toBeTruthy()
    expect((await countOpenEscalationsByProject())?.get(rec!.projectPath)).toBe(1)
  })
})

describe('sweepCommanderQuestions', () => {
  it('tells the commander once, then hands the question to the owner when the window passes', async () => {
    const { escalation } = await openEscalation(workerQ(), { notify: async () => {} })
    const told: string[] = []
    const raised: string[] = []
    const t0 = Date.parse(escalation.createdAt)
    const deps = (now: number) => ({
      now: () => now,
      tell: async (_p: string, text: string) => {
        told.push(text)
        return true
      },
      raise: async (id: string) => {
        raised.push(id)
        return raiseEscalationToOwner(id, undefined, { notify: async () => {} })
      },
      windowMs: 10 * 60_000,
    })
    await sweepCommanderQuestions(project, deps(t0 + 1000))
    await sweepCommanderQuestions(project, deps(t0 + 30_000))
    expect(told).toHaveLength(1) // said once, not per sweep
    expect(told[0]).toContain(escalation.id)
    expect(raised).toHaveLength(0)
    await sweepCommanderQuestions(project, deps(t0 + 10 * 60_000 + 1))
    expect(raised).toEqual([escalation.id])
    expect(await listEscalations({ lane: 'owner', status: 'open' })).toHaveLength(1)
  })

  it('an undelivered tell is retried on the next sweep', async () => {
    await openEscalation(workerQ(), { notify: async () => {} })
    let ok = false
    let calls = 0
    const deps = {
      tell: async () => {
        calls++
        return ok
      },
      raise: async () => undefined,
    }
    await sweepCommanderQuestions(project, deps)
    ok = true
    await sweepCommanderQuestions(project, deps)
    await sweepCommanderQuestions(project, deps)
    expect(calls).toBe(2)
  })
})

describe('needsOwnerDirectly / commanderQuestionText', () => {
  it('flags standing-boundary topics', () => {
    for (const q of ['公開していいですか', 'このファイルを削除しますか', '費用がかかります', 'Should I push to production?']) {
      expect(needsOwnerDirectly(q)).toBe(true)
    }
    expect(needsOwnerDirectly('関数名は camelCase と snake_case のどちら？')).toBe(false)
  })

  it('tells the commander both exits and the id', () => {
    const text = commanderQuestionText({
      id: 'abc',
      question: 'q?',
      createdAt: new Date().toISOString(),
    } as any)
    expect(text).toContain('escalations/answer')
    expect(text).toContain('"by":"commander"')
    expect(text).toContain('escalations/raise')
    expect(text).toContain('abc')
  })
})
