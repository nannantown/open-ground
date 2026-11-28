import { useState } from 'react'
import { Overlay, DialogCard, DialogHeader, DialogBody } from '@/components/ui/overlay'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'

/** One open question about an operation whose result nobody confirmed
 *  (receiptKey `hold:` — savedWorkHold.ts). `twoWay`: the question offers B too
 *  (a worker's card); a desk's question offers only A. */
export interface HoldQuestion { id: string; text: string; twoWay: boolean }

/** The owner answers a held operation's question here, without the president —
 *  the one seat that cannot answer when its own conversation is the held one
 *  (review D-M3, 2026-11-28). It posts the same answer route the president uses;
 *  a refusal written for the owner (`code: 'hold'`) is shown as it is and the
 *  question stays; any other refusal gets this dialog's own sentence (R2 S-3).
 *  `otherCount`: the open questions it cannot take (answered through the
 *  president) — counted in its title and named, so the chip that opened it and
 *  the title agree (R2 S-8). */
export const HoldQuestionDialog = ({ questions, otherCount = 0, onAnswered, onClose }: {
  questions: HoldQuestion[]
  otherCount?: number
  onAnswered: (id: string) => void
  onClose: () => void
}) => {
  const { t } = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null)
  const answer = async (id: string, letter: 'A' | 'B') => {
    if (busy) return
    setBusy(id)
    setRefused(null)
    try {
      const r = await fetch('/api/swarm/escalations/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, answer: letter }),
      })
      if (r.ok) return onAnswered(id)
      const body = (await r.json().catch(() => ({}))) as { error?: string; code?: string; reason?: string }
      // Withdrawn meanwhile (its result turned up): nothing is wrong and nothing is
      // left to answer, so it leaves the list like an answered one (R3-ui N1).
      if (body.code === 'hold' && body.reason === 'closed') return onAnswered(id)
      setRefused({ id, text: (body.code === 'hold' && body.error) || t('projectPanel.swarm.bar.answerFailed') })
    } catch {
      setRefused({ id, text: t('projectPanel.swarm.bar.answerFailed') })
    } finally {
      setBusy(null)
    }
  }
  const title = t('projectPanel.swarm.bar.questions', { count: questions.length + otherCount })
  return (
    <Overlay onClose={onClose} aria-label={title}>
      <DialogCard className="flex max-h-[82vh] w-[560px] max-w-[94vw] flex-col" ariaLabel={title}>
        <DialogHeader title={title} onClose={onClose} closeLabel={t('common.close')} />
        <DialogBody className="flex flex-col gap-5 px-6 py-4">
          {questions.map((q) => (
            <section key={q.id} className="flex flex-col gap-2.5">
              <p id={`hold-q-${q.id}`} className="whitespace-pre-line text-ui leading-relaxed text-ink">{q.text}</p>
              <div className="flex gap-2">
                {(q.twoWay ? (['A', 'B'] as const) : (['A'] as const)).map((letter) => (
                  <Btn key={letter} variant="ghost" size="sm" disabled={!!busy} aria-describedby={`hold-q-${q.id}`} onClick={() => void answer(q.id, letter)}>
                    {letter}
                  </Btn>
                ))}
              </div>
              {refused?.id === q.id && <p role="alert" className="text-meta text-accent">{refused.text}</p>}
            </section>
          ))}
          {otherCount > 0 && <p className="text-meta text-ink-muted">{t('projectPanel.swarm.bar.otherQuestions', { count: otherCount })}</p>}
        </DialogBody>
      </DialogCard>
    </Overlay>
  )
}
