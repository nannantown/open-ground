# SWARM GA AUDIT — swarm 一般開放適合性監査(read-only)

**監査日: 2026-07-14**(基準 = `e2c130b` / v0.11.28 — swarm ローカル解錠 `swarmGate.ts` 込みの main 系 tip)。

> 【2026-07-16 追記】監査後に**マネージャ専任化**(2026-07-15)と **autoMerge トグル廃止**(2026-07-16)が main 入りし、本書が監査した「engine の push 経路」(§2.3 委譲先 2・§2.4 の発火条件・§5 の autoMerge arm 前提)は**構造ごと撤去**された: engine は今や worker が ready になったら司令官(claude セッション)を起こす**だけ**で、trunk へ push する経路を持たない(回帰テスト「WAKES the commander and NEVER FF-pushes」で固定)。trunk を動かす主体は司令官の統合のみ(同意はカード単位 `[hold]` + 高リスク force-hold)。本文の autoMerge 記述は監査時点の事実としてそのまま残す — 現在形の正典: [commander/03-integration-review.md](commander/03-integration-review.md)。
**読者**: プロジェクトオーナーと、発見事項を個別カードに起票する補給官/司令塔。
**この文書の役割**: swarm 機能(in-app 並列 claude オーケストレーション)を「どんなユーザーが使ってもいい」状態か、セキュリティ厳格な業務で使えるかを、**実装レベル**で監査した結果。監査のみ — 修正はしない(発見は起票の材料)。

**スコープ境界**:

- swarm 固有に限定。アプリ全体のエグレス監査は別カード(c648634b、成果物 = docs/SECURITY.md 側)— 本書は swarm engine が触るデータと経路だけを見る。
- ハードコード値スクラブはカード 331805d0 と重複しうる — 発見時は参照で示す。

**既存正典との分担**(重複させない — 詳細は必ずリンク先が正):

| 正典 | 持ち分 | 本書との関係 |
|---|---|---|
| [RELEASE_READINESS_GOALS.md](RELEASE_READINESS_GOALS.md) | 公開可否の**物差し**(ゴール定義・GAP-1〜10 台帳・同意レイヤ C-1〜C-8) | 本書の発見は既存 GAP に紐づけ、載らないものだけ NEW-n で新番号 |
| [SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md) | 安全不変条件 A〜E の定義・回帰テスト・負性コントロール | 本書 §3 の権限表は E(L4)の要約参照 |
| [commander/04-quota-models.md](commander/04-quota-models.md) | quota 五層(冷却/検知/mask/pre-launch veto/起動前プローブ)の動作正典 | 本書 §1.1 はプラン前提の適合性判定のみ |
| [commander/06-overseer-escalations.md](commander/06-overseer-escalations.md) | overseer/escalation の動作正典 | 本書 §2 は永続化先と機密性の判定のみ |
| [DISTRIBUTION.md](DISTRIBUTION.md) §6 | Windows 配布の現状 | 本書はプラットフォーム前提の判定で参照 |

矛盾を見つけたら現物(コード)が正。docs 側のドリフトは §6 に列挙した(勝手に書き換えない — 提案として)。

---

## 0. 結論サマリ

**判定: 現状の配布物は「一般ユーザーに safe by absence」— swarm は owner gate(+ 明示ローカル解錠 `swarmGate.ts`)で既定到達不能なので、今日リリースしても一般ユーザーに swarm 事故は起きない(= [RELEASE_READINESS_GOALS §1 前提の確認](RELEASE_READINESS_GOALS.md)と一致)。しかしゲートを開いた瞬間に成立しない開発者環境前提が複数ある** — 🔴 は 4 件: 心拍の `~/.claude/swarm-beat.sh` 依存(A-1/NEW-4 — 全 OS の非開発者で自律ループが完走しない。**※2026-07-28: この 1 件目は前提が陳腐化** — スクリプトは boot 時に自己配備されるので残る依存は bash のみ。§1.4 A-1 の追記参照・🔴 件数の再評価は未実施)、プラン別モデル可用性の未検知(M-1/NEW-1 — Pro プランで worker 滞留ループ)、CLI 最低バージョン検査ゼロ(C-1/NEW-2)、L4 guard の Windows 実効性未実測(P-3/NEW-3)。全台帳は §4。

**セキュリティ厳格な業務利用の可否**(§5 に詳細): データフローは「ローカル完結 + 唯一の LLM egress は claude CLI 自身」で、業務コードが第三者 SaaS に送られる経路は swarm 固有には無い(§2.3 — engine の fetch 全 6 箇所が loopback)。ログイン不可環境にはローカル解錠([SECURITY.md](SECURITY.md))が既にある。判断点は (a) カード内容が claude transcript(`~/.claude/projects/`)と argv に平文で出る(§2.2 — ディスク暗号化とシングルユーザーマシン前提)、(b) 可用性の開発者前提(上記 🔴)。**結論: owner 個人の道具としては利用可・組織向け一般開放は 🔴 解消まで不可。**

---

## 1. 開発者環境前提の全数一覧(判定付き)

判定の凡例 — **breaks**: 一般ユーザー環境で動かない/エラー。**degrades**: 動くが縮退・誤動作・読めない。**ok**: 前提に見えるが安全(根拠付き)。

### 1.1 モデル/プラン前提

**M-1 — プラン別モデル可用性の検知機構が存在しない(最重大級)**: tier ladder は `['fable','opus','sonnet','haiku']` 固定(`types.ts:2219`)、top は `SWARM_LAUNCH_MODEL='fable'`(`swarmLaunch.ts:63`)。`claudeConnection.ts` は `claude auth status` から **`plan`(pro/max/team/enterprise)を取得できる**のに、swarm 側(swarmLaunch / swarmQuota / swarmTierProbe / routes)に `.plan` の参照は**ゼロ**(grep 0 hit — 本監査で確認)。fable/opus が使えないプラン(Pro 等)のユーザーでも engine は fable から着座を試みる。

- 起動前プローブ(`swarmTierProbe.ts`)の wall 判定は **quota 枯渇文言のみ**(`QUOTA_EXHAUSTION_PATTERNS` = "reached your … limit" / "usage limit" / "switch models with /model" 等 — `swarmRateLimitText.ts:75-`)。「このプランでは使えないモデル」系の拒否はどのパターンにも掛からず verdict `'unknown'` → **fail-open で fable に着座**する設計(swarmTierProbe ヘッダの明示契約)。
- 着座後の反応サンサー(worker PTY screen への `RATE_LIMIT_PATTERNS`)も同文言セット — プラン拒否では cooling が掛からず ladder が下がらない。
- **結末**: Pro プランユーザーでは worker が拒否画面のまま滞留 → 実行時間上限で強制回収、を dispatch のたびに繰り返す可能性。**verdict: breaks(Max 以外のプラン)/ severity: high**。
- 未実測の注記: プラン非保有時に CLI が返す実文言はこの開発機(Max)では再現不能 — 「alias 自体を拒否(argv エラー)」か「対話内で refusal」かで壊れ方が変わる。GA 前に Pro アカウントでの実測が必須(§4 GA-2)。

**M-2 — ladder/mask の縮退設計自体は健全(ok)**: `swarmAllowedModels.ts` は per-key fail-open(欠損キー=使える側に縮退・全 OFF は書込境界で拒否)、`isTierSpawnable` = allowed AND not-cooling の単一述語。fable を owner が OFF にすれば walk は opus から始まる — **プラン問題の実用的回避策が既に存在する**(ただしユーザーが手動で知って設定する前提。既定は全 ON)。

**M-3 — probe のタイミング定数は開発機実測由来(ok/軽微)**: `TIER_PROBE_LAUNCH_WAIT_MS=8s` / `TIER_PROBE_TIMEOUT_MS=90s` は 2026-07-13 の dev 機実測(19〜73s)からのサイズ。低速マシンでは 'unknown' fail-open に倒れるだけで安全側(縮退=probe の学習が遅れるのみ)。

**M-4 — quota 検知は claude CLI の英語出力に密結合(degrades)**: `/usage` スクレイプ(claudeUsageCli — [commander/04](commander/04-quota-models.md) が正典)も refusal パターンも CLI の**英語文言**前提。CLI の文言改版・将来のローカライズで検知が黙って消える(fail-open 設計なので「暴走」ではなく「保護の消失」— cooling されず同じ壁に再突入)。CLI 更新に追随する運用が前提。

### 1.2 claude CLI バージョン/フラグ前提

**C-1 — CLI バージョン検査が存在しない + `--remote-control` 常時 ON(high)**: swarm の全ロール(worker/manager/supply)は `--remote-control <name>` を **ALWAYS**(non-empty 名で必ず emit — `swarmLaunch.ts:81-86`)、加えて `--effort` / `--session-id` / `--add-dir` / `--disallowed-tools` / `--strict-mcp-config` / `--dangerously-skip-permissions` を組む(`claudeTerminal.ts:198-344` buildClaudeArgv)。一方 `--version` / バージョン比較のコードは**ゼロ**(grep 0 hit)。`--remote-control` は新しめのフラグ — 古い claude を持つ一般ユーザーでは未知フラグで claude が即 usage エラー死し、PTY には殻だけ残る。**verdict: breaks(古 CLI)**。最低要求 CLI バージョンの明示 + 起動前検査(または未知フラグ時の縮退)が GA 要件(§4 GA-3)。

**C-2 — effort はガード済み(ok)**: `SWARM_LAUNCH_EFFORT` は `CLAUDE_EFFORTS` メンバーシップ検査を通してのみ emit(`swarmLaunch.ts:68-76`)— リネーム/タイポは undefined(CLI 既定)に縮退し、壊れた argv は出ない。

**C-3 — claude バイナリ解決はクロスプラットフォーム設計済み(ok)**: `claudeConnection.ts` が Windows(claude.cmd をシェル経由)/ nvm・volta(login-shell PATH)/ per-OS well-known パスの3段で解決。旧 claudeCli.ts の UNIX 前提は解消済み。probe も同じ preflighted binary を使う(`resolvedClaudeBin`)。

**C-4 — probe は `-p --strict-mcp-config` 前提(ok/軽微)**: probe argv = `--model <tier> -p <PROMPT> --strict-mcp-config`(`swarmTierProbe.ts:269`)。このフラグが無い古 CLI では probe が失敗するが verdict 'unknown' = fail-open で縮退のみ(C-1 が先に致命)。

**C-5 — `/usage` スクレイプは CLI バージョンで形が変わる実績あり(degrades・既知)**: 2.1.196→2.1.207 で per-model 行が消えた実測([commander/04 §5.7](commander/04-quota-models.md)、swarmTierProbe ヘッダ)。probe はまさにその補償として存在する — CLI 更新のたびに quota 層の再実測が要る、という**恒常的な追随コスト**は GA 後も残る。

### 1.3 git identity・リポジトリ状態前提

**G-1 — engine の統合 git は ambient config 非依存(ok・根治済み)**: `swarmIntegrate.ts:42-60` の GIT_OPTS が identity fallback(`GIT_COMMITTER/AUTHOR_NAME/EMAIL` = 'OPEN GROUND' / `swarm@openground.local`、process.env 設定時はそちらを尊重)+ `GIT_TERMINAL_PROMPT=0`(credential prompt でハング不可)+ 60s timeout を全 git 呼び出しに供給。identity 未設定マシンでも rebase/統合は完走する。

**G-2 — worker セッション内の commit は ambient identity 依存(degrades / medium)**: worker 規律は「ready 前に自分で commit」だが、その commit は claude が worktree 内で打つ素の `git commit` — ユーザーの `user.name/email` 未設定なら exit 128 で失敗し、worker は ready に到達できない。worker spawn 側の GIT_OPTS(`swarmWorker.ts:51`)は `GIT_TERMINAL_PROMPT=0` のみで identity fallback は注入されない(worktree 準備は commit しないので engine 自身は困らない — 困るのは worker)。git を使う repo を登録する時点で identity 設定済みが通例のため medium 止まり。

**G-3 — trunk 名/リポジトリ形状の前提は fallback 済み(ok)**: trunk 解決は `origin/HEAD` symbolic-ref → 'main'(`swarmIntegrate.ts:155-172`)、worker の base ref は `['origin/main','main','HEAD']` preference(`swarmWorker.ts:70`)— master-only repo でも HEAD に落ちて動く。remote の無い repo は fetch best-effort(`:193-195`)+ push skip(§2.4)で自然縮退。

**G-4 — private repo の credential は helper 前提(degrades / low)**: `GIT_TERMINAL_PROMPT=0` により credential 未設定はハングでなく即失敗。fetch は best-effort なので worktree が古い base で切られる縮退のみ。

### 1.4 外部ヘルパー依存(~/.claude/)

**A-1 — worker 心拍が `~/.claude/swarm-beat.sh` に依存(自分で3点裏取り済み・最重大)**:

1. **プロンプト焼き込み**: `src/lib/server/swarmWorker.ts:142` — in-app worker へ注入する規律文に「心拍 bash ~/.claude/swarm-beat.sh はフェーズ境目ごとに必ず打つ」が焼き込まれている。このスクリプトは開発者マシンの私物(`~/.claude/` はユーザー領域 — OPEN GROUND は配布しない)。
2. **代替経路なし**: `server/routes/swarm.ts` に心拍を受ける HTTP ルートは存在しない(beat/heartbeat ルート定義ゼロ)。in-app 心拍もファイル(`~/.openground/swarm/<repo-key>/<branch>.json`)経由で、書き手は同スクリプトのみ。
3. **ready の単一ソース**: `swarmOrchestrator.ts:985` `const ready = probe.heartbeat?.ready === true`、`:2353` `j.readyToMerge === true`、`swarmWorkerRegistry.ts:197/235/255` — worker の「統合可」は heartbeat ファイルの `readyToMerge` **のみ**から判定される。

**縮退の程度**: 生存判定は PTY 出力(`lastOutputAt`)で代替される(`swarmOrchestrator.ts:5960-5978` — total silence subsumes never-beat)ので「即死」ではない。しかし worker が完了しても ready が永遠に立たず、**カードは doing に滞留 → 実行時間上限で強制回収**が既定の結末になる。**verdict: breaks / severity: critical**。[RELEASE_READINESS_GOALS §3.3](RELEASE_READINESS_GOALS.md) は Windows worker の心拍手段としてのみ言及(GAP-8 に包含)しているが、**macOS の一般ユーザーにも同じ穴が開く**(スクリプトを持っているのは開発者だけ)— GAP-8 のスコープを「全 OS の非開発者環境」に広げるべき。

**⚠ 2026-07-28 追記(GAP-8 カードでの確認 — 前提①は陳腐化)**: 上記 1. の「このスクリプトは開発者マシンの私物(OPEN GROUND は配布しない)」は**もう成り立たない**。`swarm-beat.sh`(+ `openground-swarm-lib.sh` / `/order` / `/supply` スキル)は **boot 時にアプリが `~/.claude/` へ自己配備する** — `installSwarmTooling()`(`src/lib/server/swarmToolingInstall.ts:73` に `swarm-beat.sh` の配備先定義)を `server/index.ts:212` が起動シーケンスで呼び、実体は electron-builder の `build.files`(`package.json:104`)で配布物に同梱済み。よって**「スクリプトを持っているのは開発者だけ」を根拠とする macOS 一般ユーザーの穴は塞がっている**(= NEW-4 の対処案のうち「guard 同様の自己インストール」が実装された形)。残る依存は **bash そのもの**(bash の無い素の Windows)だけで、verdict: breaks / critical はその範囲でのみ有効。**未追随(本カードの範囲外・再評価は別カード)**: §0 の「🔴 は 4 件」1 件目の説明・§4 の NEW-4 行・§5 の可用性行。

**A-2 — guard は自己インストール(ok・ただし開示事項)**: L4 guard は swarm-beat.sh と違い**アプリが自己インストール**する: `hooksInstall.ts` が `scripts/openground-guard.js` を `~/.openground/guard/` にコピー(sandbox プロファイルが write-deny する場所)し、**ユーザーの global `~/.claude/settings.json` に PreToolUse hook を upsert**(バックアップ `settings.json.openground.bak` 作成)。in-app 経路の依存としては健全だが、「アプリがユーザーのグローバル claude 設定を書き換える」行為自体は GA 時の開示事項(hook は `OPENGROUND_GUARD=1` セッション以外 no-op なので通常の claude 使用への影響はゲート済み — guard ヘッダの WORKER-ONLY gate)。

### 1.5 ハードコード値(UUID/パス/メール)

**クリーン(ok)**: swarm 実装全ファイル + `scripts/openground-guard.js` に対する grep(2026-07-14)で、`/Users/` 絶対パス・開発者名・メールアドレス・UUID リテラルは**ゼロ**。tmux への言及はコメント/ドキュメント文のみで実行コードに tmux 依存なし。スクラブカード 331805d0 のスコープと重複する発見は swarm 固有分には**無かった**。意図的な焼き込みは fallback identity の `swarm@openground.local`(架空ドメイン — G-1)と loopback origin `127.0.0.1:47776`(§2.3)のみで、どちらも適正。

### 1.6 プラットフォーム/ロケール前提

**P-1 — claude 解決・PTY 起動は Windows 対応済み(ok)**: `claudeConnection.ts`(claude.cmd/シェル経由)、`claudeTerminal.ts`(pickShell、PowerShell native-arg)、probe(`swarmTierProbe.ts` isWindows 分岐)は Windows 対応実装済み。配布実態は [DISTRIBUTION.md §6](DISTRIBUTION.md) が正典。

**P-2 — worker worktree の node_modules symlink は Windows で失敗しがち(degrades / medium)**: `swarmWorker.ts:246-253` — symlink は try/catch の best-effort(失敗しても worker は起動する)が、Windows の非 Developer Mode では symlink 特権が無く失敗が既定。結果、worker が `npm test`/`tsc` の完了ゲートを回せず、**品質フロアが Windows でだけ静かに縮退**する。

**P-3 — L4 guard は POSIX lexer 前提・win32 分岐ゼロ(未検証 / high・Windows GA blocker)**: `openground-guard.js`(2055 行)に win32/PowerShell 分岐は**ゼロ**(grep 0 hit)。Bash ツールの shell が PowerShell になる Windows worker では、(a) POSIX として parse 不能 → fail-closed で全 block = worker 進行不能(breaks)、または (b) PowerShell 構文が POSIX と異なる意味に parse され **veto をすり抜ける**(不変条件 E の穴)— どちらに倒れるかが未実測。Windows で swarm を開く前に実測必須(§4 GA-6)。

**P-4 — ロケール**: quota/rate-limit 検知は CLI の英語出力前提(§1.1 M-4 と同根 — fail-open なので保護の消失のみ)。それ以外に OS ロケール依存(日付 parse 等)は swarm コアに見当たらない。

---

## 2. swarm 固有データフロー

### 2.1 永続化マップ(何がどこに書かれるか — 全数)

swarm engine 自身の fs 書込は以下で**全数**(swarm*.ts の writeFile/appendFile/createWriteStream 全 grep + パス関数の突合、2026-07-14):

| データ | パス | mode | 書き手 |
|---|---|---|---|
| escalations 本体(質問/anomaly) | `~/.openground/escalations.json` | **0600 + fsync**(`swarmEscalations.ts:206`) | engine |
| escalation shot(worker PTY tail 断片) | `~/.openground/escalation-shots/<id>.txt` | **dir 0700 / file 0600**(`:389-391`) | engine |
| quota cooling mirror | `~/.openground/swarm-quota.json`(`paths.ts:45`) | 既定 umask | engine |
| worker セッション記録 | `~/.openground/projects/<uuid>/swarm-sessions.json`(`projectDataFile` 経由) | 既定 umask | engine |
| 統合ロック | `~/.openground/` 配下(`swarmIntegrationLock.ts` — wx フラグの atomic lock) | 既定 umask | engine |
| 心拍 | `~/.openground/swarm/<repo-key>/<branch>.json` | worker 側(swarm-beat.sh)依存 | **worker**(engine は `swarmWorkerRegistry.ts:97-107` で read-only) |
| worker worktree(コード実体) | `~/.openground/projects/<uuid>/worktrees/<branch>/` | 既定 umask | worker |

**すべて `~/.openground/`(+ claude 自身の `~/.claude/`)内で完結** — スキャン対象のユーザー repo には書かない(git-shared モードの `.openground/` は swarm 外)。

**PTY 画面はディスクに書かれない**: `swarmOrchestrator.ts` に writeFile/appendFile は**ゼロ**(grep 0 hit)。worker の screen バッファは in-memory のみで、ディスクに残る断片は escalation shot(0600)だけ。

### 2.2 機密性の評価(ユーザーコード/プロンプトが残る場所)

- **worker プロンプト(カード title+notes)はファイル経由でなく claude の positional argv**(`swarmWorker.ts:457` `initialPrompt: buildOrderInjection(...)` → `claudeTerminal.ts` が argv 末尾に置く)。含意 2 点: (a) **`ps` で同一マシンの他プロセスから可視**(マルチユーザーマシンでは他ユーザーにも)— シングルユーザー前提の設計。(b) **claude CLI 自身の transcript(`~/.claude/projects/<cwd>/<sessionId>.jsonl`)にプロンプト+作業内容がフルで残る** — これは swarm 固有でなく claude CLI の挙動だが、「カードに書いた機密が swarm 経由で `~/.claude/` に永続する」事実として業務利用判定(§5)に効く。
- escalation shot は worker screen の tail = **ユーザーコード断片を含みうる** — 0600/0700 で自衛済み(この保護は swarm 系ストアの中で最も強い。逆に quota/sessions は umask 任せだが、中身は tier 名と時刻/セッション ID で機密性が低い — 整合)。
- 機密の最終的な守りは **HOME のディスク暗号化(FileVault 等)とローカルアカウント分離**に依存 — swarm はそれを強化も破壊もしない。

### 2.3 エグレス検証(外に出る経路の全数と「無いこと」の根拠)

swarm 実装ファイル群(swarm*.ts + server/routes/swarm.ts)の外向き通信 API 全 grep(fetch/https/net/axios/WebSocket、2026-07-14):

- `fetch` は **6 箇所すべて `loopbackOrigin()` = `http://127.0.0.1:${PORT|47776}`**(`swarmOrchestrator.ts:2207` — 自分自身の Board API の読み書き)。https/net/axios/WebSocket/XMLHttpRequest は **0 hit**。
- したがって swarm engine 自身がネットワークで外に出る経路は**コード上ゼロ**。外に出るのは次の 2 つの**委譲先**だけ:
  1. **claude CLI**(worker/manager/supply/overseer-brain の PTY)→ Anthropic へ。swarm 固有の追加エグレスではなく、ユーザーが claude を使う行為そのもの(subscription-only — API key 経路なし)。
  2. **git push**(autoMerge 統合時のみ・plain push・origin の swarm/* → リモート trunk)— §2.4 のとおり既定 OFF + in-memory arm。**engine が push しないことのコード根拠は §2.4**。(2026-07-15/16 にこの経路自体が撤去 — 冒頭追記)
- owner gate のロール解決(Supabase)は swarm ファイル群の外(`roles.ts`)— アプリ全体エグレス監査(c648634b / [SECURITY.md](SECURITY.md))の持ち分。swarm 固有分としては「ロール確認のため owner gate が Supabase に依存する」事実のみ §5 で扱う。

### 2.4 engine が push しないことのコード根拠(自分で静的確認済み)

[RELEASE_READINESS_GOALS §4.1(5)](RELEASE_READINESS_GOALS.md) の静的確認を本監査でも実施(2026-07-14、`a64c8cc`):

- `swarmIntegrate.ts` の push 実呼び出しは **2 行のみ**: L288(FF push)と L339(rebase 後 push)。どちらも引数配列に `--force`/`-f` 無し。
- `--force` の hit は L347 `worktree remove --force` のみ(エンジン自前の throwaway worktree 掃除 — push とは無関係)。
- push の発火条件: autoMerge arm(既定 OFF・in-memory・再起動で OFF)+ 検証ゲート緑 + 敵対レビュー通過のみ。正典: [SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md) 不変条件 A/D。(2026-07-15/16 に engine の push 発火そのものが撤去され、この静的確認の対象コードは dormant — 冒頭追記)

### 2.5 L4 ガードの実地観測(本監査セッション内)

本監査自体が `OPENGROUND_GUARD=1` の policed worker セッションで実行されており、監査中に guard の実発火を観測した: インライン `python3 -c "<program>"` が **`openground-guard BLOCKED: python3 runs a computed / process-substitution program the guard cannot read`** で deny された(exit 2)。inline-code フラグ封鎖([SWARM_SAFETY_INVARIANTS §E](SWARM_SAFETY_INVARIANTS.md))が机上でなく実働している一次証拠。

---

## 3. 権限モデル1枚表

4 つの独立した層。**互いに独立**(1 層の無効化が他層を外さない)。詳細正典: [SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md)(C/E)、[SANDBOX_EXPERIMENT.md](SANDBOX_EXPERIMENT.md)(L3)。

| 層 | 発火条件(現物) | 対象 | 守るもの | fail 方向 |
|---|---|---|---|---|
| **owner gate**(到達制御) | `getCustomTabRole() !== 'owner'` → 403(`server/routes/swarm.ts` 全ハンドラ先頭)+ UI は `experiments.swarm`(owner ロール AND トグル) | 全 `/api/swarm/*` 呼び出し元(署名済みセッション必須 — リクエスト内容は信用しない) | swarm 到達そのもの。**現状の一般ユーザー保護の実体** | closed(未ログイン/ロール無し/オフライン初回 = 'none'。オフライン中の縮退は §3.1) |
| **SWARM_MANAGER=1**(役割タグ) | `swarmManager.ts:154` / `swarmSupply.ts:117` が manager/supply の PTY env に付与 | manager / supply セッションの**識別のみ** | 何も守らない(tooling/skills 用タグ)。guard 本体(`scripts/openground-guard.js`)に `SWARM_MANAGER` の参照は**ゼロ**(grep 0 hit — 本監査で確認)。manager は信頼された human-in-the-loop として意図的に非 police | n/a |
| **A3/L4 ガード**(決定論 veto) | `OPENGROUND_GUARD=1` + `OPENGROUND_GUARD_WRITE_ROOTS`(`claudeTerminal.ts:539-540`、worker spawn 時に `swarmWorker.ts` が `guard:{writeRoots:[worktree]}` で注入) | 無人 worker / overseer-brain セッションの全 PreToolUse | push 全形態・履歴 nuke・write roots 外書き込み・guard 自身の substrate。`--dangerously-skip-permissions` を生き延びる唯一の veto | closed(parse 不能 = exit 2)+ **配線も fail-closed**(`ensureGuardWiring` — 検証 NG なら spawn 拒否。GAP-2 根治済み) |
| **sandbox L3**(OS 封じ込め) | `experiments.sandbox`(owner 限定実験・既定 OFF)→ `sandbox-exec` 包囲。overseer-brain は macOS で無条件 L3 | 実験 ON の claude PTY / overseer-brain | L4 が構造的に見えない層(ライブプロセスからの実行等 — guard header の honest scope) | **macOS 限定**(Windows は L3 不在 = GAP-7) |

### 3.1 owner gate の解決経路(`roles.ts` 全読で確認)

署名済み app ログイン(Supabase OAuth)必須 → `OPENGROUND_OWNER_EMAILS`/`OPENGROUND_TESTER_EMAILS` env override(設定時はネットワーク不要 — dev/test/オフライン脱出ハッチ) → Supabase `og_roles` をユーザー自身の JWT + RLS で読む → 5 分 in-memory キャッシュ → 失敗時は stale cache → `'none'`。バイナリに識別情報の焼き込みは無し(意図的 — `roles.ts` 冒頭コメント)。

---

## 4. ギャップ一覧(重大度付き・起票の種)

[RELEASE_READINESS_GOALS §5](RELEASE_READINESS_GOALS.md) の GAP-1〜10 に**載っていない新規発見のみ** NEW-n で採番(既存 GAP と重なる指摘は参照で示す)。重大度: 🔴 = 一般開放 blocker、🟡 = 設計判断/実測が必要、🟢 = 品質。

| # | 重大度 | 発見(本書の節) | 起票の種(観測可能な完了条件案) |
|---|---|---|---|
| **NEW-1** | 🔴 | プラン別モデル可用性の検知機構なし(§1.1 M-1)。Pro プランで fable dispatch → probe/sensor とも素通り → worker 滞留ループ | `claudeConnection().plan` を ladder 初期 mask に反映(pro ⇒ fable OFF 等)or プラン拒否文言を probe の wall 判定に追加。**先行して Pro アカウント実測カード**(拒否の実文言確定)が必要 |
| **NEW-2** | 🔴 | claude CLI の最低バージョン検査ゼロ + `--remote-control` 常時 ON(§1.2 C-1)。古 CLI で worker 即死 | swarm 有効化/worker spawn 前に `claude --version` を検査し、最低要求版未満は spawn 拒否 + 明示エラー(fail-closed)。最低要求版を docs に明記 |
| **NEW-3** | 🔴(Win) | L4 guard の PowerShell 構文対応が未実測 — 「全 block」か「veto すり抜け」か不明(§1.6 P-3)。すり抜けなら不変条件 E が Windows で無効 | [RRG §4.3](RELEASE_READINESS_GOALS.md) の Windows 実機 QA 8 項(push block 確認)に「**PowerShell 固有構文での evasion 試行**(`&` call operator / `Invoke-Expression` / `-EncodedCommand` 等)」を追加し、block されることを確認 — されないなら Windows swarm は L4 成立まで封印 |
| **NEW-4** | 🔴 | worker 心拍手段が開発者私物 `~/.claude/swarm-beat.sh` のみ — **全 OS の非開発者**で自律ループが完走しない(§1.4 A-1)。GAP-8 は Windows の問題として扱うが実際は全員 | in-app 心拍経路の新設(例: `POST /api/swarm/beat` + worker プロンプトへの curl/組込コマンド指示、または guard 同様の自己インストール)。非開発者 HOME での worker 1 巡 E2E が緑。**※2026-07-28: 対処案のうち「guard 同様の自己インストール」は実装済み**(`swarmToolingInstall.ts:73` + `server/index.ts:212` の boot install・`package.json:104` で同梱) — 「私物なので持っていない」前提は消え、残る未解決は **bash 依存のみ**。🔴 の格付け自体が要再評価(§1.4 A-1 の 07-28 追記) |
| **NEW-5** | 🟡 | worker セッションの git commit が ambient identity 依存(§1.3 G-2) | worker spawn env に `GIT_COMMITTER/AUTHOR_*` fallback を注入(engine 側 G-1 と同型)し、identity 未設定 HOME での worker commit 成功をテスト固定 |
| **NEW-6** | 🟡(Win) | node_modules symlink が Windows で失敗 → 完了ゲート(npm test/tsc)が回らず品質フロアが静かに縮退(§1.6 P-2) | Windows は junction(`symlink(…, 'junction')`)へ fallback。失敗時は worker プロンプトに「検証ゲート不可」を明示注入して silent 縮退を殺す |
| **NEW-7** | 🟢 | quota/rate-limit 検知が CLI 英語文言に密結合(§1.1 M-4 / C-5)— CLI 改版で保護が黙って消える | リリースチェックリストに「CLI 更新時の refusal 文言再実測」を追加([RRG §4.1](RELEASE_READINESS_GOALS.md) への追記提案) |
| **NEW-8** | 🟢 | 開示不足分: worker プロンプトの argv 可視性(ps)・claude JSONL への機密残留・`~/.claude/settings.json` 書換(§2.2 / §1.4 A-2) | GAP-10 の開示文にこの 3 点を含める(実装変更なしの文書要件) |

既存 GAP との重複確認: L4 配線 fail-closed 化(GAP-2)は根治済みを実装で追認(`ensureGuardWiring` — §3 表)。Windows L3 不在(GAP-7)・実機 E2E(GAP-3)・開示 UI(GAP-10)は本監査でも同判定 — 新規事実は上表のみ。

---

## 5. セキュリティ厳格環境での業務利用可否

**判定: 「開発者個人(owner)の道具」としては今日から利用可。「組織の業務ツール」としての一般開放は不可 — 🔴 4 件(NEW-1〜4)+ GAP-1/10 の解消が前提。**

業務セキュリティ観点の評価(§1〜§3 の実測に基づく):

| 観点 | 評価 | 根拠 |
|---|---|---|
| データのローカル完結性 | ⭕ 強い | swarm engine の egress はコード上ゼロ(§2.3 — fetch 全 6 箇所 loopback)。LLM への経路は claude CLI のみ(subscription-only・API key 経路なし)。統合はローカル git merge、push は autoMerge 明示 arm(既定 OFF・再起動 OFF)のみ(2026-07-15/16〜は engine push 経路ゼロ・司令官の統合のみ — 冒頭追記。ローカル完結の評価は強まる方向) |
| 機密のディスク残留 | △ 条件付き | escalation 系は 0600/0700 で自衛(§2.1)。ただしカード内容は claude transcript(`~/.claude/projects/`)に平文残留 + argv 可視(§2.2)— **FileVault 等のディスク暗号化とシングルユーザーマシンが前提条件** |
| 認証・到達制御 | ⭕(2 経路) | 既定 = Supabase owner gate(fail-closed・オフライン初回は 'none')。ログイン不可の業務環境には **swarm ローカル解錠**(`swarmGate.ts` — settings.json 手編集/env、UI なし・HTTP 設定不能・swarm 限定)が 2026-07-14 に正典化済み — 詳細は [SECURITY.md](SECURITY.md) が正 |
| 暴走時の機械的ガード | ⭕(macOS)/ ❓(Win) | L4 guard(worker 限定・fail-closed 配線・本監査中に実発火を観測 §2.5)+ macOS は overseer-brain に L3。Windows は L4 単層(GAP-7)かつその L4 自体が未実測(NEW-3) |
| 可用性(プラン/CLI 依存) | ✖ 現状 | Max プラン + 新しめ CLI + `~/.claude/swarm-beat.sh` 保有(= 開発者)以外では自律ループが完走しない(NEW-1/2/4)。**※2026-07-28: 「保有」条件は解消済み**(boot 時に自己配備 — §1.4 A-1 追記) — 残るのは bash の有無(bash の無い素の Windows)と NEW-1/2 |

**条件付き利用の最小条件**(今日、リスクを理解した組織が owner 運用する場合): macOS + FileVault + シングルユーザーマシン + Max プラン + 最新 claude CLI + selfSupply は arm しない + 人手前提の統合運用は `[hold]` prefix で(autoMerge は 2026-07-16 廃止 — engine は push せず、統合は司令官。無人 land を避けたいカードはタイトル先頭 `[hold]` で承認待ちに)+ 機密カードを swarm に流さない運用規律。

---

## 6. docs との突合(矛盾・ドリフト — どちらが正か)

方針: 現物(コード)が正。以下は**文書側への修正提案**(本監査では書き換えない)。

1. **[RRG §3.3](RELEASE_READINESS_GOALS.md)「swarm エンジンはプラットフォーム中立に書かれている」** — engine 本体(execFile git)は真だが、**L4 guard の POSIX lexer 前提(NEW-3)と node_modules symlink(NEW-6)が抜けている**。§3.3 のチェック 3 点に「L4 の PowerShell 実効性」を明示追加する提案。
2. **[RRG GAP-8](RELEASE_READINESS_GOALS.md)** — 心拍 `swarm-beat.sh` を「Windows worker の代替」問題として記載しているが、実体は**全 OS の非開発者環境で成立しない**(§1.4 A-1 / NEW-4)。GAP-8 のスコープ拡大(または NEW-4 の独立起票)を提案。
3. **[commander/02-worker-lifecycle.md](commander/02-worker-lifecycle.md) の心拍記述** — 「worker は swarm-beat.sh で心拍を打つ」前提の運用章は開発者環境でのみ真。GA 文脈では NEW-4 解消後に追随が必要(現時点では現物どおりで矛盾なし — 予告のみ)。
4. **[SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md) / [commander/06](commander/06-overseer-escalations.md)** — 本監査の §2(データフロー)・§3(権限表)と**矛盾は検出されなかった**。GAP-6(SWARM_MANAGER 旧記述のコメント残存)は既知のまま — 本書 §3 は現物(manager no-op)側で記載済み。
5. **基準ずれの注記**: [RRG](RELEASE_READINESS_GOALS.md) の「到達不能」前提は 2026-07-14 のローカル解錠(swarmGate)で「明示 opt-in がない限り到達不能」に更新済み(RRG 冒頭【2026-07-14 更新】)— 本書 §5 はその更新後の姿で判定している(食い違いなし)。

---

*鮮度管理: 本書の「現状」記述は 2026-07-14(`a64c8cc`)のスナップショット。安全機構の詳細は本書でなく正典(SWARM_SAFETY_INVARIANTS.md / commander/ 各章)を参照し、食い違ったら現物が正 — 本書の該当行を直す。*
