import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { recordDecision, LEDGER_RECENT_LIMIT } from '@/lib/server/personaLedger'
import { personaLedgerFile } from '@/lib/server/paths'
import type { PersonaLedgerResponse } from '@/lib/types'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/persona/ledger — the DECISION LEDGER over HTTP: the counts the screen
// reads ("this week it answered 3 and asked you 2") plus the newest entries.
//
// Written through the PRODUCTION writer (recordDecision) and read over the wire,
// never by hand-building a response — a 200 proves nothing about what landed.
//
// The two properties that are NOT about content:
//   • LOOPBACK-ONLY. `recent` carries free text from the owner's own local work,
//     so the DNS-rebinding gate is a privacy boundary here, not a formality.
//   • FAIL-OPEN. An unreadable ledger is zeros, never a 500 on a read-only screen.
// ─────────────────────────────────────────────────────────────────────────────

let home: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-ledger-routes-')))
  process.env.OPENGROUND_HOME = home
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // NEVER unset — an empty OPENGROUND_HOME resolves to the real ~/.openground.
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

const get = async (init?: RequestInit) => {
  const res = await app.request('/api/persona/ledger', init)
  return { res, body: (await res.json()) as PersonaLedgerResponse }
}

describe('GET /api/persona/ledger', () => {
  it('answers with zeros before the stand-in has decided anything', async () => {
    const { res, body } = await get()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      summary: {
        week: { answered: 0, asked: 0, abstained: 0 },
        total: { answered: 0, asked: 0, abstained: 0 },
        lastAt: null,
      },
      recent: [],
    })
  })

  it('reports what the stand-in did — counts + newest-first entries', async () => {
    for (const verdict of ['answered', 'answered', 'answered', 'asked', 'asked', 'abstained'] as const) {
      await recordDecision({ projectPath: '/proj', verdict, question: `${verdict} の質問` })
    }

    const { res, body } = await get()
    expect(res.status).toBe(200)
    // The sentence the owner asked for.
    expect(body.summary.week).toEqual({ answered: 3, asked: 2, abstained: 1 })
    expect(body.summary.total).toEqual({ answered: 3, asked: 2, abstained: 1 })
    expect(body.recent).toHaveLength(6)
    // Newest first, and the free text rode the wire intact (loopback-only, above).
    expect(body.recent[0].verdict).toBe('abstained')
    expect(body.recent[0].question).toBe('abstained の質問')
    expect(body.summary.lastAt).toBe(body.recent[0].at)
  })

  it(`returns at most ${LEDGER_RECENT_LIMIT} recent entries while the counts stay complete`, async () => {
    const n = LEDGER_RECENT_LIMIT + 7
    for (let i = 0; i < n; i++) {
      await recordDecision({ projectPath: '/proj', verdict: 'asked', question: `q${i}`, id: `row-${i}` })
    }
    const { body } = await get()
    expect(body.recent).toHaveLength(LEDGER_RECENT_LIMIT)
    expect(body.recent[0].id).toBe(`row-${n - 1}`)
    expect(body.summary.total.asked).toBe(n) // the counts see the whole ledger
  })

  it('still answers over a CORRUPT ledger (fail-open, not a 500)', async () => {
    await writeFile(personaLedgerFile(), 'not json at all')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { res, body } = await get()
      expect(res.status).toBe(200)
      expect(body.recent).toEqual([])
      expect(body.summary.total).toEqual({ answered: 0, asked: 0, abstained: 0 })
      expect(body.summary.lastAt).toBeNull()
    } finally {
      err.mockRestore()
    }
  })

  it('rejects a non-loopback Host (DNS-rebinding gate) — no free text leaves', async () => {
    await recordDecision({ projectPath: '/proj', verdict: 'asked', question: '秘密の質問' })
    const res = await app.request('/api/persona/ledger', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('秘密の質問')
  })

  it('rejects a cross-origin read', async () => {
    const res = await app.request('/api/persona/ledger', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })
})
