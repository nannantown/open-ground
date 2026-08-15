// PersonaLedgerBlock — 「分身は今週、何回あなたの代わりに答えたか」.
//
// WHAT THIS IS. Everything else on the Persona screen is SELF-REPORT: courses
// the owner scored about themselves, notes they typed. The decision ledger
// (GET /api/persona/ledger, written by src/lib/server/personaLedger.ts) is the
// other half — the record of the stand-in acting against REAL work: it answered
// a blocked worker AS the owner, it handed the question back to them, or no
// answer came back at all. This block is the glance at that record; the detail
// list below it is the evidence.
//
// TWO RULES IT INHERITS FROM THE SCREEN AROUND IT:
//
//   1. NOTHING IS SAID THAT THE LEDGER CANNOT BACK. An empty ledger is an
//      invitation ("what it decides for you will show up here"), never counts of
//      zero dressed up as activity — and never an error. A ledger that could not
//      be READ renders NOTHING at all (PersonaModule drops the block), because
//      "it has done nothing yet" is a claim a failed read is in no position to
//      make. Same rule the portrait already follows.
//   2. AS LITTLE TEXT AS THE ANSWER NEEDS. The figure is the screen. The block
//      is one cap, three counts, and — only over a week of zeros, where it
//      carries information — the day of the last decision. The DETAIL list is
//      the one thing allowed to scroll, inside its own container, so opening it
//      never turns the stage into a page.
//
// PRIVACY. `question` is untrusted text another agent wrote (already truncated
// server-side) and `projectPath` is an absolute path under the owner's home, so
// only the folder NAME is ever drawn. `key` is an opaque correlation hash and is
// never rendered at all — the row shows what the owner would recognise, not what
// the store joins on.
//
// DATES ARE LOCALIZED BY THE CALLER (`dayLabel` / `lastLabel`), the same
// contract PersonaResultSheet keeps: this file formats nothing.

import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type {
  PersonaLedgerCounts,
  PersonaLedgerEntry,
  PersonaLedgerResponse,
  PersonaLedgerSummary,
  PersonaLedgerWhy,
} from '@/lib/types'

const isCounts = (v: unknown): v is PersonaLedgerCounts =>
  !!v &&
  typeof v === 'object' &&
  (['answered', 'asked', 'abstained'] as const).every(
    (k) => typeof (v as Record<string, unknown>)[k] === 'number',
  )

/** SHAPE-CHECK A 200 BEFORE IT REACHES THE RENDER PATH. The block reaches
 *  straight into `summary.week.answered`, so a body without it is not a ledger —
 *  an older server that does not serve this route, an error page, a proxy's
 *  JSON. Storing it anyway throws inside render and takes the WHOLE screen down
 *  (measured on the portrait, 2026-08-14, three suites away from its cause).
 *  "Not a ledger" and "never read" have to be the same state. */
export const isPersonaLedger = (body: unknown): body is PersonaLedgerResponse => {
  if (!body || typeof body !== 'object') return false
  const { summary, recent } = body as { summary?: unknown; recent?: unknown }
  if (!Array.isArray(recent)) return false
  if (!summary || typeof summary !== 'object') return false
  const { week, total } = summary as { week?: unknown; total?: unknown }
  return isCounts(week) && isCounts(total)
}

/** The folder name, never the path: `projectPath` is absolute and sits under the
 *  owner's home, so drawing it raw would put their home directory on screen. */
export const ledgerProjectLabel = (projectPath: string): string =>
  projectPath.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** The reason CLASSES the store keeps in `why`, each mapped to words.
 *
 *  EXHAUSTIVE over {@link PersonaLedgerWhy} on purpose: a fourth reason class added
 *  upstream fails THIS LINE at build time. Typed `Record<string, …>` it would
 *  compile happily and the new reason would render as nothing at all — a gap the
 *  owner would have to notice on screen to find out about.
 *
 *  The lookup still ACCEPTS any string, because this reads wire data: a ledger
 *  written by a newer build can carry a class this one has no wording for, and a
 *  slug the owner cannot read is worse than the verdict alone, which already says
 *  what happened. Build-time strictness, runtime tolerance — both, not either. */
const WHY_KEY: Record<PersonaLedgerWhy, string> = {
  irreversible: 'persona.ledger.why.irreversible',
  'insufficient-info': 'persona.ledger.why.insufficient-info',
  policy: 'persona.ledger.why.policy',
}

export const ledgerWhyKey = (why: string | undefined): string | null =>
  (why && WHY_KEY[why as PersonaLedgerWhy]) || null

/** Same shape for `confidence` ('high' | 'medium' | 'low', only on an answer). */
const CONFIDENCE_KEY: Record<string, string> = {
  high: 'persona.ledger.confidence.high',
  medium: 'persona.ledger.confidence.medium',
  low: 'persona.ledger.confidence.low',
}

export const ledgerConfidenceKey = (confidence: string | undefined): string | null =>
  (confidence && CONFIDENCE_KEY[confidence]) || null

/** One count, drawn number-first so three of them read as one line. The numeral
 *  is `tabular-nums` — the row must not jitter as the week fills up. */
const Stat = ({ n, label }: { n: number; label: string }) => (
  <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
    <span className="text-ui tabular-nums text-ink-onDeep/85">{n}</span>
    <span className="text-meta text-ink-onDeep/55">{label}</span>
  </span>
)

export interface PersonaLedgerBlockProps {
  summary: PersonaLedgerSummary
  /** `summary.lastAt` as a localized day, or null when nothing is stamped. */
  lastLabel: string | null
  /** Absent ⇒ there is nothing to open, and the block is a label rather than a
   *  button. A control that opens an empty list is a broken promise. */
  onOpen?: () => void
}

export const PersonaLedgerBlock = ({ summary, lastLabel, onOpen }: PersonaLedgerBlockProps) => {
  const { t } = useT()
  // THE WEEK, never the lifetime. `total` is what the store holds; printing it
  // under a cap that says 「今週」 would inflate the one number this block exists
  // to answer.
  const week = summary.week
  const total = summary.total
  const weekTotal = week.answered + week.asked + week.abstained

  // NOTHING RECORDED ⇒ NO BLOCK (2026-08-15, owner: 「意味不明。いらないなら消そう」).
  // It used to print a placeholder line promising what would appear here one
  // day. On a machine where the stand-in has never decided anything — which is
  // every machine on day one — that line was the ONLY thing in the corner, and
  // it explained a feature the reader had no way to want yet. A screen earns
  // attention by showing what exists; a promise is not a thing that exists.
  //
  // A week of zeros over a ledger that HAS entries is different, and still
  // renders: that is a real answer to 「今週何回?」.
  if (total.answered + total.asked + total.abstained === 0) return null

  const body = (
    <>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <Stat n={week.answered} label={t('persona.ledger.answered')} />
        <Stat n={week.asked} label={t('persona.ledger.asked')} />
        <Stat n={week.abstained} label={t('persona.ledger.abstained')} />
      </span>
      {/* Only over an empty week, where it is the difference between "idle" and
       *  "dead". Beside real counts it would be furniture. */}
      {weekTotal === 0 && lastLabel && (
        <span className="text-meta text-ink-onDeep/40">
          {t('persona.ledger.last', { date: lastLabel })}
        </span>
      )}
    </>
  )

  return (
    <section
      aria-label={t('persona.ledger.label')}
      className="flex flex-col items-start gap-1"
    >
      <span className="label-cap text-ink-onDeep/45">{t('persona.ledger.week')}</span>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          // Sits directly on the stage, so its ink is `ink-onDeep` — the one made
          // for a surface that does not invert with the theme (the bg-deep rule
          // pinned in src/labelPlates.test.ts).
          className="flex flex-col items-start gap-0.5 rounded-[2px] border border-transparent px-1.5 py-1 text-left transition-colors hover:border-line hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {body}
        </button>
      ) : (
        <span className="flex flex-col items-start gap-0.5 px-1.5 py-1">{body}</span>
      )}
    </section>
  )
}

export interface PersonaLedgerDetailProps {
  /** NEWEST FIRST, as the API sends them. */
  entries: PersonaLedgerEntry[]
  /** An ISO stamp as a localized day. */
  dayLabel: (iso: string) => string
  onClose: () => void
}

const HEADING_ID = 'persona-ledger-detail-heading'

/** The evidence behind the block, in the SAME reading column (and the same card)
 *  the figure's notes open into — one place on this screen where things are read,
 *  not a second drawer with its own shape. */
export const PersonaLedgerDetail = ({ entries, dayLabel, onClose }: PersonaLedgerDetailProps) => {
  const { t } = useT()
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="rounded-[3px] border border-line bg-bg-card px-5 py-4 shadow-card"
    >
      <h3 id={HEADING_ID} className="label-cap text-ink-faint">
        {t('persona.ledger.detail.heading')}
      </h3>
      {/* The one thing on this screen that scrolls — inside its own container, so
       *  the stage behind it never becomes a page. */}
      <ul className="mt-2.5 flex max-h-[46vh] flex-col gap-3 overflow-y-auto">
        {entries.map((e) => {
          const whyKey = ledgerWhyKey(e.why)
          const confidenceKey = ledgerConfidenceKey(e.confidence)
          const meta = [
            ledgerProjectLabel(e.projectPath),
            dayLabel(e.at),
            whyKey && t(whyKey),
            confidenceKey && t(confidenceKey),
          ].filter(Boolean)
          return (
            <li key={e.id} className="flex flex-col gap-1 border-l-2 border-line-strong pl-3">
              <span className="self-start rounded-[2px] border border-line-soft bg-bg-inset px-1.5 py-0.5 text-meta text-ink-muted">
                {t(`persona.ledger.verdict.${e.verdict}`)}
              </span>
              {/* Truncated server-side; wrapped here rather than clipped, because
               *  a question the owner cannot read is a row that says nothing. */}
              <p className="whitespace-pre-wrap text-ui leading-relaxed text-ink">{e.question}</p>
              <span className="text-meta leading-relaxed text-ink-faint">{meta.join(' ・ ')}</span>
              {/* THE HIGHEST-VALUE ROW ON THIS SCREEN: the proxy asked, and the
               *  human decided. It is the only line here that can measure the
               *  stand-in against the owner, so it is the only one that carries
               *  colour. */}
              {e.answered && (
                <span className="text-meta leading-relaxed text-moss-text">
                  {t('persona.ledger.ownerAnswered', { date: dayLabel(e.answered.at) })}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="mt-3.5">
        <Btn variant="subtle" size="xs" onClick={onClose}>
          {t('persona.node.close')}
        </Btn>
      </div>
    </section>
  )
}
