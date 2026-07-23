# ENGINE_PERSISTENCE_PLAN — 再起動を無イベント化する(swarm エンジンの永続化)

**起票**: 2026-07-22(会話設計 → 本書)。**基準コミット**: `87b6043`。
**読者**: 司令官(og-manage)・補給官(起票)・実装 worker。
**この文書の役割**: 「エンジンの認知は in-memory・再起動で全消え・自動運転は OFF に戻る」という
現行構造(00-INDEX §2.1)を、**crash-only 設計**(いつ殺されても、ディスクから認知を再構築して
続行できる)へ置き換える設計の正典。§6 のカード 5 枚が実装単位。

---

## 0. 解く問題(現状の実測)

| 事実 | 現物 |
|---|---|
| エンジン状態は globalThis の in-memory。「boot 毎に fork される前提」とコメントに明記 | `swarmOrchestrator.ts:327`、`:1742-1743` |
| 再起動で roster / reviews / running / selfSupply / overseer が全消え。自動運転は必ず OFF | 00-INDEX §2.1(設計意図として「安全側」) |
| 永続される engine 状態は `manualStopPersisted` の **1 個だけ** | `swarmOrchestrator.ts:2206, :2238-2249` |
| Electron は server の予期せぬ死に **fatal dialog → app.exit(1)**。respawn しない | `electron/main.js:789-824` |
| worker は spawn 時に `--session-id` 用 UUID を**既に持つが、捨てている**(未永続) | `swarmWorker.ts:627` |
| 司令官/補給官には完成した resume 機構がある(証明してから `--resume`・fail-open) | `swarmSessions.ts`(05 章 §10) |
| journal は 200 行 ring + 再起動で全消え —「無い」が無実を証明しない | 00-INDEX §4、`swarmOrchestrator.ts:201` |

結果: **再起動(=たいていリリース)のたびに** ①自動運転が黙って止まる ②worker の PTY が死んで
文脈(数十分ぶんの会話)が捨てられる ③journal が消えて事後診断が不能になる。司令官の resume 注入
(`MANAGER_RESUME_INJECTION`)が「口を開く前に読み直せ」と命じているのは、この構造欠陥の運用側
での穴埋めである。

---

## 1. アーキテクチャ判断 — プロセス分離は**しない**(理由つき)

検討した 2 案:

- **案 A(採用): crash-only 化。** エンジンは今のまま Hono プロセス内。ただし①意図と roster を
  write-through でディスクへ ②boot に「照合→再開」プロトコル ③Electron main を respawn する
  スーパーバイザに昇格。
- **案 B(棄却): エンジンを別プロセスへ分離。** 棄却理由は 1 つで足りる — **PTY は server プロセスの
  子**であり(node-pty プール、`detached:false` の fork 系列)、server が死ねば worker の claude は
  どのみち死ぬ。頭脳だけ分離しても守りたいもの(実行中の worker)は守れず、守るには terminal.ts
  ごとの移設(SSE 中継・guard env・owner-desk スクレイプ全部)が要る — 本リポで最も危険な改修。
  さらに自己更新の cutover 機構(canary fork・bootId 同一性)が「server は 1 プロセス」を前提に
  組まれており、分離はそれも壊す。

**方針: 「プロセスを生かし続ける」のではなく「いつ死んでも数秒で何事もなかったことにする」。**
one origin(:47776)・単一プロセス・subscription-only は全部不変。

---

## 2. 方針転換の明示 —「再起動で自動運転 OFF」を撤廃する

これは意図された安全設計(00-INDEX §2.1)の**明示的な撤回**なので、根拠を書き残す:

1. **旧根拠は 2026-07-15 に大部分死んだ。** マネージャ専任化で engine は main を FF する経路を
   構造的に失った(回帰テストでピン)。自動再開の最悪ケースは「悪い配車・トークン浪費・通知の
   ノイズ」であり、**main の破壊ではない**。OFF-on-restart が守っていた最大の被害半径は既に別の
   機構(統合の司令官専任)が塞いでいる。
2. **ユーザー意図の supremacy は既にある。** `manualStop` は永続済みで、再開判定は
   `desiredRunning && !manualStop` — 意図的に止めたエンジンが勝手に起きることはない。
3. **新コードの無人自走リスクは breaker で受ける。** 再起動≈リリースなので、自動再開は
   「更新直後の新コードが無人で走り出す」ことを意味する。→ §4 の crash-loop breaker
   (10 分窓に 3 回で再開抑止 + fatal 通知)と、照合完了まで spawn 凍結(§4-3)で受ける。

**[hold] 論点は決着(2026-07-22, card 2 レビュー — オーナー追認済み)。selfSupply と overseer は
非対称に扱う** — 当初この節は「3 トグルとも永続が一貫する」としていたが、**これは見落としだった**
(著者自身が認めた誤り: 一次資料を取り込む前に 00-INDEX §2 の図だけから外挿して書いた。03 章 §5
「一次資料を取り込んでから判断」規約に違反していた。加えて著者はオーナーへの口頭説明でも
「復元しても通知が来るだけ」と誤って伝えており、当初の「ON は ON」というオーナー決定はこの
誤前提の上でなされたものだった)。

- **selfSupply は永続・resume で復元する。** 出力は per-card の `selfSupplyApproved` ゲートで
  不活性化されているので、提案カードが積まれるだけで dispatch はされない — リスクは低い。
- **overseer は値を `engine.json` に書くが、boot では読み戻さない**(既に card 2 の実装どおり —
  この節が「一貫する」としていた側が誤りで、実装ではなくこの文書が直された)。理由は 3 点:
  1. §2-1 の「自動再開の最悪ケースは main の破壊ではない」は **engine (drain) には正しいが
     overseer には転用できない**。overseer の外向き作用は「読み+通知」の 1 種類ではなく 4 種類
     ある — ①大脳(claude PTY)の起動(swarmOverseer.ts:340-356・日次最大 24 回・manager 級 tier
     = 実トークン消費)②稼働中 worker の PTY への文字列注入(:359, :661)③janitor の
     `git branch -d` / 心拍ファイル unlink(:385, :620-622)④escalation + 通知(:357, :360 —
     これだけが「読み+通知」)。①〜③は resume が万一誤爆すれば実害を伴う。
  2. crash-loop breaker(§4-2)は「10 分に 3 回のクラッシュ」しか数えない —
     「新ビルドは正常に起動し、大脳が新しい壊れ方をする」ケースを 1 回も検知できない。
     §4-3c の spawn 凍結窓にも overseer 相当の凍結は無い。
  3. 再起動は OVERSEER_DESIGN.md の **L9-③(「L9 kill switch」表の行 — 行番号は同ファイル内の
     編集で動くので表の名前で引くこと)= 独立した kill switch の 1 層** — オーナーが UI に
     到達できない状況でも overseer を確実に止められる唯一の手段で、engine の drain とは
     異なり代替の安全層が無い。
  代わりに **1 クリック復帰バナー**(値が `true` のまま復元されなかったことを見せ、ワンクリックで
  再武装できる UI)を別カード(card 2b)で用意する — 「値は覚えているのに毎回手で押させる」の
  UX コストは、boot での自動 arm を許すよりずっと小さい。
  ※ 「S3/S10 の再投函は永続受領で根治済み」(swarmOverseer.ts:934-1000 + e2e pin)は**事実として
  正しく**、この文書の記述として残す。ただしこれは「**再起動後に escalation が増殖しない**」の
  証明であって、「**再起動時に overseer を arm してよい**」の証明ではない — 混同しないこと。

---

## 3. 状態の棚卸し — 永続するもの / 導出するもの

**原則: 導出できるものは永続しない**(crash-only の肝。二重管理は必ず乖離する)。

| 状態 | 現在 | 今後 | 置き場 |
|---|---|---|---|
| engine running | in-memory(再起動で OFF) | **`desiredRunning` を永続** | `~/.openground/projects/<uuid>/engine.json`(新設) |
| manualStop | Settings に永続済み | 不変(supremacy 維持) | Settings |
| selfSupply | in-memory(OFF に戻る) | **永続・resume で復元**(§2 で確定) | engine.json |
| overseer | in-memory(OFF に戻る) | **値は永続するが boot では読み戻さない**(§2 で確定・非対称) | engine.json |
| worker roster(branch / taskId / worktree / **sessionId** / tier / spawnAt / **workedMs 会計** / reworkCount) | in-memory | **write-through** | `~/.openground/swarm/<repoキー>/roster.json`(新設・心拍の隣・エンジン所有) |
| reviews[](A相 classify) | in-memory | **導出**(初回 integrate pass で再計算) | — |
| journal | 200 行 ring・揮発 | ring は API 用に不変。**JSONL へ append-through** + rotation | `~/.openground/projects/<uuid>/engine-journal.jsonl`(新設) |
| quota 冷却(層A)/ mask(層C) | 永続済み | 不変 | swarm-quota.json / Settings |
| stall クロック / limitScreen / inFlight flag | in-memory | **揮発のまま**(正しい — 再導出可能) | — |
| manager nudge 予算(3 回上限) | in-memory | v2 送り(最悪 = 余分な nudge。phase 1 は許容) | — |
| escalation dedup | 永続受領済み | 不変 | escalations.json |

- roster の `sessionId` は **swarm-sessions.json には入れない**。あのファイルの契約は「役割 2 卓
  (supply/manager)の生涯会話」で、worker の「1 ゴール 1 セッション」思想(swarmSessions.ts 冒頭)
  と衝突しない置き方が正しい: **worker の resume はゴールを跨がない**(同一ゴールの会話が
  プロセス再起動を生き延びるだけ)。sessionId の寿命 = roster エントリの寿命 = worker teardown で消す。
- `workedMs` の永続で、実作業時間会計(02 章 §5.5 — quota 待ち/統合待ち控除)が再起動を跨いで
  正しく続く。再起動が runaway クロックをリセットして worker に無限時間を与える穴も同時に塞がる。
- 置き場は全て既存 seam(projectDataFile / swarm dir ヘルパ)経由で導出 → **testHomeGuard fence の
  傘下に自動で入る**(07 章の契約)。fence を通らない生パス構築は書かない。
- 書き込み規律: 全部 `atomicWriteJson`。書き込み失敗は journal warn + 続行(**fail-open** — 壊れた
  ディスクが健全なエンジンを止めてはならない。プロセス内の真実は in-memory のまま)。読み込み失敗は
  そのプロジェクトだけ再開しない + 通知(**fail-quiet-to-OFF** — server boot は絶対に殺さない)。

---

## 4. boot 再開プロトコル(resumeEngines)

server boot(installHooks 等の既存処理の後)で:

1. **列挙**: registry の全プロジェクトの engine.json を読み、`desiredRunning && !manualStopPersisted`
   の集合を得る。無ければ何もしない(現行と同一)。
2. **crash-loop breaker**: `~/.openground/engine-boots.json` に {at, appVersion} を追記(ring 10 件)。
   **同一 version で 10 分窓に 3 回以上** → 再開を抑止し、fatal 通知 `engine-resume-suppressed` +
   journal 1 行。version が変わったら窓リセット(自己更新 cutover の連続再起動を誤検知しない)。
   card 5 以降は Electron が `OPENGROUND_BOOT_KIND=crash-respawn|normal` を env で渡し、breaker の
   信号を精緻化する(phase 1 は時刻窓のみで可)。
3. **照合が先・spawn は凍結**(reconcile-first): プロジェクトごとに
   a. Board(loopback HTTP — 裏口なしの掟のまま)・roster.json・心拍・git(branch/worktree 実在)を読む。
   b. roster エントリを分類:
      - **worktree 消滅** → エントリ破棄。カードは既存 reclaim 規約どおり。
      - **branch ahead + 心拍 ready** → ready 扱い。既存の manager-wake 反射が拾う。
      - **作業途中 + worktree 生存** → **resume 候補**(§5)。
      - **カード消滅/移動**(停止中に人が動かした) → 既存 monitor の card-vanished 規約を再利用。
   c. resume 候補の処理が終わるまで新規 dispatch を凍結。
4. **開始**: 凍結解除 → `startOrchestrator()`(通常 tick 開始)。journal に
   `engine resumed (vX→vY, workers: R resumed / K reclaimed / D dropped)` + ベル通知 1 件
   (再起動を跨いだ事実をオーナーが必ず視認できる)。

---

## 5. worker 会話 resume(最大の UX 差分)

worker は spawn 時に session UUID を持っている(`swarmWorker.ts:627`)。roster に永続すれば、
boot 時に**同じ worktree で `claude --resume <sessionId>`** でき、数十分ぶんの文脈が戻る。

- **証明してから resume(swarmSessions の哲学を共有ヘルパ化)**: transcript JSONL が
  **worktree cwd 配下の claude project dir に**実在・非空・parse 可能・live PTY が握っていない、
  を確認してから `--resume`。証明できなければ **fallback = 既存 crash reclaim**
  (WIP 保全 → 差し戻し規約)— worker は常に「最悪でも今日と同じ」に落ちる。fail-open。
- **orphan 検査(SIGKILL の縁)**: server が SIGKILL された場合、PTY の子 claude が**孤児として
  生き残り**同じ JSONL に書き続けることがあり得る。transcript の **mtime が直近 N 秒以内なら
  「誰かがまだ書いている」— この boot では resume せず**外部 worker として registry 表示に任せる
  (interleave 破壊は swarmSessions が守っている当のハザード)。
- **WORKER_RESUME_INJECTION(新設・SUPPLY_RESUME_INJECTION の妹)**: 「アプリ再起動で端末は
  死んだが会話は復元された。worktree はそのまま。/order のゴールと Board の現状を読み直し、
  心拍を打ち直してから続行。完了条件は変わっていない」。
- spawn 時の前提ゲートは全部通す: claudeRunPreflight / ensureGuardWiring / guard env — 新しい
  抜け道を作らない。

---

## 6. スーパーバイザ(Electron main)

現状: 予期せぬ server 死 → fatal dialog + app.exit(1)(`main.js:818-822`)。変更:

- 予期せぬ死(`!isQuitting && !isSwitching`)→ 既存の子プロセス reap はそのまま実行した上で、
  **backoff respawn(2s/4s/8s・10 分窓 3 回まで)**。renderer は既存の health 待ちを再利用して
  「再起動中」を表示。
- respawn 時は `OPENGROUND_BOOT_KIND=crash-respawn` を fork env に付与(§4-2 の breaker が
  「本物のクラッシュ再開」を数えられるように)。
- **窓を使い切ったら現行どおり fatal dialog + app.exit(1)** — 無限 respawn はしない。
- server 側 §4 の breaker と二重になるのは意図(Electron = プロセスを戻す係、server = エンジンを
  再開してよいか判断する係。関心が違う)。

---

## 7. 実装カード(5 枚・依存順)

> 並列: card 1‖5 は独立で同時配車可。card 2 → 3 → 4 は直列。
> **全カード共通の完了条件**: `npx tsc --noEmit` / `npm test` / `npm run lint` 緑。
> SWARM_CODE_PATHS に触れるため **docs/commander/ 該当章の同一ブランチ更新**(§8 の対応表)、
> 不要ならその明示判断を notes に残す。

### card 1 — [swarm] engine journal の append-through 永続化(独立・最小)
ring(200 行・API 契約)は不変のまま、`log()` に JSONL append を追加。
`~/.openground/projects/<uuid>/engine-journal.jsonl`、5MB で rotation(`.1` を 1 世代)。
完了条件: ①再起動後に直前の journal 行がファイルから読める ②rotation 実測 ③追記失敗はエンジンを
止めない(fail-open のテスト)④00-INDEX §4「journal は無を証明しない」に「ring は揮発のまま・
JSONL は残る」を追記。

### card 2 — [swarm] engine 意図の永続化 + boot 自動再開(dispatch のみ)+ crash-loop breaker(本丸)
engine.json(desiredRunning / selfSupply / overseer)、`resumeEngines()`、engine-boots.json breaker、
`engine-resume-suppressed` fatal 通知、再開時のベル通知。**この段階では orphan worker は既存
reclaim に任せる**(roster はまだ無い)。
完了条件(隔離 HOME での integration test): ①desiredRunning=true で再起動 → 人手ゼロで dispatch 再開
②manualStop が勝つ(変異テスト: supremacy 判定を外すと赤)③同一 version 3 boot/10 分 → 再開せず
fatal(変異テスト: breaker を殺すと赤)④version 跨ぎは窓リセット ⑤engine.json 破損 → その
プロジェクトだけ OFF + 通知、server は起きる。

### card 3 — [swarm] worker roster の write-through + boot 照合(reconcile-first)
roster.json(sessionId / taskId / branch / worktree / tier / spawnAt / workedMs / reworkCount)。
書き込みは状態遷移点のみ(spawn / promote / reclaim / rework / teardown — tick 毎ではない)。
boot の分類マトリクス(§4-3b)と spawn 凍結窓。workedMs 永続で実作業時間会計が再起動を跨ぐ。
完了条件: ①分類 4 分岐(消滅/ready/途中/カード消滅)が fixture で各々観測可能 ②照合完了前に
dispatch が走らない(変異テスト: 凍結を外すと赤)③teardown が roster エントリを消す ④roster 破損 =
全 worker を「外部 worker」扱いに degrade(何も壊さない)。

### card 4 — [swarm] worker 会話 resume(--resume respawn)
transcript-proof を swarmSessions.ts から共有ヘルパへ抽出(重複実装しない)、resume 候補の
respawn、WORKER_RESUME_INJECTION、orphan mtime 検査、fallback = crash reclaim。
完了条件: ①証明成立 fixture で `--resume` 引数の spawn が観測される ②JSONL 欠損/空/直近 mtime の
3 fixture がそれぞれ fallback へ落ちる ③preflight / guard wiring ゲートを通っている(変異テスト:
ゲートを外すと赤)④05 章 §10 の「workers deliberately absent」注記を本設計の境界(ゴールを
跨がない resume)で更新。

### card 5 — [electron] server crash respawn(スーパーバイザ)(独立)
backoff respawn + 窓 + BOOT_KIND env + 窓超過で現行 fatal。既存の reap(self-update 子)は
respawn 前に必ず実行。
完了条件: ①server を kill → ウィンドウが死なず数秒で復帰(手動実測で可)②10 分窓 3 回超で
現行 fatal dialog ③isSwitching(自己更新 cutover)中の意図的停止では respawn しない。

---

## 8. docs/commander 追随の対応表(各カードの完了条件に含める)

| 変更 | 追随先 |
|---|---|
| 「再起動で自動運転 OFF」の撤廃 | 00-INDEX §2.1 非対称表(desiredRunning 復元・breaker 条項へ書き換え)、01 章 in-memory 寿命の節 |
| journal JSONL | 00-INDEX §4「journal に無い = 起きていない、ではない」の緩和条件 |
| worker resume | 05 章 §10(workers absent 注記の更新)、02 章 worker 生涯(resume 分岐の追加) |
| **resume 注入文の改稿** | `MANAGER_RESUME_INJECTION` / `SUPPLY_RESUME_INJECTION` の本文 — 現行は「エンジンの認知は消えている」前提。card 2 以降は嘘になる。「エンジンも復元済み。ただし真実は Board(戒 2 不変)」へ |
| TARGET-STATE | §5 判定サマリ・§7 チェックリストに「再起動無イベント化」の観測可能条件を追加 |

---

## 9. やらないこと(スコープ外の明示)

- エンジンのプロセス分離・常駐デーモン化(§1 で棄却)。
- reviews[] の永続化(導出で足りる)。
- quota スクレイプの API 化(別問題 — 本設計は検知系に触れない)。
- owner gate / experiment gate の変更(公開範囲は不変)。
- dev(`tsx watch`)のクラッシュ respawn(dev は落ちて気づくのが正しい)。
