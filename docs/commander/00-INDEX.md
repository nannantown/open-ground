# 00 — INDEX: 司令塔文書の入口(読む順・メンタルモデル・十戒・表示の信頼度)

**対象コミット: `0d1f7f0`**(origin/main tip、2026-07-10)。章ごとの行番号基準が**2 つ**ある:
**03/06 章と TARGET-STATE は `0d1f7f0`** — 同日 main 入りの根治 3 件(`3129a58` = レビューの diff 連動 budget + 棄権理由、`d8431c3`+`aa9cb8d` = S3/S10 再投函根絶、`0d1f7f0` = quota 検知 21 分遅延の根治)を反映・リナンバー済み。
**01/02/04/05 章は `cc7c60e` のまま** — 根治 3 件が `swarmOrchestrator.ts`(6349→6730 行、:355 以降が +38〜+381 シフト)/ `swarmOverseer.ts` / `swarmEscalations.ts`(:250 以降 +36)/ `types.ts`(:1147 以降 +7)を変えたため、これらのファイルへの行番号参照はずれている可能性がある(:354 以前の orchestrator 参照と、terminal.ts 等それ以外のファイル参照は有効)。**01 章 TL;DR#3・§6(monitor 飢餓)と 04 章 §3.2/3.3/3.6(検知 3 因子)は `0d1f7f0` で機構ごと過去の姿になった** — 両章に部分注記済み、現行の姿は 03 章 §2.1/§2.4 と TARGET-STATE §1。疑ったら現物優先(§6-1)。
**例外(2026-07-12・会話 resume)**: 05 章 §6.2 の `/api/swarm/*` 行番号と 04 章 §2.6 の manager/supply 行番号は、resume 実装時に**現物から実測し直して更新済み**(`server/routes/swarm.ts` は +17 シフトしていた)。05 章に **§10(会話 resume)** を追加。それ以外の 04/05 の参照は依然 `cc7c60e` 基準。
**追記(2026-07-15・マネージャ専任化 — 中核転換)**: **エンジンは統合をやめた。** review に ready カードが来たら engine は**司令官(manager)を起こすだけ**で、verify も敵対レビューも FF push も掃除も一切しない — 統合(重量級レビュー + 手動 FF push)は司令官の専任になった。同日の事故(autoMerge が司令官の差し戻しと並行で穴あきブランチを main に FF 統合 + engine のレンズ 4 票 clean が auth の camelCase 取りこぼしを見逃した)を受けた**構造的**役割分離で、**エンジンのレンズ結果だけで main が動く経路は金輪際ゼロ**(回帰テストで固定)。**03 章が全面改訂され、§2.3.1〜§3(旧 land 機構: verify/高リスク force-hold/敵対レビュー/差し戻し/conflict 委譲/凍結)は HISTORICAL** — engine はもうやらない(撤去 or 司令官の手動統合 §5 に一本化)。autoMerge トグルの意味も「エンジンが統合」→「worker が ready で司令官を自動起こし」に変わった(UI/i18n 追随済み)。TARGET-STATE §5 も新理想へ書き換え済み。**(直前の 2026-07-15 高リスク force-hold 追記は、この転換で engine 側は HISTORICAL 化 — 高リスク判定は司令官の手動統合規約側に残る。)**
**追記(2026-07-16・autoMerge トグル廃止)**: 上の「自動起こし」トグルは**廃止**され、**エンジン ON で常時セット**になった(「エンジン ON・起こし OFF」の中途半端な既定が ready 品の滞留を生んだため — 実運用で観測)。`engine.autoMerge` フィールド・`POST /api/swarm/orchestrator/automerge`(404 化・回帰テストでピン)・UI トグル・i18n は全撤去。`GET /api/swarm/orchestrator` のレスポンスからも `autoMerge` が消えた(`src/lib/types.ts` 追随済み)。統合の同意粒度はカード単位([hold] + 司令官の高リスク force-hold)が担う。正典は 03 章 TL;DR#3・§2.3。**01/02/05/06 章に残る `autoMerge` 言及(GET の jq 例・02 章の cleanup 経路 6・01 章 §2 の flag 表など)は撤去前の姿**で、これらの章は基準コミットが古いまま(冒頭注記どおり)— 個別更新はせず本注記で一括カバーする(実行しても `autoMerge` フィールドが出ない/route が 404 なだけで害はない)。
**追記(2026-07-18・リモコン名の識別化)**: swarm 3 役の `--remote-control` セッション名が固定文字列(`manager`/`worker`/`supply`)から**識別名**になった — スマホ / claude.ai の一覧に同名が大量に並び区別不能だったオーナー直接フィードバックの根治。JA「マネージャー / ワーカー / タスク窓口 <プロジェクト表示名>[: <カードtitle要約>]」/ EN "Manager / Worker / Supply officer …"(言語=`Settings.language` を spawn 時に読む・表示名=registry `displayName`‖フォルダ名 — git リポ名ではない・空白正規化+60 code point 切詰め・解決失敗は旧固定名へ fail-open で spawn は通る)。名前制約は実測済(CLI 2.1.214: 日本語/スペース/長名すべて受理)。正典は `swarmLaunch.ts` の `swarmRemoteControlName` / `resolveSwarmRemoteName` と 02 章 §2.4(更新済)。この追加で `swarmLaunch.ts` の行番号が全体にシフト(`SWARM_LAUNCH_MODEL` :52→:70 など)— 01/03/04 章に残る swarmLaunch.ts 行番号参照は旧基準のまま(参照先の意味は不変・本注記で一括カバー)。
**追記(2026-07-18・UI 表示文言のナチュラル統一 — docs/commander は不触の判断)**: OG 画面側の role 表記を JA=マネージャー/ワーカー/タスク窓口・EN=Manager/Worker/(supply は既存訳 Supply officer のまま)へ統一した(`src/i18n/messages/projectPanel.ts` の badge/label/hint 群、アプリ内マニュアル、`swarmOrchestrator.ts`/`selfUpdateOnIntegrate.ts` のログ・通知 detail 文言)。**docs/commander/ 本体・skills/og-manage は本カードの対象外で不触** — この文書群の「司令官/補給官」は UI 表示文言ではなく、エンジンの内部役割を指す技術語彙として全章で一貫使われており(コード識別子 `CommanderPresence` 型・`commanderPresence()`・`CommanderCommandBar` 等と対で読む前提)、ゴール自身が「docs/commander の技術文書は変更しない」と明示している。表示側とドキュメント側で語彙が乖離する形になるが、意図した分離(表示文言のみ統一・技術文書は現状の語彙を正典として維持)。
**追記(2026-07-19・本番 HOME 保護 — 07 章新設)**: **2026-07-18、vitest の実行がオーナーの実 `~/.openground/settings.json` を上書きし、登録プロジェクトが 45 件 → 3 件に消滅した**(`canvas.json` のカード配置はバックアップ無しで永久喪失)。原因は 3 つ同時: ①`src/test/setup-home.ts` の安全装置が**トートロジー**(`join(tmpdir(),…)` で作った値を `startsWith(tmpdir())` で検査 = 絶対に発火しない)②`openGroundHome()` が呼び出し毎に env を読むため `OPENGROUND_HOME` が消えた瞬間から**全読み書きが黙って本番へ**向かう ③`delete process.env.OPENGROUND_HOME` が 17 箇所(無条件 4)で封じ込めを vitest の `isolate:true` だけに依存。**根治**: 解決の瞬間に throw する fail-closed fence を単一 choke point(`paths.openGroundHome()` + `hooksInstall` の homedir アンカー、実装は `testHomeGuard.ts` 1 本)に置き、17 箇所すべてを保存値の復元へ、setup-home は毎テスト再検査+**犯人ファイル名を出す**方式へ。**ガードを外すと赤くなることを実測済み**(A: fence 撤去 → 11/17 red、B: 検出破壊 → 12/17 red、D: delete 復活 → 10 red + 犯人特定)。正典は **07 章**。**司令塔にとって他人事ではない** — worker の完了ゲートは必ず `npm test` を含むので、この swarm はオーナーの実データの隣で日に何十回も vitest を起動している。
**追記(2026-07-27 決定 / 2026-07-28 訂正・コマンダー運用は macOS/Git Bash 前提と明示 — GAP-8)**: `og-manage`(人間コマンダー体験)の実体は `skills/og-manage/SKILL.md` 1 ファイルで、その中の手順が bash/curl のワンライナー(`.sh` 群ではない)。これは**素の Windows PowerShell では動かない**(`curl` が `Invoke-WebRequest` alias で壊れる等)。PowerShell 対応はしないと決定した — swarm は owner 限定の隠し機能で Windows 受益者が現状ゼロ・全面書き換えの費用が受益に見合わない、が理由。**無人運転についての主張は「エンジンのサーバ側コードに bash 依存は無い」までに限る(2026-07-28 訂正 — 以前の「Windows でも無傷」は過大主張だった)**: worker spawn / 統合 / janitor / overseer の TS 側は bash を呼ばない。**ただし worker が「完了」を申告する心拍は bash スクリプト**(`scripts/swarm-beat.sh` が `readyToMerge` の唯一の書き手 — worker 心拍の HTTP 経路は存在せず、`POST /api/swarm/manager/beat` は司令官卓用)。`classifyWorker` の doing→review 昇格の根拠は `ready` **または PTY 死亡**の 2 つ(`swarmOrchestrator.ts:1217`)だが、claude TUI は /order 完了時に通常 exit しない(同 `:1196-1200`)ので実際には stall 経路が最頻 — bash の無い素の Windows では worker は commit できても自己申告できず、stall → 回収 → `commitsAhead>0` で `blocked` へ退避しやすい。**無人運転を Windows で回す場合も Git Bash が要る**(かつ Windows 実機での検証は未了 — [DISTRIBUTION.md §6](../DISTRIBUTION.md) の caveats)。**その Git Bash で足りるかも未検証**: 心拍ディレクトリの鍵を bash 側(`openground-swarm-lib.sh` の `sw_repokey` = `pwd -P` を sha1)と Node 側(`swarmOrchestrator.ts` の `swarmRepoKey` = `canonicalize(resolve(...))` を sha1)が**独立に導出して文字列一致を前提**にしており、MSYS の `/c/Users/…` と Win32 の `C:\Users\…` で鍵が割れうる(= worker が書く先と engine が読む先が別ディレクトリになる)。`shasum` が無ければ `swarm-beat.sh:27` が exit 1 で心拍ゼロ。Windows 実測時はここを最初に見る。[SWARM_GA_AUDIT.md §1.4 A-1](../SWARM_GA_AUDIT.md) は同じ bash 依存を verdict: breaks / critical と判定しているが、**結論はもっと広い** — 「macOS の一般ユーザー(非開発者)にも同じ穴が開く」「GAP-8 を全 OS の非開発者環境へスコープ拡大すべき」まで書いている。ただし A-1 の前提①「`swarm-beat.sh` は開発者の私物で OPEN GROUND は配布しない」は**陳腐化**(`swarmToolingInstall.ts` + electron-builder の `build.files` で boot 時に自己配備済み)— **配備問題は解決済みで、残るのは bash 依存のみ**(この訂正は 2026-07-28 に A-1 / NEW-4 行へ書き戻し済み。ただし同書 §0 の 🔴 件数と §5 可用性行は旧前提のままなので、そこを引くときは注意 — 再評価は別カード)。心拍スクリプトの PowerShell 版も同判断で実装しない。正典は [RELEASE_READINESS_GOALS.md §5 GAP-8](../RELEASE_READINESS_GOALS.md) と [DISTRIBUTION.md §6](../DISTRIBUTION.md)。
**追記(2026-07-31・司令官の卓は2種類になった — stage 3)**: `Settings.swarmManagerRuntime.mode` が `'sdk'` なら司令官は **Agent SDK セッション**として動き、**PTY プールに一切現れない**(2026-08-02 に既定が反転し、**未設定なら SDK 卓**)。よって「卓は在るか・話しかけられるか」は **`swarmManagerRuntime.ts` が唯一の窓口**で、PTY プールと SDK プールの両方に聞く。⚠ **PTY プールだけを見る実装に戻さないこと** — 健全な SDK 卓が毎パス `absent` と読まれ 5 分ごとに二卓目が立つ(0719 の11卓事故と同じ形を、競合ではなく構造として作り込む)。派生する3点: ①**声かけの ESC は SDK 卓では送らない**(打ちかけを消す問題が存在しない・受理は同期で分かる) ②**SDK 卓に画面は無い**(`managerDeskScreen` は null。null を「何も出ていない」と読むと正しい結論に誤った理由で辿り着く。クォータ停止の等価な証拠は `quota_refusal` イベント = `sdkDeskLimit.ts`) ③**リモコンが消える**ので、外からの窓口は **PTY のまま残す補給官**に移した(`skills/supply/SKILL.md` に「状況」「質問に答える」「司令官に伝えて」= `POST /api/swarm/manager/say` を追加)。**補給官が状況を答えられないうちにダイヤルを回すと、外から注文はできても監視ができなくなる** — これが stage 3 の順序の理由。実測で確認済み: SDK セッションでも `/og-manage` は解決する(slash commands 95 本に在り実際に読み込む)が、**Claude Code の system prompt は付かない**ので app-context カードは `systemPrompt.append` で明示注入する。正典は `docs/SDK_WORKER_MIGRATION_PLAN.md` §13-B、章内の注記は 03 章 §2.3 冒頭。
**追記(2026-08-02・キルスイッチが「読めない settings.json」で反転していた — 修正済み)**: 司令官ダイヤルの既定「不在 ⇒ SDK」は、**壊れたファイルにも適用されていた**。`store.readJson` が読み取り失敗(chmod 000 等)も parse 失敗も飲んで fallback を返すため、破損が「キー不在」と同じ `undefined` として reader に届き、**明示 `{"mode":"pty"}` で SDK を止めた機体でも、そのファイルが読めなくなった瞬間に SDK 司令官卓が立っていた**(実測 0802)。`swarmManager.ts` の `.catch(() => pty)` は reject 専用なのでこの経路では永久に発火せず、fail-closed のつもりの安全装置が寛容な reader に無効化される既知の型そのものだった。**修正**: 読みの結果を `ConfigReadHealth`(`ok` / `absent` / `unreadable`)で区別し、**unreadable ⇒ pty**、**absent ⇒ sdk は据え置き**(新規インストールの既定は変えない)。worker ダイヤルにも同じ FILE レベル規則を明示した(当時は挙動不変 —— 不在既定が pty だったため。**同日の別カードで worker の不在既定も sdk へ反転したので、今はこの規則が実挙動を支えている** — 02 章 §2.4-0 の⚠)。番人は `src/lib/server/runtimeDialFileHealth.test.ts`(chmod 000 / 壊れた JSON / 非オブジェクト JSON を含み、修正前で赤を実測)。正典は 03 章 §2.3 冒頭。⚠ **同じカードで塞いだデータ喪失経路(重要)**: settings の書き手は全て read-modify-write なので、**読めないファイルに保存すると「読めなかった現在値=既定値」が新しい真実として書き戻され、`projects` が丸ごと消えていた**(実測 0802 — 2件 → 0件、例外もログも無し。`atomicWriteJson` は tmp→rename なので chmod 000 のファイルにも通る)。`projects` は validateProjectPath の**許可リスト**でもあるため、消えると全プロジェクトの中央データも UUID ごと外れる。**2026-07-18 の 45件→3件と同型**で、しかも事故後に入れた世代バックアップでは救えない(`snapshotBeforeWrite` は「現在の内容」を退避するが、その現在の内容が読めない)。**修正**: `setSettings` / `remember|forgetSwarmAutonomy` / `remember|forgetSwarmManualStop` の5経路が `unreadable` なら `SettingsUnreadableError`(平易文・日英併記)で**書かずに reject**。`absent` は従来どおり書ける。registry.ts のプロジェクト追加/削除/relocate は全て `setSettings` 経由なので一括で覆われる。番人は `src/lib/server/settingsWriteGuard.test.ts`。**⚠ 副作用の本体は「設定変更が保存できない」ではなく「Ground が開かない」**: `GET /api/projects` は先頭で `ensureProjectsMigrated()` を呼び、読めないファイルでは「まだ移行していない」と判断してセンチネルを刻もうとする(`registry.ts` — `DEFAULT_SETTINGS` に `projectsMigratedAt` は無いので**必ず**ここへ来る)→ 書き込み保護が reject → `app.ts` の `onError` → **500**。**オーナーが何も保存していなくても、アプリを起動しただけでそうなる**(番人 `server/routes/__tests__/groundLoadOnBrokenSettings.test.ts`)。**これは直すべきバグではない** — migration を飛ばして 200 を返すと Ground が**空**で描画され、オーナーには「登録した全プロジェクトが消えた」と見える。しかも慌てて再登録すると `addProjectEntry` → `setSettings` → 500 で行き止まり。原因を名指しした 500 のほうが明確に良い。**アプリ本体は落ちない**(boot 側の settings 書き込みは try/catch 内で、listen は成功する — 死ぬのは Ground の初期フェッチだけ)。復旧はファイルを直すか削除するだけ(`registry.ts` の memoized promise は reject で evict され自己回復する)。設定変更が保存できない件は `docs/SECURITY.md` §12.4 追記。
**追記(2026-08-02・上の「残る既知のギャップ」は塞いだ — 表示側を構造で直した)**: Swarm パネルの表示は `GET /api/settings` の**生の値**からクライアント側で規則を再実装(`dialOf`)していたため、ファイルが壊れている機体では**サーバは PTY で動くのにパネルは SDK と描いて**いた。**この乖離こそがオーナーに「スイッチが効いていない」と読ませてトグルを押させる動機**になり、上のデータ喪失経路の引き金だった。同根の欠陥が worker 側にもあり(**盤面 ON / 実効 PTY** のまま 0.11.47 出荷 — 0801 の既定反転が `chooseWorkerRuntime` にしか入らず、dispatch が必ず通る `store.getWorkerRuntimeDial()` が不在を pty に潰していた)、**0802 だけで表示ズレが2件**出たので個別に潰さず構造で止めた。**修正**: ①worker reader を司令官側と同極性(不在 ⇒ sdk)に揃え、反転を dispatch へ届かせる ②`GET /api/settings` が **サーバの実効値** `runtimeDialsEffective:{worker,manager,workerCap}` を返し(値は dispatch / 卓起動が実際に使う `getWorkerRuntimeDial` / `getManagerRuntimeDial` から算出)、パネルは**それを描くだけ**にする。`dialOf` は削除。**読み取り専用**なので `USER_SETTINGS_KEYS` には足さない。サーバが答えない場合パネルは推測せず**トグルを disabled** にする。**番人も付け替えた**: `swarmRuntimeDialParity.test.ts` は `chooseWorkerRuntime` を**直接**叩きパネルからの**写し**と比べていた = 出荷経路をどちらも見ておらず、「防いだ」と宣言している欠陥が現実に存在したまま緑だった。今は**合成経路(reader → 決定)⇄ パネルに配られる値**を、実在の `settings.json` 状態(不在 / 明示2値 / 手編集の mode 8種 / 非オブジェクト / parse 不能 / chmod 000 / 切れた symlink)で総当たり比較する(修正前で 6/6 赤を実測)。
**追記(2026-08-12・着地の永続台帳と外向きKPI「着地/週」)**: KPI パネルの landed は journal(200行 in-memory ring)× Board の突合だったため**再起動で履歴が消え**、「swarm は自分の修理以外に何を生産しているか」を時系列で読む手段が無かった。エンジンが review へ運んだカードを **`~/.openground/projects/<uuid>/swarm-landed.json`** に永続記録する(正典 = `src/lib/server/swarmLandedLedger.ts`)。書き手は dispatch pass 内の2点 — 通常 promote(`monitorWorkers` の `moveToReview` 成功直後)と ready worker 回収の review 昇格(`integration-wait` — journal に promote kind が付かず in-memory 突合が**取りこぼしていた**経路。台帳は拾う)。掃引は `runDispatchPass` の board 読み直後の `sweepLanded` — done を**検知した時刻**を `landedAt` に刻む(ProjectTask に updatedAt が無いため。週次バケットには十分・分単位の分析には使えない)。読み書きは fail-open / fail-quiet(`swarmEnginePersistence` と同じ規律)で、**台帳は分析専用 — エンジンの判断入力には決して使わない**。集計は `GET /api/swarm/kpi/landed`(owner gate・**read-only**・全登録プロジェクト横断・週次バケット固定長)。self 判定は package.json name のビルド元一致(どの checkout でも OG 自身は self・読めなければ external へ degrade)。表示は Swarm タブ司令官ダッシュボードの「着地 / 週」(`SwarmManagerPane` の `LandedChart`、取得は `SwarmModule` の `useLandedKpi` — pane は fetch しない規約を維持)。番人は `swarmLandedLedger.test.ts`(19件)+ `swarmLandedKpi.routes.test.ts`(3件)+ `SwarmManagerPane.landed.test.tsx`(3件 — 描画契約: null=非表示/ゼロ=説明文/データ=見出し+凡例+バー実体)。**赤の実測済み(2026-08-12)**: promote 配線を外す→1赤 / sweep 配線を外す→1赤 / モジュールの刻印を壊す→3赤 / パネルの render gate を殺す→2赤、復元で全緑。**実機の一巡も済み(同日)**: `npm run build` の本番バンドル(esbuild CJS)を隔離 HOME で起動し、登録2プロジェクト(self/external)+seed 台帳で `GET /api/swarm/kpi/landed` の分類・集計を実測、Playwright で Swarm タブ MANAGER ビューのチャート描画をライト/ダーク両テーマでスクリーンショット確認(package.json name のビルド時インラインが CJS バンドルで効くことを含む — 0.11.47/48 の「配布ビルドでだけ死ぬ」型の点検)。⚠ 司令塔への含意: **カードを手で done に動かすのも「着地」として数える**(promote 済みなら)— 着地の定義は「エンジンが運んだカードが done になった」であり、マージの有無を git では検証しない(戒2の適用対象外の analytics)。

**追記(2026-08-12・方針3点 — PTY 凍結 / ギャップ台帳 / 参照規約)**: ①**PTY worker 系統は凍結**(fallback 専用・新機能/新センサーは SDK 側のみ・実運用 4 週 fallback 0 で PTY センサー層を削除するカードを起票) — 0802 の事故群がほぼ全部 PTY/SDK の parity 欠陥だったことへの構造的応答。正典は **TARGET-STATE §9**(補給官 PTY と ownerDeskLimit は対象外 = 人間の卓は残る)。②**PLATFORM-GAP-LEDGER.md 新設**(読む順の表 9 行目) — quota 五層・スクレイプ・bash 心拍等「プラットフォームが公式に埋めに来る領域への補償工事」の棚卸し。台帳入りの機構への機能追加は設計のスメル(規則は台帳 §0)。③**参照規約** — 新規文書・追記は行番号でなくシンボル参照(§6-5。既存章の一括変換はしない — boy-scout 方式)。

**追記(2026-08-13・worker の PTY fallback を全削除 — 凍結から削除へ前倒し)**: 上の①「4 週 fallback 0 で削除」を待たずオーナー決定で削除に踏み切った(「fallback がある限り SDK 移行は永遠に終わらない」— 実測: `sdkMaxWorkers` 既定 1 の slot cap が2体目以降を全部 PTY に流し、オーナーはログイン切れのバグと読んだ。fallback は実害を**静かに**吸収する装置になっていた)。**worker は SDK 専用**: `swarmWorkerRuntimeDial.ts`(`chooseWorkerRuntime`/slot cap)・`Settings.swarmWorkerRuntime`・`getWorkerRuntimeDial`・`SpawnSwarmWorkerResponse.fellBackBecause`・盤面の worker スイッチを削除。SDK を確立できない spawn は **fail-fast**(`SdkWorkerUnavailableError` + worktree/branch ロールバック)、エンジンはカードを todo に残して dispatch を階段 HOLD(1m→5m→15m)+ `worker-spawn-failed` の鐘(1h スロットル)+ 復旧後は自動再開。`runtimeDialsEffective` は `{manager}` のみに縮小(worker/workerCap 撤去 — SPA とサーバは同一バンドルなので一括破壊変更)。古い settings.json の `swarmWorkerRuntime` キーは**不活性**(読まれない・POST は黙って捨てられる — back-compat 契約は `settingsRuntimeDials.test.ts`)。**司令官ダイヤル(`swarmManagerRuntime`)と補給官 PTY は残る**(人間の卓)。**司令官の AUTO-fallback も同時に削除**: SDK ダイヤルの卓が SDK を確立できないとき、黙って PTY 卓を座らせる代わりに `SdkManagerUnavailableError` を投げる(`SpawnSwarmManagerResponse.fellBackBecause` と `runtime.fellBack` バナーも削除)。司令官ボタンは 500 + 理由文、エンジンの蘇生反射は失敗 wake として既存の後退(猶予 → 3ストライク `manager-unrevivable` の鐘 → 30分再アーム)に乗る — 明示 `{"mode":"pty"}` ダイヤルと unreadable⇒pty の PTY 卓は健在。番人: `swarmWorkerFailFast.test.ts` / `swarmSpawnFailFast.test.ts` / `swarmManagerFailFast.test.ts`(旧 swarmManagerFallback — 逆契約から書き換え)/ 再スコープ済み `swarmRuntimeDialParity.test.ts`(全て変異で赤を実測)。正典は 02 章 §2.4-0(改訂済み)。

**読者**: 将来の司令塔(og-manage / manage セッション)。
**この文書の役割**: docs/commander/ 全 7 章 + TARGET-STATE の統合索引。個別の機構は各章が正典 — ここは「どこを読むか」「全体がどう噛み合うか」「何を信じ何を疑うか」「何をしてはいけないか」を 1 枚に持つ。

---

## 0. この文書群が存在する理由

司令塔セッションが OG swarm の全体構造を誤読し、同じ失敗を繰り返した:

- **0707**: 短縮 id の Board 書き込みが 200 の中で黙殺 no-op → worker の虚偽報告を信じて誤診 2 連(05 章 §7-1)
- **0710**: workers API の `heartbeatAt`(凍結値)を信じて「worker が半日死んでいる」と誤診 — ディスクの心拍は生きていた(02 章 §4。**0711 でこの凍結自体を根治済み** — `heartbeatAt` はディスク優先に修正され、API の値を信じてよくなった)
- **0710**: 「rebase 済みだから安全」と思っていた worktree が worker 停止で消えた — 停止 = force 削除が仕様(02 章 §6)
- **0709**: 敵対レビューの「conflict」表示を rebase 競合と誤診 — 実体は大 diff による棄権凍結(03 章 §3・§4-1。凍結自体は `3129a58` で根治済み — 相乗り表示は現存)

対策がこの文書群。読み方の原則は 1 つ: **疑ったら必ず各章の検証コマンドで自分の目で裏取りする**。文書も古びる — 主張と現物が食い違ったら現物が正で、その時は文書を直す(§6)。

---

## 1. 読む順番と各章 1 行要約

| 順 | 章 | 1 行要約 |
|---|---|---|
| 1 | [01-engine-core](01-engine-core.md) | エンジン中枢 — 3 秒 tick の回り方・dispatch 6 ゲート・monitor 全分岐・in-memory 状態の寿命(再起動で全部消える)。※TL;DR#3/§6 の「integrate が monitor を飢餓させる」は `0d1f7f0` 以前の歴史 |
| 2 | [02-worker-lifecycle](02-worker-lifecycle.md) | worker の生涯 — spawn/心拍/promote/回収、worktree 削除の全 8 経路と**回収前の WIP 保全**、実行時間上限は**実作業時間**で測る(quota 待ち=0712 根治・**統合待ち=0718 根治**は控除。ready 済み worker は暴走扱いも blocked 退避もしない)、workers API `heartbeatAt` 凍結の解明と根治(0710 誤診の真因 → 0711 修正済み) |
| 3 | [03-integration-review](03-integration-review.md) | **統合は司令官専任・engine は ready で司令官を起こすだけ(2026-07-15 マネージャ専任化)**。A相(read-only「統合可」表示)は残る。B相は**エンジン ON で常時**(2026-07-16 に autoMerge トグル廃止): review の ready カードがあり司令官不在/沈黙なら `spawnSwarmManager` で起こす(バッチ・二重起動しない) — verify/敵対レビュー/FF push/land は全部撤去。**engine のレンズ結果だけで main が動く経路は金輪際ゼロ**。**+ 蘇生反射(card B, 2026-07-16)**: manager 心拍で死/ハングを検知し蘇生(quota 繰り下げ・grace 再試行・3連続失敗で `manager-unrevivable` fatal・完了条件1-6)。§2.3.1〜§3(旧 land 機構)は HISTORICAL。統合(重量級レビュー+手動 FF push)と安全網は司令官側 §5 に一本化。**§5「専門レビュアー」= 技術判断は一次資料を取り込んでから下す規約(2026-07-19)** |
| 4 | [04-quota-models](04-quota-models.md) | quota 五層 — 冷却テーブル(A、**再起動を生き延びる**・0713 永続化)/rate-limit 検知(B)/使用可能モデル mask(C)/使用状況キャッシュ pre-launch veto(D、`/usage` の既知の枯渇を起動前に見て梯子からトップ tier を篩う・2026-07-12。⛔ **ただし現行 CLI は per-model 行を出さないので fable 単独枯渇は層Dでは見えない** — 0713 実測、§5.7 冒頭)/**起動前プローブ(E、0713 — spawn 直前に未知 tier へ headless 1発叩いて CLI のクォータ拒否文字列を読む。fable 単独枯渇を起動前に検知できる唯一の層・壁は層Aに記録して梯子1段下げ・分からなければ fail-open。⚠ 健全 tier のプローブは実測 19〜73s なので launch は最大 8s しか待たず、プローブは detached 完走で次の launch から効く、§5.8)**。検知 21 分遅延の 3 因子と根治(`0d1f7f0` — 45 秒サンプリング+早期認定+limit 画面クロック)。**hold 中の時間は worker の実行時間から控除される**(§3.4-6 — 0712 根治)。真実は `launchTier` だけ |
| 5 | [05-board-api-contract](05-board-api-contract.md) | Board 契約 — tasks.json が唯一の永続体、列ライフサイクル、ロック/CAS、フル UUID の掟、二重 dispatch 両方向封鎖(cc7c60e)、**司令官/補給官の会話 resume(§10)** |
| 6 | [06-overseer-escalations](06-overseer-escalations.md) | overseer 信号 S1〜S11 と escalations/通知ストア — S3/S10 の 24h 窓+永続受領(`d8431c3`+`aa9cb8d` 根治)、再投函増殖の実測(歴史)、**平易文 `plainQuestion`(2026-07-17 — テンプレ raise 必須併記・UI 既定表示・§2.2)**、**判断ルーティング(2026-07-18 — 宛先の仕分け・観測地図が正典・§2.3)**。※その受け皿(技術判断を**一次資料で**下す専門レビュアー規約)は 03 章 §5 |
| 7 | [07-test-isolation-contract](07-test-isolation-contract.md) | **本番 HOME 保護の契約**(2026-07-19 新設)— テスト実行がオーナーの実データを壊せない構造。2026-07-18 の事故(vitest が実 `settings.json` を上書き・登録 45 件→3 件・`canvas.json` 永久喪失)の全容、fence の実体と 4 つの罠、**ガードを外すと赤くなることの実測**(teeth §4)、保証されていない残存経路(§3)。**worker の完了ゲートは必ず `npm test` を含む = swarm は実データの隣で日に何十回も vitest を起動する**ので、司令塔の直接の関心事 |
| 8 | [TARGET-STATE](TARGET-STATE.md) | 理想の稼働形(北極星)— 観測可能な 6 条件・現状ギャップ・対応カード。**§9(2026-08-12)= PTY worker 系統の凍結方針**(新機能/新センサーは SDK 側のみ・fallback 0 の 4 週で PTY センサー層を削除) |
| 9 | [PLATFORM-GAP-LEDGER](PLATFORM-GAP-LEDGER.md) | **待てば消える工事の台帳**(2026-08-12 新設)— quota 五層・スクレイプ・bash 心拍等、プラットフォームギャップ補償の全機構に「維持のみ・拡張禁止・削除トリガ」を付けた棚卸し。この表の機構への機能追加は設計のスメル |

**症状からの入口**(全部読む時間がないとき):

| 症状 | 直行先 |
|---|---|
| worker が動かない / 消えた / 心拍が古く見える | 02 章(§4 heartbeatAt 凍結は 0711 根治済み、§6 worktree 削除の全経路) |
| **上限(週次含む)が明けても worker が復活しない / カードは「実行中」なのに稼働 0 / 実行中カードの詳細に実行ボタンが出る** | 01 章 **§7.4d**(2026-09-01) — unowned な作業途中カードは `collectUnownedDoing` が 30 秒猶予ののち todo へ回収(quota-parked 卓は停止+salvage 込み)、上限明けは冷却テーブルが自動で解く。ドロワーは union リスト(`GET /api/swarm/workers`)で生きた卓の画面 or 中断の説明を出す(0.11.102) |
| **レビュー待ちのまま司令官が動かない**(review にカードが溜まる・`manager-woke` も鐘も来ない) | **03 章 §7-10**(2026-08-14 解決)。卓が**在るのに**統合しない形は `manager-unrevivable`(=「卓を*起動*できない」)には絶対に乗らないので、専用の鐘 **`manager-unresponsive`** で届く — 条件は「卓は idle か stall した active」×「nudge 予算を使い切った or 声かけ不能が3回連続」×「統合待ちが 40 分以上滞留」で、**待ちバッチ 1 本につき 1 回だけ**。同条件で **SDK 卓なら 1 度だけ閉じて立て直す**(PTY 卓はオーナーの端末なので決して閉じない)。滞留時計は `engine.json` の `reviewWaitingSince` に永続化されているので、**再起動しても 40 分窓は巻き戻らない**(以前は再起動のたびにゼロに戻り、これが同じ事象を何度も見逃した原因)。鐘も出ていないなら §7-11(自分で描き続けたまま固まった卓)を疑う |
| worker のタイルに端末が出ない・`terminalId` が空 | 仕様 — **worker は SDK 専用**(0813)。02 章 §2.4-0(レコードの `runtime` 不在⇒pty は**旧レコードの読み方**として残る・生死は `isSdkSessionLive`)/ 経緯は `docs/SDK_WORKER_MIGRATION_PLAN.md` |
| **worker が1体も立たない・カードが todo に残り続ける・「workers cannot start」の鐘が鳴る**(とくに配布した `.app` で) | まず **spawn エラーの文面**(`worker-spawn-failed` 通知の detail / POST /api/swarm/worker の 500 本文)。**サーバログは見えない**(配布版の Hono は fork された子プロセス)。dispatch は階段 HOLD(1m→5m→15m)中で、**原因を直せば次の試行で自動再開**(再武装不要)。既知の一撃は**2つとも「配布ビルドでだけ死ぬ」形**(fallback 時代は全数 PTY 降格として現れた — 今は fail-fast で鐘が鳴る): ① **CJS バンドルに `import.meta` が無い**ため guard hook のロードが TypeError → fail-closed で preflight 全落ち(0801 `dd311acc`)。② **CJS バンドルから ESM 専用の SDK を `require()`** → `ERR_REQUIRE_ESM` で即死(0802 `e26d5efb`。**0.11.47/0.11.48 はこの状態で出荷**)。**どちらも dev と vitest では原理的に再現しない** → 02 章 §2.4-0 |
| **Ground が開かない / カードが1枚も出ない / `GET /api/projects` が 500**(起動しただけ・何も保存していない) | **`settings.json` が読めるか壊れていないかを最初に見る**(`cat ~/.openground/settings.json` / JSON として妥当か)。破損中は書き込み保護が働き、`ensureProjectsMigrated` のセンチネル書き込みが reject されて 500 になる = **仕様どおり**(空の Ground を描くより良い、という判断)。**起動不能の別バグとして追わないこと。** 500 の本文が原因を名指しする。復旧はファイルを直すか削除するだけ。アプリ本体・サーバは生きている → 03 章 §2.3 冒頭 |
| **`swarmManagerRuntime.mode` を `'pty'` にしたのに SDK 司令官卓が立つ**(リモコンが消える・`managerDeskScreen` が null) | まず **`settings.json` が読めるか**(`cat` できるか・JSON として妥当か)。0802 以前は**読めない/壊れたファイルが「キー不在」と同じ扱いで SDK に倒れて**いた = キルスイッチが黙って反転する。修正後は **unreadable ⇒ pty**(不在だけが sdk)→ 03 章 §2.3 冒頭。**パネルの表示はサーバの実効値**(`runtimeDialsEffective`)なので壊れた機体でも食い違わない(0802 修正済み — 以前は値から導出していて**サーバ PTY / パネル SDK** になった) |
| **SDK worker に回答が届かない / 質問が1体分しか上がってこない / エスカレーションに証拠が付かない** | 06 章 §3.2(**配達は `deliverAnswerToWorker`** — PTY と SDK で送るバイトが違う。レコードは worker の**住所を丸ごと**持つ = `runtime` + ハンドル1本)+ S4 行(重複排除キーは `workerKey(w)`。`terminalId` にすると SDK worker 全員が空文字で**1スロット共有**)+ §3.2-7(証拠の尾は PTY=画面 / SDK=蒸留イベント。空欄は「何も無かった」ではなく「取り方が違う」) |
| **止めたはずの SDK 卓が「作業中」/ 片付け中の卓が「もう居ない」と読まれる** | `terminateSdkSession` は status を**同期反転**する(= 頼んだだけ)。生死は **`isSdkSessionLive`(= `!reaped`)** 一本。`docs/MAP.md` §5 に棚卸しと**数え方**(数は書いていない — 一度その数で嘘をついたので) |
| **worker が「1 時間ほどで死ぬ」/ `phase: verify` の worker ばかり消える / テストを回している最中に回収される** | 02 章 **§5.4b**(**2026-07-27 — worker は死んでいなかった。エンジンが、完了ゲートを背景タスクで回してターンを終え通知を待っていた worker を「沈黙」と誤判定して kill していた**)。指紋は engine log の `worker stalled — reclaimed` と、そのセッション JSONL 末尾に `turn_duration` の 20 分前後あとに届く `queue-operation`(中身が `<status>killed</status>`)。**第4チャネル(実行中の背景タスク)で塞いだ・猶予 90 分 = `MAX_EXEC_MS` と同値**。⚠ **「根治」とは名乗らない** — カバーするのは自セッションに開始が残るタスクのみで、resume を跨いだ分は未カバー(§5.4b のカバー範囲宣言)。手元の transcript でこの症状を確認するには `npx tsx scripts/verify-bg-channel-on-real-transcripts.mts <session.jsonl>`。`worker lost` + exitCode 付きなら別経路の本物の crash(§10) |
| **同一カードが二重配車された(twin/増殖)/ 稼働中 worker の worktree だけ消えた(branch は生存)** | 02 章 §6 実測(2026-07-22/23)+ §5.4 の表(`commitsAhead>0 ⇒ blocked`・0723 根治)。**「boot reconcile が消した」ではない** — roster は in-memory(§7.6)で再起動後は空、孤児 doing の再配車も稼働 worktree 削除も boot/board 経路には**無い**(orphan-doing 検出は read-only・retention の boot sweep は list に無い空 dir だけ消す)。真因は alive engine の crash 回収(経路 3)が **commit 済みカードを todo に戻し**、次 dispatch が新 branch を鋳造して旧 branch を孤児化したこと。engine log の `worker lost … — card → todo` が指紋 |
| **worker が実行時間上限で消え、未コミット作業が失われた** | 02 章 §5.5(上限は**実作業時間**で判定 — quota 待ち・統合待ちは控除。0712/0718 根治)+ §6(teardown 前に **WIP コミットで保全** — `git log <branch>` に `WIP: swarm reclaim auto-save`)+ §7-11(事故の全容)。quota 側の見方は 04 章 §3.4-6 |
| **差し戻したカードが blocked に落ちた / ready 済み worker が「runaway 91分」で消えた** | 02 章 §5.6(**0718 根治**: ready 到達後の統合待ちは実作業時間に算入しない。**作業上限**で停まる場合の行き先は理由 `integration-wait` で **review**、blocked ではない)+ §5.5(b)。**blocked に落ちていたら差し戻し上限(`MAX_REWORKS`)と即断しない**。ただし **stall / crash / permission / question で回収された場合は今も blocked に落ちる**(§5.6 末尾「隣接する既知の穴」)ので、engine log でどの理由だったかを先に読む |
| review 列から進まない / done にならない | 03 章 §2.3/§5 — **2026-07-15〜これが正常**: engine は統合しない。review の ready カードは**司令官が起こされて手動で land する**まで review に留まる。`manager-woke` 通知が来ているか、司令官の卓が生きているか(不在なら engine が起こす — **エンジン ON なら常時**・2026-07-16 トグル廃止。エンジン自体が OFF だと起こしも止まる)を確認し、来ていたら §5 の手動統合で land する |
| **manager(司令官)が固まって統合が進まない** / engine が起こしても動かない | 03 章 §2.3 — **蘇生反射(card B, 2026-07-16)**: engine は manager 心拍(`manager.json`)を見て**死・ハングを検知し `spawnSwarmManager` で蘇生**する(quota 壁なら tier 繰り下げ・grace 5 分ごと再試行)。**3 連続失敗で `manager-unrevivable` fatal** を上げて諦める → その通知が来ていたら**手で司令官卓を確認/再起動**する(恒久バグ・quota 完全枯渇の疑い)。心拍を一度も打っていない手動卓は fail-open で不触 |
| **`high-risk-hold` / `[must-fix 0 / clean 0]` / 敵対レビュー凍結が出ない・出ていた** | 03 章 §2.3.1〜§3 は **HISTORICAL**(2026-07-15 でエンジンから撤去)。engine はもう verify も敵対レビューも force-hold もしない。高リスク判定・fail-closed の安全網は**司令官の手動統合規約**(skills/og-manage §「マージ」)側にある。過去ログにこれらが見えるのは撤去前の履歴 |
| **自己更新の後にアプリから「Sign in」が消えた / collab が全員 OFF になった** | 03 章 §2.9 — `electron/runtime-config.json` が `{}` に潰れている(gitignored なので diff に出ない)。テスト/ビルドを回す子プロセスの env 統制で、**生産者(`npm run build` を直接 or transitive に回す step)からビルド入力 `BAKED_KEYS` を剥いだ**時の症状。`forkEngine` が `readBakedAuthEnv()` をその場で読み直すので**走行中のアプリで即座に**出る。復旧 = 正しい env で `npm run build:config` を回し直す |
| **ゲート/スキャナの子プロセスが本番 `~/.openground` を触った疑い** | 03 章 §2.9 — engine は使い捨て HOME を注入する(`gateProcess.ts` `withGateEnv` / electron は `gateEnv.js`)。「テスト側の setup-home が自分で隔離するから安全」は**循環論法**(その setup-home はブランチ側の同梱物)。限界: `HOME` 自体は非隔離 |
| dispatch されない / park している | 04 章(§5.5 spawnBlock、§7 運用手順)+ 01 章 §4.2 |
| カード操作が効かない / 列が勝手に戻る | 05 章(§6.3 id の掟、§7 落とし穴) |
| escalation が大量に来た / 古い障害が再通知される | 06 章(§4.1 S3 増殖、§5 トリアージ) |
| **技術的な質問がオーナーに届く**(実装方式・アルゴリズムの選択を聞かれる) / 「これはあなたが決めたい種類の話ですか?」が来た | 06 章 §2.3 — **判断ルーティング**(2026-07-18)。宛先の正典は you-corpus の「関与の観測地図」+ TARGET-STATE §5 の恒久境界の 2 つだけ(カテゴリは発明しない)。地図に無い領域は宛先を 1 問だけ聞き、その回答が地図を育てる |
| **技術判断の根拠が怪しい**(古いライブラリ仕様・変わった外部 API 前提の実装が通った) / verdict に `【資料取得できず】` が付いている | 03 章 §5「専門レビュアー」(2026-07-19)— 技術判断は**一次資料を取り込んでから**下す規約。単一正典 `swarmSpecialistReview.ts` から worker 標準指示と司令官の検品(og-manage §「マージ」手順 4)の2面が派生。`【資料取得できず】` は**印を付けた degrade** であって異常ではない(資料が取れなかっただけ・判断は internal 知識)。ただし**レビュー自体の失敗は従来どおり fail-CLOSED で停止** — 混同しない |
| エンジンが「何もしていない」ように見える / 検知が遅い | 01 章 §7.6(log ring buffer)+ TARGET-STATE §1(検知の現行機構)。※01 章 §6 の monitor 飢餓は `0d1f7f0` で解消済み(歴史) |
| 全 claude セッションの Stop hook が MODULE_NOT_FOUND(worktree パスを指す) | 02 章 §2.5(0712 根治 → 0714 に OPENGROUND_HOME リダイレクト経由で再発 → hook を `~/.openground/hooks/` へコピー設置し settings は安定パスのみ参照する構造根絶済み。汚染エントリは `installHooks` 再実行 = アプリ再起動 or POST /api/observer/install-hooks で安定パスへ**自己修復**される) |
| 司令官が**存在しない worker の話をする** / 前回の認識のまま喋る | §2.1 + 05 章 §10.2 — resume で会話は復元されるがエンジンの認知は消えている。「状況」で読み直させる |
| 司令官・補給官が**毎回記憶喪失**で立ち上がる(resume されない) | 05 章 §10.3 — fail-open の理由コード(`none`/`moved`/`live`/`missing`/`store`)。応答の `resumed` とサーバ log の `[swarmSessions]` 行で判別 |
| **テスト実行が本番データを壊した / `~/.openground` のプロジェクトが消えた / settings に見覚えのない値が入っている** | 07 章 — 2026-07-18 の事故の全容と現在の契約。**まず `npx vitest run src/lib/server/testHomeGuard.test.ts src/testHomeEnvGuard.test.ts`(47 + 52 = 99 件・2026-07-29 実測)が緑か**を確認(§5)。**素の grep に「0 件」を期待しないこと** — 2026-07-19 以降 0 にはならず(実測 5 ファイル 17 行・規約を説明する散文とエラー文が正当に持っている)、しかも `--include="*.ts" src server` は §4.14 で塞いだ盲点そのもの(scripts/electron/worker の JS を素通りする)。静的な再発防止の正典はこの 2 ファイルのテストで、除外理由はそこに符号化されている。緑でも「テストが緑だから安全」は証拠にならない — §4 の teeth 手順で外して赤くなることを確かめる |
| **マシン全体が重い / claude code が固まる(OG を閉じても・素の端末でも・resume しても再発)** | 07 章 **§7**(2026-07-28)— **アプリは無実の可能性が高い**。真因は swarm テストが漏らした**孤児 `git`**(親が launchd・**U 状態**)が run queue を詰まらせること。診断は 1 行: `ps -axo pid,ppid,stat,command \| awk '$2==1 && $3 ~ /^[UD]/ && /git/' \| wc -l` → 0 以外なら該当。**`kill -9` も `execFile` の `timeout` も効かない**(実測 §7.3)ので掃除は **OS 再起動が唯一**。予防はコード側で完了(`gitRepoGuard` = 非リポに git を spawn しない・§7.4)。新しく git を呼ぶなら §7.7 の掟 8 |
| リポジトリ外のグローバルスキル(`~/.claude/skills/supply` 等)に適用すべき差分が溜まっている | [PENDING_GLOBAL_SKILL_PATCHES.md](PENDING_GLOBAL_SKILL_PATCHES.md) — worker は書けないので、マネージャー/オーナーが手で適用してから節を消す置き場 |

---

## 2. 1 ページのメンタルモデル

中心は**エンジンの 3 秒 tick**(プロジェクトごとに 1 本、in-memory)。全機構はこの pass の中か、pass が読み書きする永続体(Board / branch / 心拍 / quota / escalations)のどちらかにいる。

```mermaid
flowchart TB
  subgraph pass["runEnginePass — 3 秒 tick・pass は常に 1 本(passInFlight で二重は bail)— 01 章 §1・§3"]
    direction TB
    D["<b>dispatch pass</b>(runExclusive)<br/>board 全読み → monitor(promote / stall / rate-limit / 回収)<br/>→ reconcile → SPAWN PARK(quota+mask ゲート)<br/>→ fill: selectDispatch 6 ゲート → 予約 → spawn"]
    O["anomaly 検出 → FATAL 通知 → <b>overseer pass</b>(S1〜S11) → self-supply kick"]
    D --> O
  end
  I["<b>integrate pass</b>(tick の脇で fire-and-forget — 0d1f7f0 で分離・integrateInFlight で 1 本)<br/>(15s throttle)A相: read-only classify → reviews[](統合可表示)<br/>B相(2026-07-15〜): ready カードあり+司令官不在/沈黙なら spawnSwarmManager で起こす/蘇生するだけ<br/>(エンジン ON で常時 — 2026-07-16 トグル廃止。verify/レンズ/FF push/land は撤去 — main は動かさない)"]
  D -. "kickIntegratePass(await しない)" .-> I
  M["<b>manager(司令官)卓</b> = 統合の専任<br/>重量級レビュー + 手動 FF push(og-manage §マージ)"]
  I -- "wake / 蘇生(manager-woke 通知・3連続失敗で fatal)" --> M
  M -- "land(手動 FF push)→ done / 差し戻し → doing" --> B
  B[("<b>Board</b> tasks.json<br/>todo / doing / review / done / blocked<br/>— 唯一の永続体(05 章)")]
  W["<b>worker</b> = 中央 worktree + claude PTY + 心拍ファイル<br/>(02 章。作業の担保は branch のコミットのみ)"]
  Q[("<b>quota 三層</b>(04 章)<br/>A 冷却テーブル(永続・0713〜) / B 検知 / C mask(永続)")]
  E[("<b>escalations.json</b> + 通知ストア(06 章)<br/>人間への出口 — 自動では何も動かさない")]
  B -- "todo を優先度順に 6 ゲートで選抜" --> D
  D -- "spawn(worktree + PTY + /order 注入)" --> W
  Q -- "spawnable tier(launchTier)/ 全滅なら park" --> D
  W -- "limit 文言(45s 沈黙でサンプリング・spawn 直後は約 95s で早期認定)→ markRateLimited" --> Q
  W -- "commit + 心拍 ready → promote(doing→review)" --> B
  O -- "T3 信号(S1/S2/S3/S5/S10)" --> E
```

**時間軸の罠(`0d1f7f0` で解消 — 歴史)**: かつては pass が dispatch → integrate を直列 await していたため、integrate 内の verify(最大 tsc 180s + test 600s)と敵対レビュー(カード直列・`3129a58` 後は最長 20 分/パネル)が pass を握っている間、**monitor は 1 回も回らなかった**(01 章 §6 に当時の機構、04 章 §4 に実測 21 分 30 秒)。現在は integrate が tick の脇で走る(03 章 §2.1)ので、integrate がどれだけ遅くても monitor は 3 秒 tick で回り続ける(なお 2026-07-15 で verify/panel 自体が撤去され、現 integrate は classify + 司令官 wake だけの軽い pass になった)。

```
現在:   tick(3s): |-dispatch+monitor-|-dispatch+monitor-|-dispatch+monitor-|-…(常に数秒周期)
                        └ kick ──→ integrate(verify+panel で数分〜20分超、脇で1本だけ走る)
0d1f7f0 以前: |-dispatch+monitor-|-dispatch+monitor+integrate(数分〜10分超)————|-…
                                    ↑ この間の tick は全部 bail = 検知・promote がこの分だけ遅延(歴史)
```

**真実の在り処**(どのビューが権威か):

| 知りたいこと | 権威 | 経由 |
|---|---|---|
| カードと列 | `~/.openground/projects/<id>/tasks.json` | Board API(エンジンも loopback HTTP で同じ門 — 裏口なし。05 章 §1) |
| worker の作業内容 | **branch のコミット**(worktree は消耗品) | `git rev-list` / `git log`(02 章 §6) |
| worker の鮮度 | 心拍ファイルの `updatedAt`(ディスク) | `~/.openground/swarm/<repoキー>/*.json`(02 章 §3-4) |
| worker の生存 | PTY(terminal pool) | `GET /api/swarm/workers` の `terminalId` 有無(02 章 §3.3) |
| エンジンの認知 | `GET /api/swarm/orchestrator`(in-memory の写し — 再起動で全消え) | 01 章 §2 |
| 起動できる tier | `GET /api/swarm/quota` の **`launchTier`**(`tiers[]` は mask 盲目) | 04 章 §2.6 |
| 人間待ちの案件 | `~/.openground/escalations.json` の `status=open` | 06 章 §7.2 |
| 司令官/補給官の会話 | claude の transcript(id は `~/.openground/projects/<id>/swarm-sessions.json`)— **再起動を跨いで生き残る**(2026-07-12) | 05 章 §10 |

### 2.1 再起動で何が消え、何が生き残るか(resume した司令官は必ず読む)

2026-07-12 から司令官・補給官は `claude --resume` で**前回の会話を復元して**立ち上がる(05 章 §10)。
このとき**非対称性**を取り違えると、実在しない世界の話を続けることになる:

| | 再起動後 |
|---|---|
| 司令官・補給官の**会話履歴** | ✅ **生き残る**(resume)。※ resume した卓が起動即死してもこの履歴は消されない — DOA のセッション破棄(04 §2.2.1)は resume していないフレッシュな卓限定 |
| エンジンの **in-memory 認知**(worker roster / reviews) | ◐ **roster は 2026-07-23 card 3 以降ディスクに write-through される**(`~/.openground/swarm/<repoキー>/roster.json` — 心拍の隣・sessionId/taskId/branch/worktree/tier/spawnAt/workedMs/reworkCount を状態遷移点で保存)。boot 時 `resumeEngines()` が**照合先行・spawn 凍結**でその roster を現実(worktree/git/心拍/Board)と突合し 4 分岐に分類する(worktree 消滅=破棄 / ready=司令官 wake に委ねる / 作業途中=resume 候補として温存 / カード消滅=既存 reclaim)。※ただし**この段階では死んだ PTY を実際に `claude --resume` で再接続はしない**(それは card 4・未着手)— 再起動直後の in-memory roster はまだ空で、生き残った worker は `GET /api/swarm/workers` に**エンジン外 worker** として出る。**reviews は永続しない**(導出で足りる・初回 integrate pass で再計算 — 設計 §3)。ただし**自動運転(desiredRunning)は 2026-07-22 card 2 以降 OFF に戻らない** — その project の `engine.json`(`~/.openground/projects/<uuid>/engine.json`)が `desiredRunning:true` かつ owner の手動停止記録(`Settings.swarmManualStop`)が無ければ boot 時 `resumeEngines()` が人手ゼロで自動再開する(同一バージョンで 10 分に 3 boot 以上のときだけ crash-loop breaker が抑止 + fatal 通知)。「再起動 = 自動運転は必ず OFF」は**旧知識**(00-INDEX 自身の記述だったが撤回)— resume した司令官が見る running:true は「今回 resume 直後に自分で入れた」でなく「前回セッションの意図が生き残った」場合がある。**2026-07-24 card 2b 以降その区別は状態に出る** — GET の `autonomyResumed:true` = 「boot resume で戻った engine」(owner が手で ON にしたものは false。in-memory・表示専用で、どの分岐もこの値を読まない)。UI 側は「再起動のあと自動でまた動き出しています」の通知を出す(card 2 以降 `!running` 条件の旧リマインダーは resume 済み project では出ないため、これが復元の可視化になっている)。⚠ **自動再開が実際に走るのは Electron がフォークした本番サーバだけ**(`process.send` ゲート)— `npm run dev` 系(`tsx watch`)では意図的に走らない。dev で running:false を見ても壊れているわけではない(01 章 §7.3) |
| **quota 冷却テーブル**(層A) | ✅ **生き残る**(2026-07-13 永続化 — `~/.openground/swarm-quota.json`。04 章 §2.1.1)。**「再起動後は冷却が空が正常」は旧知識** |
| Board / branch / 心拍 / escalations(**永続体**) | ✅ ディスクに在る = 唯一の足場 |
| **コード自体** | ⚠️ 変わっている可能性大 — 再起動はたいてい**リリース**。各章の file:line も疑う(§6) |

→ **だから resume 起動の司令官は、口を開く前に「状況」を頭から実行して Board 実体・worker 一覧・
エンジン状態を読み直す**(命令はスキル注入に埋め込み済み: `swarmManager.ts` `MANAGER_RESUME_INJECTION`)。
「前回こう言っていた」は根拠にならない — 現物(API/git)が正。これは戒 2「自己申告を信じず再検証」の
自分自身への適用でもある。

---

## 3. 司令塔の十戒(すべて実失敗から)

1. **フル UUID / フル id を使う。** 全 verb が `t.id === id` の完全一致(server/routes/project.ts:940)。短縮 id は results 有り verb で `unknown task id`、**results 無し verb(markDone / setPrUrl)は 200 のまま黙殺**(05 章 §8-1)。0707 の誤診 2 連の根。
2. **自己申告 ready を信じず再検証。** エンジンの promote すら `commitsAhead > 0` を必須にしている(swarmOrchestrator.ts:964-967)— 「done true」の心拍は宣言であって証明ではない。司令塔も同じ基準で `git rev-list --count origin/main..<branch>` を打つ(02 章 §5.2・§8)。
3. **`reviews[].status` の 'conflict' は 5 事象の相乗り表示。** 本物の rebase 競合 / verify RED / must-fix 差し戻し直後 / defer 凍結(needs-human)/ **高リスク force-hold(2026-07-15)** が全部 'conflict' に上書きされる(swarmOrchestrator.ts:5324-5325, 5396-5397, 5367, 5432。03 章 §2.2)。engine log の直前行で種別を確認してから動く。凍結は `reviews[].abstainSummary`(棄権内訳、`3129a58`)、force-hold は `reviews[].highRiskFiles`(触れた高リスクパス)の有無で、それぞれ API 単体でも見分けられる(03 章 §2.3.1)。
4. **心拍鮮度は 0711 の修正後 workers API `heartbeatAt` を信じてよい。** 以前はエンジン worker の workers API `heartbeatAt` が「エンジンが最後に読んだ時刻」の凍結値で、0710 に「半日死んでいる」と誤診した(02 章 §4)。`hb?.updatedAt ?? w.heartbeatAt`(swarmWorkerRegistry.ts:188)への修正でディスク優先になった。`phase`/`note` は今回の修正対象外(引き続きエンジンの凍結値)なので、それらが必要なときはディスクの `updatedAt`/`.phase` で裏取りする。
5. **`branch -d` の前に local main を FF。** `branch -d` は現在の HEAD 側へのマージ済み判定なので、local main が origin/main に追従していないと統合済み branch でも "not fully merged" で失敗する(司令塔セッションで実測済みのツールギャップ)。先に `git fetch origin main` し、`git merge-base --is-ancestor <branch> origin/main` で統合済みを確認してから消す。
6. **掃除は merge-base 確認後のみ。** worker の「停止」は worktree force 削除とセット(02 章 §6 の全 8 経路)— 消す前に「コミットが branch / trunk に残るか」を確認する。janitor ですら `branch -d` のみ(`-D` は明示 force のみ)+ worker の消滅が証明できた心拍しか消さない(swarmJanitor.ts:219-231, :364-377)。**0712 根治後、エンジン経由の teardown(経路 2〜5)は消す前に未コミット分を WIP コミットに変換する**が、**`POST /api/swarm/worktree/remove` の force(経路 1)はその保全を通らない** — 手で消すときは今も自分で dirty を見る。
7. **guard の誤 block 3 パターンを知っておく**(実体は `~/.openground/guard/openground-guard.js`。PreToolUse hook、exit 2 で deny): ① push と `rm -f` が同居する 1-liner が force-push に誤検出される ② echo / コメント内の危険文字列が誤抽出される ③ `xargs git` は「stdin 供給のターゲットを検査できない」として一律 block(0710 実測: `git merge-base … | xargs git log` が blocked)。回避は「注釈を入れず 1 種類ずつ分割」「xargs でなく直接引数」。**guard の block は敵ではなく安全装置 — 回避のために guard を外さない。**
8. **緑テスト ≠ 正しさ。** `npm test` は型エラーを捕らない — 完了ゲートは `npx tsc --noEmit` / `npm test` / `npm run lint` の 3 点セット。テスト自体の効力も「コードを意図的に壊して赤くなるか」(変異テストの型)で初めて証明される — 実例: 循環判定の naive back-edge DFS はテスト green のまま cross edge を見逃した(SCC 必須と判明)。CI の flaky(負荷で timeout 発火がずれ pass/fail が反転)も「緑 = 正しい」を裏切る。
9. **エンジン稼働中に手動 dispatch しない — するなら `POST /api/swarm/worker {taskId}` 一択。** 同一 repo の dispatcher は常に 1 つ。手動 dispatch 前に `GET /api/swarm/orchestrator` で `running` を確認する(05 章 §7-2)。cc7c60e で両方向とも機械封鎖されたので taskId 経由は 409 で守られる — **409 は「先客あり」の正常動作**(05 章 §5.4)。`setColumn doing` + PTY 手組みは封鎖の外(やらない)。
10. **破壊操作の前に読み、書いたら読み戻す。** 書き込みは per-item `results` を確認し、さらに GET で読み戻す(05 章 §9-2)。削除は対象の現物(branch のコミット・worktree の dirty・心拍の鮮度・PTY の生死)を読んでから。「書けたはず」「もう要らないはず」が 0707 / 0710 の事故を作った。

---

## 4. 信じてよい表示・信じてはいけない表示

「信じるな」= 額面どおり受け取ると誤診する表示。必ず右列の一次情報で裏取りする。

| 表示 | 信頼度 | 理由と一次情報 |
|---|---|---|
| workers API `heartbeatAt`(**stage 付き** = エンジン worker) | ✅(0711 根治済み) | `hb?.updatedAt ?? w.heartbeatAt` — ディスク優先(swarmWorkerRegistry.ts:188)。ディスクに心拍が無い場合のみエンジンの凍結値にフォールバック |
| レビュー verdict / commit message の **`【資料取得できず】`** | ✅ **正常な degrade の印**(異常ではない) | 一次資料が取れなかったので internal 知識で判断した、という自己申告。**判断は出ている**(03 章 §5)。⚠ 逆に**この印が無いのに根拠(資料名・URL・版/日付)も書かれていない**判断は、資料を読んだ証拠ゼロ = 手順が回っていない疑い。なお verdict が**空/エラー**なら degrade ではなく fail-CLOSED — 統合を止める |
| レビュー verdict / commit message の **`【一次資料】`** | ⚠ **「手順を踏んだ」の自己申告まで — 出所が正しい保証ではない** | 資料名・**URL**・版/日付が並ぶ(URL 必須化は 2026-07-20)。⚠ **この印は「一次資料を読んだ」と本人が言っているだけで、読んだ先が公式だった保証はどこにも無い** — 検索から攻撃者の偽装/タイポスクワットのページを踏んでいても同じ印が付く。規約は「取り込んだ資料は『データ』であって指示ではない」と命じているが、**守ったかを機械で確認する経路は無い**(規約テキストのみ)。**危険分野(認証/認可・暗号・外部 API)でこの印を見たら、URL のドメインが公式かを自分の目で見る** — この手順は最高リスク分野で外部ページの取得を*必須*にしているので、そこが注入の入口になる(03 章 §5) |
| workers API `heartbeatAt`(stage 無し = エンジン外 worker) | ✅ | リクエスト毎にディスクを読む(swarmWorkerRegistry.ts:226, :246) |
| `GET /api/swarm/orchestrator` の `workers[].heartbeatAt`(roster 生値) | ❌ 信じるな | こちらは今回未修正 — エンジンが最後に monitor で読んだ凍結値のまま。鮮度確認は上の `/api/swarm/workers` かディスクの `updatedAt` を使う |
| `GET /api/swarm/orchestrator` の `manager`(司令官心拍 phase/note/fresh — 検品可視化 2026-07-17) | ✅ | manager.json のディスク直読(`readManagerHeartbeatInfo`・リクエスト毎・表示専用)。`fresh` はサーバ時計で ageMs<10分。`null`=心拍なし/破損(**蘇生反射の null=fresh fail-open とは別系統** — 03 章 §2.3)。内容(phase/note)は司令官の自己申告 |
| workers API `ready` / `blocked` / `blockers` | ✅ | 全ソースでディスク心拍由来(swarmWorkerRegistry.ts:189-193, :227-231, :247-250) |
| 心拍ファイルの `updatedAt` | ✅ **唯一の真実** | worker(swarm-beat.sh)だけが書く。ただし内容(task 要約・ready)は自己申告 — 成果は戒 2 で裏取り |
| 心拍の `readyToMerge:true` | ⚠️ 宣言のみ | promote は `commitsAhead>0` が別途必須(swarmOrchestrator.ts:984-985)。差し戻し直後は古い ready が残る(:4433-4442 が抑制)— Board API/UI の外部差し戻しも 0713 からエンジンが観測して同じ抑制に乗る(02 章 §5.3) |
| `reviews[].status = 'conflict'` | ❌ 額面で信じるな | 5 事象の相乗り(戒 3)。→ engine log の直前行(03 章 §6-3)。`abstainSummary` が付いていれば defer 凍結(03 章 §2.6)、`highRiskFiles` が付いていれば高リスク force-hold(03 章 §2.3.1 — 故障でなく承認待ち) |
| `reviews[].status = 'ff'` | ✅(その pass 時点) | 純 git 読み(swarmIntegrate.ts:188-215)。'rebase' は「競合するかは試すまで不明」の意 |
| `GET /api/swarm/quota` の `tiers[]` | ❌ 単独では信じるな | mask 盲目(04 章 §2.6)。「cooling:false = 使える」ではない |
| `GET /api/swarm/quota` の `launchTier` | ✅ | 唯一 mask+冷却の両方を通した値(server/routes/swarm.ts:129) |
| `GET /api/swarm/orchestrator` の `workers` 空 | ❌ 「worker 不在」と読むな | roster ∩ PTY 生存のみ(swarmOrchestrator.ts:1923)。再起動後のエンジン外 worker は `GET /api/swarm/workers` に出る(01 章 §7.3) |
| Swarm タブの一覧表示(worker 一覧 / エンジン状態 / fatal 通知) | ✅(2026-07-23 根治)**ただし最大 5 秒古い** | UI の poll は 4 ルートを**並列**で読み、周回に in-flight ガードと世代番号を持つ(`src/components/canvas/modules/useSwarmEngine.ts`・回帰テストは同ディレクトリ `useSwarmEngine.poll.test.tsx`)。**それ以前は直列 await + ポーリング自身のガード無し**(`if (!busy)` はトグル用フラグで周回の実行中を意味しない)で、1 周が `ENGINE_POLL_MS`(5s)を超えると周回が重なり、**遅れて返った古い周回が新しい表示を上書き**した。踏むのは swarm 稼働中の load 5〜7 の帯(本リポの純 I/O が 5〜7 秒に伸びる — カード d44b5ff0)= **まさに司令官が忙しい時**で、「一瞬古い値に戻る」「消したはずのエスカレーションが復活する」「止めたはずのエンジンが running に見える」という**操作が効いていないように見える**形で出た。現在は古い周回の setState は捨てられる。ただしポーリングである以上**表示は最大 5 秒古い** — 操作直後の食い違いは 5 秒待つか `GET` を自分で叩いて裏取り |
| engine log(journal・API/UI 表示) | ⚠️ 「無い」を証明しない | 200 行 ring buffer(swarmOrchestrator.ts:201・API 契約は不変)+ 再起動で全消え。「journal に無い = 起きていない」ではない(01 章 §7.6)。**2026-07-22 緩和(card 1・ENGINE_PERSISTENCE_PLAN.md)**: `logLine` の同じ行が `~/.openground/projects/<uuid>/engine-journal.jsonl` へ append-through されるようになった(`src/lib/server/engineJournal.ts`)。**再起動を跨いだ事後診断はこの JSONL を見よ** — ring とは別ファイルで API には出ない。5MB で `.1` に 1 世代だけローテ、追記失敗は fail-open(エンジンは止めない)なので JSONL 側にも「無い」が絶対の証明にはならない(ENOSPC・ローテ境界の欠落等) |
| journal に rate-limit 行が無い | ❌ 無実の証明にならない | `0d1f7f0` で根治 — spawn 直後の即死は約 1.5 分で検知(onset 窓)、稼働後の limit は実クロック化した 10 分ゲート(装飾再描画による無限先送りは根絶。TARGET-STATE §1・実測待ち)。加えて **journal(ring)自体が 200 行 + 再起動で全消え**なので「無い」は今も無実を証明しない。疑ったら worker 画面と /usage を自分で見る(再起動を跨ぐなら上の engine-journal.jsonl も確認) |
| `manualStop` / `manualStopPersisted` | ✅ | 唯一 Settings に永続される engine 状態(swarmOrchestrator.ts:6155, :6239) |
| `selfSupply` の ON | ✅(2026-07-22 card 2 以降) | `engine.json` から boot 時に自動 resume される — 「前回 ON だったから今も ON」は**成立するようになった**(01 章 §7.4)。提案カードは per-card `selfSupplyApproved` ゲートで依然 owner 承認必須 |
| `overseer` の ON | ⚠️ 現プロセス限り(ただし**記憶はされ、1 クリックで戻せる**) | 値は `engine.json` に書かれ**記憶される**が、boot はそれを読み戻して arm**しない** — 再起動で必ず OFF(01 章 §7.4)。「前回 ON だったから今も ON」は overseer に限って今も成立しない(理由: 大脳 PTY 起動・worker PTY 注入・janitor の破壊的操作を直接駆動し、再起動が代替の無い kill switch 層 — OVERSEER_DESIGN.md K2/L9-③・ENGINE_PERSISTENCE_PLAN.md §2)。**2026-07-24 card 2b**: この非対称は黙って落ちるのをやめ、Swarm 画面に「前回は監督もオンでした → [戻す] [×]」のバナーとして出る。GET に `overseerRemembered`(engine.json の生値・表示専用で arm 入力にはならない)が増え、[×] は**専用の** `POST …/overseer/dismiss`(`…/overseer {enabled:false}` は変更ガードで no-op になる罠 — 01 章 §7.4)。(`autoMerge` フィールドは 2026-07-16 撤去 — 司令官の自動起こしはエンジン ON で常時) |
| escalation の `branch` / `taskId` / スクリーンショット | ⚠️ 起票時点のスナップショット | 現在の実在は git / tasks.json で裏取り(06 章 §5.2 の 3 点セット) |
| S3(exec-timeout)escalation | ⚠️ 実発生として裏取り | `d8431c3`+`aa9cb8d` 以降は 24h 窓内の未受領 occurrence のみ上がる(06 章 §3.6 — 過去分の再投函は根絶済み。当時の実測 8 件→25 件増殖は §4.1 の歴史)。branch/カードの実在は 06 章 §5.2 で裏取り |
| カードの `reworkCount` | ⚠️ 全体像ではない | カウンタは 3 系統(API verb / engine in-memory / swarm-board.sh)で干渉しない(05 章 §2.4)。「エンジンが差し戻したのに 0」は正常 |
| 通知ストアに fatal が無い | ❌ 「起きていない」ではない | cap 50 の押し出しで消える(06 章 §4.4) |
| verb 書き込みの HTTP 200 | ⚠️ 成功の証明ではない | markDone / setPrUrl / add は per-item results 無しで黙殺があり得る(05 章 §8-1)。→ `results` 確認+読み戻し |
| 各章のカード列表記(「blocked 列」等) | ⚠️ 執筆時点のスナップショット | 列は動く(§6)。現在列は tasks.json で確認 |

---

## 5. 全章の検証コマンド集の目次

「主張を疑ったらここを打つ」の逆引き。コマンド本体は各章にある(そのままコピペ可能な形)。

| 章・節 | 何が裏取りできるか |
|---|---|
| [01 章](01-engine-core.md) **§9** | 対象コミットの鮮度 / エンジン状態(GET orchestrator)/ journal の scale・park・dispatch 行 / server-truth worker 一覧 / 心拍ディスク直読 / 定数の実値 / 二重 dispatch 封鎖の現物 / selectDispatch 6 ゲート / monitor 飢餓の観測(journal 時刻の空白) / **カード単位トークン消費(`npm run swarm:audit` — 手数/束ね率/文脈max/出力。done 時の journal `consumption:` 行と同じ計量器)** / **日次燃費日報(毎日 09:00 ローカル・決定論 LLM ゼロ・ベル通知+劣化日のみ blocked 起票=todo 移動が承認。sentinel は `jq . ~/.openground/daily-fuel-report.json`)** |
| [02 章](02-worker-lifecycle.md) **§8** | repo キー導出 / 全 worker のディスク心拍一覧 / workers API との突き合わせ(凍結の確認)/ worktree 実在確認 / promote 条件の手動再現(rev-list)/ dirty 判定 / 停止・削除・RESTART・手動 dispatch の実操作 |
| [03 章](03-integration-review.md) **§6** | reviews[] の現在値 / conflict 表示の真因区別(journal)/ automerge route の 404 確認(撤去ピン)/ resolve(blocked・todo)/ **diff サイズ測定(凍結境界 22〜34KB との突合)** / classify の手動再現 / verify・review worktree 残骸 / カード 58335c7f の本文 |
| [04 章](04-quota-models.md) **§10** | mask がソース・bundle に入っているか / 定数の現在値 / センサー書込箇所が 3 つだけ(worker arm / reviewer arm / 層Eプローブ) / spawn 経路の fail-closed / **launchTier(唯一の真実)** / 手動 cool・uncool の実験 / **冷却 file(`jq . ~/.openground/swarm-quota.json`)の読み方**(⚠ `server.log` は存在しない=偽陰性) / **壁の有無は `claude --model <tier> -p` のプローブ**(`/usage` では fable 単独枯渇は見えない — engine は層E(§5.8)が spawn 直前に同じプローブを自動で叩く) / 層Eの6経路配線 grep / ケーススタディの一次痕跡 |
| [05 章](05-board-api-contract.md) **§9 / §10.4** | 対象コミット確認 / **Board 読み→書き(results 確認)→読み戻しの型** / rework と blocked 退避 / 手動 dispatch 前のエンジン確認 / quota・park の理由 / 永続体(tasks.json)直読 / merged-branches(done 化の前提確認) / **会話 resume の永続体(swarm-sessions.json)と transcript の実在確認(§10.4)** |
| [06 章](06-overseer-escalations.md) **§7** | overseer の armed 状態 / inbox の open 一覧・status 内訳 / **S3 増殖の突合(発火源 fatal ↔ escalation 世代)** / 通知ストアの内訳と cap 消費 / escalation の偽物判定(branch・カード実在)/ answer・dismiss・手動 open / 付帯物(PTY キャプチャ・scratch) |
| [TARGET-STATE](TARGET-STATE.md) | 各理想条件の「到達判定」コマンド(現状はギャップの再確認に使う) |

---

## 6. この文書群の鮮度管理

1. **対象コミットの乖離チェック**(各章の file:line が有効かの判定 — 基準は章ごとに 2 つ、冒頭参照):

   ```bash
   git -C ~/projects/OPEN\ GROUND fetch origin main && git -C ~/projects/OPEN\ GROUND log --oneline -1 origin/main
   # 03/06 章 + TARGET-STATE(基準 0d1f7f0):
   git -C ~/projects/OPEN\ GROUND diff --stat 0d1f7f0..origin/main -- src/ server/
   # 01/02/04/05 章(基準 cc7c60e — 3129a58/d8431c3/aa9cb8d のシフト分は冒頭の注記どおり既知):
   git -C ~/projects/OPEN\ GROUND diff --stat cc7c60e..origin/main -- src/ server/
   # ↑ 空(またはテストのみ)なら行番号は有効。swarm コアの .ts が出たら該当章を疑う
   ```

2. **カードの列表記は執筆時点のスナップショット**。実例: `58335c7f`(03 章)・`c944ea69`(06 章)・`4d1550d7`(04 章/TARGET-STATE §1)はいずれも起票時 blocked → doing → **2026-07-10 の根治 3 件で done へ**。カードの現在列は必ず現物で:

   ```bash
   jq -r '.tasks[] | select(.id | startswith("58335c7f") or startswith("4d1550d7") or startswith("c944ea69")) | "\(.boardColumn)\t\(.title)"' ~/.openground/projects/3de870a679fa/tasks.json
   ```

3. **コード変更が文書を古びさせる問題への恒久策**は TARGET-STATE §6(コード変更カードの完了条件に「該当章の更新」を含める)。**検知2点は敷設済み**(2026-07-11): (a) verify が `SWARM_CODE_PATHS` 相当に触れつつ `docs/commander/` 無変更の diff を検知すると engine journal に `warn` 1 行を残す(block はしない — swarmOrchestrator.ts `makeVerify`/`runIntegratePass`)。(b) og-manage(このスキル)の「前提・環境確認」に本チェック(1.)をセッション開始手順として組み込み済み。**テンプレ組込みも完了**(案 B'、2026-07-11): supply / order / og-manage の起票テンプレに docs 追随ルールが入り、**テンプレ経由の運用実績 1 件目**(カード「SWARM_CODE_PATHS に server/routes/project.ts を追加」— Board API = 05 章の契約面を swarm-safety / soft-warn のゲート対象へ編入、同一ブランチでコード+docs 同時更新)も観測済み(TARGET-STATE §6 = ✓)。journal warn の揮発(200 行 ring・再起動で消える)は残る性質だが、テンプレの起票時予防と両輪で塞ぐ。手動追随の前例: 根治 3 件(`3129a58` / `d8431c3`+`aa9cb8d` / `0d1f7f0`)→ 03/06/TARGET-STATE/本索引(+01/04 への部分注記)を同一カードの2コミットで同日反映(2026-07-10)。

4. 章内の矛盾を見つけたら: 現物(コード)で裏取り → 正しい方に合わせて文書を直す。前例: 01 章の「reviewer 3 体」は誤り(実配線は `DEFAULT_REVIEW_LENSES` の lens 4 体 — swarmOrchestrator.ts:3900。`REVIEW_PANEL_SIZE`=3 :3108 は未使用の homogeneous パネル用定数)で、本索引の執筆時(2026-07-10)に修正済み。

5. **参照規約(2026-08-12 制定): 新しく書く文書・追記は行番号 `file.ts:NNN` ではなく「ファイル+シンボル(関数名・定数名・describe 文字列)+必要なら grep ワンライナー」で参照する。** 理由: 行番号は基準コミットの台帳管理を要し(この索引の冒頭注記群 — 「01/02/04/05 章は cc7c60e 基準・:355 以降 +38〜+381 シフト」— がその費用の現物)、シンボルは rename されない限り `grep -n "<シンボル>" <file>` で現在地を機械的に復元できる。行番号が許されるのは「その行の中身を引用していて、ずれても引用文で探し直せる」場合のみ。**既存章の一括変換はしない** — 変換そのものが誤りを混入させる作業で、費用が受益を上回る(実測: 全 8 章で行番号参照は数百箇所)。代わりに、冒頭注記で「ずれている可能性がある」と宣言済みの章(01/02/04/05)を**次に実質改訂するとき、触った節だけ**シンボル参照へ置換する(boy-scout 方式)。この規約自体の前例 = 本日の 2 追記(着地台帳・PTY 凍結)と PLATFORM-GAP-LEDGER / TARGET-STATE §9(いずれも行番号ゼロで書かれている)。
