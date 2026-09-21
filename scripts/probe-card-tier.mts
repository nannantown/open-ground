#!/usr/bin/env tsx
// probe-card-tier — what model/effort would a swarm worker get for a card on
// THIS machine? Reads the real execution mode and the real allow-mask from
// settings.json (the inputs spawnSwarmWorker reads from disk) and prints the
// effective difficulty tier, the desired tier and the launch tier.
//
// ⚠ It does NOT see the running app's quota state: the cooling table and the
// usage cache are process-local (globalThis, filled by the server at runtime),
// so in this separate process they are empty and the launch tier is the one
// with NO cooling / usage veto. Read "launch" as "if nothing were cooling".
//
//   npx tsx scripts/probe-card-tier.mts [title] [tier] [notes]
//   npx tsx scripts/probe-card-tier.mts "認証まわりのトークン更新" touch
//
// READ-ONLY and free: it uses the SYNC resolver (resolveSwarmModelEffort), so no
// headless pre-launch probe is fired and no `claude` is started. Besides the
// quota state above, that probe is what it skips versus a real spawn — it
// protects an actual launch and has nothing to protect here.
import {
  desiredModelEffort,
  resolveCardTier,
  resolveSwarmModelEffort,
} from '../src/lib/server/swarmLaunch'
import { getAllowedModelTiers, getExecutionMode } from '../src/lib/server/store'
import { asTaskTier } from '../src/lib/types'

const main = async () => {
  const [title = '認証まわりのトークン更新', tierArg = 'touch', notes = ''] = process.argv.slice(2)
  const tier = asTaskTier(tierArg)
  const card = { title, notes, ...(tier ? { tier } : {}) }
  const mode = await getExecutionMode()
  const allowed = await getAllowedModelTiers()
  const resolvedTier = resolveCardTier(card)
  const desired = desiredModelEffort(mode, 'worker', card)
  const launch = resolveSwarmModelEffort(mode, 'worker', card, Date.now(), allowed)
  console.log(JSON.stringify({ card, mode, allowed, resolvedTier, desired, launch }, null, 2))
}

void main()
