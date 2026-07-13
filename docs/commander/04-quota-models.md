# 04 — Quota・冷却・使用可能モデル mask(三層モデル)

**対象コミット: `cc7c60e`**(使用可能モデル mask は `d1485ea`(2026-07-09 18:05 +0900)で main 入り)
**読者: 将来の司令塔(og-manage)セッション。** モデル枯渇まわりで誤診しないための正確な機構文書。全主張に file:line の根拠を付す。行番号は上記コミット時点のもの — ズレたら §10 の grep で自分で裏取りすること。
> **部分更新(2026-07-10)**: `0d1f7f0` が**検知 21 分遅延の 3 因子(§3.2 沈黙ゲート / §3.3 装飾再描画 / §3.6 monitor 飢餓)をすべて根治**した — 各節に注記済み、§4 の実測は歴史(照合点)として保持。根治後の機構と到達判定は TARGET-STATE §1 が正典(0d1f7f0 基準の行番号つき)。層 A/B/C の三層モデル自体と §5 以降の park/mask 機構は不変。swarmOrchestrator.ts の行番号は :355 以降 +38〜+381 シフト(00-INDEX 冒頭)。
> **部分更新(2026-07-12)**: `swarmLaunch.ts` に**層D — 使用状況キャッシュ(claudeUsageCli/「A5」)による PRE-LAUNCH veto**が追加された(§5.7)。層A(冷却)は**起動して rate-limit を実際に食らって初めて**学習する事後学習(reactive)だが、A5 の `/usage` スクレイプは UsageHud がとっくに「fable 実質 100%」と知っている状態を起動前から握っている — その既知の枯渇を**起動判断そのもの**に使うのが層D。層 A/B/C とは独立(fail-open・trailing/gray-zone は無視)で、行番号はこの節時点の `swarmLaunch.ts` 現物 grep で裏取りすること(§10)。

---

## 0. 三層を1枚で

「fable が枯れた」に対して OG には**独立した3つの層**がある。混同すると誤診する。

| 層 | 実体 | 在処 | 寿命 | 役割 |
|---|---|---|---|---|
| **A. 冷却テーブル**(センサーの記憶) | tier → 解禁時刻(epoch ms)の Map | `globalThis.__openground_swarm_quota`(`src/lib/server/swarmQuota.ts:75-82`) | **in-memory。アプリ(サーバプロセス)再起動で消える**。tsx watch リロードは生存(swarmQuota.ts:64-70) | 「この tier は今冷えている」を一時記憶。期限で**勝手に復活**(lazy expiry、swarmQuota.ts:256-259) |
| **B. rate-limit 検知**(センサーの目) | worker 画面/reviewer transcript のパターン監視 | `src/lib/server/swarmOrchestrator.ts`(worker arm: 4064-4115 / reviewer arm: 3522-3586) | エンジン稼働中のみ | limit 文言を見つけて A に書き込む(`markRateLimited`)。**唯一の自動書込経路** |
| **C. 使用可能モデル mask**(オーナーの政策) | tier → ON/OFF の永続スイッチ | `settings.json` の `Settings.swarmAllowedModels`(src/lib/types.ts:111-115)+ globalThis ミラー(`src/lib/server/swarmAllowedModels.ts:67-74`) | **永続。再起動・self-update を生き延びる** | 「この tier は使うな」を恒久指定。**期限で復活しない** |
| **D. 使用状況キャッシュ**(A5・pre-launch veto、2026-07-12) | `claude /usage` スクレイプの成功キャッシュ(`session`/`weekAll` の pct) | `globalThis.__openground_usage_cli_state`(`src/lib/server/claudeUsageCli.ts:73-92`)を `peekCachedUsage()` で同期 peek | in-memory・TTL 30分(CACHE_TTL_MS)・成功時のみキャッシュ | **起動前**に「トップ tier(fable)は確定で 100% 枯渇」と分かっている場合だけ、`resolveAvailableTier` の梯子からトップ tier を除外する。層Aと違い**まだ一度も起動していない状態でも**効く |

**合流点は1つ**: `isTierSpawnable = isTierAllowed AND !isTierCooling`(swarmAllowedModels.ts:97-101)。**A と C は独立した2つの拒否権**で、どちらか一方だけで tier を殺せる。cool 解除は OFF tier を復活させないし、ON に戻しても cooling は縮まない(swarmAllowedModels.ts:16-18)。層D はこの2つに**さらに独立して**重なる第3の拒否権だが、**トップ tier(梯子の先頭)にしか適用されない**(A5 のキャッシュに per-tier 内訳が無く、account-wide の session/weekly % しかないため — §5.7)。

tier の梯子は `SWARM_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku']`(src/lib/types.ts:2173、best→cheapest)。swarmQuota の `MODEL_TIER_LADDER` はこれの alias(swarmQuota.ts:55)。4 alias とも 2026-07-06 に CLI 実機検証済み(swarmQuota.ts:31-37)。

---

## 1. 構造 — 何がどこにあるか

| ファイル | 役割 | 主要 export |
|---|---|---|
| `src/lib/server/swarmQuota.ts` | 層A。純粋関数+globalThis テーブル。エンジンも usage センサーも import しない一方向依存(swarmQuota.ts:15-29) | `MODEL_TIER_LADDER` / `markRateLimited`(216) / `markCoolingUntil`(201) / `clearCooling`(241) / `resolveCoolingUntil`(178) / `isTierCooling`(256) / `highestAvailableTier`(264) / `allCoolingUntil`(275) / `coolingSnapshot`(290) / `isModelTier`(247) / `MAX_MANUAL_COOLING_MS`(236) |
| `src/lib/server/swarmAllowedModels.ts` | 層C(d1485ea 新規)。swarmQuota+types のみ import(swarmAllowedModels.ts:30-31) | `normalizeAllowedModels`(47) / `anyTierAllowed`(59) / `isTierSpawnable`(97) / `highestSpawnableTier`(106) / `highestAllowedTier`(114) / `spawnBlock`(132) / `NoAllowedModelTierError`(154) / `setAllowedModelTiersCache`(78) |
| `src/lib/server/swarmLaunch.ts` | 起動 tier の決定。A/C/D を読む(書かない) | `SWARM_LAUNCH_MODEL='fable'`(56) / `isTopTierExhaustedByUsage`(223、層D) / `resolveAvailableTier`(230) / `resolveSwarmModelEffort`(315) / `execModeMaxWorkers` |
| `src/lib/server/swarmOrchestrator.ts` | 層B(検知)+park(ACTUATOR)。`markRateLimited` の生産呼出は worker arm(4096)と reviewer arm(3572)の2箇所だけ | `RATE_LIMIT_PATTERNS`(1123) / `classifyOutput`(1256) / `endsInRateLimit`(1203) / `STALL_SILENCE_MS`(271) / `RATE_LIMIT_GRACE_MS`(347) / `describeSpawnBlock`(3421) |
| `server/routes/swarm.ts` | quota API 3本(ヘッダ一覧 swarm.ts:26-31) | `GET /api/swarm/quota`(880) / `POST /api/swarm/quota/cool`(894) / `POST /api/swarm/quota/uncool`(926) |
| `src/lib/server/store.ts` | mask の永続化と読出。**全OFF拒否の書込境界**(181-185) | `getAllowedModelTiers`(195-196) |
| `src/lib/server/claudeUsageCli.ts` | 層D。「A5」= CLI `/usage` スクレイプのキャッシュ。swarmLaunch.ts が読むのは既存の `peekCachedUsage` のみ — このファイル自体(スクレイプ機構・watcher・TTL)は今回のカードで無改修 | `peekCachedUsage`(105-110、TTL 内の最終**成功**スクレイプのみ返す) / `CliUsage`(42-49、`session`/`weekAll`/`status`) |
| `src/lib/server/terminal.ts` | PTY プール。`lastOutputAt` の唯一のスタンプ箇所(297) | `WORKING_SILENCE_MS=3000`(21) |

spawn 経路(5+1)と fail-closed の実装箇所は §5.4。

---

## 2. 層A — 冷却テーブル(swarmQuota.ts)

### 2.1 データ構造と寿命

- 実体は `Map<ModelTier, number>`(tier → 解禁 epoch ms)1個だけ。`globalThis.__openground_swarm_quota` に常駐(swarmQuota.ts:71-82)。
- **expiry は lazy**: 読む側が `until <= now` を「利用可」と扱うだけで、タイマーも掃除も無い(swarmQuota.ts:252-259)。つまり「冷却が明ける」イベントは存在せず、次に誰かが読んだ瞬間に available になる。
- **アプリ再起動で全消え**。枯れているのに冷却が消えて dispatch が壁に再突入する — これが層C(mask)が作られた理由そのもの(swarmAllowedModels.ts:8-13)。

### 2.2 書込は3経路のみ

| 経路 | 関数 | 呼出箇所 |
|---|---|---|
| 自動(worker arm) | `markRateLimited` | swarmOrchestrator.ts:4096 |
| 自動(reviewer arm) | `markRateLimited` | swarmOrchestrator.ts:3572 |
| 手動 API | `markCoolingUntil` / `clearCooling` | server/routes/swarm.ts:919 / 938 |

### 2.3 markRateLimited の上書き挙動 — **newest wins(max() ではない)**

`state.cooling.set(tier, until)` の単純上書き(swarmQuota.ts:201-203, 226)。コメントも明言:「A later mark for the same tier overwrites (the newest signal wins)」(swarmQuota.ts:199-200)。

**司令塔への含意**: 手動で `cool fable 7日` を打った後にセンサーが同じ tier で再 sighting すると、センサーの解決値(最悪 20分 grace)で**上書きされて縮む**。長期間殺したいなら層C(mask OFF)を使うこと(§7)。

### 2.4 resolveCoolingUntil — 解禁時刻の3情報源(優先順)

swarmQuota.ts:178-193。上から順に試し、**過去時刻は無視して次へ落ちる**(187, 190):

1. **PTY 文言**(最優先・最具体): `extractPtyResetUntil`(147-169)が worker 画面から「resets in 5 minutes」「limit resets at 3pm」等を parse。相対形→絶対形の順(153-167)。ラベル parse 本体は `parseResetLabel`(104-139): ①相対 "in N unit"(113-117)②裸時計 "3pm"(過ぎていれば翌日、121-133)③絶対日付(TZ suffix と " at " を除去して Date.parse、136-138)。
2. **A5**(CLI usage センサーのキャッシュ値): 呼出側が `a5CoolingHint()` で渡す(swarmOrchestrator.ts:4098, 3574)。**pct >= 100 ゲート付き** — A5 の `resetsAt` は 3% 使用時でも常時表示される「現ウィンドウの終端」なので、その slot が実際に**枯れている**(session.pct>=100、次いで weekAll.pct>=100)ときだけ信用する(swarmOrchestrator.ts:1223-1238)。ゲートが無いと、一過性 429/5xx への RATE_LIMIT_PATTERNS ヒットで健全 tier を最長 ~5h 冷やしてしまう(0708 must-fix 差し戻しの教訓、1227-1230)。両 slot 枯れなら先に評価される session(=より早い reset)が勝つ(1230-1232, 1235-1236)。
3. **フラット grace**: `now + graceMs`(192)。エンジンは `RATE_LIMIT_GRACE_MS` を渡す(swarmOrchestrator.ts:4099, 3575)。

`RATE_LIMIT_GRACE_MS` = **20分が既定**。env `OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN` で 2〜360分に調整可、ただし `MAX_EXEC_MS - 60s` で強制クランプ(暴走 park より先に requeue する band-inversion 防御。swarmOrchestrator.ts:365-373)。swarmQuota 側の `DEFAULT_COOLING_GRACE_MS`(62)は同値 20分のローカル既定(import 循環回避のための重複、57-61)。**この grace の間に流れた時間は worker の実行時間に算入されない**(§3.4-6 — hold 台帳で控除される)。

### 2.5 手動 cool / uncool API

- `POST /api/swarm/quota/cool` body `{tier, untilMs}` または `{tier, minutes}`(server/routes/swarm.ts:894-921)。検証: tier は `isModelTier` で梯子照合(903-905、未知 alias は 400 = 推測で冷やさない fail-closed)、`until` は `(now, now + MAX_MANUAL_COOLING_MS]` 必須(915-918)。
- `MAX_MANUAL_COOLING_MS` = **7日**(swarmQuota.ts:236)。週次 quota より長く、忘れた cool が自己治癒する上限(231-235)。
- `POST /api/swarm/quota/uncool` body `{tier}`(926-940)→ `clearCooling`(swarmQuota.ts:241-243、idempotent)。センサー製・手動製どちらの mark も消せる。誤検知(一過性 5xx を枯渇と誤読)の脱出口(240-241)。
- 3本とも **owner gate**: `getCustomTabRole() !== 'owner'` なら 403(881, 895, 927)。

### 2.6 GET /api/swarm/quota の読み方 — mask 盲目に注意

レスポンス `SwarmQuotaResponse`(src/lib/types.ts:2228-2245)= `quotaSnapshot`(server/routes/swarm.ts:126-131):

| フィールド | 意味 | mask を見るか |
|---|---|---|
| `now` | サーバ時刻(cooling 判定の基準) | — |
| `tiers[]` | 梯子4段の `{tier, cooling, until}`。`until` 非 null ⇔ `cooling:true`(lazy expiry 済み、types.ts:2218-2226) | **見ない**(生の冷却テーブル) |
| `launchTier` | 次の top-tier 起動が実際に解決される tier = `highestSpawnableTier`(129) | **見る**(唯一 mask を考慮) |
| `allCoolingUntil` | **全 tier** cooling のときのみ最早 reset(swarmQuota.ts:275-283) | **見ない** |

`tiers` / `allCoolingUntil` が mask 盲目なのは仕様(この endpoint は冷却の操縦面で、cool/uncool はここに見えるものへ作用する。swarm.ts:119-121)。**「fable が cooling:false だから打てる」は誤読** — fable が mask OFF なら launchTier は opus になる。**真実は launchTier だけ**(swarm.ts:122-125)。

---

## 3. 層B — rate-limit 検知経路(swarmOrchestrator.ts)

### 3.1 RATE_LIMIT_PATTERNS(1123-1155)

正規化(ANSI 除去+空白畳み+小文字化、`normalizeScreen` 1100-1111)済みテキストに対する regex 群:

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

### 5.7.1 動機 — 層Aは事後学習、層Dは起動前に効く

層A(冷却テーブル)は `markRateLimited` が**唯一の書込元**(§2.2)で、これは**実際に起動して rate-limit 応答を受け取ってから**しか書けない(swarmOrchestrator.ts の worker arm / reviewer arm、両方とも「動いている worker/panel の画面を読んで」書く)。一方 `claudeUsageCli.ts`(「A5」、既に §2.4 で cooling の reset 時刻ソースとして使われている)は UsageHud が 60 秒おきにポーリングしているキャッシュで、**起動する前から** fable が実質 100% 枯渇している事実を握っていることがある。層Dはその既知の枯渇を**起動判断そのもの**(`resolveAvailableTier`)に接続する ── 「UsageHud には出ているのに swarm は知らずに fable で起動を試みて詰まる」というギャップを塞ぐ。

### 5.7.2 実装 — `isTopTierExhaustedByUsage` + `resolveAvailableTier` の第4引数

- `isTopTierExhaustedByUsage(usage: CliUsage | null): boolean`(swarmLaunch.ts:223 付近)。**session.pct >= 100 または weekAll.pct >= 100 のときだけ true**。それ以外(null・95% 等のグレーゾーン・両 slot null)はすべて **false = 非枯渇扱い(fail-open)**。閾値はセンサーが既に使っている `a5CoolingHint`(swarmOrchestrator.ts:1271-1276)と同じ「pct>=100 ゲート」を踏襲 ── A5 の `resetsAt` は 3% 使用時でも常時表示される「現ウィンドウの終端」なので、**実際に枯れているとき以外は信用しない**という既存の設計原則をそのまま流用している。
- `resolveAvailableTier(desired, now, allowed, usage = peekCachedUsage())`(swarmLaunch.ts:230-)。第4引数 `usage` を追加(既定値は `peekCachedUsage()` の同期 peek ── **起動のたびに `/usage` を live scrape することは絶対にしない**。TTL 内の最終成功キャッシュを読むだけ)。ladder walk 内部の `spawnable(tier)` 述語に `!(topTierExhausted && tier === MODEL_TIER_LADDER[0])` を足しただけ ── **梯子の先頭(fable)にしか適用されない**(A5 のキャッシュには per-tier 内訳が無く、`session`/`weekAll` は account-wide の集計値しか無いため。§0 の D 行)。
- `resolveSwarmModelEffort(mode, role, card?, now?, allowed?, usage = peekCachedUsage())`(swarmLaunch.ts:315-)。第6引数として同じ既定値でスルー渡し。**worker/manager/supply/overseer の全呼出箇所は無改修**(swarmWorker.ts / swarmManager.ts / swarmSupply.ts / swarmOverseer.ts はどこも `usage` を渡していない → 既定値経由で自動的に効く)。
- 層A・層Cとの合成は「梯子を歩く前にトップ tier を篩い落とす」だけなので、**冷却・mask と完全に独立して重なる**(例: 層Dでトップ tier 除外 + 層Aで opus も cooling → sonnet まで降りる。swarmLaunch.test.ts の「composes with cooling」ケースで確認済み)。

### 5.7.3 何が違うか — 層Aと層Dの比較

| | 層A(冷却) | 層D(使用状況 pre-launch veto) |
|---|---|---|
| いつ学習するか | **起動して** rate-limit 応答を受け取ってから(reactive) | 起動する**前**、UsageHud と同じキャッシュを peek するだけ(proactive) |
| 対象 tier | 梯子の**どの tier でも**(w.model が分かれば) | **トップ tier(fable)のみ**(account-wide %しか無いため) |
| 情報源 | PTY 画面の rate-limit 文言 / A5 の reset 時刻 / grace | A5 の pct(session/weekAll) のみ |
| 閾値 | (時刻の話。pct 概念なし) | **pct >= 100 のみ**(95% 等では絶対に動かない ── 「まだ使えるはずの枠を事前に狩りすぎない」というオーナー確認済み方針) |
| 未知/取得不可のとき | mark 自体が起きない(何も変わらない) | `usage=null` → **false = 非枯渇扱い**(fail-open。層Cのfail-closedとは対照的) |

### 5.7.4 テスト・裏取り

`src/lib/server/swarmLaunch.test.ts` の `isTopTierExhaustedByUsage (fail-open pure predicate)` と `resolveAvailableTier / resolveSwarmModelEffort — usage-cache veto` の2 describe ブロックが仕様のピン留め(null/gray-zone/100%/mask との独立性/cooling との合成の5ケース)。`usage` は全テストで直接注入 ── globalThis キャッシュや node-pty spawn には一切触れない。

---

## 6. 状態機械 / データフロー(1周)

```
[spawn 要求: worker/manager/supply/panel/brain]
        │ desired tier ← 実行モード×role×カード重み (swarmLaunch.ts:148-174)
        ▼
resolveAvailableTier(desired, now, allowed, usage)   … 層A+C+D (usageは層D=A5 pre-launch veto、§5.7)
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
冷却期限 until 経過 → lazy expiry で自動復活 (swarmQuota.ts:256-259) → `quota park lifted` (4466)
```

カスケードは特別扱いなしの創発: fable が冷える→opus で spawn→opus も limit→opus も冷える→sonnet…(swarmQuota.ts:210-215)。

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
3. **どちらを使うか**: 冷却は newest-wins でセンサーに上書きされ得る揮発層(§2.3)。「確実に・長く」は mask、「今の窓だけ」は cool。

### 7.3 復帰したら

- 手動 cool を張った/センサーの mark が残っている → `uncool`(idempotent):
  ```bash
  curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/uncool \
    -H 'content-type: application/json' -d '{"tier":"fable"}' | jq .launchTier
  ```
- mask OFF にしていた → ON へ戻す(7.2-2 の逆)。**uncool は OFF tier を復活させない**(独立2拒否権 §0)。
- 放置でも cooling は until で自然解除+journal に `quota park lifted`(4466)。none-allowed だけは人間必須。

### 7.4 誤検知(健全 tier が冷えた)

一過性 5xx・`retrying in Ns` 等で 20分冷えることがある(§3.1 の残余リスク)。`uncool` で即解除(swarmQuota.ts:240-243 がまさにこの用途)。

---

## 8. 落とし穴(司令塔が実際に踏んだ事象を含む)

1. **`tiers[]` の cooling:false を「使える」と誤読** — mask 盲目(§2.6)。判断は `launchTier` で。
2. **アプリ再起動で冷却が全消え** → 枯れ tier が復活して再突入(swarmAllowedModels.ts:8-9)。再起動後は quota API で冷却が空なのが正常。恒久は mask。
3. **手動 cool がセンサーに短縮される**(newest wins §2.3)。7日 cool を打っても、次の sighting が PTY/A5 から短い reset を解決すればそちらで上書き。
4. **「journal に rate-limited が無い」は無実の証明にならない** — かつては検知自体が最大20分超盲目だった(§4、`0d1f7f0` で根治・実測待ち)。根治後も journal は ring 200 行+再起動で全消えなので、疑ったら worker 画面と /usage を自分で見る。
5. **rate-limit hold 中の worker は「止まって見える」が正常動作** — nudge されず、20分後に todo requeue、**branch にコミットは残る**。消えた扱いで worktree を掃除しない([[swarm-janitor が fresh worker を誤殺した事故]]と同型の早合点に注意)。**hold していた時間は実行時間から控除される**ので、「limit で待たされた分だけ寿命が削られて runaway で消える」ことはない(§3.4-6 — 0712 根治。これを放置して 47KB を失った)。
6. **panel 全滅は card の失敗ではない** — `skippedForPark` の defer は rework でも needs-human 前進でもない(§3.5)。「レビューが3回 defer した」と叱る前に quota を見る。
7. **mask を書いたのに効かない** — 実行中プロセスは旧 bundle かもしれない(§5.6)。`grep -c swarmAllowedModels server/dist/index.cjs` で確認してから騒ぐ。
8. **quota API が 403** — owner gate(§2.5)。cockpit で owner ログインしたセッション経由で叩く。
9. **`OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN` を伸ばしすぎても** `MAX_EXEC_MS - 60s` でクランプされる(365-373)。runaway 側の env(`OPENGROUND_SWARM_MAX_EXEC_MIN`、343)と辻褄が取られる。なお **hold 中の時間は runaway 判定から控除される**(§3.4-6)ので、grace を伸ばしても worker の実作業予算は削られない — ただし控除の上限は `HOLD_CREDIT_CAP_MS`(=`MAX_EXEC_MS`、352)で、worker の絶対 wall-clock 寿命は `MAX_EXEC_MS + 上限`(既定 180 分)で必ず打ち切られる。

---

## 9. 既知の穴(バグ・未修正 — 文書化のみ、修正しない)

1. ~~**quota 検知が最悪 20分超遅れる**~~ → **`0d1f7f0`(2026-07-10)で 3 因子とも解消済み**(カード `4d1550d7` done)。当時の 3 因子(沈黙10分ゲート / 装飾再描画による時計後退 / integrate pass の monitor 飢餓)と現行機構の対応は §3.2/3.3/3.6 の各注記、正典は TARGET-STATE §1。実運用での初回実測が未了(◐)。
2. ~~**spawn 直後の limit は「即検知」経路が無い**~~ → **`0d1f7f0` で解消済み**。spawn 初動(≤2 分)に limit 文言が現れ 45 秒継続・commit ゼロ・心拍なしなら 10 分を待たず認定(`earlyLimitConfirmed` — sighting→cooling 約 95 秒)。limit 文言をソース/プランに書くだけの worker は onset 窓で拒否(false-kill ガード)。
3. **手動 cool の保護が無い** — `markCoolingUntil`(手動)と `markRateLimited`(センサー)が同じ Map を newest-wins で共有(swarmQuota.ts:201-203, 226)。手動長期 cool をセンサーの 20分 grace が上書き短縮するのは、オーナー意図の観点では穴(仕様コメントは「newest signal wins」を意図と明言 199-200 — ただし手動 vs 自動の優先問題への言及は無い)。恒久指定は mask で代替可能なので実害は限定的。

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

センサーの書込が2箇所だけであること・spawn 経路の fail-closed:

```bash
grep -rn "markRateLimited(" src/lib/server --include='*.ts' | grep -v test | grep -v swarmQuota.ts
grep -rn "NoAllowedModelTierError()" src/lib/server --include='*.ts' | grep -v test
```

層D(pre-launch veto、§5.7)の裏取り:

```bash
grep -n "isTopTierExhaustedByUsage\|peekCachedUsage" src/lib/server/swarmLaunch.ts   # 実装の存在確認
grep -rn "resolveSwarmModelEffort(" src/lib/server --include='*.ts' | grep -v test   # 全呼出箇所が usage 引数を渡していない=既定値経由で自動適用の裏取り
npx vitest run src/lib/server/swarmLaunch.test.ts -t "usage"                          # ピン留めテストだけ実行
```

実行系(owner セッションで):

```bash
curl -s http://127.0.0.1:47776/api/swarm/quota | jq                      # launchTier が真実
curl -s http://127.0.0.1:47776/api/settings | jq .swarmAllowedModels     # null=全ON
curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/cool -H 'content-type: application/json' -d '{"tier":"haiku","minutes":3}' | jq .tiers   # 3分で自己解除する無害な実験
curl -s -X POST http://127.0.0.1:47776/api/swarm/quota/uncool -H 'content-type: application/json' -d '{"tier":"haiku"}' | jq .tiers
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$HOME/projects/OPEN GROUND" | jq '{running, parkUntil, log: .log[-10:]}'
```

冷却の揮発性(アプリ再起動で消える)と bundle の鮮度:

```bash
node -e "console.log('globalThis 在住 → プロセス毎に空から始まる: swarmQuota.ts:75-82 参照')"
grep -c swarmAllowedModels server/dist/index.cjs   # 0 なら旧 bundle(mask 不在)— 再ビルド要
ls -l server/dist/index.cjs                        # mtime が d1485ea(2026-07-09 18:05)より古ければ確実に旧
```

ケーススタディの一次痕跡:

```bash
grep -n "21m30s" src/lib/server/swarmAllowedModels.ts        # 実測の刻印(:12-13)
grep -n "2026-07-09" src/lib/server/swarmOrchestrator.ts      # per-model 通知 verbatim の由来(:1132-1141)
grep -rl 4d1550d7 ~/.openground/projects/*/tasks.json         # 対応カードの所在(歴史: 起票時 blocked 列 → 0d1f7f0 で修正・done 列。カード本文が当時の3因子の一次記録)
```
