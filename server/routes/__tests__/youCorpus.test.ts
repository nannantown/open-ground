import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import type { YouCorpusAppendResponse, YouCorpusStatus, YouCorpusMeta } from '@/lib/types'

// The you-corpus routes against the real Hono app, with OPENGROUND_HOME on a
// throwaway dir and the SOURCE locations pointed at tmp fixtures via env, so
// nothing reads the real ~/.openground or ~/.claude. app.request() sends no
// Origin header (a local non-browser client), so the CSRF guard passes.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-youcorpus-route-home-')))
  process.env.OPENGROUND_HOME = home

  const fixtures = await realpath(await mkdtemp(join(tmpdir(), 'og-youcorpus-route-src-')))
  const memDir = join(fixtures, 'memory')
  await mkdir(memDir, { recursive: true })
  const conceptPath = join(fixtures, 'CONCEPT.md')
  await writeFile(conceptPath, '# Concept\nROUTE_CONCEPT_MARKER\n')
  await writeFile(
    join(memDir, 'project_business_model_vision.md'),
    '---\nname: project_business_model_vision\ndescription: soul\nmetadata: \n  type: project\n---\n\nROUTE_BUSINESS_MARKER\n',
  )
  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
})

afterEach(async () => {
  delete process.env.OPENGROUND_MEMORY_DIR
  delete process.env.OPENGROUND_CONCEPT_PATH
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/you-corpus', () => {
  it('reports status + available sources (before any rebuild)', async () => {
    const res = await app.request('/api/you-corpus')
    expect(res.status).toBe(200)
    const body = (await res.json()) as YouCorpusStatus
    expect(body.exists).toBe(false)
    expect(body.memoryCount).toBe(1)
    expect(body.businessVisionExists).toBe(true)
    expect(body.conceptExists).toBe(true)
  })
})

describe('DNS-rebinding / loopback guard on the sensitive GETs', () => {
  it('rejects a non-loopback Host on GET /raw (corpus exfil defense)', async () => {
    const res = await app.request('/api/you-corpus/raw', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
  })

  it('rejects a non-loopback Host on GET /api/you-corpus (status leak defense)', async () => {
    const res = await app.request('/api/you-corpus', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
  })

  it('allows an explicit loopback Host', async () => {
    const res = await app.request('/api/you-corpus/raw', { headers: { host: '127.0.0.1:47776' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('proxy')
  })

  it('rejects a foreign Origin even when Host is absent', async () => {
    const res = await app.request('/api/you-corpus/raw', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/you-corpus/rebuild', () => {
  it('assembles from the mechanical sources', async () => {
    const res = await app.request('/api/you-corpus/rebuild', json({}))
    expect(res.status).toBe(200)
    const meta = (await res.json()) as YouCorpusMeta
    expect(meta.conceptIncluded).toBe(true)
    expect(meta.businessVisionIncluded).toBe(true)
    expect(meta.sizeBytes).toBeGreaterThan(0)

    // GET raw returns the injectable markdown.
    const raw = await app.request('/api/you-corpus/raw')
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toContain('text/markdown')
    const text = await raw.text()
    expect(text).toContain('ROUTE_CONCEPT_MARKER')
    expect(text).toContain('ROUTE_BUSINESS_MARKER')
    expect(text).toContain('proxy')
  })
})

describe('POST /api/you-corpus/append', () => {
  it('rejects empty text with 400', async () => {
    const res = await app.request('/api/you-corpus/append', json({ text: '   ' }))
    expect(res.status).toBe(400)
  })

  it('adds a judgment and renders it into the corpus', async () => {
    const res = await app.request(
      '/api/you-corpus/append',
      json({ text: 'ROUTE_JUDGE_MARKER', tags: ['x'] }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as YouCorpusAppendResponse
    expect(body.judgment.text).toBe('ROUTE_JUDGE_MARKER')
    expect(body.judgment.tags).toEqual(['x'])
    expect(body.meta.manualCount).toBe(1)

    const raw = await app.request('/api/you-corpus/raw')
    const text = await raw.text()
    expect(text).toContain('ROUTE_JUDGE_MARKER')
  })
})
