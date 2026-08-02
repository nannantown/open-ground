// WHAT THE OWNER ACTUALLY SEES WHEN settings.json IS BROKEN.
//
// `GET /api/projects` is the Ground's first fetch — the whole cockpit hangs off
// it. Its very first statement is `ensureProjectsMigrated()`, and on a settings
// file we cannot read that migration decides "not migrated yet" (the sentinel
// `projectsMigratedAt` is invisible, and DEFAULT_SETTINGS has none), so it tries
// to stamp the sentinel via `setSettings` — which the write guard now refuses.
// The rejection reaches app.ts's onError and becomes a 500.
//
// So the real headline consequence is NOT "settings changes cannot be saved".
// It is: WHILE settings.json IS BROKEN, THE GROUND DOES NOT OPEN — and the owner
// reaches that state by merely launching the app, having saved nothing.
//
// THIS FILE EXISTS TO KEEP THAT 500. It looks like a bug and the obvious "fix"
// is to skip the migration when the file is unreadable and return 200. That
// would be far worse: the Ground would render EMPTY, which to the owner is
// indistinguishable from "every project I ever registered is gone", and the
// natural reaction — re-register them — walks straight into the same guard from
// the other side. A 500 whose body names the cause is the kinder failure.
//
// Measured 2026-08-02 before the write guard existed: this same request returned
// 200 AND rewrote settings.json, erasing both registered projects. Opening the
// app was enough to destroy the registry.

import { describe, it, expect, afterEach } from 'vitest'
import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { app } from '../../app'
import { settingsFile } from '@/lib/server/paths'

const SEED = JSON.stringify({
  projects: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', path: '/tmp/proj-a', addedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', path: '/tmp/proj-b', addedAt: '2026-01-02T00:00:00.000Z' },
  ],
  defaultWorkspace: '/tmp/ws',
})

afterEach(async () => {
  await chmod(settingsFile(), 0o600).catch(() => {})
  await rm(settingsFile(), { force: true }).catch(() => {})
})

describe('GET /api/projects with a settings.json we cannot read', () => {
  it('fails loudly instead of quietly emptying the registry', async () => {
    await mkdir(dirname(settingsFile()), { recursive: true })
    // Corrupt rather than chmod: it bites on every platform, and it is the shape
    // a truncated write leaves behind.
    await writeFile(settingsFile(), '{ "projects": [{"id":"aaaa"}] ,,, truncated', 'utf8')
    const before = await readFile(settingsFile(), 'utf8')

    const res = await app.request('/api/projects')

    expect(res.status).toBe(500)
    // The body must name the cause — this is what the owner reads in the
    // Ground's load error, and "internal error" would tell them nothing.
    expect((await res.json()).error).toMatch(/settings\.json/)
    // THE assertion that matters: the file the owner still needs is untouched,
    // byte for byte. Before the guard, this request REWROTE it.
    expect(await readFile(settingsFile(), 'utf8')).toBe(before)
  })

  it('a healthy settings.json still loads the Ground normally', async () => {
    // The control: the guard must not have turned a working cockpit into a 500.
    await mkdir(dirname(settingsFile()), { recursive: true })
    await writeFile(settingsFile(), SEED, 'utf8')

    const res = await app.request('/api/projects')
    expect(res.status).toBe(200)
    expect((await res.json()).settings.projects).toHaveLength(2)
  })
})
