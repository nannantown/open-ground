// canvasPathTraversal.test.ts — security contract for the canvas id endpoints.
//
// The canvas id is echoed from the client (GET ?id / POST canvas.id / rename /
// delete / active) and was joined straight into the on-disk path
// (`<canvasesDir>/<id>.json`) with no validation. A `../`-laden id let the path
// escape the canvases dir and reach ~/.openground/auth.json (OAuth token READ)
// or settings.json (arbitrary WRITE). This proves:
//   (1) a traversal id is rejected (400) on every canvas route
//   (2) a valid uuid id still passes (GET + save)
//   (3) auth.json is never leaked and settings.json is never overwritten
//   (4) the canvasData layer rejects a traversal id even when called directly
//       (defense in depth — structural last line, not just the route guard)
// HOME is the throwaway test home (setup-home.ts → OPENGROUND_HOME under tmp).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath, readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { app } from '../../app'
import { registerTestProject } from '../../../src/test/registerProject'
import { createCanvas, readCanvasFile, saveCanvasFile } from '@/lib/server/canvasData'
import { projectDataDir } from '@/lib/server/projectDataPath'
import { authFile, settingsFile, openGroundHome } from '@/lib/server/paths'
import type { CanvasFile } from '@/lib/types'

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const getCanvas = (path: string, id: string) =>
  app.request(
    `/api/project/canvases?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`,
  )

// `${id}.json` for these ids resolves OUT of <canvasesDir> and onto the
// protected home-dir files (see the sanity test below for the proof).
const AUTH_TRAVERSAL = '../../../auth'
const SETTINGS_TRAVERSAL = '../../../settings'
const SECRET = 'SUPER_SECRET_OAUTH_TOKEN_do_not_leak'

describe('canvas id path traversal hardening', () => {
  let projectPath: string
  let savedAuth: string | null
  let settingsBefore: string

  beforeEach(async () => {
    projectPath = await realpath(await mkdtemp(join(tmpdir(), 'og-canvas-traversal-')))
    await registerTestProject(projectPath)
    // The registry lives in settings.json; snapshot it so a traversal SAVE can be
    // proven NOT to have overwritten it (rather than planting a sentinel, which
    // would wipe the registry and break validateProjectPath).
    settingsBefore = await readFile(settingsFile(), 'utf8')
    // Plant a secret auth.json (the real OAuth token store) so a traversal READ
    // would leak it if unguarded. Snapshot + restore so other suites in the
    // same worker see the original (or absent) file afterwards.
    savedAuth = await readFile(authFile(), 'utf8').catch(() => null)
    await mkdir(openGroundHome(), { recursive: true })
    await writeFile(authFile(), JSON.stringify({ accessToken: SECRET }))
  })

  afterEach(async () => {
    if (savedAuth === null) await unlink(authFile()).catch(() => {})
    else await writeFile(authFile(), savedAuth)
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('sanity: the traversal ids really resolve onto auth.json / settings.json', async () => {
    // If this breaks (data-dir layout changed), the attack target moved — the
    // guard tests below would pass vacuously, so assert the target explicitly.
    const canvasesDir = join(await projectDataDir(projectPath), 'canvases')
    expect(resolve(canvasesDir, `${AUTH_TRAVERSAL}.json`)).toBe(resolve(authFile()))
    expect(resolve(canvasesDir, `${SETTINGS_TRAVERSAL}.json`)).toBe(resolve(settingsFile()))
  })

  it('GET ?id=<traversal> → 400 and never leaks auth.json', async () => {
    const res = await getCanvas(projectPath, AUTH_TRAVERSAL)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain(SECRET)
  })

  it('GET ?id=<valid uuid> → 200 (valid ids still pass)', async () => {
    const { canvas } = await createCanvas(projectPath, 'C1')
    const res = await getCanvas(projectPath, canvas.id)
    expect(res.status).toBe(200)
    expect(((await res.json()) as CanvasFile).id).toBe(canvas.id)
  })

  it('POST save with canvas.id=<traversal> → 400 and never overwrites settings.json', async () => {
    const res = await app.request(
      '/api/project/canvases',
      postJson({
        path: projectPath,
        canvas: { id: SETTINGS_TRAVERSAL, rev: 0, name: 'pwn', elements: [] },
      }),
    )
    expect(res.status).toBe(400)
    expect(await readFile(settingsFile(), 'utf8')).toBe(settingsBefore)
  })

  it('POST save with a valid uuid id → 200 (valid ids still pass)', async () => {
    const { canvas } = await createCanvas(projectPath, 'C1')
    const res = await app.request(
      '/api/project/canvases',
      postJson({ path: projectPath, canvas: { ...canvas, elements: [] } }),
    )
    expect(res.status).toBe(200)
  })

  it.each(['delete', 'rename', 'active'] as const)(
    'POST action=%s with id=<traversal> → 400',
    async (action) => {
      const res = await app.request(
        `/api/project/canvases?action=${action}`,
        postJson({ path: projectPath, id: AUTH_TRAVERSAL, name: 'pwn' }),
      )
      expect(res.status).toBe(400)
    },
  )

  it('defense in depth: canvasData rejects a traversal id even when called directly', async () => {
    // readCanvasFile swallows the canvasFilePath throw → null (never reads auth.json).
    expect(await readCanvasFile(projectPath, AUTH_TRAVERSAL)).toBeNull()
    // saveCanvasFile propagates the throw → settings.json left untouched.
    const { canvas } = await createCanvas(projectPath, 'C1')
    await expect(
      saveCanvasFile(projectPath, { ...canvas, id: SETTINGS_TRAVERSAL }),
    ).rejects.toThrow(/invalid canvas id/)
    expect(await readFile(settingsFile(), 'utf8')).toBe(settingsBefore)
  })
})
