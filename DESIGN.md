# OPEN GROUND 画面デザインデータ

OPEN GROUND の主要 5 画面を、現状の実装ベースで設計データとしてまとめたもの。
リネーム議論や UI 改修の出発点として使う「いま何があるか」のスナップショット。

凡例：
- **役割** — その画面の存在意義（一言）
- **構成要素** — 画面上で目に見える主要パーツ
- **状態** — その画面が持つ／表示する状態
- **インタラクション** — ユーザーができる主要操作
- **データソース** — 何を／どこから読み書きしているか
- **実装ファイル** — 主担当コンポーネント

---

## 1. Home（ポートフォリオ Ground）

OPEN GROUND を起動して最初に見える、全プロジェクトを俯瞰する無限キャンバス画面。
"Ground" という言葉は本来この画面（=最初のポートフォリオ画面）を指す。

### 役割
- 自分が抱えている全プロジェクトを **カード一覧** として俯瞰する。
- 各カードは「そのプロジェクトの最新ラン結果」をヒーローとして語る。
- 新規プロジェクト作成・設定・Jump パレット・Claude 使用量 HUD のハブ。

### レイアウト

```
┌─────────────────────────────────────────────────────────────┐
│  [Logo]                                  [Usage HUD] [Tools] │  ← Toolbar（右上）
│                                                              │
│                                                              │
│         ┌──────┐    ┌──────┐                                 │
│         │ Proj │    │ Proj │     ← ProjectCard（自由配置）   │
│         │ Card │    │ Card │                                 │
│         └──────┘    └──────┘                                 │
│                                                              │
│            ┌─ Frame ─────────────┐                           │
│            │  ┌──────┐  ┌──────┐ │   ← Frame でグルーピング  │
│            │  │ Card │  │ Card │ │                           │
│            │  └──────┘  └──────┘ │                           │
│            └─────────────────────┘                           │
│                                                              │
│  [Tool Palette]                                              │  ← 左下
└─────────────────────────────────────────────────────────────┘
```

### 構成要素
- **InfiniteCanvas** — パン／ズーム可能な無限キャンバス本体
- **ProjectCard** — プロジェクト 1 件分のカード（256 × 132 固定）
  - 名前 / 説明 or 最新ラン要約 / タスク数 / git ブランチ / Run ステータスバッジ
  - 「ヒーロー切替」: 最新ラン要約 ↔ 説明（カードごとに localStorage で記憶）
- **Frame** — カードを囲んでカテゴリ分けする枠（ラベル付き）
- **CanvasElement** — Sticky / Text / 図形などのフリーパーツ
- **Toolbar**（右上）— Refresh / New Project / Settings / Show Archived 切替
- **UsageHud**（右上、Toolbar の左）— Claude プランと使用率
- **ToolPalette**（左下）— Select / Text / Sticky / Frame
- **EmptyState** — `projectsRoot` 未設定 or プロジェクト 0 件時に被さる
- **NewProjectModal / SettingsPanel / ProjectJumpPalette** — モーダル類

### 状態
- `projects: ProjectMeta[]` — `~/projects` 配下のスキャン結果
- `canvas: { positions, viewport, elements }` — `~/.openground/canvas.json`
- `selectedIds: string[]` — マルチ選択
- `tool: 'select' | 'text' | 'sticky' | 'frame'`
- `editingId`, `showArchived`, `refreshing`
- `runs`（useRuns）— 全プロジェクトのライブラン状況

### インタラクション
- ドラッグでカード移動 / マーキー選択 / パン
- ホイール／ピンチでズーム（0.25× 〜 2×）
- カードクリックで右側に **ProjectPanel** が全面展開（= プロジェクト詳細へ遷移）
- ショートカット
  - `V / T / S / F` — ツール切替（typing 中は無効）
  - `N` — New Project
  - `⌘K` — Jump パレット
  - `⌘Z / ⌘⇧Z` — Undo / Redo（履歴は canvas に限る）
  - `⌘D` — 選択要素を複製（カードは複製不可）
  - `⌘A` — 全選択
  - `Enter` — 単一選択を編集モードに
  - 矢印 — 1px ナッジ（`Shift` で 10px）
  - `Esc` — 選択解除

### データソース
- 読み: `/api/projects` → settings + projects + canvas state
- 書き: `/api/canvas`（位置・viewport・elements を debounce 400ms 保存）
- ラン: `/api/run/events`（SSE）から `useRuns` 経由でカードに反映

### 実装ファイル
- `src/app/page.tsx`
- `src/components/canvas/InfiniteCanvas.tsx`
- `src/components/canvas/ProjectCard.tsx`
- `src/components/canvas/Toolbar.tsx` / `ToolPalette.tsx`
- `src/components/canvas/EmptyState.tsx`
- `src/components/canvas/UsageHud.tsx`

---

## 2. Project Panel — タブ構造（共通シェル）

カードをクリックすると `position: fixed inset-0` で被さる全面画面。
内部は 4 タブ（**Chats / Terminal / Canvas / Overview**）に分岐。

### 共通ヘッダ

```
┌─────────────────────────────────────────────────────────────┐
│ ← Home に戻る                            [Usage HUD] [···] [×]│
│ ProjectName                                                  │
│ プロジェクトの説明…                                            │
├─────────────────────────────────────────────────────────────┤
│ ✓ Chats   > Terminal   ◇ Canvas   ⓘ Overview         [Restart]│  ← ViewTabs
├─────────────────────────────────────────────────────────────┤
│                                                              │
│                   （タブごとの本体）                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

- 戻るリンク `← Home に戻る` で Home（ポートフォリオ Ground）へ
- タイトルは `EditableTitle`（インラインリネーム）
- 説明文は `EditableText`（インライン編集）
- 右上: UsageHud / MoreMenu（Archive・Restore・Delete）/ Close
- タブは **ViewTabs**: 4 つを `Ctrl+Tab` / `Ctrl+Shift+Tab` で循環
- アクティブタブは bottom-border が `border-accent` で残り 3 と差別化

### 命名上の論点（メモ）
- 最上位の Home は CONCEPT 上 "Ground" と呼ぶ（ポートフォリオ画面）。プロジェクト詳細のサブキャンバスタブは "Canvas" にリネーム済み（旧 Ground 同名衝突を解消）。
- "Chats" タブは過去は "Tasks" だった名残。中身は「タスクごとの会話スレッド」。

実装: `src/components/canvas/ProjectPanel.tsx` の `ProjectPanel` / `ViewTabs`

---

## 3. Chats タブ（旧 Tasks）

プロジェクト内の "タスク = チャットスレッド" を一覧 + 右側で会話する画面。
ChatGPT パターン（左サイドバーにスレッド一覧 / 右ペインに本文）。

### レイアウト

```
┌──────────────────────┬───────────────────────────────────┐
│ [+ New chat]         │  Chat thread       [Run badge]    │
│ ─────────────        │                                   │
│ TASKS                │  ┌──────────────────┐ user        │
│ ▢ デザインを直す       │  │ 直してほしいです   │             │
│ ▢ API を分離          │  └──────────────────┘             │
│ ▢ ✓ ロゴ差し替え       │                                   │
│                      │  ┌──────────────────┐ Claude      │
│ NOTES                │  │ 完了 · 1m23s     │             │
│ ─────────────        │  │ summary...       │             │
│ メモ書き             │  │ ✓ やったこと…     │             │
│                      │  └──────────────────┘             │
│ │ resize             │                                   │
│ │ handle             │  ┌─ Composer ──────────────────┐ │
│ │ (drag)             │  │ 続きを書く…              [▶] │ │
│                      │  │ [📎images] [auto] [plan]    │ │
│                      │  └─────────────────────────────┘ │
└──────────────────────┴───────────────────────────────────┘
       fsSidebarWidth                  main (chatScrollRef)
```

### 構成要素
- **左サイドバー**
  - `TasksSection` — タスク一覧。状態（done / live / queued）バッジ付き
  - `+ New chat` ボタン — 選択を解除して右ペインを空 composer に
  - `NotesSection` — プロジェクト全体のフリーメモ
  - リサイズハンドル（280–720px、ダブルクリックで 400 にリセット）
- **右メイン**
  - 選択中: `TaskThread variant="pane"`
    - 過去ラウンド一覧（`RoundView` の縦並び）— user バブル + Claude カード
    - Claude カード: ステータス / elapsed / auto N/N / plan モード表示
    - summary / blockers / 「やったこと」リスト / 質問待ちブロック（`pr.question`）
    - 「ログを開く」「キャンバスに貼る」フッタ
    - Composer: テキスト + 画像ペースト + auto toggle + plan toggle + Send
  - 未選択: `NewTaskComposer` — タイトル＋画像で新規チャット作成 → 即 Run

### 状態
- `data: ProjectData`（`<project>/.openground/tasks.json`）— description / tasks / notes
- `selectedTaskId: string | null`
- `taskDrafts: Record<taskId, ComposerDraft>` — チャットを跨いでも下書き保持
- `fsSidebarWidth` — localStorage `openground.fsSidebarWidth`
- `taskRuns: Map<taskId, RunSession>` / `allTaskRuns` — 各タスクの実行履歴

### インタラクション
- タスククリック → スレッド表示、最下部にスクロール
- 新規作成 → 即 Run（送信が "Run" の意思とみなす）
- 画像クリップボードペースト → 一時保存 → 送信時に instruction にパスを追加
- `auto` モード: 結果に応じて自動で次ラウンド（最大 `AUTO_MAX_ROUNDS`）
- `plan` モード: ファイル編集禁止モードで起動
- ログ展開 / キャンバス貼り付け（Canvas タブから渡された場合のみ）

### データソース
- 読み: `/api/project?path=...`
- 書き: `/api/project?path=...`（PUT、debounce 350ms）
- ラン: `useRuns.runTask()` → `/api/run` で `claude -p` 起動 → SSE で逐次反映

### 実装ファイル
- `src/components/canvas/ProjectPanel.tsx`（`TasksSection`, `TaskThread`, `RoundView`, `NewTaskComposer`）

---

## 4. Terminal タブ

プロジェクトディレクトリで動く対話シェル。
複数のターミナルを "スロット" として並行管理できる。

### レイアウト

```
┌──────────┬─────────────────────────────────────────────────┐
│ ▣ Term 1 │                                                 │
│ ▢ Term 2 │  ~ % ls                                         │
│ ▢ Term 3 │  CLAUDE.md  README.md  src/                     │
│ + Add    │  ~ %                                            │
│          │                                                 │
│          │                                                 │
│          │              （xterm.js キャンバス）              │
│          │                                                 │
└──────────┴─────────────────────────────────────────────────┘
   TerminalSlotSidebar               TerminalPane
```

ヘッダのタブには `zsh · 163×44` のような **シェル名×サイズ** が出る。
右端に **Restart** リンクで PTY を強制再起動。

### 構成要素
- **TerminalSlotSidebar** — 左の薄いスロット一覧（Add / Activate / Close）
- **TerminalPane** — xterm.js + `node-pty` バックエンド
  - シェル: ユーザーの `$SHELL`（多くは zsh）
  - `cwd` = プロジェクトパス
  - サイズはコンテナにフィット（fit-addon）
- **接続インジケータ** — 切断時の再接続 UI
- **Restart 行動** — 旧 PTY を kill → 新規セッションを起動

### 状態
- `terminalSlots: TerminalSlot[]` — localStorage `openground.terminal.slots.<path>`
- `activeTerminalSlot: string`
- スロット → PTY id のマッピングは `openground.terminal.session.<path>.<slotId>`
- `terminalInfo: { shell, cols, rows, exitCode? }` — タブ表示用

### インタラクション
- 普通のシェルとして動く（コピー / ペースト / Ctrl-C 等）
- スロット追加 → 新規 PTY を独立起動
- スロット閉じる → サーバに `DELETE /api/terminal/<id>` → localStorage キー破棄
- 最後のスロットは閉じても自動的に `default` スロットが再生成される
- パネルを閉じて開き直しても PTY セッションは保持される

### データソース
- `/api/terminal`（PTY 生成）
- `/api/terminal/<id>/sse`（入出力ストリーム）
- `/api/terminal/<id>` DELETE（破棄）

### 実装ファイル
- `src/components/canvas/TerminalPane.tsx`
- `TerminalSlotSidebar`（同 `ProjectPanel.tsx` 内）
- サーバ: `src/app/api/terminal/`（node-pty 連携）

---

## 5. Canvas タブ（プロジェクト内サブキャンバス）

プロジェクト「内」の Canvas 群。プロジェクトごとに複数の Canvas を持てる
（design / sns / roadmap … といった用途別キャンバスを想定）。
**Home の "Ground"（ポートフォリオ画面）とは別概念で、こちらは
"プロジェクト 1 件分のサブキャンバス"。**

### レイアウト

```
┌─────────────────────────────────────────────────────────────┐
│ [Canvas A] [Canvas B] [Canvas C] [+]    ← CanvasTabBar       │
├──────────────────────┬──────────────────────────────────────┤
│ Chats on this canvas │                                       │
│ ─────────────        │                                       │
│ ▢ Chat #1            │      （無限キャンバス本体）            │
│ ▢ Chat #2            │                                       │
│ + 新規               │      Sticky / Frame / Text / 画像       │
│                      │                                       │
│ ─ active chat ─      │  [Tool Palette]                       │
│ messages...          │                                       │
│ [composer]           │                                       │
└──────────────────────┴──────────────────────────────────────┘
   CanvasChatSidebar          InfiniteCanvas (Canvas 専用)
```

### 構成要素
- **CanvasTabBar** — Chrome 風タブストリップで Canvas を切替
- **CanvasChatSidebar** — その Canvas 内に紐づくチャット一覧 + 選択中スレッド
  - Chats タブの `TaskThread` を `enableSkillPicker` 付きで再利用
  - 各ラウンドに **「キャンバスに貼る」** が出る → Sticky として配置
  - Comment ピンを Claude に飛ばすと anchor 付きの新規チャットになる
- **InfiniteCanvas** — Home と同じコンポーネント（Canvas のレンジで使用）
- **ToolPalette** — Home + Mock + Comment（embedded variant）

### 状態
- `canvases: CanvasSummary[]` — `.openground/canvases-index.json`
- `activeId: string | null`
- `active: CanvasFile`（チャットの並び・要素・viewport）
- ローカル: `tool`, `selectedIds`, `editingId`（Canvas 切替で初期化）

### インタラクション
- Canvas 追加・リネーム・削除・並べ替え（Tab バー上）
- チャット → 通常の Claude 実行（Chats タブと同じ runner、`canvasContext` 付き）
- ラウンドのメッセージを Sticky としてキャンバスにペースト
- Claude が `CANVAS_ADD: {...}` マーカーを出すと自動で要素追加（observer 経由）
- キャンバスの編集（Sticky / Frame / Text / Mock / Comment）
- パン / ズーム / マルチ選択（Home と同等）

### データソース
- 一覧: `/api/project/canvases?path=...`
- 個別: `/api/project/canvases?path=...&id=...`
- 書き込み: 同 endpoint への POST（debounce 400ms、unmount 時に sync flush）
- ラン: 親 `ProjectPanel` から渡された `taskRuns` / `runTask` を共有

### 実装ファイル
- `src/components/canvas/ProjectCanvas.tsx`
- `src/components/canvas/CanvasWorkspace.tsx`
- `src/components/canvas/CanvasTabBar.tsx`
- `src/components/canvas/CanvasChatSidebar.tsx`
- `src/components/canvas/SkillPicker.tsx`

---

## 6. Overview タブ

プロジェクトの「現状ダッシュボード」。中身はメタ情報・統計・直近のアクティビティ。

### レイアウト（現状）

```
┌─────────────────────────────────────────────────────────────┐
│  Overview                                                    │
│                                                              │
│  Path:  /Users/.../foo                  Branch: main         │
│  Tasks: 12 open · 34 done               Last run: 2h ago     │
│                                                              │
│  ── Recent runs ───────────────────────                      │
│  ✓ Task A     2h ago   1m23s                                 │
│  ✗ Task B     5h ago   45s                                   │
│  ...                                                          │
└─────────────────────────────────────────────────────────────┘
```

### 役割
- そのプロジェクトの **状態** を一面で把握する。
- Chats / Terminal / Canvas は "操作" タブ、Overview は "観測" タブ。

### 構成要素
- メタ情報行: パス / git ブランチ / 説明 / アーカイブ可否
- カウンタ: open / done タスク数、最終ラン時刻
- 直近ラン一覧（task名・状態・elapsed・summary 抜粋）
- ※ 現状の `OverviewView` は最小実装。今後拡張余地：
  - milestones / blockers / git status / グラフ など

### データソース
- Chats タブと同じ `ProjectData`
- `taskRuns` から「最終ラン」サマリ

### 実装ファイル
- `src/components/canvas/ProjectPanel.tsx` の `OverviewView`

---

## 横断するデザイントークン（現状）

`tailwind.config.ts` / `globals.css` に定義されているテーマ。

- 色
  - `bg`, `bg-card`, `bg-inset`
  - `ink`, `ink-muted`, `ink-subtle`, `ink-faint`
  - `accent`（操作系強調 / リンク色）
  - `azure`（情報 / 質問待ち）
  - `moss`（成功・done）
  - `ochre`（警告・コンフリクト）
- 罫線: `line`, `line-soft`, `rule-double`
- タイポ
  - `font-display`（見出し用セリフ）
  - `label-cap`（極小オールキャップス・トラッキング広め）
  - 本文は sans / 数値は `tabular-nums`
- 影: `shadow-card`, `shadow-card-hover`
- 角丸: 全体に小さめ（2 〜 6px）

---

## 用語の整理（議論用に明記）

| 表記         | 指すもの                                          |
| ----------- | ------------------------------------------------ |
| Ground（Home） | 最初のポートフォリオ画面。全プロジェクトのカードキャンバス。 |
| ProjectPanel | プロジェクト 1 件分の全面詳細画面。                     |
| Chats タブ    | プロジェクト内のチャット（タスク）スレッド一覧 + 会話。       |
| Terminal タブ | プロジェクト内の対話シェル（複数スロット）。               |
| Canvas タブ   | プロジェクト内のサブキャンバス（複数 Canvas 切替可）。       |
| Overview タブ | プロジェクトのメタ情報ダッシュボード。                   |

> 旧版では ProjectPanel 内のタブも "Ground" と呼ばれており、Home の "Ground"
> （ポートフォリオ画面）と同名衝突していたが、現実装は ProjectPanel 内の
> サブキャンバスを "Canvas タブ" にリネーム済み。
