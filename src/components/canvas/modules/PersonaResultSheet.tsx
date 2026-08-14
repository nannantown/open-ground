// PersonaResultSheet — what a finished course tells the owner.
//
// EVERY NUMBER CARRIES ITS SOURCE. The sheet prints the instrument's `source`
// line verbatim (the licensing/provenance promise made in
// src/lib/persona/instruments.ts), every finding shows the number it came from,
// and the caveat that this is a SELF-REPORT — not a verdict — is not optional
// furniture: a personality result with no hedge is exactly the artefact people
// quote back at themselves for years.
//
// The sheet renders the SERVER's scored result (PersonaResult) as-is. It does no
// arithmetic of its own, so what is on screen is what was stored.
//
// IT IS ALSO THE READER for a course already taken. The same sheet opens from
// the rail's 済 entry over a STORED take (PersonaModule fetches
// GET /api/persona/courses/:id/history), which is why `minted` is optional and
// why the takes strip exists: re-reading a result must not mint anything, must
// not re-state what landed in the corpus months ago, and must let the owner
// walk back through earlier takes of the same instrument. Every date shown here
// is localized BY THE CALLER — this component formats nothing.

import type { ReactNode } from 'react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type { PersonaResult } from '@/lib/types'

// The scrim the sheet floats on, kept as its own component so no theme-flipping
// ink token ever lands beside it: `bg-deep` is dark in BOTH themes, so only
// `ink-on-deep` reads on it, and src/labelPlates.test.ts bans the alternatives
// anywhere near this surface. Everything inside the sheet sits on `bg-bg-card`,
// which does invert with the theme and takes the ordinary ink tokens.
const Scrim = ({ children }: { children: ReactNode }) => (
  <div className="absolute inset-0 z-overlay-local overflow-y-auto bg-bg-deep/90 px-5 py-[4vh]">
    {children}
  </div>
)

/** One entry of the takes strip. Both strings are already localized — `label`
 *  is the compact day the strip prints, `title` the full stamp on hover. */
export interface PersonaTakeStripEntry {
  id: string
  label: string
  title: string
}

export interface PersonaResultSheetProps {
  result: PersonaResult
  /** The instrument's one-line subtitle, from the courses API. */
  sub: string
  /** Localized date the course was taken. */
  takenAt: string
  /** How many findings actually reached the corpus (SubmitPersonaCourseResponse
   *  .minted). Fewer than the sheet lists ⇒ the list is a reading, not something
   *  the stand-in has — and the sheet has to say so rather than let the heading
   *  「ペルソナに入ったもの」 make a claim the corpus cannot back.
   *
   *  UNDEFINED when the sheet is REREADING a stored take: minting happened once,
   *  when the course was taken, and a later reading of it is in no position to
   *  say what did or did not land then. Absent ⇒ the sheet says nothing about
   *  it, rather than guessing in either direction. */
  minted?: number
  onClose: () => void
  onRetake: () => void
  /** Every stored take of this course, NEWEST FIRST. Fewer than two ⇒ NO strip
   *  is drawn at all: a strip of one entry is furniture that says nothing and
   *  implies there is somewhere else to go. */
  takes?: PersonaTakeStripEntry[]
  /** Index into `takes` of the result currently on screen. */
  currentTake?: number
  onPickTake?: (index: number) => void
}

export const PersonaResultSheet = ({
  result,
  sub,
  takenAt,
  minted,
  onClose,
  onRetake,
  takes,
  currentTake = 0,
  onPickTake,
}: PersonaResultSheetProps) => {
  const { t } = useT()
  const showStrip = !!takes && takes.length > 1 && !!onPickTake

  return (
    <Scrim>
      <div className="mx-auto flex max-w-[560px] flex-col gap-4 rounded-[3px] border border-line bg-bg-card px-8 py-7 shadow-card">
        <header className="flex flex-col gap-1">
          <p className="label-cap text-accent">{t('persona.result.kicker')}</p>
          <h2 className="font-display text-head tracking-tightest text-ink">
            {result.courseName}
          </h2>
          <p className="text-meta leading-relaxed text-ink-faint">
            {`${sub} ・ ${t('persona.result.answered', { count: result.itemCount })} ・ ${takenAt}`}
          </p>
          {/* Verbatim, always. Changing an instrument without changing this line
           *  is how a product starts lying about where its numbers come from. */}
          <p className="text-meta leading-relaxed text-ink-faint">
            {t('persona.result.source', { source: result.source })}
          </p>
        </header>

        {/* Every take of this instrument, newest first. A result is only worth
         *  anything against the last one — a person who took the same course in
         *  spring and again now is looking for the DIFFERENCE, and hiding the
         *  earlier sheets makes the newest one read as a fixed fact. */}
        {showStrip && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="label-cap text-ink-faint">{t('persona.result.takes')}</span>
            {takes!.map((take, i) => (
              <button
                key={`${i}-${take.id}`}
                type="button"
                title={take.title}
                aria-current={i === currentTake ? 'true' : undefined}
                onClick={() => onPickTake!(i)}
                className={`rounded-[2px] border px-2 py-0.5 text-meta tabular-nums transition-colors ${
                  i === currentTake
                    ? 'border-accent bg-accent/10 text-ink'
                    : 'border-line text-ink-muted hover:border-accent hover:text-ink'
                }`}
              >
                {take.label}
              </button>
            ))}
          </div>
        )}

        <p className="border-l-2 border-accent bg-accent/5 px-4 py-3 text-read leading-relaxed text-ink">
          {result.badge && (
            <span className="mr-2 font-display tracking-cartographic text-accent">
              {result.badge}
            </span>
          )}
          {result.headline}
        </p>

        <div className="flex flex-col gap-3">
          {result.rows.map((row) =>
            result.kind === 'bars' ? (
              <div key={row.key} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ui font-semibold text-ink">{row.name}</span>
                  <span className="text-meta text-accent">{row.note}</span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-[2px] bg-bg-inset">
                  <span
                    className="absolute inset-y-0 left-0 rounded-[2px] bg-accent"
                    style={{ width: `${Math.max(0, Math.min(100, row.pct ?? 0))}%` }}
                  />
                  {/* A bipolar axis is only meaningful against its middle: with
                   *  no mid-line "48%" reads as a low score instead of "half
                   *  and half". */}
                  {row.bipolar && (
                    <span className="absolute inset-y-0 left-1/2 w-px bg-ink/25" />
                  )}
                </div>
                <p className="text-meta leading-relaxed text-ink-faint">{row.desc}</p>
              </div>
            ) : (
              <div
                key={row.key}
                className="flex items-baseline gap-3 border-b border-line-soft pb-2"
              >
                <span className="min-w-[1.25rem] text-micro tabular-nums text-ink-faint">
                  {row.rank}
                </span>
                <span className="text-ui font-semibold text-ink">{row.name}</span>
                <span className="ml-auto text-right text-meta text-ink-faint">
                  {`${row.desc} ・ ${row.score ?? ''}`}
                </span>
              </div>
            ),
          )}
        </div>

        {/* What actually entered the corpus. The sheet is a reading; THIS is the
         *  part that changes what the stand-in does, so it is listed, not
         *  summarised. */}
        <section className="flex flex-col gap-2.5 border-t border-line pt-4">
          <h3 className="label-cap text-ink-faint">{t('persona.result.minted')}</h3>
          <ul className="flex flex-col gap-2">
            {result.findings.map((f) => (
              <li key={`${f.text}|${f.detail}`} className="flex gap-2.5">
                <span aria-hidden="true" className="mt-1.5 text-plate text-accent">
                  ◆
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-ui leading-relaxed text-ink">{f.text}</span>
                  <span className="text-meta text-ink-faint">{f.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {/* Only the sheet that JUST minted is entitled to talk about minting
           *  (see `minted`) — an old take says nothing rather than a stale
           *  warning about a write that finished months ago. */}
          {minted !== undefined && minted < result.findings.length && (
            <p className="text-meta leading-relaxed text-ochre-deep">
              {t('persona.result.mintedPartial')}
            </p>
          )}
        </section>

        <p className="text-meta leading-relaxed text-ink-faint">{t('persona.result.caveat')}</p>

        <div className="flex flex-wrap gap-2">
          <Btn variant="primary" size="sm" onClick={onClose}>
            {t('persona.result.back')}
          </Btn>
          <Btn variant="ghost" size="sm" onClick={onRetake}>
            {t('persona.result.again')}
          </Btn>
        </div>
      </div>
    </Scrim>
  )
}
