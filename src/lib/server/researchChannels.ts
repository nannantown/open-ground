// researchChannels — the server-side, cross-platform channel checker behind
// Settings → Research channels (GET /api/research/channels).
//
// WHY THIS EXISTS NEXT TO THE BASH DOCTOR. scripts/openground-research-doctor.sh
// is the WORKER-facing CLI (runs in a worker's shell, bash, macOS/linux). The
// Settings panel needs the same verdicts on every platform Windows included,
// with UI-grade structure (stable ids + enumerable detail variants the i18n
// layer maps to copy) — so the checks live here in Node too. The two are kept
// in step by tests asserting the same scenario table on each
// (researchChannels.test.ts / researchSystem.test.ts); a drift is a test
// failure, not a silent split-brain.
//
// CONTRACT (mirrors the doctor's):
//   - LOCAL ONLY. Binary presence = a PATH scan (no subprocess), plus one
//     bounded local `python -c "import feedparser"` probe. Never the network.
//   - Never throws: an unreadable PATH entry just reads as "not there".
//   - BASELINES (2026-08-14, the zero-setup widening): web / github / reddit /
//     rss are usable through plain `curl` fetches of public endpoints even
//     with no dedicated tool installed — those report 'part', never 'miss',
//     as long as curl exists. 'miss' means the channel is truly unusable.

import { spawnSync } from 'child_process'
import { statSync } from 'fs'
import { posix, win32 } from 'path'
import type {
  ResearchChannelId,
  ResearchChannelState,
  ResearchChannelStatus,
} from '../types'

/** One bounded, local-only subprocess: does the user's python import feedparser?
 *  Injectable for tests (the default runs python3, then python on win32). */
export type FeedparserProbe = () => boolean

const defaultFeedparserProbe: FeedparserProbe = () => {
  for (const py of process.platform === 'win32' ? ['python', 'python3'] : ['python3']) {
    try {
      const r = spawnSync(py, ['-c', 'import feedparser'], { timeout: 3000, stdio: 'ignore' })
      if (r.status === 0) return true
      if (r.status !== null) return false // python ran and said no
    } catch {
      // try the next spelling
    }
  }
  return false
}

export interface ChannelCheckOpts {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Is a file at this absolute path present (and a file)? Injectable for tests. */
  exists?: (p: string) => boolean
  probeFeedparser?: FeedparserProbe
  /** Cookies saved through Settings (researchAuth.ts) — resolved by the caller
   *  so this module stays free of fs/store concerns. */
  storedTwitterAuth?: boolean
}

const defaultExists = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** PATH-scan binary presence — the Node spelling of the doctor's `command -v`.
 *  win32 honours PATHEXT (yt-dlp.exe, gh.cmd, …); elsewhere the bare name. */
export const hasBinary = (
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = defaultExists,
): boolean => {
  // Join + split by the DECLARED platform, not the host — the checker must
  // evaluate a win32 machine's PATH correctly even when a test (or a future
  // remote view) runs it elsewhere. ':' would split 'C:\bin' itself.
  const path = platform === 'win32' ? win32 : posix
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const suffixes =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const d of dirs) {
    for (const s of suffixes) {
      if (exists(path.join(d, name + s.toLowerCase())) || (s && exists(path.join(d, name + s)))) {
        return true
      }
    }
  }
  return false
}

/** The install one-liner the panel offers to copy — per platform, only where a
 *  single honest command exists (no command ⇒ the UI shows guidance text only). */
const unlockCommand = (
  id: ResearchChannelId,
  platform: NodeJS.Platform,
): string | undefined => {
  switch (id) {
    case 'youtube':
      return platform === 'darwin'
        ? 'brew install yt-dlp'
        : platform === 'win32'
          ? 'winget install yt-dlp.yt-dlp'
          : 'pipx install yt-dlp'
    case 'github':
      return platform === 'darwin'
        ? 'brew install gh'
        : platform === 'win32'
          ? 'winget install GitHub.cli'
          : undefined
    case 'websearch':
      return 'npm i -g mcporter'
    case 'rss':
      return platform === 'win32' ? 'pip install feedparser' : 'pip3 install feedparser'
    default:
      return undefined // twitter/reddit CLIs have no one-liner; web needs none
  }
}

const STATUS_BY_DETAIL: Record<string, ResearchChannelStatus> = {
  // web
  'web.ready': 'ok',
  'web.no-curl': 'miss',
  // websearch
  'websearch.ready': 'ok',
  'websearch.missing': 'miss',
  // twitter
  'twitter.full': 'ok',
  'twitter.bin-only': 'part',
  'twitter.missing': 'miss',
  // reddit — never better than 'part': login state is only knowable at run time
  'reddit.cli': 'part',
  'reddit.baseline': 'part',
  'reddit.unreachable': 'miss',
  // youtube
  'youtube.ready': 'ok',
  'youtube.missing': 'miss',
  // github
  'github.cli': 'ok',
  'github.baseline': 'part',
  'github.unreachable': 'miss',
  // rss
  'rss.full': 'ok',
  'rss.no-feedparser': 'part',
  'rss.baseline': 'part',
  'rss.unreachable': 'miss',
}

/** Evaluate every research channel. Pure given its opts (the default opts read
 *  this process's env/PATH + one local python probe). */
export const listResearchChannels = (opts: ChannelCheckOpts = {}): ResearchChannelState[] => {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const exists = opts.exists ?? defaultExists
  const has = (name: string) => hasBinary(name, env, platform, exists)

  const curl = has('curl')
  const cookieEnv = !!env.TWITTER_AUTH_TOKEN && !!env.TWITTER_CT0
  const cookies = cookieEnv || !!opts.storedTwitterAuth

  const detail = (id: ResearchChannelId): string => {
    switch (id) {
      case 'web':
        return curl ? 'ready' : 'no-curl'
      case 'websearch':
        return has('mcporter') ? 'ready' : 'missing'
      case 'twitter':
        return has('twitter') ? (cookies ? 'full' : 'bin-only') : 'missing'
      case 'reddit':
        return has('rdt') ? 'cli' : curl ? 'baseline' : 'unreachable'
      case 'youtube':
        return has('yt-dlp') ? 'ready' : 'missing'
      case 'github':
        return has('gh') ? 'cli' : curl ? 'baseline' : 'unreachable'
      case 'rss': {
        const probe = opts.probeFeedparser ?? defaultFeedparserProbe
        const py = platform === 'win32' ? has('python') || has('python3') : has('python3')
        if (py && probe()) return 'full'
        if (py) return 'no-feedparser' // python can still fetch; feedparser just makes it sturdier
        return curl ? 'baseline' : 'unreachable'
      }
    }
  }

  const IDS: ResearchChannelId[] = ['web', 'websearch', 'twitter', 'reddit', 'youtube', 'github', 'rss']
  return IDS.map((id) => {
    const d = detail(id)
    const status = STATUS_BY_DETAIL[`${id}.${d}`]
    const cmd = status === 'ok' ? undefined : unlockCommand(id, platform)
    return { id, status, detail: d, ...(cmd ? { unlockCommand: cmd } : {}) }
  })
}
