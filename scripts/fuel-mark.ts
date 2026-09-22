// fuel-mark — take one reading of OPEN GROUND's own fuel breakdown, so a
// before/after measurement is arithmetic instead of squinting at a panel.
//
// WHY THIS EXISTS. The owner asked to measure whether a worker directive saves
// fuel (docs/trending/TRIALS.md §Trial 4) and, reasonably, did not want to copy
// numbers out of a popover by hand. The usage panel shows the figures since
// 0.11.120, but a measurement is three readings and two subtractions, and doing
// that by eye is where a result gets remembered wrong.
//
// It is READ-ONLY against a RUNNING app: it calls GET /api/usage/breakdown on
// the loopback port and prints what it got. It writes nothing unless `--append`
// names a file, and it never touches ~/.openground.
//
// ⚠ IT MUST RUN ON THE MACHINE THE APP RUNS ON. A cloud Claude Code session
// cannot reach the owner's Mac at all — different filesystem, different
// loopback. This is the whole reason the measurement was being handed back as
// "please paste three numbers": from a remote session there is nothing to read.
// A `claude` started locally in this checkout can run it and do the whole
// measurement itself.
//
// Usage:
//   npx tsx scripts/fuel-mark.ts                        # one reading, printed
//   npx tsx scripts/fuel-mark.ts --label before-off     # tag it
//   npx tsx scripts/fuel-mark.ts --append marks.json    # and keep it
//   npx tsx scripts/fuel-mark.ts --compare marks.json --cards 6
//                                                       # diff the last two

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** One row of GET /api/usage/breakdown. */
export type BreakdownRow = { model: string; source: string; tokens: number }
export type Breakdown = { days: number; rows: BreakdownRow[]; total: number; scannedAt?: string }

/** A single reading, in the shape `--append` writes one per line. */
export type Mark = {
  at: string
  label: string
  days: number
  total: number
  /** tokens per source bucket, summed across models */
  byRole: Record<string, number>
}

/**
 * Collapse a breakdown to the numbers a before/after comparison needs.
 *
 * Summed ACROSS MODELS on purpose: a worker directive changes how much work a
 * worker does, not which model it was given, and a card that happened to run on
 * a different tier would otherwise look like an effect. `total` is the API's own
 * figure, not a re-sum of the rows — the rows are the non-zero ones and the API
 * is the authority on the denominator.
 */
export function summarize(b: Breakdown, label = ''): Mark {
  const byRole: Record<string, number> = {}
  for (const r of b.rows ?? []) {
    if (!r || typeof r.tokens !== 'number' || !Number.isFinite(r.tokens)) continue
    byRole[r.source] = (byRole[r.source] ?? 0) + r.tokens
  }
  return {
    at: new Date().toISOString(),
    label,
    days: b.days,
    total: typeof b.total === 'number' && Number.isFinite(b.total) ? b.total : 0,
    byRole,
  }
}

export type MarkDiff = {
  from: string
  to: string
  cards: number
  /** per-role delta over the interval */
  delta: Record<string, number>
  /** per-role delta divided by `cards`, when cards > 0 */
  perCard: Record<string, number>
  /** true when the window may have rotated between the two readings */
  windowRisk: boolean
}

/**
 * Subtract two readings. The interesting figure is `perCard.['swarm-worker']`.
 *
 * ⚠ `windowRisk` is not decoration. The breakdown covers a MOVING window (7
 * days by default), so if the two readings are further apart than that window,
 * the earlier cards counted in `from` have already aged out of `to` and the
 * subtraction UNDERSTATES — it can even go negative. Flagged rather than
 * corrected, because there is no honest correction: the measurement simply has
 * to be re-run inside the window.
 */
export function diffMarks(from: Mark, to: Mark, cards: number): MarkDiff {
  const roles = new Set([...Object.keys(from.byRole), ...Object.keys(to.byRole)])
  const delta: Record<string, number> = {}
  const perCard: Record<string, number> = {}
  for (const role of Array.from(roles)) {
    const d = (to.byRole[role] ?? 0) - (from.byRole[role] ?? 0)
    delta[role] = d
    if (cards > 0) perCard[role] = Math.round(d / cards)
  }
  const spanMs = new Date(to.at).getTime() - new Date(from.at).getTime()
  const windowMs = Math.max(from.days, to.days) * 24 * 60 * 60 * 1000
  return {
    from: from.label || from.at,
    to: to.label || to.at,
    cards,
    delta,
    perCard,
    windowRisk: !Number.isFinite(spanMs) || spanMs > windowMs,
  }
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const PORT = process.env.OPENGROUND_PORT ?? '47776'

async function main(): Promise<void> {
  const comparePath = arg('compare')
  if (comparePath) {
    if (!existsSync(comparePath)) {
      console.error(`[fuel-mark] no such file: ${comparePath}`)
      process.exit(2)
    }
    const marks = readFileSync(comparePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Mark)
    if (marks.length < 2) {
      console.error(`[fuel-mark] need at least 2 readings in ${comparePath}, found ${marks.length}`)
      process.exit(2)
    }
    const cards = Number(arg('cards') ?? 0)
    const d = diffMarks(marks[marks.length - 2], marks[marks.length - 1], cards)
    console.log(JSON.stringify(d, null, 1))
    if (d.windowRisk) {
      console.error(
        '[fuel-mark] ⚠ the two readings are further apart than the breakdown window — ' +
          'the earlier cards have aged out and this subtraction understates. Re-run inside the window.',
      )
    }
    return
  }

  const url = `http://127.0.0.1:${PORT}/api/usage/breakdown?days=7`
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    console.error(
      `[fuel-mark] cannot reach ${url} — is OPEN GROUND running ON THIS MACHINE? ` +
        'A remote session cannot read the app\'s numbers; run this from a local session.',
    )
    process.exit(1)
    return
  }
  if (!res.ok) {
    console.error(`[fuel-mark] ${url} returned ${res.status}`)
    process.exit(1)
    return
  }
  const mark = summarize((await res.json()) as Breakdown, arg('label') ?? '')
  const line = JSON.stringify(mark)
  console.log(line)
  const append = arg('append')
  if (append) {
    appendFileSync(append, `${line}\n`)
    console.error(`[fuel-mark] appended to ${append}`)
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  void main().catch((e: unknown) => {
    console.error('[fuel-mark] failed:', e)
    process.exit(1)
  })
}
