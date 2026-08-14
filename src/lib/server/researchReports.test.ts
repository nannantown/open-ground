// researchReports — the read-only library behind the per-project Research tab.
// Pins the listing contract (docs/research/*.md only, first-`# `-heading titles,
// newest first) and the security shape: the strict filename charset (no
// separators ⇒ no traversal by construction), the realpath containment that
// refuses symlink escapes, and the size cap. Everything runs against throwaway
// mkdtemp dirs — NEVER the real home (OPENGROUND_HOME is pinned to tmp by
// src/test/setup-home.ts for the whole suite).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink, utimes, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listResearchReports,
  readResearchReport,
  researchReportsDir,
  MAX_REPORT_BYTES,
} from './researchReports'
import { researchRoutes } from '../../../server/routes/research'

describe('listResearchReports', () => {
  let proj: string
  let reportsDir: string

  beforeEach(async () => {
    // realpath'd so mtime/containment assertions can't trip over a symlinked
    // tmp root (macOS /var → /private/var).
    proj = await realpath(await mkdtemp(join(tmpdir(), 'og-research-')))
    reportsDir = researchReportsDir(proj)
    await mkdir(reportsDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true })
  })

  const writeReport = async (name: string, content: string, mtime?: Date) => {
    const p = join(reportsDir, name)
    await writeFile(p, content)
    if (mtime) await utimes(p, mtime, mtime)
  }

  it('returns [] when docs/research is absent (the normal "no research yet" case)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'og-research-bare-'))
    try {
      expect(await listResearchReports(bare)).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('lists only *.md with first-`# `-heading titles (filename fallback), newest first', async () => {
    await writeReport('older.md', '# Competitor scan\n\nbody', new Date('2026-01-01T00:00:00Z'))
    // No `# ` heading anywhere → the filename (sans .md) is the title.
    await writeReport('newer.md', 'no heading here\n## only h2\n', new Date('2026-02-01T00:00:00Z'))
    const reports = await listResearchReports(proj)
    expect(reports.map((r) => r.file)).toEqual(['newer.md', 'older.md'])
    expect(reports.map((r) => r.title)).toEqual(['newer', 'Competitor scan'])
    expect(reports[0].mtime).toBeGreaterThan(reports[1].mtime)
    expect(reports.every((r) => r.size > 0)).toBe(true)
  })

  it('skips subdirectories and non-.md files (traversal names cannot even exist as one entry)', async () => {
    // `evil/../x.md` is not creatable as a single directory entry — the
    // filesystem itself forbids `/` in a name — so the traversal case for the
    // LIST is structural. What can exist and must be skipped:
    await writeReport('real.md', '# Real\n')
    await mkdir(join(reportsDir, 'subdir'), { recursive: true }) // no .md suffix — fails the charset
    await mkdir(join(reportsDir, 'dir.md'), { recursive: true }) // name matches, but not a regular file
    await writeFile(join(reportsDir, 'notes.txt'), 'not markdown')
    await writeFile(join(reportsDir, '.hidden.md'), '# Hidden\n') // leading dot fails the charset
    await writeFile(join(reportsDir, 'subdir', 'nested.md'), '# Nested\n') // not a direct child
    const reports = await listResearchReports(proj)
    expect(reports.map((r) => r.file)).toEqual(['real.md'])
  })

  it('SYMLINK ESCAPE: a link out of docs/research is skipped by list and refused by read', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'og-research-outside-'))
    try {
      await writeFile(join(outside, 'secret.md'), '# STOLEN\ntop secret')
      await symlink(join(outside, 'secret.md'), join(reportsDir, 'leak.md'))
      await writeReport('good.md', '# Good\n')

      const reports = await listResearchReports(proj)
      expect(reports.map((r) => r.file)).toEqual(['good.md'])
      expect(reports.some((r) => r.title === 'STOLEN')).toBe(false)

      // The read path must refuse the same escape (name passes the charset,
      // so containment is the layer doing the work here).
      await expect(readResearchReport(proj, 'leak.md')).rejects.toThrow(
        /outside docs\/research/,
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('readResearchReport', () => {
  let proj: string
  let reportsDir: string

  beforeEach(async () => {
    proj = await realpath(await mkdtemp(join(tmpdir(), 'og-research-read-')))
    reportsDir = researchReportsDir(proj)
    await mkdir(reportsDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true })
  })

  it('rejects names failing the charset (traversal is unrepresentable)', async () => {
    for (const bad of ['../x.md', '.hidden.md', 'a/b.md']) {
      await expect(readResearchReport(proj, bad)).rejects.toThrow(/not a research report name/)
    }
  })

  it('rejects a report over the size cap (1MB + 1 byte)', async () => {
    await writeFile(join(reportsDir, 'big.md'), Buffer.alloc(MAX_REPORT_BYTES + 1, 0x61))
    await expect(readResearchReport(proj, 'big.md')).rejects.toThrow(/too large/)
  })

  it('rejects a missing file', async () => {
    await expect(readResearchReport(proj, 'nope.md')).rejects.toThrow()
  })

  it('round-trips content exactly', async () => {
    const content = '# Title\n\n- bullet 1\n- bullet 2\n\n```js\ncode()\n```\n日本語も混ざる。\n'
    await writeFile(join(reportsDir, 'report.md'), content)
    expect(await readResearchReport(proj, 'report.md')).toBe(content)
  })
})

// ─── Route-level security pin ───────────────────────────────────────────────
// The route's first line of defence is validateProjectPath (CONTRACT §3.3):
// the suite's OPENGROUND_HOME is a throwaway tmp home whose registry is empty,
// so ANY path — including a real directory like /etc — must come back 403,
// proving the reports endpoint never serves an unregistered path.
describe('GET /api/research/reports route guard', () => {
  it('403s a path outside the (empty) project registry', async () => {
    const res = await researchRoutes.request(
      `/api/research/reports?path=${encodeURIComponent('/etc')}`,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'path not allowed' })
  })
})
