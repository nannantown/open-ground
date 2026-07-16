# 02 — worker の生涯と worktree 管理(spawn → 心拍 → promote → 回収/再起動)

**対象コミット: `cc7c60e`**(origin/main tip、2026-07-10 時点)。本文中の `file:line` は全てこのコミットの行番号。
**読者**: 司令塔(og-manage / manage セッション)。worker の一生に関わる全ての状態とその在り処を、コード根拠付きで示す。
**関連**: `01-engine-core.md`(エンジン中枢 tick/pass/dispatch/monitor — 別章)。

---

## 0. 司令塔が最初に知るべき 3 つの真実

1. **心拍の鮮度は `heartbeatAt` を信じてよい(2026-07-11 根治済み)。** `GET /api/swarm/workers` の `heartbeatAt` は、以前はエンジンが追跡している worker で「エンジンが最後に monitor パスでその worker の心拍を読んだ時刻の写し」(凍結値)を返していたが、ディスク心拍の `updatedAt` を優先するよう修正された(§4)。ディスク `~/.openground/swarm/<repoキー>/<branch名変換>.json` の `updatedAt` を直接読む裏取りは、API にアクセスできない場面のフォールバックとして引き続き有効。
2. **worker の「停止」は worktree の force 削除とセット。ただし未コミットの作業は消えない(2026-07-12 根治)。** オーナーの Stop・エンジンの crash/stall/runaway 回収・rework 上限超過・統合成功後 cleanup — どれも `removeSwarmWorktree(…, { force: true })` を通る(§6 の全経路表)。コミット済みの作業は branch に残る(統合成功後 cleanup だけは branch も `-D`)。**エンジン経由の teardown(§6 経路 2〜5)は worktree を消す前に dirty を検査し、あれば `git add -A` + 回収理由入りの WIP コミットを branch に打つ**(`commitWipBeforeTeardown` — swarmOrchestrator.ts:2583)。保全に失敗したら **worktree を消さない**(作業の唯一のコピーだから)。ただし **「rebase しただけでコミット差分が消えた」状態は依然として保護されない**(それはコミット済み扱いで dirty ではない)。
3. **RESTART(`POST /api/swarm/worker` に `worktree` を渡す)は「同じ worktree・同じ branch で claude を再起動」**。worktree が既に消えていれば失敗する(`resolveExistingSwarmWorktree` が throw — src/lib/server/swarmWorker.ts:325-342)。つまり「停止(=worktree 削除)してから RESTART」は成立しない。作業を続けさせたいなら worktree を消さずに再起動する。

---

## 1. 構造 — 何がどこにあるか

| 責務 | ファイル | 中身 |
|---|---|---|
| worker spawn 本体(worktree 作成 + claude 起動 + /order 注入) | `src/lib/server/swarmWorker.ts` | `createSwarmWorktree`(:174) / `spawnSwarmWorker`(:455) / `removeSwarmWorktree`(:261) / `resolveExistingSwarmWorktree`(:325) |
| 起動モデル/エフォート/リモコンの共有既定 | `src/lib/server/swarmLaunch.ts` | `SWARM_LAUNCH_MODEL='fable'`(:52) / `resolveSwarmModelEffort`(:257) / `execModeMaxWorkers`(:272) |
| claude PTY 起動(フラグ組み立て) | `src/lib/server/claudeTerminal.ts` | `launchClaude`(:461) / `buildClaudeArgv`(:261) / `buildLaunchCommand`(:380) |
| PTY プール(生存・linger・sweep) | `src/lib/server/terminal.ts` | `createTerminal`(:230) / `listActiveTerminals`(:414) / `killTerminalsByCwd`(:465) / `sweepTerminalPool`(:533) |
| worker 一覧 API の統合ロジック | `src/lib/server/swarmWorkerRegistry.ts` | `listSwarmWorkers`(:157) / `readHeartbeats`(:91) / `parseHeartbeat`(:67) |
| エンジン(monitor / promote / 回収 / 差し戻し) | `src/lib/server/swarmOrchestrator.ts` | `monitorWorkers`(:4208) / `classifyWorker`(:978) / `defaultReadHeartbeat`(:2434) / `defaultRecoverWorker`(:2649) / **`commitWipBeforeTeardown`(:2583 — 回収前の WIP 保全)** / `defaultCleanup`(:4094) / `stopOrchestratorWorker`(:6634) |
| 実行時間上限と rate-limit hold 台帳 | `src/lib/server/swarmOrchestrator.ts` | `MAX_EXEC_MS`(:343) / `HOLD_CREDIT_CAP_MS`(:352) / `isRunaway`(:1347) / `endRateLimitHold`(:1963) / `rateLimitHoldCredit`(:1980) |
| 残骸掃除(branch / 心拍ファイル / terminal pool) | `src/lib/server/swarmJanitor.ts` | `sweepSwarmBranches`(:170) / `sweepSwarmHeartbeats`(:310) / `runSwarmJanitor`(:405) / `swarmRepoKey`(:280) |
| clean worktree の一括掃除 | `src/lib/server/worktreeCleanup.ts` | `cleanProjectWorktrees`(:105) / `listProjectWorktrees`(:83) |
| HTTP routes(spawn / remove / workers / stop) | `server/routes/swarm.ts` | `POST /api/swarm/worker`(:241) / `POST /api/swarm/worktree/remove`(:451) / `GET /api/swarm/workers`(:501) / `POST /api/swarm/orchestrator/worker/stop`(:591) |
| worktree 一覧/clean の route | `server/routes/project.ts` | `GET /api/project/worktrees`(:449) / `POST /api/project/worktrees/clean`(:458) |
| UI(Swarm タブの Terminate/Restart) | `src/components/canvas/modules/SwarmModule.tsx` | terminate(:430-434) / `restartWorker`(:703-728) |
| 心拍の書き手(worker 自身が叩く) | `~/.claude/swarm-beat.sh`(repo 外・各マシンにインストール済み) | branch/worktree/task/phase/blockers/readyToMerge/updatedAt を 1 ファイルに上書き |
| 共有型 | `src/lib/types.ts` | `OrchestratorWorker`(:999-1046) / `SwarmWorkerRecord`(:1056-1088) |

worker の在り処(ディスク):

- worktree: `~/.openground/projects/<uuid>/worktrees/<branch名のswarm/以降>/`(central worktrees dir。`centralWorktreesDir` — swarmWorker.ts:179)
- 心拍: `~/.openground/swarm/<repoキー>/<branchのスラッシュを'-'に置換>.json`(swarmWorkerRegistry.ts:97, swarmOrchestrator.ts:2249)
- repoキー = `<repoルートのbasename>-<sha1(realpath(.git))先頭8桁>`、スペースと `/` は `_` に置換(swarmJanitor.ts:280-292。swarm-beat.sh 側の `sw_repokey` と同一導出)

---

## 2. spawn の実体

### 2.1 経路は 3 つ、実体は 1 つ

worker が生まれる経路は (a) エンジンの dispatch パス(swarmOrchestrator.ts:4562 `deps.spawnWorker` → :2313 `defaultSpawnWorker`)、(b) 手動/司令塔の `POST /api/swarm/worker`(server/routes/swarm.ts:241)、(c) UI の Restart(SwarmModule.tsx:714 — 同じ route に `worktree` 付きで POST)。**全経路が `spawnSwarmWorker`(swarmWorker.ts:455)に合流する。** 合流点の内部順序は model 解決(全 tier OFF なら `NoAllowedModelTierError` で fail-closed)→ **L4 guard 配線検証(NG なら `GuardWiringError` で fail-closed — §2.5、GAP-2 根治 2026-07-11)** → worktree 作成 → claude 起動。

`POST /api/swarm/worker` の入口で効く順序(server/routes/swarm.ts):

1. swarm owner ゲート(:253 `hasSwarmOwnerAccess` — src/lib/server/swarmGate.ts。owner の app-login(サーバ永続 session)**または**サーバローカル解錠(env `OPENGROUND_LOCAL_OWNER=1` / settings.json 手編集 `swarmLocalOwner:true` — ログイン無効の業務モード用、docs/SECURITY.md)で通過、どちらも無ければ 403。リクエスト由来の値(cookie/ヘッダ/body)では絶対に開かないので、通過側もオーナーがログイン済み(か解錠済み)のマシンなら cookie 無しの curl でそのまま通る)
2. `validateProjectPath`(:256)
3. ゴール解決 — `taskId` があれば Board カードの title+notes が優先(:261-269)、無ければ `title`/`notes`(:270-275)。合計 8KiB 上限(:113, :279-281)
4. claude preflight(:286-287 — CLI 不在/未ログインは worktree を作る前に 503)
5. **twin-dispatch ガード**(:301-345): fresh dispatch は カードを todo→doing に CAS で claim してから spawn(:317)。エンジンが同カードを予約中なら 409(:310-312, :341-344)。**RESTART は免除**(:299 `isRestart` — 既存 branch への再入場であり新 branch を作らないため)
6. spawn(:350-358)。失敗したら claim を todo に返す(:362)
7. 成功後、カードに branch を記録(:367 `recordCardBranch` — review/統合ステージが読む持ち手)

### 2.2 worktree 作成(`createSwarmWorktree` — swarmWorker.ts:174-246)

1. `projectUUIDFromPath` で registry UUID を解決し、central worktrees dir を `mkdir -p`(:178-180)
2. `git fetch origin main` を best-effort(:184 — オフラインでも続行)
3. base ref は `origin/main` → `main` → `HEAD` の優先順(:68 `SWARM_BASE_REF_PREFERENCE`、:72 `pickBaseRef`)
4. branch 名 = `swarm/<hintスラッグ>-<MMDD-HHMMSS>-<48bitランダム12桁>`(:200-201, :79-87)。dir 名は `swarm/` を剥いだ残り(:90-91)
5. dir が既に存在したら **`worktree add` 前に fail-loud**(:208-210 — 衝突時に他人の生きた worktree を巻き込み削除しないため)
6. `git -c branch.autoSetupMerge=false worktree add -b <branch> <dir> <base>`(:216-225)。失敗したら自分が作った分だけ掃除して throw(:226-230)

### 2.3 node_modules は本体への共有 symlink(npm install 厳禁の理由)

worktree の `node_modules` は**本体 checkout の `node_modules` への symlink**(swarmWorker.ts:235-243)。理由:

- worktree はフルチェックアウトで、毎回 `npm install` するとディスクと時間を浪費する。symlink なら即座に build/test が走る
- **worker が worktree 内で `npm install` を打つと、symlink 越しに本体の `node_modules` を書き換える** = 全セッション(本体で dev 中のオーナー、他 worker)に波及する。だから worker への注文には「npm install 厳禁」が焼き込まれている(auto-memory: `reference_swarm_worktree_shared_node_modules_symlink`)
- sandbox 実験 ON のときは node_modules を**完全 READ-only** にする(swarmWorker.ts:487 コメント、claudeTerminal.ts:432-448 `writeSandboxProfile` — sandbox 化された worker が `.vite/deps` 等を汚染して、オーナーが後で非 sandbox で実行するコードに毒を仕込む昇格経路を塞ぐ)
- 削除時は symlink を先に unlink する(swarmWorker.ts:288-300 — `node_modules/` 形式の .gitignore は「ディレクトリのみ」マッチなので **symlink は untracked 扱い**になり、非 force 削除と定期 sweep を永久にブロックするため)

### 2.4 claude 起動フラグ(worker の場合)

`workerLaunchOpts`(swarmWorker.ts:389-447)→ `launchClaude`(claudeTerminal.ts:461)→ `buildClaudeArgv`(claudeTerminal.ts:261-354)。実際に組み上がる argv:

```
claude --session-id <uuid> --dangerously-skip-permissions \
  --model <tier> [--effort <effort>] --strict-mcp-config \
  --remote-control worker "$(cat /tmp/openground-prompt-…/prompt.txt)"
```

| フラグ | 由来 | 意味 |
|---|---|---|
| `--session-id <uuid>` | claudeTerminal.ts:317 | fresh 起動。JSONL の場所が決定的になる |
| `--dangerously-skip-permissions` | swarmWorker.ts:442(`permissionMode:'bypass'` を spread の**後**に置き無条件化)→ claudeTerminal.ts:321-325 | 無人 worker が承認プロンプトで永久停止しないため |
| `--model` / `--effort` | swarmWorker.ts:466-473 `resolveSwarmModelEffort`(実行モード×カード重み×quota 冷却×許可 tier マスク — swarmLaunch.ts:257-267)。worktree 作成**前**に解決し、全 tier OFF なら `NoAllowedModelTierError` で spawn 自体を fail-closed(swarmWorker.ts:473) | 既定は最上位 tier(`SWARM_LAUNCH_MODEL='fable'` — swarmLaunch.ts:52)/`max`(:57-65) |
| `--strict-mcp-config` | swarmWorker.ts:433 | user-scope `~/.claude.json` / project `.mcp.json` の MCP サーバを**一切ロードしない**。bypass worker にとって MCP は guard(PreToolUse hook)の外側にある RCE 経路なので、発生源ごと閉じる |
| `--remote-control worker` | swarmWorker.ts:434 → swarmLaunchDefaults(swarmLaunch.ts:85-95) | claude.ai / モバイルから 'worker' 名で操作可能 |
| positional prompt | swarmWorker.ts:446 `buildOrderInjection` | `/order ゴール: …` を**起動時引数**として渡す(後述) |
| `appContext:false` | swarmWorker.ts:414 | Board API 使用カード(--append-system-prompt)を積まない。worker のプロトコルは /order スキル |

`/order` を**TUI に打ち込まず positional で渡す理由**(swarmWorker.ts:144-156): 起動済み TUI にスラッシュコマンドを注入するとオートコンプリートが Enter を飲み込み**送信されない**(claude 2.1.185 で実測)。positional なら起動時に確実に実行され、tmux 時代の send-keys Enter-lag も構造ごと消える。ゴールは 1 行に平坦化される(:101-103 `flattenOneLine` — 制御バイト除去+空白折り畳み。ESC 注入も同時に防ぐ)。

**注入されるテキストの構成**(swarmWorker.ts:133-142): `/order ゴール: <title> — <notes>` + (差し戻し再投入なら)`【前回の差し戻し理由…】<priorFailure>` + **worker 規律**(:130-131 `WORKER_ORDER_RULES` — push 全形態禁止・commit+ready で停止・心拍必須(30 分無心拍は anomaly)。2e7beb2 事故 = worker が /order スキルの司令塔向け §4 を実行して main に push した、の再発防止として全 spawn に焼き込み)。

### 2.5 guard(deterministic veto は worker 限定 — SWARM_MANAGER は guard でなくタグ)

deterministic veto(グローバル配線済みの PreToolUse hook = openground-guard.js)は **1 系統だけ・worker 限定**(WORKER-ONLY guard scoping、2026-07)。かつて本節は「SWARM_MANAGER=1 = 司令塔向けの破壊的 git ブロック」という 2 系統説を書いていたが、それは旧仕様 — 2026-07-11 の GAP-6 ドリフト一掃(コード側コメントの旧仕様記述の置換)と同時に本節も現物へ追随済み:

- **worker(veto が効く唯一の対象)**: `guard: { writeRoots: [worktree] }`(swarmWorker.ts:423)→ launchClaude が `OPENGROUND_GUARD=1` + `OPENGROUND_GUARD_WRITE_ROOTS=<worktree>` を注入(claudeTerminal.ts:535-543)。グローバル配線済みの PreToolUse hook(openground-guard.js)が exit 2 で deny — bypass(--dangerously-skip-permissions)でも上書きできない唯一の veto。Write/Edit/Bash の書き込みを worktree 内に閉じ込め、`git push` は全形態 deny。共有 `.git` は意図的に writeRoots に**入れない**(:423 コメント — git はバイナリ経由で動くので Bash ルールが統治する。root にすると .git への生リダイレクトまで正当化してしまう)
- **司令塔/補給官(veto 対象外)**: `SWARM_MANAGER=1`(swarmSupply / swarmManager が設定)は役割**タグ**(tooling / skills 向け)であって guard opt-in では**ない**。本体 checkout で動くこの 2 役はユーザーが会話する**信頼セッション**につき veto は no-op — policing は confined worker 限定(openground-guard.js 冒頭の GATE コメント・swarmManager.ts / swarmSupply.ts 各ヘッダが正典)。worker が env を渡さないのは SWARM_MANAGER タグが司令塔/補給官専用だから(swarmWorker.ts:353-354, claudeTerminal.ts:101-108 — 行番号は 2026-07-11 GAP-6 ブランチ基準)
- **配線の fail-closed 検証(GAP-2 根治・2026-07-11)**: guard が効く前提は「`~/.claude/settings.json` の PreToolUse エントリ(5 matcher: Bash/Write/Edit/MultiEdit/NotebookEdit)+ `~/.openground/guard/openground-guard.js` の実体」の両輪 — Claude Code は **hook 不在を fail-OPEN で通す**ため、boot の `installHooks()`(server/index.ts — fire-and-forget)が失敗しても以前は無ガード worker が spawn できた(worker worktree は本体と `.git` 共有 = 共有 ref に到達可能)。現在は `spawnSwarmWorker` が worktree 作成**前**に `ensureGuardWiring()`(hooksInstall.ts)で「PreToolUse 5 matcher の配線が期待コマンドと一致 + インストール済み guard 実体が**期待版**(repo/app の `scripts/openground-guard.js` と byte 一致)」を検証し、NG なら idempotent な `installHooks()` を 1 回 self-heal 試行 → **ディスクから再検証**(install 結果は証明として信じない)→ それでも NG なら **spawn 拒否**(`GuardWiringError`)+ `'guard-unwired'` fatal 通知(bell + OS トースト、同種は 10 分 throttle)。全経路(engine dispatch / POST /api/swarm/worker / RESTART)が §2.1 の合流点で通る。検証器 `verifyGuardWiring` は **STRICT reader**(読めない/parse 不能/エントリ欠落/byte 不一致 = すべて NG — tolerant read に載せた fail-closed ガードは fail-open に化ける)。回帰ネット: swarmSafety.test.ts の INVARIANT **E-FAILCLOSED**(F1〜F6 — 配線を意図的に壊して拒否・no-worktree・bell 通知を assert、negative control 込み)
- **hook source の解決は cwd 非依存 + worktree root 拒否 + 安定パス設置(2026-07-12 根治 → 2026-07-14 再発 → 構造根絶)**: かつて `installHooks()` は hook/guard スクリプトを `process.cwd()/scripts/` から解決していたため、**cwd が swarm worktree を指した状態で install が走ると、その worktree の絶対パスがグローバル `~/.claude/settings.json` に焼き込まれ、janitor が worktree を消した時点で全 claude セッション(OPEN GROUND と無関係なプロジェクト含む)の Stop hook が MODULE_NOT_FOUND で壊れる**実事故が起きた(0712 観測)。0712 根治(モジュール位置起点の解決 + `~/.openground` 配下 root の拒否)は、**0714 に再発を許した**: 拒否 fence が `openGroundHome()`(= `OPENGROUND_HOME` リダイレクトに従う)基準だったため、worker が自ブランチ検証で `OPENGROUND_HOME=$(mktemp -d) node server/dist/index.cjs` を worktree 内から起動すると fence だけ /tmp へ移動し、書き込み先 `settingsPath()`(homedir 基準)は本番 `~/.claude/settings.json` のまま — worktree root が素通りして再汚染した(**守る側と書く側が別の env を見る非対称**が穴)。現在は 3 層: ① `resolveHookSourceRoot()` は**モジュール自身の位置**起点で解決(cwd は一切見ない)、② 拒否 fence は `openGroundHome()` **と** `homedir()/.openground` の**両方**(リダイレクトで fence を動かせない)、③ **hook 本体を guard 同様 `~/.openground/hooks/` へコピー設置し、settings.json は常にその homedir 基準の安定パスだけを参照**(解決 root はコピー元にのみ使用)— どんな root が解決されようと worktree/checkout パスがグローバル設定に書かれることが構造的に不可能。既存の汚染エントリ(消えた worktree を指す)は次回 install 時に desired 不一致で安定パスへ**自己修復**され、重複 our エントリも 1 本に正規化される。`installOgManageSkill` も同じ resolver 経由。回帰ネット: **hooksInstall.test.ts**(R1: cwd=worktree でも worktree/checkout パスが settings.json に載らない / R2·R2b: worktree 常駐エンジンは何も書かない・既存 settings byte 不変 / R3: verify が worktree source を期待版と誤認しない / R4: 解決の cwd 非依存 / R5: 0714 再発形 = OPENGROUND_HOME リダイレクトでも homedir 側 fence が拒否 / R6: 安定パスへのコピー実体 + wire / R7·R8: 汚染エントリの自己修復・重複正規化)

起動コマンド全体は `buildLaunchCommand`(claudeTerminal.ts:380-403)が 1 行に組む: `<env…> OPENGROUND_OWNED=1 <argv> ; exit`。`; exit` により claude 終了 = シェル終了 = PTY exit がそのまま「worker 死亡」シグナルになる。

### 2.6 spawn 後にエンジン側で起きること(engine dispatch の場合)

spawn 成功後、エンジンは in-memory roster に `stage: 'starting'` で push(swarmOrchestrator.ts:4573-4584)、カードを todo→doing に move(:4595)。roster エントリの形は `OrchestratorWorker`(types.ts:999-1046): terminalId / branch / worktree / taskId / taskTitle / startedAt / model / stage / phase / note / heartbeatAt / reworkAt。**この roster は in-memory(globalThis)で、プロセス再起動で消える**。再起動後のエンジンは既存 worker を数えない(= `GET /api/swarm/workers` では「エンジン外 worker」として見え続ける。§3.3)。

---

## 3. 心拍プロトコル

### 3.1 書き手 — swarm-beat.sh(worker が自分で叩く)

`bash ~/.claude/swarm-beat.sh <phase> <ready:true|false> "<要約>" ["<blockers>"]`。worktree 内から実行すると branch と `pwd -P` を自動検出し、**1 worker = 1 ファイルを丸ごと上書き**する:

```
~/.openground/swarm/<repoキー>/<branchの/を-に置換>.json
{"branch":…,"worktree":…,"task":…,"phase":…,"blockers":…,"readyToMerge":true|false,"updatedAt":"<ISO UTC>"}
```

(swarm-beat.sh 実物より。repoキー導出はサーバ側 swarmJanitor.ts:280-292 / swarmOrchestrator.ts:2220-2238 と同一 — worktree の `--git-common-dir` は本体 `.git` に解決されるので、**どの worktree から打っても同じ repo ディレクトリに落ちる**)

### 3.2 読み手は 3 系統(それぞれ読む場所とタイミングが違う)

| 読み手 | 実装 | いつ読む | 何に使う |
|---|---|---|---|
| ① エンジンの monitor パス | `defaultReadHeartbeat`(swarmOrchestrator.ts:2243-2280) | **エンジンが running で、かつその worker のカードが doing 列にある時だけ**、pass ごと(:3906-3915) | promote 判定(`readyToMerge`→ready、`phase==='blocked' or blockers`→blocked — :2258-2269)+ 表示用 phase/note/at を roster に fold(:3718-3723 `withHeartbeat`) |
| ② workers API | `readHeartbeats`(swarmWorkerRegistry.ts:91-115) | `GET /api/swarm/workers` の**リクエスト毎**(ディレクトリ全 .json を読む) | 3 ソース統合の素材(§3.3)。ファイル内の `worktree` フィールドがキー(:112 — 無いファイルはスキップ) |
| ③ janitor | `sweepSwarmHeartbeats`(swarmJanitor.ts:310-390) | overseer ON のとき 15 分毎(swarmOverseer.ts:126, :568-570)。HTTP route は無い | 15 分以上 stale **かつ** worker が証明可能に消滅(branch 消滅 or worktree 消滅 — :364-372)したファイルだけ unlink(:377) |

### 3.3 GET /api/swarm/workers の 3 ソース統合(`listSwarmWorkers` — swarmWorkerRegistry.ts:157-254)

identity は **worktree パス**(1 worker = 1 worktree)。優先順に:

1. **エンジン roster**(:175-195): `getOrchestratorState` 経由。richest(taskId/taskTitle/startedAt/stage)。`heartbeatAt` は **`hb?.updatedAt ?? w.heartbeatAt`**(:188、2026-07-11 修正) — ディスクの心拍を優先し、無い場合だけエンジン in-memory の凍結値へフォールバック。`ready`/`blocked`/`blockers` も同じ `hb`(ディスクの心拍)から取る(:189-193)ので、1 レコード内の鮮度混在は解消済み。`phase`/`note` はエンジンの凍結値のまま(修正対象外)
2. **エンジンが知らない live claude PTY**(:207-233): terminal pool は process-wide なので、この project の central worktrees dir 配下(:216)+ branch が `swarm/*`(:219)の二重ガードで絞る。`heartbeatAt` は**ディスクの `updatedAt`**(:226)
3. **心拍ファイルだけ残った dead worker**(:238-251): PTY なし・エンジン記録なし。`terminalId` 欠落がそのまま「死んでいる」ことを意味する(restart 対象)。`heartbeatAt` はディスク値(:246)

**stage フィールドの有無 = エンジン所有かどうか**(types.ts:1071-1075)。stage が無い worker(ソース 2/3)だけが UI から Terminate/Restart できる(SwarmWorkerPane.tsx:49-58)。

なお `getOrchestratorState` が返す `workers` は roster のうち **PTY が生きているものだけ**(`stateOf` — swarmOrchestrator.ts:1852, :1863)。つまり「ソース 1 に居る = エンジン roster に居て、かつ PTY 生存」。PTY が死んだエンジン worker は monitor が回収するまで roster に残るが、state API には出ない(その間、心拍ファイルがあればソース 3 で見える)。

---

## 4. 【解消済み】workers API が古い心拍を返した実測(2026-07-10)と修正(2026-07-11)

**根治済み**: `swarmWorkerRegistry.ts` のソース 1(エンジン roster)が `heartbeatAt: hb?.updatedAt ?? w.heartbeatAt` を返すよう修正された(worker ブランチ `swarm/swarm-workers-api-heartb-*` → main 統合待ち)。`hb` は同じ関数がリクエスト毎に `deps.readHeartbeats()` で読むディスク心拍そのもので、ディスクに心拍が無い場合だけエンジンの凍結値へフォールバックする。以下は**修正前の原因調査の記録**(再発時の参照・回帰テストの根拠として保持)。

**実測(修正前)**: ディスク上の心拍 `updatedAt=2026-07-10T00:41:49Z` なのに、`GET /api/swarm/workers` は `heartbeatAt=2026-07-09T07:55:26Z` を返した。

**原因はキャッシュでも fs watch でも読みタイミングでもない。データフローの構造**である:

1. その worker は**エンジン roster に居て PTY が生きていた**(ソース 1 に該当)。ソース 1 の `heartbeatAt` は `w.heartbeatAt`(swarmWorkerRegistry.ts:188)で、これは**エンジンの monitor パスが `withHeartbeat` で fold した最後の値**(swarmOrchestrator.ts:3718-3723)
2. `withHeartbeat` が呼ばれるのは monitor パスの「カードが doing 列」ルートだけ(:3903-3965)。以下のどれかに入った瞬間、**その worker の `heartbeatAt` は凍結する**:
   - **エンジンが止まった**(Autonomy OFF)。`stopOrchestrator` は「already-dispatched workers は残す + worker set も維持」(:5755-5758 コメント, :5793-5799 — timer だけ止める)。roster は生き、pass は回らない → 凍結
   - **promote 済み**(stage='done' / カードが review・done 列): early-return で `next.push({ ...w, stage: 'done' })` — **withHeartbeat を通らない**(:3877-3883)
   - **人間がカードを todo/blocked に引き戻した**: alive なら verbatim keep(:3897-3901)— 凍結
   - **カードが消えた**: alive なら verbatim keep(:3888-3891)— 凍結
3. (修正前)一方 worker 側は死んでいないので心拍を打ち続け、ディスクの `updatedAt` だけが進む。ソース 1 が `hb.updatedAt` を**使わなかった**ため、API は凍結値を返し続けた

実測ケースの読み解き(修正前): `heartbeatAt=07-09T07:55:26Z` は「エンジンがその worker の心拍を最後に読んだのが 07-09 07:55 だった」ことを意味する。その後エンジンが停止された(または対象 worker が promote されて doing 監視から外れた)まま、worker は 07-10 00:41 まで心拍を打っていた — 上記経路のどれかに一致する。

### 司令塔がどちらを信じるべきか(修正後)

修正後は `heartbeatAt` がどのソースでもディスク直読相当になったため、下表の「信じるな」は解消済み。API の値をそのまま鮮度判定に使ってよい(§8 のディスク直読ワンライナーは、API 側にアクセスできない/裏取りしたい場合のフォールバックとして引き続き有効)。

| フィールド | 信頼度 | 根拠 |
|---|---|---|
| `heartbeatAt`(stage 付き = エンジン worker) | **信じてよい(修正後)**。`hb?.updatedAt ?? w.heartbeatAt` でディスク優先に変更済み | swarmWorkerRegistry.ts:188 |
| `heartbeatAt`(stage 無し = エンジン外 worker) | リクエスト毎にディスクを読むので新鮮(元から) | swarmWorkerRegistry.ts:226, :246 |
| `ready` / `blocked` / `blockers` | **全ソースでディスク由来 = 常に新鮮**。信じてよい | swarmWorkerRegistry.ts:189-193, :227-231, :247-250 |
| `phase` / `note`(エンジン worker) | 修正対象外 — monitor が最後に fold した値のまま(凍結の可能性あり)。`heartbeatAt` のみ今回の修正対象 | swarmWorkerRegistry.ts:186-187(w.phase / w.note)、swarmOrchestrator.ts の `withHeartbeat` |
| ディスクの `updatedAt` | **唯一の真実**(変わらず) | worker(swarm-beat.sh)だけが書き、上書きのみ |

**運用ルール(修正後)**: `heartbeatAt` は API の値をそのまま信用してよい。ただし `phase`/`note` は今回の修正対象外なので、それらの鮮度が必要な場面では引き続きディスク直読(§8)で裏取りする。

---

## 5. 状態機械 — stage 遷移・promote・差し戻し・回収

### 5.1 stage 遷移(エンジン worker のみ)

```
dispatch ──> starting ──(心拍 or コミット or 25秒経過)──> running ──(promote)──> done ──(PTY exit)──> roster から消滅
                └──────────── どの段階でも: PTY 死亡/stall/runaway → 回収(recoverLost) ────────────┘
```

- `starting`: spawn 直後。心拍もコミットも無い最初の 25 秒(`STARTUP_GRACE_MS` — swarmOrchestrator.ts:207)は「起動中」表示(:988-989)
- `running`: 何らかの活動が見えた後。差し戻し直後も強制的に running — エンジン差し戻し(:5404, :5554)/外部差し戻しの観測(:4370-4371。§5.3)/古い心拍での promote 抑制(:4440-4441)のいずれも running に戻す
- `done`: promote 成功(:4458)。**PTY が生きている限り roster に残り**(claude TUI は /order 完了で exit しないのが普通)、exit した瞬間 slot が空く(:4381-4385)。ただしカードが doing に戻っていたら done のままにしない — 外部差し戻しの観測で running に再武装(§5.3)

### 5.2 promote 条件(`classifyWorker` — swarmOrchestrator.ts:978-990)

```
promote = commitsAhead > 0 && ( ready || ( !alive && !blocked ) )
```

- `commitsAhead` = **branch ref が trunk より先行しているコミット数**(:2392 `defaultCountCommitsAhead`)。worktree ではなく共有 repo の branch ref で数えるので worktree 消滅後も判定可能。trunk はプロジェクトごとに解決(origin/main 固定ではない)
- `ready` = 心拍ファイルの `readyToMerge === true`(:2449)
- `blocked` = `phase==='blocked'` または blockers 非空(:2460)
- **「dirty=0」という直接条件は promote には無い**ことに注意。dirty が効くのは worktree 削除の可否(git が非 force 削除を拒否 — §6)と司令塔の統合作業であって、promote 判定は「コミットが積まれたか + 完了宣言(または死亡かつ非 blocked)」だけ。worker が commit せずに done true を打っても commitsAhead=0 で promote されない(だから「ready 前に必ず自分でコミット」が worker の掟)

promote 成功でカードは doing→review に移り(:4447)、review 列は統合ステージ(review → verify → 敵対レビュー → rebase/FF → done)の入力になる(01-engine-core.md の領分)。

### 5.3 reworkAt との新旧比較(差し戻し後の re-promote 抑制)

`reworkAt`(型定義 types.ts:1057-1068)が立つ経路は **2 つ**:

1. **エンジン自身の差し戻し** — 統合ステージがカードを review→doing に差し戻すとき、roster エントリにその場で `stage='running'` + `reworkAt = now` を刻む(レビュー差し戻し: swarmOrchestrator.ts:5404-5405 / conflict rebase 委譲: :5554-5555)。
2. **外部差し戻しの観測**(2026-07-13 追加) — 司令官の `POST /api/project/tasks {rework:[…]}` や UI ドラッグ(review→doing)は **in-memory roster に届かない**。monitor は「roster が `stage:'done'` なのにカードが `doing` に戻っている」形を外部差し戻しとみなし、`stage='running'` + `reworkAt = now`(観測 tick の時刻 — Board の rework verb はカードに差し戻し時刻を記録しないため)で再武装して通常の監視フローに落とす(:4360-4377。engine log に `Board 側の差し戻し(review→doing)を観測` が 1 回出る)。**この観測が無かった時代は直後の stage:'done' 早期 continue(:4379-4385)が先に効いて永久スキップ** — worker が直して ready を打ち直してもカードは doing に沈み続けた(2026-07-13 実測: 55 分放置しても昇格せず、司令官の手動 setColumn でしか復旧しなかった)。

**既知の残穴(未解決)**: この観測は roster に `stage:'done'` のエントリが**残っている**ことが前提。**PTY が差し戻しより前に exit していた**場合、worker はその時点の tick で「done worker closed — slot freed」(:4381-4385)として roster から既に消えており、再武装する対象が存在しない — **カードは worker 無しで doing に沈む**(55 分沈黙と同じ症状が、この稀な条件でだけ残る)。しかも `orphan-doing` 異常(:5996)は **worktree の消滅が発火条件**(:6091-6099)で、slot-freed 経路は worktree を撤去しないため発火しない。復旧は手動(setColumn で review へ戻す、または worktree/branch を確認して再 dispatch)。

どちらの経路でも、**心拍ファイルは worker しか書けないので、差し戻し前の `readyToMerge:true` が残ったまま**になる。そのままだと次 pass が即 re-promote → 同一 tip の verify skip-RED → また差し戻し、で rework 予算(`MAX_REWORKS=2` — :238)が壁時計 30 秒で燃え尽きる。これを防ぐのが:

```
promote && w.reworkAt のとき: hbAtMs > reworkAtMs(差し戻しより厳密に新しい心拍)でなければ promote を落とす
```

(:4433-4442)。**司令塔への含意**: 差し戻された worker は「swarm-beat.sh で done true を打ち直す」まで絶対に review に戻らない — エンジン差し戻しでも Board API / UI ドラッグの差し戻しでも同じ(古い心拍での再昇格はどちらの経路でも起きない)。worker が心拍を打たない限りカードは doing に残り続ける(stall 監視には掛かる — :4424-4432 のフォールスルー設計)。回帰テスト: swarmOrchestrator.test.ts の describe「monitorWorkers — re-promote suppression after a 差し戻し (reworkAt)」に、①エンジン昇格 → ②Board 直接差し戻し → ③古い心拍では抑制 → ④新しい心拍で再昇格、の通しがある。

**回収先の非対称(事実・コードは仕様のまま)**: 差し戻しの**後**に PTY が死んだ場合の回収先は経路で異なる — **外部差し戻し**では再武装後の fall-through が `recoverLost` に落ち、古い心拍の `ready===true` を見た `recoveryColumn`(:1039)が **blocked** に送る(worktree 撤去・branch 保持・WIP 救済つき)。**エンジン自身の差し戻し**では worker 不在/死亡分岐が **todo** に戻して再配車する(:5426)。どちらも警告ログ付き・ロスレスなので挙動としては許容 — 非対称であること自体を知っておく。

差し戻しの分岐(`reworkOrPark` — :5316):

- **LIVE worker**: 同一 branch 継続。カード review→doing、`instructRework` で PTY に理由を直接注入(:5407)+ 差し戻し理由を `reworkReasons` に永続 memo(:5338 — worker が死んで再 dispatch になった時 `priorFailure` として次の /order に注入される :5142, :5169)
- **worker 不在/死亡**: カード review→todo(新 worker に再 dispatch)+ 死骸 teardown(**worktree force 削除**、branch 維持 — :5422-5457)
- **上限超過(count > MAX_REWORKS)**: カード blocked 退避 + teardown(:5341-5344)。人手待ち

### 5.4 回収(recoverLost / recoveryColumn)

PTY 死亡・stall(両チャネル 10 分沈黙 — `STALL_SILENCE_MS` :271)・runaway(**実作業**が 90 分 — `MAX_EXEC_MS` :343、env `OPENGROUND_SWARM_MAX_EXEC_MIN` で可変。§5.5)・permission 詰まり・rate-limit 長期化のとき、`recoverLost`(:4230)が worktree+PTY を teardown し、カードの行き先を `recoveryColumn`(:1031)で決める:

| 状況 | カードの行き先 |
|---|---|
| rate-limit | todo(自動リトライ — 作業は branch に保存済み) |
| runaway / permission / question | blocked(人手) |
| 心拍 ready なのに成果ゼロ | blocked(「完了宣言したのに統合物が無い」= 人が見る) |
| 心拍 blocked | blocked |
| リトライ予算切れ(`RECOVER_MAX_REQUEUE=1` :217) | blocked |
| それ以外の bare crash | todo(もう 1 回だけ自動再試行) |

**どの行き先でも、teardown の前に未コミット作業は WIP コミットで branch に保全される**(§6 冒頭)。回収後に `git log <branch>` を見れば `WIP: swarm reclaim auto-save (<理由>)` が立っている(dirty が無ければ何も起きない)。

### 5.5 実行時間上限(runaway)は **実作業時間**で測る — quota 待ちは控除される(2026-07-12 根治)

`MAX_EXEC_MS`(:343、既定 90 分)が bound するのは **worker が働いた時間**であって wall-clock ではない。判定は `isRunaway(startedAt, now, MAX_EXEC_MS, heldMs)`(:1347):

```
実作業時間 = (now − dispatch) − rate-limit hold 累計
```

- **hold 台帳**: エンジンは worker(terminalId)ごとに rate-limit hold の**確定分**を `engine.rateLimitHeldMs` に積む(`endRateLimitHold` :1963 — `engine.rateLimited` を落とす唯一の seam)。hold の起点は「limit 通知が画面を掴んだ瞬間」(`holdSince` = `engine.limitScreen` の onset)であって、hold が**確定**した時刻(`since`)ではない — 確定ゲート(最大 `STALL_SILENCE_MS`=10 分)の分まで遡って返す
- **進行中の hold も実時間で控除**される(`rateLimitHoldCredit` :1980 = 確定分 + in-flight)。今まさに limit で凍っている worker が「長く生きている」だけで暴走扱いされることはない
- **控除には上限がある**: `HOLD_CREDIT_CAP_MS`(:352 = `MAX_EXEC_MS` と同値)。limit↔作業 を往復して runaway 判定を無限に先送りできないようにするため。**worker の絶対 wall-clock 寿命 = MAX_EXEC_MS + 上限**(既定 180 分)
- journal の文言も実作業ベース: `worker runaway — worked 91m ≥ 90m execution limit (alive 111m; 20m of rate-limit hold credited back): …`

**なぜ変えたか(実測・2026-07-12)**: 旧実装は「wall-clock で数える — band が広いから rate-limit 待ちを含めても足りる」と明言していた。その前提が破れた: **quota 待ち 20 分 + 実作業 84 分 = 通算 104 分** → 90 分上限で runaway 判定 → 実装完了済み・未コミットの **15 ファイル 47KB が worktree ごと消滅**した。quota 待ちは worker の落ち度ではないので、その時間を worker の予算から引いてはならない。

---

## 6. worktree の回収 — 誰が・いつ・何を消すか(全経路表)

worktree を消せるコードパスは以下で**全部**(検索根拠: `removeSwarmWorktree` / `recoverWorker` / `deps.cleanup` / `cleanProjectWorktrees` の全呼び出し元)。全経路が central worktrees dir 配下限定ガードを通る(removeSwarmWorktree :266-275 / cleanProjectWorktrees は listProjectWorktrees :92 でフィルタ)。

**WIP 保全(2026-07-12 根治)**: `deps.recoverWorker`(= `defaultRecoverWorker` :2649)を通る経路 = 表の **2・3・4・5** は、worktree を消す前に必ず `commitWipBeforeTeardown`(:2583)を通る:

1. PTY を kill(先に殺す — 消す木にまだ書かれては困る)
2. worktree の `node_modules` symlink を外す(`node_modules/` 記法の .gitignore だと symlink が untracked に見え、`git add -A` が拾ってしまうため)
3. `git status --porcelain` が **空なら no-op**(clean な木に偽のコミットは作らない)
4. dirty なら `git add -A` + `git commit --no-verify` で **`WIP: swarm reclaim auto-save (<TeardownReason>)`**(:1006 — crash/stall/runaway/rate-limit/permission/question/stopped/rework)を branch に打つ。本文に「未検証。統合前にレビューせよ」と明記される。committer identity が解決できない環境では swarm 名義で 1 回リトライする
5. **保全に失敗したら worktree を消さない**(`{removed:false}` — 作業の唯一のコピーだから)。journal に `uncommitted work could not be saved (…) — worktree kept` が出る
6. 保全したら journal に `worker reclaimed with UNCOMMITTED work — auto-saved as a WIP commit (<sha>) on <branch>` が出る ← **司令塔はこれを見て branch を拾う**(再 dispatch は新 branch を切るので、この行だけが手掛かり)

経路 **1・6・7・8** は通らない(1・7 = エンジン外の API、6 = 統合成功後なのでコミット済み、8 = エンジン自身の一時 dir)。

| # | 経路 | トリガ | force? | WIP保全 | branch | 心拍ファイル | engine log の文言 |
|---|---|---|---|---|---|---|---|
| 1 | `POST /api/swarm/worktree/remove`(server/routes/swarm.ts:451-474) | UI Terminate(SwarmModule.tsx:430-434)/司令塔 curl | body の `force`(soft は dirty 拒否) | — | 残る | 残る(janitor 待ち) | (エンジン外 — ログ無し) |
| 2 | `stopOrchestratorWorker`(swarmOrchestrator.ts:6634) | オーナーがエンジン worker を Stop(`POST /api/swarm/orchestrator/worker/stop`) | **force** | **あり**(`stopped`) | 残る | 残る | `worker stopped by owner — card → blocked: …` |
| 3 | monitor の `recoverLost`(:4230) | PTY 死亡 / stall / runaway / rate-limit / permission / question | **force** | **あり**(回収理由) | 残る | 残る | `worker lost/stalled/runaway … — card → todo|blocked: …` |
| 4 | 差し戻し系 teardown(rework / conflict 委譲) | rework/conflict 委譲で worker 不在 or 上限超過 | **force** | **あり**(`rework`) | 残る | 残る | `差し戻し review→todo … 再 dispatch(worker 不在)` 等 |
| 5 | `resolveOrchestratorReview`(:6708) | オーナーが review カードを手動 resolve(todo/blocked) | **force** | **あり**(`stopped`) | **残す**(人/次 worker がコミットを使う前提) | 残る | `review resolved by owner — card → …` |
| 6 | 統合成功後の `defaultCleanup`(:4094) | autoMerge がその branch を trunk に land し、カードが review→done に動いた直後 | **force** + **`branch -D`** | — (統合済み = コミット済み) | **消える** | 残る(branch 消滅により janitor の掃除対象になる) | `integrated (ff|rebase-ff): … → main` |
| 7 | `POST /api/project/worktrees/clean`(server/routes/project.ts:458-468 → worktreeCleanup.ts:105-171) | 手動 API / UI の worktree 掃除 | **force なし**(clean のみ。dirty と live-PTY は必ず skip — :140-143) | — (dirty は skip) | 残る | 残る | (エンジン外) |
| 8 | `withRebasedWorktree`(:3673) | エンジンの verify/レビュー用 **一時** `.review-*` dir(worker の worktree ではない) | force | — | — | — | — |

janitor(`runSwarmJanitor` — swarmJanitor.ts:405-413)は **worktree 本体を消さない**。消すのは (1) merged/empty な `swarm/*` branch(`-d` のみ。`-D` は user-explicit force のみ — :219-231)、(2) 15 分 stale かつ worker 証明済み消滅の心拍ファイル(:310-390)、(3) terminal pool の死骸エントリ(terminal.ts:533-553 — kill はしない)。呼び出しは overseer ON 時の 15 分毎のみ(swarmOverseer.ts:568-570)。

### 実測(2026-07-10「rebase 済み worktree(self-supp)が worker 停止後に消えた」)の犯人特定

「worker 停止」の主体で犯人が決まる。**上の表のとおり、worker を止める操作それ自体が worktree 削除を内蔵している**:

- オーナー/司令塔が **エンジン worker を Stop した**(経路 2)→ その API 自体が worktree を force 削除する。「停止」と「worktree 削除」は**同一操作**。ログに `worker stopped by owner` が残る
- **PTY が exit しただけ**(worker 自身が終了/killed)→ 次の monitor パスが判定する。ここで **「rebase 済み」が決定的**: rebase して origin/main と同内容(または統合済み)になった branch は `commitsAhead = 0`(:2201-2211)→ `classifyWorker` は `hasWork=false` で promote しない(:928-929)→ dead+not-promoted = `recoverLost`(crash)で **worktree force 削除**(経路 3)。ログに `worker lost — card → …` が残る
- autoMerge がその branch を land していたなら経路 6(cleanup が worktree + branch を両方消す)。ログに `integrated (…)` が残る
- 誰かが `worktrees/clean` を叩いたなら経路 7(rebase 済み = コミット済み = clean なので、PTY が死んでいれば削除対象)

**どれだったかはエンジン log(`GET /api/swarm/orchestrator` の `log`)の上記文言で裏取りできる**(§8)。共通する教訓: **worktree は「worker の作業机」であり、PTY が死ぬか止められた時点で回収される消耗品**。中身を担保するのは **branch のコミット**であって worktree ではない。

2026-07-12 の根治で、エンジン経由の teardown(経路 2〜5)は消す前に未コミット分を **WIP コミット**に変換するようになった(§6 冒頭)ので「作業そのもの」は失われない。ただしそれは**救命ネットであって設計ではない**:

- WIP コミットは **未検証**(`--no-verify`、完了ゲート未通過)。統合前に必ず人/エンジンが verify する
- **経路 1・7(エンジン外の API)には保全が無い** — soft(force 無し)は dirty を拒否して守るが、**force Terminate は未コミット物ごと消す**
- だから規律は変わらない: **worker はフェーズの境目ごとに自分でコミットする**(§2.4 の `/order` 注入に焼き込み済み)。司令塔が worker を止める前に確認すべきは「branch にコミットが乗っているか」であって「worktree が綺麗か」ではない

### RESTART(worktree 指定)の意味

`POST /api/swarm/worker` に `worktree`(絶対パス)を渡すと **fresh dispatch ではなく再入場**になる(server/routes/swarm.ts:295-299):

- `resolveExistingSwarmWorktree`(swarmWorker.ts:325-342)が central 配下・実在・branch 有りを検証し、**新しい worktree も新しい branch も作らない**。同じ `swarm/*` branch・仕掛かり品ごと claude を再起動する
- twin-dispatch ガードが免除される(routes :297-299, :326 — カードが doing のままでも 409 にならない。新 branch を鋳造しないため)
- goal は taskId があればカードから、なければ `taskTitle || note || branch` から復元(SwarmModule.tsx:722-724)。UI は古い PTY を先に best-effort kill してから POST する(:713)
- **worktree が既に回収済みなら失敗する**(`restart worktree no longer exists` — swarmWorker.ts:335)。この時の選択肢は fresh dispatch(branch は残っているので、新 worker は最新 trunk から出発し、必要なら旧 branch のコミットを拾わせる)

---

## 7. 落とし穴(司令塔が実際に踏んだ事象を含む)

1. **【0710 実測・0711 根治済み】API の `heartbeatAt` を信じて「worker が半日死んでいる」と誤診** — §4 のとおり、当時はエンジン worker の heartbeatAt が凍結値だった(ディスクを読めば 00:41 まで生きていた)。2026-07-11 の修正で `heartbeatAt` はディスク優先になったため、この誤診パターンは再発しない
2. **【0710 実測】「rebase 済みだから安全」と思っていた worktree が worker 停止で消えた** — §6 のとおり、停止=force 削除が仕様。しかも rebase で commitsAhead=0 になった branch は promote 不能なので、PTY 死亡 → crash 回収(経路 3)コース。**worktree を残したい stop は存在しない**(soft Terminate=経路 1 の force なしだけが dirty tree を拒否して守る — ただし clean なら消える)
3. **worker 停止 → RESTART の順で操作すると RESTART が必ず失敗する** — 停止が worktree を消すため(§6 → RESTART 節)。再開させたいなら停止せず RESTART(古い PTY は API/UI が kill してくれる)
4. **差し戻し後の即 re-promote は起きない設計** — 心拍ファイルに古い `readyToMerge:true` が残っていても、`reworkAt` より新しい心拍が来るまで promote は抑制される(:4433-4442)。「worker に直せと言ったのにカードが review に戻らない」ときは、worker が **swarm-beat.sh を打ち直していない**のをまず疑う。**【0713 実測・同日修正(残穴あり)】**司令官が Board API(`{rework}`)で差し戻したカードをエンジンが二度と拾わない事象があった — 外部差し戻しは in-memory roster に届かず `stage:'done'` のまま早期 continue(:4379-4385)で永久スキップされ、worker が直して ready を打ち直しても doing に沈み続けた(実測 55 分・手動 setColumn でしか復旧せず)。修正後は monitor が「stage:'done' なのにカードが doing」を外部差し戻しとして観測し `stage='running'` + `reworkAt=now` で再武装する(:4360-4377。§5.3)。古い心拍で即 re-promote しない保証(この項の前段)もこの経路でそのまま効く。**ただし PTY が差し戻しより前に exit していた場合は roster にエントリが無く観測できない** — 同じ沈み方がその稀な条件でだけ残る(§5.3 の「既知の残穴」。orphan-doing 異常も worktree 残存で発火しない)
5. **worker が commit せず done true だけ打っても何も進まない** — promote は commitsAhead>0 が必須(:984-985)。dead+ready+成果ゼロは blocked 送り(:1039)。worker の掟「ready 前に必ず自分でコミット」はコードで強制されている
6. **エンジン roster は in-memory** — アプリ/サーバ再起動でエンジンは worker を忘れる(stage 無しのエンジン外 worker として workers API に出続ける)。「エンジンに worker が居ないから全員死んだ」ではない。ソース 2/3(live PTY / 心拍ファイル)で必ず突き合わせる
7. **心拍ファイルは worker 停止後も最大 15 分+α 残る** — janitor は overseer ON 時 15 分毎にしか回らず(swarmOverseer.ts:126, :568)、しかも branch か worktree の消滅が証明できるまで消さない(swarmJanitor.ts:377)。**dead worker タイルが workers API に残っていても異常ではない**。branch も worktree も残したまま PTY だけ死んだ手動 worker は、restart 対象として意図的に表示され続ける(swarmWorkerRegistry.ts:238-251)
8. **PTY exit 後 30 秒は linger** — セッションは `finishedAt` 付きで約 30 秒プールに残る(terminal.ts:334-337)。`isWorkerAlive` は finishedAt で判定するので生存誤判定はないが(:2325-2330)、workers API のソース 2 は `listActiveTerminals`(finishedAt 除外 — terminal.ts:419)を使うため、exit 直後の worker は「terminalId 無し」に即時遷移する
9. **node_modules に触るな** — worktree の node_modules は本体への symlink(§2.3)。worker に `npm install` をさせない・司令塔も worktree 内で lock を書き換える操作をしない
10. **同一ファイル群を触る 2 枚のカードを同時に走らせない** — twin-dispatch ガードは「同一カード」の二重 spawn を塞ぐだけ(routes :301-345)。別カード同士のファイル衝突は統合ステージの conflict 委譲(:4835-)で後払いになる。カード分割時点で disjoint に切るのが司令塔の仕事
11. **【0712 実測・根治済み】worker が実行時間上限で消え、未コミットの 15 ファイル(47KB)が worktree ごと失われた** — 欠陥が 3 つ重なった: (a) runaway が **wall-clock** で判定され、quota 待ち 20 分が worker の予算から引かれなかった(20 + 実作業 84 = 通算 104 分 → 90 分上限で暴走判定)、(b) worker 規律が「実装→検証→git commit」で **検証(完了ゲート)の前にコミットさせなかった** — worker は指示どおり振る舞った結果 全損した、(c) teardown が未コミット作業を保全せず dirty のまま force 削除した。現在は **(a) 実作業時間で判定(§5.5)・(b) 規律を「フェーズ境目ごとにコミット/完了ゲート前は必ず WIP コミット」に変更(`WORKER_ORDER_RULES` — swarmWorker.ts)・(c) teardown が WIP コミットで保全(§6)**。回収 worker の branch に `WIP: swarm reclaim auto-save (…)` が立っていたら、それは**未検証の作業**なので verify を通してから統合すること。なお **worktree が既に消えてしまった過去の全損は、claude のセッション JSONL(`~/.claude/projects/…`)の tool_use を時系列 replay すれば復元できる**(0712 実証)

---

## 8. 検証コマンド集(司令塔が主張を自分で裏取りするためのワンライナー)

前提: `P=/path/to/OPEN-GROUND`(対象プロジェクトの登録パスに読み替え)。owner がアプリにログイン済みなら curl はそのまま通る(swarm ゲート = swarmGate.ts はサーバ永続 session を読む — リクエストの cookie/ヘッダは見ない)。ログイン無効運用(業務モード)では、サーバローカル解錠(env `OPENGROUND_LOCAL_OWNER=1` か settings.json 手編集の `swarmLocalOwner:true` — docs/SECURITY.md)でも同様に通る。

```bash
# --- 心拍(ディスク = 唯一の真実) ---
# repoキーの導出(swarm-beat.sh と同一)
cdir=$(git -C "$P" rev-parse --git-common-dir); abs=$(cd "$P/$cdir" 2>/dev/null && pwd -P || cd "$cdir" && pwd -P); \
key="$(basename "$(dirname "$abs")" | tr ' /' '__')-$(printf %s "$abs" | shasum | cut -c1-8)"; echo "$key"

# 全 worker のディスク心拍を一覧(branch / phase / ready / updatedAt)
for f in ~/.openground/swarm/*/*.json; do jq -r '[.branch,.phase,(.readyToMerge|tostring),.updatedAt]|join("  ")' "$f"; done

# 特定 branch の生の心拍
cat ~/.openground/swarm/<repoキー>/swarm-<branch名の/以降>.json | jq .

# --- workers API(統合ビュー)と突き合わせ ---
curl -s "http://127.0.0.1:47776/api/swarm/workers?path=$P" | jq '.workers[] | {branch, stage, heartbeatAt, ready, blocked, terminalId}'
# → stage があるのにディスク updatedAt と heartbeatAt がズレるのは 2026-07-11 の修正で解消済み(一致するのが正常)。
#   ズレ続けるなら退行(§4 の凍結が復活)を疑う

# --- エンジン状態と journal(worktree 消滅の犯人捜し) ---
# ⚠️ こちらの heartbeatAt は roster 生値(OrchestratorWorker.heartbeatAt = w.heartbeatAt、monitor 凍結のまま・今回未修正)。
#   鮮度確認には上の /api/swarm/workers か、下のディスク直読を使うこと
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$P" | jq '{running, manualStop, workers: [.workers[]|{branch,stage,heartbeatAt}]}'
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=$P" | jq -r '.log[] | "\(.at) [\(.level)] \(.message)"' \
  | grep -E "stopped by owner|worker lost|stalled|integrated|差し戻し|review resolved"

# --- worktree の実在確認(消えた/残ってるの事実確認) ---
uuid=$(curl -s "http://127.0.0.1:47776/api/projects" | jq -r ".projects[]|select(.path==\"$P\")|.id")
ls -la ~/.openground/projects/$uuid/worktrees/
git -C "$P" worktree list
curl -s "http://127.0.0.1:47776/api/project/worktrees?path=$P" | jq .

# --- promote 条件を手で再現(commitsAhead / ready) ---
git -C "$P" fetch origin main >/dev/null 2>&1; \
git -C "$P" rev-list --count origin/main..swarm/<branch>   # 0 なら promote されない(統合済み/空)

# worktree が dirty か(非 force 削除が通るか)
git -C ~/.openground/projects/$uuid/worktrees/<dir> status --porcelain

# --- 停止と削除(やる前に上を確認) ---
# エンジン worker の停止(= worktree force 削除+カード blocked。§6 経路 2)
curl -s -X POST http://127.0.0.1:47776/api/swarm/orchestrator/worker/stop \
  -H 'content-type: application/json' -d "{\"path\":\"$P\",\"terminalId\":\"<id>\"}" | jq '.log[-3:]'
# 手動 worker の soft 削除(dirty なら拒否される安全側。§6 経路 1)
curl -s -X POST http://127.0.0.1:47776/api/swarm/worktree/remove \
  -H 'content-type: application/json' -d "{\"path\":\"$P\",\"worktree\":\"<絶対パス>\"}" | jq .

# --- RESTART(同じ worktree で再起動。worktree が実在するときだけ成功) ---
curl -s -X POST http://127.0.0.1:47776/api/swarm/worker \
  -H 'content-type: application/json' \
  -d "{\"path\":\"$P\",\"taskId\":\"<カードid>\",\"worktree\":\"<絶対パス>\"}" | jq .

# --- 新規 worker の手動 dispatch(twin ガード込み。カードが todo でないと 409) ---
curl -s -X POST http://127.0.0.1:47776/api/swarm/worker \
  -H 'content-type: application/json' -d "{\"path\":\"$P\",\"taskId\":\"<カードid>\"}" | jq .
```

---

## 9. 既知の穴(読んでいて見つけたもの — 修正はしない・列挙のみ)

1. ~~workers API の `heartbeatAt` 非対称~~ — **2026-07-11 修正済み**(§4)。`heartbeatAt: hb?.updatedAt ?? w.heartbeatAt` に変更し、ディスク優先になった
2. **promote 済み(stage='done')worker の phase/note が永久凍結(heartbeatAt は上記修正でディスク優先になったため対象外)** — monitorWorkers の done ルート(swarmOrchestrator.ts:3877-3883)は `withHeartbeat` を通らないため、done 後に worker が打った心拍の `phase`/`note`(例: 統合待ちの間の補足報告)は state API にも workers API(ソース 1)にも反映されない。`heartbeatAt` 自体は今回の修正でディスク直読になったので鮮度は追随する
3. **統合成功後、心拍ファイルが最大 15 分 dead worker として表示され続ける** — 経路 6 は worktree+branch を消すが心拍は消さない(swarmOrchestrator.ts:3628-3653 に心拍削除なし)。janitor(15 分毎・overseer ON 時のみ)が branch 消滅を確認して掃除するまで、workers API ソース 3(swarmWorkerRegistry.ts:238-251)に branch 付き dead レコードが残る。この間に UI から Restart を押すと `resolveExistingSwarmWorktree` が「worktree no longer exists」で 500 になる(swarmWorker.ts:334-335)
4. **overseer OFF 環境では janitor が一切走らない** — 呼び出し元が swarmOverseer.ts:568-570 のみで HTTP route が無い。心拍ファイルと merged branch はオーナーが手で掃除しない限り無限に溜まる(実害は小さいが、workers API の dead worker タイルが残置され続ける)
5. **`swarmRepoKey` の in-memory キャッシュは repo 移動に追随しない** — swarmOrchestrator.ts:2218 の `heartbeatKeyCache` は projectPath→key を無期限キャッシュする。プロジェクトを relocate して `.git` の realpath が変わった場合、サーバ再起動まで古いキーの心拍ディレクトリを読み続ける(実運用ではまず起きないが、relocate 直後に心拍が「消えた」ように見える可能性)
6. **restart 時の goal 復元が `note`(心拍の一行要約)に依存するケース** — SwarmModule.tsx:722-724 は taskId 無し worker の title を `taskTitle || note || branch` で復元する。curl-direct worker が長時間動いた後だと note は「今やってること」であってゴールではないため、restart 後の /order が原型より痩せる。カード(taskId)経由で運用すれば回避可能

---

*この文書は docs/commander/ シリーズの第 2 章。心拍プロトコルの書式は swarm-beat.sh(~/.claude/ 配下・repo 外)と同期しており、サーバ側の読み手 3 系統(§3.2)のどれかを変える時は本章の該当節を更新すること。*
