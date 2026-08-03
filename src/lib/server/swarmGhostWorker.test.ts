import { describe, it, expect } from 'vitest'
import { listSwarmWorkers } from './swarmWorkerRegistry'

// ─── a worker whose worktree is gone is not a worker ─────────────────────────
//
// THE GHOST (overnight review 2026-08-04). Terminating a worker removes its
// worktree but NOT its heartbeat file — the worker wrote that file, and
// removeSwarmWorktree never touches ~/.openground/swarm/. The heartbeat-only
// arm of listSwarmWorkers then kept resurrecting the worker for as long as the
// file survived: drawn in the Swarm tab with a Restart button that cannot work,
// because the directory it would restart in no longer exists.
//
// "The work is still on disk" is that arm's whole premise, so a missing
// directory falsifies it. These pin BOTH directions — the ghost disappears, and
// a real dead-but-present worker (the case the arm exists for) still shows.

const baseDeps = (over: Record<string, unknown> = {}) =>
  ({
    listActiveTerminals: () => ({ cwds: [], claude: [] }),
    listActiveSdkWorkers: () => [],
    getOrchestratorState: async () => ({ running: false, workers: [] }) as never,
    readHeartbeats: async () =>
      new Map([['/wt/gone', { branch: 'swarm/gone', updatedAt: new Date().toISOString() }]]) as never,
    branchOfWorktree: async () => null,
    resolveCentralWorktreesDir: async () => '/wt',
    ...over,
  }) as never

describe('listSwarmWorkers — heartbeat-only arm', () => {
  it('drops a heartbeat whose worktree no longer exists (the ghost)', async () => {
    const out = await listSwarmWorkers('/repo', baseDeps({ worktreeExists: async () => false }))
    expect(out).toHaveLength(0)
  })

  it('still lists a DEAD worker whose worktree is intact — the arm exists for exactly this', async () => {
    const out = await listSwarmWorkers('/repo', baseDeps({ worktreeExists: async () => true }))
    expect(out).toHaveLength(1)
    expect(out[0].branch).toBe('swarm/gone')
  })

  it('a failing existence check degrades to SHOWING it — never hide a real worker on an fs hiccup', async () => {
    const out = await listSwarmWorkers(
      '/repo',
      baseDeps({
        worktreeExists: async () => {
          throw new Error('EIO')
        },
      }),
    )
    expect(out).toHaveLength(1)
  })

  it('deps without the check behave exactly as before (back-compat for older callers)', async () => {
    const out = await listSwarmWorkers('/repo', baseDeps())
    expect(out).toHaveLength(1)
  })
})
