# OVERSEER_DESIGN — 監督ノードのアーキ設計（C0 スパイク）

> **Status: 設計ドキュメント（spike 成果物・未実装）。** カード C0
> `99318005`（[SPIKE][Phase2]）の成果物。このドキュメントのレビュー通過が
> C1 / C2 / C3 / C4 実装の前提ゲート。ここに書いてあるものは**まだ何も
> 実装されていない** — 既存部品の記述（§4, §7, 付録）だけが現行コードの事実。
>
> v2（2026-07-02）: 8 並列 read-only 監査でコード裏取り → 初稿 → 5 レンズ
> 敵対レビュー（35 findings・must-fix 12）を反映済み。主要修正: T2 承認ゲート
> 共用化 / 大脳 fire-and-forget 化 / 大脳起動仕様（scratch cwd・strictMcpConfig・
> corpus パス Read）/ usage 観測の実コスト訂正 / autonomy OFF での enabled
> クリア / §10 着手順と Done 所有者の全面改訂。
>
> 前提ドキュメント: `project-autonomous-overseer-design`（auto-memory・構想と
> 絶対制約）/ `docs/YOU_CORPUS_PLAN.md`（B1・記憶）/
> `docs/SANDBOX_EXPERIMENT.md`（A1・封じ込め）/
> `docs/SWARM_SAFETY_INVARIANTS.md`（安全網 A–D）。
>
> 行番号は 2026-07-02（0.11.17, commit 0cb5c0a）時点。実装時は再確認すること。

---

## 1. 目的と非目標

### 目的

OG の in-app swarm（swarmOrchestrator）を「ユーザーが司令塔を手動監督する」から
「**ユーザーの proxy が自律的に監督する**」へ進める。proxy の席は manager では
なく、その上 — ユーザーが今座っている空席。新設するのは**監督ノード**＝

- 全体を**周期監視**し（脳幹・LLM を呼ばない）、
- 判断が要る**エッジでだけ Claude を起こし**（大脳・episodic）、
- worker / manager の自由文質問に**「あなたとして」回答し**（記憶=you-corpus）、
- 魂レベル・不可逆だけ**本物のユーザーへエスカレーション**する（受信箱）。

### 非目標（このスパイクと EPIC C の範囲外）

- **常駐する賢い LLM は作らない。** 連続稼働の Claude は idle 燃焼+ドリフトで
  最悪（構想メモの確定結論）。生きている層は脳幹だけ。
- **マシン横断・複数プロジェクト俯瞰の司令部は作らない。** 監督は per-project
  engine の拡張ステージとして始める（§5 D1）。全体最適は Phase3 以降。
- **tmux 版 swarm（swarm-*.sh 群）の置き換えはしない。** in-app engine に載せる。
  tmux 側は先行実装・設計テンプレとして参照するだけ。
- **API key 実行は永久に非目標**（subscription-only は不変）。

---

## 2. 絶対制約（設計の外側から与えられている前提）

ユーザー確定（2026-07-01）＋既存安全網からの制約。**この節に反する設計変更は
レビューで却下する**:

| # | 制約 | 根拠・実装上の意味 |
|---|---|---|
| K1 | 監督ノードは **Swarm Autonomy の明示 ON に相乗り**して立ち上がる。独自の常駐・自動起動経路を一切新設しない。**auto-drain（`maybeAutoStartDrain`）による自動再点火は監督を起こさない** | 0.11.12 の auto-drain 既定 ON 事故の再来防止。`bootAutoDrainEnabled`（env `OPENGROUND_SWARM_AUTODRAIN==='1'` 厳格 opt-in・既定 OFF）の規律を継承。§5 D1 が実装形 |
| K2 | **再起動で必ず OFF**。engine と同じく in-memory 状態のみ・auto-resume 禁止。`Settings.swarmAutonomyOn` はリマインダー専用 | swarmOrchestrator.ts:1284（globalThis in-memory）/ store.ts:168-195 と同型 |
| K3 | **多層防御 owner-gate**: 監督の全エンドポイント・spawn 点は `getCustomTabRole() !== 'owner' → 403`（ハンドラ第1文・body parse より前）。role 既定 'none' の fail-closed | 不変条件 C。`/api/swarm/*` 配下に mount すれば `swarmSafety.routes.test.ts` の route-table sweep が自動で回帰テスト化する |
| K4 | **subscription-only**: 大脳は `launchClaude`（ユーザーの claude CLI・対話 PTY）のみ。`claude -p` / SDK / API key 禁止 | swarmSupply.ts:31 ほか全ロールと同じ |
| K5 | フローは**一方向**: 監督→supply(整形)→manager(振分/統合)→worker(実装)→manager→監督(観測)。manager が supply に発注する逆流を作らない | §7.2 参照。in-app では supply=Board 起票、manager=engine の dispatch/integrate パス |
| K6 | **エスカレーション弁は confidence でなく可逆性で切る**（不可逆＝課金/公開/送金/削除/本番デプロイは自信があっても本人へ）。不明は不可逆に倒す（fail-closed） | C4 の存在理由。you-corpus.md 冒頭の proxy 指示（youCorpus.ts:353-358）が既に同文言 |
| K7 | proxy は**情報不足を事前申告**する（calibrated abstention・confabulate 禁止） | C2 の受け入れ条件 |
| K8 | **GET / read 経路に mutation を載せない** | auto-drain 差し戻し MUST_FIX の掟（getOrchestratorState は PURE、テストで固定） |
| K9 | **不変条件 A–D**（force-push なし / central 外削除なし / owner-gate / conflict abort）と品質フロア（tsc→lint→swarm-safety→test のマージゲート）は監督のコード自身にも適用される | SWARM_SAFETY_INVARIANTS.md。§7.3 D3 の命名決定に直結 |

---

## 3. 3層モデル — 脳幹 / 大脳 / 記憶

```
                    ┌─────────────────────────────────────────┐
                    │  本物のユーザー（コウキ）                   │
                    │  OS通知/ベル ← 受信箱(C1) → 回答            │
                    └───────────────▲─────────────────────────┘
                          T3 不可逆・情報不足だけ上がる
┌───────────────────────────────────┴─────────────────────────────┐
│ 監督ノード（per-project・engine 相乗り）                            │
│                                                                  │
│  ┌───────────── 記憶（=自己） ─────────────┐                       │
│  │ you-corpus.md (B1, 出荷済み)             │ パスを渡して Read     │
│  │ ← appendJudgment() で owner の回答だけ   │ （プロンプト注入の     │
│  │   書き戻す（自動回答は書き戻さない）        │  消費者は大脳が最初）  │
│  └──────────────────────▲──────────────────┘                     │
│                          │                                        │
│  ┌── 大脳（episodic Claude・常駐しない） ───┴───────────────────┐  │
│  │ one-off PTY（マーカー scrape・タイムアウト・finally kill）。   │  │
│  │ fire-and-forget: tick は絶対に待たない（§5 D2）。            │  │
│  │ 用途: ①proxy-you 回答(C2) ②状況アセスメント ③supply 文起草   │  │
│  └───────────────────────▲──────────────────────────────────┘  │
│                           │ エッジ（rising edge のみ・dedup 済み）  │
│  ┌── 脳幹（LLM ゼロ・安い周期パス） ────────┴───────────────────┐  │
│  │ runOverseerPass — engine tick 相乗り（runSelfSupplyPass 同型）│  │
│  │ 読むだけ: tick 取得済み tasks / 心拍 / anomalies / log / KPI │  │
│  │ （usage はサブ周期・キャッシュ同期読みのみ）                    │  │
│  │ 閾値表(§6)で分類 → T0 は既存機構に任せる / T1-T3 だけ動く     │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

- **脳幹** — LLM を一切呼ばない純ロジックの周期パス。engine の 3 秒 tick に
  相乗りし（駆動を新設しない）、観測面（§4）を読み、閾値表（§6）で
  「何もしない / 大脳を起こす / supply に投入 / 本人に上げる」を分類するだけ。
  機械的介入（nudge / reclaim / requeue / 掃除）は**既存 engine が既に全部
  持っている**ので脳幹は再実装しない（§7.1）。
- **大脳** — episodic な claude 起動。1 判断 = 1 使い捨て PTY。**起動仕様は
  §5 D4 に固定**（scratch cwd・strictMcpConfig・corpus パス Read・
  fire-and-forget）。
- **記憶** — `~/.openground/you-corpus.md`（B1 出荷済み）。大脳の全回答の根拠。
  エスカレーションの Q→A は `appendJudgment()` で書き戻す＝proxy-you の訓練
  パイプライン（誤り＝故障ではなく「情報が足りない」、だから投資先は記憶）。
  **書き戻すのは owner が実際に回答した Q→A のみ** — 大脳の自動回答を
  書き戻すと誤学習が一方向に固定されるため禁止。

---

## 4. 監視対象カタログ — 脳幹は何を・どこから・どの周期で読むか

すべて**既存の観測面**。新しいセンサーは作らない。

| # | 信号 | ソース（実名） | 読み方 | 鮮度/周期 |
|---|---|---|---|---|
| M1 | worker 心拍 | `~/.openground/swarm/<repoKey>/<branch>.json`（swarm-beat.sh が書く 7 フィールド。`blockers` を含む） | `defaultReadHeartbeat`:1842 / `swarmRepoKey`:1819（式は shell `sw_repokey` と lockstep） | worker がフェーズ境界で上書き。**読み取り専用厳守**（mtime を汚すと staleness 判定が壊れる）。engine が tick 毎に読了済み — 監督は probe 結果を共有する（下記 M2 注記） |
| M2 | worker 実勢 | engine 公開面 `OrchestratorWorker`（types.ts:973 — stage / phase / note / heartbeatAt / reworkAt。**lastOutputAt / commitsAhead / blockers は公開面に無い** — monitor pass 内の probe で毎回計算・破棄される） | `getOrchestratorState(path)`:5281 の workers（PURE read）。**S4 の blockers 検知の実源泉は M1**（公開面に無いため） | engine tick 3s で更新済みの値を読む |
| M3 | Board | `~/.openground/projects/<uuid>/tasks.json` | **runOverseerPass は runEnginePass が当該 tick で取得済みの tasks スナップショットを引数で受け取る**（`fireFatalNotifications` に pass 取得済み tasks を渡す既存前例と同じ）。**自前で fetch / readProjectData しない** — engine は既に毎 tick Board を読んでおり、3 本目の全読みを足さない | 毎 tick（追加コスト 0） |
| M4 | engine 異常 | `engine.anomalies`（worktree-missing / worker-stale / orphan-doing / move-stuck / rework-exhausted） | 同一 pass 内なので engine 直読（`detectAnomalies`:4546 が毎 tick 計算済み） | ゼロコスト |
| M5 | engine ログ/KPI | `engine.log`（ring 200・kind: dispatch/promote/integrate/conflict/crash/stall/routine/cleanup）+ `kpis` + `consumption`（DISPATCH_BUDGET=50 の overLimit） | 同上 | 同上。**ログ文言は KPI の分類キー（load-bearing）— 監督が文言を生成し直さない** |
| M6 | fatal 通知 | `~/.openground/swarm-notifications.json`（5 種: rework-exhausted / all-workers-down / exec-timeout / rollback / canary-failed・cap 50） | エッジ源としては engine 内の `pendingFatal` / `notified`（rising-edge dedup 済み）を pass 内で共有 | イベント駆動 |
| M7 | git 統合可否 | branch vs trunk | `classifyBranch`:188（無変異 read）— engine が integrate パスで既に読み `engine.reviews` に置く。監督は reviews を読むだけ | integrate tick 15s |
| M8 | 使用量 | `fetchClaudeUsageCli` の**キャッシュ済み値のみ**（cap 相対 %） | **サブ周期**（`OVERSEER_USAGE_POLL_MS=60s`・`lastUsageAt` を Runtime に保持）。**in-pass では同期のキャッシュ読みだけ行い、ミス/失効時は判定をスキップして detached でリフレッシュを 1 本流す**（await しない）。失敗（scrape-failed）は指数バックオフ（`usageBackoffUntil`、上限 15min）。閾値は `usageLevel()`（usageThresholds.ts・80/100 の単一正典・**% のみ食わせる**）。`collectClaudeUsage`（JSONL 全 walk・毎回 ~30MB read）は監督の経路に**入れない** | 60s サブ周期。⚠️ 実コスト注意: swarm 稼働中は worker が JSONL を書き続けるため activity-watcher がキャッシュを 30s デバウンスで常時失効させる（claudeUsageCli.ts:100-121）— つまり**稼働中こそキャッシュミスが常態**。だからこそ in-pass await 禁止・detached 化・バックオフが必須 |
| M9 | engine 生存/同一性 | `GET /api/health`（bootId / startedAt / version） | 監督は in-process なので不要（bootId 変化＝自分も消えている）。参照系譜として記載のみ | — |
| M10 | selfUpdate 結果 | **現状 API 非公開**（Electron main のメモリ + トースト + in-app 通知のみ）。rollback / canary-failed は M6 に届く | Phase2 は M6 経由で足りる（→ §11 Q6） | イベント駆動 |
| M11 | 受信箱滞留 | `~/.openground/escalations.json`（**C1 で新設**・§8） | mtime 変化検知 + 低頻度サブ周期（60s・usage と同じ lastXxxAt 方式）。毎 tick の全読みはしない | 60s |

**読まないもの**: worker PTY の生テキスト常時パース（C3 の質問検出だけが例外で、
それも既存 `classifyOutput`:1072（パターン定数 RATE_LIMIT_PATTERNS:1039）の
分類器拡張として実装する）、Claude JSONL transcript（generateDescription 専用
seam のまま）、`collectClaudeUsage`（上記 M8）。

---

## 5. 監督ノードの状態機械

### 設計決定 D1–D4

- **D1（実装位置とトグル）: 監督は `ProjectEngine` の第3のアーム付きステージ**
  （`engine.overseer: OverseerRuntime`）。`autoMerge` / `selfSupply` と同じ
  owner-gated POST（`POST /api/swarm/orchestrator/overseer {path, enabled}` —
  `/automerge`:400・`/selfsupply`:447 と同型）で ON・**既定 OFF・in-memory
  （再起動で必ず OFF・K2）**。ただし enabled の生存は autoMerge より**安全側に
  非対称**:
  - **`stopOrchestrator`（autonomy 明示 OFF）は `overseer.enabled = false` に
    落とす**（autoMerge/selfSupply は温存されるが、監督は最危険ステージなので
    opt-in を残留させない）。autonomy を再 ON しても監督は OFF のまま —
    毎回明示的に点け直す。
  - **auto-drain（`maybeAutoStartDrain`）が engine を再点火しても監督は
    起きない**: enabled は owner POST でのみ true になり、上記 2 経路
    （明示 OFF・再起動）で必ず false に落ちているため。K1 の「明示 ON にだけ
    相乗り」がこの 2 つの規則で構造化される。
  - 再起動後の autonomyRemembered バナーから resume した場合も監督は OFF
    （リマインダーは autonomy のみ・監督にリマインダーは作らない）。この
    非対称は UI のトグル表示で可視化する（C-core）。
  - dismiss 罠（`toggleAutonomy(false)` の no-op 問題）は監督には発生しない:
    監督は engine 外の永続マーカーを持たず、enabled は engine 内 field のみ
    だから（バナー→専用 action が要る構造がそもそも無い）。
- **D2（駆動）: 脳幹 tick = `runOverseerPass(engine, tasks, deps, now)` を
  `runEnginePass`:4825 の末尾（`runSelfSupplyPass` の隣）に追加。**
  - 第2 driver を作らないので passInFlight の掟に抵触しない。全体 try/catch・
    never throw（selfSupply と同じ契約）。
  - `tasks` は pass が取得済みのスナップショットを受け取る（M3）。
  - **大脳は fire-and-forget**: runOverseerPass は大脳 PTY を**絶対に await
    しない**（await すると T1 判断 1 回で 3 秒 tick チェーン全体が最大 5 分
    凍結し、dispatch / stall-nudge / runaway 検知が止まる）。detached promise
    は必ず `.catch` で捕捉（unhandled rejection 禁止）、`assessInFlight` を
    try/finally で握り、**結果は in-memory mailbox（`OverseerRuntime.
    brainResults`）に置いて次 tick の脳幹が T0'/T2/T3 へ振り分ける**。
  - 観測は毎 tick（取得済みデータの再利用でコスト 0）、**I/O を伴う観測
    （usage / escalations）はサブ周期**（M8/M11 の lastXxxAt 方式）。
- **D3（命名）: 監督のサーバコードは `src/lib/server/swarmOverseer.ts` /
  `swarmEscalations.ts` / `swarmReversibility.ts` — swarm glob
  （`src/lib/server/swarm*.ts`・SWARM_CODE_PATHS swarmOrchestrator.ts:2123）に
  意図的に入れる。** 監督コードを触る branch は安全網スイートが毎統合必ず走り
  （K9）、安全ファイル削除の tamper guard も受ける。
- **D4（大脳の起動仕様）**: one-off claude PTY。写経元は `defaultRunReviewer`
  :2963（マーカー scrape・echo-safe・poll・finally kill）だが、以下を**上書き
  固定**する:
  - **cwd = 空のスクラッチ dir**（central data dir 配下・毎回作成/撤去）。
    実作業ツリーでも worker worktree でもない — 判断材料（corpus パス・カード・
    ログ抜粋）は全てプロンプトで渡すので repo アクセス自体が不要。bypass 権限
    の claude をユーザーの実ツリーで起動しない（「読む・起票する・上げる
    しかできない」§9 の構造的裏付け）。
  - **`strictMcpConfig: true` 必須**（claudeTerminal.ts:73-82 の契約: 非
    sandbox 自動起動ユーティリティは TRUE 必須 — ~/.claude.json に永続化された
    MCP server の起動 = RCE 経路と、MCP 認証待ちで初期 prompt がハングして
    日次予算を空焼きする既知クラスの両方を遮断。既存ユーティリティ 4 種は
    全員設定済み・**defaultRunReviewer 自体はこのフラグを欠くので「型」を
    そのまま写さない**）。`hidden` 相当の扱い（Terminal タブに出すか）は
    C2 実装時に generateDescription の前例に従う。
  - **you-corpus は argv 注入しない**: プロンプトには `~/.openground/
    you-corpus.md` の**パスと行動規範（1-2KB）だけ**を渡し、本文は claude に
    Read させる。理由: 実測 ~420KB の corpus を initialPrompt（argv 1 本）に
    入れると (a) Windows の CreateProcess 32,767 文字上限で**起動不能**
    （Windows 対応は出荷済み・C2 が実装不能になる）(b) macOS も ARG_MAX 1MB に
    corpus 成長で到達し得る (c) 毎コール ~10 万 token 級の注入で 24 回/日 cap
    でも日次数百万 token — subscription 枠と衝突。パス Read 方式なら大脳が
    必要節だけ読める。
  - タイムアウト `OVERSEER_BRAIN_TIMEOUT_MS = 5min`（レビュー panel の
    REVIEW_TIMEOUT_MS と同値）。超過は PTY kill + assessInFlight 解除 +
    mailbox に timeout 結果。
  - model/effort は `resolveSwarmModelEffort(mode, 'overseer')` — role union に
    'overseer' を追加（max=fable/max・optimize=fable/high・economy=sonnet/
    medium。manager と同格: 判断品質が結果を左右する席）。
  - sandbox 実験 ON 時は worker spawn:441 と同じ分岐で SBPL 包囲（write 対象は
    scratch dir のみ — git write carve-out 不要）。

### OverseerRuntime（in-memory・ProjectEngine に載せる）

```ts
interface OverseerRuntime {
  enabled: boolean            // 既定 false。owner POST のみ true。stopOrchestrator/再起動で false(D1)
  assessInFlight: boolean     // 大脳の単一飛行（同時 1 PTY）
  brainTerminalId?: string    // 飛行中 PTY。OFF 時に kill するための座標
  brainResults: BrainResult[] // fire-and-forget の結果 mailbox（次 tick で drain）
  seen: Map<string, string>   // エッジ dedup: signalKey → fingerprint(sha/カード id/回数)
  watch: Map<string, { since: number; fp: string }>
                              // 滞留計測（S5/S7 の「30min 継続」・S6 の「2 tick 連続」）。
                              // 毎 pass 現行 tasks/anomalies と突合して不在キーを prune
                              //（pruneStuckMoves:4670 / pruneReworks:4692 と同じ規律）
  lastBrainAt: number         // 大脳スロットル
  brainCallsToday: number; dayKey: string   // 日次 cap（UTC ロール — selfSupply と同型）
  lastUsageAt: number; usageBackoffUntil: number   // M8 サブ周期
  lastEscalationsAt: number   // M11 サブ周期
  lastEscalateAt: number      // T3 スロットル（受信箱の冪等は receiptKey が担う・§8）
}
```

※ `ProjectEngine` に field を足すので `getOrCreateEngine` の防御 backfill
（swarmOrchestrator.ts:1330-1359）にも追加する（既存の掟）。
※ watch / seen は in-memory — **再起動で計測はリセットされ、滞留タイマーは
ゼロから再計測になる（発火が遅れる方向＝安全側）**。この帰結は仕様とする。

### 監督ノード自身の状態遷移

```
        owner POST overseer{enabled:true}（autonomy ON 中の engine にのみ有効）
   ┌─────────┐ ──────────────────────────────────────► ┌────────────┐
   │ DISABLED │                                          │ OBSERVING  │
   │ (既定)   │ ◄────────────────────────────────────── │ 毎tick観測  │
   └─────────┘   owner POST {enabled:false}               └─┬───▲──────┘
        ▲        / stopOrchestrator（autonomy 明示 OFF）      │   │ mailbox drain /
        │        / プロセス再起動(K2)                エッジ検出 │   │ timeout / 完了
        │        ※ auto-drain の再点火では遷移しない(D1)      ▼   │
        │                                              ┌─────────────┐
        │                                              │ ASSESSING    │
        │                                              │ 大脳 1 PTY    │
        │                                              │ fire-and-    │
        │                                              │ forget(D2)   │
        │                                              └─────────────┘
        │     usage over(100%・% 取得済みの時のみ) ／ claude preflight NG
        │   ┌──────────────────────────────────────────────────────┐
        └───│ THROTTLED — 観測は続く・T1/T2 停止・T3 は縮退経路で継続  │
            │（S4 の質問は proxyDraft なしで受信箱へ直行）。入時に 1 回 │
            │ T3' 通知「監督が枠切れで縮退中」。% 回復で自動解除        │
            └──────────────────────────────────────────────────────┘
```

- OBSERVING⇄ASSESSING は `assessInFlight` で表現（enum 新設なし）。THROTTLED
  は毎 tick 頭で評価するガード条件であり永続状態ではない。
- **usageLevel が null（% 未取得・scrape 失敗）の時は THROTTLED に入らない**
  （'idle' を over と同義に扱わない）。fail-open に見えるが、大脳の絶対上限は
  usage と独立に日次 cap（L7）が持つ — 「% が読めない間は cap だけが上限」と
  いう縮退が設計上の意図。

### per-worker の観測状態（正規化）

監督は worker の状態を**再分類しない**。既存の 2 系統をそのまま読む:

| shell（sw_worker_status・tmux 世界） | in-app（engine・監督が読む方） | 監督の扱い |
|---|---|---|
| READY（phase==done or readyToMerge） | `classifyWorker`:858 の promote 条件（**commitsAhead>0 AND (ready OR PTY死&非blocked)** — 保守的 AND） | T0（engine が review 昇格済み）。監督は関与しない |
| WORK / WAIT / QUIET | stage 'working'/'starting'（STARTUP_GRACE_MS=25s） | 何もしない |
| STALL（心拍 mtime 10min） | 両チャネル AND 無音 10min → nudge×2 → reclaim（`classifyStall`:971） | T0（既存）。**片チャネル判定に変えない**（長 build 中の誤 reclaim） |
| BLOCK（phase==blocked） | `blocked = !ready && (phase==='blocked' \|\| blockers 非空)`:1868 — **shell より広い**（blockers 文字列も見る）。blockers の本文は M1（心拍ファイル）から読む — 公開 state に無い（M2 注記） | blockers が自由文質問なら C2 proxy 回答→C3 注入（T1）。C4 が不可逆と判定 or C2 が abstention なら **T3**（fail-closed） |
| NOBEAT | heartbeat null（spawn 直後は正常） | grace 内は無視。超過は既存 anomaly worker-stale が拾う |
| DIRTY | （in-app に直接対応なし・integrate 前に git が権威） | 関与しない |
| HELD（mergeblock sentinel） | **in-app に存在しない**（tmux 専用機構） | 監督は HELD を読まない。in-app の承認ゲートは autoMerge OFF / selfSupplyApproved / blocked 列の 3 つ（[hold] 文字列も in-app engine には無い） |

---

## 6. 閾値表 — どのエッジで・どの Tier を起こすか

### Tier 定義

| Tier | 意味 | 実行主体 | コスト |
|---|---|---|---|
| **T0** | 機械的介入（判断不要）— **既存 engine が全て実装済み**。監督は起こさない・重複実装しない | engine | 0 |
| **T0'** | 機械的だが**監督が新設**する軽アクション（LLM 不要）: 再通知・THROTTLED 出入りの通知・janitor 配線 | 脳幹 | ほぼ 0 |
| **T1** | 大脳を起こす（判断が要る・可逆） | one-off claude PTY（D4） | 1 PTY / 判断（予算下） |
| **T2** | supply 投入（新タスク化） | Board todo へ**承認ゲート付き**カード起票 | mutate 1 回（起草に T1 経由が多い） |
| **T3** | 本人エスカレーション | 受信箱(C1) append + ベル/OS 通知 | 1 append + 通知 |

**T0 の在庫（再実装禁止のリスト）**: stall nudge→reclaim（10min AND・cooldown
3min・2 発・echo-guard 30s）/ rate-limit hold→20min 後 todo 再キュー（nudge
禁止）/ permission auto-accept→2min で blocked / runaway 90min 停止 / crash
requeue（RECOVER_MAX_REQUEUE=1）/ rework 予算（MAX_REWORKS=2）/ conflict 委譲
予算（3）/ terminal sweep（boot 配線済み 30s）。
**T0' の初期在庫**: `runSwarmJanitor`:405 の低頻度配線（§7.1 W6 — 完成品・
現在プロダクション呼び出し元ゼロ）・S11 再通知・THROTTLED 通知。

### エッジ検出の規律

- **rising edge のみ**発火（swarm-watch の `(branch,status,sha)` タプル方式を
  in-app 化: `seen` Map）。継続状態を毎 tick 流すとベル/PTY がスパム化する —
  dedup は**呼び手（監督）の責務**（swarmNotifications は id に createdAt を
  含み dedup しない）。
- 再評価は fingerprint（新 SHA / 新カード id / 新回数）が動いたときだけ。
- **再起動・再 ON で seen/watch は空になり、継続中の異常は再発火する**。この
  再発火の実害は各 Tier 側で吸収する: T3 は receiptKey 冪等（§8 — open が
  ある間 append 拒否）で受信箱が増えない。T1/T2 は予算 cap 内の再評価として
  許容（結果は前回と同じ mailbox 判断に収束する）。
- **大脳の予算**: `OVERSEER_BRAIN_MIN_INTERVAL_MS = 10min`・
  `OVERSEER_MAX_BRAIN_PER_DAY = 24`（UTC ロール）・`assessInFlight` 単一飛行・
  1 コール `OVERSEER_BRAIN_TIMEOUT_MS = 5min`。usage warn（S8）で日次 cap を
  半減。予算切れ時は T1 をスキップして log に「skipped: budget」を残す
  （fail-quiet にしない）。

### 閾値表（正典・実装は 1 テーブル駆動にする）

| # | シグナル（ソース） | 閾値 / エッジ | Tier | アクション |
|---|---|---|---|---|
| S1 | anomaly `rework-exhausted`（M4/M6） | rising edge | **T1→T2/T3** | 大脳がカード+ログ+差し戻し理由（engine.reworkReasons）を読み、①仕様を再定式化して supply 起票（T2）②本人判断が要るなら T3。fingerprint = カード id+rework 回数 |
| S2 | anomaly `all-workers-down`（M4/M6） | rising edge | **T1** | 大脳が log 末尾を読み原因分類（claude 落ち / preflight / 枠切れ）。**再点火は監督の仕事ではない** — todo が残っていれば既存 auto-drain（`maybeAutoStartDrain`・15s スキャン）が拾う。監督は「auto-drain でも復旧しない」と大脳が判断した時だけ T3（注: `drainTickOrchestrator`:5315 は現在 auto-start しない純 read — 復旧の動詞として引用しない） |
| S3 | `exec-timeout`（M6） | rising edge | **T1** | 大脳がカードを読み「分割して supply（T2）or 諦めて blocked 維持+T3」 |
| S4 | worker 心拍 `blockers` 非空（M1） | rising edge（blocked 化した瞬間） | **T1 (C2/C3)** | blockers 文が質問なら C2 proxy 回答→C3 注入。C4 が不可逆と判定 or C2 が abstention なら **T3**。**THROTTLED 中は大脳を経由せず、素の質問（proxyDraft なし）を直接 T3 受信箱へ**（枠枯渇＝最も人手が要る局面で判断系が沈黙する空洞を作らない） |
| S5 | blocked 列の滞留（M3） | カード毎 **30min** 継続（`watch` Map で計測） | **T1** | 大脳が blocked カードを読み ①依存解消済みなら todo 復帰を**提案**（T3 の弱形: 受信箱でなくベル通知+実行は owner）②本人判断が要るものは T3 にまとめる。**blocked は人間判断列 — 監督が自動で列を動かさない** |
| S6 | todo 枯渇（M3） | `todo==0 && doing==0 && review==0` が **2 tick 連続**（watch） かつ ゴール未達 | **T1→T2** | Phase2 では**実装しない方向**（§11 Q4）— 表には残すが C-core のスコープ外。実装する場合: 大脳が you-corpus のゴールと done 列から次の観測可能タスクを起草して承認ゲート付き起票 |
| S7 | review 滞留（M3/M7） | review 列カードが **30min** 統合されない（autoMerge OFF 時・watch） | **T0'（info 通知）** | 「統合可能が溜まっています」をベル通知のみ（info 級イベント種は C1 で追加 — §10 C1 成果に計上）。受信箱には入れない |
| S8 | usage warn（M8） | `usageLevel(pct)==='warn'`（80%・% 取得済み時のみ） | **T0'** | 大脳日次 cap を半減。executionMode の切替は**提案通知のみ**（設定は owner のもの）。worker 側の並列 cap は既存 execModeMaxWorkers の領分 |
| S9 | usage over（M8） | `usageLevel(pct)==='over'`（100%・% 取得済み時のみ。**null/idle では発火しない** — 縮退は予算 cap が担う） | **THROTTLED** | T1/T2 停止・観測継続・S4 は縮退経路で T3 直行（§5）。**入った事実を 1 回 T3' 通知**。回復（<100）で自動解除 |
| S10 | selfUpdate `rollback` / `canary-failed`（M6） | rising edge | **T3** | 受信箱へ昇格（「エンジン自己入替が失敗し旧版で動いています」+ 文脈）。Electron 側の連続 2 回トーストは既存のまま |
| S11 | 受信箱 open 滞留（M11） | open が **6h** 無応答 | **T0'（再通知）** | OS 通知を 1 回だけ再送（fingerprint: escalation id + 6h バケット）。**自動進行は絶対にしない**（K6: 不可逆は本人未応答で進まない — C1 の Done 条件） |
| S12 | engine bootId 変化（M9） | — | **何もしない** | K2 により監督も一緒に消えている。ここに auto-resume を書かない（アンチ閾値として明記） |

**閾値の出自**: 10min/30min は既存 STALL/QUIET（SWARM_STALL_MINS/QUIET_MINS）と
lockstep。80/100 は usageThresholds.ts の単一正典を再利用（新閾値を作らない）。
30min 滞留・6h 再通知・日次 24 回・timeout 5min は新設値 — **すべて 1 箇所の
定数表（`OVERSEER_THRESHOLDS`）に集約し、テストはその表を参照して書く**
（SWARM_LAUNCH_MODEL 一元化と同じ規律）。

---

## 7. 既存部品の配線図 — 再配線マップ

### 7.1 部品別: 現状 → 監督ノードでの役割 → 変更量

| # | 部品（実名） | 現状 | 監督での役割 | 変更量 |
|---|---|---|---|---|
| W1 | `swarmOrchestrator.ts` engine tick（runEnginePass:4825） | dispatch→integrate→anomaly→notify→selfSupply | 末尾に `runOverseerPass(engine, tasks, deps, now)` を追加（D2・tasks は取得済みスナップショット） | **小**（+1 ステージ） |
| W2 | selfSupply の承認ゲート（swarmSelfSupply.ts / selectDispatch:502 / approveSelfSupplyCard:582 / スキーマ selfSupplyKey・selfSupplyApproved schemas.ts:140-149） | 機械提案カードの owner 承認フロー一式 | **T2 はフィールドを共用する**: 監督起票カードも `selfSupplyKey`（値プレフィックス `overseer:` で provenance 区別）+ `selfSupplyApproved:false` を付ける → selectDispatch:502 のゲートも approveSelfSupplyCard も承認 UI も**そのまま効く**。並設 (`overseerKey`) は選ばない — ゲート・承認ルート・スキーマ 3 点セットの全複製が必要になり、1 箇所でも漏れると未承認カードが dispatch される fail-open（schemas.ts:140-149 が同じ罠を明文警告） | **なし〜小**（key 値の規約のみ。dedup 集合 `openSelfSupplyKeys`:334 も自然に共有され二重起票を防ぐ） |
| W3 | 心拍リーダ（defaultReadHeartbeat:1842 / swarmRepoKey:1819） | engine monitor が消費 | 脳幹の M1。**読み取り専用** | **なし** |
| W4 | `getOrchestratorState`:5281 / OrchestratorWorker（types.ts:973） | UI 5s poll | M2。in-process なので engine 直読（PURE 維持）。公開面に blockers 等を足す場合は PURE のまま types+sanitize も更新（M2 注記） | **なし〜小** |
| W5 | anomaly/fatal（detectAnomalies:4546 / fireFatalNotifications:4744 / swarmNotifications.ts） | ベル+OS トースト | S1-S3/S10 の入力。**rising-edge dedup 実装の写経元**。info 級イベント種（S7/S9 用）を C1 で追加 | **小** |
| W6 | `runSwarmJanitor`（swarmJanitor.ts:405） | **完成品・プロダクション呼び出し元ゼロ** | T0': OBSERVING 中に低頻度（15min 毎・lastJanitorAt）で呼ぶ。**force / deleteRemote は自律ループから絶対に渡さない**（ユーザー明示専用の設計） | **小**（呼び出し配線のみ） |
| W7 | Board CRUD（projectData.ts） | 全書き込みの単一 choke point（lock+CAS+collabMirror） | T2 起票・列移動は **`mutateProjectData`:328（lock 内 RMW）** を使う — 大脳起草（数分）を挟んだ後の起票で stale updatedAt CAS が swarm 稼働中に高頻度衝突するため、read→CAS write 型（selfSupply の writeProjectData 方式）は採らない。fs 直書き禁止（collabMirror 迂回で共有モードが巻き戻る） | **なし** |
| W8 | one-off ランナー（defaultRunReviewer:2963 が最近縁）+ `resolveSwarmModelEffort` | レビュー panel | 大脳 = `runOverseerBrain`（新設・D4 仕様: scratch cwd・strictMcpConfig:true・corpus パス Read・5min timeout・fire-and-forget）。role union に `'overseer'` 追加 | **小**（swarmLaunch.ts に 1 行 + ランナー 1 関数） |
| W9 | `readYouCorpus()` / `appendJudgment()`（youCorpus.ts） | HTTP/CLI seam は現役・**プロンプト注入の消費者はゼロ** | 大脳が最初の注入消費者（ただしパス Read 方式・D4）+ owner 回答の書き戻し（§8） | **なし**（呼ぶだけ） |
| W10 | owner-gate（getCustomTabRole / swarmSafety.routes.test.ts sweep） | /api/swarm 全 14 ルート | 監督の新ルート（overseer toggle・escalations CRUD）を **/api/swarm/* 配下に mount** → sweep が自動適用（K3） | **なし**（レールに乗るだけ） |
| W11 | `makeAdversarialReview`:3074（runReviewer DI 済み） | マージ前 4 lens panel | 変更しない。将来: 大脳の重要判断を複数 lens 化する時の既製 factory | **なし** |
| W12 | selfUpdate（selfUpdateSignal.ts / electron/selfUpdate.js） | 統合着地→自己入替 | 変更しない。監督は M6 で結果を観測するだけ。**OPENGROUND_SOURCE_ROOT を監督の子プロセスに漏らさない**（無限サイクル防止の不変条件） | **なし** |
| W13 | sandbox（sandbox.ts / isExperimentEnabled('sandbox')） | worker と interactive claude の 2 経路を包囲。**owner-only 実験・既定 OFF** | 大脳 one-off は**実験 gate 不問で darwin 常時 sandbox**（`brainSandboxAvailable`・write は scratch dir のみ・**network:'loopback' + allowlist egress proxy** で外部送信は Anthropic のみ — 2026-07-08 恒久化、docs/SANDBOX_EXPERIMENT.md「Overseer-brain egress close」）。非 darwin / sandbox-exec 不在時のみ permission 層 stop-gap に degrade | **済** |
| W14 | usage（claudeUsageCli / usageThresholds） | UsageHud 60s poll | S8/S9（M8 の読み方規律で）。`usageLevel()` 再利用・新閾値を作らない | **なし** |
| W15 | UI（SwarmModule / useSwarmEngine） | swarm タブは experiment:'swarm' | 監督トグル+受信箱パネルは SwarmModule 内（新 experiment id 不要）。「autonomy 再 ON でも監督は OFF」の表示（D1） | **中**（C1/C-core の一部） |
| W16 | 質問注入（pastePrompt.ts の bracketed paste / writeInput） | paste-task・rework 指示注入で実績 | C1 の回答注入と C3 の proxy 回答注入が**共有ヘルパとして 1 回だけ実装**（C1 が所有・C3 は流用 — 二重実装しない） | **小** |
| W17 | retention（retention.ts） | boot 時 1 回の刈り取り | escalations.json の resolved（answered/dismissed）90 日刈りを追加。**boot 時 1 回型なので長時間稼働中は刈られない**（増加は T3 スロットル+receiptKey 冪等で有界・実害小） | **小** |

### 7.2 一方向フロー配線図（K5 の in-app 実体）

```
            (T2) selfSupplyKey='overseer:…' 付きカードを todo へ起票（承認ゲート付き）
  監督 ─────────────────────────────────────────────► Board todo 列
   ▲                                                      │
   │ 観測のみ                                              │ selectDispatch:450
   │  M1 心拍ファイル                                       │ （6ゲート・承認済みのみ）
   │  M3 Board（tick 取得済みスナップショット）               ▼
   │  M4/M5 anomalies/log/KPI                        engine dispatch パス
   │  M6 fatal（pendingFatal/notified 共有）           （=in-app の manager 執行）
   │  M8 usage（60s サブ周期・キャッシュのみ）                │ spawnSwarmWorker
   │                                                       ▼
   │            心拍 swarm-beat.sh ◄──────────────── worker（隔離 worktree・/order 自走）
   │                                                       │ commits
   │                                                       ▼
   │                                       engine monitor→review 昇格→verify→
   │                                       敵対レビュー→integrateBranch（FF/rebase）
   └───────────────────────────────────────────────────────┘
                        統合結果・異常が M4/M5/M6 に出る

  逆流の禁止（明文化）:
  - 監督は worker を直接 dispatch しない（起票は必ず Board 経由・振るのは engine）
  - 監督は git を直接触らない（統合は engine の integrateBranch のみ）
  - 例外 = C3 の「回答注入」: これは指揮でなく質問への返信。既存の
    reworkOrPark / delegateConflict が LIVE worker へ PTY 注入する既存経路と
    同型であり、一方向原則（発注の流れ）に反しない。注入の安全規律は §10 C3。
```

### 7.3 新設ファイル（D3 の命名決定・実装カードの対象・C0 では作らない）

| ファイル | 中身 | 命名の意図 |
|---|---|---|
| `src/lib/server/swarmOverseer.ts` | OverseerRuntime / runOverseerPass / OVERSEER_THRESHOLDS / edge・watch | swarm glob 内（D3・K9） |
| `src/lib/server/swarmOverseerBrain.ts` | runOverseerBrain（D4）— §10 C2 の対象。C-core の swarmOverseer.ts とファイル分離（disjoint・same-file ゲート回避） | 同上 |
| `src/lib/server/swarmEscalations.ts` | 受信箱の永続層（§8） | 同上 |
| `src/lib/server/swarmReversibility.ts` | C4 可逆性クラシファイア | 同上（**glob 外に置かない** — L5 安全層の改変が安全網スイートを踏まずに通るのを防ぐ） |
| `server/routes/swarm.ts` への追加 | POST orchestrator/overseer・GET/POST escalations 系 | 新 prefix を作らない → sweep 自動適用（K3） |
| `retention.ts` への追加 | escalations の resolved 刈り（W17） | — |

---

## 8. エスカレーション受信箱 — C1 に渡す仕様骨子

（C1 カードは「C0 の受信箱仕様」に依存すると明記されているため、ここで固定する）

### データモデル

```ts
// ~/.openground/escalations.json（machine-wide・projectPath はフィールド）
// swarmNotifications と同じ single-flight append + atomicWriteJson。
// ただし cap で落とさない（未応答の不可逆判断を黙って失うのは K6 違反）。
// resolved(answered/dismissed) だけ 90 日で retention.ts が刈る（W17・boot 時）。
interface Escalation {
  id: string                    // randomUUID
  receiptKey: string            // 冪等キー（taskId+質問正規化の hash 等）
  createdAt: string
  projectPath: string
  taskId?: string; branch?: string; terminalId?: string  // ブロック中 worker の座標
  question: string              // 本人に見せる質問（1 画面で判断できる粒度）
  context: string               // なぜ聞くか・何が賭かっているか（stakes）
  screenshotRef?: string        // PTY 末尾キャプチャ等の添付（元 C1 カードの「スクショ」— 実装は C1、フィールドだけ先に確保）
  proxyDraft?: {                // C2 の暫定回答（THROTTLED 中の S4 直行では省略される）
    answer: string
    confidence: 'high'|'medium'|'low'
    isAbstention: boolean       // 「コウキの情報が薄い」の事前申告(K7)
  }
  whyEscalated: 'irreversible'|'insufficient-info'|'policy'   // K6/K7 の3弁
  status: 'open'|'answered'|'injected'|'dismissed'
  answer?: string; answeredAt?: string; injectedAt?: string
}
```

### フロー（C1 の Done 条件そのまま）

```
監督(T3) ──append──► escalations.json ──┬─► Ground ベル（GET /api/swarm/escalations）
                                        └─► OS トースト（createSwarmFatalNotification
                                             流用 or 専用 info 級イベント）
本人が回答（UI: SwarmModule 内 Escalations パネル → POST .../answer）
   │
   ├─ worker が LIVE → writeInput へ bracketed paste 注入（W16・着弾確認つき）
   │                    → status: injected → worker 再開
   ├─ worker 不在   → engine.reworkReasons と同型で「次回 /order に同梱」
   └─ 共通         → appendJudgment(`Q: … → A: …`, tags:['escalation'])
                      ＝記憶への書き戻し（owner の実回答のみ・§3）
```

### 不変条件（C1 のテストが固定すべきもの）

1. **不可逆は本人未応答で絶対に自動進行しない**（S11 は再通知のみ・fail-closed）。
2. **receiptKey 冪等**: 同一 receiptKey の `open` レコードが存在する間、append は
   no-op（既存 id を返す）。監督の再起動・seen リセットによる再発火（§6）でも
   受信箱は増えない。
3. append は single-flight・破損時は `.corrupt-<ts>` 退避（youCorpus additions と
   同じ契約・silent clobber 禁止）。
4. ルートは全て owner-gate（/api/swarm/* 配下・sweep 自動適用）。
5. 質問注入は worker の心拍を書かない・mtime を汚さない（M1 読み取り専用）。
6. **記憶書き戻しは owner が回答した Q→A のみ**。大脳の自動回答・注入された
   worker 由来テキストは書き戻さない（誤学習の一方向蓄積を防ぐ）。
7. push 通知の到達は正しさの前提にしない（永続レコードが正 — OS トーストは
   process.send 不在環境で silent no-op という既存制約）。
8. **スコープの明示**: 元 C1 カードの「スマホへ push 通知」は Phase2 では
   **OS 通知+ベルまで**に再スコープする（外部 push サービスは outward の
   新チャネル＝owner 明示設定の別カード・§11 Q7）。これは Done の縮小であり、
   黙って落とすのではなくここで宣言する。

---

## 9. 安全設計 — 多層防御の全景

監督ノードが加わった後の無人運用は、以下の**独立した層**で守られる
（単層に依存しない・K6 の弁は最後の層ではなく最初の層）:

| 層 | 機構 | 状態 |
|---|---|---|
| L1 起動 | autonomy 明示 ON 相乗り + overseer トグル既定 OFF + 明示 OFF/再起動で enabled クリア + auto-drain では起きない（D1・K1/K2） | 設計 |
| L2 認可 | owner-gate 全ルート（K3・sweep 自動）+ role 既定 'none' | 出荷済みレールに乗る |
| L3 封じ込め | sandbox（A1・カーネル代替）。**大脳は darwin では実験 gate 不問で常時 ON**（network:'loopback' + allowlist egress proxy — 外部送信経路は構造封鎖、2026-07-08 恒久化）。worker/interactive は従来どおり owner-only 実験。**L3 が不在なのは非 darwin / sandbox-exec 消滅時のみ**で、その時の大脳は D4 の構造（scratch cwd・strictMcpConfig・プロンプト READ-ONLY 指示）+ --disallowed-tools + L4/L5/L7 が担い、overseer ON に起動時警告を出す（brainSandboxAvailable — C-core） | 出荷済み（W13） |
| L4 決定論 veto | PreToolUse exit-2 deny（A3・bypassPermissions を貫通する唯一の veto）。rm -rf / force-push / worktree 外書込 | A3 実装中（並走・C3 の前提でもある → §10） |
| L5 可逆性ゲート | C4 クラシファイア（不明→不可逆・fail-closed）を A3 / C2 / 監督 T3 弁が共通参照 | C4 カード |
| L6 git 安全網 | 不変条件 A–D + 品質フロア 4 ゲート + swarm glob の tamper guard（監督コード自身に適用・D3） | 出荷済み |
| L7 予算ブレーキ | 大脳 日次 24 cap（warn で半減）+ 10min throttle + 5min timeout + 単一飛行 / usage 80/100（S8/S9）/ DISPATCH_BUDGET=50 / 並列 cap（execModeMaxWorkers） | 新設（§6 予算） |
| L8 人間の弁 | 受信箱（不可逆は未応答で進まない・receiptKey 冪等）+ blocked 列（人間判断列の規律維持）+ T2 承認ゲート（selfSupplyApproved 共用 — schema/ゲート/承認ルートが出荷済みのものをそのまま使うので fail-open の複製リスクなし） | C1 + W2 |
| L9 kill switch | ①overseer POST OFF ②autonomy OFF（enabled ごとクリア・D1）③アプリ再起動（K2 で全 OFF）④`OPENGROUND_SWARM_AUTODRAIN` 未設定なら boot 後に何も自動で動かない | K1/K2 の帰結 |

**監督ノード自身の暴走に対する非対称**: 監督は「読む・起票する・上げる」しか
できない — これはプロンプト頼みではなく構造で担保する: 大脳は実ツリーに cwd を
持たず（D4 scratch）、git を触る動詞を持たず（統合は engine の
integrateBranch のみ）、起票は承認ゲート付き（L8）、通知はエッジ dedup +
receiptKey 冪等。最悪ケースは「無駄な大脳呼び出し（コール数・時間・単一飛行で
三重に有界）」「無駄カード起票（承認待ちに滞留するだけ）」「通知スパム
（dedup で抑止・最悪うるさいだけ）」に構造的に縮む。

---

## 10. C1–C4 実装カード草案（改訂版）

Board 既存カード（C1 `a8519143` / C2 `c1c0583b` / C3 `74ec0b0d` / C4 `2b6d0b3f`）
の notes をこの設計に基づき精緻化した草案。

**着手順（依存順・厳守）: C4 → C2 → C1 → C-core → C3。**
- C3 を最後に置く理由: C3 は大脳を起こす検出器であり、**C-core の予算・単一
  飛行・edge dedup（OverseerRuntime）の配下でのみ動いてよい**。C-core より
  先に着地させると「overseer トグルにも予算にも縛られない大脳起動+PTY 注入
  経路」が autonomy/auto-drain だけで動いてしまう。
- **E2E（「監督が質問を上げ→push 受信→回答→worker 再開→記憶に 1 件追記」の
  一気通貫）の所有者は C-core**。元 C1 カードの Done にあるこの E2E は、監督
  本体（起点）が C-core にしか存在しないため C-core Done へ移管する — C1 単体
  では「手動 API 起票→通知→回答→注入→記憶」の疎通（監督起点を除く全区間）
  までを Done とする。**これは元カードからの明示的な再スコープ**。
- Board 運用: C1–C4 カードには `dependsOn` を設定する（selectDispatch:450 の
  6 ゲートに dependsOn 未 done hold が実在する — 機構はある。設定するだけ）。
  加えてファイル割当（下記）が重なるため、autonomy 稼働中に同時 dispatch
  させず **blocked 保留レーンから 1 枚ずつ解放**する既存運用を踏襲する。

### C4 [IMPL] 可逆性クラシファイア+ゲート（fail-closed）— 最初に着手

- 依存: C0 レビュー通過のみ。触るファイル: `swarmReversibility.ts`（新規）+
  swarmSafety.test.ts への追加。
- 成果: **`src/lib/server/swarmReversibility.ts`**（swarm glob 内 — D3。
  「glob 外で良い」は撤回: L5 安全層の改変が安全網 diff ゲートを踏まないのは
  自文書 K9 と矛盾する）: `classifyReversibility(input: {kind:'bash'|'tool'|
  'question', text}) → {verdict:'reversible'|'irreversible'|'unknown', reason}`。
  不可逆カテゴリ: 課金/公開/送金/削除/本番デプロイ/認証情報。EN/JA キーワード +
  構造パターン（classifyCardWeight:107 と同じ静的規律 — **LLM を呼ばない**）。
- Done: ①純関数+テスト（**unknown→irreversible の fail-closed を negative
  control 込みで**）②C2 が import する seam 形状の確定 ③**A3 retrofit を
  この C4 カードが所有する**: A3（`510f6ed0`・独自 denylist で進行中・notes に
  C4 への言及なし）が先に着地していた場合、A3 の判定部を classifyReversibility
  参照に置換する差分までが C4 の Done（「A3 / C2 がこれを参照する」という元
  カード Done の A3 側を宙に浮かせない）④tsc/lint/test 緑 + 敵対レビュー 1 パス。

### C2 [IMPL] proxy-you 回答関数（可逆性ゲート+情報不足の事前申告）

- 依存: B1（済）・C4。触るファイル: `swarmOverseerBrain.ts`（新規・glob 内。
  C-core の swarmOverseer.ts とファイルを分けて disjoint にする）+
  swarmLaunch.ts（role union に 'overseer'）。
- 成果: `runOverseerBrain` / `answerAsOwner({question, context, projectPath})
  → {kind:'answer', text, confidence} | {kind:'escalate',
  why:'irreversible'|'insufficient-info'}`。実装 = one-off claude PTY で
  **起動仕様は D4 に完全準拠**（scratch cwd・**strictMcpConfig:true**・corpus
  パス Read・5min timeout・マーカー scrape・echo-safe・finally kill）。
  予算判定は持たない（**純 primitive** — throttle/cap は呼び手 C-core の責務。
  これで C2 が C-core 非依存になる）。応答は C4 を通す（irreversible は大脳の
  自信に関係なく escalate — K6）。
- **prompt-injection 耐性**: worker 由来の質問文・PTY 抜粋は「untrusted 入力」
  として明示 fence で括り、回答は「質問への回答」テンプレに固定（コマンド
  実行を促す形式を出力させない）。回答テキスト自体も C4 に通し、不可逆誘導を
  含む回答は注入せず T3 へ。
- Done: ①1 質問→{回答 or エスカレーション} ②不可逆は必ずエスカレーション
  （回帰テスト）③根拠薄は abstention 申告（confabulate 検出の negative
  control）④**prompt-injection の negative control**（質問文に埋めた指示が
  回答に実行形で漏れない）⑤fake ランナー DI（makeAdversarialReview と同じ型）
  で LLM なしにテスト ⑥3 点緑+敵対 1 パス。

### C1 [IMPL] エスカレーション受信箱（永続層→通知→回答→注入→記憶）

- 依存: C0 の §8 仕様・C2（proxyDraft の生成側だが、C1 は proxyDraft 無しでも
  動く — 疎結合）。触るファイル: `swarmEscalations.ts`（新規）+
  server/routes/swarm.ts + SwarmModule UI + swarmNotifications.ts（info 級
  イベント種の追加 — S7/S9/T3' が使う）+ retention.ts（W17）+ 注入ヘルパ
  （W16 — **C1 が所有・C3 は流用**）。
- 成果: §8 のデータモデル・single-flight・corrupt 退避・**receiptKey 冪等**・
  `/api/swarm/escalations` 系ルート（owner-gate・sweep 自動）・SwarmModule 内
  受信箱パネル・OS 通知接続・回答→`writeInput` bracketed paste 注入・worker
  不在時の次回 /order 同梱（engine.reworkReasons 型）・`appendJudgment` 書き
  戻し（owner 回答のみ）。
- Done: ①**手動 API で起票→ベル/OS 通知→回答→LIVE worker へ注入→記憶に
  1 件追記**の疎通（監督起点を除く全区間 — 監督起点込みの E2E は C-core）
  ②不可逆は本人未応答で絶対に自動進行しない（fail-closed）③receiptKey 冪等の
  回帰テスト ④再スコープの明示: push は OS 通知+ベルまで（§8 不変条件 8）
  ⑤3 点緑+敵対 1 パス。

### C-core [IMPL・新カード起票] 監督ノード本体（脳幹 pass + トグル + 閾値表 + E2E）

- 依存: C1・C2・C4。触るファイル: `swarmOverseer.ts`（新規）+
  swarmOrchestrator.ts（W1 の 1 行 + ProjectEngine field + backfill）+
  server/routes/swarm.ts（overseer トグル）+ SwarmModule（トグル UI）。
- 成果: OverseerRuntime（watch/seen/mailbox/予算/バックオフ — §5 の全 field）・
  runOverseerPass（**tasks スナップショット引数受け取り**・大脳 fire-and-
  forget・mailbox drain）・OVERSEER_THRESHOLDS 表駆動（S1-S5, S7-S11。
  **S6 は外す** — §11 Q4）・D1 の enabled セマンティクス（stopOrchestrator
  でのクリア含む）・janitor 配線（W6）・sandbox OFF 時の起動警告（L3）。
- Done: ①既定 OFF・再起動 OFF・**stopOrchestrator で enabled クリア・
  auto-drain 再点火で起きない**（それぞれ回帰テスト）②owner-gate（sweep
  通過）③S1/S2/S4/S9 が fake deps unit テストで発火・dedup・予算・THROTTLED
  縮退（S4→T3 直行）を検証 ④**大脳飛行中も tick 周期が維持される**（fire-and-
  forget の回帰テスト）⑤getOrchestratorState の PURE 性を壊さない（既存
  テスト緑）⑥**E2E: test プロジェクト（06c90656）で監督が S4 を検出→C2 が
  質問に abstention→受信箱に起票→回答→worker 再開→記憶追記、の一気通貫**
  （元 C1 カードから移管された Done）⑦3 点緑+安全系敵対レビュー 1 パス
  （glob 内なので安全網スイートが毎統合走る）。

### C3 [IMPL] 自由文質問の検出+注入 — 最後（C-core の予算配下でのみ）

- 依存: A1（メニュー消滅の前提・済）・C2・C1（注入ヘルパ W16）・**C-core
  （予算・単一飛行・dedup の配下で動くこと自体が依存）**。触るファイル:
  swarmOrchestrator.ts の classifyOutput:1072 周辺（検出分類の追加）+
  swarmOverseer.ts（S4' の閾値行）。
- 成果: PTY「入力待ち」検出（既存 classifyOutput:1072 の第 3 分類 'question'。
  **最初の作業項目 = claude TUI の入力プロンプト固定シグネチャの実在確認** —
  rate-limit/permission は固定 runtime 文言への一致で成立しているが自由文質問
  にはまだ確定シグネチャがない。ここが不成立なら「心拍 blockers 経由（S4）
  のみ」に縮退して C3 を閉じる、まで含めてこのカードの成果）→ 文脈収集
  （PTY 末尾 N 行 + カード）→ C2 → 回答注入（W16 ヘルパ・bracketed paste・
  着弾確認・Enter 再送）。**S4（心拍 blockers）と C3（PTY 検出）が同一 worker
  で二重発火しないよう、fingerprint を worker 単位で共有する**（dedup は
  C-core の seen）。
- **誤検出の危険方向が既存 2 分類と逆**（rate-limit FP=猶予で安全 / question
  FP=**他人の PTY への能動的テキスト注入**）。よって: 判定が不確実な場合は
  注入せず T3 に上げる（fail-closed）・注入前に回答テキストを C4 に通す
  （C2 の仕様）・検出→注入のレイテンシ目標は「stall 検出（10min）とは独立の
  短周期」だが、確実性が取れない限り遅い方に倒す。
- Done: ①test で自由文質問→proxy 回答が注入され Enter 落ちなく送信 ②menu/
  rate-limit 誤検出ゼロ + **question FP で注入しない**（negative control）
  ③S4 との二重発火なし（回帰テスト）④3 点緑。

---

## 11. 未解決の問い（レビューで決めること）

| # | 問い | 草案の立場 |
|---|---|---|
| Q1 | 監督 ON は「autonomy ON = 自動で監督も ON」か「第3トグル（既定 OFF）」か | **第3トグル**。K1 の文言は「autonomy ON の時にだけ立ち上がる」＝必要条件。段階導入（監督だけ OFF で運転）ができ、将来「autonomy ON に統合」は 1 行（逆は難しい）。D1 の enabled クリア則とセット |
| Q2 | 大脳 one-off に sandbox + SWARM_MANAGER=1 guard を課すか | sandbox は**課す**（W13・sandbox 実験 ON 時）。SWARM_MANAGER=1 は**課さない**: guard は「実ツリーで bypass する者」のオプトインであり、大脳は D4 で実ツリーに cwd を持たない（scratch）。ただし「構造より belt-and-suspenders」を選ぶなら課してもコストはない — レビューで決める |
| Q3 | ~~T2 のフィールドは selfSupplyKey 共用か並設か~~ | **解決済み（v2）: 共用**（W2）。並設は selectDispatch:502 / approveSelfSupplyCard:592 / schemas.ts の 3 点全複製が要り、漏れ 1 つで未承認 dispatch の fail-open（敵対レビュー must-fix）。値プレフィックス `overseer:` で provenance を区別 |
| Q4 | S6（todo 枯渇→次タスク起草）を Phase2 に含めるか | **含めない**（C-core スコープから除外を明記）。ゴール生成は supply/本人の領分に近く、暴走時の無駄が最大。後続カードに分離 |
| Q5 | 受信箱 UI の置き場所 | SwarmModule 内パネル（swarm experiment の内側・新 experiment id なし）。Ground ベルには件数バッジのみ |
| Q6 | selfUpdate 結果の専用メトリクス面（M10 が API 非公開） | Phase2 では作らない（M6 の rollback/canary-failed 通知で足りる）。恒常観測が欲しくなったら別カード |
| Q7 | スマホ push の実装手段 | Phase2 は OS 通知+ベルまで（既存 IPC 経路・外部送信なし）。外部 push（ntfy/webhook 等）は outward の新チャネルなので owner 明示設定の別カード。**元 C1 カードの「スマホへ push」からの再スコープは §8 不変条件 8 で明示済み** |
| Q8 | 大脳が corpus をパス Read する際の sandbox read 許可 | D4 で corpus パス Read 方式にしたため、sandbox ON 時に `~/.openground/you-corpus.md` の read が SBPL プロファイルで許可されている必要がある（worker は心拍を書くため ~/.openground 配下 write を持つ — read はより弱い。C2 実装時に sandbox-probe で実カーネル検証） |

---

## 付録 A — 調査で確定した既存部品の一次事実（抜粋）

2026-07-02 の 8 並列 read-only 監査＋5 レンズ敵対レビューより。設計中で引用
した実名の裏取り一覧:

- **engine 駆動**: TICK_MS=3000（setTimeout チェーン+generation・setInterval
  不使用）/ INTEGRATE_TICK_MS=15s / AUTO_DRAIN_SCAN_MS=15s（boot ループは
  env 厳格 opt-in・既定 OFF）/ passInFlight は「bail であって待たない」・
  制御プレーンは runExclusive(engine.lock) で直列化。runEnginePass は各
  ステージを逐次 await — **だから大脳を pass 内で await してはいけない**。
- **T0 在庫**: STALL_SILENCE_MS=10min（心拍 AND PTY 両チャネル）・nudge
  cooldown 3min×2 発・echo-guard 30s・rate-limit hold 20min（nudge/reclaim
  絶対禁止）・permission 2min・MAX_EXEC_MS=90min・RECOVER_MAX_REQUEUE=1・
  MAX_REWORKS=2・MAX_CONFLICT_REWORKS=3・MAX_REVIEW_DEFERS=3。
- **昇格は保守的 AND**: `commitsAhead>0 && (ready || (PTY 死 && 非 blocked))`。
- **selfSupply（T2 の型）**: LLM ゼロ・1h throttle（board read 含む全 I/O を
  ゲート — 毎 tick I/O ではない点が監督と違う・監督は取得済みスナップショット
  再利用で解決）・3/pass・5/day・enabled in-memory 既定 OFF・承認ゲート
  selfSupplyApproved を selectDispatch:502 が尊重・schemas.ts:140-149 が
  「スキーマに無いフィールドは round-trip で strip → ゲート silent fail-open」
  を明文警告。
- **janitor**: runSwarmJanitor は 3 スイープ完成品・プロダクション呼び出し元
  ゼロ。branch は `-d` のみ・unknown は force でも消さない。
- **通知**: swarm-notifications.json cap 50・dedup は上流責務・OS トーストは
  process.send 前提（dev では silent no-op）。
- **you-corpus**: readYouCorpus()/GET /api/you-corpus/raw は HTTP/CLI 消費者は
  現役・**プロンプト注入の消費者はゼロ**（大脳が最初）。実測 ~420KB（auto-
  memory 92 ノート + CONCEPT.md）・appendJudgment で単調増加 — argv 注入
  不可の根拠（D4）。
- **usage**: CLI スクレイプ %（成功のみ 30min TTL・~9s/回・**activity watcher
  が JSONL 書き込み 30s 後に失効させる = swarm 稼働中はミスが常態**）と JSONL
  絶対量（毎回 full walk・~30MB read — 監督経路に入れない）の 2 系統。閾値は
  usageLevel（80/100・null は 'idle'）が単一正典。
- **one-off の先例**: defaultRunReviewer:2963（5min timeout・マーカー scrape・
  echo-safe・使い捨て worktree を finally 撤去）— ただし strictMcpConfig を
  欠く（D4 で上書き）。strictMcpConfig 契約は claudeTerminal.ts:73-82、既存
  ユーティリティ 4 種（generateDescription/canvasAi/generateSkill/
  generateTaskTitle）は設定済み。
- **owner-gate**: 全 /api/swarm ルートの第 1 文・sweep はライブ route table
  駆動で「gate を忘れた新ルート」も落とす。
- **engine 状態の公開面**: OrchestratorWorker（types.ts:973）は stage/phase/
  note/heartbeatAt/reworkAt — lastOutputAt/commitsAhead/blockers は**非公開**
  （monitor probe 内で計算・破棄）。
- **ポート台帳**: 47776 live / 5175+・47777+ dev:alt / 47876 e2e / 47901+
  canary — 監督は in-process なので新ポート不要。

## 付録 B — tmux 版との対応（参照系譜）

| tmux 世界（先行実装） | in-app 監督での対応物 |
|---|---|
| swarm-watch.sh（45s poll・(branch,status,sha) edge・司令塔ペインを起こす） | runOverseerPass（tick 相乗り・seen Map edge・大脳 one-off を起こす） |
| swarm-janitor.sh sweep --auto（3 段 fresh ガード） | runSwarmJanitor 配線（W6・T0'） |
| manage skill の司令官（Opus・イベント駆動起床） | engine の dispatch/integrate パス（既に機械化済み）+ 大脳（判断だけ） |
| supply skill + swarm-board.sh | T2: Board 承認ゲート付き起票（W2/W7） |
| [hold] prefix（fail-open 自己申告 + 構造的 force-hold） | in-app は autoMerge OFF / selfSupplyApproved / blocked 列（[hold] は導入しない） |
| mergeblock sentinel（HELD） | in-app 非導入（verify/review の tip memo が同役） |
