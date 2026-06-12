# Git-shared Board & Canvas — design + implementation plan

Decided with the user (2026-06-10): Board and Canvas data can optionally live
**inside the project repo** under `.openground/`, so collaborators on the same
GitHub repo share the board and canvases through normal git (`pull` = sync).

Three locked decisions:

1. **Pure git.** No GitHub OAuth/App/API/tokens. The project's existing
   `git remote` + the user's own git auth do all the work. Works with any host.
2. **Sync button.** One click: commit (scoped to `.openground/` only) → `git
   pull --rebase --autostash` → push. The app NEVER touches paths outside
   `.openground/` and never disturbs the user's staged code changes.
3. **Folder name: `.openground/`** (hidden, like `.github/`).

## Goal state (user-visible)

- A project panel whose repo is git gets a "Gitで共有 / Share via Git" action.
  Confirming creates `.openground/` and migrates Board+Canvas data into it.
- While shared: a quiet **Sync** button in the panel header (dot = unsynced
  local changes). Pressing it commits `.openground/` changes, pulls, pushes,
  then the UI refetches and shows teammates' changes.
- A collaborator clones the repo and just **imports the folder** — the app
  detects `.openground/openground.json` and reads board/canvas from the repo
  automatically. Zero setup.
- "共有を解除 / Stop sharing" copies data back to central storage and deletes
  the folder (user commits the deletion themselves; the dialog says so).
- Terminal claude sessions can read/write `.openground/` files directly —
  edits show up in the UI on window focus / after Sync.

## Repo layout (shared mode)

```
.openground/
  openground.json          # marker + shared project meta: {"version":1,"description":""}
  board/
    cards/<taskId>.json    # ONE ProjectTask per file (append never conflicts)
    notes.md               # ProjectData.notes as plain markdown
  canvas/
    canvases/<id>.json     # existing CanvasFile format, one per canvas
    index.json             # {"order": string[]} — order only (shared)
    assets/<canvasId>/…    # canvas image assets (binary)
```

**Stays central (personal, never in the repo):** `tabOrder`, canvas
`activeId`, terminal state. Central `tasks.json` keeps holding the personal
fields in shared mode; the storage adapter composes the two sources.

**Detection:** presence of a parseable `.openground/openground.json` with a
numeric `version` ⇒ shared mode. Detection is automatic; creation only ever
happens via the explicit enable route. The legacy "no files in the user's
repo" rule in CLAUDE.md gets this one user-consented exception.

## Seam (already on this branch — all tracks build on it)

`src/lib/server/sharedData.ts`: path helpers (`sharedDataDir`,
`boardCardsDir`, `boardNotesPath`, `canvasFilesDir`, `canvasIndexPath`,
`canvasAssetsDir`), `readSharedMarker` / `writeSharedMarker` / `isShared`.
`src/lib/types.ts`: `ShareStatus`, `ShareSyncResult`.

## API contracts (pinned — do not drift)

- `GET /api/project/share/status?path=` → `ShareStatus`
  `{ shared, gitRepo, remoteUrl: string|null, dirty, ahead, behind,
  forcedUpdate?, branch? }`
  (`dirty` = `git status --porcelain -- .openground/` non-empty; false when
  not shared. `gitRepo` via `git rev-parse --is-inside-work-tree`.
  `ahead`/`behind` (added 2026-06-11) = commits touching `.openground/` in
  `@{upstream}..HEAD` / `HEAD..@{upstream}` — 0 when not shared / no
  upstream. Backed by a per-project throttled `git fetch` (60s window,
  globalThis-stamped) that gets a ≤2.5s grace inside the status call; a
  slower fetch lands in the background and the next poll reads it.
  `forcedUpdate` (S25): the fetch saw "(forced update)" — sticky until a
  sync absorbs the rewrite. `branch`: the checked-out branch (absent when
  detached / not git) — shared data follows the branch, so the UI names it.
  UI: ↑n/↓n badges + ⚠ + ⎇branch on/next to the Sync button, 90s poll.)
- `POST /api/project/share/enable` `{path, config?}` → `{ok:true}` | `{error}`
  (412-style errors: not a git repo / already shared / `.openground` is
  git-ignored — checked with `git check-ignore`. Enable commits NOTHING; the
  invite panel right after offers "Publish now (Sync)".
  `config` (added 2026-06-12, share-UX redesign — docs/SHARE_UX_FLOWS.md):
  optional `ShareEnableConfig` `{completionFlow?: 'merge'|'pr',
  targetBranch?: string, members?: string[]}` — the ShareStartDialog's
  confirmed policy. Strictly validated (exactly those keys/types, members
  trimmed+deduped; anything else → 400 BEFORE preconditions). When present
  it is merged into the CENTRAL config before `migrateBoardToShared`, which
  carries it into the marker via the existing central→marker path. Omitted
  config = the legacy enable, byte-identical behaviour.)
- `POST /api/project/share/disable` `{path}` → `{ok:true}` | `{error}`
- `POST /api/project/share/sync` `{path}` → `ShareSyncResult`
  `{ ok, committed, pulled, pushed, conflict?, conflictFiles?, reason?,
  offline?, noRemote?, forcedUpdate?, message? }`
  Preflight (2026-06-11): refuses — touching nothing — when a rebase/merge is
  already in progress (`reason:'rebase-in-progress'|'merge-in-progress'`; the
  user's own half-resolved operation must never be aborted by us) or on a
  detached HEAD (`reason:'detached-head'`).
  Sequence: `git add -- .openground` → `git commit -m "openground: sync" --
  .openground` (pathspec commit leaves the user's staged code intact;
  identity-less machines fail with `reason:'no-identity'`) →
  `git pull --rebase --autostash` (on rebase conflict: capture the unmerged
  paths, `git rebase --abort`, return `conflict:true` + `conflictFiles`
  humanized as `card "Title"` / `notes` / relative path; an autostash whose
  re-apply conflicts — git exits 0! — returns `reason:'autostash-conflict'`
  with ok:false so it can never pass as a silent success) →
  `git push` (no upstream + an origin ⇒ auto-publish `push -u origin
  <branch>`; non-fast-forward ⇒ ONE transparent retry round pull→push;
  unreachable remote sets `offline:true`, no remote at all `noRemote:true`).
  A pull that absorbed a rewritten upstream sets `forcedUpdate:true` (the UI
  shows a persistent warning). 60s network timeouts. All git via `execFile`
  with `cwd = projectPath`, pathspec-scoped. The client maps `reason` codes
  to localized, actionable notices; `message` stays the raw English fallback.
- `POST /api/project/share/resolve` `{path, choices}` → `ShareSyncResult`
  (2026-06-11). In-app conflict resolution: `choices` maps each conflicted
  file to `'mine' | 'theirs'` (named from the USER's view; the engine owns
  the rebase-stage inversion — git's stage 2/"--ours" is the upstream
  teammate, stage 3/"--theirs" the local commit). Re-runs the sync; on the
  conflict it resolves each unmerged file via `checkout --ours/--theirs` +
  `add` (a side that deleted the file → `git rm`), then `rebase --continue`
  (GIT_EDITOR=true) looping across replayed commits, `--skip`ping a commit
  the resolution emptied, then pushes. A conflicted file WITHOUT a choice
  aborts and returns the fresh `conflicts` set — the app never picks a side
  the user didn't see. The sync/conflict results carry `conflicts:
  ShareConflict[]` (file, label, kind, mine/theirs {exists, title}) — the
  dialog's data. The dialog is only offered when EVERY conflicted file is
  under `.openground/`; code conflicts stay the user's own rebase.
- Every route validates with `validateProjectPath` (repo subpaths already
  pass the boundary).

## Auto-sync ("Live" — Notion-feel on git bones, 2026-06-11)

`src/lib/server/shareAutoSync.ts` — a per-project background engine; the
manual Sync button becomes a Live indicator (clicking = force sync now).
Decided in the 壁打ち of 2026-06-11: B (auto-sync over pure git) over D
(realtime backend) — no infrastructure, clone-onboarding and offline-safety
keep working, the "feel" comes from cadence.

- **Adaptive fetch**: `nextInterval` — activity (a fetch that moved refs, a
  local shared write, a successful sync) snaps the per-project interval to
  15s; each idle round doubles it up to 120s. Two people editing converge on
  ~15s "almost live"; an idle project costs one ref-ping every 2 minutes.
- **Apply only on `behind > 0`** — an idle round never touches the working
  tree. **Debounced push**: any shared-data write (`writeProjectData`
  shared branch, `writeCanvasFile`, shared canvas index) calls
  `noteSharedWrite` → 5s debounce → sync round. A dirty `.openground/` also
  gets picked up by the next round as a backstop (covers asset writes).
- **CODE IS SACRED**: `aheadIsSharedOnly` — if ANY commit in
  `@{upstream}..HEAD` touches a path outside `.openground/`, the engine
  parks in `paused-code`: no auto commit/rebase/push until the USER pushes
  their code (manual Sync still available, and it explains itself).
- Other parked modes: `conflict` (structured set kept for the dialog),
  `offline` (pending push survives), `blocked` (user mid rebase/merge),
  `error` (loud — e.g. autostash restore conflict), `disabled` (personal
  `launch.autoSync:false`; default ON, stored only as an explicit opt-out).
- **Wiring**: the status route is the heartbeat — it refreshes the pref,
  `ensureAutoSync`s the project and returns `ShareStatus.auto`
  (mode/lastSyncAt/pendingPush/intervalMs). Manual sync/resolve report into
  the engine (`noteManualSync`); disable share stops it. State on
  globalThis; timers `unref`ed; one in-flight round per project.
- **UI**: ● Live (moss) / Syncing / Paused / Conflict / Offline / Error on
  the Sync button, 20s status poll while visible (90s when auto is off),
  auto-round conflicts/errors post persistent notices on mode TRANSITION,
  and a fresh `auto.lastSyncAt` reloads board+canvas immediately.

## Storage adapters (public APIs unchanged)

- `readProjectData/writeProjectData` (projectData.ts): in shared mode tasks
  come from `board/cards/*.json` (zod per file; corrupt file ⇒ skip, never
  nuke), `notes` from `notes.md`, `description` from the marker; `tabOrder` +
  `updatedAt` from central. Writes diff card files (write changed, delete
  removed, `atomicWriteJson`, pretty-printed stable key order).
- canvasData.ts / canvasImages.ts: same branch — files under
  `.openground/canvas/`, shared `index.json` holds `order` only; `activeId`
  keeps living in the central `canvases-index.json` in both modes.

## Migration

- enable: central → repo (cards split out of tasks.json, notes.md, marker
  with description, canvases + index order + assets copied). Central files
  stay as a stale backup (marker decides the live source).
- disable: repo → central (overwrite), then delete `.openground/`.
- Both implemented as `migrateBoardToShared/FromShared` (Track A) and
  `migrateCanvasToShared/FromShared` (Track B); the enable/disable routes are
  wired in the integration phase.

## UI (user taste: text-only, minimal, no decorative icons)

Redesigned 2026-06-12 — full rationale + flow audit in
**docs/SHARE_UX_FLOWS.md** (the canonical UX spec for this section).

- Not shared (git repo): TWO entry points, neither in the ⋯ menu — a quiet
  header text button 「Share…」 occupying the same slot Sync/Live takes
  after sharing, and a CTA at the bottom of Project settings. Both open the
  **ShareStartDialog** (`src/components/canvas/ShareStartDialog.tsx`): one
  vertical screen confirming display name (required; saved to the global
  settings BEFORE enable), members, completionFlow + targetBranch (sent as
  the enable `config`), the remote (no-remote warning, non-blocking) and the
  shared-data-follows-the-branch note. On success the dialog swaps in place
  to the **InvitePanel**: publish state + "Publish now (Sync)", the
  teammate's 3 steps, and a copyable invite message with the remote URL
  (re-openable anytime from settings 「招待方法を表示…」).
- Non-git project: NO share affordance anywhere; Project settings shows the
  Personal section only (no workflow/worktrees either).
- Shared: header keeps the Sync/Live cluster (dot when `dirty`, ↑/↓ counts,
  ⚠ forced-update, ⎇branch, remote short name). Project settings gains a
  共有 section: status line, inline display-name editing (global setting),
  members, Auto-sync (personal — device-only note), 「招待方法を表示…」 and
  「共有を解除…」 (the unshare confirm also warns that teammates' boards
  will look empty once the removal is pushed). The workflow section's hint
  switches to "applies to the whole team".
- Section visibility is a pure function: `settingsSections` /
  `showHeaderShare` in `src/lib/shareUx.ts` (unit-tested).
- After successful sync (and on window focus while shared): refetch project
  data + canvases.
- All five interactive states; i18n en+ja.

## Test strategy

HOME isolated to tmpdir (repo rule). Git tests run against a local fixture:
`git init --bare remote.git` + two clones in tmpdir = User A / User B; no
network. Cover: marker detection, board/canvas adapter round-trips in both
modes, enable/disable migration round-trip (incl. assets), sync happy path,
sync with concurrent edits (B pulls A's card), rebase-conflict abort path,
pathspec scoping (a dirty src/ file must never be committed by Sync),
route security (403 for /etc), check-ignore guard.

## Tracks (worktree-parallel)

- **A — Board adapter**: projectData.ts shared backend + board migration + tests.
- **B — Canvas adapter**: canvasData.ts/canvasImages.ts shared backend + canvas migration + tests.
- **C — Git engine**: gitShare.ts (status/sync/preconditions) + status/sync routes + fixture tests.
- **D — UI**: share dialog, Sync button, menu items, focus-refetch, i18n — against the contracts above (enable/disable routes may 404 until integration; UI must degrade gracefully).
- **Integration (after merge)**: enable/disable routes wiring A+B migrations + C preconditions, e2e, CLAUDE.md update.
