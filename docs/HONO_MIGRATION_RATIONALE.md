# OPEN GROUND: Next.js → Vite + React + Hono 移行の根拠

> 他エージェント/開発者向けハンドオフ。今の実装(Next.js)と Hono のやり方を
> 対比し、「なぜ書き換えるべきか」と「着手時に壊してはいけない契約」をまとめる。

## 0. 前提(動かせない制約)

OPEN GROUND は **ローカル単一ユーザーのデスクトップツール**(Electron 同梱)。
バックエンドは **Node 必須** — 中核機能が `node-pty` で `claude` CLI を PTY
駆動することだから。**Electron 採用と Node バックエンドは確定事項**。本件は
その内側、「レンダラ + API 層を Next.js のままにするか、Vite+React+Hono に
するか」の話。

**結論:Vite + React + Hono(+ `hc` クライアント + `@hono/zod-validator`)に
書き換えるべき。** 以下が根拠。

---

## 1. Next.js の看板機能が、このアプリでは全滅している

| Next.js の価値 | OPEN GROUND での該当 |
|---|---|
| SSR / RSC | **不要**(ローカル・SEO無関係・初期描画は localhost で一瞬) |
| ページルーティング | **不要**(UI は `src/app/page.tsx` の 1 ページに全状態が乗る実質 SPA) |
| 画像最適化 / ISR / Edge | **不要** |
| ファイルベース **API** ルーティング(45本) | ✅ 効いている(が Hono でも整理可能) |
| ゼロ設定 dev / HMR | ✅ 効いている(が Vite が同等以上に速い) |

→ **ローカル SPA + API サーバに、フルの SSR Web フレームワークを被せている**。
使っていない機能の重さを払い続けている状態。

## 2. 決定打:Next の standalone トレーサが node-pty と構造的に喧嘩している

これが最大の理由。`next.config.js` には、Next の `output:'standalone'` トレーサ
が **node-pty のネイティブバインディング(`.node`)を追えない**ための手当てが
必要になっている:

```js
output: 'standalone',
experimental: { serverComponentsExternalPackages: ['node-pty'] },
outputFileTracingIncludes: {           // .node を手動で同梱
  './node_modules/node-pty/build/Release/**/*',
  './node_modules/node-pty/prebuilds/**/*',
}
```

さらに `electron/main.js` の `resolveStandaloneServer()` は
`.next/standalone/server.js` を**複数の候補パスから探し回る**ロジックを抱え、
`package.json` の `build.asarUnpack` で node-pty を asar 外に出す手当ても要る。

**これらは全部 Next 固有の摩擦。** Hono サーバは「ただの Node ファイル」なので
Electron から普通に `fork` するだけ。トレーサと戦う必要がなく、node_modules は
そこにある。**アプリの一番の核(node-pty)と、パッケージング機構の喧嘩が
丸ごと消える。**

## 3. 失う心配のあるものは、Hono で全部維持できる

現行の HTTP サーバ設計には**温存すべき本物の利点**が 3 つある。Hono を
**localhost HTTP サーバ**として残せば全部維持される:

1. **Claude×Chrome デバッグ** — 通常 Chrome で `http://127.0.0.1:47776` を開いて
   Claude に操作させるワークフロー。localhost HTTP に配信されている限り
   Next/Hono は無関係 → **維持**
2. **HMR** — `vite dev` がレンダラを配信、Electron がそれを指す(今の
   `electron:dev` と同型) → **維持**
3. **SSE 3系統**(`run/events`・`terminal/[id]/stream`・`screen/watch`)— Hono は
   `streamSSE` で SSE がネイティブの一級市民 → **書き換え不要の思想で移植可能**

> ※ pure IPC(`ipcMain`/`ipcRenderer` 全振り)は上記 1 と 3 を壊すので**採らない**。
> Hono を HTTP サーバとして残すのが要点。

## 4. むしろ型安全は今より良くなる

git 履歴に `zod on every API`(026de2d)とある通り、API ごとに zod を手書きして
いる。Hono なら:

- **`@hono/zod-validator`** → 既存 zod スキーマをそのままルートのバリデータに転用
- **`hc`(Hono RPC クライアント)** → サーバの型をクライアントに輸入 →
  **tRPC ライクな end-to-end 型安全**を別フレームワーク無しで獲得

`fetch('/api/...')`(クライアント 14 箇所)の文字列 URL + 手動型付けが、
型付き RPC 呼び出しに置き換わる。

### なぜ Hono で、tRPC や Express/Fastify ではないのか

- **Express** → 格下げ。コールバック式・型が弱い・SSE 手動・型付きクライアント無し。
- **Fastify** → 横移動〜やや重い。大規模 validated REST 向けで、このアプリには過剰。
- **Elysia** → Bun 前提で真価が出る。Electron は Node を fork するので利点が消える。
- **tRPC** → 単一 TS クライアント向けには魅力的だが、**subscription(ストリーミング)
  が素の SSE より配線が重い**。本アプリは SSE 3 系統が中核なので相殺される。
  → **Hono の `hc` で型安全を取りつつ SSE をネイティブ維持できる方が上**。

---

## 5. 移植マッピング(現行 → Hono)

| 現行(Next.js) | Hono 版 |
|---|---|
| `src/app/api/**/route.ts`(45本) | Hono ルート(`app.get/post(...)`、ファイル分割) |
| Next route handler の `Request`/`Response` | Hono は Fetch API 準拠なのでほぼそのまま移せる |
| zod バリデーション(手書き) | `@hono/zod-validator` |
| SSE(`text/event-stream` 手書き 3箇所) | `streamSSE` ヘルパ |
| クライアント `fetch('/api/...')` ×14 | `hc` RPC クライアント |
| `src/app/page.tsx` + components | Vite + React の SPA(ロジックはほぼ流用) |
| `output:'standalone'` + fork + トレーサ手当て | **不要**(Hono を直接 `fork`) |
| `electron/main.js` の起動シーケンス | **維持**(fork 対象が server.js → Hono entry に変わるだけ) |

---

## 6. 壊してはいけない契約(受け取った側が必ず保つこと)

- **固定ポート 47776 / `127.0.0.1`**(`CLAUDE.md` の単一インスタンス設計の前提)
- **`GET /api/health` の契約**:`{ app:'openground', bootId, port, projectDir,
  startedAt }` を返す。`electron/main.js` の `waitForReady` が prod で `bootId`
  一致を要求する identity probe
- **`validateProjectPath()` のセキュリティ境界**(`projectsRoot` 配下のみ許可)—
  path 受け取り API で必ず維持
- **二ストア構造**:アプリ設定 `~/.openground/` と プロジェクト別
  `<project>/.openground/`(`src/lib/server/paths.ts` ほか)
- **`src/lib/types.ts`** をクライアント/サーバ共通契約として維持
- **レガシー移行 & `OPENGROUND_RESULT:` パーサ**(旧 `HOVE_/PMMAP_` マーカー互換)
- **`globalThis.__openground_runner`** に in-memory ランナー状態を置く方式
  (HMR/再読込跨ぎの生存)

---

## 7. リスクと留意点

- **正直な弱点**:Next の「`route.ts` 置くだけ」の規約魔法は減り、Hono は
  ルートを明示記述。ただし 45 本程度なら整理可能で、得るもの(node-pty 摩擦の
  消滅・軽量化・型安全)が上回る
- **SSE のバックプレッシャ/切断**:現行 `EventSource` の自動再接続挙動
  (`run/events/route.ts` のコメント参照)を Hono `streamSSE` 側でも担保すること
- **`terminal/[id]` の動的ルート**:Hono のパラメータルーティング
  (`/terminal/:id/...`)へ
- **移行は一括 vs 漸進**:`hc` と Hono を導入しつつ、まず SSE 3 系統と node-pty
  経路を移し、残り REST を順次 — が安全
