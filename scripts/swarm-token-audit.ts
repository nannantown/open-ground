/**
 * swarm-token-audit — the permanent consumption meter over swarm claude
 * sessions (card: swarm-token). READ-ONLY: reads session JSONLs under
 * ~/.claude/projects and (optionally) ~/.openground/settings.json; writes
 * NOTHING anywhere.
 *
 * Run via `npm run swarm:audit` (tsx). Works offline — no running server.
 *
 *   npm run swarm:audit                          # last 7d: every project's workers + the main repo's desks
 *   npm run swarm:audit -- --since 3d            # period: Nd / Nh / YYYY-MM-DD / ISO
 *   npm run swarm:audit -- --until 2026-07-18    # a bare date covers that whole LOCAL day
 *   npm run swarm:audit -- --project <path>      # one project: its workers + its main-repo desks
 *   npm run swarm:audit -- --json                # machine-readable output
 *
 * Scope, stated because it used to be implicit: the walk always covers worker
 * worktrees, and the DESK sessions (commander / supply, which run in the repo
 * itself and never in a worktree) come from --project when given, else from the
 * main repo — resolved through the registry when this is run from inside a
 * worktree, since a worktree's own dir is already in the worker walk and adding
 * it again covers nothing. Every run prints the scope, INCLUDING the number of
 * desk sessions actually found, so "empty" and "never looked" stay distinct.
 *
 * Per session it reports (the median row is over CARD sessions only — desk
 * sessions are interactive drivers, not card attempts): 手数 (unique main-loop usage
 * responses), ツール束ね率 (tool_use ÷ tool-carrying responses), 文脈max
 * (input+cache_creation+cache_read peak), 出力 tokens, sub出力(手数) — the
 * subagents the card spawned, read from <session-id>/subagents/agent-*.jsonl
 * and billed separately from the main loop — Read 再読, and bash 内訳
 * (tsc/test/lint/git/other). Definitions live in src/lib/server/swarmTokenAudit.ts.
 */
import { readFile, realpath } from 'fs/promises'
import { join, basename } from 'path'
import {
  auditSessionFile,
  collectSwarmSessionFiles,
  defaultClaudeProjectsRoot,
  describeAuditScope,
  localDayEdgeMs,
  mainRepoForWorktreeCwd,
  resolveAuditScope,
  type SessionTokenAudit,
} from '../src/lib/server/swarmTokenAudit'
import { openGroundHome } from '../src/lib/server/paths'

// `swarm:audit | head` must not crash on EPIPE — same idiom as you-corpus.ts.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

interface CliOpts {
  since?: string
  until?: string
  project?: string
  json: boolean
}

const parseArgs = (argv: string[]): CliOpts => {
  const opts: CliOpts = { json: false }
  // A value-taking flag must actually get a value: `--since` with nothing after
  // it used to fall through to the 7d default, silently reporting a different
  // period than the one asked for.
  const value = (i: number, flag: string): string => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) {
      console.error(`${flag} needs a value (try --help)`)
      process.exit(1)
    }
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') opts.since = value(++i, '--since')
    else if (a === '--until') opts.until = value(++i, '--until')
    else if (a === '--project') opts.project = value(++i, '--project')
    else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'usage: npm run swarm:audit -- [--since 7d|Nh|YYYY-MM-DD|ISO] [--until YYYY-MM-DD|ISO] [--project <path>] [--json]',
          '',
          "scope: every project's worker worktrees, PLUS the desk sessions (commander / supply)",
          '       of the main repo — those run in the repo itself, never in a worktree. Run from',
          "       inside a worktree, the desks read come from that worktree's REGISTERED main repo",
          '       (reading the worktree itself would add nothing: the worker walk already has it).',
          '       --project <path> narrows the workers to that project and reads its desks instead.',
          '       The header states the desk count actually found, so an empty scan and an unscanned',
          '       one never look alike.',
          'dates: a bare YYYY-MM-DD covers that whole LOCAL day, so --until 2026-07-18 includes',
          '       the 18th. Full ISO timestamps are used exactly as given.',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      console.error(`unknown flag: ${a} (try --help)`)
      process.exit(1)
    }
  }
  return opts
}

/** '7d' / '24h' / 'YYYY-MM-DD' / full ISO → epoch ms. Relative forms count back
 *  from now; a bare date covers the whole LOCAL day snapped to `edge` (see
 *  localDayEdgeMs — Date.parse would read it as UTC midnight, which cut every
 *  session of the --until day); a full ISO timestamp is used exactly as given. */
const parseWhen = (s: string, label: string, edge: 'start' | 'end'): number => {
  const rel = /^(\d+)([dh])$/.exec(s)
  if (rel) {
    const n = Number(rel[1])
    return Date.now() - n * (rel[2] === 'd' ? 86_400_000 : 3_600_000)
  }
  const day = localDayEdgeMs(s, edge)
  if (day !== null) return day
  const abs = Date.parse(s)
  if (Number.isFinite(abs)) return abs
  console.error(`--${label}: cannot parse "${s}" (use 7d, 24h, YYYY-MM-DD, or an ISO timestamp)`)
  process.exit(1)
}

/** Resolve a project path → its registry uuid by READING settings.json only —
 *  never through registry.ts/projectDataPath.ts, whose getters run one-shot
 *  migrations (this CLI must not write a byte under ~/.openground).
 *
 *  The home comes from openGroundHome(), NOT an inline homedir() join. That is a
 *  pure resolver — it runs no migration, so it does not weaken the guarantee
 *  above — and routing through it keeps the "there is exactly one home resolver"
 *  property that the production-home fence depends on. A second copy here was
 *  found by that property's repo sweep on its FIRST run (2026-07-19). */
const resolveProjectUuid = async (projectPath: string): Promise<string | null> => {
  let parsed: any
  try {
    parsed = JSON.parse(await readFile(join(openGroundHome(), 'settings.json'), 'utf8'))
  } catch {
    return null
  }
  const target = await realpath(projectPath).catch(() => projectPath)
  for (const e of parsed?.projects ?? []) {
    if (typeof e?.path !== 'string' || typeof e?.id !== 'string') continue
    const p = await realpath(e.path).catch(() => e.path)
    if (p === target) return e.id
  }
  return null
}

/** Row label: a worker worktree cwd shows its worktree name; anything else
 *  (the main-repo desk sessions) shows `(repo) <basename>`. */
const cardLabel = (audit: SessionTokenAudit, dir: string): string => {
  const cwd = audit.cwd
  if (cwd) {
    const i = cwd.indexOf('/worktrees/')
    if (i >= 0) return cwd.slice(i + '/worktrees/'.length)
    return `(repo) ${basename(cwd)}`
  }
  return dir // cwd-less file — fall back to the hyphenated dir name
}

const p2 = (n: number): string => String(n).padStart(2, '0')
const fmtLocalDay = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
/** A session's ISO stamp → 'YYYY-MM-DD HH:MM' in LOCAL time (the clock the
 *  period bounds use, and the one the reader actually lives in). */
const fmtLocalStamp = (iso: string): string => {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  return `${fmtLocalDay(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const padL = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s)
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2))
  const sinceMs = parseWhen(opts.since ?? '7d', 'since', 'start')
  const untilMs = opts.until ? parseWhen(opts.until, 'until', 'end') : Number.POSITIVE_INFINITY

  // Worker worktrees are always in scope; the DESK sessions come from --project
  // when given, else from the repo this was run in. When that repo IS a worker
  // worktree (the usual case — commanders, workers and reviewers all run from
  // one) its own dir is already in the worker walk, so aiming there would add
  // nothing; we resolve the worktree's registered MAIN repo instead.
  const scope = resolveAuditScope({
    project: opts.project,
    cwd: process.cwd(),
    worktreeMainRepo: opts.project ? null : await mainRepoForWorktreeCwd(process.cwd()),
  })
  let projectUuid: string | undefined
  let workerFilterNote = ''
  if (opts.project) {
    const uuid = await resolveProjectUuid(opts.project)
    if (uuid) projectUuid = uuid
    else {
      // The worker filter silently stays project-WIDE here, so the header must
      // admit it: stderr alone vanishes under `--json |` and down a pipe.
      workerFilterNote = ' · ⚠ not in the registry — worker rows are NOT narrowed to it'
      console.error(`note: ${opts.project} is not in the OPEN GROUND registry — listing its repo dir only if sessions exist; worker filter stays project-wide`)
    }
  }

  const refs = await collectSwarmSessionFiles({ projectUuid, extraDirs: scope.extraDirs, sinceMs })
  const rows: Array<{ audit: SessionTokenAudit; dir: string; file: string }> = []
  for (const ref of refs) {
    const audit = await auditSessionFile(ref.file)
    if (!audit) continue
    // Precise period check on the session's own stamps (mtime was the coarse cut).
    const last = Date.parse(audit.lastAt)
    const first = Date.parse(audit.firstAt)
    if (Number.isFinite(last) && last < sinceMs) continue
    if (Number.isFinite(first) && first > untilMs) continue
    rows.push({ audit, dir: ref.dir, file: ref.file })
  }
  rows.sort((a, b) => (a.audit.lastAt < b.audit.lastAt ? -1 : 1))

  // Counted, never assumed — see the scope line below.
  const deskRows = scope.deskDir ? rows.filter((r) => r.dir === scope.deskDir).length : 0

  if (opts.json) {
    // Shaped `{scope, sessions}` rather than a bare array so the machine-readable
    // path carries its own coverage statement. A downstream analysis that cannot
    // see WHICH dirs were walked — or that --project silently failed to narrow
    // anything — would draw fleet-wide conclusions from a partial scan, which is
    // the same failure this card exists to remove, just one consumer further on.
    // (stderr notes do not survive `--json | jq`.)
    console.log(
      JSON.stringify(
        {
          scope: {
            description: describeAuditScope(scope, deskRows),
            origin: scope.origin,
            deskRepo: scope.deskName,
            deskSessions: deskRows,
            workersNarrowedToUuid: projectUuid ?? null,
            ...(workerFilterNote
              ? { warning: 'project is not in the OPEN GROUND registry — worker rows are NOT narrowed to it' }
              : {}),
          },
          sessions: rows.map((r) => ({ card: cardLabel(r.audit, r.dir), file: r.file, ...r.audit })),
        },
        null,
        2,
      ),
    )
    return
  }

  // Everything on screen is LOCAL time, on one clock: the period bounds are local
  // day edges now, so rendering them (or the rows) in UTC would echo back a
  // different day than the one asked for — and could print a row stamp that
  // looks outside the stated range. --json keeps raw ISO for machines.
  const fmtRange = (ms: number) => (Number.isFinite(ms) ? fmtLocalDay(new Date(ms)) : '…')
  console.log(`swarm token audit — ${fmtRange(sinceMs)} → ${fmtRange(untilMs)} (local) · ${rows.length} session(s)`)
  // State the scope on every run: which dirs were walked is otherwise invisible,
  // and a reader cannot tell an empty column from an unscanned one. The desk
  // count is COUNTED, never assumed — the previous version asserted desks were
  // in scope while the walk had added none of them.
  console.log(`scope: ${describeAuditScope(scope, deskRows)}${workerFilterNote} · root ${defaultClaudeProjectsRoot()}`)
  if (rows.length === 0) {
    console.log('(no swarm sessions in this period — widen --since, or check --project)')
    return
  }

  const CARD_W = Math.min(56, Math.max(20, ...rows.map((r) => cardLabel(r.audit, r.dir).length)))
  const header = `${pad('card (session cwd)', CARD_W)}  ${padL('手数', 5)} ${padL('束ね', 5)} ${padL('文脈max', 8)} ${padL('出力', 7)} ${padL('sub出力(手数)', 13)} ${padL('Read(再)', 9)}  ${pad('bash tsc/test/lint/git/other', 28)}  last`
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const { audit, dir } of rows) {
    const label = cardLabel(audit, dir)
    const b = audit.bash
    console.log(
      `${pad(label.length > CARD_W ? label.slice(0, CARD_W - 1) + '…' : label, CARD_W)}  ` +
        `${padL(String(audit.turns), 5)} ` +
        `${padL(audit.bundleRate === null ? '-' : audit.bundleRate.toFixed(2), 5)} ` +
        `${padL(k(audit.maxContext), 8)} ` +
        `${padL(k(audit.outputTokens), 7)} ` +
        `${padL(audit.sidechainTurns ? `${k(audit.sidechainOutputTokens)}(${audit.sidechainTurns})` : '-', 13)} ` +
        `${padL(`${audit.readCount}(${audit.readRereads})`, 9)}  ` +
        `${pad(`${b.tsc}/${b.test}/${b.lint}/${b.git}/${b.other}`, 28)}  ` +
        `${audit.lastAt ? fmtLocalStamp(audit.lastAt) : '-'}`,
    )
  }
  console.log('-'.repeat(header.length))
  // The median answers "what does a card attempt cost", so it is taken over CARD
  // rows only. Desk sessions (commander / supply) are long interactive drivers,
  // not attempts — folding them in silently shifted the very number this table
  // exists to report. Same test as the row label: a card runs in a worktree.
  const cardRows = rows.filter((r) => r.audit.cwd?.includes('/worktrees/'))
  const med = (f: (a: SessionTokenAudit) => number) => median(cardRows.map((r) => f(r.audit)))
  console.log(
    `${pad(`median of ${cardRows.length} card(s)`, CARD_W)}  ` +
      `${padL(String(med((a) => a.turns) ?? '-'), 5)} ` +
      `${padL('', 5)} ` +
      `${padL(k(med((a) => a.maxContext) ?? 0), 8)} ` +
      `${padL(k(med((a) => a.outputTokens) ?? 0), 7)}`,
  )
  const deskShown = rows.length - cardRows.length
  if (deskShown > 0) {
    console.log(`(${deskShown} desk session(s) listed above are excluded from the median — interactive, not card attempts)`)
  }
}

void main()
