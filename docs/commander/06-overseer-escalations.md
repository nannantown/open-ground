# 06 — Overseer 信号系(S1〜S11)とエスカレーション/通知ストア

> **対象コミット: `0d1f7f0`** (origin/main tip, 2026-07-10)。初版は `cc7c60e` のソース基準で、
> `d8431c3`(S3/S10 再投函根絶: 24h 窓 + createdAt キー + 永続受領判定)と `aa9cb8d`(受領台帳
> 読みの strict 化)を反映済み。`0d1f7f0`(quota 検知根治)は overseer/escalations に変更なし —
> 本章は `swarmOrchestrator.ts` 参照の行番号シフトのみ反映。行番号は全て `0d1f7f0` 時点。
> 読者 = 将来の司令塔(og-manage / manage セッション)。
> 本文書の主張には全て `file:line` の根拠を付けてある。裏取りは §7 の検証コマンドで自分で行うこと。
> 設計正典は `docs/OVERSEER_DESIGN.md`(spike 成果物)— 本文書は「実装が今どうなっているか」の写し。

## 0. 司令塔が最初に覚える 5 行

1. **overseer は第3トグル・default OFF・in-memory**。再起動で OFF、autonomy 明示 OFF
   (`stopOrchestrator`)でも OFF(`src/lib/server/swarmOrchestrator.ts:6170-6173`)。arm は
   engine が running のときだけ受理(`:6700-6703`)。ON にできるのは owner の
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
| ルート | `server/routes/swarm.ts` | `/api/swarm/escalations*`(`:740,761,833,858`)、overseer トグル(`:688`)、通知(`:535`)。**全ルート owner gate** |

### 1.2 永続ストアと in-memory 状態

| 置き場所 | 何か | 生存期間 |
|---|---|---|
| `~/.openground/escalations.json` (`paths.ts:33`) | 受信箱の実体。**uncapped**(`swarmEscalations.ts:22-23`)・mode 0600・fsync(`:205-207`) | `open` は永遠。resolved は 90 日で boot sweep(`:64`, `:754-781`、呼び元 `server/index.ts:70`) |
| `~/.openground/escalation-shots/` (`paths.ts:37`) | 起票時の worker PTY 末尾キャプチャ(1 record 1 ファイル、`swarmEscalations.ts:380-397`) | record prune 時に unlink(`:770-778`) |
| `~/.openground/swarm-notifications.json` (`paths.ts:27`) | bell の中身(swarm-fatal / swarm-info / collab-invite)。cap 50(`swarmNotifications.ts:30`) | **期限なし** — 新しい 50 件に入っている限り残る(`:65-68`) |
| `engine.overseer`(in-memory) | `OverseerRuntime`: enabled / seen / watch / brainResults / budget(`swarmOverseer.ts:189-230`) | 再起動で全消え → enabled=false(K2)。seen/watch リセット = dwell 時計ゼロから(`:185-188`)。**S3/S10 の再投函はこのリセットでは復活しない**(永続受領判定 — §3.6/§4.1) |
| `engine.notified`(in-memory) | state 系 fatal の rising-edge dedup(`swarmOrchestrator.ts:1538-1543`) | 再起動で消える |
| `engine.pendingFatal`(in-memory) | edge 系 fatal(exec-timeout)の一時キュー(`swarmOrchestrator.ts:1544-1548`) | 次 pass で drain(`:5906-5909`) |

### 1.3 点火経路(誰がいつ呼ぶか)

- `runEnginePass`(3s tick)の末尾で、`fireFatalNotifications`(`swarmOrchestrator.ts:6009-6013`)
  の**後**に `runOverseerPass` を await(`:6020-6025`)。後に置くのは S2 が fresh な
  `engine.notified` を読むため(`:6019`)。overseer は**専用ドライバを持たない**(K1、
  `swarmOverseer.ts:4-6`)。
- disarm 済みなら 1 行目で no-op(`swarmOverseer.ts:504`)。pass 全体が try/catch で tick に
  絶対 throw しない(`:618-621`)。
- arm/disarm: `POST /api/swarm/orchestrator/overseer {path, enabled}`(`server/routes/swarm.ts:688-707`)
  → `setOverseer`(`swarmOrchestrator.ts:6685-6710`)。**arm は `engine.running` が前提** —
  停止中 engine への arm は warn ログだけ出して無視(`:6700-6703`)。非 darwin で arm すると
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
| **S3** exec-timeout | 通知ストア再読(60s サブサイクル)で `event:'exec-timeout'`、**24h 窓内**(`fatalWindowMs`、`:133`)かつ**受領台帳に無い occurrence のみ**(§3.6)。元は worker が `MAX_EXEC_MS`(既定 90 分、`swarmOrchestrator.ts:334`)超過 → `pendingFatal.push`(`:4231-4239`) | T3 | inbox へ「分割して再依頼 or 見送り?」。receiptKey=`S3:<path>:<ref>:<createdAt>`(§3.6)。~~§4.1 の増殖バグの主役~~ → **根治済み(§4.1 は歴史)** | `swarmOverseer.ts:854-959` |
| **S4** worker 自由文質問 | live worker の心拍が `blocked` かつ blockers 文が疑問形(`looksLikeQuestion`、`swarmOverseer.ts:392-399`)。心拍の blocked 判定は `phase==='blocked' || blockers` (`swarmOrchestrator.ts:2340`) | **T1**(THROTTLED 中は T3 直行) | budget が通れば大脳を fire-and-forget で起こす(`:744-787`)。**1 pass に 1 brain**(`:788-789`)。THROTTLED 中は素の質問を inbox 直行(`:718-734`) | `swarmOverseer.ts:690-791` |
| **S5** blocked-dwell | tasks スナップショットで `blocked` 列カードが**連続 30 分**滞留(`blockedStuckMs`、`:128`)。watch で dwell 計測(`:977-986`) | T3(weak) | inbox へ「依存は解けましたか?(todo へ戻す/このまま保留)」。**overseer は自分では列を動かさない**(`:993-1000`)。**[保留] 運用と衝突** — §4.2 | `swarmOverseer.ts:965-1007` |
| **S6** | **欠番**。todo 枯渇→次タスク起草は C-core スコープから除外(goal 生成は最高リスクの runaway) | — | — | `swarmOverseer.ts:139-144` |
| **S7** review-idle | `engine.reviews` の `status==='ff'`(統合可)が**連続 30 分**残存(`reviewIdleMs`、`:129`) | T0' | info 通知 `review-idle`「統合可能な review カードが N 件…」。inbox には行かない(`:1043`) | `swarmOverseer.ts:1011-1052` |
| **S8** usage warn | キャッシュ済み使用量 pct ≥ 80(`usageLevel`→`'warn'`、`src/lib/usageThresholds.ts:7,21-26`) | T0' | **大脳の日次上限を半減**(24→12、`brainDayCap`、`swarmOverseer.ts:415-416`)。※`fired` 配列には積まれない(通知も出ない) — 効果だけの暗黙信号 | `swarmOverseer.ts:553-555,738` |
| **S9** usage over | pct ≥ 100 への**遷移**(rising edge)。回復(<100)は無音(`:557-558`) | THROTTLED | `ov.throttled=true`。enter 時に info 通知 `overseer-throttled` を 1 発(`:560-567`)。以後 S4 は大脳を経由せず bare raise | `swarmOverseer.ts:546-569` |
| **S10** rollback / canary-failed | 通知ストア再読(60s)で `event:'rollback'|'canary-failed'`、**24h 窓 + 受領判定は S3 と同一**。発火源は Electron 自己入替 → IPC → `registerIncomingNotifications`(`swarmNotifications.ts:206-221`) | T3 | inbox へ「エンジン自己入替が失敗し旧版で動作中…どう対応?」 | `swarmOverseer.ts:854-959`(S3 と同じ関数、`:906`) |
| **S11** inbox-stale | `open` の escalation が **6 時間**未回答(`inboxStaleMs`、`:130`)。60s サブサイクル | T0' | info 通知 `escalation-reminder`。**6h バケットごとに最大 1 回**再通知(`:1080-1084`)。絶対に auto-progress しない(fail-closed) | `swarmOverseer.ts:1056-1099` |

サブサイクルの整理: S1/S2 は毎 tick(3s・ゼロコスト)。S3/S10/S11 は 60s サブサイクル
(`escalationsPollMs`、`:132`、判定は `:574-575` で一括)。S5/S7 は tick が取得済みの tasks
スナップショットに依存(board read 失敗 = tasks null の pass はスキップし、dedup キーを保持
`:591-600`)。usage peek は 60s(`:546-552`)、janitor は 15 分ごと(`:607-610`)。

### 2.1 edge discipline(dedup の仕組み — 増殖バグの理解に必須)

- 全信号は **rising edge でのみ発火**。dedup は overseer 自身の `ov.seen`(signalKey→指紋)と
  `ov.watch`(dwell 計測)で行う(`swarmOverseer.ts:41-48`)。
- 毎 pass の最後に「今 pass でアクティブでなかったキー」を prune(`pruneTracking`、`:1110-1129`)。
  条件が解消→キーが落ちる→**本物の再発は再発火する**、が設計意図。
- **S3/S10/S11 のキーはサブサイクルが実際に走った pass でしか prune しない**
  (`SUBCYCLE_SEEN_RE`、`:1108`, `:1120-1122`)— 60s に 1 回しか再登録されないキーを 3s の
  prune が消すと S11 の 6h バケット dedup が壊れるため。
- **`seen`/`watch` は in-memory**。再起動・re-arm でゼロクリア → 「持続している条件」は全部
  再発火する。それを吸収するのは escalations 側の **receiptKey 冪等**(open が居る間だけ)と
  各 tier の budget。かつて **dismissed には何も効かず** S3/S10 が re-arm ごとに増殖したが
  (§4.1 の歴史)、`d8431c3` からは S3/S10 に限り **escalations.json 自体を永続受領台帳として
  raise 前に照合する**(status 不問 — §3.6)ため、seen のゼロクリアは再投函に直結しない。

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
3. **大脳の中身**(`swarmOverseerBrain.ts:97-155` — answerAsOwner の 6 ステップ):
   ① 質問を C4 で事前ゲート(不可逆なら大脳を呼ばず escalate、`:105-108`)
   ② you-corpus をパス参照で読ませて one-off claude 実行(`:110-119`)
   ③ marker verdict をスクレイプ(`OPENGROUND_OVERSEER: … ::OG_OVERSEER_END::`、`:193-237`)
   ④ 大脳自身の ESCALATE(不可逆)/ ABSTAIN(コーパス薄い)は inbox 行き(`:131-139`)
   ⑤ **回答文も C4 で再ゲート**(prompt-injection 対策の構造バックストップ、`:146-149`)
   ⑥ 可逆 + grounded なら answer(confidence は報告のみ・ゲートしない、`:150-154`)。
   throw は絶対にせず、全異常は insufficient-info で fail-closed(`:96,117-118`)。
4. **大脳 PTY の封じ込め**(`makeOverseerBrain`、`swarmOverseerBrain.ts:392-549`): 空の
   scratch dir(`~/.openground/overseer-scratch/`)で `bypass` + L4 write-guard
   (writeRoots=scratch のみ)+ macOS では**常時** Seatbelt sandbox(network loopback +
   allowlist egress proxy)+ `disallowedTools: WebFetch/WebSearch/Bash/Task`(`:360`)+
   `strictMcpConfig` + `hidden` + 5 分 timeout(`:161`)。モデルは
   `resolveSwarmModelEffort(mode,'overseer')` + 許可 tier マスク(`swarmOverseer.ts:339-352`、
   spawn 時再解決 `swarmOverseerBrain.ts:420-421`)。
5. **mailbox drain**(次 pass 冒頭、`swarmOverseer.ts:628-686`):
   - `answer` → `canInjectInto` ガード(live claude TUI・menu 非表示・同一 project UUID —
     `swarmEscalations.ts:484-502`)を通れば `injectAnswerIntoWorker` で worker PTY に注入。
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
  record 形は `Escalation`(`types.ts:2091-2127`)。
- **不変条件 1(fail-closed)**: `open` を自動で動かす経路はゼロ。owner の answer/dismiss だけ
  (`swarmEscalations.ts:13-15`)。retention も open は永遠に触らない(`:762`)。
- **receiptKey 冪等**: 同 projectPath + 同 receiptKey の **open** が居る間、再 raise は既存
  record を返す no-op(`:354-371`)。dedup ヒット時は worker 座標(terminalId/branch)だけ
  live 側に更新(`:362-370`)。**resolved(answered/dismissed)には効かない** — 同じ
  receiptKey でも新しい row が立ち得る(`:352-353` コメント。かつて §4.1 増殖の半分だったが、
  S3/S10 に限っては raise 側が §3.6 の永続受領判定で resolved も含めて照合するため塞がれた)。
  既定キーは `sha1(taskId|projectPath|正規化質問文)`(`defaultReceiptKey`、`:313-322`)。
- **answer の 3 段**(`answerEscalation`、`:665-723`): ① answered を先に永続化(crash-safe)
  → ② you-corpus へ Q→A 書き戻し(owner 回答のみ・best-effort、`:702-717`)→ ③ 配送
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

- **cap 50・recency のみ・期限なし**: append のたび createdAt 降順 sort → 先頭 50 だけ残す
  (`swarmNotifications.ts:61-72`)。古い fatal は新しい通知に**押し出されて消える**(それ以外の
  削除経路なし)。
- **書き手は `appendSwarmNotification` 一本**(single-flight chain、`:58-72`)。その呼び元は
  2 つだけ:
  - `createSwarmFatalNotification`(`:128-137`)— kind `swarm-fatal`。呼ぶのは
    ① engine の `deps.notify`(`swarmOrchestrator.ts:3916-3917`)経由 = **`fireFatalNotifications`
    がエンジン由来 fatal の唯一のチョークポイント**(`swarmOrchestrator.ts:5865-5867`)、
    ② Electron IPC ブリッジ(`registerIncomingNotifications`、`swarmNotifications.ts:206-221`
    — rollback/canary-failed、OS toast は Electron 側が出すので os:false)。
  - `createSwarmInfoNotification`(`:186-195`)— kind `swarm-info`。呼ぶのは escalation-open
    (`swarmEscalations.ts:431-439`)と overseer の S7/S9/S11(`swarmOverseer.ts:356`)。
- **`fireFatalNotifications` の 2 系統**(`swarmOrchestrator.ts:5887-5954`):
  - EDGE(`engine.pendingFatal` を drain、1 回きり)— 今日は `exec-timeout` のみ(`:5906-5909`)。
  - STATE(毎 pass 再導出、`engine.notified` で rising-edge dedup)— `rework-exhausted`
    (`:5916-5927`)と `all-workers-down`(`:5930-5943`)。条件が消えると notified から外れ、
    **本物の再発は再通知される**(`:5945-5953`)。
- fatal イベントの全種は `SwarmFatalEvent`(`types.ts:1959-1964`)、info は `SwarmInfoEvent`
  (`types.ts:1999-2003`)。GET は `/api/swarm/notifications`(owner gate、
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
   notification の `createdAt`(`TimedSwarmFatal` `:281-285`、キー組み立て `:909`, `:912`)。
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
  (`swarmOverseer.ts:965-1007`)。**[保留] カードは 30 分で必ず S5 の対象になる**。
- 発火は 1 カードにつき dwell 1 回(fp=`blocked:<since>`、`:988-990`)だが:
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
  TUI であること・メニュー非表示・同一 project UUID(`swarmEscalations.ts:484-502`)。
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

### 5.2 偽物(stale/増殖)の見分け方 — 裏取り 3 点セット

- **branch が実在するか**: `git -C <repo> branch -a | grep <branch>`。無ければ worker/worktree は
  既に掃除済み — escalation は過去の遺物。
- **branch が main に取り込まれていないか**: `git -C <repo> merge-base --is-ancestor <branch> origin/main`
  が真なら統合済み — その質問はもう意味を持たない可能性が高い。
- **taskId が Board に実在するか + 今どの列か**(§7.5)。done/消滅済みカードの escalation は閉じてよい。

### 5.3 answer するとき

- answer は (a) live worker に W16 注入される(worker はその回答を前提に再開)か、(b) worker が
  居なければ**次 dispatch の /order に 1 行で相乗り**する(Q600 字+A900 字に切り詰め、全文は
  record に残る — `swarmEscalations.ts:644-649`)。
- **owner の answer だけが you-corpus に学習される**(`:702-717`)— 適当に answer すると proxy-you
  がそれを学ぶ。判断でないもの(過去分の掃除)は answer でなく **dismiss**(何も注入せず何も
  学習しない、`:730-745`)。
- API は §7.6。answer=404/409/500 の意味: 404=id 不存在、409=dismissed に answer
  (`server/routes/swarm.ts:850-851`)。

## 6. 既知の穴(file:line 付き列挙 — 修正はしない)

1. ~~**S3/S10 再投函増殖**~~ → **`d8431c3`+`aa9cb8d` で解決済み**(カード `c944ea69` done)。
   当時の 4 因子(窓なし × ストア期限なし × seen in-memory × dismissed に冪等なし)と現在の
   対応は §4.1(歴史)と §3.6(現行機構)。ストア期限なし(`swarmNotifications.ts:30`)と
   seen in-memory(`swarmOverseer.ts:46-48`)自体は現存 — 窓+永続受領が読み手側で吸収する設計。
2. **S5 × [保留] 運用の衝突**(仕様間の衝突): blocked 列の保留レーン流用に対し S5 が 30 分で
   inbox 行き(`swarmOverseer.ts:965-1007`)。除外規約([保留] prefix skip 等)は未実装。§4.2。
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

前提: OPEN GROUND が :47776 で稼働、owner ログイン済み(全 /api/swarm/* は owner gate —
サーバ永続 session で判定するので同一マシンの curl は通る)。`<PATH>` は対象プロジェクトの
登録済み絶対パス。

### 7.1 overseer の現在状態(armed か・engine が running か)

```bash
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq '{running, overseer, autoMerge, selfSupply, anomalies: (.anomalies | length)}'
```

### 7.2 受信箱 — open だけ / 全件の status 内訳

```bash
# open だけ(司令塔が対応すべき現物)
curl -s "http://127.0.0.1:47776/api/swarm/escalations?status=open" | jq '.escalations | map({id, createdAt, whyEscalated, question: .question[:80]})'
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
