# TARGET-STATE — 理想の稼働形(そこへ走るための北極星)

**対象コミット: `0d1f7f0`**(origin/main tip、2026-07-10)。初版は `a8429b6` 時点(ソース = `cc7c60e`)。その後 `3129a58`(§2 の実装)、`d8431c3`+`aa9cb8d`(§3 の実装)、`0d1f7f0`(§1 の実装)が main に入り、本改訂で反映済み — 本書と 03/06 章の file:line は `0d1f7f0` 基準、01/02/04/05 章は `cc7c60e` 基準のまま(乖離の扱いは 00-INDEX 冒頭)。2026-07-11 の `SWARM_CODE_PATHS` への `server/routes/project.ts` 編入で swarmOrchestrator.ts の :2630 以降は **+3 シフト** — 本書の §6 内参照は新値へ更新済み。
**読者**: 将来の司令塔(og-manage / manage セッション)と、swarm コアを改修する worker。
**この文書の役割**: 「swarm システムがこの状態で回っていれば健全」と言える条件を、**観測可能な形**(コマンドで真偽判定できる形)で列挙する。願望は書かない — 各項目は ①理想の観測可能条件 ②現状とのギャップ(file:line) ③対応カード ④到達判定コマンド、の 4 点で構成する。カード列の表記は 2026-07-10 時点のスナップショット(現在列は tasks.json で確認 — 00-INDEX §6)。

---

## 判定サマリ(2026-07-10 時点・`3129a58`/`aa9cb8d`/`0d1f7f0` 反映後)

| # | 理想 | 現状 | 対応カード |
|---|---|---|---|
| 1 | model 枯渇は 2 分以内に検知され dispatch が正しい tier に落ちる | ✓ **実測済み(2026-07-18 実 Fable 枯渇イベント)— 早期経路 1分42秒(2 分以内)・稼働後経路 10分37秒(設計どおり実クロックで着弾)・tier 繰り下げも実観測(engine 起こしの manager が opus で起動)** | `4d1550d7`(done) |
| 2 | ~~敵対レビューは diff サイズに依らず決着し…~~ **[SUPERSEDED 2026-07-15]** engine はもう敵対レビューをしない(統合は司令官専任・§5) | ⊘ **エンジンから撤去** — レビューは司令官の重量級レビューへ一本化 | `58335c7f`(歴史) |
| 3 | 過去 fatal の再投函ゼロ・dismiss は再起動を跨いで効く | ✓ **実測済み(2026-07-17 re-arm 実験)— arm 前後で exec-timeout 系 escalation 33→33・全体 59→59(増殖ゼロ)** | `c944ea69`(done) |
| 4 | 司令塔 API は嘘をつかない(stale 心拍の解消) | ✓ **実測済み(2026-07-17)— エンジン worker の API `heartbeatAt` とディスク `updatedAt` が完全一致(06:54:51Z、phase も一致)** | 統合済み(`1f19770`) |
| 5 | **統合は司令官専任 — engine は ready 検知で司令官を起こすだけ(main を FF する経路が engine に1つも無い)+ 落ちた司令官を蘇生する反射** | ◐ **実装済み(2026-07-15 マネージャ専任化 + 2026-07-16 manager 蘇生 card B)・実運用での検証待ち** | 本カード + 蘇生 card B(§5 が正典) |
| 6 | 司令塔ドキュメントが変更に追随する | ✓ **検知2点(verify soft-warn + og-manage 起動時の 00-INDEX §6-1 チェック)+ 起票テンプレ組込み(supply / order / og-manage、2026-07-11)実装済み+テンプレ経由の運用実績 1 件**(カード「SWARM_CODE_PATHS に server/routes/project.ts を追加」= 本改訂) | 案 B(検知2点)+案 B'(テンプレ)完了。実績 1 件(2026-07-11) |
| 7 | 再起動が無イベント化している(desiredRunning が人手ゼロで復元・owner の手動停止が常に勝つ・crash-loop breaker で新コードの暴走を受ける) | ◐ **実装済み(2026-07-22, card 2)・単体/統合テスト緑・main 未着地・実機の「本物の再起動」実測待ち** | docs/ENGINE_PERSISTENCE_PLAN.md card 2(本カード) |
| 9 | worker ランタイムは SDK 一系統(PTY は fallback 専用・凍結 — 新機能/新センサーは SDK 側のみ・fallback 0 の 4 週で PTY センサー層を削除) | ◐ **方針宣言(2026-08-12・§9)** — SDK 既定化は済み(0801-02)・削除条件の実測待ち | §9 + [PLATFORM-GAP-LEDGER.md](PLATFORM-GAP-LEDGER.md) |

(◐ = 実装は main 入り・到達判定コマンドでの実測が未。✓ にするのは実運用の観測のみ。)

7 項目すべて ✓ になったとき、司令塔の仕事は「監視と誤診の尻拭い」から「注文と承認」へ縮む — それがこの文書群の終着点。

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

### 実測記録(2026-07-18・実 Fable 5 枯渇イベント・✓ 到達)

同一時刻に 2 worker が limit に当たり、**早期経路と稼働後経路の両方が同時に実測できた**(以下すべて UTC):

| worker | spawn | limit 到達(JSONL 最終活動) | journal 検知 | 差 | 経路 |
|---|---|---|---|---|---|
| ペルソナ①(`owner-0718-132842`) | 04:28:43 | 04:29:24 | 04:31:06 | **1分42秒** | (a) 早期(spawn+41秒 = onset 窓内) |
| 判断ルーティング(`swarm-escalation-0718-132346`) | 04:23:47 | 04:29:27 | 04:40:04 | **10分37秒** | (b) 稼働後(spawn+5分40秒 = onset 窓外 → 10 分沈黙ゲート) |

- **理想「2 分以内」は (a) で達成**(1分42秒 — 設計値「約 1.5 分」と一致)。
- **(b) は設計どおり 10 分ゲートで着弾**。重要なのは **10 分が実クロックで到来した**こと — ②装飾再描画の根治(`limitScreen` クランプ)が効いており、根治前の実測 21 分 30 秒(04 章 §4)のような無限先送りは再現しなかった。
- **tier 繰り下げも同一イベントで実観測**: fable cooling 中の 04:39 に engine が起こした manager は `claude-opus-4-8` で起動し正常稼働(§5 条件 3c の quota 繰り下げが実事象で機能)。両 worker は `holding (requeue after 20m)` で worktree ごと保持。
- 枯渇の確定信号は直叩き(`claude --model fable -p` → "You've reached your Fable 5 limit")— `/usage` からは per-model 枯渇が見えない前提は不変。
- **未カバーの穴(本イベントで判明 → 同日クローズ)**: オーナー自身が開いた対話卓(engine 管理外の claude セッション)は tier 繰り下げも通知も無く、オーナーが目視で気づいて `/model` するまで止まる。engine 管理下の worker/manager だけが救済対象という設計境界の実害 — 下記で対処済み。

**検証待ちの間の司令塔運用(歴史)**: 実際の枯渇イベントで下の到達判定を一度実測して ✓ にする。理想の「2 分以内」を設計上満たすのは **(a) の即死型**(21 分 30 秒事例の再現形)— **稼働後に limit へ当たった worker は最大 ~10 分+スクレイプ間隔**かかる(ただし確実に着く)。稼働後型で 2 分を求めるなら新カードが要る(現状その必要性を示す実測は無い)。それまで「journal に無い = 枯れていない」ではない(00-INDEX §4 — journal は 200 行 ring かつ再起動で消えるため、この原則は根治後も残る)。

#### 未カバーだった穴 — **オーナー自身の対話卓**(2026-07-18 に判明 → 同日クローズ)

同じイベントで、この節が一度も対象にしていなかった経路が露呈した: **オーナーが開いている対話卓**(Terminal タブのペイン・Board 実行・**Swarm タブの司令官ペイン**)は `monitorWorkers` の管理外なので、上限画面

```
You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.
```

を出したまま**無救済で止まっていた**。OG は同じ文言のスクレイプを worker には実装済みだったのに、**人間が待っている卓には向けていなかった** — 「気づかず放置」が発生する唯一の残り穴。

**現状: 実装済み(2026-07-18)** — `src/lib/server/ownerDeskLimit.ts`(**エンジン非依存の boot ループ**。止まる卓は誰も見ていない卓なので、エンジン非稼働でも効かねば意味がない)。

| 観測可能条件 | 実装 |
|---|---|
| 管理外の live 対話卓の上限文言を検知する。検知ロジックは worker 用の既存実装を**再利用**(二重実装しない) | **再利用するのは「判断」で、調律つまみではない**。共有 = 文言(`swarmRateLimitText` — worker/層E と同一モジュール)+ 画面アナトミー(`@/lib/claudeScreen` — swarmQuestions / swarmEscalations と同一の枠モデル。**卓が自前の枠モデルを書いて見逃した**のが 2026-07-18 2回目の差し戻し MF-2)。一方**タイミング門の2定数は意図的に卓の自前**(`OWNER_DESK_QUIET_MS` / `OWNER_DESK_CONFIRM_MS` = 45s)— 初版は engine から import したが差し戻しで却下(engine 側は *worker* の問いに対して定義された値で、worker 都合の調律がオーナーへの通知タイミングを黙って動かす)。**数値のコピーは安全・文言のコピーが腐る**|
| ベル + OS トーストを**1回**。文言はオーナー向け平易文(何が起きたか/どうなるか/どうすればよいか。tier・quota・rate-limit を本文に出さない) | `SwarmInfoEvent='session-limit'` で既存の swarm-info レーンに載る。本文は `buildOwnerDeskLimitDetail`(テストで語彙を固定)。⚠ **「どうすればよいか」は枯渇の種類で変わる**(2026-07-18 3回目の差し戻し MF-1): account-wide 枯渇では**全モデルが枯れている**ので `/model` は嘘の指示になり、オーナーは指示どおりにやって何も起きず**次の一手を失う**。判別は CLI 自身の remedy 行(`MODEL_SWITCH_REMEDY`)を読み返す(どのパターンが当たったかで推測しない)。⚠ **同じイベントで止まった卓は1本にまとめる**(同 MF-2。⛔ 「同じ**パス**で確定した停止を束ねる」では不足 — どのパスに落ちるかは卓ごとの沈黙窓次第で、実測 1秒ズレ→2通知・15秒ズレ→同一本文6行。窓はイベントを覆う必要がある): account-wide はほぼ全卓を止め(ただし**同時刻ではない** — 各卓は自分の実行中リクエストが着弾した時点で止まる)、`deskLabel` が付くのは司令官/補給官だけなので、卓ごとに鳴らすと**同一本文が6行**並ぶ(⚠ 根拠は**オーナーが読む側の雑音**。「cap を圧迫して fatal を押し出す」は cap の kind 別分離 `capNotificationsByKind` が main に入って以降**成立しない**) |
| 同一セッションの同一枯渇は1回だけ(復帰後の再発は再通知) | 卓ごとの `notified` フラグ。**await の前に立てる**ので遅い/失敗した通知が2度目を許さない。⚠ **再武装は最後のフレームではなく「停止そのもの」に結ぶ**(2026-07-18 2回目の差し戻し MF-3): 不一致フレーム1枚で消すと、止まった卓でオーナーが1文字打って消すだけで 一致→不一致→一致 と往復して**同じ停止で2度目が鳴る**。`OWNER_DESK_REARM_READS`(=3)回**連続**で normal を読むまで再武装しない。**読めなかった画面は数に入れない**(証拠が無いことは回復の証拠ではない) |
| 誤検知しない(文言を**書いただけ**の卓を検知しない) | worker と同型の門(出力45秒沈黙まで読まない/通知が45秒画面を保持して確定)に加え、卓には裏取り材料(onset窓・commit・心拍)が無いぶん **4段厳しく**: **文言**(`QUOTA_REFUSAL_PATTERNS` — 一時故障に加え素の `/usage limit/` も除外)+ **話者**(`❯`=オーナーが貼って送ったターンは弾く)+ **原因の明示**(救済行だけの一致は「救済を話題にしている」)+ **位置3方向**(`endsInQuotaRefusal` — 末尾・先頭・**一致領域の内部**)。⚠ **端点2つだけを縛る判定は「限界文言で始まり限界文言で終わる」報告文に構造的に無力**(2026-07-18 3回目の差し戻し)。⚠ **先頭は文字数では測れない** — 本物の助走 `you've ` も引用導入 `引用します: ` も7字で、日本語は英語の約2.5倍密。句読点で判定する。⚠ **生画面の文字距離で測ると機能しない**(2026-07-18 差し戻しで判明・04章 §3.7 の ⚠ が正典): 入力箱だけで 184/264/424字(80/120/200col)あり普通の画面が丸ごと 800字の尾に収まる。かつ本物307 vs 誤発火304で**クラスが重なる**ため閾値調整では直らず、締めると本物が沈黙する。3幅での回帰テストは `ownerDeskScreens.test.ts`(実 headless xterm でレンダリング) |
| **自動でモデルを切り替えない** | deps は列挙・画面読み・通知の3つだけで、**入力の seam 自体が無い**(構造的に触れない) |

機構の正典は 04 章 §3.7、監視の守備範囲は 02 章 §1 の注記。キルスイッチ `OPENGROUND_DESK_LIMIT_WATCH=0`(既定 ON)。

**オーナー卓側の実測(上限表示 → ベル/トーストまで、設計上 約1.5〜2分)は次の枯渇イベント待ち。**

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

# --- オーナー対話卓の穴(上の「未カバーだった穴」)が塞がっているか ---
# 1) 監視ループが boot で起きるか
grep -n "startOwnerDeskLimitLoop" server/index.ts src/lib/server/ownerDeskLimit.ts
# 2) 門の2定数が「卓の自前」であること(engine から import していたら劣化 — 2026-07-18 差し戻しで
#    却下された初版の形。worker 都合の調律がオーナー通知のタイミングを黙って動かすため)。
#    ※ import 判定は import 文で見る — 素の名前 grep は解説コメントに当たって偽の緑になる
grep -n "^import.*swarmOrchestrator" src/lib/server/ownerDeskLimit.ts   # ← 0 件が正
grep -n "^export const OWNER_DESK_QUIET_MS\|^export const OWNER_DESK_CONFIRM_MS" src/lib/server/ownerDeskLimit.ts
# 2b) 逆に「文言」と「画面アナトミー」は共有でなければ劣化(卓が自前の枠モデルを書いて
#     本物を見逃したのが MF-2)。この2本は import されていること
grep -n "from './swarmRateLimitText'\|from '@/lib/claudeScreen'" src/lib/server/ownerDeskLimit.ts src/lib/server/swarmRateLimitText.ts
# 3) 文言+位置の2段になっているか(matchesQuotaExhaustion 単独なら誤検知ガードが1段外れている)
#    卓側は kind まで要るので classifyQuotaRefusal を呼ぶ(endsInQuotaRefusal はその boolean 面)
grep -n "classifyQuotaRefusal" src/lib/server/ownerDeskLimit.ts
# 3a) 案内が枯渇の種類で分岐しているか — 常に /model なら MF-1 の退行(account-wide で嘘の指示)
grep -n "model-switchable\|account-wide" src/lib/server/ownerDeskLimit.ts | head -5
# 3a') その判別が CLI 自身の remedy 行を読み返す形か(どのパターンが当たったかで推測していないか)
grep -n "MODEL_SWITCH_REMEDY" src/lib/server/swarmRateLimitText.ts
# 3b) 位置を「会話本文」で測っているか — 生画面の文字距離に戻っていたら退行(§3.7 の ⚠)
grep -n "stripScreenChrome\|OWNER_DESK_TAIL_MAX = " src/lib/server/swarmRateLimitText.ts
# 3c) 折返し行を連結して読んでいるか(素の getTerminalScreen だと 80col で本物が沈黙する)
grep -n "getTerminalScreenLogical" src/lib/server/ownerDeskLimit.ts src/lib/server/terminal.ts
# 3d) 合体しているか — 卓ごとに notify していたら MF-2 の退行(同一本文がベルを埋める)
grep -n "buildOwnerDeskLimitMergedDetail\|pending.push" src/lib/server/ownerDeskLimit.ts
# 3d') その窓が「パス」ではなく「イベント」を覆っているか。⛔ パス単位に戻っていたら
#      卓の停止が1秒ズレるだけで分離発火する(実測 1秒→2通知/15秒→6通知)。
#      MERGE 定数が消えていたら退行 — テストも skew を必ず振ること(振らないと緑のまま通る)
grep -n "OWNER_DESK_MERGE_QUIET_MS\|OWNER_DESK_MERGE_CAP_MS" src/lib/server/ownerDeskLimit.ts
grep -n "skew" src/lib/server/ownerDeskLimit.test.ts | head -3   # ← 0 件なら穴が再発している
# 3e) 画面が読めないとき生バッファに落としていないか(落とすと枠を認識できず静かに失明する)
grep -n "stripAnsi" src/lib/server/terminal.ts   # ← 0 件が正
# 4) 卓に印が付く経路(オプトイン。ここが空なら誰も監視されていない)
grep -rn "ownerDesk: true" server/routes/terminal.ts src/lib/server/swarmManager.ts src/lib/server/swarmSupply.ts
# 5) 事象発生後: ベルに載ったか(永続通知。トーストは消えても記録は残る。owner ログイン必須 — 非 owner は 403)
curl -s "http://127.0.0.1:47776/api/swarm/notifications" | jq -r '.notifications[]? | select(.swarmInfo.event=="session-limit") | "\(.createdAt) \(.swarmInfo.detail)"'
```

---

## 2. 敵対レビューは diff サイズに依らず決着し、棄権には必ず理由が残る

> **⚠ 2026-07-15 マネージャ専任化で前提が変わった**: engine の敵対レビュー(lens パネル)
> そのものが撤去され、この節の「実運用での検証待ち」は engine 側では**永遠に来ない**。
> budget 根治(`3129a58`)の設計と実測境界は、司令官の手動統合(03 章 §5)が大 diff を
> 扱う際の照合点、およびパネル復活時の設計基準として保持する。

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

**司令塔運用(2026-07-15 更新)**: engine はもうパネルを回さないので「arm 下で見届ける」運用は消滅。大 diff の review カードは 03 章 §5 の手動統合(重量級レビュー)が唯一の経路 — 上の実測境界(22〜34KB)は「このサイズ帯から反射的に読めなくなる」負荷感覚の照合点として使う。

### 対応カード

`58335c7f-7621-46cd-a1ae-3cd4c150e581` — 「[swarm] 敵対レビューが lens 棄権2件で必ず needs-human に落ちる — 棄権の理由がどこにも残らない」(**`3129a58` で修正・2026-07-10 時点 done 列**)。

### 到達判定コマンド

```bash
# (歴史)34KB 超 diff の凍結行が出ないこと — engine パネル撤去(2026-07-15)で engine 側の実測は永遠に来ない
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

**実測記録(2026-07-17・✓ 到達)**: 到達判定コマンドどおり re-arm 実験を実施 — overseer OFF→ON、95 秒後に exec-timeout 系 escalation 33→33・全体 59→59 で**増殖ゼロ**。実験後 overseer は OFF に復帰。以後上がる S3/S10 は「24h 窓内の未受領 occurrence」= 実発生として扱う(06 章 §5.1)。

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

`swarm/swarm-workers-api-heartb-*` ブランチで実装 → **`1f19770` で main 入り(2026-07-11)**。**実測済み(2026-07-17・✓ 到達)**: live エンジン worker(stage:running)で API `heartbeatAt=2026-07-17T06:54:51Z` がディスク `updatedAt` と完全一致(phase=audit も一致)。

### 到達判定コマンド

```bash
# エンジン worker(stage 付き)についてディスクとAPIの heartbeatAt が一致するか
curl -s "http://127.0.0.1:47776/api/swarm/workers?path=<PATH>" | jq -r '.workers[] | select(.stage) | "\(.branch)\t\(.heartbeatAt)"'
for f in ~/.openground/swarm/*/*.json; do jq -r '"\(.branch)\t\(.updatedAt)"' "$f"; done
# 両者の同一 branch 行が一致すれば到達(修正前は乖離が残り続けていた)
```

---

## 5. 統合は司令官専任 — engine は ready 検知で司令官を起こすだけ

> **2026-07-15 マネージャ専任化で本節の理想が変わった。** 旧理想は「autoMerge を常時 arm
> できる(engine が自動統合する)」だった。それは 2026-07-15 の事故 —— autoMerge が司令官の
> 差し戻しと並行で穴あきブランチを main に FF した + engine のレンズ 4 票 clean が auth の
> camelCase 取りこぼしを見逃した —— を受けて**撤回**された。新しい理想は下記。

### 理想(観測可能条件)

**3層設計(2026-07-15/16 で確立)**: **worker = 手**(コードと心拍だけ)/ **engine = 神経系 + 反射**
(検知して機械的に対処する — dispatch・monitor・runaway reclaim、そして **manager 蘇生**)/ **manager = 脳**
(統合・配車の判断)。統合は脳(manager)専任で、engine はもう統合しない。だが統合が manager 専任である以上
**manager が落ちたら swarm 全体が止まる** —— そこで engine は**反射**として manager の生死を監視し、止まったら
蘇生する(神経系が脳を蘇生する)。**蘇生は反射であって判断ではない** —— engine は起こすだけ、統合の判断は
蘇生後の manager がやる。成立条件:

1. **engine の統合経路(runIntegratePass の verify→レンズ→FF push→land)が撤去され、engine が
   main を FF する経路が1つも無い。** レンズ結果だけで main が動く経路は金輪際ゼロ(回帰テスト
   `swarmOrchestrator.test.ts`「manager-only integration wake / 受け入れの肝」+ integration
   「WAKES the commander and NEVER FF-pushes」で固定)。
2. **worker が ready(review 昇格)になったら engine が司令官を起こす** — **エンジン ON で常時**
   (2026-07-16 に独立の autoMerge トグルを廃止 — 「エンジン ON・起こし OFF」の中途半端な既定が
   ready 品の滞留を生んだため)。review の swarm カードがあり司令官の卓が不在/沈黙なら
   `spawnSwarmManager` で起こす。複数 ready はまとめて1回(バッチ)。統合の同意粒度は
   カード単位([hold] + 高リスク force-hold)が担う。
3. **manager 蘇生反射(card B, 2026-07-16 / 判定を 2026-07-18 に是正)** —— engine は manager の
   生死を監視し、**本当に**止まったら蘇生する:
   (a) **検知**は presence 3 状態(`absent`/`idle`/`active`)。卓の存在は **live PTY 1信号**で決まり、
      「動いている証拠」は **OR**(心拍が新鮮 **or** PTY が最近描画 **or** セッション JSONL 更新)。
      **心拍単独では死を意味しない** —— 心拍は重い統合中しか打たれないので、対話中の健全な司令官は
      平常運転で無音になる(2026-07-18 に AND 判定で生きた司令官を 3 回蘇生し誤 fatal を上げた実事象)、
   (b) **`absent`(卓が無い)なら `spawnSwarmManager` で蘇生**。**`idle`(卓は在るが無音)は蘇生せず
      nudge**(10 分間隔・3 回上限)—— live PTY が握るセッションは `--resume` 不可のため、
      蘇生すると記憶なしの重複卓が増え動いていた卓が孤児化する(実測 idle 卓 16 本)。
      ただし**二重起動防止を presence の「`absent` でしか spawn しない」だけに委ねない**
      (2026-07-19/20 + 2026-07-22)—— 最終ガードは `spawnSwarmManager` 自身が持つ:
      **PTY プールで存在を判定**し、**プロジェクト単位の spawn ロックで check-then-act を閉じる**
      (真に同時な engine 反射 + オーナーのボタンでも卓は1つ)。03 章 §2.3 の囲みが正典、
   (c) quota 壁で落ちたなら**枯れていない tier へ繰り下げてから**蘇生(同じモデルは同じ壁)、
   (d) 起動直後に毎回落ちる場合は **3 連続失敗で諦め `manager-unrevivable` fatal** をオーナーへ上げる
      (無限に蘇生してトークンを焚かない)。**この fatal の意味は「卓を起動できない」**であり、
      `absent` 経路でしか上がらない(`idle` の間は何回パスが回っても上がらない)。回帰テストは
      integration「RESURRECTION reflex, REAL manager heartbeat」(実ファイルで 卓在り→死→spawn 3回→
      fatal→復帰、加えて **live だが無音 → `idle`(蘇生しない)** を HOME 隔離で通し)+ unit の
      (a) 生きた無音卓は蘇生しない /(b) 死んだ卓は蘇生 /(c) nudge throttle+budget /(d) fatal の条件、で固定。
4. **統合(重量級レビュー + 手動 FF push)は司令官が行う** — fail-closed 0票禁止・高リスク
   force-hold の安全網も司令官側(skills/og-manage §「マージ」)。engine 側の verify/レンズ/
   force-hold は撤去/dormant で**二重管理しない**。
5. **緊急バックドア温存** — 司令官の手動統合(§5 の FF push・「マージ」フロー)はそのまま。engine が
   統合しなくなっても司令官は統合できる(主経路)。
6. 観測(到達の定義): エンジン ON のまま運用し(起こし反射は常時 — arm 操作は無い)、
   (a) engine 由来の main への FF push がゼロ(そもそも経路が無い)、(b) ready カードに対し
   司令官が起こされ統合判断が入る、(c) 司令官不在で ready が放置され続けない、(d) 固まった/
   落ちた司令官が蘇生され、蘇生不能なら fatal が上がる。

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

- **実装は main 入り(2026-07-15 マネージャ専任化)**: runIntegratePass の B相は「司令官を起こす」だけに
  置換され、verify/レンズ/FF push/land/reworkOrPark/delegateConflict は撤去。回帰テストで「engine が
  main を FF する経路ゼロ」を固定済み。残るのは **実運用での検証** —— 実際に ready カードで司令官が
  起こされ、統合判断が入る様子を見届けること(◐ → ✓ の壁)。
- **manager アクティブ判定は精緻化済み(card B, 2026-07-16)**: live-PTY のみだった暫定シグナルは
  **live PTY + 心拍鮮度(10 分無音でハング)の 2 信号 AND** に精緻化された。live だが hang した卓も
  検知され蘇生される。残るは **実運用での検証** —— 実際に固まった司令官が蘇生され、恒久障害なら fatal が
  上がる様子を見届けること(◐ → ✓ の壁)。
- **自己更新トリガ(再接続済み 2026-07-17)**: engine の land 時に発火していた `requestEngineSelfUpdate` は
  マネージャ専任化で一度 dormant 化したが、**司令官の手動統合フローの掃除段へ再接続された** —
  `POST /api/swarm/worktree/remove`(force:false — og-manage §マージ手順7「統合成立を確認してからのみ掃除」)の
  worktree 撤去成功時に、その branch tip が trunk(origin/main、無ければ local main)から到達可能かを
  read-only(rev-parse/merge-base のみ — fetch もしない)で再判定し、真なら発火する
  (`selfUpdateOnIntegrate.ts` → `removeSwarmWorktree` 配線)。観測点 = remove 応答の
  `selfUpdate.{detected,requested}` + 実発火時の bell 通知 `self-update-requested`
  (`selfUpdateOnIntegrate.test.ts` で固定)。**engine が main を FF する経路は増えていない**(条件1不変 —
  force:true の kill/abandon 系 teardown は判定自体を通らない)。実発火は従来どおり SELF_UPDATE_ARMED
  環境のみ(selfUpdateSignal.ts の二重ゲート + electron 側 single-flight 不変)。既知の狭い過剰発火:
  コミットゼロ worker の非 force 掃除も ancestor 判定を通る(spawn-base 非記録のため区別不能 — armed
  開発ランで同一ソースの再ビルドが1回走るだけなので受容)。残るは armed 実機での実発火の実運用観測(◐)。

### 対応カード

**2026-07-15 マネージャ専任化**(統合を司令官専任に)で B相を「起こすだけ」に置換 main 入り。**2026-07-16
manager 蘇生 card B**(manager 心拍 + engine が死/ハングを検知し蘇生・quota 繰り下げ・無限ループ上限・fatal
通知)で条件 3 を実装 main 入り。**2026-07-18 誤 fatal 修正**で条件 3(a)(b)(d) を是正 —— 心拍単独判定
(`live PTY AND 心拍新鮮`)をやめ presence 3 状態へ。生きている司令官を死と誤判定して蘇生を連打し
誤 fatal を上げる/重複卓を量産する経路を塞いだ(`idle` は nudge のみ・spawn は `absent` 限定)。**同日の autoMerge トグル廃止**で条件 2 の「常時」化(arm 不要 —
`engine.autoMerge` / POST automerge / UI トグル / i18n 撤去、GAP-5 の同意粒度判断は [hold]+force-hold で
確定)。三者で条件 1-6 の**機構は揃った** —— 残るは実運用検証(下の到達判定コマンド)。

### 到達判定コマンド

```bash
# engine が「司令官を起こした/蘇生した」ログが出ているか(起こし反射はエンジン ON で常時 — autoMerge フィールドは 2026-07-16 撤去済み・出ない)
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq '{running, reviews, log: [.log[] | select(.message | test("マネージャーを起こしました|応答しないため蘇生|連続で蘇生に失敗|蘇生せず声をかけました|声かけに応答しません|integrated"))] | .[-10:]}'
# ↑ 実際に出る文字列は「worker ready — マネージャーを起こしました」「マネージャーが応答しないため
#   蘇生しました(N回目)」(⚠「司令官を起こしました」という行は存在しない — 旧 test 文字列はこれを
#   取りこぼしていた)。「integrated (ff)」は engine が統合しなくなったので二度と出ない。
#   3 連続失敗なら通知ストアに 'manager-unrevivable' fatal。
#   2026-07-18〜: 卓が在るのに無音のときは蘇生せず「蘇生せず声をかけました(N/3回目)」が出る
#   (この行が出ている間は spawn も fatal も起きていない=正常)。3 回使い切っても無反応なら
#   「司令官の卓は起動しているが N 回の声かけに応答しません」が1回だけ出る(03 章 §7-10)。
# 司令官の心拍を直読。⚠ 2026-07-18 以降、updatedAt が古いこと自体は「ハング」を意味しない —
# 心拍は重い統合中しか打たれないので、対話中の健全な司令官は平常運転で数時間前のままになる。
# 蘇生の判定は presence(卓を握る live PTY の有無 + 描画/JSONL 更新)側。在処は固定名 manager.json:
jq '{role, updatedAt, phase}' ~/.openground/swarm/*/manager.json 2>/dev/null || echo "manager 心拍なし(司令官がまだ beat していない)"
# 同じ心拍は API でも読める(検品可視化 2026-07-17 — Swarm タブの「検品」表示のデータ源。
# fresh はサーバ時計計算・null=心拍なし。03 章 §2.3「表示面」):
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq '.manager'
# 自己更新トリガの観測 — 司令官の統合掃除(worktree/remove force:false)の応答 selfUpdate を見るか、
# 実発火の永続記録(bell 通知 'self-update-requested')を引く(unarmed 環境では requested:false が正常):
curl -s "http://127.0.0.1:47776/api/swarm/notifications" | jq '[.notifications[] | select(.swarmInfo.event=="self-update-requested")]'
```

---

## 6. 司令塔ドキュメントが変更に追随する仕組み

### 理想(観測可能条件)

- swarm コアを変更する**すべての**カードが、完了条件に「`docs/commander/` 該当章の更新(更新不要ならその明示判断)」を含む。対象パスの目安は verify の swarm-safety ゲートが監視する集合と同じ(`SWARM_CODE_PATHS` — swarmOrchestrator.ts:2642-2648。`server/routes/swarm.ts` に加え `server/routes/project.ts`(Board API = 05 章の契約面)も 2026-07-11 に集合へ編入済み — 理想と実装の集合が一致した)。
- 各章冒頭の「対象コミット」と origin/main tip の乖離が、司令塔の定型チェック(00-INDEX §6-1 のワンライナー)で**セッション開始時に**検知される。
- 観測: swarm コアの .ts に触れた main コミットの後、docs/commander/ の該当章が同時(または直後のカード)に更新されている — `git log` で対応が追える。

### 現状とのギャップ

- **検知2点は実装済み**(本改訂・カード「docs 追随の仕組み化(後段)」):
  1. **verify soft-warn** — `makeVerify`(swarmOrchestrator.ts:2913 付近)が `SWARM_CODE_PATHS` 相当(`touchesSwarmPaths`)に触れつつ `docs/commander/` 無変更の diff を検知すると `verdict.docsWarning` を立て、`runIntegratePass` がそれを engine journal に `warn` 1 行(`swarm code changed without a docs/commander/ update: <branch>`)として記録する。**block はしない**(`ok` には一切影響しない — 統合は通常どおり進む)。テスト: `swarmOrchestrator.integration.test.ts` の `docs-freshness soft-warn: ...` 2 件(docs 無変更 → warn あり / docs 更新あり → warn 無し)。
  2. **og-manage 起動時チェック** — `skills/og-manage/SKILL.md` の「前提・環境確認」に、00-INDEX §6-1 の乖離チェック(対象コミットと origin/main tip の diff --stat)をセッション開始手順として追記済み。
- **起票テンプレへの組み込みも実装済み**(案 B'、2026-07-11): 補給官(`~/.claude/skills/supply/SKILL.md` 手順3、正典は repo `skills/supply/SKILL.md`)・/order(`~/.claude/skills/order/SKILL.md` 入力1、正典は repo `skills/order/SKILL.md`)・og-manage(`~/.claude/skills/og-manage/SKILL.md`「注文」手順3、正典は repo `skills/og-manage/SKILL.md`)の3テンプレすべてに「SWARM_CODE_PATHS 相当に触れるカードは、完了条件に docs/commander/ 該当章の更新(更新不要ならその明示判断)を含める」ルールが入った。役割分担: テンプレは**起票時の予防**、コード側の検知2点は**事後の警報**(journal warn は 200 行 ring で再起動により揮発する — 00-INDEX §7 — ため警報だけでは「気づかれず放置」を防げない。両輪で塞ぐ)。**2026-07-22 追記**: 当時 og-manage だけが「アプリ起動時に repo 正典から自動配備」だったが、3スキルとも repo 正典(+ `scripts/swarm-beat.sh` / `scripts/openground-swarm-lib.sh`)から `server/index.ts` boot 時に同じ idempotent installer(`swarmToolingInstall.ts` / `ogManageSkill.ts` が共有する `managedFileInstall.ts`)で自動配備されるようになった(marker 無しの手編集ファイルは kept-user として不可侵)。非対称は解消 — 3スキルとも「repo 内から直接編集できる」。**2026-07-23 追記**: シェル補助の配備名を `swarm-lib.sh` → **`openground-swarm-lib.sh`** に改名した(`SWARM_LIB_BASENAME`)。ユーザの `~/.claude/swarm-lib.sh` は旧 tmux コックピット時代の**手書き 12 関数**で、~/.claude 配下の別スクリプト群がそれを source している — OG 版(2 関数)を同名で配備すると、kept-user の盾が外れた瞬間(利用者が「kept-user (marker missing)」のログを見て自分の copy を消す等)に 10 関数が消えて `sw_session: command not found` 系で**静かに壊れる**。配備先を分けたので旧ファイルはもう install 対象ですらない。**配備名を旧名に戻さないこと**(回帰テスト = `swarmToolingInstall.test.ts` の describe「legacy ~/.claude/swarm-lib.sh collision」)。`scripts/swarm-beat.sh` の source 行(`$(dirname "$0")/openground-swarm-lib.sh`)と `package.json` の `build.files` allowlist も同じ名前で追随する 3 点セット。

- **【2026-08-01 に見つかった穴】`SWARM_CODE_PATHS` が SDK ランタイムの中核ファイルを1つも拾わない。**
  集合の第1要素は `^src/lib/server/swarm[^/]*\.ts$` = **ファイル名が `swarm` で始まるもの**なので、
  `swarmEscalations.ts` / `swarmOverseer.ts` / `swarmManagerRuntime.ts` /
  `swarmWorkerRuntimeDial.ts` / `swarmWorkerRegistry.ts` は入る。しかし
  **`sdkSession.ts` / `sdkEvents.ts` / `sdkGuardHook.ts` / `sdkDeskLimit.ts` /
  `workerRuntime.ts` / `liveDesks.ts` は1つも入らない**(UI 側も
  `^src/components/canvas/modules/Swarm[^/]*$` なので `SdkWorkerPane.tsx` は外)。
  同じ述語 `touchesSwarmPaths` が **swarm-safety スイートの起動条件**(`appliesTo`)にも
  使われているので、影響は文書追随の soft-warn だけでは終わらない — **worker の生死判定と
  guard 配線を書き換えるブランチが、安全網の適用対象外として通り抜けうる。**

  **【この節の初版にあった過大主張を撤回する(0801 の点検)】** ここには
  「0801 の6周のレビューで摘出した欠陥は**ほぼ全部この集合の外側**にあった」と
  書いてあった。**コミット単位で実測すると偽。** 0731–0801 のレビュー系
  fix/test コミット **19 本**を当時の集合に当てると、**17 本は内側のファイルを
  1つ以上含んでいた** — 多くは同一コミット内の兄弟(`swarmSdkWorkerContract.test.ts` /
  `swarmOrchestrator.ts` / `SwarmModule.tsx` / `swarmEscalations.ts`)。
  つまりそれらのブランチでは `touchesSwarmPaths` は **true** で、
  swarm-safety も soft-warn も**発火していた**。「ほぼ全部すり抜けた」は起きていない。

  **完全に外側だったのは 2 本。ただしその 2 本が最悪の 2 件だった**(だから穴は本物):
  - `94e60bd5`「稼働中 worker の worktree を消す最悪の穴」=
    `liveDesks.ts` / `worktreeCleanup.ts` / `sdkSession.ts` / `server/routes/terminal.ts`
  - `dd311acc`「配布ビルドでは SDK worker が1体も起動しない(critical)」=
    `sdkGuardHook.ts` / `scripts/build-server.js`

  教訓は**数の話ではなく書き方の話**: 機構の欠陥を「実際にこう抜けた」と断ずると、
  次の人は数え直さない。**穴の存在**(集合の定義から導ける)と
  **抜けた実例**(コミットを数えて初めて言える)を分けて書くこと。数え直す手:

  ```bash
  # 各コミットが当時の集合の内側/外側どちらだったか(0 = 完全に外側 = 素通りしうる)
  git log --format=%h --since=2026-07-31 | while read c; do
    n=$(git show --name-only --format= "$c" | grep -v '^$' | grep -cE \
      '^src/lib/server/swarm[^/]*\.ts$|^server/routes/(swarm|project)\.ts$|^src/components/canvas/modules/Swarm[^/]*$|^server/index\.ts$')
    echo "$n $c $(git log -1 --format=%s "$c")"
  done
  ```

  ⚠ **これは「文書が現物と食い違っている」ではなく「機構に穴がある」** ので、
  文書側だけでは閉じない。**0801 に `SWARM_CODE_PATHS` へ追加済み**(現物 =
  `swarmOrchestrator.ts` の同定数): `^src/lib/server/sdk[^/]*\.ts$` /
  **`^server/routes/sdk[^/]*\.ts$`**(SSE 終端 — 初版の処方箋はこれを落としていた。
  `^server/routes/swarm\.ts$` にも sdk 正規表現にも当たらないので、名指ししない限り漏れる)/
  `^server/routes/__tests__/sdk[^/]*$` / `^src/components/canvas/modules/Sdk[^/]*$` /
  `^src/lib/server/(workerRuntime|liveDesks|worktreeCleanup)[^/]*\.ts$` /
  `^server/routes/terminal\.ts$`。
  **残っている外側(0801 時点・未修正、編入するかは未判断)**:
  - `src/components/canvas/modules/useSwarmEngine.ts` — Swarm タブの配線を持つが
    `Swarm[^/]*` にも `Sdk[^/]*` にも当たらない(0801 の欠陥1件がここにあった)。
  - `scripts/build-server.js` — **配布ビルドでだけ死ぬ欠陥 2 件が、どちらもここ絡み**
    だった(`dd311acc` = esbuild が guard hook をどう畳むか / `e26d5efb` 0802 = CJS 出力が
    ESM 専用パッケージを読めない)。どちらも同じコミットが `sdk*.ts` も触ったので
    **結果的に**ゲートは発火したが、ビルドスクリプトだけを触るブランチは今も素通りする。
    **2 件目が出た以上「たまたま巻き込まれる」に賭け続ける根拠は無い**(編入は未判断)。

  ⚠ **番人は「ある」が、0801 の追加分をまだ見ていない**(0801 時点の観測)。
  `swarmOrchestrator.integration.test.ts` の `describe('touchesSwarmPaths — the
  swarm-code path matcher')` は正しい形 —— 集合の中身ではなく**実ファイル名が
  true になること**を見る —— だが、並んでいる実名は編入前のもの(`swarmOrchestrator.ts` /
  `server/routes/swarm.ts` / `project.ts` / `SwarmModule.tsx` / `server/index.ts`)だけで、
  上の SDK 系エントリ(`sdkSession.ts` / `server/routes/sdkSession.ts` / `workerRuntime.ts` /
  `liveDesks.ts` / `worktreeCleanup.ts` / `SdkWorkerPane.tsx` / `server/routes/terminal.ts`)は
  **1つも入っていない**。正規表現を消しても番人は緑のまま = 編入が守られていない。
  確認: `git grep -n "sdkSession.ts'\]" src/lib/server/swarmOrchestrator.integration.test.ts`
  が空なら未追随。

### 対応カード

案 B の検知2点+案 B'(テンプレ組込み)まで完了: supply / order は 2026-07-11 にグローバルスキルへ直接追記済み、og-manage はカード「[docs/commander] カード起票テンプレへの文書追随ルール組み込み」で repo 正典(`skills/og-manage/SKILL.md`)に組込み。**テンプレ経由の運用実績 1 件目 = カード「SWARM_CODE_PATHS に server/routes/project.ts を追加」(2026-07-11、本改訂)** — テンプレの docs 追随ルールどおり完了条件に文書更新が入り、同一ブランチでコード+docs/commander/ が一緒に動いた(soft-warn を踏まない形の実測を兼ねる)。§7 の §6 行は ✓。

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

- [x] §1: limit 表示 → journal 検知が 2 分以内 — **実測済み(2026-07-18 実 Fable 枯渇)**: 早期経路 1分42秒 ✓ / 稼働後経路 10分37秒(設計どおり・実クロック着弾)/ tier 繰り下げ実観測。詳細は §1 の実測記録表
- [x] §2: 34KB 超 diff が must-fix ゼロなら統合到達・棄権に理由が残る — **実測済み(2026-07-19〜21 の手動統合ラウンド)**: 1 レビュー単位の最大は **86,741 バイト(約 85KB・基準の 2.5 倍)** = カード 62bfa708(司令官卓の増殖修正・9 コミット / 11 ファイル / +802 −36 行、`e57e73d6^..91d8269c`)。敵対レビュアーは棄権せず verdict を返し、must-fix ゼロ → そのまま統合到達。**棄権(abstain)は本ラウンドで 1 件も発生せず**、よって「棄権に理由が残る」側は未発火のまま(発生時に追記する)。同期間の test-safety 群は累積 554,641 バイト(53 ファイル / +7043 行)だが、これは複数レビューへ分割して渡した累計であり 1 単位の実測値ではない
- [x] §3: overseer re-arm で過去 fatal からの新規 escalation ゼロ — **実測済み(2026-07-17)**: 到達判定コマンドどおり arm→95秒→比較で exec-timeout 系 33→33・全体 59→59。実験後 overseer は OFF に復帰
- [x] §4: エンジン worker の API `heartbeatAt` がディスク `updatedAt` と一致 — **実測済み(2026-07-17)**: live エンジン worker(stage:running)で API `heartbeatAt=2026-07-17T06:54:51Z` = ディスク `updatedAt`(phase=audit も一致)
- [ ] §5: エンジン ON(起こし反射は常時 — 2026-07-16 トグル廃止)7 日間で、ready 放置ゼロ・engine 由来の main FF ゼロ・蘇生反射が実事象で機能 — **部分実測(2026-07-19〜22)・未達**: ① 蘇生反射は**実事象で作動を確認**(7/19〜20 に多数発火)。ただし当時は presence が生きた卓を `absent` と誤読する欠陥があり**誤蘇生**だった(司令官卓が 2 晩連続で 11 卓まで増殖)。真因=記録スロット desync で卓が「名前を失う」/ 修正は 0.11.32 で着地(PTY プールを存在の権威に + 同時 spawn の TOCTOU を per-project ロックで封鎖)。**修正後の正常作動はまだ観測できていない** ② engine 由来の main FF は**ゼロ**(engine は 2026-07-15 以降そもそも統合しない — `runIntegratePass` に push/merge 経路なし。同期間の main 着地はすべて司令官卓の手動統合) ③ **ready 放置は発生した** — 司令官が長時間不在の間、ready worker が滞留(7/20 朝の give-up ラッチ発火時にも統合待ちが残置)④ **7 日連続 ON を達成していない** — 増殖対応のため複数回 OFF にしたため。→ 再カウントは 0.11.32(増殖修正入り)での ON 継続開始日から
- [x] §6: swarm コア変更カードに文書更新が組み込まれ、実績 1 件以上 — **仕組み**(検知2点+テンプレ組込み)実装済み+**テンプレ経由の運用実績 1 件**(2026-07-11、カード「SWARM_CODE_PATHS に server/routes/project.ts を追加」= 本改訂。手動追随の前例は 2026-07-10 改訂)
- [ ] §8: 再起動が無イベント化している(docs/ENGINE_PERSISTENCE_PLAN.md card 2) — 観測可能条件: ①`desiredRunning:true` の project を再起動しても人手ゼロで自動運転が再開する ②owner の手動停止記録(`Settings.swarmManualStop`)が resume より必ず勝つ ③同一バージョンで 10 分に 3 boot 以上なら crash-loop breaker が抑止 + fatal 通知 ④再開時は必ずベル通知(`engine-resumed`)で視認できる。**実装済み・単体/統合テスト緑(2026-07-22, swarmEnginePersistence.test.ts 18件 + swarmOrchestrator.resumeEngines.test.ts 11件 — 2 回の差し戻し対応で追加された分含む。実測値はテストファイルの `it(` 件数で都度裏取りすること、この文書の数字は鮮度が落ちやすい)。実機の「本物の再起動」での実測はまだ(このカードは main 未着地 — 統合後、次の実リリース再起動で①〜④を確認してここに追記する)**。card 4(死んだ worker PTY の `--resume` 会話復元)・card 5(Electron respawn スーパーバイザ)は別カードで未着手
- [ ] §9: worker spawn の PTY fallback が実運用 4 週間 0 → PTY worker センサー層の削除カード起票(§9 の削除条件。方針宣言 2026-08-12 — 経過観測はここに追記する)
- [ ] §8b: worker roster が再起動を跨いで照合される(docs/ENGINE_PERSISTENCE_PLAN.md card 3) — 観測可能条件: ①roster が `~/.openground/swarm/<repoキー>/roster.json` へ**状態遷移点でのみ** write-through される(spawn/promote/reclaim/rework/teardown — tick 毎ではない)②boot の `resumeEngines()` が roster を現実と突合し 4 分岐(worktree 消滅 / ready / 作業途中 / カード消滅)に分類し、**照合が完了するまで新規 dispatch を凍結**する ③teardown が roster エントリを消す ④roster 破損は「外部 worker 扱い」に degrade してサーバを落とさない ⑤`workedMs` の永続で実作業時間会計が再起動で若返らない。**実装済み・単体/統合テスト緑(2026-07-23, swarmWorkerRoster.test.ts + swarmOrchestrator.roster.test.ts + resumeEngines の凍結テスト — 件数はテストファイルの `it(` で都度裏取り。凍結は「await を外すと dispatch が照合前に走る」変異で赤を実測済み)。main 未着地・実機の本物の再起動での実測はまだ**。実際の会話 `--resume` 復元は card 4(未着手)

**未到達の間の司令塔の構え**(各章の運用節の要約): 最初の実枯渇イベントで検知 2 分を実測し、それまで journal の沈黙を無実と読まない(§1)・大 diff の review カードは手動統合が唯一の経路 — 実測境界を負荷感覚の照合点に(§2)・S3/S10 は実発生として裏取り、増殖パターンを見たら回帰を疑う(§3)・鮮度はディスク(§4)・エンジン ON 運用で起こし/蘇生の実事象を見届ける(§5)・セッション開始時に文書鮮度チェック(§6)。

---

## 9. worker ランタイムは SDK 一系統(PTY は fallback 専用・凍結)— 2026-08-12 方針

> **これは機能の理想ではなく「工事の止めどころ」の理想。** 二重ランタイム(PTY/SDK)は
> 観測・質問・証拠・表示のすべての面を 2 倍にし、0802 の事故群(盤面 SDK / 実効 PTY、
> 読めない settings.json でキルスイッチ反転、CJS→ESM で配布ビルドの SDK 全滅)は
> ほぼ全部 parity 欠陥だった — 00-INDEX 冒頭の 0802 追記 2 本がその記録。
> SDK 既定化(0801-02 に worker / manager とも不在既定 sdk へ反転)が済んだ今、
> **PTY worker 系統は「SDK が安定するまでの保険」であって投資先ではない**。
> 凍結のもう一つの面(プラットフォーム補償工事の棚卸しと投資禁止)は
> [PLATFORM-GAP-LEDGER.md](PLATFORM-GAP-LEDGER.md) が正典。

### 理想(観測可能条件)

1. **新機能・新センサーは SDK 系統にのみ足す。** PTY worker 系統(PTY spawn・画面
   スクレイプ・nudge の ESC 送出・onset 窓)への変更は修理のみ(バグ修正・安全修正は
   通常どおり)。レビュー観点: PTY 専用コードへの**機能追加**が diff に現れたら、それ自体を
   設計のスメルとして扱い、カードに「なぜ SDK 側では足りないか」を書かせる。
2. **parity 面を新設しない。** presence / questions / 証拠の尾 / 表示の実効値のように
   「PTY と SDK で取り方が違う」面(00-INDEX 症状表の SDK 行群)をこれ以上増やさない —
   新しい観測が要るときは SDK 側だけに実装する。
3. **fallback 率が観測できる。** worker spawn が PTY に落ちた理由は spawn レスポンスの
   `fellBackBecause` が一次情報(配布版でサーバ log は見えない — 00-INDEX 症状表)。
   live の実効比率は workers API の `runtime` 内訳で読む(レコードの `runtime` 不在 ⇒ pty —
   02 章 §2.4-0 の掟)。
4. **削除条件(この節の終着)**: 実運用 4 週間、worker spawn の PTY fallback が 0
   (または理由がすべて一時故障)なら、**PTY worker 専用センサー層を削除するカードを
   起票する** — `swarmRateLimitText` の worker 画面経路・orchestrator の `limitScreen`
   クランプ / onset 窓(`RATE_LIMIT_EARLY_ONSET_MS` 系)・PTY nudge。削除がゴールで、
   保守はゴールではない。⚠ 削除対象は **worker 系統のみ** — 補給官の PTY(外部窓口・
   リモコン)と `ownerDeskLimit`(人間の卓の監視)は**残る**。人間が座る卓は SDK 化しない。

### 現状とのギャップ

- PTY 系統は fallback として現役。fallback 率の自動集計は無い(目視: spawn レスポンス /
  engine-journal.jsonl)。必要が立証されたら台帳方式(`swarmLandedLedger` の型)を流用する —
  立証前に作るのはこの節自身への違反。
- `swarmEngineSdkBlindspots.test.ts` / `swarmRuntimeDialParity.test.ts` が既知の parity 面を
  ピンしている — 新しい parity 欠陥が出たら、直す前にこの節の条件 2 に照らして
  「その面ごと消せないか」を先に問う。

### 到達判定コマンド

```bash
# live worker の runtime 内訳(sdk 一色なら凍結が効いている)
curl -s "http://127.0.0.1:47776/api/swarm/workers?path=<PATH>" | jq '[.workers[] | (.runtime // "pty")] | group_by(.) | map({runtime: .[0], n: length})'
# ダイヤルの実効値(サーバが実際に使う値 — パネルと同源。00-INDEX 0802 追記)
curl -s http://127.0.0.1:47776/api/settings | jq .runtimeDialsEffective
# PTY 専用コードに「機能追加」が入っていないか(修理は可) — 直近の diff を目視
git log --oneline -10 -- src/lib/server/swarmRateLimitText.ts src/lib/server/claudeScreen.ts
```
