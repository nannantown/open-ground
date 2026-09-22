import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DESK_LEDGER_CAP,
  parseDeskLedger,
  appendDeskEntry,
  readDeskLedger,
  readDeskSessionMap,
  recordDeskSession,
} from './swarmDeskLedger'
import { collectUsageBreakdown } from './claudeUsage'
import { recordSwarmSession } from './swarmSessions'
import { addProjectEntry } from './registry'

// Owner card 5a11ac62: tell the commander / supply desks apart from the
// owner's own sessions in the 7-day breakdown. The directory cannot (a desk
// runs in the project's own dir); only a record of "this session id was a
// desk" can. Honesty contract: exact for named ids, silent for the rest.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-desk-ledger-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const entry = (sessionId: string, role: 'manager' | 'supply' = 'manager') => ({
  role,
  sessionId,
  projectPath: '/p',
  at: '2026-09-22T00:00:00.000Z',
})

describe('parseDeskLedger — a corrupt file reads as empty, never throws', () => {
  it('drops malformed rows and keeps the well-formed ones', () => {
    const raw = JSON.stringify({
      entries: [entry('a'), { role: 'overseer', sessionId: 'x' }, { role: 'supply' }, 7, entry('b', 'supply')],
    })
    expect(parseDeskLedger(raw).entries.map((e) => e.sessionId)).toEqual(['a', 'b'])
    expect(parseDeskLedger('not json').entries).toEqual([])
    expect(parseDeskLedger('[1]').entries).toEqual([])
    expect(parseDeskLedger('{"entries":"x"}').entries).toEqual([])
  })
})

describe('appendDeskEntry — idempotent on session id, capped to the newest', () => {
  it('re-recording a resumed desk changes nothing (same object back)', () => {
    const l = { entries: [entry('a')] }
    expect(appendDeskEntry(l, entry('a', 'supply'))).toBe(l)
  })
  it('keeps only the newest `cap` entries', () => {
    let l = { entries: [] as ReturnType<typeof entry>[] }
    for (let i = 0; i < 5; i++) l = appendDeskEntry(l, entry(`s${i}`), 3)
    expect(l.entries.map((e) => e.sessionId)).toEqual(['s2', 's3', 's4'])
    expect(DESK_LEDGER_CAP).toBeGreaterThanOrEqual(500)
  })
})

describe('recordDeskSession / readDeskSessionMap — the file round trip', () => {
  it('records, reads back as id → role, and never throws on an unwritable path', async () => {
    const path = join(dir, 'swarm-desks.json')
    expect(await readDeskSessionMap(path)).toEqual(new Map()) // no file yet
    expect(await recordDeskSession('manager', 'm-1', '/proj', { path })).toBe(true)
    expect(await recordDeskSession('supply', 's-1', '/proj', { path })).toBe(true)
    expect(await recordDeskSession('manager', 'm-1', '/proj', { path })).toBe(true) // resume — no-op
    expect(await readDeskSessionMap(path)).toEqual(new Map([['m-1', 'manager'], ['s-1', 'supply']]))
    expect((await readDeskLedger(path)).entries).toHaveLength(2)
    expect(await recordDeskSession('manager', '   ', '/proj', { path })).toBe(false)
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'file, not dir')
    expect(await recordDeskSession('manager', 'm-2', '/proj', { path: join(blocker, 'x.json') })).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('"m-1"')
  })
})

describe('collectUsageBreakdown — desk sessions leave "your projects"', () => {
  const rec = (ts: number, id: string, usage: Record<string, number>, model: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(ts).toISOString(),
      message: { id, model, usage },
      requestId: `r-${id}`,
    })

  it('a ledger-named session in the project dir is the DESK; an unnamed one stays project', async () => {
    const now = Date.UTC(2026, 8, 22, 12)
    const proj = join(dir, '-Users-k-dev-QRmenu')
    const { mkdirSync } = await import('fs')
    mkdirSync(proj)
    writeFileSync(join(proj, 'desk-m.jsonl'), rec(now - 60_000, 'a', { input_tokens: 100 }, 'claude-opus-5') + '\n')
    writeFileSync(join(proj, 'desk-s.jsonl'), rec(now - 60_000, 'b', { input_tokens: 30 }, 'claude-opus-5') + '\n')
    writeFileSync(join(proj, 'mine.jsonl'), rec(now - 60_000, 'c', { input_tokens: 7 }, 'claude-opus-5') + '\n')
    const b = await collectUsageBreakdown({
      projectsDir: dir,
      days: 1,
      now,
      projectDirs: ['-Users-k-dev-QRmenu'],
      deskSessions: new Map([
        ['desk-m', 'manager'],
        ['desk-s', 'supply'],
      ]),
    })
    expect(b.rows).toEqual([
      { model: 'claude-opus-5', source: 'manager', tokens: 100 },
      { model: 'claude-opus-5', source: 'supply', tokens: 30 },
      { model: 'claude-opus-5', source: 'project', tokens: 7 },
    ])
  })

  it('without a ledger nothing is attributed to a desk — history is never invented', async () => {
    const now = Date.UTC(2026, 8, 22, 12)
    const proj = join(dir, '-Users-k-dev-QRmenu')
    const { mkdirSync } = await import('fs')
    mkdirSync(proj)
    writeFileSync(join(proj, 'desk-m.jsonl'), rec(now - 60_000, 'a', { input_tokens: 100 }, 'claude-opus-5') + '\n')
    const b = await collectUsageBreakdown({ projectsDir: dir, days: 1, now, projectDirs: ['-Users-k-dev-QRmenu'] })
    expect(b.rows).toEqual([{ model: 'claude-opus-5', source: 'project', tokens: 100 }])
  })

  it('a worker worktree session is a worker even if the ledger (wrongly) names it', async () => {
    const now = Date.UTC(2026, 8, 22, 12)
    const wt = join(dir, '-Users-k--openground-projects-abc-worktrees-swarm-300-x')
    const { mkdirSync } = await import('fs')
    mkdirSync(wt)
    writeFileSync(join(wt, 'w.jsonl'), rec(now - 60_000, 'a', { input_tokens: 5 }, 'claude-opus-5') + '\n')
    const b = await collectUsageBreakdown({ projectsDir: dir, days: 1, now, deskSessions: new Map([['w', 'manager']]) })
    expect(b.rows).toEqual([{ model: 'claude-opus-5', source: 'swarm-worker', tokens: 5 }])
  })
})

describe('wiring — a desk launch is recorded in the ledger by recordSwarmSession itself', () => {
  it('manager + supply launches show up in readDeskSessionMap() without any extra call', async () => {
    // The one seam every desk launch passes through (swarmManager.ts /
    // swarmSupply.ts both call recordSwarmSession). If this hook is dropped,
    // desks silently fall back into "your projects" — the exact gap the card
    // names — so it is pinned here, against the real function and the real
    // (test-isolated) home.
    const proj = mkdtempSync(join(tmpdir(), 'og-desk-proj-'))
    try {
      await addProjectEntry(proj)
      await recordSwarmSession(proj, 'manager', 'sid-manager-1')
      await recordSwarmSession(proj, 'supply', 'sid-supply-1')
      await recordSwarmSession(proj, 'manager', 'sid-manager-1') // resume: idempotent
      const map = await readDeskSessionMap()
      expect(map.get('sid-manager-1')).toBe('manager')
      expect(map.get('sid-supply-1')).toBe('supply')
      expect((await readDeskLedger()).entries.filter((e) => e.sessionId === 'sid-manager-1')).toHaveLength(1)
    } finally {
      rmSync(proj, { recursive: true, force: true })
    }
  })
})
