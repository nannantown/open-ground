import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests, addImportedProjectEntry } from '@/lib/server/registry'
import type {
  EscalationOpenResponse,
  EscalationAnswerResponse,
  EscalationsResponse,
} from '@/lib/types'

// ─────────────────────────────────────────────────────────────────────────────
// Escalations inbox ROUTES (C1) — the owner-side journey over HTTP:
// open → list → answer → dismiss, plus the loud edges (bad why / missing
// question / unregistered path / unknown id / answering a dismissed record).
//
// The owner GATE itself (403 for signed-out / non-owner, before body parse) is
// covered automatically by the route-table sweep in swarmSafety.routes.test.ts —
// these routes mount under /api/swarm/*, so they are swept without any code here.
//
// HOME ISOLATION: OPENGROUND_HOME is pinned to a throwaway tmp dir per test; the
// project path is registered through the real registry (the validateProjectPath
// allowlist), so the 200 paths exercise the same boundary production hits.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'owner@example.com'

let home: string
let project: string
const ENV_KEYS = ['OPENGROUND_HOME', 'OPENGROUND_OWNER_EMAILS', 'OPENGROUND_TESTER_EMAILS'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-escalation-routes-')))
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_OWNER_EMAILS = OWNER
  __resetMigrationCacheForTests()
  // A real folder OUTSIDE the OPENGROUND_HOME, registered via the actual
  // registry so validateProjectPath passes the same way it does in production.
  project = await realpath(await mkdtemp(join(tmpdir(), 'og-escalation-proj-')))
  await mkdir(project, { recursive: true })
  const imported = await addImportedProjectEntry(project)
  if (!('entry' in imported)) throw new Error('test setup: import rejected')
  await writeSession({
    user: { id: 'test-user', email: OWNER, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })
})

afterEach(async () => {
  await clearSession()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    // NEVER unset the home vars: empty means the user's REAL ~/.openground
    // (paths.ts openGroundHome), and vitest reuses workers across files.
    else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
  }
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const openBody = (over: Record<string, unknown> = {}) => ({
  path: project,
  question: 'この配布物に本番キーを埋めますか？',
  context: '公開リポに乗るため不可逆。',
  whyEscalated: 'irreversible',
  taskId: 'card-9',
  ...over,
})

describe('escalations routes — the owner journey', () => {
  it('open → list → answer → (409 on answering after dismiss)', async () => {
    // OPEN
    const openRes = await post('/api/swarm/escalations/open', openBody())
    expect(openRes.status).toBe(200)
    const opened = (await openRes.json()) as EscalationOpenResponse
    expect(opened.deduped).toBe(false)
    expect(opened.escalation.status).toBe('open')

    // Re-OPEN (same receiptKey) → deduped, still one record.
    const dupRes = await post('/api/swarm/escalations/open', openBody())
    expect(((await dupRes.json()) as EscalationOpenResponse).deduped).toBe(true)

    // LIST (project-filtered)
    const listRes = await app.request(
      `/api/swarm/escalations?path=${encodeURIComponent(project)}`,
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as EscalationsResponse
    expect(list.escalations).toHaveLength(1)
    expect(list.escalations[0].id).toBe(opened.escalation.id)

    // ANSWER — no live PTY on record → the card queue path ('queued'), and the
    // real appendJudgment writes the Q→A back to the isolated you-corpus.
    const ansRes = await post('/api/swarm/escalations/answer', {
      id: opened.escalation.id,
      answer: '埋めない。envから注入。',
    })
    expect(ansRes.status).toBe(200)
    const answered = (await ansRes.json()) as EscalationAnswerResponse
    expect(answered.escalation.status).toBe('answered')
    expect(answered.delivery).toBe('queued')
    expect(answered.memoryWritten).toBe(true)

    // A fresh question, dismissed, then answered → 409 (loud, not silent).
    const open2 = (await (
      await post('/api/swarm/escalations/open', openBody({ question: '別の質問？', taskId: 'c2' }))
    ).json()) as EscalationOpenResponse
    const disRes = await post('/api/swarm/escalations/dismiss', { id: open2.escalation.id })
    expect(disRes.status).toBe(200)
    const lateAnswer = await post('/api/swarm/escalations/answer', {
      id: open2.escalation.id,
      answer: 'too late',
    })
    expect(lateAnswer.status).toBe(409)
  })

  it('plainQuestion rides open → list (the owner-facing 平易文); oversize is 400', async () => {
    const plain = '古いデータを消してよいか聞いています。A: 消す（戻せません） B: 残す（容量を使います）'
    const res = await post('/api/swarm/escalations/open', openBody({ plainQuestion: plain }))
    expect(res.status).toBe(200)
    const opened = (await res.json()) as EscalationOpenResponse
    expect(opened.escalation.plainQuestion).toBe(plain)
    const list = (await (
      await app.request(`/api/swarm/escalations?path=${encodeURIComponent(project)}&status=open`)
    ).json()) as EscalationsResponse
    expect(list.escalations[0]?.plainQuestion).toBe(plain)
    // Oversize is refused loudly, mirroring question/context.
    const big = await post(
      '/api/swarm/escalations/open',
      openBody({ taskId: 'c-big', question: '大きい平易文？', plainQuestion: 'あ'.repeat(4 * 1024 + 1) }),
    )
    expect(big.status).toBe(400)
  })

  it('validates loudly: bad why=400, missing question=400, malformed proxyDraft=400', async () => {
    expect((await post('/api/swarm/escalations/open', openBody({ whyEscalated: 'meh' }))).status).toBe(400)
    expect((await post('/api/swarm/escalations/open', openBody({ question: '  ' }))).status).toBe(400)
    expect(
      (
        await post(
          '/api/swarm/escalations/open',
          openBody({ proxyDraft: { answer: 1, confidence: 'huge', isAbstention: 'yes' } }),
        )
      ).status,
    ).toBe(400)
  })

  it('an unregistered path is refused (403) on open AND on the list filter', async () => {
    const stranger = await realpath(await mkdtemp(join(tmpdir(), 'og-escalation-stranger-')))
    try {
      expect((await post('/api/swarm/escalations/open', openBody({ path: stranger }))).status).toBe(403)
      expect(
        (await app.request(`/api/swarm/escalations?path=${encodeURIComponent(stranger)}`)).status,
      ).toBe(403)
    } finally {
      await rm(stranger, { recursive: true, force: true })
    }
  })

  it('unknown ids are 404 on answer and dismiss', async () => {
    expect((await post('/api/swarm/escalations/answer', { id: 'nope', answer: 'x' })).status).toBe(404)
    expect((await post('/api/swarm/escalations/dismiss', { id: 'nope' })).status).toBe(404)
  })
})
