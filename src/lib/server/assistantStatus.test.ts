import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerTestProject } from '../../test/registerProject'
import { mutateProjectData } from './projectData'
import { projectDataFile } from './projectDataPath'
import { escalationsFile } from './paths'
import { assistantDigest } from './phoneAssistant'

let project: string
let projectId: string
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'assistant-status-'))
  projectId = await registerTestProject(project)
  await writeFile(escalationsFile(), JSON.stringify({ items: [] }))
  await mutateProjectData(project, d => {
    d.tasks.push({ id: 'tracked-card', title: 'Track this request', notes: 'Goal: keep the button confirmation', done: false, createdAt: '2026-10-21T01:00:00Z', boardColumn: 'doing' })
  })
})

describe('a sourced current status without starting any work', () => {
  it('names the observation time, source and exact card identity', async () => {
    const { text } = await assistantDigest()
    expect(text).toContain('Observed at:')
    expect(text).toContain('Board updated:')
    expect(text).toContain(await projectDataFile(project, 'tasks.json'))
    expect(text).toContain('taskId: tracked-card')
  })

  it('a corrupt Board stays unknown and is preserved, not reported as zero work', async () => {
    const file = await projectDataFile(project, 'tasks.json')
    await writeFile(file, '{broken')
    const { text } = await assistantDigest()
    const row = text.split('\n').find(l => l.includes(`projectId: ${projectId}`))!
    expect(row).toContain('Board unknown')
    expect(row).not.toContain('todo 0')
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })

  it('an unreadable owner inbox is unknown, not nothing waiting', async () => {
    await writeFile(escalationsFile(), '{broken')
    expect((await assistantDigest()).text).toContain('Owner questions unknown')
  })

  it('looks up an exact card, including current state and notes, without changing it', async () => {
    const file = await projectDataFile(project, 'tasks.json')
    const before = await readFile(file, 'utf8')
    const { text } = await assistantDigest({ projectId, taskId: 'tracked-card' })
    expect(text).toContain('Requested card tracked-card:')
    expect(text).toContain('state: doing')
    expect(text).toContain('Goal: keep the button confirmation')
    expect(text).toContain('engine-journal.jsonl')
    expect(text).toContain('not a president/commander conversation transcript')
    expect(await readFile(file, 'utf8')).toBe(before)
    await mutateProjectData(project, d => { d.tasks[0].boardColumn = 'done'; d.tasks[0].done = true })
    expect((await assistantDigest({ projectId, taskId: 'tracked-card' })).text).toContain('state: done')
  })

  it('does not look up cards without an exact registered destination', async () => {
    expect((await assistantDigest({ projectId: 'not-registered', taskId: 'tracked-card' })).text).toContain('No records were read')
    expect((await assistantDigest({ taskId: 'tracked-card' })).text).toContain('Choose a registered projectId')
    expect((await assistantDigest({ projectId, taskId: 'no-such-card' })).text).toContain('Do not infer completion or recreate it')
  })

  it('hides secret values from card notes and source claims', async () => {
    await mutateProjectData(project, d => { d.tasks[0].notes = 'apiKey=FAKE_PRIVATE_VALUE' })
    const { text } = await assistantDigest({ projectId, taskId: 'tracked-card' })
    expect(text).not.toContain('FAKE_PRIVATE_VALUE')
    expect(text).toContain('[hidden]')
  })

  it('uses the production Board legacy filter rather than resurrecting retired chats', async () => {
    const file = await projectDataFile(project, 'tasks.json')
    const data = JSON.parse(await readFile(file, 'utf8'))
    data.tasks.push({ id: 'retired-chat', kind: 'chat', title: 'RETIRED_CHAT', done: false, createdAt: '2026-01-01', boardColumn: 'doing' })
    data.tasks.push({ id: 'legacy-card', kind: 'board', title: 'LEGACY_CARD', done: false, createdAt: '2026-01-01' })
    await writeFile(file, JSON.stringify(data))
    const { text } = await assistantDigest({ projectId })
    expect(text).not.toContain('RETIRED_CHAT')
    expect(text).toContain('LEGACY_CARD')
    expect(text).toContain('doing 1')
  })

  it('a missing registered folder is reported and excluded from proposal destinations', async () => {
    const { rm } = await import('fs/promises')
    await rm(project, { recursive: true })
    const { text, projects } = await assistantDigest()
    expect(text).toContain('Project folder unavailable')
    expect(projects.map(p => p.id)).not.toContain(projectId)
  })

  it('does not follow a Board symlink outside the assistant read roots', async () => {
    const { unlink } = await import('fs/promises')
    const outside = await mkdtemp(join(tmpdir(), 'unregistered-status-'))
    const target = join(outside, 'private.json')
    await writeFile(target, JSON.stringify({ tasks: [{ id: 'private', title: 'PRIVATE_OUTSIDE', done: false, createdAt: '', boardColumn: 'doing' }] }))
    const file = await projectDataFile(project, 'tasks.json')
    await unlink(file)
    await symlink(target, file)
    const { text } = await assistantDigest()
    expect(text).toContain('Board unknown')
    expect(text).not.toContain('PRIVATE_OUTSIDE')
  })
})
