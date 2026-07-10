import { describe, expect, it } from 'vitest'
import { aggregateClaudeBeacons, type BeaconProject } from './groundBeacon'
import type { ClaudeActivity } from '@/lib/types'

const OG: BeaconProject = { id: 'uuid-og', path: '/Users/me/projects/OPEN GROUND' }
const NENE: BeaconProject = { id: 'uuid-nene', path: '/Users/me/projects/NENE' }
const PROJECTS = [OG, NENE]

// A swarm worker's cwd: the isolated worktree under the project's CENTRAL
// worktrees dir — deliberately OUTSIDE the project folder.
const worktree = (uuid: string, branch: string) =>
  `/Users/me/.openground/projects/${uuid}/worktrees/${branch}`

const pane = (a: Partial<ClaudeActivity> & Pick<ClaudeActivity, 'cwd' | 'status'>): ClaudeActivity =>
  ({ id: a.id ?? 'pty-' + a.cwd, ...a }) as ClaudeActivity

describe('aggregateClaudeBeacons', () => {
  it('attributes a worker in a CENTRAL worktree to its parent card (the reported bug)', () => {
    // Exactly the observed shape: the repo-root pane idles at its prompt while
    // the worker hammers away in a worktree. The card must read `working`.
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: OG.path, status: 'waiting' }),
      pane({ cwd: worktree('uuid-og', 'swarm-fix'), status: 'working', projectId: 'uuid-og' }),
    ])
    expect(map.get('uuid-og')).toBe('working')
  })

  it('a worktree session with NO projectId is not misattributed by prefix', () => {
    // The cwd sits under neither project path, so a server that omits the field
    // simply yields no beacon rather than lighting the wrong card.
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: worktree('uuid-og', 'swarm-fix'), status: 'working' }),
    ])
    expect(map.size).toBe(0)
  })

  it('working wins over waiting regardless of list order', () => {
    const both = (order: ClaudeActivity[]) => aggregateClaudeBeacons(PROJECTS, order).get('uuid-og')
    const working = pane({ cwd: OG.path, status: 'working', projectId: 'uuid-og' })
    const waiting = pane({ cwd: OG.path + '/sub', status: 'waiting', projectId: 'uuid-og' })
    expect(both([working, waiting])).toBe('working')
    expect(both([waiting, working])).toBe('working')
  })

  it('one working worker among many waiting ones still lights the card', () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: worktree('uuid-og', 'a'), status: 'waiting', projectId: 'uuid-og' }),
      pane({ cwd: worktree('uuid-og', 'b'), status: 'waiting', projectId: 'uuid-og' }),
      pane({ cwd: worktree('uuid-og', 'c'), status: 'working', projectId: 'uuid-og' }),
      pane({ cwd: worktree('uuid-og', 'd'), status: 'waiting', projectId: 'uuid-og' }),
    ])
    expect(map.get('uuid-og')).toBe('working')
  })

  it('waiting only when every session truly waits', () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: OG.path, status: 'waiting' }),
      pane({ cwd: worktree('uuid-og', 'a'), status: 'waiting', projectId: 'uuid-og' }),
    ])
    expect(map.get('uuid-og')).toBe('waiting')
  })

  it("one project's worker never bleeds into another card", () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: worktree('uuid-nene', 'a'), status: 'working', projectId: 'uuid-nene' }),
      pane({ cwd: OG.path, status: 'waiting', projectId: 'uuid-og' }),
    ])
    expect(map.get('uuid-nene')).toBe('working')
    expect(map.get('uuid-og')).toBe('waiting')
  })

  it('a projectId for a project absent from the Ground is ignored (no phantom card)', () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: '/elsewhere/repo', status: 'working', projectId: 'uuid-unregistered' }),
    ])
    expect(map.size).toBe(0)
  })

  it('falls back to the cwd prefix when the server omits projectId (old server)', () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: OG.path + '/src', status: 'working' }),
    ])
    expect(map.get('uuid-og')).toBe('working')
  })

  it('a sibling path sharing a prefix does not match', () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: OG.path + '-old', status: 'working' }),
    ])
    expect(map.size).toBe(0)
  })

  it('projects with no live claude pane are absent (no beacon at all)', () => {
    const map = aggregateClaudeBeacons(PROJECTS, [
      pane({ cwd: NENE.path, status: 'working', projectId: 'uuid-nene' }),
    ])
    expect(map.has('uuid-og')).toBe(false)
  })

  it('empty session list → empty map', () => {
    expect(aggregateClaudeBeacons(PROJECTS, []).size).toBe(0)
  })
})
