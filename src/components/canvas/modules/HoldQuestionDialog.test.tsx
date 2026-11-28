// @vitest-environment jsdom
//
// Review D-M3 (2026-11-28): when the PRESIDENT's own conversation is the held one,
// the owner was told to answer in the bar's 「あなたへの質問」 — whose only hint was
// "tell the president" — and no screen posted an answer. This dialog is the door
// that needs no president: it posts the same answer route the president uses.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k), lang: 'ja', setLang: () => {}, toggleLang: () => {} }),
}))

import { HoldQuestionDialog } from './HoldQuestionDialog'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const stubAnswer = (status: number, body: unknown) => {
  const posted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    posted.push({ url: _url, body: JSON.parse(String(init?.body ?? '{}')) })
    return { ok: status < 300, status, json: async () => body } as Response
  }))
  return posted
}

describe('answering a held operation from the bar, without the president', () => {
  it('shows each question and offers B only where the question has two options', () => {
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '社長の質問\nA「確認した」: …', twoWay: false }, { id: 'q2', text: 'ワーカーの質問', twoWay: true }]} onAnswered={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/社長の質問/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'A' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'B' })).toHaveLength(1)
  })

  it('A posts the owner\'s answer to the answer route and reports it answered', async () => {
    const posted = stubAnswer(200, {})
    const onAnswered = vi.fn()
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '質問', twoWay: true }]} onAnswered={onAnswered} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith('q1'))
    expect(posted).toEqual([{ url: '/api/swarm/escalations/answer', body: { id: 'q1', answer: 'B' } }])
  })

  it('a refusal shows the server\'s plain reason and keeps the question', async () => {
    stubAnswer(409, { error: '答えを記録できませんでした。質問はそのまま残っています。', code: 'hold' })
    const onAnswered = vi.fn()
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '質問', twoWay: false }]} onAnswered={onAnswered} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect((await screen.findByRole('alert')).textContent).toContain('答えを記録できませんでした')
    expect(onAnswered).not.toHaveBeenCalled()
    expect(screen.getByText('質問')).toBeTruthy()
  })

  // Review R2 S-3: a question the engine had already withdrawn answered with the
  // route's raw English (「escalation was dismissed — reopen it by raising it
  // again」) in a Japanese dialog. Only a refusal written for the owner (`code:
  // 'hold'`) is shown as it is; any other refusal gets the dialog's own sentence.
  it('a refusal not written for the owner never shows its technical text', async () => {
    stubAnswer(409, { error: 'escalation was dismissed — reopen it by raising it again' })
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '質問', twoWay: false }]} onAnswered={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect((await screen.findByRole('alert')).textContent).toBe('projectPanel.swarm.bar.answerFailed')
  })

  // Review R3-ui N1: a question withdrawn meanwhile was shown as a red error with its
  // A / B still pressable. Nothing is wrong and nothing is left to answer.
  it('a question already closed leaves the list like an answered one, with no error', async () => {
    stubAnswer(409, { error: 'この質問はもう閉じられていて、答えは要りません。', code: 'hold', reason: 'closed' })
    const onAnswered = vi.fn()
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '質問', twoWay: false }]} onAnswered={onAnswered} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith('q1'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Review R2 S-8: the title counts every question the chip counted; the ones
  // answered through the president are named, not silently left out.
  it('names the questions it cannot take, and its title counts them too', () => {
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '質問', twoWay: false }]} otherCount={2} onAnswered={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'projectPanel.swarm.bar.questions:{"count":3}' })).toBeTruthy()
    expect(screen.getByText('projectPanel.swarm.bar.otherQuestions:{"count":2}')).toBeTruthy()
  })

  it('each letter is described by its own question', () => {
    render(<HoldQuestionDialog questions={[{ id: 'q1', text: '一つ目', twoWay: false }, { id: 'q2', text: '二つ目', twoWay: true }]} onAnswered={() => {}} onClose={() => {}} />)
    const [a1, a2] = screen.getAllByRole('button', { name: 'A' })
    expect(document.getElementById(a1.getAttribute('aria-describedby') ?? '')?.textContent).toBe('一つ目')
    expect(document.getElementById(a2.getAttribute('aria-describedby') ?? '')?.textContent).toBe('二つ目')
  })
})
