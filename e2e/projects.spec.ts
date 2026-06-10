import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

// Project registry user-journey: import an existing folder, see it on the
// canvas, then remove it. Covers the import → list → render → remove path that
// a user drives from the empty state / "Import existing folder" button.
//
// Folder DELETION (POST /api/project/delete) is intentionally NOT exercised
// here: it moves the folder to the macOS Trash via JXA, which is both
// destructive and macOS-only — wrong fit for a cross-platform E2E. The registry
// side of delete is better covered by a unit test.

test.describe('Project registry', () => {
  test('import registers a folder and it appears in /api/projects', async ({ request }) => {
    const project = await createAndImportProject(request, 'projects')

    const list = await request.get('/api/projects')
    expect(list.status()).toBe(200)
    const projects = (await list.json()).projects as Array<{ id: string; path: string }>
    expect(projects.some((p) => p.id === project.id && p.path === project.path)).toBe(true)
  })

  test('an imported project renders as a card on the canvas', async ({ request, page }) => {
    const project = await createAndImportProject(request, 'card')
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // The card hero shows the folder name verbatim — a real user-visible signal
    // that the import landed, not just an API row.
    await expect(page.getByText(project.name, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    })
  })

  test('remove unregisters the project (folder left on disk)', async ({ request }) => {
    const project = await createAndImportProject(request, 'remove')

    const res = await request.post('/api/projects/remove', { data: { path: project.path } })
    expect(res.status()).toBe(200)

    const list = await request.get('/api/projects')
    const projects = (await list.json()).projects as Array<{ id: string }>
    expect(projects.some((p) => p.id === project.id)).toBe(false)

    // Removing again is a 404 (idempotency boundary).
    const again = await request.post('/api/projects/remove', { data: { path: project.path } })
    expect(again.status()).toBe(404)
  })
})
