# Context Management — 実現可能性実証 & 設計切り分け

> **カード 1/5(スパイク・`633e765f`)の成果物。** コンテキスト管理を
> 「**Claude Code が native でやること**」と「**OG が薄く足すこと**」に切り分け、
> カード 2〜5 の設計根拠を実測で固定する。方針(2026-07-23 オーナー2決定):
> ①**全自動でおまかせ**(あなたは何もしない・ゲージは見たい時だけ)
> ②**Claude Code 自体の機能があれば使う**(車輪の再発明をしない)。

## 0. 結論(TL;DR)

- **圧縮そのものは native に丸投げできる。** Claude Code の自動コンパクト(既定ON)が
  上限接近で走る。OG は独自の「満杯→/compact」トリガを**作らない**(二重発火で native と喧嘩させない)。
- **OG が足すべきは Claude Code が知り得ないことだけ** = ①**Board カード完了を知って
  タスク境界で `/clear`**(圧縮は必ず何かを失うが、別タスクに移るなら失って困る文脈は無い=質維持の最大の一手)
  ②複数セッションの**残量ゲージ可視化**。
- **load-bearing な OG 機構2点は実機で決着**(§4):**B1 `/clear` の PTY 送信**、**B3 残量 N% の画面読取**。
- 圧縮の質は **CLAUDE.md の `# Compact Instructions`**(← これも native 機能。カードが想定した
  `# Summary instructions` は**誤り**。§3-A2)で担保する。

切り分け表は **§5**。カード 2〜5 への具体的含意は **§6**。

## 1. 検証環境・手法

| 項目 | 値 |
|---|---|
| claude CLI 実バージョン | **2.1.218 (Claude Code)** |
| 検証プロジェクト | `/Users/you/projects/test`(UUID 06c90656)|
| 手法 | **本番コード経路を直叩き**するスクレイプ無し検証ハーネス(tsx)。`launchClaude()` で実 claude PTY を起動 → `seedPrompt()`(= `writeInput(id, text + '\r')`、**素の input + Enter**、bracketed paste は使わない)でスラッシュコマンド送信 → `getTerminalScreen()` / `getTerminalScreenLogical()`(headless xterm)で画面キャプチャ。HTTP サーバも共有 `~/.openground` も一切触らない(プロセス内で node-pty を直接駆動)。|
| モデル | `haiku`(TUI 機構の検証なので最安・挙動は model 非依存)|
| 画面キャプチャ実体 | `scratchpad/ctx-spike/*.screen.txt` / `*.logical.txt`(各段) |

native 機能(A1〜A4)は**一次資料**(公式ドキュメント code.claude.com/docs)で確定し、実機で観測できるものは併記。
OG 機構(B1〜B3)は**実機ハーネスの画面キャプチャ**で YES/NO を出す。

---

## 2. A — Claude Code が native で持つ機能(乗れるなら OG は作らない)

### A1. 自動コンパクト(auto-compact)
- **native がやる: YES。** 既定 ON で、コンテキストが上限に近づくと自動で圧縮が走る。
  最大コンテキストは 200,000 tokens。**発火閾値 % は非公開**(公式は "as you approach the limit" とだけ)。
- **無効化ノブ: 公式ドキュメントに存在を確認できず。** カードが挙げた
  `settings.json: autoCompactEnabled:false` / 環境変数 `DISABLE_AUTO_COMPACT=1` は**現行公式ドキュメントに記載なし**
  (信頼度 LOW)。→ **OG は無効化ノブを前提にしない。** 方針は「既定 ON に乗る」だけで足り、OG が能動的に
  トグルする必要がそもそも無い(独自トリガを作らないので、native の自動圧縮と競合しない)。
- **OG の関与: ほぼゼロ。** 「auto-compact を ON に保つ」ための操作は不要(既定 ON)。
- 根拠: how-claude-code-works.md(when context fills up)/ context-window.md。

### A2. CLAUDE.md の圧縮指示(**要修正**)
- **native がやる: YES。ただし正しい見出しは `# Compact Instructions`。**
  カード原文の `# Summary instructions` は**誤り**(stale 知識を一次資料で訂正)。
- 効果: CLAUDE.md にこのセクションを置くと、compactor が**圧縮時に何を優先して残すか**を steer する
  (`/compact focus <instruction>` のインライン版に相当)。project-root の CLAUDE.md は**圧縮後に再注入**される。
- **OG の関与:** カード 4 で、対象プロジェクトの CLAUDE.md に「変更ファイル一覧・未完了の意図を残せ」等の
  `# Compact Instructions` を**配備する薄い層**を足すだけ。圧縮エンジン自体は native。
- 根拠: how-claude-code-works.md("To control what's preserved during compaction, add a 'Compact Instructions' section to CLAUDE.md")/ memory.md("Project-root CLAUDE.md survives compaction")。

#### A2-実測(カード 4/5・2026-07-25)— 配備は完了、ただし「効き」は再現できず

カード 4/5 の実装(`compactInstructionsInstall.ts`)に合わせて**実 claude で `/compact` を回した**。
ハーネスは本番経路(`launchClaude` → `writeInput` → 画面/JSONL 読取)、使い捨ての scratch cwd に
CLAUDE.md を置き、`~/.claude/CLAUDE.md` も `~/.openground` も触っていない。claude 2.1.218・haiku・
各 arm n=1・手動 `/compact`(**自動コンパクト=200k 到達は起こしていない**)。

| arm | CLAUDE.md | 要約に変更ファイル一覧 | 決定 | テスト結果 | 判定用プローブ |
|---|---|---|---|---|---|
| **with** | 本番の `# Compact Instructions` あり | **YES**(`alpha.ts`/`beta.ts` と各変更内容) | YES | YES(`2`) | — |
| **without**(対照) | セクション無し | **YES** | YES | YES | — |
| **probe**(判別) | 本番文言 + 「`beta.ts` は要約で一切触れるな」 | YES | YES | YES | **beta.ts は消えず=指示は効かず** |

- **カードのゴール条件そのものは満たされた**: 実圧縮の要約に変更ファイル一覧・決定・直近テスト結果・
  ユーザーの指示が残る。ただし要約は Claude Code の**既定テンプレ**
  (`1. Primary Request and Intent` … `3. Files and Code Sections` … `7. Pending Tasks`)であり、
  **対照 arm でも同じものが残った** — つまり短いセッションでは**この保全は既定の働きで、
  配備したセクションが効かせているのではない**。
- **steering の実証は失敗**。判別プローブを2形で試して両方とも不発:
  ①「要約末尾に固定マーカー行を出せ」→ 無視(sonnet では**注入テキストとみなして明示的に拒否**し、
  圧縮自体が 1.2k 字の退化した出力になった=モデル間で挙動が違う)②「`beta.ts` に触れるな」→ 無視。
- したがって「`# Compact Instructions` が圧縮を steer する」は**一次資料(公式ドキュメント)の記述どおり
  配備はしたが、本スパイクの条件では観測できなかった**。可能性: (a) 短い会話では何も捨てる必要が無く
  steer が効く余地that自体が無い (b) project-scope の CLAUDE.md しか試せていない
  (`~/.claude/CLAUDE.md` はオーナーの実ファイルなので worker は書けない=A3 guard) (c) haiku の指示追従。
- **判断**: セクションは**そのまま出荷**する。公式が明記した native の steering フックであり、
  常時コスト ~180 tokens/session と小さく、害が無い。ただし**「これのおかげで残っている」とは言えない**
  ことを本節に固定する。**真価の検証は文脈が逼迫した実セッション(自動コンパクト)でしか取れない** —
  カード3(PostCompact フック配線)で実圧縮イベントを掴めるようになったら、その時の要約で再測する。
- 根拠ログ: 本 worker の scratchpad(`run-with.log` / `run-without.log` / `run-probe4.log` と
  各 `SUMMARY.txt`)。ハーネスは使い捨て(repo 非常駐)。

> ⚠ 副産物の発見(本カード範囲外・要フォロー): `claudeProjectDir.ts` の `claudeDirName` は
> `[/.\\: ]` だけを `-` に置換するが、**claude 実体は `_` も `-` にする**(実測:
> `…gxr_91_544…` → `…gxr-91-544…`)。パスに `_` を含むプロジェクトでは `sessionJsonlPath()` が
> claude の実際の保存先と**食い違う**(transcript 読み・swarm の stall probe が空振りしうる)。

### A3. PreCompact / PostCompact フック
- **native がやる: YES(信頼度 VERY HIGH)。** 圧縮の前後にフックが発火する。
  - **PreCompact**: matcher `manual`(ユーザーが `/compact`)/ `auto`(閾値発火)。**exit code 2 で圧縮をブロック可**。
    stdin JSON = `{session_id, cwd, hook_event_name:"PreCompact", trigger:"manual"|"auto", ...}`。
  - **PostCompact**: 決定制御は無し(副作用のみ)。**`additionalContext` を注入可**(圧縮後に文脈を再注入)。
- **OG の関与(重要な設計含意):** OG は「**いつ圧縮が起きたか**」を**native フックで観測できる**ので、
  **OG 独自の画面ポーリングで圧縮検知する必要は無い**。カード 3(自動エンジン)は PostCompact フックの
  発火を「圧縮イベント」の信号として使える(OG が既に持つ `hooksInstall.ts` の配線 seam に乗せる)。
- 根拠: hooks-guide.md / hooks.md(matcher table・exit code 2 behavior per event)。
- 注: 本スパイクでは**フックの live 発火試験は実施せず**、公式ドキュメント(VERY HIGH)で確定とした
  (グローバル `~/.claude/settings.json` 汚染と hooks 承認プロンプトでの wedge を避けるため)。
  実配線時に PostCompact の発火をカード 3 側で 1 度実測すること。

### A4. スラッシュコマンド `/context` `/compact` `/clear`
- **native がやる: YES(VERY HIGH)。**
  - `/context`: 現在のコンテキスト埋まり具合 %・内訳を表示(`/context` 単体で概況)。→ 実機観測は §4-B3 に併記。
  - `/compact [focus <instruction>]`: 会話を要約して空ける。**focus 引数で優先指示可**。
  - `/clear`(alias `/reset` `/new`、`/clear [name]` 形あり): 会話を**破棄**して空コンテキストで再開。
    project memory(auto memory + CLAUDE.md)は残る。**クリア後も `claude --resume` / `/resume` で復旧可**
    (session id 保持・会話履歴は失うが memory は無傷)。
- 根拠: commands.md / how-claude-code-works.md(sessions)。

---

## 3. B — OG 側 load-bearing の実機検証(ここが崩れると設計が変わる)

> 送信経路は `POST /api/terminal/:id/input` → `writeInput(id, data)`(server/routes/terminal.ts:353)。
> ハーネスは同じ `writeInput` を叩く `seedPrompt`(claudeTerminal.ts:578 = `writeInput(id, text + '\r')`)を使用。

### B1. OG から `/clear` を送って TUI が実行するか(最優先) → **YES(実機確定)**
- 送信: `writeInput(id, '/clear\r')`(= `seedPrompt` 相当・素の input + Enter、bracketed paste 不使用)。
- 結果(v2 clean・snap 05): `/clear` 実行後、直前ターン `⏺ BANANA_42` が消え、welcome バナーが再描画、
  `/context` の出力も消滅。ハーネス判定 `BANANA_42 absent = true`。
- **決定的根拠(単なるスクロールではない)**: 直前の snap 04b では `/context` の内訳がスクロールバックに表示され
  welcome バナーは画面外だった。snap 05 で **バナーが復帰しかつ `/context` 出力が消滅** = セッションのフル再描画
  = `/clear` が確実に執行された証拠(スクロールでは両方同時には起きない)。
- 根拠ファイル: `scratchpad/ctx-spike-v2/05-clear.logical.txt`、`scratchpad/ctx-spike-v2.log:129-147`。
- **実装への申し送り(カード3)**: 送信前に入力ボックスが**空 & idle**であること。boot 直後の未 settle 状態では
  長いプロンプトの `\r` が submit されず後続コマンドと連結した(run1 で実測)。→ `/clear` 送信前に
  (a) `Ctrl-U`(`\x15`)で行クリア (b) idle footer(`? for shortcuts`)確認、を挟むのが安全。

### B2. OG から `/compact` を送れるか(手動逃げ道=カード5) → **YES(実機確定)**
- 送信: `writeInput(id, '/compact\r')`。
- 結果(run1・snap 04a): `❯ /compact` → `⎿ Not enough messages to compact.`(空セッションなので中身は無いが、
  **コマンドは受理・執行された** = B2 の問い「送れて TUI が実行するか」は YES)。
- 圧縮の中身(実際に要約して空ける)は native 挙動(A1/A4・ドキュメント確定)であり本カードのスコープ外。
- 根拠ファイル: `scratchpad/ctx-spike/harness.log:79-81`。
  (v2 では直前 `/context` を閉じる `esc` がシーケンスに干渉して /compact が submit されず — ハーネスの手順由来。
  B2 の可否は run1 で確定済み。B1 と同じく「送信前に Ctrl-U + idle 確認」の申し送りが該当。)

### B3. 残量 N% を読めるか → **YES(ただし源は「画面脚注」ではなく JSONL / `/context`)**

設計上の**重要な補正**。3つの候補源を実機比較(claude 2.1.218・38.8k/200k=19% 使用の状態):

| 候補源 | 実機結果 | 常時ゲージ用途 |
|---|---|---|
| 画面フッタ脚注 `Context left until auto-compact: N%`(`claudeScreen.ts:108` の regex) | **19% 使用時は出現せず**(全 snap で NOT FOUND)。auto-compact **接近時のみ**表示されると判断 | ✗ 低〜中コンテキストで不在=常時ゲージには使えない |
| `/context` の内訳 | **読める**: `38.8k/200k tokens (19%)` / `Free space: 161.2k (80.6%)` | △ 読めるが `/context` をユーザーのセッションに**注入**する侵襲的操作。背景ポーリング不可 |
| **JSONL 最終 assistant 行の usage**(`claudeUsage.parseLine` 流用) | **YES・正確**: `input(10)+cache_read(21633)+cache_creation(17205)=38,848 tokens` ≈ `/context` の 38.8k と**一致** | ◎ 非侵襲・常時取得可。**カード2の推奨主源** |

- **結論**: 常時ゲージ(カード2)は **JSONL 集計を主源**にする
  (`contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`、
  `% = contextTokens ÷ model window(200k)`)。claude 自身の `/context` 表示と**数値一致を実機確認**。
- 画面フッタ脚注は auto-compact **接近時のアラーム**の cross-check として使える(regex は既に `claudeScreen.ts:108`・
  fixture `ownerDeskScreens.test.ts:99` で描画検証済み)が、**常時源にはならない**。
- **カード原文は「脚注を主・JSONL を fallback」としていたが、実測で逆**(JSONL 主・脚注はアラーム補助)が正しい。
- **前提: JSONL は transcript ON が必要。** OG サーバ(claude の子でない普通の Node プロセス)が起動する本番では ON。
  run1 の transcript-off は「claude の**子**として起動」した検証環境固有の汚染(`CLAUDE_CODE_CHILD_SESSION` 継承)で、
  env 除去で解消し v2 で JSONL 取得に成功した。
- 根拠ファイル: `scratchpad/ctx-spike-v2/03-context.logical.txt`(/context 内訳)、`scratchpad/ctx-spike-v2.log:44-54,149`。

---

## 4. 切り分け表 — native に任せる / OG が薄く足す(カード 2〜5 の設計根拠)

| 関心事 | native(Claude Code)がやる | OG が薄く足す | 実装カード |
|---|---|---|---|
| **満杯→圧縮の実行** | ✅ 自動コンパクト(既定ON・A1) | ❌ 作らない(独自 /compact トリガ禁止・二重発火回避) | — |
| **圧縮で何を残すか** | ✅ `# Compact Instructions` を読む(A2) | 対象 CLAUDE.md に該当セクションを**配備**するだけ | **4/5** `fbc73783` |
| **圧縮が起きた検知** | ✅ PreCompact/PostCompact フック(A3) | フック発火を受ける配線(独自ポーリング不要) | ~~3/5~~ → **5/5**(理由 §7.6) |
| **タスク境界での文脈リセット** | ❌ Board を知らない | ✅ **Board カード完了 → `/clear` を PTY 送信**(§3-B1) | **3/5** `aaec4567` ✅実装済 `boundaryClear.ts` |
| **auto-compact を切らない保証** | 既定 ON | ✅ OG が書かないことをソース走査で固定(§7.5) | **3/5** `autoCompactGuard.ts` |
| **残量の可視化(複数セッション横断)** | `/context` は単一セッション・ユーザー操作 | ✅ **JSONL 集計**で N% を吸って**ゲージ表示**(§3-B3・脚注は接近時アラーム補助) | **2/5** `dff8f211` / **5/5** `ae11d87e` |
| **手動の逃げ道(今すぐ圧縮)** | `/compact` はユーザー操作 | ✅ ボタン → `/compact` を PTY 送信(§3-B2) | **5/5** `ae11d87e` |
| **無効化・ON維持の管理** | 既定ON(A1) | ❌ 不要(ノブ非公開・既定で足りる) | — |

**設計の芯**: 「圧縮エンジン」は 100% native。OG は **(a) Board という native が知らない“タスク境界”を
`/clear` に翻訳する層** と **(b) 残量の見える化層** の2枚だけを足す。圧縮の質は native の
`# Compact Instructions` に指示を配備して担保する。

---

## 5. カード 2〜5 への含意

- **2/5 残量シグナル(`dff8f211`)**: 取得源は実測で確定 = **JSONL 最終 assistant 行の usage 集計を主源**
  (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` ÷ 200k)。claude の `/context` 表示と
  数値一致を実機確認(§3-B3)。画面脚注は auto-compact 接近時のみ出るので**アラーム補助**に留める(常時源にしない)。
  **既存 UsageHud はクォータ枠(5h/週次)であってセッション長ではない** — 別物として新規に測る
  (パーサは `claudeUsage.parseLine` を流用可)。
- **3/5 自動エンジン(`aaec4567`)**: Board カード完了を検知 → 当該セッションへ `/clear` 送信(§3-B1 が前提)。
  **専任=境界クリア**(満杯圧縮は native 任せ)。**実装済み(2026-07-25)** — 実体と責務分担は **§7**。
- **4/5 CLAUDE.md 要約指示(`fbc73783`)**: 見出しは **`# Compact Instructions`**(A2)。配備するだけの薄い層。
  **実装済み(2026-07-25)**: `compactInstructionsInstall.ts` が `~/.claude/CLAUDE.md` に
  マーカー付き block を冪等配備(`installManagedSection`)。**プロジェクトの CLAUDE.md には書かない**
  (OG はユーザの作業ツリーに書かない原則 + git 追跡ファイルを汚さない)。追加は sentinel で一度きり、
  block を消せば恒久 opt-out、ユーザ自作の同名見出しは `kept-user` で常に優先。
  効きの実測結果は **§2-A2実測** — ゴール条件は満たすが steering 自体は再現できていない。
- **5/5 ゲージ+手動逃げ道(`ae11d87e`)**: 残量ゲージ UI(2/5 のシグナル源)+ 手動「今すぐ圧縮」= `/compact` 送信(§3-B2)。

## 6. リスク・未確定・フォローアップ

- **A1 無効化ノブ非公開**: OG が auto-compact を能動的に OFF/ON する術は文書上無い。方針は「既定ON に乗る」なので
  現状問題にならないが、将来「圧縮を止めたい」要求が出たら再調査が要る。
- **A3 フック live 発火は未実測**(ドキュメント確定)。**カード 3/5 では配線しないと決めた** — 理由は §7.6。
  配線するならカード5(ゲージ再取得)側で、その時に 1 度実測する。
- **B3 の源は JSONL に確定**(§3-B3)。画面脚注は auto-compact 接近時のみ=常時ゲージには不適。
- **`/clear`・`/compact` 送信の前提**: 入力ボックスが**空・idle**であること。boot 直後の未 settle や、
  未 submit の残テキストがあると次コマンドと連結する(run1 で実測)。→ OG は送信前に `Ctrl-U`(`\x15`)+ idle 確認を挟む。
  **カード 3/5 で実装済み**(§7.4)。
- **JSONL の前提は transcript ON**: OG サーバ(claude の子でない)が起動する本番では ON。検証を「claude の子」として
  回すと `CLAUDE_CODE_CHILD_SESSION` 継承で transcript OFF になる(env 除去で解消・v2 で裏取り済み)。
- **観測: `⏸ manual mode` 表示**は `CLAUDE_CODE_*` 除去後も出た(child marker 由来ではなく permission 表示)。
  スラッシュコマンドの執行には影響なし。

---

## 7. 責務分担の正典 — 「圧縮 = native / 境界クリア = OG」(カード 3/5・実装済み 2026-07-25)

> この章が実装の正典。コードを変えたらここを直す(食い違いは現物が正)。

### 7.1 一行で

**圧縮は Claude Code(native)が 100% やる。OG は一切圧縮しない。**
OG が足すのは **「Board のカードが終わった」という native には見えない事実を `/clear` に翻訳する層だけ**。

| | 誰が | 何を | 実体 |
|---|---|---|---|
| 満杯 → 圧縮 | **native** | auto-compact(既定 ON・§2-A1) | OG のコードは無し(意図的) |
| 圧縮で何を残すか | **native** | `# Compact Instructions` を読む | `compactInstructionsInstall.ts`(配備のみ・カード4) |
| **タスク境界 → 文脈リセット** | **OG** | カード `done` 着地 → 当該ペインに `/clear` | **`boundaryClear.ts`**(本章) |
| auto-compact を切らない保証 | **OG** | 書かないことの構造的固定 | `autoCompactGuard.test.ts` のソース走査 |

### 7.2 なぜ OG 独自の「N% で圧縮」を作らないのか

作らないのは手抜きではなく**設計判断**。native は満杯圧縮が連続したとき自動で
バックオフする挙動を持つ(§2-A1)。そこへ OG が第2のトリガを撃つと、
**圧縮し続けて仕事をしないセッション**が生まれる。トリガは1つでなければならず、
その1つは native 側に置く。だから OG のトリガは **%(閾値)ではなくカード完了イベント**である。

### 7.3 なぜ「タスク境界」だけが OG の仕事なのか

圧縮は必ず何かを失う。だが**別のタスクに移るなら、失って困る文脈は無い** —
むしろ終わった仕事の文脈を持ち越すと、以降の圧縮がその要約に予算を使い続ける。
つまり境界クリアは「質を保つ最大の一手」であり、かつ
**Board を知っている OG にしか観測できない瞬間**。native には原理的に見えない。

### 7.4 実装の要点(`src/lib/server/boundaryClear.ts`)

- **カード↔ペインの紐付けは `TerminalInfo.taskId`**。カードの 実行 起動
  (`launchClaude`)と paste-task で付く。**cwd で解決しない** — 同じプロジェクトで
  並走している無関係なペインまで巻き込むため(これがこの機能で最悪の事故)。
- **送信は `Ctrl-U`(`\x15`)→ `/clear\r` の2書き込み**。Ctrl-U は飾りではなく
  §6 の実測(未 submit のテキストが次コマンドと連結する)への対処 —
  入力欄に残骸があると `/clear` が `<残骸>/clear` になり、スラッシュコマンドではなく
  **プロンプトとして送信されてしまう**。
- **作業中は「スキップ」ではなく「待つ」**。`working`(スピナー描画中)と
  `menuOpen`(権限プロンプト等で人間待ち)は送らずに queue へ残し、idle になった tick で送る。
  カードは *claude が締めの要約を出している最中* に done になるのが普通なので、
  初回 tick でスキップして捨てる実装だと**通常ケースで一度も発火しない**。
- **`menuOpen` が最も微妙な穴**: `claudeStatus()` はメニュー中を `waiting` と報告する
  (人間待ちなので)。「waiting = 打ち込んでよい」と読むと、**開いている権限プロンプトに
  Ctrl-U と `/clear` を打ち込む**ことになる。そのため menu は status と別に判定している。
- **120 秒で expire**(`BOUNDARY_CLEAR_MAX_WAIT_MS`)。2分経っても busy なペインは
  「旧カードをまだ締めている」より「**次の作業に使われ始めた**」可能性が高い。
  クリアを強行せず諦める — **クリアし損ねるのは許容、誤クリアは許容しない**という非対称が全体の設計方針。
- **`done` は状態でなく遷移で見る**(`server/routes/project.ts`)。既に `done` のカードが
  無関係な項目で再保存されただけでは再発火しない。`done` から出た場合
  (setColumn / 差し戻し rework)は queue を取り消す。
- 発火は**永続化に成功した後**。queue 登録は同期・PTY 書き込みは背景 tick なので、
  Board のレスポンスがターミナルを待つことはない。

### 7.5 auto-compact を OG が阻害していないことの担保

- **恒久保証はソース走査の歯**(`autoCompactGuard.test.ts`): OG のどのモジュールも
  `autoCompactEnabled` / `DISABLE_AUTO_COMPACT` を書かない・`/compact` を PTY に送らないことを機械的に固定。
  挙動テストでは捕まえられない(切っても「圧縮されないだけ」で見た目に壊れない)ため構造で縛る。
- **`autoCompactGuard.ts` は読むだけで直さない**。ノブ自体が公式ドキュメント未確認(§2-A1・信頼度 LOW)で、
  未確認のキーをユーザの `settings.json` に書き込むのは筋が悪い。加えて既定 ON なのだから
  `false` が入っているのは**誰かの意思**であり、OG が毎起動で黙って戻すのは
  この設計が避けたい「native との喧嘩」そのもの。だから**気づいて知らせる**に留める。

### 7.6 このカードで**やらなかった**こと(意図的)

- **PostCompact フック配線**: §4 の表では 3/5 に置かれていたが、圧縮イベントを受けて
  OG がすべき処理が本カードのゴールには無い(境界クリアは Board イベント駆動)。
  価値が出るのは**残量ゲージの再取得**=カード5側なので、そこで配線するのが正しい。
  §6 のとおり live 発火自体が未実測でもある。
- **手動 escape hatch のボタン UI** はカード5(`ae11d87e`)。本カードはサーバ側の自動化のみ。

---

### 付録: 実機キャプチャ抜粋(根拠・doc 自己完結用)

**B1 `/clear`**(v2 snap 05 — フル再描画=会話消滅):

```
╭─── Claude Code v2.1.218 ──────────────────────────────╮
│                Welcome back Nannan!                    │
│                  ~/projects/test                       │
╰────────────────────────────────────────────────────────╯
❯ /clear
[B1 RESULT] after /clear, BANANA_42 absent = true
```

**B2 `/compact`**(run1 snap 04a — コマンド受理・執行):

```
❯ /compact
  ⎿  Not enough messages to compact.
```

**B3 残量**(v2 snap 03 — `/context` 表示と JSONL 集計が一致):

```
/context 内訳:
     38.8k/200k tokens (19%)
   ⛁ System prompt: 7.9k tokens (4.0%)
   ⛁ System tools:  17.6k tokens (8.8%)
   ⛁ Memory files:  4.4k tokens (2.2%)
   ⛁ Messages:      6.9k tokens (3.4%)
     Free space: 161.2k (80.6%)

JSONL 最終 assistant usage:
   input_tokens=10, cache_read_input_tokens=21633, cache_creation_input_tokens=17205
   → contextTokens = 38,848   ( ≈ /context の 38.8k と一致 )
```

画面フッタ脚注 `Context left until auto-compact: N%` は**全 snap で NOT FOUND**(19% 使用では非表示)。

---

### 付録: 触ったファイル(調査の起点)
`src/lib/claudeScreen.ts`(auto-compact 脚注 regex は :108 に**分類用**として既存。抽出は未実装=カード2)/
`src/lib/server/terminal.ts`(`getTerminalScreen`:411 / `getTerminalScreenLogical`:504 / `writeInput`:648 / `readScreen`:142)/
`server/routes/terminal.ts`(`/api/terminal/:id/input`:353)/ `src/lib/server/claudeUsage.ts`(`parseLine`:46)/
`src/lib/server/claudeTerminal.ts`(`launchClaude`:479 / `seedPrompt`:578)。
