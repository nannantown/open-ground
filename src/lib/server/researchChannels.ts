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

/** The newest CPython on this machine, as `[major, minor]`, or null when none
 *  could be run. Injectable for tests. */
export type PythonVersionProbe = () => [number, number] | null

/** rdt-cli's own floor (pyproject `requires-python = ">=3.10"`). A pipx install
 *  under an older default interpreter fails with a resolver error that says
 *  nothing about Python — which is exactly what it did on the owner's machine
 *  (3.9.9, 2026-08-15): the app handed over a command and the command lost. */
export const RDT_MIN_PYTHON: [number, number] = [3, 10]

/** Spellings worth trying, newest first, so `pipx --python` can be pointed at a
 *  modern interpreter even when the DEFAULT python3 is too old — which is the
 *  common shape (a system 3.9 plus a brew 3.12 nobody made default). */
const PY_CANDIDATES = [
  'python3.13',
  'python3.12',
  'python3.11',
  'python3.10',
  'python3',
  'python',
]

const parsePyVersion = (out: string): [number, number] | null => {
  const m = /(\d+)\.(\d+)/.exec(out.trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

const atLeast = (v: [number, number], min: [number, number]): boolean =>
  v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])

/** Find an interpreter that clears the floor, newest spelling first. Returns the
 *  SPELLING, not the version, because that is what the command needs. */
export type PythonPickProbe = (min: [number, number]) => string | null

const defaultPythonPick: PythonPickProbe = (min) => {
  for (const py of PY_CANDIDATES) {
    try {
      const r = spawnSync(py, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'], {
        timeout: 3000,
        encoding: 'utf8',
      })
      if (r.status !== 0) continue
      const v = parsePyVersion(String(r.stdout ?? ''))
      if (v && atLeast(v, min)) return py
    } catch {
      // try the next spelling
    }
  }
  return null
}

export interface ChannelCheckOpts {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Is a file at this absolute path present (and a file)? Injectable for tests. */
  exists?: (p: string) => boolean
  probeFeedparser?: FeedparserProbe
  /** Which python spelling clears a version floor, or null when none does.
   *  Injectable for tests; the default runs a bounded local probe. */
  pickPython?: PythonPickProbe
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
  pickPython: PythonPickProbe,
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
    // The twitter CLI ships inside Agent-Reach itself, and rdt-cli is its
    // pinned sibling — both verbatim from the upstream install doc
    // (raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md,
    // fetched 2026-08-14). pipx works on every platform.
    case 'twitter':
      return 'pipx install https://github.com/Panniantong/agent-reach/archive/main.zip'
    case 'reddit': {
      // ⚠ A COMMAND THAT FAILS IS WORSE THAN NO COMMAND. rdt-cli needs Python
      // >= 3.10; pipx builds against the DEFAULT interpreter, so on a machine
      // whose python3 is older this one-liner dies in the resolver with an error
      // that never mentions Python. That happened to the owner (3.9.9,
      // 2026-08-15) — the app told them to run something, they ran it, and it
      // lost. So: find an interpreter that clears the floor and POINT pipx at
      // it; if none exists, offer NO command at all and let the panel's guidance
      // text say what is actually needed.
      const py = pickPython(RDT_MIN_PYTHON)
      if (!py) return undefined
      const src = "'git+https://github.com/public-clis/rdt-cli.git'"
      // No --python when the default already qualifies: the plain form is the
      // upstream one, and an unnecessary flag is one more thing to get wrong.
      return py === 'python3' || py === 'python'
        ? `pipx install ${src}`
        : `pipx install --python ${py} ${src}`
    }
    default:
      return undefined // web needs none (curl ships with macOS/Win10+)
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
  'twitter.cookies-only': 'miss', // still unusable — but the copy must say the cookies took
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
        // 'cookies-only' exists so the panel can ACKNOWLEDGE saved cookies even
        // while the binary is missing — the owner's first field report
        // (2026-08-14) was exactly this state reading as "Not set up" with no
        // hint that their input had registered at all.
        return has('twitter') ? (cookies ? 'full' : 'bin-only') : cookies ? 'cookies-only' : 'missing'
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

  // The command rides along only in the states it would actually change —
  // e.g. reddit with rdt INSTALLED is 'part' (auth unknowable), and offering
  // "install rdt" there would contradict the row's own text.
  const COMMAND_HELPS: Record<ResearchChannelId, readonly string[]> = {
    web: [],
    websearch: ['missing'],
    twitter: ['missing', 'cookies-only'],
    reddit: ['baseline', 'unreachable'],
    youtube: ['missing'],
    github: ['baseline', 'unreachable'],
    rss: ['no-feedparser'],
  }

  const IDS: ResearchChannelId[] = ['web', 'websearch', 'twitter', 'reddit', 'youtube', 'github', 'rss']
  return IDS.map((id) => {
    const d = detail(id)
    const status = STATUS_BY_DETAIL[`${id}.${d}`]
    const cmd = COMMAND_HELPS[id].includes(d)
      ? unlockCommand(id, platform, opts.pickPython ?? defaultPythonPick)
      : undefined
    return { id, status, detail: d, ...(cmd ? { unlockCommand: cmd } : {}) }
  })
}
