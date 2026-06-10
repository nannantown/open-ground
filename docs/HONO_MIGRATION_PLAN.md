# OPEN GROUND: Hono migration implementation plan

> A sequel to `HONO_MIGRATION_RATIONALE.md` (why we migrate).
> This one covers **how to implement it** — phase breakdown, goal states,
> expected behavior, route mapping, and verification steps. The blueprint for
> each implementation team (workflow agent).

## 0. Confirmed assumptions / investigation results

Results of measuring the codebase before the migration (2026-05-29):

| Item | Measured | Implication |
|---|---|---|
| `'use client'` | **46 / 46 files** | The front end is already fully client = no SSR/RSC = becoming a Vite SPA is straightforward |
| `next/image` `next/link` | 0 | No porting cost |
| `next/navigation` | 1 | Minor (the screen route's params) |
| `next/font` | 1 (layout only) | Convert to `@font-face` |
| `next/dynamic` | 1 | `React.lazy` |
| route handlers | 45 | Mechanical port to Hono |
| SSE (`text/event-stream`) | 3 | Move to `streamSSE` |
| client `fetch('/api...)` | 12 sites | Keep at first, later convert to `hc` RPC |
| page.tsx | 2 (`page.tsx` + `screen/[…]/page.tsx`) | SPA entry + dynamic screen |
| layout.tsx | 1 | Into the Vite index.html |

**Conclusion**: the front end's Next dependency is minimal. The migration risk
is lower than the RATIONALE assumed.

## 1. Final goal state (observable once the whole migration is complete)

- `next` is gone from `package.json` dependencies
- The front end is built/served with `vite` + `@vitejs/plugin-react`
- The back end is `hono` + `@hono/node-server` + `@hono/zod-validator` (port 47776)
- Electron `fork`s `server/index.ts` (the Hono entry) — no standalone tracer needed
- `next.config.js` / `scripts/standalone-assets.js` are deleted
- `package.json`'s `build.asarUnpack` is node-pty only (the standalone workarounds are gone)
- `GET /api/health` returns `{app:'openground', bootId, port, projectDir, startedAt}` (contract preserved)
- All 3 SSE streams (run/events, terminal stream, screen watch) work via Hono `streamSSE`
- vitest / playwright are green
- `npm run dev` = `vite` + Hono via concurrently, HMR preserved
- `npm run dist` = Electron app bundling the Hono server + Vite static artifacts, with zero node-pty friction

## 2. Final expected behavior (user-perspective scenarios)

- During development `npm run dev` → the front end reflects instantly via Vite HMR; Hono runs in a separate process on 47776
- `electron:prod` / packaged `.app` → Electron forks the Hono server → 47776 → the window loads the Vite artifacts
- claude run → a Hono route calls src/lib/server/runner.ts (node-pty) as-is → PTY works (no friction)
- run logs / terminal / screen watch → streamed to the renderer over SSE (same experience as today)
- The workflow of opening `http://127.0.0.1:47776` in a regular Chrome to have Claude debug it is preserved
- launch-twice / Cmd+Q / single instance → Electron standard (reuses PR A's electron/main.js)

## 3. Contracts that must not break (RATIONALE §6 restated as implementation constraints)

The implementation team must verify these in each phase:

1. **Fixed port 47776 / `127.0.0.1`** (no auto-increment; a prerequisite for single instance)
2. **`GET /api/health`** returns `{app:'openground', bootId, port, projectDir, startedAt}`. `bootId` from env `OPENGROUND_BOOT_ID`, `projectDir` from env `OPENGROUND_PROJECT_DIR || cwd`
3. **`validateProjectPath()`** security boundary — preserved on every path-accepting API (resolved path under projectsRoot)
4. **The two-store structure** — `~/.openground/` (app) and `<project>/.openground/` (project)
5. **`src/lib/types.ts`** preserved as the shared client/server contract
6. **The `OPENGROUND_RESULT:` parser** (compatible with the legacy `HOVE_/PMMAP_` markers) preserved
7. **The `globalThis.__openground_runner` in-memory runner-state approach** preserved
8. **`src/lib/server/*` stays as-is in principle** — route handlers are thin adapters. Do not rewrite the business logic

## 4. Phase breakdown

Dependencies: P0 → {P1, P2 in parallel} → P3 → P4 → P5 → P6

### Phase 0 — Hono foundation (single agent; the base for the other phases)

**Goal state**: `server/index.ts` boots on 47776 and `/api/health` responds per the contract. `@hono/zod-validator` and the shared middleware (validateProjectPath helper, error handler) are wired in.
**Expected behavior**: `node server/index.ts` (or tsx) → `curl /api/health` returns 200 + the correct JSON.
**Work**:
- Add deps: `hono`, `@hono/node-server`, `@hono/zod-validator`, `tsx` (for dev execution)
- `server/index.ts`: Hono app + `serve({fetch, port:47776, hostname:'127.0.0.1'})`
- `server/health.ts`: `/api/health` (bootId/projectDir from env)
- `server/middleware/projectPath.ts`: a helper to use `validateProjectPath` in the Hono context
- Don't use a `server/lib/`; import the existing `src/lib/server/*` as-is (keep the path alias)
- Build form: the server is bundled into a single entry with tsx/esbuild (which Electron forks)
**Check**: `curl 127.0.0.1:47776/api/health` returns `app:'openground'`, with the bootId env reflected.

### Phase 1 — Port the 42 REST routes (parallel by group)

**Goal state**: the 42 non-SSE routes run on Hono with the same I/O as the Next version.
**Expected behavior**: curling each route returns the same status/body as the Next version.
**Porting-unit groups** (parallel):
- A: `project/*` (open, open/pick, rename, archive, restore, delete, tasks, task-image, canvases)
- B: `project/goals*` + `project/milestones*` (goals, goals/plan, goals/run-queue, milestones, milestones/run, milestones/verify)
- C: `run*` (run, run/cancel, run/dismiss, run/dismiss-conflict, run/list, run/resolve-conflict)
- D: `canvas*` + `designs/scaffold` + `screen/lock` + `paste-image`
- E: `projects`, `projects/new`, `settings`, `skills`, `usage`, `update/check`, `folder-info`, `pick-folder`, `observer/*`
- F: `terminal`, `terminal/[id]`, `terminal/[id]/input`, `terminal/[id]/resize` (dynamic route → `/terminal/:id/...`)
**Work**: turn each route handler into `app.get/post('/api/...', zValidator(...), (c) => ...)`. `NextResponse.json(x)` → `c.json(x)`. `Request` → Hono `c.req`. Calls into `src/lib/server/*` stay unchanged.
**Check**: per route, curl shows no diff from the Next version. Confirm `validateProjectPath` is preserved.

### Phase 2 — Port the 3 SSE streams (can be parallel with Phase 1)

**Goal state**: run/events, terminal/[id]/stream, screen/watch work via Hono `streamSSE`.
**Expected behavior**: connect with EventSource → events stream. Disconnect/reconnect behaves the same as today.
**Work**: `import { streamSSE } from 'hono/streaming'`. Turn each SSE route into `streamSSE(c, async (stream) => {...})`. Preserve the replay/reconnect comment behavior of `run/events`. subscribe/emit (globalThis runner) stays as-is.
**Check**: `curl -N 127.0.0.1:47776/api/run/events?since=0` keeps streaming.

### Phase 3 — Turn the front end into a Vite + React SPA

**Goal state**: `vite` builds/serves the front end. `src/components/*` work unmodified.
**Expected behavior**: Vite HMR via `npm run dev`, UI displayed at `http://127.0.0.1:47776` (Hono serving the Vite artifacts).
**Work**:
- `vite.config.ts` + `index.html` (equivalent to layout.tsx's `<head>`, with @font-face)
- `src/main.tsx`: React root mount (the contents of page.tsx as the entry)
- `src/app/page.tsx` → `src/App.tsx` (reuse the logic, drop the 'use client' directive)
- `next/font` (1) → `@font-face` CSS
- `next/dynamic` (1) → `React.lazy` + `Suspense`
- `next/navigation` (1) → lightweight client routing for the screen route (or query param)
- `src/app/screen/[projectSlug]/[moduleId]/page.tsx` → a Vite route (`/screen/:slug/:id`) or equivalent dynamic rendering
- Static serving on Hono: in prod Hono serves the Vite `dist/`; in dev Electron points at the Vite dev server
- Port the `@/*` alias into vite.config
**Check**: the UI renders; the Canvas / Chats / Terminal / Goals tabs work; the screen iframe renders.

### Phase 4 — Wire up Electron + remove Next

**Goal state**: Electron forks the Hono entry. next.config / the standalone workarounds are gone.
**Expected behavior**: with `electron:prod` / packaged `.app`, the Hono server forks → window → claude run works.
**Work**:
- `electron/main.js`: change the fork target from `.next/standalone/server.js` → `server/dist/index.js` (Hono bundle). Tidy the candidate paths.
- `package.json`: delete `output:'standalone'`, delete `scripts/standalone-assets.js`, point `build.files`/`extraResources` at the Hono server + Vite dist. `asarUnpack` is node-pty only.
- server bundle: esbuild `server/index.ts` → `server/dist/index.js` (node-pty external)
- make `npm run dev` / `electron:dev` run vite + Hono via concurrently
**Check**: cold-run the packaged `.app` → 47776 → claude run → node-pty works (confirm the node_modules problem that stalled PR A no longer exists).

### Phase 5 — hc RPC type safety (optional, can be deferred)

**Goal state**: the 12 client `fetch('/api...)` sites become typed `hc` calls.
**Work**: import the server types via `hono/client`'s `hc<AppType>`. Leverage the `src/lib/types.ts` contract.
**Check**: tsc detects end-to-end type errors.

### Phase 6 — Verification + cleanup

**Goal state**: zero Next traces, all tests green.
**Work**: remove the `next` dependency, delete `next.config.js` / `next-env.d.ts`, swap eslint-config-next → generic, adjust vitest/playwright for the Vite premise.
**Check**: `npm run lint && npx tsc --noEmit && npm test && npm run test:e2e` all green. Real-device QA of the packaged `.app`.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Differences in SSE reconnect behavior | In Phase 2, reproduce run/events' existing comment spec with streamSSE; measure with curl -N |
| Rendering of the screen dynamic route | In Phase 3, preserve the iframe load path; pass slug/id through the Vite route |
| Whether node-pty works under a Hono fork | Proven in a spike with ELECTRON_RUN_AS_NODE + node-pty. The Hono entry is "just Node", so forking is simple |
| A period where the app doesn't work mid-state | Proceed on a feature branch, partial-verify each Phase. Integrate green at the end |
| vitest depending on Next imports | Confirm in Phase 6; keep the @ alias in vitest.config (already handled) |
| The dogfood loop stalling | During the migration, keep the current OPEN GROUND.app (shell launcher + Next). Don't switch over until the Hono version is green |

## 6. How to proceed with the implementation (teams/workflows)

- **Workflow 1**: Phase 0 → {Phase 1, Phase 2 in parallel} → route verification
- **Workflow 2**: Phase 3 (Vite-ify the front end) → Phase 4 (wire up Electron) → integration verification
- **Workflow 3**: Phases 5 + 6 (type safety + cleanup + final QA)
- Confirm CI green at the end of each workflow; split PRs (P0-2 / P3-4 / P5-6) so they're reviewable
- Keep the shell launcher (openground-launch.sh) until the whole migration is done and dogfooding is stable
