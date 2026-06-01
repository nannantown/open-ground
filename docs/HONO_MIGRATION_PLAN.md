# OPEN GROUND: Hono 移行 実装プラン

> `HONO_MIGRATION_RATIONALE.md` (なぜ移行するか) の続編。
> こちらは **どう実装するか** のフェーズ分解・ゴール状態・期待挙動・
> route マッピング・検証手順。各実装チーム(workflow agent)の設計図。

## 0. 確定した前提・調査結果

移行前にコードベースを実測した結果(2026-05-29):

| 項目 | 実測値 | 含意 |
|---|---|---|
| `'use client'` | **46 / 46 ファイル** | フロントは既に全部クライアント = SSR/RSC 未使用 = Vite SPA 化が素直 |
| `next/image` `next/link` | 0 | 移植コストなし |
| `next/navigation` | 1 | 軽微 (screen route の params) |
| `next/font` | 1 (layout のみ) | `@font-face` 化 |
| `next/dynamic` | 1 | `React.lazy` |
| route handler | 45本 | Hono へ機械的移植 |
| SSE (`text/event-stream`) | 3本 | `streamSSE` へ |
| client `fetch('/api...)` | 12箇所 | まず維持、後で `hc` RPC 化 |
| page.tsx | 2 (`page.tsx` + `screen/[…]/page.tsx`) | SPA エントリ + 動的 screen |
| layout.tsx | 1 | Vite index.html へ |

**結論**: フロントの Next 依存は極小。移行リスクは RATIONALE の想定より低い。

## 1. 最終ゴール状態 (全移行完了時に観測できるもの)

- `next` が `package.json` の dependencies から消えている
- `vite` + `@vitejs/plugin-react` でフロントをビルド・配信
- `hono` + `@hono/node-server` + `@hono/zod-validator` でバックエンド (port 47776)
- `server/index.ts` (Hono entry) を Electron が `fork` する (standalone トレーサ不要)
- `next.config.js` / `scripts/standalone-assets.js` が削除されている
- `package.json` の `build.asarUnpack` は node-pty のみ (standalone 手当てが消える)
- `GET /api/health` が `{app:'openground', bootId, port, projectDir, startedAt}` を返す (契約維持)
- SSE 3本 (run/events, terminal stream, screen watch) が Hono `streamSSE` で動く
- vitest / playwright が green
- `npm run dev` = `vite` + Hono を concurrently、HMR 維持
- `npm run dist` = Electron app に Hono server + Vite 静的成果物を同梱、node-pty 摩擦ゼロ

## 2. 最終 期待挙動 (ユーザー視点シナリオ)

- 開発時 `npm run dev` → Vite HMR でフロント即反映、Hono は別プロセスで 47776
- `electron:prod` / packaged `.app` → Electron が Hono server を fork → 47776 → window が Vite 成果物をロード
- claude run → Hono route が src/lib/server/runner.ts (node-pty) をそのまま呼ぶ → PTY 動作 (摩擦なし)
- run ログ / terminal / screen watch → SSE で renderer にストリーム (今と同じ体験)
- 通常 Chrome で `http://127.0.0.1:47776` を開いて Claude にデバッグさせるワークフロー維持
- 二度起動 / Cmd+Q / single instance → Electron 標準 (PR A の electron/main.js 流用)

## 3. 壊してはいけない契約 (RATIONALE §6 を実装制約として再掲)

実装チームは各フェーズでこれらを verify すること:

1. **固定ポート 47776 / `127.0.0.1`** (auto-increment 禁止、single instance の前提)
2. **`GET /api/health`** が `{app:'openground', bootId, port, projectDir, startedAt}` を返す。`bootId` は env `OPENGROUND_BOOT_ID`、`projectDir` は env `OPENGROUND_PROJECT_DIR || cwd`
3. **`validateProjectPath()`** のセキュリティ境界 — path 受け取り API すべてで維持 (resolved path が projectsRoot 配下)
4. **二ストア構造** — `~/.openground/` (アプリ) と `<project>/.openground/` (プロジェクト)
5. **`src/lib/types.ts`** をクライアント/サーバ共通契約として維持
6. **`OPENGROUND_RESULT:` パーサ** (旧 `HOVE_/PMMAP_` マーカー互換) 維持
7. **`globalThis.__openground_runner`** の in-memory ランナー状態方式維持
8. **`src/lib/server/*` は原則そのまま** — route handler は薄いアダプタ。ビジネスロジックを書き換えない

## 4. フェーズ分解

依存: P0 → {P1, P2 並列} → P3 → P4 → P5 → P6

### Phase 0 — Hono 基盤 (単一 agent、他フェーズの土台)

**Goal state**: `server/index.ts` が 47776 で起動し `/api/health` が契約通り応答。`@hono/zod-validator` と共通ミドルウェア(validateProjectPath ヘルパ、エラーハンドラ)が配線済み。
**Expected behavior**: `node server/index.ts` (or tsx) → `curl /api/health` が 200 + 正しい JSON。
**Work**:
- deps 追加: `hono`, `@hono/node-server`, `@hono/zod-validator`, `tsx` (dev 実行用)
- `server/index.ts`: Hono app + `serve({fetch, port:47776, hostname:'127.0.0.1'})`
- `server/health.ts`: `/api/health` (env から bootId/projectDir)
- `server/middleware/projectPath.ts`: `validateProjectPath` を Hono 文脈で使うヘルパ
- `server/lib/` は使わず、既存 `src/lib/server/*` をそのまま import (パス alias 維持)
- ビルド形態: server は tsx/esbuild で単一 entry にバンドル (Electron が fork する)
**Check**: `curl 127.0.0.1:47776/api/health` が `app:'openground'`、bootId env 反映。

### Phase 1 — REST route 42本 移植 (グループ並列)

**Goal state**: 42本の非SSE route が Hono で動き、Next 版と同じ入出力。
**Expected behavior**: 各 route を curl で叩くと Next 版と同じ status/body。
**移植単位グループ** (並列):
- A: `project/*` (open, open/pick, rename, archive, restore, delete, tasks, task-image, canvases)
- B: `project/goals*` + `project/milestones*` (goals, goals/plan, goals/run-queue, milestones, milestones/run, milestones/verify)
- C: `run*` (run, run/cancel, run/dismiss, run/dismiss-conflict, run/list, run/resolve-conflict)
- D: `canvas*` + `designs/scaffold` + `screen/lock` + `paste-image`
- E: `projects`, `projects/new`, `settings`, `skills`, `usage`, `update/check`, `folder-info`, `pick-folder`, `observer/*`
- F: `terminal`, `terminal/[id]`, `terminal/[id]/input`, `terminal/[id]/resize` (動的ルート → `/terminal/:id/...`)
**Work**: 各 route handler を `app.get/post('/api/...', zValidator(...), (c) => ...)` に。`NextResponse.json(x)` → `c.json(x)`。`Request` → Hono `c.req`。`src/lib/server/*` の呼び出しは不変。
**Check**: route ごとに curl で Next 版と差分なし。`validateProjectPath` 維持確認。

### Phase 2 — SSE 3本 移植 (Phase 1 と並列可)

**Goal state**: run/events, terminal/[id]/stream, screen/watch が Hono `streamSSE` で動く。
**Expected behavior**: EventSource で接続 → イベントがストリームされる。切断/再接続が現行同等。
**Work**: `import { streamSSE } from 'hono/streaming'`。各 SSE route を `streamSSE(c, async (stream) => {...})` に。`run/events` の replay/再接続コメント挙動を維持。subscribe/emit (globalThis runner) はそのまま。
**Check**: `curl -N 127.0.0.1:47776/api/run/events?since=0` でストリーム継続。

### Phase 3 — フロント Vite + React SPA 化

**Goal state**: `vite` がフロントをビルド/配信。`src/components/*` は無修正で動く。
**Expected behavior**: `npm run dev` で Vite HMR、`http://127.0.0.1:47776` (Hono が Vite 成果物を配信) で UI 表示。
**Work**:
- `vite.config.ts` + `index.html` (layout.tsx の `<head>` 相当、@font-face 化)
- `src/main.tsx`: React root mount (page.tsx の中身をエントリに)
- `src/app/page.tsx` → `src/App.tsx` (ロジック流用、'use client' ディレクティブ削除)
- `next/font` (1) → `@font-face` CSS
- `next/dynamic` (1) → `React.lazy` + `Suspense`
- `next/navigation` (1) → screen route 用の軽量 client routing (or query param)
- `src/app/screen/[projectSlug]/[moduleId]/page.tsx` → Vite のルート (`/screen/:slug/:id`) or 同等の動的描画
- Hono に static 配信: prod は Vite `dist/` を Hono が serve、dev は Vite dev server を Electron が指す
- `@/*` alias を vite.config に移植
**Check**: UI が描画、Canvas / Chats / Terminal / Goals タブ動作、screen iframe 描画。

### Phase 4 — Electron 配線 + Next 撤去

**Goal state**: Electron が Hono entry を fork。next.config / standalone 手当てが消える。
**Expected behavior**: `electron:prod` / packaged `.app` で Hono server fork → window → claude run 動作。
**Work**:
- `electron/main.js`: fork 先を `.next/standalone/server.js` → `server/dist/index.js` (Hono バンドル) に変更。candidate パス整理。
- `package.json`: `output:'standalone'` 削除、`scripts/standalone-assets.js` 削除、`build.files`/`extraResources` を Hono server + Vite dist に。`asarUnpack` は node-pty のみ。
- server バンドル: esbuild で `server/index.ts` → `server/dist/index.js` (node-pty は external)
- `npm run dev` / `electron:dev` を vite + Hono concurrently に
**Check**: packaged `.app` を cold run → 47776 → claude run → node-pty 動作 (PR A で詰まった node_modules 問題が存在しないことを確認)。

### Phase 5 — hc RPC 型安全化 (オプション、後回し可)

**Goal state**: client `fetch('/api...)` 12箇所が `hc` 型付き呼び出しに。
**Work**: `hono/client` の `hc<AppType>` でサーバ型を輸入。`src/lib/types.ts` 契約を活用。
**Check**: tsc で end-to-end 型エラー検出。

### Phase 6 — 検証 + クリーンアップ

**Goal state**: Next 痕跡ゼロ、全テスト green。
**Work**: `next` 依存削除、`next.config.js` / `next-env.d.ts` 削除、eslint-config-next → 汎用、vitest/playwright を Vite 前提に調整。
**Check**: `npm run lint && npx tsc --noEmit && npm test && npm run test:e2e` 全 green。packaged `.app` 実機 QA。

## 5. リスクと対策

| リスク | 対策 |
|---|---|
| SSE 再接続挙動の差異 | Phase 2 で run/events の既存コメント仕様を streamSSE で再現、curl -N で実測 |
| screen 動的ルートの描画 | Phase 3 で iframe ロード経路を維持、Vite ルートで slug/id を渡す |
| node-pty が Hono fork で動くか | spike で ELECTRON_RUN_AS_NODE + node-pty 実証済み。Hono entry は「ただの Node」なので fork 単純 |
| 中間状態でアプリが動かない期間 | feature branch で進め、各 Phase で部分 verify。最後に統合 green |
| vitest が Next import に依存 | Phase 6 で確認、@ alias を vitest.config に維持 (既に対応済み) |
| dogfood ループが止まる | 移行中は現行 OPEN GROUND.app (shell launcher + Next) を温存。Hono 版が green になるまで切り替えない |

## 6. 実装の進め方 (チーム/workflow)

- **Workflow 1**: Phase 0 → {Phase 1, Phase 2 並列} → route 検証
- **Workflow 2**: Phase 3 (フロント Vite 化) → Phase 4 (Electron 配線) → 統合検証
- **Workflow 3**: Phase 5 + 6 (型安全 + クリーンアップ + 最終 QA)
- 各 workflow 完了で CI green を確認、PR 分割 (P0-2 / P3-4 / P5-6) でレビュー可能に
- shell launcher (openground-launch.sh) は全移行完了 + dogfood 安定まで温存
