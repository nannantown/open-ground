# Ground タブ再設計プロポーザル

> スコープ：ProjectPanel 内の **Ground タブ**（プロジェクト内サブキャンバス）のみ。
> Home（最上位ポートフォリオ）は触らない。
> Ground タブを「クラウドデザイン」=Figma 的にビジュアル UI を扱える面に作り直す。

---

## 1. なぜ作り直すか

現状の Ground タブのキャンバス要素は `text / sticky / frame` の 3 種類のみ。
`ElementView.tsx` を読むと、stickies は `whitespace-pre-wrap` で plain text を出すだけ、
frames は labelled rectangle、text は font-display の単一行表示。
**実物の UI モックを Ground に貼ることが原理的にできない。**

ユーザーがやりたいこと：
- Claude にデザインを作らせる
- それを **本物の UI として** Ground に並べる
- 周りに sticky / text で注釈を入れる
- チャットで「もっとここを締めて」と頼んで再生成

→ "design review surface for an LLM-collab workflow"。
画素エディタは要らない。**表示＋注釈＋再生成** を回せれば十分。

---

## 2. クラウドデザインツールの参照

Figma / FigJam / Penpot / tldraw など、ブラウザで動く design canvas の最大公約数：

| 要素        | Figma | FigJam | OPEN GROUND Ground (現) | OPEN GROUND Ground (新)        |
| ---------- | :---: | :---:  | :---:           | :----------------------: |
| Frame      | ●     | ●      | ●               | ● (維持)                |
| Text       | ●     | ●      | ●               | ● (維持)                |
| Sticky     | -     | ●      | ●               | ● (維持)                |
| Rect/Ellipse/Line | ● | ●  | -               | △ (Phase 4)             |
| **Image**  | **●** | **●** | **-**           | **● (Phase 1)**          |
| **Screen (Live React)** | - | -| **-**     | **● (Phase 2 = 目玉)**   |
| Component / Instance | ● | - | -            | △ (Phase 4)             |
| Auto-layout | ●   | -      | -               | -                       |
| Comments    | ●   | ●      | -               | チャットサイドバーで代替済 |
| Multiplayer | ●   | ●      | -               | スコープ外（ローカル単機） |

OPEN GROUND は **ローカル単機・LLM 駆動** なので multiplayer や複雑な component system は要らない。
代わりに「Claude が生成した React コンポーネントが、そのまま Ground のノードとして置ける」のが他にない強み。

---

## 3. 新しいデータモデル

`CanvasElement` を判別可能ユニオンに変える：

```ts
type CanvasElement =
  | TextElement
  | StickyElement
  | FrameElement
  | ImageElement    // NEW
  | ScreenElement   // NEW

interface Common {
  id: string
  x: number
  y: number
  width: number
  height: number
}

interface TextElement   extends Common { type: 'text';   text: string }
interface StickyElement extends Common { type: 'sticky'; text: string; color?: string }
interface FrameElement  extends Common { type: 'frame';  text: string }

// 画像。クリップボードペースト・ドラッグ＆ドロップで作成。
// asset は `<project>/.openground/grounds/<groundId>-assets/<uuid>.<ext>` に保存。
interface ImageElement extends Common {
  type: 'image'
  /** /api/project/grounds/asset?path=...&groundId=...&assetId=... が返す画像 */
  assetId: string
  /** Source filename, for tooltip / download. */
  filename?: string
  /** Optional caption (出力されない alt 相当)。 */
  alt?: string
}

// React コンポーネントモジュールへの参照。Claude が `<project>/.design/<id>.tsx` に
// 純関数コンポーネントを書く → Ground にこの要素を置く → 画面上にライブ描画される。
interface ScreenElement extends Common {
  type: 'screen'
  /** モジュール ID。実体は src/designs ではなく `<project>/.design/<id>.tsx`
   *  に書く（プロジェクトの一部として版管理されつつ、ランタイムでロード）。 */
  moduleId: string
  /** モジュールに渡す props (JSON シリアライズ可能なもの限定)。 */
  props?: Record<string, unknown>
  /** タブやレイヤーに出すラベル。 */
  label?: string
  /** background frame の枠線 / OS chrome の有無を切替。 */
  chrome?: 'none' | 'browser' | 'phone'
}
```

> 既存の `text/sticky/frame` 要素は破壊変更しない。`type` 判別を増やすだけ。
> 既存 Ground ファイルは互換のまま読める。

---

## 4. レンダリング

`ElementView.tsx` をディスパッチャ化：

```tsx
switch (element.type) {
  case 'text':   return <TextView ... />
  case 'sticky': return <StickyView ... />
  case 'frame':  return <FrameView ... />
  case 'image':  return <ImageView ... />     // NEW
  case 'screen': return <ScreenView ... />    // NEW
}
```

### ImageView
- `<img>` を `width × height` で描画
- 角丸＋うっすら影、選択時のリングは既存と同じ
- 縦横比保持は固定（Phase 1）

### ScreenView
- `next/dynamic(() => import(modulePath), { ssr: false })` で動的ロード
- `<div style={{ width, height, transform: scale(zoom?) }}>` の中に描画
- CSS 隔離: モジュール自身が Tailwind を使う前提（プロジェクトで動くから当然使える）
- スクロール内部化: モジュール側で必要なら overflow を持つ
- props はキャンバスから JSON で渡す

> InfiniteCanvas のズームは外側の `transform: scale()` で済んでいるので、
> ScreenView は自分自身を再スケールしない。ユーザーが Ground をズームすれば、
> 画面モックも同じ係数でズームする（=普通の Figma の挙動）。

---

## 5. アセット保存

画像／React モジュールの置き場：

```
<project>/.openground/grounds/
  <groundId>.json                 # 既存
  <groundId>-assets/              # NEW - その Ground 専用バケット
    <uuid>.png
    <uuid>.jpg
.design/                           # NEW - React デザインモジュール置き場
  <moduleId>.tsx                  # Claude が書き換える対象
  README.md                       # 規約書
```

API:
- `POST /api/project/grounds/asset?path=...&groundId=...` (multipart) → `{ assetId, filename }`
- `GET  /api/project/grounds/asset?path=...&groundId=...&assetId=...`  → 画像 bytes
- `DELETE /api/project/grounds/asset?path=...&groundId=...&assetId=...`

セキュリティ：`path` は `validateProjectPath` を通す（既存と同じ）、`assetId` は UUID v4 のみ許可（パストラバーサル禁止）。

React モジュールは普通に Next.js のソースとして解決される。
`<project>/.design/*.tsx` を `tsconfig.json` の paths に追加してもよいが、
シンプルには **`src/designs/`** に置いて、対象プロジェクト名のサブフォルダで隔離する：
```
src/designs/<projectName>/<moduleId>.tsx
```
これなら Next.js のビルド／HMR がそのまま使える。
（`.design/` 案より起動コストが低い／HMR が効く）

---

## 6. オーサリング体験（一番大事）

Ground タブの右上にツールパレットを増やす：

- 既存: Select / Text / Sticky / Frame
- 追加: **Image** / **Screen**

**Image ツール**
- クリック / ドラッグでアップロード zone を出す
- クリップボードペースト (`Cmd+V`) も対応 (画像 MIME 自動判別)

**Screen ツール**
- クリック → 「新しい画面モックを作る」モーダル
  - 画面名（例: "Home", "Chats", "Terminal"）
  - 幅×高さ (preset: 1440×900 / 1280×800 / 390×844)
  - chrome (none / browser / phone)
- 確定 → `src/designs/<projectName>/<id>.tsx` にスケルトンを書き出す
- Ground にプレースホルダー Screen 要素を追加 → モジュール解決後にライブ描画

**チャットからの生成**
- サイドバーのチャットで Claude に「Home 画面の最初のデザイン作って」と頼む
- Claude は `Write` ツールでモジュールを書き、`POST /api/project/grounds`（または専用 API）で Screen 要素を追加
- Ground 上にすぐ現れる

これが OPEN GROUND ならではの「LLM × クラウドデザイン」な核。

---

## 7. 実装フェーズ

| Phase | 内容                                                       | 完了の見え方                      |
| ----- | --------------------------------------------------------- | ---------------------------------- |
| **1** | データモデル分岐化 / `ImageElement` / アセット API / ImageView / クリップボード貼付 / ツールパレットに Image 追加 | スクショを Ground に貼って並べてレビューできる |
| **2** | `ScreenElement` / 動的 import で React モジュール描画 / Screen ツール / モジュールスケルトン書き出し API | 「Home 画面モック」がライブ React として Ground に出る |
| **3** | チャットから Claude が Screen を生成・差し替えるフロー / プロンプト整備 | チャット 1 つで OPEN GROUND の全画面モックが Ground に並ぶ |
| **4** | rect / ellipse / line / 矢印 / レイヤーパネル / 整列ガイド  | 普通の design tool として使える       |

ユーザーが今日言っている「実物のデザインを Ground でレビューしたい」は **Phase 1 + Phase 2 まで** で達成。
Phase 3 は数日で乗せられる強化。Phase 4 は欲しくなったときに。

---

## 8. 既存仕様で残すもの / 変えないもの

- `.openground/grounds/<id>.json` ファイル形式は **そのまま**（`elements: CanvasElement[]` の中身が増えるだけ）
- Ground タブの構造（Tab Bar / Chat Sidebar / Canvas）は **変えない**
- ProjectPanel の他タブ（Chats / Terminal / Overview）も **変えない**
- Home（最上位ポートフォリオ Ground、`src/app/page.tsx`）は **変えない**
- `text / sticky / frame` の表示と編集挙動も **そのまま**

→ 既存ユーザーの Ground は壊れない。新しいタイプの要素が追加で配置できるようになるだけ。

---

## 9. 開いている論点（次のターン用）

Phase 1 (Image) は迷う余地がないので即着手可能。
Phase 2 (Screen=ライブ React 描画) には選択肢が 1 つ残る：

- **A. `src/designs/<projectName>/*.tsx` 案**（推奨）
  - HMR が効く / Next.js の解決そのまま / ビルド時に確認できる
  - 弱点: モジュールはアプリケーションコードの一部として版管理される（= リポに混ざる）
- **B. プロジェクト直下 `.design/*.tsx` 案**
  - 対象プロジェクトのリポ内に閉じる / プロジェクトごとに独立
  - 弱点: 動的ランタイムコンパイルが要る（esbuild / SWC をサーバ側で走らせる）→ 重い
- **C. プロジェクト直下 `.design/*.html` 案**
  - HTML を `iframe srcdoc` で表示 / コンパイル不要 / 簡単
  - 弱点: React / Tailwind の設計トークンが直接使えない、見た目を本物の OPEN GROUND に揃えにくい

OPEN GROUND 自身の 5 画面をレビューする用途では **A** が一番自然。
ただし「対象プロジェクトのデザインを Ground に貼る」用途では **A** は使えない（外部プロジェクトの src には書けない）。
両立するなら **A を OPEN GROUND 内部用、B / C を将来のプロジェクト横断用** にハイブリッドできる。

---

## 10. 最初のスプリント（提案）

`Phase 1 + Phase 2 (A 案)` を 1 スプリントで実装。

具体的な変更ファイル（予測）：
- `src/lib/types.ts` — CanvasElement をユニオン化、ImageElement / ScreenElement 追加
- `src/components/canvas/ElementView.tsx` — ディスパッチャ化
- `src/components/canvas/ImageView.tsx` — NEW
- `src/components/canvas/ScreenView.tsx` — NEW
- `src/components/canvas/ToolPalette.tsx` — Image / Screen ツール追加
- `src/components/canvas/InfiniteCanvas.tsx` — Image/Screen 作成ハンドラ、貼付、リサイズ
- `src/app/api/project/grounds/asset/route.ts` — NEW
- `src/lib/server/groundData.ts` — アセット読み書き、削除時の cascade
- `src/designs/hove/home.tsx`, `.../chats.tsx`, `.../terminal.tsx`, `.../ground.tsx`, `.../overview.tsx` — 5 画面モック（ライブ描画される）

完了したときに見える状態：
- OPEN GROUND プロジェクトの Ground タブを開くと、5 つのスクリーンモックが横一列にライブ React として描画される
- 各モックの隣／上に sticky で注釈
- チャットで「ここ直して」と Claude に頼めばモジュールが書き換わり、ライブで反映

---

これでよさそうなら、Phase 1 から着手します。
