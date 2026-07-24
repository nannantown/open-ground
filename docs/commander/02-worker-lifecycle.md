# 02 — worker の生涯と worktree 管理(spawn → 心拍 → promote → 回収/再起動)

**対象コミット: `cc7c60e`**(origin/main tip、2026-07-10 時点)。本文中の `file:line` は全てこのコミットの行番号。
**読者**: 司令塔(og-manage / manage セッション)。worker の一生に関わる全ての状態とその在り処を、コード根拠付きで示す。
**関連**: `01-engine-core.md`(エンジン中枢 tick/pass/dispatch/monitor — 別章)。

---

## 0. 司令塔が最初に知るべき 3 つの真実

1. **心拍の鮮度は `heartbeatAt` を信じてよい(2026-07-11 根治済み)。** `GET /api/swarm/workers` の `heartbeatAt` は、以前はエンジンが追跡している worker で「エンジンが最後に monitor パスでその worker の心拍を読んだ時刻の写し」(凍結値)を返していたが、ディスク心拍の `updatedAt` を優先するよう修正された(§4)。ディスク `~/.openground/swarm/<repoキー>/<branch名変換>.json` の `updatedAt` を直接読む裏取りは、API にアクセスできない場面のフォールバックとして引き続き有効。
2. **worker の「停止」は worktree の force 削除とセット。ただし未コミットの作業は消えない(2026-07-12 根治)。** オーナーの Stop・エンジンの crash/stall/runaway 回収・rework 上限超過・統合成功後 cleanup — どれも `removeSwarmWorktree(…, { force: true })` を通る(§6 の全経路表)。コミット済みの作業は branch に残る(統合成功後 cleanup だけは branch も `-D`)。**エンジン経由の teardown(§6 経路 2〜5)は worktree を消す前に dirty を検査し、あれば `git add -A` + 回収理由入りの WIP コミットを branch に打つ**(`commitWipBeforeTeardown` — swarmOrchestrator.ts:3234)。保全に失敗したら **worktree を消さない**(作業の唯一のコピーだから)。ただし **「rebase しただけでコミット差分が消えた」状態は依然として保護されない**(それはコミット済み扱いで dirty ではない)。
3. **RESTART(`POST /api/swarm/worker` に `worktree` を渡す)は「同じ worktree・同じ branch で claude を再起動」**。worktree が既に消えていれば失敗する(`resolveExistingSwarmWorktree` が throw — src/lib/server/swarmWorker.ts:387-404)。つまり「停止(=worktree 削除)してから RESTART」は成立しない。作業を続けさせたいなら worktree を消さずに再起動する。

---

## 1. 構造 — 何がどこにあるか

| 責務 | ファイル | 中身 |
|---|---|---|
| worker spawn 本体(worktree 作成 + claude 起動 + /order 注入) | `src/lib/server/swarmWorker.ts` | `createSwarmWorktree`(:222-294) / `spawnSwarmWorker`(:571) / `removeSwarmWorktree`(:309) / `resolveExistingSwarmWorktree`(:387) |
| 起動モデル/エフォート/リモコンの共有既定 | `src/lib/server/swarmLaunch.ts` | `SWARM_LAUNCH_MODEL='fable'` / `resolveSwarmModelEffort` / `execModeMaxWorkers` + **リモコン識別名**(2026-07-18): `swarmRemoteControlName`(pure 合成)/ `resolveSwarmRemoteName`(spawn 時解決・never-throws)。※本行の行番号は識別名追加以降もさらにシフトし続けている(2026-07-20 実測: `SWARM_LAUNCH_MODEL`:74 / `resolveSwarmModelEffort`:510)— 関数名で引くこと |
| claude PTY 起動(フラグ組み立て) | `src/lib/server/claudeTerminal.ts` | `launchClaude`(:479) / `buildClaudeArgv`(:275) / `buildLaunchCommand`(:394) |
| PTY プール(生存・linger・sweep) | `src/lib/server/terminal.ts` | `createTerminal`(:276) / `listActiveTerminals`(:634) / `killTerminalsByCwd`(:685) / `sweepTerminalPool`(:753) / **`listOwnerDeskTerminals`**(:559 — `TerminalInfo.ownerDesk` が立った卓だけ)/ **`getTerminalScreenLogical`**(:504 — 折返しを連結して読む。読めなければ null) |
| **オーナー対話卓の上限監視**(worker ではない — 下の注記) | `src/lib/server/ownerDeskLimit.ts` | `runOwnerDeskLimitPass` / `startOwnerDeskLimitLoop`(2026-07-18 新規。**エンジン非依存の boot ループ**) |
| worker 一覧 API の統合ロジック | `src/lib/server/swarmWorkerRegistry.ts` | `listSwarmWorkers`(:157) / `readHeartbeats`(:91) / `parseHeartbeat`(:67) |
| エンジン(monitor / promote / 回収 / 差し戻し) | `src/lib/server/swarmOrchestrator.ts` | `monitorWorkers`(:5029) / `classifyWorker`(:1024) / `defaultReadHeartbeat`(:3085) / `defaultRecoverWorker`(:3300) / **`commitWipBeforeTeardown`(:3234 — 回収前の WIP 保全)** / `defaultCleanup`(:4884) / `stopOrchestratorWorker`(:7652)(2026-07-20 実測 — この節は継続的に大きくシフトする。関数名 grep で裏取りすること) |
| 実行時間上限と 2 つの控除台帳 | `src/lib/server/swarmOrchestrator.ts` | `MAX_EXEC_MS`(:366) / `HOLD_CREDIT_CAP_MS`(:375) / `isRunaway`(:1351) / `executionCredit`(:2188) / rate-limit: `endRateLimitHold`(:2068) / `rateLimitHoldCredit`(:2085) / 統合待ち: `beginIntegrationWait`(:2138) / `endIntegrationWait`(:2152) / `integrationWaitCredit`(:2173) |
| 残骸掃除(branch / 心拍ファイル / terminal pool) | `src/lib/server/swarmJanitor.ts` | `sweepSwarmBranches`(:170) / `sweepSwarmHeartbeats`(:310) / `runSwarmJanitor`(:405) / `swarmRepoKey`(:280) |
| clean worktree の一括掃除 | `src/lib/server/worktreeCleanup.ts` | `cleanProjectWorktrees`(:105) / `listProjectWorktrees`(:83) |
| HTTP routes(spawn / remove / workers / stop) | `server/routes/swarm.ts` | `POST /api/swarm/worker`(:248) / `POST /api/swarm/worktree/remove`(:498) / `GET /api/swarm/workers`(:553) / `POST /api/swarm/orchestrator/worker/stop`(:643) |
| worktree 一覧/clean の route | `server/routes/project.ts` | `GET /api/project/worktrees`(:449) / `POST /api/project/worktrees/clean`(:458) |
| UI(Swarm タブの Terminate/Restart) | `src/components/canvas/modules/SwarmModule.tsx` | terminate(:433) / `restartWorker`(:774) |
| 心拍の書き手(worker 自身が叩く) | `~/.claude/swarm-beat.sh`(repo 外・各マシンにインストール済み) | branch/worktree/task/phase/blockers/readyToMerge/updatedAt を 1 ファイルに上書き |
| 共有型 | `src/lib/types.ts` | `OrchestratorWorker`(:1080-1138) / `SwarmWorkerRecord`(:1156-1181) |

> **監視の守備範囲(2026-07-18 に明文化)**: 本章の機構 — 心拍・stall 検知・nudge・rate-limit hold・runaway・回収 — は **`monitorWorkers` が握っている worker にしか効かない**。オーナー自身が開いている対話卓(Terminal タブのペイン・Board 実行・**司令官/補給官の卓**)はどれも**この機構の対象外**で、止まっても心拍も出さないし誰も回収しない。
>
> 2026-07-18 の Fable 5 枯渇でこの境界が実害になった: worker は 1分42秒で検知され holding+requeue+tier 繰り下げまで自動で走ったのに、**オーナーの卓は上限画面を出したまま黙って止まり**、本人が目視で気づいて `/model` を打つまで進まなかった。今はその1点だけを `ownerDeskLimit.ts` が埋める — **上限で止まったことをベル+OSトーストで1回知らせるだけ**(平易文)。**worker のような救済(nudge / 回収 / requeue / 自動モデル切替)は一切しない** — 卓はオーナーのものなので触らない。機構の詳細は 04 章 §3.7 が正典。
>
> **⚠ 残る死角 — engine 停止中(`manualStop`)の worker ペイン**(2026-07-18 差し戻し nit(h) で明文化)。守備範囲は2分割ではなく**3状態**で、真ん中が空いている:
>
> | セッション | engine 稼働中 | engine 停止中(`manualStop`) |
> |---|---|---|
> | engine の worker | 救済あり(本章の全機構) | **どちらも無し** ← 死角 |
> | オーナーの対話卓 | 通知あり(`ownerDeskLimit`) | 通知あり(**engine 非依存の boot ループ**なので停止中も効く) |
>
> `stopOrchestrator` は timer を落とすが**走行中の worker は止めない**(01章 §110)ので、停止指示のあとも worker のペインは生き続ける。その worker は `monitorWorkers` の管理外になった一方、spawn 時に `ownerDesk` が付かない(`swarmWorker` は付けない — 付けると engine 稼働中に救済と通知の二重発報になる)ので、`ownerDeskLimit` の列挙にも入らない。つまり**「engine を止めたあとも走っている worker が上限で固まる」ケースは、今も誰も知らせない**。
>
> 意図的に開けてある: engine を止めた時点でその worker は**オーナーが引き取った**もので、救済(requeue/tier 繰り下げ)の受け皿である engine が居ない以上、通知だけ出しても行き先が無い。埋めるなら「stop 時に生存 worker のペインを卓へ格上げする」= `ownerDesk` を後付けする経路になるが、それは worker の所有権モデルを変える話なので**別カード**。現状は 00-INDEX の「信じてよい表示」に含めない(＝この状態で沈黙していても正常)。
>
> **他に2つ、卓側の守備範囲の縁**(2026-07-18 3回目の敵対レビューで明文化。どちらも「沈黙していても正常」):
>
> 1. **shell ペインで手で `claude` を起動した場合は見ていない。** 卓の列挙は `tag === 'claude'` を要求する(terminal.ts:563、`listOwnerDeskTerminals` 内)ので、`POST /api/terminal` で開いた素のシェルに人が `claude` と打った session は対象外。全 shell ペインを監視対象にすれば塞がるが、画面読取のコストが常時かかる側に変わるので、需要が観測されてから。
> 2. **同一プロジェクトの無名の卓は、どのペインかまでは名乗らない**(2026-07-18 3回目の差し戻し MF-2 で**半分は解消**)。account-wide 枯渇は全卓を同時に止める一方、通知本文が名乗れるのは**プロジェクト名**と、`deskLabel` がある卓(司令官・補給官)の**役割名**だけ。Terminal タブのペインと Board 実行には `deskLabel` が無い。
>    - **塞いだ側**: 「完全に同一の行が何行も並ぶ」形は無くなった。**同じイベントで止まった卓は1本の通知に合体**し(パス単位の合体では卓の停止が1秒ズレるだけで分離する — 04章 §3.7 の実測表)、無名ペインはプロジェクトごとに「会話4件」と数える(04章 §3.7)。直した理由は**オーナーが読む側の雑音**(同じ本文が6行あっても情報は1つ)。⚠ かつてここに書いた「`SWARM_NOTIFICATIONS_CAP`(50)を圧迫して本物の fatal を押し出しうる」という理由は**もう成立しない** — 通知 cap が kind 別に分離された(`capNotificationsByKind`、main 着地)ので swarm-info が swarm-fatal を追い出す経路は無い。
>    - **残る側**: **どのペインかは名乗れない**。オーナーは「そのプロジェクトで4件止まった」までは分かるが、どの画面かは自分で見に行くことになる。ペインに人間可読な名前を持たせない限り原理的に埋まらない(id は機械語なので平易文の原則に反する)。

worker の在り処(ディスク):

- worktree: `~/.openground/projects/<uuid>/worktrees/<branch名のswarm/以降>/`(central worktrees dir。`centralWorktreesDir` — src/lib/server/paths.ts:174。旧記載は swarmWorker.ts としていたが定義は paths.ts 側、swarmWorker.ts はこれを import して使うだけ)
- 心拍: `~/.openground/swarm/<repoキー>/<branchのスラッシュを'-'に置換>.json`(swarmWorkerRegistry.ts:97, swarmOrchestrator.ts:3091)
- repoキー = `<repoルートのbasename>-<sha1(realpath(.git))先頭8桁>`、スペースと `/` は `_` に置換(swarmJanitor.ts:280-292。swarm-beat.sh 側の `sw_repokey` と同一導出)

---

## 2. spawn の実体

### 2.1 経路は 3 つ、実体は 1 つ

worker が生まれる経路は (a) エンジンの dispatch パス(swarmOrchestrator.ts:4938 `deps.spawnWorker` → :3155 `defaultSpawnWorker`)、(b) 手動/司令塔の `POST /api/swarm/worker`(server/routes/swarm.ts:248)、(c) UI の Restart(SwarmModule.tsx:785 — 同じ route に `worktree` 付きで POST)。**全経路が `spawnSwarmWorker`(swarmWorker.ts:571)に合流する。** 合流点の内部順序は model 解決(全 tier OFF なら `NoAllowedModelTierError` で fail-closed)→ **L4 guard 配線検証(NG なら `GuardWiringError` で fail-closed — §2.5、GAP-2 根治 2026-07-11)** → worktree 作成 → claude 起動。**claude preflight・env preflight(git/shell)・twin-dispatch ガードは HTTP ルート `POST /api/swarm/worker` だけが持つ**(下記の順序表)— (a) のエンジン dispatch パスは `spawnSwarmWorker` を直呼びするため、これら3つのゲートを一切通らない(エンジンは自分の `runDispatchPass` で別途カードを予約してから spawn するので twin-dispatch ガードは元々不要。git/shell が壊れている場合、エンジン経路は `spawnSwarmWorker` 内部の `git worktree add` 失敗で気づく — 事前の 503 という形にはならない)。

`POST /api/swarm/worker` の入口で効く順序(server/routes/swarm.ts):

1. swarm owner ゲート(:254 `hasSwarmOwnerAccess` — src/lib/server/swarmGate.ts。owner の app-login(サーバ永続 session)**または**サーバローカル解錠(env `OPENGROUND_LOCAL_OWNER=1` / settings.json 手編集 `swarmLocalOwner:true` — ログイン無効の業務モード用、docs/SECURITY.md)で通過、どちらも無ければ 403。リクエスト由来の値(cookie/ヘッダ/body)では絶対に開かないので、通過側もオーナーがログイン済み(か解錠済み)のマシンなら cookie 無しの curl でそのまま通る)
2. `validateProjectPath`(:263)
3. ゴール解決 — `taskId` があれば Board カードの title+notes が優先(:269-276)、無ければ `title`/`notes`(:277-282)。合計 8KiB 上限(:120 `MAX_GOAL`, :286-288)
4. claude preflight(:294 `claudeRunPreflight` — CLI 不在/未ログインは worktree を作る前に 503)
5. **env preflight(git/shell)**(:303 `swarmEnvPreflight(path, { force: true })` — src/lib/server/swarmEnvPreflight.ts、2026-07-22 追加): git 未検出 / このプロジェクトが git repo でない / シェル未検出のいずれかがあれば、worktree を作る前(twin-dispatch の claim より前)に 503(`{ error, envIssues: ('gitMissing'|'notAGitRepo'|'shellMissing')[] }`)。`force:true` — キャッシュ(10秒 TTL、claudeConnection と同じ)は GET ポーリング専用で、spawn は常に最新の判定を使う(`git init` した直後に古い判定で拒否しないため)。**2つの独立オプション**(2026-07-22 レビュー2周目で分離): `requireGitRepo`(このプロジェクト自体が git repo か)は `/worker` だけ既定 true(git worktree を作るのはここだけ) — `/supply`・`/manager` は `requireGitRepo:false` で呼ぶ(:427, :489)。`requireGit`(git バイナリが存在するか)は `/worker`・`/manager` は既定 true のまま、`/supply` だけ `false`(供給官のサーバ側コードは git を一切呼ばない)。**司令官(`/og-manage`)自身の会話は git を常用する**(status/merge/branch -d — swarmManager.ts:36,73,105,235)ため `requireGit:false` にはしない — 「このプロジェクトが git repo か」は問わないが「git が入っているか」は問う、という非対称。GET `/api/swarm/preflight?path=` は `/worker` と同じ既定(requireGit:true, requireGitRepo:true)でプレーンな read を公開し、Swarm タブが起動前に**1枚のバナー**で表示する(`useSwarmEngine.ts` の poll → `SwarmModule.tsx`。バナーには「タスク受付/司令官は使える」の補足も付く — envBannerFootnoteKey)。**起動失敗の 503 も同じ id を使ってローカライズされる**(SwarmModule.tsx の envIssuesErrorMessage — 2026-07-22 レビュー2周目 must-fix: ボタン押下直後のエラーバナーが英語の生メッセージのままだった穴を閉じた)
6. **twin-dispatch ガード**(:323-370): fresh dispatch は カードを todo→doing に CAS で claim してから spawn(:339 `claimCardForDispatch`)。エンジンが同カードを予約中なら 409(:332, :363-364)。**RESTART は免除**(:321 `isRestart` — 既存 branch への再入場であり新 branch を作らないため)
7. spawn(:372-389)。失敗したら claim を todo に返す(:384)
8. 成功後、カードに branch を記録(:389 `recordCardBranch` — review/統合ステージが読む持ち手)

### 2.2 worktree 作成(`createSwarmWorktree` — swarmWorker.ts:222-294)

1. `projectUUIDFromPath` で registry UUID を解決し、central worktrees dir を `mkdir -p`(:226-228)
2. `git fetch origin main` を best-effort(:232 — オフラインでも続行)
3. base ref は `origin/main` → `main` → `HEAD` の優先順(:77 `SWARM_BASE_REF_PREFERENCE`、:81 `pickBaseRef`)
4. branch 名 = `swarm/<hintスラッグ>-<MMDD-HHMMSS>-<48bitランダム12桁>`(:248-249, :88 `swarmBranchName`)。dir 名は `swarm/` を剥いだ残り(:99 `swarmWorktreeDirName`)
5. dir が既に存在したら **`worktree add` 前に fail-loud**(:256-258 — 衝突時に他人の生きた worktree を巻き込み削除しないため)
6. `git -c branch.autoSetupMerge=false worktree add -b <branch> <dir> <base>`(:264-273)。失敗したら自分が作った分だけ掃除して throw(:274-278)

### 2.3 node_modules は本体への共有 symlink(npm install 厳禁の理由)

worktree の `node_modules` は**本体 checkout の `node_modules` への symlink**(swarmWorker.ts:280-291)。理由:

- worktree はフルチェックアウトで、毎回 `npm install` するとディスクと時間を浪費する。symlink なら即座に build/test が走る
- **worker が worktree 内で `npm install` を打つと、symlink 越しに本体の `node_modules` を書き換える** = 全セッション(本体で dev 中のオーナー、他 worker)に波及する。だから worker への注文には「npm install 厳禁」が焼き込まれている(auto-memory: `reference_swarm_worktree_shared_node_modules_symlink`)
- sandbox 実験 ON のときは node_modules を**完全 READ-only** にする(swarmWorker.ts:623 コメント、claudeTerminal.ts:427-441 `writeSandboxProfile` — sandbox 化された worker が `.vite/deps` 等を汚染して、オーナーが後で非 sandbox で実行するコードに毒を仕込む昇格経路を塞ぐ)
- **sandbox 実験 ON で worker が起動しない場合はキーチェーンを疑う**(2026-07-19 修正済)。claude のサブスク資格情報は `~/Library/Keychains/login.keychain-db` にあり、Security.framework は**クライアントプロセス側**でその db を読み書きする。プロファイルがここを read-deny していると worker は 100% 起動できず、症状は `Not logged in · Please run /login`(= コードのバグに見えるが実体は Seatbelt の拒否)。read だけ通しても、claude はリフレッシュ後の OAuth トークンを書き戻すため数時間後に落ちるので、read+write 両方を開けてある。ただし開けるのは login keychain だけ — 同じディレクトリに同居する per-UUID data-protection keychain(Safari/iCloud/アプリの秘密)は read を深さベースで deny 済み。**ディレクトリごと deny すると認証は通るが keychain の write が死ぬ**(実測)ので、その形にはしないこと。詳細と実測は docs/SANDBOX_EXPERIMENT.md「Keychain」章。**この deny を"堅牢化"として戻さないこと** — sandbox.test.ts と scripts/sandbox-probe.ts の KEYCHAIN 行が回帰ガード
- **キーチェーンを開けた代償は「claude のトークンが読める」ではなく「login keychain の item が全部読める」**(2026-07-19 敵対レビュー2巡目)。普通のマシンの login keychain には `Chrome Safe Storage` = **ブラウザ保存パスワードの保管庫マスター鍵**が入っている。鍵側は塞げない(塞ぐと起動不能に戻る)が、保管庫の**ファイル側**は塞げるので塞いである — Chromium 系(`Login Data`/`Cookies`/`Web Data`)・Firefox 系(`key4.db`/`logins.json`/`cookies.sqlite`)・Safari(`~/Library/Cookies`)を read-deny。**ブラウザのディレクトリごと deny してはいけない**(Chrome 拡張のソースは Application Support 配下にあり、claude が正当に触る) — negative control の probe 行がその退化を検出する。worker のトークン持ち出しを本当に閉じるのは `network:'loopback'` + egress proxy であって、ファイルルールではない
- 削除時は symlink を先に unlink する(swarmWorker.ts:342-354 — `node_modules/` 形式の .gitignore は「ディレクトリのみ」マッチなので **symlink は untracked 扱い**になり、非 force 削除と定期 sweep を永久にブロックするため)

### 2.4 claude 起動フラグ(worker の場合)

`workerLaunchOpts`(swarmWorker.ts:455-538)→ `launchClaude`(claudeTerminal.ts:479)→ `buildClaudeArgv`(claudeTerminal.ts:275-370)。実際に組み上がる argv:

```
claude --session-id <uuid> --dangerously-skip-permissions \
  --model <tier> [--effort <effort>] --strict-mcp-config \
  --remote-control 'ワーカー <プロジェクト表示名>: <カードtitle要約>' \
  "$(cat /tmp/openground-prompt-…/prompt.txt)"
```

| フラグ | 由来 | 意味 |
|---|---|---|
| `--session-id <uuid>` | claudeTerminal.ts:331 | fresh 起動。JSONL の場所が決定的になる |
| `--dangerously-skip-permissions` | swarmWorker.ts:512(`permissionMode:'bypass'` を spread の**後**に置き無条件化)→ claudeTerminal.ts:335-339 | 無人 worker が承認プロンプトで永久停止しないため |
| `--model` / `--effort` | `resolveSwarmModelEffort`(実行モード×カード重み×quota 冷却×許可 tier マスク — swarmLaunch.ts:510、2026-07-20 実測。この節は識別名追加以降さらにシフトしているので関数名で引くこと)。worktree 作成**前**に解決し、全 tier OFF なら `NoAllowedModelTierError` で spawn 自体を fail-closed(swarmWorker.ts:594) | 既定は最上位 tier(`SWARM_LAUNCH_MODEL='fable'` — swarmLaunch.ts:74) |
| `--strict-mcp-config` | swarmWorker.ts:498 | user-scope `~/.claude.json` / project `.mcp.json` の MCP サーバを**一切ロードしない**。bypass worker にとって MCP は guard(PreToolUse hook)の外側にある RCE 経路なので、発生源ごと閉じる |
| `--remote-control '<識別名>'` | `spawnSwarmWorker` → `resolveSwarmRemoteName('worker', projectPath, title)`(swarmLaunch.ts)→ `workerLaunchOpts` opts.remoteName → `swarmLaunchDefaults` | claude.ai / モバイルの一覧で「どのプロジェクトの・何のカードのセッションか」読める識別名(2026-07-18 — 固定 'worker' が大量に並び区別不能だったオーナー直接フィードバックの根治)。JA「ワーカー <プロジェクト表示名>: <カードtitle要約>」/ EN "Worker <project>: <task>"。言語=Settings.language(spawn 時読み・切替は次 spawn から)、表示名=registry displayName‖フォルダ名(git リポ名ではない)、空白正規化+60 code point 切詰め。名前制約は実測済(CLI 2.1.214 — 日本語/スペース/長名すべて受理・一覧表示)。解決失敗時は旧固定名 'worker' に落ちて spawn は通る(never-throws)。manager/supply も同型: 「マネージャー <表示名>」/"Manager <project>"・「タスク窓口 <表示名>」/"Supply officer <project>"(各 spawnSwarmManager / spawnSwarmSupply が解決) |
| positional prompt | swarmWorker.ts:516 `buildOrderInjection` | `/order ゴール: …` を**起動時引数**として渡す(後述) |
| `appContext:false` | swarmWorker.ts:484 | Board API 使用カード(--append-system-prompt)を積まない。worker のプロトコルは /order スキル |

`/order` を**TUI に打ち込まず positional で渡す理由**(swarmWorker.ts:192-204 のコメント): 起動済み TUI にスラッシュコマンドを注入するとオートコンプリートが Enter を飲み込み**送信されない**(claude 2.1.185 で実測)。positional なら起動時に確実に実行され、tmux 時代の send-keys Enter-lag も構造ごと消える。ゴールは 1 行に平坦化される(:110 `flattenOneLine` — 制御バイト除去+空白折り畳み。ESC 注入も同時に防ぐ)。

**注入されるテキストの構成**(swarmWorker.ts:181-190 `buildOrderInjection`): `/order ゴール: <title> — <notes>` + (差し戻し再投入なら)`【前回の差し戻し理由…】<priorFailure>` + **worker 規律**(:176 `WORKER_ORDER_RULES` — push 全形態禁止・commit+ready で停止・心拍必須(30 分無心拍は anomaly)。2e7beb2 事故 = worker が /order スキルの司令塔向け §4 を実行して main に push した、の再発防止として全 spawn に焼き込み)。

**トークン規律(2026-07-18 追加、`WORKER_ORDER_RULES` 内 【トークン規律・厳守】節)**: 実測(swarm-token-audit カード)でワーカー7体全員のツール束ね率が 1.00(独立作業を1手ずつ実行・1手ごとに最大33万トークンの会話文脈を読み直す)だったため、標準指示に (a) 独立ツール呼び出しは1応答へ束ねて並列実行 (b) ファイルは範囲指定 Read か grep で当たりを付けてから読む(全文読み禁止) (c) 同じファイルを読み直さない (d) 長い出力は tail/要約で受ける(テストは失敗時のみ詳細) (e) フルスイート(`npm test`)は完了ゲートとして最後に1回・触った範囲を先に回す (f) カードに当たり(対象ファイル)があれば探索せず直行、の6項目を焼き込んだ。**完了ゲート(`npx tsc --noEmit` / `npm test` / lint の3点)と ready 前セルフコミットの規約は不変** — 緩めているのは探索コスト・文脈量だけで、品質ゲートには一切手を付けていない。文言はピンテスト(swarmWorker.test.ts の `WORKER_ORDER_RULES token discipline`)で固定。効果判定(束ね率≥1.5・手数中央値≤120)は別カード(swarm-token-audit)が継続観測する。

**(a) の既定反転(2026-07-22 追加、日次燃費日報の劣化起票から)**: 上の (a) を焼き込んで4日経っても**束ね率は 1.12 で基準(1.3)割れのまま横ばい**だった(`npm run swarm:audit` 実測)。原因は文言が**条件付きルール**だったこと — 「独立したツール呼び出しは束ねて並列実行する」は、worker が「この2手は独立だ」と**気づけた時にしか発火しない**。逐次に考える既定の思考順(1手決める→送る→結果を見て次を決める)ではその気づきに到達しないので、ルールは書いてあるのに空振りする。そこで (a) を**既定の反転**に書き換えた: 「調べものはできるだけまとめて一度に」を先頭に置き、**まとめて出すのが既定・道具1つだけの応答が許されるのは『その結果を見ないと次が決まらない時』に限る**とし、さらに**送信直前の自己点検**(「この後どうせ要る調べものは?」を洗い出して同じ応答に足す)を1つ足した。**なぜこれで指標が戻るか**: 束ね率の定義は `tool_use 数 ÷ tool_use を含む応答数`(`swarmTokenAudit.ts`)なので、比を上げる手は「1応答あたりの道具数を増やす」以外に無く、既定を反転させると単発応答が『結果依存の時だけ』に絞られて分母が減る — **同じ仕事を少ない往復で終える**ということであり、調べる量を減らすわけではない。**完了ゲート3点と ready 前セルフコミットは今回も不変**。ピンは**見出し句ではなく機構2文**に張る(`swarmWorker.test.ts` の同 describe / `pins the DEFAULT-INVERSION mechanism of (a), not just its heading`) — ①既定文「道具を1つだけ載せた応答が許されるのは、その結果を見ないと次に何をするか決まらない時だけ」 ②送信直前の自己点検「1つだけ送りそうになったら…同じ応答に足せ」 の2文を、`(b)` 手前までを (a) 節として切り出した**その中で**見る(機構が別節へ流れて (a) が見出しだけの殻に戻る書き換えも赤になる)。⚠ **初版のピンは見出し句 `調べものはできるだけまとめて一度に` 1本きりで、機構2文を両方消してもスイート全緑だった**(2026-07-22 変異実測: 2文を削除して `swarmWorker.test.ts` を回すと **41 passed / 0 failed** — 見出し句のピンも `1応答に束ねて並列実行する` のピンも生き残る。機構ピン追加後は同じ変異で **1 failed**)。見出しは「何と呼ぶか」しか固定せず「何をさせるか」は無防備になる — **効く文がどれかを見極めてそこに張る**のがピンテストの要件で、条文が在ることの確認は代用にならない(束ね率を動かせるのは「1応答あたりの道具数」だけで、その数を実際に増やすのはこの2文)。効果は翌日以降の日次燃費日報が判定する。

**技術判断は一次資料で(2026-07-19 追加、`WORKER_ORDER_RULES` 内 【技術判断は一次資料で・厳守】節)**: 前段の**判断ルーティング**(同節 `DECISION_ROUTING_RULES`・06 章 §2.3)が技術判断をオーナーの受信箱から外した結果、その**受け手が worker 自身**に確定した — そして worker の知識には学習カットオフがある。宛先だけ直すと古い答えが静かな場所に移るだけなので、受け手側に手順を負わせる: (a) 分野を1行で特定 (b) 一次資料を取り込む(**リポジトリ内の正典 docs → 公式ドキュメント(WebFetch/WebSearch)** の順) (c) 資料を根拠に判断し**資料名と版/日付**を **commit message** に記録(記録先を名指すのは、sink の無い「記録しろ」は誰も grep できず遵守が観測不能だから)。**資料が取れなければ止まらず `【資料取得できず】` と明記して internal 知識で判断**(黙って古い知識で断定するのが最悪の失敗 = fail-safe)。⚠ **発火条件は「分野」であって「迷ったか」ではない** — 古い記憶から自信満々に間違えている状態は定義上迷っていないので、「迷ったら」ゲートは**必要な時ほど開かない**(2026-07-19 敵対レビュー M2)。

- 2面の**結合は非対称**(「両方が派生」と書かない): worker 面は文字列連結の**真の派生**(定数を直せば全 spawn が変わる)。司令官面(og-manage §「マージ」手順 4)は**手書きの写し**で、`SPECIALIST_REVIEW_MANAGER_CLAUSES` の verbatim ピンが握っている — 定数を直しても SKILL.md は変わらず、**テストが赤くなって人間が両側を合わせる**。
- **トークン規律との優先関係**(隣の段落と衝突して読めるので明示): 規律が削るのは**探索コストと文脈量**で、この手順は削らない。積むのは要点だけ(全文禁止・重い調査は sub-agent へ・判断に足りたら深追いせず止める)。固定費は **`SPECIALIST_REVIEW_RULES` が連結3ブロック(素の worker 規律 / 判断ルーティング / 本節)の中でいちばん小さい**こと。これは文章でなく**テストで固定**してある(`swarmSpecialistReview.test.ts` の "stays the smallest of the blocks…" — **3ブロックすべてと比較**: 判断ルーティングとは `< DECISION_ROUTING_RULES.length`、素の worker 規律とは連結からの差分 `WORKER_ORDER_RULES.length - 他2本` と比較)ので、ここに実数は書かない。⚠ 2026-07-19 の敵対レビューまで、この assert は**判断ルーティングとしか比較していなかった** — 本文が「3ブロック中いちばん小さい」と主張しながら、その1/3はテスト名を借りた散文だった(現在は是正済み)。⚠ 初版はここに実測の文字数を3つ並べていたが、**1セッション中に3回ずれて**そのたび本文が偽になった(447→612→620)。散文の数字は腐る — 数えたいときは上のテストか `.length` を取る。
- ⚠ 注入文は**プロジェクト非依存**に保つこと(worker は OPEN GROUND 以外のプロジェクトでも起動する — `docs/MAP.md` のような当repo固有の索引名を焼き込まない。ピンが negative assertion で守っている)。
- 正典と degrade/fail-CLOSED の境界は 03 章 §5「専門レビュアー」。文言はピンテスト(`swarmSpecialistReview.test.ts`)で固定。

### 2.5 guard(deterministic veto は worker 限定 — SWARM_MANAGER は guard でなくタグ)

deterministic veto(グローバル配線済みの PreToolUse hook = openground-guard.js)は **1 系統だけ・worker 限定**(WORKER-ONLY guard scoping、2026-07)。かつて本節は「SWARM_MANAGER=1 = 司令塔向けの破壊的 git ブロック」という 2 系統説を書いていたが、それは旧仕様 — 2026-07-11 の GAP-6 ドリフト一掃(コード側コメントの旧仕様記述の置換)と同時に本節も現物へ追随済み:

- **worker(veto が効く唯一の対象)**: `guard: { writeRoots: [worktree] }`(swarmWorker.ts:493)→ launchClaude が `OPENGROUND_GUARD=1` + `OPENGROUND_GUARD_WRITE_ROOTS=<worktree>` を注入(claudeTerminal.ts:561-562)。グローバル配線済みの PreToolUse hook(openground-guard.js)が exit 2 で deny — bypass(--dangerously-skip-permissions)でも上書きできない唯一の veto。Write/Edit/Bash の書き込みを worktree 内に閉じ込め、`git push` は全形態 deny。共有 `.git` は意図的に writeRoots に**入れない**(:489-493 コメント — git はバイナリ経由で動くので Bash ルールが統治する。root にすると .git への生リダイレクトまで正当化してしまう)
- **司令塔/補給官(veto 対象外)**: `SWARM_MANAGER=1`(swarmSupply / swarmManager が設定)は役割**タグ**(tooling / skills 向け)であって guard opt-in では**ない**。本体 checkout で動くこの 2 役はユーザーが会話する**信頼セッション**につき veto は no-op — policing は confined worker 限定(openground-guard.js 冒頭の GATE コメント・swarmManager.ts / swarmSupply.ts 各ヘッダが正典)。worker が env を渡さないのは SWARM_MANAGER タグが司令塔/補給官専用だから(swarmWorker.ts:415, claudeTerminal.ts:118-120 — 2026-07-20 実測。この節も継続的にシフトするので関数名/コメント文言で引くこと)
- **配線の fail-closed 検証(GAP-2 根治・2026-07-11)**: guard が効く前提は「`~/.claude/settings.json` の PreToolUse エントリ(5 matcher: Bash/Write/Edit/MultiEdit/NotebookEdit)+ `~/.openground/guard/openground-guard.js` の実体」の両輪 — Claude Code は **hook 不在を fail-OPEN で通す**ため、boot の `installHooks()`(server/index.ts — fire-and-forget)が失敗しても以前は無ガード worker が spawn できた(worker worktree は本体と `.git` 共有 = 共有 ref に到達可能)。現在は `spawnSwarmWorker` が worktree 作成**前**に `ensureGuardWiring()`(hooksInstall.ts)で「PreToolUse 5 matcher の配線が期待コマンドと一致 + インストール済み guard 実体が**期待版**(repo/app の `scripts/openground-guard.js` と byte 一致)」を検証し、NG なら idempotent な `installHooks()` を 1 回 self-heal 試行 → **ディスクから再検証**(install 結果は証明として信じない)→ それでも NG なら **spawn 拒否**(`GuardWiringError`)+ `'guard-unwired'` fatal 通知(bell + OS トースト、同種は 10 分 throttle)。全経路(engine dispatch / POST /api/swarm/worker / RESTART)が §2.1 の合流点で通る。検証器 `verifyGuardWiring` は **STRICT reader**(読めない/parse 不能/エントリ欠落/byte 不一致 = すべて NG — tolerant read に載せた fail-closed ガードは fail-open に化ける)。回帰ネット: swarmSafety.test.ts の INVARIANT **E-FAILCLOSED**(F1〜F6 — 配線を意図的に壊して拒否・no-worktree・bell 通知を assert、negative control 込み)
- **hook source の解決は cwd 非依存 + worktree root 拒否 + 安定パス設置(2026-07-12 根治 → 2026-07-14 再発 → 構造根絶)**: かつて `installHooks()` は hook/guard スクリプトを `process.cwd()/scripts/` から解決していたため、**cwd が swarm worktree を指した状態で install が走ると、その worktree の絶対パスがグローバル `~/.claude/settings.json` に焼き込まれ、janitor が worktree を消した時点で全 claude セッション(OPEN GROUND と無関係なプロジェクト含む)の Stop hook が MODULE_NOT_FOUND で壊れる**実事故が起きた(0712 観測)。0712 根治(モジュール位置起点の解決 + `~/.openground` 配下 root の拒否)は、**0714 に再発を許した**: 拒否 fence が `openGroundHome()`(= `OPENGROUND_HOME` リダイレクトに従う)基準だったため、worker が自ブランチ検証で `OPENGROUND_HOME=$(mktemp -d) node server/dist/index.cjs` を worktree 内から起動すると fence だけ /tmp へ移動し、書き込み先 `settingsPath()`(homedir 基準)は本番 `~/.claude/settings.json` のまま — worktree root が素通りして再汚染した(**守る側と書く側が別の env を見る非対称**が穴)。現在は 3 層: ① `resolveHookSourceRoot()` は**モジュール自身の位置**起点で解決(cwd は一切見ない)、② 拒否 fence は `openGroundHome()` **と** `homedir()/.openground` の**両方**(リダイレクトで fence を動かせない)、③ **hook 本体を guard 同様 `~/.openground/hooks/` へコピー設置し、settings.json は常にその homedir 基準の安定パスだけを参照**(解決 root はコピー元にのみ使用)— どんな root が解決されようと worktree/checkout パスがグローバル設定に書かれることが構造的に不可能。既存の汚染エントリ(消えた worktree を指す)は次回 install 時に desired 不一致で安定パスへ**自己修復**され、重複 our エントリも 1 本に正規化される。`installOgManageSkill` も同じ resolver 経由。回帰ネット: **hooksInstall.test.ts**(R1: cwd=worktree でも worktree/checkout パスが settings.json に載らない / R2·R2b: worktree 常駐エンジンは何も書かない・既存 settings byte 不変 / R3: verify が worktree source を期待版と誤認しない / R4: 解決の cwd 非依存 / R5: 0714 再発形 = OPENGROUND_HOME リダイレクトでも homedir 側 fence が拒否 / R6: 安定パスへのコピー実体 + wire / R7·R8: 汚染エントリの自己修復・重複正規化)

起動コマンド全体は `buildLaunchCommand`(claudeTerminal.ts:394-419)が 1 行に組む: `<env…> OPENGROUND_OWNED=1 <argv> ; exit`。`; exit` により claude 終了 = シェル終了 = PTY exit がそのまま「worker 死亡」シグナルになる。

### 2.6 spawn 後にエンジン側で起きること(engine dispatch の場合)

spawn 成功後、エンジンは in-memory roster に `stage: 'starting'` で push(swarmOrchestrator.ts:6408-6418)、カードを todo→doing に move(:6431 — `deps.moveToDoing`)。roster エントリの形は `OrchestratorWorker`(types.ts:1080-1145): terminalId / branch / worktree / taskId / taskTitle / startedAt / model / stage / phase / note / heartbeatAt / reworkAt。**この roster は in-memory(globalThis)で、プロセス再起動で消える**。再起動後のエンジンは既存 worker を数えない(= `GET /api/swarm/workers` では「エンジン外 worker」として見え続ける。§3.3)。

---

## 3. 心拍プロトコル

### 3.1 書き手 — swarm-beat.sh(worker が自分で叩く)

`bash ~/.claude/swarm-beat.sh <phase> <ready:true|false> "<要約>" ["<blockers>"]`。worktree 内から実行すると branch と `pwd -P` を自動検出し、**1 worker = 1 ファイルを丸ごと上書き**する:

```
~/.openground/swarm/<repoキー>/<branchの/を-に置換>.json
{"branch":…,"worktree":…,"task":…,"phase":…,"blockers":…,"readyToMerge":true|false,"updatedAt":"<ISO UTC>"}
```

(swarm-beat.sh 実物より。repoキー導出はサーバ側 swarmJanitor.ts:280-292 / swarmOrchestrator.ts:2245-2263 と同一 — worktree の `--git-common-dir` は本体 `.git` に解決されるので、**どの worktree から打っても同じ repo ディレクトリに落ちる**)

**依存**: swarm-beat.sh は同じディレクトリの **`openground-swarm-lib.sh`**(`sw_repokey`/`sw_hbdir`)を source する。両方とも repo 正典(`scripts/`)から boot 時に `~/.claude/` へ自動配備される(TARGET-STATE §5「起票テンプレ」の 0722/0723 追記)。**`~/.claude/swarm-lib.sh`(接頭辞なし)は別物** — 旧 tmux コックピット時代のユーザ手書きファイルで OG 管理外・OG は読み書きしない。「心拍が書かれない」時は `bash ~/.claude/swarm-beat.sh …` を worktree 内で直に叩き、`sw_hbdir: command not found` が出るなら配備漏れ(= `openground-swarm-lib.sh` が無い)を疑う。

### 3.2 読み手は 3 系統(それぞれ読む場所とタイミングが違う)

| 読み手 | 実装 | いつ読む | 何に使う |
|---|---|---|---|
| ① エンジンの monitor パス | `defaultReadHeartbeat`(swarmOrchestrator.ts:3085-3039) | **エンジンが running で、かつその worker のカードが doing 列にある時だけ**、pass ごと(:5343 `deps.readHeartbeat` 呼び出し) | promote 判定(`readyToMerge`→ready、`phase==='blocked' or blockers`→blocked — `classifyWorker` 内 :1028-1031)+ 表示用 phase/note/at を roster に fold(:5001 `withHeartbeat`) |
| ② workers API | `readHeartbeats`(swarmWorkerRegistry.ts:91-115) | `GET /api/swarm/workers` の**リクエスト毎**(ディレクトリ全 .json を読む) | 3 ソース統合の素材(§3.3)。ファイル内の `worktree` フィールドがキー(:112 — 無いファイルはスキップ) |
| ③ janitor | `sweepSwarmHeartbeats`(swarmJanitor.ts:310-390) | overseer ON のとき 15 分毎(swarmOverseer.ts:135 既定値, :620 発火条件)。HTTP route は無い | 15 分以上 stale **かつ** worker が証明可能に消滅(branch 消滅 or worktree 消滅 — :377)したファイルだけ unlink(:379) |

### 3.3 GET /api/swarm/workers の 3 ソース統合(`listSwarmWorkers` — swarmWorkerRegistry.ts:157-254)

identity は **worktree パス**(1 worker = 1 worktree)。優先順に:

1. **エンジン roster**(:175-195): `getOrchestratorState` 経由。richest(taskId/taskTitle/startedAt/stage)。`heartbeatAt` は **`hb?.updatedAt ?? w.heartbeatAt`**(:188、2026-07-11 修正) — ディスクの心拍を優先し、無い場合だけエンジン in-memory の凍結値へフォールバック。`ready`/`blocked`/`blockers` も同じ `hb`(ディスクの心拍)から取る(:189-193)ので、1 レコード内の鮮度混在は解消済み。`phase`/`note` はエンジンの凍結値のまま(修正対象外)
2. **エンジンが知らない live claude PTY**(:207-233): terminal pool は process-wide なので、この project の central worktrees dir 配下(:216)+ branch が `swarm/*`(:219)の二重ガードで絞る。`heartbeatAt` は**ディスクの `updatedAt`**(:234)
3. **心拍ファイルだけ残った dead worker**(:238-251): PTY なし・エンジン記録なし。`terminalId` 欠落がそのまま「死んでいる」ことを意味する(restart 対象)。`heartbeatAt` はディスク値(:246)

**stage フィールドの有無 = エンジン所有かどうか**(`OrchestratorWorker.stage` は必須 types.ts:1104 / API 行 `SwarmWorkerRow.stage` は optional types.ts:1175)。stage が無い worker(ソース 2/3)だけが UI から Terminate/Restart できる(`const isEngine = w.stage !== undefined` — SwarmModule.tsx:1251。旧記載は SwarmWorkerPane.tsx としていたが、この判定は SwarmModule.tsx 側にあり同ファイルに `stage` の参照は無い)。

なお `getOrchestratorState` が返す `workers` は roster のうち **PTY が生きているものだけ**(`stateOf` — swarmOrchestrator.ts:2221, `live` フィルタ :2237)。つまり「ソース 1 に居る = エンジン roster に居て、かつ PTY 生存」。PTY が死んだエンジン worker は monitor が回収するまで roster に残るが、state API には出ない(その間、心拍ファイルがあればソース 3 で見える)。

---

## 4. 【解消済み】workers API が古い心拍を返した実測(2026-07-10)と修正(2026-07-11)

**根治済み**: `swarmWorkerRegistry.ts` のソース 1(エンジン roster)が `heartbeatAt: hb?.updatedAt ?? w.heartbeatAt` を返すよう修正された(worker ブランチ `swarm/swarm-workers-api-heartb-*` → main 統合待ち)。`hb` は同じ関数がリクエスト毎に `deps.readHeartbeats()` で読むディスク心拍そのもので、ディスクに心拍が無い場合だけエンジンの凍結値へフォールバックする。以下は**修正前の原因調査の記録**(再発時の参照・回帰テストの根拠として保持)。

**実測(修正前)**: ディスク上の心拍 `updatedAt=2026-07-10T00:41:49Z` なのに、`GET /api/swarm/workers` は `heartbeatAt=2026-07-09T07:55:26Z` を返した。

**原因はキャッシュでも fs watch でも読みタイミングでもない。データフローの構造**である:

1. その worker は**エンジン roster に居て PTY が生きていた**(ソース 1 に該当)。ソース 1 の `heartbeatAt` は `w.heartbeatAt`(swarmWorkerRegistry.ts:188)で、これは**エンジンの monitor パスが `withHeartbeat` で fold した最後の値**(swarmOrchestrator.ts:5001-5006)
2. `withHeartbeat` が呼ばれるのは monitor パスの「カードが doing 列」ルートだけ(:3903-3965)。以下のどれかに入った瞬間、**その worker の `heartbeatAt` は凍結する**:
   - **エンジンが止まった**(Autonomy OFF)。`stopOrchestrator` は「already-dispatched workers は残す + worker set も維持」(:5988-5991 コメント, :6026-5873 — timer だけ止める)。roster は生き、pass は回らない → 凍結
   - **promote 済み**(stage='done' / カードが review・done 列): early-return で `next.push({ ...w, stage: 'done' })` — **withHeartbeat を通らない**(:3956-3962)
   - **人間がカードを todo/blocked に引き戻した**: alive なら verbatim keep(:3976-3980)— 凍結
   - **カードが消えた**: alive なら verbatim keep(:3967-3891)— 凍結
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

- `starting`: spawn 直後。心拍もコミットも無い最初の 25 秒(`STARTUP_GRACE_MS` — swarmOrchestrator.ts:226)は「起動中」表示(:1034-1035)
- `running`: 何らかの活動が見えた後。差し戻し直後も強制的に running — 外部差し戻しの観測(:5256-5190。§5.3)/古い心拍での promote 抑制(:5363-5292)のいずれも running に戻す。**⚠ 旧記載の「エンジン差し戻し」は 2026-07-15 のマネージャ専任化で撤去済み(§5.3 の訂正注記)— 現存する差し戻し経路は「外部差し戻しの観測」1本だけ**
- `done`: promote 成功(:5380-5408)。**PTY が生きている限り roster に残り**(claude TUI は /order 完了で exit しないのが普通)、exit した瞬間 slot が空く(:5312)。ただしカードが doing に戻っていたら done のままにしない — 外部差し戻しの観測で running に再武装(§5.3)

### 5.2 promote 条件(`classifyWorker` — swarmOrchestrator.ts:1024-1034)

```
promote = commitsAhead > 0 && ( ready || ( !alive && !blocked ) )
```

- `commitsAhead` = **branch ref が trunk より先行しているコミット数**(:3043 `defaultCountCommitsAhead`)。worktree ではなく共有 repo の branch ref で数えるので worktree 消滅後も判定可能。trunk はプロジェクトごとに解決(origin/main 固定ではない)
- `ready` = 心拍ファイルの `readyToMerge === true`(:3100、`defaultReadHeartbeat` 内)
- `blocked` = `phase==='blocked'` または blockers 非空(:3111、同上)
- **「dirty=0」という直接条件は promote には無い**ことに注意。dirty が効くのは worktree 削除の可否(git が非 force 削除を拒否 — §6)と司令塔の統合作業であって、promote 判定は「コミットが積まれたか + 完了宣言(または死亡かつ非 blocked)」だけ。worker が commit せずに done true を打っても commitsAhead=0 で promote されない(だから「ready 前に必ず自分でコミット」が worker の掟)

promote 成功でカードは doing→review に移り(:5380-5381 `if (moved)`)、review 列は統合ステージ(review → verify → 敵対レビュー → rebase/FF → done)の入力になる(01-engine-core.md の領分)。

### 5.3 reworkAt との新旧比較(差し戻し後の re-promote 抑制)

> **⚠ 訂正(2026-07-20 実測)— 「エンジン自身の差し戻し」経路は現存しない。** 以下の項目 1 は
> 2026-07-15 のマネージャ専任化(`runIntegratePass` の統合機能撤去。正典は
> `docs/commander/03-integration-review.md`。コード側の宣言コメントは
> `src/lib/server/swarmOrchestrator.ts:6532-6536`「reworkOrPark / delegateConflict 差し戻し
> machinery — is GONE」)で**撤去された旧経路の記述**。`reworkOrPark` はもう定義されておらず
> (grep 実測: 定義 0 件・コメント内の言及のみ残存)、`runIntegratePass` は現在レビュー分類の
> read-only パス + マネージャ復活リフレックスだけで、review→doing の差し戻しは書かない。
> **現存するのは項目 2(外部差し戻しの観測)だけ** — 差し戻しは司令官(og-manage §「マージ」)
> が Board API 経由で行い、エンジンはそれを観測するのみ。項目 1 と続く「差し戻しの分岐」節は
> **歴史的記録として残す**が、行アンカーの実測・追随はもう行わない。

`reworkAt`(型定義 types.ts:1118-1129)が立つ経路は **2 つ**(現存するのは 2 のみ):

1. **[撤去済み・歴史的記録] エンジン自身の差し戻し** — かつては統合ステージがカードを review→doing に差し戻すとき、roster エントリにその場で `stage='running'` + `reworkAt = now` を刻んでいた。2026-07-15 のマネージャ専任化で撤去(上の訂正注記を見よ)。
2. **外部差し戻しの観測**(2026-07-13 追加。**現存する唯一の経路**) — 司令官の `POST /api/project/tasks {rework:[…]}` や UI ドラッグ(review→doing)は **in-memory roster に届かない**。monitor は「roster が `stage:'done'` なのにカードが `doing` に戻っている」形を外部差し戻しとみなし、`stage='running'` + `reworkAt = now`(観測 tick の時刻 — Board の rework verb はカードに差し戻し時刻を記録しないため)で再武装して通常の監視フローに落とす(:5177-5190。engine log に `Board 側の差し戻し(review→doing)を観測` が 1 回出る)。**この観測が無かった時代は直後の stage:'done' 早期 continue(:5209-5233)が先に効いて永久スキップ** — worker が直して ready を打ち直してもカードは doing に沈み続けた(2026-07-13 実測: 55 分放置しても昇格せず、司令官の手動 setColumn でしか復旧しなかった)。

**既知の残穴(未解決)**: この観測は roster に `stage:'done'` のエントリが**残っている**ことが前提。**PTY が差し戻しより前に exit していた**場合、worker はその時点の tick で「done worker closed — slot freed」(:5233)として roster から既に消えており、再武装する対象が存在しない — **カードは worker 無しで doing に沈む**(55 分沈黙と同じ症状が、この稀な条件でだけ残る)。しかも `orphan-doing` 異常(:6707,:6811)は **worktree の消滅が発火条件**で、slot-freed 経路は worktree を撤去しないため発火しない。復旧は手動(setColumn で review へ戻す、または worktree/branch を確認して再 dispatch)。

心拍ファイルは worker しか書けないので、差し戻し前の `readyToMerge:true` が残ったままになる。そのままだと次 pass が即 re-promote → 同一 tip の verify skip-RED → また差し戻し、で rework 予算(`MAX_REWORKS=2` — :255)が壁時計 30 秒で燃え尽きる。これを防ぐのが:

```
promote && w.reworkAt のとき: hbAtMs > reworkAtMs(差し戻しより厳密に新しい心拍)でなければ promote を落とす
```

(:5284-5292)。**司令塔への含意**: 差し戻された worker は「swarm-beat.sh で done true を打ち直す」まで絶対に review に戻らない(古い心拍での再昇格は起きない)。worker が心拍を打たない限りカードは doing に残り続ける(stall 監視には掛かる)。回帰テスト: swarmOrchestrator.test.ts の describe「monitorWorkers — re-promote suppression after a 差し戻し (reworkAt)」に、①エンジン昇格 → ②Board 直接差し戻し → ③古い心拍では抑制 → ④新しい心拍で再昇格、の通しがある(①③④は現行機構、②は上の外部差し戻し経路)。

**[撤去済み・歴史的記録] 回収先の非対称**: 差し戻しの**後**に PTY が死んだ場合の回収先は、かつては経路で異なっていた — **外部差し戻し**では再武装後の fall-through が `recoverLost` に落ち、古い心拍の `ready===true` を見た `recoveryColumn`(:1099、現存)が **blocked** に送る(worktree 撤去・branch 保持・WIP 救済つき)。**エンジン自身の差し戻し**では worker 不在/死亡分岐が **todo** に戻して再配車していた(2026-07-15 撤去済み)。

**[撤去済み・歴史的記録] 差し戻しの分岐(旧 `reworkOrPark`)**:

- **LIVE worker**: 同一 branch 継続。カード review→doing、`instructRework` で PTY に理由を直接注入 + 差し戻し理由を `reworkReasons` に永続 memo(worker が死んで再 dispatch になった時 `priorFailure` として次の /order に注入される — この読み書き自体は現存: :6470-6244)
- **worker 不在/死亡**: カード review→todo(新 worker に再 dispatch)+ 死骸 teardown(**worktree force 削除**、branch 維持)
- **上限超過(count > MAX_REWORKS)**: カード blocked 退避 + teardown。人手待ち

### 5.4 回収(recoverLost / recoveryColumn)

PTY 死亡・stall(心拍・PTY 出力・**sub-agent/transcript の mtime** の 3 チャネルすべてが 10 分沈黙 — `STALL_SILENCE_MS` :294。第3チャネルは §5.4a の注)・作業上限到達(**実作業**が 90 分 — `MAX_EXEC_MS` :366、env `OPENGROUND_SWARM_MAX_EXEC_MIN` で可変。控除項は §5.5、ラベルの二分は §5.6)・permission 詰まり・rate-limit 長期化のとき、`recoverLost`(:5051)が worktree+PTY を teardown し、カードの行き先を `recoveryColumn`(:1099)で決める:

| 状況 | カードの行き先 |
|---|---|
| rate-limit | todo(自動リトライ — 作業は branch に保存済み) |
| **integration-wait**(ready 到達済みで作業上限に到達)**かつ心拍が blocked を宣言していない** | **review**(司令官の統合待ち列。**blocked へは落とさない** — §5.6) |
| integration-wait **だが心拍が `blocked:true`**(再作業中に本物の詰まりに当たった) | **blocked**(worker 自身の「人手が要る」申告が優先 — 2026-07-19) |
| runaway / permission / question | blocked(人手) |
| 心拍 ready なのに成果ゼロ | blocked(「完了宣言したのに統合物が無い」= 人が見る) |
| 心拍 blocked | blocked |
| リトライ予算切れ(`RECOVER_MAX_REQUEUE=1` :235) | blocked |
| それ以外の bare crash | todo(もう 1 回だけ自動再試行) |

`integration-wait` の行だけ **判定順が特別**(:1117): 心拍 `ready` / 予算切れ の行より**先**に評価される。そうしないと差し戻し前の古い `ready===true` 心拍が下の行に拾われて blocked に落ちる — それが 2026-07-18 事故そのもの。

**ただし飛び越すのは `ready` の行だけ**(2026-07-19 に射程を絞った)。心拍の **`blocked:true` は `integration-wait` より先**に評価される(:1114)。初版はここも飛び越していたため、**差し戻し後の再作業中に本物の詰まりに当たり「人手が要る」と心拍に書いた worker の申告が黙って捨てられ**、未検証の tip だけが review に上がっていた(司令官がレビュー→赤で差し戻し→同じ壁、の無限ループ)。`ready` は**前の状態の遺物**、`blocked` は**今の生の報告** — 性質が違うので扱いも違う。

**どの行き先でも、teardown の前に未コミット作業は WIP コミットで branch に保全される**(§6 冒頭)。回収後に `git log <branch>` を見れば `WIP: swarm reclaim auto-save (<理由>)` が立っている(dirty が無ければ何も起きない)。

### 5.4a stall 判定の第3チャネル — sub-agent/transcript mtime(2026-07-23・**7517 の worker 版**)

worker の生死は当初 `lastActivityMs`(:1158)= max(心拍, PTY 出力, 起動時刻)**だけ**で測っていた。だが worker が**自前の敵対レビュー Task(sub-agent)**を回すと、親 PTY 出力も心拍(phase 境界でしか出ない)も凍り、両チャネルとも古くなる — 走っている本人は生きているのに。これは**司令官卓で 7517e4b1 が塞いだのと同じ死角**であり(03章 delivery 節: `defaultManagerDeliveryAt` が心拍/セッション JSONL/**sub-agent JSONL** の3つで測る)、worker には未適用のまま残っていた。

- **実害(2026-07-22 夜〜0723 早朝・司令官が実測)**: 稼働中 worker が沈黙誤判定 → nudge(ESC で走行中の検証を中断)→ reclaim(worktree teardown + `blocked` 再ホーム)→ 空いた担当を **同一カードの二重配車** で埋める、が連鎖した(worktree 6 個が心拍を残したまま消滅・成果は branch 生存で無事だが「作業中の成果を失う」一歩手前+トークン二重消費)。
- **修正**: `classifyStall`(:1218)/ `lastActivityMs`(:1158)に第3チャネル `agentActivityAtMs`(worker 自身の `<sessionId>.jsonl` + `<sessionId>/subagents/agent-*.jsonl` の最新 mtime。汎用コンビネータ `sessionAgentActivityAt` — manager 版 helper を再利用)を OR で加えた。sub-agent 実行中・ファイル編集中の worker を「生存」に倒す。
- **コスト方針は司令官版と同じ**: cheap 2 チャネルで silent と出た worker **だけ** fs walk を掛ける(monitor のゲート付き backstop・`rate-limited` は sub-agent を回さないので除外)。通常 tick の追加 IO はゼロ。
- **安全性**: ファイル mtime は**再描画では書けない**(Enter/ESC の echo は transcript も sub-agent ファイルも伸ばせない)ので echo-guard 非対象で足せる。生きた worker を生存に倒す**だけ** — 死んだ worker はファイル mtime も止まるので同じ 10 分時計で沈黙に戻り、従来どおり reclaim される(誤って「永遠に生存」にはならない)。
- **read-only 表示との整合**: `detectAnomalies` の `worker-stale`(:7563 付近)も同チャネルを同じゲートで畳み込み、「read-only の異常表示は engine 自身の生死判定と矛盾しない」不変条件(ブロック冒頭が約束)を維持。
- **回帰(歯)**: `swarmOrchestrator.test.ts` — 純関数 `classifyStall`「SPARES a worker … sub-agent file is fresh」(変異=`agentActivityAtMs` を外すと nudge に反転)/「does NOT let a STALE sub-agent file rescue …」、monitor「SPARES a silent-but-alive worker running a Task() sub-agent」+「MUTATION control … STALE … IS nudged」。`lastActivityMs` の第3チャネルも単体で固定。

### 5.5 実行時間上限は **いま与えられている担当分の実作業時間**で測る(2026-07-12 / 07-18 / 07-20 根治)

`MAX_EXEC_MS`(:366、既定 90 分)が bound するのは **worker が“今の担当分”で働いた時間**であって、wall-clock でも生涯累計でもない。判定は `isRunaway(起点, now, MAX_EXEC_MS, idleMs)`(:1336):

```
起点       = 差し戻されていれば reworkAt、無ければ dispatch(startedAt)
実作業時間 = (now − 起点) − rate-limit hold 累計 − 統合待ち累計(起点が dispatch のときだけ)
```

**起点が動くのが 2026-07-20 の変更**((c))。控除項は 2 つで、どちらも「その worker が**このカードを** `doing` で進めてはいなかった時間」。`executionCredit`(:2188)が両者を足して返す。

**(a) rate-limit hold**(2026-07-12 根治)

- **hold 台帳**: エンジンは worker(terminalId)ごとに rate-limit hold の**確定分**を `engine.rateLimitHeldMs` に積む(`endRateLimitHold` :2068 — `engine.rateLimited` を落とす唯一の seam)。hold の起点は「limit 通知が画面を掴んだ瞬間」(`holdSince` = `engine.limitScreen` の onset)であって、hold が**確定**した時刻(`since`)ではない — 確定ゲート(最大 `STALL_SILENCE_MS`=10 分)の分まで遡って返す
- **進行中の hold も実時間で控除**される(`rateLimitHoldCredit` :2085 = 確定分 + in-flight)。今まさに limit で凍っている worker が「長く生きている」だけで暴走扱いされることはない
- **控除には上限がある**: `HOLD_CREDIT_CAP_MS`(:375 = `MAX_EXEC_MS` と同値)。limit↔作業 を往復して runaway 判定を無限に先送りできないようにするため

**(b) 統合待ち(review 滞留)**(2026-07-18 根治)

- **統合待ち台帳**: カードが review/done 列に居ると観測した瞬間に `engine.integrationWaitSince` へ刻み(`beginIntegrationWait` :2138)、差し戻し(review→doing)を観測した瞬間に span を `engine.integrationWaitMs` へ積んで消す(`endIntegrationWait` :2152 — この map を落とす唯一の seam)。上限判定の直前にも**防御的に**同じ seam を呼ぶので、遷移を取りこぼしても古い刻印が育ち続けることはない(控除の読み出し `integrationWaitCredit` :2173 は**台帳のみ**を見る — 直前で必ず bank されている前提。この順序が契約)
- ⚠ **ただし列だけでは刻まない — 裏取りが要る**(2026-07-19)。カードの列は「人がそう信じた」という**主張**であって受領証ではない。`readyAt` は worker を暴走扱いから守る唯一の根拠なので、主張だけで刻むと**暴走防御が fail-open する**: 何も出していないカードを一度 review に置いて doing に戻すだけで、その worker は以後永久に暴走判定を免れ、0 コミットのまま何時間も回り、空ブランチがカードに焼き込まれ、オーナーには「統合可能な成果を一度出しています」という**事実でない断定**が届く。よって刻印の条件は **列 かつ (commit がある または 心拍 ready)**。これは**必要条件**であって witness ではない — `commitsAhead` を上限判定側の witness にするのは §5.6 の囲みのとおり誤りだが、**刻む時点での裏取り**は安全である(読み取り失敗は次パスに持ち越されるだけで、停止のラベルを誤らせない)
- **開始条件は「カードが review/done に居る」という状態であって、エンジンが promote を書けたかではない**。刻印箇所は 3 つ — エンジン自身の promote(:5324-5325)、**カードが既に review/done に在るのを観測する early-continue**(:5420-5443)、そして **promote を決めたのに Board 書き込みが KEPT になった分岐**(:5348-5353 — `promote===true` はエンジン最強の「納品した」判定なので、書き込みの成否ではなくその判定を台帳に載せる。`countCommitsAhead`/`readHeartbeat` の失敗は 0/null に握り潰されるため、一度でも transient に読めないと次パスで promote が false に落ち、`readyAt` 無しのまま上限に当たって事故が再現する — 実測)。後者が要る理由は司令官の手順そのもの: og-manage は「READY を見たらまず `move <id> review`」と指示しており、**手動 move が promote tick に勝つのが最頻経路**。台帳を promote の**書き込み成功**に縛ると、この最頻経路では `readyAt` も統合待ち時計も立たないまま `stage:'done'` になり、次の差し戻しで 0718 事故が逐語で再現する(実測 — 修正前は赤の回帰テストあり)。**列に縛れば promote 経由と手動経由が同じ台帳に乗る**(差し戻し側 :5393 は元から外部移動を観測していた — BEGIN 側だけが非対称だった)
- 刻印は **pass の観測時刻**であって司令官が実際に動かした時刻ではないので、最大 1 tick 分だけ控除が**足りない**方向にずれる。判定が厳しくなる側なので worker が不当に延命されることはない(§5.7 の `limitSince` と同じ性質)
- **実際に測っているのは「カードが `doing` に居なかった時間」**であって worker の稼働判定ではない。したがって review 滞留中にオーナーが worker ペインへ直接打ち込んで実際に動いていた時間も、`blocked` に駐車していた時間も、まとめて控除される。**それで問題ない**: エンジンは `doing` 以外のカードを監視していない(review のカードは monitor を early-continue する)ので、その時間はそもそも実行時計に載っていない — 繰り越しても何も変わらない
- ⚠ **ただし正確には「観測から観測まで」であって「列遷移から列遷移まで」ではない**(既知の過剰控除・2026-07-18 実測)。台帳は pass が観測した時刻でしか動かないので、**エンジンが止まっている間に review→doing が起きると、その盲目区間まるごとが統合待ちとして bank される**。実測: 64 分時点で review を観測 → エンジン停止 → 70 分に司令官が差し戻し → worker は再作業を継続 → 200 分でエンジン再開、とすると 136 分が控除され、実作業 200 分のうち 64 分しか課金されない = **上限が発火しなくなる**。危険側だが bound はされている(再開後は通常どおり課金され、以後の累積は `MAX_EXEC_MS` で止まる)。エンジンを止めたまま長時間差し戻して回す運用では上限を当てにしないこと。**根治には per-pass 加算(盲目区間は加算しない)への台帳作り替えが要る — 別カード**
- **こちらにも cap がある**(`WAIT_CREDIT_CAP_MS` :398 — 既定 8 時間・env `OPENGROUND_SWARM_WAIT_CREDIT_CAP_MIN`)。**2026-07-19 に方針を反転した**。旧版は「統合待ちは cap しない — cap すると夜通し review に置いたカードを翌朝差し戻した瞬間に上限超過し、事故が復活する」と書いていたが、その前提は §5.6 の修正で消えた: **暴走ラベルと blocked 退避を決めるのは今や `readyAt` であって控除ではない**。cap に当たって停まる ready 済み worker は `integration-wait` として停まり、カードは review へ行き、成果は commit 済みで残る — 有界で正直な結末である
- **cap が要る理由(MF-3)**: review 列のカードは monitor を early-continue するので、**待っている間その worker は上限判定も stall 判定も心拍判定も一切受けない**。控除は「観測と観測の間の span」であって稼働の測定ではないから、エンジンは**その PTY が本当に遊んでいるのか、`/order` ループでトークンを焼いているのかを区別できない**。無制限だと後者が青天井に控除を稼ぐ: 司令官が手で review に上げた(あるいは古い ready 心拍で promote された)カードの下で PTY が 6 時間焼き、差し戻し後にさらに丸ごと `MAX_EXEC_MS` の猶予を得る。**測れないものは bound する**という判断
- ⚠ **それでも「review 列の下の生きた PTY は無監視」であることは変わらない**。cap は消費の**総量**を有界にするだけで、待っている間その worker を見張る仕組みは無い(上限・stall・心拍のどれも走らない)。長時間 review に放置しないこと自体が運用側の責務
- **worker の wall-clock 寿命の上限は、働いている限りは** `MAX_EXEC_MS + HOLD_CREDIT_CAP_MS`(既定 180 分)。**統合待ちを挟むとその分だけ伸びる**(実測: 60 分待ち×10 ラウンドの往復で 11.5 時間生存し、累積実作業が 90 分に達した時点で停止)。伸びている間カードは `doing` の外に居るので消費ではないが、**PTY が生きていれば dispatch slot は占め続ける** — 長期の review 滞留は slot を空けない

**(c) 差し戻しは“新しい担当”なので予算も新しい**(2026-07-20 根治)

- **差し戻し(review→doing)を観測したら、上限の起点をその時刻(`reworkAt`)に移す**(:5689 手前)。差し戻しは「納品物を見た司令官がもっと作業を頼んだ」ことなので、その再作業を**それ以前の作業で先に使い切っておく**のは筋が通らない
- **免除ではなく予算**。再作業が `MAX_EXEC_MS` を超えれば従来どおり停止する(形状 `rework`)。差し戻し 1 回につき 1 回分の `MAX_EXEC_MS`、それ以上ではない
- **fail-open しないよう納品を条件にする**。起点が動くのは **`readyAt` があるか、worker 自身の心拍が `ready`** のときだけ。何も出していないカードを review に往復させても予算は増えない(`commitsAhead` は witness にしない — §5.6 の囲みのとおり働いている worker の常態)
- **心拍 witness は読んだら `readyAt` に焼く — ただし差し戻し中(`reworkAt` 立つ)worker に限る**(:5484 の `w.reworkAt &&` ガード)。心拍ファイルは差し戻し後に worker 自身が `ready:false` へ書き換えるので、読むだけで記録しないと **1 pass だけ予算が出て次の pass(3 秒後)で取り上げられる** — 直後に worktree が消える。これは §5.6 の「エンジン盲目区間の穴」を塞ぐ durable な witness でもある。**焼く先を差し戻し中に絞る理由(2026-07-21)**: 差し戻しも納品もしていない worker が早まった `ready:true` を打っただけで焼くと、それ自体が上の fail-open の入口になる — 空回り(0 コミット)worker が最初の上限で `integration-wait` → review に流れ、司令官が差し戻すと `readyAt`+`reworkAt` が揃って毎ラウンド無限に予算を得てしまう。差し戻しは「人が成果を見てもっと頼んだ」証拠なので、それが心拍の裏取りになる(pin テスト『does NOT fail open on a ready HEARTBEAT alone』— ガードを外すと赤)
- **起点が動いたときは統合待ちを“控除”しない — そもそも時計に載せない**。二重に引くと再作業が予算の 2 倍走れてしまう。journal もそう書く(「計上対象外」であって「credited back」ではない)。rate-limit hold は差し戻しの前後どちらにも起こりうるので従来どおり控除する
- **`WAIT_CREDIT_CAP_MS` の役割はこれで小さくなった**。差し戻し経路では待ち時間が時計に載らないので cap に当たること自体が無くなり、**形状 `capped-wait` は定常状態では到達不能**になった(§5.6 の表)。判定式は残してある — 台帳はエンジン状態なので self-update をまたいだ roster が `reworkAt` 無しで bank を抱えている可能性があるため

**(d) 再起動を跨いだ resume の起点**(2026-07-24 根治・card 4)

- 上の控除台帳(`rateLimitHeldMs` / `integrationWaitMs`)は **in-memory** なので**再起動で空になる**。したがって resume した worker(05 章 §10.5)の起点を**元の dispatch 時刻のまま**採用すると、**アプリが止まっていた時間がまるごと実作業時間として課金される**: 20 時に配車 → 20 分作業 → 夜アプリ終了 → 翌朝 8 時に resume、で「12 時間 20 分働いた」と判定され、**最初の monitor pass で暴走 → worktree 解体 → カード blocked**。main には無い破壊(main は resume しないので `doing` のカードと worktree は放置される)なので、`ENGINE_PERSISTENCE_PLAN.md` §5 の「最悪でも今日と同じ挙動」に反する。統合前の敵対レビューで実測再現された(2026-07-24)
- よって resume 時の起点は **`now − workedMs`**(`resumeStartedAtMs`)。`workedMs` は roster.json の台帳(card 3・`rosterEntryOf` が状態遷移点ごとに書く「wall-clock − 控除」のスナップショット)。**停止時間は課金されず、実作業ぶんは引き継がれる**ので「再起動のたびに予算がリセットされて無限に走れる」穴も開かない(両方向に回帰テストの歯がある)
- 台帳が壊れている/巨大なときは **経過実時間(`now − spawnAt`)で clamp** されるので、起点は最悪でも元の dispatch 時刻 — それより古くはならない。台帳が無い古い roster 行は `now`(= その resume が肩代わりした crash reclaim と同じ、まっさらな予算)
- ⚠ **台帳が数えているのは「今の担当ぶん」であって worker の生涯ではない**(2026-07-24・敵対レビュー must-fix #2)。`rosterEntryOf` の起点は上限判定とまったく同じ式 —— (c) の `reworkAt`(納品の裏取り `readyAt` 込み)があればそこ、無ければ dispatch —— で、控除も同じ分割(起点が動いたら統合待ちは**そもそも計上外**なので引かない。引くと台帳が予算の 2 倍を許す)。**生涯で書くと (c) が塞いだ事故が「再起動」をトリガに再演する**: resume した worker には `reworkAt` が残らない(あれはエンジンのメモリであって roster の状態ではない)ので、以後**誰も起点を動かし直せない**。「200 分前に配車・10 分前に納品・5 分前に差し戻し」の worker はアプリが動いている間は (c) に守られるのに、**再起動した瞬間に暴走判定 → worktree 解体 → カード blocked** になる。なお **`reworkAt` の絶対時刻を永続化する解は逆向きに壊れる**(停止時間が再び課金され、この節の欠陥そのものになる)ため、台帳は duration のままにしてある
- 次の `syncRoster` で `rosterEntryOf` が `spawnAt = startedAt` / `workedMs = now2 − 起点 − 控除` と書き直すので、会計はそのまま閉じる(resume 直後の worker は `reworkAt` を持たないので、その起点 = 採用した anchor)
- **司令官への含意**: 再起動直後に「resume した worker がいきなり暴走で解体された」を見たら、それは**この起点のバグの再発**を疑う場所(worker 側の問題ではない)。台帳は `~/.openground/swarm/<repoキー>/roster.json` の `workedMs` で直接読める —— 差し戻し中の worker なら、そこに載っているべき数字は**生涯ではなく差し戻し以降**である

**なぜ変えたか(実測・2026-07-20 / 2 件)**: ready のまま夜間キューに載っていた worker を朝に差し戻したところ、**差し戻しを観測した同じ pass**(150〜250ms 後)で上限に当たり、**再作業 0 分のまま worktree ごと撤去**された。07-18 の統合待ち控除は**ラベルとカードの行き先**しか変えておらず、**撤去そのものは両ラベル共通**だったため、控除が効いていても同じ結末になる。加えてこの 2 件を出したエンジンは**古いバイナリを実行していた**(§5.7)ので控除自体も走っていない。差し戻しが「作業を頼む」操作である以上、頼んだ瞬間に担当を殺す挙動は構造ごと直す必要があった。

journal の文言も実作業ベース: `worker runaway — worked 91m ≥ 90m execution limit (alive 111m; 20m rate-limit hold + 0m 統合待ち credited back): …`。差し戻し後の停止では控除欄が `計上は差し戻し以降のみ(統合待ち …m は計上対象外)` に変わる。

**なぜ変えたか(実測・2026-07-12)**: 旧実装は「wall-clock で数える — band が広いから rate-limit 待ちを含めても足りる」と明言していた。その前提が破れた: **quota 待ち 20 分 + 実作業 84 分 = 通算 104 分** → 90 分上限で runaway 判定 → 実装完了済み・未コミットの **15 ファイル 47KB が worktree ごと消滅**した。quota 待ちは worker の落ち度ではないので、その時間を worker の予算から引いてはならない。

**なぜもう一度変えたか(実測・2026-07-18)**: 同じ穴が**統合待ち側**に空いていた。worker は 04:18 に ready 到達 → カードは review で司令官の統合を待つ → 04:46 に司令官が差し戻し → **次の pass で「worked 91m ≥ 90m execution limit」と判定され worktree ごと撤去、カードは blocked へ**。実際に働いたのは 63 分で、残り 28 分は統合キューの待ち時間だった。実害は 3 つ: (a) 司令官が blocked の理由を**差し戻し上限**と誤読して診断に時間を溶かした (b) worktree が消えて「既存 worktree のまま worker を立て直す」復旧計画が成立しなくなった (c) オーナー判断列に判断不要のカードが積まれた。

### 5.6 ready 到達済みの worker は **暴走ではない** — ラベルも行き先も別(2026-07-18)

上限に到達した worker の扱いは、**一度でも ready に到達したか**(`OrchestratorWorker.readyAt` — 初回の review/done 到達で 1 回だけ刻まれ、差し戻されても消えない。刻印箇所は §5.5(b) の 3 つ)で二分される(:5718):

> **`commitsAhead > 0` を witness に足してはいけない(2026-07-19 実装 → 同日撤回)**。「毎パス git を読むので durable」という理屈は正しいが、**commit があること自体は納品の証拠にならない**。worker には「ready を宣言する前に必ずコミットしろ」と規律で指示している(「完了ゲートに入る前に必ず WIP コミット」は全 /order 指示に入っている)ので、**commitsAhead > 0 は働いている worker の常態**である。これを witness にすると「**1 つもコミットしていない worker だけ**が暴走扱い」になり、防御が実質消える — カードが大きすぎて 10 分で足場をコミットし残り 110 分空転した worker が、`暴走ではありません(統合可能な成果を一度出しています)`を付けて review に上がってしまう(実測: teeth テストに `commits: 1` を足すだけで再現)。**オーナー向け文言も嘘になる**(「一度 ready に到達したワーカーが、差し戻し後の再作業で…」— どちらも起きていない)。稀な偽陰性を、日常的な偽陽性と交換する取引だった。

**エンジン盲目区間の穴(2026-07-20 に縮小)**: `readyAt` は pass の観測結果でしかない。`stopOrchestrator` は**稼働中の worker をわざと生かしたまま**エンジンを止め(:7285)、og-manage は司令官に「エンジンを止めて手で列を動かす」手順を案内している。つまり **納品 → 手動 move → 差し戻し → 再作業 の往復が丸ごとエンジン盲目下で起きうる**。その worker は `readyAt` 無しで上限に到達し、0718 の事故ログが逐語で再現していた(実測)。

**durable な witness は在った — worker 自身の心拍**。旧版はここで「そんな信号は存在しない」と書いていたが、根拠として挙げた「心拍の `ready` は差し戻し後に worker 自身が false へ書き換える」は**書き換わる前に読めば足りる**という点を見落としていた。差し戻し直後の pass では心拍はまだ `ready:true` であり、それを読んだ時点で `readyAt` に**焼く**(:5689 手前)ので、以後 false に書き換わっても記録は残る。`commitsAhead` と違って心拍の `ready` は worker の**明示的な完了宣言**なので、「足場をコミットして空転している worker」を納品済みと誤認しない(下の囲みの取引には当たらない)。

**残っている穴**: 心拍ファイルが読めない/最初から無い状態でエンジンが盲目区間を跨いだ場合は、依然として `readyAt` 無しで上限に当たる。ただし**そこに至っても即時撤去はされない**((c) の起点移動は心拍 witness に依存するが、心拍が読めない worker は納品の証拠が一切無いので暴走扱いが妥当)。エンジンを動かしたままなら、この経路自体が起きない:

**上限に到達した理由は 1 つではなく 4 つある**。`readyAt` は routing(blocked か review か)しか決めない。**何が起きたかを語る全ての面**は `execTimeoutShape`(:5682 で決まり :5720 で通知に載る)で選ぶ — boolean では足りず、実際 2 値だった頃に (c) が (b) の文面を着せられてオーナーが矛盾したカードを読んだ。

| | 未 ready | (a) `rework` | (b) `capped-wait` | (c) `work` |
|---|---|---|---|---|
| どういう状態か | 一度も納品していない | 差し戻され、**実際に再作業して**予算を使い切った | 統合待ちが**控除上限を超え**、その超過分が計上されて上限に達した(**2026-07-20 以降は定常状態では到達しない** — §5.5(c)) | 待ちは**全額控除**され再作業もしていない。上限は**純粋に実作業**で来た(kept promote = 待ち 0 分もここ) |
| 判別式 | `readyAt` 無し | `now − reworkAt ≥ 1分`(起点も `reworkAt`) | 起点が dispatch **かつ** `rawWaited > WAIT_CREDIT_CAP_MS` | それ以外 |
| 理由(`WorkerRecoveryReason`) | `runaway` | `integration-wait` | `integration-wait` | `integration-wait` |
| カードの行き先 | blocked(人手) | **review** | **review** | **review** |
| 通知の判別子 | `execTimeoutKind:'runaway'` | `+ execTimeoutShape:'rework'` | `+ 'capped-wait'` | `+ 'work'` |
| journal(上限行) | `worker runaway — worked …` | `worker over execution budget while RE-WORKING after 差し戻し — …` | `worker stopped after a LONG integration queue — waited …m, only …m creditable …` | `worker over execution budget doing REAL WORK — … waited …m, fully credited` |
| journal(回収行) | `worker runaway (hit execution-time limit) — stopped — card → blocked` | `worker 差し戻し後の再作業で作業上限に到達 — 停止…` | `worker 統合待ちが控除上限を超過 — 停止…` | `worker 実作業が作業上限に到達 — 停止(待ち時間が原因ではない…)` |
| tip の状態 | 未検証 | **未検証**(再作業が打ち切られた) | **ready 到達時のまま**(統合を判断できる) | **未検証**(作業中に打ち切られた) |
| 平易文(オーナー) | 「分割して再依頼 or 見送り」 | 「その後の**手直し**が持ち時間を使い切って途中で止まりました」 | 「取り込みの**順番待ち**が長引いたので担当を降ろしました。**手直しはしていません**」 | 「できあがったあとも**作業を続け**、持ち時間を使い切りました。**順番待ちのせいではありません**」 |

> **(b) と (c) を取り違えないこと**。「待ちが記録されている」ことは「待ちが原因」を意味しない — 控除上限を**超えた**ときだけ、切り捨てられた分が実行時計に乗る。tick は 3 秒なので、**上限直前まで働いていた worker が差し戻された直後に上限を越える**経路は構造的に頻出で、そこで「原因は待ち時間」と書くと 20 分の待ちを 480 分の上限と比べて何も切り捨てていないのに待ちのせいにする、算術的に成立しない文になる。

> **journal は 1 停止につき 2 行出る** — 上限判定そのものの行(:5534)と、`recoverLost` の回収行(`worker <verb> — card → <col>` :5131)。**両方が同じ事実を言っていること**が要件で、初版は `verb` 側(:4982)だけが「統合待ちのまま作業上限に到達」と書いていた。下段の禁止語は**全行に**掛かる — 回帰テストは journal 全行をスイープして固定している(片方の行だけを assert していたのが見逃しの原因)。

**この分岐に来る状況は 2 つある**(2026-07-19 に訂正 — 初版は「1 つだけ」と書いていたが偽だった)。`readyAt` が立つのは **3 箇所**: エンジンの promote(:5324)、カードが既に review/done に在るのを観測する early-continue(:5420)、そして **Board 書き込みが KEPT になった promote**(:5350)。前 2 つは `stage:'done'` に送るが、**3 つ目は `stage:'running'` のまま刻み、カードは `doing` から一歩も出ない**。したがって「`'done'` を抜ける唯一の道は差し戻し観測だから、上限に来た ready worker は必ず再作業中」という初版の推論は成り立たない。

| | (a) 差し戻し後の**再作業**で上限 | (b) **再作業していない** |
|---|---|---|
| どうやって来るか | 差し戻され、実際に作業して予算を使い切った | ①統合待ちが控除上限(§5.5(b) の `WAIT_CREDIT_CAP_MS`)を超えて滞留した ②kept promote で `readyAt` だけ立ち、後の transient な読み取り失敗で promote が落ちた |
| 判別 | **再作業の経過時間**(`now − reworkAt` ≥ 1 分) | 同 < 1 分 |
| 文面 | 「差し戻し後の再作業で作業上限に到達」+ **tip は未検証** | 「統合待ちが長引いたため停止。**上限の原因は待ち時間であって作業ではない**・再作業 N 分」+ tip は ready 時点のまま |

> **判別は `reworkAt` の有無ではなく“再作業の経過時間”**。(b)① では**司令官は実際に差し戻している**(だから `reworkAt` は立つ)が、エンジンは**同じ pass で** 差し戻しを観測して撤去まで済ませるので、その worker の再作業は 0 分である。stamp の有無で分岐すると「63 時間の週末キュー待ち」を「差し戻し後の再作業で上限」と語り、**実作業 3310 分という作り話**を出す(実測)。これは 0718 の誤読を別の形で再生産する、まさにこの節が禁じている型。

カードは `doing` に居て、これから review へ**動かす**(`recoverLost` は `doing` 以外のカードを触らない :4723)。文面もそう書く — 「統合待ちのまま」「review に残る」と書くと事実に反する。

**なぜ暴走扱いしないのか**: この上限が守っているのは「**何も産まないまま無限に走る**」worker(大きすぎるタスク・無限 /order ループ・出力を垂れ流して沈黙検知に掛からない wedge)であって、**統合可能なコミットを既に出した worker はその失敗モードを自分で反証済み**。だから暴走の札を貼らない。停止自体はする(slot は有限)が、成果は branch にあるので行き先は司令官のキュー(review)であって、**オーナー判断列(blocked)ではない** — 統合待ちはオーナーが判断する事柄ではない。

- `recoveryColumn`(:1118)が `integration-wait` を `review` に振る。**ただし最優先ではない** — 心拍の `blocked:true`(:1115)だけは先に評価され、worker 自身の「人手が要る」申告が勝つ(§5.4 の判定順の注・2026-07-19 に射程を絞った)
- カード移動は `recoverCard` ではなく `moveToReview` を通る(:5297) — branch をカードに刻み直す seam なので、統合が拾える形で review に置かれる
- Board 書き込みが蹴られ続けたときの **blocked エスカレーションからも除外**(:5299)。ready worker のカードを blocked に落とすのはこの理由が防いでいる当の実害なので、書き込み失敗はエンジン側の問題として `move-stuck` anomaly で表に出す(代償: `review` への write だけが恒久的に蹴られる障害では永久 retry になる — 他の理由が持つ「blocked へ逃がす」脱出路が無い)
- **書き込みが蹴られたときの再試行も理由を保つ**。kept のとき `recordKeptMove` が `intent:'recover-review'` を刻み(:5088)、次 pass の `!alive` 分岐がそれを読み戻して `'integration-wait'` のまま再試行する(:5637)。これが無いと、**PTY は既に撤去済み ⇒ `!alive` ⇒ 理由が既定の `'crash'` に退化 ⇒ 古い ready 心拍を見た `recoveryColumn` が blocked へ**、という経路で 0718 の実害が **Board 書き込み失敗 1 回で裏口から復活する**(実装時に実証テストで確認 — 修正前は赤)
- **理由だけでなく形状(`StuckMove.shape`)も保つ**(2026-07-19 追加)。retry は recovery を作り直すので、intent だけ復元して `shape` を落とすと**既定の「差し戻し後の再作業」verb に退化**し、`capped-wait` / `work` の停止に対して「再作業 0m」と書いた直後の行で再作業を捏造する — §5.6 の「journal 2 行が同じ事実を言う」不変条件の違反そのもの。害は司令官の誤読だけだが、**このカードの発端がその誤読**なので塞いである
- **未 ready の runaway 検知は一切変えていない** — 回帰テストで固定(`STILL runs away a worker that never reached ready`)

**司令官が知っておくべき副作用**(2026-07-20 に発生条件が狭まった): まず前提として、**差し戻しただけでは worker は停まらない** — 起点が差し戻し時刻に移るので、再作業に `MAX_EXEC_MS` 丸ごとの予算が付く(§5.5(c))。以下は**その予算も使い切った**場合の話で、0720 以前のように「差し戻した瞬間に」起きることはもう無い。

`integration-wait` で停まった worker は **worktree も PTY も撤去済み**。その後に review を検証して赤 → 差し戻し(review→doing)すると、**カードは doing に落ちるが worker は居らず、`selectDispatch` は todo 列専用(:609)なので自動では再投入されない**。これは §5.3 の「既知の残穴」(worker 不在のカードが doing に沈む)と**同じ穴**で本件が作ったものではないが、**行き先が変わったぶん通り道は増えた** — 旧挙動(blocked 退避)には「オーナーが blocked→todo に戻して再 dispatch」という脱出路があった。したがって **このカードは司令官が明示的に `POST /api/swarm/worker` で立て直すか、todo へ戻す**。§5.3 のケースと違い**ここでは worktree が撤去されているので `orphan-doing` anomaly は発火する**(発火条件が worktree 消滅のため)— 沈黙はせず、少なくとも表には出る。ただし worktree が無い以上、og-manage の「既存 worktree のまま再開」手順は使えない(0718 の実害(b)は、上限が実際に発火するケースでは依然として残る)。

**隣接する既知の穴(本件では未修正 — 別カード相当)**: 免除がかかるのは**作業上限の経路だけ**。差し戻された worker の心拍ファイルは `readyToMerge:true` のまま(エンジンは消せない :5182)なので、**stall / crash / permission / question** で回収されると `recoveryColumn` の「心拍 ready ⇒ blocked」(:1119)が古い ready を拾い、0718 と同じ「ready 済みのカードがオーナー判断列に積まれる」が起きる。敵対レビューの実測では **沈黙 19 分(stall)** あるいは **PTY 死亡 1 pass(crash)** で再現した。

> **本件で「安く」なった点(次に着手する人向け)**: §5.5(b) で `readyAt` を**列に束ねた**ことで、`readyAt` は初めて「この worker は納品したことがある」の**信頼できる**判定になった(以前は promote 経由でしか立たず、司令官の手動 move では立たなかった＝最頻経路で偽陰性)。したがって塞ぐ側の前提条件は揃っている — 実装は `recoveryColumn` に `delivered`(= `w.readyAt` の有無)を渡し、:1119 の「心拍 ready ⇒ blocked」を未納品の worker に限る、の 1 箇所。**それでも本件に載せなかった理由**: この行を外すと「納品済み worker が再作業中に crash/stall した」カードの**新しい行き先を決める**必要があり(review = 未検証の tip を統合列に積む / todo = 再 dispatch で作り直す)、それは crash/stall 回収の既定挙動そのものの設計判断で、既存テストが固定している範囲に及ぶ。上限経路の構造修正(本カード)とは別の判断なので、別カードとして切るのが正しい。

### 5.7 `0m of rate-limit hold credited back` は **値としては正常・文面としては“古いバイナリ”の指紋**(2026-07-18 点検 / 07-20 訂正)

⚠ **2026-07-20 追記 — この節の見出しは半分しか正しくなかった**。`0m` という**値**は正常だが、`0m of rate-limit hold credited back` という**言い回し**は 2026-07-12 23:47(`7ee422d6`)〜2026-07-18 14:00(`a2164a46`)の間しか存在しない。0718 の修正で控除欄は `…m rate-limit hold + …m 統合待ち credited back` に置き換わっているので、**この文字列が今のログに出たら、その engine プロセスは 07-18 より古いコードを実行している**。0720 の事故 2 件はまさにこれで、ソースにもビルド済み bundle にも修正は入っていたのに、**動いていたプロセスがそれを読み込んでいなかった**。

**司令官の診断手順**: 上限まわりの事故を見たら、まず**控除欄の文面でエンジンの版を判定する**。

| ログに出ている控除欄 | エンジンが実行しているコード |
|---|---|
| `Xm of rate-limit hold credited back` | **07-18 より古い**(統合待ち控除は載っていない) |
| `Xm rate-limit hold + Ym 統合待ち credited back` | 07-18 以降 |
| `計上は差し戻し以降のみ(統合待ち Ym は計上対象外)` | 07-20 以降・かつ差し戻し後の停止 |

ソースや `server/dist/index.cjs` が新しいことは**実行中プロセスが新しいことの証明にならない**(fork 済みの長命プロセスは古いコードを持ち続ける)。`server/dist/` は gitignore なので git からは版を追えない。また esbuild は非 ASCII を `\uXXXX` 形式へエスケープするので、**bundle を日本語そのままで grep すると必ず 0 件になる**(偽陰性 — 修正が入っているのに「入っていない」と読める)。**ASCII 部分だけで引くこと**:

```bash
# 版の判定(0 件 / 非 0 件で読む)。日本語では引かない
grep -c 'of rate-limit hold credited back' server/dist/index.cjs   # 非 0 なら 07-18 より古い
grep -c 'rate-limit hold + '               server/dist/index.cjs   # 非 0 なら 07-18 以降
grep -c 'beginIntegrationWait'             server/dist/index.cjs
```

以下は 0718 時点の点検結果(値そのものについては現在も有効):

0718 事故のログに出た `0m` は**正しい値**。この worker は quota 待ちを一度もしておらず(ready 到達後に統合待ちで idle していただけ)、控除すべき hold がそもそも存在しなかった。当時 91 分が実作業と判定された原因は hold 台帳ではなく、**統合待ちが控除項に無かったこと**(§5.5(b))。

台帳側も全経路を点検し、**取りこぼしは無い**と確認した:

| 経路 | 挙動 | 判定 |
|---|---|---|
| hold の**開始** | `engine.rateLimited` を set する箇所は 1 つだけ(:5717)。`holdSince` は `engine.limitScreen` の onset まで遡る | ✓ |
| hold の**解除** | `endRateLimitHold`(:2043)が唯一の seam。span を必ず bank する | ✓ |
| 上限到達での teardown | credit を**読んでから** map を消す(:5426-5468 の順序) | ✓ 先に消していれば漏れるが、そうなっていない |
| 死んだ terminal の GC | bank せず delete。既に worker が居ないので控除先の実行時計が無い | ✓ |

**唯一の理論上の目減り**: `limitSince` は「PTY 出力が `RATE_LIMIT_SCRAPE_QUIET_MS`(45 秒)凪いだ pass で画面をスクレイプして初めて」刻まれるので、**実際の limit 発生から最初のスクレイプまで(最大 45 秒 + 1 tick)は控除されない**。90 分の上限に対して 1 分未満・分単位のログでは `0m` に丸まる量で、しかも**過少控除の方向**(判定は厳しくなるだけで、worker が不当に延命されることはない)。よって**修正不要**と判断した。

---

## 6. worktree の回収 — 誰が・いつ・何を消すか(全経路表)

worktree を消せるコードパスは以下で**全部**(検索根拠: `removeSwarmWorktree` / `recoverWorker` / `deps.cleanup` / `cleanProjectWorktrees` の全呼び出し元)。全経路が central worktrees dir 配下限定ガードを通る(removeSwarmWorktree :314-323)。

**WIP 保全(2026-07-12 根治)**: `deps.recoverWorker`(= `defaultRecoverWorker` :3221)を通る経路 = 表の **2・3・4・5** は、worktree を消す前に必ず `commitWipBeforeTeardown`(:3155)を通る:

1. PTY を kill(先に殺す — 消す木にまだ書かれては困る)
2. worktree の `node_modules` symlink を外す(`node_modules/` 記法の .gitignore だと symlink が untracked に見え、`git add -A` が拾ってしまうため)
3. `git status --porcelain` が **空なら no-op**(clean な木に偽のコミットは作らない)
4. dirty なら `git add -A` + `git commit --no-verify` で **`WIP: swarm reclaim auto-save (<TeardownReason>)`**(`TeardownReason` 型定義 swarmOrchestrator.ts:1062 — crash/stall/runaway/rate-limit/permission/question/stopped/rework)を branch に打つ。本文に「未検証。統合前にレビューせよ」と明記される。committer identity が解決できない環境では swarm 名義で 1 回リトライする
5. **保全に失敗したら worktree を消さない**(`{removed:false}` — 作業の唯一のコピーだから)。journal に `uncommitted work could not be saved (…) — worktree kept` が出る
6. 保全したら journal に `worker reclaimed with UNCOMMITTED work — auto-saved as a WIP commit (<sha>) on <branch>` が出る ← **司令塔はこれを見て branch を拾う**(再 dispatch は新 branch を切るので、この行だけが手掛かり)

経路 **1・6・7・8** は通らない(1・7 = エンジン外の API、6 = 統合成功後なのでコミット済み、8 = エンジン自身の一時 dir)。

| # | 経路 | トリガ | force? | WIP保全 | branch | 心拍ファイル | engine log の文言 |
|---|---|---|---|---|---|---|---|
| 1 | `POST /api/swarm/worktree/remove`(server/routes/swarm.ts:498-521) | UI Terminate(SwarmModule.tsx:433)/司令塔 curl | body の `force`(soft は dirty 拒否) | — | 残る | 残る(janitor 待ち) | (エンジン外 — ログ無し。**非 force の撤去成功時のみ** branch tip の trunk 到達を判定し、統合済みなら self-update トリガを発火 — 応答 `selfUpdate` + bell 通知が観測点。selfUpdateOnIntegrate.ts / TARGET-STATE §5) |
| 2 | `stopOrchestratorWorker`(swarmOrchestrator.ts:7652) | オーナーがエンジン worker を Stop(`POST /api/swarm/orchestrator/worker/stop`) | **force** | **あり**(`stopped`) | 残る | 残る | `worker stopped by owner — card → blocked: …` |
| 3 | monitor の `recoverLost`(:5051 — `monitorWorkers` 内ローカル) | PTY 死亡 / stall / runaway / rate-limit / permission / question | **force** | **あり**(回収理由) | 残る | 残る | `worker lost/stalled/runaway … — card → todo|blocked: …` |
| 4 | 差し戻し系 teardown(rework / conflict 委譲) | **[撤去済み・歴史的記録]** 2026-07-15 のマネージャ専任化でエンジン側のこの teardown 経路自体が無い(§5.3 の訂正注記) | **force** | **あり**(`rework`) | 残る | 残る | `差し戻し review→todo … 再 dispatch(worker 不在)` 等 |
| 5 | `resolveOrchestratorReview`(:7726) | オーナーが review カードを手動 resolve(todo/blocked) | **force** | **あり**(`stopped`) | **残す**(人/次 worker がコミットを使う前提) | 残る | `review resolved by owner — card → …` |
| 6 | 統合成功後の `defaultCleanup`(:4884)(**HISTORICAL — 2026-07-15 マネージャ専任化で engine land ごと撤去・発火しない**。現在の統合後掃除は司令官の手動手順 — 03 章 §5) | (当時)autoMerge がその branch を trunk に land し、カードが review→done に動いた直後 | **force** + **`branch -D`** | — (統合済み = コミット済み) | **消える** | 残る(branch 消滅により janitor の掃除対象になる) | `integrated (ff|rebase-ff): … → main`(もう出ない) |
| 7 | `POST /api/project/worktrees/clean`(server/routes/project.ts:458-468 → worktreeCleanup.ts:105-171) | 手動 API / UI の worktree 掃除 | **force なし**(clean のみ。dirty と live-PTY は必ず skip — :140-143) | — (dirty は skip) | 残る | 残る | (エンジン外) |
| 8 | `withRebasedWorktree`(:4458) | エンジンの verify/レビュー用 **一時** `.review-*` dir(worker の worktree ではない) | force | — | — | — | — |

janitor(`runSwarmJanitor` — swarmJanitor.ts:405-413)は **worktree 本体を消さない**。消すのは (1) merged/empty な `swarm/*` branch(`-d` のみ。`-D` は user-explicit force のみ — :219-231)、(2) 15 分 stale かつ worker 証明済み消滅の心拍ファイル(:310-390)、(3) terminal pool の死骸エントリ(terminal.ts:753-773 — kill はしない)。呼び出しは overseer ON 時の 15 分毎のみ(swarmOverseer.ts:568-570)。

### 実測(2026-07-10「rebase 済み worktree(self-supp)が worker 停止後に消えた」)の犯人特定

「worker 停止」の主体で犯人が決まる。**上の表のとおり、worker を止める操作それ自体が worktree 削除を内蔵している**:

- オーナー/司令塔が **エンジン worker を Stop した**(経路 2)→ その API 自体が worktree を force 削除する。「停止」と「worktree 削除」は**同一操作**。ログに `worker stopped by owner` が残る
- **PTY が exit しただけ**(worker 自身が終了/killed)→ 次の monitor パスが判定する。ここで **「rebase 済み」が決定的**: rebase して origin/main と同内容(または統合済み)になった branch は `commitsAhead = 0`(`defaultCountCommitsAhead` swarmOrchestrator.ts:3043)→ `classifyWorker` は `hasWork=false` で promote しない(:1030-1031)→ dead+not-promoted = `recoverLost`(crash)で **worktree force 削除**(経路 3)。ログに `worker lost — card → …` が残る
- (当時)autoMerge がその branch を land していたなら経路 6(cleanup が worktree + branch を両方消す)。ログに `integrated (…)` が残る — **2026-07-15 以降は engine land 撤去につきこの経路は起きない**(司令官の手動統合 03 章 §5 では司令官自身が worktree/branch を掃除する)
- 誰かが `worktrees/clean` を叩いたなら経路 7(rebase 済み = コミット済み = clean なので、PTY が死んでいれば削除対象)

**どれだったかはエンジン log(`GET /api/swarm/orchestrator` の `log`)の上記文言で裏取りできる**(§8)。共通する教訓: **worktree は「worker の作業机」であり、PTY が死ぬか止められた時点で回収される消耗品**。中身を担保するのは **branch のコミット**であって worktree ではない。

2026-07-12 の根治で、エンジン経由の teardown(経路 2〜5)は消す前に未コミット分を **WIP コミット**に変換するようになった(§6 冒頭)ので「作業そのもの」は失われない。ただしそれは**救命ネットであって設計ではない**:

- WIP コミットは **未検証**(`--no-verify`、完了ゲート未通過)。統合前に必ず人/エンジンが verify する
- **経路 1・7(エンジン外の API)には保全が無い** — soft(force 無し)は dirty を拒否して守るが、**force Terminate は未コミット物ごと消す**
- だから規律は変わらない: **worker はフェーズの境目ごとに自分でコミットする**(§2.4 の `/order` 注入に焼き込み済み)。司令塔が worker を止める前に確認すべきは「branch にコミットが乗っているか」であって「worktree が綺麗か」ではない

### RESTART(worktree 指定)の意味

`POST /api/swarm/worker` に `worktree`(絶対パス)を渡すと **fresh dispatch ではなく再入場**になる(server/routes/swarm.ts:306 `isRestart`):

- `resolveExistingSwarmWorktree`(swarmWorker.ts:387-404)が central 配下・実在・branch 有りを検証し、**新しい worktree も新しい branch も作らない**。同じ `swarm/*` branch・仕掛かり品ごと claude を再起動する
- twin-dispatch ガードが免除される(routes :313, :348-351 — カードが doing のままでも 409 にならない。新 branch を鋳造しないため)
- goal は taskId があればカードから、なければ `taskTitle || note || branch` から復元(SwarmModule.tsx:795)。UI は古い PTY を先に best-effort kill してから POST する(SwarmModule.tsx:783)
- **worktree が既に回収済みなら失敗する**(`restart worktree no longer exists` — swarmWorker.ts:397)。この時の選択肢は fresh dispatch(branch は残っているので、新 worker は最新 trunk から出発し、必要なら旧 branch のコミットを拾わせる)

---

## 7. 落とし穴(司令塔が実際に踏んだ事象を含む)

1. **【0710 実測・0711 根治済み】API の `heartbeatAt` を信じて「worker が半日死んでいる」と誤診** — §4 のとおり、当時はエンジン worker の heartbeatAt が凍結値だった(ディスクを読めば 00:41 まで生きていた)。2026-07-11 の修正で `heartbeatAt` はディスク優先になったため、この誤診パターンは再発しない
2. **【0710 実測】「rebase 済みだから安全」と思っていた worktree が worker 停止で消えた** — §6 のとおり、停止=force 削除が仕様。しかも rebase で commitsAhead=0 になった branch は promote 不能なので、PTY 死亡 → crash 回収(経路 3)コース。**worktree を残したい stop は存在しない**(soft Terminate=経路 1 の force なしだけが dirty tree を拒否して守る — ただし clean なら消える)
3. **worker 停止 → RESTART の順で操作すると RESTART が必ず失敗する** — 停止が worktree を消すため(§6 → RESTART 節)。再開させたいなら停止せず RESTART(古い PTY は API/UI が kill してくれる)
4. **差し戻し後の即 re-promote は起きない設計** — 心拍ファイルに古い `readyToMerge:true` が残っていても、`reworkAt` より新しい心拍が来るまで promote は抑制される(:5284-5292)。「worker に直せと言ったのにカードが review に戻らない」ときは、worker が **swarm-beat.sh を打ち直していない**のをまず疑う。**【0713 実測・同日修正(残穴あり)】**司令官が Board API(`{rework}`)で差し戻したカードをエンジンが二度と拾わない事象があった — 外部差し戻しは in-memory roster に届かず `stage:'done'` のまま早期 continue(:5209-5233)で永久スキップされ、worker が直して ready を打ち直しても doing に沈み続けた(実測 55 分・手動 setColumn でしか復旧せず)。修正後は monitor が「stage:'done' なのにカードが doing」を外部差し戻しとして観測し `stage='running'` + `reworkAt=now` で再武装する(:5167-5190。§5.3)。古い心拍で即 re-promote しない保証(この項の前段)もこの経路でそのまま効く。**ただし PTY が差し戻しより前に exit していた場合は roster にエントリが無く観測できない** — 同じ沈み方がその稀な条件でだけ残る(§5.3 の「既知の残穴」。orphan-doing 異常も worktree 残存で発火しない)
5. **worker が commit せず done true だけ打っても何も進まない** — promote は commitsAhead>0 が必須(`hasWork` swarmOrchestrator.ts:1030)。dead+ready+成果ゼロは blocked 送り(:1041)。worker の掟「ready 前に必ず自分でコミット」はコードで強制されている
6. **エンジン roster は in-memory** — アプリ/サーバ再起動でエンジンは worker を忘れる(stage 無しのエンジン外 worker として workers API に出続ける)。「エンジンに worker が居ないから全員死んだ」ではない。ソース 2/3(live PTY / 心拍ファイル)で必ず突き合わせる
7. **心拍ファイルは worker 停止後も最大 15 分+α 残る** — janitor は overseer ON 時 15 分毎にしか回らず(swarmOverseer.ts:135 既定値, :620 発火条件)、しかも branch か worktree の消滅が証明できるまで消さない(swarmJanitor.ts:377)。**dead worker タイルが workers API に残っていても異常ではない**。branch も worktree も残したまま PTY だけ死んだ手動 worker は、restart 対象として意図的に表示され続ける(swarmWorkerRegistry.ts:238-251)
8. **PTY exit 後 30 秒は linger** — セッションは `finishedAt` 付きで約 30 秒プールに残る(terminal.ts:360 で `finishedAt` を打ち、:389 で 30 秒後に pool から delete。sweep 側の補填は :720-721)。workers API のソース 2 は `listActiveTerminals`(:634、finishedAt 除外は terminal.ts:639)を使うため、exit 直後の worker は「terminalId 無し」に即時遷移する
9. **node_modules に触るな** — worktree の node_modules は本体への symlink(§2.3)。worker に `npm install` をさせない・司令塔も worktree 内で lock を書き換える操作をしない
10. **同一ファイル群を触る 2 枚のカードを同時に走らせない** — twin-dispatch ガードは「同一カード」の二重 spawn を塞ぐだけ(routes :308-352)。別カード同士のファイル衝突は統合ステージの conflict 委譲(**[2026-07-15 マネージャ専任化で撤去 — 現在は司令官が手動でさばく]**)で後払いになる。カード分割時点で disjoint に切るのが司令塔の仕事
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
2. **promote 済み(stage='done')worker の phase/note が永久凍結(heartbeatAt は上記修正でディスク優先になったため対象外)** — monitorWorkers の done ルート(swarmOrchestrator.ts:5288-5235。`next.push({ ...w, stage: 'done', readyAt })` が素通しで `withHeartbeat` を経由しない)は `withHeartbeat` を通らないため、done 後に worker が打った心拍の `phase`/`note`(例: 統合待ちの間の補足報告)は state API にも workers API(ソース 1)にも反映されない。`heartbeatAt` 自体は今回の修正でディスク直読になったので鮮度は追随する
3. **統合成功後、心拍ファイルが最大 15 分 dead worker として表示され続ける** — 経路 6 は worktree+branch を消すが心拍は消さない(`defaultCleanup` swarmOrchestrator.ts:4884-4829 に心拍削除なし。**⚠ この経路自体 2026-07-15 のマネージャ専任化以降 `deps.cleanup` が実際には呼ばれておらず事実上デッドコード** — §5.3/§6 の訂正注記参照)。janitor(15 分毎・overseer ON 時のみ)が branch 消滅を確認して掃除するまで、workers API ソース 3(swarmWorkerRegistry.ts:238-251)に branch 付き dead レコードが残る。この間に UI から Restart を押すと `resolveExistingSwarmWorktree` が「worktree no longer exists」で 500 になる(swarmWorker.ts:397)
4. **overseer OFF 環境では janitor が一切走らない** — 呼び出し元が swarmOverseer.ts:620(`if (now - ov.lastJanitorAt >= config.janitorMs)`)のみで HTTP route が無い。心拍ファイルと merged branch はオーナーが手で掃除しない限り無限に溜まる(実害は小さいが、workers API の dead worker タイルが残置され続ける)
5. **`swarmRepoKey` の in-memory キャッシュは repo 移動に追随しない** — swarmOrchestrator.ts:3060 の `heartbeatKeyCache` は projectPath→key を無期限キャッシュする(読み出し :3063、書き込み :3078)。プロジェクトを relocate して `.git` の realpath が変わった場合、サーバ再起動まで古いキーの心拍ディレクトリを読み続ける(実運用ではまず起きないが、relocate 直後に心拍が「消えた」ように見える可能性)
6. **restart 時の goal 復元が `note`(心拍の一行要約)に依存するケース** — SwarmModule.tsx:795 は taskId 無し worker の title を `taskTitle || note || branch` で復元する。curl-direct worker が長時間動いた後だと note は「今やってること」であってゴールではないため、restart 後の /order が原型より痩せる。カード(taskId)経由で運用すれば回避可能

---

*この文書は docs/commander/ シリーズの第 2 章。心拍プロトコルの書式は swarm-beat.sh(~/.claude/ 配下・repo 外)と同期しており、サーバ側の読み手 3 系統(§3.2)のどれかを変える時は本章の該当節を更新すること。*
