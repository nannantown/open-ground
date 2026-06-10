import { mkdtemp, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, type APIRequestContext } from '@playwright/test'

// Shared E2E helpers. These drive the real Hono server (booted in prod mode by
// playwright.config's webServer) over its HTTP API. The server runs with an
// isolated HOME + OPENGROUND_HOME and a fake `claude` CLI (see the config), so
// these flows exercise the real registry without touching the user's
// environment or needing a live subscription.

export interface ImportedProject {
  id: string
  /** Server-canonical path (symlinks resolved) — use this for API payloads. */
  path: string
  /** Folder basename, used as the project name. */
  name: string
}

// Create a throwaway folder on disk and register it via POST /api/projects/import.
// The test process and the server share the same filesystem, so a dir we make
// here under os.tmpdir() is visible to the server. Returns the registered entry.
export const createAndImportProject = async (
  request: APIRequestContext,
  label = 'proj',
): Promise<ImportedProject> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `og-e2e-${label}-`)))
  // Drop a file in so the folder looks like a real project.
  await writeFile(join(dir, 'README.md'), `# ${label}\n`)

  const res = await request.post('/api/projects/import', { data: { path: dir } })
  expect(res.status(), `import ${dir}`).toBe(200)
  const body = await res.json()
  expect(body.id).toBeTruthy()
  return { id: body.id, path: body.path as string, name: basename(body.path) }
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p
