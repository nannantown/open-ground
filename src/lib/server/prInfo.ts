// prInfo — PR state / diff stats for a Board card's prUrl (B023, F058/F085).
// `gh pr view --json` from the project cwd; everything that can go wrong
// (no gh, unauthenticated, malformed URL, network, 404) collapses to
// { available: false } so the drawer simply shows nothing — a gh-less
// environment is silent, never an error state.
//
// Results are cached 60s on globalThis (keyed by prUrl, capped at 100
// entries, oldest evicted) so reopening the same drawer doesn't respawn gh.
// globalThis keeps the cache across tsx-watch reloads — same pattern as the
// terminal pool and ghCli's probe cache.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { probeGhCli } from './ghCli'
import type { PrInfoResponse } from '@/lib/types'

const execFile = promisify(execFileCb)

// Strictly https://github.com/<owner>/<repo>/pull/<number> — no trailing
// path, query, or fragment. owner/repo follow GitHub's allowed charset
// (word chars, dots, hyphens); anything else is refused, which also keeps
// arbitrary strings from ever reaching the gh argv.
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/

export interface ParsedPrUrl {
  owner: string
  repo: string
  number: number
}

/** Parse a GitHub PR URL; null when it isn't exactly the canonical form. */
export const parsePrUrl = (url: string): ParsedPrUrl | null => {
  const m = PR_URL_RE.exec(url)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: Number(m[3]) }
}

const TTL_MS = 60_000
const MAX_ENTRIES = 100

type CacheEntry = { at: number; info: PrInfoResponse }

// Map preserves insertion order — eviction drops the oldest-inserted key.
const g = globalThis as typeof globalThis & {
  __openground_pr_info?: Map<string, CacheEntry>
}

const cache = (): Map<string, CacheEntry> =>
  (g.__openground_pr_info ??= new Map())

/** Cached value for prUrl, or null when absent/expired. Exported for tests. */
export const prInfoCacheGet = (prUrl: string, now = Date.now()): PrInfoResponse | null => {
  const hit = cache().get(prUrl)
  if (!hit) return null
  if (now - hit.at >= TTL_MS) {
    cache().delete(prUrl)
    return null
  }
  return hit.info
}

/** Store a result, evicting the oldest entries past the cap. Exported for tests. */
export const prInfoCachePut = (prUrl: string, info: PrInfoResponse, now = Date.now()): void => {
  const c = cache()
  c.delete(prUrl) // re-insert so a refresh moves the key to the newest slot
  c.set(prUrl, { at: now, info })
  while (c.size > MAX_ENTRIES) {
    const oldest = c.keys().next().value as string | undefined
    if (oldest === undefined) break
    c.delete(oldest)
  }
}

/** Test hook: drop the whole cache. */
export const prInfoCacheClear = (): void => {
  cache().clear()
}

const UNAVAILABLE: PrInfoResponse = { available: false }

/** PR state + diff stats for the drawer's status strip. Never throws. */
export const fetchPrInfo = async (
  projectPath: string,
  prUrl: string,
): Promise<PrInfoResponse> => {
  // Malformed URL → silently unavailable (and never spawned into gh argv).
  if (!parsePrUrl(prUrl)) return UNAVAILABLE

  // Preconditions: gh installed AND authenticated (probe is itself cached).
  const gh = await probeGhCli()
  if (!gh.installed || !gh.authenticated) return UNAVAILABLE

  const cached = prInfoCacheGet(prUrl)
  if (cached) return cached

  let info: PrInfoResponse
  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'view', prUrl, '--json', 'state,title,additions,deletions,mergedAt,isDraft'],
      {
        cwd: projectPath,
        timeout: 15_000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
      },
    )
    const json = JSON.parse(stdout) as {
      state?: unknown
      title?: unknown
      additions?: unknown
      deletions?: unknown
      isDraft?: unknown
    }
    const state = json.state
    if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') {
      info = UNAVAILABLE
    } else {
      info = {
        available: true,
        state,
        title: typeof json.title === 'string' ? json.title : '',
        additions: typeof json.additions === 'number' ? json.additions : 0,
        deletions: typeof json.deletions === 'number' ? json.deletions : 0,
        isDraft: json.isDraft === true,
      }
    }
  } catch {
    // gh failed (404, network, timeout, repo mismatch) — quietly unavailable.
    info = UNAVAILABLE
  }
  // Failures are cached too: a dead PR link must not respawn gh on every
  // drawer open within the TTL.
  prInfoCachePut(prUrl, info)
  return info
}
