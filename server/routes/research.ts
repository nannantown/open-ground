// Research channels — the thin HTTP adapter over researchChannels.ts (the
// cross-platform checker) and researchAuth.ts (the local-only cookie store),
// serving Settings → Research channels. Loopback-local per-machine state with
// no cross-user data, so no auth gate — mirrors /api/settings (misc.ts).
//
// PRIVACY CONTRACT (pinned by researchAuth.test.ts): no route here ever
// returns a stored cookie VALUE. Status is booleans; saving is write-only.

import { Hono } from 'hono'
import { listResearchChannels } from '@/lib/server/researchChannels'
import {
  clearResearchTwitterAuth,
  researchAuthStatus,
  setResearchTwitterAuth,
} from '@/lib/server/researchAuth'
import { listResearchReports, readResearchReport } from '@/lib/server/researchReports'
import { readBlogInfo } from '@/lib/server/blogPublish'
import {
  MAX_QUESTION_LEN,
  contentShaOf,
  getResearchJobState,
  readResearchKnowledge,
  startResearchAskJob,
  startResearchDigestJob,
} from '@/lib/server/researchKnowledge'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import { requireProjectPath } from '../middleware/projectPath'
import type {
  ResearchAuthStatusResponse,
  ResearchChannelsResponse,
  ResearchJobStartResponse,
  ResearchKnowledgeResponse,
  ResearchReportResponse,
  ResearchReportsResponse,
  SetResearchAuthRequest,
} from '@/lib/types'

export const researchRoutes = new Hono()
  // --- GET /api/research/channels -------------------------------------------
  // Every channel's verdict (ok/part/miss + detail + copyable unlock command).
  // Local checks only — PATH scan + one bounded python probe; never the network.
  .get('/api/research/channels', async (c) => {
    const { twitterConfigured } = await researchAuthStatus()
    const body: ResearchChannelsResponse = {
      channels: listResearchChannels({ storedTwitterAuth: twitterConfigured }),
    }
    return c.json(body)
  })
  // --- GET /api/research/reports?path=… --------------------------------------
  // The per-project research library (docs/research/*.md, newest first). The
  // project root passes validateProjectPath (CONTRACT §3.3 — requireProjectPath);
  // researchReports.ts then confines every read to docs/research/ (charset +
  // realpath containment).
  .get('/api/research/reports', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const reports = await listResearchReports(path)
    // Join the blog-publish ledger (blogPublish.ts) so the tab can say where
    // each report stands on the owner's blog. One cheap JSON read; additive —
    // reports without an entry carry no `blog` key and old clients ignore it.
    const blog = await readBlogInfo(path).catch(() => ({}) as Record<string, never>)
    const body: ResearchReportsResponse = {
      reports: reports.map((r) => (blog[r.file] ? { ...r, blog: blog[r.file] } : r)),
    }
    return c.json(body)
  })
  // --- GET /api/research/report?path=…&file=… --------------------------------
  .get('/api/research/report', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const file = c.req.query('file') ?? ''
    try {
      const body: ResearchReportResponse = {
        file,
        content: await readResearchReport(path, file),
      }
      return c.json(body)
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 404)
    }
  })
  // --- GET /api/research/knowledge?path=…&file=… ------------------------------
  // The report's knowledge sidecar (digest + Q&A) plus the one derived fact the
  // client cannot compute: whether the live report text still matches the
  // digest's contentSha. A missing sidecar is a valid empty knowledge, not 404;
  // a missing REPORT is 404 (nothing to be knowledgeable about).
  .get('/api/research/knowledge', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const file = c.req.query('file') ?? ''
    try {
      const content = await readResearchReport(path, file)
      const k = await readResearchKnowledge(path, file)
      const body: ResearchKnowledgeResponse = {
        file,
        ...(k.digest ? { digest: k.digest, digestStale: k.digest.contentSha !== contentShaOf(content) } : {}),
        qa: k.qa,
      }
      return c.json(body)
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 404)
    }
  })
  // --- POST /api/research/digest {path,file} ----------------------------------
  // Start (or re-attach to) the digest job. EXPLICIT button only — nothing in
  // the app calls this automatically (the pitch's non-goal: never burn the
  // owner's subscription on an open). 503 = the shared claude preflight.
  .post('/api/research/digest', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const raw = (await c.req.json().catch(() => ({}))) as { file?: string }
    const file = typeof raw.file === 'string' ? raw.file : ''
    try {
      await readResearchReport(path, file) // 404 before any spawn
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 404)
    }
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    const body: ResearchJobStartResponse = { jobId: startResearchDigestJob({ projectPath: path, file }) }
    return c.json(body, 202)
  })
  // --- POST /api/research/ask {path,file,question} ----------------------------
  .post('/api/research/ask', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    const raw = (await c.req.json().catch(() => ({}))) as { file?: string; question?: string }
    const file = typeof raw.file === 'string' ? raw.file : ''
    const question = typeof raw.question === 'string' ? raw.question.trim() : ''
    if (!question) return c.json({ error: 'a question is required' }, 400)
    if (question.length > MAX_QUESTION_LEN) {
      return c.json({ error: `question is too long (max ${MAX_QUESTION_LEN} chars)` }, 400)
    }
    try {
      await readResearchReport(path, file)
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 404)
    }
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    const body: ResearchJobStartResponse = {
      jobId: startResearchAskJob({ projectPath: path, file, question }),
    }
    return c.json(body, 202)
  })
  // --- GET /api/research/job/:id ----------------------------------------------
  // Poll a digest/ask job. On 'done' the result is already persisted — the
  // client re-reads /api/research/knowledge. 404 = unknown or already swept
  // (either way: nothing running; whatever finished is in the sidecar).
  .get('/api/research/job/:id', (c) => {
    const state = getResearchJobState(c.req.param('id'))
    if (!state) return c.json({ error: 'unknown job' }, 404)
    return c.json(state)
  })
  // --- GET /api/research/auth ------------------------------------------------
  .get('/api/research/auth', async (c) => {
    const body: ResearchAuthStatusResponse = await researchAuthStatus()
    return c.json(body)
  })
  // --- POST /api/research/auth -----------------------------------------------
  // Both values non-empty ⇒ save. Both empty ⇒ clear. Anything else ⇒ 400
  // (one cookie without the other cannot work, so it must not be storable).
  .post('/api/research/auth', async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Partial<SetResearchAuthRequest>
    const authToken = typeof raw.twitterAuthToken === 'string' ? raw.twitterAuthToken.trim() : null
    const ct0 = typeof raw.twitterCt0 === 'string' ? raw.twitterCt0.trim() : null
    if (authToken === null || ct0 === null) {
      return c.json({ error: 'twitterAuthToken and twitterCt0 must both be strings' }, 400)
    }
    if (authToken === '' && ct0 === '') {
      await clearResearchTwitterAuth()
    } else if (authToken !== '' && ct0 !== '') {
      try {
        await setResearchTwitterAuth({ authToken, ct0 })
      } catch (e) {
        return c.json({ error: String((e as Error)?.message ?? e) }, 400)
      }
    } else {
      return c.json({ error: 'provide both cookie values to save, or both empty to clear' }, 400)
    }
    const body: ResearchAuthStatusResponse = await researchAuthStatus()
    return c.json(body)
  })
