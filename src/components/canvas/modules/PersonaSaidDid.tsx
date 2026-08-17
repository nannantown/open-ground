// PersonaSaidDid — 「答えたことと、そのときの状況」, read as a deposition, not a table.
//
// WHAT THE SCREEN IS FOR. Every other surface here shows what has been recorded
// ABOUT the owner. This one is the only place where his own account of himself
// sits beside the record it was made against — and that pairing is the one thing
// no other self-analysis tool can show, because none of them has the owner's
// actual work log to put next to the questionnaire.
//
// ⚠ IT COMPARES NOTHING AND CONCLUDES NOTHING. No 「一致しています」, no percentage,
// no streak. Whether 「差し戻しは2回まで」 and a card that came back three times is
// a broken rule, a changed rule, an exception, or a badly-kept record cannot be
// told apart from this data — so a product that ruled on it would be wrong a
// fixed fraction of the time, and the owner would stop answering honestly, which
// starves the corpus this whole feature runs on. Two texts, dated, side by side.
// The reading is his.
//
// ⚠ THE LOWER HALF IS A SITUATION, AND IS CALLED ONE. Three rounds were spent
// renaming the LABEL while the screen's own name still promised 「やったこと」,
// which it has never shown: these sentences are the framing the day's question
// was built from — a state (「9日動いていません」), usually with the tool as its
// grammatical subject, ending 「〜ときの話です」. Nothing about that is an act of
// his. Named by provenance, the same rule knownGroups.ts files the corpus by.
//
// ── THE FORM, AND WHY IT IS THIS FORM ──────────────────────────────────────
// v1 was a two-column table: column heads, one row per pair, both halves at the
// same weight. It read as data, and three defects came from that alone — the
// columns ran opposite to the screen's own name, the same timestamp printed
// three times as if it were data, and there was nowhere to act.
//
// It is now a LEDGER SPINE. One hairline runs the height of the screen; dates
// are engraved on it in the left margin; each declaration stands up from it and
// the record it was made against hangs beneath, indented behind its own softer
// rule. That is a citation structure — a statement, and what it rests on — and
// it is the one layout that makes the relationship visible without asserting
// anything about it. It also scales: at four entries the spine reads as
// deliberate, at four hundred it is the only thing making the screen navigable.

import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import { BackLink } from '@/components/ui/BackLink'
import { capTrackingClass } from '@/lib/labelScript'
import type { SaidDidPair } from '@/lib/persona/saidDid'

export interface PersonaSaidDidProps {
  /** ⚠ THREE-VALUED, like every other read on this surface: `undefined` = the
   *  corpus could not be read, which is not the same as having said nothing. */
  pairs: SaidDidPair[] | undefined
  /** Day-precision stamp for the margin (「8月16日」). Composed by the module —
   *  this file formats nothing. */
  day: (iso: string) => string
  /** Month plate for the spine (「2026年 8月」). Only drawn when the month
   *  changes, so the spine carries time without repeating it per row. */
  month: (iso: string) => string
  /** Full stamp, for the `title` on the day — the minute is real information
   *  once, on demand, and noise when printed on every row. */
  stamp: (iso: string) => string
  onOpenCorrect: (id: string) => void
  onRetire: (id: string) => void
  busyId: string | null
  failedId: string | null
  onRetry: () => void
  onClose: () => void
  reloading: boolean
}

export const PersonaSaidDid = ({
  pairs,
  day,
  month,
  stamp,
  onOpenCorrect,
  onRetire,
  busyId,
  failedId,
  onRetry,
  onClose,
  reloading,
}: PersonaSaidDidProps): JSX.Element => {
  const { t } = useT()
  const heading = t('persona.saidDid.heading')
  return (
    <section aria-label={heading} className="flex h-full flex-col bg-bg">
      {/* ── the head. No column titles: with the statement on top and its
       *  footing beneath, the two halves are labelled where they sit, once
       *  each, instead of by a header bar the eye has to travel back to. */}
      <div className="flex flex-col gap-3 border-b border-line px-8 pb-4 pt-4 sm:px-12">
        <BackLink label={t('persona.known.back')} onClick={onClose} />
        {/* ⚠ THE SAME GRID AS THE ENTRIES, so the title stands directly above the
         *  first declaration and the date gutter reads as the page's margin
         *  rather than as a hole. An axis the head does not share is the fastest
         *  way to make a document look assembled instead of set. */}
        <div className="mx-auto grid w-full max-w-[46rem] grid-cols-[4.5rem_1fr] sm:grid-cols-[6rem_1fr]">
          <span aria-hidden="true" />
          <div className="flex flex-col gap-1.5 pl-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-title tracking-tightest text-ink">{heading}</h2>
            {pairs !== undefined && (
              <b className="text-meta font-medium tabular-nums text-ochre-deep">{pairs.length}</b>
            )}
          </div>
          {/* ⚠ SAYS WHAT IT IS, AND WHAT IT IS NOT YET. What sits below is the
           *  record AS IT WAS WHEN THE QUESTION WAS ASKED — not what happened
           *  afterwards. Letting the screen's name imply the second one would be
           *  the exact overstatement this surface exists to avoid. */}
          <p className="text-meta leading-relaxed text-ink-muted">{t('persona.saidDid.lead')}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 sm:px-12">
        <div className="mx-auto w-full max-w-[46rem]">
          {pairs === undefined ? (
            <div className="flex flex-col items-start gap-2.5 py-8">
              <p className="text-meta leading-relaxed text-ink-muted">
                {t('persona.known.loadFailed')}
              </p>
              <Btn variant="subtle" size="xs" onClick={onRetry} disabled={reloading}>
                {reloading ? t('persona.loading') : t('persona.retry')}
              </Btn>
            </div>
          ) : pairs.length === 0 ? (
            <p className="py-8 text-meta leading-relaxed text-ink-muted">
              {t('persona.saidDid.empty')}
            </p>
          ) : (
            <ol className="flex flex-col pb-16 pt-7">
              {pairs.map((p, i) => {
                // The plate is drawn only when the month turns. Time then reads
                // off the spine in one pass, instead of being restated by every
                // row until it stops meaning anything.
                const newMonth = i === 0 || month(pairs[i - 1].at) !== month(p.at)
                const busy = busyId === p.id
                return (
                  <li key={p.id} className="group/entry contents">
                    {newMonth && (
                      <div className="grid grid-cols-[4.5rem_1fr] sm:grid-cols-[6rem_1fr]">
                        <span
                          className={`pr-4 text-right label-cap ${capTrackingClass(month(p.at))} self-center text-ink-faint`}
                        >
                          {month(p.at)}
                        </span>
                        <span className="border-l border-line py-3" aria-hidden="true" />
                      </div>
                    )}
                    <article className="grid grid-cols-[4.5rem_1fr] sm:grid-cols-[6rem_1fr]">
                      {/* the margin: the date, engraved against the spine */}
                      <span
                        title={stamp(p.at)}
                        className="pr-4 pt-[0.15rem] text-right text-micro tabular-nums text-ink-faint"
                      >
                        {day(p.at)}
                      </span>
                      {/* the spine: one continuous hairline. It warms to ochre
                       *  for the entry in hand — the same "this is the one you
                       *  are pointing at" vocabulary the list screen uses. */}
                      <div className="border-l border-line pb-5 pl-6 transition-colors group-focus-within/entry:border-ochre group-hover/entry:border-ochre">
                        {/* ⚠ BOTH HALVES ARE NAMED, IN THE TITLE'S OWN TWO WORDS.
                         *  The first cut labelled only the lower half, and the
                         *  owner could not tell the halves apart at all (「どれが
                         *  言ったことでどれがやったことかわからん」) — fairly, because
                         *  both are prose in the same voice, and neither of the
                         *  screen's two words appeared anywhere in the body. Size
                         *  and colour are a hierarchy, not a legend. Two plates
                         *  at the same left edge are: the eye learns the rhythm
                         *  on the first entry and never asks again. */}
                        <span
                          className={`label-cap ${capTrackingClass(t('persona.saidDid.said'))} text-ochre-deep`}
                        >
                          {t('persona.saidDid.said')}
                        </span>
                        {/* HIS SENTENCE — the one line on this screen that is in
                         *  his own words, so it carries the reading size. */}
                        <p className="mt-1 whitespace-pre-wrap text-read leading-relaxed text-ink">
                          {p.said}
                        </p>
                        {/* WHAT IT WAS SAID AGAINST. ⚠ The qualifier is not
                         *  decoration: this is the record AS IT STOOD WHEN THE
                         *  QUESTION WAS ASKED, and 「やったこと」 alone would let the
                         *  screen imply it tracked what he did AFTERWARDS —
                         *  which needs a field nobody is storing yet. */}
                        <span
                          className={`mt-3.5 block label-cap ${capTrackingClass(t('persona.saidDid.did'))} text-ink-faint`}
                        >
                          {t('persona.saidDid.did')}
                        </span>
                        <p className="mt-1 whitespace-pre-wrap text-meta leading-relaxed text-ink-muted">
                          {p.did}
                        </p>
                        {/* ⚠ THE TWO EXITS, and there are deliberately only two.
                         *  A line can be rewritten or withdrawn — those are acts
                         *  on the RECORD, which is the only thing this app owns.
                         *  There is no third button for "change what you do",
                         *  and inventing one would turn the screen into a
                         *  lecture. Kept off the page until the entry is in
                         *  hand, so four hundred rows do not read as eight
                         *  hundred buttons. */}
                        <div className="mt-2.5 flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100">
                          <Btn variant="ghost" size="xs" onClick={() => onOpenCorrect(p.id)}>
                            {t('persona.correct.start')}
                          </Btn>
                          <Btn
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => onRetire(p.id)}
                          >
                            {busy ? t('persona.retire.working') : t('persona.retire.start')}
                          </Btn>
                        </div>
                        {failedId === p.id && (
                          <p className="mt-1 text-meta text-accent">{t('persona.retire.failed')}</p>
                        )}
                      </div>
                    </article>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  )
}
