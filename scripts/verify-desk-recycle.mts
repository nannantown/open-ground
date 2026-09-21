#!/usr/bin/env tsx
// verify-desk-recycle — real-machine check of the commander half of the desk
// context cap (deskContextCap.ts, 2026-09-18), against an ISOLATED OpenGround
// home so no live desk of the owner's app is touched or twinned.
//
//   1) seed:   OPENGROUND_HOME=<tmp> npx tsx scripts/verify-desk-recycle.mts seed <scratchProject> <srcCwd> <overCapSessionId>
//   2) start the server of THIS checkout on that home:
//              OPENGROUND_HOME=<tmp> PORT=47777 npx tsx server/index.ts
//   3) run:    OPENGROUND_HOME=<tmp> OG_API=http://127.0.0.1:47777 npx tsx scripts/verify-desk-recycle.mts run <scratchProject>
//   4) clean:  OPENGROUND_HOME=<tmp> npx tsx scripts/verify-desk-recycle.mts clean <scratchProject> <copySid>
//
// seed registers ONLY the scratch project, copies a REAL over-cap conversation
// (read-only source, e.g. a commander transcript) under a new id into the scratch
// project's claude dir, and records it as that project's commander session — so
// the spawn sees a resumable conversation whose measured fill is over the cap.
// run then spawns the commander through the real route and reports:
//   ① the spawn opened a NEW session id (not the recorded one) and recorded it
//   ② the new session's fill (sessionContextTokens) once it has spoken
//   ③ the desk's own first report (its 「状況」), to be read against the scratch
//      project's real state — the copied memory is about ANOTHER project, so a
//      report that echoes it is a failure of "memory loss is harmless".

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const ISO = process.env.OPENGROUND_HOME
if (!ISO || !ISO.startsWith(tmpdir())) {
  console.error('OPENGROUND_HOME must point at an ISOLATED home under the tmp dir (never the real one)')
  process.exit(2)
}
const API = process.env.OG_API ?? 'http://127.0.0.1:47777'
// seed takes the SOURCE conversation's cwd too: transcripts are filed by cwd.
const [mode, project, srcCwd, srcSid] = process.argv.slice(2)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settingsFile = join(ISO, 'settings.json')
const projectId = (): string => {
  const s = JSON.parse(readFileSync(settingsFile, 'utf8'))
  return s.projects.find((p: { path: string }) => p.path === project).id
}

const { sessionJsonlPath } = await import('../src/lib/server/transcript')
const { sessionContextTokens, resetJsonlWalkMemo } = await import('../src/lib/server/claudeUsage')

const findJsonl = (cwd: string, sid: string): string | null => {
  const f = sessionJsonlPath(cwd, sid)
  return existsSync(f) ? f : null
}

if (mode === 'seed') {
  const src = findJsonl(srcCwd, srcSid)
  if (!src) throw new Error(`no transcript for ${srcSid}`)
  mkdirSync(ISO, { recursive: true })
  const id = randomUUID()
  writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        projects: [{ id, path: project, addedAt: new Date().toISOString() }],
        projectsMigratedAt: new Date().toISOString(),
        swarmOptIn: true,
        executionMode: 'economy',
        language: 'ja',
      },
      null,
      2,
    ),
  )
  const copy = randomUUID()
  const dst = sessionJsonlPath(project, copy)
  mkdirSync(join(dst, '..'), { recursive: true })
  copyFileSync(src, dst)
  const dataDir = join(ISO, 'projects', id)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'swarm-sessions.json'),
    JSON.stringify({ manager: { sessionId: copy, cwd: project, updatedAt: new Date().toISOString() } }, null, 2),
  )
  const now = new Date().toISOString()
  writeFileSync(
    join(dataDir, 'tasks.json'),
    JSON.stringify({
      tasks: [
        { id: randomUUID(), title: '検証用カードA(保留)', boardColumn: 'blocked', done: false, createdAt: now, priority: 1, notes: '' },
        { id: randomUUID(), title: '検証用カードB(完了済み)', boardColumn: 'done', done: true, createdAt: now, priority: 2, notes: '' },
      ],
    }),
  )
  resetJsonlWalkMemo()
  console.log(`seeded project ${id}; recorded commander session ${copy} (fill ${await sessionContextTokens(copy)})`)
  console.log(`COPY_SID=${copy}`)
} else if (mode === 'run') {
  const id = projectId()
  const sessFile = join(ISO, 'projects', id, 'swarm-sessions.json')
  const before = JSON.parse(readFileSync(sessFile, 'utf8')).manager.sessionId
  const board = await (await fetch(`${API}/api/project?path=${encodeURIComponent(project)}`)).json()
  console.log(`board (read back): ${JSON.stringify((board.tasks ?? []).map((t: { title: string; boardColumn: string }) => `${t.boardColumn}:${t.title}`))}`)
  const res = await fetch(`${API}/api/swarm/manager`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: API },
    body: JSON.stringify({ path: project }),
  })
  const body = (await res.json()) as Record<string, unknown>
  console.log(`spawn ${res.status} ${JSON.stringify(body)}`)
  const after = JSON.parse(readFileSync(sessFile, 'utf8')).manager.sessionId
  const newSid = String(body.agentSessionId ?? '')
  console.log(`① recorded before=${before} after=${after} response=${newSid} newId=${newSid !== before && after === newSid}`)
  // Wait for the desk to finish its first report: the transcript stops growing.
  let last = -1
  let stableFor = 0
  for (let i = 0; i < 180 && stableFor < 45; i++) {
    await sleep(2000)
    const f = findJsonl(project, newSid)
    const size = f ? readFileSync(f).length : 0
    stableFor = size > 0 && size === last ? stableFor + 2 : 0
    last = size
  }
  resetJsonlWalkMemo()
  console.log(`② fill old=${await sessionContextTokens(before)} new=${await sessionContextTokens(newSid)}`)
  const f = findJsonl(project, newSid)
  const texts = f
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"type":"assistant"'))
        .flatMap((l) => {
          try {
            const c = JSON.parse(l).message?.content
            return Array.isArray(c) ? c.filter((x: { type: string }) => x.type === 'text').map((x: { text: string }) => x.text) : []
          } catch {
            return []
          }
        })
    : []
  console.log(`③ desk report (last text):\n${texts.at(-1) ?? '(none)'}`)
  const journal = join(ISO, 'projects', id, 'engine-journal.jsonl')
  const lines = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter((l) => l.includes('卓を作り直した')) : []
  console.log(`engine log: ${lines.map((l) => JSON.parse(l).message).join(' | ') || '(no line)'}`)
  const stop = await fetch(`${API}/api/swarm/manager/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: API },
    body: JSON.stringify({ path: project }),
  })
  console.log(`stopped desk: ${stop.status}`)
  console.log(`NEW_SID=${newSid}`)
} else if (mode === 'clean') {
  const id = projectId()
  const rec = JSON.parse(readFileSync(join(ISO, 'projects', id, 'swarm-sessions.json'), 'utf8'))
  // argv: clean <project> <copySid> — the copied conversation, plus the recorded (new) one.
  for (const sid of [srcCwd, rec.manager?.sessionId].filter(Boolean)) {
    const f = sessionJsonlPath(project, sid)
    if (existsSync(f)) {
      rmSync(f)
      console.log(`removed ${f}`)
    }
  }
  rmSync(ISO, { recursive: true, force: true })
  console.log(`removed ${ISO}`)
}
process.exit(0)
