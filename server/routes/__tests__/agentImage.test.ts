// The Mac chat's view of an image an agent put in its reply (`![…](/path)`):
// served only from where readAgentImage allows, only when the bytes are an
// image; with a project and a line key, the copy that line got first.
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { miscRoutes } from '../misc'
import { agentImageUrl } from '@/lib/agentImage'
import { registerTestProject } from '@/test/registerProject'

const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, fill)])

describe('GET /api/agent-image', () => {
  it('serves an image in the temp folder by its own type; refuses what is not an image or not allowed', async () => {
    const d = await mkdtemp(join(tmpdir(), 'og-agent-image-'))
    await writeFile(join(d, 'shot.jpg'), png(7)) // named .jpg, but it is a PNG
    await writeFile(join(d, 'notes.png'), 'just words')
    const ok = await miscRoutes.request(agentImageUrl(join(d, 'shot.jpg')))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(Buffer.from(await ok.arrayBuffer()).equals(png(7))).toBe(true)
    for (const path of [join(d, 'notes.png'), '/etc/hosts', 'relative.png', join(d, 'missing.png')])
      expect((await miscRoutes.request(agentImageUrl(path))).status).toBe(404)
    // A rebound DNS name gets nothing.
    expect((await miscRoutes.request(agentImageUrl(join(d, 'shot.jpg')), { headers: { host: 'evil.example:47776' } })).status).toBe(403)
  })

  it('a chat line keeps the image it showed first: a reused path or an emptied temp folder changes nothing', async () => {
    const project = await mkdtemp(join(tmpdir(), 'og-agent-image-project-'))
    await registerTestProject(project)
    const d = await mkdtemp(join(tmpdir(), 'og-agent-image-'))
    const shot = join(d, 'shot.png')
    await writeFile(shot, png(1))
    const line = agentImageUrl(shot, { project, key: 'session:public-3:2' })
    const bytes = async (url: string) => Buffer.from(await (await miscRoutes.request(url)).arrayBuffer())
    expect((await bytes(line)).equals(png(1))).toBe(true)
    await writeFile(shot, png(2)) // a new screenshot under the same name
    expect((await bytes(line)).equals(png(1))).toBe(true)
    expect((await bytes(agentImageUrl(shot, { project, key: 'session:public-9:2' }))).equals(png(2))).toBe(true) // a later line: the new one
    await rm(d, { recursive: true }) // the temp folder emptied
    expect((await bytes(line)).equals(png(1))).toBe(true)
    // An unregistered project is not a place to keep anything.
    expect((await miscRoutes.request(agentImageUrl(shot, { project: '/nowhere', key: 'k' }))).status).toBe(404)
  })
})
