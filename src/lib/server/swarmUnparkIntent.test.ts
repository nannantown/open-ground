import { describe, it, expect, vi } from 'vitest'
import { readUnparkIntent, recordEscalationAnswerForNextDispatch } from './swarmOrchestrator'
import type { ProjectTask } from '@/lib/types'

// ─── both halves of the SAME menu must work ──────────────────────────────────
//
// The overseer asks about a stuck card with a two-option menu it wrote itself:
//   A: 順番待ちの列に戻して、作業を再開させる
//   B: このまま保留にしておく（勝手に動かすことはありません）
// The unpark is the ONLY engine route out of 'blocked', so:
//   • gating it on nothing        → answering B MOVED the card (cycle 3)
//   • gating it on "a worker asked" → answering A did NOTHING (cycle 4),
//     while the UI promised 「次回 dispatch に同梱されます」
// Both are silent, both are the owner being disobeyed by their own answer. The
// discriminator is therefore the CHOICE, with "who asked" kept only as the
// tie-breaker for free text.
//
// The labels below are the shipped ones (swarmOverseer's plainQuestion
// templates) — including 「A: このまま任せる」, which is why the option LETTER is
// read before any keyword: a resume-shaped choice can contain a hold-shaped
// phrase.

const card = (id: string, column: string): ProjectTask =>
  ({ id, title: `card ${id}`, boardColumn: column }) as unknown as ProjectTask

describe('readUnparkIntent', () => {
  it('reads the option letter of the shipped S5 menu', () => {
    expect(readUnparkIntent('A: 順番待ちの列に戻して、作業を再開させる')).toBe('resume')
    expect(readUnparkIntent('B: このまま保留にしておく（勝手に動かすことはありません）')).toBe('hold')
  })

  it('reads a bare letter, and the full-width forms an IME produces', () => {
    expect(readUnparkIntent('A')).toBe('resume')
    expect(readUnparkIntent('b')).toBe('hold')
    expect(readUnparkIntent('Ａ：戻して')).toBe('resume')
    expect(readUnparkIntent('Ｂ．このまま')).toBe('hold')
  })

  it('the LETTER wins over a keyword inside the label (A: このまま任せる)', () => {
    // The shipped S3 label. A keyword-first reader would call this 'hold'.
    expect(readUnparkIntent('A: このまま任せる（担当が中身を確認して取り込みます）')).toBe('resume')
  })

  it('falls back to keywords for free text', () => {
    expect(readUnparkIntent('もう一度やってみて')).toBe('resume')
    expect(readUnparkIntent('とりあえずこのまま保留で')).toBe('hold')
    expect(readUnparkIntent('依存は解けたので todo へ戻して')).toBe('resume')
  })

  it('unreadable text is "unstated" — never a guess', () => {
    expect(readUnparkIntent('')).toBe('unstated')
    expect(readUnparkIntent('ありがとう')).toBe('unstated')
  })
})

describe('recordEscalationAnswerForNextDispatch — choice over asker', () => {
  const run = (answer: string, workerAddressed: boolean, unpark: () => Promise<boolean>) =>
    recordEscalationAnswerForNextDispatch(
      `/tmp/og-intent-${Math.random().toString(36).slice(2)}`,
      't1',
      answer,
      { workerAddressed },
      { fetchTasks: async () => [card('t1', 'blocked')], unpark },
    )

  it('A unparks even though NO worker asked (the overseer raise — cycle-4 must-fix)', async () => {
    const unpark = vi.fn(async () => true)
    await run('A: 順番待ちの列に戻して、作業を再開させる', false, unpark)
    expect(unpark).toHaveBeenCalledTimes(1)
  })

  it('B never unparks, even when a worker DID ask (cycle-3 must-fix, still closed)', async () => {
    const unpark = vi.fn(async () => true)
    await run('B: このまま保留にしておく', true, unpark)
    expect(unpark).not.toHaveBeenCalled()
  })

  it('free text falls back to the worker rule (asked ⇒ resume, nobody ⇒ leave)', async () => {
    const asked = vi.fn(async () => true)
    await run('ありがとう、判断はまかせます', true, asked)
    expect(asked).toHaveBeenCalledTimes(1)
    const nobody = vi.fn(async () => true)
    await run('ありがとう、判断はまかせます', false, nobody)
    expect(nobody).not.toHaveBeenCalled()
  })
})
