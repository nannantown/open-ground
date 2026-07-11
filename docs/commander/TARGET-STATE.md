# TARGET-STATE — 理想の稼働形(そこへ走るための北極星)

**対象コミット: `0d1f7f0`**(origin/main tip、2026-07-10)。初版は `a8429b6` 時点(ソース = `cc7c60e`)。その後 `3129a58`(§2 の実装)、`d8431c3`+`aa9cb8d`(§3 の実装)、`0d1f7f0`(§1 の実装)が main に入り、本改訂で反映済み — 本書と 03/06 章の file:line は `0d1f7f0` 基準、01/02/04/05 章は `cc7c60e` 基準のまま(乖離の扱いは 00-INDEX 冒頭)。
**読者**: 将来の司令塔(og-manage / manage セッション)と、swarm コアを改修する worker。
**この文書の役割**: 「swarm システムがこの状態で回っていれば健全」と言える条件を、**観測可能な形**(コマンドで真偽判定できる形)で列挙する。願望は書かない — 各項目は ①理想の観測可能条件 ②現状とのギャップ(file:line) ③対応カード ④到達判定コマンド、の 4 点で構成する。カード列の表記は 2026-07-10 時点のスナップショット(現在列は tasks.json で確認 — 00-INDEX §6)。

---

## 判定サマリ(2026-07-10 時点・`3129a58`/`aa9cb8d`/`0d1f7f0` 反映後)

| # | 理想 | 現状 | 対応カード |
|---|---|---|---|
| 1 | model 枯渇は 2 分以内に検知され dispatch が正しい tier に落ちる | ◐ **実装済み(`0d1f7f0`)— spawn 直後の即死は約 1.5 分(onset 窓)・稼働後は実クロック化した 10 分ゲート。実運用での検証待ち** | `4d1550d7`(done) |
| 2 | 敵対レビューは diff サイズに依らず決着し、棄権には理由が残る | ◐ **実装済み(`3129a58`)・実運用での検証待ち** | `58335c7f`(done) |
| 3 | 過去 fatal の再投函ゼロ・dismiss は再起動を跨いで効く | ◐ **実装済み(`d8431c3`+`aa9cb8d`)・実運用での検証待ち** | `c944ea69`(done) |
| 4 | 司令塔 API は嘘をつかない(stale 心拍の解消) | ◐ **実装済み(worker ブランチ `swarm/swarm-workers-api-heartb-*`、2026-07-11)— main 統合・実運用実測待ち** | 統合待ち(commander) |
| 5 | autoMerge を常時 arm できる(+人間承認の境界確定) | △ §1・§2 とも実装済み — 残るは両者の実運用実測と再起動 OFF の設計判断 | 1・2 に従属(境界は本書 §5 が正典) |
| 6 | 司令塔ドキュメントが変更に追随する | ◐ **検知2点は実装済み(本改訂)— verify soft-warn(journal)+ og-manage 起動時の 00-INDEX §6-1 チェック**。カード起票テンプレへの強制はまだ無い | 案 B のうち検知2点は完了。テンプレ組込みのみ残存 |

(◐ = 実装は main 入り・到達判定コマンドでの実測が未。✓ にするのは実運用の観測のみ。)

6 項目すべて ✓ になったとき、司令塔の仕事は「監視と誤診の尻拭い」から「注文と承認」へ縮む — それがこの文書群の終着点。

---

## 1. model 枯渇は 2 分以内に検知され、dispatch が正しい tier に落ちる

### 理想(観測可能条件)

- worker の画面に rate-limit / per-model limit 文言が表示されてから、engine journal に `worker rate/usage-limited — holding` 行(swarmOrchestrator.ts:4376-4380)が出るまで **2 分以内**。
- 検知の次の dispatch から、spawn は `launchTier`(mask+冷却を通した値)で行われる — 枯れた tier への再突入がゼロ。
- 全 enabled tier 枯渇時は journal に `quota park` の enter-edge 行(swarmOrchestrator.ts:4738-4750)が出て、新規 spawn だけが止まる(既存 worker・monitor は無傷 — :4732-4735 の現行セマンティクスを維持)。

### 現状: **実装済み(`0d1f7f0`、2026-07-10)— 実運用での検証待ち**

旧 3 因子と実装の対応(歴史の詳細は 04 章 §4 = 実測 21 分 30 秒の事例研究・照合点として保持):

| 旧・因子(cc7c60e 時点) | 実装(0d1f7f0 基準) |
|---|---|
| ① 沈黙 10 分ゲート — `STALL_SILENCE_MS` まで画面を読まない(spawn 直後の即拒否を見ない) | **解消(2 経路の OR :4352 — コード自身のコメント :4341-4346 が正典)**: 出力が 45 秒沈黙したらスクリーンをサンプリング(`RATE_LIMIT_SCRAPE_QUIET_MS` :374、条件 :4273-4287)。**(a) 早期経路 = spawn 初動の即死型限定**: limit 文言が onset 窓(≤2 分、`RATE_LIMIT_EARLY_ONSET_MS` :384)に現れ 45 秒継続(`RATE_LIMIT_EARLY_CONFIRM_MS` :391)・commit ゼロ・文言以降の心拍なしなら 10 分を待たず認定(`earlyLimitConfirmed` :4327-4333)— sighting→cooling 約 1.5 分(実測形 約 95 秒)。**(b) 稼働後の limit(onset 窓外・commit/心拍あり)は従来の 10 分沈黙ゲートのまま** — ただし②のクランプで**実クロック化**(装飾再描画による無限先送りは根絶 = 10 分は 10 分で必ず着く) |
| ② 装飾再描画 — `lastOutputAt` が onData 無条件スタンプで沈黙時計が巻き戻る | **解消**: `engine.limitScreen`(:1496 — limit 文言が画面を占有し始めた実時刻)を新設し、**stall クロックの出力チャネルを文言出現時刻でクランプ**(`stallLastOut` :4302)。心拍はクランプしない(打てる worker は働いている)。terminal.ts 側の無条件スタンプ自体は残る — クランプは読む側で行う。requeue には grace 経過に加え **raw 沈黙 45 秒**も要求(:4381)— 文言がフレームに残留したまま活動再開した worker を誤回収しない |
| ③ monitor 飢餓 — integrate pass の verify+panel が `passInFlight` を握り monitor 自体が回らない | **解消**: `kickIntegratePass` で tick の脇に fire-and-forget 化(:5619-5630、tick 側 :5981-5989 — self-supply と同型)。`integrateInFlight`(:1370)で integrate 同士の重複を禁止。board/workers を書く区間(reworkOrPark / delegateConflict / land)は `runExclusive` で monitor・control plane と直列化(:4999,5145,5509)、遅い await は lock 外のまま |

false-kill ガードは不変(回帰テストで固定): 出力が流れる worker はサンプリングすらされず、limit 文言をソース/プランに**書くだけ**の worker は onset 窓で早期認定を拒否される。per-model 通知の 3 フレーズ(:1170-1192)と層 C(mask、d1485ea)は従来どおり。

**検証待ちの間の司令塔運用**: 実際の枯渇イベントで下の到達判定を一度実測して ✓ にする。理想の「2 分以内」を設計上満たすのは **(a) の即死型**(21 分 30 秒事例の再現形)— **稼働後に limit へ当たった worker は最大 ~10 分+スクレイプ間隔**かかる(ただし確実に着く)。稼働後型で 2 分を求めるなら新カードが要る(現状その必要性を示す実測は無い)。それまで「journal に無い = 枯れていない」ではない(00-INDEX §4 — journal は 200 行 ring かつ再起動で消えるため、この原則は根治後も残る)。

### 対応カード

`4d1550d7-a815-40e1-a579-2cd366b76f7d` — 「[swarm] quota 検知が21分遅れる — 沈黙10分ゲート/装飾再描画/統合パスの飢餓」(起票時 blocked [保留] → doing → **`0d1f7f0` で修正・2026-07-10 時点 done 列**)。

### 到達判定コマンド

```bash
# 事象発生時: worker 画面の limit 表示時刻(左)と journal 検知時刻(右)の差が 2 分以内か — ✓ にする実測はこれ
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq -r '.log[] | select(.message | test("rate/usage-limited|quota park")) | "\(.at) \(.message)"'
# 実装の静的確認(回帰チェック):
grep -n "RATE_LIMIT_SCRAPE_QUIET_MS = \|RATE_LIMIT_EARLY_ONSET_MS = \|RATE_LIMIT_EARLY_CONFIRM_MS = " src/lib/server/swarmOrchestrator.ts
grep -n "kickIntegratePass\|integrateInFlight" src/lib/server/swarmOrchestrator.ts | head -5
grep -n "limitScreen" src/lib/server/swarmOrchestrator.ts | head -3
# (注: terminal.ts の lastOutputAt 無条件スタンプは残存が正 — クランプは orchestrator の stallLastOut 側)
```

---

## 2. 敵対レビューは diff サイズに依らず決着し、棄権には必ず理由が残る

### 理想(観測可能条件)

- 任意サイズの to-be-landed diff で、パネルが `rework` か `integrate` に**決着**する — 「diff が大きい」ことだけを原因とする defer→needs-human 凍結が起きない(分割レビュー・タイムアウト/バッファのスケーリング・棄権の除外集計など、手段はカード側の設計に委ねる)。
- 棄権(vote:null)が発生したら、**どの lens が・なぜ**(timeout / PTY 死 / マーカー無し / spawn 失敗 / quota)が engine journal または review 結果に残る — 「理由の残らない棄権」がゼロ。
- 実測基準: 03 章 §3 の凍結 3 枚と同等の diff(34KB / 47KB / 123KB)が、must-fix ゼロなら統合まで到達する。

### 現状: **実装済み(`3129a58`、2026-07-10)— 実運用での検証待ち**

旧ギャップと実装の対応(03 章 §2.5-2.6/§3 が正典):

| 旧・穴(cc7c60e 時点) | 実装(aa9cb8d 基準) |
|---|---|
| 5 分 timeout が diff サイズに対して固定 | **解消**: `computeReviewTimeoutMs` — floor 5 分 + 10s/KB・cap 20 分・サイズ不明は cap 側(swarmOrchestrator.ts:3383-3389、定数 :3356,3373-3374) |
| 棄権理由が `.catch` と timeout kill で消滅・区別不能 | **解消**: `AbstainCause`(:3055)+ `classifyAbstainCause`(:3401-3406)。throw も `abstainCause:'error'` に(:3717-3719)。ログは `lens=abstain(cause)` + `(diff NNKB / budget NNmin/reviewer)`(:3222-3231,3725-3734) |
| needs-human が 'conflict' 相乗りで内訳不明 | **緩和**: 凍結には `reviews[].abstainSummary`(累積棄権内訳)が付く(types.ts:1147-1153、:5371,5433)。独立 status 値は依然無し(03 章 §7-4) |
| lens パネルは `abstained === 0` でしか integrate を出さない(実質全員一致) | **現存(仕様として維持)**: :3241。budget 根治で「大きさだけで棄権」が消えたため、凍結の構造性は解消 |
| 64KB バッファ固定 | **現存**: :3358(03 章 §7-3 — 実測で主因になった証拠なし) |

当時の実測(2026-07-09、同一ビルド 7 件、03 章 §3 に保持): 22KB 以下は clean 4 で統合成功、34KB 以上は毎回ちょうど 2 lens 棄権 → defer×3 → 凍結。**must-fix が無くても構造的に統合できなかった**。

**検証待ちの間の司令塔運用**: 大 diff カードを arm 下で流す最初の数枚は engine log を見届ける(凍結したら `abstainSummary` で理由を読む — 03 章 §4-3)。凍結が出ない実績が積めるまで、03 章 §5 の手動統合を fallback として維持。

### 対応カード

`58335c7f-7621-46cd-a1ae-3cd4c150e581` — 「[swarm] 敵対レビューが lens 棄権2件で必ず needs-human に落ちる — 棄権の理由がどこにも残らない」(**`3129a58` で修正・2026-07-10 時点 done 列**)。

### 到達判定コマンド

```bash
# 34KB 超 diff のカードが autoMerge で決着するか(凍結行が出ないこと)— ✓ にする実測はこれ
git -C <PATH> diff origin/main...<branch> | wc -c
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq -r '.log[] | select(.message | test("多数決|needs-human|敵対レビュー")) | "\(.at) \(.message)"'
# 棄権理由の記録(実装後は defer/凍結行に lens=abstain(cause) と棄権内訳が出る):
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq -r '.reviews[] | select(.abstainSummary) | "\(.branch)\t\(.abstainSummary)"'
# 実装の静的確認(回帰チェック):
grep -n "computeReviewTimeoutMs\|classifyAbstainCause\|REVIEW_TIMEOUT_MAX_MS" src/lib/server/swarmOrchestrator.ts | head -5
```

---

## 3. 過去 fatal の再投函ゼロ・dismiss は再起動を跨いで効く

### 理想(観測可能条件)

- overseer を OFF→ON(re-arm)/ プロセス再起動しても、通知ストアに残る**過去の** exec-timeout / rollback fatal から新規 escalation が **1 件も立たない**(新規発生の fatal は従来どおり 1 件立つ)。
- 一度 dismiss した事象は、再起動・re-arm 後も同一事象について再投函されない(= dedup が in-memory の `ov.seen` だけに依存しない)。
- 観測: 06 章 §7.3 の突合で「escalation 件数 ≒ fatal 件数 × 世代数」の増殖パターンが消え、1 fatal ≦ 1 open escalation になる。

### 現状: **実装済み(`d8431c3`+`aa9cb8d`、2026-07-10)— 実運用での検証待ち**

旧ギャップ(4 点の合成)と実装の対応(06 章 §3.6 が現行機構の正典・§4.1 が歴史):

| 旧・穴(cc7c60e 時点) | 実装(aa9cb8d 基準) |
|---|---|
| `recentFatals()` に時間窓が無い(全件返す) | **解消**: `recentFatals(sinceMs)` 契約 + `fatalWindowMs` 24h(swarmOverseer.ts:133, :317-322, :370-379)+ pass 側の窓再強制(:900-902) |
| dismissed に receiptKey 冪等が効かない(open が居る間だけ) | **解消**: raise 前に escalations.json を **status 不問**で照合する永続受領判定(:916-940)。receiptKey は `<id>:<path>:<ref>:<createdAt>`(:912) |
| 受領台帳の読みが tolerant で fail-closed ガードが不発(d8431c3 単体の残穴) | **解消(`aa9cb8d`)**: strict リーダー `listEscalationReceiptKeys` — ENOENT のみ空・破損/他エラーは throw → raise 見送り(swarmEscalations.ts:264-284、swarmOverseer.ts:921-932) |
| S3 dedup(`ov.seen`)が in-memory — re-arm / 再起動でゼロクリア | **現存(設計のまま)**: swarmOverseer.ts:46-48 — 窓+永続受領が読み手側で吸収 |
| 通知ストアは cap 50・期限なし | **現存**: swarmNotifications.ts:30, :65-68 — 同上 |

当時の実測(2026-07-10 根治前、06 章 §4.1 に保持): 発火源 fatal 8 件 → exec-timeout 由来 escalation 25 件(全 dismissed — 世代コピー)。

**検証待ちの間の司令塔運用**: 下の到達判定(re-arm 実験)を一度実測して ✓ にする。根治後に上がる S3/S10 は「24h 窓内の未受領 occurrence」= 実発生として扱う(06 章 §5.1)。

### 対応カード

`c944ea69-5b95-4541-ba14-f60a3db08e5d` — 「[swarm] overseer S3 が過去の exec-timeout を毎回再投函する — recentFatals に時間窓が無く dismiss も効かない」(**`d8431c3`+`aa9cb8d` で修正・2026-07-10 時点 done 列**)。

### 到達判定コマンド

```bash
# re-arm 実験: overseer OFF→ON して 90 秒後(60s サブサイクル+余裕)に exec-timeout 由来 escalation の件数が増えないこと
jq -r '[.items[] | select(.question | contains("実行時間上限"))] | length' ~/.openground/escalations.json   # arm 前
curl -s -X POST http://127.0.0.1:47776/api/swarm/orchestrator/overseer -H 'Content-Type: application/json' -d '{"path":"<PATH>","enabled":true}' >/dev/null
sleep 90
jq -r '[.items[] | select(.question | contains("実行時間上限"))] | length' ~/.openground/escalations.json   # arm 後 — 同数なら到達
```

---

## 4. 司令塔 API は嘘をつかない(stale 心拍問題の解消)

### 理想(観測可能条件)

- `GET /api/swarm/workers` の `heartbeatAt` が、**エンジン roster 由来の worker についても**ディスク心拍の `updatedAt` を反映する(リクエスト時点の値)。または「エンジンが最後に読んだ時刻」と「ディスクの最新」が**別フィールド**で返り、UI/司令塔が区別できる。
- 1 レコード内の鮮度混在(`ready`/`blocked` は新鮮・`heartbeatAt` は凍結)が解消される。
- 観測: エンジン worker についてディスクの `updatedAt` と API の `heartbeatAt` を突き合わせて**常に一致**(または差が 1 リクエスト分以内)。

### 現状とのギャップ(解消済み・02 章 §4・§9-1 は歴史として保持)

| 穴 | 根拠(修正前) |
|---|---|
| ソース 1(エンジン roster)の `heartbeatAt` = `w.heartbeatAt`(monitor が最後に fold した凍結値)。ディスク `hb.updatedAt` を使わない | swarmWorkerRegistry.ts:188(旧 :178-194 に `hb?.updatedAt` への参照なし) |
| `withHeartbeat` は「カードが doing 列」の monitor ルートでしか呼ばれない — エンジン停止・promote 済み(done)・人がカードを動かした・カード消滅、のどれかで凍結 | swarmOrchestrator.ts:3931-3936, :4090-4096, :4101-4114(この監視/promote 側のロジック自体は今回未変更 — 表示 API 側で吸収) |
| 同じレコードの `ready`/`blocked` はディスク由来で新鮮 — 鮮度が 1 レコード内で混在 | swarmWorkerRegistry.ts:189-193 |

実測(2026-07-10、修正前): ディスク `updatedAt=07-10T00:41` の worker を API が `heartbeatAt=07-09T07:55` と返し、「半日死んでいる」と誤診。

**修正**: `swarmWorkerRegistry.ts` のソース 1(エンジン roster)ループが `hb?.updatedAt ?? w.heartbeatAt` を返すように変更(`hb` は同じ関数内で `deps.readHeartbeats()` からリクエスト時点に読んだディスク心拍)。ディスクに心拍ファイルが無い/読めない場合のみエンジンの凍結値へフォールバックする。monitor/promote 側(`w.heartbeatAt` を使う `swarmOrchestrator.ts` の reworkAt 比較など)は変更なし — あくまで表示 API の話に閉じている。`SwarmWorkerRecord`(types.ts)のフィールド追加は不要(既存 `heartbeatAt` の値の出所を差し替えるだけ)。

**運用の読み替え(修正後)**: `heartbeatAt` はディスク直読相当になったため、02 章 §8 の「鮮度判定は必ずディスク直読」という回避策は不要になった — API の値をそのまま信用してよい。

### 対応カード

`swarm/swarm-workers-api-heartb-*` ブランチで実装済み(worker コミット済み・main 未統合)。commander が統合し次第、本行の「対応カード」列と 判定サマリ §4 を `done` へ更新する。

### 到達判定コマンド

```bash
# エンジン worker(stage 付き)についてディスクとAPIの heartbeatAt が一致するか
curl -s "http://127.0.0.1:47776/api/swarm/workers?path=<PATH>" | jq -r '.workers[] | select(.stage) | "\(.branch)\t\(.heartbeatAt)"'
for f in ~/.openground/swarm/*/*.json; do jq -r '"\(.branch)\t\(.updatedAt)"' "$f"; done
# 両者の同一 branch 行が一致すれば到達(修正前は乖離が残り続けていた)
```

---

## 5. autoMerge を常時 arm できる条件と、人間承認が必須で残る操作の境界

### 理想(観測可能条件)

**常時 arm の成立条件**(すべて満たしたとき「arm しっぱなし」を既定運用にできる):

1. §1(quota 検知)と §2(レビュー決着)が解消済み — 大 diff カードが凍結せず、枯渇時もレビューパネルが誤 defer しない。
2. 03 章 §5 の静的条件が定常的に真: origin trunk あり / node_modules あり(verify が fail-closed のため — swarmOrchestrator.ts:2593-2598)/ spawnable tier あり / **同一 repo を統合する主体が engine のみ**(手動統合と併走しない — 03 章 §4-8)。
3. 観測(到達の定義): autoMerge armed のまま **7 日間**、(a) needs-human 凍結ゼロ、(b) 二重統合・force push ゼロ(そもそも機構が never force — swarmIntegrate.ts:251-301)、(c) 「done なのに review」残置が自己修復以外で発生しない(swarmOrchestrator.ts:5573-5579)。

**人間承認が必須で残る操作**(理想状態でも自動化しない境界 — これは到達目標ではなく**恒久の境界線**):

| 操作 | 理由(根拠) |
|---|---|
| release(公開リポへの push / GitHub Release publish) | outward + 一部不可逆。/release スキルの RED ZONE 手順が正典 |
| プロジェクト delete | フォルダ trash + 中央データ `rm -rf`(不可逆 — server/routes/project.ts:712) |
| 使用可能モデル mask の変更 | オーナーの政策層(04 章 §0 — センサーは C 層に書けない設計) |
| `none-allowed` park の解除 | 時計が無い hold — 人間が ON に戻すまで永遠(swarmAllowedModels.ts:120-121) |
| self-supply カードの dispatch 承認 | `selfSupplyApproved` ゲート(swarmOrchestrator.ts:599)— エンジン自案の自走を防ぐ |
| escalation の answer | 回答は you-corpus に学習される(swarmEscalations.ts:702-717)— 適当な answer は proxy-you を汚す(06 章 §5.3)。掃除は dismiss |
| `[hold]` 指定カードの統合 | 心拍 prefix による承認待ち規約(/order スキル §6)— 司令塔は自動マージしない |
| force-push / `git stash` | 全面禁止(機構も never force。CLAUDE.md の git discipline) |

### 現状とのギャップ

- §2 の実装(`3129a58`)で「小 diff 限定」の制約は撤廃され、§1 の実装(`0d1f7f0`)で「arm 中の monitor 空白(panel が pass を握る)」も解消された — integrate は tick の脇で走り、panel/verify 中も monitor は回る(03 章 §2.1/§2.4)。残るのは **§1・§2 とも実運用実測がゼロ**なこと(◐ → ✓ の壁)。
- `autoMerge` は in-memory・再起動で OFF(swarmOrchestrator.ts:1350)— 「常時」を実現するには再起動後の再 arm 運用(または永続化の設計判断)も必要。これは §1・§2 の実測が揃った後に改めて起票する(今のカード無し)。

### 対応カード

§1(`4d1550d7` done)と §2(`58335c7f` done)の**実運用検証**に従属(カード無し — 到達判定の実測のみ)。両者が揃った後、「autoMerge 永続化(再起動を跨ぐ arm)の是非」を独立カードとして起票するのが順序。

### 到達判定コマンド

```bash
# arm 状態と直近の統合結果・凍結の有無を 1 コマンドで
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq '{autoMerge, reviews, log: [.log[] | select(.message | test("integrated|needs-human|差し戻し"))] | .[-10:]}'
```

---

## 6. 司令塔ドキュメントが変更に追随する仕組み

### 理想(観測可能条件)

- swarm コアを変更する**すべての**カードが、完了条件に「`docs/commander/` 該当章の更新(更新不要ならその明示判断)」を含む。対象パスの目安は verify の swarm-safety ゲートが監視する集合と同じ(`SWARM_CODE_PATHS` — swarmOrchestrator.ts:2636-2641)+ `server/routes/swarm.ts` / `server/routes/project.ts`。
- 各章冒頭の「対象コミット」と origin/main tip の乖離が、司令塔の定型チェック(00-INDEX §6-1 のワンライナー)で**セッション開始時に**検知される。
- 観測: swarm コアの .ts に触れた main コミットの後、docs/commander/ の該当章が同時(または直後のカード)に更新されている — `git log` で対応が追える。

### 現状とのギャップ

- **検知2点は実装済み**(本改訂・カード「docs 追随の仕組み化(後段)」):
  1. **verify soft-warn** — `makeVerify`(swarmOrchestrator.ts:2906 付近)が `SWARM_CODE_PATHS` 相当(`touchesSwarmPaths`)に触れつつ `docs/commander/` 無変更の diff を検知すると `verdict.docsWarning` を立て、`runIntegratePass` がそれを engine journal に `warn` 1 行(`swarm code changed without a docs/commander/ update: <branch>`)として記録する。**block はしない**(`ok` には一切影響しない — 統合は通常どおり進む)。テスト: `swarmOrchestrator.integration.test.ts` の `docs-freshness soft-warn: ...` 2 件(docs 無変更 → warn あり / docs 更新あり → warn 無し)。
  2. **og-manage 起動時チェック** — `skills/og-manage/SKILL.md` の「前提・環境確認」に、00-INDEX §6-1 の乖離チェック(対象コミットと origin/main tip の diff --stat)をセッション開始手順として追記済み。
- **未実装のまま残る**: (1) 補給官(/supply)・/order のカード起票テンプレへの強制組み込み(「swarm コア変更なら完了条件に docs/commander 更新を含める」)。これは運用ルールであり、コード側の検知2点だけでは「docs 更新を忘れたカードが journal に warn を残したまま気づかれず放置される」ケースを防げない — journal は 200 行 ring buffer で再起動で消える(00-INDEX §7 参照)ため、司令塔が能動的に journal を確認しない限り warn は揮発する。

### 対応カード

案 B の検知2点(上記)は本改訂で完了。残るテンプレ組込みは**新カード案 B'**(起票する場合の下書き):

> **タイトル**: [docs/commander] カード起票テンプレへの文書追随ルール組み込み
> **notes**: 補給官(/supply)と /order のカード起票テンプレに「`SWARM_CODE_PATHS` 相当(swarmOrchestrator / swarmWorker / swarmQuota / swarmAllowedModels / swarmLaunch / swarmIntegrate / swarmOverseer* / swarmEscalations / swarmNotifications / swarmWorkerRegistry / swarmJanitor / routes/swarm / routes/project)に触れる場合、完了条件に docs/commander/ 該当章の更新を含める」を追記する。完了条件: テンプレの変更が main に入り、以後の swarm コア変更カード 1 件で運用が実際に回った実績。

### 到達判定コマンド

```bash
# swarm コアに触れた直近コミットと docs/commander の更新が対応しているか
git -C ~/projects/OPEN\ GROUND log --oneline -15 -- src/lib/server/swarmOrchestrator.ts src/lib/server/swarmWorker.ts src/lib/server/swarmQuota.ts server/routes/swarm.ts
git -C ~/projects/OPEN\ GROUND log --oneline -15 -- docs/commander/
# 前者に新規行があるのに後者が止まっていたら追随が切れている

# verify soft-warn の検知ロジックを単体で確認(swarm コア変更 + docs/commander 無変更 → 実カードで journal warn を観測)
npx vitest run src/lib/server/swarmOrchestrator.integration.test.ts -t "docs-freshness soft-warn"
```

---

## 7. 全体の到達判定(チェックリスト)

到達 = 以下がすべて ✓(各項の判定コマンドで機械的に確認できる):

- [ ] §1: limit 表示 → journal 検知が 2 分以内(実事象またはテストで確認)— **実装 main 入り(`0d1f7f0`)・実測待ち**
- [ ] §2: 34KB 超 diff が must-fix ゼロなら統合到達・棄権に理由が残る — **実装 main 入り(`3129a58`)・実測待ち**
- [ ] §3: overseer re-arm で過去 fatal からの新規 escalation ゼロ — **実装 main 入り(`d8431c3`+`aa9cb8d`)・実測待ち**
- [ ] §4: エンジン worker の API `heartbeatAt` がディスク `updatedAt` と一致 — **実装 worker ブランチ済み(未 main 統合)・実測待ち**
- [ ] §5: autoMerge armed 7 日間で凍結ゼロ・二重統合ゼロ(§1・§2 の実測後に計測開始)
- [ ] §6: swarm コア変更カードに文書更新が組み込まれ、実績 1 件以上 — 手動追随の実績 1 件あり(本改訂 = §2/§3 の docs 反映)。**仕組み**(テンプレ組み込み)は未着手

**未到達の間の司令塔の構え**(各章の運用節の要約): 最初の実枯渇イベントで検知 2 分を実測し、それまで journal の沈黙を無実と読まない(§1)・大 diff の最初の数枚は engine log を見届け、凍結したら abstainSummary を読む(§2)・S3/S10 は実発生として裏取り、増殖パターンを見たら回帰を疑う(§3)・鮮度はディスク(§4)・arm 実測は §1・§2 の初回観測とセットで(§5)・セッション開始時に文書鮮度チェック(§6)。
