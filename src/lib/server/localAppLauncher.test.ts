import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ projects: [] as { path: string }[] }))
vi.mock('./store', () => ({ getSettings: async () => settings }))

import { findNeneDir, probeNene, startNene } from './localAppLauncher'

afterEach(() => { vi.unstubAllGlobals(); settings.projects = [] })

describe('NENE Songs launcher', () => {
  const repo = (prefix: string, name: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    writeFileSync(join(dir, 'serve.js'), '')
    writeFileSync(join(dir, 'songs-data.js'), '')
    if (name) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
    return dir
  }

  it('finds only the registered folder whose package.json is nene-songs', async () => {
    const lookalike = repo('og-other-', 'something-else')
    const noPkg = repo('og-nopkg-', null)
    const nene = repo('og-nene-', 'nene-songs')
    settings.projects = [{ path: lookalike }, { path: noPkg }, { path: nene }]
    expect(await findNeneDir()).toBe(nene)
  })

  it('treats an error status on :8899 as down, not up', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 500 }))
    expect(await probeNene()).toBe(false)
  })

  it('reports not-found instead of spawning when NENE is not registered', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down') })
    expect(await startNene()).toEqual({ ok: false, reason: 'not-found' })
  })

  it('does not start anything when serve.js already answers', async () => {
    vi.stubGlobal('fetch', async () => new Response(null))
    expect(await startNene()).toEqual({ ok: true, already: true })
  })
})
