# CODE MAP — 領域→入口→テスト→落とし穴の索引

**読者**: worker・起票調査(補給官)・新セッション。CLAUDE.md(全体像と経緯)の次にこれを読み、
探索(コード理解の買い直し)を省いて現物に直行する。個別機構の正典は各ファイル・各 docs で、
本書は「どこを開くか」だけを1枚に持つ。**行番号は書かない**(すぐ古びる)— ファイル名で引く。
プロダクト思想は `CONCEPT.md`、swarm 運用・診断は `docs/commander/00-INDEX.md` が正典。

**鮮度ルール**: 構造変更(ファイル追加/移動/責務変更)を含むカードは、本 MAP の該当行も同一
ブランチで追随させる(起票テンプレに組込み済み)。現物と食い違ったら現物が正 — その場で本書を直す。

**表記**: パスは repo ルート相対。節の中の短縮表記は直前に出た親ディレクトリ相対
(例: `modules/…` = `src/components/canvas/modules/…`、`routes/__tests__/…` = `server/routes/__tests__/…`)。
`server/routes/*.ts` は thin adapter で、実ロジックは `src/lib/server/*` にある(対で読む)。
テストは同名 `*.test.ts(x)` 同居が規約 — 「テスト:」行には同名パターン以外の主要なものだけ書く。

---

## 0. 契約と骨格 — 全変更の起点
- Songs/NENE development handoff (2026-09-22): `docs/SONGS-HANDOFF-2026-09-22.md`.
  Two local repository branches, delivered UI/recording changes, verification,
  preserved owner data and remaining hardware/packaged-app acceptance checks.
- Current local handoff/backlog audit (2026-09-21):
  `commander/PRODUCT-HANDOFF-2026-09-21.md`. Records release 0.11.115,
  installed-app/data verification, live Claude acknowledgement and the Board
  audit. Two delivered cards are now done; the owner subsequently started the
  two remaining implementation workers and asked to leave them running.
  The earlier unshipped/stopped snapshot is historical; check live state.
- Public/owner surface contract: `docs/PUBLIC_PRODUCT_SCOPE.md`. Public Board,
  Terminal and opt-in Swarm (a bottom bar under every tab, not a tab — see §5); owner-only per-project Canvas, Research, custom tabs
  and WordPress/Skills UI. Owner display preview: `OwnerViewSwitch.tsx` +
  `App.tsx`; Ground tools collapse in `ToolPalette.tsx`. Automatic fuel reports
  are owner-only (`dailyFuelReport.ts`); meters/safety remain public. Visibility
  changes preserve existing data and hidden layouts. Public tabs have fixed
  order/visibility; only owner view offers add/hide/reorder. Feedback has one
  composer entry on Ground. The retired `/api/project/open` routes return 404;
  `/api/project/open-editor` and `/api/project/open/pick` remain live.
- Description display: `projectDataReconcile.ts` rejects responses overtaken by
  another save/load; `App.tsx` and `ProjectPanel.tsx` share `descriptionForLang`.
  Regressions: `ProjectPanel.description.test.tsx`, `App.render.test.tsx`, and
  `e2e/project-description.spec.ts` (generation, late read, navigation/reload).
- Project header: `ProjectPanel.tsx` keeps project name, scrollable tabs,
  compact `UsageHud`, and navigation in one 48px row. The project-name button
  opens details (description/generation, rename, folder/editor/branches,
  owner/public display switch and Skills); no saved data is removed.
  `CustomFrameHost.tsx` respects focus restored by a closing dialog while
  retaining playback and keep-alive navigation. Regressions:
  `e2e/project-header.spec.ts` (320/390/1280/1600px, iframe geometry and state,
  dialogs/menus, focus, data preservation) and `CustomFrameHost.test.tsx`.
- `src/lib/types.ts` — client/server 唯一の共有契約。API payload を変えたら必ずここ
- `src/lib/schemas.ts` — 永続データの zod スキーマ(ProjectTaskSchema ほか)。カードの
  フィールド追加は types + schemas の両方(片方忘れると保存時に黙って消える)
- `server/index.ts`(:47776 bind)→ `server/app.ts`(Hono app。route mount の全一覧はここ)
- `src/main.tsx`(I18n→Auth→Realtime の provider 積層)→ `src/App.tsx`(全 UI 状態のルート)
- `src/lib/api-client.ts` — fetch ラッパ / `server/routes/_shared.ts` — route 共通ヘルパ
- 罠: ProjectTask の optional は `.catch` 付きで書く — 1フィールド不正でカード丸ごと drop を防ぐ。

## 1. Ground・registry / paths — プロジェクト登録・データ配置・パス境界
- `src/lib/server/registry.ts`(登録 CRUD・UUID 発行・legacy 移行)/ `scan.ts`(カード一覧・missing 検出)
- `paths.ts`(`~/.openground/` 解決・旧名 home の一括 rename・**テスト中の fail-closed fence** →
  §12)/ `store.ts`(settings.json / canvas.json)
- `projectDataPath.ts` — **セキュリティ境界**: `projectUUIDFromPath` / `validateProjectPath`。
  per-project データは `~/.openground/projects/<uuid>/`(repo 内には何も書かない)
- `retention.ts`(起動時の legacy prune)/ route: `server/routes/project.ts` / `misc.ts`
- **データ保全2点セット**(2026-07-18 の registry 45→3 消失を受けて): `homeBackup.ts`
  (settings.json / canvas.json の世代バックアップ — `store.ts` の `writeJson` が上書き前に
  `snapshotBeforeWrite` を呼ぶ。`~/.openground/backups/<kind>/`・内容hashで dedupe(canvas は
  viewport を除外=パン/ズームは世代を消費しない)・直近10世代+日次14日+総容量20MB上限)/
  `homeIntegrity.ts`(起動時の破壊検知 — `server/index.ts` から fire-and-forget。異常縮小・
  読取不能・テスト固有値混入を検知して**警告と復元候補の提示のみ**、自動復元はしない。
  読み出しは `GET /api/home-integrity`)
- 罠(**保持ポリシーの肝**): 刈り取りから真に守られるのは「**各次元で最も中身の多い世代**」
  (=the pin、ファイル名の `n<件数>` で判定)であって「最新N世代」ではない。KEEP_RECENT は
  時間でなく**書き込み回数**で数えるので、破壊直後に同日中10回書けば KEEP_FLOOR の3本は
  全部**破壊後のコピー**になる — 初版はこれで事故を再現すると控えがゼロになった。
- 罠(**次元は絶対に合算しない**): canvas は `positions`(カード配置)と `elements` を
  **独立の量**として持つ(`DIMENSIONS`)。合算した版では、付箋を足し続けるだけで pin が
  そちらへ移り、**カード配置45個を持つ世代が刈られて復元不能になった**(実測)。検知側も
  45pos/0el→45pos/100el→0pos/100el が「145→100=31%減」で閾値を下回り無音になる。
  片方の増加がもう片方の全損を覆う — 新しい次元を足すときも必ず別々に pin・判定すること。
- 罠(**high-water の窓**): ブート間の損失(セッション中に45件インポート→ブート無しで破壊)は
  watermark だけでは見えないので世代ファイル名からも導出する。ただし pin は破壊直前の世代を
  **永久に保持する**ので、窓(`peakWindowFrom`)を切らないと毎ブート旧ピークが復活し、
  オーナーが1件戻すたびに新しい警告が鳴る。`lastAlert`(dedupe・clean bootで消える)とは
  **別フィールド**で持つこと — 兼用したら窓が消えて再発した。
- UI: `src/App.tsx`(Ground 本体)+ `src/components/canvas/` の `ProjectCard` / `ProjectCanvas` /
  `ProjectPanel`(カードを開いた中身・タブ切替)/ `Toolbar` / `NewProjectModal`
- **カードのランプ**(2026-08-15 に「プロセスの生死」→「仕事の状態」へ移設): 判定は
  `src/lib/groundLamp.ts`(pure・オーナー指定の4ケース)、材料は `src/lib/server/groundLamps.ts`
  → `GET /api/ground/lamps`(started カード数・未回答の質問数・実際に動いているか)。
  作業中=running / 入力待ちも途中停止も waiting / **全部doneまたはtodoのみは何も出さない**。
  罠(**サーバで見るのは SDK プールがあるから**): swarm worker は Agent SDK で動くので
  `/api/terminal/active`(PTY プール)には出ない。PTY プールだけで判定すると、完璧に動いて
  いる swarm に対して「途中で止まっている」と表示する。liveness は `liveDesks`(両プール)
  経由でしか取らないこと(eslint の no-restricted-imports が止める)。
  罠(**沈黙もメッセージ**): ボードが読めなかったときに何も描かないのは「全部終わった」と
  同じ見た目 = 静かな嘘。`started` は optional で、欠けていたら `'unknown'`(No data スタンプ)。
  旧 `groundBeacon.ts`(active 一覧を1プロジェクト1判定に畳む集約)は**削除済み**。
- テスト: `src/lib/server/` の `projectPathSecurity.prop.test.ts`(境界の property test)/
  `registry.test.ts` / `scan.test.ts` / `homeBackup.test.ts` / `homeIntegrity.test.ts`
  (後2者は 45→3 という**実事故の形**を fixture 化した回帰。赤/緑の両方向を固定)
- 罠: path を受ける新 endpoint は必ず `validateProjectPath`(registry が allowlist・UUID は registry
  からのみ取得・両側 canonicalize)。swarm worktree 配下(`projects/<uuid>/worktrees/`)も合法パス。

## 2. Board — かんばん・タスクカード・実行ボタン
- UI: `src/components/canvas/modules/BoardModule.tsx`(タブ本体・実行/挿入ボタン)+
  `src/components/canvas/` 直下の `BoardCard.tsx` / `BoardTab.tsx` / `BulkActionBar.tsx`
- データ: `src/lib/server/projectData.ts` — tasks.json が唯一の永続体(ロック / CAS)。
  route: `server/routes/project.ts`
- 実行: `composeTaskPrompt.ts`(実行=AUTO-SENT の prompt 合成)/ `taskPrompt.ts` / `taskAssets.ts`
- client lib: `boardDeps.ts` / `boardPriority.ts` / `boardWorker.ts` / `assignees.ts` / `cardTitle.ts`
- テスト: `BoardModule.*.test.tsx` / `projectData*.test.ts` / `server/routes/__tests__/tasks.test.ts`
- Difficulty picker browser coverage: `e2e/board-tier.spec.ts` (save, Auto reset,
  reload, safety-floor status, desktop and narrow viewports).
- Manual run-defaults visibility follows `BoardModule.swarmVisible`, the same
  gate as Run routing and per-card settings. `BoardTab.showRunDefaults` changes
  display only; saved launch preferences survive enabling/disabling Swarm.
- 罠: API 契約の落とし穴(フル UUID 必須・列名・短縮 id 黙殺の歴史)は
  `docs/commander/05-board-api-contract.md`。collab 共有中は Y.Doc が権威 — サーバ側の Board
  書込みは collabMirror 経由でないとクライアントに巻き戻される(→ §6)。

## 3. Terminal(PTY)— 唯一の実行経路
- `src/lib/server/terminal.ts` — node-pty pool。`globalThis.__openground_terminal` で
  tsx watch reload を生存(新規 in-memory 状態もこのパターンを踏襲する)
- `claudeTerminal.ts`(`launchClaude` — claude PTY 起動・`--session-id`・taskWorktrees の
  `--add-dir` 事前許可)/ `pastePrompt.ts`(bracketed paste・UNSENT 挿入)/ `cliResolve.ts`(claude 実体解決)
- `claudeConnection.ts` / `claudePreflight.ts` / `swarmEnvPreflight.ts`(git/shell 前提 —
  git 不在・非 git repo・シェル不在を worker/supply/manager spawn 前にゲート、
  `GET /api/swarm/preflight` で Swarm タブに1枚のバナー表示) / `terminalProjects.ts`(active 一覧に
  projectId を刻む — worker の cwd は中央 worktree で project 配下にないため)/
  `src/lib/claudeMenu.ts`(client 側 — 権限メニュー検出→数字送信)
- `src/lib/claudeScreen.ts` — **描画済み claude TUI 1画面のアナトミー**(どの行が CLI の
  furniture でどの行が会話か)を集約した pure leaf。`swarmQuestions`(質問検出)/
  `swarmEscalations`(投入ターンの着弾判定)/ `swarmRateLimitText`(上限文言の位置判定)の
  **3消費者が共有**。⚠ 罠4つ(全て実測で踏んだ・3幅の回帰は `ownerDeskScreens.test.ts`):
  ①入力箱は `│ … │` の枠ではなく**罫線で挟んだ `❯` 行**(`╭──╮` はバナー専用)。
  ②`esc to interrupt` は footer であると同時に**ただの本文**でもある — 画面全体に
  当てると、その語を表示した卓(=この機能のソースを読んだ卓)が永久に「生成中」に化ける。
  ③`⎿` が付くのはツール結果の**1行目だけ**・継続行は無印の字下げ行。
  ④**行を無条件に束ねるな** — chrome 表は閉じた列挙なので、束ねる設計は「表が知らない行」
  (`API Error: 529 Overloaded` 等)を無害から致命に変える(上の行が通知に畳み込まれて
  本物が沈黙)。hard-wrap は消費者側の**二読評価**で吸収する(素直な読みが落ちたときだけ
  上の無印ブロックを1つずつ前置して再判定・上限あり)。⑤親が画面外の字下げ行は `orphan` =
  誰の発話か分からない(証拠が無いのであって証拠があるのではない)。
  ⚠ **位置判定を足すときは「パターンが受け渡し文字を食えないか」を先に見る** — 位置専用
  パターンが任意テキストを食えると、その内側は gap 判定からも導入判定からも見えなくなる
  (この機能が7回差し戻された原因・commander/04 §3.7 が正典)
- route: `server/routes/terminal.ts` / `sse.ts`(出力ストリーム)
- UI: `src/components/canvas/` の `TerminalPane.tsx`(xterm 描画)/ `ClaudeTerminalPane.tsx` /
  `TaskTerminal.tsx`. `EmbeddedClaudeTerminal.tsx` retains legacy binding cleanup
  only; all right-edge terminal docks and their auto-launch UI are removed.
- テスト: `terminal.test.ts` / `claudeTerminal.test.ts` / `routes/__tests__/paste*.test.ts` / `runTaskLaunch.test.ts`
- 罠: **正典 = `claudeTerminal.ts` 冒頭「THE TWO RULES」**(8つの launcher が全部ここを指す)。
  **①subscription-only**(API key 経路を作らない・提案しない)と**②PTY-only**(`claude -p` を
  実行経路にしない)は**別のルール・別の理由**。⚠ 0730 以前は「PTY だからサブスクに課金される」と
  1つに融合させていたが**それは誤り** — 実測で `-p` もサブスク(`apiKeySource:"none"` /
  `/usage` が "using your subscription" / seven_day rate_limit_event)。②が生きている理由は
  課金ではなく **(a)課金はポリシーで戻りうる (b)`--remote-control` は REPL 専用=非PTYで黙って
  死ぬ (c)センサー群が描画画面前提 (d)シェルが逃げ道**。(a)(b) は我々の裁量外。
  描画性能(WebGL / coalescing / ACK フロー制御)は設計契約がある —
  `TerminalPane.tsx` / `terminal.ts` のコメントを読んでから触る。
- **スクレイプをやめる選択肢の調査**: `docs/SDK_CLIENT_INVESTIGATION.md`(0729-0730)。
  ⚠ **この文書の「移行はしない」結論は 0730 夜のオーナー決定で worker については覆っている**
  (実装済み・§5 参照)。以下は当時の推論として保持 —
  結論=**Agent SDK への移行はしない**。**最上位の理由は規約**(§12・一次情報): Agent SDK 公式ドキュメントが
  「第三者開発者が自社プロダクトに claude.ai ログイン/レート制限を使うのは不可 —
  **Agent SDK で作ったエージェントを含む**」と名指しし、API キーを使えと指示している。
  API キーは subscription-only を壊すので選べない。⚠ **技術的に動くこと(実測で動く)は許可ではない**。
  PTY 経路は同文書で名指しされておらず "ordinary use of Claude Code" 側に近い、という非対称が根拠。
  以下は規約と独立に成り立つ副次理由 —
  SDK でもリモコンは作れる(`/bridge` の `createCodeSession`→`fetchRemoteCredentials`→
  `attachBridgeSession`)が、`--remote-control` **1行**が**`@alpha` API の自前運用**
  (認証/epoch/SSE seq/heartbeat)に変わる。alpha は「破壊的変更でメジャーを上げない」と
  明記＝パッチで壊れうる。**手放せない機能をそこに乗せない**。
  ⚠ `--remote-control` フラグ自体は SDK/print 経路では効かない(実測3件: initialize が
  `remote_control_auto_enable:false` / `-p --remote-control --debug` でブリッジ活動ゼロ /
  `extraArgs` 経由でもゼロ)。**代わりに JSONL で解ける**:
  ★**CLI 自身の文言は JSONL に `isApiErrorMessage: true` 付きで記録される**(全JSONL走査で実測・
  該当249ファイル — `You've reached your Fable 5 limit` 158回 / `session limit` 74回 /
  `API Error: 529 Overloaded` / `Not logged in` ほか)。**引用にはこのマーカーが付かない**ので、
  上の罠④(529 が通知に畳み込まれて沈黙)と `swarmRateLimitText.ts:401` の誤検知クラス
  (=司令官が worker 画面を引用する日常業務)が**位置ではなく構造**で解ける。
  移せるのはクォータ/APIエラーの腕まで — **idle 状態判定と権限メニュー検出は画面が要る**
  (ただし swarm 全ロールは `permissionMode:'bypass'` なのでメニューは出ない)。
  ⚠ `claude -p` は 2.1.220 では**サブスク課金**(実測4証拠)だが、これは**ポリシーであって
  アーキテクチャではない**(過去に課金ルールが存在し後に消えた) — 実行経路を賭けないこと。
  ⚠ 中断の判別は `terminal_reason`(`aborted_streaming`)で見る — **`subtype` は本物のエラーでも
  `success` になる**。

## 4. Canvas — デザイン/ブレストの無限キャンバス
- UI 本体: `src/components/canvas/` の `CanvasWorkspace.tsx`(タブ・複数キャンバス・ドック)/
  `InfiniteCanvas.tsx`(pan・zoom・marquee)/
  `ElementView.tsx`(要素 dispatch)+ `ShapeView` / `FrameView` / `ImageView` / `ScreenView` / `CommentPin` / `StrokeOverlay`
- パネル: `LayersPanel.tsx` / `SelectionInspector.tsx` / `ToolPalette.tsx` / `ElementBar.tsx` / `PagesSection.tsx`
- 純関数 lib: `src/lib/canvas*.ts` 群(transform / snap / group / align / textSizing / merge …)+
  `useCanvasHistory.ts`(undo)
- データ: `src/lib/server/canvasData.ts`(per-canvas JSON・OCC rev)/ `canvasImages.ts`(アセット)。
  route: `server/routes/canvas.ts` / `canvasAi.ts`(AI 生成 — server 側常駐ジョブ `src/lib/server/canvasAi.ts`)
- mock/screen 描画: `src/lib/mockSrcdoc.ts` / `screenSrcdoc.ts`(sandbox iframe srcdoc 生成)
- テスト: `src/lib/canvas*.test.ts` 多数 / `CanvasWorkspace.*.test.tsx` / `canvasOcc` ・
  `canvasIndexRace` ・ `canvasAssetGc`(server 側)/ `e2e/canvas.spec.ts`
- 罠: 保存 409 = OCC 競合 — 3way merge(`canvasMerge.ts`)で解く。画像は element の assetId と
  shape 塗りの fillImageId の**2参照** — GC は両方集めないと誤 unlink。AI 生成はサーバ側ジョブ
  (navigate しても完走・per-id OCC)。

## 5. Swarm — 並列 worker エンジン(詳細は docs/commander/)

- Current simplification contract: [commander/SIMPLIFICATION.md](commander/SIMPLIFICATION.md).
  Persona, proxy answers, self-supply scans and the dormant engine integration panel
  are removed. Human approvals, monitoring, stop/recovery, backups and quota guards remain.
- **三役のキャラクター**(2026-08-15・オーナー承認): `src/lib/swarm/sprites.ts`(16×16 を
  **テキストのドット絵**で持つ — カワウソ=補給係 / フクロウ=司令官 / ウサギ=作業者。
  1枚の絵に状態ごとのパレットを塗る)+ `src/components/canvas/SwarmSprite.tsx`(canvas 描画・
  状態ごとに**動き方が違う**・`prefers-reduced-motion` は静止1枚・rAF は unmount で cancel)。
  出る場所: BoardCard の worker/commander 帯・Swarm タブの各席の名札 `SwarmSeatHeader`
  (社長/マネージャー/ワーカー全席・役ごとの背景色トークン `--og-seat-*` は globals.css 両パレット、
  文字コントラストは `themePalette.test.ts` の SURFACES で監査)。
  罠(**いない相手は描かない**): 状態はどれも「そこに居る」という主張なので、`exited` と
  司令官の `off` は図を出さず点のまま(`BEACON_SPRITE` / `MANAGER_SPRITE` が `null` を返す)。
  罠(**動きは読み上げに届かない**): aria-label は必ず「役 状態」。worker は未回答の質問が
  あれば活動語ではなくそちらを言う(`spriteStateFor` の asking 優先と一致させる)。
- **診断・改修の前に `docs/commander/00-INDEX.md`**(症状→章の直行表)。理想形 = `TARGET-STATE.md`。
  安全不変条件 = `docs/SWARM_SAFETY_INVARIANTS.md` + `src/lib/server/swarmSafety.test.ts`(触る前に緑確認)
- **worker の SDK ランタイム(実装済み・ダイヤル既定は 0801 に SDK へ反転・reader まで届いたのは
  0802/詳細は本節 §5 後段「ダイヤル既定は 2026-08-01 に反転」の段)**: 入口は
  `workerRuntime.ts`(WorkerRuntime seam・`workerKey`・pty/sdk 実装)/
  `sdkSession.ts`(プール・queryFn DI)/ `sdkEvents.ts`(メッセージ蒸留の一枚岩)/
  `sdkGuardHook.ts`(**A3/L4 veto の in-process 再武装・全失敗経路が deny**)/
  `swarmWorkerSdk.ts`(launch plan + preflight)/
  route `server/routes/sdkSession.ts`(SSE・**二重ゲート**)/ UI `modules/SdkWorkerPane.tsx`。
  (`swarmWorkerRuntimeDial.ts` は **2026-08-13 に削除** — worker は SDK 専用になり、
  ダイヤルも slot cap も存在しない。下の「kill switch」段を参照。)
  ⚠ **SDK は filesystem settings を読まない → 素朴に spawn すると guard が黙って消える**。
  ⚠ **開発で100%動き、配布ビルドで100%動かない形を1回踏んだ**(0801 `dd311acc`)。
  `sdkGuardHook.loadGuardEvaluate` が `createRequire(import.meta.url)` を使っていた。
  esbuild の CJS 出力に `import.meta` は無く `{}` に置換されるので、Electron が fork する
  `server/dist/index.cjs` では `createRequire(undefined)` が **TypeError**。この hook は
  fail-CLOSED なので preflight が落ち、**出荷版では SDK worker が1体も立たない**。
  vitest は ESM なのでテストからは原理的に見えない。**esbuild は `empty-import-meta` で
  警告していたが、ビルド設定が `logOverride` で黙らせていた** — 当時の唯一の読み手は
  死んだ枝だったので正しかったが、その沈黙が後から生えた**生きた読み手**を覆った。
  今は require のベースを**ロード対象の絶対パス**にし(そもそも解決基準としてこちらが正しい)、
  ビルド側は banner で `pathToFileURL(__filename).href` を define して**本物の file URL を
  与える**。番人 = `sdkGuardBundleShape.test.ts`(設定に文字列があることではなく、その
  banner/define を**実際に esbuild へ食わせて** file URL が出ることを見る)。
  ⚠ **同じ「dev で100%動き、配布で100%動かない」を 0802 にもう一度踏んだ**(`e26d5efb`)。
  今度は `sdkSession.ts` の `require('@anthropic-ai/claude-agent-sdk')`。この SDK は
  **ESM 専用**かつ `external` なので、Electron が fork する CJS バンドルからは読めない
  (Electron 31.7.7 = Node 20.18、`require(esm)` は 20.19/22.12 以降) ⇒ 配布ビルドでは
  **全 spawn が `ERR_REQUIRE_ESM`**、SDK は製品として一度も起動していない
  (0.11.47/0.11.48 出荷済み)。今は動的 `import()`。番人 = `sdkEsmLoadFromCjsBundle.test.ts`。
  **2 件に共通するのは「ビルド成果物を走らせていない」ことだけ**。
  ⚠⚠ **worker は `workerKey(w)` で指し、`runtimeOf(w)` 経由で操作する。`w.terminalId` で
  直接触る箇所はすべて穴** — SDK worker の terminalId は**空**なので、失敗せず
  「何もしない」か「別人に当たる」。0731 のレビュー5周で**6件**摘出(全部無言。
  ⚠ この「6件」も**その時点の数**であって不変条件ではない — 下の「数を信用するな」と同じ扱いで、
  引用する前に数え直すこと。実際 0801 に同じ型が**送る側**でさらに複数出ている):
  掃除役が稼働中の worktree を削除 / 解体が止めずに削除 / 停止が全 SDK worker を巻き添え /
  一覧が runtime を落として健康な worker を「終了」表示 / 消費集計と Ground ビーコンが欠落。
  規則は `workerRuntime.ts` の `workerKey` 冒頭、性質は
  `swarmSdkWorkerContract.test.ts`、両プールを1回で聞く seam は `liveDesks.ts`。
  ⚠⚠⚠ **SDK デスクの生死は `isSdkSessionLive(s)`(= `!reaped`)だけで判定する。`status` で
  判定した箇所は全部欠陥** — `terminateSdkSession` は status を**同期反転**させる(頼むだけ)ので、
  片付け中の卓が「もう居ない」と読まれる。述語は `sdkSession.ts` から1つ export 済み。
  ⚠⚠⚠ **この問いを聞く seam の「数」を信用しないこと。この行が2度嘘をついた場所である。**
  0801 の5周目コミット(`80d567f6`)は「seam は6つ」と書き、その6つ(司令官の唯一性判定 /
  掃除役 / 停止 / Ground ビーコン / Swarm タブ一覧 / 枠カウント)を直して**集約済み**と宣言した。
  同じコミットのツリーに `status` 判定の seam が**2つそのまま残っていた**
  (`swarmManagerRuntime.isManagerDeskAlive` / `workerRuntime.sdkWorkerRuntime.isAlive`。
  どちらも7周目 `fecb4628` で修正)。**なぜ数え間違えたか — grep で見落としたのではない。**
  実測: その commit で `git grep isSdkSessionAlive` を打つと、残る2つは**同じ画面に出ていた**。
  外したのは数え方の単位だった:
  ①**「seam」ではなく「その周に見つけた欠陥」を数えていた** — 既に正しく `reaped` を見ている
  seam(reap 待ちの3本 = `isSdkSessionReaped` / `stopAllDesksInDirAndWait` /
  `waitForSdkSessionGone`)は数から落ち、まだ書かれていない seam(SDK worker への回答配達
  `defaultCanPushIntoSdkWorker` — 7周目に新設)は数えようがない。**call site の個数は
  コードが伸びれば増える**ので、数を書いた瞬間にその行は古くなる。
  ②**列挙の単位が「オーナーに見える症状」だった** — twin が湧く / worktree が消える /
  カードが消灯する / 生きた worker が死亡表示 / 枠を超える / 誤って止まる、と並べた。
  残った2つは**エンジンが内部で聞くだけ**で固有の症状名が付かず、症状の表に行が立たなかった。
  症状で数えると、症状を持たない seam が静かに落ちる。
  **数える代わりに、数え方を置く**(次に棚卸しする人はこの3手を全部やること):
  `git grep -n "reaped" src/lib/server server | grep -v test`(フィールド直読み —
  `sdkSession.ts` 内部の4箇所は記号を経由しないのでこれでしか出ない)/
  `git grep -n "isSdkSessionLive\|isSdkSessionAlive\|isSdkSessionReaped"`(記号)/
  **DI 既定値を目で追う**(`deps.sdkAlive ?? …` / `opts.sdkReaped ?? …` /
  `reaped: (id) => boolean = isSdkSessionReaped` — 呼び出し側のローカル名は別物なので、
  「聞いている場所」を記号 grep では拾えない)。
  0801 時点の棚卸し(**日付つきの事実であって不変条件ではない**)= 本番15箇所:
  プール内部**5**(`listActiveSdkCwds` / `terminateSdkSessionsInDir` / `listSdkSessionsIn` /
  `isSdkSessionReaped` / **`sweepClosedSessions`**)+ `isSdkSessionLive` 消費7(Ground ビーコン /
  Swarm タブ一覧 / 司令官卓の生存プローブ / worker の isAlive / 回答配達 / **SSE 終端** /
  **会話の resume 可否** = `swarmSessions.isAgentSessionLiveAnywhere`)+ `reaped` 直読み3
  (枠カウント / 削除ゲート / 解体待ち)。
  **数え方**(引用する前にこの線引きを合わせること): 数えるのは**読み**だけ。
  `e.reaped = true` の**書き**2箇所(pump の `finally` / spawn 失敗)と、
  `SdkSessionInfo` への射影(`...(e.reaped ? …)`)は含めない。
  ⚠ **初版はこの棚卸しで `sweepClosedSessions` を落としていた**(0801、点検で摘出)。
  落ちた理由が上の①②そのもの: **エクスポートされていないので記号 grep に出ず**、
  かつ**固有の症状名が無い** — この関数が `reaped` でない entry を永久に消さないのは
  仕様(D 状態で固まった claude の worktree を守るため、リーパ timeout を置かない)で、
  「壊れた」と呼べる行が症状の表に立たない。**仕様どおりの読みも読みである。**
  そして**この1箇所が下流の性質を1つ決めている**: プールが非 reaped entry を永久に
  抱えるので、`isAgentSessionLiveAnywhere` はその会話 id に対して**サーバプロセスの
  生涯ずっと "live" と答え続ける**(再起動でプールは消える)。詳細は
  `swarmSessions.isAgentSessionLiveAnywhere` の注記。
  ⚠ **この棚卸しを書いている最中に1件生えた**(`isAgentSessionLiveAnywhere` — 「この
  claude 会話はまだどちらかのプールで開いているか」。false で「空いている」と答えると、
  まだ喋っている卓のトランスクリプトを新しい `--resume` に渡してしまう)。上の3手を
  実際に打って出てきたもので、私の頭の中の一覧には無かった。**数を引用する前に打つ**という
  規則がここで1回身を守った、という記録として残す。
  SSE 終端(`server/routes/sdkSession.ts`)は 0801 まで status 判定で、**片付け中の
  最後のフレーム — 卓がどう終わったかを言う唯一のフレーム — が客に届かなかった**
  (再接続すると即 `end` でタイルが白紙)。`isSdkSessionLive` に寄せて解消。
  ⚠ ここには「隣の Swarm 一覧は `!reaped` で『稼働中』と描くので**同じ画面で2つの答えが
  並んでいた**」と書いてあったが、**それは観測ではなくコードからの再構成**だった
  (0801 の点検で撤回)。2つの読み手が別々の述語を使っていたことは現物で確認できる
  事実、その画面を誰かが実際に見た記録は無い。**成立しうる状態と、観測した状態を
  同じ文体で書かない** — 再現手順を持たない「実例」は、次の人に測り直す気を失わせる。
  ⚠ その修正には**プール側の相方**が要った: `terminateSdkSession` が先に `exited` を
  書いているので、pump の `finally` の書き込みは `setStatus` の重複排除に飲まれて
  **フレームを1つも出していなかった** — 「頼んだ」と「本当に止まった」で1フレームしか
  存在しなかった。`announceStatus`(重複でも emit する)を新設し、**`reaped = true` を
  emit の前に立てる**(受け取った listener がプールに聞き返したとき既に true でないと、
  「まだ生きている」と告げられて二度と知らせが来ない)。順序は番人が直接固定する
  (`server/routes/__tests__/sdkSessionStreamEnd.test.ts`)。
  **status のまま残っている1つ**: `isSdkSessionAlive`(= 終端 status が書かれたか。
  **生死ではない**。本番の呼び手ゼロ・テストだけが呼ぶ地雷)。
  ⚠ **status を動かす昇格は「仕事の証拠」(`isWorkEvidence`)で** — CLI はターンの合間にも喋る
  (`background_tasks_changed` / `session_state_changed`)。「メッセージが来た＝作業中」で書くと、
  終わるターンが無いので**二度と waiting に戻らない**。
  ⚠ **terminate は status 遷移の終端**。`closed` 後は emit だけして status に触らない。ただし
  中断ターンの `aborted_streaming` は**読む** — 落とすと正常停止が全部 `failed` 表示になる
  (`closed` 自体も「頼んだ停止」の一次証拠として扱う)。
  ⚠ **`interrupt()` はセッションを殺さない**(0801 実測 `scripts/probe-sdk-interrupt-survival.mts`)。
  CLI が生きていれば interrupt は**ターンだけ**中断し、`aborted_streaming` の result を届けて
  **イテレータは続く** — 後から push したターンは完走する。イテレータの throw は
  **claude プロセスが死んだとき専用**で、SDK が例外本文を最後のエラー result の文言に貼り替える
  ので `[ede_diagnostic] …` と読め、interrupt が原因に見える。0730 のスパイクが逆の結論を
  出したのは **string prompt** を使っていたから(SDK は `typeof prompt === 'string'` で
  `isSingleUserTurn` を立て、最初の result で CLI の stdin を閉じる = CLI は必ず死ぬ)。
  本番は AsyncIterable(`makeInputIterable`)で**別の構成**。
  ⚠ **ただし測った相手は偽 CLI**(プロトコルだけ喋る 60 行のスタンドイン)。**確定するのは
  SDK クライアント側の性質**(子が生きていれば iterator は終わらない / throw は子の死に紐づく)
  で、**「本物の `claude` が interrupt 後も生き続けるか」は未確認**(隔離 HOME では認証
  できないため意図的に未測定 — SDK_WORKER_MIGRATION_PLAN 付録 B-6 / C)。本物が終了を
  選ぶなら本番は throw 側に落ちる。**「実測済み」を無条件に引用しないこと。**
  → 「本番と違う構成を測ると逆の因果を確信する」の実例。auto-memory
  `reference_measure_the_production_arrangement` と同じ罠。**そして構成の一致は
  `prompt` の形だけではない — 相手側のプロセスも構成のうち**(この但し書き自体が、
  同じ罠の2周目として 0801 の点検で足された)。
  ⚠ **エンジンから worker への通信路が丸ごと PTY 前提だった**(0801・7周目 `fecb4628`)。
  生存判定と同じ型の**送る側**の版で4本 — 2本は `status` 前提(司令官卓の生存判定 /
  worker の `isAlive`)、2本は `terminalId` 前提: 監督 S4 の重複キー
  (`S4:${w.terminalId}` — SDK worker は全員空文字なので**艦隊全体で1スロットを奪い合い**、
  2体目以降のエスカレーションが黙って捨てられる。今は `workerKey(w)`)/ 監督 T1 の回答注入
  (`canInjectInto(terminalId) && injectAnswerIntoWorker(terminalId)` — SDK worker には
  **一度も発火しようがなかった**。劣化した経路ではなく、動きようのない経路)。
  回答配達は runtime 非依存の seam
  `swarmEscalations.deliverAnswerToWorker`(ガードと配達を1呼び出しに畳んだもの。PTY =
  bracketed paste + CR + 着地確認 / SDK = ターンを1つ queue)へ寄せた。
  ⚠ **エスカレーションのレコードは「住所」を丸ごと持つ**(`Escalation.runtime` +
  `terminalId` / `sdkSessionId`。不在 ⇒ `'pty'` で既存 JSON はそのまま読める)。
  0801 まで `terminalId` しか永続しておらず、SDK worker では空文字なので
  **オーナーが inbox から答えても誰にも届かず**、毎回「次 dispatch に相乗り」へ落ちていた。
  ⚠ 住所の更新は**丸ごと差し替え**(runtime + 両ハンドル)。フィールド単位で上書きすると、
  再起動で別ランタイムに生まれ直した worker のレコードに**前世の terminalId と今世の
  sdkSessionId が同居**し、どちらが本物か分からなくなる。
  ⚠ 証拠の尾(`screenshotRef`)も**ランタイムごとに材料が違う** — PTY は画面、SDK は蒸留済み
  イベントの直近。PTY 前提のままだと SDK のエスカレーションは**証拠ゼロ**で上がる。
  ⚠ **同じ型の最後の1歩は「クライアントの受信サニタイザ」だった**(0801)。
  `useSwarmEngine` の手書きコピーが `runtime` と `sdkSessionId` **だけ**落としており、
  サーバが正しく送っていても SDK worker は全部 `runtime: undefined`(⇒ pty)で届き、
  **終了済み端末として描かれ PTY 用の再起動ボタンが付いていた** — 生きた claude の上に。
  `SdkWorkerPane` は本番では**到達不能な死んだコード**だった。恒久策はサニタイザを
  `Required<SwarmWorkerRecord>` 上の **mapped type** にして、フィールド追加漏れを
  **コンパイルエラー**にすること(手書きの逐次コピーは黙って落とす)。番人は
  `useSwarmEngine.workerWireContract.test.ts` — **本物のサーバ組み立て**と
  **本物のサニタイザ**を通して往復させ、落ちたら赤。
  ⚠ **spawn 失敗の理由は HTTP レスポンス / 通知に乗せる**(0813 以降: worker は
  fail-fast — 失敗は route の 500 本文 + `worker-spawn-failed` の鐘。fallback 時代は
  `SpawnSwarmWorkerResponse.fellBackBecause` が同じ役目だった)。配布アプリのサーバは
  fork された子プロセスなので **`console.warn` はオーナーに届かない** — 理由をログだけに
  置くと、preflight 落ちなのか CLI 不在なのか誰にも分からない。
  ⚠ **セッション所有の判定はレジストリ UUID で**(`projectUUIDFromPath` を両辺に) — パス前方一致で
  書くと**全 SDK worker が 403**(worker の cwd は repo 外の central worktree。0731 に出荷2版が
  この形で、worktree を repo 内に作ったテストが偽緑で通していた)。
  終了セッションは 30 分 linger 後に sweep(`SDK_SESSION_LINGER_MS` — 放置すると ring buffer ごと
  永久残留・`removeSdkSession` は呼び手ゼロだった)。
  ⚠ **worker に kill switch は無い(2026-08-13 オーナー決定)** — worker は **SDK 専用**。
  ダイヤル(`swarmWorkerRuntimeDial.ts`・`Settings.swarmWorkerRuntime`・`sdkMaxWorkers`
  slot cap・`getWorkerRuntimeDial`)は PTY worker ランタイムごと削除した。fallback は
  「実害を静かに吸収して移行を永遠に終わらせない」装置だったため(実測: slot cap 既定 1 が
  余剰 worker を全部 PTY に流し、オーナーはバグと読んだ)。SDK を確立できない spawn は
  **fail-fast**: `SdkWorkerUnavailableError` を投げ、カードは todo に残り、エンジンは
  dispatch を階段(1m→5m→15m)で HOLD + `worker-spawn-failed` の鐘 + 復旧後は自動再開
  (`swarmSpawnFailFast.test.ts` / `swarmWorkerFailFast.test.ts`)。古い settings.json の
  `swarmWorkerRuntime` キーは**不活性**(読まれない・エラーにもならない)。
  司令官も 2026-09-21 に SDK 専用化。旧設定は不活性、切り替え UI と実効値 API は削除。
  設計と実測台帳: `docs/SDK_WORKER_MIGRATION_PLAN.md`
  (0730 オーナー決定 — worker から段階導入・ダイヤル併存・PTY コードは消さない。
  **この併存方針は 0813 に「worker は SDK 専用」へ更新された** — 上の段を参照)。
  センサー対応表 §5 / ガード配線の非自明点 §4-G(**SDK は既定で settings をロードしない →
  素朴に spawn すると A3/L4 guard が黙って消える**・fail-closed 必須) / カード分割 §12。
  調査の正典は `SDK_CLIENT_INVESTIGATION.md`(実測台帳・「しない」だった旧結論の上書き経緯込み)
- **司令官の SDK ランタイム(2026-09-21 から新規起動は SDK 専用)**: 入口は
  `swarmManagerRuntime.ts`(**卓の在処を答える唯一の seam** — PTY プールと SDK プールの両方に聞く)/
  `swarmManagerSdk.ts`(launch plan + preflight)/ `swarmManagerLabel.ts`(循環を切る葉の定数)/
  `sdkDeskLimit.ts`(クォータ停止をイベント源で拾う)/ route `POST /api/swarm/manager/say`。
  起動は `swarmManager.ts` → `sdkManagerLaunchPlan` の一系統。旧設定は読み取らず、
  POST は無視する。会話・作業データは保持。旧 PTY 卓は dev reload 中の稼働分だけ
  検出・会話・停止を維持し、二重起動を防ぐ。停止後の次回起動は SDK。
  ⚠ **卓の存在判定を PTY プールだけに聞かないこと** — SDK 卓が毎パス `absent` と読まれ、
  5分ごとに二卓目が立つ(0719 の11卓事故と同じ形)。必ず `listManagerDesks`。
  ⚠ **SDK 卓に画面は無い**(`managerDeskScreen` は null)。null を「何も出ていない」と読むと
  正しい結論に誤った理由で辿り着く。等価な証拠は自分のストリームの `quota_refusal` イベント。
  ⚠ **リモコンは消える**(`--remote-control` は REPL 外で無効)。外からの窓口は **PTY のまま残す
  補給官**(`skills/supply/SKILL.md` の「状況」「質問に答える」「司令官に伝えて」)。ここが
  スマホからの状況確認と司令官への指示中継は引き続き補給官が担当する。
- **補給官 ⇄ 司令官の往復**(2026-09-22 オーナー決定「タスク窓口が社長」): 行き
  `POST /api/swarm/manager/say`(**卓が無ければ起こす** — `wake:false` で従来の 404)、帰り
  `POST /api/swarm/supply/say` → `supplyNotice.ts` の `queueSupplyReply`(知らせとは別レーン・
  FIFO cap 5・返事が知らせより先・落ちた分はベル info `commander-reply`)。印は
  `SUPPLY_REPLY_PREFIX='【司令官からの返事】'`(凍結)。**話者は body で指定させない**
  (`【本人からの回答(escalation)】` を騙れる — payload の `【】` は `REDACTIONS` で除去)。
  司令官側の義務は `skills/og-manage/SKILL.md`「補給官から中継された件には同ターンで返す」。
  正典は `docs/commander/06-overseer-escalations.md` §1.5。
- **社長モデル(2026-09-23 オーナー決定「僕が喋るのは社長さんだけ」)**: 補給官の画面名は
  「社長 / President」(i18n と Remote Control 名のみ — 卓の識別キー `SUPPLY_DESK_LABEL='補給官'`
  は**変えない**)。① ワーカーの質問は **司令官レーン**(`Escalation.routedTo:'commander'`)
  — `commanderQuestions.ts` が司令官へ渡し(`commanderRelay.ts` = manager/say と同じ起床経路)、
  司令官は `escalations/answer {by:'commander'}` か `escalations/raise` で決着、10分で自動的に
  オーナーへ。境界語(`swarmDecisionRouting.needsOwnerDirectly`)は最初からオーナー行き。
  ② `supplyNotice.ts` は3レーン(返事 → 重要 FIFO → 進捗ダイジェスト)。**重要は上書きしない**
  (旧1スロット上書きで質問が消えていた)。③ 進捗は `supplyProgress.ts` が Board の列移動を
  毎パス差分して作る(モデル不使用)。卓への打ち込みは貼り付け→Enter別送→着地確認で、
  着地してからキューを外す(未着は次パスで Enter だけ再送・06 章 §1.9)。**着地前に外すことは無い**
  (詰まった行はベル1回+保持・返事に TTL 無し)。入力欄の薄字の予測候補は `readScreen` が落とす(06 章 §1.10)。④ 納品は `sweepLanded` がカード名入りで重要レーン +
  ベル `work-landed`。正典は 06 章 §1.6。
  ⑦ **Swarm はタブではなく下部バー(2026-09-24・オーナー決定)**: `src/components/canvas/SwarmBottomBar.tsx`
  を `ProjectPanel` がタブ本体の三項演算の**外**(内容列の末尾)に置く = どのタブでも同じバー・タブ切替で
  開閉状態も席も保たれる。既定は畳み(`SwarmModule collapsed` = 見出し1行だけ: 状態・人数・判断待ち数・
  オン/オフのスイッチ。**席を1つもマウントしない = EventSource 0本**)。開くと上に広がり、上端ドラッグ/↑↓キーで高さ、
  高さだけ `openground.swarmbar.<projectId>` に保存(開閉は保存しない=毎回畳みで始まる)。
  Header stays ONE line open or folded (owner 2026-09-24): the boot-restored notice (`autonomyResumed`)
  is a dismissable chip inside the header row, and the master power is one `role="switch"`
  (`SwarmPowerSwitch`, no text). The Board's "Board · N cards / Settings" band is gone — Project
  Settings opens from the panel's ⋯ menu only; `BoardTab`'s toolbar row renders only for Mine-only / presence.
  Swarm タブ(`ModuleId 'swarm'`)は `MODULE_IDS` ごと撤去 — 保存済みタブ並び/最後のタブの `'swarm'` は
  無害に捨てられる。ゲートは `isSwarmVisible(moduleGate)` 1本(Board の `swarmVisible` も同じ)。
  Board の社長ドロワー `BoardSupplyDock` も削除 = 社長の席はバーの中の1つだけ(卓の二重起動防止は
  `useSupplyDesk` のガード+サーバの `spawnSwarmSupply` 排他ロックで従来どおり)。
  畳み中はエンジン poll を 15 秒に落とす(`FOLDED_ENGINE_POLL_MS` — 毎周サーバで git preflight が走る)。
  初回(オンボーディング未読・完全停止)に畳んだ帯のスイッチをオンにすると、起動せずバーを開いて説明を出す。
  バー内のお知らせ(予算超過・自動運転の記憶・監視の記憶・環境バナー)は畳み中は帯の赤い点1つで知らせる(再起動後の自動再開は見出し行の札なので点の対象外)。
  **接続の予算 `src/lib/streamBudget.ts`**(差し戻し 2026-09-24): HTTP/1.1 は同一 origin 6本まで・SSE 1本が1本を
  占有し、6本で後続 fetch(入力・poll・開始/停止)が永久に待つ。以前は Terminal タブと Swarm タブが排他だったが
  今は同時に出る。そこで SSE を開く3部品(`TerminalPane` / `ClaudeTerminalPane` / `SdkWorkerPane`)が生存中
  `holdStream(owner)` で枠を持ち、owner は `StreamOwnerContext`(バー内=`swarmBar`・他=`page`)。
  `STREAM_BUDGET=5`(1本は fetch 用に空ける)。**ページ優先**: バーは `5 − page` の残りだけを 社長→展開中
  ワーカー→旧PTYワーカー の順に使い、枠の無い席は要約表示+理由1行(「作業の様子を見る」も無効化+理由)。
  ターミナルのペイン上限 `MAX_TERMINALS` も同じ `STREAM_BUDGET`(旧6 — 6枚だけで詰まっていた)。旧上限で保存された
  6枚目以降は**消さず・シェルも殺さず**ストリームを開かない待機表示(`data-terminal-over-budget`)にし、他を閉じると
  同じシェルに再接続して戻る(番人 `ProjectPanel.terminalBudget.test.tsx`)。枠を使うのは実際にストリームを開く席だけ。
  番人 = `SwarmModule.streamBudget.test.tsx`(6接続プールの模型で fetch が答えるか・ペイン追加で枠を返すか・
  部品が正しい側で枠を持ち離すか)。**新しく EventSource を開く部品は必ず holdStream すること。**
  旧 `disabledModules: ['swarm']`(タブ単位の非表示)はもう効かない — バーを消す道は Swarm 自体をオフにすること。
  スクショ = `docs/screenshots/swarm-bottom-bar-20260924/`。
  番人 = `SwarmBottomBar.test.tsx` / `SwarmModule.seats.test.tsx`「folded into the bottom bar」/
  `ProjectPanel.dock.test.tsx`(タブ切替で開いたまま・フラグ無しでバー無し)/ `moduleRegistry.test.tsx`。
  ⑤ **監督タブは撤去済み(2026-09-23)**。続けて**サブタブ自体も廃止**(同日・1画面化):
  Swarm タブは 社長/マネージャー/ワーカー×N の席を1列に横並び(`SwarmModule` の seats row・
  狭い幅は横スクロールで統一)。`SwarmPaneId`/`SWARM_PANE_IDS`/`Settings.swarmPaneOrder` は削除
  (古い settings.json のキーは不活性・POST は黙って捨てる)。スクショ = `docs/screenshots/swarm-one-screen-20260923/`。
  罠(**接続6本の上限**): 生きた作業記録は1席につき EventSource 1本、サーバは HTTP/1.1 の同一ホスト
  = Chromium 上限6本。社長+マネージャー+ワーカー4席を全部流すと他の fetch が全部詰まった(レビュー実測)。
  だからワーカー席は既定で**畳んだ要約** `SwarmWorkerSeat`(状態は `/api/terminal/active` の両プール poll、
  質問は escalations poll 1本)で、作業記録を開けるのは**同時に1席だけ**(`openWorktree`)。
  番人 = `SwarmModule.workerRestart.test.tsx` の "keeps worker streams bounded"。質問への回答は社長経由(`escalations/answer`)、ベル/OS通知は従来どおり。
  ⑥ **マネージャー席は名札だけ(2026-09-23・カード③)**: `SwarmManagerPane` = 状態3語(動いている/止まっている/いない)
  +控えめな起動・停止のみ。会話ストリーム・命令バー・計器盤(KPI/着地/週/消費/在席)は撤去、`useLandedKpi` も削除
  (`GET /api/swarm/kpi/landed` と台帳は残置 — 社長が「着地は?」で読む=`skills/supply/SKILL.md` 状況④、
  `docs/OUTWARD_TRIAL.md` の週次計測はこの経路)。棚卸し表 = `commander/SIMPLIFICATION.md`。「状況の監視」スイッチは上部バー
  `SwarmMonitorToggle`(`SwarmPowerBar.tsx`)へ移設、予算超過(`consumption.overLimit`)は上部バー下の1行へ。
  席の状態は `/api/terminal/active`(両プール)。見えていて消えた卓=死亡、まだ見えない卓は5秒ごとの生存 probe
  (404/403/reaped のみ死亡・5xx は無視)→ どちらも reconcile が記録を消す(上部 Start で再起動できる)。質問 poll は `&status=open&lane=owner`(司令官が処理中の質問は出さない)。
  番人 = `SwarmModule.seats.test.tsx` / `SwarmManagerPane.test.tsx` / `SdkWorkerPane.test.tsx`(open-question banner)。
  重要レーンは TTL なし(社長不在中は保持・遅配は「約N時間前の知らせ」付き)・
  `~/.openground/supply-notice-queue.json` に永続(再起動でも消えない)・溜まった分は
  「(N件まとめて)」の1行で伝える。回答/却下で
  `forgetSupplyQuestion`、新しい卓は `catchUpSupplyDesks` が質問ストアから未回答を読み直す
  (再起動でも消えない)。正典は 06 章 §1.7、番人は `supplyNoticeAbsence.test.ts`。
  実測(0731): SDK セッションでも `/og-manage` は解決する(slash commands 95本に在る・実際に読み込む)。
  ただし **Claude Code の system prompt は付かない** ので app-context カードは
  `systemPrompt.append` で明示注入する(`scripts/probe-sdk-skill-resolution.mts` /
  `probe-sdk-system-prompt.mts`)。
- 入口だけ: `swarmOrchestrator.ts`(エンジン tick)/ `swarmWorker.ts` / `swarmLaunch.ts`(spawn・
  モデル/effort/リモコン名解決。**どの席がどのモデルを希望するかは `desiredModelEffort` 一本**で、
  役割は `SwarmModelRole` union に列挙する — union に無い席はそもそも問い合わせられない=tsc が落ちる。
  既定 optimize の worker はカードの難易度 `ProjectTask.tier`(touch/standard/design/ultra)を
  `TIER_MODEL_EFFORT` で引く。`fable` を希望するのは **worker × `ultra` カードだけ**、他は
  `SWARM_DEFAULT_MODEL='opus'` 以下。罠: 安全語(auth/削除/課金…)のカードは書かれた型に関係なく
  design 未満にならない(`resolveCardTier`)。`tier` は orchestrator の dispatch と Board 実行の両方から
  `spawnSwarmWorker` に渡すこと — 片方だけだと無人配車で効かない。表と実測は
  docs/commander/04-quota-models.md §5.9)/ `swarmIntegrate.ts` / `swarmOverseer*.ts` / `swarmEscalations.ts` /
  `swarmQuota.ts` / route: `server/routes/swarm.ts` / UI: `modules/SwarmModule.tsx` + `useSwarmEngine.ts`
- **エンジンの再起動永続化**(2026-07-22, card 2): `swarmEnginePersistence.ts`(engine intent
  write-through `~/.openground/projects/<uuid>/engine.json` + crash-loop breaker ring
  `~/.openground/engine-boots.json`) + `swarmOrchestrator.ts` の `resumeEngines()`(server 起動時に
  `server/index.ts` から fire-and-forget で呼ばれる)。設計正典 = `docs/ENGINE_PERSISTENCE_PLAN.md`
- **worker roster の write-through + boot 照合**(2026-07-23, card 3): `swarmWorkerRoster.ts`
  (roster を心拍の隣 `~/.openground/swarm/<repoキー>/roster.json` へ write-through — sessionId /
  taskId / branch / worktree / tier / spawnAt / workedMs / reworkCount。状態遷移点のみ書く
  signature-guard・fail-open write / fail-quiet read)+ `swarmOrchestrator.ts` の `syncRoster()`
  (dispatch pass 末尾)・`resumeEngines()` の**照合先行・spawn 凍結**(`reconcileRoster` を dispatch
  前に await)。boot 分類 4 分岐 = worktree 消滅 / ready / 作業途中(resume 候補) / カード消滅。
  実際の `--resume` 会話復元は card 4(未着手)。設計正典 = `docs/ENGINE_PERSISTENCE_PLAN.md` §3/§4-3
- **「worker が完了した」を司令官へ伝える道は蘇生反射とは別**(2026-07-27・`swarmOrchestrator.ts`)。
  トリガ = `reviewSeenAt` に**初めて**載った瞬間(= 完了イベント)、キュー = `engine.managerNotice`
  (1枠・新しい方が勝つ・review から消えたブランチは prune)、送信 = `defaultNotifyManagerReady`。
  **送信可否は時間でなく画面** — `noticeDeliverable`(生成中でない・入力欄が空・メニューが出ていない。`isGenerating` /
  `readInputBoxText` = `src/lib/claudeScreen.ts`)。**ESC も Ctrl-U も送らない**ので打ちかけを壊さない。
  ⚠ **蘇生の nudge(`defaultNudgeManager`)と混同しない** — あちらは ESC を先に送る破壊的な操作で、
  4本のゲート(10分/5分/10分/3回)はその破壊性の代償。ここを「遅いから」と短くするのは
  2026-07-18 の事故(生きた卓を3回蘇生し誤 fatal)の再発。正典 = commander/03 §2.3
- **worker の「成果あり」は親ブランチ + worktree 直下の入れ子リポ**(`swarmOrchestrator.ts` `probeHasWork` / `defaultCountNestedCommits`、2026-09-13)。親フォルダ型プロジェクトの worker は子リポの linked worktree に成果を出すので、親だけ数えると完成品が stall に化ける。ready なのにどこにもコミットが無いときは `ready-without-work`(nudge せず 3 分保持 → blocked、初見で通知)。
- **stall 判定の生存チャネルは 4 本**(すべて `swarmOrchestrator.ts` 内。①心拍 ②PTY 出力
  ③transcript/sub-agent mtime = `sessionAgentActivityAt`(2026-07-23) ④**実行中の背景タスク** =
  `sessionBackgroundTaskAt`(2026-07-27)。畳み込みは `lastActivityMs` / `classifyStall`、上限は
  `backgroundTaskAliveAt` + `BG_TASK_GRACE_MS`(90分 = `MAX_EXEC_MS` と同値))。**④が無かった間、エンジンは完了ゲートを
  背景で回して待っている健全な worker を殺していた** — ③は「1ターン内で Task() を回す」形専用で、
  ターンが終わって通知を待つ形は救えない。④は claude の session JSONL を読む。⚠ **開始は2形式**
  — 明示(`run_in_background:true` の tool_use)と、**前景 Bash が timeout で自動背景化された形**
  (この tool_use には `run_in_background` キーが無い = 初版が見落として実データで 6 件殺し続けて
  いた形)。⚠ 証拠は **`Command did not complete within its <n>s timeout and was moved to the
  background (ID: …)` という文全体**であって `was moved to the background` という語句ではない —
  後者は散文にも現れる(実測: 5 件が語句だけ一致し、うち1件は司令官の差し戻し指示文そのもの)。
  緩めると**解決しない幽霊タスク**が生まれ、死んだ worker に猶予を丸ごと渡してしまう。終了は両者共通で
  `queue-operation` が同じ `<tool-use-id>` を名指す。
  正典 = commander/02 §5.4b。法医学ツール = `scripts/verify-bg-channel-on-real-transcripts.mts`
  (stall reclaim された worker の transcript を渡すと BEFORE/AFTER を再現)
- 子プロセスの env: テスト/ビルド/lint を回す spawn は **必ず** `gateProcess.ts` の `withGateEnv`
  (electron 側は `electron/gateEnv.js` の `buildGateEnv`)を通す — 使い捨て `OPENGROUND_HOME` を
  engine が注入する統制。env を丸ごと渡すと `gateEnv.test.ts` の source pin が RED。
  **例外は成果物生産者**: `npm run build` は第1段でベイクするので `buildProducerEnv`(BAKED_KEYS 免除)。
  **生産者は transitive で判定**(e2e step は playwright の webServer が `npm run build &&` で始まるので生産者)。
  検証子(tsc/lint/vitest/scanner/unit)は全 strip。理由と限界(HOME 自体は非隔離)= commander/03 §2.9・不変条件 F
- **オーナー自身の卓**が上限で止まったら知らせる: `ownerDeskLimit.ts`(**engine 非依存の boot ループ** —
  止まる卓は誰も見ていない卓なので engine 非稼働でも効く)。反応は**通知だけ**で卓には触らない(入力 seam
  が構造的に無い)。文言 = `swarmRateLimitText.ts` / 枠 = `src/lib/claudeScreen.ts` を**共有**し、
  タイミング門2本だけ卓の自前。正典 = commander/04 §3.7。⚠ 罠3つ(全て実測で踏んだ):
  ①**案内は枯渇の種類で分岐**する — account-wide 枯渇に「`/model` を打て」は**嘘**(全モデルが枯れている)。
  判別は CLI 自身の remedy 行を読み返す。②**1パスで止まった卓は1本に合体** — account-wide は全卓を同時に
  止めるので卓ごとに鳴らすと同一本文がベルを埋め、本物の fatal を押し出す。③画面が読めなければ **null**
  (生バッファに落とすと枠を認識できず**静かに失明**する)
  ⚠ **この卓はプールを走査する** ので **SDK 卓は見えない**。SDK 卓の等価物は `sdkDeskLimit.ts`
  (spawn 時に張るリスナ・イベント源で拾う)。文言判定と通知本文は共有するが、静穏窓/確認窓/
  3読み再武装は**持たない** — あれは「絵を読む」代償であって、CLI が言ってくるなら要らない。
- worker/司令官へ焼き込む**規約テキスト**(コードでなく文言が機構): `swarmDecisionRouting.ts`
  (**誰が**決めるか — 観測地図で宛先を仕分け)/ `swarmSpecialistReview.ts`(**どう**決めるか — 判断前に
  一次資料を取り込む・取得失敗は `【資料取得できず】` で degrade)。どちらも WORKER_ORDER_RULES
  (`swarmWorker.ts`)に追記され、後者は `skills/og-manage/SKILL.md`「マージ」手順4 とも同一正典。
  テスト: 同名 `*.test.ts` + `ogManageSkill.test.ts`(出荷 SKILL.md への verbatim 照合)
- worker/補給官の道具(`/order`・`/supply`・`/research` スキルと心拍 `swarm-beat.sh`+
  `openground-swarm-lib.sh`+調査診断 `openground-research-doctor.sh`+Canvas 撮影
  `openground-canvas-shot.mjs`(ライト/ダーク2枚・カード添付、2026-09-24))は
  `~/.claude/` へ boot 自動配備される: `managedFileInstall.ts`(og-manage/order/supply/script
  共通の idempotent installer — missing→install / marker+差分→refresh / marker無→kept-user)
  を `ogManageSkill.ts` と `swarmToolingInstall.ts` の両方が使う。正典テキストは repo の
  `skills/order/SKILL.md` `skills/supply/SKILL.md` `skills/research/SKILL.md`
  `scripts/swarm-beat.sh` `scripts/openground-swarm-lib.sh`
  `scripts/openground-research-doctor.sh`(tmux 依存ゼロ)。配備 seam は
  `server/index.ts` の boot IIFE(`installSwarmTooling()`)。テスト: `swarmToolingInstall.test.ts`
- 調査系カードのマルチプラットフォーム調査システム(Agent-Reach 蒸留、2026-08-13):
  `/order` スキルの調査系ゴール節が唯一のトリガ → doctor(ローカル専用診断・ネットワーク
  不実行は curl 囮で行動保証)→ `skills/research/SKILL.md` のルーティング表+フォールバック
  階段(専用ツール→Jina→素fetch)+Cookie ローカル限定則。正典 doc:
  `docs/RESEARCH_REACH_NOTES.md`、番人: `researchSystem.test.ts`
- Researchタブ(プロジェクトごとの調査ライブラリ、2026-08-14): `moduleRegistry` の常設
  native module('research')。`ResearchModule.tsx` ← `GET /api/research/reports|report`
  (`researchReports.ts` — docs/research/*.md 限定・文字種allowlist+realpath封じ込めの
  2層、レジストリ検証は route 側 requireProjectPath)。Markdown描画は依存ゼロの
  React node 直組み(innerHTML不使用・https限定リンク)。番人: `researchReports.test.ts`。
  共有(commons)構想の正典: `docs/RESEARCH_COMMONS_PLAN.md`
- 調査チャンネルの一般向け導線(2026-08-14): 設定→調査チャンネル =
  `SettingsPanel.tsx` ← `GET /api/research/channels`(`server/routes/research.ts` →
  `researchChannels.ts`、クロスプラットフォームPATH走査・非ネットワーク)+
  X Cookie ローカル保存 `researchAuth.ts`(0600・値はAPIから出ない・worker spawn で
  env 注入 — `swarmWorker.ts`)。素fetchベースライン(GitHub REST/Reddit JSON/
  フィード直読)はスキルと doctor 両方に採録。番人: `researchChannels.test.ts` /
  `researchAuth.test.ts`
- 罠: シェル補助の配備名は `openground-` 接頭辞つき(`SWARM_LIB_BASENAME`)。ユーザの
  `~/.claude/swarm-lib.sh` は**旧 tmux コックピット版(手書き・12 関数)で OG 管理外**、
  ~/.claude 配下の別スクリプト群が source している。同名で配備すると kept-user が外れた
  瞬間に 10 関数が消えて静かに壊れるので、**配備先はこの名前に戻さない**(回帰テスト
  `swarmToolingInstall.test.ts` の describe「legacy ~/.claude/swarm-lib.sh collision」)。
  `scripts/swarm-beat.sh` の source 行と `package.json` の `build.files` も同名で追随が要る
- コンテキスト圧縮の指示配備: `compactInstructionsInstall.ts` が native の
  `# Compact Instructions` セクションを **`~/.claude/CLAUDE.md`** へ入れる(圧縮ロジックは
  100% Claude Code 側・OG は文言配備だけ)。ファイル全体ではなく**マーカー付き block** を
  所有する `installManagedSection`(`managedFileInstall.ts` の2つ目の flavour)を使う —
  ユーザ自身が書くファイルなので、block 外は1バイトも触らない。追加は
  `settings.compactInstructionsInstalledAt` で**一度きり**(以後 block が無い=ユーザが消した
  =恒久 opt-out)、ユーザ自作の同名見出しがあれば `kept-user`。配備先が**プロジェクトの
  CLAUDE.md ではない**のは、OG がユーザの作業ツリーに書かない原則と、git 追跡ファイルを
  汚さないため。seam は `server/index.ts` boot IIFE。
  テスト: `compactInstructionsInstall.test.ts` / 実測は `docs/CONTEXT_MANAGEMENT_PLAN.md` §3-A2実測
- **タスク境界の自動 `/clear`**: `boundaryClear.ts`。**圧縮は 100% native(auto-compact)に委譲し、
  OG は独自の `/compact` トリガを持たない** — OG が足すのは native に見えない  OG は独自の `/compact` トリガを持たない**(**例外 1 つ・2026-09-18 オーナー決定**: 補給官の卓の
  早期圧縮 = 下の「常駐卓の文脈上限」)— OG が足すのは native に見えない
  「Board のカードが終わった」だけ。カードが `done` に**遷移**すると(`server/routes/project.ts`
  の setColumn/markDone/rework 経路)、そのカードに紐づくペイン(`TerminalInfo.taskId` —
  **cwd では解決しない**。同プロジェクトの無関係ペインを巻き込むため)へ
  `Ctrl-U` + `/clear` を送る。作業中(`working` / `menuOpen`)は**スキップせず待つ**(120s で expire)。
  `menuOpen` は `claudeStatus` が `waiting` を返すので status と別判定 — でないと権限プロンプトに打ち込む。
  auto-compact を OG が切っていないことは `autoCompactGuard.ts` + ソース走査の歯で固定。
- **常駐卓の文脈上限(2026-09-18)**: `deskContextCap.ts`(司令官の作り直し判定 — `swarmManager.launchNewDesk` が
  resume 前に呼ぶ)+ `supplyContextCap.ts`(補給官の卓へ空き時に `/compact` — engine 非依存の boot ループ)+
  `engineLogSink.ts`(卓コードからエンジンログへ1行 — orchestrator を import し返すと循環するための受け口)。
  閾値 = `Settings.deskContextCapTokens`(既定 300,000・0=無効・allowlist 済)。測定 = `claudeUsage.sessionContextTokens`
  (圧縮の境目が最後の返答より新しければ `postTokens` を返す)。罠: 補給官への書き込みは `noticeDeliverable` の3条件、
  自動の送り手はこの1つだけ(`autoCompactGuard.test.ts` が呼び出し元を固定)。正典 docs/commander/05 §10.6。
  テスト: `boundaryClear.test.ts` / `autoCompactGuard.test.ts` /
  `server/routes/__tests__/boundaryClearRoute.test.ts`(実ルート経由の end-to-end)。
  正典 = `docs/CONTEXT_MANAGEMENT_PLAN.md` **§7**
- 消費計測: `swarmTokenAudit.ts`(カード単位の 手数/束ね率/文脈max/出力・read-only)+ CLI
  `scripts/swarm-token-audit.ts`(`npm run swarm:audit`)。worker done 時に `consumption:` 行が
  journal に載る(orchestrator の promote 点・fail-safe で skip 可)。既定走査 = 全project の worker
  worktree + **実行元 repo(cwd)の司令卓**、期間指定は**ローカル日**基準。詳細 = commander/01 §9 末尾
- 罠: swarm コアに触れるカードは docs/commander/ 該当章の追随が完了条件(TARGET-STATE §6)。
  worker の git push は guard が機械 block(exit 2)。**サブエージェント費用は本体セッション JSONL に
  無い** — `<session-id>/subagents/**/agent-*.jsonl` を**再帰で**読む(`workflows/wf_*/` 配下が全体の1/3)。
  行内 `isSidechain` は本体に書かれないので、フラグ判定の集計は費用ゼロを報告する。

## 6. Collab — リアルタイム共同編集(Yjs / Cloudflare DO)
- server: `server/routes/collab.ts`(gate・ticket mint)/ `ticket.ts` / `src/lib/server/projectMembers.ts`
  (membership)/ `collabInvites.ts` / **mirror**: `collabMirror.ts` / `collabMirrorCore.ts` / `canvasCollabMirror.ts`
- client: `src/lib/collab/`(`ydoc` / `provider` / `yProvider` / `boardDoc` / `canvasDoc` / `assetSync` /
  `RealtimeContext.tsx`)
- リレー実体: `worker/src/`(`OgCollabDoc.ts` = CF Durable Object・membership・jwt)。
  デプロイは `worker/` で wrangler deploy(アプリ本体のビルドには含まれない)
- UI: `src/components/canvas/` の `CollabSharedDialog` / `SharedProjectBody` / `CollabInviteDialog` /
  `CollabPresence` / `CollabConsentDialog`
- 設計: `docs/COLLAB_CF_DO_PLAN.md`(+ COLLAB_PLAN / COLLAB_MEMBER_CLIENT_PLAN)
- テスト: `routes/__tests__/collab*.test.ts` 群 / `collabMirror.test.ts` / `src/App.collab.test.tsx`
- 罠: feature-gate OFF が既定(未設定なら inert)。共有中の Board / Canvas へのサーバ書込みは
  **必ず mirror 経由**(直書きは Y.Doc に巻き戻される)。

## 7. Auth・ロール — 任意ログイン(Supabase OAuth)
- `server/routes/auth.ts`(PKCE・google/github)/ `src/lib/server/supabaseAuth.ts` /
  `authStore.ts`(サーバ永続 session)/ `roles.ts`(og_roles 照会・owner 判定)
- client: `src/lib/auth/AuthContext.tsx`(`useAuth` — entitlement の単一 seam)/
  `src/components/canvas/AccountModal.tsx`
- 手順: `docs/AUTH_SETUP.md`
- テスト: `roles.test.ts` / `routes/__tests__/auth.test.ts` / `settingsSecurity.test.ts`
- 罠: ログインは任意 — 未設定でも `/api/auth/session` は 200 `{user:null}`(signed-out 扱い。
  503 は start/callback/signout の action route だけ)。全機能は普通に動き owner-gate だけ閉じる。
  ロール判定に email 焼き込み禁止(Supabase og_roles が正典)。

## 8. Electron・ビルド・配布
- `electron/main.js`(Hono fork・bootId health 照合・login-shell PATH 解決・single instance)
- `selfUpdate.js`(swarm 統合後の自己再ビルド+canary+rollback)/ `autoUpdate.js`(配布 update)/
  `lockdown.js` / `forkEnv.js` / `startup.js` / `preload.js` / `runtimeConfig.js` / `cacheReset.js`
- アプリメニュー + 手動アップデート確認: `electron/updateMenu.js`(メニュー雛形・確認の前提判定・
  結果の読み方・日英ダイアログ文言はすべて純関数)。main.js 側は `installApplicationMenu()` /
  `checkForUpdatesInteractive()` / `promptRestartForUpdate()` だけ。**メニュー表記は英語固定**
  (macOS がシステム言語で描く About/Services/Edit と混ざるため)、**ダイアログだけ
  settings.language に追随**。既定メニューを置き換えるので `role: 'editMenu'` 等を落とすと
  ⌘C/⌘V が消える — テストが見張る(`server/__tests__/updateMenu.test.ts`)
- 「更新が終了したのに入らない」: `electron/updaterLog.js`(全更新ログ → `~/.openground/updater.log`・
  pending marker `update-pending.json` を次回 boot で照合・自己修復の1回券 `update-recovery.json`)+
  `electron/shipIt.js`(macOS の入れ替え係 = Squirrel.Mac の launchd ジョブ `<appId>.ShipIt` の
  読み取りと判定はすべて純関数)。main.js 側は `probeShipIt` / `shipItPreflight` /
  `armInstallSelfRepair` / `kickstartShipItBeforeExit` / `relaunchUnarmedStagedInstall` だけ =
  `launchctl` はここでしか動かない(ただし `relaunchUnarmedStagedInstall` は launchctl を叩かない —
  普通の ⌘Q で当たる更新にも「終わったら開き直す」指示だけ書く。オーナー決定 2026-09-22)。
  罠: ジョブは **disabled でなくても走らない**ことがある(submit した dict に RunAtLoad が無く、
  Squirrel 自身の XPC トリガーが空振りする)。⚠ **pre-flight で kickstart しないこと** — ①
  pre-flight は staging 待ちより前に走るのでジョブがまだ無いことがある ②
  `launchAfterInstallation=YES` は `quitAndInstall` の中でしか付かないので、ここで起こすと
  「入れ替わるが再起動しない」インストールになる。起こすのは `will-quit` の1箇所だけ。
  boot の自己修復も「その場で起こす」のではなく **次の終了に予約**する
  (稼働中に起こすと ShipIt が待機し、手動で入れた新しい版を古い staged で上書きし得る)。
  ⚠ ただし**その待機は保証されない**(0922 実測)。終了待ちは `SQRLTerminationListener` が
  起動の一瞬だけ running-app 一覧を1回引くだけの判定で、そこで外すと**稼働中のアプリの
  バンドルをそのまま入れ替える**。唯一の安全網(`SQRLInstallerErrorAppStillRunning`)も
  同じ判定式なので同時に空振りする。しかも ShipIt を起こすのは staging
  (=`quitAndInstall` ではない)で、launchd はその submit から**遅れて**ジョブを走らせ得る
  (0922 実測で 11分11秒後・kickstart なし)。実測と一次資料は
  `docs/SHIPIT_LIVE_SWAP_0922.md`。
  ⚠ この2ログは**タイムゾーンが違う** — `ShipIt_stderr.log` はローカル(JST)、
  `updater.log` は UTC(`…Z`)。並べて読むときは必ず9時間ずらす。
  staged 版の判定は **`ShipItState.plist`(中身は JSON)の `updateBundleURL`** から取る —
  `update.*` の走査は別ビルドを掴む/取りこぼす。
  **判定は必ず「現状維持へ倒す」**(終了して何も入らないより、入れ替えを諦める方が安全)。
  経緯の正典は `docs/DISTRIBUTION.md`
- ビルド: `scripts/build-server.js`(esbuild → `server/dist/index.cjs`)/ vite → `dist-web/`。
  署名: `scripts/sign-and-notarize.sh` / `verify-dmg.sh`
  ⚠ **CJS バンドルには `import.meta` が存在しない**(esbuild が `{}` に置換)。dev(tsx/ESM)と
  vitest(ESM)では動き、**配布版だけ壊れる**ので、テストからは原理的に見えない。0801 にこれで
  「出荷版では SDK worker が1体も立たない」を作った(`dd311acc`・詳細は §5)。
  今は banner で `pathToFileURL(__filename).href` を define して**本物の file URL を与える**。
  ⚠ **CJS バンドルは ESM 専用パッケージを `require()` できない**(Electron 31 = Node 20.18、
  `require(esm)` は Node 20.19/22.12 以降)。0802 にこれで「配布版では SDK ランタイムが
  一度も起動しない」を作った(`e26d5efb`・0.11.47/0.11.48 出荷済み)。`import()` なら読める —
  **esbuild は external かつ target=node20 では `import()` を `require()` に書き換えない**
  ので小細工は不要(target を下げる/external から外すと書き換えが復活する)。`buildOptions`
  はこのスクリプトから **export** してあり、番人 `sdkEsmLoadFromCjsBundle.test.ts` が
  **本番と同一の options で**バンドルして .cjs を実行する。
  ⚠⚠ **`logOverride` で esbuild の警告を黙らせるときは、その警告が将来の読み手も覆うと考える**。
  `empty-import-meta` の沈黙は、追加した当時は正しかった(唯一の読み手が死んだ枝だった)が、
  後から生えた生きた読み手をそのまま覆った。番人 = `src/lib/server/sdkGuardBundleShape.test.ts`
- 配布: `docs/DISTRIBUTION.md` — 2リポ構成(origin=PMmap 開発・open-ground 公開、tag vX.Y.Z で CI)
- テスト: `server/__tests__/`(selfUpdate / autoUpdate / forkEnv / startup / electronLockdown …)
- 罠: `electron/*.js` は純 CommonJS — 触ったら `node --check`。asar:false は node-pty の制約で
  意図的。ポート 5174/47776 は不可侵 — 2本目の dev は `npm run dev:alt`。
- Runtime selection was removed for everyone on 2026-09-21. New managers and
  workers are SDK-only; supply/ordinary terminals remain PTY-based. Retired
  settings POSTs are ignored while legacy data is preserved
  (`settingsRuntimeDials.test.ts`). Coverage: `swarmManagerFailFast.test.ts`,
  `swarmManager.spawn.test.ts`, `swarmSessions.integration.test.ts`,
  `SwarmManagerPane.test.tsx`. Current contract: `commander/SIMPLIFICATION.md`.
- 罠(2026-07-31 実観測): **`node_modules/electron/dist/Electron.app` が macOS に
  マルウェア判定されてゴミ箱に消える**。`npx electron` は SIGKILL → 直後に `.app` が消滅、
  再展開しても同じ(zip 自体は正規 — `checksums.json` の SHA-256 と一致)。未 notarize の
  Electron 31 に対する XProtect の誤検知で、**署名+notarize 済みの配布 .app は無関係**。
  つまり `npm run electron:dev` はこの機体では起動しない — メニューまわりの検証は
  Electron を起動せず純関数テストで行う(それが `updateMenu.js` を純関数に割った理由でもある)。

## 9. i18n — 日英バイリンガル
- `src/i18n/I18nContext.tsx`(provider)+ `src/i18n/messages/`(領域別辞書: board / canvas /
  projectPanel / settings / toolbar …)。テスト: `src/i18n/messages.test.ts`
- 言語判定ヘルパ: `src/lib/server/promptLang.ts` / `src/lib/descriptionLang.ts`(client/server 共用)/
  `src/lib/releaseNotesLang.ts`(かな検知で ja/en)
- アプリ内マニュアル: `src/components/canvas/manual/`(バイリンガル・9系統)
- 罠: IME 2大対策 — 制御 textarea は変換中に値を凍結・Enter ハンドラは変換確定 Enter を奪わない。
  挙動を変えたら messages/ とマニュアルの両方を追随。

## 10. Custom modules — ユーザー製タブ
- server: `server/routes/customModules.ts` + `src/lib/server/customModules.ts`
  (`~/.openground/custom-modules/` 読込・hot-reload)
- client: `src/components/canvas/moduleRegistry.tsx` — **タブセットの single source of truth** /
  `src/lib/modules/`(descriptor / ids / tabOrder / customTabAttach / useCustomModules / useExperiments)
- UI: `modules/CustomFrameHost.tsx`(sandbox iframe host)/ `CustomTabPickerDialog` /
  `CustomTabCreateDialog` / `CustomModuleView` (full-width preview, no terminal dock).
  Creation no longer launches or pastes into a side terminal. Existing terminal
  bindings are left untouched except by explicit module-deletion cleanup.
- NENE input recording: `src/lib/localAppFrame.ts` resolves the explicit
  `localApp: 'nene-songs'` capability to a fixed, separate loopback origin.
  Only that direct frame receives microphone permission; arbitrary sources
  remain opaque. Tests: `localAppFrame.test.ts`, `CustomFrameHost.test.tsx`,
  `e2e/nene-recording-frame.spec.ts` (real getUserMedia with fake input only).
- 設計: `docs/CUSTOM_TABS_PLAN.md` (current local-only contract)
- テスト: `customModules*.test.ts` / `routes/__tests__/customModules` ・ `retiredMarketplace.routes` ・ `customModuleTerminal`
- 罠: hot-reload はタブ hidden 中は停止する仕様。編集ロールは Supabase og_roles(§7)。
- Distribution retired 2026-09-20: no market, publish, submission or review routes.
  Existing installed sources and their original role restrictions remain intact.

## 11. 小さい領域(1行ずつ)
- feedback: `server/routes/feedback.ts` + `src/components/canvas/FeedbackModal.tsx` + `src/lib/feedbackImages.ts` —
  anon insert-only。**読み側 sanitize 必須**(anon は任意 JSON を書ける)
- usage 予算: `src/components/canvas/UsageHud.tsx` + `src/lib/server/claudeUsage.ts` / `claudeUsageCli.ts` +
  `src/lib/usageThresholds.ts`(80黄/100赤)— ゲージを新設しない・これを使う
- SSE 基盤: `server/routes/sse.ts` + `src/lib/sseReconnect.ts`
- skills: `src/lib/server/projectSkills.ts`(per-project `.claude/skills/`)/ `generateSkill.ts`
  (グローバル生成)+ `src/components/canvas/` の `GlobalSkillsPanel` / `SkillsModal`
- sandbox 実験: `src/lib/server/sandbox.ts`(sandbox-exec 包囲・experiments.sandbox)—
  SBPL の落とし穴は `docs/SANDBOX_EXPERIMENT.md` 必読
- lockdown: `src/lib/server/lockdown.ts` + `src/lib/lockdownClient.ts` + `electron/lockdown.js`
  (srcdoc 側の検証は `src/lib/srcdocLockdown.test.ts`)
- 実験 gate: `src/lib/server/experiments.ts` + `src/lib/modules/useExperiments.ts`(Swarm タブ等の owner 限定機能)
- 通知: `src/components/canvas/` の `NotificationBell` / `NotificationPanel` +
  `src/lib/server/osNotify.ts`(swarm 由来は `swarmNotifications.ts` → commander/06)
- deep link: `src/lib/deepLink.ts` + `useJoinDeepLink.ts`(招待リンク)
- playback: `src/lib/playback/playbackStore.ts` + `src/components/canvas/PlaybackEq.tsx`
- onboarding: `src/components/Onboarding.tsx`
- **燃料の測定**(トークン消費の前後比較): `scripts/fuel-mark.ts`(読み取り専用・要ローカル起動)
  + 手順は `docs/trending/TRIALS.md` の「燃料の測定を始めて」節。オーナーがこの言葉で頼む。
  スイッチは `Settings.workerTrials`(設定→詳細設定)。テスト: `server/__tests__/fuelMark.test.ts`
- trending 取り込み: `scripts/trending-intake.ts` → `docs/trending/INDEX.md` / `DETAILS.md`
  (+ `scripts/trending-cost-scan.ts` → `signals.json`: ライセンスと課金の実測。**無料のみ** = オーナー決定 2026-09-22)
  (**生成物・手で直さない**)+ `docs/trending/OG-CANDIDATES.md`(手書きの採否判断)—
  sns-hub の毎朝の GitHub Trending 投稿(`nannantown/github-trending-video`)の git 履歴から
  紹介済み 298 リポジトリを復元した索引。OG に入れるか迷ったらまず OG-CANDIDATES を読む
  (既存オーナー決定と衝突する候補・有料の候補が理由付きで却下済み)。
  テスト: `server/__tests__/trendingIntake.test.ts` / `trendingCostScan.test.ts`

## 12. テストと完了ゲート
- unit/integration: vitest(`npm test`・約7300)。同名 `*.test.ts(x)` 同居 +
  `server/routes/__tests__/`(route 面)+ `server/__tests__/`(electron 面)
- **HOME 隔離(fail-closed・2026-07-19 根治)**: fence 本体 = `src/lib/server/testHomeGuard.ts`
  (`assertTestHomeIsolated`)。choke point = `paths.ts` `openGroundHome()` — テスト中に解決先が
  tmpdir 配下でなければ **throw(読み取りも例外にしない)**。homedir アンカーの `hooksInstall.ts`
  (`guardedHomedir`)だけは構造的に choke point 外なので同じ fence をミラー。pin と犯人特定 =
  `src/test/setup-home.ts`(+ `setup-dom.ts` / `registerProject.ts`)。回帰 = `testHomeGuard.test.ts`
  **落とし穴 — `tmpdir()` の実体が OS で違う**: `tempRoots()` は非 win32 で `/tmp` を
  ハードコードで足すので、Linux(CI)では「実 tmp の中に建てた不安全ホーム」が安全と判定され、
  macOS(`/var/folders/…`)でだけ緑になる。temp まわりの teeth は必ず `TMPDIR=/tmp` でも回すこと
  (7 リリース分 CI で赤のまま気づかれなかった実績 — [07 章 §4.15](commander/07-test-isolation-contract.md))
- **作業ツリー隔離**(守る対象が違う): `src/test/repoRootFence.ts`(`setup-home.ts` が装着)。
  毎テスト後に repo 直下を listing 比較し、`.gitignore` が覆わない新規エントリで落とす —
  dirty ツリーは swarm 統合を止めるため。repo 直下に throwaway を作ってよいのは
  `REPO_PROBE_PREFIX`(= `.og-fence-probe-`・同 file が単一宣言)配下のみ
- **静的ガード = `src/testHomeEnvGuard.test.ts`**(fence とは別レイヤの再発防止 sweep・52 件)。
  ①home var の unset 復活 ②`~/.openground` の第2解決式 ③**`~/.claude` アンカー 38 件の
  常設インベントリ**(tier = fenced / read-only / writes-elsewhere・各主張をソースから毎回検証。
  新しいアンカーは UNDECLARED で赤)。**列挙は 1 本**(`repoSourceFiles` → 拡張子判定は
  git の pathspec でなく JS 側 `SOURCE_EXT`)で、③は repo 全体、①②は `SWEPT_DIRS` ∪ repo 直下
  (`vitest.config.ts` は setupFiles を配線する = ガードを arm する当のファイル)。
  ①②は 2026-07-21 まで拡張子と綴りで非対称だった(→ §4.14)。`~/.claude` を新しく名指ししたら
  `CLAUDE_ANCHORS` に宣言する — 詳細・敵対レビュー2ラウンドで塞いだ回避9綴りと誤検出3件・
  teeth 32 件は `docs/commander/07-test-isolation-contract.md` §3.1
- 罠(実害あり): 旧 setup-home のガードは**トートロジー**で、2026-07-18 に vitest が本番
  `settings.json` を上書き(登録 45 件→3 件・`canvas.json` 永久喪失)。`delete process.env.OPENGROUND_HOME`
  は**書かない**(保存値を復元する)。契約と teeth 実測 = `docs/commander/07-test-isolation-contract.md`。
  実機確認は test プロジェクトで
- 罠(2026-07-20): repo 直下への書き込みを**ソースを読んで**止めるガードは、綴りを変えるだけで
  素通りする(実測 4 通り)。全称主張は付けられない — 網羅したいなら**残骸(結果)**を見る。
  §4.13
- e2e: `e2e/*.spec.ts`(playwright — build + prod boot して :47776 を叩く)+ `playwright.config.ts`
- **完了ゲート3点セット**: `npx tsc --noEmit` / `npm test` / `npm run lint` — tsc は test/lint が
  捕捉しない型エラーを捕る(必須)
- 罠: vitest を mid-run で kill しない(遅い≠ハング。親だけ kill すると forks が孤児化して暴走)。
