# Agent SDK クライアント経路 — 調査と結論

調査日: 2026-07-29 / CLI 2.1.220 / `@anthropic-ai/claude-agent-sdk` 0.3.220
状態: **調査のみ。実装は未着手。** 着手はオーナー承認待ち。

きっかけの問い —— 「VS Code の Claude 拡張のような読みやすい表示を OPEN GROUND でもできないか」

---

## 0. 結論（最終・0730 更新）

> ⚠ **この §0 は 0730 に差し替えられている。** §1〜§7 は第1ラウンド（0729）の調査記録で、
> そこでの暫定結論「swarm を SDK へ」は **§8〜§10 で覆った**。数値と実測は今も有効。
>
> ★★ **0730 夜・オーナー決定でさらに上書き: swarm worker は SDK へ段階移行する。**
> 「移行はしない」の主根拠だった規約は、swarm がオーナー限定（配布物から到達不能）で
> ある限り発生しないと整理し直され（§12/§13）、リモコンは補給官分割で解決（§13）、
> そして「PTY で安定を待つ」は不安定の原因が方式自体である以上成立しない、が決め手。
> **正典は `docs/SDK_WORKER_MIGRATION_PLAN.md`**（設計書・カード分割済み）。
> 本書は調査記録として残る。以下の「しない」結論は worker については失効。

**SDK への移行はしない。欲しかったものは移行なしで手に入る。**

| 対象 | 判断 |
|---|---|
| **司令官 / worker / Terminal タブ** | **PTY のまま据え置き**（リモコンが手放せない） |
| **司令官の読みやすい表示** | **作る** — JSONL 由来の読み取りビュー＋既存 PTY 入力 |
| **クォータ / API エラーのセンサー** | **画面読みから JSONL 読みへ**（SDK 不要） |
| SDK 移行本体 | **保留**（再検討条件は §10-C） |

理由の骨子（**0 が最上位。1-4 はそれが無くても成り立つ理由**）:

0. **規約が SDK を名指しで禁止側に置いている**（§12・一次情報）。Agent SDK 公式ドキュメントが
   「第三者開発者が自社プロダクトに claude.ai ログイン／レート制限を使うことは許可しない
   —— **Agent SDK で作ったエージェントを含む**」と明記し、API キーを使えと指示する。
   API キーはルール1（subscription-only）と OG の価値提案そのものを壊すので、選べない。
   ⚠ **技術的に動くことは許可ではない**（§12-D）。
1. 司令官はリモコンで日常的に操作されており、手放せない（オーナー確認 0730）。
   SDK でもリモコンは**作り直せる**が、**`--remote-control` 1行**が
   **`@alpha` API の自前運用**に変わる（§8-A）→ PTY 据え置き
2. 司令官が PTY のままなら owner-desk のスクレイプ（税の大半）は残る → worker だけ移しても買えるものが小さい
3. **そして §9 で、税の中核は SDK 抜きで消せることが実測で分かった** —— CLI 自身の文言は
   JSONL に `isApiErrorMessage: true` 付きで記録されている
4. `claude -p` の課金ルールは**アーキテクチャではなくポリシー**。過去に「プログラマティック課金」の
   ルールが実際に存在し、後に無くなった（オーナー証言 + §8-B）。**戻る可能性がある以上、
   実行経路をそこに賭けない**

---

## 1. なぜ「作る話」ではなく「税をやめる話」なのか

`src/lib/claudeMenu.ts` 冒頭が自ら書いている:

> これらの番号付きメニュー（ツール権限プロンプト、プラン承認など）は
> **TUI 専用で、セッション JSONL には決して現れない**

そのため OG は headless xterm で画面を再構成し、**そこから逆算**している。

### 1-A. 税の規模

| 実装 | 行数 |
|---|---:|
| `src/lib/server/swarmEscalations.ts` | 953 |
| `src/lib/server/swarmRateLimitText.ts` | 758 |
| `src/lib/claudeScreen.ts` | 322 |
| `src/lib/server/swarmQuestions.ts` | 271 |
| `src/lib/claudeMenu.ts` | 100 |
| `src/lib/server/pastePrompt.ts` | 57 |
| **小計** | **2,461** |

| それを守るテスト | 行数 |
|---|---:|
| `ownerDeskScreens.test.ts` | 1,310 |
| `swarmEscalations.test.ts` | 1,101 |
| `ownerDeskLimit.test.ts` | 1,026 |
| `swarmQuestions.test.ts` | 297 |
| `claudeMenu.test.ts` | 68 |
| **小計** | **3,802** |

**合計 約 6,300 行** が「画面から逆算する」ためだけに存在する。

### 1-B. これは実装の巧拙ではなく、アプローチの原理的限界

`docs/MAP.md` §3 に罠が5つ並び、**すべて「実測で踏んだ」**と記録されている。
位置判定機能は **7回差し戻された**（`docs/commander/04` §3.7 が正典）。

罠②が本質を突いている:

> `esc to interrupt` は footer であると同時に**ただの本文**でもある —— 画面全体に当てると、
> その語を表示した卓（=**この機能のソースを読んだ卓**）が永久に「生成中」に化ける

つまり **会話内容と UI 部品が原理的に区別できない**。どれだけ正規表現を磨いても、
会話が UI 部品と同じ文字列を含めば誤読する。構造化プロトコルにはこの曖昧さが存在しない。

`claudeScreen.ts` 自身にも実害の記録がある:

> 私的な再実装が高くつく方向に間違っていた。
> **センサーが、まさにそれが存在する理由であるイベントで沈黙した**（0718 敵対レビューで発見）

---

## 2. 公式の統合面は存在し、成熟している

- `@anthropic-ai/claude-agent-sdk` **0.3.220** ↔ CLI **2.1.220** — **番号が揃う＝同時リリース前提**
- 制御リクエスト **35種**:
  `can_use_tool` / `interrupt` / `initialize` / `set_permission_mode` / `set_model` /
  `list_models` / `get_usage` / `get_context_usage` / `get_session_cost` /
  `get_workspace_diff` / `get_plan` / `file_suggestions` / `read_file` / `rewind_files` /
  `mcp_*` / `hook_callback` / `elicitation` / `request_user_dialog` / `stop_task` ほか
- `sdk.d.ts` **7,149行**、コメントが極めて厚い＝クライアント実装を前提にした公開契約

→ **VS Code は「一から作って Claude に追随している」のではない。この契約に乗っている。**

---

## 3. 実測結果（全10項目・すべてこの調査で実際に走らせた）

| # | 検証 | 結果 |
|---|---|---|
| 1 | 双方向ストリーミング・多ターン | ✅ 3ターン同一 session_id・文脈保持 |
| 2 | 権限プロンプト | ✅ `canUseTool` 発火 |
| 3 | スラッシュコマンド | ✅ **92個**利用可（`og-manage`/`manage`/`supply`/`order`/`release` 含む） |
| 4 | サブスク認証 | ✅ `apiKeySource:"none"` — API キー不要 |
| 5 | プロセス死後の再接続 | ✅ 別プロセスから `resume` で **6.0秒**復帰・session_id 同一 |
| 6 | 中断 | ✅ `interrupt()` で停止。判別方法は §3-A |
| 7 | subagent の可視化 | ✅ `forwardSubagentText` で親ストリームに流れる |
| 8 | **subagent のツール承認** | ✅ **親の `canUseTool` に来る**（`agentID` 付きで識別可能） |
| 9 | **1セッション2クライアント同時接続** | ✅ 動く。JSONL も壊れない |
| 10 | 権限プロンプトの選択肢 | ✅ 構造化されて来る（§3-B） |

### 3-A. 中断と本物のエラーの判別（スパイク1）

| ケース | subtype | is_error | **terminal_reason** | 例外 |
|---|---|---|---|---|
| 正常完了 | `success` | false | **`completed`** | なし |
| `interrupt()` | `error_during_execution` | true | **`aborted_streaming`** | あり |
| 本物のエラー | **`success`** | **true** | **`api_error`** (+`api_error_status:404`) | あり |
| `abortController` | （result 来ず） | — | — | あり |

**判別子は `terminal_reason`。**

⚠ **罠**: 本物のエラーでも `subtype` は `success` になる。**`subtype` で判定してはいけない。**
⚠ `abortController` は result が一切来ないので理由が分からない。
**中断には `interrupt()` を使う**（result が来て理由が読める）。`abortController` は「もう何も要らない」時専用。

### 3-B. 権限プロンプトの中身が UI を作る側に優しい

Bash のケースで実際に飛んできたもの:

```
opts keys = signal, suggestions, blockedPath, decisionReason,
            title, displayName, description, toolUseID, agentID, requestId

suggestions = [
  { type:'addRules', rules:[{toolName:'Bash', ruleContent:'ls -d …'}],
    behavior:'allow', destination:'localSettings' },   // 「常に許可」
  { type:'addRules', rules:[{toolName:'Read', ruleContent:'//Users/…/**'}],
    behavior:'allow', destination:'session' }          // 「このセッション中だけ」
]
```

Write のケース:

```
suggestions = [
  { type:'setMode', mode:'acceptEdits', destination:'session' },
  { type:'addDirectories', directories:['…/scratchpad'], destination:'session' }
]
decisionReason = "Path is outside allowed working directories"
```

→ **ターミナルの権限メニューの選択肢そのものが構造化されて来る。**
OG は**ボタンを並べて返すだけ**。何を出すべきか推測する必要がない。

### 3-C. subagent の承認が親に集約される（スパイク3）

subagent に `/tmp` への Write をさせたところ、**親の `canUseTool` に届いた**:

```
canUseTool: tool=Write agentID=a593b75cb276d6551
            reason="Path is outside allowed working directories"
```

→ worker の subagent が何をしようとしているかが**親で全部見える**。
今は JSONL の mtime で「まだ生きているか」しか分からない（`swarmOrchestrator` の停滞プローブ）。

### 3-D. 同一セッションへの2クライアント同時接続（スパイク2）

A を張ったまま B が `resume` で入り、**両方が動き続け、JSONL も壊れなかった**（29行 / 壊れた行 0）。

⚠ **未検証**: ①両者が**同時に生成中**のケース ②A と B が**互いの発言を見るか**
（B は A の合言葉を読めたが、A が B の発言を見たことは確認していない）

---

## 4. 移行の seam は狭い

swarm 実装は **52,059行**（うち `swarmOrchestrator.ts` が 10,372行）。
しかし **PTY に触る呼び出しは全部で 51 箇所**:

| 呼び出し | 箇所数 |
|---|---:|
| `getTerminalScreen` | 27 |
| `killTerminal(` | 6 |
| `readInputBoxText(` | 5 |
| `launchClaude(` | 5 |
| `readScreen(` | 2 |
| `isGenerating(` | 2 |
| `detectMenu(` | 2 |
| `writeToTerminal` / `bracketedPaste(` | 2 |

→ **配車・roster・クォータ・統合といったオーケストレーションの頭脳はそのまま。**
書き換えるのは接点だけ。「52k行の書き直し」ではない。

---

## 5. おまけで手に入るもの

今 OG が別途作っている、または作れていないもの:

- `maxBudgetUsd` / `taskBudget` — **予算上限をセッションに直接設定**（swarm のクォータ park と直結）
- `rate_limit_event` — 7日枠の消費率がストリームに流れる（実測で `utilization:0.55` を観測）
- `getSubagentMessages()` / `listSubagents()` — subagent の会話を API で読む
- `get_context_usage` — コンテキスト残量（今は画面から `extractContextLeftPct`。`sessionContext.ts`）
- `set_permission_mode` / `set_model` — 今は生キーストローク（`claudeSlash.ts`）
- `get_workspace_diff` / `get_plan` / `rewind_files`
- `initialize` 応答の `pending_permission_requests` — **再接続で「宙に浮いた承認待ち」を取り戻せる**

---

## 6. 残るリスク・未確定

1. **同時生成のケース未検証**（§3-D）
2. **`request_user_dialog` の実体は現状 `refusal_fallback_prompt` のみ** — 「選択UI」の実体はほぼ権限プロンプト。
   ただし CLI は宣言外の種別に **fail-closed**（既定動作に落ちる）なので、実装漏れでハングする事故は起きない
3. **プロセス寿命は PTY 版と同条件** — OG サーバが死ねば claude も道連れ。`resume` で復帰できることは実測済み
4. **TUI 専用の体験は失う** — claude の中で全画面ツールが開く類は映らない
5. **移行期は二重メンテ** — PTY 経路とスクレイプ 6,300行は当面残る
6. **受益者は当面オーナー1人** — swarm は owner-only（安定するまで一般開放しない方針）。
   ただし**税を払っているのもオーナー1人**である

---

## 7. 進め方（着手承認が出た場合）

1. **swarm worker 1枚**を SDK 経路で立てる — 読みやすい表示 ＋ センサーを構造化に
2. 司令官の監視画面を SDK 側へ寄せる
3. スクレイプ 6,300行は**実運用で置換を確認してから**落とす（先に消さない）
4. Terminal タブへのチャット表示は**任意のトグル**として最後に検討（**既定は PTY のまま**）

先に潰す未確定: §6-1（同時生成）→ §3-D の相互可視性。

---

## 8. 「今できていることを失うか」調査（0730）

### 8-A. リモコン（`--remote-control`）— 「失う」ではなく「自前運用に変わる」

> **訂正（0730）**: 初稿はここを「リモコンを失う」と書いていた。**言い過ぎ。**
> 正しくは「**フラグ1行が `@alpha` API の自前運用に変わる**」。

**事実1 — `--remote-control` フラグは SDK / print 経路では効かない（実測3件）**

1. SDK の `initialize` が `remote_control_auto_enable: false` を返す
2. `claude -p --remote-control <name> --debug` でブリッジ活動ゼロ
3. SDK の `extraArgs` でフラグを渡しても `--debug` の stderr にブリッジ関連が**1件も出ない**

（`Options` にリモコン用のフィールドは存在しない。CLI バイナリの
`remote-control-repl` / `-cli` / `-sdk` / `-auto` というモード名から見て、
フラグの自動配線は**対話 REPL 専用**で、SDK 消費者は次の道を使う設計。）

**事実2 — SDK はリモコンの実装キットを公開している**（`@anthropic-ai/claude-agent-sdk/bridge`）

```
createCodeSession()      → claude.ai 側にセッションを作る
fetchRemoteCredentials() → worker JWT を取る
attachBridgeSession()    → 生きたブリッジのハンドル
```

ハンドル: `write()`（画面を送る）/ `sendControlRequest()`（**権限プロンプトをスマホへ**）/
`sendControlResponse()` / `sendResult()`。
受け口: `onInboundMessage`（**スマホで打った文字**）/ `onPermissionResponse` / `onInterrupt` /
`onSetModel` / `onSetPermissionMode` / `onRenameSession` / `onClose`。

→ **スマホから司令官を操作する体験は SDK でも作れる。**

**事実3 — だが引き受けるものが増える**

| | 今（PTY） | SDK |
|---|---|---|
| リモコン | `--remote-control <名前>` **1行** | 3段階の配線 + 7系統のコールバック |
| 認証 | CLI 任せ | OG が持つ（アクセストークン、`untrusted_device` / `session_stale_relogin`） |
| 再接続 | CLI 任せ | OG が持つ（worker epoch / SSE シーケンス番号 / ハートビート / エコー除去） |
| 安定性 | CLI 本体の機能 | **`@alpha`** |

その `@alpha` の但し書きが強い:

> ALPHA STABILITY. これは `query()` 本体とは**別のバージョニング宇宙**である。
> ここでの破壊的変更は**パッケージのメジャーバージョンを上げない**

＝ **パッチリリースで壊れうる。**

**したがって却下の理由は「リモコンが使えないから」ではない:**

> リモコンは作り直せる。だが**オーナーが唯一手放せない機能を、パッチで壊れうる alpha API の
> 上に乗せる**ことになる。しかも §9 により、**移行しなくても税の中核は消せる**。
> ＝ 安く買えるもののために、大きな請求書を払うことになる。

**移行側にしかない良さも1つある**: `outboundOnly`（ミラーモード）——
「リモート UI がセッションを**見られるが操作はできない**」。今の `--remote-control` は
見る／操作するがセットなので、これは PTY にない粒度。worker を本格運用し始めたら効く材料。

### 8-A2. その他に失う2つ

| # | 失うもの | 代替 |
|---|---|---|
| A-2 | **シェルへの脱出** — `launchClaude` はログインシェルの中で claude を起こすので、claude を抜けると worktree の生きたシェルが残る | worker ごとに PTY を別に1本持つ（既存 terminal API） |
| A-3 | 生の TUI 画面を見るデバッグ手段 | 構造化イベントのダンプ（実質同等以上） |

### 8-B. ★ コード中の不変条件が古い（実測4証拠で否定）

`claudeTerminal.ts` 冒頭と `generateDescription.ts` は次のように書いている:

> PTY が本物の TTY を見せるから、セッションはサブスクの枠に課金される。
> `claude -p` は**プログラマティック・クレジット**になる ／ `claude -p` は **FORBIDDEN**

**CLI 2.1.220 では成り立たない。**

1. `-p` で `/usage` → 「**You are currently using your subscription** to power your Claude Code usage」
2. `apiKeySource: "none"`
3. `rate_limit_event: { rateLimitType: "seven_day", utilization: 0.55 }` = サブスクの7日枠
4. `account: { subscriptionType: "Claude Max", apiProvider: "firstParty" }`

分かれ目は **TTY の有無ではなく認証方式**（OAuth ログイン vs API キー / `setup-token` の
長期トークン＝inference-only）。

⚠ **ただしこれはポリシーであってアーキテクチャではない。** オーナー証言（0730）—— 過去に
実際「これらは課金になる」というルールが設けられ、後に無くなった。**戻る可能性がある。**
だから「今は `-p` でもサブスク」は事実として記録しつつ、**実行経路をそこに賭けない**のが
本ドキュメントの立場（§0-4）。コメントは事実に合わせて直すべきだが、
「だから `-p` に移行してよい」という含意は持たせないこと。

### 8-C. 失わないもの / むしろ良くなるもの

失わない: スラッシュコマンド92個・権限プロンプト・subagent 承認・中断・再接続・
OG 内からのログイン（`/api/terminal/claude-login`。Terminal タブが PTY のままなので無傷）。

作り直しになるが良くなる: paste-task / ファイルドロップ / beacon の working・waiting /
`generateDescription` / `claudeSlash.ts`。

---

## 9. ★ 決定的な発見 — 税の中核は SDK 抜きで消せる

### 9-A. 司令官では「権限プロンプトが JSONL に無い」問題が発生しない

第1ラウンドで JSONL 読み取り案を捨てた理由は「権限プロンプトが JSONL に現れない」だった。
**司令官には当てはまらない。**

- `swarmManager.ts:284` / `swarmSupply.ts:116` / `swarmWorker.ts:623` —— **全ロールが `permissionMode: 'bypass'`**
- `swarmQuestions.ts` 冒頭が明記: 「**bypass 下では権限メニューは消える**」

→ 司令官の卓は**会話の全部が JSONL にある**。読み取りビューがほぼ完全に作れる。
読む＝JSONL / 打つ＝既存の `POST /api/terminal/:id/input`。**PTY を触らないのでリモコン無傷。**

### 9-B. CLI 自身の文言は JSONL に構造マーカー付きで記録されている

実測（全 JSONL を走査・該当249ファイル）:

| 回数 | 文言（`type=assistant` + **`isApiErrorMessage: true`**） |
|---:|---|
| 158 | `You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.` |
| 74 | `You've hit your session limit · resets …`（時刻別に4種） |
| 13 | `Not logged in · Please run /login` |
| 11 | `You've hit your weekly limit · resets …` |
| 3 | **`API Error: 529 Overloaded.`** |
| 5 | `API Error: Unable to connect / Connection closed / Server error mid-response` |
| 3 | `There's an issue with the selected model (…)` |

**`ownerDeskLimit` / `swarmRateLimitText` が画面から探している語彙が、丸ごと JSONL にある。**

これが効く理由:

- **誤検知クラスが死ぬ** —— 「司令官が worker の画面を引用した」（＝`swarmRateLimitText.ts:401` が
  *司令官と補給官の卓の日常業務そのもの* と呼ぶ、唯一カバーされていなかった誤検知クラス）は
  `tool_result` / 素の assistant text であり、**`isApiErrorMessage` が付かない**。
  位置の推測ではなく**構造**で区別できる
- **MAP.md §3 の罠④も死ぬ** —— 「表が知らない行（`API Error: 529 Overloaded` 等）が
  通知に畳み込まれて本物が沈黙する」問題。JSONL では独立エントリなので畳み込まれない

### 9-C. 適用範囲（正直に）

| センサー | JSONL へ移せるか |
|---|---|
| `ownerDeskLimit`（1,026行のテスト） | ✅ 移せる |
| `swarmRateLimitText`（758行 + テスト1,310行） | ✅ 中核は移せる |
| `swarmQuestions` の**質問内容** | ✅ JSONL にある |
| `swarmQuestions` の**「入力箱が idle で待っている」状態** | ❌ 画面 or プロセス状態が要る |
| 権限メニュー検出（`claudeMenu`） | ❌ JSONL に無い（ただし bypass 下では出ない） |

→ **クォータ / API エラーの腕は移せる。idle 状態判定の腕は画面が要る。**

---

## 10. 最終結論

### A. やる（PTY を一切触らない）
1. **司令官の読みやすい表示** — JSONL 読み取りビュー ＋ 既存 PTY 入力（§9-A）
2. **クォータ / API エラーのセンサーを JSONL へ** — 誤検知クラスと MAP.md 罠④が消える（§9-B）
3. **タダ直し** — §8-B の古いコメント訂正 ／ `/usage` の per-model 行が 2.1.220 で出るように
   なったので `isTopTierExhaustedByUsage`（pct>=100 が永久に発火しない問題）を再検討

### B. やらない
SDK への移行本体。司令官のリモコンが手放せない以上、税の大半は残り、
worker だけ移しても買えるものが小さい。

### C. SDK 移行を再検討する条件

**⚠ 0730 更新: これは順序付きの条件。①が満たされない限り②③は検討する意味がない。**

1. **規約が変わる、または Anthropic の事前承認（"previously approved"）を得る**（§12）。
   現状の一次情報は SDK を名指しで禁止側に置いている。ここが動かない限り移行は選択肢ですらない。
   **申請の作法は §12-E**（照会ではなく申請として出す・現行方式の可否は混ぜない）。
2. ~~`attachBridgeSession` が `@alpha` を抜ける~~ → **解決済み（§13）**。
   リモコンは PTY の卓を1つ残すことで維持できるので、alpha ブリッジは不要になった。
3. ~~worker を実際に使うようになる~~ → 価値の見積もりは §11-C で更新済み（震源はプロセスの
   生死推測であり、worker の稼働率とは独立に大きい）。

**⇒ 実質的に残る条件は 1 だけ。** 承認が取れれば移行は現実の選択肢になる。

なお **`claude -p` の課金ポリシー**（§8-B ⚠）は①とは別問題として残る。ポリシーであって
アーキテクチャではないので、PTY を選び続ける理由としては①と独立に生き続ける。

---

## 11. 追加実測（0730 第3ラウンド）— SDK は `-p` ではない / 震源は JSONL ではない

### 11-A. SDK が実際に起動する argv（`spawnClaudeCodeProcess` で捕捉）

```
claude --output-format stream-json --verbose --input-format stream-json --permission-mode default
```

**`--print` / `-p` は渡していない。** `claude -p "文章"` は一発売り切りだが、SDK が使うのは
`--input-format stream-json` による**双方向の持続セッション**で、別モード。同じ非対話系だが同一ではない。

### 11-B. ⚠ SDK は既定で「自前のバンドル claude」を起動する

捕捉した command は `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` ——
**ユーザーの `claude` ではない**。「OG はユーザー自身の CLI しか叩かない」は OG の
コンプライアンス上の柱なので、既定のままだとその主張が literally 崩れる。

`pathToClaudeCodeExecutable` で回避できることは実測済み（ユーザーの
`~/.local/bin/claude` を起動、`apiKeySource:"none"` / `Claude Max` のまま）。
**SDK を使うなら必須設定**。OG には `cliResolve.ts` / `resolvedClaudeBin` があるので繋ぐだけ。

### 11-C. ★ OG の大規模コードの震源は JSONL ではない

直近の大きいコミット5本を開いた結果:

| コミット | 行数 | 実体 |
|---|---:|---|
| `361108dd` | 434 | 「シグナルを送った」を「死んだ」と扱う撤去パス（`terminal.ts` +111 / `swarmWorker.ts` +84） |
| `a1d332ce` | 447 | 消せない孤児プロセスの検知（`stuckProcessWatch.ts` 新規178） |
| `2e0adb3e` | 365 | エスカレーションの永久デッドロックと monitor 飢餓 |
| `fe52d5d6` | 345 | 心拍スイープの極性反転（エンジンが自分の記憶を食う） |
| `227102cd` | 275 | roster が「知らないこと」を「無い証拠」として焼く |

**JSONL 由来はゼロ。** 全部これ ——
**claude プロセスの生死と状態を、プロセスの外側から推測している**。

SDK ならその推測が「答え」になる（生死＝ストリーム / 「シグナル≠死」＝`terminal_reason` /
roster の「知らない」＝セッション状態 / 着弾判定＝送信 ACK）。**5本のうち3本は大幅に減る。**
減らないのは孤児プロセス検知と worktree 漏れ ——
あれは **`git` サブプロセス**の話で claude ではない。

→ **§0 の「移行の価値」は、初稿の見積もりより大きい。** それでも結論は変わらない。理由は §12。

---

## 12. ★ 規約 — ここで決着した（0730・一次情報）

第2ラウンドで「未解決」としていた論点。**一次情報を当たった結果、グレーではなかった。**

### 12-A. Agent SDK 公式ドキュメントの Note（`code.claude.com/docs/en/agent-sdk/overview`）

事前承認がある場合を除き、Anthropic は第三者開発者が自社プロダクトのために claude.ai ログインや
レート制限を提供することを許可しない —— そこに
**"including agents built on the Claude Agent SDK"** と**名指しで**含めている。
API キー認証を使うよう指示している。

### 12-B. Legal and compliance（`code.claude.com/docs/en/legal-and-compliance`）

- OAuth は**サブスク購入者向けであり、Claude Code その他ネイティブ Anthropic アプリの
  "ordinary use" を支えるためのもの**と定義
- **Agent SDK を使う開発者は Console の API キーを使うべき**、と Agent SDK を名指し
- **第三者開発者が claude.ai ログインを提供すること、および Free/Pro/Max の資格情報で
  ユーザーの代わりにリクエストを流すことを許可しない**
- 予告なく enforcement する権利を留保

### 12-C. OG に当てはめると

禁止条項の**作用する形**は「claude.ai ログインを**提供する**」「**ユーザーの代わりに**
サブスク資格情報でリクエストを流す」。OG はどちらもしていない —— ユーザーは自分で
公式 CLI にログインし、OG はその CLI を起こすだけ。

**しかし決定的な非対称がある:**

| | PTY 経路（現行） | SDK 経路 |
|---|---|---|
| 規約文書での言及 | **名指しされていない** | **名指しで禁止側に列挙** |
| OAuth の定義文との距離 | "ordinary use of Claude Code" に近い（人が打つ端末） | 「Agent SDK で作ったエージェント」そのもの |

→ **SDK 経路は、OG が現に負っている残余リスクの上に、名指しの禁止を1枚重ねる。**
サンクションされた SDK の使い方は API キーであり、それはルール1（subscription-only）と
OG の価値提案そのものを壊す。

### 12-D. ⚠ 「動いた」を「許された」と読まないこと

§3 で実測した通り、SDK はサブスク認証で**技術的には動く**（`apiKeySource:"none"` /
`subscriptionType:"Claude Max"`）。**これは許可ではない。**
Anthropic は本物の Claude Code バイナリかどうかを検証する側の enforcement を入れており、
SDK は本物を起こすので通ってしまう —— **通ることと、許されていることは別。**

これは §8-B で直したばかりの失敗と**同じ形**（実測して「大丈夫そう」と読み、ルールの根拠を
崩す）。次に誰かがここを測って「動くじゃん」と思ったら、この節を読むこと。

### 12-E. ★ 「コンプライアンス照会」と「承認申請」は別の行為（0730・オーナー指摘で判明）

Anthropic に問い合わせるかを検討した過程で、**2つを1つに潰していた**ことが分かった。
分けると結論が変わる。

| | コンプライアンス照会 | 承認申請 |
|---|---|---|
| 聞くこと | 「今やっていることは許可されますか」 | 「これをやらせてください」 |
| ノーが返ったとき | **現行運用への指摘**になる | 申請が通らなかっただけ。**現行運用は俎上に載らない** |
| SDK について | **聞く価値がない** — 答えは既に公開済み（§12-A）。自分の名前を付けるだけ | **価値がある** — "Unless previously approved" は Anthropic 自身が用意した経路 |
| PTY について | **聞いてはいけない** — 名指しされていない良識的な読みを、書面の拒否に変換するリスクだけ | （そもそも承認を要さない） |

**設計上の要点 — 申請文に「今の方式は許可されますか」を混ぜないこと。そこが唯一の露出源。**
現行方式は「背景」として事実のみ書き、評価を求めない。聞くのは変えたいことだけ。
そうすれば、断られても失うのは「申請が通らなかった」ことだけになる。

**タイミング**: 承認は**ユーザーが付く前が一番安い**（収益ゼロ・1人・小さな依頼）。
実ユーザーを抱えてから遡って頼むのとは通りやすさが違う。

**期待値の見立て**: 一次サポートで即決される種類の依頼ではない。"Unless previously approved"
の承認はおそらくパートナーシップ / BD のトラック（同じページにパートナー向けブランディング
規約が並んでいるのが傍証）。**現実的な最良の結果は「承認」ではなく「正しい窓口と手続きが
分かる」**。今は窓口すら分かっていないので、それでも前進。

**窓口**: Claude アプリ左下 → "Get help"（Fin ボット → 人間へエスカレーションを明示要求。
Max で到達可）。contact-sales は公表スコープが 500席以上 / BAA のみだが、
legal-and-compliance ページ自身が permitted authentication methods の質問先として案内して
いるので、support から回してもらうのが現実的。公開メールアドレスは存在しない。

申請文の草案は scratchpad（`anthropic-inquiry-draft.md`）。送信済み / 回答の有無は本節に追記する。

---

## 13. リモコンのブロッカーは解けた（0730・オーナー発案）

§8-A で「唯一の本物の後退」としたリモコン問題は、**役割を分ければ消える**。

オーナーが外から必要としているのは**モニタリングと注文だけ**で、司令官の端末を丸ごと
操作することではない。であれば:

- **マネージャー＋ワーカー → SDK**（構造化・生死の推測が不要に）
- **卓を1つ PTY で残す → それがスマホの窓口**（`--remote-control` がそのまま効く）

**`@alpha` のブリッジは要らなくなる。**

### 13-A. その「卓」は既にある — 補給官（タスク窓口）

| | 補給官の現状 |
|---|---|
| PTY | ✅ |
| `--remote-control` | ✅（スマホ一覧に「タスク窓口」として出る） |
| `ownerDesk: true` / `permissionMode:'bypass'` | ✅（`swarmSupply.ts:116,127`） |
| 役割 | 「フワッとした要望を聞いて、観測可能なタスクにして Board の todo に積む」 |

足りないのは**状況報告の役目**だけで、それは今マネージャーが持っている。

### 13-B. 仕組みは新規ではない — `/og-manage` が既に証明済み

マシン上の claude セッションは OG に対して何でもできる。API は `127.0.0.1:47776`、
**認証ミドルウェアなし**（localhost 限定が唯一のゲート）。`/og-manage` は全部これでやっている:

```
worker 一覧  : curl -s "$OG/api/swarm/workers?path=$PWD"
エンジン状態 : curl -s "$OG/api/swarm/orchestrator?path=$PWD"
worker 起動  : curl -s -X POST $OG/api/swarm/worker -d '{...}'
```

### 13-C. ⚠ 「Claude アプリから直接 OG を叩く」は**やってはいけない**

claude.ai はクラウドで動くので `127.0.0.1` には届かない。届かせるには OG を外に出すことに
なるが、**OG の API は無認証**でプロセス起動とファイル読み書きができる。
外に出す＝リモートシェルを配ること。**塞いだままにする。**

安全な形は Remote Control そのもの:
`スマホ/claude.ai → RC → マシン上の claude → 127.0.0.1:47776`。
トンネルは Anthropic が運営し、オーナー自身のログインで認証される。OG は外に出ない。

### 13-D. 今より良くなる点 / 残るリスク

**良くなる**: ①電話に出る卓が司令塔をやめる（今の二重役が誤検知の温床）
②`swarmRateLimitText.ts:401` の誤検知クラス（司令官が worker の画面を引用する日常業務）は、
worker が SDK なら**そもそも画面を読まないので消える**
③電話窓口が落ちてもオーケストレーションは止まらない（今はマネージャーが落ちると止まる）

**残るリスク**: ①頭が2つ（受け渡し点は既存の Board なので、今の補給官↔司令官と同じ構造）
②電話窓口が単一障害点 ③ログイン期限が切れれば RC は死ぬ（今も同じ）

---

## 付録: 調査に使ったもの

- `~/.local/share/claude/versions/2.1.220`（CLI バイナリの文字列解析）
- `@anthropic-ai/claude-agent-sdk@0.3.220` の `sdk.d.ts` / `bridge.d.ts`
- 使い捨て実測スクリプト（scratchpad・リポジトリ外）:
  `probe.mjs`（双方向・権限・スラッシュ）/ `probe2.mjs`（resume・中断・subagent）/
  `spike1.mjs`（中断の判別）/ `spike2.mjs`（同時接続）/ `spike3.mjs`（subagent 承認）
