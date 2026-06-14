# Board card drawer — content-first compose rework

2026-06-13。対象: `src/components/canvas/modules/BoardModule.tsx` の Board カード詳細ドロワー
（Draft/compose フェーズ）。スクショの画面を「内容ファースト」に作り直す。

## Goal State（観測可能な完了条件）

- [ ] `npm test`（vitest 全件）緑 / `npx tsc --noEmit` 0 / `npm run lint` 0 / e2e（board 系）緑
- [ ] 下のチェックリストを実アプリ（隔離 dev:alt + Playwright スクショ）で確認

## Expected Behavior チェックリスト

1. [ ] compose ドロワーに **タイトル入力欄が無い**（`<input>` ごと撤去。✦自動生成ラベル/再生成ボタンも compose からは消す）
2. [ ] **内容 textarea が最初の主役フィールド**（autoFocus・残り高さいっぱいに grow）
3. [ ] **「画像」セクション / 「＋画像を追加」ボタン / hidden file input が無い**
4. [ ] 内容エリアへの **drag&drop / copy&paste で画像が添付**され、内容のすぐ下に**小さなサムネ列**（×で削除）が出る。別ラベルのセクションは無い
5. [ ] **担当者・依存・期限は折りたたみ「オプション」**の中（既定で閉じ、展開で表示）
6. [ ] 下部の **モデル / effort セレクタ + 実行ボタン**はそのまま。実行は **内容が空でない**ときに押せる（タイトル有無では無い）
7. [ ] **実行 → 内容の1行目から暫定タイトルを生成**（notes は丸ごと保持）→ ターミナルが開き claude が起動して内容が auto-send → 実行後に haiku 整形タイトルがカードに反映
8. [ ] kanban カード・依存チップ・Session ヘッダが**空タイトルでも破綻しない**（既存の `title || (Untitled)` を維持・確認）

## 明示的に後回し
内容テキスト中に画像を「インライン画像として」描画（現状はサムネ列＋プロンプトに絶対パス添付で claude に渡る、既存契約のまま）。複数選択カードの一括 compose。

## アーキ決定（監査 wf_8211ecec を踏まえ）

- **サーバは不変**。`composeTaskPrompt`/`buildTaskPrompt` は title 必須のまま。よって
  クライアントの `runTask` で、title 空なら**内容1行目から暫定タイトルを同期的に生成**して
  payload に積む（state 経由の非同期 patch だと round-trip 競合で空 title 送信の恐れ）。
  `titleAuto:true` を立て、起動後に既存 `task-title`(haiku) パスで整形（5s ポーリングで反映）。
- 新ヘルパー `provisionalTitle(content)` を `src/lib/cardTitle.ts` に追加（first-line を
  MAX_DERIVED_TITLE で clip。**notes は消費しない** = `deriveCardFields` と違い content を保つ）。純粋・単体テスト。
- `fieldsBlock(task, grow)` は Draft と Session で**共有**。タイトル撤去・画像サムネ列化・
  オプション折りたたみは**両モードに適用**（strict な簡素化）。ただし content の autoFocus は
  Draft のみ（Session ではターミナルからフォーカスを奪わない）→ 引数を
  `fieldsBlock(task, { grow, autoFocusContent })` に。
- Draft の二系統（capture box / full fields）を**1系統に統合**（content-first 単一レイアウト）。
  `commitCapture` は撤去（title は実行時生成へ）。`isUntouchedEmpty` は notes/添付で判定済み＝
  content だけのカードは close で消えない。
- **manual ✦ 再生成**は Session ヘッダ（タイトル表示の隣）に小ボタンとして残す（compose からは消える）。
- i18n: `board.run.needsTitle`→内容を促す文言へ、`board.run.hint` 微修正、
  `titleLabel/titlePlaceholder/attachmentsLabel/attachAdd/captureLabel/capturePlaceholder` は
  未参照になったら撤去（EN+JA 両方）。
- e2e `board-drawer.spec.ts`: タイトル前提のアサートを content ベースへ更新。

## 検証
隔離 `OPENGROUND_HOME=$(mktemp -d)/og npm run dev:alt` + Playwright 実マウスで
1〜8 をスクショ確認。常用 5174/47776 と本物 ~/.openground、別セッションの
`text-sizing-base` worktree には触れない。
