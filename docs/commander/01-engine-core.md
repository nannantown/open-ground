# 01 — エンジン中枢(tick / pass / dispatch / monitor)

**対象コミット: `cc7c60e`**(cc7c60e 自体が「二重 dispatch 封鎖(両方向)」のコミット)。本文中の `file:line` は全てこのコミットの行番号。無印の行番号は `src/lib/server/swarmOrchestrator.ts`(6349 行 — エンジンの全てがこの 1 ファイルにある)。
> **部分更新(2026-07-10)**: その後 `3129a58`/`0d1f7f0` が swarmOrchestrator.ts を 6730 行に変えた(:355 以降 +38〜+381 シフト — 00-INDEX 冒頭)。**特に `0d1f7f0` は本章の TL;DR#3 と §6(integrate による monitor 飢餓)を機構ごと過去にした** — 該当箇所に注記済み。現行の tick/integrate 構造の正典は 03 章 §2.1/§2.4。
**読者**: 司令塔(og-manage / manage セッション)。in-app swarm エンジン(自律 drain ループ)の心臓部 — tick の回り方・1 pass の中身・dispatch の選抜規則・monitor の全分岐 — をコード根拠付きで示す。
**関連**: `02-worker-lifecycle.md`(worker の生涯 / spawn の実体)、`03-integration-review.md`(統合と敵対レビューの詳細)、`04-quota-models.md`(quota 冷却とモデル mask)、`05-board-api-contract.md`(Board 列と API 契約)。

---

## 0. 司令塔が最初に知るべき 4 つの真実

1. **エンジンは丸ごと in-memory。** 全状態は `globalThis.__openground_swarm_orchestrator` 上の `Map<projectPath, ProjectEngine>`(:1520-1534)で、**プロセス再起動で全部消える**(worker roster・rework 予算・journal・KPI・全部)。ディスクに残るのは Settings の 2 フラグ(`swarmAutonomyOn` = 「前回 ON だった」リマインダー :5805、`swarmManualStop` = 「手で止めた」記録 :5848)とカード側の stamp(`branch` / `integrationConflict`)だけ。~~再起動後のエンジンは必ず `running:false` で~~、**追記(2026-07-22, card 2 — docs/ENGINE_PERSISTENCE_PLAN.md)**: この一文は **撤回**。`desiredRunning:true` で明示的に走っていたプロジェクトは、その project の `engine.json`(`~/.openground/projects/<uuid>/engine.json`)を根拠に boot の `resumeEngines()` が人手ゼロで `running:true` へ戻す(owner の `manualStop` 永続記録が常に勝つ・同一バージョンで短時間に再起動が繰り返されたら crash-loop breaker が抑止)。詳細は §2.1(改訂版)・00-INDEX §2.1。**再起動前に走っていた worker の PTY・worktree・branch・心拍ファイルは生きたまま「エンジン外」になる**点(§2 の寿命列)は変わらない — worker roster 自体の write-through は別カード(card 3、未着手)。
2. **tick はキューではない。** 3 秒の setTimeout チェーン(:5753-5766)が 1 pass ずつ直列に回し、`passInFlight`(:1320)は「pass 実行中に来た別の起動要求を **bail させる**」再入ガード — 待ち行列ではない。遅い pass の間に予定されていた tick は**消える**(次にチェーンが arm されるのは今の pass の `.finally`)。
3. ~~**統合パスは pass の中で直列 await される**~~ — **`0d1f7f0`(2026-07-10)で歴史になった**。当時は `runEnginePass` が dispatch → integrate の順に await し(:5681-5682)、integrate の中の verify(tsc timeout 180s :2530-2535 / vitest run timeout 600s :2790-2795 をインライン await)と敵対レビュー(lens レビュアー 4 体 × timeout 5 分 :3240)が走っている間、**monitor は一切走らなかった** — quota 検知・stall 検知・promote が数分飢餓した(§7.1、実測 2026-07-09・カード `4d1550d7` → `0d1f7f0` で done)。**現在**: integrate は `kickIntegratePass` で tick の脇に fire-and-forget 化され(`integrateInFlight` 再入ガード)、monitor は verify/panel 中も 3 秒 tick で回る。Board/workers を書く区間だけ `runExclusive` で直列化。正典 = 03 章 §2.1/§2.4(0d1f7f0 基準の行番号つき)。
4. **二重 dispatch 封鎖は両方向**(cc7c60e)。エンジン→手動の窓は「picks **全件を spawn 前に予約**」(`pendingDispatch` :4520-4522)+ 手動 route が `isCardDispatchInFlight`(:1626)を照会して塞ぎ、手動→エンジンの窓は「**spawn 直前に board を読み直して todo 再検証**」(:4543-4558)で塞ぐ。エンジン vs エンジンは `passInFlight` + `runExclusive` + generation ガードの三重(§3)。

---

## 1. 構造 — 何がどこにあるか

| 責務 | 場所 |
|---|---|
| エンジン本体(state・tick・dispatch・monitor・integrate・anomaly・制御 API) | `src/lib/server/swarmOrchestrator.ts`(この章の主題) |
| 起動モデル/エフォート解決(実行モード × カード重み × quota × mask) | `src/lib/server/swarmLaunch.ts` — `SWARM_LAUNCH_MODEL='fable'`(:52) / `resolveSwarmModelEffort`(:257) / `execModeMaxWorkers`(:272) |
| tier 冷却テーブル([Quota] 層) | `src/lib/server/swarmQuota.ts` — `MODEL_TIER_LADDER` / `markRateLimited` / `spawnBlock`(詳細は 04 章) |
| tier ON/OFF mask([Allowed] 層) | `src/lib/server/swarmAllowedModels.ts`(詳細は 04 章) |
| worker spawn の実体(worktree + claude PTY + /order 注入) | `src/lib/server/swarmWorker.ts` — `spawnSwarmWorker`(:455)(詳細は 02 章) |
| 優先度ソートの一次ソース | `src/lib/boardPriority.ts` — `sortByPriority`(`sortTodos` :418 が委譲) |
| HTTP routes(swarm owner gate + validateProjectPath) | `server/routes/swarm.ts` — GET `/api/swarm/orchestrator`(:486)、POST `…/drain-tick`(:516)、`…/start`(:546)、`…/stop`(:570)、`…/worker/stop`(:591)、`…/review/resolve`(:636)、`…/selfsupply`(:661)、`…/overseer`(:688)。(`…/automerge` は 2026-07-16 撤去 — 404。回帰テストでピン)。gate = swarmGate.ts(owner ログイン or ローカル解錠 — docs/SECURITY.md) |
| 状態の公開形 | `src/lib/types.ts` — `SwarmOrchestratorState`(:1280)。**`pendingDispatch` / `lock` / `generation` / 各種 Map は API に出ない**(`stateOf` :1836-1873 が返すのは running/manualStop(+Persisted)/selfSupply/overseer/workers(生存のみ)/reviews/log/anomalies/maxWorkers/kpis/consumption/autonomyRemembered/parkUntil のみ。`autoMerge` フィールドは 2026-07-16 撤去) |

エンジン stage の全景(1 tick = `runEnginePass` :5667):

```
scheduleNext(TICK_MS=3s) ──▶ runEnginePass
  ├─ passInFlight CAS(:5671-5672 — 二重 pass は bail)
  ├─ runExclusive( runDispatchPass )        (:5681)   ← control-plane と FIFO 直列化
  │    ├─ 1. board 全読み                    (:4397-4405)
  │    ├─ 2. monitorWorkers(監視・promote・回収) (:4410)
  │    ├─ 3. reconcile(todo→doing 再試行)     (:4418-4429)
  │    ├─ 3b. SPAWN PARK(quota/mask ゲート)   (:4450-4467)
  │    └─ 4. fill(scale → selectDispatch → 予約 → 再検証 → spawn) (:4473-4610)
  ├─ runIntegratePass(throttle 15s)          (:5682)   ← verify/レビュー/land(03 章)
  ├─ pruneStuckMoves + pruneReworks + detectAnomalies (:5689-5693)
  ├─ fireFatalNotifications(致命イベント→人へ) (:5703)
  ├─ runOverseerPass(await・guarded。brain 起動は fire-and-forget) (:5713-5718)
  ├─ kickSelfSupplyPass(fire-and-forget)      (:5732-5738)
  └─ finally passInFlight=false               (:5739-5741)
```

---

## 2. ProjectEngine — 全フィールドの意味と寿命

型定義 :1294-1518。**全フィールドが in-memory**(再起動で消える)。「永続の半身」列は、消えた後もディスク側に残る対応物。初期値は `getOrCreateEngine`(:1536-1573)、旧ビルドの engine への欠損 backfill は :1574-1607(dev の tsx watch 越え用)。

| フィールド(行) | 意味 | 消えたときの影響 / 永続の半身 |
|---|---|---|
| `path` :1296 | canonicalize 済み project path = engine のキー | — |
| `running` :1298 | 自律 drain チェーンが予約されている間 true | ~~再起動で必ず false(自動再開なし)~~ **旧知識(2026-07-22 card 2 で撤回)** — `desiredRunning:true` だった project は boot の `resumeEngines()` が自動で `running:true` へ戻す(owner の `manualStop` が勝つ・crash-loop breaker あり。§0/§7.4 改訂版)。半身: `Settings.swarmAutonomyOn`(リマインダー表示のみ :6181)+ 新設 `engine.json`(`desiredRunning` — 実際に resume を駆動する側はこちら) |
| `manualStop` :1309 | owner が明示 OFF した(auto-drain 抑止) | 半身: `Settings.swarmManualStop`(:5848 で書き :5800 で消す。`maybeAutoStartDrain` :5932 と `stateOf` :1858 が読む — 0707 twin-dispatch の根本対策) |
| ~~`autoMerge`~~ | **フィールドごと撤去(2026-07-16)** — 旧「司令官自動起こし」の arm。起こし反射は `running` に常時同乗になった(トグル無し・03 章 §2.3) | —(存在しない。GET 応答にも出ない) |
| `passInFlight` :1320 | pass 実行中フラグ = **二重 pass 防止の bail であってキューではない** | — |
| `lock` :1329 | `runExclusive`(:1745)の FIFO promise chain 尾。dispatch pass と owner の stop/resolve を直列化 | — |
| `generation` :1335 | start epoch。stop→start で bump し、**古いチェーンの `.finally` が第 2 タイマーを arm するのを殺す**(:5758) | — |
| `timer` :1337 | 次 pass の setTimeout ハンドル(停止中 null) | — |
| `workers` :1339 | エンジンが dispatch し数えている roster(`OrchestratorWorker[]`) | **再起動で消える = 生きた PTY/worktree が「エンジン外 worker」になる**(GET `/api/swarm/workers` には出続ける — 02 章 §3.3) |
| `reviews` :1342 | review 列 swarm カードの統合 readiness 表示(統合 pass A 半で更新) | 表示のみ。次の統合 pass で再計算 |
| `conflictedBranches` :1346 | 実 rebase が conflict した branch の memo(再 rebase churn 防止) | カード側 stamp `integrationConflict` が永続の半身 |
| `verifyFailed` :1352 | verify RED の branch → 落ちた tip sha(同 tip 再検証スキップ) | 消えると同 tip を 1 回だけ再 tsc(無害) |
| `reviewFailed` :1359 | 敵対レビュー must-fix の branch → tip(同 tip 再パネル抑止) | 消えると同 tip にパネル 1 回再燃(claude 3 セッション) |
| `reviewDeferred` :1366 | 多数決つかず(defer)の連続回数 memo。`MAX_REVIEW_DEFERS`=3(:258)で needs-human 化 | 消えると defer 連敗カウントがリセット |
| `lastIntegrateAt` :1368 | 統合 throttle(`INTEGRATE_TICK_MS`=15s :197)の基準時刻 | — |
| `recoveries` :1373 | カード(taskId)ごとの lost-worker 再 queue 回数。`RECOVER_MAX_REQUEUE`=1(:217) | 消えると crash リトライ予算がリセット(ループの天井が一時的に甘くなる) |
| `reworks` :1383 | 差し戻し(review→doing)回数。`MAX_REWORKS`=2(:238)。'todo' では**prune しない**(:5525-5530 — 再 dispatch を跨いで予算が生きる) | 同上(差し戻し予算リセット) |
| `reworkReasons` :1395 | **学習ループ**: 最後に差し戻された理由。`reworkOrPark` が書き(:4713)、再 dispatch が /order へ注入して消費(:4535, :4567)、owner の escalation 回答も同じスロットに乗る(:1690-1712、`mergeReworkReason` :1662 が回答セグメントを保護) | 消えると再投入 worker が前回の失敗理由を知らずに走る |
| `conflictReworks` :1406 | 統合 conflict の rebase 委譲回数。`MAX_CONFLICT_REWORKS`=3(:248)— `reworks` とは**別予算**(conflict は worker のコード品質でなく trunk が動いた結果) | 予算リセット |
| `stuckMoves` :1413 | Board 列 move が kept され続けるカードの追跡。`MOVE_STUCK_MAX_RETRIES`=5(:226)で anomaly 化 | — |
| `nudges` :1423 | terminalId ごとの stall nudge 予算(count / lastNudgeAt / escalated) | — |
| `rateLimited` :1430 | terminalId ごとの rate-limit hold 開始時刻(`since`) | **消えると hold 時計がリセット** — 再起動直後は grace を数え直す |
| `permissionWaits` :1437 | 権限/trust プロンプト待ちの開始時刻 + auto-accept 済みフラグ | 同上 |
| `questionRaised` :1445 / `questionWaits` :1453 | 自由文質問の escalation 受付キー / hold 時計(`QUESTION_GRACE_MS` :372) | 同上 |
| `log` :1455 | journal ring buffer(`MAX_LOG_LINES`=200 :201、`logLine` :1762) | **再起動で全消え** — 過去の dispatch/integrate 履歴は git log とカードにしか残らない |
| `anomalies` :1458 | 直近 pass の検出結果(毎 pass 再構築 :5693) | — |
| `selfSupply` :1463 | 自己補給 runtime(armed + throttle + 日次 cap)。既定 OFF | ~~再起動で OFF(fail-safe)~~ **旧知識(2026-07-22 card 2)** — `engine.json` の `selfSupply` が true なら drain 再開と同時に自動で再武装する(提案カードは引き続き owner 承認ゲート済みなので risk は低いと判断)。**`overseer` は対象外のまま** — 大脳 PTY 起動・worker 注入・janitor の破壊的操作を直接駆動し、再起動が代替の無い kill switch 層(OVERSEER_DESIGN.md K2/L9-③)であることを優先し、engine.json には値を書くが boot では読まない(意図的な非対称。plan §2 の [hold] 論点は 2026-07-22 の設計レビューで確定 — §7.4 に詳細) |
| `overseer` :1471 | 監督ノード runtime。既定 OFF・**明示 stop で disarm される非対称**(:5863-5866) | 再起動で OFF(K2)。auto-drain 再点火では決して arm されない(:6393-6396)。**boot resume(2026-07-22 card 2)でも同じ** — `engine.json` には値を書くが `resumeEngines()` は読まない(意図的な唯一の例外。selfSupply/running との非対称は上表 :85 参照) |
| `notified` :1477 | 状態由来 FATAL の rising-edge dedup(解消で忘れて再発なら再通知 :5644-5652) | 消えると持続中の fatal が 1 回再通知(無害) |
| `pendingFatal` :1482 | monitor が enqueue した one-shot FATAL(例: exec-timeout :4017)。pass 末尾で drain(:5605-5608) | 消えると未送の通知が失われる |
| `metrics` :1487 | KPI 生涯カウンタ(`logLine` の choke point で bump :1779-1783) | 再起動でゼロ(per-session roll-up) |
| `lastScaleSig` :1493 | scale 決定 journal の変化時のみ記録用署名(:4497-4506) | — |
| `parkUntil` :1500 | 全 tier 冷却中の最早 reset(dashboard 表示用ミラー — 真実は swarmQuota 側) | — |
| `spawnBlockSig` :1506 | SPAWN PARK の enter-edge 署名(`'none-allowed'` \| `'cooling:<ms>'`)。journal を 3 秒毎に汚さないためのエッジ検出 | — |
| `pendingDispatch` :1517 | **今まさに spawn 中のカード id 予約**(cc7c60e)。spawn 前に全 picks を登録(:4520-4522)、finally で自分が積んだ分だけ解放(:4602-4610)。手動 route が `isCardDispatchInFlight`(:1626)で照会 | — |

---

## 3. tick の連鎖構造(状態機械)

### 3.1 チェーンの回り方

- `scheduleNext`(:5753-5766): `setTimeout(TICK_MS=3000)`(:190)→ `runEnginePass` → **`.finally` で次を arm**。setInterval ではないので pass が自分と重なることは構造的にない。arm 条件は `engine.running && gen === engine.generation`(:5758)— stop→start を挟んだ古いチェーンは次の arm 時点で死ぬ(重複チェーン zombie の防止)。
- `runEnginePass`(:5667-5742)の実行順は §1 の図のとおり。重要な形:
  - **`passInFlight` は入口で同期 check-and-set**(:5671-5672)。走っている pass がいたら**bail(待たない)**。`finally` で必ず解放(:5739-5741)。
  - **dispatch pass だけ `runExclusive` に包む**(:5681)。`runExclusive`(:1745-1760)は per-engine の FIFO promise chain で、owner の `stopOrchestratorWorker`(:6025)/ `resolveOrchestratorReview`(:6099)/ escalation 回答の書き込み(:1703)と dispatch pass を直列化する。塞ぐバグ: monitor の await 窓(countCommitsAhead / readHeartbeat)中に stop が割り込むと、stop が park したカードを古いスナップショットの monitor が todo/review へ書き戻す(:1720-1731)。
  - **integrate pass は意図的に `runExclusive` の外**(:5717, :1739-1744)— 数分級のレビュー待ちで owner の stop クリックをブロックしないため。代償として resolve-vs-integrate の狭い窓が残る(integrate 側の再チェック :5110 が部分緩和)。**`0d1f7f0` 後**: integrate は pass からも分離され(tick は kick するだけ)、Board/workers を**書く**区間(reworkOrPark / delegateConflict / land)だけが `runExclusive` に入る形に進化 — 「遅い await は lock 外」の原則は不変(03 章 §2.4)。
  - anomaly 検出(:5689-5693)・FATAL 通知(:5703)・overseer(:5713-5718 — pass 自体は await するが内部 catch 付き。brain 起動は fire-and-forget)・self-supply kick(:5732-5738 — **await しない**。かつて await していて 8 分級の scan が monitor を凍らせた前科がコメントに残る :5726-5731)は全て guarded で、失敗しても tick を壊さない。

### 3.2 start / stop(公開制御面)

- `startOrchestrator`(:5783-5827): claude preflight(:5789、不可なら `ClaudeNotReadyError` → route が 503)→ `manualStop=false` + 永続記録の消去(:5797-5800)→ `swarmAutonomyOn` を記録(:5805 — **リマインダー用で auto-resume はしない**)→ `lastIntegrateAt=0`(:5811 — 再開直後に統合 readiness を即更新)→ `generation` bump(:5814)→ **即 1 pass kick してからチェーン arm**(:5819-5821)。
- `stopOrchestrator`(:5833-5878): `swarmAutonomyOn` 消去(:5842)→ `swarmManualStop` 永続記録(:5848 — **engine 不在でも書く**。再起動を跨いで「手で止めた」が外から読める)→ `manualStop=true`(:5855)→ **overseer を disarm + brain abort**(:5863-5866 — 非対称 D1)→ timer clear(:5867-5873)。**走行中の worker は止めない**(手動制御面の仕事)。
- 個別 worker の停止は `stopOrchestratorWorker`(:6010-6065)— runExclusive 内で teardown(:6033)→ カードが doing のままなら **'blocked' へ park**(:6038-6050 — 'todo' でなく blocked なのは「エンジンが次 tick で拾い直す」のを防ぐため)→ 予算 3 種を消す(:6052-6054)。
- review 詰まりの人力解決は `resolveOrchestratorReview`(:6082-6168)— review 列のカードのみ対象(:6108)、move 先着(:6115-6124)→ worker teardown(branch は残す :6131-6139)→ 全 memo 掃除(:6144-6159)。

### 3.3 「勝手に点く」系統は 3 つ、生きているのは実質 1 つ

1. **`drainTickOrchestrator`**(POST `/api/swarm/orchestrator/drain-tick` :6211-6229): **card eadb25e6 で auto-start 廃止済み** — 今は純 read(getOrCreateEngine + stateOf)。Swarm ペインを開いても点火しない。
2. **`maybeAutoStartDrain`**(:5920-6000): 「idle slot + 独立 todo あり」で停止中 engine を点火する唯一のロジック。ガードは 4 重 — running/passInFlight/manualStop(:5927)+ **永続 manualStop**(:5932)+ preflight(:5963)+ commit 直前の再チェック(:5967)。点火時は inline で 1 dispatch pass を回してからチェーン arm(:5988-5998)。
3. **`startAutoDrainLoop`**(:6305-6318): 全登録プロジェクトを `AUTO_DRAIN_SCAN_MS`=15s(:397)で総なめして 2. を呼ぶ boot ループ。**`OPENGROUND_SWARM_AUTODRAIN=1` の厳密 opt-in**(:6293-6295 — unset/'0'/'true' 全て OFF)。server/index.ts だけが呼ぶ。

つまり**既定ビルドでは、停止中 engine を点火できるのは owner の POST `/start` だけ**。「停止中 engine は点火しない」を前提に司令塔は動いてよい(auto-memory の eadb25e6 注記と一致)。

---

## 4. dispatch pass — scale・選抜・予約・学習ループ

`runDispatchPass`(:4388-4611)。board 1 読みで monitor と dispatch の両方を賄う(:4395-4405)。

### 4.1 scale / band(何体まで出すか)

- `live` = roster のうち PTY 生存数(:4473)。'done' 表示でも PTY が残っていればスロットを握る(:4469-4472)。
- `dispatchable` = `selectDispatch(tasks, countedIds, ORCHESTRATOR_MAX_WORKERS)`(:4480)— **ゲートを全部通った独立 backlog の数**(生 todo 数ではない)。
- `target = computeTargetWorkers({live, dispatchable, max: execModeMaxWorkers(mode, 6)})`(:4481-4487)。式は `demand = live + dispatchable; demand===0 ? 0 : clamp(demand, min=1, max)`(:603-616)。max は実行モードで縮む: economy 2 / optimize 4 / max 6(swarmLaunch.ts:272-275、ハード天井 `ORCHESTRATOR_MAX_WORKERS`=6 :175、floor `ORCHESTRATOR_MIN_WORKERS`=1 :185)。
- 新規 spawn 数 `slots = max(0, target - live)`(:4492)。**縮小は受動的**(target < live でも殺さない — PTY 退場で自然減 :4488-4491)。
- scale 決定は target が**変わった時だけ** journal に出る(:4497-4506、`lastScaleSig`)。

### 4.2 SPAWN PARK(quota / mask ゲート)

fill の直前(:4450-4467)。`spawnBlock(now, allowedTiers)` が非 null なら**新規 dispatch を全停止**(monitor/reconcile は動く)。2 種: `all-cooling`(全有効 tier 冷却中 — `parkUntil` に最早 reset)/ `none-allowed`(owner が全 tier OFF — 期限なし、escalation を 1 回上げる :4348-4370)。enter-edge のみ log(`spawnBlockSig`)。解除も edge で log(:4463-4467)。詳細は 04 章。

### 4.3 selectDispatch — 6 ゲート(:509-572)

キュー順は `sortTodos`(:418 → `sortByPriority`: 実効優先度(静的 + aging)→ boardOrder → createdAt)。各候補に:

| # | ゲート | 行 | 中身 |
|---|---|---|---|
| ① | COLUMN | :553 | `todo` 列のみ候補(関数内で filter — 混合リストを渡されても守られる) |
| ② | ID | :555 | 既に counted worker がいる id はスキップ |
| ⑥ | SELF-SUPPLY | :561 | エンジン自案カード(`selfSupplyKey`)は owner 承認(`selfSupplyApproved`)まで不発 |
| ③ | CONTENT | :562-563 | title+notes の正規化キー(`contentKey` :433 — NUL 区切り :437-441)が active work / 先行 pick と重複したらスキップ |
| ④ | FILE | :564-565 | `files:` / `ファイル:` 指令行で**宣言された**ファイル(`declaredFiles` :457 — opt-in、散文中のパスは対象外)が claim 済みなら保留(同一ファイル作業の直列化) |
| ⑤ | DEPENDS | :566 | `dependsOn` の**実在する未 done** 前提がある間は保留(:526-529)。削除済み/typo の id は「満たされた」扱い — 永久 stuck にしない |

"active work" = doing 列 ∪ **review 列**(promote 済みでも未統合の branch は競合面)∪ counted workers(:536-543)。pick するたび claim 集合が育つので、同一 pass 内の衝突も防がれる(:567-569)。純関数(IO なし)。

### 4.4 予約 + spawn 直前再検証(cc7c60e の両方向封鎖)

1. **全予約が先**: picks 全件の id を loop 開始**前**に `pendingDispatch` へ(:4512-4522)。1 件ずつ予約すると picks[0] の spawn(数百 ms)の間 picks[1..] が無防備で、手動 `POST /api/swarm/worker` が `isCardDispatchInFlight()===false` を見て同カードに双子を立てる。
2. **spawn 直前に board 再読 + todo 再検証**(:4537-4558): 予約**前**に着地していた手動 claim(route の CAS が todo→doing 済み)は board にしか見えないので、pick スナップショットを無条件 spawn しない。todo でなくなっていたら skip(log: "claimed elsewhere")。
3. spawn 成功 → **column move より先に roster へ push**(:4569-4584 — move が落ちても counted になり、②ゲートが再 dispatch を塞ぎ、次 pass の reconcile(:4413-4429)が move を再試行)。
4. finally で**自分が積んだ予約だけ**解放(:4602-4610)。

### 4.5 reworkReasons 学習ループ

- 書き手: `reworkOrPark`(:4713)と `delegateConflict`(:4852)が**差し戻しのたび**最新理由で上書き(owner の escalation 回答セグメントだけは `mergeReworkReason` :1662-1671 が保護。区切りは制御バイト `\x1f` :1656)。
- 読み手: dispatch が spawn 前に読み(:4535)、**spawn 成功後にのみ delete**(:4567 — spawn が throw したら次 pass に残る)。`priorFailure` として `spawnWorker` → `buildOrderInjection` に渡り、fresh worker の /order に「前回の差し戻し理由」が焼き込まれる(02 章 §2.4)。dispatch log に注入の有無が出る(:4587-4592)。
- 掃除: `pruneReworks`(:5534-5559)が done/消滅で削除。**todo では消さない**(再 dispatch 待ちの注入材料)。owner 回答の合流点は `recordEscalationAnswerForNextDispatch`(:1690-1712 — runExclusive 内で書く。理由は「dispatch の read→spawn→delete と交錯すると読まれず消される」:1682-1686)。

---

## 5. monitor — 全分岐(monitorWorkers :3742-4340)

roster の各 worker を pass-start の board スナップショット(`byId`)と突き合わせ、`next` roster を再構築する。判定順(上から先勝ち):

| 順 | 条件 | 動作 | 行 |
|---|---|---|---|
| 0 | エンジン stop 中 | そのまま keep(触らない) | :3870-3873 |
| 1 | stage 'done' or カードが review/done 列 | PTY 生存中は 'done' で keep、exit したら slot 解放 | :3879-3883 |
| 2 | カード削除済み | 生存 → orphan として keep(数え続ける)。死亡 → `recoverLost`(掃除のみ・列は触らない) | :3888-3892 |
| 3 | カードが doing 以外(人が動かした) | 生存 → keep(todo なら reconcile が再 home)。死亡 → `recoverLost`(列は人のもの・掃除のみ) | :3897-3901 |
| 4 | doing: probe(commitsAhead :3907 + heartbeat :3912)→ `classifyWorker`(:3917) | promote 判定へ | :3904-3920 |
| 4a | **reworkAt 抑制**: 差し戻し直後は心拍ファイルが古い `readyToMerge:true` のままなので、差し戻しより**新しい**心拍が出るまで promote を落とす(re-promote race 対策)。落とした後も **fall through して stall/作業上限の監視は受ける**(ready 済みなので上限に当たっても暴走扱いにはならない — 02 章 §5.6) | | :5284-5292 |
| 4b | promote 成立(`commitsAhead>0 ∧ (ready ∨ (dead ∧ ¬blocked))` :1019-1022) | doing→review move(:5297)。kept なら `recordKeptMove` + 次 pass 再試行(:5335。**kept でも「納品した」事実は `readyAt` に刻む** — 02 章 §5.5(b))。**move 成功直後 = done 検知点で、その worker のセッション JSONL を計量した `consumption: 手数… 束ね… 文脈max… 出力…`(サブエージェントを使ったカードだけ末尾に `sub出力…(手数…)`)info 行を journal に 1 行記録**(2026-07-18 card swarm-token — optional dep `deps.readConsumption` :5310-5317。JSONL 不在/読取失敗/例外は黙って skip = fail-safe で promote・監視を一切妨げない。kind 無しなので KPI カウンタも汚さない。計量器の定義は §9 末尾) | :5294-5356 |
| 5 | 死亡 & 非 promote | `recoverLost`(crash)— teardown + 列回収 | :3977-3980 |
| 6 | **作業上限**: 生死問わず `(now - startedAt) - 控除 >= MAX_EXEC_MS`(:364 既定 90 分・env 可)。控除 = rate-limit hold + 統合待ち(`executionCredit` :2163 — 02 章 §5.5)。**wall-clock ではない** | 全 bookkeeping 掃除 → `pendingFatal` enqueue → `recoverLost`。理由は `readyAt` で二分(:5460): 未 ready は `'runaway'`(→blocked)、ready 済み(=差し戻し後の再作業)は `'integration-wait'`(→review・02 章 §5.6)。**`commitsAhead>0` を witness に足してはいけない** — worker は ready 前にコミットするよう規律で指示されているので commit は常態であり、足すと防御が実質消える(02 章 §5.6 の囲み) | :5431-5595 |
| 7 | stall 判定を先に計算(:4042-4056)。**silentMs >= STALL_SILENCE_MS(10 分 :292)の worker だけ**画面を読む(:4064-4067)— 出力が流れている worker は画面に何が書いてあっても絶対に触らない(false-kill guard :3984-3991) | | |
| 7a | 画面 = rate-limited(`classifyOutput` :1256 → `RATE_LIMIT_PATTERNS` :1123) | **hold**(nudge しない・reclaim しない)。初回 sighting で quota 層へ `markRateLimited`(:4093-4103 — worker の起動 tier に帰属)。`RATE_LIMIT_GRACE_MS`(:409 既定 20 分、`MAX_EXEC_MS-60s` 未満に clamp)を超えて**まだ**限定中なら `recoverLost`('rate-limit') → **'todo' 再 queue**(コミット済み作業は branch に残る) | :4080-4116 |
| 7b | 画面 = permission-wait(:1165)∧ commitsAhead===0 | 初回に Enter で auto-accept(:4130-4141)。`PERMISSION_WAIT_GRACE_MS`(2 分 :463)超で `recoverLost`('permission') → **'blocked'**(bypass が壊れている = 人が要る) | :4118-4149 |
| 7c | 画面 = question(自由文質問) | escalations inbox へ 1 回 raise(:4180-4211、overseer 有効時は S4 に委譲 :4179)。`QUESTION_GRACE_MS`(:472 既定 30 分)超で `recoverLost`('question') → **'blocked'** | :4151-4228 |
| 8 | 通常 stall 経路(silent かつ画面 normal) | `classifyStall`(:1047)の action に従う: `nudge`(Enter、`STALL_MAX_NUDGES`=2 :281)→ `escalate`(ESC + continue 指示を 1 回だけ :4249-4269)→ `reclaim` = `recoverLost`('stall')。nudge 後 `STALL_ECHO_GUARD_MS`(30s :291)内の出力は **Enter エコーとして無視**(:1065-1071)。実回復(新しい心拍 or guard 越えの持続出力)で予算リセット(:4286-4292) | :4237-4293 |

**`recoverLost` の回収先**(:4972 + `recoveryColumn` :1097-1119)。**この表は実装の評価順どおりに並べてある** — 上から順に最初に当たった行で決まる。順序自体が仕様なので、並べ替えて読まないこと:

| # | 条件(この順で評価) | 回収先 | 根拠行 |
|---|---|---|---|
| 1 | rate-limit | **todo**(一時的な待ちであって失敗ではない。retry 予算も消費しない) | :1103 |
| 2 | runaway / permission / question | **blocked**(再走しても同じ壁) | :1104 |
| 3 | **心拍 `blocked:true`(worker 自身の「人手が要る」申告)** | **blocked** | :1113 |
| 4 | **integration-wait**(ready 到達済みで作業上限) | **review**(成果は branch 済み。オーナー判断事項ではない — 02 章 §5.6) | :1116 |
| 5 | 心拍 `ready:true`(done 宣言なのに統合物なし) | blocked | :1117 |
| 6 | 再 queue 予算(`RECOVER_MAX_REQUEUE`=1 :227)超過 | blocked | :1118 |
| 7 | それ以外の素の crash/stall | todo(1 回だけ自動再挑戦) | :1119 |

> **3 が 4 より上にあることが要点**(2026-07-19 に射程を絞った)。`integration-wait` の免除が飛び越すのは **5 の「心拍 ready」だけ**であって、**3 の「心拍 blocked」は飛び越さない**。`ready` は差し戻し前の状態の遺物だが、`blocked` は worker が今まさに上げている「人手が要る」という申告なので、これを review に流すと申告が黙って捨てられる。02 章 §5.4 の同じ注と揃っていること。

回収の move が kept のときは dead worker を **roster に残して**次 pass で move を再試行(:3833-3844 — スロットは食わない)。move が `MOVE_STUCK_MAX_RETRIES`(5 :226)回 kept され続けたら 'blocked' へエスカレート(:3822-3831)。

pass 末尾で: review/done/消滅カードの `recoveries` を忘れ(:4303-4307)、**live roster にいない terminalId の bookkeeping を全 Map から一括 prune**(:4318-4337 — Map は live worker 数で有界)。

deps の実体(defaultDeps :4411): `countCommitsAhead` は project ごとに解決した trunk(origin/HEAD 対応 :2189-2192)への `rev-list --count`(:2201-2211)、`readHeartbeat` は `~/.openground/swarm/<repoキー>/<branch名変換>.json` を読む(:2243-2280 — repo キー導出 :2220-2238)、`recoverCard` は **loopback HTTP で自プロジェクトの Board API を叩く**(:2335-2347)、`recoverWorker` = killTerminal + `removeSwarmWorktree(force)`(:2354-2370)、`readConsumption`(型 :2090 / 実体 `defaultReadConsumption` :4398-4409 / 配線 :4426)は terminal pool の `agentSessionId`(worker PTY が `--session-id` で起動した uuid)→ `sessionJsonlPath(worktree, sid)` → `swarmTokenAudit.readWorkerConsumptionLine`(全 miss で null — read-only・JSONL は書き換えない。**本体セッション + その `<session-id>/subagents/agent-*.jsonl` の両方**を読む → §9 末尾)。

---

## 6. integrate pass の骨格と「monitor 飢餓」の機構(**`0d1f7f0` で飢餓は解消 — 本節は歴史**)

> **注記(2026-07-10)**: 本節が説明する「integrate が pass を握り monitor が飢餓する」機構は
> `0d1f7f0` で根治された — integrate は `kickIntegratePass` により tick の脇で fire-and-forget に走り
> (`integrateInFlight` で 1 本制限)、monitor は verify/panel 中も回る。
> **再注記(2026-07-15/16)**: その後のマネージャ専任化で B 相の land 機構(verify → panel →
> lock → land)は**撤去**され、現 B 相は「司令官を起こす」だけ(autoMerge トグルも 2026-07-16 廃止 —
> エンジン ON で常時)。現行の正典は 03 章 §2.1/§2.3、根治の全容は TARGET-STATE §1。
> 以下は当時の機構の記録(実測の照合点)。

詳細な統合セマンティクス(FF/rebase/conflict 委譲・敵対レビュー)は 03 章。ここでは**エンジンの時間軸**に効く形だけ:

- throttle: `INTEGRATE_TICK_MS`=15s(:197、:4637-4639)。tick は 3 秒でも統合は 15 秒に 1 回。
- A 半(常時): review 列 swarm カードの readiness を read-only 分類して `engine.reviews` に公開(:4672-4681)。
- B 半(`autoMerge` armed のみ :5000): カードごとに **verify → 敵対レビュー → lock → integrate** を直列 await:
  - `verify`(:5297-5317)= `makeVerify`(:2835-2923): 使い捨て worktree を作り trunk に rebase(:2891-2900)、**`tsc --noEmit`(timeout 180s :2530-2535)→ lint → swarm-safety(diff 該当時)→ `vitest run`(timeout 600s :2790-2795)を順にインライン await**(:2914-2917)。RED は同 tip memo(`verifyFailed`)で次 pass 以降スキップ(:5297, :5047)。
  - 敵対レビュー(:5071-5209)= lens レビュアー 4 体(`DEFAULT_REVIEW_LENSES` :3021-3042、配線 :3687。`REVIEW_PANEL_SIZE`=3 :3015 は lenses 無しの homogeneous パネル用で現行配線では未使用)の claude PTY、**timeout 5 分**(REVIEW_TIMEOUT_MS :3240)。同 tip must-fix memo(`reviewFailed`)/ defer 連敗 memo(`reviewDeferred`)でパネル再燃を抑止。
  - cross-process lock は **card ごと・`deps.integrate()` 直前だけ**確保(:5187-5209 — pass 全体で持つと verify/panel の数分 hold で lock が stale 視され盗まれる、0706 の轍)。

**飢餓の機構**: これら全部が `runEnginePass` の 1 pass の中で直列 await される(:5682)。この間 `passInFlight` は立ったまま(:5672)なので、**3 秒チェーンが次に発火しても bail するだけ**(:5671)で、monitor(= dispatch pass 内 :4410)は走れない。つまり verify が数分回っている間:

- rate-limit 検知(§5 7a)が遅れる → quota 冷却の `markRateLimited` も遅れる → **dispatch が枯れた tier に打ち続ける時間が延びる**
- stall / runaway / crash の検知・promote も同じだけ遅れる

コード自身がこれを認めていた:「verify above can run for minutes」「the pass also runs verify/tsc and a multi-minute adversarial-review panel per card」、self-supply が同じ理由で fire-and-forget 化された前科。verify/レビュー後の再チェックは「owner stop が await 中に着地した」ケースの**カード変異だけ**を守り、monitor の遅延自体は救わなかった。

> **この段落の行アンカーは意図的に外してある**(2026-07-19)。§6 は `0d1f7f0` で**機構ごと消えた歴史**であり、引用した 1 つ目のコメントは現物にもう存在しない(2 つ目は `IntegrationDeps` の docstring :2430 に残骸が残るだけ)。当時の行番号は `0d1f7f0` 以前のツリーを指すので、現在の行に振り直すと**存在しない対応を捏造する**ことになる。現行構造の正典は 03 章 §2.1/§2.4。

---

## 7. 落とし穴(司令塔が実際に踏んだ事象を含む)

### 7.1 quota 検知の遅延 — verify/レビューの monitor 飢餓(実測 2026-07-09・**`0d1f7f0` で根治済み — 歴史**)

2026-07-09、worker の画面には rate-limit 文言が **15:24 には出ていた**(= monitor が走れば 7a で検知可能)のに、実際に検知・冷却が発火したのは **15:29** — 統合パスの verify(tsc/vitest インライン await)が pass を握っていた約 5 分、monitor が一度も回らなかった。Board カード **`4d1550d7`**(「[保留] [swarm] quota 検知が21分遅れる — 沈黙10分ゲート/装飾再描画/統合パスの飢餓」、blocked 列)に全体像がある: 遅延は 3 要因の合成で、(a) **沈黙 10 分ゲート**(§5 7a は `silentMs >= STALL_SILENCE_MS` :4064 を通らないと画面を読まない — rate-limit 表示直後の 10 分間は構造的に見えない)、(b) TUI の装飾再描画が lastOutputAt を更新して沈黙時計を巻き戻す、(c) 本節の統合パス飢餓。司令塔への含意: **「エンジンが rate-limit を検知した時刻」は「worker が limit に当たった時刻」より最大で 10 分 + verify/レビュー数分ぶん遅い**。worker の実際の状態は PTY 画面と心拍ファイルの `updatedAt` が一次情報。

### 7.2 per-model limit 文言はパターン追加済み(同日の別事故)

同じ 2026-07-09、CLI の per-model 枯渇文言 "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model." は当時の `RATE_LIMIT_PATTERNS` のどれにも一致せず、**検知ゼロ → fable が冷却されず dispatch が枯れ tier に再突入し続けた**(stall + 空レビューパネル)。現 tip では文言 3 フラグメントぶんのパターンが追加済み(:1132-1154 — TUI の折り返しで 1 フラグメントしか画面に残らないケースも拾う)。regression fixture がテストに固定されている。詳細は 04 章。

### 7.3 再起動 = エンジンの認知は消えるが、明示的な意図は resume する(2026-07-22 改訂・card 2)

**旧見出しは「再起動 = エンジン全消え、だが worker は生きている」だった。前半は撤回。**
§0.1 / §2 の `ProjectEngine` の中身(worker roster / reviews / journal / KPI 等)は今も再起動で**全消え**(card 3 = roster の write-through が未着手のため)。だが `running`(drain の ON/OFF そのもの)は**もう「必ず false」ではない** —
`desiredRunning:true` だったプロジェクトは、boot の `resumeEngines()`(`swarmOrchestrator.ts`)が
`~/.openground/projects/<uuid>/engine.json` を根拠に人手ゼロで `running:true` へ戻す。優先順位:
①owner の `manualStop` 永続記録が最優先(常に勝つ)②同一バージョンで短時間に再起動が繰り返されたら
crash-loop breaker(`swarmEnginePersistence.ts`)が抑止して代わりに fatal 通知 ③`claudeRunPreflight`
に落ちたプロジェクトだけその boot は resume しない(fail-quiet — fatal ではない)。resume した/しな
かった事実はベル通知(`engine-resumed`)で必ず視認できる。**「orchestrator が空(running:false) =
今回誰も ON にしていない」という誤読は今後も成り立つが、「running:true = 誰かが今この session で
ON にした」という誤読は成り立たなくなった** — 前回セッションの意図が resume で戻っただけかもしれない。
まず「状況」で GET /api/swarm/orchestrator と engine.json どちらを見ても、resume 由来か手動操作かは
journal の `engine resumed at boot (v…)` 行で見分けられる。

⚠ **この自動再開が実際に走るのは、Electron がフォークした本番サーバだけ**(`process.send` の
IPC 有無で判定 — `server/index.ts`)。`npm run dev` / `dev:server` / `electron:dev`(`tsx watch`)では
**わざと走らない**(保存のたびに実 worker を dispatch させないための意図的なゲート)。**dev で検証中の
司令官が running:false を見ても「壊れている」ではない** — dev はそもそも resume の対象外。実機での
自動再開を確認したいときは `npm run electron:prod` かパッケージ済み `.app` で見ること。

`GET /api/swarm/orchestrator` が空(running:false, workers:[])のときは従来どおり、**前セッションの
worker PTY・worktree・branch・心拍は生きている**。それらは `GET /api/swarm/workers`(server-truth:
PTY ∪ roster ∪ 心拍ファイルの統合 :501)には出る。「orchestrator が空 = worker がいない」と誤読して
worktree を掃除すると生きた作業を殺す(02 章 §6 の削除経路表を先に読むこと)。

### 7.4 「手で止めた」は永続、selfSupply は resume で戻る、overseer だけ値を覚えて起こさない(2026-07-22 改訂・確定版)

`stopOrchestrator` は `Settings.swarmManualStop` を**engine 不在でも**書く(:5843-5848)ので、再起動後も `manualStop:true / manualStopPersisted:true` が GET に出る(:1858, :6185-6188)。

**`selfSupply`(card 2, 2026-07-22 以降)**: ~~揮発で再起動後 OFF~~ は旧知識。`engine.json` 経由で `running` と一緒に resume する(§2 :85 参照)。「前回 selfSupply が ON だったから今も ON のはず」は resume 後は**成立する**。

**`overseer`(2026-07-22, 設計レビューで [hold] 論点が確定)**: 今も再起動で必ず OFF に戻る。ただし**揮発ではなくなった** — `enabled` の値は `engine.json` に書かれて記憶されるが、boot 時にそれを読み戻して arm することは**しない**(意図的)。「前回 overseer が ON だったから今も ON のはず」は今も**成立しない**——毎セッション明示的な再武装が必要。

**その非対称は画面に出る(card 2b, 2026-07-24 実装済み)**: 黙って落とすのではなく、Swarm 画面の上部に「前回は監督もオンでした → [戻す] [監督のお知らせを閉じる]」のバナーが出る。司令官が見るべき点は 3 つ:

- **`GET /api/swarm/orchestrator` に `overseerRemembered` が増えた** — `engine.json` の `overseer` の**生値**。engine が in-memory に無くても(再起動直後がまさにそれ)ディスクから読んで返す。`overseer`(今 arm されているか)とは**別物** — バナー条件は `overseerRemembered && !overseer`。この値は**表示専用で、arm の入力には決してならない**(`resumeEngines()` は相変わらず読まない)。
- **[戻す] は `POST …/overseer {enabled:true}`** — 実際に arm する。D1 ゲート(engine が running でなければ arm 拒否)は**据え置き**なので、自動運転 OFF のときボタンは disabled になり「先に自動運転をオンにすると、監督を戻せます」と出る。
- **[×] は専用の `POST /api/swarm/orchestrator/overseer/dismiss`**(`dismissOverseerReminder` — `engine.json` の `overseer` だけを false に patch。arm 状態にも `desiredRunning`/`selfSupply` にも触らない)。⚠ `…/overseer {enabled:false}` で代用してはいけない — バナーが出ている時点で overseer は既に disarm 済みなので `setOverseer` の変更ガードに弾かれて**何も書かれず**、次の poll でバナーが戻る(autonomy バナーで実際に起きた `d1d6d704` の no-op 罠と同型)。

**もう一つの副作用も塞いだ(card 2b)**: `startOrchestrator` は今も全書き(`writeEngineIntent` — 3フィールド)だが、書き込む `overseer` を「その時点の in-memory `.enabled`」だけから導出するのをやめ、**先にディスクの現値を読んで OR を取る**ようになった(`engine.overseer.enabled || priorIntent.overseer`)。以前は in-memory 由来の false で上書きしていたため、resume が抑止された boot(crash-loop breaker / preflight 失敗)で owner が先に「再開」を押すと、押した瞬間に復帰バナーの根拠が消えていた。resume は元々このフィールドを読まないので、値を残しても**再開挙動は一切変わらない**。

> ⚠️ **この `readEngineIntent` は `runEnginePass` の kick より前でなければならない**(`swarmOrchestrator.ts` の clear → kick の順序)。kick の後ろに置くと `await` が1つ増え、**engine ON で滞留時計(`reviewSeenAt`)をクリアする契約**(§7.4 / 7517e4b1)が壊れて、ON 直後に生きた司令官卓へ声かけ(ESC 付き)が飛ぶ。`patchEngineIntent` に「戻す」と内部で read が1回増えて同じ回帰を踏むので、**全書き+事前 read というこの形を崩さないこと**(2026-07-24 `4e218a46` で実際に踏んで直した回帰)。歯は `swarmOrchestrator.test.ts` の「startOrchestrator DROPS the review dwell clock」。

**なぜ非対称か**: selfSupply の出力は per-card 承認ゲート(`selfSupplyApproved`)で不活性 — 提案カードが積まれるだけで dispatch はされない。overseer は大脳(claude PTY)の起動・稼働中 worker への文字列注入・janitor の破壊的操作(`git branch -d` / 心拍 unlink)を**直接駆動**し、かつ再起動は OVERSEER_DESIGN.md K2/L9-③ が定める「代替の無い kill switch 層」— overseer の自動再開だけがこの層を無効化してしまう。設計の経緯は docs/ENGINE_PERSISTENCE_PLAN.md §2、正典は OVERSEER_DESIGN.md K2(2026-07-22 追記あり)。

(旧 `autoMerge` フィールドも overseer と同じ揮発モデルだったが 2026-07-16 にフィールドごと撤去 — 司令官起こしは `running` に常時同乗。overseer はさらに、明示 stop が disarm し(:5863-5866)、running 中しか arm できない(:6393-6396)。)

### 7.5 passInFlight / pendingDispatch は外から見えない

`stateOf`(:1836-1873)は `passInFlight` / `pendingDispatch` / `lock` / `generation` / rework 予算 Map を**返さない**。「dispatch が二重に走っていないか」を API で確認する手段はなく、機械封鎖(§4.4 + `isCardDispatchInFlight`)を信頼するのが正。手動 dispatch(POST `/api/swarm/worker`)がエンジン予約と衝突すると 409 が返る(02 章 §2.1 の twin-dispatch ガード)。

### 7.6 log は 200 行 ring buffer

`MAX_LOG_LINES`=200(:201, :1772-1774)。長い統合連鎖や 3 秒 tick のルーチン行で過去の dispatch 履歴はすぐ押し出される。**「journal に無い = 起きていない」ではない**。KPI カウンタ(:1487)は ring より長生きだが、それも再起動でゼロ。

---

## 8. 既知の穴(読んで見つけた点 — 修正はしない・列挙のみ)

1. **(消滅 — 2026-07-15/16)** ~~`reworkOrPark` は `autoMerge` disarm を見ない非対称~~。マネージャ専任化で reworkOrPark/delegateConflict を含む B 相 land 機構が撤去され、autoMerge トグル自体も廃止されたため、この穴は機構ごと存在しない(歴史として保持 — 03 章 §2.3.1)。
2. **question hold 中の worker が `worker-stale` anomaly に併発し得る**。`detectAnomalies` は `rateLimited` / `permissionWaits` に載っている worker を stale 判定から除外する(:5400)が、**`questionWaits` は除外していない**。質問 hold(`QUESTION_GRACE_MS` 既定 30 分 :372)と `STALE_HEARTBEAT_MS`(30 分 :5336)がほぼ同尺なので、境界で「管理下の WAIT」が「hung かも」として anomaly に出る — card 4880e9c6 の「WAIT vs HANG を正直に」の意図からの漏れ(表示ノイズのみ・動作影響なし)。
3. **`fireFatalNotifications` の `_now` 引数は未使用**(:5592)。シグネチャだけの残骸で実害なし。
4. **monitor 飢餓は構造的・未解決**(§7.1)。カード `4d1550d7` が blocked 列に保留中で、cc7c60e 時点のコードでは verify/レビューは依然 pass 内直列 await。司令塔は修正済みと思い込まないこと。

---

## 9. 検証コマンド集(司令塔が自分で裏取りするためのワンライナー)

対象コミットの確認(この文書の行番号が有効か):

```bash
git -C ~/projects/OPEN\ GROUND log --oneline -1 cc7c60e
git -C ~/projects/OPEN\ GROUND diff --stat cc7c60e..origin/main -- src/lib/server/swarmOrchestrator.ts src/lib/server/swarmLaunch.ts
# ↑ 空なら本書の行番号は origin/main tip でもそのまま有効
```

エンジン状態(swarm ゲートを通過できるアプリが :47776 で稼働中の前提 — owner ログイン済み、**または**ログイン無効運用のサーバローカル解錠(env `OPENGROUND_LOCAL_OWNER=1` / settings.json 手編集 `swarmLocalOwner:true` — swarmGate.ts、docs/SECURITY.md)。path は登録済み project の実パス):

```bash
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$HOME/projects/OPEN%20GROUND" | jq '{running, manualStop, manualStopPersisted, selfSupply, overseer, parkUntil, workers: (.workers|length), anomalies}'
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$HOME/projects/OPEN%20GROUND" | jq -r '.log[] | "\(.at) [\(.level)] \(.message)"' | tail -30
# scale 決定・park の enter/lift・dispatch 行だけ拾う:
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$HOME/projects/OPEN%20GROUND" | jq -r '.log[] | select(.message | test("^(scale:|dispatch:|quota park|holding new dispatch)")) | "\(.at) \(.message)"'
```

server-truth の worker 一覧(エンジン roster と独立 — 再起動後の「エンジン外 worker」もここに出る):

```bash
curl -s "http://127.0.0.1:47776/api/swarm/workers?path=$HOME/projects/OPEN%20GROUND" | jq -r '.workers[] | "\(.branch) phase=\(.phase//"-") ready=\(.readyToMerge//false) beat=\(.heartbeatAt//"-")"'
```

心拍の一次情報(エンジンの写しではなくディスクの真実。02 章 §3 参照):

```bash
ls -lt ~/.openground/swarm/*/ | head -15
cat ~/.openground/swarm/<repoキー>/<branch名の'/'を'-'に>.json | jq '{phase, readyToMerge, task, blockers, updatedAt}'
```

定数の実値(env 上書き込みの実効値は起動時解決 :305-320 — プロセス env を確認):

```bash
grep -n "export const TICK_MS\|export const INTEGRATE_TICK_MS\|export const ORCHESTRATOR_MAX_WORKERS\|export const STALL_SILENCE_MS\|export const STALE_HEARTBEAT_MS" src/lib/server/swarmOrchestrator.ts
grep -n "OPENGROUND_SWARM_MAX_EXEC_MIN\|OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN\|OPENGROUND_SWARM_QUESTION_GRACE_MIN\|OPENGROUND_SWARM_AUTODRAIN\b" src/lib/server/swarmOrchestrator.ts | head
```

二重 dispatch 封鎖(cc7c60e)の現物確認:

```bash
git -C ~/projects/OPEN\ GROUND show cc7c60e --stat
grep -n "pendingDispatch" src/lib/server/swarmOrchestrator.ts | head
grep -n "isCardDispatchInFlight" server/routes/swarm.ts
```

selectDispatch の dependsOn ゲート・学習ループの現物:

```bash
sed -n '509,572p' src/lib/server/swarmOrchestrator.ts        # 6ゲート本体
sed -n '4529,4567p' src/lib/server/swarmOrchestrator.ts      # priorFailure 読み→spawn→消費
```

実測事象カード(§7.1)の現物:

```bash
jq -r '.tasks[] | select(.id | startswith("4d1550d7")) | {id, title, boardColumn}' ~/.openground/projects/3de870a679fa/tasks.json
```

エンジン log で monitor 飢餓を観測する(統合 pass 前後の journal 時刻の空白を見る):

```bash
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<path>" | jq -r '.log[] | .at' | awk 'NR>1 { if ((prev != "") && (substr($0,15,2) - substr(prev,15,2)) >= 2) print prev " → " $0 " (gap)"; } { prev=$0 }'
# ↑ 分単位の粗い検出。verify/レビュー中は log 自体が止まるので、隣接行の時刻差が数分空いていれば pass が握られていた証拠
```

カード単位のトークン消費(常設計測器・2026-07-18 card swarm-token — アプリ稼働不要・完全 read-only):

```bash
npm run swarm:audit                                          # 直近7日: 全projectのworker worktree + 実行元repoの司令卓
npm run swarm:audit -- --since 3d --project ~/projects/OPEN\ GROUND   # 期間+プロジェクト絞り(worker + 本体repoの司令卓)
npm run swarm:audit -- --since 2026-07-18 --until 2026-07-18 # 「今日1日」= ローカル日の 00:00〜23:59
npm run swarm:audit -- --json                                # 機械可読 {scope, sessions}(ここだけ生ISO)
# 列: 手数(main-loop のユニーク usage 応答数=message.id dedupe後)/束ね率(tool_use数÷tool_use含む応答数)/
#     文脈max(input+cache_creation+cache_read の最大)/出力token/sub出力(手数)/Read(再読)/bash内訳 tsc/test/lint/git/other
# done 時に journal へ載る `consumption:` 行(§5 表 4b)と同じ計量器(src/lib/server/swarmTokenAudit.ts)。
# ⚠ 走査範囲(既定) — worker worktree は常に対象、**司令卓(commander/supply)のセッションは repo 直下で走る**
#   ので worktree 走査には現れない。既定では `--project` 無しでも**本体 repo の司令卓**を読む
#   (2026-07-18 後追いカードで追加。それ以前は worktree のみ = カードのゴール「本体repo+worktree」が既定で
#   片肺だった。実測: 本体repoで --since 2d が 42→65セッション、増分23本が全て `(repo)` 行)。
#   ★cwd が worktree のときは、その worktree の**登録元 repo**(settings.json の uuid→path)を読む。
#     素直に「cwd の司令卓」を読む実装は**無意味**だった — cwd 自身の dir は worker walk が既に持っており
#     Set で dedupe されて0本しか増えないのに、ヘッダは desk を含むと表示していた。司令官・worker・
#     レビュアーは通常 worktree 内で走るので、最も踏まれる経路でだけ最重量の司令卓群が黙って欠落する
#     (実測 2026-07-19: worktree から 37件 / 本体repo から 60件・差23本が司令卓。修正後は worktree から
#     58件で desk 23本、`(repo)` 行の実数と scope 行の表示が一致)。
#   ヘッダ2行目の `scope:` は**実際に届いた desk 行数を数えて**出す(意図ではなく実績)。desk が0本なら
#   `none in this period`、そもそも走査していないなら `NOT scanned` と**別の文言**になるので、空欄と
#   未走査は出力から区別できる。登録元が引けない worktree では後者になり `--project <repo>` を促す。
#   `--project <path>` を渡すと司令卓の読み先はそちらへ切り替わる(cwd は読まない)+ worker を uuid で絞る。
#   registry 未登録の path を渡すと worker は**絞られない**ので、その旨も scope 行に出る(stderr の note
#   だけだと `--json |` やパイプで消えるため)。`--json` は素の配列ではなく `{scope, sessions}` を返し、
#   scope に origin/deskRepo/deskSessions/workersNarrowedToUuid/warning を載せる — 後続分析が
#   「部分走査の数字を全体と誤読する」のを防ぐ(このカードが消したい失敗と同じものが1段下流で起きる)。
# ⚠ median は **card 行のみ**(worktree セッション)を母集団にする — 司令卓は対話ドライバでカード attempt
#   ではないため、混ぜると「1カードの費用」を表すはずの数値がずれる。除外した desk 本数は表の下に出る。
# ⚠ 期間指定は**ローカル日**基準 — 素の `YYYY-MM-DD` は「その日まるごと」(--since は 00:00、--until は
#   23:59:59.999)。旧実装は Date.parse = UTC 深夜0時だったため `--since D --until D`(その日だけ)が
#   幅ゼロ窓になり **0件**を返していた(実測 2026-07-18: 旧0件 / 新40件)。表示も表・ヘッダ共にローカル時刻
#   (ヘッダに `(local)` 表記)。フルISOタイムスタンプを渡した場合はその瞬間がそのまま使われる。
# ⚠ サブエージェント費用の在処 — `sub出力(手数)` 列は**セッションファイルの中ではなく別ディレクトリ**から来る:
#     ~/.claude/projects/<dir>/<session-id>.jsonl                        ← main loop(手数/束ね/文脈max/出力)
#     ~/.claude/projects/<dir>/<session-id>/subagents/agent-*.jsonl      ← Task/Explore(実測882本)
#     …/subagents/workflows/wf_<id>/agent-*.jsonl                        ← Workflow ツールの艦隊(実測425本)
#   これらの行は親の sessionId を持つので同じカードに帰属する。集計は行内フラグではなく**出所**で決まる:
#   `isSidechain:true` は**本体セッションには一切書かれない**(実測 2026-07-18: 直近127ファイルで0件)ので、
#   フラグだけ見る実装はサブエージェント費用を丸ごと落とす(初版がこれで `sub出力` が常に `-` だった)。
#   **walk は再帰必須** — workflows/ 配下が全記録の 1/3(425/1307)を占め、フラット readdir では読めない。
#   実例: カード swarm-swarm-read-only-0714 は flat 0本 / nested 29本 = main手数25 に対し sub手数214・
#   sub出力382k(費用の大半がサブエージェント側)。再帰しないとこのカードは費用ゼロに見える。
#   読むのは `agent-*.jsonl` のみ(meta.json sidecar と workflow の journal.jsonl を名前で除外)。
#   ディスク上 subagents/ を持つセッションは必ず兄弟の .jsonl を持つ(実測226dir中orphan 0)ので取りこぼしは無い。
# ⚠ 手数は message.id dedupe 後の応答数 — CLI は 1 応答を content block ごとに複数行へ分割して書く
#   (実測 910 行 = 461 応答)ので、行数を数える手作業集計より小さく出る。こちらが正確な定義。
#   分割行の usage は**最後のスナップショットが正**(合算でも先頭固定でもない)。通常は全行同値だが
#   output_tokens はストリーム中にランプしうる(実測3292応答中1件が 3→3→2660→2660)。全ランプが単調増加で
#   最終行が必ず最大(3292/3292)・input/cache_* は変動0件。先頭固定にすると 2660 の応答を 3 と数える。
#   ※この「同値でない fixture」が回帰テストの要 — 3行とも同値の fixture では first/latest/max のどれに
#     変えても緑になり、集計規則が全く固定されない(2026-07-18 実測 29/29 素通り)。
#     現 fixture が実際に噛むことはミューテーションで実測済(2026-07-19)— 先頭固定 / 合算 / spread 復帰
#     (ファイル側・ディレクトリ側の各単独)の4通りとも 36 中ちょうど1本、狙った当のテストだけを落とす。
#     壊し方を変えても緑のままなら、それは fixture が実形状を失った合図。
# ⚠ Read(再読) は **file_path が読めた Read だけ**で算出する — CLI は tool input を parse できないと
#   `{__unparsedToolInput:{raw}}` を書き(実測 629 Read 中 3件)、これを総数側だけに数えると再読が水増しされる。
```

日次燃費日報(常設自己分析ループ・2026-07-18 card swarm-token-blocked — `src/lib/server/dailyFuelReport.ts`):

- **何者か**: アプリ(Hono server)稼働中、毎日 **09:00 ローカル**(定数 `REPORT_HOUR_LOCAL` — 設定 UI なし)に
  直前の報告窓の swarm **worker** セッション JSONL を上と同じ計量器で集計し、ベル(swarm-info
  `daily-fuel-report`)へ平易文の日報を永続通知する。**決定論・LLM 呼び出しゼロ・read-only**
  (書くのは通知・sentinel・劣化日の提案カードだけ)。retention と同じ **real-server entry 配線**
  (`server/index.ts` — kill-switch `OPENGROUND_FUEL_REPORT=0`)なので **swarm エンジンの ON/OFF に依存しない**。
- **窓と「完了カード」の定義**: 窓は `[前回 sentinel の lastCutoffMs, now − 30min)`。右端を 30 分
  (QUIET_MS)手前に置くことで「まだ書き込み中のセッション」を翌日へ回し、**1 セッション=ちょうど 1 回**
  だけ日報に載る(半端な数字で数えない)。「完了カード」= この窓内に最終行(lastAt)が入った worker
  セッション — 厳密な done 判定ではなく「活動を終えた」の意(crash/park の消費も燃費として数える)。
  司令卓(manager/supply)のセッションは単位がカードでないため対象外。窓の長さは **26h で上限
  クランプ**(`MAX_WINDOW_MS`)— 数日アプリを止めた後の初回が「きのうの」と称して数日分を報告する
  嘘を防ぎ、同時に**誤検知バイアスを断つ**(文脈max は窓内の MAX なので、窓が長いほど 300k を
  踏みやすく、1 日分なら成立しない劣化判定で起票してしまう)。クランプで外れた古いセッションは
  報告されない — アプリが動いていなかった日の分であり、日報は日報のまま保つという判断。
- **劣化検知と承認境界**: 窓内 2 枚以上の日に限り、束ね率<1.3 / 手数中央値>150 / 文脈max>300k の
  いずれか超過で、分析サマリを notes に焼き込んだ改善提案カードを **blocked 列**に自動起票+通知する。
  blocked はエンジンが dispatch しない人間判断レーン(§7 の isTodo)なので、**オーナーが todo へ動かす
  操作そのものが承認**。カードに selfSupplyKey は**わざと付けない**(付けると todo 移動後も
  selfSupplyApproved ゲートで止まり「todo へ復活=承認」の契約が壊れる)。未解決の提案カードが
  残っている間は同種の新規起票をしない(重複防止)。
- **重複防止は Board が正典**(2026-07-19 差し戻し2で是正): 提案カードは `fuelProposalKey`
  (3点セット: `types.ts` / `schemas.ts` ProjectTaskSchema / 走査側)を持ち、起票の直前に
  **対象 Board を走査して未 done の同種カードが1枚でもあれば起票しない**
  (`openFuelProposals` — self-supply の `openSelfSupplyKeys` と同じ列規則)。判定は
  `mutateProjectData` の**ロック内**で行うので TOCTOU が無い(2 tick が同時に「空」を見て
  両方 push する事故が起きない)。
  ⚠ **以前は sentinel だけを見ていた**: sentinel は寛容(読めなければ null)で memo は
  プロセス寿命しか無いため、`daily-fuel-report.json` が**消えた**(home 移行/バックアップ復元)
  か**恒久的に書けない**場合、毎回の起動が「提案なし」に見えて **同じカードが blocked に
  日々積み増した**(26h クランプで同じセッション群を数え直すため内容まで同一)。Board は
  重複判定の対象そのものなので、この形にズレようがない。
  なお sentinel 側の参照も**併存**させている — 前回の提案が**今日とは別のプロジェクト**に
  起票されていた場合、Board 走査(対象プロジェクトのみ)では届かないため。
  ⚠ 残る制約: 走査は**その日の対象 Board 1 つだけ**。複数プロジェクトを跨いで劣化が続くと
  プロジェクトごとに 1 枚ずつは立ちうる(枚数はプロジェクト数で頭打ちで、日数では増えない)。
- **暴走しない作り**(2026-07-18 統合前レビューの差し戻しで追加): 「今日は報告済み」と「未解決の
  提案カード」のガードは sentinel ファイルだけでなく**プロセス内 memo**
  (`globalThis.__openground_fuel_memo`)にも同時に持ち、**副作用(カード起票→ベル→sentinel 書込み)
  より前に arm** する。理由は read と write の非対称: sentinel は read が壊れても次の write で
  自己修復するが、**write が恒久的に通らない**状態(EISDIR/権限/ENOSPC/immutable)は自己修復しない —
  ガードが disk 上にしか無いと、劣化が続く限り 60 秒 tick ごとに提案カードが増え続ける
  (レビュアーが隔離 HOME で実測: 1→2→3)。ベルと sentinel 書込みは best-effort(失敗はログのみ)で、
  失敗しても「今日は報告済み」は memo 側に残る=最悪でも**日報 1 通を落とすだけ**でカードは溢れない。
  tick の再入ガードも globalThis(`__openground_fuel_tick_inflight`)— `tsx watch` のリロードで
  新旧モジュールが別 boolean を見て二重 tick する穴を塞ぐ。
- **ゼロの日の方針**: 「終わったカードはありませんでした」の 1 行を**通知する**(スキップしない) —
  毎日必ず届くことで「完了ゼロ」と「ループが死んでいる」を見分けられるようにする設計判断。
  OS toast は劣化日のみ(平常日はベルだけの静かな定期便)。この「毎日必ず 1 件」が
  **ベルの cap を kind 別に分けた理由**でもある(06 章 §3.4)— 共有 cap のままだと、静かな日が
  続くだけで日報が `rework-exhausted` 等の fatal をベルから押し出して**安全弁が消えた**。
- **オーナー向け文面の約束**: 数字は万単位(`33.6万`・`120万`)で出す(`plainCount` — `1200k` は
  非プログラマに読めない)。窓は「きのう」と決め打ちせず**実期間**を書く(`直近26時間` — 追い付き
  実行や初回は実際に「きのう」ではない)。提案カードの notes は
  **オーナー節(判断のお願い)と作業者節(作業指示)を見出しで分離**する — todo 承認後、この
  notes がそのまま worker のプロンプト(`composeTaskPrompt`)になるため、混在していると作業役が
  「カードを todo へ動かせ」という自分には実行できない指示を読んで停滞する。

```bash
jq . ~/.openground/daily-fuel-report.json
# sentinel の読み方: lastReportDate(この日付の日はもう報告済み=同日二重なし・再起動を跨いで保持)/
#   lastCutoffMs(次回窓の左端)/ lastSummary(前回比の元ネタ)/ proposal(未解決の提案カード参照=重複起票ガード)
# 日報が来ない日の切り分け: ①アプリが落ちていないか ②lastReportDate が今日になっていないか
#   ③OPENGROUND_FUEL_REPORT=0 で殺していないか。
# ⚠ sentinel を消しても**その場では再送されない** — 「今日は報告済み」は同じ内容がプロセス内 memo
#   にも立っているため(それが write 恒久失敗時の暴走止め)。手で再送させたいなら sentinel を消した
#   うえで**アプリを再起動**する(memo はプロセスと運命を共にする)。
# ⚠ 逆に、sentinel が「書けない」場所になっている(ディレクトリ化/権限/ENOSPC)と、日報は出るのに
#   ファイルは空のまま = 再起動のたびに 1 通重複する。server ログの
#   `[openground:fuel-report] sentinel write failed` が出ていないか見る。
#   ただし**重複するのは日報(ベル)だけで、提案カードは増えない** — カードの重複防止は
#   sentinel ではなく Board 走査(fuelProposalKey)が持っているため(2026-07-19 以降)。
```
