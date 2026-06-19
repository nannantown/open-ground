# REPORT_FIX — 承認画面ループ修正A（配布版で claude 未ログイン時に run 系が OAuth ブラウザを多重に開く問題）

実装日: 2026-06-19 / branch: `swarm/w3-0619-102622-69418` / **[hold]（マージは承認制）**
調査の正典: `OPEN_GROUND-w3-0619-095342-63923/REPORT.md`（本ファイルは上書きせず別建て）

---

## TL;DR

- **根本原因**: run 系の全ルートが `claudeConnection().installed` **だけ**で gate し `loggedIn` を無視していたため、
  配布版（`installed:true / loggedIn:false` が常態）では run のたびに未ログイン `claude` を spawn し、
  claude 本体が OAuth ブラウザを開いていた。1 回の 実行 が「タスク本体 + 自動タイトル haiku」で **最大 2 spawn**
  に乗算するため「承認画面が無限に開く」体感になっていた。
- **修正方針 A を実装**: 共有プリフライト `claudeRunPreflight()` を `installed && loggedIn` に強化し、未ログインは
  専用フラグ `claudeLoggedOut` で 503。自動ユーティリティ（タイトル/説明/Canvas 生成/スキル生成）は spawn せず、
  明示 run は **多重 spawn せず**「Claude にサインイン」導線 + **単一の対話ログインターミナル 1 つ**へ誘導する。
- **subscription-only は不変**: API キーは一切使わない。唯一、署名済みログインルート
  `POST /api/terminal/claude-login`（`installed` のみ gate）だけが未ログイン claude を spawn でき、
  ユーザーはそこで一度だけ OAuth を完了する。

---

## 変更点（ファイル別）

### サーバ（核 = run 系の gate 強化）

1. **`src/lib/server/claudePreflight.ts`（新規）** — 共有プリフライト。
   `claudeRunPreflight()` は `installed && loggedIn` のときのみ `{ ok: true }`。失敗時は
   `{ ok:false, body: { error, claudeMissing } }`（未インストール）/ `{ … claudeLoggedOut }`（未ログイン）を返し、
   呼び出し側は `c.json(pre.body, 503)`。

2. **`server/routes/terminal.ts`**
   - `POST /api/terminal/claude`（旧 99-102）: `installed` のみ → `claudeRunPreflight()` に置換。
   - `POST /api/terminal/custom-module`（旧 239-242）: 同上。
   - **`POST /api/terminal/claude-login`（新規）**: `validateProjectPath` で cwd を検証し、**`installed` のみ** gate して
     **プレーンな claude（プロンプト無し・appContext:false）**を起動。これが「単一の対話ログインターミナル」。
     `initialPrompt` 無しなので claude はサインイン/入力プロンプトで待機し、`; exit` は claude 終了後にしか発火しない
     → OAuth 往復中にターミナルが閉じない（完了条件 b の前提）。静的ルート群（`/:id` より前）に宣言。

3. **`server/routes/project.ts`**
   - `POST /api/project/describe`（旧 889-892）: `claudeRunPreflight()` に置換。
   - `POST /api/project/task-title`（旧 933-935・fire-and-forget の自動タイトル）: 同上。
   - `POST /api/skills/global/create`（旧 527-530・**当初の対象リスト外だが同一バグクラス**なので合わせて強化）: 同上。
   - 未使用化した `claudeConnection` import を `claudeRunPreflight` import に置換。

4. **`server/routes/canvasAi.ts`**
   - `POST /api/canvas/generate-elements`（旧 54-56）/ `POST /api/canvas/tweak-screen`（旧 112-114）:
     `claudeRunPreflight()` に置換。ヘッダコメントと import を更新。

### クライアント（② 自動ユーティリティ抑止 ＋ ③ 明示 run のサインイン導線）

5. **`src/components/canvas/modules/BoardModule.tsx`**
   - `TaskLaunchResult.reason` に `'claudeLoggedOut'` を追加。
   - `BoardModuleProps` に `claudeLoggedIn?: boolean` と `onClaudeLogin?: () => void` を追加。
   - `launchFailed` の値型を `'claudeMissing' | 'claudeLoggedOut' | 'other'` に拡張。
   - **②**: `runTask` の **fire-and-forget 自動タイトル**呼び出しを `claudeLoggedIn !== false` で条件化
     （未ログイン中は 2 本目の doomed リクエストを投げない。`undefined`＝未確認時はサーバ gate が最終防衛）。
   - **③**: ドロワーの失敗コピーに `claudeLoggedOut` 分岐を追加。`board.run.failedClaudeLoggedOut` を出し、
     **「Claude にサインイン」ボタン**（`onClaudeLogin`）でログインターミナルへ誘導（hover/active/focus-visible 完備）。

6. **`src/components/canvas/ProjectPanel.tsx`**
   - `useClaudeConnection`（既存フック）を `!!project && !project.missing` で有効化し、`claudeNonce` で再チェック可能に。
     `claudeConn.loggedIn` を `BoardModule.claudeLoggedIn` に供給。
   - `launchTaskTerminal` の 503 解釈に `claudeLoggedOut` を追加。
   - **単一ログインターミナル**: `openClaudeLogin`（single-flight + single-instance：他カードの CTA からも同じ 1 本を再フォーカス）/
     `closeClaudeLogin`（PTY を kill ＝サインインは keychain に永続するので安全・`claudeNonce` を bump して接続再チェック）。
     `POST /api/terminal/claude-login` を叩き、`ClaudeTerminalPane` をモーダルで描画（onExit でも再チェック）。
   - `BoardModule` に `claudeLoggedIn` / `onClaudeLogin` を接続。

7. **i18n** — `src/i18n/messages/board.ts`（`board.run.failedClaudeLoggedOut` / `board.run.signIn`・EN/JA）、
   `src/i18n/messages/projectPanel.ts`（`projectPanel.claudeLogin.{title,hint,starting,retry}`・EN/JA）。

### テスト

8. **`server/routes/__tests__/claudeLoginGate.test.ts`（新規・6 件）**
   - `/api/terminal/claude` 未ログイン → 503 `claudeLoggedOut` ＋ **launchClaude 未呼び出し**（spawn しない＝ブラウザが開かない）。
   - 同・ログイン済み → 200 spawn（完了条件 b）。
   - `/api/project/task-title`（force）未ログイン → 503 `claudeLoggedOut` ＋ 未 spawn。
   - `/api/terminal/claude-login` 未ログインでも `installed` なら 200 spawn（プレーン: initialPrompt 無し / appContext:false）。
   - 同・未インストール → 503 `claudeMissing` / 未登録 cwd → 403。
9. **`src/components/canvas/modules/BoardModule.modes.test.tsx`（+2 件）**
   - 未ログイン run → `failedClaudeLoggedOut` コピー表示・「サインイン」ボタンで `onClaudeLogin` 発火・**run は再実行しない**。
   - `claudeLoggedIn=false` 時に **自動タイトル POST が発火しない**（条件 c）。

---

## 完了条件の判定

| # | 条件 | 結果 | 根拠 |
|---|---|---|---|
| a | 未ログインで Board 実行しても OAuth が繰り返し開かない（多くて 1 回の導線） | **true** | run 系が 503 `claudeLoggedOut` で spawn せず（テスト: launchClaude 未呼び出し）。ブラウザは **ユーザーが明示的にサインイン CTA を押したときの単一ログインターミナル**でのみ開く（single-instance）。自動タイトルもクライアント/サーバ二重で抑止 |
| b | サインイン後は同操作で PTY 正常起動・再オープンなし | **true** | `loggedIn:true` で gate 通過（テスト: 「spawns normally once signed in」）。ログインモーダル close / 終了で `claudeNonce` bump → 接続再チェック → 以後の run は静かに通る。relaunch ループ無し |
| c | `loggedIn:false` 間は自動ユーティリティが claude を spawn しない | **true** | describe / task-title / canvas / skill を全て `claudeRunPreflight` で gate（サーバ）＋ fire-and-forget タイトルをクライアントで skip（テスト: taskTitlePost 未発火） |
| d | tsc / lint / test 緑 | **true** | `tsc --noEmit` exit 0 / `eslint` exit 0（警告のみ・既存の `any`/`frameLabel`、新規エラー無し）/ `vitest run` **1625 passed (121 files)** |
| e | REPORT_FIX.md に変更点記載（REPORT.md は上書きせず） | **true** | 本ファイル |

---

## 設計判断・スコープの注記

- **plain dock も gate される**: `EmbeddedClaudeTerminal` / `TerminalDock` は `/api/terminal/claude` を共有するため、
  未ログイン時はドックの「Launch claude」も 503 になり、`NOT_SIGNED_IN_MSG` を表示する（自動サインイン経路は消える）。
  これは ③「単一の対話ログインターミナル 1 つに誘導」の意図どおり ── サインインは Board ドロワーの CTA が開く 1 本に集約する。
  Canvas ドック単独利用時はメッセージ表示に留まる（完了条件外）。
- **`; exit` レース / env 衛生（REPORT 3-4 = 修正方針 B）は本 PR の対象外**。ログインターミナルは
  `initialPrompt` 無し＝ claude が待機するため `; exit` が OAuth 中に発火せず、A の完了条件には影響しない。
  B（PATH 一致 / `ELECTRON_RUN_AS_NODE` 除去 / `; exit` 抑止）は別タスクに残す。
- **subscription-only 不変**: Anthropic API キー経路は新設していない。claude の認証は claude 本体が所有し、
  OPEN GROUND は単に「サインインするための 1 本のターミナル」を起動するだけ。
