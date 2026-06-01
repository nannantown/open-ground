import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { setSettings } from '@/lib/server/store'
import { sessionDir, sessionJsonlPath } from '@/lib/server/observer'

// Phase 4 — GET /api/run/transcript.
//
// Unlike routes.test.ts (which never touches the real Claude projects dir),
// this suite needs a real JSONL on disk because sessionJsonlPath() resolves
// under ~/.claude/projects (os.homedir, not OPENGROUND_HOME). We write the
// dummy JSONL under a tmp-derived project dir name so it can NEVER collide
// with a real session, and remove that directory in afterAll.

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
let projectsRoot: string
let projectPath: string
let jsonlDir: string

const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'こんにちは、作業を始めます' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/c.ts' } }],
    },
  }),
  // A blank line in the middle — must be skipped, not counted.
  '',
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'OPENGROUND_RESULT: {"summary":"done"}' }] },
  }),
].join('\n')

beforeAll(async () => {
  projectsRoot = mkdtempSync(join(tmpdir(), 'og-transcript-root-'))
  projectPath = join(projectsRoot, 'demo-project')
  mkdirSync(projectPath, { recursive: true })
  await setSettings({ projectsRoot })

  jsonlDir = sessionDir(projectPath)
  mkdirSync(jsonlDir, { recursive: true })
  writeFileSync(sessionJsonlPath(projectPath, SID), lines, 'utf8')
})

afterAll(() => {
  try { rmSync(jsonlDir, { recursive: true, force: true }) } catch {}
  try { rmSync(projectsRoot, { recursive: true, force: true }) } catch {}
})

describe('GET /api/run/transcript', () => {
  it('returns paged, formatEvent-rendered lines for an existing JSONL', async () => {
    const res = await app.request(
      `/api/run/transcript?sessionId=${SID}&path=${encodeURIComponent(projectPath)}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe(SID)
    // 5 raw lines, 1 blank dropped → 4 events.
    expect(body.total).toBe(4)
    expect(body.lines).toHaveLength(4)
    // First event is the system init, rendered (not raw JSONL).
    expect(body.lines[0].type).toBe('system')
    expect(body.lines[0].text).toContain('session started')
    // Indices are absolute over the non-blank sequence.
    expect(body.lines.map((l: any) => l.index)).toEqual([0, 1, 2, 3])
    // The assistant text event renders the human-readable text.
    expect(body.lines[1].text).toContain('こんにちは')
  })

  it('honours offset/limit paging', async () => {
    const res = await app.request(
      `/api/run/transcript?sessionId=${SID}&path=${encodeURIComponent(projectPath)}&offset=1&limit=2`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(4)
    expect(body.offset).toBe(1)
    expect(body.limit).toBe(2)
    expect(body.lines.map((l: any) => l.index)).toEqual([1, 2])
  })

  it('404s when the JSONL is missing (worktree pruned / never ran)', async () => {
    const res = await app.request(
      `/api/run/transcript?sessionId=ffffffff-0000-0000-0000-000000000000&path=${encodeURIComponent(projectPath)}`,
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/not found/i)
  })

  it('403s when path is outside projectsRoot', async () => {
    const res = await app.request(
      `/api/run/transcript?sessionId=${SID}&path=${encodeURIComponent('/etc')}`,
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not allowed/i)
  })

  it('400s on a missing sessionId', async () => {
    const res = await app.request(
      `/api/run/transcript?path=${encodeURIComponent(projectPath)}`,
    )
    expect(res.status).toBe(400)
  })

  it('400s on a path-traversal sessionId', async () => {
    const res = await app.request(
      `/api/run/transcript?sessionId=${encodeURIComponent('../../etc/passwd')}&path=${encodeURIComponent(projectPath)}`,
    )
    expect(res.status).toBe(400)
  })
})
