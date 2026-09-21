#!/usr/bin/env tsx
// probe-desk-compact — does a live desk ACCEPT a `/compact` line, on BOTH runtimes?
//
// The desk context cap (deskContextCap.ts, 2026-09-18) compacts the supply desk
// early by typing `/compact` into it. Before building on that, this measures it
// on a THROWAWAY desk per runtime, in the arrangement production uses:
//
//   PTY — the RUNNING app's own launch route (POST /api/terminal/claude, i.e.
//         zsh -l → claude, a real TUI), one turn, then `/compact\r` through
//         POST /api/terminal/:id/input. Evidence = a `compact_boundary` line in
//         the session's JSONL with trigger 'manual'.
//   SDK — spawnSdkSession + pushSdkInput (the seam an SDK desk is spoken to by),
//         one turn, then push `/compact`. Evidence = a `compact` event on the
//         session's own stream (sdkEvents distils system/compact_boundary).
//
//   npx tsx scripts/probe-desk-compact.mts [ptyProjectPath]
//
// ptyProjectPath must be a REGISTERED project (the route validates it) — use a
// scratch one. The SDK arm runs in a fresh tmp dir. Both desks are torn down.
// Model: haiku, two tiny turns each — the cheapest thing that can answer.

// A claude launched from INSIDE a claude session inherits child-session markers
// (transcript off / manual mode). Strip them before anything spawns, so the SDK
// arm measures what the server — not a claude child — would get.
// (Listed literally — the names seen in a claude session on 2026-09-18.)
delete process.env.CLAUDECODE
delete process.env.CLAUDE_CODE_ENTRYPOINT
delete process.env.CLAUDE_CODE_SESSION_ID
delete process.env.CLAUDE_CODE_CHILD_SESSION
delete process.env.CLAUDE_CODE_SESSION_ATTENDED
delete process.env.CLAUDE_CODE_EXECPATH
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
delete process.env.CLAUDE_CODE_MESSAGING_TOKEN
delete process.env.CLAUDE_PID
delete process.env.CLAUDE_EFFORT

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const API = process.env.OG_API ?? 'http://127.0.0.1:47776'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const { sessionJsonlPath } = await import('../src/lib/server/transcript')
const findJsonl = (cwd: string, sid: string): string | null => {
  const f = sessionJsonlPath(cwd, sid)
  return existsSync(f) ? f : null
}
const boundaries = (file: string | null) =>
  file
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"compact_boundary"'))
        .map((l) => JSON.parse(l).compactMetadata as Record<string, unknown>)
    : []
const assistantTurns = (file: string | null) =>
  file ? readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"assistant"')).length : 0

const ptyArm = async (projectPath: string) => {
  console.log(`\n=== PTY arm (${projectPath}) ===`)
  const res = await fetch(`${API}/api/terminal/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: API },
    body: JSON.stringify({ cwd: projectPath, model: 'haiku', initialPrompt: 'Reply with exactly: OK' }),
  })
  const body = (await res.json()) as Record<string, unknown>
  console.log(`launch ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  const id = String(body.id ?? body.terminalId ?? '')
  const sid = String(body.agentSessionId ?? '')
  if (!id || !sid) return
  try {
    let file: string | null = null
    for (let i = 0; i < 60 && assistantTurns(file) === 0; i++) {
      await sleep(2000)
      file = findJsonl(projectPath, sid)
    }
    console.log(`first turn landed: ${assistantTurns(file) > 0} (${file})`)
    await sleep(3000) // let the TUI settle back to an empty input box
    const w = await fetch(`${API}/api/terminal/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: API },
      body: JSON.stringify({ data: '/compact\r' }),
    })
    console.log(`typed /compact: ${w.status}`)
    for (let i = 0; i < 90 && boundaries(file).length === 0; i++) await sleep(2000)
    const b = boundaries(file)
    console.log(`PTY RESULT: compact_boundary=${b.length} ${JSON.stringify(b.map((m) => ({ trigger: m.trigger, pre: m.preTokens, post: m.postTokens })))}`)
  } finally {
    await fetch(`${API}/api/terminal/${id}`, { method: 'DELETE', headers: { origin: API } }).catch(() => {})
  }
}

const sdkArm = async () => {
  console.log('\n=== SDK arm ===')
  const { sdkManagerLaunchPlan, sdkManagerPreflight } = await import('../src/lib/server/swarmManagerSdk')
  const { spawnSdkSession, preloadSdk, attachSdkListener, pushSdkInput, terminateSdkSession } = await import(
    '../src/lib/server/sdkSession'
  )
  const { ensureClaudeFolderTrusted } = await import('../src/lib/server/claudeTrust')
  const pre = sdkManagerPreflight()
  if (!pre.ok || !pre.claudeBin) return console.log(`preflight failed: ${pre.problems.join('; ')}`)
  const cwd = mkdtempSync(join(tmpdir(), 'og-desk-compact-'))
  ensureClaudeFolderTrusted(cwd)
  const sid = randomUUID()
  const plan = sdkManagerLaunchPlan({
    projectPath: cwd,
    agentSessionId: sid,
    resume: false,
    me: { model: 'haiku' },
    claudeBin: pre.claudeBin,
    lang: 'en',
  })
  const s = spawnSdkSession({
    cwd,
    role: 'manager',
    agentSessionId: sid,
    options: plan.options,
    initialPrompt: 'Reply with exactly: OK',
    sdk: await preloadSdk(),
  })
  let turns = 0
  const compacts: unknown[] = []
  const texts: string[] = []
  const onFrame = (f: { ev: unknown }) => {
    const ev = f.ev as { kind: string } & Record<string, unknown>
    if (ev.kind === 'turn_end') turns++
    if (ev.kind === 'compact') compacts.push(ev)
    if (ev.kind === 'text') texts.push(String(ev.text).slice(0, 120))
  }
  const sub = attachSdkListener(s.id, 0, onFrame)
  for (const f of sub?.replay ?? []) onFrame(f)
  try {
    for (let i = 0; i < 60 && turns === 0; i++) await sleep(2000)
    console.log(`first turn ended: ${turns > 0}`)
    console.log(`pushed /compact: ${pushSdkInput(s.id, '/compact')}`)
    for (let i = 0; i < 90 && compacts.length === 0; i++) await sleep(2000)
    await sleep(2000)
    const file = sessionJsonlPath(cwd, sid)
    const b = boundaries(existsSync(file) ? file : null)
    console.log(`SDK RESULT: compact events=${JSON.stringify(compacts)} jsonl boundaries=${b.length} turns=${turns}`)
    console.log(`texts: ${JSON.stringify(texts)}`)
  } finally {
    sub?.detach()
    terminateSdkSession(s.id)
    await sleep(1500)
    rmSync(cwd, { recursive: true, force: true })
  }
}

const main = async () => {
  const ptyProject = process.argv[2]
  if (ptyProject) await ptyArm(ptyProject)
  await sdkArm()
  process.exit(0)
}
void main()
