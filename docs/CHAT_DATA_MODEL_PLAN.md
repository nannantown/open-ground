# OPEN GROUND: conversation data-model migration plan

> Agreed direction (2026-05-29): **OPEN GROUND does not permanently store the
> full text of conversations.**
> ① latest summary = lightweight, strongly persisted / ② past full text =
> referenced from the claude JSONL only / ③ live log = in-memory + SSE, folded
> into ① once finished.
> Background and the incident (dismiss all wiped out all of runs/): see memory
> `project-chat-data-model` / `feedback-tests-isolate-home`.

## Current reality (confirmed by investigation)

- THREAD bodies and card heroes have `~/.openground/runs/*.json` as their **only
  disk source** (`listSessions()` runner.ts:390). If that is empty, both THREAD
  and hero are empty.
- The card hero is recomputed on the client from the run entries each time
  (useRuns.ts:694), with **no persistence**.
- Conversation bodies are permanently stored by claude at
  `~/.claude/projects/<toDirName(cwd)>/<sessionId>.jsonl`. The observer
  (observer.ts) tails this to build the RunEntry.
- `ProjectTask` is lightweight (id/title/done/milestoneId/createdAt). No run
  metadata.
- `clearFinishedSessions` (dismiss all) **immediately unlinks** runs/*.json,
  with no way to recover.

## New data model

```ts
// src/lib/types.ts (new)
interface TaskRunSummary {   // ① latest summary. Does not include body or log
  kind: 'done'|'review'|'skipped'|'error'|'overloaded'|'cancelled'
  topic?: string; summary: string; blockers: string
  followups?: string[]; question?: string; taskComplete?: boolean
  sessionId: string; finishedAt: string
}
interface TranscriptRef {    // ② reference to the claude JSONL. Holds no body
  sessionId: string; cwd: string; jsonlPath: string
}
// ProjectTask extensions (all optional, backward-compatible)
//   latestRun?: TaskRunSummary
//   agentSessionId?: string
//   transcriptRef?: TranscriptRef
```

- Persist `task.latestRun` into tasks.json → the hero/THREAD summary shows even
  on a fresh app.
- Use `task.transcriptRef` to lazily read past full text from the claude JSONL.
- `~/.openground/runs/` is **demoted to a cache**. Even if it disappears, ①
  remains.

## Phases (each an independent PR)

| # | risk | name | Goal state | Expected behavior |
|---|---|---|---|---|
| 1 | low | regression prevention | HOME can be isolated via the `OPENGROUND_HOME` env, vitest gets a tmp HOME, dismiss becomes unlink→archive | Tests don't damage the real ~/.openground. Even after dismiss all, you can restore from archive |
| 2 | low | type/schema extension | TaskRunSummary/TranscriptRef + the 3 ProjectTask fields (optional), zod support, round-trips OK | New fields can be written while staying compatible with existing tasks.json |
| 3 | med | ① persist latest summary | On run completion, write each targeted task's task.latestRun/agentSessionId/transcriptRef into tasks.json | On a fresh app, the card hero and THREAD summary show even without runs/ |
| 4 | med | ② past-log API | `GET /api/run/transcript` returns the JSONL paginated from transcriptRef (validateProjectPath) | "View past log" can read the full text of the claude JSONL |
| 5 | med | migrate existing + demote runs to cache | A startup sweep fills tasks with no latestRun once, from existing runs/*.json. From then on runs/ is a pure cache | After migration, resume/observer/Phase7 all work, and even if runs/ disappears the hero/summary survive |

Dependencies: 1 → 2 → 3 → {4, 5}.

## Contracts that must not break (verify during migration)

- **resume**: `claude --resume <sessionId>` — agentSessionId stays preserved
- **observer JSONL tail**: needs transcriptPath/sessionId
- **run queue (Phase 7)**: references the sessionId in goal.runQueue.sessions
- **worktree isolation/merge**, **SSE (run/events)** live stream
- **card hero / auto-loop / question turn**
- **backward compatibility**: existing tasks.json (without the new fields) /
  users who hold existing runs/ don't break

## Decisions on the open questions (defaults confirmed, no re-negotiation needed)

1. **Fold granularity**: write latestRun to **all tasks** in targetedTasks (each
   task holds its own latest)
2. **Runs whose task vanished**: discard them (favor lightweight; they remain in
   the claude JSONL)
3. **Archive retention**: auto-prune at 30 days mtime
4. **Transcript cache**: read raw every time at first (move to in-memory later if
   slow)
5. **dismiss**: unify on archive + keep a separate "permanent delete" behind a
   confirmation modal
6. **hero priority**: the newer one, by finishedAt comparison
7. **migration trigger**: piggyback on the server-startup sweep (transparent)

## Migration (backward-compatible)

- All new fields are optional. Existing tasks.json stays readable.
- The Phase 5 startup sweep scans existing runs/*.json exactly once and fills
  tasks with no latestRun (moving forward with no data loss). Right now runs/ is
  empty so nothing gets filled, but we put the mechanism in (because future runs
  persist ①, so it stops disappearing on a fresh app).
