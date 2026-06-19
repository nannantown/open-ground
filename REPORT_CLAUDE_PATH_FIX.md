# REPORT — 配布版 claude 関連2点の修正（PATH 解決の食い違い ＋ UsageHud の未ログイン spawn）

実装日: 2026-06-19 / branch: `swarm/w3-0619-111726-58198` / **[hold]（マージは承認制）**
調査の正典: `OPEN_GROUND-w3-0619-095342-63923/REPORT.md`（修正方針 B）/ `REPORT_FIX.md`（修正 A）
**本ファイルは別建て** — 既存の `REPORT.md`（配布版ログイン bake）と `REPORT_FIX.md`（修正 A = run 系の loggedIn ゲート）は**上書きしない**（どちらも別セッションのコミット済み成果物）。

---

## TL;DR

1. **修正1 — 配布版で Board カードのタイトル/プロジェクト説明の自動生成が動かない**
   **根本原因**: 接続チェック `claudeConnection`（`zsh -lic` で解決＝`.zshrc` も読む／既知の絶対パスも探す）は `claude` を見つけて
   `installed:true / loggedIn:true` を返す（＝ツールバー indicator も修正 A のプリフライトも通る）。
   ところが**実 spawn は別経路**: `launchClaude → buildClaudeArgv` は **bare `claude`** を PTY に書き込み、PTY は
   `createTerminal` の **`zsh -l`（`-i` 無し＝`.zshrc` を読まない）**（`src/lib/server/terminal.ts:198`）。
   `.zshrc` 経由でしか `claude` が PATH に乗らない／PTY の PATH がログインプロファイルで痩せる配布版では、
   **PTY だけが `claude` を解決できず空振り**し、marker が出ず generateTaskTitle/Description が timeout → `null`（＝何も生成されない）。
   **修正**: `claudeConnection` が検証した `claude` の**絶対パスを保持・公開**し、`launchClaude` がそれを spawn する（修正方針 B の推奨そのもの）。
   PTY シェルの PATH 解決に依存しなくなるため、`.zshrc`-only / PATH ドリフト / `.zshrc` のシェル関数シャドウのいずれにも耐える。

2. **修正2 — UsageHud が 60s ごとに未ログイン claude を spawn して OAuth ブラウザを開く**（修正 A レビューで判明）
   **根本原因**: `GET /api/usage`（`server/routes/misc.ts:266`・UsageHud が 60s ポーリング）→ `fetchClaudeUsageCli()` は
   **ゲート無し**で `ptySpawn(claudeBin, [], …)`（`src/lib/server/claudeUsageCli.ts`）＝引数無しの対話 claude を起動。
   未ログインだと claude 本体がサインイン画面に落ちて OAuth ブラウザを開く（run 系で修正 A が止めたのと同じループ）。
   **修正**: `fetchClaudeUsageCli` を `claudeConnection().loggedIn` でゲートし、未ログイン時は spawn せず `null`（HUD は local-jsonl 推定にフォールバック）。

---

## 1. 原因の特定（file:line）

### 修正1 — PATH 解決の食い違い

| 役割 | コード | シェル / 解決 | `.zshrc` |
|---|---|---|---|
| 接続チェック（indicator・プリフライト） | `claudeConnection`（`src/lib/server/claudeConnection.ts`）→ step1 `execFile('claude')`（PATH 直）／step2 `resolveViaLoginShell`（`src/lib/server/cliResolve.ts:34` = **`zsh -lic`**）／step3 既知絶対パス | `zsh -lic`（対話）＋既知パス | **読む** |
| Electron がサーバへ注入する PATH | `electron/main.js:124`（**`zsh -lic`**）→ `:467` `PATH: enrichedPath` | `zsh -lic` | **読む** |
| **実 spawn（タイトル/説明/Board run/Canvas/skill）** | `launchClaude`（`claudeTerminal.ts`）→ `buildClaudeArgv` が **bare `claude`** → `createTerminal`（`terminal.ts:198` = **`zsh -l`**）の PTY に書き込み | **`zsh -l`（非対話）** | **読まない** |

→ indicator は `zsh -lic`/既知パスで `claude` を見つけ **OK**、しかし PTY は `zsh -l` で **別物/未解決**。
原調査 REPORT（095342）3-4 の「PATH 一致」、REPORT_FIX.md:107 が「修正方針 B として別タスクに残す」とした項目に一致。
**本実機でも裏取り済み**: このマシンの `claude` は `.zshrc` 内のシェル関数（Chrome ランチャ）で、`zsh -l` には存在しない＝
bare `claude` は PATH 頼み。絶対パス化でこの関数シャドウも回避できる（敵対レビューで確認）。

### 修正2 — UsageHud の未ログイン spawn

- `server/routes/misc.ts:266` `GET /api/usage` → `:278` `fetchClaudeUsageCli().catch(() => null)`（**プリフライト無し**）。
- `src/lib/server/claudeUsageCli.ts` `drive()` → `ptySpawn(claudeBin, [], …)`（引数無し対話 claude）。
- `src/components/canvas/UsageHud.tsx:6` `POLL_MS = 60_000`／`:40` で 60s ごとに `/api/usage` を叩く。
- 修正 A は run 系だけをゲートしたため、この usage 経路が**取り残されていた**（同一バグクラス）。

---

## 2. 再現条件

**修正1**: 署名済み配布 `.app` を Finder/Dock 起動（`claude` は CLI **ログイン済み**だが、`claude` が
`.zshrc` 経由でしか PATH に乗らない／ログインプロファイルが PATH を痩せさせる／`.zshrc` のシェル関数）。
→ indicator は緑なのに、カード作成・「説明を生成」・Board run で PTY が `claude: command not found` 相当になり、
タイトル/説明が**黙って生成されない**。dev（対話シェルから `npm run dev`）では PATH が完全なので踏みにくい＝配布版特有。

**修正2**: 配布版・CLI **未ログイン**で UsageHud が表示されている（＝常時）。60s ごとに usage scrape が走り、
未ログイン claude が OAuth ブラウザを開く。修正 A 後も usage 経路だけ残存。

---

## 3. 変更点（ファイル別）

### `src/lib/server/claudeConnection.ts`
- `import { existsSync } from 'fs'`（`:20`）。
- module-level `let resolvedBin`（`:55`）＋ getter **`export const resolvedClaudeBin()`**（`:62`）。
  「最後の probe が検証した `claude` の絶対パス」を返す同期 getter。
- helper `absoluteClaudeOnPath()`（`:99`）: `process.env.PATH` を左→右に走査して最初に存在する `claude`、
  無ければ `knownClaudeLocations()` をフォールバック（同期・シェル不使用）。サーバの PATH は Electron が `zsh -lic` で
  注入した完全版なので、step1 が走らせた `claude` と同じ絶対パスに解決する。
- `claudeConnection()` 本体（`:185`〜`:213`）: auth status に答えた**勝者バイナリ `winner`** を記録（override / step2 / step3 は絶対パス、
  step1 の bare 名は `absoluteClaudeOnPath()` で絶対化）。`resolvedBin = winner ?? (json ? absoluteClaudeOnPath() : null)`。
  **既存の auth 判定ロジック（installed/loggedIn/plan/email）は不変**＝副作用として絶対パスを記録するだけ。

### `src/lib/server/claudeTerminal.ts`
- `import { resolvedClaudeBin } from './claudeConnection'`（`:11`）。
- `buildClaudeArgv` に第4引数 `resolvedBin: string | null = null`（`:159`）。
  バイナリ優先順位 = **`OPENGROUND_CLAUDE_BIN`（override）→ `resolvedBin`（検証済み絶対パス）→ bare `claude`**（`:174`）。
  空文字 override は下段のトゥルース性チェックで bare に戻る（`?? ` ではなく `? :` が要、コメントで明示）。
- `launchClaude` が `buildClaudeArgv(…, resolvedClaudeBin())` を渡す（`:252`）。各 spawn ルートは直前に
  `claudeRunPreflight()`→`claudeConnection()` を通すので `resolvedBin` は新鮮（敵対レビューで全呼び出し元を確認）。

### `src/lib/server/claudeUsageCli.ts`
- `import { claudeConnection } from './claudeConnection'`（`:5`）。
- `fetchClaudeUsageCli()` の inflight 内・`ensureActivityWatcher()` の後・`findClaudeBinary()` の前に
  **`const conn = await claudeConnection(); if (!conn.loggedIn) return null`**（`:243-244`）。
  `claudeConnection` は `claude auth status` を `execFile`（非対話）で叩くだけ＝**ブラウザを開かない**ので、ゲート自体は安全。

### テスト
- `src/lib/server/claudeConnection.test.ts`（+2）: `resolvedClaudeBin()` が検証済み絶対パスを返す／未インストール時は `null`。
- `src/lib/server/claudeTerminal.test.ts`（+3）: `buildClaudeArgv` 第4引数で絶対 argv[0]／override が resolvedBin に勝つ／両方未設定で bare `claude`。既存 seam テスト（空文字→`claude`）は不変。
- `src/lib/server/claudeUsageCli.test.ts`（**新規**・3 件）: 未ログイン/未インストール→**spawn ゼロ**＋`null`／ログイン済み→ゲート通過で spawn 到達。
  `fs`(`existsSync→true`,`watch→no-op`)・`node-pty`・`claudeConnection` をモックし決定的（タイマー無し）。

---

## 4. 完了条件の判定

| # | 条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 修正1 を実装（原因を file:line 特定→再現条件→修正） | **true** | §1.修正1 / §2 / §3。絶対パスを launchClaude に伝播（修正方針 B 推奨） |
| 2 | 修正2 を実装（`fetchClaudeUsageCli` を loggedIn でゲート・未ログイン時 spawn しない） | **true** | `claudeUsageCli.ts:243-244`。テストで spawn ゼロを固定 |
| 3 | tsc 緑 | **true** | `npx tsc --noEmit` exit 0（出力ゼロ） |
| 4 | lint 緑 | **true** | `eslint` 変更ファイル **0 errors**（残1 warning は既存の `stripAnsi` 正規表現・本変更外） |
| 5 | test 緑 | **true** | `npm test`（vitest run）**Test Files 122 passed / Tests 1633 passed**（exit 0・2回連続）。対象3ファイル 40 passed |
| 6 | REPORT に変更点 | **true** | 本ファイル（`REPORT.md`/`REPORT_FIX.md` は上書きせず別建て） |

敵対的レビュー（別エージェント・8観点）: **must-fix ゼロ**。循環 import 無し・E2E/dev 回帰無し・`??` 意味論 OK・
絶対パス選択は auth 共有のため実害無し・ゲート位置とブラウザ非起動を確認。任意ポリッシュ(a)（空文字 override の注記）は採用済み。

---

## 5. 設計判断・スコープ注記

- **subscription-only 不変**: Anthropic API キー経路は新設せず。claude の認証は claude 本体が所有、OG は PTY を起こすだけ。
- **`resolvedBin` が別 claude を掴むリスク**: 複数インストール時に step1 が走らせた claude と別物を選ぶ理論的可能性はあるが、
  auth（keychain/`~/.claude`）はマシン共有で `auth status` も同一回答＝**実害なし**（敵対レビューで OK 判定）。
- **未採用の任意ポリッシュ**: (b) `claudeUsageCli.findClaudeBinary` を `resolvedClaudeBin()`/`knownClaudeLocations` に一本化（**既存の**候補リスト差・本変更の回帰ではない）／(c) `resolvedBin` を `globalThis` 化（常に spawn 直前で再取得されるため装飾的）。**スコープ外**として残す。
- **[hold]**: マージは承認制。本 worker はコミット/マージしない（統合は司令塔）。
