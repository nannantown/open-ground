import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { getSettings } from '@/lib/server/store'
import { computeExperiments } from '@/lib/server/experiments'

let home: string
let previousHome: string | undefined
const legacyData = {
  'you-corpus.md': '# Local archive\nPrivate observations stay on disk.\n',
  'you-corpus-additions.json': '[{"id":"archive","text":"Keep this note"}]',
  'persona-courses.json': '{"archived":true}',
  'persona-ledger.json': '{"archived":true}',
}

beforeEach(async () => {
  previousHome = process.env.OPENGROUND_HOME
  home = await mkdtemp(join(tmpdir(), 'og-retired-persona-'))
  process.env.OPENGROUND_HOME = home
  for (const [name, body] of Object.entries(legacyData)) await writeFile(join(home, name), body)
  await writeFile(join(home, 'settings.json'), JSON.stringify({ personaOptIn: true, experiments: { persona: true } }))
})

afterEach(async () => {
  if (previousHome) process.env.OPENGROUND_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('retired Persona', () => {
  it('has no API readers or writers, even with legacy opt-ins on disk', async () => {
    for (const [method, path] of [
      ['GET', '/api/you-corpus/raw'],
      ['GET', '/api/you-corpus/judgments'],
      ['GET', '/api/persona/courses'],
      ['GET', '/api/persona/chat'],
      ['POST', '/api/you-corpus/append'],
      ['POST', '/api/persona/chat'],
      ['POST', '/api/persona/import'],
    ]) {
      const response = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    for (const [name, body] of Object.entries(legacyData)) expect(await readFile(join(home, name), 'utf8')).toBe(body)
  })

  it('does not advertise Persona to an owner with old settings', async () => {
    const resolved = computeExperiments('owner', await getSettings())
    expect(resolved.flags).toEqual({ swarm: false, sandbox: false })
    expect(resolved).not.toHaveProperty('personaOptIn')
  })
})
