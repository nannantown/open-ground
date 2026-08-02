#!/usr/bin/env tsx
// probe-sdk-manager-launch — boot a commander on the SDK runtime using the
// PRODUCTION launch plan, and show what it actually did.
//
// WHY IT IS THE REAL PLAN AND NOT A HAND-ROLLED ONE. Measuring an arrangement
// that differs from production is how OPEN GROUND has mis-concluded before (the
// PTY's direct child is `zsh -l`, not `claude`; a kill relayed through a shell
// reports 128+n). So this calls `sdkManagerLaunchPlan` verbatim and hands the
// result to the same `spawnSdkSession` the server uses. What it proves, in one
// run: the user's claude resolves, the preflight passes, the SDK accepts every
// option, `/og-manage` LOADS (its first instruction is a health curl), and the
// app-context card reached the model (the commander knows its API base URL).
//
//   npx tsx scripts/probe-sdk-manager-launch.mts [projectPath]
//
// Bounded: maxTurns 1, so it boots, does its first read-only step, and stops.
// It does NOT record a session in swarmSessions, so nothing the app owns is
// touched and no desk is adopted by a later spawn.

import { sdkManagerLaunchPlan, sdkManagerPreflight } from '../src/lib/server/swarmManagerSdk'
import {
  spawnSdkSession,
  preloadSdk,
  getSdkSession,
  attachSdkListener,
  terminateSdkSession,
} from '../src/lib/server/sdkSession'
import { randomUUID } from 'crypto'

const main = async () => {
  const projectPath = process.argv[2] ?? process.cwd()

  const pre = sdkManagerPreflight()
  console.log(`preflight: ok=${pre.ok} bin=${pre.claudeBin} cli=${pre.cliVersion}`)
  if (!pre.ok || !pre.claudeBin) {
    console.log(`  problems: ${pre.problems.join('; ')}`)
    process.exitCode = 1
    return
  }

  const plan = sdkManagerLaunchPlan({
    projectPath,
    agentSessionId: randomUUID(),
    claudeBin: pre.claudeBin,
  })
  for (const w of plan.warnings) console.log(`warning: ${w}`)
  const sp = plan.options.systemPrompt as { append?: string }
  console.log(`app-context card: ${sp?.append ? `${sp.append.length} chars` : 'MISSING (bug)'}`)
  console.log(`first message   : ${JSON.stringify(plan.initialPrompt)}`)

  // The SDK is ESM-only; `spawnSdkSession` reads it SYNCHRONOUSLY and therefore
  // requires it to be imported first, exactly as the two production spawn sites
  // do. Without this the probe reports `status:'failed'` with "is not loaded",
  // i.e. the verifier would break at the moment production started working.
  const pre2 = await preloadSdk()
  if (!pre2.loaded) console.log(`warning: SDK module did not load — ${pre2.error ?? 'unknown'}`)

  const s = spawnSdkSession({
    cwd: projectPath,
    role: 'manager',
    agentSessionId: String(plan.options.sessionId ?? ''),
    // Bound the run: boot, take one turn, stop.
    options: { ...plan.options, maxTurns: 1 },
    initialPrompt: plan.initialPrompt,
    sdk: pre2,
  })
  console.log(`\nspawned sdk session ${s.id} (status ${s.status})\n── events ──`)

  const sub = attachSdkListener(s.id, 0, (f) => {
    const ev = f.ev
    if (ev.kind === 'text') console.log(`  text     ${ev.text.slice(0, 200).replace(/\n/g, ' ')}`)
    else if (ev.kind === 'tool_use') console.log(`  tool     ${ev.name} ${ev.detail.slice(0, 120)}`)
    else if (ev.kind === 'tool_result') console.log(`  result   ${ev.ok ? 'ok' : 'ERR'} ${ev.head.slice(0, 120)}`)
    else if (ev.kind === 'turn_end') console.log(`  turn_end reason=${ev.reason} error=${ev.isError}`)
    else if (ev.kind === 'api_error') console.log(`  API ERR  ${ev.status} ${ev.head.slice(0, 160)}`)
    else if (ev.kind === 'quota_refusal') console.log(`  QUOTA    ${ev.raw.slice(0, 160)}`)
    else if (ev.kind === 'status') console.log(`  status   ${ev.status}${ev.detail ? ` (${ev.detail})` : ''}`)
  })

  const deadline = Date.now() + 180_000
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    const cur = getSdkSession(s.id)
    if (!cur || cur.status === 'exited' || cur.status === 'failed') {
      console.log(`\nfinished: status=${cur?.status} reason=${cur?.exitReason ?? '-'} events=${cur?.seq}`)
      break
    }
    if (Date.now() > deadline) {
      console.log('\ntimed out — terminating')
      terminateSdkSession(s.id)
      break
    }
  }
  sub?.detach()
  process.exit(0)
}

void main()
