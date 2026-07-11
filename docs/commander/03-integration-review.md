# 03 — 統合パス(auto-integrate)と敵対レビュー: 実挙動と「なぜ凍結したか」

**対象コミット: origin/main `0d1f7f0`** (2026-07-10)。初版は `cc7c60e` 基準で、`3129a58`(敵対レビューの diff 連動 budget + 棄権理由の可視化 — 大 diff 凍結の根治)と `0d1f7f0`(quota 検知 21 分遅延の根治 — 本章に効くのは **integrate の tick 分離 = monitor 飢餓の解消**、§2.1/§2.4)を本改訂で反映済み。
行番号はすべて `0d1f7f0` 時点のもの。主戦場は `src/lib/server/swarmOrchestrator.ts`(6730行)と `src/lib/server/swarmIntegrate.ts`。

**読者**: 将来の司令塔(og-manage)セッション。このドキュメントは「review 列のカードがなぜ done にならないのか」を誤診しないために書かれている。**すべての主張に file:line の根拠がある。疑ったら §6 の検証コマンドで自分で裏取りすること。**

---

## 0. TL;DR — 司令塔が最初に知るべき5点

1. **統合パスは2相**。A相(read-only 分類 → `engine.reviews[]` = UI の「統合可」表示)は engine 稼働中つねに走る。B相(実際の land)は **autoMerge が armed のときだけ**走る(`swarmOrchestrator.ts:4905-4925`)。autoMerge は in-memory・既定 OFF(`server/routes/swarm.ts:605-613`)。
2. land の前に**2つのゲート**がある: verify(`.verify-*` worktree で tsc→lint→swarm-safety→test をインライン await、`swarmOrchestrator.ts:2906-2994`)と敵対レビュー(4 lens の claude パネル、`swarmOrchestrator.ts:3598-3804`)。
3. **敵対レビューは「全員一致」でしか統合を許可しない**。lens パネルは棄権(vote:null)が1つでもあると decision を出さず defer する(`tallyLensReview`、`swarmOrchestrator.ts:3241`)。同一 tip で 3 回 defer すると needs-human 凍結(`MAX_REVIEW_DEFERS=3`、`swarmOrchestrator.ts:258`)。
4. **大 diff での構造的凍結は `3129a58`(2026-07-10)で根治済み**: レビュアーの budget は diff 実測バイトでスケールする(floor 既定 5 分・+10s/KB・cap 20 分、`computeReviewTimeoutMs`、`swarmOrchestrator.ts:3383-3389`)。根治前は固定 5 分 budget のせいで 22〜34KB を境界に必ず 2 lens が棄権→凍結していた(当時の実測は §3 に保持)。棄権には理由(`abstainCause`)が付き、凍結ログと `reviews[].abstainSummary` に内訳が残る(§2.6)。**カード `58335c7f` は修正済み(done 列)** — 実運用での検証待ち(TARGET-STATE §2)。
5. 凍結・conflict・verify RED はどれも UI 上 **`reviews[].status='conflict'` に上書き表示される**。「conflict」と見えても本物の rebase 競合とは限らない(§2.2 と §4)。凍結の場合だけは `reviews[].abstainSummary`(`src/lib/types.ts:1147-1153`)に棄権内訳が併記される。

---

## 1. 構造 — 何がどこにあるか

| もの | 場所 |
|---|---|
| 統合パス本体 `runIntegratePass` | `src/lib/server/swarmOrchestrator.ts:4926-5596` |
| 統合パスの2相コメント(A/B) | `src/lib/server/swarmOrchestrator.ts:4905-4925` |
| tick 構造 `runEnginePass`(dispatch は await・integrate は **kick して待たない**、`0d1f7f0`) | `src/lib/server/swarmOrchestrator.ts:5968-6049`(dispatch :5981、kick :5989) |
| integrate の起動口 `kickIntegratePass`(fire-and-forget + `integrateInFlight` 再入ガード) | `src/lib/server/swarmOrchestrator.ts:5619-5630`(ガード :5623-5628、flag :1370) |
| 周期定数 `TICK_MS=3000` / `INTEGRATE_TICK_MS=15_000` | `src/lib/server/swarmOrchestrator.ts:190,197` |
| 統合 dep の契約 `IntegrationDeps` | `src/lib/server/swarmOrchestrator.ts:2072-2174` |
| 実 dep 配線 `defaultDeps`(verify :3895 / review :3900 / integrate :3901) | `src/lib/server/swarmOrchestrator.ts:3872-3912` |
| verify ゲート `makeVerify` + 各チェック | `src/lib/server/swarmOrchestrator.ts:2906-2994`(tsc :2584 / lint :2783 / test :2843 / swarm-safety :2689) |
| 敵対レビュー `makeAdversarialReview` | `src/lib/server/swarmOrchestrator.ts:3598-3804` |
| レビュー budget(diff 連動)`computeReviewTimeoutMs` | `src/lib/server/swarmOrchestrator.ts:3383-3389`(定数 :3356,3373-3374) |
| 棄権理由の帰属 `classifyAbstainCause` / 型 `AbstainCause` | `src/lib/server/swarmOrchestrator.ts:3401-3406 / :3055` |
| 棄権集計 `describeAbstentions` / `describeAbstainTallies` | `src/lib/server/swarmOrchestrator.ts:3150-3154 / :3161-3164` |
| レビュアー1体の実装 `defaultRunReviewer` | `src/lib/server/swarmOrchestrator.ts:3462-3529` |
| レビュー用 worktree `withRebasedWorktree`(`.review-*`) | `src/lib/server/swarmOrchestrator.ts:3420-3453` |
| 集計 `tallyReview` / `tallyLensReview` | `src/lib/server/swarmOrchestrator.ts:3166-3191 / 3208-3257` |
| 既定 lens 4本 `DEFAULT_REVIEW_LENSES` | `src/lib/server/swarmOrchestrator.ts:3114-3135` |
| 差し戻し `reworkOrPark`(runIntegratePass 内ローカル) | `src/lib/server/swarmOrchestrator.ts:4999-5131` |
| conflict 委譲 `delegateConflict`(同ローカル) | `src/lib/server/swarmOrchestrator.ts:5145-5271` |
| 掃除 `defaultCleanup` | `src/lib/server/swarmOrchestrator.ts:3841-3866` |
| git 操作の実体(classify / integrate / conflict 指示文) | `src/lib/server/swarmIntegrate.ts:188-215 / 251-350 / 373-391` |
| reviewer-arm quota sensor `endsInRateLimit` | `src/lib/server/swarmOrchestrator.ts:1241-1259` |
| spawn park 判定 `spawnBlock` | `src/lib/server/swarmAllowedModels.ts:132-148` |
| tier 降格 `resolveAvailableTier` | `src/lib/server/swarmLaunch.ts:205-220` |
| HTTP API(状態 GET / automerge / review/resolve) | `server/routes/swarm.ts:486 / :614 / :636` |
| engine in-memory 状態(reviews / 各 memo) | `src/lib/server/swarmOrchestrator.ts:1392-1460` |

engine は `globalThis` 上のプロジェクト別シングルトンで、**全 memo は in-memory**(サーバー再起動で消える。カード側の `integrationConflict` stamp だけが永続、`swarmOrchestrator.ts:1393-1396`)。

`3129a58` 以降の型の追加: `AbstainCause = 'timeout' | 'limit' | 'spawn-failed' | 'no-marker' | 'aborted' | 'error'`(:3055)、`ReviewerVerdict.abstainCause`(:3069-3072)、`OrchestratorReview.abstainSummary`(`src/lib/types.ts:1147-1153`)。

---

## 2. 状態機械 / データフロー

### 2.1 いつ走るか

- engine の tick は 3 秒ごと(`TICK_MS`、`swarmOrchestrator.ts:190`)。tick は dispatch パスを await した後、**integrate を `kickIntegratePass` で fire-and-forget に発火して待たない**(`swarmOrchestrator.ts:5981-5989` — `0d1f7f0` で tick の直列 await から分離。それ以前は per-card の verify+panel が `passInFlight` を握り、monitor が数分〜20 分飢餓した)。同時実行は `integrateInFlight` で 1 本に制限(:5619-5630、flag :1370)。統合は内部で 15 秒スロットル(`INTEGRATE_TICK_MS`、`swarmOrchestrator.ts:197,4934-4936`)。
- `lastIntegrateAt` は start 時 0 で始まり、**autoMerge を arm した瞬間にも 0 にリセット**されるので、arm 直後の次 tick で即統合パスが走る(`setAutoMerge`、`swarmOrchestrator.ts:6651`)。
- 対象は **review 列のカードのうち `swarm/*` ブランチを持つものだけ**(`defaultFetchReview` が `isReviewCard`(=`boardColumn==='review'`、`swarmOrchestrator.ts:446`)で絞り :2509-2517、さらに `isSwarmBranch` フィルタ :4947-4951)。手で作った非 swarm ブランチのカードは統合パスの対象外。
- パス冒頭で trunk を解決+1回 fetch(`prepareTarget` → `resolveTarget`+`fetchTarget`、`swarmOrchestrator.ts:4938,2522-2527`、`swarmIntegrate.ts:145-173`)。trunk 名は明示 override → `origin/HEAD` → 'main' の順(`swarmIntegrate.ts:158-173`)。

### 2.2 A相 — read-only 分類(「統合可」表示)

`swarmOrchestrator.ts:4969-4978`。engine 稼働中は autoMerge OFF でも毎統合パス実行される。カードごとに:

1. `engine.conflictedBranches` に載っていれば `status='conflict'`(:4973)
2. trunk が無ければ `'unknown'`(:4974)
3. それ以外は `classifyBranch`(:4975 → `swarmIntegrate.ts:188-215`)

`classifyBranch` の返す `ReviewReadiness` は **`'ff' | 'rebase' | 'unknown'` の3値で、'conflict' を含まない**(`swarmIntegrate.ts:186`)。判定は git 読み取りのみ:

- branch ⊆ trunk(マージ済み)**または** trunk ⊆ branch(clean FF)→ `'ff'`(:206-214)
- 双方が分岐 → `'rebase'`(rebase が競合するかは**試すまで分からない**、:182-183)
- swarm ブランチでない / tip 不明 / trunk 無し / git エラー → `'unknown'`

結果は `engine.reviews[]`(`OrchestratorReview[]`、型は `src/lib/types.ts:1136` の `OrchestratorReviewStatus = 'ff' | 'rebase' | 'conflict' | 'unknown'`)として publish され、`GET /api/swarm/orchestrator` で見える。

**紛らわしさの核心 — `status='conflict'` は4つの異なる事象の相乗り表示**。B相は判定の途中で `engine.reviews` の要素を in-place で `'conflict'` に書き換える:

| 実際に起きたこと | 書き換え箇所 |
|---|---|
| 本物の rebase 競合(integrate が conflict を返した) | A相 :4973(`conflictedBranches` 経由) |
| verify RED(tsc/lint/test/swarm-safety 落ち) | `swarmOrchestrator.ts:5324-5325` |
| 敵対レビュー must-fix 差し戻しの直後 | `swarmOrchestrator.ts:5396-5397` |
| **defer streak 枯渇(needs-human 凍結)** | `swarmOrchestrator.ts:5367, 5432` |

つまり司令塔が UI やAPI で `'conflict'` を見ても、**「rebase が競合した」とは限らない**。engine log(`GET /api/swarm/orchestrator` の `log[]`)で直前の行(`敵対レビュー: N回連続で多数決つかず…` / `検証` / `conflict`)を読んで初めて区別できる。誤診の典型がここ(§4-1)。ただし `3129a58` 以降、**凍結だけは `reviews[].abstainSummary` に棄権内訳(`lens(cause)×N` 形式)が併記される**(:5371, :5433、型 `src/lib/types.ts:1147-1153`)ので、4 事象のうち凍結は API 単体でも見分けられる。

### 2.3 B相 — land(autoMerge armed のときだけ)

`swarmOrchestrator.ts:5273-5596`。ゲートは直列で、**どれか1つでも落ちたらそのカードは今パスでは統合されない**:

```
autoMerge? ─No→ return(A相のみ)                        :5274
trunk ある? ─No→ warn して return                       :5275-5278
カードごとに(engine.running && autoMerge を毎周再確認 :5281):
  1. conflictedBranches 済み? → ff になるまで skip       :5285-5298
  2. verify(tsc/lint/…)      → RED なら reworkOrPark    :5300-5334
  3. 敵対レビュー             → rework/defer/integrate   :5336-5460
  4. クロスプロセス統合 lock   → 取れなければ skip        :5462-5484
  5. deps.integrate           → integrated/conflict/error :5485-5493
  6. integrated → moveToDone → cleanup → killPty         :5495-5581
     conflict   → delegateConflict(worker に rebase 委譲) :5582-5589
     error      → 次パス再試行                            :5590-5593
```

`deps.integrate` の実体は `integrateBranch`(`swarmIntegrate.ts:251-301`)で、never force・never auto-resolve:

- **already-merged**(branch ⊆ trunk)→ push なしで `integrated/ff`(:277-280)
- **clean FF**(trunk ⊆ branch)→ `git push origin refs/heads/<branch>:refs/heads/<target>`(:286-295)。remote が動いていたら reject → `error`(次パス再試行)
- **分岐**→ 使い捨て detached worktree `.integrate-<12hex>`(`defaultIntegrate`、`swarmOrchestrator.ts:2533-2541`)で `rebase <trunk>` → 成功なら `push origin HEAD:<target>`、競合なら `rebase --abort` + 競合ファイル一覧を添えて `{status:'conflict', files}`(`rebaseAndPush`、`swarmIntegrate.ts:305-350`)

**land 成功後の後始末**(:5495-5581): カード move が先(review→done、:5514)、成功して初めて worktree+branch 掃除(`defaultCleanup` :5515 — force remove + `branch -D`、`swarmOrchestrator.ts:3841-3866`)、残った worker PTY を id でも kill(:5536-5552)、`reworks`/`conflictReworks` 予算リセット(:5518-5519)。move が kept(Board 書込失敗)なら**コミットは trunk に載っているのにカードは review に残る**「done なのに review」状態になり、次パスの already-merged 判定で自己修復を再試行しつつ `move-stuck` anomaly が上がる(:5573-5579)。

また land 成功時、対象プロジェクトが OPEN GROUND 自身なら engine 自己更新(rebuild+canary 切替)を要求する(`requestEngineSelfUpdate` :5502)。

### 2.4 verify ゲート — `.verify-*` worktree と「インライン await」

`makeVerify`(`swarmOrchestrator.ts:2906-2994`)。**land するのとまったく同じ tree**(branch を trunk に rebase したもの)を検証する:

1. swarm ブランチでなければ素通し(:2910)。tip をローカル→remote の順で解決、無ければ「何も land しない」ので素通し(:2912-2916)
2. **tip memo**: `opts.skipIfTip === tip`(前回 RED と同一 tip)なら再実行せず `{ok:false, skipped:true}`(:2918-2920)。→ 直らないまま同じ commit で居座るブランチが毎パス tsc を焼かない
3. already-merged なら素通し(:2925-2929)
4. 走らせるチェックを diff から決める(:2936-2945): tsc は tsconfig があれば常に(:2937)、lint / full-test は **全ブランチ常時**(`appliesTo: () => true`、:2883-2892)、swarm-safety は **swarm コードを触った diff のみ**(`SWARM_CODE_PATHS` :2636-2641、`touchesSwarmPaths` :2645)
5. `~/.openground/projects/<uuid>/worktrees/.verify-<12hex>` に detached worktree を作り(:2956,2962)、trunk へ rebase(競合したら **ok:true で integrate に委ねる** — verify は競合を二重報告しない、:2968-2970)、**メイン checkout の node_modules を symlink**(:2977)
6. チェックを**安い順に直列実行し、最初の RED で打ち切り**(tsc→lint→swarm-safety→test、:2981-2988)。タイムアウトは tsc 180s(:2603)/lint 180s(:2805)/swarm-safety 240s(:2721)/full test 600s(:2865)
7. finally で worktree を force remove(:2991-2992)

重要な性質: これらは**統合パスの中でそのまま await される**(`swarmOrchestrator.ts:5308`)ので、full-test が10分かかる間そのプロジェクトの**統合パスは**止まる。ただし `0d1f7f0` 以降、統合パスは tick の脇で走る(§2.1)ため、**dispatch と monitor はその間も 3 秒 tick で回り続ける** — それ以前は pass 全体が `passInFlight` を握り、verify/panel の間 rate-limit 検知・stall 検知・promote まで飢餓していた(カード `4d1550d7` の第3因子。歴史は 01 章 §6・04 章 §4)。Board/workers を**書く**区間(reworkOrPark / delegateConflict / land)だけは `runExclusive` で monitor・control plane と直列化される(:4999-5131,5145-5271,5509 — 遅い await は lock の外)。統合 lock を per-card・integrate 直前にしか取らない理由も同じ(検証+パネルで数分かかるので、パス全体で持つと lock が stale 化する、:5462-5484 のコメント)。

RED の帰結: `verifyFailed[branch]=tip` を記録(:5321)、status を 'conflict' に上書き(:5324-5325)、`reworkOrPark`(:5330)。node_modules 未 install は「検証不能=RED」扱い(fail-closed、`tscCheck` :2593-2598)なので、**install していないプロジェクトで autoMerge を arm しても全カードが差し戻される**。

### 2.5 敵対レビュー — PTY・マーカー・64KB・diff 連動 budget

verify green の後、`deps.review`(実体 `makeAdversarialReview({lenses: DEFAULT_REVIEW_LENSES})`、配線 :3900)が走る(:5336-5460)。

**パネル構成**: 既定は lens パネル 4 体 — correctness / security / perf / regression(`DEFAULT_REVIEW_LENSES`、:3114-3135)。1 lens = 1 レビュアーで、それぞれ焦点だけ違う read-only プロンプト(`buildReviewPrompt` :3279-3299)。モデルは `SWARM_LAUNCH_MODEL='fable'`(`swarmLaunch.ts:52`)を望みつつ、**cooling と使用可能モデルマスクを通して降格解決**(`resolveAvailableTier` 経由 :3673-3692、`swarmLaunch.ts:205-220`)。

**実行前の早期 return**(スポーン費用ゼロの順に):
- 同一 tip が前回 must-fix → panel を再スポーンせず rework を carry(`skipIfTip`、:3609-3618)
- diff が計算できない(git 失敗)→ defer(:3627-3630)。diff が空 → 統合(already merged、:3631-3633)
- **spawn park**: 有効 tier が全部 cooling / 全 OFF → `skippedForPark:true` の defer(:3594-3605)。呼び出し側 `runIntegratePass` にも同じ pre-gate があり(:5357)、park 中はそもそも review を呼ばない

**budget は diff 実測でスケールする(`3129a58` の根治核心)**: 早期 return を抜けたら、まず to-be-landed diff の**テキスト実バイト数**を独自 execFile(maxBuffer 32MB — gitOut だと >1MB diff で溢れて「サイズ不明」になるため)で測る(:3634-3651)。per-reviewer budget は `computeReviewTimeoutMs(baseMs, diffBytes)`(:3383-3389)= **floor 既定 5 分(`REVIEW_TIMEOUT_MS` :3356)+ 10s/KB(`REVIEW_TIMEOUT_PER_KB_MS` :3373)、cap 20 分(`REVIEW_TIMEOUT_MAX_MS` :3374)**。34KB → 約 10.7 分、122KB → cap の 20 分。**サイズ不明(git 失敗)時は cap 側に倒す**(:3385-3386 — 待つ方向に fail し、凍結方向には fail しない)。レビュアーは並列なので wall-clock は最遅の 1 体分(:3652 で全員同じ budget)。

**レビュアー1体の一生**(`defaultRunReviewer`、:3462-3529):
1. `.review-<12hex>` worktree(branch を trunk に rebase 済み、`withRebasedWorktree` :3420-3453 — verify とは別に作る。node_modules symlink は**しない**)の中で `launchClaude`(:3478-3486)。`permissionMode:'bypass'`・`appContext:false`(素の system prompt)・subscription PTY(`claude -p` は禁止契約、:3008-3011)
2. 出力は `buffer = (buffer + chunk).slice(-REVIEW_BUFFER)` で**末尾 64KB だけ**保持(`REVIEW_BUFFER=64_000` :3358、slice :3502)
3. 750ms ごとに(`REVIEW_POLL_MS` :3357)`extractReviewVerdict` でマーカーを探し、見つかれば即終了(:3510-3517)
4. **budget の壁時計**(上記 `perReviewerTimeoutMs`)を超えたら `ended:'timeout'` を添えて loop を抜け、finally で `killTerminal`(:3519-3528)。→ **マーカーを出す前に殺されたレビュアーは vote:null(棄権)** — ただし戻り値は `{raw, ended}` で(:3471)、切られた**理由の生証拠**が呼び出し側に渡る

**verdict 抽出**(`extractReviewVerdict` :3325-3354): ANSI を剥がした上で `OPENGROUND_REVIEW: <VERDICT> ::OG_REVIEW_END::` スパン(:3261-3262)を**後ろから**探す。body が `MUST_FIX`/`CLEAN` の語で始まらないスパン(プロンプト自身のエコー `<VERDICT>` プレースホルダ含む)はスキップ(echo-safety、:3267-3278)。見つからなければ `{vote:null}`。

**棄権(vote:null)には必ず理由が付く(`3129a58`)**: 非投票は verdict 化の場で `classifyAbstainCause(raw, ended)`(:3401-3406)により帰属される(:3707-3716) — 優先順位は ① transcript が rate-limit 通知で**終わって**いれば `'limit'`(`endsInRateLimit` と同じ判別)② runner の exit edge(`'timeout'` / `'aborted'`)③ 自然終了で出力ゼロなら `'spawn-failed'`、出力ありマーカー無しなら `'no-marker'`。パネルは `Promise.all` 並列で、**レビュアーが throw した場合も `.catch` で `abstainCause:'error'` の棄権に落ちる**(:3717-3719) — 旧実装(`3129a58` 以前)はこの catch が理由を握りつぶし、timeout kill と合わせて「理由の残らない棄権」だった(カード `58335c7f` の完了条件1。**修正済み**)。`runReviewer` 注入契約は `string | {raw, ended?}` の union で後方互換(:3554-3566)。

**reviewer-arm quota sensor(d4cce6e で精度修正)**: パネル終了後、
- 誰か1人でも投票していれば tier は健在の証拠 → 何もしない(:3740)
- **全員棄権**かつ、その raw が **rate-limit 文言で「終わって」いる**(`endsInRateLimit` :3741)場合のみ、その tier を `markRateLimited` で冷却し `skippedForPark` の defer を返す(:3772-3788)

`endsInRateLimit`(:1241-1259)は「含有」でなく「位置」で判定する: 全 `RATE_LIMIT_PATTERNS` の**最後のマッチ終端から末尾までが 800 文字以内**(`RATE_LIMIT_TAIL_MAX` :1178)であること。理由(:1221-1230): レビュー対象が rate-limit コード自身(swarmQuota.ts やこのファイル)のとき、通知の verbatim 文言が diff とレビュアーの地の文に載る。含有では引用と本物を区別できないが、本物なら limit がそのセッションの**最後の発話**になる。d4cce6e 以前は「棄権×文言含有」だけで健全 tier を 20 分冷却していた(コミットメッセージ参照。`git show d4cce6e` で読める)。冷却時間は `RATE_LIMIT_GRACE_MS`(既定20分、:347-353)、A5 usage sensor の resetsAt は **pct>=100 のときだけ**信頼(`a5CoolingHint` :1271-1276)。同じ判別器が per-reviewer の棄権理由 `'limit'` にも使われる(`classifyAbstainCause` :3402)。

**worktree 側の縮退**: rebase 競合 → `decision:'integrate'` で integrate に競合の所有権を渡す(:3762-3765 — integrate が再度競合して conflict stamp を打つ)。worktree が作れない → defer(:3766)。

### 2.6 tally — 「全員一致」の実像と defer streak

**lens パネル(既定)** `tallyLensReview`(:3208-3257)は多数決ではなく **weighted OR + 全員一致**:

- must-fix の重み合計 ≥ `reworkThreshold`(既定1、つまり **どれか1 lens の must-fix で即差し戻し**)→ `'rework'`(:3232-3239)
- そうでなく **`abstained === 0`(4人全員が決定的 verdict)のときだけ** `'integrate'`(:3241-3248)
- **棄権が1つでもあれば `'defer'`**(:3250-3256)— 「その failure mode は未レビュー」という理屈

reason に折り込まれる per-lens summary は `3129a58` 以降 **`lens=abstain(cause)` 形式**(:3222-3231 — 例 `correctness=abstain(timeout)`)。さらに makeAdversarialReview は、棄権を含む defer の reason 末尾に **`(diff NNKB / budget NNmin/reviewer)`** を付記する(:3792-3801)ので、engine log の 1 行だけで「誰が・なぜ棄権し・budget は何分だったか」まで読める。

(参考: lenses を渡さない homogeneous パネルは `tallyReview` :3166-3191 の厳密多数決 — `majority = floor(panelSize/2)+1`、分母は**起動数**なので棄権は絶対にバーを下げない :3137-3145。こちらの defer reason にも棄権内訳 `describeAbstentions` :3150-3154 が付く :3183-3190)

**defer streak → 凍結**(`runIntegratePass` 側、:5406-5449):

- defer のたび `reviewDeferred[branch] = {tip, count+1, abstains}`(:5419-5427)。**streak 全体の棄権内訳 `abstains`(`lens(cause)` → 回数)も蓄積**される(:5419-5425、型 :1420)。ただし `skippedForPark` の defer は engine 都合の hold なので streak を**消費しない**(:5411)
- `count >= MAX_REVIEW_DEFERS`(=3、:258)で needs-human: status='conflict' 表示 + `abstainSummary` に累積棄権内訳を stamp(:5428-5434)+ログ「敵対レビュー: 3回連続で多数決つかず — needs-human 退避(再レビュー停止・新コミットで再開): … — 棄権内訳: correctness(timeout)×3, … — 最終: …」(:5435-5439)
- 以後のパスは **defer-exhausted memo で panel を再スポーンしない**(:5359-5374)。トークン焼き防止。`engine.reviews` は毎パス再構築されるので、凍結 skip のたびに `abstainSummary` を再 stamp する(:5368-5371)
- **リセット条件は「新コミット(tip が変わる)」だけ**(:5359-5362, 5262)。決定的 verdict(rework/clean)も streak を終わらせる(:5395, 5454)が、凍結後は panel 自体が走らないので、実質 **worker が commit を積む(または人間が rebase して tip を変える)まで凍結は解けない**
- 15秒ごとの統合パス×3回なので、**棄権が続くと 3 パネル分の実行時間で凍結に到達する**(旧固定5分 budget の実測では 6-7 分間隔×3 回 = 約13分、§3。現 budget は diff 連動で最長 20 分/パネルなので、大 diff で本当に棄権が続く場合の凍結到達は最長約 60 分)

### 2.7 差し戻し(reworkOrPark)と conflict 委譲(delegateConflict)

どちらも autoMerge armed のときだけ動く「review に滞留させない」機構。

**reworkOrPark**(:4999-5131) — verify RED(:5330)と must-fix(:5403)の共通出口:
- 理由を `reworkReasons[taskId]` に永続 memo(:5021 — 次 dispatch の /order に注入される LEARNING LOOP、:1438-1449)
- 予算 `MAX_REWORKS=2`(:238)超過 → カードを 'blocked' へ park(:5024-5055)、'rework-exhausted' anomaly+通知
- worker が生きていれば review→doing に戻し、PTY に「[レビュー差し戻し n/2] …理由… 同じブランチで修正し…」を書き込んで**同一ブランチ継続**(:5058-5098、文言 :5085-5088)
- worker が死んでいれば review→todo で**新 worker に再 dispatch**(:5100-5131)

**delegateConflict**(:5145-5271) — integrate が `'conflict'` を返したときの出口(:5582-5589)。人間待ちにせず「自分のブランチを rebase して解消しろ」を worker に投げ返す。指示文は `buildConflictRebaseInstruction`(`swarmIntegrate.ts:373-391` — 競合ファイル名・rebase コマンド・**push 禁止/force-push 絶対禁止**を明記)。予算は別勘定 `MAX_CONFLICT_REWORKS=3`(:248 — conflict は worker のコード品質でなく trunk が動いた結果なので混ぜない)。超過で 'blocked' + conflict stamp(:5165-5199)。

### 2.8 engine メモの寿命(誤診防止の要)

| memo | キー | 何のため | 消えるとき |
|---|---|---|---|
| `conflictedBranches` | branch | 競合ブランチを毎パス re-rebase しない(:1393-1396) | ff になった時(:5293)/review を離れた時(:4956-4958)/resolve(:6452)/**再起動** |
| `verifyFailed` | branch→tip | 同一 tip の再 tsc 抑止(:1397-1402) | 新 tip で green(:5334)/review 離脱(:4959-4961)/resolve(:6453)/再起動 |
| `reviewFailed` | branch→tip | 同一 tip の panel 再スポーン抑止(must-fix、:1403-1409) | 新 tip で clean(:5453)/review 離脱(:4962-4964)/再起動 |
| `reviewDeferred` | branch→{tip,count,abstains} | defer streak と凍結 + 棄権内訳の累積(:1410-1420) | 決定的 verdict(:5395,5454)/review 離脱(:4965-4967)/再起動 |
| `reworks` / `conflictReworks` / `reworkReasons` | **taskId** | 差し戻し/委譲予算と理由(:1423-1460) | land(:5518-5519)/done 到達か消滅(`pruneReworks` :5835-5860)/owner の resolve(:6464-6465) |

**全部 in-memory**。サーバー再起動で凍結もconflict memo も消え、カードの `integrationConflict` stamp(永続)だけ残る — 再起動後の A相は stamp を読まないので表示が食い違い得る(§7-6)。

---

## 3. なぜ凍結したか — 実測データ(2026-07-09・**`3129a58` で根治済みの歴史**)

> **この節は歴史**。ここに記録された凍結は 2026-07-10 の `3129a58`(per-reviewer budget を diff 実測でスケール — §2.5)で根治された。実測データは**将来の回帰の照合点**として当時のまま保持する — 同型の凍結(大 diff・must-fix 0・ちょうど 2 lens 棄権)を再び観測したら、まず budget 機構の回帰を疑い §6-11/§6-12 で現物を確認すること。根治後の到達判定は TARGET-STATE §2。

出典: Board カード **`58335c7f-7621-46cd-a1ae-3cd4c150e581`**(タイトル「[swarm] 敵対レビューが lens 棄権2件で必ず needs-human に落ちる — 棄権の理由がどこにも残らない」)。起票時 blocked 列 → **`3129a58` で修正され 2026-07-10 現在 done 列**(§6 の検証コマンドでカード本文を読める)。当時のエンジンビルド(0.11.21 = e583723)・同一パネル構成での実測 7 件:

| to-be-landed diff サイズ | パネル結果 | 帰結 |
|---|---|---|
| 5,417 bytes(5.4KB) | clean 4(全員投票) | 統合成功 |
| 6,860 bytes(6.9KB) | clean 4 | 統合成功 |
| 12,904 bytes(12.9KB) | clean 4 | 統合成功 |
| 22,020 bytes(22.0KB) | clean 4 | 統合成功 |
| 33,891 bytes(33.9KB) | clean 2(**2 lens 棄権**) | defer×3 → **凍結** |
| 47,087 bytes(47.1KB) | clean 2 | defer×3 → **凍結** |
| 122,858 bytes(122.9KB) | clean 2 | defer×3 → **凍結** |

- **境界は 22KB〜34KB の間で単調に分離**。must-fix は一度も出ていない(9 パネル連続で must-fix 0 / clean 2)
- 凍結の3枚(f3f1e5c6 / 138cea2f / 8c19e047)は rebase で tip を変えて streak をリセットしても、**約40分後に同じ 3 連続 defer で再凍結**(09:17〜10:28Z で実測)
- rate-limit 文言の含有とは無関係(d4cce6e 自身の diff は limit 文言を3行含んで clean 4 / 凍結した post-api は 0 行で clean 2)。quota park でもない(park なら `skippedForPark` で streak を消費せず、reason に "reviewer hit the … usage limit" が出るが、出ていない。当時 fable は cooling で panel は opus に降格済み = `resolveAvailableTier` は機能していた)

**当時の機構**(§2.5-2.6 の積): 大きい diff → レビュアーの読解・推論が**当時固定だった 5 分 budget**(旧 `REVIEW_TIMEOUT_MS`、現ソースでは floor 定数 :3356)に収まらない、または verdict マーカーが 64KB 窓(:3358,3502 — これは現在も固定)から押し出される/出力されないまま `killTerminal` → **vote:null が2つ** → `tallyLensReview` は `abstained===0` でしか integrate を出せない(:3241 — これも現在も同じ)→ defer → 同一 tip で3回 → 凍結。**must-fix が無くても、誰も反対していなくても、構造的に統合できなかった**。しかも棄権は timeout/spawn 失敗/パース不能/limit の全てが裸の vote:null に潰れ、理由がどこにも残らなかった。

**根治**(`3129a58`、2026-07-10): budget が diff 実測バイトでスケールするようになった(floor 5 分 + 10s/KB、cap 20 分 — `computeReviewTimeoutMs` :3383-3389、§2.5)。実測境界だった 34KB は約 10.7 分の budget に収まり、当時の凍結 3 枚と同等の diff が予算内で 4/4 投票できる設計。同コミットで棄権理由(`AbstainCause` :3055)・凍結時の内訳(`abstainSummary` :5433)も実装済み。**未変更のまま残る要素**: 64KB バッファ(:3358)・全員一致要件(:3241)・needs-human の独立 status 不在(§7-4)。

**帰結(更新)**: 「engine は自分を修理できない」状態は解消された(設計上)。**実運用でこのサイズ帯の diff が autoMerge で決着した実績はまだ無い** — 最初の大 diff カードが arm 下で統合されるまでは、§5 の手動統合を fallback として維持する(TARGET-STATE §2 の到達判定)。

---

## 4. 落とし穴 — 司令塔が実際に踏んだ/踏みやすい誤診

1. **「conflict 表示 = rebase 競合」と思い込む**。§2.2 の通り、verify RED・must-fix 差し戻し直後・**defer 凍結**(:5324-5325,5396-5397,5367,5432)が全部 'conflict' に相乗りする。凍結カードを「競合だ」と誤診して worktree で rebase を試みても、競合は無く FF 可能なことがある(実際 §3 の凍結 3 枚がそう)。**engine log の直前行で種別を確認**(§6-3)— `3129a58` 以降は `reviews[].abstainSummary` の有無でも凍結だけは即判別できる(§2.2)。
2. **「must-fix 0 / clean 2 なら、あと少しで通る」と思い込む**。clean 2 は「賛成2」ではなく「**2 lens が棄権 = 全員一致が絶対に成立しない**」。同じ tip で待っても3回で凍結し、以後 panel は走らない(:5359-5374)。新コミットを積まない限り再開しない。(`3129a58` 以前は「大 diff だから棄権」がこの型の支配的原因だった — 現在棄権が続くなら `abstainCause` で真因を読む。)
3. **棄権の理由が残らない前提で諦める(逆に、探して時間を溶かす)**。**これは `3129a58` で過去の話になった** — 当時は `.catch → vote:null` と timeout kill が理由を握りつぶし、調べる手段が無かった。現在は3か所に残る: ① 毎 defer の engine log(`lens=abstain(cause)` + `(diff NNKB / budget NNmin/reviewer)`、:3222-3231,3725-3734)② 凍結ログの「棄権内訳: …」(:5435-5439)③ API の `reviews[].abstainSummary`(:5371,5433)。診断はまずここを読む — `timeout` なら diff/budget、`limit` なら quota(§2.5 sensor)、`spawn-failed`/`error` なら PTY 環境。
4. **autoMerge OFF なのに「統合されない」と騒ぐ**。B相は armed のときだけ(:5274)。OFF 時は分類表示だけで、差し戻しも委譲も起きない(:236-237 のコメント通り「カードは review に留まる」のが正常)。
5. **verify の遅さを hang と誤診**。full test は最大 600 秒(:2865)、パス内で直列 await(§2.4)。さらにパネルも per-reviewer 最長 20 分(§2.5)。統合パスが「止まって見える」のは正常。engine log に verify/レビューの結果行が出るまで待つ。
6. **再起動で凍結が「直った」と誤認**。`reviewDeferred` は in-memory(§2.8)。再起動後は panel が再スポーンされ、**凍結の原因が残っていれば同じ棄権で再凍結**する(§3 の「rebase でリセットしても40分後に再凍結」と同型。当時の原因=固定 budget は根治済みなので、再発したら `abstainCause` で新しい原因を特定する)。
7. **push 済みブランチの「integration deferred: … fast-forward push rejected」**。trunk が動いた直後の正常な transient(:5590-5593、`swarmIntegrate.ts:294`)。次パスで rebase 経路に入る。異常扱いして手を入れない。
8. **二重司令塔**。engine の統合と手動統合(tmux 側 or 自分)を同時にやると同一ブランチを同時に rebase/push しうる。engine 側は per-card の cross-process lock(:5462-5484、`scripts/swarm-lock.js` と同じ lock)を取るが、**手動側が lock を取らなければ意味がない**。手動統合するなら autoMerge を OFF にしてから。

---

## 5. 司令塔の運用注意

### autoMerge を arm してよい条件

以下を**全部**満たすときだけ arm する(1つでも欠けると review が詰まるか、全カード差し戻しになる):

1. **origin の trunk が存在する**(無いと B相は丸ごと no-op、:5275-5278)
2. **プロジェクトに node_modules がある**(無いと tsc gate が fail-closed で全カード RED → 差し戻し2回→blocked、:2593-2598)
3. **使用可能モデルに ON の tier があり、全滅 cooling でない**(park 中は review が進まないだけだが、arm する意味がない。:5357、`swarmAllowedModels.ts:132-148`)
4. **大 diff カードも決着する前提でよい(`3129a58` 以降)** — budget が diff 連動(cap 20 分、§2.5)になり、旧 22KB 制限は撤廃。含みは1つ: **実運用でこのサイズ帯が arm 下で決着した実績はまだ無い**(TARGET-STATE §2 — 最初の1枚は engine log を見届ける)。かつて併記していた「arm 中は panel が pass を握るため最長 20 分/カードの monitor 空白」は **`0d1f7f0`(同日)で解消** — integrate は tick から分離され、panel/verify 中も monitor は回る(§2.1/§2.4。検知21分遅延そのものの根治は 04 章 §4・TARGET-STATE §1)
5. **他に同じ repo を統合する主体がいない**(tmux 司令塔・手動 rebase/push と同時にしない。§4-8)

arm/disarm は `POST /api/swarm/orchestrator/automerge` body `{path, enabled}`(`server/routes/swarm.ts:614-627`)。in-memory・既定 OFF・engine 停止中に arm しても intent が残るだけ(:6635-6640)。

### 凍結/conflict カードの解除 — 2つの正規ルート

**(a) エンジンに任せたまま解かせる**: worker に新コミットを積ませる(tip が変われば `reviewDeferred`/`verifyFailed`/`reviewFailed` は全部無効化される。§2.6/2.8)。`3129a58` 以前は「凍結原因が大 diff なら同じ結果になる」ため勧めなかったが、現在は tip が変われば panel が diff 連動 budget で再走するので、**まず `abstainSummary` で凍結原因を読み**、timeout 起因でなければこのルートが第一候補。

**(b) owner resolve で review から出す**: `POST /api/swarm/orchestrator/review/resolve` body `{path, taskId, target:'blocked'|'todo'}`(`server/routes/swarm.ts:636-652` → `resolveOrchestratorReview` :6389-6475)。
- `'blocked'` = **人間(司令塔)が引き取る**宣言。branch は残る。以後は下の手動統合へ
- `'todo'` = 新 worker で最新 trunk からやり直し(旧 branch は参照用に残る)
- どちらも conflict stamp・conflict/verify memo・差し戻し予算をクリアし、残 worker を teardown する(:6451-6465)

### 手動統合の手順(凍結カードを司令塔が land する型)

**共有 checkout(メインの作業ツリー)を絶対に触らない**。全部 API/git の読み取りと使い捨て worktree で行う。autoMerge は先に OFF。

```bash
cd <projectPath>
git fetch origin main

# 1) 検証つき統合の作業場(使い捨て worktree)
git worktree add --detach /tmp/og-land-<id> <branch>
cd /tmp/og-land-<id>

# 2) trunk に乗せ直す(FF 可ならこの rebase は no-op)
git rebase origin/main            # 競合したら止めて worker 委譲 or 自力解消を判断

# 3) 再検証(engine の verify と同じ基準。node_modules は本体から)
ln -s <projectPath>/node_modules node_modules 2>/dev/null || true
npx tsc --noEmit && npm run lint && npm test    # 赤なら push しない — reworkOrPark 相当の差し戻しへ

# 4) 緑なら FF push(force 厳禁)
git push origin HEAD:main

# 5) 後始末
cd <projectPath>
git worktree remove --force /tmp/og-land-<id>
git branch -D <branch>            # trunk 着地を確認してから
# Board: カードを done へ(swarm-board.sh move / POST /api/project/tasks setColumn)
```

これは engine の `rebaseAndPush`(`swarmIntegrate.ts:305-350`)+ verify(§2.4)を人力でなぞったもの。**engine が代わりにやれないのは敵対レビューの責務だけ**(budget は `3129a58` で diff 連動になったが、64KB 窓と全員一致要件は残る — §2.5/§2.6)なので、手動統合するときは自分(司令塔)がレビュー責務を負う — diff を読み、必要なら時間無制限の subagent レビューを1本立てる。push が reject されたら trunk が動いただけ(fetch からやり直し。異常ではない)。

---

## 6. 検証コマンド集(主張の裏取り用ワンライナー)

```bash
# 1) engine の状態・reviews[](統合可表示)・autoMerge を見る
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq '{running, autoMerge, reviews}'

# 2) reviews[] の status だけ抜く(conflict 表示の確認)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.reviews[] | "\(.status)\t\(.branch)"'

# 3) engine log から凍結/差し戻し/park の行を拾う(conflict 表示の真因の区別)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.log[] | select(.message | test("多数決|差し戻し|conflict|park|cooling|integrated")) | "\(.at) \(.level) \(.message)"'

# 4) autoMerge の arm / disarm(owner ログイン必須)
curl -s -X POST http://127.0.0.1:47776/api/swarm/orchestrator/automerge -H 'content-type: application/json' -d '{"path":"/path/to/project","enabled":false}'

# 5) 凍結カードを review から出す(blocked=自分が引き取る / todo=作り直し)
curl -s -X POST http://127.0.0.1:47776/api/swarm/orchestrator/review/resolve -H 'content-type: application/json' -d '{"path":"/path/to/project","taskId":"<UUID>","target":"blocked"}'

# 6) diff サイズを測る(budget の見積り: floor 5分 + 10s/KB・cap 20分。§3 の歴史境界 22〜34KB は旧固定 budget 時の実測)
git -C /path/to/project fetch origin main && git -C /path/to/project diff origin/main...<branch> | wc -c

# 6b) 凍結カードの棄権内訳を API で見る(3129a58 以降 — 凍結時のみ abstainSummary が付く)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.reviews[] | select(.abstainSummary) | "\(.branch)\t\(.abstainSummary)"'

# 7) classify を手で再現(A相の ff/rebase 判定)
git -C /path/to/project merge-base --is-ancestor <branch> origin/main && echo "already-merged(ff)" || { git -C /path/to/project merge-base --is-ancestor origin/main <branch> && echo ff || echo rebase; }

# 8) 検証/レビュー worktree の残骸を見る(生きた .verify-* / .review-* / .integrate-* は実行中の証拠)
ls ~/.openground/projects/<projectUUID>/worktrees/ | grep -E '^\.(verify|review|integrate)-'

# 9) 実測の出典カード 58335c7f の本文を読む
jq -r '.tasks[] | select(.id | startswith("58335c7f")) | .notes' ~/.openground/projects/<projectUUID>/tasks.json
# (inline python(python3 -c)は openground-guard に弾かれるので使わない — jq か、スクリプトファイルに落として実行)

# 10) d4cce6e(quota sensor の精度修正)の中身
git -C /path/to/OPEN-GROUND show d4cce6e --stat

# 11) 主要定数が本ドキュメントの記載と一致するか(PER_KB/MAX が 3129a58 の budget 定数)
grep -n "REVIEW_TIMEOUT_MS =\|REVIEW_TIMEOUT_PER_KB_MS =\|REVIEW_TIMEOUT_MAX_MS =\|REVIEW_BUFFER =\|MAX_REVIEW_DEFERS =\|MAX_REWORKS =\|MAX_CONFLICT_REWORKS =\|INTEGRATE_TICK_MS =" src/lib/server/swarmOrchestrator.ts

# 12) 「棄権1つで defer(全員一致)」と budget 式の該当行を直接見る
sed -n '3241,3257p' src/lib/server/swarmOrchestrator.ts   # tallyLensReview の integrate/defer 分岐
sed -n '3383,3389p' src/lib/server/swarmOrchestrator.ts   # computeReviewTimeoutMs(diff 連動 budget)
```

(47776 は `server/index.ts` の固定ポート契約 — engine 自身も同じ loopback origin で Board API を叩く、`swarmOrchestrator.ts:2178-2183`)

---

## 7. 既知の穴(読解中に確認した実装上の問題 — 修正はしない・列挙のみ)

1. ~~**棄権の理由が消える**~~ → **`3129a58` で解決済み**。throw は `abstainCause:'error'`(:3717-3719)、timeout は `ended:'timeout'` → `'timeout'`(:3519,3714)として帰属され、defer ログ・凍結ログ・`reviews[].abstainSummary` に残る(§2.5/§2.6)。旧挙動(`.catch → 裸の vote:null`・needs-human ログに内訳なし)は §3 の歴史記録を参照。
2. **lens パネルは実質「全員一致」ゲート**(現存・仕様): `tallyLensReview` は `abstained===0` のときしか integrate を出さない(:3241)。`3129a58` 以前は棄権率が diff サイズで単調に上がったため大 diff が構造的に統合不能だった(§3 — budget 根治で解消)。全員一致要件そのものは「棄権 = その failure mode 未レビュー」の設計意図で残っている — 棄権が **budget 以外の理由**(spawn 失敗・limit)で続けば今でも凍結し得る。
3. **64KB バッファが固定のまま**(:3358,3502)。budget は diff 連動になったが(§2.5)、マーカーが 64KB 窓から押し出される経路と、分割レビューの不在は残る。実測でこの窓が棄権の主因になった証拠は無い(§3 の凍結は budget 由来)が、巨大出力を吐くレビュアーでは理論上 `no-marker` 棄権になり得る。
4. **needs-human に独立した status 値が無い**: `OrchestratorReviewStatus`(`src/lib/types.ts:1136`)は `'ff'|'rebase'|'conflict'|'unknown'` のみで、verify RED / must-fix / defer 凍結はすべて `'conflict'` に上書き(:5324-5325,5396-5397,5367,5432)。`3129a58` で凍結だけは `abstainSummary`(`types.ts:1147-1153`)により API 上区別可能になったが、status 値としての独立は依然無い(verify RED と must-fix は今も区別不能)。
5. **`resolveOrchestratorReview` のコメントと実装の不一致**: 「Clear EVERY engine memo tied to this branch」(:6448)と言いつつ、消すのは `conflictedBranches`/`verifyFailed` だけ(:6451-6454)で **`reviewFailed`/`reviewDeferred` は残る**。実害は小さい(次の統合パス冒頭の prune :4962-4967 が review 不在ブランチの memo を落とす)が、engine 停止中に resolve→同一ブランチを手動で review に戻す運用をすると古い凍結 memo が生き返る余地がある。
6. **in-memory conflict memo とカードの永続 stamp の乖離**: 再起動で `conflictedBranches` が消えると、A相(:4973)は stamp(`integrationConflict`)を読まないため 'rebase' 等に戻る一方、カードには stamp が残る(:1393-1396 は意図と明記しているが、表示上は食い違う)。stamp の自己修復は autoMerge armed の B相(:5287-5297)と land 時 backstop(:5520-5528)にしかない。
7. **verify と review が同じ tip に対して rebase worktree を2回別々に作る**(`.verify-*` :2956 / `.review-*` :3429)。正しさに問題は無いが、統合パス1周あたりの git コスト・所要時間が倍化し、その分 park/stop の割込み窓(:5390)も広がる。budget が cap 20 分に伸びた分(§2.5)、integrate 1 周の所要時間は `3129a58` 以前より**長くなり得る** — ただし `0d1f7f0` で integrate は tick から分離されたので、この長さが monitor を飢餓させることはもう無い(§2.1。カード `4d1550d7` の pass 飢餓は解消済み)。遅い integrate の実害は「review 列の決着が遅れる」ことに閉じる。
8. **`tallyReview`(homogeneous パネル)は現行配線では未使用**(defaultDeps は lenses 固定 :3900)。ドキュメントや UI 文言が「多数決」と言うとき、実際に動いているのは weighted-OR + 全員一致(§2.6)であることに注意。
