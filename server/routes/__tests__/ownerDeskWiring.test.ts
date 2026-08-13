import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// THE WIRING that makes the owner-desk model-limit watch actually run in
// production — asserted here because, until this file existed, it had NO teeth
// at all.
//
// WHY (commander review, 2026-07-18 round 4). Deleting all four production wiring
// points at once —
//   • server/routes/terminal.ts   `ownerDesk: true` on /api/terminal/claude
//   • server/routes/terminal.ts   `ownerDesk: true` on /api/terminal/custom-module
//   • swarmManager.ts / swarmSupply.ts  `ownerDesk` + `deskLabel`
//   • server/index.ts             the startOwnerDeskLimitLoop() boot call
// — left `npm test` FULLY GREEN (276 files / 5423 passed). Every test the feature
// had drove the pure pass logic through injected seams or set `ownerDesk` on a
// FAKE session, so all of them kept passing over a feature that was no longer
// connected to anything. The watch would have gone silent on the commonest desks
// (Terminal panes, Board 実行) and nothing would have said so.
//
// That is exactly the failure mode terminal.ts's own comment names — a fixture
// that can drift away from the code it claims to pin — reproduced one level up:
// the DETECTOR was pinned to the millimetre while the wire feeding it was not
// pinned at all.
//
// Each assertion below is written so that removing its wiring turns it RED, and
// that was verified by mutation rather than assumed (see the branch's commit for
// the four-way mutation run).

// launchClaude is mocked — no PTY is spawned. The stub builds `info` the way
// claudeTerminal/terminal.ts does (echoing ownerDesk + deskLabel from opts), so
// asserting on the RESPONSE is a real end-to-end statement about what the route
// passed, not a tautology about the stub.
const launchClaude = vi.fn((opts: Record<string, unknown>) => ({
  terminalId: 'pty-x',
  agentSessionId: String(opts.agentSessionId ?? 'sid'),
  info: {
    id: 'pty-x',
    cwd: String(opts.cwd ?? ''),
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date().toISOString(),
    tag: 'claude',
    ...(opts.ownerDesk ? { ownerDesk: true } : {}),
    ...(opts.ownerDesk && opts.deskLabel ? { deskLabel: opts.deskLabel } : {}),
  },
}))

vi.mock('@/lib/server/claudeTerminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/claudeTerminal')>()
  return { ...actual, launchClaude: (opts: Record<string, unknown>) => launchClaude(opts) }
})

vi.mock('@/lib/server/claudeConnection', () => ({
  claudeConnection: async () => ({
    installed: true,
    loggedIn: true,
    plan: null,
    email: null,
    message: 'ok',
  }),
}))

import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { managerLaunchOpts } from '@/lib/server/swarmManager'
import { supplyLaunchOpts } from '@/lib/server/swarmSupply'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-desk-wire-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-desk-wire-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  launchClaude.mockClear()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const registerDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

// ── (a) The routes that open a desk the owner talks to ───────────────────────

describe('owner-desk wiring — the routes', () => {
  it('POST /api/terminal/claude marks the session as an owner desk', async () => {
    const dir = await registerDir('a')
    const res = await app.request('/api/terminal/claude', json({ cwd: dir }))
    expect(res.status).toBe(200)

    // What the route PASSED (pins the `ownerDesk: true` at the call site)…
    expect(launchClaude).toHaveBeenCalledTimes(1)
    expect(launchClaude.mock.calls[0][0]).toMatchObject({ ownerDesk: true })

    // …and what the caller can SEE, which is what listOwnerDeskTerminals filters
    // on. This is the commonest desk there is (Terminal tab / Board 実行) and the
    // one the 2026-07-18 event actually stranded.
    expect((await res.json()).ownerDesk).toBe(true)
  })

  it('POST /api/terminal/claude-login does NOT mark a sign-in terminal as a desk', async () => {
    const dir = await registerDir('b')
    const res = await app.request('/api/terminal/claude-login', json({ cwd: dir }))
    expect(res.status).toBe(200)

    // A bare claude completing OAuth runs no model whose quota could be spent —
    // watching it could only ever produce a "your conversation stopped" toast
    // about a login prompt. The NEGATIVE half of the contract: without it,
    // "mark everything" would satisfy the positive test above.
    expect(launchClaude).toHaveBeenCalledTimes(1)
    expect(launchClaude.mock.calls[0][0].ownerDesk).toBeFalsy()
    expect((await res.json()).ownerDesk).toBeUndefined()
  })
})

// ── (b) The two desks that carry a role name ─────────────────────────────────

describe('owner-desk wiring — the commander and supply desks', () => {
  // These two are the only desks with a `deskLabel`, and the label is what lets
  // one merged bell row say WHICH conversation stopped ("「OG」の司令官・補給官").
  // Dropping either field degrades a real message silently.
  it('managerLaunchOpts opens an owner desk named 司令官', () => {
    expect(managerLaunchOpts('/tmp/p', 'sid', { lang: 'en' })).toMatchObject({
      ownerDesk: true,
      deskLabel: '司令官',
    })
  })

  it('supplyLaunchOpts opens an owner desk named 補給官', () => {
    expect(supplyLaunchOpts('/tmp/p', 'sid', { lang: 'en' })).toMatchObject({
      ownerDesk: true,
      deskLabel: '補給官',
    })
  })
})

// ── (c) The boot call that makes any of it run ───────────────────────────────

describe('owner-desk wiring — the boot loop', () => {
  // Asserted against the SOURCE because that is where the property lives: the
  // entry binds a port and forks, so importing it in a unit test is not on. Same
  // technique the lockdown suite uses for its source-level invariants.
  //
  // EXACTLY ONE call site, checked in both directions:
  //   • zero  ⇒ the watch never starts and every desk goes unwatched — the whole
  //             feature is dead while its own unit tests stay green;
  //   • two   ⇒ two interval timers. The loop is reload-safe (it clears the
  //             previous timer on re-entry), so a duplicate would NOT double-fire
  //             and NOTHING else in the suite would notice.
  const entry = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8')

  it('startOwnerDeskLimitLoop is called exactly once from server/index.ts', () => {
    expect(entry.match(/startOwnerDeskLimitLoop\(/g) ?? []).toHaveLength(1)
  })

  it('…and stays behind its documented kill-switch', () => {
    // The watch reads screens on a timer; the escape hatch has to remain real.
    expect(entry).toContain('OPENGROUND_DESK_LIMIT_WATCH')
  })
})
