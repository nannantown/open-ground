#!/usr/bin/env tsx
// Real-claude measurement for the 2026-11-17 tool-boundary update wait.
//
// A real SDK session runs a Bash (`sleep 12`) inside this process, which plays
// the server. The process then SIGTERMs ITSELF — the signal Electron's teardown
// (terminateChild: SIGTERM, 5 s, SIGKILL) sends the forked server — and a fresh
// process ("the next boot") inspects the real transcript exactly as the boot
// resume does (savedSwarmRuntimeHold → assertSwarmNativeConversationSettled):
//   A. cut while the Bash is running        — the old hands-free timing
//   B. cut at the first moment the probe the Electron shell reads
//      (GET /api/update/restart-safety → toolCallsInFlight) says 0 after the call
// Expected: A leaves an unfinished tool call (the commander / engine would be
// held for the owner's review); B leaves a settled conversation (they resume).
//
// Spends a few haiku turns of the user's subscription. Run with an isolated
// OPEN GROUND home and a throwaway cwd, one case per process:
//   OPENGROUND_HOME=<tmp> npx tsx scripts/probe-update-tool-boundary.mts run mid|boundary <tmp cwd>
//   OPENGROUND_HOME=<tmp> npx tsx scripts/probe-update-tool-boundary.mts inspect <tmp cwd> <session id>
import { randomUUID } from 'crypto'
import { spawnSdkSession, preloadSdk, getSdkSession } from '../src/lib/server/sdkSession'
import { sdkManagerPreflight } from '../src/lib/server/swarmManagerSdk'
import { sdkSessionEnv } from '../src/lib/server/swarmWorkerSdk'
import { updateRestartSafety } from '../src/lib/server/liveDesks'
import { inspectSwarmNativeConversation } from '../src/lib/server/swarmNativeTranscript'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PROMPT = 'Run exactly this one Bash command and nothing else: sleep 12 && echo done. Then reply with the single word OK.'

const run = async (label: string, cutAtBoundary: boolean, claudeBin: string, cwd: string, sdk: Awaited<ReturnType<typeof preloadSdk>>) => {
  const sessionId = randomUUID()
  const s = spawnSdkSession({
    cwd,
    role: 'worker',
    agentSessionId: sessionId,
    initialPrompt: PROMPT,
    sdk,
    options: {
      cwd, pathToClaudeCodeExecutable: claudeBin, env: sdkSessionEnv(), permissionMode: 'bypassPermissions',
      strictMcpConfig: true, mcpServers: {}, model: 'haiku', sessionId,
    },
  })
  let sawCall = false
  const started = Date.now()
  for (;;) {
    await sleep(cutAtBoundary ? 2000 : 250) // the policy re-asks every 2 s while it waits
    const probe = await updateRestartSafety()
    if (probe.toolCallsInFlight > 0) sawCall = true
    const cur = getSdkSession(s.id)
    console.log(`  ${label} t=${Math.round((Date.now() - started) / 1000)}s status=${cur?.status} toolCallsInFlight=${probe.toolCallsInFlight}`)
    if (!cutAtBoundary && sawCall) break
    if (cutAtBoundary && sawCall && probe.toolCallsInFlight === 0) break
    if (Date.now() - started > 120_000) { console.log(`  ${label} timed out`); break }
  }
  console.log(`${label}: SESSION ${sessionId} — server SIGTERM now`)
  process.kill(process.pid, 'SIGTERM')
  await sleep(60_000)
}

const inspect = async (cwd: string, sessionId: string) => {
  const inspected = await inspectSwarmNativeConversation(cwd, sessionId).catch((e: Error) => ({ error: e.message }))
  const unfinished = 'unfinishedTools' in inspected ? inspected.unfinishedTools.length : -1
  console.log(`next boot: unfinishedTools=${unfinished} ⇒ boot resume would ${unfinished === 0 ? 'RESUME' : 'HOLD for review'}`)
  if ('error' in inspected) console.log(`  inspect error: ${inspected.error}`)
}

const main = async () => {
  const [mode, arg, cwd, id] = process.argv[2] === 'inspect' ? ['inspect', '', process.argv[3], process.argv[4]] : process.argv.slice(2)
  if (!cwd || !process.env.OPENGROUND_HOME) throw new Error('see usage at the top of this file')
  if (mode === 'inspect') { await inspect(cwd, id); process.exit(0) }
  const pre = sdkManagerPreflight()
  if (!pre.ok || !pre.claudeBin) throw new Error(`claude not ready: ${pre.problems.join('; ')}`)
  const sdk = await preloadSdk()
  await run(arg === 'boundary' ? 'B (cut at tool boundary)' : 'A (cut mid-call)', arg === 'boundary', pre.claudeBin, cwd, sdk)
}
void main()
