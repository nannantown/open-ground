import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  blogPublishTick,
  draftPayload,
  sweepProjectBlogPublish,
  MAX_PUSHES_PER_SWEEP,
  readBlogInfo,
} from './blogPublish'
import { addImportedProjectEntry, __resetMigrationCacheForTests } from './registry'
import { getSettings, setSettings, setUserSettings, normalizeWordPressSettings } from './store'
import { setLockdownCache } from './lockdown'
import type { WordPressSettings } from '../types'

// blogPublish — research reports → WordPress DRAFTS. The whole feature stands
// on four promises (docs/BLOG_PUBLISH_PITCH.md): drafts only / one report =
// one post / the owner's WP-side hand always wins / a WP-side delete stands
// unless the report itself is redone. Each is pinned here against a fake WP
// that records every request — the observable is the WIRE (what was sent
// where), not "the function returned".

const WP: WordPressSettings = {
  baseUrl: 'https://blog.example',
  username: 'owner',
  appPassword: 'app-pass-xyzzy',
}

/** In-memory WordPress: enough of /wp-json/wp/v2/posts to drive the sweep. */
const fakeWp = () => {
  const posts = new Map<number, { modified_gmt: string; status: string }>()
  const reqs: { method: string; url: string; body?: Record<string, unknown>; auth?: string }[] = []
  let nextId = 100
  let clock = 0
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    reqs.push({ method, url, body, auth: headers.authorization })
    const json = (status: number, payload: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response
    const m = /\/wp-json\/wp\/v2\/posts(?:\/(\d+))?/.exec(url)
    if (!m) return json(404, {})
    const id = m[1] ? Number(m[1]) : null
    if (method === 'POST' && id === null) {
      const pid = nextId++
      clock++
      const post = { modified_gmt: `2026-08-28T00:00:0${clock}`, status: String(body?.status ?? 'draft') }
      posts.set(pid, post)
      return json(201, { id: pid, ...post })
    }
    if (id === null || !posts.has(id)) return json(404, {})
    const post = posts.get(id)!
    if (method === 'GET') return json(200, { id, ...post })
    clock++
    post.modified_gmt = `2026-08-28T00:00:0${clock}`
    if (typeof body?.status === 'string') post.status = body.status
    return json(200, { id, ...post })
  }) as typeof fetch
  return { posts, reqs, fetchImpl, touch: (id: number) => { clock++; posts.get(id)!.modified_gmt = `owner-edit-${clock}` } }
}

let proj = ''

beforeEach(async () => {
  __resetMigrationCacheForTests()
  setLockdownCache(false)
  proj = await mkdtemp(join(tmpdir(), 'og-blog-'))
  await mkdir(join(proj, 'docs', 'research'), { recursive: true })
  await addImportedProjectEntry(proj)
})
afterEach(async () => {
  await rm(proj, { recursive: true, force: true })
})

const report = (name: string, md: string) => writeFile(join(proj, 'docs', 'research', name), md)

describe('sweepProjectBlogPublish — the four promises, on the wire', () => {
  it('a new report becomes a DRAFT, authenticated, with the heading as the title', async () => {
    await report('a.md', '# 調査A\n\n本文です。\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })

    expect(wp.reqs).toHaveLength(1)
    const r = wp.reqs[0]
    expect(r.method).toBe('POST')
    expect(r.url).toBe('https://blog.example/wp-json/wp/v2/posts')
    // Promise #1 — drafts only. 'draft' is stated on the wire, not assumed.
    expect(r.body?.status).toBe('draft')
    expect(r.body?.title).toBe('調査A')
    // The h1 became the WP title, so the body must not print it twice.
    expect(String(r.body?.content)).not.toContain('<h1>')
    expect(String(r.body?.content)).toContain('本文です。')
    expect(r.auth).toBe('Basic ' + Buffer.from('owner:app-pass-xyzzy').toString('base64'))

    const info = await readBlogInfo(proj)
    expect(info['a.md']?.state).toBe('draft')
    expect(info['a.md']?.link).toContain('post.php?post=100')
  })

  it('an unchanged report costs ZERO requests on the next sweep', async () => {
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    const after = wp.reqs.length
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs.length).toBe(after)
  })

  it('a rewritten report UPDATES its post — never a sibling draft (promise #2)', async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    await report('a.md', '# A\n\nv2 — redone\n')
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })

    // One create, ever.
    const creates = wp.reqs.filter((r) => r.method === 'POST' && /posts$/.test(r.url))
    expect(creates).toHaveLength(1)
    // The rewrite went to the SAME post id, and did NOT touch `status` — an
    // update must never flip a draft the owner is sitting on toward publish.
    const update = wp.reqs.find((r) => r.method === 'POST' && /posts\/100/.test(r.url))
    expect(update).toBeTruthy()
    expect(update?.body && 'status' in update.body).toBe(false)
    expect(String(update?.body?.content)).toContain('v2')
  })

  it("the owner's WP-side edit STOPS all future updates (promise #3 — the trust one)", async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    wp.touch(100) // the owner edits the draft on WordPress
    await report('a.md', '# A\n\nv2\n')
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })

    // The sweep LOOKED (GET) and then kept its hands off.
    expect(wp.reqs.filter((r) => r.method === 'POST' && /posts\/100/.test(r.url))).toHaveLength(0)
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('edited-on-wp')

    // …and 'edited-on-wp' is terminal: the next sweep does not even GET.
    const n = wp.reqs.length
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs.length).toBe(n)
  })

  it('a post the owner PUBLISHED is likewise hands-off, even if timestamps did not move', async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    wp.posts.get(100)!.status = 'publish' // status flipped without a timestamp drift
    await report('a.md', '# A\n\nv2\n')
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs.filter((r) => r.method === 'POST' && /posts\/100/.test(r.url))).toHaveLength(0)
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('edited-on-wp')
  })

  it('a WP-side DELETE stands — until the report is REDONE, which earns a fresh draft (promise #4)', async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    wp.posts.delete(100) // the owner deletes the draft

    // Rewrite → this sweep discovers the deletion and records it…
    await report('a.md', '# A\n\nv2 — redo\n')
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('deleted-on-wp')

    // …and the NEXT sweep creates a fresh draft for the redone report.
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    const creates = wp.reqs.filter((r) => r.method === 'POST' && /posts$/.test(r.url))
    expect(creates).toHaveLength(2)
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('draft')

    // A deletion with NO rewrite stays deleted: further sweeps stay silent.
    const n = wp.reqs.length
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs.length).toBe(n)
  })

  it('a failure is recorded scrubbed — the app password appears NOWHERE — and retried', async () => {
    await report('a.md', '# A\n\nv1\n')
    const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as typeof fetch
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: failing })
    const info = await readBlogInfo(proj)
    expect(info['a.md']?.state).toBe('failed')
    expect(info['a.md']?.error).toContain('500')
    expect(JSON.stringify(info)).not.toContain(WP.appPassword)

    // The retry happens even though the file has not changed.
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('draft')
  })

  it(`a first-enable backlog drains ${MAX_PUSHES_PER_SWEEP} per sweep, not all at once`, async () => {
    for (let i = 0; i < MAX_PUSHES_PER_SWEEP + 2; i++) await report(`r${i}.md`, `# R${i}\n\nbody\n`)
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs).toHaveLength(MAX_PUSHES_PER_SWEEP)
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs).toHaveLength(MAX_PUSHES_PER_SWEEP + 2)
  })
})

describe('blogPublishTick — the gates', () => {
  it('does nothing without Settings.wordpress (configuring it IS the opt-in)', async () => {
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await setSettings({ wordpress: undefined })
    await blogPublishTick({ fetchImpl: wp.fetchImpl })
    expect(wp.reqs).toHaveLength(0)
  })

  it('does nothing in lockdown, even fully configured', async () => {
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await setSettings({ wordpress: WP })
    setLockdownCache(true)
    try {
      await blogPublishTick({ fetchImpl: wp.fetchImpl })
      expect(wp.reqs).toHaveLength(0)
    } finally {
      setLockdownCache(false)
      await setSettings({ wordpress: undefined })
    }
  })

  it('configured ⇒ the registered project sweeps through the tick', async () => {
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await setSettings({ wordpress: WP })
    try {
      await blogPublishTick({ fetchImpl: wp.fetchImpl })
      expect(wp.reqs.length).toBeGreaterThan(0)
    } finally {
      await setSettings({ wordpress: undefined })
    }
  })
})

describe('draftPayload', () => {
  it('renders GFM (research reports lean on tables)', () => {
    const { html } = draftPayload('t.md', '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(html).toContain('<table>')
  })
  it('falls back to the filename when there is no heading', () => {
    const { title } = draftPayload('20260828-topic.md', 'no heading here\n')
    expect(title).toBe('20260828-topic')
  })
})

describe('Settings.wordpress — the door (normalizeWordPressSettings / setUserSettings)', () => {
  it('accepts https, trims, and strips the trailing slash', () => {
    expect(
      normalizeWordPressSettings({ baseUrl: ' https://eigotrip.com/ ', username: ' o ', appPassword: ' p ' }),
    ).toEqual({ baseUrl: 'https://eigotrip.com', username: 'o', appPassword: 'p' })
  })

  it('REFUSES plain http for a real host — Basic auth rides every request', () => {
    expect(
      normalizeWordPressSettings({ baseUrl: 'http://eigotrip.com', username: 'o', appPassword: 'p' }),
    ).toBeNull()
    // …but loopback http passes (local testing).
    expect(
      normalizeWordPressSettings({ baseUrl: 'http://127.0.0.1:8080', username: 'o', appPassword: 'p' }),
    ).not.toBeNull()
  })

  it('refuses a missing field and a garbage shape', () => {
    expect(normalizeWordPressSettings({ baseUrl: 'https://x.example', username: '', appPassword: 'p' })).toBeNull()
    expect(normalizeWordPressSettings('https://x.example')).toBeNull()
  })

  it('through the settings door: valid persists, garbage is dropped, null CLEARS', async () => {
    await setUserSettings({ wordpress: { baseUrl: 'https://x.example/', username: 'o', appPassword: 'p' } })
    expect((await getSettings()).wordpress).toEqual({ baseUrl: 'https://x.example', username: 'o', appPassword: 'p' })
    // Garbage patch → previous value survives (refuse-a-meaningless-patch).
    await setUserSettings({ wordpress: { baseUrl: 'notaurl', username: 'o', appPassword: 'p' } })
    expect((await getSettings()).wordpress?.baseUrl).toBe('https://x.example')
    // Explicit null → cleared, and the persisted file holds no null.
    await setUserSettings({ wordpress: null })
    expect((await getSettings()).wordpress).toBeUndefined()
  })
})
