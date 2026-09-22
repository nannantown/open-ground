// GitHub-Trending intake — the FREE-ONLY pass.
//
// WHY THIS EXISTS. Owner decision, 2026-09-22: only tools that can be used for
// free are candidates for OPEN GROUND. "Free" is two separate questions and the
// answers live in two different files:
//
//   1. May we use it?      → the LICENSE (MIT/Apache = yes; Elastic/BSL =
//                            source-available with conditions; none = unknown).
//   2. Does using it cost? → the README (a paid tier, or a required API key,
//                            which for us is both a cost AND a collision with
//                            OG's subscription-only rule).
//
// So this script fetches both for every repository in the intake and caches the
// answers in docs/trending/signals.json, which trending-intake.ts then renders
// into the generated docs. Cached because 298 repositories is ~600 HTTP requests
// and the answers change slowly.
//
// ⚠ WHY THE CLASSIFIER IS NOT A GREP. The first pass at this WAS a grep for
// "API key", and it got two repositories exactly backwards (measured
// 2026-09-22):
//
//   • JuliusBrussee/caveman  — "One command, no account, no API key."
//   • …/destructive_command_guard — its matches are deny-patterns that PROTECT
//     API keys ("template deletion, API key deletion").
//
// Counting a string cannot tell "needs a key" from "needs no key" or "guards
// other people's keys", and a cost filter that is confidently wrong is worse
// than no filter — it rejects the free thing and waves through the paid one.
// Hence `classifyCostSignals`, which answers only what it can defend, returns
// 'unclear' otherwise, and carries the matched line as evidence for every
// non-'unclear' verdict. Its traps are pinned in
// server/__tests__/trendingCostScan.test.ts.
//
// Usage:
//   npx tsx scripts/trending-cost-scan.ts <github-trending-video checkout>
//   npx tsx scripts/trending-cost-scan.ts <checkout> --only owner/name
//   npx tsx scripts/trending-cost-scan.ts <checkout> --refresh   (ignore cache)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  freeVerdict,
  mergeAppearances,
  readDaysFromGit,
  type CostSignals,
  type HistoryVideo,
  type KeyVerdict,
  type RepoSignals,
  type SignalsCache,
} from './trending-intake'

// The shared vocabulary lives in trending-intake.ts (the base module both this
// scanner and the renderers import) so the two files do not import each other.
// Re-exported here because this is where callers expect the cost surface to be.
export { freeVerdict }
export type { CostSignals, KeyVerdict, RepoSignals, SignalsCache }

// ── the part worth testing ───────────────────────────────────────────────────


/** "no API key", "no account required", "without an API key" … */
const NO_KEY = /\bno\s+(?:\w+\s+){0,3}?(?:api[\s_-]?keys?|account)\b|\bwithout\s+(?:an?\s+)?api[\s_-]?key\b|\bapi[\s_-]?keys?\s+(?:is|are)\s+not\s+required\b|\bno\s+api[\s_-]?keys?\s+required\b/i
/** An actual credential being SET, or stated as required. */
const YES_KEY =
  /\b[A-Z][A-Z0-9_]*_API_KEY\s*=|\b[A-Z][A-Z0-9_]*_API_KEY["']?\s*:|\brequires?\s+(?:an?\s+)?api[\s_-]?key\b|\byou\s+need\s+(?:an?\s+)?[\w\s]{0,20}api\s+key\b|\bget\s+(?:an?\s+)?api[\s_-]?key\b/i
/** Runs on the agent CLI you already pay for. */
const SUBSCRIPTION =
  /\buses?\s+your\s+existing\s+[`'"]?claude[^\n]{0,40}session\b|\bclaude\s+auth\s+login\b|\byour\s+subscriptions?\s+on\b|\bsubscription\s+mode\b|\bno\s+\w+\s+api\s+key\s+required\b|\busing\s+its\s+own\s+llm\b/i
/** A recurring price. `$0.54` on its own is a benchmark number, not a price. */
const PAID_TIER = /\$\s?[\d,]+(?:\.\d+)?\s*(?:\/|\s+per\s+)\s*(?:seat|user|mo|month|yr|year)[\w/]*/gi
const LOCAL_ONLY =
  /\b100%\s+local\b|\bruns?\s+entirely\s+locally\b|\bnothing\s+leaves\s+your\s+machine\b|\bno\s+data\s+leaves\s+your\s+machine\b|\bfully\s+local\b/i

/** Markdown/HTML noise removed so a regex reads prose, not markup. */
const flatten = (text: string): string[] =>
  text
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

const quote = (line: string): string => (line.length > 200 ? `${line.slice(0, 197)}…` : line)

/**
 * Read a README for cost signals. Answers only what a quoted line supports;
 * everything else is 'unclear' / false / empty.
 *
 * Precedence on the key question is deliberate: an explicit "no API key" claim
 * BEATS a later credential example, because projects routinely say "no key
 * needed" for the default path and then document optional provider setups
 * (caveman, ruflo). The inverse ordering was measured wrong on both.
 */
export function classifyCostSignals(readme: string): CostSignals {
  const lines = flatten(readme)
  const evidence: string[] = []
  let sawNo = false
  let sawYes = false
  let subscriptionOk = false
  let localOnly = false
  const paidTier: string[] = []

  for (const line of lines) {
    if (NO_KEY.test(line)) {
      if (!sawNo) evidence.push(`no-key: ${quote(line)}`)
      sawNo = true
    }
    if (YES_KEY.test(line)) {
      if (!sawYes) evidence.push(`key: ${quote(line)}`)
      sawYes = true
    }
    if (SUBSCRIPTION.test(line)) {
      if (!subscriptionOk) evidence.push(`subscription: ${quote(line)}`)
      subscriptionOk = true
    }
    if (LOCAL_ONLY.test(line)) {
      if (!localOnly) evidence.push(`local: ${quote(line)}`)
      localOnly = true
    }
    const prices = line.match(PAID_TIER)
    if (prices) {
      for (const p of prices) {
        const norm = p.replace(/\s+/g, ' ').trim()
        if (!paidTier.includes(norm)) paidTier.push(norm)
      }
      evidence.push(`paid: ${quote(line)}`)
    }
  }

  // An explicit "no key" or a subscription path wins over a documented optional
  // credential — see the doc comment.
  const needsKey: KeyVerdict = sawNo || subscriptionOk ? 'no' : sawYes ? 'yes' : 'unclear'
  return { needsKey, subscriptionOk, paidTier, localOnly, evidence }
}


const LICENSE_NAMES: [RegExp, string][] = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL'],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL'],
  [/GNU GENERAL PUBLIC LICENSE/i, 'GPL'],
  [/Apache License/i, 'Apache-2.0'],
  [/\bMIT License\b|Permission is hereby granted, free of charge/i, 'MIT'],
  [/BSD 3-Clause/i, 'BSD-3'],
  [/BSD 2-Clause/i, 'BSD-2'],
  [/Mozilla Public License/i, 'MPL-2.0'],
  [/Business Source License/i, 'BSL-1.1'],
  [/Elastic License/i, 'Elastic-2.0'],
  [/Functional Source License/i, 'FSL'],
  [/\bISC License\b/i, 'ISC'],
  [/This is free and unencumbered software|The Unlicense/i, 'Unlicense'],
  [/Creative Commons/i, 'CC'],
]

/** Name the licence from its text. Returns null rather than guessing. */
export function detectLicense(text: string): string | null {
  const head = text.slice(0, 4000)
  for (const [re, name] of LICENSE_NAMES) if (re.test(head)) return name
  return null
}

// ── the network pass (not unit-tested; it needs the internet) ────────────────


const BRANCHES = ['main', 'master'] as const
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'] as const
const README_FILES = ['README.md', 'readme.md', 'README.MD'] as const

const raw = async (repo: string, branch: string, file: string): Promise<string | null> => {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${file}`)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function firstOf(repo: string, files: readonly string[]): Promise<{ file: string; text: string } | null> {
  for (const branch of BRANCHES) {
    for (const file of files) {
      const text = await raw(repo, branch, file)
      if (text !== null) return { file, text }
    }
  }
  return null
}

export async function scanRepo(repo: string): Promise<RepoSignals> {
  const lic = await firstOf(repo, LICENSE_FILES)
  const readme = await firstOf(repo, README_FILES)
  return {
    license: lic ? detectLicense(lic.text) : null,
    licenseFile: lic?.file ?? null,
    readmeBytes: readme ? readme.text.length : null,
    signals: readme ? classifyCostSignals(readme.text) : null,
    fetchedAt: new Date().toISOString().slice(0, 10),
  }
}

// Wrapped in an async main rather than using top-level await: the ROOT tsconfig
// has no `target` (⇒ ES5), which rejects top-level await (TS1378), and moving the
// file to `.mts` to get es2022 would put it outside the root project — where the
// guard test could no longer import it (no allowImportingTsExtensions there).
async function main(): Promise<void> {
  const repoDir = process.argv[2] ?? process.env.TRENDING_REPO
  if (!repoDir) {
    console.error('usage: npx tsx scripts/trending-cost-scan.ts <github-trending-video checkout> [--only owner/name] [--refresh]')
    process.exit(2)
  }
  const onlyAt = process.argv.indexOf('--only')
  const only = onlyAt === -1 ? null : process.argv[onlyAt + 1]
  const refresh = process.argv.includes('--refresh')

  const outDir = join(fileURLToPath(new URL('..', import.meta.url)), 'docs/trending')
  const cachePath = join(outDir, 'signals.json')
  const cache: SignalsCache = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, 'utf8')) as SignalsCache)
    : { updatedAt: '', repos: {} }

  const { days } = readDaysFromGit(repoDir)
  let videos: HistoryVideo[] = []
  try {
    videos = (JSON.parse(readFileSync(join(repoDir, 'data/performance-history.json'), 'utf8')) as {
      videos?: HistoryVideo[]
    }).videos ?? []
  } catch {
    /* name-only days are optional here */
  }
  const all = mergeAppearances({ days, videos }).map((r) => r.fullName)
  const targets = (only ? all.filter((r) => r === only) : all).filter((r) => refresh || !cache.repos[r])
  console.log(`[cost-scan] ${all.length} repositories, ${targets.length} to fetch (cached: ${all.length - targets.length})`)

  // Small concurrency on purpose: this is someone else's CDN, and the whole run
  // is a few minutes either way.
  const CONCURRENCY = 6
  let done = 0
  const queue = [...targets]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const repo = queue.shift()
      if (!repo) return
      cache.repos[repo] = await scanRepo(repo)
      done++
      if (done % 25 === 0) console.log(`[cost-scan]   ${done}/${targets.length}`)
    }
  })
  await Promise.all(workers)

  cache.updatedAt = new Date().toISOString().slice(0, 10)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`)

  const rows = all.map((r) => cache.repos[r]).filter(Boolean)
  const tally = (f: (x: RepoSignals) => boolean) => rows.filter(f).length
  console.log(
    `[cost-scan] wrote docs/trending/signals.json — ` +
      `licence known ${tally((x) => !!x.license)}/${rows.length}, ` +
      `needsKey yes ${tally((x) => x.signals?.needsKey === 'yes')} / no ${tally(
        (x) => x.signals?.needsKey === 'no',
      )}, paid-tier ${tally((x) => !!x.signals?.paidTier.length)}, ` +
      `no README ${tally((x) => x.signals === null)}`,
  )
  // Keep the shell's exit status meaningful for a scripted re-run.
  if (rows.length === 0) {
    console.error('[cost-scan] nothing scanned — is the checkout right?')
    process.exit(1)
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  void main().catch((e: unknown) => {
    console.error('[cost-scan] failed:', e)
    process.exit(1)
  })
}
