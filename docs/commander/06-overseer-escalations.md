# 06 — Overseer 信号系(S1〜S11)とエスカレーション/通知ストア

> **対象コミット: `0d1f7f0`** (origin/main tip, 2026-07-10)。初版は `cc7c60e` のソース基準で、
> `d8431c3`(S3/S10 再投函根絶: 24h 窓 + createdAt キー + 永続受領判定)と `aa9cb8d`(受領台帳
> 読みの strict 化)を反映済み。`0d1f7f0`(quota 検知根治)は overseer/escalations に変更なし —
> 本章は `swarmOrchestrator.ts` 参照の行番号シフトのみ反映。行番号は全て `0d1f7f0` 時点。
> 読者 = 将来の司令塔(og-manage / manage セッション)。
> 本文書の主張には全て `file:line` の根拠を付けてある。裏取りは §7 の検証コマンドで自分で行うこと。
> 設計正典は `docs/OVERSEER_DESIGN.md`(spike 成果物)— 本文書は「実装が今どうなっているか」の写し。
>
> **追記(2026-07-17・平易文 `plainQuestion`)**: オーナー(非エンジニア)の直接フィードバック
> 「escalation の質問の意味が毎回わからない」を受け、escalation record に **`plainQuestion`
> (平易文 — ①何を決めてほしいか1〜2文 ②選択肢A/B ③各選択の影響を生活言語で)** が optional の
> 一級フィールドとして追加された(`src/lib/types.ts` `Escalation.plainQuestion` /
> `swarmEscalations.ts` `MAX_ESCALATION_PLAIN_QUESTION`=4KB clamp)。§2.2 に全容。この追記に
> 伴う本章内の行番号シフトは小さい(types.ts / swarmEscalations.ts / swarmOverseer.ts の
> 該当箇所に数行〜十数行)が、`0d1f7f0` 基準の行番号参照は該当ファイルでずれ得る — 疑ったら現物。

## 0. 司令塔が最初に覚える 5 行

1. **overseer は第3トグル・default OFF・in-memory**。再起動で OFF、autonomy 明示 OFF
   (`stopOrchestrator`)でも OFF(`src/lib/server/swarmOrchestrator.ts:6170-6173`)。arm は
   engine が running のときだけ受理(`:6774-6777`)。ON にできるのは owner の
   `POST /api/swarm/orchestrator/overseer` ただ一つ。
2. **信号はテーブル駆動**: T3 = inbox(escalations)直行が S1/S2/S3/S5/S10、T1 = 大脳(proxy
   brain)が S4 のみ、T0' = info 通知のみが S7/S8/S11、S9 = THROTTLED 状態遷移
   (`src/lib/server/swarmOverseer.ts:155-166`)。S6 は意図的欠番(`:139-144`)。
3. **escalations(受信箱)は fail-closed**: `open` を自動で動かすコードパスは存在しない
   (`src/lib/server/swarmEscalations.ts:13-15`)。かつては **dismiss しても re-arm のたびに S3 が
   過去の exec-timeout を全件再投函**していたが、`d8431c3`+`aa9cb8d`(2026-07-10)で根絶 —
   S3/S10 は 24h 窓 + 永続受領判定で、dismiss は再起動/re-arm を跨いで効く(§4.1 は機構と実測を
   歴史として保持。カード `c944ea69` 修正済み・done 列)。
4. **swarm-notifications.json は cap 50・recency のみ・期限なし**
   (`src/lib/server/swarmNotifications.ts:30`)。S3/S10 はこのファイルを 60 秒ごとに再読するが、
   **`fatalWindowMs`(24h、`swarmOverseer.ts:133`)より古い記録は「recent」に含まれない**
   (`:370-379` — d8431c3 で導入した時間窓)。
5. **escalation の branch/taskId は鵜呑みにしない**。exec-timeout 系はまず発火源の日時と突合
   (§5.2)。branch は `git branch -a` と `merge-base` で実在裏取りしてから動く。

---

## 1. 構造 — 何がどこにあるか

### 1.1 三層アーキテクチャ(脳幹/大脳/記憶)

| 層 | ファイル | 役割 |
|---|---|---|
| 脳幹(brainstem) | `src/lib/server/swarmOverseer.ts` | 純ロジックの周期パス。engine tick(3s)に相乗りし、閾値表で「何もしない/大脳を起こす/人へ上げる」を決める。**自分では LLM を呼ばない**(`swarmOverseer.ts:10-13`) |
| 大脳(brain) | `src/lib/server/swarmOverseerBrain.ts` | S4 でだけ起きる one-off `claude` PTY(proxy-you)。fire-and-forget — パスは絶対に await しない(`swarmOverseer.ts:14-18`) |
| 記憶 | `~/.openground/you-corpus.md` (`src/lib/server/paths.ts:45`) | 大脳の判断根拠。書き戻すのは owner の回答だけ(`swarmOverseer.ts:19-20`、`swarmEscalations.ts:24-25`) |
| 受信箱(C1) | `src/lib/server/swarmEscalations.ts` | escalations.json の CRUD + PTY 注入(W16)+ you-corpus 書き戻し |
| 通知(bell/toast) | `src/lib/server/swarmNotifications.ts` | swarm-notifications.json(fatal/info)+ OS toast |
| 可逆性ゲート(C4) | `src/lib/server/swarmReversibility.ts` | 大脳の前後で question/answer を構造チェック(`swarmOverseerBrain.ts:48-53` import) |
| ルート | `server/routes/swarm.ts` | `/api/swarm/escalations*`(`:740,761,833,858`)、overseer トグル(`:688`)、通知(`:535`)。**全ルート swarm owner gate**(swarmGate.ts — owner ログイン or ローカル解錠、§7 前提) |

### 1.2 永続ストアと in-memory 状態

| 置き場所 | 何か | 生存期間 |
|---|---|---|
| `~/.openground/escalations.json` (`paths.ts:33`) | 受信箱の実体。**uncapped**(`swarmEscalations.ts:22-23`)・mode 0600・fsync(`:205-207`) | `open` は永遠。resolved は 90 日で boot sweep(`:64`, `:754-781`、呼び元 `server/index.ts:70`) |
| `~/.openground/escalation-shots/` (`paths.ts:37`) | 起票時の worker PTY 末尾キャプチャ(1 record 1 ファイル、`swarmEscalations.ts:380-397`) | record prune 時に unlink(`:770-778`) |
| `~/.openground/swarm-notifications.json` (`paths.ts:27`) | bell の中身(swarm-fatal / swarm-info / collab-invite)。cap 50(`swarmNotifications.ts:30`) | **期限なし** — 新しい 50 件に入っている限り残る(`:65-68`) |
| `engine.overseer`(in-memory) | `OverseerRuntime`: enabled / seen / watch / brainResults / budget(`swarmOverseer.ts:189-230`) | 再起動で全消え → enabled=false(K2)。seen/watch リセット = dwell 時計ゼロから(`:185-188`)。**S3/S10 の再投函はこのリセットでは復活しない**(永続受領判定 — §3.6/§4.1) |
| `engine.notified`(in-memory) | state 系 fatal の rising-edge dedup(`swarmOrchestrator.ts:1656`) | 再起動で消える |
| `engine.pendingFatal`(in-memory) | edge 系 fatal(exec-timeout)の一時キュー(`swarmOrchestrator.ts:1661`) | 次 pass で drain(`:7011-7014`) |

### 1.3 点火経路(誰がいつ呼ぶか)

- `runEnginePass`(3s tick)の末尾で、`fireFatalNotifications`(`swarmOrchestrator.ts:6009-6013`)
  の**後**に `runOverseerPass` を await(`:6094-6099`)。後に置くのは S2 が fresh な
  `engine.notified` を読むため(`:6019`)。overseer は**専用ドライバを持たない**(K1、
  `swarmOverseer.ts:4-6`)。
- disarm 済みなら 1 行目で no-op(`swarmOverseer.ts:504`)。pass 全体が try/catch で tick に
  絶対 throw しない(`:618-621`)。
- arm/disarm: `POST /api/swarm/orchestrator/overseer {path, enabled}`(`server/routes/swarm.ts:688-707`)
  → `setOverseer`(`swarmOrchestrator.ts:6685-6710`)。**arm は `engine.running` が前提** —
  停止中 engine への arm は warn ログだけ出して無視(`:6774-6777`)。非 darwin で arm すると
  レスポンスに `sandboxWarning:true` が付く(`server/routes/swarm.ts:705`)。
- 現在値の確認: `GET /api/swarm/orchestrator?path=…` の `overseer` フィールド
  (`swarmOrchestrator.ts:1933`)。

## 2. 信号表 S1〜S11(S6 欠番)

tier の意味(`swarmOverseer.ts:146`): **T3** = 受信箱(escalations.json)へ直行 /
**T1** = 大脳を起こす / **T0'**(T0prime) = info 通知(bell + OS toast)のみ /
**THROTTLED** = overseer 自身の縮退状態遷移。正典テーブルは `OVERSEER_SIGNALS`
(`swarmOverseer.ts:155-166`)、閾値は `OVERSEER_THRESHOLDS`(`:124-137`)。

| 信号 | 発火条件(edge) | tier | 実際に起きること | 検知箇所 |
|---|---|---|---|---|
| **S1** rework-exhausted | `engine.anomalies` に `kind:'rework-exhausted'`(= 差し戻し `MAX_REWORKS`=2 超過で blocked 退避、`swarmOrchestrator.ts:238,5781-5798`)。毎 tick 読む | T3 | inbox へ「設計見直し/放置/分割して再依頼?」。receiptKey=`S1:<path>:<taskId>:<attempts>` | `swarmOverseer.ts:804-826` |
| **S2** all-workers-down | `engine.notified.has('all-workers-down')`(= running・live worker 0・doing に swarm branch カード残、`swarmOrchestrator.ts:5929-5943`)。毎 tick | T3 | inbox へ「どう復旧しますか?」。receiptKey=`S2:<path>:all-workers-down` | `swarmOverseer.ts:829-849` |
| **S3** exec-timeout | 通知ストア再読(60s サブサイクル)で `event:'exec-timeout'`、**24h 窓内**(`fatalWindowMs`、`:133`)かつ**受領台帳に無い occurrence のみ**(§3.6)。元は worker が `MAX_EXEC_MS`(既定 90 分、`swarmOrchestrator.ts:364`)を**実作業時間**で超過 → `pendingFatal.push`(`:5550-5569`)。**4 種類が同じ event で来る**(02 章 §5.6 の表): ①未 ready = 暴走(→blocked)/ ②`rework` = ready 済みで**実際に再作業**した(→review・**tip は未検証**)/ ③`capped-wait` = **統合待ちが控除上限を超えた**だけ(→review・**tip は ready 到達時のまま**)/ ④`work` = 待ちは全額控除・再作業もなしで、**純粋に実作業**が上限に達した(→review・**tip は未検証**。kept promote もここ)。②③④の判別は `fatal.execTimeoutShape`('rework'/'capped-wait'/'work')で、いずれもオーナーの判断は不要 — 司令官が差分を読んで判断する | T3 | inbox の**文面も 4 種類に分岐する**(`execTimeoutKind` + `execTimeoutShape`、`swarmOverseer.ts:1021,1032`): ①「分割して再依頼 or 見送り?」/ ②③④「このまま任せる or 見送る」(「あなたが決めることは基本ありません」と明記)。**③と④を取り違えないこと** — ④に「順番待ちが長引いた」と書くと、待ち 0 分でずっと働いていた worker について嘘を語ることになる(boolean 判別子だった頃の実バグ)。**③に「その後の手直しが持ち時間を使い切って」と書いてはいけない** — 手直しは 1 分も起きていないので、それは 0718 と同型の作り話になる(63 時間の週末レビューで実測)。**ready 側に「分割して再依頼」を出してはいけない** — worker 撤去後の回答は `deliverAnswer` → `recordEscalationAnswerForNextDispatch` で**次の dispatch に指示として乗る**ので、「小さく分けてやり直せ」は納品済みの作業をやり直させる実効命令になる(0718 実害(c)の再生産)。receiptKey=`S3:<path>:<ref>:<createdAt>`(§3.6)。~~§4.1 の増殖バグの主役~~ → **根治済み(§4.1 は歴史)** | `swarmOverseer.ts:854-959` |
| **S4** worker 自由文質問 | live worker の心拍が `blocked` かつ blockers 文が疑問形(`looksLikeQuestion`、`swarmOverseer.ts:392-399`)。心拍の blocked 判定は `phase==='blocked' || blockers` (`swarmOrchestrator.ts:2622-2624`) | **T1**(THROTTLED 中は T3 直行) | budget が通れば大脳を fire-and-forget で起こす(`:744-787`)。**1 pass に 1 brain**(`:788-789`)。THROTTLED 中は素の質問を inbox 直行(`:718-734`) | `swarmOverseer.ts:690-791` |
| **S5** blocked-dwell | tasks スナップショットで `blocked` 列カードが**連続 30 分**滞留(`blockedStuckMs`、`:128`)。watch で dwell 計測(`:1061-1068`) | T3(weak) | inbox へ「依存は解けましたか?(todo へ戻す/このまま保留)」。**overseer は自分では列を動かさない**(`:1073-1075`)。**[保留] 運用と衝突** — §4.2 | `swarmOverseer.ts:1041-1093` |
| **S6** | **欠番**。todo 枯渇→次タスク起草は C-core スコープから除外(goal 生成は最高リスクの runaway) | — | — | `swarmOverseer.ts:139-144` |
| **S7** review-idle | `engine.reviews` の `status==='ff'`(統合可)が**連続 30 分**残存(`reviewIdleMs`、`:129`) | T0' | info 通知 `review-idle`「統合可能な review カードが N 件…」。inbox には行かない(`:1043`) | `swarmOverseer.ts:1011-1052` |
| **S8** usage warn | キャッシュ済み使用量 pct ≥ 80(`usageLevel`→`'warn'`、`src/lib/usageThresholds.ts:7,21-26`) | T0' | **大脳の日次上限を半減**(24→12、`brainDayCap`、`swarmOverseer.ts:415-416`)。※`fired` 配列には積まれない(通知も出ない) — 効果だけの暗黙信号 | `swarmOverseer.ts:553-555,738` |
| **S9** usage over | pct ≥ 100 への**遷移**(rising edge)。回復(<100)は無音(`:571`) | THROTTLED | `ov.throttled=true`。enter 時に info 通知 `overseer-throttled` を 1 発(`:573-579`)。以後 S4 は大脳を経由せず bare raise | `swarmOverseer.ts:557-582` |
| **S10** rollback / canary-failed | 通知ストア再読(60s)で `event:'rollback'|'canary-failed'`、**24h 窓 + 受領判定は S3 と同一**。発火源は Electron 自己入替 → IPC → `registerIncomingNotifications`(`swarmNotifications.ts:255-269`) | T3 | inbox へ「エンジン自己入替が失敗し旧版で動作中…どう対応?」 | `swarmOverseer.ts:854-959`(S3 と同じ関数、`:906`) |
| **S11** inbox-stale | `open` の escalation が **6 時間**未回答(`inboxStaleMs`、`:130`)。60s サブサイクル | T0' | info 通知 `escalation-reminder`。**6h バケットごとに最大 1 回**再通知(`:1080-1084`)。絶対に auto-progress しない(fail-closed) | `swarmOverseer.ts:1056-1099` |

サブサイクルの整理: S1/S2 は毎 tick(3s・ゼロコスト)。S3/S10/S11 は 60s サブサイクル
(`escalationsPollMs`、`:132`、判定は `:574-575` で一括)。S5/S7 は tick が取得済みの tasks
スナップショットに依存(board read 失敗 = tasks null の pass はスキップし、dedup キーを保持
`:591-600`)。usage peek は 60s(`:546-552`)、janitor は 15 分ごと(`:607-610`)。

### 2.1 edge discipline(dedup の仕組み — 増殖バグの理解に必須)

- 全信号は **rising edge でのみ発火**。dedup は overseer 自身の `ov.seen`(signalKey→指紋)と
  `ov.watch`(dwell 計測)で行う(`swarmOverseer.ts:41-48`)。
- 毎 pass の最後に「今 pass でアクティブでなかったキー」を prune(`pruneTracking`、`:1225-1244`)。
  条件が解消→キーが落ちる→**本物の再発は再発火する**、が設計意図。
- **S3/S10/S11 のキーはサブサイクルが実際に走った pass でしか prune しない**
  (`SUBCYCLE_SEEN_RE`、`:1108`, `:1120-1122`)— 60s に 1 回しか再登録されないキーを 3s の
  prune が消すと S11 の 6h バケット dedup が壊れるため。
- **`seen`/`watch` は in-memory**。再起動・re-arm でゼロクリア → 「持続している条件」は全部
  再発火する。それを吸収するのは escalations 側の **receiptKey 冪等**(open が居る間だけ)と
  各 tier の budget。かつて **dismissed には何も効かず** S3/S10 が re-arm ごとに増殖したが
  (§4.1 の歴史)、`d8431c3` からは S3/S10 に限り **escalations.json 自体を永続受領台帳として
  raise 前に照合する**(status 不問 — §3.6)ため、seen のゼロクリアは再投函に直結しない。

### 2.2 平易文 `plainQuestion` — 誰がどの raise に付けるか(2026-07-17)

すべてのオーナー向け表示は「プログラムを書いたことがない人が読んで判断できる」を基準にする
(オーナー実フィードバック起点)。

- **テンプレ raise(発火側が文面を持つもの)= `plainQuestion` を必ず併記**:
  S1/S2/S3/S5/S10(`swarmOverseer.ts` の各 raiseToInbox)と no-model
  (`swarmOrchestrator.ts` `raiseNoAllowedModelTier`)。3要素 = ①決めること ②選択肢(A:/B:)
  ③各選択の影響(生活言語)。従来の `question`(技術者向け原文)と `context`(技術詳細 —
  S3/S10 は `c.f.detail` 生値)は**そのまま不変** — 技術情報は失われない。
- **worker 由来 raise(文面が worker 産のもの)= `plainQuestion` なし**:
  S4 の 3 経路(THROTTLED 直行 / proxy 注入失敗 / proxy escalate)と engine の TUI スクレイプ
  質問 arm。発火側にテンプレが無く平易文を合成できないため、**worker 自身に平易文3要素で
  書かせる** — `WORKER_ORDER_RULES`(`swarmWorker.ts`)の「【質問は平易文で・厳守】」が全
  spawn プロンプトに焼き込まれる(心拍 blocker・画面質問の両方をカバー。契約は
  `swarmWorker.test.ts` がピン)。
- **UI(SwarmEscalationsPane)**: `plainQuestion` があればそれが既定表示になり、`question` +
  `context` は「技術的な詳細」`<details>` 折りたたみへ。無い record(旧レコード・worker 由来)
  は従来どおり `question` 主表示 + `context` 表示 — 後方互換で消えるものはない
  (`isEscalation` は必須フィールドのみ検証・optional は素通し)。
- **通知(bell/OS toast)の teaser も平易文優先**(`openEscalation` 内 —
  `plainQuestion || question` の先頭 120 字)。
- **不変なもの**: answer フロー(answered 永続化 → you-corpus 追記 → W16 注入 / 次 dispatch
  相乗り)と dismiss は一切変更なし。receiptKey の既定も `question` 由来のまま(平易文は
  identity に関与しない)。
  **例外(2026-07-18 → 2026-07-19 で3面に拡大)**: **回答と対にする質問文**は `plainQuestion ||
  question` になった。オーナーが**実際に読んで答えた文**を学習/配達しないと回答の帰属が狂うため。
  当初は you-corpus だけを直したが、**注入文と次 dispatch 行が技術原文のままで非対称**だったため
  0719 に3面へ揃えた(§5.3)。注入文は平易文と技術原文を**両方**ラベル付きで載せる — worker には
  技術文も要るので、置き換えではなく併記が正解。技術原文は record 上に不変で残る。
  ⚠️ **回答のラベルは `A:` を使わない**(`オーナーの回答:`)。escalation の質問は**設計上ほぼ必ず
  選択肢を含む**(worker 規約が「②選択肢(A/B など)」を要求し、監督のテンプレも A/B を描画する)ので、
  回答を `A:` で始めると同じ接頭辞が「選択肢A」と「回答」の2義になる。注入文・次 dispatch 行・
  you-corpus の3面すべてで語ラベル。**素の(plainQuestion 無し)レーンこそ危ない** — そこは
  worker 産の質問が通る唯一のレーンで、テンプレが無い = 平易文が無い = 必ず自前の A/B を持つ。

### 2.3 判断ルーティング — 「誰が決めるか」の仕分け(2026-07-18)

§2.2 が「オーナーが**読める**質問」を担保したのに対し、こちらは「そもそも**オーナー宛てで
正しいのか**」を担保する。従来の受信箱は *why*(irreversible/insufficient-info/policy)は
分類するが**宛先**を判定しないため、技術的トレードオフの質問がオーナーに届き得た(=誤配達)。

**正典は2つだけ。コードでカテゴリを発明しない。**

1. **「関与の観測地図」** — `~/.openground/you-corpus.md` §4 手動追記のペルソナ節(オーナー
   本人が設計・追記)。**「技術/非技術」のような分類ではない** — オーナーが実際に考えていると
   *観測された* 領域だけがオーナー宛て、関与しないと観測された領域は AI 側で決める。項目は
   (a)本人の発言引用+日付 (b)観測された関与/不関与の事実、のみ。**新しい観測が古い記録に優先**。
2. **恒久境界** — TARGET-STATE §5「人間承認が必須で残る操作」の表。観測ではなく**立て付け上の
   政策**なので、地図が何を言おうと常にオーナー宛て。

実体は `src/lib/server/swarmDecisionRouting.ts`(定数と文面の単一正典)。配線は**3経路**:

| 経路 | 何が入るか | 誰が地図を読むか | file |
|---|---|---|---|
| **worker の /order 規約** | `DECISION_ROUTING_RULES` を `WORKER_ORDER_RULES` に連結(全 spawn に焼き込み) | 読まない。**地図の要旨(digest)を同梱** | `swarmWorker.ts:178`(直後に `SPECIALIST_REVIEW_RULES` も連結 — 判断の**宛先**の次に**方法**が載る。03 章 §5) |
| **大脳(proxy)の prompt** | `brainRoutingRule(3)` を RULE 3 として挿入(旧 RULE 3 の untrusted 節は 4 へ繰り下げ) | **実地図を live で読む**(元々 corpus を path 参照している) | `swarmOverseerBrain.ts:377` |
| **S4 棄権レーン** | 大脳が**実際に corpus を読んだ上での棄権**(=地図に無い)にだけ、平易な**ルーティング質問**を `plainQuestion` として付与 | — | `swarmOverseer.ts:706` |

- ⚠️ **恒久境界は worker digest と大脳プロンプトの両方に載せる**(2026-07-19 差し戻し4で是正)。
  委任領域を渡す規約は、**同じ場所で例外も渡さないと境界を弱める**。実害の形:
  大脳への委任例に「git / integration procedure」があり、これは字義どおり
  **「[hold] カードの統合」= 恒久境界**を含む。ルーティング規約の導入前は、この質問は
  RULE 1(コーパスが根拠付けない)に落ちて **ABSTAIN → オーナーの受信箱**だったが、
  委任領域を明示した結果 **ANSWER → worker の PTY へ注入**が通り得るようになった
  (= この差分が持ち込んだ退行)。可逆性プリゲートも
  `classifyReversibility('この [hold] カードを統合していいですか？')` → `reversible` で素通りするので、
  **止める層は大脳プロンプトしかない**。
  - 非対称が本質だった: worker digest には但し書き(統合そのものは司令塔の仕事)と恒久境界の
    両方があり矛盾が解けていたのに、**人間を介さず自動回答できる唯一の主体である大脳にだけ
    どちらも無かった**。
  - 実装は `PERMANENT_OWNER_BOUNDARIES` からの**補間**(英訳を別に持たない)。境界を1つ足せば
    大脳へ自動で届き、2面がドリフトしない。**和文 verbatim は意図的** — 質問もコーパスも和文で、
    大脳が実際に照合する文字列だから。
  - ピンは**描画後のプロンプト**に対して張る(`buildOverseerAnswerPrompt` の出力に全境界)。
    定数だけを見るピンでは「配線が切れた(brainRoutingRule が prompt から外れた)」を捕まえられない。

- ⚠️ **規約が閉じた弁の代わりに指す逃げ道は、実在するものだけ**(2026-07-19 差し戻しで是正)。
  この規約は「委任領域は escalation にするな」と**既存の弁を閉じる**ので、代わりに示す道が空だと
  worker の実際の選択肢は「当て推量」か「無心拍で停止」になる。旧版は
  **「専門レビュアー(別カード)」= Board の未実装 todo カード**を指しており、テストがその文言を
  写経して固定していた(= 実装の誤りごとピン)。現行の文面が名指すのは**コードで追跡済みの経路**だけ:
  - **心拍の blocker**(`swarm-beat.sh` 第4引数 → `blockers`)に質問の形で書く。
  - → 司令塔が**本文ごと読める**(`GET /api/swarm/workers` が `blocked`/`blockers` を返す)。
  - → **監督が起動していれば** S4 が拾い、大脳(proxy)が答えを PTY に注入する。
    **大脳が答えられなければオーナーの受信箱に回る**(= 大脳は保証された回答者ではない)。
  - ⚠️ **必ず質問の形**(`?`/`？` を入れるのが確実。「〜ですか」等の疑問形も通る)。
    `looksLikeQuestion`(`swarmOverseer.ts:396`)が S4 の入口ゲートで、**質問と判定されない文は
    拾われない**。ただしこの判定は**部分一致の best-effort** — 「いずれ」「どうしても」等を含む
    ただの状況報告も true になるので、「質問文以外は必ず落ちる」とは書かないこと(偽陽性は
    大脳の日次上限を1回無駄に消費する)。
  - ⚠️ **監督は既定 OFF**(in-memory・再起動で必ず OFF)。その場合 S4 レーンは死んでいて、
    **生きているのは司令塔が読む経路だけ**。だから `/og-manage` の「状況」は `blocked:true` の
    ときに `blockers` 本文まで読むよう規定してある(そこを読まないと、この逃げ道は片肺になる)。
  テストは実在性を両側でピン(実経路を含むこと / 「専門レビュアー」を含まないこと)、および
  条件付きの脚を**条件付きのまま**述べていること(「監督が起動していれば」/「答えられなければ受信箱」)。
  - ⚠️ **2026-07-19: 専門レビュアーは実装された**(`swarmSpecialistReview.ts`・03 章 §5)。
    それでも**この否定ピンは残す** — ピンが守っているのは「名前が実在するか」ではなく
    **「閉じた弁の代わりに指す先が“質問を渡せる場所”か」**だから。実装されたのは
    worker **自身の判断手順**(判断の前に一次資料を読む)であって、質問の**宛先**ではない
    (詰まる*前*にやることで、詰まった時に渡す相手ではない)。escalation の経路は上の
    心拍 blocker のままで増えていない。**名前がツリーに現れたことを理由にこの assertion を
    反転させるのが、旧版が警告していた「事故で変える」そのもの**。
  ⚠️ **ここに経路を書き足すときは、必ずコードで追跡してから書く**。旧版の失敗は「実装されていない
  ものを規約が指した」ことで、テストがその文言を写経して固定していたため**テストは緑のまま**だった。

- **なぜ worker には digest なのか**: corpus は数百 KB のオーナー個人データ(0600)で、大脳 PTY は
  それを外に出せないよう `--disallowed-tools` で WebFetch/WebSearch/Bash/Task を構造的に落として
  いる。worker はフル装備 = egress 経路なので、corpus を読ませない。オーナー本人が示した代替が
  「地図の要旨をワーカー標準指示に同梱し、**更新は地図追記と同期**」。
  ⚠️ **同期義務**: 地図に追記したら `OWNER_MAP_ENGAGED` / `OWNER_MAP_DELEGATED` を同じ pass で
  直す。`swarmDecisionRouting.test.ts` は両リストを**完全一致**でピンしている — ただしこれは
  「定数 vs テスト内のコピー」の自己参照ピンなので、**corpus との一致を機械検証するものではない**
  (テストも一緒に書き換えれば通る)。効き目は「無言で1行足す」ができなくなること = 変更を
  明示的な操作に変える程度。corpus 本体との突合は人間がやる。
  ⚠️ **逐語引用を置かない**: corpus の項目はオーナー本人の発言から作られており、このファイルは
  tracked source = リリースのたび**公開 repo へ tree ごとスナップショット**される
  (docs/DISTRIBUTION.md §PII hygiene)。digest には**観測された事実だけ**を書き、本人が言った
  文そのものは corpus(0600・git 非共有)に置いたままにする。`repoPiiGuard.test.ts` は
  メール/実名/ホームパスしか見ないので**これは検出されない** — 書き手が守る規約。
- **未分類レーン(棄権)**: 「corpus が薄い」= その領域が地図に無い、ということ。生の質問を
  そのまま転送せず、まず **1問だけ**「これはあなたが決めたい種類の話ですか?」を平易文で聞く。
  2つ目の選択肢「自分で決める」は「続けて考えを書いてください」= 同じ返信で中身も答えられるので、
  オーナーが持ちたい判断なら往復は 1 回で済む。回答は既存の answer 経路でそのまま you-corpus に
  学習されるので、**答えるたびに地図が育つ**。
  - 📌 **既知の負債(将来課題・0719 時点で未対応)**: corpus 追記はこの平易文を**そのまま** Q として
    書くので、ルーティングレーンでは4行のテンプレート丸ごとが1エントリに入り、corpus が定型文で
    肥大していく。**帰属としては正しい**(オーナーが実際に読んで答えた文と対にするのが §2.2 の
    不変条件)ため、安易に「技術原文に戻す」= 誤帰属の再発になる。直すなら Q 側に主題だけを
    残す圧縮を入れる形で、**帰属を保ったまま**やること。今回は手を入れていない。
  - **主題が先頭**(`buildUnclassifiedRoutingPlainQuestion`): 1行目は「聞かれているのは『…』です。」
    で始まり、「AIが判断できず止まりました」は後ろ。この文面は**通知トーストの teaser にもなり
    120 字で切られる**(`swarmEscalations.ts:446`)ので、前置きを先頭に置くと切り詰めでオーナーが
    識別すべき主題が消える。
  - **空題は `''` を返す**: 主題が空のルーティング質問は答えようがなく、『聞かれているのは「」です』
    は無いより悪い。`''` は `openEscalation` が「plainQuestion 無し」に畳む値そのものなので、
    素の raise(worker の文が主表示)に自然に落ちる。実路では S4 が空 blocker を弾くので到達しない
    = ガードであってレーンではない(`swarmDecisionRouting.ts:240`)。
- ⚠️ **選択肢は「A/B」ではなく語**(`ROUTING_CHOICE_DELEGATE` / `ROUTING_CHOICE_OWN`
  = 「まかせる」/「自分で決める」・`swarmDecisionRouting.ts:214`)。**回答の誤帰属を防ぐため**で、
  見た目の趣味ではない: worker の質問は規約上たいてい選択肢つき(「A: 既存テーブルを拡張 /
  B: 新テーブルを追加」)で、オーナーの生返信は **you-corpus と worker の PTY の両方**へ「質問と対」で
  渡る。裸の「A」は**万能の選択肢ラベル**なので隣に置かれた技術メニューに再束縛され、
  ルーティング質問への「A」が worker には**自分の選択肢 A が選ばれた**と読める。語は再束縛できない。
- ⚠️ **判定は `why` ではなく `OwnerAnswer.abstained` で行う(壊しやすい急所)**。`insufficient-info`
  は**故障系も名乗る**: 大脳の crash/timeout(`swarmOverseerBrain.ts:131` — **全 tier OFF /
  quota park の `NoAllowedModelTierError` もここ**)・verdict 解析不能(`:137`)・5分 watchdog の
  合成 null(`swarmOverseer.ts:546`)・チェーン例外。これらは**地図を一度も参照していない**ので、
  ルーティング質問を出すと ①誰も出していない所見(「地図に無い」)を断定し、故障レーンでは履行
  できない約束(「次から止まりません」)をする ②さらに危険なのは、**可逆性を誰も判定していない
  質問に「まかせる」= 白紙委任を勧めてしまう**こと — K6 のキーワード事前ゲートは
  設計上 best-effort で、言い換えられた不可逆を捕まえる層は大脳の ESCALATE だけ。その大脳が
  落ちているのが故障レーンである。よって `abstained: true` は**本物の棄権**
  (`swarmOverseerBrain.ts` step 4)だけが立てる。故障系は素の raise(worker の質問文が主表示)。
  - **`proxyDraft.isAbstention` も同じ `abstained` で決める**(0719 差し戻し4で是正・元は
    origin/main からの既存バグ)。`why === 'insufficient-info'` で判定していたため、**大脳が
    落ちた/固まった時も「熟慮のうえ棄権した」ラベル**になっていた。このフラグは受信箱カードの
    表示を切り替える(true = `proxyDraft.answer` を出さず定型文「コーパスが薄い」に差し替え)ので、
    **真因の文字列 “proxy brain failed: …” が本文から消える**。`abstained` に寄せた今は、故障は
    自分の `reason` をそのまま表示する。※ 真因は従来も context 段落
    (`(監督の proxy 判断: …)`)には残っていたので、欠陥は「消失」ではなく「誤ラベル+主文の差し替え」。
- **オーナー領域の escalate は `policy`**(2026-07-18): 大脳の verdict 文法に任意修飾
  `ESCALATE OWNER | …` を追加した。素の `ESCALATE` は従来どおり **irreversible**(言い換え不可逆を
  捕まえる層)、`ESCALATE OWNER` は「可逆だがオーナーの領域(名前・進め方など)」= **policy**。
  これが無いと、名前決めの質問が受信箱で「取り消せない操作」と表示され、you-corpus にも
  `irreversible` タグで学習される。文法は後方互換(素の ESCALATE の意味は不変)。
  - **降格にはバックストップがある**(`swarmOverseerBrain.ts:160`): `OWNER` は赤い不可逆バッジを
    落とすので、大脳が破壊的な話を「オーナーの領域」と誤ラベルすると警告だけ静かに消える(受信箱には
    届くので握り潰しではない)。**質問文では捕まえられない** — step 1 の事前ゲートが既に通しているので
    再分類は必ず no-op。新しい証拠は**大脳自身の reason 文**なので、そこに `classifyReversibility` を
    1回通し、引っかかれば `irreversible` に戻す。テストは対でピン(reason「名前の決定」→ policy /
    reason「本番データベースを削除する必要がある」→ irreversible)。
    ⚠️ **偽陽性は承知の上**: キーワード方式なので、可逆な文言決めでも reason に「解約」「初期化」
    等が混ざると `irreversible` が付く(赤バッジ + corpus のタグずれ)。**どちらのズレも起きうるが
    向きが違う** — 偽陽性は「余計に警告が出る」だけで回復可能、偽陰性は「破壊的操作の警告が
    静かに消える」= 回復不能。安全な側に倒してある。受信箱には**どちらでも届く**(握り潰しは無い)。
- **`irreversible` レーンは包まない**: 不可逆は恒久境界で最初からオーナー宛てが正しい。そこに
  「誰が決めますか?」を足すのはノイズ。K6(可逆性が弁、確信度ではない)は不変で、**ルーティングは
  K6 を決して上書きしない**(brain prompt に明記・テストでピン)。
- **技術の説明は禁じていない**: オーナーは仕組みを自分から質問して深く理解する人(ループ/トークン
  設計の議論は全部本人発)。禁じるのは**技術的トレードオフの「判断の委任」**だけ。文面はこの区別を
  必ず含む(`swarmDecisionRouting.test.ts` がピン)。

**ルーティングが掛かっていない同種レーン(宣言・意図的)**: ① engine の **S4 THROTTLED 直行**
(`swarmOrchestrator.ts` — 大脳を止めている状態なので、故障レーンと同じ理由で地図を参照していない)
② `swarmQuestions.ts` の `handleWorkerQuestion`(現状の live 経路に乗っていない)。どちらも worker
自作の質問文がそのままオーナーに出る。将来これらを受信箱の主経路にするときは**ルーティングの
可否を明示的に決める**こと(黙っていると「対応済み」に見える)。

**テンプレ質問の点検結果(2026-07-18)= 該当なし・変更不要**。S1/S2/S3/S5/S10 と no-model の
6本を地図と突き合わせた: いずれも「**作業をどうするか**」(やり直す/分割する/諦める/再開する/
todo へ戻す)か「**政策スイッチ**」(使用可能モデル mask)であって、実装方式・アルゴリズム・
ライブラリ選定をオーナーに選ばせるものは1つも無い ⇒ 前者は観測地図の「進め方の戦略」、後者は
恒久境界に収まる。よってルーティングが縛るのは**テンプレの無い2レーン**(worker 自作の質問文と
大脳の verdict)だけで、テンプレは現状のまま据え置き。判断の記録は
`swarmOverseer.ts:818` の ADDRESSING AUDIT コメント(新テンプレ追加時の基準もここ)。

**不変なもの**: escalation 機構そのもの — 3分類(`EscalationWhy`)・状態機械・receiptKey 冪等・
answer→you-corpus 学習・dismiss は一切変更なし。`question`/`context`(技術原文)もそのまま残り、
注入文 `buildAnswerInjection` も従来どおり `question` を使う(worker AI に届く側は技術文が正しい)。

## 3. 状態機械 / データフロー

### 3.1 overseer pass の 1 周(`runOverseerPass`、`swarmOverseer.ts:496-624`)

```
disarm? → return                                     :504
watchdog: brain が 5min+60s 超過 → 強制解放+null 合成 :523-539
0. mailbox drain(前 pass の大脳結果を配送)          :542
1. usage peek/refresh → S9 遷移判定                   :546-569
   subcycle 判定(60s に 1 回)                        :574-575
2. S1/S2(毎 tick) → S3/S10(subcycle のみ)          :580-581
3. S4(worker 質問 → 大脳 or bare raise)             :585
4. S5/S7(tasks があるときだけ)                      :588-600
5. S11(subcycle のみ)                               :604
6. janitor(15min ごと、force/deleteRemote なし)      :607-610
prune seen/watch                                      :617
```

### 3.2 S4 → 大脳 → mailbox → 配送(T1 の全経路)

1. **budget ゲート**(`brainBudget`、`:420-432`): single-flight(1 PTY のみ)+ 前回から
   10 分(`brainMinIntervalMs`、`:125`)+ 日次 24 回(UTC roll、warn 時 12)。落ちたら
   「skipped: budget」ログだけで **seen に積まない** → budget が空いた pass で再評価(`:738-742`)。
2. **発火**: seen 記帳と budget 課金を**先に**行い(`:744-748`)、`answerAsOwner` を
   fire-and-forget(`:758-787`)。結果は `ov.brainResults`(mailbox)へ。
3. **大脳の中身**(`swarmOverseerBrain.ts:110-204` — answerAsOwner の 6 ステップ):
   ① 質問を C4 で事前ゲート(不可逆なら大脳を呼ばず escalate、`:116-121`)
   ② you-corpus をパス参照で読ませて one-off claude 実行(`:123-132`)
   ③ marker verdict をスクレイプ(`OPENGROUND_OVERSEER: … ::OG_OVERSEER_END::`、`:245-298`)
   ④ 大脳自身の ESCALATE(不可逆)/ ABSTAIN(コーパス薄い)は inbox 行き(`:144-190`)
   ⑤ **回答文も C4 で再ゲート**(prompt-injection 対策の構造バックストップ、`:190-198`)
   ⑥ 可逆 + grounded なら answer(confidence は報告のみ・ゲートしない、`:200-203`)。
   throw は絶対にせず、全異常は insufficient-info で fail-closed(`:108-109,129-131`)。
4. **大脳 PTY の封じ込め**(`makeOverseerBrain`、`swarmOverseerBrain.ts:461-621`): 空の
   scratch dir(`~/.openground/overseer-scratch/`)で `bypass` + L4 write-guard
   (writeRoots=scratch のみ)+ macOS では**常時** Seatbelt sandbox(network loopback +
   allowlist egress proxy)+ `disallowedTools: WebFetch/WebSearch/Bash/Task`(`:360`)+
   `strictMcpConfig` + `hidden` + 5 分 timeout(`:161`)。モデルは
   `resolveSwarmModelEffort(mode,'overseer')` + 許可 tier マスク(`swarmOverseer.ts:339-352`、
   spawn 時再解決 `swarmOverseerBrain.ts:420-421`)。
5. **mailbox drain**(次 pass 冒頭、`swarmOverseer.ts:628-686`):
   - `answer` → `canInjectInto` ガード(live claude TUI・menu 非表示・同一 project UUID —
     `swarmEscalations.ts:529-560`)を通れば `injectAnswerIntoWorker` で worker PTY に注入。
     注入失敗/worker 消滅なら **inbox へ格下げ**(proxyDraft 付き、`:654-665`)。
   - `escalate` / null(brain 死亡)→ inbox へ(proxyDraft は abstention フラグ付き、`:671-684`)。
6. **watchdog**(`:523-539`): settle しない brain は 5min+60s で強制解放し、
   `{...brainInFlight, answer:null}` を mailbox に合成 — 質問が silent drop にならない。

### 3.3 escalations store の状態機械(`~/.openground/escalations.json`)

```
            answer (owner)            配送成功
  open ────────────────→ answered ────────────→ injected
    │                        │  配送失敗/worker 不在
    │ dismiss (owner)        └─→ 'queued'(次 dispatch に相乗り)/'skipped'
    ↓                             ※status は answered のまま
  dismissed
```

- 型: `EscalationStatus = open|answered|injected|dismissed`(`src/lib/types.ts:2073`)、
  record 形は `Escalation`(`types.ts:2091-2127`。2026-07-17 から optional の
  `plainQuestion`(平易文)を持つ — §2.2)。
- **不変条件 1(fail-closed)**: `open` を自動で動かす経路はゼロ。owner の answer/dismiss だけ
  (`swarmEscalations.ts:13-15`)。retention も open は永遠に触らない(`:762`)。
- **receiptKey 冪等**: 同 projectPath + 同 receiptKey の **open** が居る間、再 raise は既存
  record を返す no-op(`:354-371`)。dedup ヒット時は worker 座標(terminalId/branch)だけ
  live 側に更新(`:362-370`)。**resolved(answered/dismissed)には効かない** — 同じ
  receiptKey でも新しい row が立ち得る(`:352-353` コメント。かつて §4.1 増殖の半分だったが、
  S3/S10 に限っては raise 側が §3.6 の永続受領判定で resolved も含めて照合するため塞がれた)。
  既定キーは `sha1(taskId|projectPath|正規化質問文)`(`defaultReceiptKey`、`:313-322`)。
- **answer の 3 段**(`answerEscalation`、`:665-723`): ① answered を先に永続化(crash-safe)
  → ② you-corpus へ Q→A 書き戻し(owner 回答のみ・best-effort、`:702-717`。書き戻しが走らせる
  corpus 再組み立てはソース解決が cwd 非依存(レジストリ参照)で、機械ソースが 1 つも解決でき
  ないときは既存 corpus を上書きせず `skipped` を返す fail-safe 付き — 2026-07-17 のパッケージ版
  「answer だけで corpus がほぼ空に上書き」事故の対策(`youCorpus.ts`)。skip でも判断自体は
  additions に永続化済みで、次の健全な rebuild で corpus に反映される)→ ③ 配送
  (`deliverAnswer`、`:605-653`)。配送は (a) live worker PTY へ W16 注入(bracketed paste →
  200ms → CR → 着地確認+Enter 再送最大 3 回、`:551-583`)= `injected`、(b) worker 不在なら
  `recordEscalationAnswerForNextDispatch` で engine の `reworkReasons` スロットに積み、
  **次 dispatch の /order 行に相乗り**(`swarmOrchestrator.ts:1758-1780`)= `queued`(このキューは
  in-memory — 再起動で消えるが record は answered のまま残る)、(c) どちらも無理 = `skipped`。
- **ライフサイクル辺の細則**: dismissed へ answer = 409(`EscalationStateError`、`:678-680`)。
  injected へ再 answer = 冪等 no-op(`:681-685`)。**answered へ再 answer = 配送だけ retry**
  (最初の回答が立つ・memory 再書き込みなし、`:686-692`)— 配送失敗が dead end にならない脱出口。
- **ファイル堅牢性**: 書き込み path は ENOENT のみ「空」扱い・他の read error は abort
  (`readForWrite`、`:170-188`)。parse 失敗は `.corrupt-<ts>` へ退避してから空継続(`:185`)。
  未知 record(新しい build の enum 等)は `all` に verbatim 保存され消えない(`:165-168`)。

### 3.4 通知ストア(`~/.openground/swarm-notifications.json`)の契約

- **cap 50 は kind ごと・recency のみ・期限なし**: append のたび createdAt 降順 sort →
  **kind 別に**先頭 50 だけ残す(`capNotificationsByKind`、`swarmNotifications.ts:84-96`)。
  古い記録は同じ kind の新しい記録に**押し出されて消える**(それ以外の削除経路なし)。
  ⚠ **2026-07-19 以前は全 kind 共有の 50 だった** — 日次燃費日報(info)が毎日1件必ず積む
  設計なので、静かな日が続くと `rework-exhausted` 等の **fatal がベルから押し出されて
  消えた**(安全弁の消失)。kind 別に分離したのがこの修正。ベルで fatal が見当たらない
  ときに「info に流された」を疑う必要は、もう無い。
- **書き手は `appendSwarmNotification` 一本**(single-flight chain、`:61,101-109`)。その呼び元は
  2 つだけ:
  - `createSwarmFatalNotification`(`:173-182`)— kind `swarm-fatal`。呼ぶのは
    ① engine の `deps.notify`(`swarmOrchestrator.ts:3916-3917`)経由 = **`fireFatalNotifications`
    がエンジン由来 fatal の唯一のチョークポイント**(`swarmOrchestrator.ts:5865-5867`)、
    ② Electron IPC ブリッジ(`registerIncomingNotifications`、`swarmNotifications.ts:255-269`
    — rollback/canary-failed、OS toast は Electron 側が出すので os:false)、
    ③ **起動時のホームデータ破壊検知**(`homeIntegrity.ts` — event `data-integrity`)。
    ③は **swarm 由来ではない**: settings.json / canvas.json が異常縮小した・読めなくなった・
    テスト固有値が実ホームに混入した、という**オーナー宛**の警告。fatal 側に置いてあるのは
    見た目の問題ではなく実害を避けるため — info 行は Inbox アイコン+`text-ink-muted`
    (「何も壊れていない、質問が待っている」用)なので、**登録プロジェクトが消えた通知が
    「質問が来ています」と同じ見た目になる**。fatal 行は警告三角+accent で、かつ `logHint`
    に**控えの絶対パス**を載せられる(復元導線がこれしか無いので必須)。新 `NotificationKind`
    を足す方が正しいが、未知 kind は `NotificationPanel` が `null` を返す=**見えない行なのに
    未読バッジだけ増える幽霊**になる(実装確認済)。非 swarm の相乗りは前例あり
    (`rollback`/`canary-failed` は Electron 自己更新)。読み出し専用の
    `GET /api/home-integrity`(`server/routes/misc.ts`、gate 無し)も同じ内容を返す。
  - `createSwarmInfoNotification`(`:234-243`)— kind `swarm-info`。呼ぶのは escalation-open
    (`swarmEscalations.ts:431-439`)と overseer の S7/S9/S11(`swarmOverseer.ts:356`)、
    それに日次燃費日報 `daily-fuel-report`(`dailyFuelReport.ts` — 2026-07-18 card
    swarm-token-blocked。アプリ稼働ベースの毎日 09:00 定期便で、engine/overseer とは独立系統。
    詳細は 01 章 §9 末尾)。
- **`fireFatalNotifications` の 2 系統**(`swarmOrchestrator.ts:5887-5954`):
  - EDGE(`engine.pendingFatal` を drain、1 回きり)— 今日は `exec-timeout` のみ(`:5980-5983`)。
  - STATE(毎 pass 再導出、`engine.notified` で rising-edge dedup)— `rework-exhausted`
    (`:5990-6001`)と `all-workers-down`(`:6004-6017`)。条件が消えると notified から外れ、
    **本物の再発は再通知される**(`:6019-6027`)。
- fatal イベントの全種は `SwarmFatalEvent`(`types.ts:1959-1964`)、info は `SwarmInfoEvent`
  (`types.ts:1999-2003`)。GET は `/api/swarm/notifications`(swarm owner gate、
  `server/routes/swarm.ts:535-538`)。

### 3.5 engine 側 C3(TUI スクレイプ質問)と S4 の分担

overseer とは**別に**、engine 自身も「claude が入力待ちで止まって画面に質問が見える」を検知して
inbox に raise する(C3、`swarmOrchestrator.ts:4436-4494`)。分担ルール(MF1 修正済):

- **overseer OFF**: engine の C3 が TUI スクレイプ質問を raise(質問が silent drop にならない)。
- **overseer ON**: 心拍 `blocked` の worker については C3 側を suppress し、S4 が心拍 blockers
  から raise する(`:4464` — `heartbeat?.blocked && engine.overseer?.enabled ? null : …`)。
- **両方 raise すると二重になる**理由: receiptKey の材料が違う(S4 = 心拍の blockers 文、
  C3 = TUI から削り出した質問文)ため dedup が跨がらない(`:4449-4452` コメント)。
- 質問で止まった worker のスロット保持は `QUESTION_GRACE_MS`(既定 30 分、
  `swarmOrchestrator.ts:410-413`)まで。過ぎると blocked に park(質問自体は inbox に残る)。

### 3.6 S3/S10 の受領判定 — strict リーダーと 24h 窓(`d8431c3` + `aa9cb8d` の新契約)

S3/S10(`detectEdgeFatals`、`swarmOverseer.ts:854-959`)が「同じ fatal を二度と人に見せない」を
再起動/re-arm を跨いで成立させる 3 層:

1. **時間窓** — `recentFatals(sinceMs)` は「`sinceMs` 以降に append された記録だけ返す」**契約**
   (`OverseerDeps` の宣言 `:317-322`、実装は通知ストアの `createdAt` でフィルタ `:370-379`)。
   窓は `fatalWindowMs` = 24h(`:113`, `:133`)。pass 側でも `createdAt < windowStart` を
   ローカル再強制(防衛、`:900-902`)。`createdAt` の無い記録(手編集/legacy)は「recent を
   証明できない」ので除外(`:372-377`)。
2. **occurrence の同一性 = store 追記時刻** — signalKey / receiptKey の末尾は detail ではなく
   notification の `createdAt`(`TimedSwarmFatal` `:282-286`、キー組み立て `:977`, `:980`)。
   同一 record の再読みは同キー(再投函なし)、真の再発は新 record = 新 createdAt で必ず 1 回
   上がる。旧 detail-in-key の churn(512 clamp 溢れ・detail 差で別 row)も包含して解消
   (`:883-889` コメント)。
3. **永続受領判定(strict リーダー)** — raise 前に escalations.json を照合し、**status を問わず**
   (open/answered/**dismissed** すべて)同 receiptKey が居れば raise しない(`:916-940`)。
   読み手は `listEscalationReceiptKeys`(`swarmEscalations.ts:264-284`、契約コメント `:250-263`)
   = **`readForWrite` と同じ ENOENT-only 契約**: ENOENT だけが「正当に空」、破損 JSON・
   EACCES/EIO 等は **throw**。throw したら「台帳が読めない間は raise を見送る」(`:927-932` —
   盲目 raise は dismissed の再投函そのものなので fail-closed)。要素は `isEscalation` でなく
   shape(receiptKey + projectPath)で拾う — 未知 status/将来 schema の記録も受領は受領
   (`:278-282`、fail-closed 方向)。

**tolerant と strict の呼び分け(`aa9cb8d` の教訓)**: `OverseerDeps` には escalations の読み手が
**2 本**ある — `listEscalations`(tolerant: 失敗 ≈ 空。S11 の staleness 等 info-grade 用、
`:307-310`)と `listReceiptKeys`(strict。S3/S10 の受領判定専用、`:311-316`)。`d8431c3` 当初は
受領判定も tolerant の上に `try/catch` を載せていたが、**tolerant リーダーは EACCES/破損 JSON を
[] に折り畳むため catch が発火せず、fail-closed ガードが実配線では fail-open だった**(敵対
レビューの must-fix 指摘 → `aa9cb8d` で strict リーダーに切替)。教訓: *fail-closed ガードは
「read が throw する」前提ごと検証する — tolerant リーダーの上に載った catch は死んでいる*。

## 4. 落とし穴(司令塔が実際に踏んだ事象を含む)

### 4.1 S3 が過去の exec-timeout を再 arm のたびに全件再投函した(**`d8431c3`+`aa9cb8d` で根治済み** — 機構と実測は歴史)

> **この節は歴史**。増殖は 2026-07-10 の `d8431c3`(24h 窓 + createdAt キー + 永続受領判定)と
> `aa9cb8d`(受領リーダーの strict 化)で根絶された — 現行機構は §3.6。実測データは**将来の回帰の
> 照合点**として当時のまま保持する。カード `c944ea69` 修正済み(done 列)。到達判定(re-arm しても
> escalation が増えないこと)は TARGET-STATE §3。

**当時の機構**(4 点の合成。→ 以下、各点の現在):

1. `recentFatals()` は通知ストアの swarm-fatal を**全件**返す — 時間窓が無い(当時の実装は
   `listSwarmNotifications()` を kind でフィルタするだけ)。→ **現在**: `recentFatals(sinceMs)` +
   `fatalWindowMs` 24h 窓(`swarmOverseer.ts:133,370-379`、§3.6-1)。
2. 通知ストア側にも期限が無い(cap 50 の押し出しのみ、`swarmNotifications.ts:30,65-68`)—
   静かな期間は 1 週間前の exec-timeout も残り続ける。→ **現在も同じ**(ストアは変更なし —
   窓と受領判定が読み手側で吸収)。
3. S3 の dedup(`ov.seen`)は **in-memory**(`swarmOverseer.ts:46-48`)— 再起動 / OFF→ON
   (re-arm)でゼロクリア。→ **現在も in-memory のまま**だが、raise 前の永続受領判定
   (escalations.json 照合、§3.6-3)が再起動を跨ぐ dedup を担う。
4. escalation を **dismiss しても通知ストアの fatal は消えない**(dismiss は escalations.json の
   status を変えるだけ、`swarmEscalations.ts:730-745`)。receiptKey 冪等は open が居る間だけ
   (`:354-356`)なので、dismissed の後の再 raise は**新しい row を積んだ**。→ **現在**: S3/S10 の
   receiptKey は `<id>:<path>:<ref>:<createdAt>` に固定され(§3.6-2)、**dismissed でも**受領台帳
   照合で raise 自体が抑止される(§3.6-3)。

→ 当時の合成結果: **arm するたびに、通知ストアに残る全 exec-timeout が 1 世代ぶん新規 escalation に
なる**。dismiss は次の世代を止めなかった。

**実測**(2026-07-10、根治前の本文書初版執筆時。§7.3 のコマンドで当時再現できた):

- 通知ストアの exec-timeout fatal は 8 件(07-01×5 / 07-02×1 / 07-06×1 / 07-09×1)。
- escalations.json には exec-timeout 由来 record が **25 件**(07-08 に 8 件・07-09 に 17 件、
  全て dismissed)— 元 8 件が arm のたびに世代コピーされた形。カード起票時(2026-07-09)の
  実測は「07/01〜07/06 の 8 件が 3 世代 24 件」。
- 対応カード: `c944ea69-5b95-4541-ba14-f60a3db08e5d` "[swarm] overseer S3 が過去の
  exec-timeout を毎回再投函する — recentFatals に時間窓が無く dismiss も効かない"(起票時
  blocked 列 → **`d8431c3`+`aa9cb8d` で修正・done 列**)。
- なお根治後も、**24h 窓に入る古い fatal(例: 前日の exec-timeout)が受領台帳に無ければ、修正後の
  初回 arm で 1 回だけ正当に上がる**(それが「未受領の実発生」だから)。dismiss すればその
  occurrence は二度と来ない — 増殖(世代コピー)との違いは「同じものが再び来るか」。

**MF1 read-failure guard との区別**(誤解しやすい): `detectEdgeFatals` の catch 節
(`swarmOverseer.ts:874-881`)は「**通知ストアの read が失敗**した pass では S3/S10 の seen キーを
保持し、成功 read だけが『fatal 消えた』と結論できる」というガード。防ぐのは *transient read
失敗 → prune → 復旧時に回答済み fatal を再 raise* という**別種の**重複であって、当時の再 arm 増殖は
**防がなかった**(seen 自体が in-memory で消えるため — それを塞いだのが §3.6 の永続受領判定)。
同型のガードが S11 にもある(`:1107-1075`)。受領台帳側にも対の catch がある(台帳が読めない
sub-cycle は raise 見送り、`:927-932`)。また当時の detail-in-key 設計(「同一カードが別の
タイミングで 2 回 timeout」を別事象として扱う意図)は増殖の 1 要因(detail が違えば別 row)
だったが、createdAt キーが同じ意図をより正確に果たす形で置換された(§3.6-2)。

**司令塔の対処**(更新):

- 根治後に S3/S10 が上がったら、それは **24h 窓内の未受領 occurrence** — 過去分の再投函を疑う
  前に、まず実発生として §5.2 の裏取りへ。念のための突合手順(§7.3)は正当性確認に今も使える。
- dismiss は**恒久に効く**(再起動・re-arm を跨ぐ)。「また来る前提で dismiss」の運用は不要。
- 増殖パターン(同一 fatal 由来の escalation が世代コピーされる)を再び観測したら回帰 —
  §3.6 の 3 層(窓/キー/受領)のどれかが壊れている。`git log --oneline -- src/lib/server/swarmOverseer.ts src/lib/server/swarmEscalations.ts` で直近の変更を疑う。

### 4.2 S5 blocked-dwell は [保留] 運用と正面衝突する

- 現行の Board 運用では **blocked 列を「依存待ちの保留レーン」として流用**している([Phase1/2
  保留] 等をタイトルに付けて区別 — swarm-board 5 列固定のため)。
- 一方 S5 は「blocked に 30 分連続滞留 = 人の判断が要る異常」とみなして inbox に上げる
  (`swarmOverseer.ts:1041-1093`)。**[保留] カードは 30 分で必ず S5 の対象になる**。
- 発火は 1 カードにつき dwell 1 回(fp=`blocked:<since>`、`:1069-1072`)だが:
  - dismiss しても **re-arm / 再起動で watch がゼロから** → 30 分後にまた来る(`:185-188`)。
    (S3/S10 と違い、**S5 には永続受領判定が無い** — §3.6 の機構は edge fatal 専用。)
  - 一旦 blocked から出て戻ると新しい dwell として再発火(prune → 再 watch、設計どおり)。
- 実例(当時): §4.1 のカード `c944ea69` 自身が [保留] で blocked に居た = overseer を arm して
  いる限りこのカードについて S5 が定期的に上がってきた(同カードは現在 done — blocked 列に
  [保留] カードが居る限り同じ衝突は今も起きる)。
- 司令塔の対処: [保留] カード由来の S5 は「既知・保留中」と即答(dismiss)してよい。
  question 文中のカードタイトルに `[保留]` があるかで見分ける。overseer を長時間 arm する
  運用に移るなら、保留レーンを blocked 以外に移すか S5 の除外規約(タイトル prefix)をコードに
  入れる必要がある(未実装 — §6)。
- **例外が1つだけ実装済み(2026-07-19)**: 日次燃費日報の改善提案カード
  (`fuelProposalKey` を持つカード)は **S5 の対象外**(`swarmOverseer.ts` の
  `detectBlockedDwell` 冒頭で continue)。理由は上の一般論と同じではなく**より強い**もので、
  このカードは「依存待ち」ではなく**オーナーの判断待ちとして blocked に置くのが設計**
  (todo への移動＝承認)。S5 の定型文「依存は解けましたか?」は状況を誤って説明するうえ、
  起票時に日報がベルで既に知らせているので、30 分後の再催促は**文面の合わない二重催促**に
  なる。タイトル prefix ではなくフィールドで判定しているので、オーナーがカード名を
  書き換えても除外は外れない。

### 4.3 dismiss は「消音」ではない(信号ごとの再来条件)

| 信号 | dismiss 後にまた来る条件 |
|---|---|
| S1 | anomaly が残存 + re-arm(seen リセット)。attempts が動いても fp が動き再発火(`swarmOverseer.ts:807-808`) |
| S2 | 条件解消→再発、または notified が残ったまま re-arm |
| S3/S10 | **来ない**(`d8431c3`+`aa9cb8d` — 受領台帳が status 不問の永続 dedup、§3.6)。来るのは真の再発(新 createdAt の新 record)だけ・それも 1 回。かつては「通知ストアに fatal が残っている限り re-arm ごと」だった(§4.1 の歴史) |
| S4 | 同じ質問文なら open が居る間は dedup。dismiss 後に worker がまだ blocked なら再 raise |
| S5 | re-arm / blocked 出入りで dwell 再計測 → 30 分後(§4.2) |
| S11 | escalation が open な限り 6h ごと(バケット、`:1080-1084`) |

### 4.4 その他の運用注意

- **通知ストア cap 50 の押し出し**: 賑やかな期間は逆方向の問題が起きる — 未対応の exec-timeout
  fatal が info 通知(S11 の 6h リマインダー等)に押し出されて消えると、**S3 の発火源ごと消える**
  (escalation が立っていればそちらは残る。fatal だけが消える)。「通知ストアに無い = 起きて
  いない」ではない。engine log が全履歴(`swarmNotifications.ts:27-29`)。
- **S11 自体が通知ストアを埋める**: open を放置すると 6h ごとに info record が積まれ、cap 50 を
  消費していく(前項の押し出しを加速)。
- **overseer の状態はすべて in-memory**: GET state の `overseer:true` は「今のプロセスで arm
  されている」以上の意味を持たない。再起動後は必ず false(K2、`swarmOverseer.ts:23-25`)。
- **注入(W16)の 3 条件**を満たさない answer は queued/skipped に落ちる: 対象 PTY が claude
  TUI であること・メニュー非表示・同一 project UUID(`swarmEscalations.ts:529-560`)。
  answered のまま injected にならない record はこのガードに落ちた可能性 — 再 POST answer で
  配送だけ retry できる(`:686-692`)。
- **screenshot(PTY tail)は起票時点のスナップショット**: 今の worker 画面ではない。live 確認は
  Terminal タブで。

## 5. 司令塔の運用指針 — どの escalation を信じるか

### 5.1 トリアージ順序

1. `status=open` だけ見る(§7.2)。resolved は履歴。
2. `whyEscalated` で緊急度を分ける: `irreversible` > `insufficient-info` > `policy`
   (S1/S2/S3/S5/S10 と C3 は全部 `policy` で上がる — `swarmOverseer.ts:816,840,948,997`、
   `swarmOrchestrator.ts:4478`)。
3. **S3/S10 系は 24h 窓内の未受領 occurrence**(`d8431c3`+`aa9cb8d` 以降 — 過去分の再投函は
   根絶済み、§3.6)。実発生として §5.2 の裏取りへ。疑わしければ §7.3 の突合で正当性確認。
4. S5 系はカードタイトルの `[保留]` を確認(§4.2)。
5. 残ったものが「本物の今の問題」。proxyDraft があれば大脳の下書き(confidence /
   isAbstention 付き、`types.ts:2078-2084`)を確認してから answer。
6. UI の既定表示は `plainQuestion`(平易文 — §2.2)。**司令塔が機械で読むときは従来どおり
   `question`/`context` を使う**(receiptKey も question 由来)— 平易文は人間向けの別表現で
   あって identity ではない。技術詳細は UI では「技術的な詳細」折りたたみの中にある。

### 5.2 偽物(stale/増殖)の見分け方 — 裏取り 3 点セット

- **branch が実在するか**: `git -C <repo> branch -a | grep <branch>`。無ければ worker/worktree は
  既に掃除済み — escalation は過去の遺物。
- **branch が main に取り込まれていないか**: `git -C <repo> merge-base --is-ancestor <branch> origin/main`
  が真なら統合済み — その質問はもう意味を持たない可能性が高い。
- **taskId が Board に実在するか + 今どの列か**(§7.5)。done/消滅済みカードの escalation は閉じてよい。

### 5.3 answer するとき

- answer は (a) live worker に W16 注入される(worker はその回答を前提に再開)か、(b) worker が
  居なければ**次 dispatch の /order に 1 行で相乗り**する(切り詰め、全文は record に残る —
  `swarmEscalations.ts:671` / `:706-711`)。
- ⚠️ **回答の帰属は 3 面すべてで同じ**(2026-07-18 差し戻しで是正・壊しやすい): 回答は**それが
  答えた質問と対でしか意味を持たない**。`plainQuestion` を持つ record では、オーナーが画面で読んだ
  のは**その平易文**(UI は技術原文を details に畳む)なので、**注入文・次 dispatch 行・you-corpus の
  3 つとも**平易文を回答の相手として扱う。以前は corpus だけが平易文で、注入と queue が技術原文を
  使っていた = **同じ record で非対称**だった。実害はルーティングレーンで具体化する: worker の質問は
  A/B メニュー、オーナーが読んだのはルーティング質問 → その回答が技術メニューの下に置かれ、
  **worker が自分の選択肢を選ばれたと誤読する**。注入文は平易文と技術原文を**両方**ラベル付きで
  載せる(技術原文は落とさない)。ピンは `swarmEscalations.test.ts`(注入・queue の両レーン)。
- **owner の answer だけが you-corpus に学習される**(`:770`)— 適当に answer すると proxy-you
  がそれを学ぶ。判断でないもの(過去分の掃除)は answer でなく **dismiss**(何も注入せず何も
  学習しない)。
- API は §7.6。answer=404/409/500 の意味: 404=id 不存在、409=dismissed に answer
  (`server/routes/swarm.ts:850-851`)。
- **ルーティング質問(「これはあなたが決めたい種類の話ですか?」)が来たら** — S4 の棄権レーン
  (§2.3)。中身の質問ではなく**宛先を聞いている**。「まかせる」と答えると、その回答が
  you-corpus に学習されて**次から同種の質問は上がらなくなる**(地図が育つ)ので、掃除のつもりで
  dismiss せず、宛先だけでも答える方が受信箱は静かになる。オーナー本人が持ちたい判断なら、同じ
  返信に中身の答えをそのまま書けば 1 往復で済む(「自分で決める」がそう促す文面になっている)。

## 6. 既知の穴(file:line 付き列挙 — 修正はしない)

1. ~~**S3/S10 再投函増殖**~~ → **`d8431c3`+`aa9cb8d` で解決済み**(カード `c944ea69` done)。
   当時の 4 因子(窓なし × ストア期限なし × seen in-memory × dismissed に冪等なし)と現在の
   対応は §4.1(歴史)と §3.6(現行機構)。ストア期限なし(`swarmNotifications.ts:30`)と
   seen in-memory(`swarmOverseer.ts:46-48`)自体は現存 — 窓+永続受領が読み手側で吸収する設計。
2. **S5 × [保留] 運用の衝突**(仕様間の衝突): blocked 列の保留レーン流用に対し S5 が 30 分で
   inbox 行き(`swarmOverseer.ts:1041-1093`)。除外規約([保留] prefix skip 等)は未実装 —
   **例外は燃費提案カード(`fuelProposalKey`)のみ除外済み**(2026-07-19)。§4.2。
3. **S8 は表に載るが観測できない**: `OVERSEER_SIGNALS` に S8 がある(`swarmOverseer.ts:162`)のに
   `fired` にも通知にも現れない(cap 半減という効果のみ、`:415-416,738`)。日次 cap が突然 12 に
   なった理由をログから追えない。
4. ~~**S3 の detail-in-key と増殖の相互作用**~~ → **`d8431c3` で解消**。キーは detail でなく
   store 追記時刻 `createdAt` に(`swarmOverseer.ts:883-889,909,912`)— 「同一カードの複数回
   timeout は別事象」の意図は保ちつつ、detail 差による row 増殖と 512 clamp 溢れが消えた(§3.6-2)。
5. **escalations.json は uncapped**(`swarmEscalations.ts:22-23`)。増殖(旧穴 1)が閉じたので
   単調増加は止まったが、正当な raise の蓄積はする — open が無ければ 90 日 retention で回収される
   のが唯一の下り(`:754-781`)。
6. **queued 配送は in-memory**: worker 不在時の answer は `engine.reworkReasons` に乗るだけ
   (`swarmOrchestrator.ts:1758-1780`)— 次 dispatch 前に再起動すると配送は消える(record は
   answered のまま、質問し直しは worker 側)。
7. **通知 cap 50 押し出しで fatal の証跡が消える**(§4.4)— 「S3 が上がらない = 問題ない」とは
   言えない構造。全履歴は engine log(in-memory ring)と escalations 側の record のみ。
   24h 窓の導入で「押し出される前に読まれる」保証も無い(窓と cap は独立)。

## 7. 検証コマンド集(そのまま打てる形)

前提: OPEN GROUND が :47776 で稼働、owner ログイン済み **または** ローカル解錠済み(全
/api/swarm/* は swarm owner gate = swarmGate.ts — サーバ永続 session かサーバローカル解錠
(env `OPENGROUND_LOCAL_OWNER=1` / settings.json 手編集 `swarmLocalOwner:true`、
docs/SECURITY.md)で判定するので同一マシンの curl は通る)。`<PATH>` は対象プロジェクトの
登録済み絶対パス。

### 7.1 overseer の現在状態(armed か・engine が running か)

```bash
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq '{running, overseer, selfSupply, anomalies: (.anomalies | length)}'
```

### 7.2 受信箱 — open だけ / 全件の status 内訳

```bash
# open だけ(司令塔が対応すべき現物。plainQuestion はオーナー向け平易文 — 無ければ旧レコード)
curl -s "http://127.0.0.1:47776/api/swarm/escalations?status=open" | jq '.escalations | map({id, createdAt, whyEscalated, question: .question[:80], plain: (.plainQuestion // "" | .[:80])})'
# ストア全体の status/why 内訳(ファイル直読み)
jq -r '.items | "total: \(length)", (group_by(.status) | map("status \(.[0].status): \(length)") | .[]), (group_by(.whyEscalated) | map("why \(.[0].whyEscalated): \(length)") | .[])' ~/.openground/escalations.json
```

### 7.3 S3 増殖の突合(発火源 fatal ↔ escalation 世代)

```bash
# 発火源: 通知ストアに残る exec-timeout fatal の日付分布
jq -r '.items[] | select(.kind=="swarm-fatal" and .swarmFatal.event=="exec-timeout") | (.createdAt/1000 | todate[:10])' ~/.openground/swarm-notifications.json | sort | uniq -c
# 増殖側: exec-timeout 由来 escalation の件数・日付・status
jq -r '[.items[] | select(.question | contains("実行時間上限"))] | "count: \(length)", (group_by(.createdAt[:10]) | map("\(.[0].createdAt[:10]): \(length)") | .[]), (group_by(.status) | map("\(.[0].status): \(length)") | .[])' ~/.openground/escalations.json
# → escalation 件数が fatal 件数の整数倍近くあれば「世代コピー」が起きている(§4.1 の歴史パターン。
#   d8431c3+aa9cb8d 根治後にこれを観測したら回帰 — §4.1 末尾の手順で直近変更を疑う)
# 根治の到達判定(re-arm しても件数が増えない)は TARGET-STATE §3 のコマンド一式
```

### 7.4 通知ストアの中身(fatal/info 内訳と cap 消費)

```bash
jq -r '.items | "total: \(length) / cap 50", (group_by(.kind) | map("\(.[0].kind): \(length)") | .[])' ~/.openground/swarm-notifications.json
jq -r '.items | map(select(.kind=="swarm-fatal")) | group_by(.swarmFatal.event) | map("\(.[0].swarmFatal.event): \(length)") | .[]' ~/.openground/swarm-notifications.json
```

### 7.5 escalation の偽物判定(branch / カードの実在)

```bash
# branch 実在?(無ければ掃除済みの遺物)
git -C <PATH> branch -a | grep <branch>
# 統合済み?(真 = もう main に入っている)
git -C <PATH> fetch origin main >/dev/null 2>&1; git -C <PATH> merge-base --is-ancestor <branch> origin/main && echo MERGED || echo NOT-MERGED
# カード実在 + 現在列(<uuid> は ~/.openground/projects/ 配下の対象プロジェクト dir 名)
jq -r '.tasks[] | select(.id=="<taskId>") | "\(.boardColumn // "?")\t\(.title)"' ~/.openground/projects/<uuid>/tasks.json
```

### 7.6 escalation の操作(answer / dismiss / 手動 open)

```bash
# answer(注入 or 次 dispatch queue。結果 delivery: injected|queued|skipped)
curl -s -X POST http://127.0.0.1:47776/api/swarm/escalations/answer -H 'Content-Type: application/json' -d '{"id":"<escalationId>","answer":"<回答文>"}' | jq '{status: .escalation.status, delivery, memoryWritten}'
# dismiss(何も注入しない・何も学習しない)
curl -s -X POST http://127.0.0.1:47776/api/swarm/escalations/dismiss -H 'Content-Type: application/json' -d '{"id":"<escalationId>"}' | jq '.escalation.status'
# 手動 open(検証用 — receiptKey 冪等の確認は同 body を 2 回打って deduped:true を見る)
curl -s -X POST http://127.0.0.1:47776/api/swarm/escalations/open -H 'Content-Type: application/json' -d '{"path":"<PATH>","question":"検証用の質問?","context":"検証","whyEscalated":"policy"}' | jq '{id: .escalation.id, deduped}'
```

### 7.7 overseer の arm / disarm(arm は engine running が前提)

```bash
curl -s -X POST http://127.0.0.1:47776/api/swarm/orchestrator/overseer -H 'Content-Type: application/json' -d '{"path":"<PATH>","enabled":true}' | jq '{overseer, sandboxWarning}'
curl -s -X POST http://127.0.0.1:47776/api/swarm/orchestrator/overseer -H 'Content-Type: application/json' -d '{"path":"<PATH>","enabled":false}' | jq '.overseer'
```

### 7.8 付帯物の確認(PTY キャプチャ / 心拍 / 大脳 scratch)

```bash
ls -la ~/.openground/escalation-shots/ | head          # 起票時 PTY tail(record 1 つに 1 ファイル)
ls ~/.openground/swarm/ 2>/dev/null                     # 心拍の repo-key dir(S4 の読み元)
ls ~/.openground/overseer-scratch/ 2>/dev/null          # 大脳 one-off の scratch(通常は空 — 残骸があれば teardown 失敗)
```

---

*関連文書: `docs/OVERSEER_DESIGN.md`(設計正典・§6 信号表 / §8 受信箱の原典)、
`docs/commander/05-board-api-contract.md`(Board 列ライフサイクル — S1/S5 の列セマンティクスの前提)。*
