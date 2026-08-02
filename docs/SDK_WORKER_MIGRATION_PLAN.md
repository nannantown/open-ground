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
> **既定は 2026-08-01 に SDK へ反転した**（キー不在 ⇒ `'sdk'` /
> 明示 `'pty'` ⇒ pty＝キルスイッチ健在 / 壊れた値 ⇒ pty / **読めないファイル ⇒ pty**）。
> ⚠ **反転が dispatch に届いたのは 2026-08-02**：規則は `chooseWorkerRuntime` に入ったが、
> 本番の唯一の呼び出し（`swarmWorker.ts`）は `store.getWorkerRuntimeDial()` を通して渡し、
> **その reader が不在を明示 `{mode:'pty'}` へ潰していた**ので、未設定の機体は PTY worker を
> 立て続けた（隔離 HOME で実測 0802・**0.11.47 に出荷済み**）。盤面は不在を `'sdk'` と描くので
> **表示と実効が逆**だった。修正は reader を司令官側と同じ極性（不在 ⇒ sdk）に揃えること、
> および**盤面が導出をやめてサーバの実効値を描く**こと（`GET /api/settings` の
> `runtimeDialsEffective` — §8 の UI 項）。
> **教訓**: 番人が `chooseWorkerRuntime` を**直接**叩き、パネルから写した `dialOf` と
> 比べていたため、「防いだ」と宣言している欠陥が現実に存在したまま緑だった。
> 番人（`swarmRuntimeDialParity.test.ts`）は**合成経路**（reader → 決定）と**パネルに配られる値**を
> 比べる形に付け替えた。
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
設定ダイヤルで worker 単位に選べる。既定は 0801 に反転しキー不在 ⇒ `'sdk'`
（reader まで届いたのは 0802 — 冒頭の注記）。`'sdk'` を
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
| 置換か併存か | **併存**（runtime ダイヤル・0730 時点の既定 pty → 0801 に「不在⇒sdk」へ反転） | 戻すときに困るのは途中状態。git revert でなく設定切替で戻れる形に |
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
  `interruptSdkSession(id)`（graceful・turn 停止。**セッションは生き延びる** — §6 の
  0801 実測） / `terminateSdkSession(id)`（**「頼む」だけ**。`closed` を立てて
  `interrupt()` を投げ、status を `exited` に**同期で**倒す。abort はしない） /
  `getSdkSession(id)` / `listSdkSessions()`。
- **生死の述語は `isSdkSessionLive(s)`（= `!reaped`）が唯一。** `status` は生死ではなく
  「何を頼んだか／何を見たか」の記録で、terminate 直後は claude がまだ unwind 中でも
  `exited` になっている。reap 待ちは `isSdkSessionReaped(id)`（pump の `finally` でだけ立つ）。
  この2つを混同した seam が 0801 の一連のレビューで少なくとも9件出た（`docs/MAP.md` §5）。
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
| S1 | 生きているか | getTerminal + 心拍鮮度 + JSONL mtime の合議（推測） | **`isSdkSessionLive(s)` = `!reaped`** ＝ pump のイテレータが実際に返ったか。⚠ **当初この欄は「closed = 死（確定）」と書いており、それが 0801 に少なくとも9件の無言欠陥を生んだ。** `closed` / `status:'exited'` は `terminateSdkSession` が**同期で立てる「頼んだ」印**で、その裏の claude はまだ unwind している。死んだと読んだ側は worktree を消しにいく | ✅（述語は1つに集約済み。棚卸しと数え方は `docs/MAP.md` §5） |
| S2 | 作業中 or 入力待ち | `isGenerating(screen)`（footer 文字列 — 罠②の本文誤認あり） | ターン境界。⚠ **「メッセージが来た＝作業中」ではない** — CLI はターンの合間にも喋る（`background_tasks_changed` / `session_state_changed`）。それで working に上げると**終わるターンが無いので二度と waiting に戻らない**。昇格は**仕事の証拠**（`isWorkEvidence`）に限る。⚠ **terminate は遷移の終端**（`closed` 後は emit だけ）。ただし中断ターンの `aborted_streaming` は読む — 落とすと正常停止が全部 `failed` 表示になる | ✅（0801 の4〜6周目で3回作り直した箇所） |
| S3 | クォータ拒否（tier 帰属つき） | swarmRateLimitText の位置解剖（758行） | `sdkEvents.quota_refusal`: `turn_end.reason==='api_error'` + SDK export の refusal prefix 前方一致。tier は worker.model から（今と同じ帰属規則） | ✅ 材料実測 / 組み立ては新規 |
| S4 | rate limit の事前警告 | 無し（画面に出た時だけ） | `rate_limit_event`（utilization / resetsAt が**拒否の前に**流れる — 実測 0.55 を観測） | ✅ **新能力**: 冷却テーブルへ予防入力できる（stage 1 では記録のみ・挙動は変えない） |
| S5 | 自由記述の質問で止まっている | detectFreeTextQuestion（画面・fail-closed） | `turn_end(success)` 後 waiting + 最終 `text` を質問分類（**既存 swarmQuestions の判定文法をテキスト入力で再利用** — 画面行の代わりに発話テキストを渡す薄い adapter） | ☑ 判定関数は流用・入口だけ差し替え |
| S6 | 権限プロンプトで止まっている | detectMenu（backstop） | **backstop は不要かつ不可能** — bypass 下で `canUseTool` は呼ばれない（W0/S0-D 実測。SDK 自身が「bypass では PreToolUse hook を使え」と警告する）。ゲートは §4-G の hook 一本 | ✅ 解決（当初案は破棄） |
| S7 | 注入が着弾したか | bracketedPaste + 画面再読（§3.7・7回差し戻し） | `pushInput` の受理 = 着弾（キュー投入が同期確認）。mid-turn 投入がキューされ次ターンで処理されることは **W0/S0-B で実測済み**（付録 B-3・本番構成の AsyncIterable prompt で測定） | ✅ 解決。⚠ **ただし「受理」は API の話で、UI はそれを取りこぼしうる** — タイルが POST の**前**に入力欄を空にしていたため、409 で拒否された投入が無言で消え、オーナーは届いたと信じていた（0801 修正）。同期で受理が分かる利点は、**失敗を表示して初めて**利点になる |
| S8 | 停滞（長い1ターンの中で進んでいるか） | subagent JSONL の mtime | **併用**: lastEventAt（stream 由来・秒精度）+ 従来の subagent mtime（JSONL は SDK でも書かれる — resume 実測が間接証明。worktree cwd での書き出しは S0-C で直接確認） | ✅ 解決（付録 B-4。当初「JSONL が無い」と誤判定した原因は SDK ではなく OG 側 `claudeDirName` の実バグで、`dbba9e55` で根治済み） |
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
- **【2026-08-01 実測で訂正】`interrupt()` はセッションを終わらせない。**
  当初この行は「`interrupt()` 後の throw（`[ede_diagnostic]`）は正常系として吸収する」と
  書いていた。**因果が逆だった。** 認証もクォータも要らない protocol-speaking の偽 CLI で
  実測（`scripts/probe-sdk-interrupt-survival.mts`）した結果:
  - CLI が生きている限り `interrupt()` は**走っているターンだけ**を中断し、
    `aborted_streaming` の result を届け、**async iterator は終わらない**。
    その後に push したターンは完走する（= UI の「セッションは続きます」は真）。
  - throw は **claude プロセスが死んだとき専用**。SDK は子プロセスの終了でしか自分の
    iterator を終わらせず、その終了エラーの本文を**直前のエラー result の文言に貼り替える**
    ので、例外が `[ede_diagnostic] …` と読めて interrupt が原因に見える。
  - 0730 のスパイクが逆の結論を出したのは、**`prompt` に文字列を渡していた**から。
    SDK は `typeof prompt === 'string'` で `isSingleUserTurn` を立て、最初の result で
    CLI の stdin を閉じる ⇒ **その構成では CLI は必ず死ぬ**。本番は AsyncIterable
    （`sdkSession.makeInputIterable`）で、これは**別の構成**である。
  - ⚠ **測ったのは偽 CLI に対してであり、本物の `claude` に対してではない**（0801 の
    点検で追記）。プロトコルが同じなので **SDK クライアント側の性質**（子が生きていれば
    iterator は終わらない／throw は子の死に紐づく）は転用してよいが、
    **「本物の `claude` が interrupt 後も生き続けるか」は未確認**。本物が終了を選ぶなら
    本番はケース B に落ちる。隔離 HOME では認証できない（付録 B-6）ための意図的な未測定 —
    付録 C の該当行を参照。
  - ⚠ 教訓（このファイル全体に効く）: **本番と同じ構成で測る**。
    auto-memory `reference_measure_the_production_arrangement` と同型の踏み方で、
    ここでは「測り方の違い」が**因果の向きを反転させて確信させた**。
  - なお `aborted_streaming` を判定に使う点と、**`subtype` では判定しない**という
    INVESTIGATION §3-A の罠（本物のエラーでも `success` が来る）は変わらず有効。
  - 副産物として本物の欠陥が1件出た: 中断の記録が**生涯フラグ**（`sawAbort`）で、朝
    interrupt した卓が昼にクラッシュしても「綺麗に止めた」と記録されていた。
    「直前のイベントが aborted な `turn_end` か」へ縮めてある。
- **`terminateSdkSession` の実体は abort ではない**（設計当初は
  `abortController.abort()` + 子プロセス確認殺しと書いていた）。現物は
  ① `closed = true` ② 入力待ちの wake を叩き起こす ③ `handle.interrupt()` を投げっぱなし
  ④ `exitReason ??= 'terminated'` ⑤ `setStatus(e,'exited')`。
  ⚠ **⑤は同期**である。**「頼んだ」だけで claude はまだ unwind 中**なので、
  status を生死判定に使うと片付け中の卓が「もう居ない」と読まれる。
  生死は `isSdkSessionLive`（= `!reaped`）、reap 待ちは `isSdkSessionReaped`。
  この2つを取り違えた seam が0801 の一連のレビューで少なくとも9件出ている（棚卸しと数え方は
  `docs/MAP.md` §5 — **数ではなく数え方**を置いてある）。

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
  mode: 'pty' | 'sdk'      // キー不在 ⇒ 'sdk'（2026-08-01 反転）
                           // 明示 'pty' / 壊れた値 ⇒ 'pty'
  sdkMaxWorkers?: number   // mode==='sdk' 時の SDK 起動上限。既定 1
}
```

- ⚠ **規則は `chooseWorkerRuntime` だけでは効かない**: `swarmWorker.ts` は
  `store.getWorkerRuntimeDial()` を挟んで渡すので、**dispatch を決めるのはその reader**。
  0801〜0802 の間 reader は不在を明示 `{mode:'pty'}` に潰しており、反転が dispatch まで
  届いていなかった（実測 0802・0.11.47 出荷）。**両者は同じ極性に揃えてある** — 明示 ⇒ その
  ランタイム / 不在 ⇒ sdk / それ以外 ⇒ pty。片方だけ動かさないこと。
- ⚠ **FILE レベルは別規則**: `settings.json` が読めない / parse 不能 / 非オブジェクトなら
  **どちらのダイヤルも `'pty'`**（`sdkMaxWorkers` も落ちる）。反転前は「不在の既定がたまたま
  pty」だったので偶然一致していたが、その偶然は 0802 に消えた。番人は
  `src/lib/server/runtimeDialFileHealth.test.ts`。
- dispatch 時の決定: `mode==='sdk' && (現在生きている SDK worker 数 < sdkMaxWorkers)`
  なら SDK、そうでなければ PTY。**worker ごとに決めて roster に runtime を焼く**。
- kill switch = `mode:'pty'` に書き戻すだけ。走行中の SDK worker は完走（または
  手動 terminate）。roster の後方互換により復旧 boot も安全。
- UI: **実装済み(0.11.45)** — Swarm タブ → 司令官 → 右サイドバー「動かし方(お試し)」に
  worker / commander のトグル各1行（`SwarmManagerPane.tsx` の `runtimeDials`、書き込みは
  `SwarmModule.tsx` の `toggleRuntime` → `POST /api/settings`）。
  - ⚠ **盤面は導出せずサーバの実効値を描く(2026-08-02)** — `GET /api/settings` が
    `runtimeDialsEffective: { worker, manager, workerCap }` を返し、`SwarmModule` はそれを
    そのまま表示する。値は**dispatch / 卓起動が実際に使う読み手**
    （`store.getWorkerRuntimeDial()` / `getManagerRuntimeDial()`）から取る。
    以前はパネル側が生キーからサーバ規則を再実装（`dialOf`）しており、**0802 だけで表示ズレを
    2件**産んだ: ①不在の worker ダイヤルを ON と描くのに dispatch は PTY
    ②壊れた `settings.json` で ON と描くのにサーバはキルスイッチ側。②は生キーからは原理的に
    直せない（寛容リーダーは「未記入」と「読めない」を同じ**キー不在**として返すが、
    両者の解決先は逆）。`dialOf` は削除済み — 復活させないこと。
    ⚠ **読み取り専用**: `runtimeDialsEffective` は `USER_SETTINGS_KEYS` に**足さない**
    （`suggestedDisplayName` と同じくサーバ計算のレスポンス専用フィールド）。
    サーバが答えない/壊れた形なら盤面は `null` = **トグルを disabled** にする（推測しない）。
  commander 側は ON のときだけ
  「スマホから届かなくなる」警告を出す（常時表示は壁紙になって読まれない）。
  - **設定ファイル直編集は「オーナー限定の実験」の解ではなかった** — 唯一 ON にできる人が
    JSON を手で書く必要がある状態は、機能スイッチではなく開発者向けメモである。
  - **`sdkMaxWorkers: 0` は意味のある値**（「ダイヤルは sdk だが SDK worker は1体も使わない」）。
    0 を falsy として捨てると**既定 1 に戻る** — UI は 0 を表示したままサーバは1体立てる、という
    「表示と実体が食い違う」形になる（0801 に実際に作った。`store.ts` で修正済み）。
    設定値のバリデーションで `value || default` を書くと、境界値が黙って消える。
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
| interrupt | SIGINT 相当の画面操作は無し（kill のみ） | graceful `interrupt()` が**新規に手に入る**（差し戻し時に「殺さず止めて指示」が可能 — stage 1 では従来同様 kill を既定、interrupt は手動ボタンのみ）。**0801 実測でセッションが生き延びることを確認**（§6・`probe-sdk-interrupt-survival.mts`）: ターンだけ中断され iterator は続き、後続ターンは完走する |
| **配布ビルドでだけ SDK worker が0体**（0801 実観測・`dd311acc`） | — | `import.meta` は esbuild の CJS 出力に存在せず `{}` に置換される ⇒ `createRequire(import.meta.url)` が `createRequire(undefined)` = **TypeError**。guard hook は fail-CLOSED なので preflight が全部落ちる。**dev(ESM)と vitest(ESM)では 100% 再現しない**。恒久策 = require のベースをロード対象の絶対パスにする＋ビルドの banner で `pathToFileURL(__filename).href` を define。番人 `sdkGuardBundleShape.test.ts` は**実際に esbuild へ食わせて**確かめる |
| オーナーが「SDK にしたのに PTY で上がる」理由を知れない | — | 降格理由は `SpawnSwarmWorkerResponse.fellBackBecause` に載せて UI が出す。**配布アプリのサーバは fork された子プロセスなので `console.warn` はどこにも届かない** — ログだけに置く設計は「理由が表示されるから枠を1つ握る設計を受け入れた」という前提を静かに無効化する |
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

## 13-B. stage 3 — 司令官の SDK 化（2026-07-31 完了・既定は 2026-08-02 に SDK へ反転）

前提だった「補給官＝電話窓口の役割拡張」を先に済ませ（下記 A）、その上で司令官を
移した（B）。ダイヤルは **`Settings.swarmManagerRuntime.mode`（不在 ⇒ `'sdk'`・
明示 `'pty'` と壊れた値 ⇒ `'pty'`）** で
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

> ### ⚠ この付録を読む前に — **測った構成を確認すること**（2026-08-01 追記）
>
> この付録の主張は1件が**実測で覆っている**（§6 の interrupt）。原因は SDK の挙動ではなく
> **スパイクが本番と違う構成を測っていた**こと。`query({ prompt })` に何を渡したかで
> セッションの寿命が変わる:
>
> | prompt | SDK の解釈 | CLI の寿命 | 本番か |
> |---|---|---|---|
> | **文字列** | `isSingleUserTurn = true` | **最初の result で stdin を閉じる ⇒ 必ず死ぬ** | ✗ |
> | **AsyncIterable** | 多ターン双方向 | 明示的に閉じるまで生きる | ✓（`sdkSession.makeInputIterable`） |
>
> したがって: **string prompt で測った結果から「セッションの寿命」「2ターン目以降」
> 「終了の因果」を結論してはいけない。** 単一ターン内で完結する事実（hook が発火するか、
> deny が効くか）はその構成でも読める。
>
> **どちらで測ったか**（実測: 各スクリプトの `query(...)` 引数を確認済み）:
>
> | 節 | prompt | 本番構成か | 結論の有効範囲 |
> |---|---|---|---|
> | B-1（ガード） | **文字列**（`opts.prompt ?? WRITE_PROMPT`） | ✗ | **ターン1限定**。下の 🔁 を参照 |
> | B-2（canUseTool） | AsyncIterable | ✓ | そのまま有効 |
> | B-3（生成中の注入） | AsyncIterable | ✓ | そのまま有効（多ターンでないと測れない主張なので構成も合っている） |
> | B-4（session/path/effort） | AsyncIterable | ✓ | そのまま有効 |
> | B-5（定数 import） | セッション不使用 | 該当なし | そのまま有効 |
> | B-6（認証） | 環境の性質 | 該当なし | そのまま有効 |

### B-1. S0-A ガード（`probe-sdk-guard-hooks.mts`）

> 🔁 **再実測が要る（未実施）**: このスパイクは **string prompt = 単一ターン**で測っている。
> 本番の SDK worker は1セッションで何十ターンも回すので、**「ターン2以降も hook が
> 武装されたままか」は一度も測っていない**。P / A1 / A2 / A3 はいずれもターン1の中で
> 起きる事象なので、下の結論そのものは（ターン1については）有効。
> 再実測は `prompt` を AsyncIterable にして、**2ターン目で Write を出させて deny を確認**
> する形にすればよい。fail-closed 設計なので「ターン2で veto が外れる」なら
> それは**出荷を止める級**の事実であり、未確認のまま「守られている」と書かないこと。

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

---

## 付録C. 実測台帳の再点検（2026-08-01）

**なぜこの付録があるか。** 本書には「実測済み」と書かれた主張が多数あり、そのうち
**1件が実測で覆った**（§6 の interrupt）。覆ったのは SDK の挙動ではなく**測り方**で、
しかもその誤りは「本番と違う構成を測った」という**再現可能な型**だった。
同じ型が他に混ざっていないかを一件ずつ突き合わせた結果を置く。

**判定の凡例** — ✅ 現物と一致 / 🔁 **再実測が要る**（未実施・印だけ付けてある） /
📝 現物が変わったので本文を修正済み。

⚠ **この台帳自身が、自分の判定基準を1件だけ緩めていた**（0801 の点検で摘出）。
基準は「**本番と同じ構成で測る**」であり、他の行はその基準で 🔁 を付けている
（`prompt` が string ＝ ターン1限定、など）。ところが §6 の interrupt 行だけは、
再実測が**偽 CLI**（`scripts/probe-sdk-interrupt-survival.mts` の 60 行スタンドイン）
に対するものであるのに、無条件の 📝 として置かれていた。**構成の一致は
`prompt` の形だけではない — 相手側のプロセスも構成のうち**。下の行に但し書きを
足して閉じる。緩めた側に倒すと、次の人はその行を「実測済み」として引用する。

| 主張 | どこ | 判定 | 根拠 / 何が要るか |
|---|---|---|---|
| `interrupt()` 後の throw は正常系（＝ interrupt がセッションを終わらせる） | 旧 §6 | 📝 **覆った**（旧説の根拠は崩れた） | string prompt で測っていた＝CLI の stdin が最初の result で閉じ、**その構成では CLI は必ず死ぬ**。旧説が成り立たないことはこれで確定。0801 の再実測（`scripts/probe-sdk-interrupt-survival.mts`）。§6 に訂正の全文 |
| ↳ その置き換え説「`interrupt()` はターンだけ止め、iterator は続く」 | §6 | 🔁 **偽 CLI に対しては実測、本物の `claude` に対しては未確認** | 測ったのは 60 行の stream-json スタンドイン。**確定するのは SDK クライアント側の性質**（子が生きていれば iterator は終わらない／throw は子の死に紐づく）で、プロトコルが同じ以上ここは転用してよい。**確定しないのは「本物の `claude` が interrupt 後も生き続けるか」** — もし本物が終了を選ぶなら本番はケース B（throw）に落ち、UI の「セッションは続きます」はまた偽になる。隔離 HOME では認証できず（付録 B-6）、実機で測ればオーナーのクォータを使うため**意図的に未測定**。無条件の「実測済み」として引用しないこと |
| `terminateSdkSession` = `abortController.abort()` + 子プロセス確認殺し | 旧 §3.1 / 旧 §6 | 📝 **現物と違った** | 現物は `closed` + `interrupt()` + **status を同期で `exited`**。abort はしない。これを「死んだ」と読んだ seam が0801 の欠陥群の根 |
| 「プール entry が closed = 死（確定）」 | 旧 §5 S1 | 📝 **現物と違った** | 死は `reaped`（pump の `finally`）。`closed` は「頼んだ」印 |
| bypass 下で `canUseTool` は呼ばれない | 付録 B-2 | ✅ | 本番構成（AsyncIterable）で測定。SDK 自身の警告文も一次情報として一致 |
| mid-turn の `pushInput` はキューされ次ターンで処理される | 付録 B-3 | ✅ | 本番構成で測定。多ターンでないと測れない主張なので構成も必然的に合っている |
| `sessionId` 採用 / `effort:'max'` 受理 / `permissionMode:'bypassPermissions'` / JSONL は書かれる | 付録 B-4 | ✅ | 本番構成で測定。JSONL の「無い」誤判定は OG 側 `claudeDirName` のバグで、`dbba9e55` で根治済み |
| `USAGE_LIMIT_ERROR_PREFIXES` 等が runtime import できる | 付録 B-5 | ✅ | セッションを張らない測定なので構成の影響を受けない。⚠ ただし**件数（12/2）は SDK バージョンに紐づく**ので、lockfile を上げたら数ではなく**import が通ること**を見ること |
| 隔離 HOME では認証できない | 付録 B-6 | ✅ | 環境の性質。テスト方針（`queryFn` 注入）の根拠として今も有効 |
| **A3 ガードは fail-open（hook が throw すると veto が消える）** | 付録 B-1 | 🔁 **ターン1しか測っていない** | string prompt = 単一ターン。**「2ターン目以降も hook が武装されたままか」は未測定**。本番の worker は1セッションで何十ターンも回す。再実測 = prompt を AsyncIterable にして2ターン目に Write を出させ deny を確認 |
| **P（SDK は filesystem settings をロードしない）/ A1（bypass 下でも deny は効く）/ A2（subagent も同じ hook を通る）** | 付録 B-1 | 🔁 **同上（ターン1限定）** | 結論そのものはターン1については有効。fail-closed 設計の土台なので、**「ターン2で veto が外れる」なら出荷を止める級**。未確認のまま「守られている」と書かないこと |
| `interrupt()` → 例外あり（判別表） | `docs/SDK_CLIENT_INVESTIGATION.md` §3-A | 🔁 **本書の範囲外だが同じ誤り** | 同じ string-prompt スパイクの表。「例外あり」は**CLI が死ぬ構成でのみ真**。判別子が `terminal_reason` である点と `subtype` の罠は有効なまま。**あちらのファイルは未修正** |

**この表の使い方**: 🔁 の行を「実測済み」として引用しないこと。引用したいときは
先に測り直して、この表の判定を更新してから引用する。
