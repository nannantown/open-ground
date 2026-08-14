// @vitest-environment node
//
// researchChannels — the Node checker behind Settings → Research channels.
// Scenario table kept deliberately parallel to the bash doctor's tests in
// researchSystem.test.ts: same machine states, same verdicts, two
// implementations — a drift between them must fail HERE, not in the field.

import { describe, it, expect } from 'vitest'
import { posix, win32 } from 'path'
import { hasBinary, listResearchChannels } from './researchChannels'
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
