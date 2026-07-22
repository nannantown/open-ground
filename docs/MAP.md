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
- 罠: API 契約の落とし穴(フル UUID 必須・列名・短縮 id 黙殺の歴史)は
  `docs/commander/05-board-api-contract.md`。collab 共有中は Y.Doc が権威 — サーバ側の Board
  書込みは collabMirror 経由でないとクライアントに巻き戻される(→ §6)。

## 3. Terminal(PTY)— 唯一の実行経路
- `src/lib/server/terminal.ts` — node-pty pool。`globalThis.__openground_terminal` で
  tsx watch reload を生存(新規 in-memory 状態もこのパターンを踏襲する)
- `claudeTerminal.ts`(`launchClaude` — claude PTY 起動・`--session-id`・taskWorktrees の
  `--add-dir` 事前許可)/ `pastePrompt.ts`(bracketed paste・UNSENT 挿入)/ `cliResolve.ts`(claude 実体解決)
- `claudeConnection.ts` / `claudePreflight.ts` / `terminalProjects.ts`(active 一覧→Ground beacon)/
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
  `EmbeddedClaudeTerminal.tsx` / `TaskTerminal.tsx`
- テスト: `terminal.test.ts` / `claudeTerminal.test.ts` / `routes/__tests__/paste*.test.ts` / `runTaskLaunch.test.ts`
- 罠: subscription-only — API key 経路を作らない・提案しない。描画性能(WebGL / coalescing /
  ACK フロー制御)は設計契約がある — `TerminalPane.tsx` / `terminal.ts` のコメントを読んでから触る。

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
- **診断・改修の前に `docs/commander/00-INDEX.md`**(症状→章の直行表)。理想形 = `TARGET-STATE.md`。
  安全不変条件 = `docs/SWARM_SAFETY_INVARIANTS.md` + `src/lib/server/swarmSafety.test.ts`(触る前に緑確認)
- 入口だけ: `swarmOrchestrator.ts`(エンジン tick)/ `swarmWorker.ts` / `swarmLaunch.ts`(spawn・
  モデル/effort/リモコン名解決)/ `swarmIntegrate.ts` / `swarmOverseer*.ts` / `swarmEscalations.ts` /
  `swarmQuota.ts` / route: `server/routes/swarm.ts` / UI: `modules/SwarmModule.tsx` + `useSwarmEngine.ts`
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
- worker/司令官へ焼き込む**規約テキスト**(コードでなく文言が機構): `swarmDecisionRouting.ts`
  (**誰が**決めるか — 観測地図で宛先を仕分け)/ `swarmSpecialistReview.ts`(**どう**決めるか — 判断前に
  一次資料を取り込む・取得失敗は `【資料取得できず】` で degrade)。どちらも WORKER_ORDER_RULES
  (`swarmWorker.ts`)に追記され、後者は `skills/og-manage/SKILL.md`「マージ」手順4 とも同一正典。
  テスト: 同名 `*.test.ts` + `ogManageSkill.test.ts`(出荷 SKILL.md への verbatim 照合)
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
- ビルド: `scripts/build-server.js`(esbuild → `server/dist/index.cjs`)/ vite → `dist-web/`。
  署名: `scripts/sign-and-notarize.sh` / `verify-dmg.sh`
- 配布: `docs/DISTRIBUTION.md` — 2リポ構成(origin=PMmap 開発・open-ground 公開、tag vX.Y.Z で CI)
- テスト: `server/__tests__/`(selfUpdate / autoUpdate / forkEnv / startup / electronLockdown …)
- 罠: `electron/*.js` は純 CommonJS — 触ったら `node --check`。asar:false は node-pty の制約で
  意図的。ポート 5174/47776 は不可侵 — 2本目の dev は `npm run dev:alt`。

## 9. i18n — 日英バイリンガル
- `src/i18n/I18nContext.tsx`(provider)+ `src/i18n/messages/`(領域別辞書: board / canvas /
  projectPanel / settings / toolbar …)。テスト: `src/i18n/messages.test.ts`
- 言語判定ヘルパ: `src/lib/server/promptLang.ts` / `src/lib/descriptionLang.ts`(client/server 共用)/
  `src/lib/releaseNotesLang.ts`(かな検知で ja/en)
- アプリ内マニュアル: `src/components/canvas/manual/`(バイリンガル・9系統)
- 罠: IME 2大対策 — 制御 textarea は変換中に値を凍結・Enter ハンドラは変換確定 Enter を奪わない。
  挙動を変えたら messages/ とマニュアルの両方を追随。

## 10. Custom modules — ユーザー製タブ+マーケット
- server: `server/routes/customModules.ts` + `src/lib/server/customModules.ts`
  (`~/.openground/custom-modules/` 読込・hot-reload)/ `customModulesMarket.ts` /
  `customModulesSubmissions.ts` + `server/routes/moduleSubmissions.ts`(投稿・審査)
- client: `src/components/canvas/moduleRegistry.tsx` — **タブセットの single source of truth** /
  `src/lib/modules/`(descriptor / ids / tabOrder / customTabAttach / useCustomModules / useExperiments)
- UI: `modules/CustomFrameHost.tsx`(sandbox iframe host)/ `CustomTabPickerDialog` /
  `CustomTabCreateDialog` / `MarketplaceDialog` / `ModuleReviewInbox`
- 設計: `docs/CUSTOM_TABS_PLAN.md` / `MODULE_SUBMISSIONS_SETUP.md`
- テスト: `customModules*.test.ts` / `routes/__tests__/customModules` ・ `moduleSubmissions` ・ `customModuleTerminal`
- 罠: hot-reload はタブ hidden 中は停止する仕様。審査ロールは Supabase og_roles(§7)。

## 11. 小さい領域(1行ずつ)
- feedback: `server/routes/feedback.ts` + `src/components/canvas/FeedbackModal.tsx` + `src/lib/feedbackImages.ts` —
  anon insert-only。**読み側 sanitize 必須**(anon は任意 JSON を書ける)
- usage 予算: `src/components/canvas/UsageHud.tsx` + `src/lib/server/claudeUsage.ts` / `claudeUsageCli.ts` +
  `src/lib/usageThresholds.ts`(80黄/100赤)— ゲージを新設しない・これを使う
- SSE 基盤: `server/routes/sse.ts` + `src/lib/sseReconnect.ts`
- skills: `src/lib/server/projectSkills.ts`(per-project `.claude/skills/`)/ `generateSkill.ts`
  (グローバル生成)+ `src/components/canvas/` の `GlobalSkillsPanel` / `SkillsModal`
- you-corpus: `server/routes/youCorpus.ts` + `src/lib/server/youCorpus.ts`
  (`~/.openground/you-corpus.md` 0600・破損は .corrupt 退避)。UI は
  `src/components/canvas/modules/PersonaModule.tsx`(ペルソナタブ・owner 限定
  `experiments.persona`)— 手動追記のカード一覧は `GET /api/you-corpus/judgments`。
  **訂正=追記**(編集も削除も経路が無い・元の記述は新しい記述の `context` に引用され、
  `correctsId` に元の id が入る)。**読めない≠無い**: additions の読みは ENOENT のみ
  空扱い、他の errno は throw(読み手を tolerant に戻すと `/judgments` が 200 `[]`・
  status が manualCount 0 を返し、タブが満杯のコーパスに「まだ何もありません」を出す。
  assemble に至っては判断を落とした本文で上書きする)。UI 側も読み込み失敗時は空状態を
  出さない
- シナプス網(ペルソナタブ「マップ」): `src/lib/personaGraph.ts`(純関数・
  エッジ規則=correctsId/共有タグ/72h以内の日付近接・優先順位はこの順で
  弱い規則を上書きしない)+ `src/components/canvas/modules/PersonaGraphView.tsx`
  (pan/zoom は InfiniteCanvas と同じ `{x,y,zoom}` viewport の型に倣った専用軽量実装・
  重量級グラフライブラリは追加していない)。ノードは既存の
  `GET /api/you-corpus/judgments` の `ManualJudgment[]` そのもの(取材ループの回答も
  escalation の回答も、答えた時点で `appendJudgment` 経由でこのリストに載るので
  別データソースは不要)。読み取り専用 v1(グラフからの編集経路は無い)。
  `PersonaModule.tsx` 内の list/graph トグル(既定は list)で切替、既存の一覧表示は
  変更していない。
- 取材ループ(ペルソナタブ「今日の1問」): `src/lib/server/personaInterview.ts` +
  `/api/you-corpus/interview`(POST=生成込み・GET=純読み)/`…/answer`/`…/skip`。
  状態は `~/.openground/persona-interview.json` 0600。**claude を起動しない** —
  生成はオーナーの実データに対する決定論的テンプレ穴埋め(`claude -p` 禁止の repo 規約
  下では LLM 化は PTY 1セッション/日を意味する。それ以上に、①材料が無ければ質問を
  出さない=汎用診断質問が構造的に作れない ②**カードには移動/承認の「時刻」が無い**
  (`createdAt`・現在の列・耐久フラグ `reworkCount`/`selfSupplyApproved` はあるが、
  それが**いつ**起きたかは無い)ので、LLM に board を渡すと「昨日 done にした」等の
  検証不能な断定を書く)。速さを問えるのは escalation だけ(4時刻を持つ)。
  **落とし穴6つ(すべて敵対レビューで実再現・回帰テスト済み)**:
  ⓪**プロジェクト同一性は registry UUID・名前は同一性ではない** — basename も
  `displayName`(型定義が「purely cosmetic」と明記)も一意でなく、`~/work/api` と
  `~/oss/api` は同時登録できる。名前でグルーピングすると無関係な2repoのカードが
  対にされ「起きていないレース」を断言し、それが corpus に恒久記録される。
  `BoardCard` は名前フィールドを**持たない**(キーに使えない名前を置くこと自体が罠)。
  検証は実 sweep 経由で — 別名 fixture のテストは空振りする
  ①**検出器は必ず全ヒットを順位付きで返す** — 上位1件だけ返すと、動かない保留カードの
  top hit は永遠に top のままで、一度聞いた時点でその kind が恒久沈黙する(保留10枚で
  生涯1問だけ、が実測値) ②**カード年齢を「列に居た時間」として描かない** — 差し戻し
  上限超過の経路は `createdAt` を触らずに blocked へ落とすので「40日保留のまま」は捏造。
  「40日前に作った」と書く ③**answer/skip は state ロック必須** — corpus 書き込みの
  await を挟むので、日付跨ぎで `lastAskedDate` が巻き戻り新しい質問が消える/同時回答で
  corpus に二重書き。全検出器が throw した場合は空状態を騙らず fail loud
  ④**「今日は聞くことがない」は完全な読み取りが要る** — 素材収集の失敗を握り潰すと、
  一件も読めていないのにオーナーの記録について断言し、さらに `lastAskedDate` を焼いて
  翌日まで再試行しない(③の fail loud と非対称なガードだった)。`InterviewMaterial.complete`
  が false かつ候補ゼロなら throw・日を焼かない(route 500 → タブは断言せず非表示)。
  候補が出た場合は部分 sweep でも聞く(1プロジェクトの破損で全体を黙らせない)。
  ただし上流リーダーは寛容なので、壊れた `tasks.json` は「失敗」でなく**空**として
  読まれる — `complete` が見えるのは実際に throw する故障だけ
  ⑤**共有の stale フラグを回答の確認文に流用しない** — メモ欄と共有のため、失敗した
  メモが後続の成功した回答の確認文を書き換える。回答は専用 state を持つ。
  同じ観測は `askedSubjects` で二度聞かない・kind は使用回数の少ない順に自動ローテ。
  回答は escalation 書き戻しと**同じ文面**(`Q:` / `→ オーナーの回答:`)で
  `appendJudgment` へ — corpus 側で1つの声に見えるため。`meta.skipped`(保存できたが
  corpus 再構築失敗)は `corpusStale` として UI まで運び、確認文自体を
  `interview.answeredStale`(「まだ分身に渡っていません」)に差し替える — 警告を横に
  出すだけでは「分身が覚えました」の嘘が消えないため(否定アサーションでピン)。文言方針(汎用診断質問の禁止)は **エクスポートした `DETECTORS` を列挙**
  してピン — 検出器を足して CASE を足さないとテストが落ちる(旧版は固定6問にしか
  BANNED を当てておらず、レビューで quiz 検出器を足しても92件全緑=歯が無かった)
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

## 12. テストと完了ゲート
- unit/integration: vitest(`npm test`・約4100)。同名 `*.test.ts(x)` 同居 +
  `server/routes/__tests__/`(route 面)+ `server/__tests__/`(electron 面)
- **HOME 隔離(fail-closed・2026-07-19 根治)**: fence 本体 = `src/lib/server/testHomeGuard.ts`
  (`assertTestHomeIsolated`)。choke point = `paths.ts` `openGroundHome()` — テスト中に解決先が
  tmpdir 配下でなければ **throw(読み取りも例外にしない)**。homedir アンカーの `hooksInstall.ts`
  (`guardedHomedir`)だけは構造的に choke point 外なので同じ fence をミラー。pin と犯人特定 =
  `src/test/setup-home.ts`(+ `setup-dom.ts` / `registerProject.ts`)。回帰 = `testHomeGuard.test.ts`
- **作業ツリー隔離**(守る対象が違う): `src/test/repoRootFence.ts`(`setup-home.ts` が装着)。
  毎テスト後に repo 直下を listing 比較し、`.gitignore` が覆わない新規エントリで落とす —
  dirty ツリーは swarm 統合を止めるため。repo 直下に throwaway を作ってよいのは
  `REPO_PROBE_PREFIX`(= `.og-fence-probe-`・同 file が単一宣言)配下のみ
- **静的ガード = `src/testHomeEnvGuard.test.ts`**(fence とは別レイヤの再発防止 sweep・51 件)。
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
