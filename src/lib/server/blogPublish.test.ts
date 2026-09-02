import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  blogPublishTick,
  draftPayload,
  markResearchForBlog,
  sweepProjectBlogPublish,
  MAX_PUSHES_PER_SWEEP,
  readBlogInfo,
} from './blogPublish'
import { addImportedProjectEntry, __resetMigrationCacheForTests } from './registry'
import { getSettings, setSettings, setUserSettings, normalizeWordPressSettings } from './store'
import { setLockdownCache } from './lockdown'
import { projectDataFile } from './projectDataPath'
import type { WordPressSettings } from '../types'

// blogPublish — research reports → WordPress DRAFTS. The feature stands on five
// promises (docs/BLOG_PUBLISH_PITCH.md): drafts only / one report = one post /
// the owner's WP-side hand always wins / a WP-side delete stands unless the
// report is redone / ONLY CHOSEN REPORTS GO. Each is pinned against a fake WP
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
    // WordPress's own settings — `url` is `siteurl`, i.e. where wp-admin lives.
    // The fixture uses the OWNER'S SHAPE (2026-09-02): core in a subdirectory
    // (`/wp`) while the REST API answers at the site root. A fake that returned
    // the same string as baseUrl could not tell the fixed link from the old one.
    if (/\/wp-json\/wp\/v2\/settings\b/.test(url)) return json(200, { url: `${WP.baseUrl}/wp` })
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

/** Requests that touch POSTS — the "zero requests" contract is about pushes and
 *  their read-backs, not the one-time `/settings` read that locates wp-admin. */
const postReqs = <T extends { url: string }>(reqs: T[]): T[] =>
  reqs.filter((r) => r.url.includes('/wp/v2/posts'))

let proj = ''

beforeEach(async () => {
  __resetMigrationCacheForTests()
  setLockdownCache(false)
  proj = await mkdtemp(join(tmpdir(), 'og-blog-'))
  await mkdir(join(proj, 'docs', 'research'), { recursive: true })
  await addImportedProjectEntry(proj)
})
afterEach(async () => {
  await setSettings({ wordpress: undefined })
  await rm(proj, { recursive: true, force: true })
})

const report = (name: string, md: string) => writeFile(join(proj, 'docs', 'research', name), md)

/** Press the 「ブログへ」 button on each file — the real entry point, with the
 *  given fake WP behind it (marks wanted + pushes that one report). */
const press = async (fetchImpl: typeof fetch, ...files: string[]) => {
  await setSettings({ wordpress: WP })
  try {
    for (const f of files) await markResearchForBlog(proj, f, { fetchImpl })
  } finally {
    await setSettings({ wordpress: undefined })
  }
}

describe('sweepProjectBlogPublish — the five promises, on the wire', () => {
  it('contract #5: a report NOBODY chose is never pushed — by the sweep or the tick', async () => {
    // ⚠ The reversal that makes this feature shippable to every user. The
    // research library holds internal ops reports next to publishable ones;
    // the first build pushed EVERYTHING once WP was configured, which would
    // have flooded the blog's drafts with both. Selection is the contract now.
    await report('internal-ops.md', '# 内部作業ログ\n\nnot blog material\n')
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs).toHaveLength(0)
    await setSettings({ wordpress: WP })
    try {
      await blogPublishTick({ fetchImpl: wp.fetchImpl })
    } finally {
      await setSettings({ wordpress: undefined })
    }
    expect(wp.reqs).toHaveLength(0)
    expect(await readBlogInfo(proj)).toEqual({})
  })

  it('the button creates a DRAFT, authenticated, with the heading as the title', async () => {
    await report('a.md', '# 調査A\n\n本文です。\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')

    const posts = postReqs(wp.reqs)
    expect(posts).toHaveLength(1)
    const r = posts[0]
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
    // ⚠ THE LINK COMES FROM WordPress's OWN `siteurl`, not from the address the
    // REST API answers at (2026-09-02, measured on the owner's blog: core in
    // `/wp`, home at the root). Every push worked while 「ブログの下書きを開く」
    // opened a URL that does not exist, and WordPress answered with the THEME'S
    // 404 page — a working feature that looked broken. The fake site has that
    // shape, so a link built from baseUrl fails this line.
    expect(info['a.md']?.link).toBe('https://blog.example/wp/wp-admin/post.php?post=100&action=edit')
  })

  it('REPAIRS an already-pushed report\'s stale link — the owner must not have to press again', async () => {
    // The shape the owner was left in: a draft pushed by an older build, whose
    // link was built from baseUrl and therefore 404s. The report has NOT
    // changed, so no push will ever happen again — if the repair needed one,
    // the link would stay broken forever. One `/settings` read fixes it, and
    // the entry keeps its post id (the draft itself is untouched).
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')
    // Rewrite the ledger the way the old build wrote it.
    const ledgerPath = await projectDataFile(proj, 'blog-publish.json')
    const before = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      entries: Record<string, { postId: number; link?: string }>
      adminBase?: string
    }
    delete before.adminBase
    before.entries['a.md'].link = 'https://blog.example/wp-admin/post.php?post=100&action=edit'
    await writeFile(ledgerPath, JSON.stringify(before))

    const pushesBefore = postReqs(wp.reqs).length
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })

    const info = await readBlogInfo(proj)
    expect(info['a.md']?.link).toBe('https://blog.example/wp/wp-admin/post.php?post=100&action=edit')
    // …and it healed WITHOUT touching the draft (no new push).
    expect(postReqs(wp.reqs).length).toBe(pushesBefore)
  })

  it('an unchanged chosen report costs ZERO requests on the next sweep', async () => {
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')
    const after = postReqs(wp.reqs).length
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    // ⚠ Counted over POST-endpoint requests: locating wp-admin costs ONE
    // `/settings` read per site, once, and is then remembered on the ledger —
    // the contract this pins is that an unchanged report is never re-pushed.
    expect(postReqs(wp.reqs).length).toBe(after)
    // …and the one-time read really is one-time: nothing new at all on a THIRD
    // sweep (the mutation "re-fetch the base every sweep" turns this red).
    const all = wp.reqs.length
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs.length).toBe(all)
  })

  it('a rewritten report UPDATES its post — never a sibling draft (promise #2)', async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')
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

  it('a report pushed BEFORE selection existed keeps syncing without a mark (back-compat)', async () => {
    // A 0.11.100 ledger holds entries but no `wanted` map. Anything that
    // already HAS a draft must keep tracking its report — a draft that silently
    // went stale would be worse than the extra sync.
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')
    // Strip the mark, leaving only the entry — the pre-selection shape.
    const ledgerPath = await projectDataFile(proj, 'blog-publish.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>
    delete ledger.wanted
    await writeFile(ledgerPath, JSON.stringify(ledger))

    await report('a.md', '# A\n\nv2\n')
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    const update = wp.reqs.find((r) => r.method === 'POST' && /posts\/100/.test(r.url))
    expect(update, 'an existing draft must keep tracking its report').toBeTruthy()
  })

  it("the owner's WP-side edit STOPS all future updates (promise #3 — the trust one)", async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')
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
    await press(wp.fetchImpl, 'a.md')
    wp.posts.get(100)!.status = 'publish' // status flipped without a timestamp drift
    await report('a.md', '# A\n\nv2\n')
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(wp.reqs.filter((r) => r.method === 'POST' && /posts\/100/.test(r.url))).toHaveLength(0)
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('edited-on-wp')
  })

  it('a WP-side DELETE stands — until the report is REDONE, which earns a fresh draft (promise #4)', async () => {
    await report('a.md', '# A\n\nv1\n')
    const wp = fakeWp()
    await press(wp.fetchImpl, 'a.md')
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
    await press(failing, 'a.md')
    const info = await readBlogInfo(proj)
    expect(info['a.md']?.state).toBe('failed')
    expect(info['a.md']?.error).toContain('500')
    expect(JSON.stringify(info)).not.toContain(WP.appPassword)

    // The retry happens on the SWEEP even though the file has not changed —
    // the choice already persisted, so no second button press is needed.
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect((await readBlogInfo(proj))['a.md']?.state).toBe('draft')
  })

  it(`a chosen backlog drains ${MAX_PUSHES_PER_SWEEP} per sweep, not all at once`, async () => {
    const files: string[] = []
    for (let i = 0; i < MAX_PUSHES_PER_SWEEP + 2; i++) {
      await report(`r${i}.md`, `# R${i}\n\nbody\n`)
      files.push(`r${i}.md`)
    }
    // Choose them all while WP is down — the marks persist, the pushes fail.
    const failing = (async () => ({ ok: false, status: 599, json: async () => ({}) }) as Response) as typeof fetch
    await press(failing, ...files)
    const wp = fakeWp()
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(postReqs(wp.reqs)).toHaveLength(MAX_PUSHES_PER_SWEEP)
    await sweepProjectBlogPublish(proj, WP, { fetchImpl: wp.fetchImpl })
    expect(postReqs(wp.reqs)).toHaveLength(MAX_PUSHES_PER_SWEEP + 2)
  })
})

describe('markResearchForBlog — the button itself', () => {
  it('pushes THE PRESSED report, not whatever the cap reaches first', async () => {
    // ⚠ Why the button scopes its push to one file. The sweep walks newest-first
    // under a per-sweep cap, so a press on an OLD report while newer chosen ones
    // are still pending would spend the whole cap on the newer ones and leave
    // the report the owner is LOOKING AT unpushed — a button that visibly does
    // nothing. The `only` filter is what makes the press about this report.
    await report('pressed.md', '# 押した記事\n\nbody\n')
    const failing = (async () => ({ ok: false, status: 599, json: async () => ({}) }) as Response) as typeof fetch
    const newer: string[] = []
    for (let i = 0; i < MAX_PUSHES_PER_SWEEP + 1; i++) {
      const f = `newer${i}.md`
      await report(f, `# N${i}\n\nbody\n`)
      // Force distinct, NEWER mtimes so pressed.md sorts LAST (newest-first list).
      const t = new Date(Date.now() + (i + 1) * 10_000)
      await utimes(join(proj, 'docs', 'research', f), t, t)
      newer.push(f)
    }
    await press(failing, ...newer) // chosen, pending — the queue ahead of us
    const wp = fakeWp()
    await setSettings({ wordpress: WP })
    try {
      const res = await markResearchForBlog(proj, 'pressed.md', { fetchImpl: wp.fetchImpl })
      expect(res.ok && res.blog?.state).toBe('draft')
    } finally {
      await setSettings({ wordpress: undefined })
    }
    expect((await readBlogInfo(proj))['pressed.md']?.state).toBe('draft')
  })

  it('answers not-configured (and records nothing) without Settings.wordpress', async () => {
    await report('a.md', '# A\n\nbody\n')
    const res = await markResearchForBlog(proj, 'a.md')
    expect(res).toEqual({ ok: false, error: 'not-configured' })
    expect(await readBlogInfo(proj)).toEqual({})
  })

  it('answers lockdown while lockdown is on', async () => {
    await report('a.md', '# A\n\nbody\n')
    await setSettings({ wordpress: WP })
    setLockdownCache(true)
    try {
      expect(await markResearchForBlog(proj, 'a.md')).toEqual({ ok: false, error: 'lockdown' })
    } finally {
      setLockdownCache(false)
      await setSettings({ wordpress: undefined })
    }
  })

  it('returns the fresh draft info the UI flips its chip from', async () => {
    await report('a.md', '# A\n\nbody\n')
    const wp = fakeWp()
    await setSettings({ wordpress: WP })
    try {
      const res = await markResearchForBlog(proj, 'a.md', { fetchImpl: wp.fetchImpl })
      expect(res.ok).toBe(true)
      expect(res.ok && res.blog?.state).toBe('draft')
      expect(res.ok && res.blog?.link).toContain('post.php?post=100')
    } finally {
      await setSettings({ wordpress: undefined })
    }
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

  it('does nothing in lockdown, even fully configured with chosen reports', async () => {
    await report('a.md', '# A\n\nbody\n')
    const failing = (async () => ({ ok: false, status: 599, json: async () => ({}) }) as Response) as typeof fetch
    await press(failing, 'a.md') // chosen, push pending
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

  it('configured ⇒ a CHOSEN report sweeps through the tick', async () => {
    await report('a.md', '# A\n\nbody\n')
    const failing = (async () => ({ ok: false, status: 599, json: async () => ({}) }) as Response) as typeof fetch
    await press(failing, 'a.md')
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
