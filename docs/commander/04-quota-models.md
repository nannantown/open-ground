# 04 — Quota・冷却・使用可能モデル mask(三層モデル)

**対象コミット: `cc7c60e`**(使用可能モデル mask は `d1485ea`(2026-07-09 18:05 +0900)で main 入り)
**読者: 将来の司令塔(og-manage)セッション。** モデル枯渇まわりで誤診しないための正確な機構文書。全主張に file:line の根拠を付す。行番号は上記コミット時点のもの — ズレたら §10 の grep で自分で裏取りすること。
> **部分更新(2026-07-10)**: `0d1f7f0` が**検知 21 分遅延の 3 因子(§3.2 沈黙ゲート / §3.3 装飾再描画 / §3.6 monitor 飢餓)をすべて根治**した — 各節に注記済み、§4 の実測は歴史(照合点)として保持。根治後の機構と到達判定は TARGET-STATE §1 が正典(0d1f7f0 基準の行番号つき)。層 A/B/C の三層モデル自体と §5 以降の park/mask 機構は不変。swarmOrchestrator.ts の行番号は :355 以降 +38〜+381 シフト(00-INDEX 冒頭)。
> **部分更新(2026-07-13)**: **層A(冷却テーブル)が永続化された** — `~/.openground/swarm-quota.json` にミラーされ、**再起動・self-update を生き延びる**(§2.1.1 が正典。§0 の表・§2.1/2.2/2.5/2.6・§8-2・§10 を追随)。それまでは in-memory のみで、再起動のたびに「fable で1セッション焼いて limit 画面を見て初めて学ぶ」を繰り返していた(0.11.25 実測。再起動はたいていリリース直後なので毎リリース再発)。**「再起動後は冷却が空なのが正常」という旧知識は捨てること**(§8-2)。手動 cool/uncool の **200 は「ディスクに載った」を意味する**(載らなければ 500 — §2.1.1)。層 B/C/D と三層モデル自体は不変 — 冷却が**期限で自動復活する**性質も不変なので、恒久指定は今も mask(§5.1 注)。
> **部分更新(2026-07-12)**: `swarmLaunch.ts` に**層D — 使用状況キャッシュ(claudeUsageCli/「A5」)による PRE-LAUNCH veto**が追加された(§5.7)。層A(冷却)は**起動して rate-limit を実際に食らって初めて**学習する事後学習(reactive)だが、A5 の `/usage` スクレイプは UsageHud がとっくに「枠は 100%」と知っている状態を起動前から握っていることがある — その既知の枯渇を**起動判断そのもの**に使うのが層D。層 A/B/C とは独立(fail-open・trailing/gray-zone は無視)で、行番号はこの節時点の `swarmLaunch.ts` 現物 grep で裏取りすること(§10)。
> **⛔ 訂正(2026-07-13 実測)**: 層Dが観測できるのは **account-wide の枠(session / week-all)だけ**。`/usage`(claude 2.1.207)は **per-model 行を出さない**(プレースホルダに置き換わっている)ので、**fable だけが枯れた状態は層Dでは検知できない**。「A5 を見れば起動前に fable 枯渇が分かる」は**誤り** — 唯一確実な信号は `claude --model fable -p …` の拒否文字列。§5.7 冒頭の ⛔ ボックスを必ず読むこと。**層A(上の永続化)と混同しないこと**: 冷却は**再起動を生き延びる**が、それは**一度 limit を食らって学んだ後**の話。層Dが塞ぐはずだった「学ぶ前に避ける」は fable 単独枯渇では**依然できない**。
> **部分更新(2026-07-13・同日)**: 上の穴を塞ぐ**層E — 起動前プローブ(swarmTierProbe.ts)**が入った(§5.8 が正典)。spawn が tier を決める直前、その tier が**未知**(冷却マーク無し・usage veto 不発火)なら、headless の `claude --model <tier> -p … --strict-mcp-config` を**1発だけ**叩いて CLI 自身の**クォータ拒否文字列**を読む — 壁なら `markRateLimited`(層Aと同じ書込経路・ディスクミラー)で冷やして梯子を1段下げ、応答すれば起動、**分からなければ fail-open**(desired のまま起動)。⚠ プローブは速くない(健全 tier 実測 19〜73s)ため **launch がブロックされるのは最大 8s** — 窓内に判定が来なければ fail-open で起動し、プローブは detached で完走して**次の launch から効く**。全 spawn 経路(worker / manager / supply / overseer / brain / reviewer panel)が probed リゾルバ経由になった。**「fable 単独枯渇は起動前に分からない」という上の知識は「層Eがプローブで検知する(遅くとも2回目の launch までに)」に更新**(/usage で分からないのは不変 — 分かる手段がプローブに変わった)。

---

## 0. 三層を1枚で

「fable が枯れた」に対して OG には**独立した3つの層**がある。混同すると誤診する。

| 層 | 実体 | 在処 | 寿命 | 役割 |
|---|---|---|---|---|
| **A. 冷却テーブル**(センサーの記憶) | tier → 解禁時刻(epoch ms)の Map | `globalThis.__openground_swarm_quota`(`src/lib/server/swarmQuota.ts:83-108`)+ **ディスクミラー `~/.openground/swarm-quota.json`**(swarmQuotaStore.ts、2026-07-13) | **永続。再起動・self-update を生き延びる**(起動時に hydrate、swarmQuota.ts:260-261)。tsx watch リロードも生存 | 「この tier は今冷えている」を記憶。期限で**勝手に復活**(lazy expiry、swarmQuota.ts:450-453)。**期限切れ mark は起動時に捨てられる**(同じ意味論) |
| **B. rate-limit 検知**(センサーの目) | worker 画面/reviewer transcript のパターン監視 | `src/lib/server/swarmOrchestrator.ts`(worker arm: 4064-4115 / reviewer arm: 3522-3586) | エンジン稼働中のみ | limit 文言を見つけて A に書き込む(`markRateLimited`)。**唯一の自動書込経路** |
| **C. 使用可能モデル mask**(オーナーの政策) | tier → ON/OFF の永続スイッチ | `settings.json` の `Settings.swarmAllowedModels`(src/lib/types.ts:111-115)+ globalThis ミラー(`src/lib/server/swarmAllowedModels.ts:67-74`) | **永続。再起動・self-update を生き延びる** | 「この tier は使うな」を恒久指定。**期限で復活しない** |
| **D. 使用状況キャッシュ**(A5・pre-launch veto、2026-07-12) | `claude /usage` スクレイプの成功キャッシュ。live で中身が入るのは **account-wide の `session`/`weekAll` の pct だけ**(per-model 行 = `weekModels` はパーサ済みだが**現行 CLI が出さないので常に空 = dormant**、§5.7.2) | `globalThis.__openground_usage_cli_state`(`src/lib/server/claudeUsageCli.ts:102-121`)を `peekCachedUsage()`(:134-138)で同期 peek | in-memory・TTL 30分(CACHE_TTL_MS)・成功時のみキャッシュ。**再起動で消える**(層Aと違い永続化されていない) | **起動前**に「梯子の先頭は確定で 100% 枯渇」と分かっている場合だけ、`resolveAvailableTier` の梯子からトップ tier を除外する。層Aと違い**まだ一度も起動していない状態でも**効く。⛔ **ただしそれが分かるのは account-wide の枠が枯れたときだけ — fable 単独枯渇は検知できない**(§5.7 冒頭の ⛔ ボックス) |
| **E. 起動前プローブ**(2026-07-13) | 未知 tier への headless 1発 `claude --model <tier> -p 'reply with exactly: PROBE_OK' --strict-mcp-config`(中立 cwd)。**クォータ拒否文言**だけが壁(一時故障 529/500/backoff は unknown) | `src/lib/server/swarmTierProbe.ts`。ok/unknown 判定は `globalThis.__openground_swarm_tier_probe` に TTL 10分でキャッシュ、**壁は層Aに書く**(`markRateLimited` — 自前のテーブルを持たない) | 判定キャッシュは in-memory・TTL 10分。壁の記憶は層Aと同寿命(**永続**) | spawn の tier 決定直前、その tier が**未知**(冷却なし・usage veto 不発火・fresh 判定なし)のときだけ叩く。**fable 単独枯渇を起動前に検知できる唯一の層**。⚠ プローブは速くない(健全 tier 実測 19〜73s・壁の応答時間は**未計測**)ので **launch は最大 8s しか待たず fail-open** — プローブ自体は detached で完走(上限 90s)して結果を記録し、**次の launch から効く**(冷却は永続なので学習は1回)。boot 時にトップ tier を1回 detached で温める。同時起動はプローブ1回に collapse(§5.8) |

**合流点は1つ**: `isTierSpawnable = isTierAllowed AND !isTierCooling`(swarmAllowedModels.ts:97-101)。**A と C は独立した2つの拒否権**で、どちらか一方だけで tier を殺せる。cool 解除は OFF tier を復活させないし、ON に戻しても cooling は縮まない(swarmAllowedModels.ts:16-18)。層D はこの2つに**さらに独立して**重なる第3の拒否権だが、**トップ tier(梯子の先頭)にしか適用されない**(veto が boolean で、除外できるのが先頭段だけという構造上の制約 — §5.7.3)。**さらに live では、A5 が語れるのは account-wide の session/weekly % だけ**(現行 CLI が per-model 行を出さないため — §5.7.2)。⇒ **層Dは fable 単独枯渇を検知できない** — それを起動前に検知するのは**層E(起動前プローブ、§5.8)**。層Eは拒否権ではなく**センサー**: 自前の veto を持たず、見つけた壁を**層Aに書いて**(markRateLimited)梯子を下げさせる。分からなければ何も書かない(fail-open)。

tier の梯子は `SWARM_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku']`(src/lib/types.ts:2173、best→cheapest)。swarmQuota の `MODEL_TIER_LADDER` はこれの alias(swarmQuota.ts:66)。4 alias とも 2026-07-06 に CLI 実機検証済み(swarmQuota.ts:41-47)。

---

## 1. 構造 — 何がどこにあるか

| ファイル | 役割 | 主要 export |
|---|---|---|
| `src/lib/server/swarmQuota.ts` | 層A。純粋関数+globalThis テーブル(読みは同期)+ディスクミラーの配線。エンジンも usage センサーも import しない一方向依存(swarmQuota.ts:15-39) | `MODEL_TIER_LADDER`(66) / `markRateLimited`(402) / `markCoolingUntil`(385) / `clearCooling`(433) / `resolveCoolingUntil`(357) / `isTierCooling`(450) / `highestAvailableTier`(458) / `allCoolingUntil`(469) / `coolingSnapshot`(484) / `isModelTier`(441) / `MAX_MANUAL_COOLING_MS`(424) / **`ensureCoolingTableLoaded`(260、起動時 hydrate)** / **`flushQuotaPersist`(229、書込の排水+成否の報告)** / `QuotaPersistResult`(145) |
| `src/lib/server/swarmQuotaStore.ts` | 層Aの**永続化 seam**(2026-07-13 新規)。`paths` + `atomicWrite` + `types` しか import しない(swarmQuota を import すると循環するので tier 判定は `SWARM_MODEL_TIERS` から再導出、71) | `loadCoolingMarks`(81、**fail-safe** — 壊れていても `{}` を返し throw しない) / `saveCoolingMarks`(130、atomic+fsync・テーブル丸ごと置換) / `CoolingMarks`(49) |
| `src/lib/server/swarmAllowedModels.ts` | 層C(d1485ea 新規)。swarmQuota+types のみ import(swarmAllowedModels.ts:30-31) | `normalizeAllowedModels`(47) / `anyTierAllowed`(59) / `isTierSpawnable`(97) / `highestSpawnableTier`(106) / `highestAllowedTier`(114) / `spawnBlock`(132) / `NoAllowedModelTierError`(154) / `setAllowedModelTiersCache`(78) |
| `src/lib/server/swarmLaunch.ts` | 起動 tier の決定。A/C/D を読み、E を呼ぶ(自分では書かない) | `SWARM_LAUNCH_MODEL='fable'`(63) / `rowNamesTier`(行→tier 照合) / `isTopTierExhaustedByUsage`(層D) / `resolveAvailableTier`(279、probe-free の同期コア) / **`resolveAvailableTierProbed`(337、層E入り async walk — spawn 経路はこちら)** / `resolveSwarmModelEffort`(414、本番呼び出し元なし — テスト/将来の同期文脈用) / **`resolveSwarmModelEffortProbed`(440)** / `execModeMaxWorkers` |
| `src/lib/server/swarmTierProbe.ts` | **層E(2026-07-13 新規)**。未知 tier への headless 1発プローブ(launch は 8s 窓・本体は detached 完走)。swarmQuota(層A書込)+ swarmRateLimitText(quota 拒否文言)+ claudeConnection(preflight 済み bin + boot warm-up の preflight)のみ import — engine を import しない一方向依存 | `ensureTierProbed`(338、唯一の入口) / `classifyProbeOutput`(145、pure 判定 — quota 拒否のみ wall) / `warmTierProbeAtBoot`(377、boot の detached 温め) / `TIER_PROBE_LAUNCH_WAIT_MS=8s`(95) / `TIER_PROBE_TIMEOUT_MS=90s`(84) / `TIER_PROBE_RESULT_TTL_MS=10min`(105) / `TIER_PROBE_PROMPT`(110) / `__resetTierProbeForTest`(400) |
| `src/lib/server/swarmRateLimitText.ts` | **limit 文言検出の pure 抽出**(2026-07-13)。層B用の広い全集合と、層E用の**クォータ拒否だけの部分集合**を並置(消費者ごとに false positive の極性が違う — §5.8.2.1。engine から verbatim 移設・probe→engine の import 循環回避)。orchestrator は再export で旧パス互換 | `RATE_LIMIT_PATTERNS`(36、層B用・広い) / **`QUOTA_EXHAUSTION_PATTERNS`(94、層E用・拒否5本のみ)** / `normalizeScreen`(17) / `matchesRateLimit`(72) / `matchesQuotaExhaustion`(103) / `endsInRateLimit`(107) / `RATE_LIMIT_TAIL_MAX` |
| `src/lib/server/swarmOrchestrator.ts` | 層B(検知)+park(ACTUATOR)。`markRateLimited` の生産呼出は worker arm と reviewer arm の2箇所だけ(+層Eのプローブが第3の書込呼出元 — §2.2 注) | `classifyOutput` / `STALL_SILENCE_MS` / `RATE_LIMIT_GRACE_MS` / `describeSpawnBlock`(`RATE_LIMIT_PATTERNS`/`endsInRateLimit` は swarmRateLimitText へ移設・ここから再export) |
| `server/routes/swarm.ts` | quota API 3本(ヘッダ一覧 swarm.ts:26-31) | `GET /api/swarm/quota`(880) / `POST /api/swarm/quota/cool`(894) / `POST /api/swarm/quota/uncool`(926) |
| `src/lib/server/store.ts` | mask の永続化と読出。**全OFF拒否の書込境界**(181-185) | `getAllowedModelTiers`(195-196) |
| `src/lib/server/claudeUsageCli.ts` | 層D。「A5」= CLI `/usage` スクレイプのキャッシュ。swarmLaunch.ts が読むのは `peekCachedUsage` のみ。**スクレイプ機構・watcher・TTL・完了判定は無改修**(2026-07-13 に per-model 行のパーサだけ追加 — 現行 CLI がその行を出さないので dormant。`drive()` の完了判定は §5.7.2.1 の「**触るな**」) | `peekCachedUsage`(134-138、TTL 内の最終**成功**スクレイプのみ返す) / `parseUsageOutput`(248) / `findModelWeeks`(226、dormant) / `CliUsage`(52-77、`session`/`weekAll`/`weekModels?`/`status`) |
| `src/lib/server/terminal.ts` | PTY プール。`lastOutputAt` の唯一のスタンプ箇所(297) | `WORKING_SILENCE_MS=3000`(21) |

spawn 経路(5+1)と fail-closed の実装箇所は §5.4。

---

## 2. 層A — 冷却テーブル(swarmQuota.ts)

### 2.1 データ構造と寿命

- 実体は `Map<ModelTier, number>`(tier → 解禁 epoch ms)1個だけ。`globalThis.__openground_swarm_quota` に常駐(swarmQuota.ts:83-108)。**読み取り API は全部同期**(`isTierCooling` / `highestAvailableTier`)— spawn 経路の同期リゾルバ(swarmAllowedModels.isTierSpawnable)から await 無しで呼ばれるため。この Map が読みの唯一の権威で、ディスクは**ミラー**。
- **expiry は lazy**: 読む側が `until <= now` を「利用可」と扱うだけで、タイマーも掃除も無い(swarmQuota.ts:450-453)。つまり「冷却が明ける」イベントは存在せず、次に誰かが読んだ瞬間に available になる。
- **再起動を生き延びる(2026-07-13 〜)**。以前は in-memory のみで、**再起動のたびに「fable で1セッション焼いて limit 画面を見て、そこでようやく学ぶ」**を繰り返していた(0.11.25 実測。再起動はたいていリリース直後なので毎リリース再発)。現在は下記の永続化で塞がれている。

#### 2.1.1 永続化 — 在処・失効・fail-safe(2026-07-13)

| 項目 | 現物 |
|---|---|
| **在処** | `~/.openground/swarm-quota.json`(`paths.ts:45` `swarmQuotaFile()`)。形は `{"cooling": {"<tier>": <until epoch ms>}}`、梯子順・最大4エントリ。**ユーザーの repo には一切書かない**(central home store の原則どおり) |
| **なぜ settings.json 相乗りでないか** | ①`settings.json` は `projects`(= validateProjectPath の allowlist、セキュリティ境界)を持つ。冷却はエンジンの rate-limit センサーという**ホットパス**から書かれるので、境界ファイルの read-modify-write を毎 sighting 走らせるのは blast radius が無駄に大きい ②冷却は user preference ではなく app STATE(notifications.json を settings から出しているのと同じ規約)③**import 循環**: `store.ts → swarmAllowedModels.ts → swarmQuota.ts` が既にあるため、swarmQuota が store を import すると循環する(これが決定打) |
| **書込** | 3書込経路すべてが単一フライトの persist チェーンでミラー(swarmQuota.ts:200-227)。atomic + `fsync`(swarmQuotaStore.ts:130-133)。書込は**テーブル丸ごと置換**(read-modify-write しないので lost-update レースが無い) |
| **書込順序の掟(3つ)** | ①**ディスクを一度も見ていないテーブルは書かない**(swarmQuota.ts:202 `.then(loadedForWrite)`)。丸ごと置換なので、読込前に書くと file 側の他 tier を消す。ロードが蹴られていなければ**書込側が自分で蹴る**(:187、構造保証)②**後から着地したロードは、mutation が触った tier に手を出さない**(:248 の `touched` ガード)。「in-memory が勝つ」だけでは **uncool を巻き戻す** — 解除済み tier は map から消えていて「元々無い」と区別できないため、ロードが file から mark を読み戻してしまう ③テーブルの直列化は**チェーン内**で行う(:203)。呼出時点のスナップショットを書かない |
| **起動時 hydrate** | `ensureCoolingTableLoaded(now)`(swarmQuota.ts:260-261)。boot で kick(server/index.ts:70)、quota API 3本も応答前に await(swarm.ts:908 / 939 / 1000)。プロセス内 **1回だけ**読む(memoize) |
| **失効** | 読込時に `until <= now` の mark は**捨てる**(swarmQuota.ts:243-252)。`isTierCooling` と同じ lazy expiry なので、古いファイルが死んだ冷却を蘇らせることはない(冷やす方向に間違えない) |
| **fail-safe** | 読めない/壊れている/形が違う → **冷却なしで起動続行**(= 永続化前の挙動)+ ログ1行。**起動は止めない**(swarmQuotaStore.ts:81-127)。梯子に無い tier キーや非数値の `until` はその**エントリだけ** drop(推測で冷やさない) |
| **保証(200 は嘘をつかない)** | `POST /cool` / `/uncool` が **200 を返した ⇔ ディスクに載った**。書込に失敗したら **500** を返す(swarm.ts:966-977 / 1005-1016)。判定は `flushQuotaPersist()`(swarmQuota.ts:229-233)が返す `persisted`。**エンジンのセンサー経路(`markRateLimited`)は書込失敗を握り潰したままで正しい** — 再学習できる mark のために cockpit を落とさない。手動 cool は逆で、**再起動を跨いで残ることが存在意義**なので握り潰してはならない |
| **書込失敗時の挙動** | mark は**メモリには載ったまま**(ロールバックしない — 動いているエンジンにはその tier を避けさせる)。失われたのは永続性だけで、500 の本文がそう言う。次の書込が成功すれば file は丸ごと最新になり、失敗記録も消える |

### 2.2 書込は4経路のみ(すべてディスクにミラーされる)

| 経路 | 関数 | 呼出箇所 |
|---|---|---|
| 自動(worker arm) | `markRateLimited` | swarmOrchestrator.ts(worker arm の QUOTA SENSOR) |
| 自動(reviewer arm) | `markRateLimited` | swarmOrchestrator.ts(makeAdversarialReview 内) |
| **自動(層E 起動前プローブ、2026-07-13)** | `markRateLimited` | swarmTierProbe.ts(`ensureTierProbed` — プローブが壁を確認したときだけ。§5.8) |
| 手動 API | `markCoolingUntil` / `clearCooling` | server/routes/swarm.ts(cool / uncool) |

mutation 3関数とも `markTouched()` + `schedulePersist()` を呼ぶ(swarmQuota.ts:385-389 / 411-416 / 433-437)ので、**どの呼出元から書いてもミラーされる**。**5本目の呼出元を足すのは自由だが、mutation 関数を経由しない直接書込は禁止** — ミラーを忘れた mutation は「次の再起動で黙って消える mark」になり、これはまさに永続化が塞いだバグそのもの。`clearCooling`(uncool)も**削除がミラーされる** — でないと起動 hydrate が、オーナーが解除したばかりの mark を律儀に読み戻してしまう。

### 2.3 markRateLimited の上書き挙動 — **newest wins(max() ではない)**

`state.cooling.set(tier, until)` の単純上書き(swarmQuota.ts:387, 413)。コメントも明言:「A later mark for the same tier overwrites (the newest signal wins)」(swarmQuota.ts:383-384)。

**司令塔への含意**: 手動で `cool fable 7日` を打った後にセンサーが同じ tier で再 sighting すると、センサーの解決値(最悪 20分 grace)で**上書きされて縮む**。長期間殺したいなら層C(mask OFF)を使うこと(§7)。

### 2.4 resolveCoolingUntil — 解禁時刻の3情報源(優先順)

swarmQuota.ts:357-372。上から順に試し、**過去時刻は無視して次へ落ちる**(366, 369):

1. **PTY 文言**(最優先・最具体): `extractPtyResetUntil`(326-348)が worker 画面から「resets in 5 minutes」「limit resets at 3pm」等を parse。相対形→絶対形の順。ラベル parse 本体は `parseResetLabel`(283-318): ①相対 "in N unit" ②裸時計 "3pm"(過ぎていれば翌日)③絶対日付(TZ suffix と " at " を除去して Date.parse)。
2. **A5**(CLI usage センサーのキャッシュ値): 呼出側が `a5CoolingHint()` で渡す(swarmOrchestrator.ts:4098, 3574)。**pct >= 100 ゲート付き** — A5 の `resetsAt` は 3% 使用時でも常時表示される「現ウィンドウの終端」なので、その slot が実際に**枯れている**(session.pct>=100、次いで weekAll.pct>=100)ときだけ信用する(swarmOrchestrator.ts:1223-1238)。ゲートが無いと、一過性 429/5xx への RATE_LIMIT_PATTERNS ヒットで健全 tier を最長 ~5h 冷やしてしまう(0708 must-fix 差し戻しの教訓、1227-1230)。両 slot 枯れなら先に評価される session(=より早い reset)が勝つ(1230-1232, 1235-1236)。
3. **フラット grace**: `now + graceMs`(371)。エンジンは `RATE_LIMIT_GRACE_MS` を渡す(swarmOrchestrator.ts:4099, 3575)。

`RATE_LIMIT_GRACE_MS` = **20分が既定**。env `OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN` で 2〜360分に調整可、ただし `MAX_EXEC_MS - 60s` で強制クランプ(暴走 park より先に requeue する band-inversion 防御。swarmOrchestrator.ts:365-373)。swarmQuota 側の `DEFAULT_COOLING_GRACE_MS`(73)は同値 20分のローカル既定(import 循環回避のための重複、68-72)。**この grace の間に流れた時間は worker の実行時間に算入されない**(§3.4-6 — hold 台帳で控除される)。

### 2.5 手動 cool / uncool API

- `POST /api/swarm/quota/cool` body `{tier, untilMs}` または `{tier, minutes}`(server/routes/swarm.ts:921-978)。検証: tier は `isModelTier` で梯子照合(930-932、未知 alias は 400 = 推測で冷やさない fail-closed)、`until` は `(now, now + MAX_MANUAL_COOLING_MS]` 必須(948-951)。
- `MAX_MANUAL_COOLING_MS` = **7日**(swarmQuota.ts:424)。週次 quota より長く、忘れた cool が自己治癒する上限。
- `POST /api/swarm/quota/uncool` body `{tier}`(983-1017)→ `clearCooling`(swarmQuota.ts:433-437、idempotent)。センサー製・手動製どちらの mark も消せる。誤検知(一過性 5xx を枯渇と誤読)の脱出口。
- 3本とも **owner gate**: `getCustomTabRole() !== 'owner'` なら 403(900, 922, 984)。
- **3本とも永続化を経由する**(§2.1.1): GET/cool/uncool は応答前に `ensureCoolingTableLoaded` を await(908 / 939 / 1000)、cool/uncool はさらに `flushQuotaPersist` を await する(966 / 1005)。
- **200 は嘘をつかない**: 書込に失敗したら **500**(966-977 / 1005-1016)。`/cool` の 200 = ディスクに載った、`/uncool` の 200 = ディスクから消えた。500 のときは **mark はメモリには効いている**(このプロセスのエンジンは tier を避ける)が**再起動で消える** — 本文がそう言う。`/uncool` の 500 はさらに危険で、**古い mark が file に残っているので再起動すると tier が cooling に戻る**。500 を見たら §10 の書込先チェック(権限 / ディスク残量 / `swarm-quota.json` がディレクトリになっていないか)。

### 2.6 GET /api/swarm/quota の読み方 — mask 盲目に注意

レスポンス `SwarmQuotaResponse`(src/lib/types.ts:2228-2245)= `quotaSnapshot`(server/routes/swarm.ts:128-133):

| フィールド | 意味 | mask を見るか |
|---|---|---|
| `now` | サーバ時刻(cooling 判定の基準) | — |
| `tiers[]` | 梯子4段の `{tier, cooling, until}`。`until` 非 null ⇔ `cooling:true`(lazy expiry 済み、types.ts:2218-2226) | **見ない**(生の冷却テーブル) |
| `launchTier` | 次の top-tier 起動が実際に解決される tier = `highestSpawnableTier`(131) | **見る**(唯一 mask を考慮) |
| `allCoolingUntil` | **全 tier** cooling のときのみ最早 reset(swarmQuota.ts:469-477) | **見ない** |

`tiers` / `allCoolingUntil` が mask 盲目なのは仕様(この endpoint は冷却の操縦面で、cool/uncool はここに見えるものへ作用する。swarm.ts:121-123)。**「fable が cooling:false だから打てる」は誤読** — fable が mask OFF なら launchTier は opus になる。**真実は launchTier だけ**(swarm.ts:124-127)。

**再起動直後の GET も信じてよい**(2026-07-13〜)。以前はここが最も危険な嘘で、再起動後の `cooling:false` は「冷えていない」ではなく「**忘れた**」の意味だった。今は GET が応答前に永続テーブルを hydrate する(§2.1.1)ので、再起動後の1発目から前日の冷却が見える。

---

## 3. 層B — rate-limit 検知経路(swarmOrchestrator.ts)

### 3.1 RATE_LIMIT_PATTERNS

> **移設(2026-07-13)**: パターン本体と正規化・判定関数(`normalizeScreen` / `RATE_LIMIT_PATTERNS` / `matchesRateLimit` / `RATE_LIMIT_TAIL_MAX` / `endsInRateLimit`)は `src/lib/server/swarmRateLimitText.ts` に **verbatim 抽出**された — 層Eのプローブ(swarmTierProbe)が**同じ文言検出**を共有するため(engine を import すると循環・コピーすると CLI の文言変更で乖離)。swarmOrchestrator は同名を**再export**しているので既存の import パス・テストは不変。以下のパターン解説は抽出後も内容そのまま(行番号だけ swarmRateLimitText.ts 側に移動 — §10 の grep で裏取り)。

正規化(ANSI 除去+空白畳み+小文字化、`normalizeScreen`)済みテキストに対する regex 群:

- 汎用(8本): `/usage limit/`・`/limit (?:will )?reset/`・`/\boverloaded_error\b/`・`/\brate_limit_error\b/`・`/api error…(429|500|503|529|overloaded)/`・`/\b(?:429|529)\b…\boverloaded\b/`・`/too many requests/`・`/retrying in \d+…/`(1124-1131)
- **per-model 枯渇通知**(2026-07-09 の実事故で追加。当時「You've reached your Fable 5 limit.」がどのパターンにも当たらず、センサー無発火→fable 冷えず→dispatch が枯れ tier に再突入し続けた — 1132-1141): `/reached your .{0,40}\blimit\b/`(1141)
- **修飾語付き limit reached**: `/\b(?:\d+[\w.-]*|usage|model|session|weekly|your)\s+limit reached\b/`(1142-1148)。裸の `/limit reached/` にしないのは「connection limit reached」「buffer limit reached」や worker が書くソースコードで健全 tier を20分冷やさないため(1143-1146)。
- 通知の対処文言 2 本: `/switch models with \/model\b/`(1149)・`/\brun \/usage-credits\b/`(1150-1154)。TUI が文を箱端で折り返して断片しか画面に残らないケースに備え、3 フレーズ独立(1137-1139)。

誤検知(false positive)方向に寄せた設計 — 余分な grace を与えるだけで kill はしない安全側。false negative(本物の待機を reclaim)が危険側(1118-1122)。

### 3.2 classifyOutput は「沈黙10分ゲート」の内側でしか走らない(**`0d1f7f0` で過去の姿 — 歴史**)

- `classifyOutput(screen)`(1256-1266)自体は純関数: permission-wait → **rate-limited** → question → normal の順。
- しかし当時の monitor は **`stall.silentMs >= STALL_SILENCE_MS`(=10分、271)のときだけ** 画面を読んだ(4064-4071)。理由: limit/prompt らしきテキストを**出力し続けている** worker(この機構のコードをレビュー中の worker 等)を誤分類しない+busy worker 全員の毎 pass TUI スクレイプを避ける(4058-4063)。
- **含意: limit 表示から検知まで最低でも10分の沈黙が必要だった**。これがケーススタディ(§4)の原因①。
- **`0d1f7f0` 後**: 出力 45 秒沈黙でサンプリング(`RATE_LIMIT_SCRAPE_QUIET_MS`)+ spawn 初動(≤2 分)の limit は 45 秒継続・commit ゼロ・心拍なしの確認で **10 分を待たず早期認定**(`earlyLimitConfirmed` — 認定ゲートは 10 分沈黙との OR)。「出力が流れる worker は読まない」原則は不変。正典 = TARGET-STATE §1。

### 3.3 lastOutputAt は装飾再描画でもリセットされる(**`0d1f7f0` で読む側がクランプ — 歴史**)

- 沈黙時計の材料 `silentMs` は `classifyStall`(1047-1098)が計算: `activity = max(heartbeatAt, realOutput, startedAt)`(1072-1077)、`silentMs = now - activity`(1077)。
- `lastOutputAt` は terminal.ts の `proc.onData` で**あらゆる出力チャンクに無条件スタンプ**(terminal.ts:295-297)。claude TUI はトースト・スピナー等の**装飾再描画でも onData を発火**させるので、実質止まっている worker でも沈黙時計が巻き戻った。エンジン自身のコメントも「A bare CR makes a `claude` TUI repaint (stamping lastOutputAt)」と自認(swarmOrchestrator.ts:283-291)。
- echo 割引(1065-1071)は **nudge 後(count>0)の echo だけ**を除外する仕組みで、**平常時の装飾再描画には無力**(1069 の `count > 0` 条件)。→ ケーススタディ原因②。
- **`0d1f7f0` 後**: terminal.ts の無条件スタンプは残るが、**limit 文言が画面を占有している間は stall クロックの出力チャネルを文言出現時刻でクランプ**(`engine.limitScreen` + `stallLastOut`)— 文言保持中の repaint は chrome とみなす。心拍はクランプしない(打てる worker は働いている)。requeue は grace 経過に加え raw 沈黙 45 秒も要求。正典 = TARGET-STATE §1。

### 3.4 worker arm — 検知したら「hold → cool → 20分後 requeue」(hold 中の時間は実行時間から控除される)

monitor(`monitorWorkers`、dispatch pass の一部)にて、silent かつ `classifyOutput === 'rate-limited'` の worker:

1. 初回 sighting: `engine.rateLimited.set(terminalId, {since: now, holdSince: limitSince ?? now})`。`since` は **requeue クロック**(下記 4)の起点、`holdSince` は **hold 台帳**(下記 6)の起点で、後者は limit 文言が画面を掴んだ瞬間(`engine.limitScreen` の onset)まで遡る。
2. **QUOTA SENSOR**(冷却テーブルへの生産書込): `w.model` が梯子上の tier のときだけ `markRateLimited(tier, {ptyText: screen, a5ResetsAt: a5CoolingHint(), graceMs: RATE_LIMIT_GRACE_MS, now})`(4093-4101)。model 不明の worker は**何も mark しない**(推測で冷やさない、4090-4092)。`w.model` は spawn 時に `SpawnSwarmWorkerResponse.model` から記録される(4583、swarmWorker.ts:503、types.ts:1014-1019)。
3. hold: **nudge しない・reclaim しない**(Enter で limit は明けない/reclaim は成果ごと捨てて同じ壁に再突入するから。4073-4076)。journal に `worker rate/usage-limited — holding (no nudge; requeue after 20m) · tier fable cooling until …` と出る(4104-4108)。
4. `RATE_LIMIT_GRACE_MS` 経過後もまだ limited: slot を解放して card を 'todo' へ requeue(`recoverLost`)。**branch のコミットは保持** — 後の再挑戦が引き継ぐ。さらに **未コミットの作業も WIP コミットで保全される**(02 章 §6 — `commitWipBeforeTeardown`)。
5. 画面が normal に戻れば hold は**解除**され、`rateLimited` エントリはクリアされる。
6. **【2026-07-12 根治】hold していた時間は worker の実行時間から控除される。** 解除のたびに `endRateLimitHold`(swarmOrchestrator.ts:1963 — `engine.rateLimited` を落とす唯一の seam)が hold の長さを `engine.rateLimitHeldMs` に積み、runaway 判定は「実作業時間 = 通算 − hold 累計」で行う(`isRunaway` :1347 / `rateLimitHoldCredit` :1980)。**進行中の hold も実時間で控除**されるので、今まさに limit で凍っている worker が「長く生きているだけ」で暴走扱いされることはない。控除の上限は `HOLD_CREDIT_CAP_MS`(:352 = `MAX_EXEC_MS`)。

   **なぜ必要だったか(実測)**: 旧実装は runaway を wall-clock で測り、コードコメントも「rate-limit 待ちを含めて数える — band が広いから足りる」と明言していた。2026-07-12 にその前提が破れた: **quota 待ち 20 分 + 実作業 84 分 = 通算 104 分** → 90 分上限で強制回収 → 実装完了済み・未コミットの 15 ファイル(47KB)が worktree ごと消滅。**quota 待ちは worker の落ち度ではないので、worker の実行予算から引いてはならない。** 詳細 = 02 章 §5.5。

### 3.5 reviewer arm — パネル全滅を tier に帰属させる

monitor のセンサーは **worker 画面しか見ない**ので、レビューパネルが先に壁に突っ込むと「全員棄権→多数決つかず→defer 連発→needs-human、次のパネルも同じ枯れ tier」になる(3522-3526)。それを塞ぐのが `makeAdversarialReview` 内のセンサー(3540-3541, 3570-3586)。**独立2条件の AND** で健全 tier の誤冷却を防ぐ(3528-3539):

1. **誰も投票していない**(`anyVoted === false`)— 同 tier で並走した1人でも verdict を出せていたら、その tier は生きている証拠。
2. 棄権 transcript が **limit 通知で終わっている**(`endsInRateLimit`、1203-1221)— 含有では不十分(rate-limit コード自体をレビューすると文言が diff に引用される)。本物なら通知が最後の発話で、後続は入力箱チローム ≤ `RATE_LIMIT_TAIL_MAX` 800 文字だけ(1175-1196)。

成立したら `markRateLimited(panelModel, …)` して `decision:'defer'` + **`skippedForPark:true`**(3570-3586)。この flag は「エンジン都合の hold であってパネルの評決ではない」の印で、**`MAX_REVIEW_DEFERS`(3連、258)の streak に数えてはならない**(3001-3010) — 数えると park 明け後もパネルが再点火されない永久 needs-human に落ちる。

### 3.6 なぜ検知がさらに遅れたか — pass 構造(integrate による monitor 飢餓・**`0d1f7f0` で解消 — 歴史**)

- 当時のエンジンは `TICK_MS` 3秒間隔の setTimeout チェーン(190, 5691)で `runEnginePass` を回した: **dispatch pass(monitor 内包)→ integrate pass の直列**、全体を `passInFlight` が覆う(5593-5608, 5665-5666)。tick が来ても前 pass が生きていれば**即 bail**(5597)。
- integrate は 15秒 throttle(197, 4638)だが、走った pass は **card ごとに verify(tsc/test)+ 敵対レビューパネル(数分)を直列実行**する。コード自身が「a whole-pass hold well past DEFAULT_STALE_MS (10 min)」と自認(5129-5140)。self-supply スキャンを fire-and-forget 化した理由も同じ(「passInFlight is held for this whole body — so awaiting it froze dispatch AND the monitor」5646-5657)。
- **含意: integrate が重い間、monitor は1回も回らなかった = rate-limit 検知の時計はそもそも読まれない**。→ ケーススタディ原因③。
- **`0d1f7f0` 後**: integrate は self-supply と同型の fire-and-forget に(`kickIntegratePass` + `integrateInFlight`)。monitor は verify/panel 中も 3 秒 tick で回る。正典 = 03 章 §2.1/§2.4。

---

## 4. 実測ケーススタディ(2026-07-09)— 「4秒で表示、検知は21分30秒後」(**`0d1f7f0` で根治済み — 実測は回帰の照合点**)

**事象**: fable の枯渇時、worker 3体が spawn の約4秒後に「You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.」を表示して座り込んだ。エンジンの rate-limit 検知(=冷却 mark)はその **21分30秒後**。しかも当時は per-model 通知がどのパターンにも当たらず(§3.1)、grace 明けに requeue → **20分後にまた同じ壁**(swarmAllowedModels.ts:10-13 に「observed 2026-07-09: three workers seated on "You've reached your Fable 5 limit." for 21m30s, then again 20m later」と刻まれている)。

**原因は3つの合算**(当時。行番号は cc7c60e 基準 — **3 因子とも `0d1f7f0` で根治**、対応は §3.2/3.3/3.6 の各注記と TARGET-STATE §1):

| # | 原因 | 現行コードの根拠 |
|---|---|---|
| ① | **沈黙10分ゲート** — 表示から最低 `STALL_SILENCE_MS`(10分)沈黙するまで classifyOutput が走らない | swarmOrchestrator.ts:271, 4064 |
| ② | **装飾再描画で沈黙時計が後退** — limit 表示後もトースト等の repaint が `lastOutputAt` を無条件更新し、silentMs が10分に届かない | terminal.ts:295-297、swarmOrchestrator.ts:1072-1077(echo 割引は nudge 後限定: 1069) |
| ③ | **integrate pass が monitor を飢餓させる** — 多分パネル/verify を抱えた pass が passInFlight を握り、monitor 自体が回らない | swarmOrchestrator.ts:5597-5608, 5129-5140, 5652-5654 |

**現状(2026-07-10 更新)**: パターン欠落は同日中に修正済み(per-model 3 フレーズ追加、cc7c60e 基準 1132-1154)+ 層C(mask)が「オーナーが既知の枯渇を恒久指定する」経路として追加された(d1485ea)。**①②③の構造も `0d1f7f0` で根治** — 45 秒サンプリング+spawn 直後早期認定(①)、limit 画面クロックによる出力チャネルのクランプ(②)、integrate の tick 分離(③)。カード **`4d1550d7` は done 列**。**本事例の型(spawn 直後の即死)は sighting→cooling 約 1.5 分の設計**(実測形 約 95 秒。稼働後の limit は実クロック化した 10 分ゲート — §3.2)— 実運用での初回実測が残タスク(TARGET-STATE §1 の到達判定)。

**司令塔への教訓(更新)**: 根治後も「journal に無い=枯れていない」ではない(ring 200 行+再起動で消える)。初回の実枯渇イベントでは検知 2 分の到達判定を実測し、疑わしければ従来どおり worker 画面と `/usage` を自分の目で確認、**手動 cool / mask を先に打つ**(§7)。この節の 21 分 30 秒という数字は、同型の遅延を再び観測したときの回帰照合点として残す。

---

## 5. 層C — 使用可能モデル mask(swarmAllowedModels.ts、d1485ea)

### 5.1 なぜ冷却テーブルと別層か

冷却は①globalThis 在住で再起動が忘れる、②勝手に期限切れして同じ壁へ再突入ループする(§4 の実測がまさにこれ)。オーナーが「fable は来週まで無い」と**知っている**ことをエンジンに伝える恒久チャネルが無かった(swarmAllowedModels.ts:4-18)。

> **注(2026-07-13)**: ①は解消済み — 冷却テーブルは永続化され、再起動を生き延びる(§2.1.1)。**それでも層Cは要る**: 冷却は②のとおり**期限で自動復活する**(lazy expiry)一方、mask は**期限で復活しない恒久指定**だから。「来週まで使うな」は今も mask の仕事(§7.2)。

### 5.2 読み書きの経路

- **正典は `settings.json`** の `swarmAllowedModels`(types.ts:111-115、`Partial<SwarmAllowedModels>`)。既定は全 ON(`DEFAULT_SWARM_ALLOWED_MODELS`、types.ts:2190-2195)。
- **normalizeAllowedModels は per-key fail-open**(swarmAllowedModels.ts:47-55): `src[tier] !== false` — **明示的 `false` だけが OFF**。キー欠落・typo・手壊れファイルは「使える」側に倒れる(モデルを黙って退役させない、40-46)。
- **書込境界は全OFF拒否**: `setUserSettings` が mask を正規化し、`anyTierAllowed` が false なら **キーごと落として旧 mask を生存させる**(store.ts:181-185)。API 面は `POST /api/settings`(server/routes/misc.ts:328-343、allowlist `USER_SETTINGS_KEYS` に `swarmAllowedModels` 含む: store.ts:147-155)。UI(Settings ▸ 使用可能モデル = `ExecutionModeToggle.tsx`)も最後の1個の OFF をブロック(store.ts:180 コメント)。手編集で settings.json を全OFFにした場合だけは parse としては合法で、swarm は**音を立てて park**する(escalation、§5.5)— 黙って書き戻されはしない(swarmAllowedModels.ts:43-46)。
- **globalThis ミラー** `__openground_swarm_allowed_models`(67-74): `getSettings()` が**毎読出で** `setAllowedModelTiersCache` を呼んで更新(store.ts:78, 111)。同期呼出(resolveAvailableTier の既定値)用の**後備え**であって第二の正典ではない(24-29)。await できる呼出側は必ず `getAllowedModelTiers()`(store.ts:195-196)の新鮮値を渡す契約。

### 5.3 判定関数群 — 独立2拒否権の AND

- `isTierSpawnable(tier, now, allowed) = isTierAllowed && !isTierCooling`(97-101)。**すべての起動 tier 決定はこの1述語を通る**。
- `highestSpawnableTier`(106-109): 梯子を best→cheapest に歩いて最初の spawnable。「fable OFF」は単に opus から歩き始めるのと同じ。
- `resolveAvailableTier(desired, now, allowed)`(swarmLaunch.ts:205-220)の契約:
  1. desired から**下へ**歩いて spawnable を探す(212-214)。未知モデル文字列は梯子先頭扱い(210-211)。
  2. 無ければ**上も含め**最良 spawnable(215-216)。
  3. それも無い(=何も spawnable でない): desired が **allowed なら** desired を返す(全部単に cooling のケース — どうせ park で spawn されない。217-218)。
  4. else 最良 **allowed** tier(219)— **OFF tier は最後の手段としても絶対返さない**(旧 `?? desired` がまさに OFF tier を返すバグで、d1485ea が塞いだ穴。196-198)。
  5. 全 tier OFF なら **null**(219→ `highestAllowedTier` が null)。
- `resolveSwarmModelEffort(mode, role, card?, now?, allowed?)`(257-267): 実行モード(max/economy/optimize)の希望 tier(`desiredModelEffort`、148-174)を resolveAvailableTier に通す。**null 契約: null が返ったら呼出側は spawn してはならない**(254-256)。effort はフォールバックで**不変**(model だけが quota に従う。239)。

### 5.4 全 spawn 経路の fail-closed(5+1経路)

| 経路 | 実装 | null 時の挙動 |
|---|---|---|
| worker | swarmWorker.ts:466-473 | `throw NoAllowedModelTierError`。**worktree 作成より前**に解決するので孤児 worktree/branch を残さない(460-465) |
| manager(司令官) | swarmManager.ts:192-199 | 同 throw。**session 解決(resume 判定)より後・record より前**に効くので、tier 全滅で spawn を拒んだときに「存在しない会話の session id」を永続化してしまうことはない(05 章 §10) |
| supply(補給官) | swarmSupply.ts:149-156 | 同 throw(同上) |
| reviewer panel | swarmOrchestrator.ts:3470-3501 | throw ではなく **defer**(3472-3481 park gate、3491-3500 `resolveAvailableTier` null → defer + `skippedForPark`)。「never merge un-reviewed」を守りつつ streak を焦がさない |
| overseer brain(大脳) | swarmOverseerBrain.ts:416-421 | `throw NoAllowedModelTierError`(runner が fail-closed → answerAsOwner が owner へ escalate)。ミラー読みだが直前に defaultOverseerDeps が settings を再読してミラーを更新(swarmOverseer.ts:316, brain 416-419 コメント) |
| engine dispatch(自動補給) | swarmOrchestrator.ts:4450-4461 | spawn せず **park**(§5.5) |

`NoAllowedModelTierError`(swarmAllowedModels.ts:154-162)は「OFF tier への fallback は存在しない。モデル無し=spawn 無し」の物言い。

### 5.5 spawnBlock と park(dispatch の門)

`spawnBlock(now, allowed)`(swarmAllowedModels.ts:132-148)が**1つの門**で2種の hold を返す:

- `{kind:'all-cooling', until}` — **enabled な** tier が全部 cooling。until はその中の最早 reset(OFF tier の reset は無関係 — fable OFF なら「opus+sonnet+haiku cooling」で full park。121-123, 139-147)。**自然解除**(lazy expiry)。
- `{kind:'none-allowed'}` — 全 tier OFF。**時計が無い** — 人間が ON に戻すまで永遠(120-121)。

エンジン側 actuator(runDispatchPass 3b、swarmOrchestrator.ts:4431-4467):

- park 中は **step 4(新規 spawn)だけ**止める。既存 worker・monitor・reconcile は無傷、todo カードは動かさず放置(4442-4445)。
- journal は **enter-edge のみ**(`spawnBlockSig`、4448-4460): `quota park: every enabled model tier is cooling until <ISO> — holding new dispatch` / `no model tier is enabled (Settings ▸ 使用可能モデル) — …`(文言は describeSpawnBlock 3421-3424)。解除時は `quota park lifted — a tier is usable, resuming dispatch`(4463-4466)。
- `none-allowed` は加えて **T3 escalation を1回 raise**(4459 → raiseNoAllowedModelTier 4342-4370)。
- dashboard 用に `engine.parkUntil`(cooling の期限のみ。1494-1500、GET /api/swarm/orchestrator のレスポンス types.ts:1360)と `spawnBlockSig`(両種を表せる。1501-1506)。
- review 再パネル点火も同じ門を per-card で通る(5047 — verify が数分走る間に park 状態が変わり得るため tick 冒頭でなく直前に評価)。

### 5.6 ⚠ 実行中のアプリに載るのは再ビルド後

d1485ea(2026-07-09 18:05 +0900)は **ソース**に入っただけ。本番(packaged .app / `npm run start`)の Hono+engine は **esbuild bundle `server/dist/index.cjs`** を fork して動く(CLAUDE.md「Bundled by esbuild … which Electron forks in prod」)。つまり:

- **`npm run build`(等)で bundle を再生成し、プロセスを再起動するまで、動いているアプリに mask は存在しない**。`GET /api/settings` に `swarmAllowedModels` を入れても旧 bundle のエンジンは読まない。
- dev(`npm run dev` = tsx watch)は即時反映。
- 判別ワンライナー: `grep -c swarmAllowedModels server/dist/index.cjs`(0 なら旧 bundle)。§10 参照。

---

## 5.7 層D — 使用状況キャッシュによる pre-launch veto(swarmLaunch.ts、2026-07-12)

> ## ⛔ 先に読め — **層Dは fable 単独枯渇を検知できない**(2026-07-13 実測確定)
>
> `/usage` は **fable 単独の枯渇を語らない**。だから層Dはそれを弾けない。**「層Dがあるから起動前に分かるはず」と思って /usage を睨むのは時間の無駄**であり、実際に 0713 はそれで誤診した。
>
> **壁の有無を今すぐ知る唯一確実な方法**(壁が立っていればトークン消費ゼロ。⚠ 応答時間: 健全 tier は実測 19〜73s かかる。**壁の拒否の速さは未計測** — 0713 に観測された拒否は速かったが、計測値として残っていない):
> ```bash
> claude --model fable -p 'reply with exactly: PROBE_OK'
> # → "You've reached your Fable 5 limit." が返れば壁が立っている(/usage は 3%/63% と言っていても)
> ```
> このプローブは **engine の起動前判定に組み込み済み**(2026-07-13、**層E = swarmTierProbe.ts、§5.8 が正典**)── spawn が tier を決める直前、その tier が未知なら engine 自身がこの1発を自動で叩き、壁なら冷却テーブルに記録して梯子を下げる。手で打つのは「エンジンの外で今すぐ知りたい」ときの検証手段として今も有効。層Dの per-model 読み(§5.7.2)は**配線済みだが入力が来ない dormant 状態**で、行が復活した日に自動で効く ── それだけ。

### 5.7.1 動機 — 層Aは事後学習、層Dは起動前に効く

層A(冷却テーブル)は `markRateLimited` が**唯一の書込元**(§2.2)で、これは**実際に起動して rate-limit 応答を受け取ってから**しか書けない(swarmOrchestrator.ts の worker arm / reviewer arm、両方とも「動いている worker/panel の画面を読んで」書く)。一方 `claudeUsageCli.ts`(「A5」、既に §2.4 で cooling の reset 時刻ソースとして使われている)は UsageHud が 60 秒おきにポーリングしているキャッシュで、**起動する前から** account-wide の枠(session / week-all)が 100% 枯渇している事実を握っていることがある。層Dはその既知の枯渇を**起動判断そのもの**(`resolveAvailableTier`)に接続する ── 「UsageHud には出ているのに swarm は知らずに起動を試みて詰まる」というギャップを塞ぐ。**ただし塞げるのは account-wide の枠が枯れたときだけ**(理由は §5.7.2)。

### 5.7.2 何の行を見るか — **live は account-wide 2行だけ**(2026-07-13 実測)

`claude /usage`(**2.1.207**)の live レンダを node-pty で取得して確認した結果 ── **出るのは2行だけ**:

> 行番号は **`087847d` 時点の実測**(この節のみ引き直し済み)。ズレたら §10 の grep で自分で裏取りすること。

| 行見出し | 意味 | `CliUsage` のスロット | live に出るか |
|---|---|---|---|
| `Current session` | アカウント全体のセッション枠 | `session`(claudeUsageCli.ts:53) | **出る** |
| `Current week (all models)` | アカウント全体の週次枠 | `weekAll`(:54) | **出る** |
| `Current week (<Model> only)` | その1モデルだけの週次枠 | `weekModels?`(:72、`CliUsageModelSlot`(:48)の配列 = `{ model, pct, resetsAt }`) | **❌ 出ない**(下記) |

**per-model 行の位置には、行の代わりにプレースホルダが出る**(2026-07-13 04:5xZ 実測):

```
Per-model breakdown unavailable (rate limited — try again in a moment)
r to retry
```

同レンダ中の `only` / `Fable` / `Sonnet` / `Haiku` の出現回数は**すべて 0**。同時刻に `claude --model fable -p …` は「You've reached your Fable 5 limit.」と拒否する ── **壁は立っているのに /usage はそれを一言も言わない**。

**⚠ 誤診の元凶(0713・司令官が踏んだ)**: `claudeUsageCli.parse.test.ts` の fixture には `Current week (Sonnet only)` が入っている。これは **claude 2.1.196 のキャプチャで、現行 CLI はこの行を出さない**。**fixture を「live にこの行がある」証拠として使ってはいけない**。「パーサが per-model 行を読み飛ばしていたから検知できない」という説明も**誤り** ── 読み飛ばしていたのではなく、**CLI がその行を出していない**。材料は最初から来ていない。

- ⇒ **`weekModels` は live では常に `[]`**。`isTopTierExhaustedByUsage` の per-model 分岐は**発火しない**。`resolveAvailableTier('fable')` は `'fable'` を返し続ける。**0713 の事故はこの層では止まらない**(止めるのは冒頭のプローブ方式 = **層E、§5.8 — 実装済み**)。
- パーサ(`findModelWeeks`、claudeUsageCli.ts:226-243)は**行が復活した日のために配線してある**だけ。**モデル名はハードコードしない**: どのモデルが自分の週次枠を持つかは plan / account 依存で、2.1.196 では `Sonnet only` だった。パーサは `Current week (<何か> only)` の `<何か>` を**そのまま**キャプチャする。`(all models)` は「only」で終わらないので取り違えない。プレースホルダ行も `Current week (` で始まらないのでマッチしない(テストで固定)。
- **1行とは限らない**ので配列(`weekModels?`)。healthy な `Opus only` の下に枯れた `Fable 5 only` が来る並びで「最初の1行だけ」を採ると、行が復活したときに**同じ穴を再生産する**。
- 空白落ち耐性は既存の `SECTION_BODY`(:187)を共有 ── `Currentweek(Fable5only)` / `100%used` でも取れる(§5.7.6 のテスト。ただし**すべて合成入力**)。

#### 5.7.2.1 既知の限界 — スクレイプ完了判定(**触るな**)

`drive()` の完了判定は `%used` の**出現回数**(`pctCount >= 3`、claudeUsageCli.ts:317-318。判定は `drive()` の `onData` 内 311-324)。**現行 CLI は2行しか出さないが、同じ画面を2回描画するので count が 4 に達して完了する**。

- ⚠ **「セクション見出しの種類数で数える」実装に変えてはいけない** ── 3種類目が永久に来ないので、スクレイプが**毎回 15s のハードタイムアウトまで待つ**重い退行になる(HUD が「読めない」に落ちる)。
- 既知の限界: **per-model 行が非同期で遅れて来る場合(プレースホルダの `r to retry` が示唆する)、この完了判定は行の到着前に snapshot しうる**。行が復活しても取り逃す可能性がある、という前提で扱うこと。

### 5.7.3 実装 — `isTopTierExhaustedByUsage` + `resolveAvailableTier` の第4引数

- `isTopTierExhaustedByUsage(usage: CliUsage | null): boolean`(swarmLaunch.ts:263-270)。**3読みの OR** ── ① `session.pct >= 100`、② `weekAll.pct >= 100`(この2つは account-wide なので全モデルを同時に止める。**live で実際に発火しうるのはこの2つだけ**)、③ `weekModels` の中に `SWARM_LAUNCH_MODEL`(現在 fable)を名指す行があって pct >= 100(**dormant ── 現行 CLI はその行を出さないので発火しない**、§5.7.2)。それ以外(null・95% 等のグレーゾーン・per-model 行なし)はすべて **false = 非枯渇扱い(fail-open)**。閾値はセンサーが既に使っている `a5CoolingHint`(swarmOrchestrator.ts:1298-1303)と同じ「pct>=100 ゲート」を踏襲 ── A5 の `resetsAt` は 3% 使用時でも常時表示される「現ウィンドウの終端」なので、**実際に枯れているとき以外は信用しない**という既存の設計原則をそのまま流用している。
- **行 → tier の突き合わせ**は `rowNamesTier`(swarmLaunch.ts:216-220)。ラベルは TUI が印字したまま(`Fable 5` / `Fable` / `fable` / 空白落ちした `Fable5`)なので、**非アルファベットで単語分割して一致を見る**(⇒ 大小文字・バージョン接尾辞・空白落ちすべてに耐える)。`Sonnet` が fable 段に化けることはない。
  - **限界**: 単語分割は**非英字を含む tier 名にマッチしない**(将来 `fable-5` / `opus-4-8` のようなエイリアスになったら、ラベルが `Fable 5` でも一致しない)。ただし外れる方向は **fail-open**(誤って veto しない)で、現在の梯子は全部英字 ── `SWARM_LAUNCH_MODEL === MODEL_TIER_LADDER[0] === 'fable'` を `swarmLaunch.test.ts:163-164` が固定している。**モデル名にハイフンや数字が入った日に、ここを見直すこと**。
- **per-model 行が「他 tier」のときは何もしない**(`Sonnet only` が 100% でも false)。この述語が答える問いは1つだけ ──「**梯子の先頭は枯れているか**」。`resolveAvailableTier` の veto が除外できるのは先頭段だけだからで、中段を自分の行で veto するには walk が boolean ではなく per-tier マスクを取る必要がある(未実装 = **既知の限界**。中段は層A(冷却)が事後的にカバーする)。
- `resolveAvailableTier(desired, now, allowed, usage = peekCachedUsage())`(swarmLaunch.ts:272-)。第4引数 `usage`(既定値は `peekCachedUsage()`(claudeUsageCli.ts:134-138)の同期 peek ── **起動のたびに `/usage` を live scrape することは絶対にしない**。TTL 内の最終成功キャッシュを読むだけ)。ladder walk 内部の `spawnable(tier)` 述語に `!(topTierExhausted && tier === MODEL_TIER_LADDER[0])` を足しただけ ── **梯子の先頭(fable)にしか適用されない**(上記のとおり)。
- `resolveSwarmModelEffort(mode, role, card?, now?, allowed?, usage = peekCachedUsage())`(swarmLaunch.ts:364-)。第6引数として同じ既定値でスルー渡し。**worker/manager/supply/overseer の全呼出箇所は無改修**(swarmWorker.ts / swarmManager.ts / swarmSupply.ts / swarmOverseer.ts はどこも `usage` を渡していない → 既定値経由で自動的に効く)。
- 層A・層Cとの合成は「梯子を歩く前にトップ tier を篩い落とす」だけなので、**冷却・mask と完全に独立して重なる**(例: 層Dでトップ tier 除外 + 層Aで opus も cooling → sonnet まで降りる。swarmLaunch.test.ts の「composes with cooling」ケースで確認済み)。

### 5.7.4 fail-open はどこまで残るか

**fail-open の契約は1ミリも狭めていない**。false(=枯渇していない扱い)になるのは:

| 状況 | 判定 | なぜ |
|---|---|---|
| キャッシュが無い / TTL 切れ(`usage === null`) | **false** | **cold cache は今も素通り** ── 起動時に ~9s の live scrape を焚かない方針は不変(cold の扱いはオーナー判断待ちで未着手) |
| **per-model 行が render に無い**(`weekModels` が `[]`) | **false** | **これが現行 CLI の常態**(§5.7.2)。層D 導入前と完全に同一挙動 |
| per-model 行はあるが 95%/99%(グレーゾーン) | **false** | 「まだ使えるはずの枠を事前に狩りすぎない」というオーナー確認済み方針。**100% だけ**が根拠(※ dormant) |
| per-model 行が他 tier(`Sonnet only` 100%) | **false** | 先頭段の話ではない(§5.7.3)(※ dormant) |
| スクレイプ失敗(`status: 'scrape-failed'`、全 slot null) | **false** | センサー不調で swarm を止めない |

⇒ **層Dが実際に true になるのは、温かいキャッシュの `session` か `weekAll` が 100% を明示しているときだけ**。「知らない」は常に「使える」に倒れる(層Cの fail-closed とは対照的)。**fable 単独枯渇はこの表のどの行にも当てはまらない ── そもそも入力が無い**。

### 5.7.5 何が違うか — 層Aと層Dの比較

| | 層A(冷却) | 層D(使用状況 pre-launch veto) |
|---|---|---|
| いつ学習するか | **起動して** rate-limit 応答を受け取ってから(reactive) | 起動する**前**、UsageHud と同じキャッシュを peek するだけ(proactive) |
| 対象 tier | 梯子の**どの tier でも**(w.model が分かれば) | **トップ tier(梯子の先頭)のみ**。veto が除外できるのが先頭段だけのため(構造上の制約)。**加えて live では account-wide の枯渇しか観測できない**(per-model 行が来ないので、実質「全モデル同時に枯れた」ときだけ効く) |
| 情報源 | PTY 画面の rate-limit 文言 / A5 の reset 時刻 / grace | A5 の pct ── **live で効くのは `session` / `weekAll` のみ**。`weekModels`(per-model 週次行)はパース済みだが **CLI が出さないので常に空 = dormant**(§5.7.2) |
| 閾値 | (時刻の話。pct 概念なし) | **pct >= 100 のみ**(95% 等では絶対に動かない ── 「まだ使えるはずの枠を事前に狩りすぎない」というオーナー確認済み方針) |
| 未知/取得不可のとき | mark 自体が起きない(何も変わらない) | `usage=null` → **false = 非枯渇扱い**(fail-open。層Cのfail-closedとは対照的) |
| **fable 単独枯渇** | **検知できる**(起動して拒否されれば `markRateLimited`。ただし1セッション焼く) | **検知できない**(§5.7.2。/usage が語らない)— 起動前に検知できるのは**層E(§5.8)だけ**(1発のプローブ・セッションを焼かない) |

### 5.7.6 テスト・裏取り

- **テストの入力はすべて合成**(`RAW` fixture を除く)。`claudeUsageCli.parse.test.ts` の `parseUsageOutput — per-model weekly rows (weekModels)`(:108-)は**行が復活した日の契約**をピン留めしているだけで、**live にその行がある証拠ではない**(ファイル冒頭の ⚠ に明記): 2.1.196 キャプチャの `Sonnet only` 行 / 合成の `Current week (Fable only)` 100% / 複数行(`Opus only` + `Fable 5 only`)/ 空白落ち。
- **今日の live 形は `LIVE SHAPE (claude 2.1.207)` ケースが固定**している ── 2行 + プレースホルダ ⇒ `weekModels: []`・`status:'ok'`。**`[]` が正常値**。
- `swarmLaunch.test.ts` の `isTopTierExhaustedByUsage — per-model weekly rows (dormant contract)`(:312-)が**行 → veto** をピン留め(表記ゆれ5種 / 他 tier は false / grayzone / healthy 行が先でも拾う)。end-to-end(`DORMANT:` 接頭辞つき)は `resolveAvailableTier / resolveSwarmModelEffort — usage-cache veto`(:374-)。`usage` は全テストで直接注入 ── globalThis キャッシュや node-pty spawn には触れない。
- ⚠ **ワンライナーの読み方(誤診注意)**:
  ```bash
  curl -s localhost:47776/api/usage | jq '.cli.weekModels'   # → [] が今日の正常値
  ```
  **`[]` を見て「旧 bundle だ」と再ビルドしても何も変わらない**(CLI がその行を出していないため)。§5.6 の再ビルド注意は**この項目には効かない**。壁の有無を知りたいなら **`/usage` ではなくプローブ**(§5.7 冒頭の ⛔ ボックス):
  ```bash
  claude --model fable -p 'reply with exactly: PROBE_OK'   # 拒否文字列が出れば壁
  ```
  live の /usage を自分の目で確認したいときは node-pty で `claude` を起こして `/usage` を打ち、`only` の出現回数を数える(0 なら per-model 行は来ていない)。

---

## 5.8 層E — 起動前プローブ(swarmTierProbe.ts、2026-07-13)

### 5.8.1 なぜこの層が要るか — /usage では fable 単独枯渇が原理的に見えない(実測)

2026-07-13 の実測(司令官が node-pty で live の `/usage` を取得):

- live の `/usage`(claude **2.1.207**)は `Current session` と `Current week (all models)` の**2行しか出さない**。per-model 行の位置には `Per-model breakdown unavailable (rate limited — try again in a moment) / r to retry` というプレースホルダが出る。実レンダ中の `only` / `Fable` / `Sonnet` / `Haiku` の出現回数は**すべて 0**(§5.7.2)。
- **その最中に** `claude --model fable -p 'reply with exactly: PROBE_OK'` は `You've reached your Fable 5 limit.` と拒否した。同時刻の /usage は session 8% / week-all 64%(**どちらも 100 未満**)。

⇒ **fable 単独の枯渇は /usage からは原理的に観測できない**(層Dの入力に存在しない)。起動前に壁を知る唯一の確実な信号は、その tier で実際に1発叩いて**CLI 自身の拒否文言を見る**こと。枯れている tier へのプローブは**トークンを消費しない**(⚠ 拒否が返るまでの時間は**未計測** — 執筆時点で fable は復活しており壁が無く、計測できない。「速いはず」を前提にしない)。層A(冷却)はこの壁を検知**できる**が、それは worker/panel を1体その壁に**突っ込ませてから**の事後学習 — 0713 に焼けたのは manager(司令官)経路で、まさに「学ぶ前に避ける」層が無かった。

方針(コウキ確認済み・7/12 の fail-open 方針は維持): 「分からないなら先回りで潰さない」はそのまま、「分からないまま突っ込む」を「**分かるまで待つ(=プローブして確かめる)**」に変える。待って見るのは /usage ではなく**直接プローブ**。

#### 5.8.1.1 プローブの所要時間(2026-07-13 実測 — 開発機・敵対レビューによる計測)

**`claude -p` は軽い ping ではなくエージェント1ターン**。健全 tier では応答生成まで走るので秒単位では返らない:

| 条件 | 実測 |
|---|---|
| fable・`--strict-mcp-config` 無し・cwd = OG repo | **45s 超**(打ち切り — repo の CLAUDE.md/skills/.mcp.json をフルロード) |
| fable・`--strict-mcp-config` 有り・cwd = OG repo | **72.9s**(rc=0) |
| haiku・cwd = OG repo(無し / 有り) | 23.7s / 9.6s |
| fable・cwd = /tmp・env 洗浄(最良条件) | **18.9s** |
| **枯れた tier の拒否** | **未計測**(執筆時点で壁が立っておらず計測不能。「拒否は速い」を設計の前提にしない) |

⇒ 健全 tier のプローブは **19〜73s**。この実測が §5.8.2 の設計(launch は 8s しか待たない・プローブは detached で完走・boot で温める)を決めている。当初実装の「timeout 20s で launch を同期ブロック」は**この実測で棄却された**(プローブが常に自分の timeout を超えて 'unknown' に落ち、層Eが inert になる)。

### 5.8.2 機構 — 「未知のときだけ1発・launch は 8s しか待たない・学習は detached 完走で拾う」

実体は `src/lib/server/swarmTierProbe.ts`。入口は1つ、`ensureTierProbed(tier)`(:338)。行番号は 2026-07-13 現物 — ズレたら §10 の grep。

| 要素 | 現物 |
|---|---|
| **プローブ本体** | `claude --model <tier> -p 'reply with exactly: PROBE_OK' --strict-mcp-config` を **execFile で headless 1発**(PTY 不要)、**cwd は `os.tmpdir()`**(:249 `probeOnce`)。`--strict-mcp-config` は**外せない**: ①セキュリティ — プローブは claudeTerminal.ts が strict を義務づけた「非サンドボックス・自動起動 utility session」クラスそのもので、素で spawn すると `~/.claude.json` の user-scope MCP をサンドボックス外で起動する(OG が意図的に閉じた RCE トリガの再開通)+ 認証待ち MCP でハング(0.11.12 事故クラス)。②レイテンシ — 無しだと repo cwd で 45〜73s(§5.8.1.1)。cwd を中立にするのは、サーバの `process.cwd()`(= OG repo)を継承すると CLAUDE.md/skills/.mcp.json をフルロードした重いエージェント session になるため |
| **二段タイムアウト** | **launch が待つのは `TIER_PROBE_LAUNCH_WAIT_MS` = 8s だけ**(:95。`Promise.race` — `verdictWithin` :320)。窓内に verdict が来なければ **'unknown' を返して fail-open 起動**し、**プローブ自体は打ち切らず detached で完走**(子プロセス上限 `TIER_PROBE_TIMEOUT_MS` = **90s** :84 — 実測 72.9s 最悪値+マージン)。完走した verdict は冷却テーブル(壁)/ TTL キャッシュ(ok/unknown)に記録され、**次の launch から効く**。冷却は永続(f7857d9e)なので**学習は1回で再起動も跨ぐ**。壁の拒否が 8s 窓内に来れば**その場で**梯子が下がる(壁の応答時間は未計測 — 窓は「賭け」でなく「来たら拾う」) |
| **bin 解決** | **preflight が検証した `resolvedClaudeBin()` のみ**(:184。意図的に PATH walk なし・env 直読みなし — `OPENGROUND_CLAUDE_BIN` は claudeConnection 経由で届く)。spawn route の共通 preflight・UsageHud の 60s ポーリング・boot warm-up(下)が温める — **ただし保証ではない**: `claude auth status` の一時タイムアウトで null に戻る瞬間がある。**null のときは 'unknown'(fail-open)かつ非キャッシュ** — 子を1個も走らせていない=プローブ結果ではないので、次の呼び出しが即再試行する。この一本化は「preflight しないテストが開発者の実 CLI に到達しない」第一の防衛でもあり、第二の防衛として **realExec は vitest 下で fail-loud に throw** する(:198) |
| **boot warm-up** | `warmTierProbeAtBoot()`(:377、server/index.ts が boot で呼ぶ)— **detached** で claudeConnection() を先に走らせて(boot 直後は resolvedBin が cold)からトップ tier を1回プローブ(`launchWaitMs: Infinity` — 誰も待っていないので完走させる)。**boot をブロックせず、失敗しても何も起きない**(per-launch プローブは独立に生きている)。狙い: 再起動後最初の spawn(たいてい司令官)が 8s 窓レースではなく**記録済みの答え**を引く |
| **判定**(`classifyProbeOutput` :145、pure) | stdout+stderr を `normalizeScreen` して **`QUOTA_EXHAUSTION_PATTERNS`(swarmRateLimitText.ts:94 — クォータ拒否文言だけの部分集合)**に当てる。**文言あり → `'wall'`(exit code より文言優先** — 拒否は非0 exit と一緒に来る)。文言なし+正常終了 → `'ok'`。文言なし+失敗/timeout → `'unknown'`。⚠ **層Bの `RATE_LIMIT_PATTERNS` 全体は使わない**(§5.8.2.1 — 極性が反転する) |
| **壁の記録** | `'wall'` なら `markRateLimited(tier, {ptyText: 出力, now})` — **層Aと同じ書込経路**(§2.2 の第3自動経路)なので、ディスクミラー(f7857d9e)込みで**再起動を生き延びる**。拒否文言中に reset 時刻があれば `extractPtyResetUntil` がそれを horizon にする(なければ 20分 grace) |
| **fail-open** | `'unknown'`(窓超過 / timeout / bin 不在 / spawn 失敗 / 一時故障 / exec seam の throw)では**冷却に何も書かない** — desired tier のまま起動する。**分からないことを理由に tier を殺さない** |
| **焚きすぎ防止** | ①**未知のときだけ**叩く: 冷却マーク済み → 即 `'wall'`(叩かない)、usage veto 発火 → そもそも resolver が選ばないので到達しない、fresh 判定あり → 再利用。②ok/unknown 判定は **TTL 10分**(`TIER_PROBE_RESULT_TTL_MS` :105)で `globalThis` にキャッシュ — 健全 tier のコストは「10分に1回のエージェント1ターン」であって起動毎ではない。壁側のキャッシュは**冷却テーブルそのもの**。③同時に複数体を起動しても **in-flight Map で1回に collapse**(各呼び出しの 8s 窓は独立に効く)。④inFlight への登録は**呼び出し側で set → `.finally` で解除**(:361-371)— async 本体は最初の await まで同期実行されるため、本体内 finally だと await 無しの早期 return(bin 不在)で「解決済み promise が inFlight に永久残留 → TTL 失効後その tier のプローブが二度と走らない」穴が開く(敵対レビュー MUST-FIX 4。exec 呼び出し回数を assert する回帰テストで固定) |

#### 5.8.2.1 判定パターンの極性 — 層Bの流用は禁止(2026-07-13 敵対レビュー)

層Bの `RATE_LIMIT_PATTERNS` は**わざと広い**(overloaded_error / rate_limit_error / api error 4xx-5xx / too many requests / retrying in Ns も拾う)。それが安全なのは**センサーでは false positive が「生きている worker に余分な猶予を与える」だけ**だから(パターンの docblock 自身が明言)。**プローブで同じ広さを使うと極性が反転する**: false positive が `markRateLimited` を叩き、**健全 tier を 20 分冷却してディスクに永続**+6経路全部が降格し、しかも手動 uncool しても次の起動が再プローブで再冷却する(壁は known にキャッシュされない仕様のため)。実測でも一時 529/500/backoff/429 文言がすべて 'wall' に誤判定された(差し戻しの現物)。⇒ プローブは **`QUOTA_EXHAUSTION_PATTERNS`(拒否文言5本: `reached your …limit` / `usage limit` / `<数値|usage|model|session|weekly|your> limit reached` / `switch models with /model` / `run /usage-credits`)だけ**を信じ、一時系はすべて 'unknown'=fail-open に落とす。**層Bのパターンは今までどおり広いまま** — 統一しようとするな(消費者ごとに false positive のコストが違う)。rc=0 で健全に応答した本文が一時系文言に**言及**しているだけのケース(`PROBE_OK (note: too many requests…)`)も 'ok' になる(quota 文言ではないので)。

### 5.8.3 配線 — 全 spawn 経路が probed リゾルバ経由

`swarmLaunch.ts` に async 版リゾルバが増えた: `resolveAvailableTierProbed`(:337)と `resolveSwarmModelEffortProbed`(:440)。ループは「同期 walk で tier を選ぶ → その tier が未知ならプローブ(8s 窓) → 壁なら(プローブが冷却を書いたので)walk が次の段を選ぶ」の繰り返しで、**梯子の長さで有界** — かつ 'unknown' は即その tier を採用するので、**launch が窓を複数回待つのは壁が実際に確定し続けたときだけ**(dispatch tick が数十秒吊られる形にはならない)。同期版はどうなったか: `resolveAvailableTier`(:279)は probed 版が**内部で使う probe-free コア**として現役。`resolveSwarmModelEffort`(:414)には**本番の呼び出し元が残っていない**(全6経路が probed 版に移行済み。quota route の `launchTier` も使っていない — あれは `highestSpawnableTier`)— テストと「プローブを await できない将来の同期文脈」のための残置であり、docstring がそう明言している。**プローブを払うのは実 spawn だけ**。

| spawn 経路 | 呼出箇所(2026-07-13 現在 — ズレたら §10 の grep) |
|---|---|
| worker | swarmWorker.ts:528 `await resolveSwarmModelEffortProbed(mode,'worker',card,…)` |
| **manager(司令官)** — 0713 に焼けた経路 | swarmManager.ts:196 |
| supply(補給官) | swarmSupply.ts:152 |
| overseer(C-core 大脳の席) | swarmOverseer.ts:350 |
| overseer brain(一発 PTY) | swarmOverseerBrain.ts:423 `await resolveAvailableTierProbed(model,…)` |
| reviewer panel / lens(敵対レビュー) | swarmOrchestrator.ts:3844(makeAdversarialReview 内 `panelModel`) |

**梯子の途中の tier にも効く**(層Dとの決定的な違い): probed ループは「walk が選んだ tier」をプローブするので、economy の sonnet 起動でも sonnet の壁を起動前に検知できる。desired が壁 → 1段下げ → その段も未知ならまたプローブ、が自然に連鎖する(全段壁なら同期 walk と同じ nothing-spawnable 解 = park がエンジン側で発動)。

### 5.8.4 受け入れ確認(実機)と検証

- **実機の受け入れ形**: fable が枯れている状態で worker / 司令官を起動 → **fable では起動せず opus で起動**し、`GET /api/swarm/quota` に fable の cooling マークが**手動 cool なしで自動的に**付く — 壁の拒否が 8s 窓に間に合えば**1回目の起動から**、間に合わなければ 1回目は fail-open で fable に出るが detached 完走が冷却を書くので**2回目から**(冷却は永続。壁の応答時間は未計測なのでどちらもあり得る)。fable が健全なら従来どおり fable 起動で、**起動が待たされるのは最大 8s**(boot warm-up か直近 10 分の判定キャッシュが温かければ **0s**)・プローブ自体(実測 19〜73s)は裏で完走・以後 10 分はプローブなし。
- 単体テストが同じ形をピン留め: `swarmTierProbe.test.ts`(判定の極性 8件 — 一時 529/500/backoff/429 は wall にしない・rc=0 の言及は ok — + ensureTierProbed/warm-up 13件: strict-mcp argv と中立 cwd の assert・collapse・TTL・8s 窓レース(遅いプローブ→'unknown'→detached 完走→次 launch が壁を知る)・inFlight 残留回帰(exec 呼び出し回数 assert)・null-bin 非キャッシュ)と `swarmLaunch.test.ts` の probed describe(**本物の ensureTierProbed × exec モック**の統合形 12件 — 「dry fable ⇒ opus + 自動冷却」「healthy ⇒ fable・プローブ1回」「unknown ⇒ fail-open」「mask/veto/冷却済みには 1発も費やさない」)。**exec seam をモックするので CI は実 CLI を叩かない**(HOME も隔離済み・realExec は vitest 下で throw する二重防衛)。
- エンジンログ: プローブが壁を確認すると `[openground:swarm-probe] tier 'fable' refused the pre-launch probe (wall) — cooling until …` が server ログに出る(§10 の serverLogPath を tail)。

### 5.8.5 やらないこと(設計判断の記録)

- **/usage スクレイプの起動時ウォーム(旧B案)・cold 時の同期スクレイプ(旧C案)は実装しない** — §5.8.1 のとおり見る材料(per-model 行)が live に存在しないので効果ゼロ。**プローブに置き換わった**。層Dの dormant 配線(§5.7)はそのまま(行が復活した日に自動で効く)。
- 冷却テーブルの永続化そのものは別カード(f7857d9e、§2.1.1)— 層Eは `markRateLimited` を**呼ぶだけ**で永続化はそちらの機構に乗る。
- プローブ結果の永続化はしない(ok/unknown は in-memory TTL のみ)。壁だけが層A経由で永続する — 「健全だった」10分前の記憶を再起動後も信じる価値はない。
- **launch を同期でプローブ完走まで待たせる案(当初実装の 20s timeout)は実測で棄却**(§5.8.1.1 — 健全 tier のプローブが常に timeout を超え、層Eが inert になる+起動 API / dispatch tick が数十秒吊られる)。「短い窓 + detached 完走 + boot warm-up」が採用形。
- **層Bの `RATE_LIMIT_PATTERNS` をそのまま判定に使う案も棄却**(§5.8.2.1 — false positive の極性が反転し、一時 529 が健全 tier を永続冷却する)。

---

## 6. 状態機械 / データフロー(1周)

```
[spawn 要求: worker/manager/supply/panel/brain]
        │ desired tier ← 実行モード×role×カード重み (swarmLaunch.ts:148-174)
        ▼
resolveAvailableTierProbed(desired, now, allowed, usage)   … 層A+C+D+E (§5.8。同期 walk=層A+C+D で tier を選び、
        │                                                     未知ならプローブ→壁なら markRateLimited して1段下げ再 walk)
        │ null → throw NoAllowedModelTierError / panel は defer (§5.4)
        ▼
claude 起動 (--model <tier>) … worker は tier を w.model に記録 (swarmOrchestrator.ts:4583)
        ▼
[PTY 出力] … terminal.ts:297 が lastOutputAt を無条件スタンプ
        ▼
monitor (dispatch pass 内・3s tick。0d1f7f0 以前は passInFlight に飢餓され得た §3.6 — 現在は integrate 分離で常時回る)
        │ 0d1f7f0 前: silentMs >= 10分 のときだけ screen を classifyOutput (4064-4071)
        │ 0d1f7f0 後: 出力45秒沈黙でサンプリング+spawn初動のlimitは約95秒で早期認定 (§3.2注記・TARGET-STATE §1)
        ▼ 'rate-limited'
markRateLimited(w.model, {ptyText, a5ResetsAt(pct>=100), graceMs 20m})   ← 層Aへ書込 (4096-4101)
        │ worker は hold (nudge なし) → 20分後まだ limited なら todo requeue・branch 保持 (4109-4112)
        ▼
次の dispatch: spawnBlock(now, allowed)
        │ null → resolveAvailableTier が1段下の tier で spawn (梯子を降りる)
        │ all-cooling → park (parkUntil、自然解除)
        │ none-allowed → park + escalation (人間のみ解除)
        ▼
冷却期限 until 経過 → lazy expiry で自動復活 (swarmQuota.ts:450-453) → `quota park lifted` (4466)
```

カスケードは特別扱いなしの創発: fable が冷える→opus で spawn→opus も limit→opus も冷える→sonnet…(swarmQuota.ts:396-401)。

---

## 7. 司令塔の運用手順

前提: すべて owner セッションの curl(quota API は owner gate、§2.5)。ポートは本番 47776。

### 7.1 まず現在地を見る

```bash
curl -s http://127.0.0.1:47776/api/swarm/quota | jq
```

- `launchTier` が**次に起動される tier**(mask 考慮済み・唯一の真実)。`"fable"` なら健全。
- `launchTier: null` = 何も spawn できない(enabled 全 cooling か全 OFF)。engine journal に park 行が出ているはず。
- `tiers[]` は生の冷却テーブル(mask 盲目 §2.6)。`until` は epoch ms。
- mask 現在値: `curl -s http://127.0.0.1:47776/api/settings | jq .swarmAllowedModels`(`null` = 未設定 = 全 ON)。
- engine 状態(parkUntil / journal): `curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$(pwd)" | jq '{running, parkUntil, log: .log[-8:]}'`

### 7.2 枯渇を検知したら(センサーより先に自分が動く)

自動検知は `0d1f7f0` で根治された — **spawn 直後の即死は約 1.5 分で検知(onset 窓)、稼働後の limit は実クロック化した 10 分ゲート**(装飾再描画による無限先送りは根絶。§3.2/§4 — 実測待ち)— が、journal は ring 200 行+再起動で消えるため「見えない」は残る。worker 画面に limit 文言を見た・/usage が 100% — センサーを待つ理由はないので、その時点で:

1. **数時間スケール(reset 時刻が読める)** → 手動 cool:
   ```bash
   curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/cool \
     -H 'content-type: application/json' -d '{"tier":"fable","minutes":180}' | jq .tiers
   ```
   (`untilMs` で絶対時刻指定も可。上限 7日 §2.5。)以後の dispatch/panel は自動で1段降りる。
2. **週次枠が尽きた等、再起動を跨いで殺したい** → mask OFF(Settings ▸ 使用可能モデル、または):
   ```bash
   curl -s -X POST http://127.0.0.1:47776/api/settings \
     -H 'content-type: application/json' \
     -d '{"swarmAllowedModels":{"fable":false,"opus":true,"sonnet":true,"haiku":true}}'
   ```
   全 OFF は書込境界で黙殺される(§5.2)ので必ず1つは ON。
3. **どちらを使うか**: 冷却は**再起動は生き延びる**(§2.1.1)が、**期限で自動復活**し、newest-wins でセンサーに**上書き短縮され得る**一時層(§2.3)。「確実に・長く」は mask、「今の窓だけ」は cool。

### 7.3 復帰したら

- 手動 cool を張った/センサーの mark が残っている → `uncool`(idempotent):
  ```bash
  curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/uncool \
    -H 'content-type: application/json' -d '{"tier":"fable"}' | jq .launchTier
  ```
- mask OFF にしていた → ON へ戻す(7.2-2 の逆)。**uncool は OFF tier を復活させない**(独立2拒否権 §0)。
- 放置でも cooling は until で自然解除+journal に `quota park lifted`(4466)。none-allowed だけは人間必須。

### 7.4 誤検知(健全 tier が冷えた)

一過性 5xx・`retrying in Ns` 等で 20分冷えることがある(§3.1 の残余リスク)。`uncool` で即解除(swarmQuota.ts:426-432 がまさにこの用途)。

---

## 8. 落とし穴(司令塔が実際に踏んだ事象を含む)

1. **`tiers[]` の cooling:false を「使える」と誤読** — mask 盲目(§2.6)。判断は `launchTier` で。
2. ~~**アプリ再起動で冷却が全消え**~~ → **2026-07-13 に永続化して解消**(§2.1.1)。冷却は `~/.openground/swarm-quota.json` に載り、再起動を生き延びる。**「再起動後は冷却が空なのが正常」はもう成り立たない** — 空なら (a) 本当に冷えていない (b) 期限切れで捨てられた (c) ファイルが壊れて fail-safe で冷却なし起動した、のいずれか。**切り分けは `jq . ~/.openground/swarm-quota.json`**(§10)。⚠ ログを grep しようとしないこと — `~/.openground/server.log` は**存在しない**(書き手がいない)。なお**期限で自動復活する**性質は不変なので、恒久指定は依然 mask。
3. **手動 cool がセンサーに短縮される**(newest wins §2.3)。7日 cool を打っても、次の sighting が PTY/A5 から短い reset を解決すればそちらで上書き。
4. **「journal に rate-limited が無い」は無実の証明にならない** — かつては検知自体が最大20分超盲目だった(§4、`0d1f7f0` で根治・実測待ち)。根治後も journal は ring 200 行+再起動で全消えなので、疑ったら worker 画面と /usage を自分で見る。
5. **rate-limit hold 中の worker は「止まって見える」が正常動作** — nudge されず、20分後に todo requeue、**branch にコミットは残る**。消えた扱いで worktree を掃除しない([[swarm-janitor が fresh worker を誤殺した事故]]と同型の早合点に注意)。**hold していた時間は実行時間から控除される**ので、「limit で待たされた分だけ寿命が削られて runaway で消える」ことはない(§3.4-6 — 0712 根治。これを放置して 47KB を失った)。
6. **panel 全滅は card の失敗ではない** — `skippedForPark` の defer は rework でも needs-human 前進でもない(§3.5)。「レビューが3回 defer した」と叱る前に quota を見る。
7. **mask を書いたのに効かない** — 実行中プロセスは旧 bundle かもしれない(§5.6)。`grep -c swarmAllowedModels server/dist/index.cjs` で確認してから騒ぐ。
8. **quota API が 403** — owner gate(§2.5)。cockpit で owner ログインしたセッション経由で叩く。
8b. **`/cool` や `/uncool` が 500** — **リクエストは効いている**(mark はメモリに載った/消えた)が、**永続化に失敗した**(§2.1.1)。つまり再起動でその指示は失われる — `/uncool` の 500 は特に、古い mark が file に残るので**再起動で tier が cooling に戻る**。原因はほぼ書込先: 権限 / ディスク残量 / `~/.openground/swarm-quota.json` が壊れてディレクトリになっている等。**500 を 200 と読み違えないこと** — 200 は「ディスクに載った」を意味する(そこは嘘をつかない)。
9. **`OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN` を伸ばしすぎても** `MAX_EXEC_MS - 60s` でクランプされる(365-373)。runaway 側の env(`OPENGROUND_SWARM_MAX_EXEC_MIN`、343)と辻褄が取られる。なお **hold 中の時間は runaway 判定から控除される**(§3.4-6)ので、grace を伸ばしても worker の実作業予算は削られない — ただし控除の上限は `HOLD_CREDIT_CAP_MS`(=`MAX_EXEC_MS`、352)で、worker の絶対 wall-clock 寿命は `MAX_EXEC_MS + 上限`(既定 180 分)で必ず打ち切られる。

---

## 9. 既知の穴(バグ・未修正 — 文書化のみ、修正しない)

1. ~~**quota 検知が最悪 20分超遅れる**~~ → **`0d1f7f0`(2026-07-10)で 3 因子とも解消済み**(カード `4d1550d7` done)。当時の 3 因子(沈黙10分ゲート / 装飾再描画による時計後退 / integrate pass の monitor 飢餓)と現行機構の対応は §3.2/3.3/3.6 の各注記、正典は TARGET-STATE §1。実運用での初回実測が未了(◐)。
2. ~~**spawn 直後の limit は「即検知」経路が無い**~~ → **`0d1f7f0` で解消済み**。spawn 初動(≤2 分)に limit 文言が現れ 45 秒継続・commit ゼロ・心拍なしなら 10 分を待たず認定(`earlyLimitConfirmed` — sighting→cooling 約 95 秒)。limit 文言をソース/プランに書くだけの worker は onset 窓で拒否(false-kill ガード)。
3. **手動 cool の保護が無い** — `markCoolingUntil`(手動)と `markRateLimited`(センサー)が同じ Map を newest-wins で共有(swarmQuota.ts:385-389, 413)。手動長期 cool をセンサーの 20分 grace が上書き短縮するのは、オーナー意図の観点では穴(仕様コメントは「newest signal wins」を意図と明言 383-384 — ただし手動 vs 自動の優先問題への言及は無い)。恒久指定は mask で代替可能なので実害は限定的。

(§3.1 の `retrying in Ns` 系 false-positive は設計上の許容リスクとしてコード内に明記済み(1118-1122)のため、穴ではなく仕様として §8-9 に記載。)

---

## 10. 検証コマンド集(司令塔が自分で裏取りするワンライナー)

対象コミット・mask の存在:

```bash
git -C ~/projects/OPEN\ GROUND log -1 --format='%h %s' origin/main
git -C ~/projects/OPEN\ GROUND merge-base --is-ancestor d1485ea origin/main && echo "mask はソースに入っている"
git -C ~/projects/OPEN\ GROUND show d1485ea --stat | head -30
```

定数の現在値(行番号ズレの検出も兼ねる):

```bash
grep -n "STALL_SILENCE_MS = \|RATE_LIMIT_GRACE_MS = \|TICK_MS = \|INTEGRATE_TICK_MS = " src/lib/server/swarmOrchestrator.ts
grep -n "MAX_MANUAL_COOLING_MS\|DEFAULT_COOLING_GRACE_MS" src/lib/server/swarmQuota.ts
grep -n "SWARM_MODEL_TIERS = " src/lib/types.ts
grep -n "src\[tier\] !== false" src/lib/server/swarmAllowedModels.ts   # per-key fail-open の実体
grep -n "anyTierAllowed" src/lib/server/store.ts                        # 全OFF拒否の書込境界
grep -n "lastOutputAt = Date.now()" src/lib/server/terminal.ts          # 無条件スタンプ
```

センサーの書込が3箇所だけであること(worker arm / reviewer arm / **層Eプローブ** — §2.2)・spawn 経路の fail-closed:

```bash
grep -rn "markRateLimited(" src/lib/server --include='*.ts' | grep -v test | grep -v swarmQuota.ts
# → swarmOrchestrator.ts ×2 + swarmTierProbe.ts ×1 の3行が正(2026-07-13〜)
grep -rn "NoAllowedModelTierError()" src/lib/server --include='*.ts' | grep -v test
```

層E(起動前プローブ、§5.8)の裏取り:

```bash
grep -n "ensureTierProbed\|TIER_PROBE_LAUNCH_WAIT_MS\|TIER_PROBE_TIMEOUT_MS\|TIER_PROBE_RESULT_TTL_MS\|strict-mcp-config\|warmTierProbeAtBoot" src/lib/server/swarmTierProbe.ts | head
grep -rn "resolveSwarmModelEffortProbed(\|resolveAvailableTierProbed(" src/lib/server --include='*.ts' | grep -v test | grep -v swarmLaunch.ts
# → worker/manager/supply/overseer/brain/orchestrator(panel) の6経路が正
npx vitest run src/lib/server/swarmTierProbe.test.ts                                  # プローブ本体のピン留め
npx vitest run src/lib/server/swarmLaunch.test.ts -t "pre-launch probe"               # 統合形(dry fable ⇒ opus + 自動冷却)
grep -c swarmTierProbe server/dist/index.cjs   # 0 なら旧 bundle(層E不在=起動前プローブが走らない)— 再ビルド要
```

層D(pre-launch veto、§5.7)の裏取り:

```bash
grep -n "isTopTierExhaustedByUsage\|peekCachedUsage" src/lib/server/swarmLaunch.ts   # 実装の存在確認
grep -rn "resolveSwarmModelEffort(" src/lib/server --include='*.ts' | grep -v test   # 全呼出箇所が usage 引数を渡していない=既定値経由で自動適用の裏取り
npx vitest run src/lib/server/swarmLaunch.test.ts -t "usage"                          # ピン留めテストだけ実行
```

**⛔ 「fable は枯れているか?」に答えられるのは /usage ではなくプローブだけ**(§5.7 冒頭):

```bash
claude --model fable -p 'reply with exactly: PROBE_OK' --strict-mcp-config   # 拒否文字列が返れば壁(トークン消費ゼロ。健全なら実測19〜73s・壁の応答時間は未計測)
curl -s http://127.0.0.1:47776/api/usage | jq '.cli'     # session/weekAll しか出ない。weekModels は [] が正常(再ビルドしても変わらない)
```

実行系(owner セッションで):

```bash
curl -s http://127.0.0.1:47776/api/swarm/quota | jq                      # launchTier が真実
curl -s http://127.0.0.1:47776/api/settings | jq .swarmAllowedModels     # null=全ON
curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/cool -H 'content-type: application/json' -d '{"tier":"haiku","minutes":3}' | jq .tiers   # 3分で自己解除する無害な実験
curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/uncool -H 'content-type: application/json' -d '{"tier":"haiku"}' | jq .tiers
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$HOME/projects/OPEN GROUND" | jq '{running, parkUntil, log: .log[-10:]}'
```

冷却の永続化(2026-07-13〜)と bundle の鮮度:

```bash
cat ~/.openground/swarm-quota.json 2>/dev/null | jq .          # 永続化された冷却 mark(無ければ「一度も冷えていない」)
jq -r '.cooling | to_entries[] | "\(.key) until \(.value | tonumber/1000 | strftime("%F %T %Z"))"' ~/.openground/swarm-quota.json
grep -c swarmQuotaStore server/dist/index.cjs      # 0 なら旧 bundle(永続化不在=再起動で冷却が消える)— 再ビルド要
grep -c swarmAllowedModels server/dist/index.cjs   # 0 なら旧 bundle(mask 不在)— 再ビルド要
ls -l server/dist/index.cjs                        # mtime が d1485ea(2026-07-09 18:05)より古ければ確実に旧
```

冷却が消えている理由の切り分け(§8-2 の (a)/(b)/(c) を分ける)。**まず file を見る** — これが唯一どこでも効く:

```bash
jq . ~/.openground/swarm-quota.json          # ← parse error  = (c) 壊れている(fail-safe で冷却なし起動した)
                                             #    file が無い  = 一度も冷えていない / uncool 済み
                                             #    {"cooling":{}} = 全 tier 解放済み
# (b) 期限切れかどうか: until を人間の時刻に直して今と比べる
jq -r '.cooling | to_entries[] | "\(.key) until \(.value/1000 | todate)"' ~/.openground/swarm-quota.json
```

**⚠ `~/.openground/server.log` は存在しない。**`paths.ts:108` に `serverLogPath()` の定義だけが残っているが**書き手が1人もいない**(旧シェルランチャー時代の残骸。同 :102-107 に DEAD 注記あり)。`grep ~/.openground/server.log` は永久に空を返す = **偽陰性**なので使わないこと。fail-safe の `[openground:swarm-quota]` 行が実際に出るのは **stdout** で、見える場所はこう:

| 起動のしかた | ログの出先 |
|---|---|
| `npm run dev` / `npm run dev:server` | それを回しているターミナル(`[openground:hono] …` と同じ流れ) |
| `npm run electron:dev` / `electron:prod` | それを回しているターミナル。forked server の stdout は Electron が `[hono] ` を付けて中継する(electron/main.js:751-752) |
| パッケージ版 `.app` を Finder から起動 | **どこにも残らない**(GUI プロセスの stdout は捨てられる)。見たいなら `'/Applications/OPEN GROUND.app/Contents/MacOS/OPEN GROUND'` をターミナルから直接起動する |

つまり**実運用(パッケージ版)では上の `jq` が (c) を判別する唯一の手段**。破損 file はそのまま残す実装なので、次の書込が起きるまでは必ず観測できる。

ケーススタディの一次痕跡:

```bash
grep -n "21m30s" src/lib/server/swarmAllowedModels.ts        # 実測の刻印(:12-13)
grep -n "2026-07-09" src/lib/server/swarmOrchestrator.ts      # per-model 通知 verbatim の由来(:1132-1141)
grep -rl 4d1550d7 ~/.openground/projects/*/tasks.json         # 対応カードの所在(歴史: 起票時 blocked 列 → 0d1f7f0 で修正・done 列。カード本文が当時の3因子の一次記録)
```
