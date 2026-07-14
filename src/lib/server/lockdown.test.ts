import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  isEgressAllowedUnderLockdown,
  installLockdownFetchGuard,
  setLockdownCache,
  isLockdownEnabledSync,
  LockdownEgressError,
} from './lockdown'
import { getFreshSession, postToken } from './supabaseAuth'
import { createBoardMirror, type MirrorDeps, type BoardMirror } from './collabMirror'
import { openScopedDoc } from './collabMirrorCore'
import { setSettings } from './store'
import { writeSession, clearSession } from './authStore'
import * as Y from 'yjs'
import type { ProjectData } from '../types'

// Work mode (lockdown) LAYER 2 — the fetch floor — plus the supabaseAuth
// central seam (getFreshSession/postToken), which is what keeps every Supabase
// REST caller (projectMembers / collabInvites / roles) off the network.

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await clearSession()
  await setSettings({ lockdownMode: false })
})

describe('isEgressAllowedUnderLockdown — the allow predicate', () => {
  it('allows loopback (the app talking to itself)', () => {
    expect(isEgressAllowedUnderLockdown('http://127.0.0.1:47776/api/health')).toBe(true)
    expect(isEgressAllowedUnderLockdown('http://localhost:5174/x')).toBe(true)
    expect(isEgressAllowedUnderLockdown('http://[::1]:47776/')).toBe(true)
  })

  it('allows Anthropic hosts (the subscription path) — incl. subdomains', () => {
    expect(isEgressAllowedUnderLockdown('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isEgressAllowedUnderLockdown('https://statsig.anthropic.com/x')).toBe(true)
    expect(isEgressAllowedUnderLockdown('https://claude.ai/login')).toBe(true)
  })

  it('refuses every other external host', () => {
    expect(isEgressAllowedUnderLockdown('https://api.github.com/repos/x/y')).toBe(false)
    expect(isEgressAllowedUnderLockdown('https://example.supabase.co/rest/v1/t')).toBe(false)
    expect(isEgressAllowedUnderLockdown('https://og-collab.example.workers.dev/ticket')).toBe(false)
    // A lookalike must not pass the suffix match.
    expect(isEgressAllowedUnderLockdown('https://notanthropic.com/')).toBe(false)
    expect(isEgressAllowedUnderLockdown('https://anthropic.com.evil.example/')).toBe(false)
  })

  it('passes non-http(s) schemes and refuses garbage', () => {
    expect(isEgressAllowedUnderLockdown('data:text/plain,hi')).toBe(true)
    expect(isEgressAllowedUnderLockdown('not a url')).toBe(false)
  })
})

describe('installLockdownFetchGuard — the floor around global fetch', () => {
  it('ON: external hosts throw LockdownEgressError; loopback + anthropic pass through', async () => {
    const real = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', real)
    await setSettings({ lockdownMode: true })
    const uninstall = await installLockdownFetchGuard()
    try {
      await expect(fetch('https://api.github.com/x')).rejects.toBeInstanceOf(
        LockdownEgressError,
      )
      expect(real).not.toHaveBeenCalled()

      await fetch('http://127.0.0.1:47776/api/health')
      await fetch('https://api.anthropic.com/v1/x')
      expect(real).toHaveBeenCalledTimes(2)
    } finally {
      uninstall()
    }
  })

  it('OFF: everything passes straight through', async () => {
    const real = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', real)
    await setSettings({ lockdownMode: false })
    const uninstall = await installLockdownFetchGuard()
    try {
      await fetch('https://api.github.com/x')
      expect(real).toHaveBeenCalledTimes(1)
    } finally {
      uninstall()
    }
  })

  it('the toggle is live: flipping settings flips the floor without reinstalling', async () => {
    const real = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', real)
    await setSettings({ lockdownMode: false })
    const uninstall = await installLockdownFetchGuard()
    try {
      await fetch('https://api.github.com/x') // off → passes
      await setSettings({ lockdownMode: true }) // mirrors the cache on write
      await expect(fetch('https://api.github.com/x')).rejects.toBeInstanceOf(
        LockdownEgressError,
      )
      await setSettings({ lockdownMode: false })
      await fetch('https://api.github.com/x') // back on air
      expect(real).toHaveBeenCalledTimes(2)
    } finally {
      uninstall()
    }
  })
})

describe('the sync mirror', () => {
  it('follows setLockdownCache and only a literal true counts', () => {
    setLockdownCache(true)
    expect(isLockdownEnabledSync()).toBe(true)
    setLockdownCache('true')
    expect(isLockdownEnabledSync()).toBe(false)
    setLockdownCache(false)
    expect(isLockdownEnabledSync()).toBe(false)
  })
})

describe('supabaseAuth under lockdown — the central token seam goes quiet', () => {
  it('getFreshSession → null with an EXPIRED stored session (no refresh fetch)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await writeSession({
      user: { id: 'u1', email: 'a@example.com', provider: 'google' },
      expiresAt: Date.now() - 1000,
      accessToken: 'stale',
      refreshToken: 'valid-refresh',
    })
    const spy = vi.fn(async () => {
      throw new Error('unexpected egress')
    })
    vi.stubGlobal('fetch', spy)
    await setSettings({ lockdownMode: true }) // warms the sync mirror
    expect(await getFreshSession()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('postToken → null without fetching', async () => {
    const spy = vi.fn(async () => {
      throw new Error('unexpected egress')
    })
    vi.stubGlobal('fetch', spy)
    await setSettings({ lockdownMode: true })
    const out = await postToken(
      { url: 'https://example.supabase.co', anonKey: 'k' },
      'refresh_token',
      { refresh_token: 'r' },
    )
    expect(out).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── The SERVER-SIDE collab mirror (its own `ws` WebSocket to the Worker) ─────
// The Hono process itself dials the Worker to mirror board/canvas writes into
// the shared Y.Doc (collabMirrorCore) — a WS the fetch floor cannot see. The
// queue front door + openScopedDoc must both go quiet under lockdown.

describe('collabMirror under lockdown — the server-side Worker WS never dials', () => {
  const boardData = (updatedAt: string): ProjectData => ({
    description: '',
    tasks: [],
    notes: '',
    updatedAt,
  })

  let mirror: BoardMirror | null = null
  afterEach(() => {
    mirror?.reset()
    mirror = null
  })

  it('queue is a no-op while ON (no pid lookup, no doc open); resumes after OFF', async () => {
    let resolveCalls = 0
    let openCalls = 0
    const doc = new Y.Doc()
    const deps: MirrorDeps = {
      canonicalize: async (p) => p,
      resolvePid: async () => {
        resolveCalls += 1
        return 'pid-1'
      },
      openDoc: async () => {
        openCalls += 1
        return { doc, destroy: () => {} }
      },
      seenStore: { load: async () => null, save: async () => {} },
      idleMs: 60_000,
      retryDelaysMs: [10, 10, 10],
      pidTtlMs: 60_000,
    }
    mirror = createBoardMirror(deps)

    await setSettings({ lockdownMode: true })
    mirror.queue('/proj', boardData('2026-07-14T01:00:00.000Z'))
    await mirror.settle('/proj')
    expect(resolveCalls).toBe(0)
    expect(openCalls).toBe(0)

    await setSettings({ lockdownMode: false })
    mirror.queue('/proj', boardData('2026-07-14T02:00:00.000Z'))
    await mirror.settle('/proj')
    expect(openCalls).toBe(1)
    doc.destroy()
  })

  it('openScopedDoc throws before any transport work while ON', async () => {
    await setSettings({ lockdownMode: true })
    await expect(openScopedDoc('pid-1', 'board')).rejects.toThrow(/work mode/i)
  })
})
