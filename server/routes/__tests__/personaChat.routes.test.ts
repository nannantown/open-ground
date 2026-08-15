import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// The persona CONVERSATION over HTTP. These routes spawn `claude` and write to
// the owner's corpus, so they carry TWO gates the sibling course routes do not
// need, and both are measured here rather than reviewed:
//
//   • blockNonLoopback — the DNS-rebinding half. The thread is the owner's own
//     words about themselves; a rebinding page's GET is same-origin, so the
//     app-level CSRF guard (mutations only) does not cover it.
//   • the persona EXPERIMENT — owner-ANDed server-side. Closed ⇒ 403 and NOTHING
//     spawns.
//   • claudeRunPreflight on both spawning routes — a missing / signed-out CLI is
//     a 503 the screen can explain, checked BEFORE anything launches.
//
// The launcher is faked through the module's own test seam, so no test in this
// file can spawn a real `claude`; every assertion below also checks that the
// fake was NOT called on the refusal paths — "returned 403" alone would pass
// against a route that answered 403 after launching.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  personaOpen: true,
  preflight: { ok: true } as
    | { ok: true }
    | { ok: false; body: { error: string; claudeMissing: true } }
    | { ok: false; body: { error: string; claudeLoggedOut: true } },
}))

vi.mock('@/lib/server/experiments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/experiments')>()),
  isExperimentEnabled: async (id: string) => id === 'persona' && h.personaOpen,
}))

vi.mock('@/lib/server/claudePreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/claudePreflight')>()),
  claudeRunPreflight: async () => h.preflight,
}))

// Plain static imports: vitest hoists the vi.mock calls above every import in
// this file, so the mocks are already installed when the app's module graph
// loads. (A dynamic import here would need top-level await, which this
// tsconfig's module target rejects.)
import { app } from '../../app'
import {
  PERSONA_END,
  PERSONA_KEPT_MARKER,
  PERSONA_REPLY_MARKER,
  endPersonaConversation,
  _resetPersonaChatForTest,
  _setPersonaChatDepsForTest,
  type PersonaTurnArgs,
} from '@/lib/server/personaChat'
import {
  shaOfBytes,
  _resetPersonaImportForTest,
  _setPersonaImportDepsForTest,
} from '@/lib/server/personaImport'
import { readManualJudgments } from '@/lib/server/youCorpus'

let home: string
const ENV_KEYS = [
  'OPENGROUND_HOME',
  'OPENGROUND_MEMORY_DIR',
  'OPENGROUND_CONCEPT_PATH',
  'HOME',
] as const
let savedEnv: Record<string, string | undefined> = {}

/** Every call the fake launcher saw. Empty is the assertion on refusal paths. */
let launches: PersonaTurnArgs[] = []

const output = (...lines: string[]): string => ['TUI noise', ...lines].join('\n')
const kept = (region: string, text: string): string =>
  `${PERSONA_KEPT_MARKER} ${region}|${text} ${PERSONA_END}`
const reply = (text: string): string => `${PERSONA_REPLY_MARKER} ${text} ${PERSONA_END}`

const useFakeRunner = (raw: string): void => {
  const runTurn = async (args: PersonaTurnArgs) => {
    launches.push(args)
    return { raw }
  }
  _setPersonaChatDepsForTest({ runTurn })
  _setPersonaImportDepsForTest({ runTurn })
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-chat-routes-')))
  const memDir = join(home, 'fixture-memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(
    join(memDir, 'project_notes.md'),
    '---\nname: project_notes\ndescription: fixture\nmetadata: \n  type: project\n---\n\nfixture body\n',
  )
  const conceptPath = join(home, 'fixture-CONCEPT.md')
  await writeFile(conceptPath, '# fixture concept\n')
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
  process.env.HOME = home
  h.personaOpen = true
  h.preflight = { ok: true }
  launches = []
  _resetPersonaChatForTest()
  _resetPersonaImportForTest()
  useFakeRunner(output(kept('legs', '決めたあとに止まる'), reply('どのあたりが重いですか。')))
})

afterEach(async () => {
  await endPersonaConversation()
  _resetPersonaChatForTest()
  _resetPersonaImportForTest()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else if (k === 'OPENGROUND_HOME') process.env[k] = home
    else process.env[k] = ''
  }
  await rm(home, { recursive: true, force: true })
})

const post = (path: string, body: unknown, init: RequestInit = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  })

const settleTurn = async (turnId: string): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 200; i++) {
    const res = await app.request(`/api/persona/chat/turn/${turnId}`)
    const body = (await res.json()) as Record<string, unknown>
    if (body.state !== 'running') return body
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('turn never settled')
}

// ── the gates ───────────────────────────────────────────────────────────────

describe('the persona chat gates', () => {
  it('rejects a non-loopback Host on the READ — the thread never leaves', async () => {
    const started = await post('/api/persona/chat', { text: '秘密のはなし' })
    expect(started.status).toBe(202)
    const { turnId } = (await started.json()) as { turnId: string }
    await settleTurn(turnId)

    const res = await app.request('/api/persona/chat', { headers: { host: 'evil.example.com' } })
    // THE LEAK FIRST: when the gate is gone the status assertion would fail
    // before anything looked at what actually crossed the wire.
    const text = await res.text()
    expect(text).not.toContain('秘密のはなし')
    expect(res.status).toBe(403)
  })

  it('rejects a cross-origin read', async () => {
    const res = await app.request('/api/persona/chat', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('is CLOSED unless the persona experiment is open — and spawns nothing', async () => {
    h.personaOpen = false
    expect((await app.request('/api/persona/chat')).status).toBe(403)
    expect((await post('/api/persona/chat', { text: 'hi' })).status).toBe(403)
    expect((await app.request('/api/persona/chat/turn/whatever')).status).toBe(403)
    expect((await post('/api/persona/chat/cancel', { turnId: 'x' })).status).toBe(403)
    expect((await post('/api/persona/import', { json: [], fileSha: shaOfBytes('x') })).status).toBe(
      403,
    )
    expect((await app.request('/api/persona/import/whatever')).status).toBe(403)
    expect(launches).toHaveLength(0)
  })

  it('answers 503 when the CLI is signed out — BEFORE anything spawns', async () => {
    h.preflight = { ok: false, body: { error: 'not signed in', claudeLoggedOut: true } }
    const res = await post('/api/persona/chat', { text: 'こんにちは' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not signed in', claudeLoggedOut: true })
    expect(launches).toHaveLength(0)
    // …and nothing was written either.
    expect(await readManualJudgments()).toEqual([])
  })

  it('answers 503 when the CLI is missing — import too', async () => {
    h.preflight = { ok: false, body: { error: 'not installed', claudeMissing: true } }
    const res = await post('/api/persona/import', { json: [], fileSha: shaOfBytes('x') })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not installed', claudeMissing: true })
    expect(launches).toHaveLength(0)
  })
})

// ── the conversation ────────────────────────────────────────────────────────

describe('POST /api/persona/chat', () => {
  it('202s with a turn id, then the poll carries the reply AND what it kept', async () => {
    const started = await post('/api/persona/chat', { text: '最近、仕事で消耗してる' })
    expect(started.status).toBe(202)
    const { turnId } = (await started.json()) as { turnId: string }

    const turn = await settleTurn(turnId)
    expect(turn.state).toBe('done')
    expect(turn.reply).toBe('どのあたりが重いですか。')
    const keptWrites = turn.kept as { judgment: { id: string; text: string }; region: string }[]
    expect(keptWrites).toHaveLength(1)
    expect(keptWrites[0].region).toBe('legs')

    // Read back through the PRODUCTION corpus reader — a 202 proves nothing
    // about what landed.
    const stored = await readManualJudgments()
    expect(stored.map((j) => j.text)).toEqual(['決めたあとに止まる'])
    expect(keptWrites[0].judgment.id).toBe(stored[0].id)
    // The stand-in's reply is NOT in the corpus.
    expect(JSON.stringify(stored)).not.toContain('どのあたりが重いですか。')

    // …and the thread is readable again after the fact.
    const state = (await (await app.request('/api/persona/chat')).json()) as {
      turns: { text: string }[]
      live: boolean
    }
    expect(state.live).toBe(false)
    expect(state.turns.map((t) => t.text)).toEqual(['最近、仕事で消耗してる'])
  })

  it('409s a second turn while one is in flight — one conversation, period', async () => {
    _setPersonaChatDepsForTest({
      runTurn: async (args) => {
        launches.push(args)
        return new Promise(() => {}) as Promise<{ raw: string }>
      },
    })
    expect((await post('/api/persona/chat', { text: 'ひとつめ' })).status).toBe(202)
    const second = await post('/api/persona/chat', { text: 'ふたつめ' })
    expect(second.status).toBe(409)
    expect((await second.json()) as { busy: boolean }).toMatchObject({ busy: true })
    // Waiting for the first launch to actually reach the seam before counting.
    for (let i = 0; i < 50 && launches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(launches).toHaveLength(1)
  })

  it('400s an empty message rather than burning a session on nothing', async () => {
    expect((await post('/api/persona/chat', { text: '   ' })).status).toBe(400)
    expect(launches).toHaveLength(0)
  })

  it('404s a turn id this server does not hold', async () => {
    expect((await app.request('/api/persona/chat/turn/nope')).status).toBe(404)
  })

  it('cancels a turn in flight', async () => {
    _setPersonaChatDepsForTest({
      runTurn: (args) =>
        new Promise((_res, rej) => {
          launches.push(args)
          args.signal?.addEventListener('abort', () => rej(new Error('cancelled')), { once: true })
        }),
    })
    const { turnId } = (await (await post('/api/persona/chat', { text: 'やめる' })).json()) as {
      turnId: string
    }
    for (let i = 0; i < 50 && launches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const res = await post('/api/persona/chat/cancel', { turnId })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cancelled: true })
    expect((await settleTurn(turnId)).state).toBe('failed')
  })
})

// ── the import ──────────────────────────────────────────────────────────────

const exportJson = (n: number): unknown[] => [
  {
    uuid: 'c1',
    name: '会話',
    chat_messages: Array.from({ length: n }, (_, i) => ({
      sender: 'human',
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      text: `owner message ${i} — long enough to survive the minimum`,
    })),
  },
]

describe('POST /api/persona/import', () => {
  it('202s, then the job reports every count including the ones that are losses', async () => {
    useFakeRunner(output(kept('head', '迷ったら一晩おく'), reply('読み終えました。')))
    const res = await post('/api/persona/import', {
      json: exportJson(7),
      fileSha: shaOfBytes('export-a'),
    })
    expect(res.status).toBe(202)
    const { importId } = (await res.json()) as { importId: string }

    let body: Record<string, unknown> = {}
    for (let i = 0; i < 400; i++) {
      body = (await (await app.request(`/api/persona/import/${importId}`)).json()) as Record<
        string,
        unknown
      >
      if (body.state !== 'running') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(body.state).toBe('done')
    expect(body.result).toMatchObject({
      conversations: 1,
      ownerMessages: 7,
      unreadable: 0,
      considered: 7,
      notConsidered: 0,
      duplicatesSkipped: 0,
    })
    expect((await readManualJudgments()).map((j) => j.text)).toEqual(['迷ったら一晩おく'])
  })

  it('409s the same file a second time — the corpus is not doubled', async () => {
    useFakeRunner(output(kept('head', '一晩おく'), reply('読み終えました。')))
    const first = await post('/api/persona/import', {
      json: exportJson(3),
      fileSha: shaOfBytes('export-b'),
    })
    const { importId } = (await first.json()) as { importId: string }
    for (let i = 0; i < 400; i++) {
      const b = (await (await app.request(`/api/persona/import/${importId}`)).json()) as {
        state: string
      }
      if (b.state !== 'running') break
      await new Promise((r) => setTimeout(r, 5))
    }
    const before = (await readManualJudgments()).length
    expect(before).toBe(1)

    const second = await post('/api/persona/import', {
      json: exportJson(3),
      fileSha: shaOfBytes('export-b'),
    })
    expect(second.status).toBe(409)
    expect((await second.json()) as { alreadyImported: boolean }).toMatchObject({
      alreadyImported: true,
    })
    expect((await readManualJudgments()).length).toBe(before)
  })

  it('400s a file that is not an export — and reports no counts at all', async () => {
    const res = await post('/api/persona/import', {
      json: { not: 'an array' },
      fileSha: shaOfBytes('export-c'),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.unreadableFile).toBe(true)
    expect(body.conversations).toBeUndefined()
    expect(launches).toHaveLength(0)
  })
})
