# 01 — エンジン中枢(tick / pass / dispatch / monitor)

**対象コミット: `cc7c60e`**(cc7c60e 自体が「二重 dispatch 封鎖(両方向)」のコミット)。本文中の `file:line` は全てこのコミットの行番号。無印の行番号は `src/lib/server/swarmOrchestrator.ts`(6349 行 — エンジンの全てがこの 1 ファイルにある)。
> **部分更新(2026-07-10)**: その後 `3129a58`/`0d1f7f0` が swarmOrchestrator.ts を 6730 行に変えた(:355 以降 +38〜+381 シフト — 00-INDEX 冒頭)。**特に `0d1f7f0` は本章の TL;DR#3 と §6(integrate による monitor 飢餓)を機構ごと過去にした** — 該当箇所に注記済み。現行の tick/integrate 構造の正典は 03 章 §2.1/§2.4。
**読者**: 司令塔(og-manage / manage セッション)。in-app swarm エンジン(自律 drain ループ)の心臓部 — tick の回り方・1 pass の中身・dispatch の選抜規則・monitor の全分岐 — をコード根拠付きで示す。
**関連**: `02-worker-lifecycle.md`(worker の生涯 / spawn の実体)、`03-integration-review.md`(統合と敵対レビューの詳細)、`04-quota-models.md`(quota 冷却とモデル mask)、`05-board-api-contract.md`(Board 列と API 契約)。

---

## 0. 司令塔が最初に知るべき 4 つの真実

1. **エンジンは丸ごと in-memory。** 全状態は `globalThis.__openground_swarm_orchestrator` 上の `Map<projectPath, ProjectEngine>`(:1520-1534)で、**プロセス再起動で全部消える**(worker roster・rework 予算・journal・KPI・全部)。ディスクに残るのは Settings の 2 フラグ(`swarmAutonomyOn` = 「前回 ON だった」リマインダー :5731、`swarmManualStop` = 「手で止めた」記録 :5774)とカード側の stamp(`branch` / `integrationConflict`)だけ。再起動後のエンジンは必ず `running:false` で、**再起動前に走っていた worker の PTY・worktree・branch・心拍ファイルは生きたまま「エンジン外」になる**(§2 の寿命列)。
2. **tick はキューではない。** 3 秒の setTimeout チェーン(:5679-5692)が 1 pass ずつ直列に回し、`passInFlight`(:1320)は「pass 実行中に来た別の起動要求を **bail させる**」再入ガード — 待ち行列ではない。遅い pass の間に予定されていた tick は**消える**(次にチェーンが arm されるのは今の pass の `.finally`)。
3. ~~**統合パスは pass の中で直列 await される**~~ — **`0d1f7f0`(2026-07-10)で歴史になった**。当時は `runEnginePass` が dispatch → integrate の順に await し(:5607-5608)、integrate の中の verify(tsc timeout 180s :2530-2535 / vitest run timeout 600s :2790-2795 をインライン await)と敵対レビュー(lens レビュアー 4 体 × timeout 5 分 :3240)が走っている間、**monitor は一切走らなかった** — quota 検知・stall 検知・promote が数分飢餓した(§7.1、実測 2026-07-09・カード `4d1550d7` → `0d1f7f0` で done)。**現在**: integrate は `kickIntegratePass` で tick の脇に fire-and-forget 化され(`integrateInFlight` 再入ガード)、monitor は verify/panel 中も 3 秒 tick で回る。Board/workers を書く区間だけ `runExclusive` で直列化。正典 = 03 章 §2.1/§2.4(0d1f7f0 基準の行番号つき)。
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
| HTTP routes(owner gate + validateProjectPath) | `server/routes/swarm.ts` — GET `/api/swarm/orchestrator`(:486)、POST `…/drain-tick`(:516)、`…/start`(:546)、`…/stop`(:570)、`…/worker/stop`(:591)、`…/automerge`(:614)、`…/review/resolve`(:636)、`…/selfsupply`(:661)、`…/overseer`(:688) |
| 状態の公開形 | `src/lib/types.ts` — `SwarmOrchestratorState`(:1280)。**`pendingDispatch` / `lock` / `generation` / 各種 Map は API に出ない**(`stateOf` :1836-1873 が返すのは running/manualStop(+Persisted)/autoMerge/selfSupply/overseer/workers(生存のみ)/reviews/log/anomalies/maxWorkers/kpis/consumption/autonomyRemembered/parkUntil のみ) |

エンジン stage の全景(1 tick = `runEnginePass` :5593):

```
scheduleNext(TICK_MS=3s) ──▶ runEnginePass
  ├─ passInFlight CAS(:5597-5598 — 二重 pass は bail)
  ├─ runExclusive( runDispatchPass )        (:5607)   ← control-plane と FIFO 直列化
  │    ├─ 1. board 全読み                    (:4397-4405)
  │    ├─ 2. monitorWorkers(監視・promote・回収) (:4410)
  │    ├─ 3. reconcile(todo→doing 再試行)     (:4418-4429)
  │    ├─ 3b. SPAWN PARK(quota/mask ゲート)   (:4450-4467)
  │    └─ 4. fill(scale → selectDispatch → 予約 → 再検証 → spawn) (:4473-4610)
  ├─ runIntegratePass(throttle 15s)          (:5608)   ← verify/レビュー/land(03 章)
  ├─ pruneStuckMoves + pruneReworks + detectAnomalies (:5615-5619)
  ├─ fireFatalNotifications(致命イベント→人へ) (:5629)
  ├─ runOverseerPass(await・guarded。brain 起動は fire-and-forget) (:5639-5644)
  ├─ kickSelfSupplyPass(fire-and-forget)      (:5658-5664)
  └─ finally passInFlight=false               (:5665-5667)
```

---

## 2. ProjectEngine — 全フィールドの意味と寿命

型定義 :1294-1518。**全フィールドが in-memory**(再起動で消える)。「永続の半身」列は、消えた後もディスク側に残る対応物。初期値は `getOrCreateEngine`(:1536-1573)、旧ビルドの engine への欠損 backfill は :1574-1607(dev の tsx watch 越え用)。

| フィールド(行) | 意味 | 消えたときの影響 / 永続の半身 |
|---|---|---|
| `path` :1296 | canonicalize 済み project path = engine のキー | — |
| `running` :1298 | 自律 drain チェーンが予約されている間 true | **再起動で必ず false**(自動再開なし)。半身: `Settings.swarmAutonomyOn`(リマインダー表示のみ :6107) |
| `manualStop` :1309 | owner が明示 OFF した(auto-drain 抑止) | 半身: `Settings.swarmManualStop`(:5774 で書き :5726 で消す。`maybeAutoStartDrain` :5858 と `stateOf` :1858 が読む — 0707 twin-dispatch の根本対策) |
| `autoMerge` :1312 | 統合ステージ(Card③)の arm。`running` 中のみ作用 | 再起動で OFF。半身なし |
| `passInFlight` :1320 | pass 実行中フラグ = **二重 pass 防止の bail であってキューではない** | — |
| `lock` :1329 | `runExclusive`(:1745)の FIFO promise chain 尾。dispatch pass と owner の stop/resolve を直列化 | — |
| `generation` :1335 | start epoch。stop→start で bump し、**古いチェーンの `.finally` が第 2 タイマーを arm するのを殺す**(:5684) | — |
| `timer` :1337 | 次 pass の setTimeout ハンドル(停止中 null) | — |
| `workers` :1339 | エンジンが dispatch し数えている roster(`OrchestratorWorker[]`) | **再起動で消える = 生きた PTY/worktree が「エンジン外 worker」になる**(GET `/api/swarm/workers` には出続ける — 02 章 §3.3) |
| `reviews` :1342 | review 列 swarm カードの統合 readiness 表示(統合 pass A 半で更新) | 表示のみ。次の統合 pass で再計算 |
| `conflictedBranches` :1346 | 実 rebase が conflict した branch の memo(再 rebase churn 防止) | カード側 stamp `integrationConflict` が永続の半身 |
| `verifyFailed` :1352 | verify RED の branch → 落ちた tip sha(同 tip 再検証スキップ) | 消えると同 tip を 1 回だけ再 tsc(無害) |
| `reviewFailed` :1359 | 敵対レビュー must-fix の branch → tip(同 tip 再パネル抑止) | 消えると同 tip にパネル 1 回再燃(claude 3 セッション) |
| `reviewDeferred` :1366 | 多数決つかず(defer)の連続回数 memo。`MAX_REVIEW_DEFERS`=3(:258)で needs-human 化 | 消えると defer 連敗カウントがリセット |
| `lastIntegrateAt` :1368 | 統合 throttle(`INTEGRATE_TICK_MS`=15s :197)の基準時刻 | — |
| `recoveries` :1373 | カード(taskId)ごとの lost-worker 再 queue 回数。`RECOVER_MAX_REQUEUE`=1(:217) | 消えると crash リトライ予算がリセット(ループの天井が一時的に甘くなる) |
| `reworks` :1383 | 差し戻し(review→doing)回数。`MAX_REWORKS`=2(:238)。'todo' では**prune しない**(:5451-5456 — 再 dispatch を跨いで予算が生きる) | 同上(差し戻し予算リセット) |
| `reworkReasons` :1395 | **学習ループ**: 最後に差し戻された理由。`reworkOrPark` が書き(:4713)、再 dispatch が /order へ注入して消費(:4535, :4567)、owner の escalation 回答も同じスロットに乗る(:1690-1712、`mergeReworkReason` :1662 が回答セグメントを保護) | 消えると再投入 worker が前回の失敗理由を知らずに走る |
| `conflictReworks` :1406 | 統合 conflict の rebase 委譲回数。`MAX_CONFLICT_REWORKS`=3(:248)— `reworks` とは**別予算**(conflict は worker のコード品質でなく trunk が動いた結果) | 予算リセット |
| `stuckMoves` :1413 | Board 列 move が kept され続けるカードの追跡。`MOVE_STUCK_MAX_RETRIES`=5(:226)で anomaly 化 | — |
| `nudges` :1423 | terminalId ごとの stall nudge 予算(count / lastNudgeAt / escalated) | — |
| `rateLimited` :1430 | terminalId ごとの rate-limit hold 開始時刻(`since`) | **消えると hold 時計がリセット** — 再起動直後は grace を数え直す |
| `permissionWaits` :1437 | 権限/trust プロンプト待ちの開始時刻 + auto-accept 済みフラグ | 同上 |
| `questionRaised` :1445 / `questionWaits` :1453 | 自由文質問の escalation 受付キー / hold 時計(`QUESTION_GRACE_MS` :372) | 同上 |
| `log` :1455 | journal ring buffer(`MAX_LOG_LINES`=200 :201、`logLine` :1762) | **再起動で全消え** — 過去の dispatch/integrate 履歴は git log とカードにしか残らない |
| `anomalies` :1458 | 直近 pass の検出結果(毎 pass 再構築 :5619) | — |
| `selfSupply` :1463 | 自己補給 runtime(armed + throttle + 日次 cap)。既定 OFF | 再起動で OFF(fail-safe) |
| `overseer` :1471 | 監督ノード runtime。既定 OFF・**明示 stop で disarm される非対称**(:5789-5792) | 再起動で OFF(K2)。auto-drain 再点火では決して arm されない(:6319-6322) |
| `notified` :1477 | 状態由来 FATAL の rising-edge dedup(解消で忘れて再発なら再通知 :5570-5578) | 消えると持続中の fatal が 1 回再通知(無害) |
| `pendingFatal` :1482 | monitor が enqueue した one-shot FATAL(例: exec-timeout :4017)。pass 末尾で drain(:5531-5534) | 消えると未送の通知が失われる |
| `metrics` :1487 | KPI 生涯カウンタ(`logLine` の choke point で bump :1779-1783) | 再起動でゼロ(per-session roll-up) |
| `lastScaleSig` :1493 | scale 決定 journal の変化時のみ記録用署名(:4497-4506) | — |
| `parkUntil` :1500 | 全 tier 冷却中の最早 reset(dashboard 表示用ミラー — 真実は swarmQuota 側) | — |
| `spawnBlockSig` :1506 | SPAWN PARK の enter-edge 署名(`'none-allowed'` \| `'cooling:<ms>'`)。journal を 3 秒毎に汚さないためのエッジ検出 | — |
| `pendingDispatch` :1517 | **今まさに spawn 中のカード id 予約**(cc7c60e)。spawn 前に全 picks を登録(:4520-4522)、finally で自分が積んだ分だけ解放(:4602-4610)。手動 route が `isCardDispatchInFlight`(:1626)で照会 | — |

---

## 3. tick の連鎖構造(状態機械)

### 3.1 チェーンの回り方

- `scheduleNext`(:5679-5692): `setTimeout(TICK_MS=3000)`(:190)→ `runEnginePass` → **`.finally` で次を arm**。setInterval ではないので pass が自分と重なることは構造的にない。arm 条件は `engine.running && gen === engine.generation`(:5684)— stop→start を挟んだ古いチェーンは次の arm 時点で死ぬ(重複チェーン zombie の防止)。
- `runEnginePass`(:5593-5668)の実行順は §1 の図のとおり。重要な形:
  - **`passInFlight` は入口で同期 check-and-set**(:5597-5598)。走っている pass がいたら**bail(待たない)**。`finally` で必ず解放(:5665-5667)。
  - **dispatch pass だけ `runExclusive` に包む**(:5607)。`runExclusive`(:1745-1760)は per-engine の FIFO promise chain で、owner の `stopOrchestratorWorker`(:5951)/ `resolveOrchestratorReview`(:6025)/ escalation 回答の書き込み(:1703)と dispatch pass を直列化する。塞ぐバグ: monitor の await 窓(countCommitsAhead / readHeartbeat)中に stop が割り込むと、stop が park したカードを古いスナップショットの monitor が todo/review へ書き戻す(:1720-1731)。
  - **integrate pass は意図的に `runExclusive` の外**(:5606, :1739-1744)— 数分級のレビュー待ちで owner の stop クリックをブロックしないため。代償として resolve-vs-integrate の狭い窓が残る(integrate 側の再チェック :5074 が部分緩和)。**`0d1f7f0` 後**: integrate は pass からも分離され(tick は kick するだけ)、Board/workers を**書く**区間(reworkOrPark / delegateConflict / land)だけが `runExclusive` に入る形に進化 — 「遅い await は lock 外」の原則は不変(03 章 §2.4)。
  - anomaly 検出(:5615-5619)・FATAL 通知(:5629)・overseer(:5639-5644 — pass 自体は await するが内部 catch 付き。brain 起動は fire-and-forget)・self-supply kick(:5658-5664 — **await しない**。かつて await していて 8 分級の scan が monitor を凍らせた前科がコメントに残る :5652-5657)は全て guarded で、失敗しても tick を壊さない。

### 3.2 start / stop(公開制御面)

- `startOrchestrator`(:5709-5753): claude preflight(:5715、不可なら `ClaudeNotReadyError` → route が 503)→ `manualStop=false` + 永続記録の消去(:5723-5726)→ `swarmAutonomyOn` を記録(:5731 — **リマインダー用で auto-resume はしない**)→ `lastIntegrateAt=0`(:5737 — 再開直後に統合 readiness を即更新)→ `generation` bump(:5740)→ **即 1 pass kick してからチェーン arm**(:5745-5747)。
- `stopOrchestrator`(:5759-5804): `swarmAutonomyOn` 消去(:5768)→ `swarmManualStop` 永続記録(:5774 — **engine 不在でも書く**。再起動を跨いで「手で止めた」が外から読める)→ `manualStop=true`(:5781)→ **overseer を disarm + brain abort**(:5789-5792 — 非対称 D1)→ timer clear(:5793-5799)。**走行中の worker は止めない**(手動制御面の仕事)。
- 個別 worker の停止は `stopOrchestratorWorker`(:5936-5991)— runExclusive 内で teardown(:5959)→ カードが doing のままなら **'blocked' へ park**(:5964-5976 — 'todo' でなく blocked なのは「エンジンが次 tick で拾い直す」のを防ぐため)→ 予算 3 種を消す(:5978-5980)。
- review 詰まりの人力解決は `resolveOrchestratorReview`(:6008-6094)— review 列のカードのみ対象(:6034)、move 先着(:6041-6050)→ worker teardown(branch は残す :6057-6065)→ 全 memo 掃除(:6070-6085)。

### 3.3 「勝手に点く」系統は 3 つ、生きているのは実質 1 つ

1. **`drainTickOrchestrator`**(POST `/api/swarm/orchestrator/drain-tick` :6137-6155): **card eadb25e6 で auto-start 廃止済み** — 今は純 read(getOrCreateEngine + stateOf)。Swarm ペインを開いても点火しない。
2. **`maybeAutoStartDrain`**(:5846-5926): 「idle slot + 独立 todo あり」で停止中 engine を点火する唯一のロジック。ガードは 4 重 — running/passInFlight/manualStop(:5853)+ **永続 manualStop**(:5858)+ preflight(:5889)+ commit 直前の再チェック(:5893)。点火時は inline で 1 dispatch pass を回してからチェーン arm(:5914-5924)。
3. **`startAutoDrainLoop`**(:6231-6244): 全登録プロジェクトを `AUTO_DRAIN_SCAN_MS`=15s(:397)で総なめして 2. を呼ぶ boot ループ。**`OPENGROUND_SWARM_AUTODRAIN=1` の厳密 opt-in**(:6219-6221 — unset/'0'/'true' 全て OFF)。server/index.ts だけが呼ぶ。

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

- 書き手: `reworkOrPark`(:4713)と `delegateConflict`(:4852)が**差し戻しのたび**最新理由で上書き(owner の escalation 回答セグメントだけは `mergeReworkReason` :1662-1671 が保護。区切りは制御バイト `\x1f` :1649)。
- 読み手: dispatch が spawn 前に読み(:4535)、**spawn 成功後にのみ delete**(:4567 — spawn が throw したら次 pass に残る)。`priorFailure` として `spawnWorker` → `buildOrderInjection` に渡り、fresh worker の /order に「前回の差し戻し理由」が焼き込まれる(02 章 §2.4)。dispatch log に注入の有無が出る(:4587-4592)。
- 掃除: `pruneReworks`(:5460-5485)が done/消滅で削除。**todo では消さない**(再 dispatch 待ちの注入材料)。owner 回答の合流点は `recordEscalationAnswerForNextDispatch`(:1690-1712 — runExclusive 内で書く。理由は「dispatch の read→spawn→delete と交錯すると読まれず消される」:1682-1686)。

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
| 4a | **reworkAt 抑制**: 差し戻し直後は心拍ファイルが古い `readyToMerge:true` のままなので、差し戻しより**新しい**心拍が出るまで promote を落とす(re-promote race 対策)。落とした後も **fall through して stall/runaway 監視は受ける** | | :3922-3940 |
| 4b | promote 成立(`commitsAhead>0 ∧ (ready ∨ (dead ∧ ¬blocked))` :926-929) | doing→review move(:3945)。kept なら `recordKeptMove` + 次 pass 再試行(:3957-3965) | :3942-3967 |
| 5 | 死亡 & 非 promote | `recoverLost`(crash)— teardown + 列回収 | :3977-3980 |
| 6 | **runaway**: 生死問わず `now - startedAt >= MAX_EXEC_MS`(:334 既定 90 分・env 可) | 全 bookkeeping 掃除 → `pendingFatal` enqueue(:4017-4025)→ `recoverLost`('runaway') | :4000-4028 |
| 7 | stall 判定を先に計算(:4042-4056)。**silentMs >= STALL_SILENCE_MS(10 分 :271)の worker だけ**画面を読む(:4064-4067)— 出力が流れている worker は画面に何が書いてあっても絶対に触らない(false-kill guard :3984-3991) | | |
| 7a | 画面 = rate-limited(`classifyOutput` :1256 → `RATE_LIMIT_PATTERNS` :1123) | **hold**(nudge しない・reclaim しない)。初回 sighting で quota 層へ `markRateLimited`(:4093-4103 — worker の起動 tier に帰属)。`RATE_LIMIT_GRACE_MS`(:347 既定 20 分、`MAX_EXEC_MS-60s` 未満に clamp)を超えて**まだ**限定中なら `recoverLost`('rate-limit') → **'todo' 再 queue**(コミット済み作業は branch に残る) | :4080-4116 |
| 7b | 画面 = permission-wait(:1165)∧ commitsAhead===0 | 初回に Enter で auto-accept(:4130-4141)。`PERMISSION_WAIT_GRACE_MS`(2 分 :363)超で `recoverLost`('permission') → **'blocked'**(bypass が壊れている = 人が要る) | :4118-4149 |
| 7c | 画面 = question(自由文質問) | escalations inbox へ 1 回 raise(:4180-4211、overseer 有効時は S4 に委譲 :4179)。`QUESTION_GRACE_MS`(:372 既定 30 分)超で `recoverLost`('question') → **'blocked'** | :4151-4228 |
| 8 | 通常 stall 経路(silent かつ画面 normal) | `classifyStall`(:1047)の action に従う: `nudge`(Enter、`STALL_MAX_NUDGES`=2 :281)→ `escalate`(ESC + continue 指示を 1 回だけ :4249-4269)→ `reclaim` = `recoverLost`('stall')。nudge 後 `STALL_ECHO_GUARD_MS`(30s :291)内の出力は **Enter エコーとして無視**(:1065-1071)。実回復(新しい心拍 or guard 越えの持続出力)で予算リセット(:4286-4292) | :4237-4293 |

**`recoverLost` の回収先**(:3764-3867 + `recoveryColumn` :966-978):

| reason | 回収先 | 根拠行 |
|---|---|---|
| rate-limit | **todo**(一時的な待ちであって失敗ではない。retry 予算も消費しない :3851-3854) | :972 |
| runaway / permission / question | **blocked**(再走しても同じ壁) | :973 |
| crash/stall で heartbeat ready(done 宣言なのに統合物なし) | blocked | :974 |
| crash/stall で heartbeat blocked(自己申告 blocker) | blocked | :975 |
| crash/stall で再 queue 予算(`RECOVER_MAX_REQUEUE`=1 :217)超過 | blocked | :976 |
| それ以外の素の crash/stall | todo(1 回だけ自動再挑戦) | :977 |

回収の move が kept のときは dead worker を **roster に残して**次 pass で move を再試行(:3833-3844 — スロットは食わない)。move が `MOVE_STUCK_MAX_RETRIES`(5 :226)回 kept され続けたら 'blocked' へエスカレート(:3822-3831)。

pass 末尾で: review/done/消滅カードの `recoveries` を忘れ(:4303-4307)、**live roster にいない terminalId の bookkeeping を全 Map から一括 prune**(:4318-4337 — Map は live worker 数で有界)。

deps の実体(defaultDeps :3659-3706): `countCommitsAhead` は project ごとに解決した trunk(origin/HEAD 対応 :2189-2192)への `rev-list --count`(:2201-2211)、`readHeartbeat` は `~/.openground/swarm/<repoキー>/<branch名変換>.json` を読む(:2243-2280 — repo キー導出 :2220-2238)、`recoverCard` は **loopback HTTP で自プロジェクトの Board API を叩く**(:2335-2347)、`recoverWorker` = killTerminal + `removeSwarmWorktree(force)`(:2354-2370)。

---

## 6. integrate pass の骨格と「monitor 飢餓」の機構(**`0d1f7f0` で飢餓は解消 — 本節は歴史**)

> **注記(2026-07-10)**: 本節が説明する「integrate が pass を握り monitor が飢餓する」機構は
> `0d1f7f0` で根治された — integrate は `kickIntegratePass` により tick の脇で fire-and-forget に走り
> (`integrateInFlight` で 1 本制限)、monitor は verify/panel 中も回る。骨格(A/B 相・verify → panel →
> lock → land の直列)自体は現存。現行の正典は 03 章 §2.1/§2.4、根治の全容は TARGET-STATE §1。
> 以下は当時の機構の記録(実測の照合点)。

詳細な統合セマンティクス(FF/rebase/conflict 委譲・敵対レビュー)は 03 章。ここでは**エンジンの時間軸**に効く形だけ:

- throttle: `INTEGRATE_TICK_MS`=15s(:197、:4637-4639)。tick は 3 秒でも統合は 15 秒に 1 回。
- A 半(常時): review 列 swarm カードの readiness を read-only 分類して `engine.reviews` に公開(:4672-4681)。
- B 半(`autoMerge` armed のみ :4964): カードごとに **verify → 敵対レビュー → lock → integrate** を直列 await:
  - `verify`(:4995-5009)= `makeVerify`(:2835-2923): 使い捨て worktree を作り trunk に rebase(:2891-2900)、**`tsc --noEmit`(timeout 180s :2530-2535)→ lint → swarm-safety(diff 該当時)→ `vitest run`(timeout 600s :2790-2795)を順にインライン await**(:2914-2917)。RED は同 tip memo(`verifyFailed`)で次 pass 以降スキップ(:4995, :5011)。
  - 敵対レビュー(:5035-5127)= lens レビュアー 4 体(`DEFAULT_REVIEW_LENSES` :3021-3042、配線 :3687。`REVIEW_PANEL_SIZE`=3 :3015 は lenses 無しの homogeneous パネル用で現行配線では未使用)の claude PTY、**timeout 5 分**(REVIEW_TIMEOUT_MS :3240)。同 tip must-fix memo(`reviewFailed`)/ defer 連敗 memo(`reviewDeferred`)でパネル再燃を抑止。
  - cross-process lock は **card ごと・`deps.integrate()` 直前だけ**確保(:5129-5151 — pass 全体で持つと verify/panel の数分 hold で lock が stale 視され盗まれる、0706 の轍)。

**飢餓の機構**: これら全部が `runEnginePass` の 1 pass の中で直列 await される(:5608)。この間 `passInFlight` は立ったまま(:5598)なので、**3 秒チェーンが次に発火しても bail するだけ**(:5597)で、monitor(= dispatch pass 内 :4410)は走れない。つまり verify が数分回っている間:

- rate-limit 検知(§5 7a)が遅れる → quota 冷却の `markRateLimited` も遅れる → **dispatch が枯れた tier に打ち続ける時間が延びる**
- stall / runaway / crash の検知・promote も同じだけ遅れる

コード自身がこれを認めている: 「verify above can run for minutes」(:5044-5046)、「the pass also runs verify/tsc and a multi-minute adversarial-review panel per card」(:5134-5138)、self-supply が同じ理由で fire-and-forget 化された前科(:5652-5657)。verify/レビュー後の再チェック(:4695, :5074)は「owner stop が await 中に着地した」ケースの**カード変異だけ**を守り、monitor の遅延自体は救わない。

---

## 7. 落とし穴(司令塔が実際に踏んだ事象を含む)

### 7.1 quota 検知の遅延 — verify/レビューの monitor 飢餓(実測 2026-07-09・**`0d1f7f0` で根治済み — 歴史**)

2026-07-09、worker の画面には rate-limit 文言が **15:24 には出ていた**(= monitor が走れば 7a で検知可能)のに、実際に検知・冷却が発火したのは **15:29** — 統合パスの verify(tsc/vitest インライン await)が pass を握っていた約 5 分、monitor が一度も回らなかった。Board カード **`4d1550d7`**(「[保留] [swarm] quota 検知が21分遅れる — 沈黙10分ゲート/装飾再描画/統合パスの飢餓」、blocked 列)に全体像がある: 遅延は 3 要因の合成で、(a) **沈黙 10 分ゲート**(§5 7a は `silentMs >= STALL_SILENCE_MS` :4064 を通らないと画面を読まない — rate-limit 表示直後の 10 分間は構造的に見えない)、(b) TUI の装飾再描画が lastOutputAt を更新して沈黙時計を巻き戻す、(c) 本節の統合パス飢餓。司令塔への含意: **「エンジンが rate-limit を検知した時刻」は「worker が limit に当たった時刻」より最大で 10 分 + verify/レビュー数分ぶん遅い**。worker の実際の状態は PTY 画面と心拍ファイルの `updatedAt` が一次情報。

### 7.2 per-model limit 文言はパターン追加済み(同日の別事故)

同じ 2026-07-09、CLI の per-model 枯渇文言 "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model." は当時の `RATE_LIMIT_PATTERNS` のどれにも一致せず、**検知ゼロ → fable が冷却されず dispatch が枯れ tier に再突入し続けた**(stall + 空レビューパネル)。現 tip では文言 3 フラグメントぶんのパターンが追加済み(:1132-1154 — TUI の折り返しで 1 フラグメントしか画面に残らないケースも拾う)。regression fixture がテストに固定されている。詳細は 04 章。

### 7.3 再起動 = エンジン全消え、だが worker は生きている

§0.1 / §2 の帰結。再起動後に `GET /api/swarm/orchestrator` が空(running:false, workers:[])でも、**前セッションの worker PTY・worktree・branch・心拍は生きている**。それらは `GET /api/swarm/workers`(server-truth: PTY ∪ roster ∪ 心拍ファイルの統合 :501)には出る。「orchestrator が空 = worker がいない」と誤読して worktree を掃除すると生きた作業を殺す(02 章 §6 の削除経路表を先に読むこと)。

### 7.4 「手で止めた」は永続、他は揮発

`stopOrchestrator` は `Settings.swarmManualStop` を**engine 不在でも**書く(:5769-5774)ので、再起動後も `manualStop:true / manualStopPersisted:true` が GET に出る(:1858, :6111-6114)。一方 `autoMerge` / `selfSupply` / `overseer` は揮発で再起動後 OFF。**「前回 autoMerge ON だったから今も ON のはず」は成立しない**。overseer はさらに非対称で、明示 stop が disarm し(:5789-5792)、running 中しか arm できない(:6319-6322)。

### 7.5 passInFlight / pendingDispatch は外から見えない

`stateOf`(:1836-1873)は `passInFlight` / `pendingDispatch` / `lock` / `generation` / rework 予算 Map を**返さない**。「dispatch が二重に走っていないか」を API で確認する手段はなく、機械封鎖(§4.4 + `isCardDispatchInFlight`)を信頼するのが正。手動 dispatch(POST `/api/swarm/worker`)がエンジン予約と衝突すると 409 が返る(02 章 §2.1 の twin-dispatch ガード)。

### 7.6 log は 200 行 ring buffer

`MAX_LOG_LINES`=200(:201, :1772-1774)。長い統合連鎖や 3 秒 tick のルーチン行で過去の dispatch 履歴はすぐ押し出される。**「journal に無い = 起きていない」ではない**。KPI カウンタ(:1487)は ring より長生きだが、それも再起動でゼロ。

---

## 8. 既知の穴(読んで見つけた点 — 修正はしない・列挙のみ)

1. **`reworkOrPark` は `autoMerge` disarm を見ない非対称**(:4695 vs :4840)。`delegateConflict` は `!engine.running || !engine.autoMerge` で bail するが、`reworkOrPark` は `!engine.running` のみ。verify(数分)の await 中に owner が autoMerge を OFF にしても、その pass の verify-RED 差し戻し(:5020)は 1 件走り得る(次のカードのループ先頭 :4971 までは disarm が見えない)。影響は「OFF 直後に 1 差し戻し」の狭い窓。
2. **question hold 中の worker が `worker-stale` anomaly に併発し得る**。`detectAnomalies` は `rateLimited` / `permissionWaits` に載っている worker を stale 判定から除外する(:5326)が、**`questionWaits` は除外していない**。質問 hold(`QUESTION_GRACE_MS` 既定 30 分 :372)と `STALE_HEARTBEAT_MS`(30 分 :5262)がほぼ同尺なので、境界で「管理下の WAIT」が「hung かも」として anomaly に出る — card 4880e9c6 の「WAIT vs HANG を正直に」の意図からの漏れ(表示ノイズのみ・動作影響なし)。
3. **`fireFatalNotifications` の `_now` 引数は未使用**(:5518)。シグネチャだけの残骸で実害なし。
4. **monitor 飢餓は構造的・未解決**(§7.1)。カード `4d1550d7` が blocked 列に保留中で、cc7c60e 時点のコードでは verify/レビューは依然 pass 内直列 await。司令塔は修正済みと思い込まないこと。

---

## 9. 検証コマンド集(司令塔が自分で裏取りするためのワンライナー)

対象コミットの確認(この文書の行番号が有効か):

```bash
git -C ~/projects/OPEN\ GROUND log --oneline -1 cc7c60e
git -C ~/projects/OPEN\ GROUND diff --stat cc7c60e..origin/main -- src/lib/server/swarmOrchestrator.ts src/lib/server/swarmLaunch.ts
# ↑ 空なら本書の行番号は origin/main tip でもそのまま有効
```

エンジン状態(owner ログイン済みのアプリが :47776 で稼働中の前提。path は登録済み project の実パス):

```bash
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$HOME/projects/OPEN%20GROUND" | jq '{running, manualStop, manualStopPersisted, autoMerge, selfSupply, overseer, parkUntil, workers: (.workers|length), anomalies}'
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
