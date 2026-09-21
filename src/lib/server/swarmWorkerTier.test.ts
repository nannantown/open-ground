// The card's difficulty tier reaches the model resolver on EVERY worker spawn
// (2026-09-18). swarmOrchestrator.test.ts pins that the engine hands `tier` to
// spawnWorker; this pins the other half — spawnSwarmWorker passes it (with the
// title/notes the safety floor reads) into resolveSwarmModelEffortProbed, the
// function that actually picks `--model` / `--effort`. Without this half the
// engine could thread the tier all the way to a spawn that silently drops it.
//
// The resolver is captured and made to return null (every tier OFF), so the spawn
// throws NoAllowedModelTierError BEFORE any worktree or claude exists — nothing
// real is created. Red measured 2026-09-18 by dropping `tier: opts.tier` from the
// resolver call in swarmWorker.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const seen: unknown[] = []

vi.mock('./claudeTerminal', () => ({
  launchClaude: () => {
    throw new Error('launchClaude must never be reached')
  },
}))
vi.mock('./hooksInstall', () => ({ ensureGuardWiring: async () => ({ ok: true, problems: [] }) }))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async (_mode: unknown, _role: unknown, card: unknown) => {
    seen.push(card)
    return null
  },
}))

import { spawnSwarmWorker } from './swarmWorker'
import { NoAllowedModelTierError } from './swarmAllowedModels'

let scratch = ''
let savedHome: string | undefined

beforeEach(async () => {
  seen.length = 0
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-workertier-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
})

afterEach(async () => {
  // Never UNSET a home env var (testHomeEnvGuard): restore a saved value, else
  // leave the isolated one in place — vitest isolates env per test file.
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

describe('spawnSwarmWorker — the card tier reaches the model resolver', () => {
  it('passes tier + title + notes to resolveSwarmModelEffortProbed', async () => {
    await expect(
      spawnSwarmWorker({
        projectPath: join(scratch, 'proj'),
        title: '認証まわりの修正',
        notes: 'auth token refresh',
        tier: 'touch',
      }),
    ).rejects.toBeInstanceOf(NoAllowedModelTierError)
    expect(seen).toEqual([{ title: '認証まわりの修正', notes: 'auth token refresh', tier: 'touch' }])
  })

  it('an untiered spawn passes tier undefined (the estimator decides)', async () => {
    await expect(
      spawnSwarmWorker({ projectPath: join(scratch, 'proj'), title: 'add a button' }),
    ).rejects.toBeInstanceOf(NoAllowedModelTierError)
    expect(seen).toHaveLength(1)
    expect((seen[0] as { tier?: string }).tier).toBeUndefined()
  })
})
