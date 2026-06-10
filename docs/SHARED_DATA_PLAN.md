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
  `{ shared, gitRepo, remoteUrl: string|null, dirty, ahead, behind }`
  (`dirty` = `git status --porcelain -- .openground/` non-empty; false when
  not shared. `gitRepo` via `git rev-parse --is-inside-work-tree`.
  `ahead`/`behind` (added 2026-06-11) = commits touching `.openground/` in
  `@{upstream}..HEAD` / `HEAD..@{upstream}` — 0 when not shared / no
  upstream. Backed by a per-project throttled `git fetch` (60s window,
  globalThis-stamped) that gets a ≤2.5s grace inside the status call; a
  slower fetch lands in the background and the next poll reads it. UI:
  ↑n/↓n badges on the Sync button + a 90s visible-window status poll.)
- `POST /api/project/share/enable` `{path}` → `{ok:true}` | `{error}`
  (412-style errors: not a git repo / already shared / `.openground` is
  git-ignored — checked with `git check-ignore`.)
- `POST /api/project/share/disable` `{path}` → `{ok:true}` | `{error}`
- `POST /api/project/share/sync` `{path}` → `ShareSyncResult`
  `{ ok, committed, pulled, pushed, conflict?, message? }`
  Sequence: `git add -- .openground` → `git commit -m "openground: sync" --
  .openground` (pathspec commit leaves the user's staged code intact) →
  `git pull --rebase --autostash` (on rebase conflict: `git rebase --abort`,
  return `conflict:true` + message telling the user to pull manually) →
  `git push` (missing upstream ⇒ `pushed:false` + message). 60s timeouts.
  All git via `execFile` with `cwd = projectPath`, pathspec-scoped.
- Every route validates with `validateProjectPath` (repo subpaths already
  pass the boundary).

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

- Not shared: ⋯ menu item 「Gitで共有…」 (disabled + tooltip when not a git
  repo / missing). Confirm dialog explains the folder, what moves, and that
  push/pull uses the user's own git auth.
- Shared: header gets a quiet text button 「Sync」 with a small dot when
  `dirty`; while syncing the label swaps to 「Sync中…」. Result via the
  existing toast/error language. ⋯ menu gains 「共有を解除…」 (dialog notes
  the user commits the deletion). Remote short name shown next to Sync.
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
