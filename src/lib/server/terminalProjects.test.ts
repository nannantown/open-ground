import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { attachProjectIds } from './terminalProjects'
import { projectUUIDsForPaths } from './projectDataPath'
import { centralWorktreesDir, projectCentralDir } from './paths'
import { registerTestProject } from '../../test/registerProject'
import type { ActiveTerminalsResponse } from '@/lib/types'

const res = (claude: ActiveTerminalsResponse['claude']): ActiveTerminalsResponse => ({
  cwds: claude.map((a) => a.cwd),
  claude,
})

describe('projectUUIDsForPaths (batch attribution)', () => {
  let dir: string
  let uuid: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-tp-'))
    uuid = await registerTestProject(dir)
  })

  it('resolves the registered root, a subdir, and a CENTRAL worktree to one uuid', async () => {
    const wt = join(centralWorktreesDir(uuid), 'swarm-fix')
    await mkdir(join(wt, 'src'), { recursive: true })
    const map = await projectUUIDsForPaths([dir, join(dir, 'src'), wt, join(wt, 'src')])
    expect(map.get(dir)).toBe(uuid)
    expect(map.get(join(dir, 'src'))).toBe(uuid)
    expect(map.get(wt)).toBe(uuid)
    expect(map.get(join(wt, 'src'))).toBe(uuid)
  })

  it('maps an unowned path to null instead of throwing (a free shell in ~/)', async () => {
    const stray = await mkdtemp(join(tmpdir(), 'og-stray-'))
    const map = await projectUUIDsForPaths([stray])
    expect(map.get(stray)).toBeNull()
  })

  it('does NOT attribute the bare central data root (mirrors the security rule)', async () => {
    const central = projectCentralDir(uuid)
    await mkdir(join(central, 'canvases'), { recursive: true })
    const map = await projectUUIDsForPaths([central, join(central, 'canvases')])
    expect(map.get(central)).toBeNull()
    expect(map.get(join(central, 'canvases'))).toBeNull()
  })

  it('does not let a sibling dir sharing the root prefix match', async () => {
    const map = await projectUUIDsForPaths([dir + '-old'])
    expect(map.get(dir + '-old')).toBeNull()
  })
})

describe('attachProjectIds', () => {
  it('stamps projectId on the panes the resolver owns, leaves the rest bare', async () => {
    const out = await attachProjectIds(
      res([
        { id: 'a', cwd: '/repo', status: 'waiting' },
        { id: 'b', cwd: '/central/uuid-1/worktrees/w', status: 'working' },
        { id: 'c', cwd: '/home/me', status: 'waiting' },
      ]),
      async () =>
        new Map([
          ['/repo', 'uuid-1'],
          ['/central/uuid-1/worktrees/w', 'uuid-1'],
          ['/home/me', null],
        ]),
    )
    expect(out.claude.map((a) => a.projectId)).toEqual(['uuid-1', 'uuid-1', undefined])
    // cwds passes through untouched.
    expect(out.cwds).toEqual(['/repo', '/central/uuid-1/worktrees/w', '/home/me'])
  })

  it('deduplicates cwds before resolving (N panes in one worktree = one lookup)', async () => {
    const seen: string[][] = []
    await attachProjectIds(
      res([
        { id: 'a', cwd: '/w', status: 'working' },
        { id: 'b', cwd: '/w', status: 'waiting' },
      ]),
      async (paths) => {
        seen.push([...paths])
        return new Map([['/w', 'uuid-1']])
      },
    )
    expect(seen[0]).toEqual(['/w'])
  })

  it('returns the response untouched when the resolver throws (never 500s a poll)', async () => {
    const input = res([{ id: 'a', cwd: '/repo', status: 'working' }])
    const out = await attachProjectIds(input, async () => {
      throw new Error('settings.json unreadable')
    })
    expect(out).toEqual(input)
  })

  it('skips the registry read entirely when no claude pane is live', async () => {
    let called = false
    const input = res([])
    const out = await attachProjectIds(input, async () => {
      called = true
      return new Map()
    })
    expect(called).toBe(false)
    expect(out).toBe(input)
  })
})
