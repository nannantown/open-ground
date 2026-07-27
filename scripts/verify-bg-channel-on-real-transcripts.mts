// Forensic replay + survey for the FOURTH liveness channel (02-worker-lifecycle §5.4b).
//
// Why this exists: the 2026-07-27 false-kill was invisible in tests until the real bytes
// were replayed — the engine reclaimed healthy workers that were waiting on a background
// `npm test`, and the proof sat in their transcripts the whole time. It earned its keep
// twice: the FIRST version of this script looked only at each file's LAST
// queue-operation, and that blind spot hid a whole second way background tasks are born
// (a foreground Bash the harness moves to the background on timeout). It now walks EVERY
// task in every file.
//
// Two modes:
//   replay  (default) — for each background task, reconstruct what the engine saw at the
//                       moment that task ended and print BEFORE (3 channels) vs AFTER
//                       (4 channels). Tasks whose worker was NOT silent are reported as
//                       not-at-risk rather than silently skipped.
//   --survey          — for each background task, the longest contiguous transcript
//                       silence while it was in flight. This is the number
//                       BG_TASK_GRACE_MS has to cover, so the grace is derived from
//                       measurement rather than from a three-sample window.
//
// Reads the given transcripts READ-ONLY and replays them under a THROWAWAY $HOME, so the
// PRODUCTION path — sessionBackgroundTaskAt → sessionJsonlPath → claudeDirName → the real
// parser — runs exactly as it does inside the engine. Nothing here re-implements the
// production parser: a bug in production is a failure here. The real ~/.claude is only
// ever read; every write is asserted to land under the throwaway home.
//
// Usage:
//   npx tsx scripts/verify-bg-channel-on-real-transcripts.mts <session.jsonl> [...]
//   npx tsx scripts/verify-bg-channel-on-real-transcripts.mts --survey <session.jsonl> [...]
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'

const argv = process.argv.slice(2)
const surveyMode = argv.includes('--survey')
const inputs = argv.filter((a) => !a.startsWith('--'))
if (inputs.length === 0) {
  console.error('usage: npx tsx scripts/verify-bg-channel-on-real-transcripts.mts [--survey] <session.jsonl> [...]')
  process.exit(2)
}

const fakeHome = await mkdtemp(join(tmpdir(), 'og-bg-replay-home-'))
process.env.HOME = fakeHome

const {
  sessionBackgroundTaskAt,
  classifyStall,
  backgroundTaskAliveAt,
  BG_TASK_GRACE_MS,
  MAX_EXEC_MS,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  STALL_ECHO_GUARD_MS,
  STALL_MAX_NUDGES,
} = await import('../src/lib/server/swarmOrchestrator.ts')
const { sessionJsonlPath } = await import('../src/lib/server/transcript.ts')

const P = {
  stallMs: STALL_SILENCE_MS,
  cooldownMs: STALL_NUDGE_COOLDOWN_MS,
  echoGuardMs: STALL_ECHO_GUARD_MS,
  maxNudges: STALL_MAX_NUDGES,
}
const min = (ms: number) => (ms / 60_000).toFixed(1)

let failures = 0
const check = (ok: boolean, msg: string) => {
  console.log(`    ${ok ? '✓' : '✗ FAIL'} ${msg}`)
  if (!ok) failures++
}

type Task = { id: string; startAt: number; startForm: 'explicit' | 'auto'; endAt: number | null; endIdx: number | null }
type Parsed = { lines: string[]; stamps: number[]; tasks: Task[] }

/** Mirror of what the production resolver keys on — used ONLY to enumerate tasks and
 *  locate their records for truncation. The verdicts below always come from the real
 *  `sessionBackgroundTaskAt`, never from this. */
const parse = (text: string): Parsed => {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const stamps: number[] = []
  const byId = new Map<string, Task>()
  lines.forEach((line, idx) => {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      return
    }
    const at = typeof rec?.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
    if (Number.isFinite(at)) stamps.push(at)
    if (rec?.type === 'queue-operation') {
      const content = typeof rec.content === 'string' ? rec.content : ''
      for (const m of content.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) {
        const t = byId.get(m[1])
        if (t && t.endAt === null && Number.isFinite(at)) {
          t.endAt = at
          t.endIdx = idx
        }
      }
      return
    }
    if (!Number.isFinite(at)) return
    for (const part of Array.isArray(rec?.message?.content) ? rec.message.content : []) {
      if (part?.type === 'tool_use' && part?.input?.run_in_background === true && typeof part.id === 'string') {
        if (!byId.has(part.id)) byId.set(part.id, { id: part.id, startAt: at, startForm: 'explicit', endAt: null, endIdx: null })
      } else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const txt = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '')
        // Same ANCHORED sentence production requires — a loose substring would enumerate
        // phantom tasks (any tool_result quoting the phrase) and quietly inflate the
        // survey the grace is derived from.
        if (/^Command did not complete within its \S+ timeout and was moved to the background \(ID: /.test(txt) && !byId.has(part.tool_use_id)) {
          byId.set(part.tool_use_id, { id: part.tool_use_id, startAt: at, startForm: 'auto', endAt: null, endIdx: null })
        }
      }
    }
  })
  stamps.sort((a, b) => a - b)
  return { lines, stamps, tasks: [...byId.values()].sort((a, b) => a.startAt - b.startAt) }
}

/** The longest stretch with NO transcript record while the task was in flight — i.e. the
 *  silence the fourth channel has to cover for this task. */
const maxSilence = (p: Parsed, t: Task): number => {
  const end = t.endAt ?? t.startAt
  let worst = 0
  let prev = t.startAt
  for (const s of p.stamps) {
    if (s <= t.startAt) continue
    if (s > end) break
    worst = Math.max(worst, s - prev)
    prev = s
  }
  return Math.max(worst, end - prev)
}

const surveyRows: { file: string; id: string; form: string; silence: number; dur: number; workerAgeAtEnd: number }[] = []

for (const input of inputs) {
  let text: string
  try {
    text = await readFile(input, 'utf8')
  } catch {
    console.log(`(unreadable: ${input}) — skipped`)
    failures++
    continue
  }
  const p = parse(text)
  const label = basename(input).slice(0, 8)

  if (surveyMode) {
    for (const t of p.tasks) {
      surveyRows.push({
        file: basename(dirname(input)),
        id: t.id,
        form: t.startForm,
        silence: maxSilence(p, t),
        dur: (t.endAt ?? t.startAt) - t.startAt,
        // How old the WORKER was when the task ended. The first record in the session is
        // its spawn, so this is a floor on the execution-time clock — if it already
        // exceeds MAX_EXEC_MS, the runaway path owns this worker and the stall grace
        // could not have changed its fate whatever value it were given.
        workerAgeAtEnd: (t.endAt ?? t.startAt) - (p.stamps[0] ?? t.startAt),
      })
    }
    continue
  }

  console.log(`\n── ${label} ${'─'.repeat(56)}  ${p.lines.length} lines, ${(text.length / 1024 / 1024).toFixed(2)} MB`)
  if (p.tasks.length === 0) {
    console.log('  (no background task in this session)')
    continue
  }

  const baseSid = basename(input).replace(/\.jsonl$/, '')
  const cwd = dirname(input) // hyphenating an already-hyphenated dir name is idempotent
  await mkdir(dirname(sessionJsonlPath(cwd, baseSid)), { recursive: true })

  // EVERY variant gets its OWN session id, so each lands on a fresh path. Rewriting one
  // path would race the production memo, which keys on (size, mtime): two truncations of
  // the same transcript can easily share a byte count, and writes inside one millisecond
  // share an mtime — a stale memo hit would make this script report a verdict the engine
  // never produced. Unique paths remove the hazard instead of hoping to dodge it.
  let variant = 0
  const layDown = async (view: string[]): Promise<string> => {
    const sid = `${baseSid}-v${variant++}`
    const dest = sessionJsonlPath(cwd, sid)
    if (!dest.startsWith(fakeHome)) throw new Error(`refusing to write outside the throwaway home: ${dest}`)
    await writeFile(dest, view.join('\n') + '\n')
    return sid
  }

  for (const t of p.tasks) {
    const form = t.startForm === 'auto' ? 'AUTO-BACKGROUNDED' : 'explicit'
    if (t.endAt === null || t.endIdx === null) {
      console.log(`  • ${t.id.slice(0, 20)}… [${form}] — never reported back; skipped (no decision moment on record)`)
      continue
    }
    // Everything before the END notification = what the engine saw at the last instant
    // of this task. Its own timestamp is that instant.
    const view = p.lines.filter((_, i) => i < t.endIdx!)
    const now = t.endAt
    const lastRecord = p.stamps.filter((s) => s < now).pop() ?? t.startAt
    const cheapSilent = now - lastRecord
    if (cheapSilent < STALL_SILENCE_MS) {
      console.log(
        `  • ${t.id.slice(0, 20)}… [${form}] ran ${min(now - t.startAt)}m — NOT at risk (worker only ${min(cheapSilent)}m silent)`,
      )
      continue
    }

    console.log(`  • ${t.id.slice(0, 20)}… [${form}] ran ${min(now - t.startAt)}m, worker silent ${min(cheapSilent)}m — AT RISK`)
    const bg = await sessionBackgroundTaskAt(cwd, await layDown(view)) // PRODUCTION resolver
    check(bg !== null, `resolver sees an in-flight task (${bg ? new Date(bg).toISOString() : 'NULL'})`)
    if (bg === null) continue

    const spent = { count: P.maxNudges, lastNudgeAt: now - P.cooldownMs - 1, escalated: true }
    const cheap = { heartbeatAtMs: lastRecord, lastOutputAtMs: lastRecord, startedAtMs: t.startAt - 3_600_000, nudge: spent }
    const before = classifyStall(cheap, now, P)
    const after = classifyStall({ ...cheap, bgTaskAliveAtMs: backgroundTaskAliveAt(bg, now, BG_TASK_GRACE_MS) }, now, P)
    check(before.action === 'reclaim', `BEFORE (3 channels): '${before.action}' — the bug`)

    // A worker already past MAX_EXEC_MS belongs to the RUNAWAY path, not this one: the
    // execution-time limit reclaimed it before the grace could matter, and no grace value
    // would change that. Reporting such a case as a failure of this channel would be
    // blaming the wrong clock — but it must still be SHOWN, not quietly dropped.
    const workerAge = now - (p.stamps[0] ?? t.startAt)
    if (workerAge > MAX_EXEC_MS) {
      check(
        true,
        `AFTER  (4 channels): '${after.action}' — worker was ${min(workerAge)}m old, past MAX_EXEC_MS (${min(MAX_EXEC_MS)}m):` +
          ` the execution-time limit owns this one, not the stall path`,
      )
    } else {
      check(after.action === 'none', `AFTER  (4 channels): '${after.action}' — spared (waited ${min(now - bg)}m, grace ${min(BG_TASK_GRACE_MS)}m)`)
    }
  }

  // Guards, once per file, on the FULL transcript: a resolved task stops counting, and a
  // task stuck in flight loses the channel at the cap.
  const fullSid = await layDown(p.lines)
  if (p.tasks.length > 0 && p.tasks.every((t) => t.endAt !== null)) {
    check((await sessionBackgroundTaskAt(cwd, fullSid)) === null, 'every task RESOLVED ⇒ no in-flight signal (nobody is kept alive forever)')
  }
  // The cap must be measured from the NEWEST unresolved task — that is what the resolver
  // answers with. Using the first unresolved one (an earlier version of this script did)
  // asks "is a task that started at time X expired?" of an answer about a LATER task, and
  // reports a false failure whenever a session left more than one task unreported.
  const stuck = [...p.tasks].reverse().find((t) => t.endAt === null)
  if (stuck) {
    const wayLater = stuck.startAt + BG_TASK_GRACE_MS + 60_000
    check(backgroundTaskAliveAt(await sessionBackgroundTaskAt(cwd, fullSid), wayLater, BG_TASK_GRACE_MS) === null, 'past the cap the reprieve expires')
  }
}

if (surveyMode) {
  // RANKED BY DURATION, not by silence. The grace is compared against `now - taskStart`
  // (backgroundTaskAliveAt), so the quantity it has to cover is how long the task RAN —
  // not the longest quiet stretch inside it. Deriving the threshold from the silence
  // column instead is an off-by-one-metric that picked a grace 4 minutes too small and
  // let the worst victim on this disk (90.1m task / 86.1m silence) die anyway.
  surveyRows.sort((a, b) => b.dur - a.dur)
  const explicit = surveyRows.filter((r) => r.form === 'explicit')
  const auto = surveyRows.filter((r) => r.form === 'auto')
  // Only tasks whose worker actually went quiet past the stall gate can ever consult the
  // channel — but the threshold is set over ALL of them, since a task's silence is a
  // property of the load on the day, not of the task.
  const atRisk = surveyRows.filter((r) => r.silence >= STALL_SILENCE_MS)
  console.log(`\ntasks: ${surveyRows.length}  (explicit ${explicit.length} / auto-backgrounded ${auto.length})`)
  console.log(`of those, ${atRisk.length} went silent past STALL_SILENCE_MS (${min(STALL_SILENCE_MS)}m) while in flight — the ones the channel exists for`)
  const pct = (q: number) => (surveyRows.length ? surveyRows.map((r) => r.dur).sort((a, b) => a - b)[Math.floor((surveyRows.length - 1) * q)] : 0)
  console.log(`task DURATION (start → notification) — p50 ${min(pct(0.5))}m  p90 ${min(pct(0.9))}m  p99 ${min(pct(0.99))}m  max ${min(surveyRows[0]?.dur ?? 0)}m`)
  for (const g of [30, 45, 60, 90, 120, 150]) {
    const lost = surveyRows.filter((r) => r.dur > g * 60_000)
    const lostAtRisk = lost.filter((r) => r.silence >= STALL_SILENCE_MS)
    // A worker already past MAX_EXEC_MS is the runaway path's, not the stall path's —
    // raising the grace could not have saved it, so it is not evidence for a bigger number.
    const stallWouldDecide = lostAtRisk.filter((r) => r.workerAgeAtEnd <= MAX_EXEC_MS)
    console.log(
      `  grace ${String(g).padStart(3)}m ⇒ ${String(lost.length).padStart(3)} task(s) outlive it,` +
        ` ${String(lostAtRisk.length).padStart(3)} of those silent —` +
        ` but only ${String(stallWouldDecide.length).padStart(2)} still inside MAX_EXEC_MS (${min(MAX_EXEC_MS)}m) ⇒ KILLED BY THIS CHANNEL'S CHOICE`,
    )
  }
  console.log('\ntop 12 by duration:')
  for (const r of surveyRows.slice(0, 12)) {
    const owner = r.workerAgeAtEnd > MAX_EXEC_MS ? 'exec-limit' : 'stall'
    console.log(
      `  ran ${min(r.dur).padStart(6)}m  silent ${min(r.silence).padStart(6)}m  worker age ${min(r.workerAgeAtEnd).padStart(6)}m [${owner.padEnd(10)}]  ${r.form.padEnd(8)}  ${r.file.slice(-40)}`,
    )
  }
}

await rm(fakeHome, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
