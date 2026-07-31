# SDK Worker Migration — 設計書

作成: 2026-07-30（設計フェーズ）/ **実装完了: 2026-07-30 同日（W0〜W8・直列実装）**

> ## 実装状況（2026-07-30）
>
> | カード | 状態 | コミット |
> |---|---|---|
> | W0 スパイク5本 | ✅ | `5b146327`（+ 副産物の実バグ根治 `dbba9e55`） |
> | W1 sdkSession + sdkEvents | ✅ | `9c8085fd` |
> | W3 guard の in-process 再武装 | ✅ | `908615ea` |
> | W4 WorkerRuntime seam（pty のみ） | ✅ | `1f2c7be2` |
> | W2 HTTP/SSE route | ✅ | `d5b6f951` |
> | W5 launch plan + preflight | ✅ | `9b5d045c` |
> | W6a キー統一 + SDK ランタイム実装 | ✅ | `5a738bd7` |
> | W6b ダイヤル + spawn 分岐 + roster | ✅ | `a1c329e6` |
> | W7 SdkWorkerPane + i18n | ✅ | `221fbfd5` |
> | W8 docs 追随 | ✅ | 本コミット |
>
> **既定は OFF**（`Settings.swarmWorkerRuntime.mode` 不在 ⇒ `'pty'`）。
> 有効化しない限り、挙動は移行前と1ビットも変わらない。
>
> **残っているのは §12 の実機受け入れ4項目のみ**（ダイヤル ON で toy カード完走 /
> PTY worker と混在 / 再起動で twin が生えない / kill switch）。これは実運用の
> オーナー環境でしか確かめられない。
>
> 設計から変わった点は §4-G・§5-S6・§12 に追記済み（W0 が設計を1箇所破棄し、
> 1箇所に危険を発見した）。
前提調査: `docs/SDK_CLIENT_INVESTIGATION.md`（実測10項目+スパイク3本+規約）— 本書は重複記載しない。
決定者: オーナー（2026-07-30）。

> **この決定は SDK_CLIENT_INVESTIGATION.md §0 の「移行はしない」を上書きする。**
> 理由: PTY スクレイプ経路の不具合が収束していない（位置判定は7回差し戻し・0729 にも
> 「心拍だけ残った死んだ worker」を実観測）。「安定してから移行」は、不安定の原因が
> 方式そのものである以上、順序として成立しない — オーナー判断で方式側を替える。
> 規約論点は swarm がオーナー限定（Supabase RLS の身元ゲート・配布物から到達不能）で
> ある限り発生しない（同 §12/§13）。配布判断は凍結バナー(support 記事 15036540)ウォッチ。

---

## 0. ゴール状態と期待挙動

**ゴール状態**: swarm worker の実行ランタイムが `'pty' | 'sdk'` の2種になり、
設定ダイヤルで worker 単位に選べる。既定は `'pty'`（挙動不変）。`'sdk'` を
`sdkMaxWorkers: 1` で有効化すると、次に dispatch される worker 1体だけが
Agent SDK 経由で起動し、残りは従来どおり PTY。両者は同じ roster / Board /
統合パイプラインの下で共存する。

**期待挙動（SDK worker で変わること）**:
1. **生死が推測でなくなる** — ストリームが閉じた=死。心拍ファイルの鮮度や
   「シグナルを送った」からの推定を、worker については使わない。
2. **「作業中/入力待ち」が確定event になる** — `esc to interrupt` の画面読みではなく、
   ターン境界（`result` メッセージ）で判定。
3. **クォータ/APIエラーが構造で来る** — 画面上の位置判定（swarmRateLimitText の
   worker 向け腕）を、SDK worker については通らない。
4. **注入（差し戻し・催促・回答）が着弾確認不要になる** — bracketed paste +
   画面再読（7回差し戻された §3.7 の機構）の代わりに、入力ストリームへの
   push（受理が同期的に分かる）。
5. **worker タイルが読みやすい表示になる** — xterm ではなく構造化 transcript
   （本件の発端だった「VS Code のような表示」が worker で実現する）。

**変わらないこと（不変条件）**:
- worker は自分の worktree で `/order` プロトコルを回し、`swarm-beat.sh` で心拍を打ち、
  自分で commit し、push しない（既存メモリの掟はそのまま）。
- Board / roster / 統合 / 差し戻し / クォータ冷却テーブルの下流ロジックは同一。
- manager / supply / Terminal タブ / 一回起動系（title/description/skill/canvasAi）は
  **PTY のまま**（本書のスコープ外・§14）。
- subscription-only。SDK は **必ず** `pathToClaudeCodeExecutable` でユーザー自身の
  claude を起動する（SDK 既定の同梱バイナリ起動は禁止 — INVESTIGATION §11-B）。
- PTY worker のコードパスは**削除しない**。kill switch はダイヤルを `'pty'` に戻すだけ。

---

## 1. 決定記録

| 論点 | 決定 | 根拠 |
|---|---|---|
| 移行するか | **する**（worker から・段階導入） | オーナー 0730。「PTY で粘っても収束が見えない」 |
| 置換か併存か | **併存**（runtime ダイヤル・既定 pty） | 戻すときに困るのは途中状態。git revert でなく設定切替で戻れる形に |
| 最初の範囲 | **worker 1体**（`sdkMaxWorkers: 1`） | 同日・同エンジン下で PTY worker と直接比較でき、失敗の損害が最小 |
| manager | **後**（stage 3・別設計） | リモコン必須 → 補給官へ窓口移設の設計が先（INVESTIGATION §13） |
| スクレイプ 2,461 行 | **消さない** | SDK worker が実運用で置換を証明してから（PTY 経路が残る限り必要） |
| 規約 | 今は非論点 | swarm はオーナー限定・配布物から到達不能。配布時に再訪（凍結バナー監視） |

---

## 2. 現状の worker 契約（棚卸し・実測済み）

PTY worker が今日受け取っているもの（`swarmWorker.ts workerLaunchOpts` → `claudeTerminal.ts`）:

| 項目 | 現在の実装 | 意味 |
|---|---|---|
| cwd | 中央 worktree（`~/.openground/projects/<uuid>/worktrees/...`） | 隔離作業樹 |
| セッション ID | `--session-id <uuid>`（fresh）/ `--resume <uuid>`（再開） | JSONL の所在が決定論的 |
| permissionMode | `'bypass'`（spread の**後**に置き無条件） | 無人で権限プロンプトに座らせない |
| guard | `guard: { writeRoots: [worktree] }` → env `OPENGROUND_GUARD=1` + `OPENGROUND_GUARD_WRITE_ROOTS` | **A3/L4: bypass 下で唯一の決定論的 veto**。グローバル settings の PreToolUse hook（openground-guard.js）が env を見て発火。**配線検証失敗は fail-closed（GuardWiringError＝spawn 拒否）** |
| strictMcpConfig | `true` | mcp__* は guard の外 → そもそもロードさせない（Commander MUST-FIX 2） |
| appContext | `false` | lean（/order が protocol） |
| model / effort | mode 解決（既定 opus/max）。`model` は roster に記録され**クォータ帰属**に使う | |
| remoteControl | 識別名で **ON** | SDK では消える（受容済み — 外部窓口は補給官が担う計画） |
| initialPrompt | `/order <goal>` を positional（長文は temp-file 経由 — MAX_CANON 回避） | 自動送信 |
| sandbox | owner 実験（Seatbelt）。off が既定 | |
| 監視 | 画面 scrape（classifyOutput: rate-limited / permission-wait / question / normal）+ 心拍ファイル + JSONL/subagent mtime（停滞プローブ）+ 消費読み（JSONL） | 本書 §5 で全数対応 |

---

## 3. アーキテクチャ

```
                     ┌────────────────────────────────────────────┐
                     │  swarmOrchestrator（頭脳・不変）             │
                     │  dispatch / roster / integrate / quota      │
                     └───────┬────────────────────────────────────┘
                             │ WorkerRuntime インターフェース（§3.2 新設）
              ┌──────────────┴──────────────┐
      ptyWorkerRuntime                sdkWorkerRuntime
      （既存関数の薄い包み・            （新規）
        挙動変更ゼロ）                        │
              │                              │
      terminal.ts (node-pty)          sdkSession.ts（新規・§3.1）
      claudeTerminal.ts                 └─ @anthropic-ai/claude-agent-sdk query()
              │                              └─ pathToClaudeCodeExecutable =
              │                                 resolvedClaudeBin()（ユーザーの claude）
              ▼                              ▼
      SSE /api/terminal/:id/stream    SSE /api/sdk-session/:id/stream（新規）
      TerminalPane(xterm)             SdkWorkerPane（新規・構造化 transcript）
```

### 3.1 `src/lib/server/sdkSession.ts` — 汎用 SDK セッションプール（新規）

`terminal.ts` の相似形。**worker 専用にしない**（将来 manager でも使う）。

- 状態は `globalThis.__openground_sdk_sessions` に置き、tsx watch reload を生存
  （terminal.ts と同じ掟 — CLAUDE.md 記載のパターン）。
- 1 エントリ = `{ id, cwd, sessionId, status, startedAt, lastEventAt,
  events: RingBuffer<SdkEvent>, seq, input: AsyncQueue, queryHandle, listeners }`。
- **`queryFn` を DI**（既定 = SDK の `query`）。テストは fake async-generator を注入し、
  **実 claude を絶対に spawn しない**（HOME 隔離の掟）。swarmOverseerBrain の
  runReviewer 注入と同型。
- 公開 API（すべて id ベース）:
  `spawnSdkSession(opts)` / `attachListener(id, fromSeq)` / `pushInput(id, text)` /
  `interruptSdkSession(id)`（graceful・turn 停止） / `terminateSdkSession(id)`
  （hard・abort+子プロセス終了） / `getSdkSession(id)` / `listSdkSessions()`。
- **status 機械**（§6）はこのモジュールが唯一の書き手。

### 3.2 `src/lib/server/workerRuntime.ts` — アダプタ境界（新規）

orchestrator が worker に触る操作を1つの interface に束ねる。**PTY 実装は既存関数へ
委譲するだけ**（挙動変更ゼロ — 既存テスト全緑がその証明）。

```ts
export interface WorkerRuntime {
  kind: 'pty' | 'sdk'
  /** spawn 済み worker の生存確認（プロセス実在） */
  isAlive(w: OrchestratorWorker): boolean
  /** 監視 tick の分類（§5 の対応表がこの実装差） */
  classify(w: OrchestratorWorker): 'rate-limited' | 'permission-wait' | 'question' | 'normal'
  /** 分類の根拠テキスト（通知・エスカレーション文面用。PTY=画面 / SDK=最終イベント） */
  evidence(w: OrchestratorWorker): string | null
  /** 停滞プローブ（PTY=JSONL/subagent mtime / SDK=lastEventAt + 同 mtime を併用） */
  lastProgressAt(w: OrchestratorWorker): Promise<number | null>
  /** UNSENT でなく SENT の注入（差し戻し文・回答・催促）。戻り値=受理 */
  inject(w: OrchestratorWorker, text: string): Promise<boolean>
  /** 穏当停止（ターン中断）と強制終了 */
  interrupt(w: OrchestratorWorker): Promise<void>
  kill(w: OrchestratorWorker): Promise<void>
  /** 消費読み（PTY=JSONL 行 / SDK=result.usage 累積、JSONL fallback） */
  consumption(w: OrchestratorWorker): Promise<WorkerConsumption | null>
}
```

- `OrchestratorWorker` / `SwarmWorkerRecord`（types.ts）に `runtime?: 'pty' | 'sdk'` を追加。
  **absent = 'pty'**（永続 roster の後方互換 — 古い roster.json を読んでも壊れない）。
- ハンドル: PTY は従来どおり `terminalId`。SDK worker は `terminalId` に
  **sdkSession の id を持たせない**。新フィールド `sdkSessionId?: string` を追加し、
  「`runtime==='sdk'` ⇔ `sdkSessionId` あり ⇔ `terminalId` なし」を invariant として
  roster 書込点で assert（魔法接頭辞での混載は不可 — 事故時に見分けられなくなる）。
- orchestrator 内の worker 向け PTY 直呼び（実測: launch 5 / kill 6+ / screen 系 ~10 /
  inject 1 / consumption 1 ≈ **20 箇所前後が worker 文脈**）を `runtimeOf(w).xxx()` に
  置換する。**manager/supply/ownerDesk 向けの直呼びは触らない**（スコープ外）。

### 3.3 `src/lib/server/sdkEvents.ts` — イベント解剖の一枚岩（新規）

**claudeScreen.ts の教訓をそのまま移植する**: 解剖学は1箇所に置き、全消費者が import する。
swarmRateLimitText が私的再実装を育てて「センサーが存在理由のイベントで沈黙」した事故
（claudeScreen 冒頭に記録）を、SDK 側で再演しない。

- 入力: SDK の `SDKMessage`（生）。出力: OG 内部の蒸留型 `SdkEvent`:

```ts
export type SdkEvent =
  | { kind: 'status'; status: SdkSessionStatus }            // §6 の状態遷移
  | { kind: 'text'; text: string }                          // assistant 発話
  | { kind: 'thinking'; chars: number }                     // 中身は保持しない（表示は件数）
  | { kind: 'tool_use'; name: string; detail: string }      // detail は transcript.ts の summarizeInput を再利用
  | { kind: 'tool_result'; ok: boolean; head: string }
  | { kind: 'turn_end'; reason: TerminalReason; usage?: TurnUsage }   // result メッセージ
  | { kind: 'rate_limit'; utilization: number; resetsAt: number; type: string }
  | { kind: 'api_error'; status: number | null; head: string }
  | { kind: 'quota_refusal'; tier: string | null; raw: string }       // §5-3 の判定済み
```

- **quota_refusal の判定はここだけ**が持つ: SDK 自身が export する
  `USAGE_LIMIT_ERROR_PREFIXES` / `USAGE_WARNING_PREFIXES`（実在確認済み — sdk.d.ts:7025）
  に対する前方一致 + `turn_end.reason === 'api_error'`。**位置判定は存在しない**。
- 消費者: ①SSE（UI feed） ②sdkWorkerRuntime.classify ③consumption 集計。3者が
  **同じ蒸留結果**を読む。

### 3.4 `src/lib/server/swarmWorkerSdk.ts` — worker 固有の糊（新規）

- `sdkWorkerLaunchOpts(worktree, sessionId, opts, me)` — §4 のパリティ表を実装する
  **純関数**（workerLaunchOpts と同じくテスト可能な builder）。
- ガード配線（§4-G）・env 衛生・preflight（§4-P）をここで担う。

### 3.5 `server/routes/sdkSession.ts` — HTTP/SSE（新規）

- `GET /api/sdk-session/:id/stream?from=<seq>` — SSE。接続時に ring buffer を
  `from` 以降 replay → live tail。クライアントは既存 `sseReconnect.ts` を再利用。
- `POST /api/sdk-session/:id/input` `{ text }` / `POST .../interrupt` / `DELETE :id`。
- **全 route が `validateProjectPath` を通す**（セッションの cwd で検証 — worktree は
  中央 worktrees 配下なので既存の述語がそのまま通す。新 path 受け口の掟を厳守）。
- `server/app.ts` に mount。

### 3.6 UI — `src/components/canvas/modules/SdkWorkerPane.tsx`（新規）

- SwarmWorkerPane と同じ差し込み位置・同じヘッダ語彙（DOT: working=azure /
  waiting=ochre / starting・exited=ink-faint。既存の beacon 語彙を再利用）。
- 本文 = transcript feed（`SdkEvent` を描画）:
  - `text` → そのまま（whitespace-pre-wrap。markdown レンダは**しない** — stage 1 は最小）
  - `tool_use` → 1行チップ `🔧 Edit foo/bar.ts`（summarizeInput due の detail）
  - `thinking` → 折りたたみ1行（「思考 n 文字」）
  - `turn_end` → 区切り線 + 状態
  - `quota_refusal` / `api_error` → 目立つバナー行
- フッタ = 1行入力 + 送信 + 中断ボタン（手動での nudge/デバッグ用。普段は engine が打つ）。
  **ボタン/入力は ui-interactive-states スキルの5状態を全部実装**（default/hover/
  active/disabled/focus — グローバル CLAUDE.md の必須要件）。
- i18n: 既存 I18nContext。新規文言は ja/en 両方。

---

## 4. 設定パリティ表（PTY worker → SDK Options）

**凡例**: ✅=INVESTIGATION で実測済み / ☑=型定義で存在確認済み（実測は S0） / ⚠=要スパイク

| # | PTY（今日） | SDK Options | 状態 | 備考 |
|---|---|---|---|---|
| 1 | cwd=worktree | `cwd` | ✅ | |
| 2 | `--session-id` / `--resume` | `sessionId` / `resume` | ✅ resume 実測 6.0s | fresh は `sessionId` 指定（JSONL 所在の決定論を維持） |
| 3 | `--dangerously-skip-permissions` | `permissionMode: 'bypassPermissions'` 相当 | ☑ | SDK の enum 表記は S0-D で確定。**spread の後に置く掟を builder でも維持** |
| 4 | guard env (`OPENGROUND_GUARD=1` + WRITE_ROOTS) | `env` に同じ変数 | ☑ | **hook が発火するかは別問題 → §4-G** |
| 5 | `--strict-mcp-config` | `strictMcpConfig: true` + `mcpServers: {}` | ☑ | |
| 6 | model / effort | `model` / `effort` | ✅（model 実測） | effort の enum 互換は S0-C で確認 |
| 7 | `--add-dir`（taskWorktrees） | `additionalDirectories` | ☑ | worker は worktree confinement なので通常空。attachments を渡す場合のみ |
| 8 | initialPrompt（positional + temp-file 経由） | 入力ストリームの最初の user message | ✅ | **MAX_CANON 問題が消滅**（TTY line discipline が無い）。temp-file ハックは SDK 経路では不要 |
| 9 | remoteControl 識別名 | **無し**（効かない — 実測3件） | ✅ | 受容済み。worker の外部窓口は補給官（stage 3） |
| 10 | sandbox（Seatbelt wrap） | **stage 1 では非対応** | — | sandbox 実験と SDK の併用は後続（§14）。`experiments.sandbox && runtime==='sdk'` は spawn 時に sandbox を落とし通知 |
| 11 | ユーザーの claude 実体 | `pathToClaudeCodeExecutable: resolvedClaudeBin()` | ✅ 実測 | **必須**。null（未解決）なら SDK spawn を拒否し PTY に fallback |
| 12 | login shell 由来の env/PATH | `env`: サーバ process env を基に構築 | ☑ | Electron 起動時は main が login-shell PATH を注入済み。**`CLAUDE_CODE_*` / `CLAUDECODE` を必ず strip**（child-session 汚染の既知問題） |
| 13 | appContext:false | `systemPrompt` 追加なし | ☑ | |
| 14 | cols/rows | 不要 | — | 画面が存在しない |

### 4-G. ガード配線（A3/L4）— 最重要の非自明点

**問題**: PTY worker の唯一の決定論的 veto は、グローバル `~/.claude/settings.json` に
インストールされた PreToolUse hook（openground-guard.js・env ゲート）。
**Agent SDK は既定で filesystem settings をロードしない**（`settingSources` 既定）。
つまり素朴に SDK で spawn すると **guard hook が存在しない worker** ができる。
Claude Code は missing hook を **fail-open** するので、これは静かに丸腰になる —
GuardWiringError の哲学（unverified ⇒ spawn 拒否）に真っ向から反する。

**設計**（優先順）:
1. **第一候補: プログラマティック hooks** — SDK `Options.hooks.PreToolUse` に
   in-process コールバックを渡し、その中で openground-guard の**判定ロジック**を呼ぶ。
   - guard の実体は hooksInstall.ts が `~/.openground/` に複製する `openground-guard.js`。
     その**ルールエンジンを関数として import 可能**にする小改修（判定部を pure 関数に
     切り出し、CLI エントリはそれを包むだけにする）を card A3-x として切る。
   - 利点: env ゲート・settings 依存・PATH 依存がゼロ。**テストが直接叩ける**。
     deny は callback の deny 返却（exit-2 相当）。
2. **fallback: `settingSources: ['user']`** — グローバル settings をロードさせ、
   既存 hook をそのまま発火させる（env ゲートは今と同一）。副作用として user 設定
   全般（他 hook・plugins）もロードされる — lean 哲学に反するため第一候補が原則。
3. **どちらでも**: `ensureGuardWiring` 相当の spawn 前検証を SDK 経路にも実装し、
   検証不能なら **GuardWiringError と同型で fail-closed**（PTY への自動 fallback は
   しない — ガード無し worker が黙って走る事故と、spawn が拒否される事故では
   後者を選ぶ。既存の掟と同じ）。
4. **W0/S0-A で確定済み（付録B-1）**: 前提は正しく（実 hook は SDK 経路で発火しない）、
   **第一候補は成立する**（programmatic deny は bypass 下で効き、subagent のツールも
   同じ hook を通る）。ただし —
5. ⚠ **hook が throw すると FAIL OPEN する（実測）**。したがって
   **hook 本体は必ず try/catch で包み、catch は deny を返す**。これを守らない実装は
   「自分のコードが壊れたら通す veto」になり、GuardWiringError の哲学に反する。
   W3/W5 の受け入れ基準に含める。
6. ⚠ **deny の成否を `permission_denials` で判定しない** — subagent 経路では
   阻止できていても空だった（実測）。判定は hook 側の記録で行う。

### 4-P. バージョン skew preflight

- SDK npm パッケージ（本書時点 0.3.220）はリポジトリに固定。ユーザーの claude CLI は
  自動更新で先行する。**CLI が SDK より新しい**のは想定内（プロトコルは initialize の
  capabilities で協調）。**CLI が floor（2.1.220）より古い**場合は SDK spawn を拒否し、
  その dispatch を PTY で行い、1回だけ通知（GuardWiringError の throttle と同じ 10min 型）。
- 実装: `sdkPreflight(claudeBin)` → `claude --version` 実行（既にある版数読み取りの
  流儀を再利用）→ semver 比較。結果は 5min キャッシュ。

---

## 5. センサー対応表（本書の心臓）

各行 = orchestrator が worker について知る必要がある1事実。**下流（カード列遷移・
冷却テーブル・通知）は一切変えない** — 変わるのは事実の取り方だけ。

| # | 知りたい事実 | PTY の取り方（現状） | SDK の取り方（本設計） | 状態 |
|---|---|---|---|---|
| S1 | 生きているか | getTerminal + 心拍鮮度 + JSONL mtime の合議（推測） | プール entry の stream open / closed。閉じた=死（確定） | ✅ |
| S2 | 作業中 or 入力待ち | `isGenerating(screen)`（footer 文字列 — 罠②の本文誤認あり） | ターン境界: input 送信済みで `turn_end` 未着=working / 着=waiting | ✅ |
| S3 | クォータ拒否（tier 帰属つき） | swarmRateLimitText の位置解剖（758行） | `sdkEvents.quota_refusal`: `turn_end.reason==='api_error'` + SDK export の refusal prefix 前方一致。tier は worker.model から（今と同じ帰属規則） | ✅ 材料実測 / 組み立ては新規 |
| S4 | rate limit の事前警告 | 無し（画面に出た時だけ） | `rate_limit_event`（utilization / resetsAt が**拒否の前に**流れる — 実測 0.55 を観測） | ✅ **新能力**: 冷却テーブルへ予防入力できる（stage 1 では記録のみ・挙動は変えない） |
| S5 | 自由記述の質問で止まっている | detectFreeTextQuestion（画面・fail-closed） | `turn_end(success)` 後 waiting + 最終 `text` を質問分類（**既存 swarmQuestions の判定文法をテキスト入力で再利用** — 画面行の代わりに発話テキストを渡す薄い adapter） | ☑ 判定関数は流用・入口だけ差し替え |
| S6 | 権限プロンプトで止まっている | detectMenu（backstop） | **backstop は不要かつ不可能** — bypass 下で `canUseTool` は呼ばれない（W0/S0-D 実測。SDK 自身が「bypass では PreToolUse hook を使え」と警告する）。ゲートは §4-G の hook 一本 | ✅ 解決（当初案は破棄） |
| S7 | 注入が着弾したか | bracketedPaste + 画面再読（§3.7・7回差し戻し） | `pushInput` の受理 = 着弾（キュー投入が同期确認）。**mid-turn 投入の意味論（キューされるか）は S0-B** | ⚠ S0-B |
| S8 | 停滞（長い1ターンの中で進んでいるか） | subagent JSONL の mtime | **併用**: lastEventAt（stream 由来・秒精度）+ 従来の subagent mtime（JSONL は SDK でも書かれる — resume 実測が間接証明。worktree cwd での書き出しは S0-C で直接確認） | ⚠ S0-C |
| S9 | 消費量（トークン/コスト） | JSONL の usage 行 | `turn_end.usage` の累積（`modelUsage` 込みで result に実測済み）。JSONL fallback 維持 | ✅ |
| S10 | コンテキスト残量 | JSONL 合算 + 画面 footnote | stage 1: JSONL 合算のまま（共通）。後続: `get_context_usage` 制御要求 | — 据え置き |
| S11 | 心拍（phase/note/readyToMerge） | worker が Bash で swarm-beat.sh | **不変**（worker の /order プロトコルはランタイム非依存） | ✅ 設計上不変 |
| S12 | 完了（commit 有無） | git（engine 側） | **不変** | ✅ |

**明示する差**: S3/S4 の worker 向け改善は **SDK worker にだけ**効く。PTY worker と
owner desk は従来センサーのまま（それらの改善は別トラック — INVESTIGATION の案2）。

---

## 6. 状態機械（sdkSession の status）

```
starting ──(system:init 受信)──▶ working ──(turn_end)──▶ waiting
   │                              ▲    │                    │
   │                              │    │(quota_refusal)     │(pushInput)
   │                              │    ▼                    │
   │                              │  quota-parked ◀─────────┘（engine が hold 処理）
   │                              └────────────(pushInput)──┘
   └─(spawn 失敗)─▶ failed
working/waiting ──(stream close: reason)──▶ exited { reason }
```

- `exited.reason` は `turn_end.reason`（`completed` / `aborted_streaming` / `api_error`）
  または `process-died`（result 無しで閉じた — 137 等）。
- **`interrupt()` 後の throw（`[ede_diagnostic]`）は正常系**として吸収し、
  `aborted_streaming` を exited/waiting の判定に使う（INVESTIGATION §3-A の罠:
  **`subtype` では判定しない**。本物のエラーでも `success` が来る）。
- `terminateSdkSession` = `abortController.abort()` + 子プロセス確認殺し
  （abort は result を返さない — 実測 — ので、これは「理由を問わない停止」専用）。

---

## 7. API / SSE 契約（types.ts 追加分）

```ts
// GET /api/sdk-session/:id/stream — SSE。data: SdkStreamFrame
export interface SdkStreamFrame { seq: number; ev: SdkEvent }
// 接続クエリ ?from=<seq> — ring buffer 内なら差分 replay、外なら全量 + {kind:'status'} 先頭
// POST /api/sdk-session/:id/input  { text: string }  → { ok: boolean; queued: boolean }
// POST /api/sdk-session/:id/interrupt               → { ok: boolean }
// DELETE /api/sdk-session/:id                        → { ok: boolean }

// SwarmWorkerRecord / OrchestratorWorker への追加（後方互換: absent = 'pty'）
runtime?: 'pty' | 'sdk'
sdkSessionId?: string
```

- ring buffer: 4,096 frame（worker の1タスク分の tool 呼び出し数を実測余裕で包含。
  超過時は先頭 drop + 接続時に `truncated: true` を初回 frame で通知）。
- 既存 SSE（terminal 用 sse.ts）の ACK フロー制御は**流用しない**（あれは xterm の
  描画背圧対策。構造化 frame は桁違いに軽い）。plain SSE + Last-Event-ID 相当の
  `from` パラメータのみ。

---

## 8. 設定ダイヤルと kill switch

```ts
// Settings（~/.openground/settings.json）
swarmWorkerRuntime?: {
  mode: 'pty' | 'sdk'      // 既定 'pty'（キー不在も 'pty'）
  sdkMaxWorkers?: number   // mode==='sdk' 時の SDK 起動上限。既定 1
}
```

- dispatch 時の決定: `mode==='sdk' && (現在生きている SDK worker 数 < sdkMaxWorkers)`
  なら SDK、そうでなければ PTY。**worker ごとに決めて roster に runtime を焼く**。
- kill switch = `mode:'pty'` に書き戻すだけ。走行中の SDK worker は完走（または
  手動 terminate）。roster の後方互換により復旧 boot も安全。
- UI: **実装済み(0.11.45)** — Swarm タブ → 司令官 → 右サイドバー「動かし方(お試し)」に
  worker / commander のトグル各1行（`SwarmManagerPane.tsx` の `runtimeDials`、書き込みは
  `SwarmModule.tsx` の `toggleRuntime` → `POST /api/settings`）。commander 側は ON のときだけ
  「スマホから届かなくなる」警告を出す（常時表示は壁紙になって読まれない）。
  - **設定ファイル直編集は「オーナー限定の実験」の解ではなかった** — 唯一 ON にできる人が
    JSON を手で書く必要がある状態は、機能スイッチではなく開発者向けメモである。
  - **踏みかけた罠**: `POST /api/settings` は `USER_SETTINGS_KEYS` で body を絞る。
    この2キーを配列に足すまで**書き込みは黙って捨てられていた**（スイッチは動いて見え、
    UI は ON を表示し、卓は全部 PTY で立つ。例外もログも出ない）。往復テストで固定:
    `server/routes/__tests__/settingsRuntimeDials.test.ts` は route に POST してから
    **spawn パスが実際に読む** `getWorkerRuntimeDial()` / `getManagerRuntimeDial()` で確認する。

---

## 9. 障害・復旧マトリクス

| 事象 | PTY 今日 | SDK 設計 |
|---|---|---|
| tsx watch reload | globalThis pool 生存 | 同（`__openground_sdk_sessions`） |
| サーバ full restart | PTY 子は死ぬ → boot 復旧（roster + 心拍 + resumable probe → adopt/resume/blocked 判定） | SDK 子も死ぬ → **同じ復旧路**: roster の runtime==='sdk' entry → JSONL resumable probe（既存 swarmSessions の述語を流用）→ `resume` + WORKER_RESUME_INJECTION を最初の input として push。**recoveryColumn（commitsAhead>0 → blocked）は不変** — twin 増殖の根治規則を SDK でも通す |
| OOM / 外部 kill（137） | `{exitCode:137, signal:0}` シェル中継の読み（実測済みの罠） | stream close（result 無し）→ `exited{process-died}`。**シェル中継の解釈問題が消滅** |
| クォータ壁（mid-turn） | 画面文言 → hold+requeue+冷却 | `quota_refusal` event → 同じ hold+requeue+冷却（tier=worker.model） |
| interrupt | SIGINT 相当の画面操作は無し（kill のみ） | graceful `interrupt()` が**新規に手に入る**（差し戻し時に「殺さず止めて指示」が可能 — stage 1 では従来同様 kill を既定、interrupt は手動ボタンのみ） |
| SDK パッケージの破壊的変更 | — | 影響面は sdkSession.ts に閉じる（bridge の @alpha は**使っていない** — query() 本体は semver 通常運用）。CI: SDK バージョンは lockfile 固定・更新は手動 PR |
| ガード検証不能 | GuardWiringError fail-closed | 同型で fail-closed（§4-G-3） |

---

## 10. セキュリティ不変条件（変更禁止リスト）

1. `validateProjectPath` を新 route 全部に通す（§3.5）。
2. worker の veto（A3/L4）は **fail-closed**。検証不能なら spawn しない。
3. `strictMcpConfig` + `mcpServers:{}` を SDK worker でも必ず設定（mcp__* RCE 経路の封鎖）。
4. `pathToClaudeCodeExecutable` 必須（同梱バイナリ起動の禁止 — subscription-only の柱）。
5. SDK session の input route は**平文コマンド実行口ではない**（claude への発話のみ）。
   guard が Bash を veto する構造は PTY と同一に保たれる。
6. env から `CLAUDE_CODE_*` / `CLAUDECODE` を strip（検証系の既知汚染）。
7. OG API は 127.0.0.1 bind・無認証のまま**外に出さない**（INVESTIGATION §13-C）。

---

## 11. Stage-0 スパイク（本実装前に実測で潰す・各 ≤1h）

すべて **repo 内 `scripts/probe-sdk-*.mts`** として書き、結果を本書の付録に追記する
（scratchpad は消える — 過去の掟）。捨てセッション・捨て worktree・HOME 隔離不要
（読み取り専用 or deny 検証のみ）だが、**書込み系の検証は必ず隔離 HOME**（0727 の
本番 settings.json 破壊事故の掟）。

| ID | 問い | 合否基準 | 依存カード |
|---|---|---|---|
| S0-A | SDK `Options.hooks.PreToolUse` の deny は bypass 下で本当にツールを止めるか。callback 例外時に fail-open しないか | 隔離 HOME で guarded-write が deny され、例外注入時も実行されない | A3-x, C |
| S0-B | mid-turn の `pushInput` はキューされるか（喋っている worker への注入意味論） | 生成中に送った message が現ターン終了後に処理される（or 明確な reject が返る）ことの確認 | E |
| S0-C | worktree cwd での JSONL 書出し・subagent dir・effort enum・`bypassPermissions` 表記 | worktree パスで sessionJsonlPath が実在 / effort:'max' が argv/挙動に反映 | C, E |
| S0-D | bypass 下で `canUseTool` は発火しないか | 発火ゼロ（発火したら allow-all backstop の必要性が確定） | C |
| S0-E | `USAGE_LIMIT_ERROR_PREFIXES` が runtime import で取れるか（型だけでなく実体） | import して配列が得られる | A |

---

## 12. 並列実装カード（Opus worker 用・disjoint 分割）

**掟**: 各カードは自分の worktree で完結し、**下記のファイル集合以外に触らない**
（disjoint 分割が最大レバー — 既存メモリ）。カード本文には本書 §番号を参照として貼る。
成果の最終配置先は各カードに明記済み。

| カード | 内容 | 触るファイル（新規◎/変更△） | 依存 |
|---|---|---|---|
| **W0** | S0-A〜E スパイク実測 + 本書付録に結果追記 | ◎scripts/probe-sdk-*.mts ／ △docs/SDK_WORKER_MIGRATION_PLAN.md（付録のみ） | なし・**最初** |
| **W1** | sdkSession プール + sdkEvents 蒸留 + 単体テスト | ◎src/lib/server/sdkSession.ts ◎sdkEvents.ts ◎*.test.ts ／ △package.json（SDK 依存追加） | W0(E) |
| **W2** | HTTP/SSE route + types 追加 + route テスト | ◎server/routes/sdkSession.ts ／ △server/app.ts（mount 1行） △src/lib/types.ts（§7 の追加分のみ） | W1（型は先行 stub 可） |
| **W3** | guard のルールエンジン切り出し（判定 pure 関数化・CLI ラッパ据え置き）+ 既存 guard テスト全緑 | △openground-guard.js の実体（hooksInstall 管理下）＋◎切出しモジュール＋△hooksInstall.ts | W0(A) |
| **W4** | WorkerRuntime アダプタ抽出（**pty 実装のみ・挙動変更ゼロ**）。orchestrator の worker 文脈直呼びを adapter 経由に ⚠**実測では ~20 ではなく 71 箇所あった**。W4 では seam 新設と deps 2本のみとし、鍵の `workerKey()` 化は SDK が実在して各箇所を SDK 込みで判断できる W6a に送った(盲目的な一括置換で「挙動不変」と主張しない) | ◎src/lib/server/workerRuntime.ts ／ △swarmOrchestrator.ts △swarmEscalations.ts（worker inject 経路のみ） | なし（並行可） |
| **W5** | swarmWorkerSdk（options builder + preflight + ガード配線）+ テスト | ◎src/lib/server/swarmWorkerSdk.ts ◎*.test.ts | W1, W3, W0(C/D) |
| **W6** | sdk runtime の dispatch 配線 + roster runtime フィールド + 復旧路 + kill switch 設定 | △swarmOrchestrator.ts（dispatch/recovery） △swarmWorkerRoster.ts △swarmWorker.ts（spawn 分岐） △types.ts（Settings） | W4, W5 |
| **W7** | SdkWorkerPane + SwarmModule 差し込み + i18n | ◎src/components/canvas/modules/SdkWorkerPane.tsx ／ △SwarmModule.tsx △i18n | W2 |
| **W8** | commander docs 追随（02-worker-lifecycle 他該当章）+ MAP.md §5 | △docs/commander/* △docs/MAP.md | W6 完了後 |

**W4 と W6 は同一ファイル（swarmOrchestrator.ts）を触るため直列**。それ以外は並列可。
推奨波: 第1波 {W0, W4} → 第2波 {W1, W3} → 第3波 {W2, W5} → 第4波 {W6} → 第5波 {W7, W8}。

**統合ゲート（全カード共通・司令官が enforce）**:
- `npx tsc --noEmit` clean（完了ゲートの掟）
- 該当テスト + `src/testHomeEnvGuard.test.ts` green（HOME 柵の掟）
- swarm 安全網回帰スイート green
- W4 は「既存テスト全緑」自体が受け入れ基準（挙動変更ゼロの証明）
- eslint 変更ファイル 0 error

**実機受け入れ（全波後・オーナー環境の test プロジェクトで）**:
1. `mode:'sdk', sdkMaxWorkers:1` で toy カード1枚を dispatch → SDK worker が
   worktree で /order を回し、心拍・commit・review 遷移まで完走する
2. 同時に PTY worker 1体を並走させ、roster/UI/統合が混在で正しい
3. サーバ再起動 → SDK worker が resume 復旧 or blocked 退避（twin が生えない）
4. kill switch（mode:'pty' へ）→ 次 dispatch が PTY に戻る

---

## 13. テスト方針（要点のみ — 各カードのテストは §12 に内包）

- **実 claude をテストで spawn しない**。sdkSession は queryFn 注入、
  swarmWorkerSdk は builder の純関数テスト、orchestrator は fake WorkerRuntime。
- fixtures は**この調査の実測キャプチャ**から起こす（result / rate_limit_event /
  api_error / interrupt throw の実形状）。**fixture は live の証拠ではない**旨を
  ファイル頭に明記（claudeUsageCli の教訓を反復しない）。
- 負荷 flaky 対策: 新テストは fake timer / 決定論 I/O のみ。testTimeout 既定に依存する
  長い実時間待ちを書かない（vitest 5s 既定の既知の罠）。

---

## 13-B. stage 3 — 司令官の SDK 化（2026-07-31 完了・既定 OFF）

前提だった「補給官＝電話窓口の役割拡張」を先に済ませ（下記 A）、その上で司令官を
移した（B）。ダイヤルは **`Settings.swarmManagerRuntime.mode`（既定 `'pty'`）** で
worker のダイヤルとは**別**：回すと失うものが違うから分けてある。

### A. 補給官が電話窓口になる（PTY のまま）

外から要るのは**監視と注文だけ**なので、リモコンの効く卓が1つ残れば足りる。補給官には
`todo` に積む役目しか無かったので、**読み取り専用の状況報告**と**司令官への中継**を足した
（`skills/supply/SKILL.md`）:

| 語彙 | 何をする | 書き込み |
|---|---|---|
| 「状況」 | workers / orchestrator / project / escalations を GET → 平易な日本語に読み替え | なし |
| 「質問に答える」 | `escalations?status=open` の `plainQuestion` を読み上げ → `answer` を投函 | ユーザーの判断のみ |
| 「司令官に伝えて」 | `POST /api/swarm/manager/say` で1文中継（卓は立てない） | なし |

境界は変えていない：**列を進めない・worker を起こさない・エンジンを触らない**。目と口
であって手ではない。

⚠ **配信路が壊れていた**（同日に発見・根治）。`~/.claude/skills/{order,supply}` と
`swarm-beat.sh` は marker 導入前に手配備された無マーカー版で、kept-user シールドに
恒久的に守られていた ⇒ 0722 に出した「tmux 依存の除去」が9日間実機に届いておらず、
補給官は「あなたは tmux コックピットの `Ctrl-b 2` に居る」と書かれた手順書を読んでいた。
`installManagedFile` の `adoptDigests`（自分の出力だと**名指しできるバイト列**だけ adopt）
で根治。確認は `npx tsx scripts/verify-skill-install.mts`。

### B. 司令官の SDK 化

先に実測してから作った（推測で作らない）:

| 問い | 実測 | 出典 |
|---|---|---|
| SDK セッションで `/og-manage` は解決するか | **する**。slash commands 95 本に在り、`Skill` ツールも出る。最初のメッセージに `/og-manage` を渡すと実際に読み込み、禁止 git 操作を verbatim で答えた | `scripts/probe-sdk-skill-resolution.mts` |
| Claude Code の system prompt は付くか | **付かない**（「You are a Claude agent, built on Anthropic's Claude Agent SDK」）。`preset:'claude_code'` を渡しても同じ | `scripts/probe-sdk-system-prompt.mts` |
| `append` は届くか | **届く**（トークン往復で確認）⇒ app-context カードはこれで明示注入 | 同上 |
| argv / stdin 捕捉で分かるか | **分からない**。system prompt は argv に乗らず、SDK は CLI のハンドシェイク応答後にしか options を送らないので、スタブプロセスでは何も観測できない | 同上（失敗も記録） |

seam と非自明点:

- **`swarmManagerRuntime.ts` が「卓は在るか・話しかけられるか」の唯一の窓口**。PTY プール
  と SDK プールの**両方**に聞く。⚠ 片方だけ見る実装に戻すと、SDK 卓が毎パス `absent` と
  読まれ 5 分ごとに二卓目が立つ（0719 の11卓事故と同じ形を、今度は構造として作り込む）。
- **ガードは張らない**（worker 限定スコープ）。司令官に veto を付けると PTY 司令官より
  厳しくなり、統合そのものである `git push origin HEAD:main` が止まる。preflight も
  バイナリ＋バージョンだけ（`sdkClaudeBinaryPreflight`）。
- **声かけから ESC ダンスが消える**。PTY 側は「画面を読んで打ちかけでないか判定 → ESC で
  下書きを消す → 本文 → Enter」で、しかも着弾は確認できない。SDK 側は push 1 回で、
  受理は同期で分かる（mid-turn でも CLI がキューする実測済み）。
- **クォータ停止はイベント源で拾う**（`sdkDeskLimit.ts`）。静穏窓・確認窓・3読み再武装は
  持たない — あれは「絵を読む」代償。文言判定と通知本文は PTY 側と共有する。
- **リモコンは消える**。これがこの移行で**唯一本当に失うもの**で、A がその代替。
- 失敗時は**必ず PTY に降りる**（preflight 不通・spawn 失敗・即 failed）。「司令官が居ない」
  は「司令官が PTY」より悪い。

残件: 実機受け入れ（ダイヤル ON → 卓が立つ → 「状況」が返る → スマホから補給官経由で
監視と注文）。**ダイヤルは 0.11.45 で UI に出た**ので、受け入れ手順から「settings.json を
手で書く」が消えた（§8）。

### 13-C. 文脈が満杯になったらどうなるか（0.11.45 で「見える」に変えた）

長時間走る卓——とりわけ司令官——について**唯一残っていた未実測**が「context が満杯に
なったら？」だった。答えは CLI 側にあり、**`compact_boundary` が streamed message union に
入っている**（`SDKCompactBoundaryMessage` — `trigger:'auto'|'manual'` と前後トークン数つき）。

そこで取った立場: **「auto-compact は効くはず」と主張するのではなく、起きたら見えるようにする。**
`sdkEvents.ts` が `system/compact_boundary` を `{kind:'compact'}` に蒸留し、卓の記録に
「これまでの記憶を要約して空きを作りました — 128k → 31k」と1行出る。
*見張れる未知は、見張れない未知とは別のリスク*である。

実装上の判断:
- 壊れた boundary でも**必ず1件出す**（数値は装飾・「要約された」という事実が本体。
  それを落とすと読み手は「なぜ卓が忘れたのか」を延々と探す）。
- `post_tokens` 欠落は **null で、0 ではない**（「不明」と「全部要約した」を混ぜない）。
- 未知の `trigger` は verbatim（`'auto'` に丸めない — claudeScreen 罠④と同じ轍）。
- `statusAfter` は null（ターン内の記帳であってライフサイクル遷移ではない。
  waiting に落とすと作業中の卓を空きと誤認する）。

---

## 14. 非目標と後続トラック

1. ~~**manager / supply の SDK 化** — stage 3~~ → **完了（§13-B・2026-07-31）**。
   supply は SDK 化**しない**（PTY のままが要件 — 電話窓口）。
2. **スクレイプ 2,461 行の削除** — SDK worker が実運用で S3/S5/S7 を置換したと
   確認できるまで凍結。owner desk 系（ownerDeskLimit / swarmRateLimitText の
   desk 腕）は **補給官が PTY である限り恒久的に現役** — 司令官が SDK に移っても
   消えない（消せると読んだら §13-B を読み直すこと）。
3. **owner desk 向けの JSONL センサー移行（案2）** — 本書と独立に価値が残る
   （`isApiErrorMessage` 実測済み）。別カードで随時。
4. **sandbox 実験 × SDK の併用** — Seatbelt wrap を SDK spawn に噛ませる設計は別途。
5. **配布 / 規約** — support 記事 15036540 の凍結バナーが外れたら再訪。
   swarm を一般開放する時が申請の時（INVESTIGATION §12-E の作法で）。

---

## 付録A. 本設計が依拠する実測（詳細は SDK_CLIENT_INVESTIGATION.md）

- 双方向多ターン / resume 6.0s / interrupt の judge は `terminal_reason`（subtype は罠）
- subagent 承認は親 canUseTool に agentID 付きで届く / 2クライアント同時接続で JSONL 無傷
- `apiKeySource:"none"`（サブスク認証のまま）/ SDK は `-p` ではなく stream-json 双方向
- SDK 既定は同梱バイナリ起動 → `pathToClaudeCodeExecutable` で回避実測済み
- `USAGE_LIMIT_ERROR_PREFIXES` 等が sdk.d.ts に export されている（runtime 実体は S0-E）
- 直近の大規模修正 5 本（434/447/365/345/275 行）の震源は「プロセス外からの推測」
  — S1/S2/S7 の確定化はそのうち3本に直接効く

## 付録B. スパイク結果（W0・2026-07-30 実測）

スクリプト: `scripts/probe-sdk-guard-hooks.mts` / `scripts/probe-sdk-session-semantics.mts`

### B-1. S0-A ガード（`probe-sdk-guard-hooks.mts`）

| 測定 | 結果 |
|---|---|
| CONTROL（hook 無し） | ファイル書けた ⇒ プローブは有効 |
| **P（前提）** `OPENGROUND_GUARD=1` + 書込ルート別所・programmatic hook 無し | **実 hook は発火せず、書けてしまった** ⇒ **§4-G の前提は正しい。SDK は filesystem settings をロードしない。素朴に spawn した worker は無防備** |
| **A1** programmatic hook が deny | **`hookFired=1` / 書けず / `denials=["Write"]`** ⇒ **bypass 下でも deny は効く** |
| **A2** subagent が発行した Write | **`hookFired=2` / うち `fromSubagent=1` / 書けず** ⇒ **subagent のツールも同じ hook を通る**（`agent_id` で識別可） |
| **A3** hook が throw | **書けてしまった** ⇒ ⚠ **FAIL OPEN** |

**A3 が本スパイクの収穫**。hook 実装が例外を投げると veto が消える。
⇒ **実装要件（W3/W5 の受け入れ基準に入れる）**: hook 本体は必ず try/catch で包み、
**catch 節は deny を返す**。「自分のコードが壊れたら通す」veto は veto ではない。

補足: A2 では書込みは阻止されたが `permission_denials` は空だった。
**deny の成否を `permission_denials` で判定してはいけない**（subagent 経路では載らない）。

### B-2. S0-D 権限コールバック（`probe-sdk-session-semantics.mts`）

`canUseTool` は **1回も発火しなかった**。SDK 自身が起動時に警告を出す:

> `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked:
> permissionMode 'bypassPermissions' auto-approves every tool call … **To gate
> every tool call, use a PreToolUse hook instead.**`

⇒ **§5 S6 の「allow-all `canUseTool` backstop」は成立しない**（呼ばれないので
tripwire にすらならない）。設計から削除し、§4-G の hook 一本に寄せる。
なお **SDK 公式が「bypass 下のゲートは PreToolUse hook を使え」と明言**しているので、
§4-G の第一候補は一次情報に支持されている。

### B-3. S0-B 生成中の注入

生成中（カウント途中）に `pushInput` した指示は **キューされ、当該ターン終了後の
turn 2 で処理された**（`markB=true`）。
⇒ **§5 S7 成立**。bracketed paste + 画面再読（7回差し戻された機構）は不要。

### B-4. S0-C セッション/パス/effort

- `sessionId` は指定どおり採用された（JSONL 名の決定論は維持）
- `effort:'max'` は受理（init には echo されない）。型にも `'max'` あり
- `permissionMode` の SDK 表記は **`'bypassPermissions'`**（型で確定）
- **JSONL は書かれていた** — ただし当初「無い」と誤判定した。原因は SDK ではなく
  **OG 側 `claudeDirName` の実バグ**（`_` を置換していなかった）。
  → 別コミット `dbba9e55` で根治（規則は `[^a-zA-Z0-9]`→`-`、実測で確定、
  ミラー3箇所を統一）。**S8 の停滞プローブはこの修正の上に乗る**

### B-5. S0-E 定数の runtime import

`USAGE_LIMIT_ERROR_PREFIXES`（**12 件**）/ `USAGE_WARNING_PREFIXES`（**2 件**）
ともに実体を import できた。先頭3件:
`["You've hit your","You've reached your","You're out of usage credits"]`
⇒ **§3.3 のクォータ判定はこの配列を正典にできる**（自前の文字列表を持たない）。

### B-6. 認証まわりの注意（W1/W5 のテスト設計に効く）

隔離 HOME では **認証できない**。macOS は OAuth トークンを Keychain に置くが、
CLI は `~/.claude.json` の `oauthAccount` レコードも見ており、素の HOME では
`Not logged in · Please run /login` になる（`oauthAccount`/`userID` を種として
書いても解消しなかった）。
⇒ **実 claude を起動するテストは書かない**（設計 §13 の方針どおり `queryFn` 注入）。
実起動が要る検証は本付録のプローブ側で行い、単体テストには持ち込まない。
