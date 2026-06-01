# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The app is a **Vite + React SPA** (front-end) talking to a **Hono** server
(back-end) over a fixed loopback port. There is no Next.js anymore — see
`docs/HONO_MIGRATION_RATIONALE.md` / `docs/HONO_MIGRATION_PLAN.md`.

```bash
npm run dev        # Vite SPA (:5174) + Hono API (:47776) together (concurrently)
npm run dev:web    # Vite SPA only (:5174, HMR)
npm run dev:server # Hono API only (:47776, tsx watch)
npm run build      # vite build → dist-web/  +  esbuild → server/dist/index.cjs
npm run start      # prod: Hono on :47776 serving dist-web + /api (one origin)
npm run lint       # eslint . --ext .ts,.tsx
npm test           # vitest (75 tests)
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
  `zsh`/`claude`. (`src/lib/server/runner.ts` + `electron/main.js`.)
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

The product is **OPEN GROUND**. Existing user machines may still hold older
codenames' directories — `~/.pmmap/` then `~/.hove/` globally, and `.pmmap/`
then `.hove/` per project. Server code auto-migrates the whole lineage to
`~/.openground/` and `.openground/` on first read, including a rewrite of
each project's `.gitignore` (see `src/lib/server/paths.ts` and
`src/lib/server/projectMigration.ts`). The run-prompt result marker is
`OPENGROUND_RESULT:` for new runs; the parser still accepts the older
`HOVE_RESULT:` and `PMMAP_RESULT:` markers so archived run sessions keep
parsing.

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
repeat, juggle tabs) onto one canvas. It renders every project folder under a
configured root directory as a card on a pannable/zoomable infinite canvas,
tracks per-project tasks, and runs Claude Code in any of them from that
single surface.

It is a **multiplexer**, not a batch tool: each card carries its own independent
work. Firing the *same* prompt at many projects is just a special case. A card's
hero content is the **summary of its last run** — each card narrates "where this
project stands now."

It is not a deployed web app — server code reads and writes the user's filesystem
and spawns `claude` as a child process, so it must run locally.

**Two-layer canvas** (see `CONCEPT.md` for the full vision):

- **Layer 1 — Ground (portfolio canvas)** is OPEN GROUND's face: every
  project as a card, the core experience is *overview*, and Claude runs
  launch from here. Card position carries no system meaning (free
  workspace), so the card's *state* — chiefly its last-run summary —
  carries the whole overview.
- **Layer 2 — Canvas (per-project)** is the design / brainstorm surface
  inside a project (Chats / Terminal / **Canvas** / Overview tabs). Each
  project can hold multiple Canvases (Chrome-style tabs), each with its
  own sticky / text / frame / mock / comment elements and chat sidebar.
  Mock elements render live React (or HTML) in a sandboxed iframe — same
  pattern Claude Artifacts uses.

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
- **`server/routes/`** mirrors the old `src/app/api/*` tree: health, project,
  goals, run, canvas, misc, terminal, sse. `server/middleware/projectPath.ts`
  adapts `validateProjectPath` to Hono. `server/routes/_shared.ts` holds
  cross-route helpers (e.g. `validateName`).

### Two stores, two scopes

- **App config** lives in `~/.openground/` (see `src/lib/server/paths.ts`):
  `settings.json`, `canvas.json` (card positions + viewport), and
  `runs/<id>.json`. Accessed via `src/lib/server/store.ts`.
- **Per-project data** lives in `<project>/.openground/` inside each scanned
  project: `tasks.json` (chats / milestones / notes), `canvases/<id>.json`
  (Canvas-tab content), `canvases-index.json`, `task-images/` (clipboard
  pastes), `worktrees/` (parallel-run isolation). Accessed via
  `src/lib/server/projectData.ts` and `src/lib/server/canvasData.ts`.
  This directory is owned by OPEN GROUND; the run prompt explicitly tells
  Claude not to touch it.

### Project discovery

`src/lib/server/scan.ts` reads `settings.projectsRoot`, treats each subdirectory as a
project, and recurses one level into `settings.archiveDirName` (`_archive`) for
archived projects. Project `id` is a SHA1 of the folder name (stable across moves).
Archiving (`projectData.ts`) is a plain `fs.rename` into/out of the `_archive` folder.

**Security boundary:** every API route that takes a project path calls
`validateProjectPath()` — the resolved path must equal or sit under `projectsRoot`.
Preserve this check on any new path-accepting endpoint.

### The runner (batch Claude execution)

`src/lib/server/runner.ts` is the core of the "Run" feature:

- `startRun()` PTY-spawns `claude --dangerously-skip-permissions` (via
  `node-pty`) as a child process in each project's directory, with a
  concurrency-limited worker pool. **Subscription-only:** OPEN GROUND only ever
  drives the user's `claude` CLI — never the Anthropic API key.
- Runner state (sessions, child processes, SSE listeners) is stored on
  `globalThis.__openground_runner` so it **survives `tsx watch` server
  reloads** in dev. Keep this pattern for any new in-memory server state.
- Live logs stream to the client over Server-Sent Events via
  `/api/run/events` (`subscribe()` / `emit()`, Hono `streamSSE`); finished
  sessions are flushed to `~/.openground/runs/<id>.json` and re-read from disk
  by `getSession()`.
- The prompt is assembled in `server/routes/run.ts`: a template (with
  `{{tasks}}`, `{{notes}}`, `{{name}}` placeholders) + optional feedback from a
  prior run + a fixed `RESULT_INSTRUCTION`.
- That instruction asks the spawned Claude to emit a final
  `OPENGROUND_RESULT: {json}` line; `parseResult()` scrapes the **last** such
  line from the log to populate completed/skipped/summary/blockers. Legacy
  `HOVE_RESULT:` and `PMMAP_RESULT:` lines also parse, so archived runs keep
  their summaries.
- Before and after each run, git HEAD, `status --porcelain`, `diff --stat`, and
  `log --oneline` are captured into `RunGitInfo` so the UI can show what changed.

### Types

`src/lib/types.ts` is the single shared contract between client and server — update it
when changing any API payload.
