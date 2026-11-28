# 01 — エンジン中枢(tick / pass / dispatch / monitor)

## Current Contract (2026-09-19)

The self-supply scan and its persisted enable/budget fields no longer exist. Dispatch, monitoring, stop, salvage, desk restoration and commander wakeups remain.
See [SIMPLIFICATION.md](SIMPLIFICATION.md) for the current entry points and verification.
Any descriptions of the retired paths below are historical, not operating instructions.

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
| 起動モデル/エフォート解決(実行モード × カードの難易度 tier(安全床込み — 判定は `src/lib/cardTier.ts`)× quota × mask) | `src/lib/server/swarmLaunch.ts` — `SWARM_LAUNCH_MODEL='fable'`(:52) / `resolveSwarmModelEffort`(:257) / `execModeMaxWorkers`(:272) |
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
| ~~`rateLimited`~~ / ~~`permissionWaits`~~ | **【0813 削除】** 20分 hold と permission 腕は PTY センサー層ごと削除(quota 停止は即 requeue — 02 章 §5.5(a)) | — |
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

### 4.3 selectDispatch — 8 ゲート

キュー順は `sortTodos`(:418 → `sortByPriority`: 実効優先度(静的 + aging)→ boardOrder → createdAt)。各候補に:

| # | ゲート | 行 | 中身 |
|---|---|---|---|
| ① | COLUMN | :553 | `todo` 列のみ候補(関数内で filter — 混合リストを渡されても守られる) |
| ② | ID | :555 | 既に counted worker がいる id はスキップ |
| ⑥ | SELF-SUPPLY | :561 | エンジン自案カード(`selfSupplyKey`)は owner 承認(`selfSupplyApproved`)まで不発 |
| ③ | CONTENT | :562-563 | title+notes の正規化キー(`contentKey` :433 — NUL 区切り :437-441)が active work / 先行 pick と重複したらスキップ |
| ④ | FILE | :564-565 | `files:` / `ファイル:` 指令行で**宣言された**ファイル(`declaredFiles` :457 — opt-in、散文中のパスは対象外)が claim 済みなら保留(同一ファイル作業の直列化) |
| ⑤ | DEPENDS | :566 | `dependsOn` の**実在する未 done** 前提がある間は保留(:526-529)。削除済み/typo の id は「満たされた」扱い — 永久 stuck にしない |
| ⑦ | CONTENT REQUIRED | `hasCompletionConditions` | **内容(notes)が空のカードは配らない**(2026-09-11 追加)。⚠ 実測の事故: 補給官が積んだ2枚を**8秒後**に司令官が worker へ配布し、**完了条件が書かれる前**に着手した。原因は書き手のミスではなく**同梱の補給官手順書自体**が「先に題名だけ `add` → 後で notes を PUT」と書いていたこと(skills/supply/SKILL.md step 4 — 同じ変更で一括書き込みに修正)。指示は安全装置ではないので、不変条件はここに置いた。**捨てずに保留** — 内容が入れば次の周回で拾う。**手動の「実行」は対象外**(押すこと自体が「今の内容で配れ」という表明)。保留中のカードはジャーナルに1行(held 集合の変化時のみ)+ カード詳細に理由が出る |
| ⑧ | DRAFT | `card.draft` | **下書き印(`draft: true`)のカードは配らない**(2026-09-26 追加)。Incident: in Echona the president queued two cards that touch the same screen, then added the order (`dependsOn`) afterwards; autopilot had already started both. A wait timer was rejected by the owner (every card would pay the delay). Instead the president writes multi-card / ordered requests as drafts, adds `dependsOn`, reads back, and clears every draft in ONE `PUT` (skills/supply/SKILL.md step 4). Held, not dropped: after the flag clears, ⑤ and the other gates apply as usual. Manual 実行 is exempt (same as ⑦). A draft is not counted in the ⑦ "empty body" journal line. The schema reads a junk `draft` value as `true` (fail-closed); `PUT /api/project` refuses non-boolean `draft` and non-array `dependsOn` with 400 (05 章 §2.1). The owner releases a draft from the Board card's hover button. A manual start (`POST /api/swarm/worker` claim) clears the flag; a duplicated draft stays a draft; the commander's manual pick (og-manage step 2) skips drafts |

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
| 4 | doing: probe(commitsAhead :3907 + heartbeat :3912 **+ 親が 0 のときだけ `countNestedCommits`(worktree 直下 1 階層の別リポ / linked worktree — 2026-09-13)**)→ `classifyWorker`(:3917) | promote 判定へ | :3904-3920 |
| 4a | **reworkAt 抑制**: 差し戻し直後は心拍ファイルが古い `readyToMerge:true` のままなので、差し戻しより**新しい**心拍が出るまで promote を落とす(re-promote race 対策)。落とした後も **fall through して stall/作業上限の監視は受ける**(ready 済みなので上限に当たっても暴走扱いにはならない — 02 章 §5.6) | | :5284-5292 |
| 4a' | **reenteredAt 抑制**(2026-10-02): 既存ブランチに戻った再配車(保留→「やり直す」/ quota 再投入)は、配車より**新しくない**心拍を無いものとして扱い、promote は本人の配車後 ready のときだけ(旧コミットだけの「死亡∧¬blocked」昇格も落とす)。in-memory worker に付け roster 経由で永続、boot の `--resume` で復元。さらに **`spawnSwarmWorker` が前任の心拍ファイルを消す**(`clearBranchHeartbeat` — 既存 worktree を渡された非 resume の spawn のみ、占有チェック(`WorktreeOccupiedError`)の後。engine の再配車と手動 `POST /api/swarm/worker` の両経路共通、占有時は消さない)— 誰にも数えられない worker(手動の「実行」・boot 再開の見送り・boot 再開なし)のカードが doing に残っても `promoteUnownedDelivered` が古い ready で昇格しない。カードは動かさず §7.4d の通常経路(孤児保留を含む)に任せる | 02 章 §5.3a | `reenteredAt` を grep |
| 4b | promote 成立(`probeHasWork ∧ (ready ∨ (dead ∧ ¬blocked))`、probeHasWork = 親 commitsAhead>0 ∨ 入れ子 nestedCommits>0 — 02 章 §5.2 改訂 2026-09-13) | doing→review move(:5297)。kept なら `recordKeptMove` + 次 pass 再試行(:5335。**kept でも「納品した」事実は `readyAt` に刻む** — 02 章 §5.5(b))。**move 成功直後 = done 検知点で、その worker のセッション JSONL を計量した `consumption: 手数… 束ね… 文脈max… 出力…`(サブエージェントを使ったカードだけ末尾に `sub出力…(手数…)`)info 行を journal に 1 行記録**(2026-07-18 card swarm-token — optional dep `deps.readConsumption` :5310-5317。JSONL 不在/読取失敗/例外は黙って skip = fail-safe で promote・監視を一切妨げない。kind 無しなので KPI カウンタも汚さない。計量器の定義は §9 末尾) | :5294-5356 |
| 5 | 死亡 & 非 promote | `recoverLost`(crash)— teardown + 列回収 | :3977-3980 |
| 4c | **ready-without-work**(2026-09-13): 生存 ∧ ready ∧ 親・入れ子とも 0 ∧ **Canvas 成果の証拠なし**(2026-10-01: カウントが読めて 0 ∧ カードに明暗 2 枚の写真 ∧ その画像が配車後に書かれた ∧ worktree が clean ⇒ `canvasDeliverable` で 4b の promote へ — 02 章 §5.2) | 初見で journal warn + info 通知 `ready-without-work`(1 回)。`READY_WITHOUT_WORK_GRACE_MS`(3 分)は **nudge せず保持**(stall 経路に落とさない)。超過で `recoverLost('ready-without-work')` → **blocked**。猶予中にコミットが見えれば 4b で promote | 02 章 §5.2 |
| 6 | **作業上限**: 生死問わず `(now - startedAt) - 控除 >= MAX_EXEC_MS`(:364 既定 90 分・env 可)。控除 = 統合待ちのみ(`executionCredit` — 02 章 §5.5。rate-limit hold 控除は 0813 に hold ごと削除)。**wall-clock ではない** | 全 bookkeeping 掃除 → `pendingFatal` enqueue → `recoverLost`。理由は `readyAt` で二分(:5460): 未 ready は `'runaway'`(→blocked)、ready 済み(=差し戻し後の再作業)は `'integration-wait'`(→review・02 章 §5.6)。**`commitsAhead>0` を witness に足してはいけない** — worker は ready 前にコミットするよう規律で指示されているので commit は常態であり、足すと防御が実質消える(02 章 §5.6 の囲み) | :5431-5595 |
| 7 | stall 判定を先に計算(:4042-4056)。**silentMs >= STALL_SILENCE_MS(10 分 :292)の worker だけ**画面を読む(:4064-4067)— 出力が流れている worker は画面に何が書いてあっても絶対に触らない(false-kill guard :3984-3991) | | |
| 7a | **【0813 改訂】** プールの `quotaBlocked` 判定 ∧ 沈黙 `QUOTA_STOP_DEBOUNCE_MS`(60秒) | 同一 pass で `markRateLimited`(起動 tier に帰属・model 不明なら mark しない)→ `recoverLost`('rate-limit') → **'todo' 即 requeue**(hold なし。コミット済み作業は branch・未コミットは WIP コミットで保全) | swarmQuotaStopFailFast.test.ts |
| ~~7b~~ | **【0813 削除】** permission-wait 腕(trust ダイアログは PTY の TUI フレーム — SDK セッションには存在しない) | — | — |
| 7c | 画面 = question(自由文質問) | escalations inbox へ 1 回 raise(:4180-4211、overseer 有効時は S4 に委譲 :4179)。`QUESTION_GRACE_MS`(:472 既定 30 分)超で `recoverLost`('question') → **'blocked'** | :4151-4228 |
| 8 | 通常 stall 経路(silent かつ output normal) | `classifyStall` の action に従う: `nudge`(SDK input で「Continue.」1ターン、`STALL_MAX_NUDGES`=2)→ `escalate`(`say` で continue 指示を 1 回だけ — ESC ダンスは 0813 に PTY ごと削除)→ `reclaim` = `recoverLost`('stall')。nudge 後 `STALL_ECHO_GUARD_MS`(30s)内の出力はエコーとして無視。実回復(新しい心拍 or guard 越えの持続出力)で予算リセット | — |

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

**その非対称の伝え方(card 2b 2026-07-24 → 2026-09-24 に画面から撤去)**: 黙って落とさないために、当初は Swarm 画面の上部に「前回は監督もオンでした → [戻す] [×]」のバナーを出していた。**2026-09-24、オーナー決定でこのバナーは状況の監視スイッチごと画面から撤去された。** 今の経路は次のとおり:

- **`GET /api/swarm/orchestrator` の `overseerRemembered`**(残置) — `engine.json` の `overseer` の**生値**。engine が in-memory に無くても(再起動直後がまさにそれ)ディスクから読んで返す。`overseer`(今 arm されているか)とは**別物**。この値は**表示専用で、arm の入力には決してならない**(`resumeEngines()` は相変わらず読まない)。
- **伝えるのは社長**: `overseerRemembered && !overseer` のとき、社長が状況報告で「再起動前は状況の監視がオンでしたが、今はオフです。戻しますか」と平易に一言伝える。**自分からは戻さない**(`skills/supply/SKILL.md`「Status」と「Owner-requested settings」)。
- **戻すのはオーナーが頼んだときだけ、社長が `POST …/overseer {enabled:true}`** — 実際に arm する。D1 ゲート(engine が running でなければ arm 拒否 — 200 を返しつつ `.overseer` は false のまま)は**据え置き**なので、社長は必ず `.overseer` を読み戻して結果を伝える。司令官は触らない(`skills/og-manage/SKILL.md` Guardrails)。
- **断られたら社長が専用の `POST /api/swarm/orchestrator/overseer/dismiss`** を呼ぶ(`dismissOverseerReminder` — `engine.json` の `overseer` だけを false に patch)。読み戻しは `GET …/orchestrator` の `.overseerRemembered` が false。これをしないと記録が残り、以後の状況報告で毎回同じ質問が出る。⚠ `…/overseer {enabled:false}` で代用してはいけない — disarm 済みの状態では `setOverseer` の変更ガードに弾かれて**何も書かれない**(`d1d6d704` の no-op 罠と同型)。

**もう一つの副作用も塞いだ(card 2b)**: `startOrchestrator` は今も全書き(`writeEngineIntent` — 3フィールド)だが、書き込む `overseer` を「その時点の in-memory `.enabled`」だけから導出するのをやめ、**先にディスクの現値を読んで OR を取る**ようになった(`engine.overseer.enabled || priorIntent.overseer`)。以前は in-memory 由来の false で上書きしていたため、resume が抑止された boot(crash-loop breaker / preflight 失敗)で owner が先に「再開」を押すと、押した瞬間に復帰バナーの根拠が消えていた。resume は元々このフィールドを読まないので、値を残しても**再開挙動は一切変わらない**。

> ⚠️ **この `readEngineIntent` は `runEnginePass` の kick より前でなければならない**(`swarmOrchestrator.ts` の clear → kick の順序)。kick の後ろに置くと `await` が1つ増え、**engine ON で滞留時計(`reviewSeenAt`)をクリアする契約**(§7.4 / 7517e4b1)が壊れて、ON 直後に生きた司令官卓へ声かけ(ESC 付き)が飛ぶ。`patchEngineIntent` に「戻す」と内部で read が1回増えて同じ回帰を踏むので、**全書き+事前 read というこの形を崩さないこと**(2026-07-24 `4e218a46` で実際に踏んで直した回帰)。歯は `swarmOrchestrator.test.ts` の「startOrchestrator DROPS the review dwell clock」。

**なぜ非対称か**: selfSupply の出力は per-card 承認ゲート(`selfSupplyApproved`)で不活性 — 提案カードが積まれるだけで dispatch はされない。overseer は大脳(claude PTY)の起動・稼働中 worker への文字列注入・janitor の破壊的操作(`git branch -d` / 心拍 unlink)を**直接駆動**し、かつ再起動は OVERSEER_DESIGN.md K2/L9-③ が定める「代替の無い kill switch 層」— overseer の自動再開だけがこの層を無効化してしまう。設計の経緯は docs/ENGINE_PERSISTENCE_PLAN.md §2、正典は OVERSEER_DESIGN.md K2(2026-07-22 追記あり)。

(旧 `autoMerge` フィールドも overseer と同じ揮発モデルだったが 2026-07-16 にフィールドごと撤去 — 司令官起こしは `running` に常時同乗。overseer はさらに、明示 stop が disarm し(:5863-5866)、running 中しか arm できない(:6393-6396)。)

### 7.4b 司令官の卓も再起動をまたぐ(2026-08-26 追加 — 孤児化の是正)

**旧知識: 再起動で司令官は消え、engine の蘇生反射が起こし直すまで戻らない。撤回。**

再起動をまたいで戻るものの表に、**司令官(commander)の卓**が加わった。根拠は
`engine.json` の新フィールド **`managerDesired`** — 補給官の `supplyDesired`
(2026-08-03)と完全に対称で、boot の `resumeEngines()` が読んで
`spawnSwarmManager` を呼ぶ。

**なぜ増やしたか(実測の事故, 2026-08-26)**: アップデートが swarm 稼働中にアプリを
再起動した。engine は `desiredRunning` で戻り、worker roster は reconcile で戻り、
補給官は `supplyDesired` で戻った。**司令官だけが戻らなかった** — 卓はこのサーバが
抱える `claude` なので再起動で死ぬのに、戻すための根拠がどこにも無かった。
`managerPresence` は `missing` のまま(`manager.updatedAt` 08:58:27Z / boot
09:07:58Z)、孤児化した worker はそのまま走り続けて**完了した**。司令官のいない完了は
誰も統合しない。owner の目には worker が生きているので「動いている」に見える — いちばん
気づきにくい停止。再起動はたいていリリースなので、**作業が飛んでいる最中に起きる**。

司令官の卓に効く順序と条件、他フィールドとの違い:

| | 根拠 | `desiredRunning` に従属するか | 手動停止記録に負けるか |
|---|---|---|---|
| engine の `running` | `desiredRunning` | — | **負ける**(§7.4 の supremacy) |
| 補給官の卓 | `supplyDesired` | しない | 負けない |
| **司令官の卓** | **`managerDesired`** | **しない** | **負けない** |
| overseer | 覚えるが起こさない | — | — |

- **`desiredRunning` に従属しない** — 自動運転 OFF のまま司令官が立っているのは普通の
  状態(owner が卓と話している)。engine のゲートの後ろに置くとその全部を落とす。
- **`manualStop` にも負けない** — あれは**自動運転の一時停止**であって、「今話している卓を
  閉じろ」という意味を持ったことは一度もない。卓を閉じるのは卓自身の停止経路だけ。
- **owner の意図だけを書く** — `POST /api/swarm/manager` が立て、
  **`POST /api/swarm/manager/stop`(新設)**が消す。engine の蘇生反射が立てた卓は
  フラグを書かない(統合待ちが残っていれば反射がもう一度立てるので不要だし、owner が
  立てた覚えのない意図を永続させてしまう)。
- **閉じるボタンは必ずこの stop 経路を通る** — 以前の UI は生ハンドルを DELETE していた
  (kill であって意図の表明ではない)。boot 自動復帰が入った今それをやると、**owner が
  閉じた卓が毎回の再起動で蘇る**。補給官側で `/api/swarm/supply/stop` が塞いだのと同型の罠。
- **戻れなかったときは黙らない** — 補給官の resume は失敗を握り潰すが、司令官は
  `engine-resume-suppressed` の fatal 通知を上げる。補給官の不在は画面で見えるが、
  **司令官の不在は見えない**(worker は動き、カードは進み、ただ何も着地しない)。

⚠ §7.3 の dev ゲートはここにも同じくかかる — `process.send` が無い `tsx watch` では
resume そのものが走らないので、司令官の卓も戻らない。実機確認は `electron:prod` か
パッケージ済み `.app` で。

歯(mutation で赤を実測済み): `swarmOrchestrator.resumeEngines.test.ts` の
「the COMMANDER desk comes back」ブロック(ブロック削除 / `desiredRunning` ゲートの後ろへ移動 /
手動停止ゲートの後ろへ移動 / 失敗を握り潰す、の4通り)、
`server/routes/__tests__/swarmManagerDesired.test.ts`(spawn が書かない / stop が消さない /
owner ゲート欠落)、`SwarmModule.commanderStop.test.tsx`(生ハンドル DELETE への差し戻し / path 欠落)。

### 7.4b2 Boot resume holds per actor and retries until the gate opens (2026-11-17)

**Old knowledge withdrawn: "a resume blocked at boot stays off for the session" and
"the president's resume is best-effort and silent".**

**Measured incident.** After the 0.11.208 update neither the presidents nor the
autopilot came back on any project (orchestrator: `running:false`,
`autonomyRemembered:true`, `autonomyResumed:false`, empty log, no notification).
`~/.openground/engine-boots.json` — written by `recordEngineBoot` on the first
line of every `resumeEngines()` — had not changed since the 0.11.207 boot
(2026-11-09 17:36 JST), i.e. `resumeEngines()` had not run on any boot since.
`~/.openground/runtime/receipts.json` held three `uncertain` `runtime-tool`
receipts ("The app restarted after this operation began"), the first from
2026-11-09 18:06 JST: a commander desk's Bash in one project (sns-hub) cut off by
a restart. The boot callback in `server/index.ts` ran
`assertSavedSwarmRuntimeSafe()` / `assertNoUncertainRuntimeActions()` /
`awaitPresidentInputSettlement()` **globally** before `resumeEngines()`, so that
one receipt threw on every later boot: no president, commander or autopilot
anywhere, the automation policy loop never started, and the only trace was a
`console.error` in a stderr nobody reads.

A second, intermittent stopper on the same line ("it came back on some boots and
not others"): the receipt reads are owner-scoped (`runtimeOwnerKey`), and right
after a launch the owner-role lookup can still be offline — then
`awaitPresidentInputSettlement()` threw "Owner sign-in is required" and held
the whole boot the same silent way.

**Now:**

- **Per actor, not per app.** `savedSwarmRuntimeHold(projectPath, actor)`
  (`swarmRuntimeTransition.ts`) replaces the global asserts. Commander and
  engine are held by that project's unconfirmed receipts (the same scope the
  manual `spawnSwarmManager` / SDK launch doors already check) and by their own
  sessions' unfinished history; the president only by its own session or an
  unsettled president instruction in its project. Unrelated projects and
  actors resume. The check reads every account's receipts
  (`listAllConversationReceipts`), so it neither throws nor goes blind while
  the owner-role lookup has not answered — but it holds only on what 会話の復旧
  can show and clear (that screen lists the signed-in owner's records only):
  owner known ⇒ only that owner's receipts hold (another account's record holds
  nothing); owner not known yet (lookup offline, signed out) ⇒ any receipt
  holds, as a transient "sign in" hold on the retry timer.
- **No global assert before `resumeEngines`.** The boot callback lives in
  `bootResumeHook.ts` (`server/index.ts` only registers it) so
  `bootResumeHook.test.ts` can run it with the old asserts throwing — putting
  any of them back ahead of `resumeEngines` turns that test red.
- **The boot resume owns a held engine's start.** While a project's engine part
  is pending, the frame reconcile (`reconcileAutomationOrchestrators`) and the
  opt-in auto-drain sweep leave it alone — starting it there would skip the
  hold, the roster reconcile and `--resume` adoption. Retries also wait while
  an AI connection switch is in flight (`runtimeAdmissionBlocked('swarm')`).
- **Retry, not one shot.** `resumeEngines()` keeps a pending map (president /
  commander / engine per project). Anything a gate held — preflight, the
  owner-account check (`automaticOperationAllowed`), saved work awaiting review,
  a spawn that threw — stays pending and `retryBootResumes()` re-runs the
  attempt from the automation policy loop (15 s, `automationPolicy.ts`) and
  after a recovery review (the `runtimeRecoveryBoot` re-notify, not awaited so
  an AI-switch settle never waits out a pass). A hold only the owner's review
  clears (`isOwnerReviewHold`: its reason carries `OWNER_REVIEW_HOLD_HINT` — the
  bar's question — or, for a held ChatGPT desk conversation, which raises no
  inbox question, one of three words `chatGptHoldHint` picks: `CHATGPT_REVIEW_HOLD_HINT`
  — Settings › 詳細設定 › ChatGPT › 中断した作業の確認 — only while that panel can
  list it (app sign-in, owner role, live ChatGPT connection to the account that
  started it, work mode off); otherwise `CHATGPT_SIGN_IN_HOLD_HINT` (those
  conditions), or `CHATGPT_UNREADABLE_HOLD_HINT` for a history that cannot be read
  (no door promised); the standing names the same door) is skipped by the 15 s
  timer — each try ran the claude preflight and re-parsed transcripts up to
  32 MB — and retried on that re-notify (`retryBootResumes({ownerReview:true})`)
  or every `BOOT_OWNER_HOLD_RETRY_MS` (5 min), because it can also clear with no
  review at all (an orphaned claude finishing its call) (re-notify:
  queued if a pass is running; a re-notify that lands while the first boot pass
  is still running re-runs the hook afterwards — `runtimeRecoveryBoot.ts`). A
  read error on a saved transcript is NOT an owner-only hold (it stays on the
  timer). A project unregistered after boot is dropped (an empty registry read —
  what an unreadable settings.json returns — drops nothing). Every attempt
  re-reads `engine.json` (and the desk flags again right before spawning), so a
  stop the owner made while it was pending (`supplyDesired`/`managerDesired`
  cleared, manual-stop record) drops it. A project deliberately outside the
  Ground frame (a healthy canvas read) resumes nothing, as before, and says so
  once if something had been up; an unreadable canvas or an unanswered account
  check is transient and stays pending. The crash-loop breaker and the unwritable
  boot ring still suppress the whole boot with no retry — deliberate.
- **Never silent.** Each hold writes `boot resume held: <who>: <why>` to that
  project's engine log when that engine exists (`GET /api/swarm/orchestrator` →
  `log`; no engine is created just to log — the reconcile could persist it and
  clear a saved `desiredRunning`) and raises one `engine-resume-suppressed`
  notification per distinct reason (not per retry) — once the project has been
  held for `BOOT_HOLD_ANNOUNCE_MS` (15 s, a timestamp on the entry, not a retry
  count: the policy loop's first tick retries milliseconds after boot; the
  timestamp restarts when the hold changes and clears when it clears), so a few
  seconds of an offline owner-role lookup at launch raise neither a fatal toast
  nor a 戻りました notice. Hold texts are Japanese only (an owner-lookup
  error, a switched account, an unreadable transcript); English error detail goes
  to the server log. An owner-review hold
  (never retried on the timer) is announced at once. A late successful resume
  raises an `engine-resumed` info notice only if its hold had been announced.
  The president's resume is no longer silent either.
- **The update waits for a tool boundary (2026-11-17, `electron/autoUpdatePolicy.js`).**
  The holds above keep the c5c61209 rule (an interrupted, unconfirmed tool
  action is never silently replayed), so the way to bring the commander and
  engine back hands-free after an UPDATE is not to be mid-call when it lands.
  `GET /api/update/restart-safety` reports `toolCallsInFlight` (SDK
  tool_use without its tool_result for native Claude actors, and the converted
  tool_use / tool_result / turn_end events for ChatGPT actors — one call at a
  time, so a per-session count — both from `sdkSession.ts`'s live stream; PTY
  desks are not counted, swarm workers and commanders are SDK-only); the
  hands-free apply waits for 0, looking again every 2 s, for at most
  `TOOL_BOUNDARY_MAX_WAIT_MS` (15 min) of ACCUMULATED tool-wait time — then
  installs anyway, as before. `nextToolBoundaryWait` adds, per decision deferred
  for a tool call, the time since the previous such decision (each step capped at
  `TOOL_WAIT_STEP_CAP_MS` = 2 × the 2 s look-again); a decision deferred for
  anything else (owner active/typing, a president turn, the owner's terminal, an
  unreachable probe) ends the streak and its gap adds nothing — wall-clock since
  the first tool deferral counted the owner's own working time and then
  installed mid-tool at the first idle moment. No decision resets the total
  (with several workers busy any reset let the bound run forever), nor does a
  newer version; it lives in the main process, so a real install ends it, and
  `onStuck` (an install that returned without quitting) clears it. An
  unreachable probe gets the 2 s look-again only in the middle of a tool-wait
  streak, once; a streak logs when it starts, not every look.
  Generation alone still does not hold an update (2026-09-23). `main.js`
  re-asks right before the teardown on every hands-free apply. Residual: a tool
  call that starts in the ~instant between that last probe and the server
  teardown is still cut (and held for review) — the window, not the rule, shrank.

Teeth (red measured on fe4e0607, then mutation-checked):
`swarmOrchestrator.resumeEngines.test.ts` "boot resume retry — a gate not ready
at boot opens later" and `swarmOrchestrator.bootResumeFrame.test.ts` (the frame
reconcile does not bypass a held engine; the 2026-11-17 follow-ups: owner gate
closed→open, announce-after-retry, owner-only backoff, unregistered drop,
president held by its instruction / transcript, foreign receipts), plus
`bootResumeHook.test.ts`, `server/__tests__/autoUpdatePolicy.test.ts` (tool
boundary, bounded) and `sdkSessionLifecycle.test.ts` (`sdkToolCallsInFlight`).
Each red-measured by a production mutation on the follow-up branch.

### 7.4b3 A second OPEN GROUND process no longer marks the live app's work "uncertain" (2026-11-23)

**Old knowledge withdrawn: "an `uncertain` runtime-tool receipt means the app
restarted".** It could also mean that *another process* opened the journal.

**Measured incident (2026-11-20 → 23).** A worker ran `npm run dev:alt` to look
at a UI change. `scripts/dev-alt.mjs` passed the environment through, so the
second server shared `~/.openground`. Within 100 ms of its first journal read
(the 2 s inbox tick in `server/index.ts` lists receipts in every server process
once the owner is signed in) two live Bash calls of the real app — one in this
project, one in another — became `uncertain` ("The app restarted after this
operation began"). The app had not restarted since 11-18
(`engine-boots.json`). One such receipt in a project makes
`assertNoUncertainRuntimeActions` deny every tool (PreToolUse "No action was
authorized"), ends each SDK launch before `claude` starts (the engine only logs
"worker lost") and keeps `spawnSwarmManager` from starting the commander: two
projects stood still for three days. Older marks of the same shape (11-09 ×2,
11-15) have no identified trigger.

**Cause.** `conversationReceipts.ts` keeps `bootId = randomUUID()` per process
and, on *every* journal open (reads included), rewrote each `executing` receipt
whose `attemptBoot` was another boot to `uncertain`. "Another boot" was taken
to mean "a boot that is gone". Nothing kept a second process from writing the
journal either (`writer` serialises one process only).

**Now:**

- **One owner per data folder's runtime journal** (`runtimeJournalOwner.ts`,
  checked first inside `transaction()`, the single choke point). The owner
  record is `runtime/journal-owner/<generation>.json` = `{bootId, pid, port}`,
  where `port` is a loopback listener the owner opens before it publishes the
  record and never closes, so only the end of the process closes it. While the
  owner lives, any other process gets `RuntimeJournalOwnedElsewhere` (message
  names the owner's pid and says to check what it is first: if it is the live
  app, give this copy its own `OPENGROUND_HOME`; if the refused one is the app,
  stop the pid only once it is confirmed a stray copy and never move the app to
  another home; never delete `runtime/journal-owner/` — agents read it; logged
  once per pid) before it reads or writes. Every
  caller fails closed on it (503 / 409 / 500, deny, hold or a quiet retry —
  audited 2026-11-23, none proceeds).
- **Gone takes proof** (one rule on every OS, nothing spawned): `kill(pid, 0)`
  = ESRCH; or nothing listens on the recorded port (ECONNREFUSED); or what
  listens there answers something other than the owner's hash (the port went to
  another program — after a reboot old pids soon belong to other programs, so
  the pid alone proves nothing). Everything else counts as alive: a stopped,
  sleeping or busy owner still has its connection accepted by the kernel and
  simply does not answer (no lease, no timeout to run out), and an owner out of
  file descriptors hangs up without a word (libuv sheds load that way) —
  neither is proof. Our own pid counts as gone (an earlier load of the module —
  tests reload modules; a reused pid otherwise). The first version
  (2026-11-23) compared OS start times through `ps` / PowerShell; dropped
  2026-11-24: PowerShell 5.1 cannot read the start time of a process it may not
  open (a reused pid after a reboot often is one, and "cannot tell" = alive
  would have refused the app its own journal), and Linux `ps lstart` can differ
  between two invocations. A probe sends one HTTP-shaped line first, so a
  program that waits for the client to speak (HTTP servers above all) answers
  too and gives itself away. A silent holder is probed at most once a minute:
  each probe stays queued at a stopped owner (a reset does not free the slot —
  measured on macOS), and Windows refuses connections to a full queue, which
  would read as gone. The pid check still runs every time.
- **Takeover is a compare-and-swap**: generation n+1 is published with
  `link(2)`, which never overwrites (EEXIST = lost the race), and withdrawn
  again unless every other record in the folder is one this process judged,
  unchanged — compared by content, not name: a listing can be older than two
  takeovers, and a name judged gone can hold a fresh live claim once the folder
  was emptied. Every record is judged, not only the newest: a process that died
  between publishing and withdrawing leaves one above the live owner's, and the
  owner publishes itself again above it.
- **The restart sweep** is reached only by the owner, so a real restart (the
  previous owner is gone) still marks its unfinished work `uncertain` as
  before. Since 2026-11-24 each claim also records its process
  (`attemptHolder` = `{pid, port}`, the same proof of life as an owner record),
  and the sweep marks a call `uncertain` only once that process is proven gone
  (same rule as above). Defence in depth: even a second owner (the lock folder
  deleted from outside while the app works) leaves a live process's calls
  alone — but it still shuts the live app out until it exits (Limits: never
  delete `runtime/journal-owner/`). Claims written before carry no holder and
  keep the old rule.
  `attemptHolder` is never shown (`publicConversationReceipt`).
  A mark the sweep made for a call whose result Claude's transcript recorded (the
  2026-11-20 worker call above completed normally) is settled from that record on
  first use since 2026-11-28 (§7.4e, last paragraph); only a call with no recorded
  result keeps holding.
- **Builds from before the lock are shut out** (2026-11-24): the journal lives
  at `runtime/receipts-v2.json` (`version: 2`, same shape). Pre-fix builds read
  and replace `runtime/receipts.json` and know no lock, and an old checkout's
  server (ten such worktrees on the owner's Mac that day) would flip the live
  app's claims. The first answer — `version: 2` in place, which pre-fix builds
  refuse to parse — stopped their *reads* but not a *write* already under way:
  an old build that read version 1 just before the app wrote renamed its stale
  copy over the app's journal (review round 2, modelled), and the app's
  in-flight receipt disappeared. So the owner (`retireLegacyJournal`, every
  transaction, one `stat` once done) moves `receipts.json` in, keeps it as
  `receipts.json.retired`, and puts a **folder** at the old path: old builds
  fail closed reading it (`EISDIR`) and cannot rename a file over it. Leaving a
  plain old file behind was rejected: an old build would then run on a stale
  copy, and a later real restart's cut-off call would be missing from it — the
  hold weakened. A file there again — a downgraded app run after its folder was
  removed by hand, or an old build's write landing between the rename and the
  folder — is merged, not dropped (commander rework 2026-11-26; until then it
  was only renamed: its `uncertain` marks and owner inputs vanished and the
  first `.retired` was overwritten). What it holds that `receipts-v2.json` (its
  archive included) lacks moves in, so its cut-off calls are held by the sweep;
  for anything both hold, `receipts-v2.json`'s copy stands; accepted draft
  revisions keep the higher one. Every copy is kept (`.retired`, `.retired.2`,
  …), never overwritten.
- `npm run dev:alt` runs on its **own throwaway `OPENGROUND_HOME`** unless one
  is given (`scripts/dev-alt.mjs`; the path is printed), and refuses one that
  is the app's own folder however it is spelled — a symlink, another letter
  case, `/System/Volumes/Data/…`, or with `HOME` pointed elsewhere (compared by
  device and inode against `~/.openground` of both `HOME` and the account).

**Limits (by design or not yet covered):**

- First come, first owner. A second process on the real home that touches the
  journal while the app is down (e.g. during an update restart) keeps the app
  out until that process exits — refused calls name its pid. `dev:alt` no
  longer shares the home and refuses it, so this takes a plain server or a
  script started on the real home.
- An app version from before this change writes no owner record: a live app is
  protected once it runs this version itself. Conversely, once this version has
  opened the journal, an older build (a downgrade, or a self-update rollback to
  a pre-fix build) finds a folder at `runtime/receipts.json` and holds all
  runtime work until it is upgraded again (for an owner with ChatGPT access its
  `assertNoUncertainRuntimeActions` reads the journal and throws). Removing that
  empty folder by hand lets an old build start over on an empty journal —
  without the holds recorded since; what it records there moves back in on the
  next upgrade (above). That includes the installed app itself
  while it still runs a pre-fix version: a process of this version that opens
  the real home's journal first (a script, a server pointed at it) leaves the
  old app holding all runtime work until it is upgraded. So release and
  install promptly once this lands.
- Pids and loopback ports belong to one machine: a data folder shared with a
  container or another host is not covered. After a reboot, a reused pid plus a
  program on the recorded port that neither speaks nor answers the probe's line
  still reads as alive until that program lets go of the port (the refusal
  names that unrelated pid; `lsof` below shows it). No record and no claim is
  ever written without its port (a failed loopback listen fails that call; the
  next one tries again): one only a pid speaks for could never be proven gone,
  and after a restart a reused pid would refuse the real app its own journal
  for as long as that other program runs (commander rework 2026-11-24; the
  first design's record without `started` had the same hole). A portless record
  can only come from a build that never shipped; it counts as alive while its
  pid lives.
- **Never delete `runtime/journal-owner/` while any OPEN GROUND process runs.**
  It does not free the journal, it hands it to whichever process asks next
  (measured 2026-11-26 with real processes): when that is a second process, it
  owns the journal and the live app is refused on every call
  (`RuntimeJournalOwnedElsewhere`: every tool denied, no worker or commander
  starts, as in the incident) until that process exits. The claim holders above
  still keep the live app's calls from being marked `uncertain`.
- The data folder needs hard links (APFS, NTFS, ext4). On exFAT / FAT or an SMB
  home the journal fails closed with a message that says so.
- Not yet run on a real Windows machine (a refused loopback connect takes about
  2 s there; the probe waits up to 5 s).
- A plain `npm run dev` / `start` / `dev:server` next to the running app exits
  on EADDRINUSE before its first I/O callback, so it never reaches the journal
  (audited 2026-11-23).
- Still unlocked second-process writes, out of this change: `runtime/transitions.json`
  (boot-time "restarted during a switch" stamp — the live app overwrites it on
  its next step), `runtime/drafts.json` (composer drafts — no boot logic and
  no write on read; written only when a second server's UI is typed into), and
  route-triggered actions in a second server's UI that judge liveness from
  their own memory (worktree remove / clean, opening a desk). Hence: never
  point a second server at the real home.

**Diagnose:** `GET /api/conversation/recovery` lists the `uncertain` receipts
(the journal itself: `~/.openground/runtime/receipts-v2.json`; `receipts.json`
there is a folder, `receipts.json.retired` (`.2`, … for later ones) the
pre-lock copies); `ls ~/.openground/runtime/journal-owner/` shows the owner
generation (`cat` it for the pid and port; `ps -o pid,lstart,command -p <pid>`
and `lsof -nP -iTCP:<port> -sTCP:LISTEN` show who holds them) — look, never
delete it while any OPEN GROUND process runs (Limits). A second process on the
same home answers its receipt routes with the pid message above. When the
refused one is the app itself (another process asked first while the app was
down), check what that pid is and stop it only once it is confirmed a stray
copy; never move the app to another `OPENGROUND_HOME` — it would start empty.

Teeth (each red-measured by a production mutation, 2026-11-23 / 24):
`runtimeJournalOwner.test.ts` — a real second process leaves a live process's
executing receipts byte-identical and is refused, and the same receipts turn
`uncertain` once the first process is gone (red with the owner check removed:
both live receipts `uncertain`; red with "gone" never proven; red with the
restart sweep disabled); the refused copy stays refused on every later read and
write (red with the check on the first call only) and never compacts a full
journal (red with the check moved below compaction); old builds' path is a
folder while the app runs — their read gets `EISDIR`, a rename over it is
refused — and a pre-lock journal moves in once, its cut-off call held, its path
a folder and a `.retired` copy kept (red with the folder never made, with the
move skipped, with version 1 no longer readable); a live process's calls stay
`executing` even for a second owner after the lock folder was deleted, and turn
`uncertain` once that process is gone (red with the sweep ignoring the holder,
and with claims carrying no holder); a claim whose check after publishing fails
is withdrawn (red without the withdrawal); a stopped owner is still the owner; each "cannot tell" judged on its own
— no port, a hang-up, a reset, EPERM — is alive (red with each counted as gone);
a silent holder is probed once a minute (red without the limit); an exited
owner, a pid and a port that went to other programs (a greeting server, an
HTTP-like one that waits for the probe's line — red with a silent probe), an
unreadable record are taken over and a `05.json` is left alone (red with
leading zeros accepted); a claim published after our listing is never
overwritten; a claim that lands under a newer live owner is withdrawn; a record
that reappeared under a name judged gone is kept (red with names compared, not
content); a gone process's stray record above the live owner does not hand the
journal over; of two simultaneous starters exactly one owns.
`server/__tests__/devAltHome.test.ts` — `dev:alt` hands its server a fresh
throwaway home (red with `OPENGROUND_HOME: home` dropped) and refuses
`~/.openground`, also through a symlink (red with the refusal removed).
`runtimeActionReceipts.test.ts` "restores a fresh-module started receipt"
guards the own-pid rule. Commander rework (2026-11-24, re-measured 2026-11-25 on
the final code, each guard removed alone): a claim that lands under a newer
live owner from a listing older than two takeovers is withdrawn (red with the
post-link check disabled: 2 failed); with the first listen failing nothing is
published and the next call claims with its port (red when a portless claim is
published — also red before the fix, 7b648224); the refusal tells the reader to
use its own `OPENGROUND_HOME` and not to stop the pid unchecked (red with the
old "Stop it" text). Five of these mutations passed the whole suite before
the 2026-11-24 review round (check on the first call only, check below
compaction, portless / hang-up / EPERM / socket error counted as gone).
Re-measured on the final code (2026-11-25, a detached copy of the branch, one
edit at a time, restored from git): the seven mutations of the folder / move /
version-1 read / holder check / holder stamp / withdrawal each turn exactly
their test red. The two layers were measured apart: with the owner check
removed (the `runtime/` folder still made), the second copy is no longer
refused (3 failed) but the claim holders keep the live calls `executing`; with
the holder check removed as well, the incident is back — `expected
{ 'live-action': 'uncertain', … } to deeply equal { 'live-action':
'executing', … }` (4 failed).
Commander rework (2026-11-26, measured on this code, each production edit
alone, restored after): a populated pre-lock journal (two projects' marks,
settled history, owner inputs with draft revisions, contexts) moves in whole,
only its cut-off call `uncertain` (red with the move-in keeping only
`executing` records and empty contexts / drafts: `expected 1 to be 7` — the
one-record test above stayed green under it); a pre-lock journal that
reappears after the move is merged (red before the fix: `expected undefined to
deeply equal { id: 'mark-downgraded', … }`), each part with teeth — the archive
not counted as ours, the old copy winning a shared key, contexts not moved in,
the old draft revision winning, drafts not moved in, the first `.retired`
overwritten: 1 failed each; the refusal names both remedies and warns off
deleting the lock folder (red with the 2026-11-25 text).

Measured with real processes in an isolated `OPENGROUND_HOME` / `HOME` /
`TMPDIR` (2026-11-23 on the start-time rule, 2026-11-24 on the listener rule
with the journal at `version: 2`, 2026-11-25 with the journal at
`receipts-v2.json`, and 2026-11-26 on the code of the 2026-11-26 rework, the
refusal naming both remedies — same outcome each time): process A held
two executing receipts; a real `server/index.ts` boot B
on the same home ran 7 s past its first `/api/health` answer (three inbox
ticks) — journal byte-identical, owner record A's alone, B's recovery route
answered 500 naming A's pid; A then settled one call (`delivered`), so the live
app's work went on; after A was killed, B took over (generation 2) and marked
only A's unsettled receipt `uncertain`. With the owner check removed the same
run reproduced the incident (2026-11-23).

### 7.4c 「誰も動かしていない doing カード」は engine が回収する(2026-08-27 実測の停止)

**旧知識: worker が done になれば司令官が起こされる。条件付きで撤回。**

司令官を起こす鎖は、全部の輪が `engine.workers` か review 列を読んでいる:

```
monitorWorkers(engine.workers を歩く) → doing→review へ昇格
  → runIntegratePass が review 列を読む
    → 初めて見た branch = freshlyReady
      → managerNotice → 卓を起こす
```

**`engine.workers` に居ない worker は、この鎖のどこにも入れない。** 入れない
worker は2種類ある:

1. **再起動をまたいだ worker** — boot の `adoptResumeCandidates` が採用を見送った
   もの(session id 無し / transcript 未証明 / spawn 失敗)。「transcript 未証明」は
   存在しない・空・読めない、または**孤児 claude が生きている**場合。孤児の判定は
   ①その session id をコマンドラインに持つプロセスが居る(`ps` 1回・失敗時も
   断る)②最終更新が孤児窓(`ORPHAN_MTIME_WINDOW_MS` = 10秒)内なら窓が過ぎる
   まで(最大10秒)待って測り直し、更新が進んでいる。どちらも無ければ resume する
   (時刻の近さだけでは断らない — 2026-09-24、ハンズフリー更新は worker を止めて
   約10秒で再起動するため旧実装は毎回断っていた)。時刻は証明を実行する時点で
   読み、証明が通った後・起こす直前に自動運転の停止を読み直す
   (`swarmTranscriptProof.ts` / `adoptResumeCandidates`)。
2. **手動 worker** — `POST /api/swarm/worker`(Board の 実行 ボタン)は
   `engine.workers` に **push しない**。engine 自身の dispatch だけが数える。
   0.11.98 で 実行 が worker 経路になったので、こちらは日常的に発生する。

実測(2026-08-27, QRmenu): 再起動前に出た worker 3体が再起動後に完了。カードは
`doing` のまま、worktree は生きていて、心拍は `readyToMerge`、branch には commit
があるのに、**誰も review へ動かさなかった**。`GET /api/swarm/workers`
(roster ∪ 心拍 ∪ 生きた卓)は ready:true を返し、`GET /api/swarm/orchestrator` は
`workers:[]` を返し、**その食い違いは何時間も無言だった**。動いたのは補給官が手で
`POST /api/swarm/manager/say` を送ったときだけ — 起きた司令官が「状況」を実行して
**自分でカードを動かし**、そこで初めて engine の通知が出た(「統合待ち 3 件・
**0秒**で到達」— 0秒なのは、通知の仕組み自体は壊れていなかったから)。

**追加された2つ**(どちらもカード起点。`adoptResumeCandidates` の3つの出口に
4枚目の当て板を貼るのではなく、**どう孤立しようと成り立つ不変条件**にしてある):

- **`promoteUnownedDelivered`**(`runDispatchPass` の 2b、monitor の直後)—
  「誰も数えていない doing カードで、心拍が ready かつ branch に commit がある」
  ものを review へ回収する。以後は既存の鎖がそのまま動く(通知 → 司令官)。
  **生きた worker のカードを奪えない**理由が3つ揃っている:
  ①数えられた worker のカードは対象外(そのカードは monitor が持つ)
  ②`readyToMerge` + commit(引き渡しの合図と実体の両方)
  ③差し戻されたことのあるカード(`reworkedAt` あり)は、心拍が**最後の差し戻し時刻
  `reworkedAt` より新しい** ready のときだけ(`readySinceSendBack`)— 差し戻しは心拍ファイルに
  触れないので、worker が次に打つまで前の回の ready が残る。live monitor はこれを in-memory の
  `reworkAt` で見分けるが、それは再起動で消え、**数えられていない worker には最初から無い**。
  だから時刻はカードに持たせる — `{rework}` API・`setColumn` の review→doing・Board の
  review→doing ドラッグの3経路が刻む(swarm-board.sh は刻まない)。`reworkCount` があって
  `reworkedAt` の無いカード(2026-10-07 以前)は従来どおり対象外。
  ⚠ **2026-10-07 実測(カード a1a3d9ea)**: 以前の③は「`reworkCount` が 0 のものだけ」だった。
  司令官が手で立てた worker(`POST /api/swarm/worker` — 数えられない)の 1 回目の完了は
  この掃除が 12:10 に回収、12:18 に差し戻し、12:22 に再完了(新しい ready + 2 commit)——
  そこから 14:18 にオーナーが聞くまで doing のまま、司令官には何も届かなかった。
- **`noticeStrandedReady`**(2d、取りこぼしの網・2026-10-07)— 上の道筋のどれが漏れても
  結果で捕まえる: doing の swarm カードで `readySinceSendBack` が真のまま
  `STRANDED_READY_NOTICE_MS`(3分)動かず、branch に commit があれば、司令官の卓へ
  一言知らせる(`deps.tellManager` = `defaultNotifyManagerReady` の `{text}` 形 —
  完了通知と同じ「生成中・打ちかけ・メニュー表示中には書かない」規則)。見るのは
  `STRANDED_READY_CHECK_MS`(30秒)に1回(心拍の読みは repo キーがキャッシュされるので軽いが、取りこぼし確定後の
  commit 数の git と卓の記録読みを、通知を受け取れない卓のために 3 秒ごとに回さないため)、
  届かなければ次の回に再試行、届いたら `STRANDED_READY_RENOTICE_MS`(15分)ごとに繰り返す。
  数えられた worker で monitor が差し戻しを見ている(`reworkAt`)ものは、それより新しい心拍で
  なければ数えない(カードの刻印を通らない差し戻しへの「review に移して」を防ぐ)。同じく
  同じ branch に再配車された worker(`reenteredAt`)は、再配車より古い心拍を前任のものとして
  無視する(monitor と同じ `heartbeatPredatesReentry`)。
  **カードは動かさない**(動かすべき道が動かさなかったのは司令官が見るべき不具合)。
  commit 数は 3 分経ってからだけ読む。
- **`unowned-doing` 異常**(`orphan-doing` の兄弟)— 同じ「誰も居ない doing」で、
  **worktree が残っている**側。届いていない残りがここに出る。
  ⚠ `AnomalyDeps.deskOccupies`(両プールに生きた卓が居るか)で必ず絞ること。
  これが無いと**健全な手動 worker 全部に火を噴く** — 読み飛ばされる通知欄は
  無い通知欄より悪い。プローブが答えられないときは **「居る」側に倒して黙る**。

**声かけ 1/3 で止まる件は、この停止の下流**であって別のバグではない。review が
空なら Part B は丸ごと武装解除される(`swarmCards.length === 0` → `rs.nudges = 0`)。
カードが `doing` に取り残されている間 review は空なので、engine は言うことが無い。
加えて `manager/say` を送ると卓が `active` に見えるので、そこでも予算は正当に
リセットされる。回収が入れば review にカードが載り、10分間隔の 1/3 → 2/3 → 3/3 が
そのまま回る。

歯(mutation で赤を実測済み): `swarmOrchestrator.test.ts` の
「promoteUnownedDelivered」ブロック(掃除を消す / 数えた worker のガードを外す /
差し戻しガードを外す / 引き渡しの合図なしで昇格 / 空 branch で昇格)と
「detectAnomalies」の `unowned-doing` 3本(生存プローブを無視 / プローブ障害を
発火側に倒す / worktree が消えたら orphan-doing のまま)。
⚠ 「数えた worker のガード」の歯は**最初 緑のままだった** — 心拍を与えていない
fixture だったので、ガードを外しても引き渡し検査が止めていた。何も観測していない
歯だったので、ready な心拍 + commit を与えて**ガードだけが理由になる**形に直した。

### 7.4d 作業途中で取り残された doing カードも engine が回収する(2026-09-01 実測の停止)

§7.4c は**届いた**half(ready + commit)だけを回収する。残った孤児クラスが
**作業途中**の unowned worker で、週次上限で実測した(AIResearch):

- 手動 worker(実行 ボタン経由 = `engine.workers` の外)が週次の利用上限に当たり
  `quota-parked`(上限待ち)で停止。
- engine の quota 経路(monitor が park を見て requeue → 冷却テーブル → 上限明けに
  再 dispatch)は **`engine.workers` を歩く**ので、この worker には届かない。
  park 自身の出口(実作業イベント / turn 境界2回)も、入力の来ない idle セッション
  では**永遠に発火しない**。
- 次のアプリ再起動でセッションは死に、カードは `doing` に残る。dispatch は todo
  列しか見ないので、**上限が明けても(使用量 0%)誰も再着手しない**。画面は
  「実行中 1」なのに下のバーは「稼働 0」— この食い違いがこの停止の顔。

**追加(`collectUnownedDoing` — `runDispatchPass` の 2c、2b の直後)**: 誰も数えて
いない doing カードで、promote が請求しなかった(=届いていない)swarm branch 持ちの
ものを、卓の実態で振り分ける:

| 卓の状態 | 処置 | 理由 |
|---|---|---|
| 生きて作業中(手動 worker 含む) | **触らない** | 健全。届けば §7.4c が回収する |
| `quota-parked` だけが居る | セッション停止 + WIP salvage + **カードを todo へ** | unowned な park は誰にも解けない。owned と同じ requeue-not-hold(2026-08-13)に合流させる |
| サーバ内には誰も居ないが、その worktree の session を握る claude プロセスが OS に生きている | **触らない**(時計もリセット) | サーバの SIGKILL(猶予切れ・OOM・クラッシュ)で孤児になった worker。boot resume も 'live' で断っている。回収すると同じ worktree に新 worker が入り twin になる(2026-09-24)。保留の開始と解除を1回ずつ warn でジャーナルに書き、保留中は anomalies に `unowned-doing` として出る。`ps` がその回だけ失敗した場合も保留するが、失敗が5分続いたら打ち切って回収する(`ORPHAN_UNKNOWN_HOLD_CAP_MS`) |
| 同上だが `ps` がそもそも無い(Windows) | 従来どおり回収 | 孤児を確かめる手段が無いので、main の挙動(30秒後に回収・再配車)を保つ。**Windows ではサーバ SIGKILL 後の孤児 twin はまだ起こりうる**(既知の残りリスク) |
| 誰も居ない(プロセスも無い) | (worktree があれば salvage して) **カードを todo へ** | 再起動の残骸。branch は残るので次の dispatch が続きから入る。孤児が終われば、最後の保留から最大約30秒後の次の確認でここへ来る |

**盗まないための造り**: ①数えたカード対象外 ②`promoteUnownedDelivered` が請求した
id(移動が kept で失敗した分も含む)は除外 — 届いたカードを「無かったこと」にして
todo へ流すのが最悪の誤動作 ③30秒の猶予(`UNOWNED_DOING_GRACE_MS` — 手動 dispatch は
カード claim → セッション登録の順なので、その隙間で刈らない。'live' を見たら時計を
リセットし**連続した無人時間**だけを数える) ④卓プローブは失敗時 'live' 側に倒す
(証明できないものは奪わない) ⑤teardown が stillOccupied を返したら退く ⑥'none' でも、worktree の transcript ディレクトリ(`~/.claude/projects/<cwd>/`)にある各 session id を 1回の `ps`(`/bin/ps` 優先)の出力と照合し(`isWorktreeHeldByProcess` — boot resume と同じ `readProcessCommandLines`)、生きていれば退く。判定できない回は最大5分まで退く。`ps` が無い(win32 / ENOENT)なら退かない。
冷却テーブルには**書かない** — unowned 卓の tier は不明で、「推測で tier を冷やさない」
(§7.4 の quota センサーの規約)が勝つ。上限が続いていれば、再 dispatch された
engine-owned worker が壁に当たり、そのセンサーが正しく冷やす(1周だけ余分に回る。
有界で自己修正)。

ドロワー側の同じ穴: Board のカード詳細は worker 画面の判定を
`GET /api/swarm/orchestrator`(= engine 所有分)だけで引いていたので、手動 worker の
カードは**実行中なのに下書き+実行ボタンの顔**をしていた(実行は 409 で拒否される
ボタン)。`BoardModule` が **branch を持つ**(= dispatch の領収書がある)doing カードで
engine 非所有のとき `GET /api/swarm/workers`(union)を引き、生きた行があれば worker
画面、居なければ中断の説明文(実行ボタンは出さない)を出す。**branch の無い doing
カード**(手で 実行中 へドラッグした札・claim→spawn の隙間)は worker の物語が無いので
従来どおり下書き+実行のまま — server 側 sweep が branch 無しを対象外にするのと同じ線。

歯(mutation で赤を実測済み): `swarmOrchestrator.test.ts` の「collectUnownedDoing」
7本(請求済み除外を外す / 猶予を外す / 'live' スキップを外す / todo→blocked に
すり替え / parked の reason を crash にすり替え — 各1〜2本が赤)と、
孤児保留の3本(2026-09-24 — 孤児確認を外す / 'unavailable' を保留扱いにする / 5分の上限を外す / 毎回ログを書く / anomaly 条件を外す — 各1〜2本が赤)と、`BoardModule.drawerWorker.test.tsx` 4本(生存 id 条件を外す=残骸に画面が出る /
中断分岐を外す=実行ボタンが戻る — 各赤)。

### 7.4e Saved-work hold — an unconfirmed operation holds only its own conversation (2026-11-23, scoped 2026-11-28)

**Symptom it ends.** A project in the automation frame where nothing starts: every
dispatched worker is "worker lost" within seconds (the card lands in `blocked` after
two tries), the commander cannot be woken, running workers have every tool call
refused with `Owner authorization or durable action recording is unavailable. No
action was authorized.`, and nothing says why. Measured 2026-11-09 → 11-23 in five
projects.

**Cause, and the position reversed on 2026-11-28.** One operation whose result nobody
confirmed (an `uncertain` receipt, or an `executing` one whose actor is gone) used to
hold the WHOLE project: every SDK launch and every PreToolUse asked
`assertNoUncertainRuntimeActions(cwd, false)` per project. This section used to call
that "the safeguard, and correct". The rule worth keeping is narrower — *an unknown
result is never run again automatically, and its input is never handed to another
actor* — and the only actor that can run an unknown call again is the conversation
that issued it. Stopping every other worker, the commander and the president
protected nothing more and turned eight stale receipts into days without automation
in seven projects (AUTONOMY-SPEC §1.1). Owner decision 2026-11-28 (§7-1 = A): the
predicate takes the asking conversation's session (`listUncertainRuntimeActions(cwd,
includeExecuting, anyOwner, sessionId)`); a receipt holds only
`receipt.execution.sessionId` (`body.sessionId` for old receipts), and one that names
no session still holds everyone. The audit's PreToolUse, `sdkSession.subscriptionQuery`,
the two turn-end checks in the `sdkSession` pump and `swarmManager.launchNewDesk` ask
with their own session; `drainSwarmRuntime`'s whole-app asserts are unchanged.

**What the engine does now** (`refreshSavedWorkHold`, read at step 1d of
`runDispatchPass`, wording in `savedWorkHold.ts`), once per held operation:

- A live worker on that conversation is stopped through the normal teardown (its work
  saved on the branch) and is never resumed; its card goes to `blocked` and is kept
  out of dispatch while the operation holds. Every other card dispatches, and the
  commander's wake is not held.
- ONE question waits in the owner's inbox (the yellow hand): `openEscalation` with
  `receiptKey: hold:<receipt id>` (deduped while open, also across restarts), no
  worker address, the plain three-part shape (`unconfirmedOperationQuestion`: who —
  ワーカー / マネージャー / 社長, the screen's names —, when, what — the call's own
  `description` input only when every word of it is plain (`plainDescription` drops a
  description with any path, option, identifier, branch name or command word whole),
  never its arguments). Every answer records the owner's decision through the same
  review the Settings panel writes (`answerHeldOperation` → `reviewConversationReceipt` /
  `reviewNativeConversationRecovery`, note = the answer, operation id = the question's
  id; a receipt still `executing` whose actor is gone is first recorded `uncertain`,
  the write `runtimeRecoveryIssues` makes) and calls `notifyRuntimeRecoveryChanged()`.
  What the answer does (review 2026-11-28 — A and B used to do the same thing):
  - a worker's card: two options. A 「引き継いで続ける」 puts the card back in `todo`
    with its branch (a NEW conversation continues the saved work; it gets the owner's
    answer through the next-dispatch lane); B 「初めからやり直す」 puts it back WITHOUT
    its branch (`unparkBlockedCard {fresh}`), so the next dispatch starts from the main
    line — the old branch stays in git.
  - a desk (manager / president) or an unattributed conversation: ONE option, A
    「確認した」 — a held desk conversation is never resumed, so a second option would
    promise nothing. The answer drops the desk's saved pointer (native holds: the
    manager's only; the president's next open reads the review and opens fresh with it).
  - the answer is APPLIED before it is recorded (`answerEscalation` phase 0): one that
    picks nothing (`readHoldChoice` — THE CONTRACT since review R2 N-M2: the first line
    is the letter alone, `A` or `B`, NFKC-folded, optionally in 「」/quotes/brackets and
    followed by 。.、,; the lines below are the owner's note; nothing is guessed out of
    prose, after two rounds of widening each read a negation such as 「AでなくB」 as a
    letter), a B where only A is offered (a desk's question), a held conversation still
    running, or a review that did not take is refused (409, a plain sentence in the
    owner's language) and the question stays open. The owner can answer in the bar itself (`HoldQuestionDialog`,
    opened from the 「あなたへの質問」 count while a `hold:` question is open) — the door
    when the president's own conversation is the held one.
- The question says the rest of the project goes on only when the operation names its
  conversation; one that names none holds every launch here (`'all'`, below) and says so.
- A commander conversation that is held is not resumed: its next launch opens a
  FRESH conversation whose first message names the operation and says to look at the
  current state first (`heldOperationOpening`), and asks the owner (both the receipt
  and the native branch; the native branch not again once the review marker exists).
  Only the president's own held
  conversation waits for the answer (the owner's history lives there); once answered,
  a new president conversation opens with the note.
- An operation that stops holding without an answer (the transcript recorded its
  result after all, R-B1) has its question withdrawn and its card unparked.
- Only when the guard's question cannot be answered at all (owner sign-in gone,
  record unreadable), or an operation names no conversation, does the whole project
  hold (`engine.savedWorkHold`; the first told once it lasts, the second through its
  question).
- `OWNER_REVIEW_WHERE` names the question inbox by the bar's own label
  (「あなたへの質問」). At boot `savedSwarmRuntimeHold` is per conversation the same way
  and raises the questions; `adoptResumeCandidates` never `--resume`s a held or
  natively unfinished worker conversation (card → `blocked`, question).

**The engine no longer makes such operations itself.** Its quota stop used to cut a
worker off in the middle of a running command (JobSearch, 2026-11-23 16:29: a test run
started 3 minutes earlier), which left exactly this kind of receipt and stopped the
project. Every engine stop — the quota stop, the execution ceiling, the stall reclaim —
now waits while the worker's session reports a tool call in flight
(`awaitToolBoundary`, reading `sdkWorkerFacts(...).toolCallsInFlight`), up to
`TOOL_BOUNDARY_WAIT_MS` (30 min in code — longer than one full test run; 15 cut that
very command off, and this line said 15 until 2026-11-28); a parked worker costs nothing. A wait belongs to ONE
stop: a worker the engine no longer wants to stop drops its stamp at the end of that
pass (`monitorWorkers`' sweep), so a later stop waits from zero. A stop that still cuts
a command off (the bound elapsing) journals `worker stopped in the middle of N running
command(s) (<reason>)` and the saved-work notice it causes names that stop as the
reason.

**Nor do the app's own stops** (AUTONOMY-SPEC R-B2, 2026-11-28). Owner quit, "Restart
now", an update install and the engine switch all reach the server as SIGTERM from
`electron/autoUpdate.js` `terminateChild`. The server used to exit on the spot (the gate
and host reapers' own signal listeners called `process.exit`), cutting off whatever was
running. Now `server/index.ts` is the one owner of SIGTERM/SIGINT
(`liveDesks.exitAfterShutdownOnSignals`; the reapers hook `exit` only):
`sdkSession.beginShutdown()` flips a flag that every PreToolUse callback of an SDK launch
reads first — `subscriptionQuery` wraps them all (`refuseWhileStopping`), the receipt
audit's own included, so a NEW call is refused before anything is claimed ("OPEN GROUND
is restarting; this call did not run." — no receipt, nothing to confirm; a separate
refusing hook would not do, the CLI runs a call's hooks side by side). It resolves when
`sdkToolCallsInFlight()` is 0 or at `SHUTDOWN_TOOL_GRACE_MS` (20 s), and the process
exits; `exit` runs both reapers. Electron's SIGKILL comes at `CHILD_SIGTERM_GRACE_MS` =
25 s (was 5 s, inside the wait). A call that outlives the 20 s is still cut and its
receipt decides at the next start, as before. Nothing new starts during the wait (review
C-S2): `spawnSdkSession` throws `SHUTDOWN_LAUNCH_REFUSAL` ("OPEN GROUND is shutting down,
so no new conversation was started." — the owner's own opens too, shown in their
launch-failed line), and `runDispatchPass` returns at once on `sdkShutdownBegun()`, so no
card is claimed and no worker bills a first turn only to be killed at exit. A "Restart
now" teardown is tracked by the Electron quit gate (`createQuitGate.track`, review
C-S1): a ⌘Q during the wait is held. Not covered: an SDK launch with no PreToolUse hook
at all, and — **known limitation (review A S4, AUTONOMY-SPEC R-B2)** — PTY desks: they have
no receipts and no in-process hook, so a quit does not wait for a command running in the
president's PTY (it is cut off), and a PTY launch is not refused. A cut-off PTY call becomes
ONE held operation for the president's conversation alone (the native check), whose question
the owner answers in the bar's 「あなたへの質問」 (`HoldQuestionDialog`) without the president;
the seat then opens a new conversation. **Note (review A N5, not fixed):** a background Bash
(`run_in_background`) has its receipt delivered when it starts, and `beginShutdown` does not
wait for the background process — a quit kills it and nothing holds or asks. It predates
the autonomy work and is outside the spec. Guards:
`sdkSessionShutdown.test.ts`, `swarmOrchestrator.shutdown.test.ts`,
`swarmManager.spawn.test.ts` ("while the server is stopping"), `autoUpdate.test.ts`
("terminateChild — the hard kill cannot land inside the server's tool wait"; the quit
gate's Restart-now cases), each measured red against the pre-fix code.

**A usage refusal is not an abort** (2026-11-24, `sdkSession.ts` pump). A refused turn
used to end its own session whenever ANY command in the project was still running
(it asked `assertNoUncertainRuntimeActions(cwd)`, which counts running commands): two
of three workers died that way on one limit (11-23 22:21), and the commander died with
its own helper's command running — that command was killed with it and became the
unconfirmed operation that held the project for eight hours (11-24 04:38). The refused
turn now asks what the launch guard asks (`…(cwd, false)`): only a result that really
is unconfirmed (its actor gone) ends the session; otherwise it parks.

**Other silences this closed** (same notice lane, `automation-held`, each told ONCE):

| What kept failing in silence | Now | Constant |
|---|---|---|
| A worker whose every tool call the runtime action guard refuses (sat until the 90-minute ceiling) | `watchToolDenials`: journal + notice after N refusals in a row; quiet when the saved-work notice already says so; re-armed by a call that goes through | `TOOL_DENIAL_ALERT` = 3 |
| A card whose dispatch fails every 3 s (a first-time project with no commit: `worktree add … HEAD` failed ~5,000 times, no reason) | `createSwarmWorktree` says which it is (no commit yet / not a git folder) and keeps git's own first line otherwise; `tellRepeatedDispatchFailure` tells the president after N in a row, still retrying | `DISPATCH_FAILURE_TELL` = 5 |
| A frame project whose automatic start keeps failing (`reconcileAutomationOrchestrators` returned `failures` that the canvas save reduced to "pending" and the 15 s loop dropped) | `tellAutomationStartFailures`: journal + notice once per project and reason; the boot resume's own hold and the boot safeguard are not told twice | `AUTOMATION_START_TELL_MS` = 60 s |
| The commander could not be woken, journalled as "no usable model tier" whatever the cause, and "check the desk by hand" | `defaultWakeManager` keeps what the launch said (`lastCommanderFailure`), `noteCommanderDeathAtStart` keeps a desk's exit reason; `commanderFailureWords` turns it into the owner's words — an unconfirmed operation comes with the Settings path, a quota wall is called a usage limit — in the wake line, the retry line and the `manager-unrevivable` notice | — |

**Reading the journal.** `worker lost — … · exit: <reason>` now carries the SDK
session's own exit reason (before: nothing for SDK workers), and a failed commander
wake journals `司令官を起動できませんでした — <reason>` instead of blaming model tiers.

Guards: `swarmSavedWorkHold.test.ts`, `runtimeActionReceipts.test.ts` ("a usage refusal
while a command is still running…", "an unknown result holds only the conversation that
issued it"), `swarmEscalations.test.ts` ("a held operation is one question…"),
`swarmManagerContextCap.test.ts` ("a held commander conversation opens fresh…"),
`swarmOrchestrator.resumeEngines.test.ts` (R-B3 / R-B5 blocks), `swarmOrchestrator.test.ts`
("the failed wake and the give-up say WHY…") — each measured red against the pre-fix code.

**A result the transcript recorded is not unconfirmed** (2026-11-28, AUTONOMY-SPEC
R-B1). Measured on the owner's machine: seven of the eight open holds were tool calls
whose result Claude's own transcript had recorded — four vetoed by a settings hook
(`swarm-guard.sh`) inside a commander's sub-agent, one `Exit code 137`, two normal
results whose closing callback was lost. A receipt closed only from live callbacks
(`PostToolUse`, `PostToolUseFailure`, the two `observeSdkMessage` shapes), so each of
those held its project for days. Now `listUncertainRuntimeActions` — the one predicate
behind the launch guard, every PreToolUse, `savedWorkHolds` and the boot
`savedSwarmRuntimeHold` — and the review list (`runtimeRecoveryIssues`) first pass
every tool receipt that would hold (`uncertain`, or `executing` with its actor gone)
through `settleHeldToolReceipts`: `runtimeToolEvidence.findToolOutcome` reads
`<dir>/<sessionId>.jsonl` and `<dir>/<sessionId>/subagents/*.jsonl` (32 MB per file, a
file that changes during the read is skipped), and a `tool_result` beside the claimed
`tool_use` (same tool, same argument hash) that is not interrupted settles the receipt
as `delivered` `{confirmed, failed: is_error, source: 'native-transcript',
automaticReplay: false}` (`conversationReceipts.settleReceiptFromEvidence`, the only
writer besides the owner's review that moves `uncertain → delivered`). A call started
without a result, an interrupted result — including the stand-in a resumed session
writes, `[Tool call interrupted: the session ended …]` with `toolDenialKind:
'interrupted'`, and any denial kind not yet measured — a receipt its own callback
recorded as interrupted, or a file that cannot be read keep the hold: nothing is run
again, and owner-reviewed or rejected receipts are never rewritten.
**Only a denial proven to precede the run counts as "never ran"** (review A-M1,
2026-11-28; `runtimeToolEvidence.resultInterrupted`): `permission-rule` (every local
line is a PreToolUse veto or a pre-call check) and `automode-blocked`, or any kind with
`toolDenialBeforeRun: true`. `user-rejected` is NOT proof by itself: the CLI writes it
for a prompt refusal AND for a call an interrupt or a shutdown cut off while running
(a real worker's Bash, 163 s in, CLI 2.1.329, no flag); `interruptedByShutdown` (the
CLI's own loader relabels it `interrupted`) and `toolDenialAfterRun` are interrupted
too. Old CLIs that never wrote the flag hold — the safe side. The native resume check
(`swarmNativeTranscript.inspect`) reads results the same way: an interrupted result
keeps its call unfinished until a later assistant line a real model wrote, from a
DIFFERENT response (`message.id`) than the cut call's, shows the conversation already
went on past it. A synthetic / API-error / model-less line never counts, nor does a
later block of the same response (written while it was still streaming, before the
model saw the result) or a line with no `message.id`. A session whose
`PostToolUse` write failed (`recordingFaults`, which denied every later call) heals
the same way on its next call. New receipts carry `cwd` (the transcript folder) and
`inputValueHash`; older ones are found by session id across the projects folder.
The JSONL layout is not an official contract (ledger row "transcript JSONL"): a
format change makes the lookup miss and the hold stands, as before. Guards:
`runtimeToolEvidence.test.ts` (one fixture per measured shape), the R-B1 block in
`runtimeActionReceipts.test.ts` and `runtimeRecovery.test.ts` — red measured before
the fix and under each guard's mutation.

### 7.4f Standing and the stall watchdog — no stop without a reason (2026-11-28, AUTONOMY-SPEC U5)

**What it ends.** Every hold above (§7.4b2 boot map, §7.4e saved-work hold, the SDK spawn
backoff, the quota park, the offline hold, the manual stop) told the owner through its own
path, so a stop with a cause nobody had written a notice for was silent until the owner found
it. Card 1123-151658 alone listed 13 such conditions, each patched one at a time.

**One function says where a project stands.** `standingOf(facts)` (`swarmStanding.ts`, pure)
returns `state` (`running` | `needs-owner` | `waiting` | `idle` | `off`), `needs`
(`dispatch` = todo cards `selectDispatch` would start, `integrate` = swarm review cards not
parked for a human — high-risk holds and failed panels excluded), `progressedAt` and
`reasons[]` of `{kind, plain, until?, ownerAction?}`. The facts come off the engine
(`standingFactsOf` in `swarmOrchestrator.ts`); one adapter per hold field turns a field into a
reason, in the owner's language from `projectPanel.standing.*`:

| Field | Kind | State |
|---|---|---|
| open owner escalations | `owner-question` | needs-owner |
| `engine.savedWorkHold` (counted, or the guard's question unanswerable) | `owner-question` (U2 turns it into an inbox question) | needs-owner |
| `spawnBlockSig === 'none-allowed'` | `models-off` | needs-owner |
| boot-resume entry with a held `reason` (`ownerOnly` ⇒ owner action) | `boot-pending` | waiting / needs-owner |
| `manualStop` or the persisted record | `manual-stop` | off |
| frame policy enabled and not allowed | `outside-frame` | off |
| `parkUntil` in the future (all-cooling park and the quota defer) | `usage-limit` + `until` | waiting |
| `sdkSpawnHold.until` in the future | `spawn-backoff` + `until` | waiting |
| `managerResume.offlineHold` | `offline` | waiting |
| `engine.budgetHold` (the hold that lifts soonest; else the note), or `engine.commanderReserveHold` (the owner's weekly reserve holding the commander's wake, 04 §5.10.3) | `window-headroom` / `weekly-pace` / `weekly-reserve` + `until`; `usage-unknown` (note only) | waiting |
| `engine.automationBlocked` (inside the frame, automatic operation not allowed — the owner signed out, the role lost). Outside the frame the same flag is set (`automaticOperationAllowed` is false there too) and is NOT reported: that project is `outside-frame` / off (review R2-M1) | `owner-question` (the sign-in sentence + where to check) | needs-owner |
| the commander's SDK desk paused on a usage refusal (`sdkQuotaPause`; a per-model limit cools only its tier, so no park says it) — while a review card waits | `usage-limit` + `until` (the manager's sentence) | waiting |
| `engine.dispatchFailures` — a todo card whose streak already told the president | `spawn-backoff` (no `until`: it retries every pass) | waiting |
| `managerResume.fatalFired` / `unresponsiveFatalFired` ('manager-unrevivable' / 'manager-unresponsive' rang) — while a review card waits | `commander-down` + where to look | needs-owner |

A hold of the engine counts only while the engine runs; the dispatch holds (usage limit,
backoff, offline) only while work waits for them. Ranking: needs-owner > running (a live
counted worker, or the commander mid-turn) > off > waiting > running-within-the-window > idle.
A budget hold is never mirrored into `parkUntil`, so it is never told as `usage-limit` (review
2026-11-28 B-S1).

**The watchdog** (`watchStanding`, called once per pass in `runEnginePass` after
`detectAnomalies`): a board column signature that changes, a live worker or the commander
mid-turn is progress — and so is the commander waiting on its own background command (its full
test run, which og-manage tells it to wait for: `deps.commanderBackgroundTaskAt`, read from the
desk's transcript only when a review card is the only need and nothing else serves; counted only
within the run grace, `backgroundTaskAliveAt` / `BG_TASK_GRACE_MS` 90 min, so a start whose end
record never landed cannot silence the watchdog — review R2-M2; the cap-at-wake busy check in
`idleManagerDeskOverCap` uses the same grace). A budget hold whose `until` has passed (left by a pass
that returned early) is not reported. The last four rows
above and this rule were added after review 2026-11-28 B-S3: each of those states read as
`unexplained` after 15 quiet minutes, a false defect report and a second notice where the hold
already had its own. Any state other than `running` restarts the quiet clock (a named hold,
off, nothing needed). When a need stands `STANDING_STALL_MS` (15 min) with no progress and no
reason, `standingOf` adds `unexplained`; the engine writes ONE journal line
(`automation stalled — work needed (dispatch N, integrate N) with no progress since …; quiet
since …, N counted worker(s), anomalies […]`) and raises ONE `automation-stalled` fatal
notice per episode (bell + president; no OS toast). Progress, a reason, or the need going away
ends the episode. Existing notices stay — this only catches what none of them names. The
memory is in-memory (`engine.standingWatch`): the notice store keys by occurrence, so after a
restart the same stall is told again once its 15-minute window has passed.

**Where the owner sees it.** `GET /api/swarm/standing?path=` (owner-gated, read-only) — the
president retells `reasons[].plain` word for word (`skills/supply/SKILL.md` "Status" ⑤). The
Ground lamp rows carry `standing.{state,reasons}`; `groundLamp` draws `needs-owner` as the
hand and `waiting` as a muted lucide `Clock` (`text-ink-faint`, no band, no label, the reasons
as hover text — owner decision §7-4 = A). The agent-team bar polls the route every 10 s and
draws the same clock beside its switch.

Guards (each measured red, mutations restored to identical bytes): `swarmStanding.test.ts`
(every field alone ⇒ its kind; removing each adapter turns exactly that field's cases red —
measured for every adapter; the watchdog fires once, progress ends the episode, a named hold never
fires; wiring removed / latch removed / clock not restarted / progress never seen ⇒ red),
`server/routes/__tests__/swarmStanding.routes.test.ts` (fixtures × ja/en; route removed ⇒ 404),
`groundLamp.test.ts` / `groundLamps.test.ts` (precedence), `SwarmBottomBar.test.tsx`,
`ProjectCard.test.tsx`, `statusColors.test.ts` (the clock wears no state colour),
`supplyNotice.test.ts` (the skill reads ⑤ word for word).

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
  OS toast は出さない(2026-09-26 以降、Mac 通知は `OS_TOAST_EVENTS` の3種のみ — 06 章)。この「毎日必ず 1 件」が
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
