// PersonaTellApartCard — three lines, one of which is not his.
//
// It rides at the top of the list screen because that is where his own words
// are: the answer to 「これは本当に自分のことか」 is one scroll below the question.
//
// ⚠ IT SHOWS A RESULT, NEVER A SCORE. Getting one wrong does not make a line
// false — it means the line reads like something anyone would say, which is a
// fact about the sentence and has its own remedy (直す / 取り消す, both already on
// that line's own card). Nothing here is written to the corpus in either
// direction; see src/lib/server/personaTellApart.ts.

import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type { PersonaTellApartCheck, PersonaTellApartResult } from '@/lib/types'

export interface PersonaTellApartCardProps {
  check: PersonaTellApartCheck
  /** Set once he has answered. The card then STOPS being a question. */
  result: PersonaTellApartResult | null
  busy: boolean
  failed: boolean
  onAnswer: (optionId: string) => void
  onSkip: () => void
  onDone: () => void
}

export const PersonaTellApartCard = ({
  check,
  result,
  busy,
  failed,
  onAnswer,
  onSkip,
  onDone,
}: PersonaTellApartCardProps): JSX.Element => {
  const { t } = useT()

  if (result) {
    return (
      <section
        aria-label={t('persona.tellApart.heading')}
        className="flex flex-col gap-2 border-b border-line py-3.5"
      >
        <span className="label-cap text-ink-faint">{t('persona.tellApart.heading')}</span>
        <p className="text-ui leading-relaxed text-ink">
          {result.correct ? t('persona.tellApart.right') : t('persona.tellApart.wrong')}
        </p>
        {/* ⚠ THE MISTAKEN LINE IS QUOTED BACK. "You got it wrong" with no line
         *  attached is a grade; the line is the only part he can act on. */}
        {!result.correct && result.mistookText && (
          <p className="border-l-2 border-ochre pl-3 text-meta leading-relaxed text-ink-muted">
            {result.mistookText}
          </p>
        )}
        <p className="text-meta leading-relaxed text-ink-faint">
          {t('persona.tellApart.stranger')}
        </p>
        <p className="border-l-2 border-line-strong pl-3 text-meta leading-relaxed text-ink-muted">
          {result.strangerText}
        </p>
        {!result.correct && (
          <p className="text-meta leading-relaxed text-ink-faint">
            {t('persona.tellApart.wrongHint')}
          </p>
        )}
        <div className="flex pt-1">
          <Btn variant="subtle" size="xs" onClick={onDone}>
            {t('persona.node.close')}
          </Btn>
        </div>
      </section>
    )
  }

  return (
    <section
      aria-label={t('persona.tellApart.heading')}
      className="flex flex-col gap-2 border-b border-line py-3.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="label-cap text-ink-faint">{t('persona.tellApart.heading')}</span>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="text-meta text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
        >
          {t('persona.tellApart.later')}
        </button>
      </div>
      <p className="text-meta leading-relaxed text-ink-muted">{t('persona.tellApart.lead')}</p>
      <ul className="flex flex-col gap-1.5">
        {check.options.map((o) => (
          <li key={o.id}>
            {/* Three equal rows, in the order the server drew them. No numbering
             *  and no letters: a label is a handle, and a handle is one more
             *  thing to read on a question that is already three sentences. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => onAnswer(o.id)}
              className="w-full rounded-[2px] border border-line px-3 py-2 text-left text-meta leading-relaxed text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {o.text}
            </button>
          </li>
        ))}
      </ul>
      {failed && <p className="text-meta text-accent">{t('persona.tellApart.failed')}</p>}
    </section>
  )
}
