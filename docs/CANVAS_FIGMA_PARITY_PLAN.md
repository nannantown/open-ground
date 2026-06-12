# Canvas Figma-Parity Plan

2026-06-12 開始、同日 Wave 1+2 完了（41/41 ✓）。ゴール: **per-project Canvas タブを Figma の design editor と本質的に同等にする**。
レイアウト（左サイドバー=Pages+Layers / 右サイドバー=Design パネル）、レイヤーパネル UX、
オートレイアウト（⇧A）、Figma 式回転/リサイズ。検証は登録済みテストプロジェクト
`canvas-playground`（registry id `8048e6cf-67d6-435e-b334-cde4a1267dcb`）で 1 挙動ずつ行う。

## Goal State（観測可能な完了条件）

すべて true になったら完了:

- [x] `npm test`（vitest 全件）緑 / `npx tsc --noEmit` 0 error / `npm run lint` 0 error / `npm run test:e2e` 緑
- [x] 下のチェックリスト全項目が、実アプリ（dev:alt + Playwright スクショ）で確認済み

## Expected Behavior チェックリスト

### A. シェル（Figma 丸パクリのドック型 3 ペイン）
- [x] Canvas タブを開くと **左に常設サイドバー**（240px・全高）: 上に **Pages セクション**（= 旧 CanvasTabBar のキャンバス一覧。追加 + / リネーム / 切替 / 削除）、下に **Layers ツリー**（残り高さ全部・スクロール）
- [x] **右に常設サイドバー**（240px・全高）= Design パネル。**未選択時も消えない**（canvas 情報を表示）
- [x] 中央キャンバスは flex-1。ToolPalette は下中央の水平ピル（Figma UI3 風）
- [x] 上部バーに **ズーム % 表示+コントロール**（クリックでメニュー: zoom to fit / 100% 等）
- [x] `⌘\` で両サイドバーをトグル（focus mode）
- [x] Pages のリネーム入力に IME ガード（isComposing）— 既存バグ修正

### B. Layers パネル（使いやすさ = Figma 同等）
- [x] 行ホバー → キャンバス上の該当要素に青アウトライン（hover sync）。逆方向（canvas hover → 行ハイライト）も
- [x] キャンバスで選択 → パネルが**祖先を自動展開してスクロール表示**（reveal）
- [x] ↑/↓ で行移動、⇧+クリック/⇧↑↓ で**範囲選択**、←/→ で折りたたみ/展開
- [x] ドラッグで **コンテナ行の上にドロップ → 中に入る**（行中央バンド + コンテナハイライト。空/折りたたみフレームにも入れられる）
- [x] 検索フィールドで名前フィルタ
- [x] オートレイアウトフレームに方向アイコン（→/↓）表示
- [x] z-nudge（Alt+矢印/ボタン）がネスト時も正しく効く — 既存バグ（行 index vs 配列 index）修正

### C. オートレイアウト エンジン v2
- [x] **主軸 justify**: start / center / end / **space-between** — 「中央にちゃんと均等配置」ができる
- [x] **Hug contents**（フレームが子に合わせて縮む/伸びる）を軸ごとに設定可
- [x] **Fill container**（子がフレームいっぱいに伸びる）を子ごと・軸ごとに設定可
- [x] **per-side padding**（上下左右独立。リンクトグルで一括も）
- [x] hidden の子はスロットを占有しない（Figma 同様詰まる）
- [x] コメントピンはレイアウト対象外
- [x] エンジンは引き続き純粋+冪等（canvasAutoLayout.test.ts の不変条件を維持・拡張）
- [x] **子の順序 = 配列順（z順）に統一**（Figma と同じ「フロー順 = レイヤー順」）。旧ファイルは読み込み時に位置順へ正規化して見た目を変えない

### D. オートレイアウト インタラクション
- [x] レイアウトフレーム内の子をドラッグ → **挿入インジケータ（青バー）+ 兄弟がよける**、ドロップで配列順が変わる
- [x] 外の要素をレイアウトフレームにドラッグイン → 挿入位置に入る / 子をドラッグアウト → フローから抜ける
- [x] レイアウトフレーム上で新規作成/ペースト → フローに挿入される
- [x] フレームをリサイズ中も子が**ライブで再配置**される（pointer-up 待ちしない）
- [x] テキストが伸びたら再フロー（テキスト実測サイズを width/height に保存して footprint を正す）
- [x] ⇧A: 既存挙動維持（フレーム→その場で有効化 / その他→ラップ）+ ⌥⇧A 解除

### E. インスペクタ（Figma Design パネル同等）
- [x] **X / Y 入力欄**（W/H/rotation と並ぶ Figma 配置）
- [x] パネル最上部に**整列ボタン行**（旧 AlignBar を吸収。レイアウト子では非表示=Figma 同様）
- [x] オートレイアウトセクション: 方向トグル + gap + per-side padding 展開 + **3×3 アライングリッド**（justify×align を書く）+ 軸ごと Hug/Fixed ドロップダウン + プレーンフレームに「+ オートレイアウト追加」
- [x] **複数選択でも表示**: 共通フィールドは一括編集、値が違えば「Mixed」プレースホルダ
- [x] NumberInput はキーストロークでなく blur/Enter でクランプ（入力中に値が戦わない）

### F. 回転・リサイズ（Figma 式セレクション）
- [x] **回転ドット廃止**。選択要素の**角の少し外側をホバー → 回転カーソル**（角ごとに向きが変わる曲がり矢印）、ドラッグで中心回転、⇧で15°スナップ、**回転中は角度バッジ**表示
- [x] **リサイズハンドル 8 個**（4隅の□ + 4辺）。回転に追従したカーソル向き。⇧=比率維持 / ⌥=中心から（既存数式 resizeRotatedBR を全ハンドルに一般化）
- [x] リサイズ/選択中に **W×H サイズバッジ**を選択枠の下に表示
- [x] Esc でドラッグ中の回転/リサイズをキャンセル

### G. 検証インフラ
- [x] InfiniteCanvas の要素ラッパに `data-element-id`（e2e セレクタ）
- [x] `e2e/canvas.spec.ts` 新設: ⇧A フロー / 回転カーソル / 8 ハンドルリサイズ / Layers ドラッグ / justify 反映 を実マウスで検証
- [x] dev:alt（隔離 OPENGROUND_HOME）+ Playwright スクショで全チェック項目を目視確認し、このファイルの ✓ を埋める

## 明示的に後回し（このイテレーションではやらない）
wrap / grid オートレイアウト、絶対配置子、gap のピンクハンドル、グラデーション・画像フィル・Effects・Export、
constraints、コンポーネント/インスタンス、per-corner radius、マルチユーザーカーソル、
負の item spacing（normalize の整合ゲートは負 gap ファイルを保護済みだが、UI 解禁は要設計）。

## アーキテクチャ決定

1. **フロー順 = 配列順（z順）**。エンジンは live 位置ソートをやめ配列順でパック。リオーダーは
   ジェスチャ側が挿入 index を計算して配列を splice。レガシー保存は読み込み時に
   「レイアウトフレームの子配列を現在位置順に正規化」して視覚不変。
2. **FrameLayout v2 は全フィールド optional 追加**（省略=旧挙動）。git-shared の前方互換のため
   フィールド削除・再解釈はしない。座標系は world 絶対のまま（変更しない）。
3. 純粋ロジックは src/lib/canvas*.ts + 単体テストに置く既存パターンを厳守。
   InfiniteCanvas へは呼び出しだけ足す。

### FrameLayout v2 契約（全トラック共通・凍結）
```ts
export interface FrameLayout {
  mode: 'row' | 'column'
  gap: number                 // px。justify==='space-between' のときエンジンは無視
  padding: number             // レガシー一括値（per-side 未指定時のフォールバック）
  align: 'start' | 'center' | 'end'                       // 交差軸
  justify?: 'start' | 'center' | 'end' | 'space-between'  // 主軸。省略='start'
  paddingTop?: number; paddingRight?: number
  paddingBottom?: number; paddingLeft?: number             // 省略=padding
  primarySizing?: 'fixed' | 'hug'   // フレーム主軸。省略='fixed'
  counterSizing?: 'fixed' | 'hug'   // フレーム交差軸。省略='fixed'
}
// CanvasElement に追加（レイアウト子のみ意味を持つ）:
//   fillMain?: boolean   // 主軸 Fill container
//   fillCross?: boolean  // 交差軸 Fill container
// フレームが hug の軸では fill 子は fixed 扱い（Figma 同様）
```

## トラック分割（worktree 並列・主担当ファイル重複なし）

| Wave | Track | ブランチ | 主担当ファイル |
|---|---|---|---|
| 1 | T1A engine | swarm/canvas-engine | types.ts(FrameLayout/fill*), canvasAutoLayout.ts+test |
| 1 | T1B selection chrome | swarm/canvas-selection | canvasTransform.ts+test, InfiniteCanvas.tsx（単独所有）, data-element-id |
| 1 | T3 shell | swarm/canvas-shell | CanvasWorkspace.tsx, CanvasTabBar→Pages, ToolPalette, 新 Sidebar |
| 1 | T4 layers | swarm/canvas-layers | LayersPanel.tsx+test, canvasLayerTree.ts+test |
| 1 | T5 inspector | swarm/canvas-inspector | SelectionInspector.tsx+test |
| 2 | T6 autolayout UX | swarm/canvas-al-ux | InfiniteCanvas（挿入インジケータ/drag-in-out/live reflow/text measure） |
| 2 | T7 wiring | swarm/canvas-wiring | hover sync・multi-select inspector gate・reveal・⌘click deep select |
| 2/3 | T8 verify | swarm/canvas-e2e | e2e/canvas.spec.ts + スクショ検証ループ |

クロストラック契約: 上の FrameLayout v2 / `LayersPanel variant="docked"` / `SelectionInspector
variant="docked"` + props は各プロンプトに同文を凍結して渡す。統合は T1A→T1B→T3→T4→T5 の順に
integration ブランチ `feat/canvas-figma-parity` へ。コンフリクトは統合時に解消。各 Wave 終了時に
全テスト+敵対的レビュー+実アプリ検証 → main へ。

## 検証プロトコル（毎 Wave）
1. 各 worktree: `npx vitest run <関連>` + `npx tsc --noEmit` + `npx eslint <touched>`
2. 統合後: `npm test` 全件 + `npm run build` + e2e
3. `OPENGROUND_HOME=$(mktemp -d)/og npm run dev:alt` → Playwright スクリプトで実マウス操作 +
   スクショ → チェックリストに ✓。ユーザーの常用インスタンス(5174/47776)と本物の
   ~/.openground には触れない（canvas-playground はユーザー確認用で、自動検証は隔離 HOME 側に同名プロジェクトを作る）
