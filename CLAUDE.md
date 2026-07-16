# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The app is a **Vite + React SPA** (front-end) talking to a **Hono** server
(back-end) over a fixed loopback port. There is no Next.js anymore — see
`docs/HONO_MIGRATION_RATIONALE.md` / `docs/HONO_MIGRATION_PLAN.md`.

```bash
npm run dev        # Vite SPA (:5174) + Hono API (:47776) together (concurrently)
npm run dev:alt    # SECOND dev instance (worktree/parallel branch): auto-picks the
                   # first free port pair from Web :5175 / API :47777 upward and
                   # prints the URL. The primary pair 5174/47776 stays untouched.
                   # (OAuth login works only on the primary — fixed redirect URI.)
npm run dev:web    # Vite SPA only (:5174, HMR)
npm run dev:server # Hono API only (:47776, tsx watch)
npm run build      # vite build → dist-web/  +  esbuild → server/dist/index.cjs
npm run start      # prod: Hono on :47776 serving dist-web + /api (one origin)
npm run lint       # eslint . --ext .ts,.tsx
npm test           # vitest (~4100 tests)
npm run test:e2e   # playwright smoke (builds + boots Hono prod, then hits :47776)
```

**During development**, open <http://127.0.0.1:5174> in a browser: Vite serves
the SPA with HMR and proxies `/api` → Hono on 47776. (In prod the single Hono
process serves both the built SPA and `/api` on 47776 — one origin.) Or run it
inside the Electron window with `npm run electron:dev`.

### Desktop app (Electron)

OPEN GROUND ships as an **Electron app** (`electron/main.js`). Electron is the
final shell: it bundles Node (so node-pty can PTY-spawn `claude` under a
hardened runtime), forks the Hono server, and owns the window natively.

```bash
npm run electron:dev   # Vite(:5174) + Hono(:47776) + Electron window (HMR)
npm run electron:prod  # build, then Electron forks the bundled Hono server
npm run dist           # electron-builder → signed arm64 .dmg (dist-electron/)
```

- **dev** (`OPENGROUND_ELECTRON_MODE=dev`): Vite dev server + Hono are already
  running (via concurrently); Electron waits for `/api/health`, then loads the
  Vite URL (5174). HMR + live API both work.
- **prod** (packaged `.app`, or `electron:prod`): Electron forks the esbuild
  bundle `server/dist/index.cjs` with `ELECTRON_RUN_AS_NODE=1` on **fixed port
  47776**. That single Hono process serves the built SPA (`dist-web/`) **and**
  `/api` on one origin. Electron waits for `/api/health` to echo its `bootId`,
  then loads `http://127.0.0.1:47776`.
- **Single instance:** `app.requestSingleInstanceLock()` — a second launch
  raises the existing window instead of starting a new one (Electron-native;
  replaces the old shell launcher's bootstrap.lock dance).
- **Identity probe:** `GET /api/health` returns
  `{app:'openground', projectDir, bootId, port, startedAt}`; prod requires the
  forked server's `bootId` to match before loading the window.
- **PATH:** a Finder-launched `.app` inherits a stripped PATH, so before
  forking the server `main.js` resolves the login-shell PATH
  (`zsh -lic`, async) and passes it in env — otherwise node-pty can't spawn
  `zsh`/`claude`. (`src/lib/server/terminal.ts` + `electron/main.js`.)
- **asar: false** (package.json `build`): node-pty 1.2.x mangles its
  spawn-helper path inside an asar (`app.asar.unpacked.unpacked`), so the app
  ships unpacked. Local single-user tool — asar tamper-protection isn't a goal.
- Signing + notarization: `scripts/sign-and-notarize.sh` / `docs/DISTRIBUTION.md`
  (Developer ID cert + `openground-notary` keychain profile already set up).

> **Legacy shell launcher (`scripts/openground-launch.sh` + `make-app.sh` →
> `OPEN GROUND.app`) is DEPRECATED.** It ran `npm run dev` and opened a Chrome
> `--app` window at :47776 — but that assumed the Next.js dev server served the
> UI there. After the Hono migration :47776 is the API and the SPA is on Vite
> :5174, so the old `.app` no longer shows the UI. Use `npm run electron:dev`
> (or open <http://127.0.0.1:5174> directly) instead. The shell scripts are
> kept only until the Electron path is dogfood-proven, then removed.

## Legacy migration

The product is **OPEN GROUND**. Existing user machines may still hold an older
codename's **global** home dir — `~/.pmmap/` then `~/.hove/`. On first read
`ensureOpenGroundHome()` renames the whole lineage forward to `~/.openground/`
in one hop (only when a legacy dir exists and `~/.openground/` does not — it
never clobbers a real one); see `src/lib/server/paths.ts`. Separately,
`registry.ts` (`migrateOnce`) carries old single-root users into the project
registry model once per home.

**No files are written into the user's project folders** — there is no
per-project `.gitignore` rewrite and no per-project data dir inside the repo
(all per-project data lives centrally under
`~/.openground/projects/<uuid>/`, see the registry/data section below). Any
old per-project `.pmmap/` / `.hove/` dirs left in a repo from the in-repo era
are simply ignored, not migrated. (Historical note: an earlier version did
rewrite each project's `.gitignore` via a now-deleted `projectMigration.ts`;
a stale copy may still linger in the built bundle `server/dist/index.cjs`
until rebuilt.)

(Historical note: the batch-run era's `OPENGROUND_RESULT:` /
`HOVE_RESULT:` / `PMMAP_RESULT:` markers and the `runs/<id>.json` cache are
gone with the runner — leftover `runs/` files on user disks are legacy data,
pruned at boot by `src/lib/server/retention.ts`.)

## Git discipline

**Never use `git stash` in this repo.** Work must be either committed or discarded
before a session ends — stashes are invisible to the next session and cause exactly
the kind of "my changes disappeared" confusion described in the project history.

- Finished work → `git commit`
- Mid-task checkpoint → `git commit -m "WIP: <what you did so far>"`
- Throwaway experiment → `git restore .` / `git clean -fd`

If you find yourself about to run `git stash`, commit instead.

## Swarm / 司令塔まわりの正典

swarm エンジン(`src/lib/server/swarmOrchestrator.ts` / `swarmOverseer.ts` /
`swarmEscalations.ts` ほか)や司令塔運用を**診断・改修する前に
`docs/commander/00-INDEX.md` を読む**(症状→章の直行表・検証コマンド集・
信じてよい表示の一覧)。理想の稼働形とギャップは `docs/commander/TARGET-STATE.md`
が正典。swarm コアのコードを変更したら、同じ変更で docs/commander/ の該当章を
追随させる(TARGET-STATE §6 — 現物が正、食い違いは文書側を直す)。

## What this is

OPEN GROUND is a **local, single-user tool** — a **cockpit for Claude Code**.
It folds the N-terminal-windows workflow (cd into a project, launch `claude`,
repeat, juggle tabs) onto one canvas. It renders every registered project as a
card on a pannable/zoomable infinite canvas, tracks per-project board tasks,
and runs Claude Code in any of them from that single surface.

It is a **multiplexer**, not a batch tool: each card carries its own independent
work, and the **only execution path is the interactive terminal** (a real
`claude` PTY per task/project — no batch runs, no prompt templates). A card
shows its name + description plus a live **"Terminal" beacon** while any PTY is
running in that project.

It is not a deployed web app — server code reads and writes the user's filesystem
and spawns `claude` as a child process, so it must run locally.

**Two-layer canvas** (see `CONCEPT.md` for the full vision):

- **Layer 1 — Ground (portfolio canvas)** is OPEN GROUND's face: every
  project as a card, the core experience is *overview*, and Claude
  terminals launch from here. Card position carries no system meaning
  (free workspace).
- **Layer 2 — per-project tabs**: **Terminal / Canvas / Board** (see
  `src/components/canvas/moduleRegistry.tsx` — the single source of truth
  for the tab set), plus an **owner-only, hidden-by-default `Swarm` tab**
  (gated by `experiment: 'swarm'` — see the Swarm section) and any
  **user-installed custom tabs** (`server/routes/customModules.ts`,
  `~/.openground/custom-modules/`). Terminal is tiled `claude` PTY panes;
  Board is a kanban. Opening a card NO LONGER auto-launches anything (the drawer
  auto-launch died 2026-06-12, `BoardModule.tsx`); a task's `claude`
  session starts ONLY when the user clicks the card drawer's explicit
  **実行 (Run)** button, which launches `claude` with the composed task
  prompt AUTO-SENT (honouring the card's `run` flow / model / effort).
  Separately, "Insert task into input"
  (`POST /api/terminal/:id/paste-task`) pastes a task's title + content
  UNSENT (bracketed paste, no trailing newline) into a live session so
  the user reviews and presses Enter. Canvas is the design /
  brainstorm surface — multiple Canvases per project (Chrome-style tabs),
  each with sticky / text / frame / mock / comment elements. Mock
  elements render live React (or HTML) in a sandboxed iframe — same
  pattern Claude Artifacts uses. (The old Chats / Goals / Overview / Doc
  tabs and the batch "Run" feature were deleted outright in the
  terminal-only purge — 2026-06.)

## Architecture

**Vite + React SPA** front-end, **Hono** back-end, glued by a fixed loopback
port (47776). `@/*` maps to `src/*`.

- **Front-end:** `index.html` → `src/main.tsx` (React root + tiny pathname
  router: `/screen/...` → `src/screen/ScreenPage.tsx`, else `src/App.tsx`).
  `src/App.tsx` (the former `page.tsx`) holds all UI state; `src/components/*`
  are the views. All UI talks to the back-end via `fetch('/api/...')` (and
  SSE / EventSource). Built by Vite to `dist-web/`.
- **Back-end:** `server/index.ts` (entry, binds 47776) → `server/app.ts`
  (Hono app: mounts `server/routes/*.ts`, then a `/api/*` 404 guard, then
  `serveStatic(dist-web)` with SPA history fallback). Route handlers are
  **thin adapters** over the real logic in `src/lib/server/*`. Bundled by
  esbuild (`scripts/build-server.js`) to `server/dist/index.cjs`, which
  Electron forks in prod.
- **`server/routes/`**: health, project, canvas, canvasAi, misc, terminal,
  sse, auth, collab, customModules, moduleSubmissions, feedback, swarm,
  ticket, youCorpus. `server/middleware/projectPath.ts` adapts
  `validateProjectPath` to Hono. `server/routes/_shared.ts` holds
  cross-route helpers (e.g. `validateName`).

### Two stores, two scopes

- **App config** lives in `~/.openground/` (see `src/lib/server/paths.ts`):
  `settings.json` and `canvas.json` (card positions + viewport). Accessed via
  `src/lib/server/store.ts`. (`runs/<id>.json` files are run-era legacy,
  pruned at boot by `retention.ts`.)
- **Per-project data** lives **centrally** in
  `~/.openground/projects/<projectUUID>/` — **NOT** inside the scanned repo,
  keyed by the registry entry's stable UUID: `tasks.json` (board cards +
  notes) and `canvases/<id>.json` + `canvases-index.json` (+ per-canvas
  `canvases/<id>-assets/` images). The single resolver
  `src/lib/server/projectDataPath.ts` (`projectDataDir` / `projectUUIDFromPath`,
  which canonicalizes its input and **throws on miss**) is the seam every data
  module (`projectData.ts`, `canvasData.ts`, `canvasImages.ts`) routes
  through. A scanned project's working tree therefore stays **free of OPEN
  GROUND files** — mirroring how Claude Code keeps per-project state under
  `~/.claude/projects/`, never in the repo. (Run-era subdirs — `journal.json`,
  `doc.json`, `task-images/`, `task-attachments/`, `verify-logs/`,
  `worktrees/` — are legacy on old installs; old attachments are pruned by
  `retention.ts`, the rest is simply ignored.)
- **Sharing — realtime collab (v2, Cloudflare Durable Object)**: the old
  **"Share via Git" feature was removed** (`9aedd5d`); the in-repo
  `.openground/` data mode and its `sharedData.ts` / `gitShare.ts` /
  `server/routes/share.ts` seams **no longer exist**. Sharing is now a
  **CRDT (Yjs) realtime session — never files written into the user's
  repo**. The owner shares a project; members join by 7-day invite code or
  email and get a live Board + Canvas. Transport is a **Cloudflare Durable
  Object** WebSocket (`worker/src/OgCollabDoc.ts`, y-partyserver) gated by a
  short-lived minted **ticket**; membership + invites live in **Supabase**
  (`project_members`, RLS). Seams: `server/routes/collab.ts` (capability
  gate + per-project resolution + ticket mint),
  `src/lib/server/projectMembers.ts` (membership resolver + owner-managed
  writes), `src/lib/server/collabMirror.ts` / `canvasCollabMirror.ts`
  (server-side Board/Canvas writes mirrored INTO the collab doc so a shared
  project and swarm edits coexist without rollback). Client CRDT lives in
  `src/lib/collab/*` (`ydoc.ts`, `provider.ts` / `yProvider.ts`,
  `boardDoc.ts`, `canvasDoc.ts`, `assetSync.ts`, `RealtimeContext.tsx`); UI
  entries are `CollabSharedDialog.tsx` / `SharedProjectBody.tsx`. The whole
  path is **feature-gated and OFF by default** — inert unless enabled. Full
  design: `docs/COLLAB_CF_DO_PLAN.md` (+ `COLLAB_PLAN.md`,
  `COLLAB_MEMBER_CLIENT_PLAN.md`).

### Project discovery (registry model)

Projects are a **user-curated registry** (`settings.projects: ProjectEntry[]`),
not a scan of one root. The user adds projects one at a time: **Create new**
(make a folder under `settings.defaultWorkspace`, picked once natively) or
**Import existing folder** (register any folder anywhere on disk). Each entry is
`{ id, path, addedAt }` where `id` is a `crypto.randomUUID()` assigned at
registration — **stable across rename/move**, and the key for canvas card
positions. `path` is stored canonicalized (symlinks resolved).
`src/lib/server/scan.ts` builds the card list by stat-ing each registered entry;
a vanished folder is surfaced as `missing: true` — the card offers **"Locate
folder"** (`/api/projects/relocate` → `relocateProjectEntry`, which re-points the
entry at a user-picked folder **keeping its UUID** so the central data + canvas
position reconnect) as well as "Remove from canvas" — rather than dropped. The
registry CRUD + the one-shot legacy migration live in
`src/lib/server/registry.ts`.

`ensureProjectsMigrated()` runs once per home (gated by the persisted
`projectsMigratedAt` sentinel): existing users' old `projectsRoot` is scanned the
legacy way and each project becomes a registry entry, with `canvas.json`
positions re-keyed `sha1(name) → new UUID` so cards stay put. `projectsRoot` /
`archiveDirName` / `excludePatterns` survive only as deprecated migration inputs.

There is **no archive feature** anymore. "Remove from canvas" unregisters
(`/api/projects/remove`, folder untouched); "Delete" trashes the folder
(`/api/project/delete`), unregisters, **and `rm -rf`s the project's central data
dir** (`~/.openground/projects/<id>/`) so it doesn't orphan under a dead UUID.
Both drop the card's canvas position.

**Security boundary:** every API route that takes a project path calls
`validateProjectPath()` — the resolved-and-canonicalized path must equal or sit
under **one of the registered projects**, OR under that project's central
worktrees dir (`~/.openground/projects/<uuid>/worktrees/` — where the **swarm
engine** creates the isolated per-worker worktrees it owns; see the Swarm
section). The
registry is the allowlist (it only grows via the explicit Create / Import / relocate routes); the
UUID is taken **only** from the registry (never parsed from the incoming path),
both sides are canonicalized, and the bare central data root is rejected. The
shared predicate lives in `src/lib/server/projectDataPath.ts`
(`projectUUIDFromPath` / `isValidProjectPath`, re-exported as
`validateProjectPath`). Preserve this check on any new path-accepting endpoint.

### Terminal execution (the only execution path)

The batch runner was deleted in the terminal-only purge (2026-06). All Claude
execution is an **interactive PTY** the user types into:

- `src/lib/server/terminal.ts` — the node-pty pool. `POST /api/terminal`
  spawns a login shell (`zsh -l`) in a validated project cwd;
  `GET /api/terminal/:id/stream` streams output over SSE; input/resize/kill
  via the sibling routes. `GET /api/terminal/active` lists live PTY cwds —
  this feeds the Ground card's "Terminal" beacon (App polls it every 5s).
- `src/lib/server/claudeTerminal.ts` (`launchClaude`) — `POST
  /api/terminal/claude` spawns `claude --session-id <uuid>` inside a PTY.
  **Subscription-only:** OPEN GROUND only ever drives the user's `claude`
  CLI — never the Anthropic API key. The Board card's **実行 (Run)** button
  posts here with a `task` body + `taskWorktrees:true`: the server
  **composes the task prompt** server-side (`composeTaskPrompt` — the card's
  live drawer values → stored `card.run` → project prefs, i.e. title +
  notes + attachments, honouring flow / model / effort) and passes it as
  `initialPrompt` so claude launches with it **AUTO-SENT**. `taskWorktrees`
  also pre-authorizes the central worktrees dir + the card's out-of-repo
  attachments dir via `--add-dir` so file / attachment reads don't trip path
  prompts.
- Separate **UNSENT** path — "Insert task into input" (`POST
  /api/terminal/:id/paste-task`) pastes a task's title + content (same
  `composeTaskPrompt`) into a LIVE session, wrapped by
  `src/lib/server/pastePrompt.ts`'s `bracketedPaste` in bracketed-paste
  markers (stripping any embedded ESC so the span can't be closed early),
  no trailing newline — the user reviews and presses Enter. Keyed by taskId.
- Terminal pool state is stored on `globalThis.__openground_terminal` so it
  **survives `tsx watch` server reloads** in dev. Keep this pattern for any
  new in-memory server state.
- `src/lib/server/transcript.ts` (`readTranscript`) reads Claude Code's own
  JSONL session files (`~/.claude/projects/...`) — used only by
  `generateDescription.ts` (the card's auto-description, which launches a
  one-off claude PTY and polls the transcript for its DESC marker).

### Types

`src/lib/types.ts` is the single shared contract between client and server — update it
when changing any API payload.
