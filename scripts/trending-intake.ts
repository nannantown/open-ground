// GitHub-Trending intake — turn the sns-hub video project's post history into a
// document THIS repo can read.
//
// WHY THIS EXISTS. `nannantown/github-trending-video` posts a daily "GitHub
// Trending TOP5" short to @ai_trend_daily_. Every morning it commits the day's
// picks to `data/enriched-trending.json` with a Japanese gloss per repository,
// and the file is OVERWRITTEN the next day — so the only complete record of
// "which repositories have been featured" is that file's git history. The owner
// asked (2026-09-22) for that record as a document OPEN GROUND can read, to find
// things worth adopting here.
//
// So this script walks the history, merges every day's picks into one entry per
// repository, and writes two GENERATED docs:
//   docs/trending/INDEX.md    one line per repository, sorted by appearances
//   docs/trending/DETAILS.md  the full Japanese gloss + every appearance date
// The judgement calls live in the HAND-WRITTEN docs/trending/OG-CANDIDATES.md,
// which this script never touches.
//
// ⚠ THE JAPANESE TEXT IS POST COPY, NOT A VERIFIED CLAIM. `description` /
// `detail` / `narration` were written by an LLM to narrate a 50-second video for
// a general audience, with a business angle imposed on top ("削れる月額SaaS"…).
// It is a good index and a bad citation. Anything acted on has to be checked
// against the repository itself — OG-CANDIDATES.md records which entries were.
//
// Usage (the trending repo must be checked out somewhere, with history):
//   git -C <trending-repo> fetch --depth=1000 origin main
//   npx tsx scripts/trending-intake.ts <trending-repo>
// or set TRENDING_REPO instead of passing the path.
//
// Lives as `.ts`, not `.mts`, so the root `tsc --noEmit` gate covers it AND the
// guard test can import the merge function extensionless (the root project has no
// `allowImportingTsExtensions`, so a `.mts` literal import is a compile error).

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type DayProject = {
  rank?: number
  fullName?: string
  name?: string
  url?: string
  language?: string | null
  stars?: number
  todayStars?: number
  description?: string
  detail?: string
  narration?: string
}
export type DayFile = { date?: string; projects?: DayProject[] }
export type HistoryVideo = { date?: string; projects?: string[] }

export type Appearance = {
  date: string
  rank: number | null
  language: string | null
  stars: number | null
  description: string | null
  detail: string | null
  narration: string | null
  /** true when this day came from performance-history.json, which carries names only. */
  namesOnly: boolean
}
export type RepoEntry = {
  fullName: string
  owner: string
  repo: string
  /** de-duplicated, ascending */
  dates: string[]
  count: number
  first: string
  last: string
  language: string | null
  /** highest star count ever recorded for it across appearances */
  stars: number | null
  description: string | null
  detail: string | null
  narration: string | null
  /** how many of its appearances carried the Japanese gloss */
  glossedDays: number
  appearances: Appearance[]
}

const asAppearance = (date: string, p: DayProject): Appearance => ({
  date,
  rank: typeof p.rank === 'number' ? p.rank : null,
  language: p.language ?? null,
  stars: typeof p.stars === 'number' ? p.stars : null,
  description: p.description ?? null,
  detail: p.detail ?? null,
  narration: p.narration ?? null,
  namesOnly: false,
})

/**
 * Merge every day's picks into one entry per repository.
 *
 * `days` may arrive in any order and may contain several files for the same
 * date; the LAST file given for a date wins (callers pass history oldest-first,
 * so a later correction commit beats the original). `videos` is
 * performance-history.json, which lists names only — it fills in days whose
 * enriched file was never committed, and never overwrites a glossed day.
 *
 * Pure on purpose: the git walk is the part that cannot be unit-tested, so it
 * stays out of here.
 */
export function mergeAppearances(input: { days: DayFile[]; videos?: HistoryVideo[] }): RepoEntry[] {
  const byDate = new Map<string, DayFile>()
  for (const d of input.days) {
    if (!d?.date) continue
    byDate.set(d.date, d)
  }
  const dates = Array.from(byDate.keys()).sort()

  const entries = new Map<string, { fullName: string; appearances: Appearance[] }>()
  const touch = (fullName: string) => {
    let e = entries.get(fullName)
    if (!e) {
      e = { fullName, appearances: [] }
      entries.set(fullName, e)
    }
    return e
  }

  for (const date of dates) {
    for (const p of byDate.get(date)?.projects ?? []) {
      if (!p?.fullName) continue
      touch(p.fullName).appearances.push(asAppearance(date, p))
    }
  }
  // Days the enriched file never captured: names only, and only for dates the
  // glossed pass did not already cover.
  for (const v of input.videos ?? []) {
    if (!v?.date || byDate.has(v.date)) continue
    for (const fullName of v.projects ?? []) {
      if (!fullName) continue
      touch(fullName).appearances.push({
        date: v.date,
        rank: null,
        language: null,
        stars: null,
        description: null,
        detail: null,
        narration: null,
        namesOnly: true,
      })
    }
  }

  const out: RepoEntry[] = []
  for (const e of Array.from(entries.values())) {
    const appearances = e.appearances.slice().sort((a, b) => a.date.localeCompare(b.date))
    const uniqueDates = Array.from(new Set(appearances.map((a) => a.date))).sort()
    const glossed = appearances.filter((a) => a.detail)
    const latest = glossed.length ? glossed[glossed.length - 1] : null
    const starValues = appearances.map((a) => a.stars).filter((s): s is number => typeof s === 'number')
    const [owner = e.fullName, repo = ''] = e.fullName.split('/')
    out.push({
      fullName: e.fullName,
      owner,
      repo,
      dates: uniqueDates,
      count: uniqueDates.length,
      first: uniqueDates[0] ?? '',
      last: uniqueDates[uniqueDates.length - 1] ?? '',
      language: latest?.language ?? appearances.map((a) => a.language).filter(Boolean).pop() ?? null,
      stars: starValues.length ? Math.max(...starValues) : null,
      description: latest?.description ?? null,
      detail: latest?.detail ?? null,
      narration: latest?.narration ?? null,
      glossedDays: glossed.length,
      appearances,
    })
  }
  out.sort((a, b) => b.count - a.count || (b.stars ?? 0) - (a.stars ?? 0) || a.fullName.localeCompare(b.fullName))
  return out
}

// ── the free-only vocabulary (owner decision 2026-09-22) ─────────────────────
//
// These types and `freeVerdict` live HERE, in the base module, because both the
// scanner (scripts/trending-cost-scan.ts, which fills the cache) and the
// renderers below (which display it) need them — and the scanner already imports
// this file. Putting them the other way round would make the two modules import
// each other. The scanner re-exports them so its own callers and tests read
// naturally; the classifier that PRODUCES a CostSignals stays over there.

export type KeyVerdict = 'no' | 'yes' | 'unclear'
export type CostSignals = {
  needsKey: KeyVerdict
  subscriptionOk: boolean
  paidTier: string[]
  localOnly: boolean
  evidence: string[]
}
export type RepoSignals = {
  license: string | null
  licenseFile: string | null
  readmeBytes: number | null
  signals: CostSignals | null
  fetchedAt: string
}
export type SignalsCache = { updatedAt: string; repos: Record<string, RepoSignals> }

/**
 * The one-word column the index shows. It is a reading of the README, NOT a
 * verdict on the product — see the caveat rendered into INDEX.md.
 */
export function freeVerdict(s: { license: string | null; signals: CostSignals | null }): 'free' | 'free?' | 'cost?' | 'unknown' {
  if (!s.signals) return 'unknown'
  if (s.signals.paidTier.length || s.signals.needsKey === 'yes') return 'cost?'
  if (!s.license) return 'free?'
  if (s.signals.needsKey === 'no') return 'free'
  return 'free?'
}

// ── the git walk (not unit-tested; it needs a real checkout) ──────────────────

const DATA_FILE = 'data/enriched-trending.json'

export function readDaysFromGit(repoDir: string): { days: DayFile[]; commits: number; unreadable: number } {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  // Prefer the fetched remote branch; a bare clone checkout falls back to HEAD.
  let rev = 'origin/main'
  try {
    git('rev-parse', '--verify', rev)
  } catch {
    rev = 'HEAD'
  }
  const shas = git('log', '--format=%H', rev, '--', DATA_FILE).trim().split('\n').filter(Boolean)
  const days: DayFile[] = []
  let unreadable = 0
  // Oldest-first, so a later correction commit for the same date wins in the merge.
  for (const sha of shas.slice().reverse()) {
    try {
      const parsed = JSON.parse(git('show', `${sha}:${DATA_FILE}`)) as DayFile
      if (parsed?.date) days.push(parsed)
      else unreadable++
    } catch {
      unreadable++
    }
  }
  return { days, commits: shas.length, unreadable }
}

const md = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

export function renderIndex(
  repos: RepoEntry[],
  meta: { days: number; from: string; to: string },
  cache?: SignalsCache | null,
): string {
  const lines: string[] = []
  lines.push('# GitHub Trending intake — index')
  lines.push('')
  lines.push('> **GENERATED FILE — do not hand-edit.** Regenerate with')
  lines.push('> `npx tsx scripts/trending-intake.ts <github-trending-video checkout>`')
  lines.push('> (the checkout needs history: `git -C <repo> fetch --depth=1000 origin main`).')
  lines.push('> Judgement calls belong in the hand-written [OG-CANDIDATES.md](./OG-CANDIDATES.md).')
  lines.push('')
  lines.push(
    'Every repository featured in the daily "GitHub Trending TOP5" short posted to',
    '@ai_trend_daily_ (`nannantown/github-trending-video`), recovered from the git',
    'history of that project\'s `data/enriched-trending.json`.',
  )
  lines.push('')
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push(`| Days covered | ${meta.days} (${meta.from} → ${meta.to}) |`)
  lines.push(`| Unique repositories | ${repos.length} |`)
  lines.push(`| Featured more than once | ${repos.filter((r) => r.count > 1).length} |`)
  lines.push('')
  lines.push('⚠ **The Japanese one-liner is post copy, not a verified claim.** It was written')
  lines.push('to narrate a 50-second video for a general audience, with a business angle')
  lines.push('imposed on top. Treat it as an index entry; check the repository itself before')
  lines.push('acting on anything. `stars` is the highest figure recorded on any appearance day.')
  lines.push('')
  if (cache) {
    lines.push(`## Free-only filter (owner decision 2026-09-22) — scanned ${cache.updatedAt}`)
    lines.push('')
    lines.push('Only tools usable for free are candidates. `Free?` reads the repository\'s')
    lines.push('README and LICENSE (`scripts/trending-cost-scan.ts`):')
    lines.push('')
    lines.push('| Value | Meaning |')
    lines.push('|---|---|')
    lines.push('| `free` | Licence identified AND the README explicitly needs no key or account. |')
    lines.push('| `free?` | Licence identified but the README says nothing either way — or the licence could not be read. |')
    lines.push('| `cost?` | A recurring price, or a required API key, was quoted from the README. |')
    lines.push('| `unknown` | No README could be fetched. |')
    lines.push('')
    lines.push('⚠ **It is a reading of the README, not a verdict on the product.** A paid')
    lines.push('hosted default that names no price is invisible to it — `thedotmack/claude-mem`')
    lines.push('scans `free?` while its installer defaults to a hosted paid tier after a 30-day')
    lines.push('trial. Read the evidence in `signals.json` and the README before deciding.')
    lines.push('')
  }
  const head = cache
    ? '| # | Repository | Days | First → Last | Stars | Lang | Licence | Free? | 一言(投稿文・未検証) |'
    : '| # | Repository | Days | First → Last | Stars | Lang | 一言(投稿文・未検証) |'
  const rule = cache ? '|---:|---|---:|---|---:|---|---|---|---|' : '|---:|---|---:|---|---:|---|---|'
  lines.push(head)
  lines.push(rule)
  repos.forEach((r, i) => {
    const span = r.first === r.last ? r.first : `${r.first} → ${r.last}`
    const sig = cache?.repos[r.fullName]
    const cols = cache
      ? ` ${md(sig?.license ?? null) || '?'} | ${sig ? freeVerdict(sig) : 'unknown'} |`
      : ''
    lines.push(
      `| ${i + 1} | [${md(r.fullName)}](https://github.com/${r.fullName}) | ${r.count} | ${span} | ${
        r.stars ?? '-'
      } | ${md(r.language) || '-'} |${cols} ${md(r.description)} |`,
    )
  })
  lines.push('')
  return lines.join('\n')
}

export function renderDetails(
  repos: RepoEntry[],
  meta: { days: number; from: string; to: string },
  cache?: SignalsCache | null,
): string {
  const lines: string[] = []
  lines.push('# GitHub Trending intake — details')
  lines.push('')
  lines.push('> **GENERATED FILE — do not hand-edit.** See [INDEX.md](./INDEX.md) for the')
  lines.push('> table, provenance and the regeneration command, and')
  lines.push('> [OG-CANDIDATES.md](./OG-CANDIDATES.md) for what is worth adopting here.')
  lines.push('')
  lines.push(`Covering ${meta.days} days (${meta.from} → ${meta.to}), ${repos.length} repositories.`)
  lines.push('')
  lines.push('⚠ The Japanese text below is the video post copy — an LLM narration for a')
  lines.push('general audience, not a verified technical claim. Grep it to find candidates;')
  lines.push('read the repository before believing it.')
  lines.push('')
  for (const r of repos) {
    lines.push(`## ${r.fullName}`)
    lines.push('')
    const sig = cache?.repos[r.fullName]
    const bits = [
      `<https://github.com/${r.fullName}>`,
      `${r.count} day${r.count === 1 ? '' : 's'}`,
      r.stars == null ? null : `★${r.stars}`,
      r.language ?? null,
      sig ? `${sig.license ?? 'licence unread'} · ${freeVerdict(sig)}` : null,
    ].filter(Boolean)
    lines.push(bits.join(' · '))
    if (sig?.signals?.evidence.length) {
      lines.push('')
      for (const e of sig.signals.evidence.slice(0, 4)) lines.push(`> ${md(e)}`)
    }
    lines.push('')
    if (r.description) lines.push(`**${md(r.description)}**`)
    if (r.detail) lines.push('', md(r.detail))
    if (r.narration && r.narration !== r.detail) lines.push('', `読み: ${md(r.narration)}`)
    if (!r.detail) lines.push('', '_(no gloss recorded — this repository only appears in the name-only performance history)_')
    lines.push('')
    lines.push(`Featured: ${r.dates.join(', ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const repoDir = process.argv[2] ?? process.env.TRENDING_REPO
  if (!repoDir) {
    console.error('usage: npx tsx scripts/trending-intake.ts <github-trending-video checkout>')
    console.error('   or: TRENDING_REPO=<path> npx tsx scripts/trending-intake.ts')
    process.exit(2)
  }
  const { days, commits, unreadable } = readDaysFromGit(repoDir)
  let videos: HistoryVideo[] = []
  try {
    videos = (JSON.parse(readFileSync(join(repoDir, 'data/performance-history.json'), 'utf8')) as { videos?: HistoryVideo[] })
      .videos ?? []
  } catch {
    console.warn('[trending-intake] no performance-history.json — name-only days will be missing')
  }
  const repos = mergeAppearances({ days, videos })
  const allDates = Array.from(new Set(repos.flatMap((r) => r.dates))).sort()
  const meta = { days: allDates.length, from: allDates[0] ?? '', to: allDates[allDates.length - 1] ?? '' }
  const outDir = join(fileURLToPath(new URL('..', import.meta.url)), 'docs/trending')
  mkdirSync(outDir, { recursive: true })
  // The free-only columns come from the cache trending-cost-scan.ts fills. Absent
  // (first run, or offline) the docs render without them rather than failing.
  let cache: SignalsCache | null = null
  try {
    cache = JSON.parse(readFileSync(join(outDir, 'signals.json'), 'utf8')) as SignalsCache
  } catch {
    console.warn('[trending-intake] no docs/trending/signals.json — run scripts/trending-cost-scan.ts for the free-only columns')
  }
  writeFileSync(join(outDir, 'INDEX.md'), renderIndex(repos, meta, cache))
  writeFileSync(join(outDir, 'DETAILS.md'), renderDetails(repos, meta, cache))
  console.log(
    `[trending-intake] commits=${commits} unreadable=${unreadable} days=${meta.days} ` +
      `(${meta.from}..${meta.to}) repos=${repos.length} -> docs/trending/{INDEX,DETAILS}.md`,
  )
}
