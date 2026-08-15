// @vitest-environment node
//
// researchChannels — the Node checker behind Settings → Research channels.
// Scenario table kept deliberately parallel to the bash doctor's tests in
// researchSystem.test.ts: same machine states, same verdicts, two
// implementations — a drift between them must fail HERE, not in the field.

import { describe, it, expect } from 'vitest'
import { posix, win32 } from 'path'
import { hasBinary, listResearchChannels, RDT_MIN_PYTHON } from './researchChannels'
import type { ResearchChannelState } from '../types'

/** A fake machine: which binaries exist on PATH, which env vars are set.
 *  Paths are built with the DECLARED platform's joiner (matching hasBinary),
 *  so a win32 machine is modelled faithfully from this linux/mac test host. */
const machine = (opts: {
  bins?: string[]
  env?: Record<string, string>
  platform?: NodeJS.Platform
  feedparser?: boolean
  storedTwitterAuth?: boolean
  /** Which python spelling clears rdt-cli's floor. Defaults to the ordinary
   *  case (a modern default python3); `null` = nothing on this machine does. */
  python?: string | null
}) => {
  const platform = opts.platform ?? 'darwin'
  const path = platform === 'win32' ? win32 : posix
  const binDir = platform === 'win32' ? 'C:\\bin' : '/bin'
  const files = new Set(
    (opts.bins ?? []).map((b) => path.join(binDir, platform === 'win32' ? `${b}.exe` : b)),
  )
  return listResearchChannels({
    platform,
    env: { PATH: binDir, ...(platform === 'win32' ? { PATHEXT: '.EXE' } : {}), ...opts.env },
    exists: (p) => files.has(p),
    probeFeedparser: () => opts.feedparser ?? false,
    pickPython: () => (opts.python === undefined ? 'python3' : opts.python),
    storedTwitterAuth: opts.storedTwitterAuth ?? false,
  })
}

const byId = (channels: ResearchChannelState[], id: string): ResearchChannelState => {
  const c = channels.find((x) => x.id === id)
  expect(c, `channel ${id} missing from the result`).toBeDefined()
  return c!
}

describe('listResearchChannels — the scenario table', () => {
  it('bare machine (nothing on PATH): every channel is miss', () => {
    const cs = machine({ bins: [] })
    for (const c of cs) expect(c.status, c.id).toBe('miss')
  })

  it('curl alone: web ok; github/reddit baselines part; rss part; the rest miss', () => {
    const cs = machine({ bins: ['curl'] })
    expect(byId(cs, 'web')).toMatchObject({ status: 'ok', detail: 'ready' })
    expect(byId(cs, 'github')).toMatchObject({ status: 'part', detail: 'baseline' })
    expect(byId(cs, 'reddit')).toMatchObject({ status: 'part', detail: 'baseline' })
    expect(byId(cs, 'rss')).toMatchObject({ status: 'part', detail: 'baseline' })
    expect(byId(cs, 'websearch').status).toBe('miss')
    expect(byId(cs, 'twitter').status).toBe('miss')
    expect(byId(cs, 'youtube').status).toBe('miss')
  })

  it('fully equipped: everything ok except reddit (auth only knowable at run time)', () => {
    const cs = machine({
      bins: ['curl', 'mcporter', 'twitter', 'rdt', 'yt-dlp', 'gh', 'python3'],
      env: { TWITTER_AUTH_TOKEN: 't', TWITTER_CT0: 'c' },
      feedparser: true,
    })
    expect(byId(cs, 'web').status).toBe('ok')
    expect(byId(cs, 'websearch').status).toBe('ok')
    expect(byId(cs, 'twitter')).toMatchObject({ status: 'ok', detail: 'full' })
    expect(byId(cs, 'reddit')).toMatchObject({ status: 'part', detail: 'cli' })
    expect(byId(cs, 'youtube').status).toBe('ok')
    expect(byId(cs, 'github')).toMatchObject({ status: 'ok', detail: 'cli' })
    expect(byId(cs, 'rss')).toMatchObject({ status: 'ok', detail: 'full' })
  })

  it('twitter: cookies WITHOUT the binary is acknowledged (cookies-only), with the install command attached', () => {
    // The owner's first field report (2026-08-14): cookies entered, binary
    // absent — the row read as a bare "Not set up" as if the input vanished.
    const c = byId(machine({ bins: [], storedTwitterAuth: true }), 'twitter')
    expect(c).toMatchObject({ status: 'miss', detail: 'cookies-only' })
    expect(c.unlockCommand).toContain('pipx install')
  })

  it('reddit with rdt INSTALLED gets no install command (it would contradict the row text)', () => {
    expect(byId(machine({ bins: ['rdt'] }), 'reddit').unlockCommand).toBeUndefined()
    // …while the not-installed states do offer it.
    expect(byId(machine({ bins: ['curl'] }), 'reddit').unlockCommand).toContain('rdt-cli')
  })

  it('twitter: binary without cookies is part; STORED cookies count the same as env', () => {
    expect(byId(machine({ bins: ['twitter'] }), 'twitter')).toMatchObject({
      status: 'part',
      detail: 'bin-only',
    })
    // Settings-stored cookies (researchAuth) must unlock exactly like the env pair.
    expect(
      byId(machine({ bins: ['twitter'], storedTwitterAuth: true }), 'twitter'),
    ).toMatchObject({ status: 'ok', detail: 'full' })
    // One env var without the other is NOT signed in.
    expect(
      byId(machine({ bins: ['twitter'], env: { TWITTER_AUTH_TOKEN: 't' } }), 'twitter').detail,
    ).toBe('bin-only')
  })

  it('rss: python without feedparser is part (sturdier-parse hint), with the pip command offered', () => {
    const c = byId(machine({ bins: ['python3'] }), 'rss')
    expect(c).toMatchObject({ status: 'part', detail: 'no-feedparser' })
    expect(c.unlockCommand).toBe('pip3 install feedparser')
  })

  it('unlock commands are platform-aware and absent once a channel is ok', () => {
    expect(byId(machine({ bins: [] }), 'youtube').unlockCommand).toBe('brew install yt-dlp')
    expect(
      byId(machine({ bins: [], platform: 'win32' }), 'youtube').unlockCommand,
    ).toBe('winget install yt-dlp.yt-dlp')
    expect(byId(machine({ bins: ['yt-dlp'] }), 'youtube').unlockCommand).toBeUndefined()
  })

  it('hasBinary honours PATHEXT on win32 and plain names elsewhere', () => {
    const exists = (p: string) => p === 'C:\\bin\\gh.exe' || p === '/bin/gh'
    expect(hasBinary('gh', { PATH: 'C:\\bin', PATHEXT: '.EXE' }, 'win32', exists)).toBe(true)
    expect(hasBinary('gh', { PATH: '/bin' }, 'darwin', exists)).toBe(true)
    expect(hasBinary('gh', { PATH: '/elsewhere' }, 'darwin', exists)).toBe(false)
  })
})

// ─── the reddit unlock command must actually RUN ─────────────────────────────
//
// FIELD REPORT, 2026-08-15. The panel offered
//   pipx install 'git+https://github.com/public-clis/rdt-cli.git'
// the owner ran it, and it died in the resolver — rdt-cli requires Python >=
// 3.10 and their default python3 was 3.9.9. The error never says "Python".
//
// A command that fails is worse than no command: it costs the person a try,
// teaches them nothing, and reads as the app being broken. So the version is
// probed BEFORE the command is offered.
describe('reddit unlock — never hand over a command that will fail', () => {
  const cmdFor = (python: string | null | undefined) =>
    byId(machine({ bins: ['curl'], ...(python === undefined ? {} : { python }) }), 'reddit')
      .unlockCommand

  it('offers the plain upstream command when the DEFAULT python qualifies', () => {
    // No --python flag: the plain form is the upstream one, and an unnecessary
    // flag is one more thing to get wrong.
    expect(cmdFor('python3')).toBe(
      "pipx install 'git+https://github.com/public-clis/rdt-cli.git'",
    )
  })

  it('POINTS pipx at a newer interpreter when one exists beside an old default', () => {
    // The common shape: a system 3.9 plus a brew 3.12 nobody made default.
    expect(cmdFor('python3.12')).toBe(
      "pipx install --python python3.12 'git+https://github.com/public-clis/rdt-cli.git'",
    )
  })

  it('offers NO COMMAND when nothing on the machine clears the floor', () => {
    // ⚠ THE WHOLE POINT. Silence here is honest — the panel's guidance text
    // still says what the channel needs — while a command is a promise that it
    // will work.
    expect(cmdFor(null)).toBeUndefined()
  })

  it('the floor is rdt-cli own requires-python', () => {
    expect(RDT_MIN_PYTHON).toEqual([3, 10])
  })

  it('an INSTALLED rdt still gets no command, whatever python says', () => {
    // Unchanged by this work: offering an install command beside "installed"
    // contradicts the row's own text.
    expect(byId(machine({ bins: ['rdt'], python: null }), 'reddit').unlockCommand).toBeUndefined()
    expect(byId(machine({ bins: ['rdt'], python: 'python3' }), 'reddit').unlockCommand).toBeUndefined()
  })
})
