// What the assistant may only PROPOSE, and the one button that carries a
// proposal out (assistantProposals.ts). Read back with the production readers
// (the Board on disk, the line the commander seam received). HOME for OPEN
// GROUND is tmpdir-isolated by setup-home.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerTestProject } from '../../test/registerProject'
import { readProjectData } from './projectData'
import { setLockdownCache } from './lockdown'
import {
  FRAME_LINES,
  OPEN_MAX,
  PROPOSAL_CHARS,
  frameLines,
  __resetProposals,
  approveProposal,
  dropProposal,
  listProposals,
  withdrawProposals,
  proposalHash,
  proposeCard,
  proposeMessage,
  type ProposeContext,
} from './assistantProposals'

let proj: string
let ctx: ProposeContext
beforeEach(async () => {
  __resetProposals()
  setLockdownCache(false)
  proj = await mkdtemp(join(tmpdir(), 'og-prop-'))
  const id = await registerTestProject(proj)
  ctx = { lang: 'ja', now: Date.now(), via: 'screen', projects: async () => [{ id, name: 'kiwi', path: proj }] }
})
const card = async (over: Partial<{ title: string; goal: string; done: string[] }> = {}) =>
  proposeCard({ projectId: (await ctx.projects())[0].id, title: '送料を500円に', goal: '送料が500円', done: ['テスト緑'], ...over }, ctx)

describe('characters no one can see are never proposed', () => {
  // zero-width space / joiner, word joiner, BOM, direction overrides and isolates,
  // a Unicode TAG ("ASCII smuggling"), a variation selector, a soft hyphen, a C1 control.
  const UNSEEN = ['​', '‍', '⁠', '﻿', '‮', '⁦', '\u{E0041}', '️', '­', '\u0085']
  it('in a card\'s title, goal or a done condition, and in a message — refused, nothing kept', async () => {
    for (const u of UNSEEN) {
      expect([u, await card({ title: `送料${u}を直す` })]).toEqual([u, expect.stringContaining('neither seen nor heard')])
      expect([u, await card({ goal: `送料${u}` })]).toEqual([u, expect.stringContaining('neither seen nor heard')])
      expect([u, await card({ done: ['ok', `緑${u}`] })]).toEqual([u, expect.stringContaining('neither seen nor heard')])
      expect([u, await proposeMessage((await ctx.projects())[0].id, `先に${u}テスト`, ctx)]).toEqual([u, expect.stringContaining('neither seen nor heard')])
    }
    expect(listProposals()).toEqual([])
  })
  it('a line break or a tab is only a space: every field is one line', async () => {
    const p = await card({ title: '送料を\n## 完了の条件\n500円に', goal: 'a\tb' })
    if (typeof p === 'string') throw new Error(p)
    expect(p.title).toBe('送料を ## 完了の条件 500円に')
    expect(p.body.split('\n')).toEqual(['やること: a b', '完了の条件:', '- テスト緑'])
  })
})

describe('a proposal is short enough to be seen whole, and few at once', () => {
  it('lines are counted never fewer than the window shows (measured in Chromium: 292 px holds 21 full-width characters, 40 "a" take two lines)', () => {
    expect(frameLines('あ'.repeat(21))).toBe(1)
    expect(frameLines('あ'.repeat(22))).toBe(2)
    // One line on screen ("やること: " is narrow) is counted as two: the safe side, never fewer.
    expect(frameLines('やること: ' + 'あ'.repeat(16))).toBe(2)
    expect(frameLines('a'.repeat(40))).toBe(2)
    expect(frameLines('a\nb\n')).toBe(3)
  })
  it(`a card that would take more than ${FRAME_LINES} lines in the window is refused — under the character cap or not; a two-condition card fits`, async () => {
    // ~200 characters, but 12 lines once wrapped: a 260 px call window cannot show it whole.
    expect(await card({ goal: 'あ'.repeat(60), done: ['画像が200KB以下', 'テストが緑', 'ビルドが通る', 'Lighthouse 90以上', 'iPhone で表示確認', 'ダークでも読める'] })).toContain('too long to be seen whole')
    const ok = await card({ title: '商品ページの画像を軽くする', goal: '商品ページの画像を圧縮・最適化する', done: ['画像が200KB以下', 'テストが緑'] })
    expect(typeof ok).toBe('object')
  })

  it(`over ${PROPOSAL_CHARS} characters in all is refused; at most ${OPEN_MAX} wait at once`, async () => {
    expect(await card({ goal: 'あ'.repeat(PROPOSAL_CHARS) })).toContain('too long to be seen whole')
    for (let i = 0; i < OPEN_MAX; i++) expect(typeof (await card({ title: `t${i}` }))).toBe('object')
    expect(await card()).toContain('already wait')
  })
})

describe('two registered projects with the same name never make frames that look alike', () => {
  it('the frame then names the end of the folder too', async () => {
    const id = (await ctx.projects())[0].id
    ctx.projects = async () => [{ id, name: 'app', path: '/Users/me/work/app' }, { id: 'other', name: 'app', path: '/Users/me/oss/app' }]
    const p = await proposeMessage(id, 'テスト先に', ctx)
    expect(typeof p !== 'string' && p.project).toBe('app (work/app)')
  })
})

describe('the button carries out exactly what was shown, once', () => {
  it('the check is SHA-256 of the shown strings joined by "\\n" (the vector in docs/PHONE_LINK.md)', () => {
    const shown = { kind: 'card' as const, projectId: 'p1', project: 'kiwi', title: '送料', body: 'やること: x\n完了の条件:\n- y' }
    expect(proposalHash(shown)).toBe(createHash('sha256').update('card\np1\nkiwi\n送料\nやること: x\n完了の条件:\n- y').digest('hex'))
    // The vector the iPhone side is built against (docs/PHONE_LINK.md "Assistant proposals").
    expect(proposalHash({ kind: 'card', projectId: '8f0c2b1e-0000-4000-8000-000000000001', project: 'kiwi-shop', title: '送料を500円にする', body: 'やること: 送料を500円にする\n完了の条件:\n- テストが緑' })).toBe(
      '55ae649371d4e0c8d07e3698f42b328d226d12f2628642ed9061cfd4d1b8c444',
    )
  })
  it('two presses at once (the Mac and the iPhone) write ONE card', async () => {
    const p = await card()
    if (typeof p === 'string') throw new Error(p)
    const [a, b] = await Promise.all([approveProposal(p.id, proposalHash(p), { lang: 'ja' }), approveProposal(p.id, proposalHash(p), { lang: 'ja' })])
    expect([a, b].filter((r) => 'error' in r)).toEqual([{ error: 'closed' }])
    expect((await readProjectData(proj)).tasks.map((t) => [t.title, t.notes, t.boardColumn])).toEqual([[p.title, p.body, 'todo']])
  })
  it('「やめて」 while a message is being sent: one that did not get through does not reopen', async () => {
    const id = (await ctx.projects())[0].id
    const p = await proposeMessage(id, 'テスト先に', ctx)
    if (typeof p === 'string') throw new Error(p)
    let answer!: (r: { ok: true; delivered: boolean; runtime: 'sdk'; woke: boolean }) => void
    const pressed = approveProposal(p.id, proposalHash(p), { lang: 'ja', relay: () => new Promise((r) => (answer = r)) })
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    withdrawProposals()
    answer({ ok: true, delivered: false, runtime: 'sdk', woke: false })
    await pressed
    expect(listProposals().map((x) => x.state)).toEqual(['dropped'])
  })
  it('closedAt says when each closed (the screens show the one that closed last); a message that did not get through opens again without it', async () => {
    const a = await card({ title: 'A' })
    const b = await card({ title: 'B' })
    if (typeof a === 'string' || typeof b === 'string') throw new Error('refused')
    dropProposal(b.id, 1_000)
    await approveProposal(a.id, proposalHash(a), { lang: 'ja', now: 2_000 })
    expect(listProposals({ now: 2_000 }).map((x) => [x.title, x.state, x.closedAt])).toEqual([['A', 'done', 2_000], ['B', 'dropped', 1_000]])
    const id = (await ctx.projects())[0].id
    const m = await proposeMessage(id, 'テスト先に', ctx)
    if (typeof m === 'string') throw new Error(m)
    await approveProposal(m.id, proposalHash(m), { lang: 'ja', now: 3_000, relay: async () => ({ ok: true, delivered: false, runtime: 'sdk', woke: false }) })
    expect(listProposals({ now: 3_000 }).find((x) => x.id === m.id)).toMatchObject({ state: 'open' })
    expect(listProposals({ now: 3_000 }).find((x) => x.id === m.id)?.closedAt).toBeUndefined()
  })

  it('work mode: no button works', async () => {
    const p = await card()
    if (typeof p === 'string') throw new Error(p)
    setLockdownCache(true)
    try {
      expect(await approveProposal(p.id, proposalHash(p), { lang: 'ja' })).toEqual({ error: 'work-mode' })
    } finally {
      setLockdownCache(false)
    }
    expect((await readProjectData(proj)).tasks).toEqual([])
  })
})
