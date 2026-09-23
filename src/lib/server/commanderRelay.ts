// commanderRelay — speak ONE line to the project's commander desk, waking one if
// none is standing. The single seam behind `POST /api/swarm/manager/say` (the
// owner's words, relayed by the supply desk) and the commander question lane
// (commanderQuestions.ts — a worker's question, held inside the company).
//
// Extracted from the route verbatim (2026-09-23) so the two callers cannot drift:
// both must refuse a CLOSED desk (one asked to stop refuses every push), both
// must preflight before a model launch, and both must report HELD honestly rather
// than claim a delivery that did not happen.

import { claudeRunPreflight } from './claudePreflight'
import { swarmEnvPreflight } from './swarmEnvPreflight'
import { spawnSwarmManager } from './swarmManager'
import { listManagerDesks, sayToManagerDesk } from './swarmManagerRuntime'
import { noticeDeliverable } from './deskDeliverable'

export type CommanderRelayResult =
  | {
      ok: true
      delivered: boolean
      runtime: 'pty' | 'sdk'
      woke: boolean
      heldBecause?: string
    }
  | {
      ok: false
      /** 503 = nobody could be woken; 404 = no desk and waking was not asked for. */
      status: 404 | 503
      body: Record<string, unknown>
    }

export interface CommanderRelayDeps {
  preflight: typeof claudeRunPreflight
  envPreflight: typeof swarmEnvPreflight
  spawn: typeof spawnSwarmManager
  desks: typeof listManagerDesks
  say: typeof sayToManagerDesk
}

const defaultDeps: CommanderRelayDeps = {
  preflight: claudeRunPreflight,
  envPreflight: swarmEnvPreflight,
  spawn: spawnSwarmManager,
  desks: listManagerDesks,
  say: sayToManagerDesk,
}

export const relayToCommander = async (
  path: string,
  text: string,
  opts: { wake?: boolean } = {},
  partial: Partial<CommanderRelayDeps> = {},
): Promise<CommanderRelayResult> => {
  const deps = { ...defaultDeps, ...partial }
  // A desk asked to stop is CLOSED — it refuses every push — so speaking to it
  // is not "held, try later", it is nobody home.
  const liveDesk = () => deps.desks(path).find((d) => !d.stopping) ?? null
  let desk = liveDesk()
  let woke = false
  if (!desk && opts.wake !== false) {
    const pre = await deps.preflight()
    if (!pre.ok) return { ok: false, status: 503, body: { ...pre.body, delivered: false, woke: false } }
    const envPre = await deps.envPreflight(path, { force: true, requireGitRepo: false })
    if (!envPre.ok) {
      return {
        ok: false,
        status: 503,
        body: {
          error: envPre.issues.map((i) => i.message).join(' '),
          envIssues: envPre.issues.map((i) => i.id),
          delivered: false,
          woke: false,
        },
      }
    }
    try {
      await deps.spawn({ projectPath: path })
      desk = liveDesk()
      woke = desk !== null
    } catch (e: any) {
      return {
        ok: false,
        status: 503,
        body: { error: `failed to wake the commander: ${e?.message ?? e}`, delivered: false, woke: false },
      }
    }
  }
  if (!desk) return { ok: false, status: 404, body: { error: 'no commander desk is running in this project' } }
  const res = deps.say(desk, text, { deliverable: noticeDeliverable })
  return {
    ok: true,
    delivered: res.ok,
    runtime: desk.runtime,
    woke,
    ...(res.heldBecause ? { heldBecause: res.heldBecause } : {}),
  }
}
