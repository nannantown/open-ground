# RELEASE READINESS GOALS — swarm 込み一般公開の「リリース可能ゴール」

**作成: 2026-07-11**(調査基準 = このブランチ時点の main 系 tip、v0.11.23 直後)。
**読者**: プロジェクトオーナーと、今後の公開準備カードを起票する補給官/司令塔。
**この文書の役割**: OPEN GROUND(swarm = 並列オーケストレーション機能込み)を**一般ユーザー(Windows/Mac)へ公開してよいと判定できる状態**を、観測可能な条件として明文化する。これは**ゴール定義書**であり、個別の実装はしない — §5 の各ギャップが今後のカード起票の種になる。

**既存正典との分担**(重複させない — 詳細は必ずリンク先が正):

| 正典 | 持ち分 |
|---|---|
| [SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md) | 安全不変条件 A〜E の定義・回帰テスト・自己改変マージゲート・品質フロア |
| [commander/TARGET-STATE.md](commander/TARGET-STATE.md) | swarm の理想稼働形 6 条件と「人間承認が恒久に残る操作」の境界(§5) |
| [commander/00-INDEX.md](commander/00-INDEX.md) | 司令塔運用の索引・十戒・表示の信頼度 |
| [DISTRIBUTION.md](DISTRIBUTION.md) | 配布手順(CI リリース §0・署名/公証 §1-2・更新 §3・dmg 検証 §4・**Windows の現状 §6**) |
| [../RELEASE_REPORT.md](../RELEASE_REPORT.md) + `/release` スキル | リリース操作の runbook と RED ZONE 承認フロー |

本書は「**公開してよいかの物差し**」だけを持つ。矛盾を見つけたら現物(コード)が正 — 本書側を直す(00-INDEX §6 と同じ規律)。

---

## 1. ゴール宣言

> **OPEN GROUND を、Windows/macOS の一般ユーザーが配布物(署名+公証済み .dmg / NSIS .exe)をインストールして初回起動したとき、(a) swarm を含む一切の自律挙動が「ユーザー自身の明示的な有効化操作」を経てのみ動き出し、(b) swarm 稼働中であっても、ユーザーの明示同意なしには自動マージ・自動プッシュ・破壊的 git 操作が一切起きないことが機械的ガードと回帰テストで保証され、(c) その保証と中核体験(PTY での claude 対話実行、worker 起動〜統合)が両 OS の実機で end-to-end 検証済みであり、(d) swarm を有効化するユーザーが「何が自動で起きるか/絶対に起きないか」を有効化の場で理解・同意できる — この 4 点が揃った状態を「一般公開可能」と定義する。**

前提の確認(2026-07-11 時点の最重要事実): **現状の配布物では swarm は一般ユーザーに到達不能**である。UI は owner-only experiment(`moduleRegistry.tsx` の `experiment: 'swarm'` + `experiments.ts` = owner ロール AND `settings.experiments.swarm`、fail-closed)、API は全 `/api/swarm/*` ルートが owner gate で 403(不変条件 C)、そして**バイナリに owner は焼き込まれていない**(`roles.ts` — Supabase `og_roles` に行がなければ `'none'`)。つまり今日リリースしても一般ユーザーに swarm 事故は構造的に起きない — 代わりに **swarm 機能も存在しない**。「swarm 込み公開」とはこのゲートを**意図して開く**ことであり、開き方の設計(§5 GAP-1)が本ゴールの最上流にある。

【2026-07-14 更新】上の「到達不能」は「**明示的なローカル opt-in がない限り**到達不能」に変わった: swarm ローカル解錠(`swarmGate.ts` — 手編集 settings.json `swarmLocalOwner:true` / env `OPENGROUND_LOCAL_OWNER=1`、UI なし・既定 OFF・HTTP からは設定不能・swarm 限定スコープ、docs/SECURITY.md)が入り、ログイン無効の業務モードでも(そして知っていれば任意のユーザーでも)自機の swarm を開けられる。GAP-1 の「開き方」の UI なし先行実装に相当し、(a) の「ユーザー自身の明示的な有効化操作」要件は満たすが、(d) の同意開示 UI は未提供のまま — GAP-1 本体(opt-in UI + 開示文)は依然オープン。

---

## 2. 安全性ゴール(ガードレール)

### 2.1 到達条件 — 同意レイヤの表(これが安全性ゴールの本体)

「ユーザーの明示同意なしには絶対起きない」を、**挙動ごとに必要な同意操作**として定義する。公開可能 = この表のすべての行が実装・テスト・実機確認済みで、かつ一般ユーザー向けの開示(§5 GAP-10)がある状態。

| # | 挙動 | 必要な明示同意 | 既定 | プロセス再起動後 | 現状 |
|---|---|---|---|---|---|
| C-1 | swarm 機能の可視化 / API 到達 | (現状)owner ロール + `experiments.swarm` ON。(公開後)GAP-1 で設計する opt-in | 不可視・403 | 設定は永続(ロール必須) | ✅ 閉じている(開き方は未設計 = GAP-1) |
| C-2 | worker の自動 dispatch(drain/自動運転) | Swarm UI から owner が明示 start(`POST /api/swarm/orchestrator/start`) | OFF | **OFF に戻る**(in-memory。`Settings.swarmAutonomyOn` は「前回 ON だった」の表示専用 — auto-resume しない) | ✅ |
| C-3 | boot 時の全プロジェクト auto-drain | env `OPENGROUND_SWARM_AUTODRAIN=1`(strict opt-in) | OFF(回帰テストで pin: unset ⇒ off) | env 次第 | ✅(`server/index.ts` — release blocker カード eadb25e6 で既定 OFF 化済み) |
| C-4 | **origin trunk への統合 push(land)+ worker ready 時の司令官自動起こし** | エンジンに push 経路は無い(2026-07-15 撤去・回帰テスト固定)。起こし反射はエンジン start(C-2)に常時同乗(2026-07-16 に独立トグル `POST .../automerge` を廃止 — 起こすだけで trunk は動かない)。**trunk を動かすのは司令官(claude セッション)の統合だけ**で、カード単位の `[hold]` prefix + 高リスク force-hold が承認ゲート | 経路なし / (起こしは)エンジン OFF なら止まる | エンジンごと **OFF に戻る**(独立の永続フラグ無し) | ✅(粒度は GAP-5 で決着 — カード単位) |
| C-5 | self-supply(エンジン自案カード)の dispatch | arm(既定 OFF・in-memory)**かつ** per-card の owner 承認(`selfSupplyApproved`) | OFF | OFF に戻る | ✅ |
| C-6 | リモートブランチ削除 / `branch -D` 強制削除 | 呼び出し毎の明示 `deleteRemote:true` / `force:true` — 自律経路(janitor)は絶対に渡さない | しない | — | ✅ |
| C-7 | リリース(公開リポへの push / Release publish) | `/release` スキルの RED ZONE — 各段で人間承認 | 自動化なし | — | ✅(恒久境界 — TARGET-STATE §5) |
| C-8 | その他の不可逆操作(プロジェクト delete、model mask 変更、escalation answer 等) | [TARGET-STATE §5](commander/TARGET-STATE.md) の「人間承認が必須で残る操作」8 項目 — **理想状態でも自動化しない恒久の境界線** | — | — | ✅(本書はこの境界に完全に従う) |

**統合(C-4)まわりで起きることの全容**(これ以上のことは起きない — 開示文書 GAP-10 の骨子。2026-07-15 マネージャ専任化 + 2026-07-16 autoMerge トグル廃止に追随):
**エンジン自身は push しない** — verify・敵対レビュー・FF push の旧 land 機構は撤去され、レンズ結果や engine 判断だけで trunk が動く経路は**構造的にゼロ**(回帰テスト「WAKES the commander and NEVER FF-pushes」で固定)。エンジンが単独で行うのは「review に ready な `swarm/*` カードがあり司令官の卓が不在なら、司令官(claude セッション)を起こす」**だけ**で、起こしても trunk は 1bit も動かない。trunk が動くのは**司令官が統合を判断して plain push したときのみ**(`--force` 全形態なし・対象は `swarm/*` ブランチのみ・conflict は自動解決せず停止 — og-manage スキル「マージ」規律)。カード単位の同意 = タイトル先頭 `[hold]`(承認待ち)+ 高リスクパス force-hold は司令官が常時尊重する。正典: [commander/03-integration-review.md](commander/03-integration-review.md)。

### 2.2 現状カバー済みの棚卸し

既存実装が「同意なき自動マージ/自動プッシュ/破壊的 git」をどう封じているか。詳細な定義・テスト・負性コントロールはすべて [SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md) が正典 — ここでは公開判定の観点で列挙のみ。

| 機構 | 何を封じるか | 実装の芯 |
|---|---|---|
| owner gate(二重: UI experiment + API 403) | 非 owner の swarm 到達そのもの。**第一の封じ込め** — 現状の一般ユーザー保護の実体 | `roles.ts` / `experiments.ts` / `server/routes/swarm.ts`(不変条件 C — ライブルート表 sweep で新規ルートの gate 漏れも検出) |
| 3 トグル既定 OFF + 再起動リセット | 「入れただけで勝手に動く」の全否定。drain / selfSupply / overseer すべて in-memory・restart で OFF(旧 autoMerge トグルは 2026-07-16 に**フィールドごと廃止** — 司令官起こしは engine ON に常時同乗し、engine と一緒に OFF へ戻る) | `swarmOrchestrator.ts`(`manualStopPersisted` は auto-start **抑止**側にのみ永続) |
| 統合経路の構造制約 | 第一制約: **エンジンに trunk push 経路が無い**(2026-07-15 撤去・回帰テスト「NEVER FF-pushes」)。残存コード(read-only 分類 + dormant な integrateBranch)にも force-push・履歴破壊・他人のブランチ・ローカル main 書き換えの**構造的不可能性**は維持 | `swarmIntegrate.ts`(不変条件 A/D。plain push・swarm/* 限定・no-remote-trunk は skip・conflict abort) |
| L4 決定論ガード(worker 限定 PreToolUse veto) | 暴走 worker の push 全形態・履歴 nuke・write-roots 外書き込み — `--dangerously-skip-permissions` でも生存する唯一の veto。POSIX lexer の構造解析で evasion 経路(stdin プログラム、eval、alias、inline-code、xargs 未知動詞 fail-closed 等)も封鎖。**配線も spawn 時 fail-closed**(GAP-2 根治 2026-07-11 — `ensureGuardWiring` 検証 NG なら worker spawn 拒否) | `scripts/openground-guard.js`(不変条件 E。`OPENGROUND_GUARD=1` の worker/overseer-brain だけを police — manager は信頼された human-in-the-loop として no-op、これは設計)+ `swarmWorker.spawnSwarmWorker` の配線ゲート(不変条件 E-FAILCLOSED) |
| worktree teardown 境界 | 掃除がユーザーの repo 本体・central 外を消すこと | `swarmWorker.removeSwarmWorktree`(不変条件 B — `force:true` でも越境不能) |
| overseer C-core | 監督ノード自体の暴走。overseer コードは **git 操作を一切持たず**、不可逆操作は reversibility 判定で owner 承認 escalation へ fail-closed。大脳(claude 点火)は guard L4 無条件 + macOS では sandbox L3 無条件 | `swarmOverseer.ts` / `swarmOverseerBrain.ts` / `swarmReversibility.ts`([commander/06](commander/06-overseer-escalations.md)) |
| janitor の自律 git の非破壊限定 | 自動掃除による喪失。`branch -d` のみ(git 自身の merged 判定が網)・remote 削除と `-D` は明示フラグ必須で自律発火不能 | `swarmJanitor.ts` |
| 自己改変マージゲート + 品質フロア | swarm が swarm を壊す変更の auto-merge。swarm コード変更は安全スイート緑必須、全ブランチに tsc/lint/full-test | `swarmOrchestrator.ts` `makeVerify`([SWARM_SAFETY_INVARIANTS.md](SWARM_SAFETY_INVARIANTS.md) 後半 2 節) |
| quota / mask ゲート | spawn 暴走(資源安全 — git 安全とは別軸)。全 tier 枯渇/全 OFF で dispatch park | `swarmQuota.ts` / `swarmAllowedModels.ts`([commander/04](commander/04-quota-models.md)) |
| リリースの人間承認 | 公開リポへの outward push / publish の自動化 | `/release` スキル RED ZONE + [DISTRIBUTION.md §0](DISTRIBUTION.md) |

### 2.3 未カバー(公開までに埋める・§5 に起票の種)

1. **GAP-1**: swarm を一般ユーザーに**開く**ゲートモデルが未設計(現状の安全は「閉じている」ことに依存)。
2. **GAP-2**: ~~L4 ガードの**配線**が fail-open~~ → **根治済み(2026-07-11)**: `spawnSwarmWorker` が worktree 作成前に `ensureGuardWiring()`(hooksInstall.ts)で配線+guard 実体の期待版一致を検証し、NG なら `GuardWiringError` で spawn 拒否 + `'guard-unwired'` 通知(fail-closed)。boot の `installHooks()` は第一防衛に降格(失敗しても無ガード worker は生まれない — worker 拒否に縮退)。回帰ネット = swarmSafety.test.ts INVARIANT E-FAILCLOSED。詳細は [SWARM_SAFETY_INVARIANTS.md §E](SWARM_SAFETY_INVARIANTS.md) / [commander/02 §2.5](commander/02-worker-lifecycle.md)。
3. **GAP-7**: Windows には L3(OS サンドボックス)相当が無い — L4 単層になる(macOS 限定の `sandbox-exec`)。
4. **GAP-5**: ✅ **決着(2026-07-16)**: ~~autoMerge の同意粒度はセッション単位 arm~~ — autoMerge トグル自体が廃止され「セッション単位 arm」という粒度は消滅。統合の同意は**カード単位**(`[hold]` prefix + 高リスク force-hold)+ エンジン start(C-2)に確定([TARGET-STATE §5](commander/TARGET-STATE.md))。
5. **GAP-6**: `SWARM_MANAGER=1` に関する旧仕様の記述(「manager も guard が block する」)がコメント/文書に残存 — 現物(manager は no-op)とのドリフト。

---

## 3. クロスプラットフォームゴール

正典は [DISTRIBUTION.md](DISTRIBUTION.md)(特に §6 の「MUST-validate-on-real-Windows caveats」)。ここでは公開判定に必要なチェックリストだけを持つ。

### 3.1 macOS — ほぼ到達済み

| 項目 | 状態 |
|---|---|
| 署名 + 公証済み arm64/x64 .dmg の CI ビルド(`release.yml` macos ジョブ) | ✅ 実績あり(v0.9.0 以降の公開 Release で証明済み) |
| 配布物検証(`scripts/verify-dmg.sh` — wrong-volume / Rosetta footgun 対策込み) | ✅ 回帰テスト固定 |
| node-pty PTY + claude CLI 対話実行 | ✅ 開発主環境として日常検証済み |
| ログインシェル PATH 解決(Finder 起動対策) | ✅ `electron/main.js`(darwin 限定プローブ) |
| 自動更新(electron-updater、手動 restart 適用) | ✅ [DISTRIBUTION.md §3](DISTRIBUTION.md) |
| L3 sandbox(owner 実験)/ overseer brain の sandbox | ✅ darwin で動作(ただし owner-only・既定 OFF) |

### 3.2 Windows — 「shipping but provisional」(ビルド・分岐実装済み / 実機 E2E 未検証)

3 分類で現状を固定する(調査 2026-07-11。正典: [DISTRIBUTION.md §6](DISTRIBUTION.md))。

**✅ 実装済み・CI/テストで担保**: NSIS .exe の native CI ビルド(windows-2022 pin + node-pty C++20 patch + `win-build-check.yml` 回帰ネット)/ パス処理全般(`homedir()`・`path.join`・atomicWrite の fsync-skip)/ claude バイナリ発見(`claudeConnection.ts` — `claude.cmd`/`.exe`・`where`)/ PowerShell 起動整形(`claudeTerminal.ts` — `$env:` prefix・call operator `&`・`$(Get-Content -Raw)`・単一引用符二重化)/ hook+guard インストールの win 引用符対応(`hooksInstall.ts` — L4 は cross-platform)/ swarm エンジン本体(git は全て `execFile` シェルなし — OS 中立)/ フォルダピッカー・削除(Recycle Bin)・エディタ起動・deep link・自動更新。

**⚠️ 実装済みだが実機未検証**(公開ブロッカー — GAP-3):
1. **node-pty / ConPTY ランタイム** — `powershell.exe` + 対話 claude の PTY spawn、exit signalling、resize、Ctrl-C(`\x03`)。
2. **claude CLI on Windows** — ConPTY 下での subscription/TTY billing が macOS と同一に振る舞うか。
3. **PowerShell 5.1 の embedded-quote** — 値内 `"` を含む app-context(`--append-system-prompt` の JSON)が mangle されうる既知制約(`claudeTerminal.ts` コメントに明記)— 自動注入コンテキストが 5.1 で欠ける可能性。
4. 上記を含む**対話ターミナル happy path 一式**と **swarm worker 起動〜統合の E2E**。

**❌ 未実装 / Windows に存在しない**:
- **コード署名なし** → SmartScreen 警告(「More info」→「Run anyway」、README 開示済み)— GAP-4。
- **L3 sandbox / overseer brain の OS 封じ込め**(darwin 限定)— GAP-7。
- **og-manage コマンダースキルの中身が bash/curl 一色** — Windows 素の PowerShell では `curl` が `Invoke-WebRequest` alias で壊れる(人間コマンダー体験のみ。エンジンの無人運転は API/git/launchClaude 経由なので無傷)— GAP-8。
- `lsof` ポート競合診断(win はスキップ・汎用エラーのみ)— 軽微、非ブロッカー。

### 3.3 swarm 機能そのもののクロスプラットフォーム判定

swarm **エンジン**(orchestrator/worker/integrate/janitor/overseer 脳幹)はプラットフォーム中立に書かれている。公開判定で問うべきは次の 3 点だけ:

- [ ] Windows 実機で worker(= PTY 上の claude)が spawn し心拍を打てるか(GAP-3 の一部 — `~/.claude/swarm-beat.sh` は bash スクリプトであり、Windows worker の心拍手段は要検証/要代替)
- [ ] Windows 実機で統合(fetch→rebase→plain push)が完走するか(git は `execFile` なので理論上 OK — 実測のみ)
- [ ] L4 ガードが Windows の worker セッションで実際に exit 2 を返すか(hook 実行は `node <path>` 明示起動で shebang 非依存 — 実測のみ)

---

## 4. 公開前チェックリスト(検証手順)

「§2・§3 を満たした」と宣言する前に打つ手順。**すべて機械判定可能な形**で書く。

### 4.1 安全性(どの OS でも)

```bash
# (1) 安全回帰ネットが緑(不変条件 A〜E + 統合ゲート) — 完了ゲート 3 点セットと同時に
npx tsc --noEmit && npm run lint && npm test

# (2) 新規インストール相当(ロール無し)で swarm が閉じている:
#     未ログイン状態で全 /api/swarm ルートが 403(routes sweep テストが同等を常時検証)
npx vitest run server/routes/__tests__/swarmSafety.routes.test.ts

# (3) トグルの再起動リセット: サーバ再起動後にエンジンごと OFF(running/selfSupply/overseer が全て false)
#     autoMerge フィールドは 2026-07-16 撤去 — 応答に存在しないのが正常(出てきたら回帰)
curl -s "http://127.0.0.1:47776/api/swarm/orchestrator?path=<PATH>" | jq '{running, selfSupply, overseer, autoMerge}'
# → 再起動直後は running=false / selfSupply=false / overseer=false / autoMerge=null でなければ回帰
#   (司令官の自動起こしは running に常時同乗 — running=false ならエンジンと一緒に止まっている)

# (4) L4 ガードの牙(worker スコープで push が exit 2) — E2E テストがプロセス exit code を assert
npx vitest run src/lib/server/swarmSafety.test.ts

# (5) 統合エンジンの push に force が無い(静的補助確認 — 機械判定の正典は (1) に含まれる不変条件 A テスト)
grep -n "'push'" src/lib/server/swarmIntegrate.ts
# → push 実呼び出しは 2 行のみ(FF push / rebase 後 push)、いずれの引数配列にも --force / -f が無いこと
grep -n "'--force'" src/lib/server/swarmIntegrate.ts
# → 唯一の hit は 'worktree remove --force'(エンジン自前の throwaway worktree 掃除 — push とは無関係)であること
```

画面操作の確認(手動・リリース毎に 1 回):
- [ ] 新規 HOME(`OPENGROUND_HOME` を空 dir に向ける)で起動 → Swarm タブが**存在しない**こと・何も自動起動しないことを目視
- [ ] owner で swarm 有効化 → 自動運転 OFF のまま worker が 1 体も湧かないこと
- [ ] worker を 1 巡させ、**エンジン由来の push がゼロ**(カードは review 列止まり・trunk が動くのは司令官の land だけ)を `git log origin/main` で確認 — エンジンに push 経路が無いことの実機確認(トグル廃止後は「arm せず」という前提操作自体が存在しない)

### 4.2 macOS 配布物

```bash
# ドラフト Release の dmg を検証(バージョン・arm64・feature marker)— 正典: DISTRIBUTION.md §4
scripts/verify-dmg.sh "OPEN GROUND-X.Y.Z-arm64.dmg" X.Y.Z swarmOrchestrator
# 署名 3 点(エンドユーザー側の確認手順でもある)
codesign --verify --deep --strict --verbose=2 "/Applications/OPEN GROUND.app"
spctl --assess --type execute --verbose "/Applications/OPEN GROUND.app"
xcrun stapler validate "/Applications/OPEN GROUND.app"
```

### 4.3 Windows 実機 QA(GAP-3 を ✓ にする手順 — 現状未実施)

実 Windows マシン(VM 可、ConPTY の挙動確認のため Windows 10 1809+ / 11)で:

1. [ ] ドラフト Release の `.exe` をダウンロード → SmartScreen を「Run anyway」で通過 → 対話インストーラ完走
2. [ ] 初回起動: ウィンドウが開き `/api/health` が応答(ポート 47776)
3. [ ] プロジェクトを Import → カードが出る
4. [ ] Terminal タブで claude を起動 → **対話できる**(入力/出力/Ctrl-C/リサイズ)— ConPTY 検証の本丸
5. [ ] app-context 自動注入が効いているか確認(PS バージョン別: 5.1 と 7 の両方で。5.1 で欠けるなら GAP-3-4 起票)
6. [ ] claude の subscription 認証・課金経路が macOS と同一であることを確認
7. [ ] (owner 設定で)swarm 有効化 → worker 1 体 spawn → 心拍 → commit → 統合(ready で司令官が自動で起こされ land する — 起こし反射はエンジン ON で常時)まで 1 巡
8. [ ] worker セッション内で `git push` を試させ **ブロックされる**こと(L4 の実機確認)
9. [ ] アプリ終了 → 再起動 → トグル全 OFF・自動 spawn ゼロを確認

### 4.4 リリース操作

`/release` スキル + [DISTRIBUTION.md §0](DISTRIBUTION.md) + [RELEASE_REPORT.md](../RELEASE_REPORT.md) の RED ZONE フローに従う(tag push とpublish は別々の後戻り不可点 — 各段でユーザー承認)。本書からの追加要件: **公開前チェックリスト(4.1〜4.3)の結果を RELEASE_REPORT に添付**すること。

---

## 5. 未達成ギャップ一覧(起票の種)

現時点(2026-07-11)で §1 のゴール宣言を満たしていない項目。**優先度 = 公開ブロッカーか否か**で仕分ける。各項目は独立カードとして起票する(本書は実装しない)。カード化の際は[起票テンプレの docs 追随ルール](commander/TARGET-STATE.md)(SWARM_CODE_PATHS に触れるなら docs/commander/ 更新を完了条件に含める)に従うこと。

### 🔴 公開ブロッカー(これが埋まるまで「swarm 込み一般公開」はしない)

| # | ギャップ | 起票の種(観測可能な完了条件案) |
|---|---|---|
| **GAP-1** | **swarm 一般開放のゲートモデル未設計**。現状の安全は owner gate で「閉じている」ことに依存 — 一般ユーザーが使える形(誰でも自分のマシンでは有効化できる)への転換は、認証要件・opt-in UI・同意フローすべて未設計。最上流の設計判断 | 新規インストールのユーザーが、(設計次第でログインの上)Settings の明示 opt-in **のみ**で Swarm タブが出現し API が 200 になる。opt-in UI は C-4 の開示文(§2.1)を表示して同意を取る。opt-in しない限り現状どおり不可視・403。安全レビュー(敵対)通過 |
| **GAP-2** | ✅ **根治済み(2026-07-11 — GAP消化の正はBoard)**。~~L4 ガード配線が fail-open~~ — `spawnSwarmWorker` が spawn 前に `ensureGuardWiring()` で「PreToolUse 配線 + guard 実体の期待版 byte 一致」を検証(1 回の installHooks self-heal → 読み戻し再検証)し、不成立なら `GuardWiringError` で **spawn 拒否** + `'guard-unwired'` bell/OS 通知 | 達成: 全 spawn 経路(engine/route/RESTART)が門を通過。配線を意図的に壊すテスト = swarmSafety.test.ts **INVARIANT E-FAILCLOSED**(F1〜F6、negative control 込み)が拒否・no-worktree・通知を assert |
| **GAP-3** | **Windows 実機 E2E 未検証**(§3.2 ⚠️ の 4 点 — ConPTY / claude CLI subscription / PS5.1 quote / swarm 1 巡)。[DISTRIBUTION.md §6](DISTRIBUTION.md) が「not yet hardware-validated」と明記したまま | §4.3 のチェックリスト 9 項目が実 Windows で全部 ✓(結果を DISTRIBUTION.md §6 に反映し「hardware-validated」へ書き換え)。PS5.1 で app-context が欠けるなら、修正または「PowerShell 7 必須」の明示要件化 |
| **GAP-10** | **同意の開示の組込みが未完**。開示文書そのものは存在するようになった(アプリ内マニュアル Swarm 章(バイリンガル・§2.1 C-4 骨子と同期)+ Settings の Swarm 実験 hint — 2026-07-17 に autoMerge トグル廃止へ追随済み)が、GAP-1 の opt-in フローに「有効化の場での同意取得」としてまだ組み込まれていない | swarm opt-in(GAP-1 で設計する UI)が §2.1 C-4 開示文を有効化の場で表示して同意を取る。開示内容が SWARM_SAFETY_INVARIANTS.md と矛盾しないことをレビューで確認 |

### 🟡 設計判断が必要(ブロッカーかはオーナーの判断次第 — 判断自体を起票する)

| # | ギャップ | 起票の種 |
|---|---|---|
| **GAP-4** | **Windows コード署名なし** → SmartScreen 警告。技術的には README 開示済みで動作に支障なし — 「一般公開の第一印象」として許容するかは事業判断(証明書コスト/EV 検討) | 判断カード: 署名する(証明書取得 + release.yml 組込み)or「初回警告あり」を公開告知に明記する、の二択を決める |
| **GAP-5** | ✅ **決着(2026-07-16 — autoMerge トグル廃止で粒度問題ごと解消)**: ~~セッション単位 arm の適否~~ → エンジンは push しない(経路撤去)ので「push の arm 粒度」という問いが消滅。統合の同意は**カード単位**(`[hold]` prefix + 高リスク force-hold — 司令官の統合規約)+ エンジン start(C-2)に確定 | 達成: [TARGET-STATE §5](commander/TARGET-STATE.md) 条件 2 に正典化。開示文(GAP-10 のマニュアル/Settings)へは 2026-07-17 追随済み |
| **GAP-7** | **Windows は L3(OS サンドボックス)不在** — worker/overseer brain の封じ込めが L4 単層。guard header 明記の残存穴(既存 gitconfig alias 等)が Windows では OS 層で拾えない | 判断カード: Windows 相当の L3(AppContainer/Job Object 等)を実装する or「Windows は L4 単層」を受容しリスクを GAP-10 開示に含める、を決める |
| **GAP-8** | **og-manage(人間コマンダー体験)が bash/curl 依存** — Windows 素の PowerShell で壊れる(エンジン無人運転は無傷)。swarm 込み公開で「コマンダー」をどの OS で謳うか未定義 | 判断カード: og-manage スキルの PowerShell 対応 or「コマンダー運用は macOS/Git Bash 環境推奨」の明示、を決める。心拍スクリプト(swarm-beat.sh)の Windows worker 代替も同カードで扱う(§3.3) |

### 🟢 品質・追随(公開ブロッカーではないが、公開前に済ませたい)

| # | ギャップ | 起票の種 |
|---|---|---|
| **GAP-6** | `SWARM_MANAGER=1` の旧仕様記述(「SWARM_MANAGER=1 が guard を発火させる/block する」)がコメントに残存 — 現物(guard は `OPENGROUND_GUARD=1` の worker 限定・manager は信頼につき no-op)とのドリフト | 該当箇所(`claudeTerminal.ts` の「fires only on SWARM_MANAGER=1」コメント / `swarmManager.test.ts`・`swarmSupply.test.ts` の「guard blocks」コメント / `server/routes/swarm.ts` 等)を現行仕様の記述に更新(`swarmManager.ts` 本体は更新済み)。SWARM_CODE_PATHS に触れるため docs/commander/ 追随込み |
| **GAP-9** | **TARGET-STATE §1〜§5 の実運用実測が未了**(実装は main 入り済み・◐ 状態)。特に §5「エンジン ON 7 日間で ready 放置ゼロ・engine 由来の main FF ゼロ・蘇生反射が実事象で機能」は、一般ユーザーに swarm を渡す前の信頼性実績としてそのまま使える | [TARGET-STATE §7](commander/TARGET-STATE.md) のチェックリストを実測で ✓ にする(それぞれの到達判定コマンドが正典)。本書 §1 の公開判定は「§5 の 7 日間実測 ✓」を安全実績の必要条件として参照する |

---

## 6. 到達判定サマリ(この表が全部 ✓ になったら §1 を宣言できる)

- [ ] §2.1 同意レイヤ C-1〜C-8 がすべて実装+テスト+実機確認済み(C-1 の開き方 = GAP-1、配線 = GAP-2)
- [ ] §4.1 安全性チェックが緑(3 点セット + sweep + 再起動リセット + L4 exit 2 + force 不在)
- [ ] §4.2 macOS 配布物検証 OK(現状ほぼ到達 — リリース毎の実施のみ)
- [ ] §4.3 Windows 実機 QA 9 項目 ✓(= GAP-3 解消、DISTRIBUTION.md §6 を hardware-validated に書き換え)
- [ ] GAP-10 の同意開示がアプリ内に存在
- [ ] GAP-4/7/8 の判断カードがすべて「決着」(実装または受容の明文化 — GAP-5 は 2026-07-16 決着済み)
- [ ] GAP-9: TARGET-STATE §7 の 6 条件 ✓(少なくとも §5 のエンジン ON 7 日間実測) — **2026-07-22 時点で 5/6 到達**(§1 §2 §3 §4 §6 ✓)。**残るは §5 のみ** = エンジン ON 7 日間の連続実績。7/19〜20 の司令官卓増殖(誤蘇生)対応でエンジンを複数回 OFF にしたため未達。増殖の真因は 0.11.32 で根治済み(PTY プールを存在の権威に + 同時 spawn の TOCTOU をロックで封鎖)なので、**再カウントは 0.11.32 での ON 継続開始日から**。§2 は 2026-07-19〜21 の手動統合で実測(1 レビュー単位 85KB が棄権なし・must-fix ゼロで統合到達)
- [ ] 公開リリース自体は `/release` RED ZONE フローで人間承認(恒久 — 本書があっても自動化しない)

---

*鮮度管理: 本書の「現状」記述は 2026-07-11 調査時点のスナップショット。安全機構の詳細は本書でなく正典(SWARM_SAFETY_INVARIANTS.md / TARGET-STATE.md / DISTRIBUTION.md)を必ず参照し、食い違ったら現物が正 — 本書の該当行を直す。GAP の消化状況はカード(Board)が正。*
