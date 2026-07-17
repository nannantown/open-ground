# 03 — 統合パス: 統合は manager 専任・engine は ready 検知で司令官を起こすだけ

> **⚠ 2026-07-15 中核転換 — マネージャ専任化(manager-only integration)。**
> **エンジンはもう統合しない。** review 列に ready カードが来たら、エンジンは
> **司令官(manager)を起こすだけ**で、verify も敵対レビューも FF push も掃除も
> **一切しない**。統合(重量級レビュー + 手動 FF push)は司令官の専任業務になった。
> これは 2026-07-15 の事故 —— autoMerge が司令官の差し戻し(review→doing)と**並行で**
> 穴あきブランチを main に FF 統合した(かつ engine のレンズ 4 票 clean が auth の
> camelCase 取りこぼしを見逃し、司令官の重量級レビューだけが検出した)—— を受けた
> **構造的**な役割分離。エンジンを統合業務から外すことで、両者が本流で競合する経路が
> 機構ごと消えた(ルール依存ではない)。**エンジンのレンズ結果だけで main が動く経路は
> 金輪際ゼロ**(回帰テストで固定 — `swarmOrchestrator.test.ts` の「manager-only
> integration wake」+ integration の「WAKES the commander and NEVER FF-pushes」)。

**対象コミット: マネージャ専任化ブランチ**(swarm/swarm-engine-manager-aut-…、2026-07-15。
**+ 2026-07-16 autoMerge トグル廃止** — swarm/swarm-engine-automerge-o-…。本章の
`swarmOrchestrator.ts` 行番号はトグル撤去分だけ僅かにずれている可能性がある)。
主戦場は `src/lib/server/swarmOrchestrator.ts`。**§2.3.1 以降(旧 land 機構: verify/敵対
レビュー/tally/差し戻し/conflict 委譲/凍結)は HISTORICAL** —— エンジンは**もうこれを
やらない**(その機構は撤去、または司令官の手動統合フロー §5 に移った)。歴史として、また
司令官が手動統合で同じ判断(検証・レビュー・rebase)を人力でなぞる際の型として残す。

**読者**: 将来の司令塔(og-manage)セッション。**統合は君(司令官)の仕事だ。** エンジンは
「worker が ready になった」と君を起こすだけ。起きたら §5 の手動統合手順で land する。

---

## 0. TL;DR — 司令塔が最初に知るべき6点

1. **エンジンは統合しない(2026-07-15〜)。** 統合パス `runIntegratePass` は2相で、
   **どちらも engine 稼働中つねに走る**(2026-07-16〜、トグル無し): **A相**
   (read-only 分類 → `engine.reviews[]` = UI の「統合可」表示)、**B相**は
   review に ready カードがあり**司令官の卓が不在/沈黙**なら **`spawnSwarmManager` で
   司令官を起こす**だけ。verify も敵対レビューも FF push も掃除も**しない**。
2. **統合(land)は司令官の専任。** 重量級レビュー + 手動 FF push は §5 の手順で司令官が行う。
   fail-closed 0票禁止・高リスク force-hold の安全網も**司令官側**(skills/og-manage §「マージ」)。
   エンジン側の verify/レンズ/force-hold は **dormant/撤去**(二重管理しない)。
3. **autoMerge トグルは廃止(2026-07-16)。** 「司令官を自動で起こす」は**エンジン ON に
   常時セット**になった —— `engine.autoMerge` フィールド・`POST /api/swarm/orchestrator/automerge`・
   UI トグル(Swarm タブ)・関連 i18n は**全部撤去**(route は 404、回帰テストでピン)。
   理由: 起こしても main は 1bit も動かないのに独立トグルを残すと「エンジン ON・起こし OFF」
   という中途半端な既定ができ、ready 完了品が誰にも拾われず review に滞留する(実運用で観測)。
   同意の粒度は**カード単位**が担う: タイトル先頭の `[hold]` + 高リスク force-hold
   (HIGH_RISK_PATHS、司令官の手動統合規約)。再起動セマンティクスは従来どおり
   **エンジンごと必ず OFF**(起こし反射もそれに乗る —— 独立の永続フラグは無い)。
4. **司令官起こしはバッチ・二重起動しない・落ちたら蘇生する(card B, 2026-07-16)。** 待っている
   review ブランチは**まとめて1回**で起こす(トークン節約)。「起きている」判定は今や **2 信号の AND**
   (`isManagerActive`): 永続 manager セッションが **live PTY**(プロセス死を捕捉)**かつ** manager 心拍が
   **新鮮**(10 分無音でハングと判定)。健全なら二度目は起こさない。**死んだ/固まった卓は蘇生**する —
   `spawnSwarmManager` で起こし直し(quota 壁なら tier 繰り下げ)、grace 5 分ごとに再試行、**3 連続失敗で
   `manager-unrevivable` fatal を1回**上げて諦める(無限ループ防止)。状態は `engine.managerResume`
   (in-memory・再起動で消える)。**エンジンは起こすだけ**で統合はしない(反射 ≠ 判断)。詳細 §2.3。
5. **`reviews[].status` の読み方は不変(A相は残る)。** engine 稼働中は
   毎パス「統合可」を publish する。`'conflict'` 表示の相乗り事象のうち engine 由来のもの
   (verify RED / must-fix / defer 凍結 / force-hold)は**もう発生しない**(旧 land 機構が撤去された)——
   純粋な git 分岐(`classifyBranch` の 'rebase')か、司令官が手動で付けた stamp だけ。
6. **緊急バックドアは温存。** 司令官の手動統合(§5 の FF push・「マージ」フロー)はそのまま。
   エンジンが統合しなくなっても**司令官は統合できる**(むしろ主経路)。§2.3.1 以降の旧機構は
   HISTORICAL 参照 —— 司令官が手動で verify/レビュー/rebase をなぞる際の型として読む。

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
| tier 降格 `resolveAvailableTierProbed`(panel は 2026-07-13 から probed 版 — 未知 tier は起動前プローブ、04 章 §5.8) | `src/lib/server/swarmLaunch.ts`(同期 walk = `resolveAvailableTier` / probed = `resolveAvailableTierProbed`) |
| HTTP API(状態 GET / review/resolve — automerge route は 2026-07-16 撤去・404) | `server/routes/swarm.ts`(`GET /api/swarm/orchestrator` / `POST …/review/resolve`) |
| engine in-memory 状態(reviews / 各 memo) | `src/lib/server/swarmOrchestrator.ts:1392-1460` |

engine は `globalThis` 上のプロジェクト別シングルトンで、**全 memo は in-memory**(サーバー再起動で消える。カード側の `integrationConflict` stamp だけが永続、`swarmOrchestrator.ts:1393-1396`)。

`3129a58` 以降の型の追加: `AbstainCause = 'timeout' | 'limit' | 'spawn-failed' | 'no-marker' | 'aborted' | 'error'`(:3055)、`ReviewerVerdict.abstainCause`(:3069-3072)、`OrchestratorReview.abstainSummary`(`src/lib/types.ts:1147-1153`)。

---

## 2. 状態機械 / データフロー

### 2.1 いつ走るか

- engine の tick は 3 秒ごと(`TICK_MS`、`swarmOrchestrator.ts:190`)。tick は dispatch パスを await した後、**integrate を `kickIntegratePass` で fire-and-forget に発火して待たない**(`swarmOrchestrator.ts:5981-5989` — `0d1f7f0` で tick の直列 await から分離。それ以前は per-card の verify+panel が `passInFlight` を握り、monitor が数分〜20 分飢餓した)。同時実行は `integrateInFlight` で 1 本に制限(:5619-5630、flag :1370)。統合は内部で 15 秒スロットル(`INTEGRATE_TICK_MS`、`swarmOrchestrator.ts:197,4934-4936`)。
- `lastIntegrateAt` は start 時 0 で始まるので、start 直後の次 tick で即統合パスが走る(旧 `setAutoMerge` の arm 時リセットはトグルごと撤去 — 2026-07-16)。
- 対象は **review 列のカードのうち `swarm/*` ブランチを持つものだけ**(`defaultFetchReview` が `isReviewCard`(=`boardColumn==='review'`、`swarmOrchestrator.ts:446`)で絞り :2509-2517、さらに `isSwarmBranch` フィルタ :4947-4951)。手で作った非 swarm ブランチのカードは統合パスの対象外。
- パス冒頭で trunk を解決+1回 fetch(`prepareTarget` → `resolveTarget`+`fetchTarget`、`swarmOrchestrator.ts:4938,2522-2527`、`swarmIntegrate.ts:145-173`)。trunk 名は明示 override → `origin/HEAD` → 'main' の順(`swarmIntegrate.ts:158-173`)。

### 2.2 A相 — read-only 分類(「統合可」表示)

`swarmOrchestrator.ts:4969-4978`。engine 稼働中は毎統合パス実行される。カードごとに:

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
| **高リスクパスの force-hold(2026-07-15・§2.3.1)** | `swarmOrchestrator.ts:5696-5702`(現物実測・camelCase 追補後) |

つまり司令塔が UI やAPI で `'conflict'` を見ても、**「rebase が競合した」とは限らない**。engine log(`GET /api/swarm/orchestrator` の `log[]`)で直前の行(`敵対レビュー: N回連続で多数決つかず…` / `検証` / `conflict` / `高リスクパス force-hold`)を読んで初めて区別できる。誤診の典型がここ(§4-1)。ただし `3129a58` 以降、**凍結だけは `reviews[].abstainSummary` に棄権内訳(`lens(cause)×N` 形式)が併記される**(:5371, :5433、型 `src/lib/types.ts:1147-1153`)ので、また **force-hold は `reviews[].highRiskFiles`(触れた高リスクパスの一覧)が併記される**(§2.3.1)ので、5 事象のうちこの2つは API 単体でも見分けられる。

### 2.3 B相 — 司令官を起こす・落ちたら蘇生する(エンジン ON で常時 — 2026-07-16 トグル廃止)

**2026-07-15〜。エンジンはもう統合しない。** B相の旧全体(高リスク hold・verify・敵対レビュー・
lock・FF push・land・掃除・reworkOrPark・delegateConflict)は**撤去された**。そのうえで
**2026-07-16 の card B** が、単発の「起こす memo(handoffs)」を **蘇生反射の状態機械**に置き換えた。
オーナーの実訴え(**opus に大 diff が流入すると司令官が固まる** — context 溢れ・API エラー・ハング)に
対する反射で、統合が司令官専任になった以上「司令官が落ちたら swarm 全体が止まる」を塞ぐ。**神経系
(engine)が脳(manager)を蘇生する** — 3層設計(worker=手 / engine=神経系+反射 / manager=脳)の反射の中核。
**同日(2026-07-16)、独立の arm トグル(autoMerge)は廃止**され、この反射は**エンジンが
running なら常に**働く(ゲートは `engine.running` と pass 冒頭の throttle だけ)。人が手で開いて
いる卓は下記 `isManagerActive` の fail-open(心拍未書き込み=新鮮扱い)が守るので、反射が手動卓を
潰す/二重起動することはない。今の B相は:

```
(engine.running は pass 冒頭で確認済み — 旧「autoMerge armed?」ゲートは廃止・2026-07-16)
rs = engine.managerResume(in-memory {attempts, lastWakeAt, fatalFired}・再起動で消える)
review に swarm ブランチある? ─No→ 反射を丸ごと disarm(rs リセット)して return(仕事無し=蘇生しない)
司令官の卓は「生きていて応答している」か?(isManagerActive・now 注入)
  = 永続 manager セッションが live PTY(プロセス死を捕捉) AND 心拍が新鮮(ハングを捕捉)
  ─Yes(健全)→ rs.attempts=0・fatalFired=false にして return(反射 disarm・二重起動しない)
  ─No(死 or ハング)→ 直前 wake から grace(5分)未満? ─Yes→ return(resume した卓の起動+初回心拍を待つ)
                      attempts が上限(3)到達? ─Yes→ fatal 'manager-unrevivable' を1回だけ上げて return
                                                     (毎回落ちる卓を無限に焚かない=完了条件5)
                      ─No→ wakeManager(review 全ブランチをまとめて1回)= spawnSwarmManager + 情報通知1本
                           lastWakeAt=now・attempts+1(spawn 成否に関わらず「1回試みた」と数える)
```

- **心拍(完了条件1)**: 司令官は統合の各段(1本マージ毎・レビュー sub-agent を起こす直前など)で
  `POST /api/swarm/manager/beat`(owner+path gate)を打つ。その実体は `writeManagerHeartbeat` =
  **固定名 `~/.openground/swarm/<repoキー>/manager.json`**(worker 心拍と同じ体系・repo キーで衝突しない)。
  og-manage スキルに配線済み。
- **検知(完了条件2)= 2信号の AND**(`isManagerActive`): ① live PTY(`isClaudeSessionLive`)で**プロセス死**を、
  ② 心拍鮮度(`MANAGER_HEARTBEAT_STALE_MS` = **10分**無心拍で stale=ハング)で**固まり**を捕捉。心拍を
  **一度も打っていない卓は fail-open で「新鮮」扱い**(旧 pre-心拍セッション・人が手で開いた卓を壊さない)—
  **在った心拍が 10 分途切れて初めて**ハングと判定する。異常時は必ず `false`(=蘇生)へ倒す。
- **蘇生(完了条件3)= wakeManager**: `spawnSwarmManager`(永続会話を `--resume`、無ければ fresh)+
  `manager-woke` 情報通知1本。起きた司令官は `/og-manage` で Board を読み review カードを自分で見つける。
- **quota 繰り下げ(完了条件4)**: 蘇生時のモデルは `resolveSwarmModelEffortProbed`(`swarmManager.ts`)が
  選ぶ — opus/fable が quota 切れで落ちたなら**枯れていない tier へ 1 段繰り下げてから** resume する
  (同じモデルで起こすと同じ壁に当たる=数日前の fable 事故と同型)。枯渇の記憶は永続冷却テーブル
  (`swarm-quota.json`・層A)から読む。
- **無限蘇生ループの上限(完了条件5)**: 起動直後に毎回落ちる(quota 完全枯渇・恒久バグ)と検知→蘇生→死の
  無限ループでトークンを焚く。`MAX_MANAGER_RESUME_ATTEMPTS` = **3** 連続失敗で蘇生を諦め、`manager-unrevivable`
  fatal を**1回だけ**上げてオーナーへエスカレーション(「司令官が繰り返し落ちている・手動確認を」)。
  カウンタは **in-memory**(`engine.managerResume`・再起動で消える=engine 認知と同じ寿命)。卓が健全に戻る/
  仕事が枯れると 0 にリセットされ、次のエピソードは満額 3 回からやり直す。
- **grace 窓**: `MANAGER_RESUME_GRACE_MS` = **5分**。`--resume` した司令官は起動+初回心拍までに時間が要り、
  前の(stale な)心拍ファイルもそれまで死んで見える。この猶予が無いと起動ギャップをハングと誤読して
  毎 tick 二重 spawn する。
- **反射であって判断ではない(完了条件6)**: エンジンは**起こすだけ**。統合するか・配車するか等の判断は
  蘇生後の司令官がやる。**エンジンは司令官の代わりに統合を実行しない**(main を 1bit も動かさない)。
- **既存の worker 監視・緊急停止(反射)は保持**(完了条件7): manager 蘇生は同じ integrate tick に相乗りするが、
  worker の runaway reclaim(02 章 §5.5)を壊さない。
- **予防の注記(蘇生は対症療法)**: この反射は「止まった司令官を立て直す」対症策。**そもそも司令官を
  止めないための予防**は manager 側の運用 —— 重い処理(大 diff レビュー)を sub-agent に逃がす(司令官は既に
  そうしている)—— であって本機構の領分ではない。card B は蘇生(対症)に集中する。
- 自己更新(engine 自己入替)トリガは land 時に発火していた(`requestEngineSelfUpdate`)ため、
  エンジンが land しなくなった今は**engine 側で発火しない**(dormant)。OG 自身の swarm 統合で
  自己更新を回したい場合は、司令官の手動統合フロー側で発火させる必要がある(別カードの領分)。

---

**⚠ ここから §2.3.1〜§3 は HISTORICAL(2026-07-15 でエンジンから撤去/dormant 化)。**
下記の verify ゲート・高リスク force-hold・敵対レビュー(lens/tally/64KB/budget)・差し戻し
(reworkOrPark)・conflict 委譲(delegateConflict)・大 diff 凍結は、**エンジンはもう実行しない**。
これらの安全網・判断は**司令官の手動統合フロー(§5)に一本化**された(二重管理しない)。以下は
(a)歴史の記録、(b)司令官が §5 で同じ判断(検証・レビュー・rebase)を人力でなぞる際の型、
として残す。file:line は撤去前の値で、現行コードには**もう存在しない**ものが多い。

---

### 2.3.1 [HISTORICAL] 高リスクパスの force-hold(2026-07-15)— 司令官の手動統合規約へ一本化

**実測事象(2026-07-14 18:18)**: autoMerge が `.github/workflows/release.yml` に触れるブランチを人間の確認なしに integrated (rebase) した。司令官の手動統合には規約(skills/og-manage/SKILL.md §「マージ」手順 0 の高リスク force-hold)があったが、**エンジンには対応する構造ゲートが無かった**。このサブ節のゲートがその穴を塞ぐ(このとき司令官が事前に敵対レビュー済みだったため実害ゼロ — だが構造で塞ぐべき穴)。

**パス集合 = `HIGH_RISK_PATHS`(`swarmOrchestrator.ts:2853`・単一定義)**。司令官規約と**同一の集合**で、両者の一致はユニットテスト(`swarmOrchestrator.test.ts` の「司令官規約と同一集合」— SKILL.md の文言ごと固定)が機械で守る — どちらかを変えるとテストが割れて同期を強制する:

| カテゴリ | マッチ例 |
|---|---|
| CI/CD パイプライン | `.github/workflows/**`・どの階層でも `release.yml` / `ci.yml` |
| 依存/ビルドスクリプト注入 | `package.json`・lockfile(package-lock / npm-shrinkwrap / yarn.lock / pnpm-lock / bun.lockb) |
| 署名/notarization | `sign…` / `notar…` のパスセグメント(例 `scripts/sign-and-notarize.sh`。セグメント境界判定なので design… / assign… は誤爆しない) |
| 特権 Electron プロセス | `electron/main.js` |
| secrets/credentials | `*secret*`・`.env*`・`auth` / `token` のパスセグメント **+ camelCase 結合**(2026-07-15 追補: `supabaseAuth.ts` / `authStore.ts` / `refreshTokens.ts` 型。case-sensitive の companion 2 本で判定するので `author` / `tokenizer` / `Authoring` は誤爆しない) |
| 認可の本体(明示列挙) | `src/lib/server/roles.ts` / `swarmGate.ts` / `swarmAllowedModels.ts`(2026-07-15 追補: 「誰が owner か・どのモデルが使えるか」を決める層はパス名に auth を含まないため名前マッチ不能 — 明示で hold。**swarmOrchestrator / swarmLaunch へは意図的に広げない**: swarm エンジン改修が全部 hold になると解除操作が常態化してゲートが形骸化する) |

**動き方**(ゲート 0 — 現物 :5662-5706): カードごとに `deps.changedPaths`(実体 `defaultChangedPaths` :2909 — `git rev-parse` + `git diff --name-only <trunk>...<tip>` の**読み取りだけ**・fail-closed で失敗は throw)でブランチ自身の変更ファイルを取り、`highRiskChangedPaths`(:2879)に1つでもマッチしたら:

- **統合しない**(integrate どころか verify にも進まない — hold されるカードに毎パス tsc/test/claude パネルを焼かないため、ゲートは列の先頭)
- `engine.highRiskHolds`(branch → {tip, files})に記録し、engine log に `高リスクパス force-hold — 自動統合を保留(出口は人間の手動統合のみ)` を **1 コミットにつき 1 行だけ**残す(同じ tip の再パスは沈黙 — tip メモ)
- `reviews[].status='conflict'`(needs-human dot・§2.2 の相乗り5事象目)+ **`reviews[].highRiskFiles`** に触れたパス一覧を毎パス re-stamp(API 単体で他の 'conflict' と判別可能)
- `detectAnomalies` が **`'high-risk-hold'` anomaly**(ref=カードid・`files` 付き、:6277)を立て、`fireFatalNotifications` が **fatal 通知**(:6442 — rising edge で1回だけ・解消→再発で再通知)で人間を起こす

**解除(出口)は2つだけ** — エンジンは自動では絶対に入れない:

1. **人間の手動統合**(§5「手動統合の手順」がそのまま出口)。diff を読み、問題なければ司令官が「マージ」で land する。Board の done 移動も司令官(§5)。カードが review を離れれば hold メモは prune される(:5324)
2. **worker が新コミットで高リスク接触を取り除く**(tip が変われば再判定 — 高リスクパスに触れなくなっていれば hold が解けて通常の verify→パネル→integrate に戻る :5705-5706)

**fail-closed の形**: diff が読めない(git 一時失敗)ときは**統合に進まない**が **hold にもしない** — `high-risk check errored (deferring)` を warn して次パス再試行(:5674-5680)。「読めない diff = 安全」とは読まず、かつ一時失敗で人間ゲートに固定化もしない。誤爆側の設計も fail-safe: 誤 hold のコストは人間が一度 diff を見るだけ・見逃しのコストはリリースパイプライン汚染なので、マッチは広めに倒してある(sign/auth/token はセグメント境界+camel 境界の判定で design/assign/tokenizer 等の明確な誤爆だけ潰す — 実測: 本 repo 757 ファイル中 hit 21 は全部意図どおりの高リスク系)。

**camelCase 追補の経緯(2026-07-15)**: 初版のセグメント境界 regex(`(^|[/._-])o?auth([/._-]|$)/i` 等)は `supabaseAuth.ts` / `authStore.ts` のような camelCase 結合を素通りさせていた — OAuth 実装・認証ストア・認可判定の本体(`roles.ts` / `swarmGate.ts`)が force-hold の対象外という中核の穴。司令官の敵対レビューがこれを検出して差し戻したが、修正が始まる前にエンジンの autoMerge(レンズ 4 票 clean — レンズは穴を見抜けなかった)が差し戻し前の ready tip を FF 統合した(**外部レビューの verdict はエンジンに伝わらない**、という §2.2 とは別種の教訓も残した事故)。塞ぎは前進(companion 2 本 + 認可層の明示列挙)で行い、実ファイルの HOLD/PASS はユニットテスト(`swarmOrchestrator.test.ts`「highRiskChangedPaths」)が固定している。SKILL.md 同期テストは **verbatim pin(文言一致)であって意味の同期ではない**(pin 緑 ≠ regex のカバレッジ保証)ことも同テストに明記した。

**寿命**: `highRiskHolds` は in-memory(§2.8 の他メモと同じく再起動で消える)— 消えても次の統合パスが同じ diff から再判定するので hold は**自然に復元される**(永続化不要の設計)。カードが review を離れた時点で prune(:5324)。

`makeVerify`(`swarmOrchestrator.ts:2906-2994`)。**land するのとまったく同じ tree**(branch を trunk に rebase したもの)を検証する:

1. swarm ブランチでなければ素通し(:2910)。tip をローカル→remote の順で解決、無ければ「何も land しない」ので素通し(:2912-2916)
2. **tip memo**: `opts.skipIfTip === tip`(前回 RED と同一 tip)なら再実行せず `{ok:false, skipped:true}`(:2918-2920)。→ 直らないまま同じ commit で居座るブランチが毎パス tsc を焼かない
3. already-merged なら素通し(:2925-2929)
4. 走らせるチェックを diff から決める(:2936-2945): tsc は tsconfig があれば常に(:2937)、lint / full-test は **全ブランチ常時**(`appliesTo: () => true`、:2883-2892)、swarm-safety は **swarm コードを触った diff のみ**(`SWARM_CODE_PATHS` :2642-2648 — swarm\*.ts / routes/swarm.ts / **routes/project.ts(Board API = 05 章の契約面、2026-07-11 編入)** / swarmSafety route net / Swarm\* UI、`touchesSwarmPaths` :2652。行番号は編入後の現物)
5. `~/.openground/projects/<uuid>/worktrees/.verify-<12hex>` に detached worktree を作り(:2956,2962)、trunk へ rebase(競合したら **ok:true で integrate に委ねる** — verify は競合を二重報告しない、:2968-2970)、**メイン checkout の node_modules を symlink**(:2977)
6. チェックを**安い順に直列実行し、最初の RED で打ち切り**(tsc→lint→swarm-safety→test、:2981-2988)。タイムアウトは tsc 180s(:2603)/lint 180s(:2805)/swarm-safety 240s(:2721)/full test 600s(:2865)
7. finally で worktree を force remove(:2991-2992)

重要な性質: これらは**統合パスの中でそのまま await される**(`swarmOrchestrator.ts:5308`)ので、full-test が10分かかる間そのプロジェクトの**統合パスは**止まる。ただし `0d1f7f0` 以降、統合パスは tick の脇で走る(§2.1)ため、**dispatch と monitor はその間も 3 秒 tick で回り続ける** — それ以前は pass 全体が `passInFlight` を握り、verify/panel の間 rate-limit 検知・stall 検知・promote まで飢餓していた(カード `4d1550d7` の第3因子。歴史は 01 章 §6・04 章 §4)。Board/workers を**書く**区間(reworkOrPark / delegateConflict / land)だけは `runExclusive` で monitor・control plane と直列化される(:4999-5131,5145-5271,5509 — 遅い await は lock の外)。統合 lock を per-card・integrate 直前にしか取らない理由も同じ(検証+パネルで数分かかるので、パス全体で持つと lock が stale 化する、:5462-5484 のコメント)。

RED の帰結: `verifyFailed[branch]=tip` を記録(:5321)、status を 'conflict' に上書き(:5324-5325)、`reworkOrPark`(:5330)。node_modules 未 install は「検証不能=RED」扱い(fail-closed、`tscCheck` :2593-2598)なので、**install していないプロジェクトで autoMerge を arm しても全カードが差し戻される**。

### 2.5 [HISTORICAL] 敵対レビュー — PTY・マーカー・64KB・diff 連動 budget

> [HISTORICAL] エンジンはこの lens パネルを**もう回さない**(2026-07-15 撤去)。統合可否を
> エンジンのレンズ多数決で決める経路は金輪際ゼロ —— それが本転換の核心(オーナーの本質的
> 懸念: レンズは司令官の重量級レビューの検出力に届かない)。以下は歴史/手動レビューの参考。

verify green の後、`deps.review`(実体 `makeAdversarialReview({lenses: DEFAULT_REVIEW_LENSES})`、配線 :3900)が走る(:5336-5460)。

**パネル構成**: 既定は lens パネル 4 体 — correctness / security / perf / regression(`DEFAULT_REVIEW_LENSES`、:3114-3135)。1 lens = 1 レビュアーで、それぞれ焦点だけ違う read-only プロンプト(`buildReviewPrompt` :3279-3299)。モデルは `SWARM_LAUNCH_MODEL='fable'`(`swarmLaunch.ts:52`)を望みつつ、**cooling と使用可能モデルマスクを通して降格解決**(2026-07-13 からは `resolveAvailableTierProbed` 経由 — 未知 tier には起動前プローブが1発入り、壁なら冷却して1段降格。04 章 §5.8)。

**実行前の早期 return**(スポーン費用ゼロの順に):
- 同一 tip が前回 must-fix → panel を再スポーンせず rework を carry(`skipIfTip`、:3609-3618)
- diff が計算できない(git 失敗)→ defer(:3627-3630)。diff が空 → 統合(already merged、:3631-3633)。**この「パネルを開かずに integrate を返す」経路(空 diff / 後述の rebase 競合委譲)は verdicts が空** — 2026-07-14 から engine log は `敵対レビュー省略(パネル対象外: <reason>) → 統合へ` と正直に出す(以前は `多数決 → clean [must-fix 0 / clean 0]` と表示され、パネルが承認したように読めた — 実測 2026-07-14 18:11 の「0票 clean」ログの正体)
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
- そうでなく **「全 lens が実在し decisive に投票」(`abstained === 0` かつ decisive 票数 ≥ lens 数 かつ decisive > 0)のときだけ** `'integrate'`
- **棄権が1つでもあれば `'defer'`**— 「その failure mode は未レビュー」という理屈。**verdicts が空/lens 数未満でも `'defer'`**(2026-07-14 fail-closed 化: 旧実装は `abstained === 0` **だけ**を見ており、**空の verdicts(パネル全滅・1票も無い)を「全員判定済」と誤認して integrate** し得た — 0票は絶対に clean と読まない)

reason に折り込まれる per-lens summary は `3129a58` 以降 **`lens=abstain(cause)` 形式**(:3222-3231 — 例 `correctness=abstain(timeout)`)。さらに makeAdversarialReview は、棄権を含む defer の reason 末尾に **`(diff NNKB / budget NNmin/reviewer)`** を付記する(:3792-3801)ので、engine log の 1 行だけで「誰が・なぜ棄権し・budget は何分だったか」まで読める。

(参考: lenses を渡さない homogeneous パネルは `tallyReview` :3166-3191 の厳密多数決 — `majority = floor(panelSize/2)+1`、分母は**起動数**なので棄権は絶対にバーを下げない :3137-3145。こちらの defer reason にも棄権内訳 `describeAbstentions` :3150-3154 が付く :3183-3190)

**defer streak → 凍結**(`runIntegratePass` 側、:5406-5449):

- defer のたび `reviewDeferred[branch] = {tip, count+1, abstains}`(:5419-5427)。**streak 全体の棄権内訳 `abstains`(`lens(cause)` → 回数)も蓄積**される(:5419-5425、型 :1420)。ただし `skippedForPark` の defer は engine 都合の hold なので streak を**消費しない**(:5411)
- `count >= MAX_REVIEW_DEFERS`(**=2**、2026-07-14 に 3→2: 初回パネル+**再試行はちょうど1回** — 完了条件「1回だけ再試行」の明文化)で needs-human: status='conflict' 表示 + `abstainSummary` に累積棄権内訳を stamp +ログ「敵対レビュー: 2回連続で多数決つかず — needs-human 退避(再レビュー停止・新コミットで再開): … — 棄権内訳: correctness(timeout)×2, … — 最終: …」
- **凍結は 2026-07-14 から anomaly として観測可能**: `detectAnomalies` が `reviewDeferred` の cap 到達 + review 列在籍から **`review-panel-failed` anomaly**(ref=taskId・attempts=count)を毎パス導出し、`fireFatalNotifications` が **rising edge で fatal 通知**(in-app bell + OS toast)を1回発火する。**rework counter は焼かない**(defer は worker の過失ではない — reworkOrPark を通らない、従来どおり)
- 以後のパスは **defer-exhausted memo で panel を再スポーンしない**(:5359-5374)。トークン焼き防止(無限リトライ禁止)。`engine.reviews` は毎パス再構築されるので、凍結 skip のたびに `abstainSummary` を再 stamp する(:5368-5371)
- **リセット条件は「新コミット(tip が変わる)」だけ**(:5359-5362, 5262)。決定的 verdict(rework/clean)も streak を終わらせる(:5395, 5454)が、凍結後は panel 自体が走らないので、実質 **worker が commit を積む(または人間が rebase して tip を変える)まで凍結は解けない**(凍結が anomaly/通知で人間に届くようになったのが 2026-07-14 の追加)
- 15秒ごとの統合パスなので、**棄権が続くと 2 パネル分の実行時間で凍結に到達する**(budget は diff 連動で最長 20 分/パネル — 大 diff で本当に棄権が続く場合の凍結到達は最長約 40 分。旧 `MAX_REVIEW_DEFERS=3`・固定5分 budget 時代の実測は §3)

### 2.7 [HISTORICAL] 差し戻し(reworkOrPark)と conflict 委譲(delegateConflict)

> [HISTORICAL] `reworkOrPark` / `delegateConflict` は**撤去された**(2026-07-15)。エンジンは
> もう verify RED / must-fix / conflict でカードを review→doing に戻さない —— 統合の判断
> (差し戻すか land するか)は司令官の専任。以下は歴史。

どちらも(当時)autoMerge armed のときだけ動いた「review に滞留させない」機構。

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

**帰結(再更新・2026-07-15 で前提ごと消滅)**: budget 根治(`3129a58`)で「engine は自分を修理できない」状態は設計上解消されたが、**その後のマネージャ専任化で engine のレビュー→land 経路そのものが撤去された**ため、「このサイズ帯の diff が engine で決着する」ことはもう無い。§5 の手動統合(司令官の重量級レビュー)が fallback ではなく**唯一かつ主経路**。上の実測は司令官が大 diff を扱う際の負荷感覚の照合点として保持する。

---

## 4. 落とし穴 — 司令塔が実際に踏んだ/踏みやすい誤診

1. **「conflict 表示 = rebase 競合」と思い込む**。§2.2 の通り、verify RED・must-fix 差し戻し直後・**defer 凍結**(:5324-5325,5396-5397,5367,5432)・**高リスク force-hold**(2026-07-15・§2.3.1)が全部 'conflict' に相乗りする。凍結カードを「競合だ」と誤診して worktree で rebase を試みても、競合は無く FF 可能なことがある(実際 §3 の凍結 3 枚がそう)。**engine log の直前行で種別を確認**(§6-3)— `3129a58` 以降は `reviews[].abstainSummary` の有無で凍結が、2026-07-15 以降は `reviews[].highRiskFiles` の有無で force-hold が、それぞれ API 単体でも即判別できる(§2.2/§6-13)。force-hold は**故障ではない**(設計どおりの承認待ち)— 直しに行くのではなく diff を読んで手動統合の判断をする。
2. **「must-fix 0 / clean 2 なら、あと少しで通る」と思い込む**。clean 2 は「賛成2」ではなく「**2 lens が棄権 = 全員一致が絶対に成立しない**」。同じ tip で待っても3回で凍結し、以後 panel は走らない(:5359-5374)。新コミットを積まない限り再開しない。(`3129a58` 以前は「大 diff だから棄権」がこの型の支配的原因だった — 現在棄権が続くなら `abstainCause` で真因を読む。)
3. **棄権の理由が残らない前提で諦める(逆に、探して時間を溶かす)**。**これは `3129a58` で過去の話になった** — 当時は `.catch → vote:null` と timeout kill が理由を握りつぶし、調べる手段が無かった。現在は3か所に残る: ① 毎 defer の engine log(`lens=abstain(cause)` + `(diff NNKB / budget NNmin/reviewer)`、:3222-3231,3725-3734)② 凍結ログの「棄権内訳: …」(:5435-5439)③ API の `reviews[].abstainSummary`(:5371,5433)。診断はまずここを読む — `timeout` なら diff/budget、`limit` なら quota(§2.5 sensor)、`spawn-failed`/`error` なら PTY 環境。
4. **「エンジンが統合してくれない」と騒ぐ**。2026-07-15〜これが正常 — エンジンは統合しない。review の ready カードは**司令官が手動 land するまで review に留まる**。エンジン ON なら起こし反射は常時働く(2026-07-16〜トグル無し)ので、`manager-woke` 通知が来ているか・司令官卓が生きているかを確認し、来ていたら §5 で land する。エンジン OFF なら起こしも止まる(それがグローバル stop の意味)。
5. **verify の遅さを hang と誤診**。full test は最大 600 秒(:2865)、パス内で直列 await(§2.4)。さらにパネルも per-reviewer 最長 20 分(§2.5)。統合パスが「止まって見える」のは正常。engine log に verify/レビューの結果行が出るまで待つ。
6. **再起動で凍結が「直った」と誤認**。`reviewDeferred` は in-memory(§2.8)。再起動後は panel が再スポーンされ、**凍結の原因が残っていれば同じ棄権で再凍結**する(§3 の「rebase でリセットしても40分後に再凍結」と同型。当時の原因=固定 budget は根治済みなので、再発したら `abstainCause` で新しい原因を特定する)。
7. **push 済みブランチの「integration deferred: … fast-forward push rejected」**。trunk が動いた直後の正常な transient(:5590-5593、`swarmIntegrate.ts:294`)。次パスで rebase 経路に入る。異常扱いして手を入れない。
8. **二重司令塔(歴史 — 2026-07-15 で構造ごと消滅)**。かつては engine の統合と手動統合が同一ブランチを同時に rebase/push し得た(engine 側は per-card の cross-process lock を取るが手動側が取らなければ無意味 — 実際 0715 の事故の型)。**エンジンが統合業務から外れた今、trunk を動かす主体は司令官ただ一人**なので、この競合は機構的に起きない。残る唯一の注意は「司令官セッションを同一 repo に2つ立てない」(00-INDEX 戒 9 の dispatcher 1 つ原則と同型)。

---

## 5. 司令塔の運用注意 — **統合は君の仕事(主経路)**

2026-07-15〜、統合は司令官の専任。エンジンは「worker が ready」と君を起こすだけ。起きたら
下の**手動統合の手順**で land する —— これが**主経路**であって例外ではない。

### 司令官の自動起こし — エンジン ON で常時(2026-07-16 トグル廃止)

**arm という操作はもう無い**: 起こしても main は 1bit も動かないので、独立トグルを残す意味が
なく(むしろ「エンジン ON・起こし OFF」の中途半端な既定が ready 品の滞留を生んだ — 実運用で観測)、
**エンジンを ON にすれば起こし反射は常に効く**。OFF にしたければエンジンごと止める(それが
グローバル stop)。旧 `POST /api/swarm/orchestrator/automerge` は**撤去済み(404)** — 回帰テスト
(`server/routes/__tests__/swarm.test.ts`)が 404 をピンしている。再起動セマンティクスは
エンジン自体の「再起動で必ず OFF」に乗るだけで、独立の永続フラグは無い。
統合の**同意はカード単位**で表現する: タイトル先頭 `[hold]`(承認待ち)+ 高リスク force-hold
(`HIGH_RISK_PATHS` — 君の手動統合規約 og-manage §「マージ」手順 0)。
君が常時卓に居る運用でも害は無い — 健全な卓(live PTY + 心拍新鮮 or 心拍未書き込み fail-open)は
`isManagerActive` が守り、反射は二重起動しない。

### 起こされたら(`manager-woke` 通知が来たら)

`manager-woke` 情報通知(または起動直後の `/og-manage` の「状況」)で review に統合待ちが
来たと分かる。やることは1つ: **review の各カードの diff を読み、重量級レビューして、問題なければ
下の手順で land する**。エンジンは verify も敵対レビューもしていない —— **検証もレビューも君が負う**
(必要なら時間無制限の subagent レビュアーを立てる。これが「深い判断が要る統合は必ず manager の
目を通す」の実装)。**高リスクパス(release/CI/署名/依存/secrets 系 = `HIGH_RISK_PATHS` / og-manage
§「マージ」手順 0)に触れるブランチは、他が緑でも特に慎重に** —— fail-closed の安全網は今や君の
手順の中にしかない(エンジン側の force-hold は撤去済み)。

### 凍結/conflict カードの解除 — 2つの正規ルート

**(a) エンジンに任せたまま解かせる**: worker に新コミットを積ませる(tip が変われば `reviewDeferred`/`verifyFailed`/`reviewFailed` は全部無効化される。§2.6/2.8)。`3129a58` 以前は「凍結原因が大 diff なら同じ結果になる」ため勧めなかったが、現在は tip が変われば panel が diff 連動 budget で再走するので、**まず `abstainSummary` で凍結原因を読み**、timeout 起因でなければこのルートが第一候補。

**(b) owner resolve で review から出す**: `POST /api/swarm/orchestrator/review/resolve` body `{path, taskId, target:'blocked'|'todo'}`(`server/routes/swarm.ts:636-652` → `resolveOrchestratorReview` :6389-6475)。
- `'blocked'` = **人間(司令塔)が引き取る**宣言。branch は残る。以後は下の手動統合へ
- `'todo'` = 新 worker で最新 trunk からやり直し(旧 branch は参照用に残る)
- どちらも conflict stamp・conflict/verify memo・差し戻し予算をクリアし、残 worker を teardown する(:6451-6465)

### 手動統合の手順(凍結カードを司令塔が land する型)

**共有 checkout(メインの作業ツリー)を絶対に触らない**。全部 API/git の読み取りと使い捨て worktree で行う。(エンジンはもう統合しないので「先に disarm」の前置きは不要 — 君が唯一の統合主体。)

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
# 1) engine の状態・reviews[](統合可表示)を見る(autoMerge フィールドは 2026-07-16 撤去 — 出ないのが正常)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq '{running, reviews}'

# 2) reviews[] の status だけ抜く(conflict 表示の確認)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.reviews[] | "\(.status)\t\(.branch)"'

# 3) engine log から凍結/差し戻し/park の行を拾う(conflict 表示の真因の区別)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.log[] | select(.message | test("多数決|差し戻し|conflict|park|cooling|integrated")) | "\(.at) \(.level) \(.message)"'

# 4) automerge route が撤去済みであることの確認(404 が正常 — 起こし反射はエンジン ON で常時)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47776/api/swarm/orchestrator/automerge -H 'content-type: application/json' -d '{"path":"/path/to/project","enabled":false}'   # → 404

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

# 13) 高リスク force-hold(2026-07-15・§2.3.1)の現物確認
#   a. hold 中のカードを API で見る(highRiskFiles が付くのは force-hold だけ)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.reviews[] | select(.highRiskFiles) | "\(.branch)\t\(.highRiskFiles | join(", "))"'
#   b. anomaly として上がっているか('high-risk-hold' kind)
curl -sG "http://127.0.0.1:47776/api/swarm/orchestrator" --data-urlencode "path=/path/to/project" | jq -r '.anomalies[] | select(.kind == "high-risk-hold") | "\(.ref)\t\(.branch)\t\(.files | join(", "))"'
#   c. hold 判定を手で再現(そのブランチは高リスクパスに触れているか)
git -C /path/to/project fetch origin main && git -C /path/to/project diff --name-only origin/main...<branch>
#      ↑ の出力を HIGH_RISK_PATHS(swarmOrchestrator.ts:2853 — workflows/release.yml/ci.yml/package.json/lockfile/sign…/notar…/electron\/main.js/secret/.env/auth/token(camelCase 結合 supabaseAuth.ts/authStore.ts 型も)/roles.ts/swarmGate.ts/swarmAllowedModels.ts)と突き合わせる
#   d. パス集合が司令官規約とドリフトしていないか(同期テストがスイートで守っている)
npx vitest run src/lib/server/swarmOrchestrator.test.ts -t '司令官規約'
```

(47776 は `server/index.ts` の固定ポート契約 — engine 自身も同じ loopback origin で Board API を叩く、`swarmOrchestrator.ts:2178-2183`)

---

## 7. 既知の穴(読解中に確認した実装上の問題 — 修正はしない・列挙のみ)

1. ~~**棄権の理由が消える**~~ → **`3129a58` で解決済み**。throw は `abstainCause:'error'`(:3717-3719)、timeout は `ended:'timeout'` → `'timeout'`(:3519,3714)として帰属され、defer ログ・凍結ログ・`reviews[].abstainSummary` に残る(§2.5/§2.6)。旧挙動(`.catch → 裸の vote:null`・needs-human ログに内訳なし)は §3 の歴史記録を参照。
2. **lens パネルは実質「全員一致」ゲート**(現存・仕様): `tallyLensReview` は `abstained===0` のときしか integrate を出さない(:3241)。`3129a58` 以前は棄権率が diff サイズで単調に上がったため大 diff が構造的に統合不能だった(§3 — budget 根治で解消)。全員一致要件そのものは「棄権 = その failure mode 未レビュー」の設計意図で残っている — 棄権が **budget 以外の理由**(spawn 失敗・limit)で続けば今でも凍結し得る。
3. **64KB バッファが固定のまま**(:3358,3502)。budget は diff 連動になったが(§2.5)、マーカーが 64KB 窓から押し出される経路と、分割レビューの不在は残る。実測でこの窓が棄権の主因になった証拠は無い(§3 の凍結は budget 由来)が、巨大出力を吐くレビュアーでは理論上 `no-marker` 棄権になり得る。
4. **needs-human に独立した status 値が無い**: `OrchestratorReviewStatus`(`src/lib/types.ts:1136`)は `'ff'|'rebase'|'conflict'|'unknown'` のみで、verify RED / must-fix / defer 凍結はすべて `'conflict'` に上書き(:5324-5325,5396-5397,5367,5432)。`3129a58` で凍結だけは `abstainSummary`(`types.ts:1147-1153`)により API 上区別可能になったが、status 値としての独立は依然無い(verify RED と must-fix は今も区別不能)。
5. **`resolveOrchestratorReview` のコメントと実装の不一致**: 「Clear EVERY engine memo tied to this branch」(:6448)と言いつつ、消すのは `conflictedBranches`/`verifyFailed` だけ(:6451-6454)で **`reviewFailed`/`reviewDeferred` は残る**。実害は小さい(次の統合パス冒頭の prune :4962-4967 が review 不在ブランチの memo を落とす)が、engine 停止中に resolve→同一ブランチを手動で review に戻す運用をすると古い凍結 memo が生き返る余地がある。
6. **in-memory conflict memo とカードの永続 stamp の乖離**: 再起動で `conflictedBranches` が消えると、A相(:4973)は stamp(`integrationConflict`)を読まないため 'rebase' 等に戻る一方、カードには stamp が残る(:1393-1396 は意図と明記しているが、表示上は食い違う)。stamp の自己修復は旧 B相の land 経路にしかなく、**その経路ごと 2026-07-15 で撤去された**ので、今や stamp を消すのは owner resolve(§5(b))か司令官の手動更新だけ。
7. **verify と review が同じ tip に対して rebase worktree を2回別々に作る**(`.verify-*` :2956 / `.review-*` :3429)。正しさに問題は無いが、統合パス1周あたりの git コスト・所要時間が倍化し、その分 park/stop の割込み窓(:5390)も広がる。budget が cap 20 分に伸びた分(§2.5)、integrate 1 周の所要時間は `3129a58` 以前より**長くなり得る** — ただし `0d1f7f0` で integrate は tick から分離されたので、この長さが monitor を飢餓させることはもう無い(§2.1。カード `4d1550d7` の pass 飢餓は解消済み)。遅い integrate の実害は「review 列の決着が遅れる」ことに閉じる。
8. **`tallyReview`(homogeneous パネル)は現行配線では未使用**(defaultDeps は lenses 固定 :3900)。ドキュメントや UI 文言が「多数決」と言うとき、実際に動いているのは weighted-OR + 全員一致(§2.6)であることに注意。
