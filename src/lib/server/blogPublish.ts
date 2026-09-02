// blogPublish — research reports → WordPress DRAFTS on the owner's own site.
//
// WHY THIS EXISTS (owner, 2026-08-28): the Research tab is where reports are
// MADE, but it never became a good place to READ them — the owner already has
// one (a WordPress blog), so the reports go there. A background sweep mirrors
// each `docs/research/*.md` into a WP draft over the REST API, authenticated
// with an Application Password (Settings.wordpress — configuring it IS the
// opt-in; absent ⇒ this whole module is inert).
//
// THE CONTRACT, in order of importance (docs/BLOG_PUBLISH_PITCH.md):
//   1. DRAFTS ONLY. Nothing this module writes is ever public — research
//      reports quote SNS posts verbatim, and publishing is an editorial act
//      that stays on the WP side, behind the owner's own publish button.
//   2. ONE REPORT = ONE POST. The ledger (blog-publish.json in the project's
//      central data dir) maps report → postId + the hash we last pushed, so a
//      rewritten report UPDATES its draft instead of minting a sibling.
//   3. THE OWNER'S WP EDITS WIN, ALWAYS. Before any update we compare the
//      post's `modified_gmt` with the one OUR last write recorded; any drift
//      means a human (edit, publish — both move the clock) and the sweep stops
//      touching that post forever ('edited-on-wp'). Overwriting a hand-edited
//      draft once would end this feature's credibility — the pitch names this
//      as THE risk.
//   4. A WP-SIDE DELETE IS A DECISION. A deleted draft is not re-created —
//      unless the REPORT ITSELF is rewritten afterwards, which is the redo
//      loop (「チェックしてダメなら編集やり直し」): a redone report earns a
//      fresh draft.
//   5. ONLY CHOSEN REPORTS GO (owner, 2026-08-28: 「どのリサーチを送るとか
//      ボタンつけれる？」). The research library holds internal ops reports
//      alongside publishable ones, so "everything, automatically" — the first
//      shipped shape — would have flooded the blog's drafts with both. A
//      report is pushed only once the owner pressed its 「ブログへ」 button
//      (the `wanted` half of the ledger); from then on the sync IS automatic
//      (rewrites keep updating the same draft under promises 1–4). A report
//      that already HAS a draft keeps syncing even without a mark — the
//      back-compat read for anything pushed before selection existed.
//
// Failure posture: per-report, recorded on the ledger ('failed' + a scrubbed
// reason — the app password never appears in any error, log line, or ledger),
// retried on later sweeps. The sweep never throws, caps its per-project
// network work, does NOTHING while lockdown is on (the fetch floor would
// refuse the egress anyway — this just makes the skip deliberate), and an
// unchanged report costs zero requests.

import { createHash } from 'crypto'
import { mkdir, readFile } from 'fs/promises'
import { marked } from 'marked'
import type { ResearchReportBlogInfo, Settings, WordPressSettings } from '../types'
import { atomicWriteJson } from './atomicWrite'
import { isLockdownEnabledSync } from './lockdown'
import { projectDataDir, projectDataFile } from './projectDataPath'
import { listResearchReports, readResearchReport, titleFrom } from './researchReports'
import { getSettings } from './store'

// ─── ledger ──────────────────────────────────────────────────────────────────

export interface BlogLedgerEntry {
  postId: number
  /** WP edit-screen URL (display-only). */
  link?: string
  /** sha1 of the report markdown WE last pushed. */
  contentHash: string
  pushedAt: string
  /** The post's `modified_gmt` as of OUR last write — the owner-edit tripwire. */
  wpModifiedAt?: string
  state: ResearchReportBlogInfo['state']
  /** For 'failed': scrubbed reason. Never contains credentials. */
  error?: string
}

interface BlogLedger {
  entries: Record<string, BlogLedgerEntry>
  /** Report files the owner chose to publish (contract #5). Marked by the
   *  Research tab's button, never by the sweep. */
  wanted?: Record<string, true>
}

const LEDGER_FILE = 'blog-publish.json'

const readLedger = async (projectPath: string): Promise<BlogLedger> => {
  try {
    const raw = await readFile(await projectDataFile(projectPath, LEDGER_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BlogLedger>
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      const wanted =
        parsed.wanted && typeof parsed.wanted === 'object' && !Array.isArray(parsed.wanted)
          ? parsed.wanted
          : undefined
      return { entries: parsed.entries, ...(wanted ? { wanted } : {}) }
    }
  } catch {
    /* absent / torn ⇒ empty — worst case a report is re-pushed as a new draft */
  }
  return { entries: {} }
}

const writeLedger = async (projectPath: string, ledger: BlogLedger): Promise<void> => {
  try {
    // The central data dir may not exist yet for a project that has never held
    // board/canvas data — atomicWriteJson's sibling-temp rename needs it there
    // (the same ensure-then-write shape as swarmEnginePersistence, and measured
    // here first: the ledger silently never persisted and every sweep re-created
    // the same draft).
    await mkdir(await projectDataDir(projectPath), { recursive: true })
    await atomicWriteJson(await projectDataFile(projectPath, LEDGER_FILE), ledger)
  } catch {
    /* fail-open: a ledger that cannot persist costs a duplicate draft later,
       never a crashed sweep */
  }
}

/** The Research tab's read of the ledger (route enrichment) — never throws. */
export const readBlogInfo = async (
  projectPath: string,
): Promise<Record<string, ResearchReportBlogInfo>> => {
  const ledger = await readLedger(projectPath)
  const out: Record<string, ResearchReportBlogInfo> = {}
  for (const [file, e] of Object.entries(ledger.entries)) {
    out[file] = {
      state: e.state,
      ...(e.link ? { link: e.link } : {}),
      ...(e.state === 'failed' && e.error ? { error: e.error } : {}),
    }
  }
  return out
}

// ─── WordPress client ────────────────────────────────────────────────────────

/** What the sweep needs back from WP — the full post object is much bigger. */
interface WpPostLite {
  id: number
  modified_gmt?: string
  status?: string
}

export interface BlogPublishDeps {
  fetchImpl?: typeof fetch
  now?: () => number
}

const REQUEST_TIMEOUT_MS = 30_000

/** One WP REST call. Throws a SCRUBBED error on any non-2xx — the message
 *  carries method, path and status only. The Authorization header value (and
 *  therefore the app password) exists only inside this function. */
const wpRequest = async (
  wp: WordPressSettings,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<WpPostLite> => {
  const url = `${wp.baseUrl}/wp-json/wp/v2${path}`
  const auth = Buffer.from(`${wp.username}:${wp.appPassword}`).toString('base64')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    })
  } catch (e) {
    // Network faults can echo the request URL but never the header; still keep
    // the message minimal and self-made.
    throw new Error(`${method} ${path}: ${e instanceof Error ? e.name : 'fetch failed'}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 404) throw new WpGoneError(`${method} ${path}: 404`)
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`)
  const json = (await res.json().catch(() => null)) as WpPostLite | null
  if (!json || typeof json.id !== 'number') throw new Error(`${method} ${path}: malformed response`)
  return json
}

/** 404 from WP — for a post we created, that means the owner deleted it (a
 *  trashed post also 404s on the plain endpoint). Its own class so the sweep
 *  can tell "gone" from "broken". */
class WpGoneError extends Error {}

// ─── report → draft payload ──────────────────────────────────────────────────

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

/** Title + HTML body for one report. The first `# ` heading becomes the WP
 *  title and is REMOVED from the body — WP renders its own title, and keeping
 *  both prints it twice. GFM on: research reports lean on tables. */
export const draftPayload = (file: string, md: string): { title: string; html: string } => {
  const title = titleFrom(md.slice(0, 8 * 1024)) ?? file.replace(/\.md$/i, '')
  const body = md.replace(/^#[ \t]+.+?[ \t]*\r?\n/, '')
  const html = marked.parse(body, { gfm: true, async: false })
  return { title, html }
}

// ─── the sweep ───────────────────────────────────────────────────────────────

/** Network-touching operations per project per sweep. A first enable meets a
 *  backlog of every report the project ever produced; pushing them five at a
 *  time keeps one sweep bounded while the backlog drains in a few cycles. */
export const MAX_PUSHES_PER_SWEEP = 5

const editLink = (wp: WordPressSettings, postId: number): string =>
  `${wp.baseUrl}/wp-admin/post.php?post=${postId}&action=edit`

/** Sweep ONE project's reports against the ledger. Exported for tests; the
 *  loop below drives it across every registered project. Never throws. */
export const sweepProjectBlogPublish = async (
  projectPath: string,
  wp: WordPressSettings,
  deps: BlogPublishDeps = {},
  opts: {
    /** Push just this one report NOW (the button's immediate path) — it must
     *  already be marked wanted, or hold an entry; the gate below still runs. */
    only?: string
  } = {},
): Promise<void> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString()
  let reports
  try {
    reports = await listResearchReports(projectPath)
  } catch {
    return
  }
  if (opts.only) reports = reports.filter((r) => r.file === opts.only)
  if (!reports.length) return
  const ledger = await readLedger(projectPath)
  let dirty = false
  let pushes = 0

  for (const meta of reports) {
    if (pushes >= MAX_PUSHES_PER_SWEEP) break
    // CONTRACT #5 — only what the owner chose. An existing ENTRY also passes:
    // it means this report already has a draft (chosen before, or pushed by the
    // pre-selection build), and a draft that silently stopped tracking its
    // report would violate promise #2's spirit worse than the extra sync.
    if (!ledger.wanted?.[meta.file] && !ledger.entries[meta.file]) continue
    let md: string
    try {
      md = await readResearchReport(projectPath, meta.file)
    } catch {
      continue // unreadable/oversized — not this module's problem to report
    }
    const hash = sha1(md)
    const entry = ledger.entries[meta.file]

    // Unchanged since our last push ⇒ zero requests. This same line is what
    // makes a WP-side DELETE stand: a 'deleted-on-wp' entry whose report has
    // not been rewritten rests here forever, and only a REDO (hash moved) falls
    // through to earn a fresh draft. (A dedicated deleted-skip existed briefly
    // and was removed as dead code — mutation-tested green, i.e. it guarded
    // nothing this line does not.)
    if (entry && entry.contentHash === hash && entry.state !== 'failed') continue

    // 'edited-on-wp' is TERMINAL, hash or no hash (promise #3): once the owner's
    // hand touched the post, this module never writes near it again — not even
    // for a redone report. The chip in the Research tab says why, and the owner
    // owns the WP copy from then on. (Deleting the WP post does NOT re-open it
    // either: we deliberately never GET these, so we cannot tell — and guessing
    // would put a surprise draft next to work the owner curated by hand.)
    if (entry?.state === 'edited-on-wp') continue

    const { title, html } = draftPayload(meta.file, md)
    pushes++
    try {
      // Create when there is nothing to update: no entry, a deletion superseded
      // by a redo, or a FAILED first create that never got a postId (updating
      // post 0 would 404 and mis-record the failure as a WP-side delete).
      if (!entry || entry.state === 'deleted-on-wp' || !entry.postId) {
        // CREATE — always a draft (contract #1).
        const post = await wpRequest(wp, 'POST', '/posts', { title, content: html, status: 'draft' }, fetchImpl)
        ledger.entries[meta.file] = {
          postId: post.id,
          link: editLink(wp, post.id),
          contentHash: hash,
          pushedAt: nowIso(),
          ...(post.modified_gmt ? { wpModifiedAt: post.modified_gmt } : {}),
          state: 'draft',
        }
      } else {
        // UPDATE — but the owner's WP-side hand wins first (contract #3).
        let current: WpPostLite
        try {
          current = await wpRequest(wp, 'GET', `/posts/${entry.postId}?context=edit`, undefined, fetchImpl)
        } catch (e) {
          if (e instanceof WpGoneError) {
            // Deleted on WP. Record it; the NEXT sweep's fall-through above
            // decides whether the current content is a redo (create) or not.
            ledger.entries[meta.file] = { ...entry, state: 'deleted-on-wp' }
            dirty = true
            continue
          }
          throw e
        }
        const touched =
          entry.wpModifiedAt !== undefined &&
          current.modified_gmt !== undefined &&
          current.modified_gmt !== entry.wpModifiedAt
        if (touched || (current.status && current.status !== 'draft')) {
          // Edited or published by a human — hands off, permanently.
          ledger.entries[meta.file] = { ...entry, state: 'edited-on-wp' }
          dirty = true
          continue
        }
        const post = await wpRequest(wp, 'POST', `/posts/${entry.postId}`, { title, content: html }, fetchImpl)
        ledger.entries[meta.file] = {
          ...entry,
          contentHash: hash,
          pushedAt: nowIso(),
          ...(post.modified_gmt ? { wpModifiedAt: post.modified_gmt } : {}),
          state: 'draft',
          error: undefined,
        }
      }
      dirty = true
    } catch (e) {
      // Scrubbed by construction (wpRequest writes its own messages), but belt
      // and braces: never let the password through even if a dep changes.
      // A Node fetch failure says only "fetch failed" — the code that tells
      // DNS from a refused connection from a bad certificate rides on `cause`.
      // Append it so the owner's reason line can name the real obstacle.
      const causeCode = (e as { cause?: { code?: unknown } } | null)?.cause?.code
      const raw = e instanceof Error ? e.message : String(e)
      const withCause = typeof causeCode === 'string' && causeCode ? `${raw} (${causeCode})` : raw
      const msg = withCause.split(wp.appPassword).join('***')
      ledger.entries[meta.file] = {
        ...(entry ?? { postId: 0, contentHash: '', pushedAt: '' }),
        state: 'failed',
        error: msg.slice(0, 300),
      }
      dirty = true
    }
  }
  if (dirty) await writeLedger(projectPath, ledger)
}

/** The Research tab's 「ブログへ」 button: record the owner's choice, then push
 *  that one report immediately so the draft exists before the button's spinner
 *  stops (the 5-minute sweep would read as broken). Returns the report's fresh
 *  blog info, or an `error` the UI can show verbatim:
 *   - 'not-configured' — Settings.wordpress is absent; the UI points at 設定.
 *   - 'lockdown'       — lockdown mode is on; egress is off by policy.
 *  The MARK persists either way once configured — a push that fails here is
 *  retried by every later sweep (the ledger's 'failed' path). */
export const markResearchForBlog = async (
  projectPath: string,
  file: string,
  deps: BlogPublishDeps = {},
): Promise<{ ok: true; blog?: ResearchReportBlogInfo } | { ok: false; error: 'not-configured' | 'lockdown' }> => {
  if (isLockdownEnabledSync()) return { ok: false, error: 'lockdown' }
  let settings: Settings
  try {
    settings = await getSettings()
  } catch {
    return { ok: false, error: 'not-configured' }
  }
  const wp = settings.wordpress
  if (!wp?.baseUrl || !wp.username || !wp.appPassword) return { ok: false, error: 'not-configured' }
  const ledger = await readLedger(projectPath)
  if (!ledger.wanted?.[file]) {
    ledger.wanted = { ...ledger.wanted, [file]: true }
    await writeLedger(projectPath, ledger)
  }
  await sweepProjectBlogPublish(projectPath, wp, deps, { only: file })
  const info = await readBlogInfo(projectPath)
  return { ok: true, ...(info[file] ? { blog: info[file] } : {}) }
}

/** One pass over every registered project. Inert without Settings.wordpress;
 *  deliberately skipped in lockdown (the fetch floor would refuse anyway). */
export const blogPublishTick = async (deps: BlogPublishDeps = {}): Promise<void> => {
  if (globalThis.__openground_blog_publish_inflight) return
  globalThis.__openground_blog_publish_inflight = true
  try {
    if (isLockdownEnabledSync()) return
    let settings: Settings
    try {
      settings = await getSettings()
    } catch {
      return
    }
    const wp = settings.wordpress
    if (!wp?.baseUrl || !wp.username || !wp.appPassword) return
    for (const p of settings.projects ?? []) {
      if (typeof p?.path === 'string' && p.path) {
        await sweepProjectBlogPublish(p.path, wp, deps).catch(() => {})
      }
    }
  } finally {
    globalThis.__openground_blog_publish_inflight = false
  }
}

// ─── the loop (server/index.ts) ──────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 5 * 60_000

declare global {
  // eslint-disable-next-line no-var
  var __openground_blog_publish_timer: ReturnType<typeof setInterval> | null | undefined
  // eslint-disable-next-line no-var
  var __openground_blog_publish_inflight: boolean | undefined
}

export const startBlogPublishLoop = (intervalMs: number = SWEEP_INTERVAL_MS): void => {
  if (globalThis.__openground_blog_publish_timer) {
    clearInterval(globalThis.__openground_blog_publish_timer)
  }
  const timer = setInterval(() => {
    void blogPublishTick()
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_blog_publish_timer = timer
  void blogPublishTick()
}

export const stopBlogPublishLoop = (): void => {
  if (globalThis.__openground_blog_publish_timer) {
    clearInterval(globalThis.__openground_blog_publish_timer)
    globalThis.__openground_blog_publish_timer = null
  }
}
