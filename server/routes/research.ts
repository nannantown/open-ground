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
import { requireProjectPath } from '../middleware/projectPath'
import type {
  ResearchAuthStatusResponse,
  ResearchChannelsResponse,
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
    const body: ResearchReportsResponse = { reports: await listResearchReports(path) }
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
