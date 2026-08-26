# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **コード探索の前に [docs/MAP.md](docs/MAP.md) を読む** — 機能領域→入口ファイル→テスト→落とし穴の1枚索引(探索の買い直し防止)。

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
- Signing + notarization: **CI (`release.yml`) on a tag push**, or `npm run dist`
  locally — electron-builder signs, notarizes and staples in one step. See
  `docs/DISTRIBUTION.md` (Developer ID cert + `openground-notary` keychain
  profile already set up).

**Installing a release on the owner's own Mac: standing permission (owner
decision, 2026-08-14).** Once a release is published, go ahead and install it
on the owner's machine and restart the app — every time, without asking first.
This is a STANDING grant, not a per-release one; it was given precisely so the
ask stops repeating. Written down here because sessions are ephemeral and a
grant nobody can find is a grant that gets re-requested. Say what was installed
afterwards; do not stop to confirm beforehand. Scope is exactly this: install a
PUBLISHED OPEN GROUND release and restart the app. It authorizes nothing else on
that machine — anything beyond installing and restarting is a separate ask.

> **The legacy shell launcher is GONE (removed 2026-08-06).**
> `scripts/openground-launch.sh`, `make-app.sh`, `openground-activate.sh`,
> `sign-and-notarize.sh` and `entitlements.plist` built and signed a shell-script
> `.app` from the Next.js era. This note used to say they were "kept only until
> the Electron path is dogfood-proven" — it is proven, and they were removed the
> day the leftover bundle bit.
>
> **How it bit, because it is the reason to delete rather than deprecate.** The
> built `OPEN GROUND.app` sat in the repo root registering the bundle id
> `local.openground.launcher`. macOS resolves an app by DISPLAY NAME, and both
> bundles are called "OPEN GROUND" — so the name pointed at the dead launcher
> instead of `/Applications/OPEN GROUND.app` (`local.openground.app`). Launching
> "OPEN GROUND" by name started the corpse, which announced
> 「already running from another checkout」 and quit. A deprecated artifact does
> not sit quietly out of the way; it shadows the live one.
>
> Use `npm run electron:dev` (or open <http://127.0.0.1:5174> directly).

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

## 検証の掟(テストを書く前に読む)

> 正典は **[docs/VERIFICATION.md](docs/VERIFICATION.md)**。2026-08-01〜02 に9周の
> 敵対的レビュー(約60件修正)と実機の受け入れ検証5本を回した**実測**から書かれている。

**書いた人と確かめる人が同じなら、緑は証拠にならない。** このリポジトリはコードもテストも
同じ種類の LLM が書くので、生成の盲点と検証の盲点が相関する。実測: 棚卸し番人に欠陥を
4件植えて4件すり抜けた／`typeof f === 'function'` を見るテストは空実装で満たされた
(kill・say・nudge を全部空にしても76件が緑)／同時起動テスト2本が本物の SDK が
クラッシュしきる前に数えて緑になっていた。

非交渉の4つ:

1. **番人は書くだけでは番人にならない。** 直す → 番人を書く → **本番を修正前に戻して
   赤を実測** → 復元して緑。赤が出ない番人は消してよい(安心を配るだけで検出しない)。
2. **「呼べる」ではなく「効く」を見る。** `typeof f === 'function'` / `status === 200` /
   「エラーが出ない」は、何もしない実装で満たされる。観測可能な結果を見ること
   (「関数が呼ばれた」ではなく「ディレクトリが残っている」「本文が届いた」)。
   ⚠ 書き込みは **本番の読み手で読み戻す**(`POST /api/settings` は allowlist で body を絞る)。
3. **プロセス / git / FS / claude に触るなら、「できた」と言う前に一度は実機で通す。**
   9周のレビューで出ず実機で1発で出たもの: 配布ビルドで SDK worker が1体も起動しない /
   Windows で安全装置が全書き込みを拒否 / 戻すスイッチが実態と逆を表示。
   ⚠ **`node server/dist/index.cjs` は実機ではない**(2026-08-02 実測)。本番は Electron が
   fork した Node で、`require(ESM)` の可否が逆になる。この差だけで SDK ランタイムが
   **2版(0.11.47/0.11.48)にわたり配布アプリで一度も点火していなかった**。
   モジュール読み込み / ネイティブ / SDK 起動に触るなら **packaged .app で別枠1回**
   (VERIFICATION.md §4.1)。
   ⚠ **AI の遵法は安全装置ではない** — 禁止操作は AI 自身が断ってしまうので、
   断る理由のない普通の操作で規則に触れるものを選ぶ。
4. **同じ型が2回出たら、レビューをやめて構造で止める。** 判定の向きが生死を分ける:
   存在検査(登録漏れ = 沈黙)ではなく過大近似(そもそも名前が見えない = ビルドエラー)へ。

**停止条件は「1周ゼロ」ではない**(到達不能。レビューが見つける欠陥の75%は可読性・構造で
動作の欠陥は25%、周回数を増やしても検出率に有意差なし、修正自体の誤り率は14.8〜24.4%)。
停止条件は機械的不変条件 — tsc / lint / 全テスト / build / **番人の赤の実測** /
実機の一巡 / PII・HOME・棚卸し番人。

## Git discipline

**Never use `git stash` in this repo.** Work must be either committed or discarded
before a session ends — stashes are invisible to the next session and cause exactly
the kind of "my changes disappeared" confusion described in the project history.

- Finished work → `git commit`
- Mid-task checkpoint → `git commit -m "WIP: <what you did so far>"`
- Throwaway experiment → `git restore .` / `git clean -fd`

If you find yourself about to run `git stash`, commit instead.

## Language policy

**New work defaults to English.** Code comments, commit messages, new docs,
and new CLAUDE.md sections written from now on should be primarily in
English (owner decision, 2026-08-13).

**Exception — owner-facing text follows Settings.language, not this policy.**
Anything a non-programmer owner reads directly (conversational replies,
escalation questions / `plainQuestion`, UI copy — and notification `detail`
strings, today hardcoded Japanese in `swarmOrchestrator.ts`,
`swarmOverseer.ts`, `swarmEscalations.ts`, and `selfUpdateOnIntegrate.ts`;
language switching is wired NOWHERE for these yet, so write new ones in
Japanese to match until it is) keeps following `Settings.language` (unset ⇒
English, per `src/lib/types.ts` and `src/lib/server/promptLang.ts`) — this
policy neither overrides nor changes that resolution. See the worker rule
("質問は平易文で") in `src/lib/server/swarmWorker.ts` and the `plainQuestion`
contract comment in `src/lib/types.ts` for the plain-language obligation on
these surfaces, and `docs/commander/06` §2.2 for the same.

**This is forward-only — never retroactive**, with one exception: a card
explicitly ordered to translate/rewrite existing Japanese docs (e.g. "rewrite
these docs to English") is allowed to do that — the ban is on *incidental*
cleanup while working on something else, not on explicitly commissioned
rewrites. Outside of such a card, do not translate, rewrite, or "clean up"
existing Japanese comments, docs, or commit history just to make them
English. Touch existing Japanese content only when you are already editing
that code/doc for an unrelated reason, and even then prefer leaving it as-is
unless the edit is trivial. Mixed-language files are expected and fine
during this transition.

**Frozen — never "translate as trivial".** Code-matched string constants
(regardless of language) are not text, they are protocol, and changing them
silently breaks classification of anything already on disk or in journals:
marker constants (e.g. `REWORK_LOG_MARKER = '差し戻し review→'` and
`ESCALATION_ANSWER_MARKER` in `swarmOrchestrator.ts`, `SPECIALIST_SOURCED_MARKER`
in `swarmSpecialistReview.ts`, and heartbeat field values) are frozen
outright. The UI trigger vocabulary
("状況" / "マージ" / "掃除") allows adding English aliases alongside the
existing Japanese, but never removing the Japanese. These are out of scope
for this policy's translate/rewrite ban entirely, including under the
"trivial edit" allowance above.

**Scope notes:**
- Board card titles/notes are owner-facing (they surface in the Board UI and
  escalations) — follow `Settings.language` like other owner-facing text
  above.
- A brand-new file, or a brand-new section added inside an existing
  Japanese-language file, defaults to English. A few lines added into an
  existing Japanese list/paragraph (not a new section) matches the
  surrounding language instead.
- Release notes keep their existing bilingual convention
  (`docs/DISTRIBUTION.md` / `RELEASE_REPORT.md`) — unaffected by this policy.

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
  for the tab set), plus a **hidden-by-default `Swarm` tab** (gated by
  `experiment: 'swarm'` — owner via `experiments.swarm`, OR the login-free
  `swarmLocalOwner` unlock, OR since 0.11.94 a PUBLIC macOS opt-in
  `Settings.swarmOptIn` any user can turn on in Settings behind a "still
  being tuned" warning; Windows stays owner-only until the guard has a
  real-Windows pass — `isSwarmOptInEnabled`/`isSwarmOptInAvailable` in
  swarmGate.ts. See the Swarm section) and any
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
  path is **feature-gated and OFF by default** — inert unless enabled, and
  since 2026-08-23 that holds for RELEASES too: `release.yml` passes
  `OPENGROUND_REALTIME` / `OPENGROUND_COLLAB_WS_URL` through from repo
  Variables with **no fallback**, so a shipped build has collab off unless both
  are set deliberately (owner decision — the old `|| '1'` default meant a
  signed-in user merely opening a Board/Canvas tab uploaded that project to the
  operator's Durable Object, with no share action and no delete path). The
  guard that keeps the default off is in `server/__tests__/runtimeConfig.test.ts`.
  **Read `docs/COLLAB_STATUS.md` before touching collab** — it is the current
  canon (spec + what is actually verified + the open gaps); the six
  `docs/COLLAB_*.md` plan docs are all stale in different ways and its §5 says
  how.

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
