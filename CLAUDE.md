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
npm test           # vitest (~450 tests)
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
  for the tab set). Terminal is tiled `claude` PTY panes; Board is a
  kanban whose per-card ▶ launches a claude terminal (slot keyed by
  taskId, shared with the Terminal tab); Canvas is the design /
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
- **`server/routes/`**: health, project, canvas, misc, terminal, sse.
  `server/middleware/projectPath.ts` adapts `validateProjectPath` to Hono.
  `server/routes/_shared.ts` holds cross-route helpers (e.g. `validateName`).

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
- **Exception — git-shared mode** (user-consented, per project): "Share via
  Git" moves Board + Canvas data INTO the repo under `.openground/` so
  collaborators sync it through normal git. The marker
  `.openground/openground.json` is the mode switch (detection automatic on
  import of a shared clone; creation ONLY via `/api/project/share/enable`).
  One card per file (`board/cards/<id>.json`), `notes.md`, canvases + shared
  order in `canvas/`; personal state (`tabOrder`, canvas `activeId`) STAYS
  central in both modes. The Sync button commits **pathspec-scoped to
  `.openground/` only** (never the user's code), then
  `pull --rebase --autostash`, then push — pure git, no GitHub API/tokens.
  Seam: `src/lib/server/sharedData.ts`; engine: `gitShare.ts`; routes:
  `server/routes/share.ts`. Full design: `docs/SHARED_DATA_PLAN.md`.

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
worktrees dir (`~/.openground/projects/<uuid>/worktrees/` — kept only because
legacy worktrees may still exist on disk; nothing creates new ones). The
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
  CLI — never the Anthropic API key. Board cards' ▶ goes through this; the
  resulting slot is keyed by taskId and shared between the Board drawer and
  the Terminal tab (single source of truth).
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
