import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disableShare,
  enableShare,
  fetchShareStatus,
  remoteShortName,
  syncShare,
} from './shareClient'

// ── remoteShortName (pure parser for the faint label next to Sync) ─────────

describe('remoteShortName', () => {
  it('parses scp-like github remotes', () => {
    expect(remoteShortName('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(remoteShortName('git@github.com:owner/repo')).toBe('owner/repo')
  })

  it('parses https remotes and strips .git', () => {
    expect(remoteShortName('https://github.com/owner/repo.git')).toBe('owner/repo')
    expect(remoteShortName('https://github.com/owner/repo')).toBe('owner/repo')
    // Trailing slash must not produce an empty repo segment.
    expect(remoteShortName('https://github.com/owner/repo/')).toBe('owner/repo')
  })

  it('parses ssh:// remotes without eating the port', () => {
    expect(remoteShortName('ssh://git@gitlab.com:2222/owner/repo.git')).toBe(
      'owner/repo',
    )
  })

  it('keeps only the last two segments for nested (sub-group) paths', () => {
    expect(remoteShortName('https://gitlab.com/group/sub/repo.git')).toBe(
      'sub/repo',
    )
    expect(remoteShortName('git@gitlab.com:group/sub/repo.git')).toBe('sub/repo')
  })

  it('handles single-segment and local-path remotes', () => {
    expect(remoteShortName('/srv/git/repo.git')).toBe('git/repo')
    expect(remoteShortName('git@host.example:repo.git')).toBe('repo')
  })

  it('is case-insensitive about the .git suffix only at the end', () => {
    expect(remoteShortName('https://github.com/owner/repo.GIT')).toBe('owner/repo')
    expect(remoteShortName('https://github.com/owner/my.gitops')).toBe(
      'owner/my.gitops',
    )
  })

  it('returns null for null / blank / unparseable input', () => {
    expect(remoteShortName(null)).toBeNull()
    expect(remoteShortName('')).toBeNull()
    expect(remoteShortName('   ')).toBeNull()
    expect(remoteShortName('https://')).toBeNull()
  })
})

// ── fetch wrappers (graceful degradation while the routes don't exist) ─────

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchShareStatus', () => {
  it('returns the normalised status on a contract-shaped 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          shared: true,
          gitRepo: true,
          remoteUrl: 'git@github.com:o/r.git',
          dirty: true,
        }),
      ),
    )
    expect(await fetchShareStatus('/p')).toEqual({
      shared: true,
      gitRepo: true,
      remoteUrl: 'git@github.com:o/r.git',
      dirty: true,
      // ahead/behind absent in the body (older server) → default 0.
      ahead: 0,
      behind: 0,
    })
  })

  it('returns null on 404 (routes not deployed yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'Not found' })))
    expect(await fetchShareStatus('/p')).toBeNull()
  })

  it('returns null on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('refused'))))
    expect(await fetchShareStatus('/p')).toBeNull()
  })

  it('returns null on a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { nope: 1 })))
    expect(await fetchShareStatus('/p')).toBeNull()
  })

  it('URL-encodes the project path', async () => {
    const f = vi.fn(async () => jsonResponse(200, { shared: false, gitRepo: true, remoteUrl: null, dirty: false }))
    vi.stubGlobal('fetch', f)
    await fetchShareStatus('/Users/k/My Project')
    expect(f).toHaveBeenCalledWith(
      '/api/project/share/status?path=%2FUsers%2Fk%2FMy%20Project',
      expect.anything(),
    )
  })
})

describe('enableShare / disableShare', () => {
  it('maps {ok:true} through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })))
    expect(await enableShare('/p')).toEqual({ ok: true })
    expect(await disableShare('/p')).toEqual({ ok: true })
  })

  it('surfaces the server error message on a 412-style failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(412, { error: 'not a git repo' })),
    )
    expect(await enableShare('/p')).toEqual({ ok: false, error: 'not a git repo' })
  })

  it('degrades to an error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('refused'))))
    const r = await enableShare('/p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('refused')
  })
})

describe('syncShare', () => {
  it('returns the contract result, including conflict + message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          ok: false,
          committed: true,
          pulled: false,
          pushed: false,
          conflict: true,
          message: 'rebase conflict — pull manually',
        }),
      ),
    )
    const r = await syncShare('/p')
    expect(r).toEqual({
      result: {
        ok: false,
        committed: true,
        pulled: false,
        pushed: false,
        conflict: true,
        message: 'rebase conflict — pull manually',
      },
    })
  })

  it('treats a body without the contract shape as a transport error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: 'Not found' })),
    )
    expect(await syncShare('/p')).toEqual({ error: 'Not found' })
  })

  it('degrades to an error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('refused'))))
    expect(await syncShare('/p')).toEqual({ error: 'refused' })
  })
})
