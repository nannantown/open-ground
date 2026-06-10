# Assistant Dock — チャットタブ廃止 / 常駐アシスタントへの転換

> ブランチ: `feat/assistant-dock`（worktree: `../og-assistant-dock-wt`、origin/main 起点）
> 元に戻すには: `git worktree remove ../og-assistant-dock-wt` + `git branch -D feat/assistant-dock`

## 1. ねらい（Goal State）

「別々のスレッドが並ぶチャット」という旧式の管理画面 UI を捨て、**プロジェクトごとに
一人の常駐アシスタント（秘書）** がいる体験へ転換する。ユーザーは画面を自分で操作する
のではなく、画面最下部に常駐するアシスタントに**オーダーする**と、アシスタントが
デザイン（Canvas）操作・タスク（Board）整理・コード作業を代行する。

### 観測可能な完了条件（Expected Behavior）

- [ ] **G1**: プロジェクトを開くと、どのタブ（Board / Canvas / Terminal）にいても
  画面最下部に**アシスタント・ドック**が常駐している。
- [ ] **G2**: ドックは**ミニマイズ（細いバー）⇄ 展開（会話＋入力）**を切り替えられる。
  状態は localStorage に永続。
- [ ] **G3**: 入力して送ると、**1 本の連続した会話**として履歴に積み上がる
  （別スレッドが増えない）。次の送信は前回の claude セッションを resume し、
  文脈が累積する＝「前のことを覚えている」。
- [ ] **G4**: 旧 **Chats タブが消える**（moduleRegistry から `tasks` を除去）。
  既存の `kind:'chat'` データは削除しない（履歴として参照可能・revertable）。
- [ ] **G5**: Canvas タブの**サイドパネルチャットが消える**。Canvas を開いた状態で
  ドックに依頼すると、`CANVAS_ADD:` / `CANVAS_UPDATE:` 経由で要素が即時反映される
  （= ドックが canvasContext を自動付与）。
- [ ] **G6**: Board タブで、ドックに「〜を整理して」と頼むと、アシスタントが
  `BOARD_ADD:` マーカーで Board にカードを起こし、ビジュアライズされる
  （手入力は副次手段として残す）。
- [ ] **G7**: `npm run build` / `tsc` / `npm run lint` / `npm test` がすべて緑。
- [ ] **G8**: 日本語 IME 入力が壊れない（変換確定 Enter を奪わない・変換中に値を凍結）。

## 2. 設計判断（ユーザー合意済み）

- **会話モデル**: プロジェクト単位の単一会話に統合。実装上、各プロジェクトに
  **ちょうど 1 つの `kind:'assistant'` の ProjectTask**（固定 id `assistant`）を持たせ、
  その `agentSessionId` を毎回 resume する。`allTaskRuns.get('assistant')` が会話の
  全タイムライン。claude セッションは技術的に連結できないので「過去の別チャットは
  履歴として閲覧可、これからの会話は 1 本」が正直な実装。
- **ドック範囲**: プロジェクト全体に常駐（タブ横断）。
- **スコープ**: ①ドック基盤 ②Canvas 統合 ③Board 統合 を全部やる。

## 3. アーキテクチャ

### 既存機構の再利用（重要）
- 単一会話 = 1 タスクを resume し続ける。`useRuns.runTask(project, task, {resumeFrom})`
  が既にある。`allTaskRuns` が履歴、SSE が live。**新しい runner は不要**。
- Canvas 反映 = 既存 `CANVAS_ADD:` / `CANVAS_UPDATE:` マーカー + observer。
  ドックは「Canvas タブが active なら canvasContext を付ける」だけ。
- Board 反映 = `CANVAS_ADD:` と同型の **新マーカー `BOARD_ADD:`** を observer に追加。

### 変更マップ
| レイヤ | ファイル | 変更 |
|---|---|---|
| 型 | `src/lib/types.ts` | `ProjectTask.kind` に `'assistant'` 追加。ヘルパ `ASSISTANT_TASK_ID` |
| データ | `src/lib/server/projectData.ts` | `ensureAssistantTask()`（無ければ作る、既存 chat は消さない） |
| ドック | `src/components/canvas/AssistantDock.tsx`（新規） | 最下部常駐・min/expand・会話・IME 安全 composer |
| マウント | `src/components/canvas/ProjectPanel.tsx` | ドックをパネル全体の最下部に常駐。Chats 描画分岐を撤去 |
| タブ | `src/components/canvas/moduleRegistry.tsx` | `tasks`(Chats) を MODULES から除去 |
| 既定タブ | `src/lib/persistView.ts` ほか | 既定 view を board/terminal に |
| Canvas | `ProjectCanvas.tsx` / `CanvasWorkspace.tsx` / `CanvasChatSidebar.tsx` | サイドバー撤去。canvasContext をドックへ橋渡し |
| Board | `server/lib observer` + `BoardTab.tsx` | `BOARD_ADD:` パース→タスク追加。手入力は残す |
| runner | `server/routes/run.ts` | `BOARD_ADD:` の briefing を Board active 時に付与 |

## 4. フェーズ（各フェーズ末で build/lint/tsc/test 緑 + commit）

- **P1 基盤**: 型 + ensureAssistantTask + AssistantDock + ProjectPanel マウント +
  Chats タブ撤去 + 既定タブ調整。→ G1–G4, G7, G8。
- **P2 Canvas**: サイドバー撤去 + ドックの canvasContext 自動付与。→ G5。
- **P3 Board**: `BOARD_ADD:` マーカー + briefing + observer。→ G6。
- **P4 仕上げ**: 敵対的レビュー・e2e スモーク・残課題整理。

## 5. ガードレール
- subscription-only（API key 禁止）。`.openground/` は編集禁止のままユーザーに伝える。
- 他で動いている `feat/i18n-english-main` の作業ツリーには触らない（この worktree で完結）。
- `git stash` 禁止。各フェーズで commit。
- 既存データ（chat タスク）は破壊しない＝いつでも戻せる。
