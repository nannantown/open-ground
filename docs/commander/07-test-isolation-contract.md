# 07 — 本番 HOME 保護の契約(テストがユーザーのデータを壊せない構造)

**対象コミット: このカードの統合時点**(2026-07-19)。行番号は実測値。
**読者**: 司令塔(og-manage / manage)と、`npm test` を完了ゲートで回す全 worker。
**この章の役割**: 「テスト実行が本番 `~/.openground` / `~/.claude` を壊さない」ことを
**何が保証しているのか**、どこまでが保証されていないのかを 1 枚に持つ。

司令塔が worker に渡す完了ゲートは必ず `npm test` を含む(TARGET-STATE §6)。
つまり**この swarm は、オーナーの実データの隣で 1 日に何十回も vitest を起動する**。
その前提が 2026-07-18 に破れた。

---

## 1. 事故(2026-07-18)— 何が起きたか

vitest の実行がユーザーの**実** `~/.openground/settings.json` を上書きした。

- 登録プロジェクト **45 件 → 3 件**に消滅。
- `canvas.json` のカード配置は**バックアップが存在せず永久喪失**。

**確定証拠**(推測ではない):

| 証拠 | 意味 |
|---|---|
| 本番 settings に `projectsMigratedAt="2026-01-02T03:04:05.000Z"` と `archiveDirName="_arc"` が**両方**残存 | この 2 つを同時に書くコードは repo 内に `storeSettingsRace.test.ts:21,22` の 1 箇所のみ |
| registry に `og-canvas-mirror-*`(tmpdir)が登録されていた | `canvasCollabMirror.test.ts:449` が作る一時ディレクトリ |

### 1.1 3 つの failure が同時に成立していた

1. **安全装置がトートロジーで実質不在**。旧 `src/test/setup-home.ts` は
   `join(tmpdir(), …)` で作った値を `startsWith(tmpdir())` で検査していた —
   **いかなる場合も発火しない**。「守られている」という見た目だけがあった。
2. **`openGroundHome()` が呼び出し毎に env を読む**。`OPENGROUND_HOME` が消えた
   瞬間から、以後の**全読み書きが黙って本番へ**向かう。エラーも警告も出ない。
3. **`delete process.env.OPENGROUND_HOME` が 17 箇所**(うち無条件 4)。封じ込めを
   vitest の `isolate:true` だけに依存しており、`--no-isolate` や config 未読込で崩れる。

**教訓**: 1 は「緑のテスト ≠ 効いているガード」の典型。2 は「fail-open は静かに壊す」。
3 は「規律(全ファイルが正しく後始末する)を安全機構の代わりにしてはいけない」。

---

## 2. 契約(いま保証されていること)

> **テストプロセスが動いている間、OPEN GROUND のホームパスは 4 条件をすべて満たさなければ
> ならない — ①(`OPENGROUND_HOME` リダイレクト先を検証する呼び出しでは)env が明示 pin
> されている ② 解決先が OS 一時ディレクトリ配下 ③ 実 `~/.openground` そのもの・配下ではない
> ④ 実 home / このプロセスの実効 home のどちらの配下でもない(ただしその home 自身が
> 使い捨てのときはその片方だけ免除)。ひとつでも満たさなければ throw する —
> 読み取りも例外にしない。「OS 一時ディレクトリ配下」だけでは不十分 — ②単独は
> `TMPDIR=$HOME` のような汚染で簡単に真になるので、③④が無いと実ホームへのシンボリック
> リンクや `TMPDIR=$HOME` 経由の素通りを止められない(§2.3, §4.8, §4.9 の実測)。**

- **opt-out の env は存在しない**。抜け道のある fence は必ず抜けられるため、意図的に
  用意していない。
- **本番では完全に不活性**。Electron は `OPENGROUND_HOME` を設定しない
  (`electron/main.js:747` は self-update canary の時だけ渡す)ので、
  実 `~/.openground` はこれまで通り解決される。
- **読み取りを免除しない理由**: 実 registry を読めてしまえば、テストはユーザーの
  実プロジェクト一覧を手に入れ、それをどこかへ書き戻せる。事故はまさにその形。

### 2.1 実体(3 層 + 単一実装)

| 層 | 実体 | 役割 |
|---|---|---|
| **fence(最終防壁)** | `src/lib/server/testHomeGuard.ts` `assertTestHomeIsolated` :389 | 解決の瞬間に throw。**書き込みが起きないこと**を保証 |
| choke point | `src/lib/server/paths.ts` `openGroundHome()` :53 → :55 で fence 呼び出し | `settingsFile()`/`canvasFile()` 等**全パスがここから作られる** |
| ミラー | `src/lib/server/hooksInstall.ts` `guardedHomedir()` :76(:82/:83/:199/:201/:419 が使用) | `homedir()` 起点の書き込み(後述 §3) |
| 検出・報告 | `src/test/setup-home.ts` `verifyAndRepin`(`beforeEach` / `afterEach` が全ファイルを包む) | **破った犯人を特定して落とす**。修復もするが主目的は可視化。判定は fence と**同じ述語** `testHomeProblem` に委譲(自前の写しを持たない) |
| 再発防止(静的) | `src/testHomeEnvGuard.test.ts` | repo 全体を grep し、`delete process.env.OPENGROUND_HOME` / `.HOME` の**再発をテストとして落とす**。実行時に踏むのを待たない |
| 作業ツリー防壁 | `src/test/repoRootFence.ts` `installRepoRootFence` :139(`setup-home.ts` が装着) | 保護対象が違う — 守るのは**ユーザーのデータではなく git ワーキングツリー**。毎テスト後に repo 直下を `readdirSync` し、`.gitignore` が覆わない新規エントリを落とす(§4.13) |

**実装は 1 本**(`testHomeGuard.ts`)。paths と hooksInstall で 2 本持たない —
その 2 つのアンカーの**ズレ**こそ 2026-07-14 の事故が突いた穴だから
(`hooksInstall.ts:190` の長い注記を参照)。

#### 2.1.1 独立解 M2 との統合(2026-07-19)— fence が「未設定検査」を包含した経緯

同じ事故に対して**別 worker の解(M2 `3960d41`)が先に main へ着地していた**。本章の
fence とは設計が違い、統合時に突き合わせている(この worktree の rebase)。差分と結論:

| | M2(先着) | 本 fence(統合後) |
|---|---|---|
| 判定対象 | **env が未設定か**(`if (!explicit && VITEST) throw`) | **解決先がどこか**(canonical に tmp 配下か)**+ pin されているか** |
| 未設定 | throw する | throw する(**条件 0** — 下記の理由で解決先検査とは別立て) |
| 設定済みだが実データを指す | **素通り**(非空なので合格) | throw する |
| 相対パス・空白のみ | **素通り**(truthy) | throw する |
| `/var` vs `/private/var` | 判定に使わない | realpath で両側を正規化 |

> ### ⚠️ 統合は最初これを間違えた — 「包含している」は**偽**だった
>
> 統合の初版は M2 の未設定分岐を**削除**し、こう書いていた:
> 「未設定 → `~/.openground` に解決 → tmp 外 → だから解決先検査が発火する」。
> **2026-07-19 の敵対レビューが再現付きで反証した。** これが成り立つのは
> **`$HOME` が実ホームである間だけ**。7 ファイル(`hooksInstall` / `swarmSafety` /
> `swarmSessions{,.integration}` / `worktreeCleanup` / `projectSkills` /
> `swarmTwinDispatch`)が `process.env.HOME` を使い捨て dir に再 pin しており、
> **その窓の中では `join(homedir(), '.openground')` が tmp 配下に落ちて解決先 3 条件を
> 全通過する**。実測で `<偽home>/.openground` が throw なしに返った。
>
> 実データは無事(偽ホームが吸収)。**失われていたのは検出**で、しかも契約が
> 「覆っている」と明言している構成でだった。修正は `requireExplicitPin` として
> **M2 の半分を条件 0 に据え直す**こと — 導出せず、別条件として持つ。
> teeth は `testHomeGuard.test.ts` の *"unset is NOT implied by the destination
> check"*(fallback が実際に tmp 配下であることを前提条件として assert してから
> throw を要求する — 旧理由で通って証拠にならないのを防ぐ)。
>
> **この誤りの形を覚えておくこと**: 「A は B の一部だから B の検査で足りる」は、
> A と B が**同じ環境変数に依存していない**ときだけ真。ここでは解決先が `$HOME` に
> 依存し、テストは `$HOME` を動かす。**読んで正しく聞こえる導出ほど危ない。**

統合では M2 の鑑識情報(実 settings に残っていた固定値・registry 消失の説明)を
`paths.ts` のコメントに保全し、M2 の**静的 grep ガード**(上表の第 5 層)はそのまま
残して新 fence に追随させた(throw 文言の期待更新 + fence 本体と teeth の除外)。

> **教訓(司令塔向け)**: 同一ゴールを 2 体に振ると、**両方とも正しく、片方が他方を
> 包含して見える**形で衝突しうる。「弱い方を捨てて強い方に寄せる」は自然に見えるが、
> **包含の証明を実測でやらない限り穴が開く**(今回まさに開けた)。安全側の作法は、
> 包含を主張して片方を消すのではなく、**両方の条件を別立てで残す**こと。

### 2.2 fence は「パス組み立て」に置く — fs 呼び出しの中ではない

**これは設計上の必須条件で、動かしてはいけない。**

`store.ts` の `readJson` は**今も寛容リーダー**(実体は `readJsonWithHealth` で、
読み取り失敗も parse 失敗も各 `catch` が fallback に潰す。`readJson` はその
`value` だけを返す薄いラッパ — 2026-08-02 に形が変わったので、旧記述の
`catch { return fallback }` :54 という引用はもう現物に無い)。
もし fence を `readFile` の中で投げれば、その例外は握り潰され、`getSettings()` は
**何事もなかったかのように `DEFAULT_SETTINGS` を返す** — fail-closed のつもりが
fail-open になる(過去に同型の前例あり)。**この節の主張は形が変わっても真のまま** —
`readJsonWithHealth` が新しく返す `health` は「不在か・壊れているか」を区別するだけで、
fence の例外を**外へ通すわけではない**(`unreadable` に潰れて呼び手に届く)。

現在は `settingsFile()` が `readJson(...)` の**引数として先に評価される**ため、
throw は try ブロックの外で起き、寛容リーダーを素通りして呼び出し元まで届く。
この性質は回帰テストで固定済み:
`testHomeGuard.test.ts` の *"getSettings REJECTS rather than falling back to defaults"*。

> **⚠️ ただし「必ず throw が届く」は言い過ぎ**(2026-07-19 の敵対レビューによる訂正)。
> 成り立つのは `store.ts` のように**パス組み立てが try の外**にある呼び出し元だけ。
> `sharedCache.ts:43-44,60-61` と `retention.ts:68` は `cacheFile(...)` /
> `projectDataDir(...)` を **try の内側**で評価しているので、fence の throw は
> `catch` に食われて `return null` / `return 0` になる。
> **書き込みは依然として起きない**(引数評価が `mkdir`/`writeFile` に到達する前に
> throw するため)ので**データ安全性は保たれる**が、その経路では fence は
> 「静かに拒否する」挙動になり、`console.error` の痕跡だけが残る。
> 正確な契約は「**実ホームへのアクセスは必ず阻止される。例外が呼び出し元まで届くかは
> 呼び出し元次第**」。

さらに fence は throw の前に `console.error` も出す — 呼び出し元が握り潰しても、
痕跡だけは必ず残るように。

### 2.3 4 つの罠(実装を「簡略化」すると即座に壊れる)

| 罠 | 症状 | 対処 |
|---|---|---|
| **macOS `/var` vs `/private/var`** | `os.tmpdir()` は `/var/folders/…`、`realpath()` は `/private/var/folders/…`。**36 個のテストファイル**が `realpath(mkdtemp(…))` で home を作るので、素朴な `startsWith(tmpdir())` は **macOS で大半を誤検知・Linux CI では素通り** | 両側を `canonicalizePath` :99 で正規化 |
| **未作成 dir の ENOENT** | `swarmJanitor` / `swarmIntegrationLock` / `swarmWorkerRegistry` は `join(scratch,'home')` を mkdir せずに指す。`realpathSync` は throw する | 最近接の**実在祖先**まで遡って正規化し、欠けた末尾を付け直す(:99-114) |
| **symlink home の書き換え** | `swarmWorktreeTrust.test.ts` は home を symlink にして「解決前 ≠ 解決後」を assert している。fence が値を正規化して書き戻すとこの前提が壊れる | **検証のみ・値は絶対に書き換えない**(`assertTestHomeIsolated` は void を返す) |
| **`vi.mock('os')` の全置換** | `editorDetect.test.ts:15` は `homedir` だけを持つ os を返す = `tmpdir` が `undefined` | `tmpdir?.()` を try で包み、`TMPDIR`/`TMP`/`TEMP`/`/tmp` へフォールバック。**全滅したら素通りさせず throw**(`tempRoots` :187-209) |

---

## 3. 保証されていない範囲(残存リスク・正直な線引き)

fence が覆うアンカーは **5 つ**(2026-07-19 の敵対レビュー後に 2 → 5 へ拡張):

| # | アンカー | 実体 | 守るもの |
|---|---|---|---|
| 1 | `openGroundHome()` | `paths.ts:53` | `~/.openground/**`(settings.json / canvas.json / projects/…) |
| 2 | `hooksInstall` | `guardedHomedir()` :76 | `~/.claude/settings.json` + `~/.openground/{hooks,guard}` |
| 3 | `claudeTrust` | `claudeConfigPath()` | `~/.claude.json` — **claude の OAuth トークン**(誤書き込み = ログアウト) |
| 4 | `ogManageSkill` | `installedPath()` | `~/.claude/skills/og-manage/SKILL.md` |
| 5 | `generateSkill` | `opts.home ?? homedir()` | `~/.claude/skills/**` |

> **3 を繋いだ瞬間に、実在の穴が 4 ファイル分落ちた。** fence をアンカー 3 に繋いで
> フルスイートを回すと **38 回発火し、全て `claudeTrust`**:
>
> | テストファイル | 発火数 | 到達経路 |
> |---|---|---|
> | `swarmLensReview.test.ts` | 16 | `ensureClaudeFolderTrusted`(worker 起動) |
> | `swarmOrchestrator.integration.test.ts` | 16 | 同上(REAL git end-to-end) |
> | `selfUpdateOnIntegrate.test.ts` | 6 | `removeSwarmWorktree → removeClaudeFolderTrust` |
> | `swarmSafety.test.ts`(invariant B) | — | 同上。**安全網であるはずのファイル自身** |
>
> 4 本とも `OPENGROUND_HOME` は正しく pin しており、**見た目は完全に隔離されている**。
> だが `claudeTrust` の解決式は `CLAUDE_CONFIG_PATH ?? homedir()/.claude.json` で、
> `OPENGROUND_HOME` では動かせない homedir アンカー。結果、**ユーザーの実
> `~/.claude.json`(claude の OAuth トークン)を読み書きしていた** — fence を繋ぐまで
> 誰も落ちておらず、完全に不可視だった。
>
> これは 2026-07-18 の事故と**同じ機構・別の方向**の再演。「per-file の規律で
> 守られている」は「たまたま無事だった」と同義である、という主張の実証。
> 対処は 4 本すべてで `CLAUDE_CONFIG_PATH` を scratch home 配下へ pin。

**まだ覆っていないもの(正直な線引き)**:

| 経路 | 実体 | なぜ覆えないか / 現状の守り |
|---|---|---|
| `POST /api/observer/install-hooks` | `server/routes/misc.ts` | テストが 1 本も無い。既存の route 総なめテストは `/api/swarm` 接頭辞で絞っているため**偶然**触れていないだけ。ただしアンカー 2 の fence が最後の砦として効く |
| `electron/lockdown.js:34` / `scripts/swarm-lock.js:54` / `scripts/openground-hook.js:48,70` | 同じ解決式の**独立コピー計 4 箇所** | TS の import 網の外(Electron が直接 load / node script / Claude Code が `~/.openground/hooks/` から実行)。vitest からは呼ばれないので現時点の実害は無い。**2026-07-21 以降は「見逃している」のではなく「件数で pin されている」** — sweep の `SANCTIONED_SITES` が各ファイルの件数を持ち、増えても減っても赤くなる(§4.14)|
| `~/.claude/projects/**` の READ 経路 | `transcript.ts` / `claudeUsage*.ts` / `swarmTokenAudit.ts:398` | 全て読み取り専用。**2026-07-20 以降は「実測した」ではなく「毎回検証される」** — §3.1 の `read-only` tier に載っており、当該ファイルが fs 変異呼び出しを 1 つでも持った瞬間に赤くなる |
| **vitest 以外のテスト実行系** | `node --test` / `tsx` / 素のスクリプト | fence の発火条件は「**vitest か**」であって「本番でないか」ではない(`testHomeGuard.ts` の `detectTestProcess`)。vitest 以外でサーバコードを回すと **pin も fence も無い**。現状そういう経路は repo に無いが、追加するなら pin を明示的に持ち込むこと |
| **win32 の「使い捨て home」判定は弱い** | `testHomeGuard.ts` `homeIsThrowaway` | POSIX はハードコードした絶対接頭辞で判定するが、Windows には同等の安定した接頭辞が無いため **`Temp`/`Tmp` セグメントの有無**という名前ヒューリスティックに落としている。`C:\Users\<u>\AppData\Local\Temp\…` は通り、`C:\Users\<u>` は通らないので実用上は効くが、`C:\Temp\real-data` のような配置は誤って「使い捨て」と判定される。CI は ubuntu なので現状の実害は無い |
| **`setup-home` は HOME を再検証しない** | `verifyAndRepin` は `OPENGROUND_HOME` のみ | `--no-isolate` で先行ファイルが `HOME` を偽 home に置いたまま漏らすと、後続の homedir アンカーが素通りする。**データは偽 home 側なので安全**で、失われるのは検出(review nit 2026-07-19) |
| **`vi.resetModules()` + HOME stub で `EFFECTIVE_HOMEDIR` が再捕捉される** | `EFFECTIVE_HOMEDIR`(`homedir()` 由来)は import 時ラッチ | `resetModules` 後に再 import されると、その時点の `HOME`(= stub された偽 home)が新しい `EFFECTIVE_HOMEDIR` として焼き直される。現状これを踏むテストは無いが、**「このプロセスの実効 home」側のベースラインは `resetModules` で書き換わりうる**という性質は覚えておくこと。**`PASSWD_HOMEDIR`(`userInfo().homedir` 由来 — `passwdHome()` testHomeGuard.ts:141)はこのリスクの対象外** — `$HOME` を読まないので `resetModules` 後の再 import でも動かない(§4.9 実測のとおり `$HOME` に免疫) |
| **実 `~/.claude` を fence 無しで名指しする経路(32 ファイル)** | §3.1 のアンカー 38 本 − fenced 5 本 − sweep 自身 | fence を通さず実 `~/.claude` を名指しする(うち 13 本はテキストで名前を出しているだけ)。「fence 済みアンカーは 5 つ」という主張の**境界**。⚠️ この行は当初「READ 経路 **3 本**」と書いていた — **手で数えた値で、実際より少なかった**(§3.1・2026-07-20) |
| **`CLAUDE_CONFIG_PATH` に条件 0 が無い** | `claudeTrust.ts:55` | `openGroundHome()` と同じ「env var、無ければ `$HOME` フォールバック」形なのに、**未設定を弾く条件 0 に相当するものが無い**(§2.1.1 の ⚠️ と同じ穴が 1 変数ズレて残っている)。HOME を pin しつつ `CLAUDE_CONFIG_PATH` を pin しないテストでは、フォールバックが tmp 配下に落ちて条件 1-3 を素通りする。**実データは無事**(実 `$HOME` なら条件 1/3 が発火する)ので失われるのは検出のみ。**意図的に未対処** — 現状 `CLAUDE_CONFIG_PATH` を pin しているのは 2 ファイルだけで、残りは「HOME を pin しているから結果的に安全」な状態。ここに条件 0 を足すと多数のテストが一斉に赤くなるため、影響範囲を測ってから別カードで扱う(review 2026-07-19 指摘 F6) |

> **訂正(差し戻し 1 回目・2026-07-19)**: この表は当初 `swarmTokenAudit.ts` を
> 「`~/.claude/projects/**` の読み取り専用」とだけ分類していた。**誤り**だった。
> 同ファイルの `mainRepoForWorktreeCwd`(:542)は `process.env.OPENGROUND_HOME ??
> join(homedir(), '.openground')` という**独立した第2の解決式**を持っており、
> choke point を通らずに**実 `~/.openground/settings.json`(レジストリ本体)**を
> 読んでいた。司令官の実測: fence 有効の vitest プロセス内で `OPENGROUND_HOME` を
> unset し `mainRepoForWorktreeCwd(process.cwd())` を呼ぶと、**実登録パスが返った**。
> 「読めるだけ」で片付く種類ではない — レジストリはこの事故で消えた当のデータで、
> 何より「解決器は 1 つ」という契約の前提そのものが崩れていた。

### 3.1 `~/.claude` 側の常設インベントリ(2026-07-20・敵対レビュー SF-2)

**指摘**: 第2解決式 sweep(`testHomeEnvGuard.test.ts`)の判定は `'.openground'`
リテラルのみ。今後 `join(homedir(), '.claude', 'settings.json')` に**書く**コードが
生えても sweep は無言、fence も(手で `assertTestHomeIsolated` を呼ばない限り)無言。
担保は「5 アンカーが手で繋がれていること」を人が §5 の grep #4 で確認する運用 —
同ファイルが自ら戒めた「"I re-scanned and found none" is a one-time assurance」
そのものの形。**今日のバグではなく明日の穴**。

**なぜ `.openground` と同じ「解決器は 1 つ」ルールに出来ないか**: `~/.openground`
には choke point (`openGroundHome()`) があるので「他に解決式があったら穴」で済む。
`~/.claude` には choke point が無く、今後も作れない — transcript / usage / skills /
trust / hooks が別々の理由で読む。実測 38 ファイルが名指ししている。

**採った形 — 集合等価の常設インベントリ**。リポジトリ全体のソース(拡張子判定は
git の pathspec ではなく JS 側 `SOURCE_EXT`)のうち、「home らしいトークンを含む行」と
「`.claude` を名指しする行」を**両方**持つファイルは、全て `CLAUDE_ANCHORS` 表に
tier と理由付きで載っていなければならない。**各 tier の主張はソースから毎回
再検証される**(宣言を信用しない):

| tier | 件数 | 主張 | 機械検証 |
|---|---|---|---|
| `fenced` | 5 | 解決が `assertTestHomeIsolated` を通る | 当該呼び出しがファイル内に在ること |
| `read-only` | 14 | 読むだけで、どこにも書かない | fs 変異呼び出しが**ゼロ** かつ **import 節に変異名が無い**こと(別名 import 対策) |
| `writes-elsewhere` | 19(うち 1 は sweep 自身) | 変異はするが実 `~/.claude` には向かない(使い捨て $HOME / choke point 配下の OG home / sanctioned probe prefix 配下の repo 作業ツリー) | 下の全 tier 共通ルールのみ(理由文が残りを担う) |

> **sweep 自身の tier は 2026-07-21 に `read-only` → `writes-elsewhere` へ動いた**。
> origin/main へ rebase した時点で、main 側の repo-root listing フェンス teeth が
> 同じファイルに実 `mkdtempSync` を持ち込み、「fs 変異ゼロ」の申告が成立しなくなった
> ——**それをガードが `CLAIM BROKEN (read-only)` として自分で検出した**(rebase 後
> 1 回目の run・実測)。黙らせずに実体へ合わせてある。残る**検証済み**の保証は
> 「生 write ルールは全 tier に走るので、このファイルも実 `~/.claude` を狙う write は
> 生やせない」であって、「一切書かない」ではない。唯一の変異は `REPO_PROBE_PREFIX`
> 配下の mkdtemp(finally で撤去)で、どの home の下でもない。

> **38 件のうち 13 件は「テキストで名前を出しているだけ」**(UI ラベル / マニュアル本文 /
> sandbox プロファイルの DENY ルール / worker プロンプト文字列)。表が薄まる、という
> 指摘はもっとも —— だが**チルダ綴り `~/.claude` を拾わないと保証 A に穴が空く**
> (シェル経由の書き込みが素通りする)ので、1 行のコストで買っている。ラベル行にも
> 「fs 変異ゼロ」という検証済みの性質は付く。

**さらに tier を問わない共通ルールが 1 本**: `.claude` の出現位置の**前後窓
(−200/+120 字)**に「変異呼び出し」と「実 home 解決式」が同居し、かつ窓内に
`assertTestHomeIsolated` が**無い**なら赤。正しい書き方(パスを組む →
`assertTestHomeIsolated` に渡す → 検査済み変数で書く)は窓に fence が入るので通る。

> **自己レビューで 1 件・外部の敵対レビューで 7 件、実測で穴が出た**。当初この規則を
> ①`writes-elsewhere` 限定にしていたため `fenced` のファイル(=書くのが仕事の
> ファイル群)が入口になっていた。②さらに**同一行**を要求していたため、prettier が
> 折り返すだけで素通りした —— repo 内に折返し write は 42 箇所ある。窓走査は
> 同じファイル内の `.openground` sweep が同日に採った形で、片方だけ行ベースに
> していたのは単に非対称だった。

**保証は 2 つあり、強さが違う。これを混ぜないことが肝**:

| | 保証 | 強さ |
|---|---|---|
| **A** | 実 Claude home に触りうるファイルは**必ず宣言される**(tier + 理由)。検出はわざと広く fail-closed — home らしいトークンなら何でも / ディレクトリ名の綴りは大小無視 / 全ソース拡張子 / repo 全体。新規ファイルが逃げるには**両方のシグナルを隠す**しかない | **強い**。人が分類し、機械が「分類しろ」と強制する |
| **B** | 宣言済みファイルが**あからさまな生 write** を生やせない | **tripwire であって証明ではない**。下記の限界で破れる |

- **両方向の集合等価**: 新規アンカーは `UNDECLARED` で赤(人が分類するまで通らない)。
  宣言済みなのに anchor しなくなったら `STALE` で赤。
- **STALE 半分はファイル探索断の canary** — 探索が 0 件を返したら「違反なし」ではなく
  「38 件全部 STALE」として赤くなる。`grep` の exit code に「本当に走査したか」を
  委ねて macOS だけ無言だった過去の失敗を、設計として繰り返さない。
- **read-only tier こそが本題**: カードが挙げた 5 本の純読み取りは、これで
  「見たときは read-only だった」から「read-only でなくなった瞬間に赤くなる」へ変わる。

**teeth ①(物理・実探索経路)**: 実ファイルを 2 本植え、隔離 HOME で
`npx vitest run src/testHomeEnvGuard.test.ts` を回した。純関数の単体呼び出しでは
なく、**git 探索 → 読み込み → 判定の本番経路**を通している。

| 植えたもの | 何を同時に突くか | 結果 |
|---|---|---|
| `src/lib/server/claudeSettingsPersist.ts` — prettier 折返しの `writeFileSync(\n join(homedir(), '.claude', 'settings.json'),\n json,\n)` | 折返し(E-1) | **赤** `UNDECLARED … join(homedir(), '.claude', 'settings.json'),` |
| `spike/probeCapsHome.mts` — `const { HOME } = process.env` + `` `${HOME}/.Claude/settings.json` `` | `.mts` 拡張子・SWEPT_DIRS 外・大文字 C・分割代入 HOME(E-2/E-3/E-4) | **赤** `UNDECLARED … writeFileSync(\`${HOME}/.Claude/settings.json\`, json)` |
| 改修**前**の sweep(`git show HEAD~1:` を別名で実行) | — | 植えたファイルへの言及 **0 件**(= 無言。SF-2 の指摘どおり) |

撤去後 `git status --porcelain` 空・sweep 27/27 緑に復帰も確認済み。

**teeth ②(常設)**: 判定関数は実 sweep と**同一**のものを呼ぶ。合計 **25 件**
(2026-07-21 実測 = §3.1 の describe ブロック内。同ファイル全体では 36 件で、
残り 11 件は unset sweep / 第2解決式 / repo-root 系のもの)。
- 分類の強制: 新規 write / 新規 read / 探索 0 件(= 全 STALE)
- tier 主張: read-only が write を生やす / **別名 import で生やす** / fenced が fence を失う
- 生 write: **折返し write**(宣言済みファイル内)/ fenced が fence から離れた所に生やす / writes-elsewhere が実 home に書く
- **敵対レビューが実際に通した回避 7 綴り**を綴り単位で pin(下記)
- 誤検出しないこと: 散文 / プロジェクトローカル `.claude` / 正しく fence した書き方
- **探索そのもの**: `SOURCE_EXT` が 8 拡張子を受理し 5 種を弾くこと、`vitest.config.ts` /
  `playwright.config.ts` / `electron/lockdown.js` が走査対象に**実際に入っている**こと
  (探索の穴は他のどの teeth からも原理的に見えないため直接アサートする)

**外部の敵対レビュー(独立エージェント・2026-07-20)が land させた回避 7 件** ——
いずれも「実 `~/.claude` に書けるのに緑」。全て修正し、綴り単位で teeth 化:

| # | 回避の綴り | なぜ通ったか | 対処 |
|---|---|---|---|
| E-1 | prettier 折返しの write | 判定が同一行を要求 | 窓走査(−200/+120) |
| E-2a | `process.env['HOME']` / `const { HOME } = process.env` | アンカーが `process.env.HOME` の**ドット記法だけ** | 広域アンカー `\bHOME\b` 等へ |
| E-2b | `import { homedir as userHome }` | 別名 | 同上(import 行の `homedir` を拾う) |
| E-2c | `execFileSync('sh', […$HOME/.claude…])` | シェル文字列 | 同上(`$HOME` を拾う) |
| E-2d | `USERPROFILE`(win32) | 未収載 | 同上 |
| E-2e | ブロックコメント終端の後ろに実コード | 行頭 `*` を丸ごとコメント扱い | `codeOf` が終端を剥がす |
| E-3 | `'.Claude'`(大文字 C) | 判定が case-sensitive。**macOS は同一 inode** | 正規表現を case-insensitive に |
| E-4 | `.mts` / `.cts` / `.jsx`、SWEPT_DIRS 外の追跡 10 ファイル | git pathspec が「全ソース」に見えて実は違った。**`vitest.config.ts`(setupFiles を配線する当のファイル)が未走査** | 探索を repo 全体へ + 拡張子判定を JS 側へ(teeth で直接検証) |
| E-5 | `import { writeFile as persist }` | read-only の変異検出が呼び出し名ベース | import 節スキャンを追加 |

> E-3 は「理屈上」ではない。レビュアーは実際に大文字 C 経由で `settings.json` を
> 上書きし、**小文字パスから壊れた値を読み出して** `ls -a` でディレクトリが 1 つ
> しか無いことまで示している。`$HOME` と `/private/tmp` は同一ボリューム
> (`/System/Volumes/Data`)なので、実 `~/.claude`(OAuth トークンのある当の
> ディレクトリ)でも同じことが起きる。

#### 第2ラウンド(2026-07-20)— 突かれたのは回避ではなく**誤検出**だった

修正版に対して独立エージェントをもう 1 体当てた。回避も 4 件出たが、**判定は
「main に入れるべきでない」で、理由は誤検出**。正しいコードを赤くするガードは
時間を浪費するだけでなく、**人にガードを黙らせる動機を与える**。

| # | 誤検出 | 何が起きたか | 対処 |
|---|---|---|---|
| **FP-1** | **致命的** | 宣言済みの `server/routes/__tests__/projectSkills.test.ts` に、グローバルスキルのテストとして最も自然な 1 行 `await mkdir(join(fakeHome, '.claude', 'skills'), …)` を足すだけで `UNFENCED WRITE`。書き先は `mkdtemp` した捨てディレクトリなのに、**3 行上の `realHome = process.env.HOME`**(= 本章が「unset せず退避して戻せ」と命じている当の作法)が「実 home 解決」の証拠に数えられていた。しかも提示される直し方が「`assertTestHomeIsolated` に渡せ」—— **KNOWN LIMITS が「近くに置くと黙る decoy」と警告しているものを、ガード自身が書かせにいっていた** | HOME 変数の**退避形 / pin 形**を窓判定から中和(`resolvesRealHome`) |
| FP-2 | 中 | `payload.claude.length` のような**プロパティアクセス**を `.claude` と誤認。repo 内に 10 ファイル 18 箇所(`src/App.tsx` 含む)。どれも home トークン 1 個ぶんの距離で赤になる | `.claude` の直前が識別子文字なら不採用(pin 済み回避 9 綴りは全て無傷を確認済み) |
| FP-4 | 中 | コメントの英文 "the invite deep link **(Track C)**" が `\blink\s*\(` に当たり、2 行下の**純粋な `readFileSync` が「UNFENCED WRITE」と名指しされた** | 窓を**コメント除去済み**ソースから切る + パーレン前の空白を不許可に |
| 回帰 | 中 | `git rm` 無しでファイルを消す(リファクタ途中の普通の状態)/ dangling symlink で**素の ENOENT** が 3 テストを殺す | ENOENT のみ skip(内容が無い = 違反も持てない)。他の read エラーはファイル名付きで throw |

追加で塞いだ回避:

| # | 綴り | 対処(宣言コスト) |
|---|---|---|
| E-6 | `app.getPath('home')` — Electron 自身の home API。repo は既に `app.getPath('userData')` を使っており、hook 配線が main.js に移る動機は普通にある | BROAD に追加(**+0 件**) |
| E-7 | `~/.claude`(チルダ綴り)。`$HOME` 綴りは pin 済みだったのに、より一般的な `~` が抜けていた | BROAD に追加(**+13 件**) |
| E-8 | `HOMEDRIVE` / `HOMEPATH`(win32 の姉妹綴り) | BROAD に追加(**+0 件**) |
| — | `userInfo(` は**検出力ゼロ**と実測(実綴りは必ず `userInfo().homedir` で `\bhomedir\b` が拾う)。削除しても teeth が 1 つも赤くならない = 飾り | 削除(誤検出面だけ減る) |

**実ファイルでの再確認(純関数呼び出しではなく本番経路)**:

| | 結果 |
|---|---|
| `electron/probeGetPathHome.js`(`app.getPath('home')` + `.claude` へ write) | **赤** `UNDECLARED … const dir = join(app.getPath('home'), '.claude')` |
| 実 `server/routes/__tests__/projectSkills.test.ts` に FP-1 の 1 行を追加 | **UNFENCED WRITE は出ない**(= 誤検出が解消していることの実測) |

両方撤去後 `git status --porcelain` 空・32/32 緑に復帰。

**副産物として判明した実測 2 件**:

1. **手で数えた「未 fence 5 本」は不足していた。** 機械で数えると 16 本
   (`claudeConnection.ts` / `swarmTokenAudit.ts` / `scripts/openground-guard.js` /
   `scripts/sandbox-probe.ts` と各種テストが漏れていた)。人力インベントリが
   実際に取りこぼす、という主張の実証。
2. **`grep` ベースの走査は 108KB を無言で飛ばす。** `scripts/openground-guard.js` は
   **リテラルの NUL バイトを 3 個**含む(パス検査用と思われる)。grep はこれをバイナリと
   見なし、`-a` 無しでは**何もヒットしない** — 実測: `grep -c homedir` → exit 1 /
   `grep -ac homedir` → 1、`LC_ALL=C` でも `en_US.UTF-8` でも同じなので**ロケール
   由来ではない**。
   **正確な現状**: unset 検出 sweep(`offendingLines()`)の pathspec は `*.ts/*.tsx`
   のみなので、この穴は**潜在**であって現時点では発火しない(実測: `-a` の有無で
   ヒット数 28 件のまま不変)。ただし第2解決式 sweep は 2026-07-20 に `*.js` へ
   広げられた前例があり、同じ拡張が来た瞬間に「走査対象に入っているのに中身は
   見ていない」状態になる。**先回りして `-a` を付けた**(挙動変化ゼロ)。
   新しい `~/.claude` インベントリは JS 読みなので最初からこの層に依存しない。

**脅威モデル(緑を読み過ぎないために)**: 想定する相手は**急いでいる同僚**であって、
このガードから隠れようとする者ではない。2026-07-18 の事故を書いたのも仕事をしていた
人間で、上表の回避 7 綴りはいずれも「普通に手が動いた結果」の形をしている。本気で
すり抜けたいなら文字列を組み立てるだけでよく(`'.' + 'claude'` —— この sweep 自身が
やっている)、何も見えない。そこを守る価値は無く、守れるふりをすることの方が穴。

**正直な限界(隠さず書く)** —— **全て保証 B の限界であり、保証 A は成立し続ける**
(= そのファイルは必ず宣言されており、人のレビューは通っている)。しかも下記は
想像ではなく、いずれも旧版に対して**実際に通されたもの**:

- **helper でリテラルを隠す形**: `const claudeHome = () => join(homedir(), '.claude')`
  を別の場所に置き、`writeFileSync(join(claudeHome(), …))` と書くと write の周囲に
  ディレクトリ名が無く、窓に何も映らない。
- **名前で呼べない変異**: FileHandle の `.write()`、`execFileSync('sh', …)` 経由の
  書き込み。名前の列挙では原理的に届かない。
  (ただし**シェル経由でも保証 A は立つ** —— `$HOME` / `~/` / `.claude` のどれかが
  文字列に出るので宣言義務は発生する。第2ラウンドでここを「A も破れる」と指摘され、
  `~/` を足して塞いだ。)
- **定数モジュールへの分割**: `export const CLAUDE_DIR_NAME = '.claude'` を別ファイルに
  置き、writer 側が `join(homedir(), CLAUDE_DIR_NAME, …)` と書くと、**どちらのファイルも
  2 シグナルを揃えない**ので保証 A ごと抜ける。DRY リファクタとして自然な形であり、
  ここは**塞げていない**。同一ファイル内の helper については保証 A は立つ。
- **意図的な沈黙**: 生 write のそばに `assertTestHomeIsolated` を置けば窓判定は
  クリアされる。それが**正しい書き方そのもの**なので、機械には fence とデコイの
  区別が付かない。ここは人が見る。
- `.openground` sweep は今も SWEPT_DIRS 限定(こちらは repo 全体)。広げるのは
  別変更 —— 広げた瞬間に `spike/` / `landing/` の sanction が必要になる。

**復旧層は別にある(2026-07-19・本章の管轄外だが対で読む)**: 本章が扱うのは
**予防**(壊させない)だけで、**復旧**(壊れても戻せる)は独立した層として main 側に
着地している。両方見ないと「どれだけ安全か」を誤る:

| 層 | 実体 | 効く場面 |
|---|---|---|
| 予防(本章) | fence / choke point / 静的ガード | テスト実行が実データへ到達するのを**止める** |
| 復旧 | `src/lib/server/homeBackup.ts` `snapshotBeforeWrite`(`store.ts:71` が書込み前に必ず呼ぶ) | `settings.json` / `canvas.json` の**世代バックアップ**(`~/.openground/backups/`) |
| 検知 | `src/lib/server/homeIntegrity.ts` `checkHomeIntegrity`(`server/index.ts:94` が起動時に実行) | 前回起動時との**縮み**を検知して通知(45→3 のような異常) |

つまり §1 の「`canvas.json` はバックアップが無く永久喪失」は**事故当時の話**で、
現在は同じ形の喪失なら `backups/` から戻せる。ただし**予防の代わりにはならない** —
バックアップは「壊れたことに気づいてから」しか効かず、気づかせるのが検知層、
そもそも壊させないのが本章の fence、という三段構え。
> 現在は `openGroundHome()` 経由。repo 全体を再走査し、`~/.openground` を独自に
> 組み立てる箇所が他に無いことを確認済み(§5 の検証コマンド 3b)。

---

## 4. teeth — ガードを外すと赤くなることの実測

> **緑のテスト ≠ 効いているガード。** 旧 setup-home はまさに「緑だが何も守っていない」
> 状態で 1 年生き延びた。だから新しいガードは**外したら赤くなることを実測**してある。

**手順**(再現可能。スクリプト: 各シナリオでファイルを patch → vitest 実行 → `git checkout` で復元 → `git status` が clean であることを確認):

| # | 壊した箇所 | 対象 | 結果 |
|---|---|---|---|
| baseline | (なし) | `testHomeGuard.test.ts` | **17 passed**(当時の件数。差し戻し対応後は 22 件 — §4.3 で再実測) |
| **A** | `assertTestHomeIsolated` を即 return(fence 撤去) | 同上 | **11 failed / 17** ✅ 赤くなる |
| **B** | `isTestProcess()` を常に false(検出破壊) | 同上 | **12 failed / 17** ✅ 赤くなる |
| **C** | setup-home の再検査を撤去 **+** 無条件 delete を復活 | `swarmNotifications` + `testHomeGuard` | **27 passed** ⚠️ 赤くならない(§4.1) |
| **D** | 無条件 delete のみ復活(再検査は生かす) | `swarmNotifications.test.ts` | **10 failed** ✅ 赤くなる・**犯人ファイル名を出力** |
| 復元後 | (なし) | `testHomeGuard.test.ts` | **17 passed**(当時・`git status` clean) |

D の出力(そのまま):

```
reason:  OPENGROUND_HOME is UNSET — every openGroundHome() call now resolves to the REAL ~/.openground
BLAME:   the test above left OPENGROUND_HOME unsafe. Restore the saved value in its afterEach ...
test file: .../src/lib/server/swarmNotifications.test.ts
```

### 4.0 `--no-isolate` での実測(2026-07-19)— fence が実際に穴を 1 つ捕まえた

事故原因 ③ は「封じ込めを vitest の `isolate:true` に依存している」だった。その
依存が外れた状態を実際に作るため、`npx vitest run --no-isolate`(全ファイルが 1
プロセスを共有)で実測した。

| 指標 | 実HOME(素の `npx vitest run --no-isolate`) | **隔離HOME**(契約が指定する回し方) |
|---|---|---|
| **実ホームへの書き込み** | **0 回** | **0 回** |
| `[testHomeGuard] REFUSING`(fence 発火) | 43 回(すべて拒否の記録・下記) | **0 回** |
| `TEST HOME ISOLATION BROKEN` | **0 回** | **0 回** |
| テスト結果 | 18 files / 84 failed | 17 files / 63 failed(`isolate:false` 固有・下記) |

**結論: `--no-isolate` でも隔離は破れない。** 実HOME で回したときの発火 43 回は
すべて「fence が実ホームへの到達を**止めた**」記録であって、破れた記録ではない。
`HOME=$(mktemp -d)` を付けるとその 43 回自体が消える — 到達先が最初から使い捨て
だからで、**fence は最後の砦であって pin の代わりではない**ことの実測でもある。

> **注意: `--no-isolate` の失敗集合は実行ごとに大きく入れ替わる**(2 回の計測で
> 新規 9 ファイル・解消 10 ファイル)。ファイル実行順でどのモジュール実体が勝つかが
> 変わるため。**個々のファイル名を「回帰」と読んではいけない** — この非対応モードで
> 意味があるのは fence 発火数と isolation 報告数(いずれも 0)だけ。

**3 回の実測が同じ結論を出している**(隔離HOME 列、いずれも `--no-isolate`):

| 時点 | テスト結果 | fence 発火 | `ISOLATION BROKEN` |
|---|---|---|---|
| 統合前(上表) | 17 files / 63 failed | **0** | **0** |
| M2 統合後 | 16 files / 70 failed | **0** | **0** |
| **条件 0 追加後(§4.6 の修正込み)** | 18 files / 58 failed | **0** | **0** |

失敗集合は毎回入れ替わる(注記のとおり)が、**意味のある 2 列は 3 回とも 0**。条件 0 を
足した回では `OPENGROUND_HOME is UNSET|BLANK` のメッセージも **0 件**で、`--no-isolate`
下でも pin を落とすファイルは実在しないことが確認できた。

**M2 統合後の内訳(2026-07-19・rebase 後の HEAD、隔離HOME)**: `16 files / 70 failed`、
**fence 発火 0 / `ISOLATION BROKEN` 0**。失敗 70 件の内訳は
`useT must be used within <I18nProvider>` 19・`Test timed out in 5000ms` 17・
env スタブ漏れ由来の `expected 503 to be 200` 系・`vi.fn()` 呼び出し回数 —
**すべて 1 プロセス共有によるモジュール/コンテキスト/タイマー状態の混線**で、
`OPENGROUND_HOME` / `HOME` 起因のメッセージは 1 件も出ていない(grep 実測 0 件)。

> **測定時の落とし穴(2026-07-19 に踏んだ)**: `npx vitest run --no-isolate > log 2>&1; echo $?`
> のように**末尾に別コマンドを繋ぐと、観測される終了コードはそちらのもの**になり、
> 70 件赤でも「exit 0」に見える。バックグラウンド実行の完了通知も同じ罠を踏む。
> **判定はログ本文の `Test Files` 行で行うこと** — 終了コードだけを信じない。

**`--pool=threads` は別物(2026-07-19 実測)**: `--no-isolate` は契約を保つが、
`--pool=threads` は**スイートが赤くなる**。`worker_threads` は `process.env` のビューを
共有するため、`HOME` を pin する 7 ファイルの隔離が効かず `os.homedir()` が実ホームを
返す。**fence がそれを見て発火するので方向は fail-closed** — 損害ではなく赤いスイートと
して出る。この repo は `--pool=threads` をサポートしないので、赤を見たら「fence の
バグ」ではなく「そのプールでは HOME pin が成立しない」と読むこと。

**mtime による end-to-end 実証(2026-07-19・最も強い証拠)**: fence 発火数を数えるのは
「fence がそう報告した」に過ぎない。**保護対象そのものが動いていないこと**を独立に測る:

```bash
# 2 モード(isolate / --no-isolate)でフルスイートを回した後に実行
stat -f '%Sm %N' -t '%Y-%m-%d %H:%M:%S' ~/.openground/settings.json ~/.openground/canvas.json
```

計測結果 — `npm test` 開始 20:54:07 / `--no-isolate` 開始 20:56:07 に対し、
`settings.json` = **20:10:19**、`canvas.json` = **11:43:18**。**どちらもテスト開始より前**で、
計 8858 テストを走らせても 1 バイトも書かれていない。fence の自己申告に依存しない、
外形からの裏取りとしてこの手順を使うこと。

**発火 43 回の内訳(最終)**: すべて `anchor: claudeTrust`。3 ファイルから:

| テストファイル | 発火 | なぜ `isolate:true` では起きないか |
|---|---|---|
| `swarmOverseerBrain.launch.test.ts` | 21 | `vi.mock('./claudeTerminal')` で real `launchClaude` を差し替えている |
| `canvasAiPreflight.test.ts` | 10 | 同上 |
| `generateSkill.test.ts` | 6 | 同上 |

3 本とも**隔離の手段が「実ホームを触るモジュールを mock する」**という設計。
`--no-isolate` はモジュール識別子を共有させるので mock が当たらなくなり、real
`launchClaude → ensureClaudeFolderTrusted` が走って実 `~/.claude.json` に到達する。
そこで fence が止めた。

> **判断(意図的なスコープ)**: この 3 本に `CLAUDE_CONFIG_PATH` の pin は**足していない**。
> ①`isolate:true`(CI とローカルの既定・実運用モード)ではこの経路に到達しない、
> ②`--no-isolate` ではこの 3 本はどのみち mock 不発で落ちる、
> ③**構造的な保護は fence が既に提供しており、pin は二重の帯**だから。
> 将来スイートが `--no-isolate` を採用するなら、この 3 本が最初の作業対象。
> ここに列挙してあるのは、その時に探し直さないため。

**修正前の 10 回が捕まえたもの(実害・対処済み)**: 10 回すべてが
`anchor: hooksInstall (homedir-anchored)` / `resolved home: <実HOME>` /
`offending test: server/routes/__tests__/swarmTwinDispatch.test.ts`。
このテストは `OPENGROUND_HOME` を pin する一方 **`HOME` を実物のまま**にしており、
dispatch ルートが worker spawn → `ensureGuardWiring` → `hooksInstall` に到達する。
`isolate:true` では spawn hook が効いてこの経路に入らないため**完全に不可視の潜在穴**
だった。fence が無ければ、この route テストは**ユーザーの実 `~/.claude/settings.json`
と `~/.openground/{hooks,guard}` を書いていた**。対処は fence を緩めるのではなく
テスト側の hermetic 化(`HOME` も tmpdir へ pin)。→ 発火 0 へ。

**残る failures(84)の大半は fence 起因ではない**。エラー内訳は
`expected "vi.fn()" to be called 1 times, but got 0 times`(12)、
`Cannot read properties of undefined`(10)、Windows パス期待値の不一致 …
= `vi.mock` とモジュール識別子が共有レジストリで一致しなくなる、`isolate:false` の
古典的症状。**このスイートは元々 `--no-isolate` を想定していない**(`globalThis` 常駐
状態 — terminal プール / swarm エンジン / 各種キャッシュ — が全ファイルで混ざる)。
参考: fence を繋ぐ前の `--no-isolate` は 16 files / 54 failed だったので、fence は
この非対応モードで約 2 ファイル分の失敗を**増やしている**。増えた分は
「黙って実ホームを触っていた」が「大声で落ちる」に変わったもの — 望ましい交換。

> **⛔ 旧コードでの `--no-isolate` ベースラインは取っていない — 取ってはいけない。**
> 旧コード(トートロジー + 無条件 delete 4 箇所)を `--no-isolate` で走らせることは、
> **2026-07-18 の事故を意図的に再現する**行為に等しい(delete が次のファイルへ直撃し、
> 本番ホームへ書きにいく)。「before/after を比較できない」ことそれ自体が、
> チケットの指摘した危険性の証拠。

### 4.1 シナリオ C が赤くならない理由 — 2 層の役割分担

C は**失敗ではなく測定結果**で、この機構の性質を正確に示している。

`isolate:true`(既定)ではテストファイルごとに fork が分かれる。最後の `afterEach` で
env を消しても、**その後にホームを解決する者が誰もいなければ** fence は発火しない —
つまり `delete` は「潜在的な地雷」であって、それ自体は fence の検知対象ではない。

- **fence(paths.ts)** は「**壊れた状態でホームを解決しようとした瞬間**」を止める
  → 実害(書き込み)を防ぐ担当。
- **setup-home の再検査** は「**壊れた状態にして立ち去ったこと**」自体を検知する
  → 地雷を埋めた犯人を特定する担当(D で実証)。

この 2 つは**別のものを見ている**。片方だけでは 2026-07-18 は再発しうる
(`--no-isolate` では地雷が次のファイルに直撃する)。

---

### 4.2 敵対レビューで見つかった「armed のまま素通しする」3 経路

teeth 実測(§4)を通ったあと、**外部の敵対レビュアーに「この fence は効いていない。
反証せよ」と指示して攻撃させた**。テストは全部緑のまま、以下が見つかった。
つまり**§4 の teeth ですら十分ではなかった** — 回帰テストは「壊したら気づく」を
保証するが、「そもそも回避経路が無い」ことは保証しない。

| # | 穴 | なぜ効かなかったか | 対処 |
|---|---|---|---|
| **1** | **`TMPDIR=$HOME` で fence が全面無効化** | `tempRoots()` が `TMPDIR`/`TMP`/`TEMP` を無検査で信用 → 「`~/.openground` は temp root 配下」が真 → 実ホームを素通し。**「opt-out env は用意しない」と書いた fence における、`TMPDIR` という名の opt-out** | ⚠️ **当初「実ホームを内包する候補 root は破棄」としたが、これは誤り**(隔離 HOME で fence が全面無効化した)。現在は §4.3 の三条件 |
| **2** | **memo が symlink すり替えを不可視化** | pass を `(anchor, home)` でキャッシュし「tmp 配下に正規化される値が実ホームへ drift することはない」と根拠を明記していた。**正規化はファイルシステム問合せなので可変** — 未作成 tmp パスを pin(仕様として許容)→後からそこに実ホームへの symlink を作ると、cache 済み pass が書き込みを通す | memo 全廃 + 「temp 配下 **かつ** 実 `~/.openground` 配下でない」の二条件必須 |
| **3** | `ensureOpenGroundHome()` が reject 済み promise を永久キャッシュ | `??=` は失敗も覚える。一度 fence が発火すると、env を直したあとも同プロセスの全 store 読み書きが古いエラーで詰む | rejection で evict(`registry.ts:39-42` が既に持っていた型) |

**新規 teeth**(それぞれ修正を revert すると**該当ケースだけ**が赤くなることを実測):

| 壊した箇所 | 赤くなったケース |
|---|---|
| E. TMPDIR フィルタ撤去 | *"a TMPDIR that swallows the real home does NOT make the real home pass"* のみ |
| F. memo 復活 | *"re-validates every call — a path that PASSED can turn unsafe underneath it"* のみ |

**教訓**: 「ガードを書いた」「teeth も測った」の次に、**「回避経路を探させた」**が要る。
2 の根拠コメントは**自信を持って書かれた誤り**で、レビュアーがいなければ残っていた。

### 4.3 差し戻し 1 回目(2026-07-19)— 契約文が実装より強かった

司令官のレビューで**契約文と実装の不一致**が 2 件見つかり差し戻された。fence 自体は
本物(司令官が独自にミューテーションを入れて teeth を再実測・本番アプリ不変も確認)
だったが、**「単一 choke point」「reads も塞ぐ」という文が事実でなかった**。

| # | 指摘 | 実体 | 対処 |
|---|---|---|---|
| **must-fix 1** | choke point を通らない**第 2 の解決式** | `swarmTokenAudit.ts:559`。fence 有効のまま実 `~/.openground/settings.json` を読み、実登録パスを返した(実測) | `openGroundHome()` 経由へ。全 repo 再走査で他に無いことを確認 |
| **must-fix 2** | choke point ファイル**自身の中**の未 fence アンカー | `paths.ts` の legacy 移行 `rename(homedir()/.hove → fresh)`。fence は宛先しか見ておらず、tmp home 未作成のテストで**実 `~/.hove` を tmpdir へ移動→afterEach が再帰削除** | `exists` 分岐内で legacy 側にも fence。回帰テスト追加 |

**自己修正**: 敵対レビュー finding 5(TMPDIR)への当初の対処が**誤りだった**。
「実 HOME を内包する temp root を破棄」という実装は、`HOME=$(mktemp -d)` では
**全 temp root が HOME を内包する**ため root が全滅し、**fence を全面無効化**していた。
司令官指定の隔離実行(`OPENGROUND_HOME=$(mktemp -d) HOME=$(mktemp -d)`)で即座に発覚。
条件を 3 つに再定式化した(`assertTestHomeIsolated` の実装コメント参照):
①temp root 配下 ②実 `~/.openground` そのものでない ③実 HOME 配下でない
(**HOME 自体が使い捨てのときは③を無効化** — これが隔離実行と両立させる鍵)。

**teeth 再実測(隔離 HOME・baseline 22 件)**:

| 外した箇所 | 赤くなった件数 |
|---|---|
| A. fence 撤去 | 15 |
| B. 検出破壊 | 16 |
| E2. TMPDIR 防御(条件②③)撤去 | 8 |
| F2. memo 復活 | **1**(再検証ケースのみ) |
| G. legacy 移行の fence 撤去 | **1**(must-fix 2 の回帰のみ) |
| H. choke point の `vi.mock` 復活 | **1**(メタテストのみ) |

F2 / G / H が**ちょうど 1 件ずつ**赤くなるのは、各回帰が狙った 1 点だけを見ている証拠。

**教訓**: 「守る側と書く側が別の env を見る」非対称は**1 回の監査では出し切れない**。
5 アンカー監査を通した後にさらに 2 件出ており、しかも 1 件は fence を設置した
ファイル自身の中にあった。そして**防御を足すこと自体が新しい穴になりうる**
(TMPDIR 対処が隔離 HOME を壊した)— 契約の指定する実行方法で必ず回すこと。

### 4.4 自己言及の罠 — ルールを説明する散文がルール違反として検出される

本カードで**5 回**踏んだ。いずれも同一構造なので、この種の検査を足す/触るときは
最初から想定すること。

**踏んだ検査の正体**: `repoPiiGuard.test.ts` の `HOME_PATH_ENCODED`
(`/-(?:Users|home)-([A-Za-z0-9_][A-Za-z0-9_.]*)/`)。`~/.claude` のセッションキー
符号化形(`-Users-<name>-…`)から実ユーザー名の漏出を拾うためのもので、
**`-home-` の直後に英数が続く綴りはすべてヒットする**。以下この表では、
その並びを作らないよう `-home-{…}` と中括弧で分割して引用する。

| # | 何が検出されたか | 直し方 |
|---|---|---|
| 1 | 章ファイル名(旧 `07-test-home-{safety}.md`)を実ユーザー名の漏出と判定 | ファイル名を `07-test-isolation-contract.md` へ。エラータグも `[testHomeGuard]` へ |
| 2 | mock 禁止メタテストが、**自分の正規表現リテラルと自分の説明コメント**にヒット | 正規表現を文字列から構築 + コメント行を除外 |
| 3 | §5 の検証 grep(第 2 の解決式の検出)が、修正前の式を引用した**自分のコメント**にヒット | コメントの文言を変更(検証が「0 件で健全」と読めるように) |
| 4 | 3 の書き換えで `…then-home-{dir}` という並びを作り、再び PII guard にヒット | `OPENGROUND_HOME → homedir()` 表記へ |
| **5** | **この表そのもの** — 1 と 4 を**そのままの綴りで引用**して 2 件検出(司令官の再検証で判明) | 引用を `-home-{…}` 形へ分割(本注記) |

**一般則**: リポジトリ全体を走査する検査(PII / 禁止パターン / メタテスト)を書いたら、
**その検査を説明する文章自身が検査に掛かる**と考えてよい。対策は
(a) パターンをリテラルで書かず組み立てる (b) コメント行を除外する
(c) 説明文でパターンをそのまま引用しない(引用が必要なら分割する)、のいずれか。

**5 が示すもの**: 罠を戒める文章を書いている最中でも踏む。教訓を書いた時点で
免疫ができたと思わないこと。4 は「隔離フルランが緑になった**後**の 1 行修正」で、
5 は「その 4 を記録する追記」で混入した — いずれも**緑を見た後の編集**。
**docs だけの追記でも、コミットする状態でテストを回し直す**(§6 の掟 4b)。

---

### 4.5 M2 統合後の teeth 再実測(2026-07-19)— 事故そのものの再現に成功

統合(§2.1.1)で fence の実装が変わったので、**外したら赤くなるか**を測り直した。
対象は `testHomeGuard.test.ts`(22 件)+ `testHomeEnvGuard.test.ts`(5 件)= 27 件。

| # | 壊した箇所 | 対象 | 結果 |
|---|---|---|---|
| baseline | (なし) | 両ファイル | **27 passed** |
| **A** | `paths.ts` の fence 呼び出しをコメントアウト | 両ファイル | **9 failed** ✅ |
| **B** | `isTestProcess()` を常に false(検出破壊) | 両ファイル | **18 failed** ✅ |
| **C** | 静的ガードの除外から `testHomeGuard.test.ts` を削除 | `testHomeEnvGuard` | **1 failed**(7 行検出)✅ |
| **D** | fence を **M2 相当**(未設定のときだけ throw)へ差し替え | `testHomeEnvGuard -t "SET but…"` | **1 failed** ✅ |
| 復元後 | (なし) | 両ファイル | **27 passed**・`git status` clean |

**A は「赤くなった」だけではない — 事故そのものを再現した。** fence を外した状態で
スイートを回すと、settings.json に `archiveDirName: "_arc"` /
`projectsMigratedAt: "2026-01-02T03:04:05.000Z"` / **`projects: []`** が実際に書かれた
— 2026-07-18 の鑑識署名と完全一致。`HOME` を隔離していたから実データに届かなかった
だけで、**fence が `npm test` とユーザーのレジストリの間に立つ唯一のもの**であることの
直接証拠(「assertion が fence に言及している」という間接証拠ではない)。B でも
`installHooks() writes NOTHING` が `assertNeverCreated` で落ちた = 実ファイルが作られた。

**D が最も鋭い判別**: M2 相当のシムに差し替えると、**未設定のケースは緑のまま**
「設定済みだが実ホームを指す」ケースだけが赤くなる。つまり **M2 単独なら緑に見えたまま
第 2 の failure mode を開けて出荷していた**。統合後の fence は両半分とも load-bearing。

> **計測手順そのものの落とし穴(2026-07-19 に踏んだ)**: この計測はファイルを一時的に
> 壊す。その最中に**別プロセスが `git add -A` すると、壊れた状態がコミットされる** —
> 実際に「docs」と題した 2 コミットが `isTestProcess → false` を抱え込み、約 1 分間
> **HEAD で fence が死んでいた**(次のコミットで相殺され最終ツリーは無事、履歴は
> 作り直し済み)。**サブエージェントが同じ worktree で検証している間は `git add -A`
> を使わず、パスを明示してステージすること。** 計測側も mutate→test→restore を
> 1 コマンドに畳むと露出窓が縮む。

### 4.6 敵対レビュー第2ラウンド(2026-07-19)— 統合そのものが穴を開けていた

§4.5 の teeth は「fence を外すと赤くなる」を示したが、**fence 自体の論理の誤りは
teeth では出ない**(teeth は現在の実装を前提に組むため)。別レビュアーに
「統合の主張を反証せよ」と依頼して出た 4 件:

| # | 指摘 | 実体 | 対処 |
|---|---|---|---|
| 1 | **包含は不成立** | `$HOME` 再 pin 窓で未設定が素通り(上の ⚠️ ブロック) | 条件 0 を別立てで復活・teeth 3 件追加 |
| 2 | 静的ガードが **fail-OPEN** | `testHomeEnvGuard` の `catch { return [] }`。grep は「一致なし」で exit 1 だが**掃引先の改名/削除では exit 2**。どちらも `[]` に潰れ、走査していないのに緑 | exit 1 以外は throw |
| 3 | mock 禁止の正規表現に 4 穴 | `vi.doMock`(実 API は camelCase で `(?:do)?mock` は**死にコード**。しかも非巻き上げ版=この repo の動的 import 形と噛み合う)/ 拡張子付き / `vi.mock(import(…))` / 複数行 | パターン修正 + **パターン自体の検証 11 件** |
| 4 | fence と setup-home の**述語が食い違い** | setup-home は条件 3 を持たず、`TMPDIR=$HOME/tmp` の環境で「安全」と判定 → fence は全拒否 → 原因不明の数千件赤 | `testHomeProblem` に一本化 |

**#2 と #4 は、この章が説明している失敗の型そのものを、この章の実装が踏んでいた** —
#2 は「寛容リーダーが fail-closed を無効化する」、#4 は「2 アンカー 2 述語のズレ」
(2026-07-14)。**自分が書いた警告は自分には効かない**ので、他者に反証させる工程を省かない。

> **teeth と敵対レビューは別物**という教訓。teeth は「守っているつもりのものを本当に
> 守っているか」を測る。**「守るべきものを取り違えていないか」は teeth では出ない** —
> それは仮説の反証であって、実装を壊す実験では届かない。両方やること。

### 4.7 第3ラウンド(2026-07-19)— **修正そのもの**を反証させた

第2ラウンドの修正は新しいコードなので、それ自体を反証させた。**6 件出た**(=
「レビューで直した」は「もう安全」ではない)。

| # | 指摘 | 実体 | 対処 |
|---|---|---|---|
| **F1** | **fail-OPEN 修正が macOS で無効** | BSD grep は `--include` 付きだと**欠損ディレクトリを黙って飛ばす**(exit 0・stderr なし。単独指定なら exit 1 = 旧コードが「全走査して違反ゼロ」と解釈)。GNU/ugrep は exit 2 を返す | grep の終了コード依存をやめ **`existsSync` 事前チェック**へ |
| F2 | 正規表現が実在形を取りこぼし | `vitest.mock(…)`(`vitest` は実在の別名・`vitest === vi`)と空白変種 `vi.mock (` / `vi . mock(` | **vitest 自身の hoister 正規表現**に形を合わせた |
| F3 | sweep が最重要地点を見ていない | `*.test.ts` のみ走査 → `setupFiles` と `src/test/` 共有ヘルパーが不可視。そこに 1 行置けば**スイート全体で** fence が無効化されるのに、個々のテストは綺麗なまま。`git ls-files` も未追跡ファイルを落とす | ハーネスを走査対象へ + `--others --exclude-standard` |
| F4 | unset の別綴りが素通り | `vi.stubEnv(<home var>, undefined)` は vitest 実装が `delete` する | パターンとテストを追加 |
| F5 | 修復より先に例外が出る | `canonicalizePath('')` は cwd を解決 → cwd 削除済みなら ENOENT を投げ、`setup-home` の**修復行より前に**脱出 | 条件 0 の後へ移動 |
| F7 | 本番バンドルに無ゲートで露出 | `testHomeProblem` が `isTestProcess()` チェック無しで export | 冒頭でゲート |

> **F1 が示した最悪の形**: 「ガードを足した」つもりが、**データが存在する環境でだけ効かない**。
> Linux CI(GNU grep)では throw し、開発機(BSD grep)では沈黙する — つまり
> **守る必要が無い方を守り、守るべき方を守っていなかった**。しかも緑なので気づけない。
> 教訓: **外部コマンドの終了コードを安全判定の根拠にしない**(実装差で意味が変わる)。
> 判定に必要な事実は自分で確かめる(ここでは「掃引先が存在するか」を `existsSync` で)。

### 4.8 第4ラウンド(2026-07-19)— **fence を丸ごと無効化できる経路**が実証された

差し戻し1件。これまでで最も重い指摘で、**実データへの書き込みが end-to-end で再現**された。

**穴**: 条件 3 を抑止する `REAL_HOME_IS_TEMPORARY` が `isUnderTempRoot(REAL_HOMEDIR)`
= **防御対象と同じ env(TMPDIR)から導かれていた**。`TMPDIR=$HOME` にすると実 home が
「temp 配下」と判定され、**プロセス全体で条件 3 が恒久沈黙**する。残るのは条件 2
(`~/.openground` の identity)だけで、`~/.claude` 系アンカーを一切カバーしない。

```
TMPDIR=$HOME npx vitest run  で実測(レビュアー)
  hooksInstall   拒否: true → false   → 実 <HOME>/.claude/settings.json が作成された
  claudeTrust    拒否: true → false   → 実 ~/.claude.json(OAuth)を read-modify-write 可能
  ogManageSkill  拒否: true → false
```

**修正**: 判定を `tempRoots()` から切り離し、**ハードコードした信頼済み temp 接頭辞の
「厳密な子孫」**であることを要求する(`/tmp` `/private/tmp` `/var/tmp`
`/private/var/tmp` `/var/folders` `/private/var/folders`)。

| 入力 | 旧 | 新 |
|---|---|---|
| `TMPDIR=$HOME` | true(条件3沈黙) | **false**(root===home で厳密子孫でない)|
| `TMPDIR=/` / `TMPDIR=/Users` | true | **false**(信頼済み接頭辞でない)|
| `HOME=$(mktemp -d)` | true | **true 維持**(5258a1e の退行なし)|

> **⚠️ この表は 2026-07-20 まで不完全だった(§4.9)。** 上の判定は「**どの home に
> ついての判定か**」を書いていない。`HOME` を隔離すると `homedir()` 由来の baseline が
> **偽 home へ移る**ため、`TMPDIR=<実ホーム>` と組み合わせると実 `~/.openground` が
> 素通りしていた — **契約 §5 が必須と指定している実行方法そのもの**で。現在は
> **passwd 由来の home**(`userInfo()`・`$HOME` に免疫)と**プロセスの実効 home**を
> 分離し、条件3を両方に対して評価する。上表は「実効 home についての判定」を指す。

**teeth は子プロセスで測る**(`__fixtures__/tempRootPoisonProbe.ts`)。起動時汚染は
`vi.stubEnv` では**原理的に再現できない** — `REAL_HOME_IS_TEMPORARY` は import 時に
確定済みなので、stub を置いても条件 3 は生きたまま緑になる。実際、既存の
*"a TMPDIR that swallows the real home…"* はこの理由で**空振りしており、穴を塞いだと
主張しながら1日隠していた**。実測: 修正あり 42/42 緑 → 判定を旧実装に戻すと
**汚染 2 ケースがちょうど赤**、隔離 HOME の退行確認ケースは両方で緑。

> **この穴を隠していたのは虚偽のコメント**だった。`tempRoots()` の docstring は
> 「実 home を含む候補は捨てる」と宣言していたが、その discard は **5258a1e で撤去
> 済み**で現物に存在しなかった。読む人は「TMPDIR 汚染は対処済み」と信じる。
> **安全機構の根拠コメントが「実装されていない防御」を語っている状態は、防御が無い
> ことより悪い** — 無ければ疑うが、有ると書いてあれば疑わない。コードを消すときは
> その根拠コメントも同じコミットで消すこと。

### 4.9 第5ラウンド(2026-07-20)— **契約が指定する実行方法が、契約の穴だった**

差し戻し 2 件。1 件目はこの章で最も皮肉な形をしている。

**MF1 — 隔離 HOME + TMPDIR 汚染で実ホームが素通り**

```
HOME=$(mktemp -d) TMPDIR=<実ホーム> npx vitest run
  → testHomeProblem('<実ホーム>/.openground') === null     ← 通してしまう
```

機序: `homedir()` は `$HOME` を読むので、**`$HOME` を隔離した瞬間に「実ホーム」の
基準点が偽 home へ移る**。結果、条件 2 は実 `~/.openground` を知らず(偽 home 配下と
比較している)、条件 3 は「実 home は throwaway」と正しく判定して沈黙する。残るのは
env 由来の条件 1 だけ — **`REAL_HOME_IS_TEMPORARY` を導入した目的そのもの(env 由来の
判定に依存しない)が消えていた**。

> **なぜ nit ではないか**: §5 は「テストは必ず `HOME` ごと隔離して回す」を**必須**と
> 指定している。つまり**契約が指定する実行方法が、契約が塞いだと主張する穴を開け直して
> いた**。§4.8 で「実装されていない防御を語るコメントは、防御が無いことより悪い」と
> 書いた当の章が、同じ形を表の中で再演したことになる。

**修正**: home を 2 つに分ける。

| | 由来 | 何のための値か | `HOME=$(mktemp -d)` のとき |
|---|---|---|---|
| **passwd home** | `userInfo().homedir` — **`$HOME` に免疫**(実測確認) | **守る対象**。条件 2 の identity と条件 3 の一方 | 実ホームのまま |
| **実効 home** | `homedir()` | このプロセスの `homedir()` アンカーが**実際に着地する**先 | 使い捨て dir |

条件 3 は**両方に対して**評価し、抑止は「**その home 自身が throwaway のときだけ**」。
隔離ランナーは自分のスクラッチ home 配下に書けるまま(5258a1e 退行なし)、ユーザーの
実 home は拒否される。

**MF2 — sweep が `.js` を見ていなかった**: 「resolver は 1 つ」の repo sweep が
pathspec `*.ts`/`*.tsx` のみで、**`SWEPT_DIRS` に `electron`/`scripts` を入れておきながら
拡張子で落としていた**。`.js`/`.cjs`/`.mjs` を足すと 4 件検出(`lockdown.js` 34 /
`swarm-lock.js` 54 / `openground-hook.js` 48・70)。いずれも TS モジュールグラフ外で
動く素の JS で**構造的に choke point を通れない**ため理由付きで sanctioned にしたが、
`.js` を掃引対象に残すこと自体が目的 — 新規コピーは捕まる。

> **teeth が一度「間違った理由で緑」になった(記録)**: MF1 の teeth は、親テストが
> ゲートによって `$HOME` を隔離された状態で走るため `homedir()` が**ゲートの使い捨て
> home** を返し、汚染値が実ホームになっていなかった。結果、実ホームは「temp root の
> 外」として条件 1 に弾かれ、**修正を戻しても緑のまま**だった。親側も `userInfo()` 由来に
> 直して再実測 → `expected 'ALLOWED' to be 'REFUSED'` で該当ケースがちょうど赤。
> **teeth を書いたら必ず「修正を戻すと赤くなるか」を測る** — 緑は何の証拠でもない。

### 4.10 第6ラウンド(2026-07-20)— **§4.9 の修正が、§4.9 の teeth を殺した**

§4.9 の MF1 修正(baseline を passwd 由来へ)は正しい。その修正が、**同じ章の teeth を
1 件だけ成立不能にした**。

```
OPENGROUND_HOME=$(mktemp -d) HOME=$(mktemp -d) \
  npx vitest run src/lib/server/testHomeGuard.test.ts src/testHomeEnvGuard.test.ts
  → × 「事故そのもの > 実 ~/.openground へ黙って解決せず THROW する」
```

**機序**: 期待値 `productionHome()` は passwd 由来になり **`$HOME` に免疫**。一方 fence
メッセージが印字する `resolved home:` は**今も `$HOME` 由来**。`$HOME` を隔離した瞬間に
両者は別パスになり、`toThrow(new RegExp(escapeForRegex(productionHome())))` という
**素のパス一致**が何にもマッチしなくなる。実 HOME では両者が一致するので緑 —
**モード依存の赤**。

> **なぜ nit ではないか**: §5 と §6-4b は「緑の申告は隔離 HOME で回した結果に限る」を
> **明文で必須**にしている。つまり**契約が命じる回し方をすると、契約の teeth が赤い**。
> 次の司令官/worker は必ずここで止まる。§4.8 →§4.9 に続き、この形は**3 回目**。
>
> ※ **fence 自体は正しく throw しており、実ホームは守られていた**。壊れていたのは
> 防御ではなく**検証手順の成立性**。ここを混同して「安全性の穴」と報告しないこと。

**素のパス一致は逆方向にも壊れていた(偽緑・同一コミット)**。fence メッセージには
`offending test:` 行があり、テストファイルの絶対パスが入る。swarm worker の worktree は
`~/.openground/projects/<uuid>/worktrees/<branch>/` — **`productionHome()` が指すディレクトリ
そのものの中**にあるため、この行が期待文字列を verbatim に含み、**fence が何を言おうと
正規表現を満たす**。

| 実行場所 | `$HOME` | 結果 | 理由 |
|---|---|---|---|
| primary checkout | 実 HOME | 緑 | `resolved home:` が実 `~/.openground` — **本来の意図どおり** |
| primary checkout | 隔離 | **赤** | 期待文字列がメッセージのどこにも無い(上記の機序)|
| worktree(`~/.openground` 配下)| 隔離 | 緑 | `offending test:` 行の**偶然の一致** — 何も証明していない |

**修正**: fence メッセージに **`protected home:` 行**(passwd 由来 = 守る対象そのもの)を
1 本足し、テストは**「ラベル + パス」で pin** する:

```ts
expect(() => openGroundHome()).toThrow(
  new RegExp(`protected home:\\s+${escapeForRegex(productionHome())}`),
)
```

- 両モードで成立する — `$HOME` に依存しない行を見ているから。
- **場所依存の偽緑が死ぬ** — `offending test:` にラベルは付かないので満たせない。
- 診断価値が上がる — メッセージは従来、**関係するパスを全部印字しながら「守っている
  対象」だけ書いていなかった**。実効 home(`HOME:` 行)の隣に並ぶので、隔離時に
  両者が食い違っていること自体が目で見える。

**teeth 実測(2026-07-20)**:

| # | 状態 | 実行場所 / `$HOME` | 結果 |
|---|---|---|---|
| baseline | 修正あり | worktree・隔離 | **53 passed**(2 files。2026-07-20 rebase 後の再実測 — NODE_ENV teeth 追加(208bf6b6)前の当初計測は 52 だった)|
| baseline | 修正あり | `~/.openground` 外・隔離 | 当該 1 件 **緑**(修正前は赤)|
| **A** | `protected home:` 行を削除 | worktree・隔離 | 当該 1 件が**ちょうど赤** ✅ |
| **B** | `protected home:` 行を削除 | worktree・実 HOME | 当該 1 件が**ちょうど赤** ✅ |

A が重要 — **旧アサーションが偽緑だった場所で赤くなる**ことが、場所依存を潰せた証拠。

> **教訓(§4.8 の系)**: 「安全機構の**根拠コメント**が嘘」は §4.8 で潰した。今回は
> 「安全機構の **teeth が、証明したい事実ではなく偶然の文字列一致で緑になっていた**」。
> どちらも**緑の理由を問わなかった**ことが原因。**アサーションは「何にマッチしたか」まで
> 特定できる形に書く** — 素の全文検索は、メッセージに無関係な長いパスが 1 本でも
> 混ざった瞬間に意味を失う。

### 4.11 第7ラウンド(2026-07-20)— **teeth 自身が repo を汚し、統合を止めうる状態だった**

指摘の本体は防御の穴ではない。**teeth の副作用**である。「実在するが temp ではない
home」を作る case が、repo ワーキングツリー直下に `og-fence-outside-*` を mkdtemp して
いた。一方 `.gitignore` が持つのは `/.og-fence-probe-*` の 1 行だけ。

```
git check-ignore og-fence-outside-abc123 → exit 1(無視されない)
git check-ignore .og-fence-probe-abc     → exit 0(無視される)
```

**なぜ nit ではないか**: この repo では **dirty ツリーは swarm 統合を止める**(worker は
ready 前に commit する契約)。さらに 2026-07-19 には、並行サブエージェントの一時改変を
`git add -A` が巻き込み、安全装置が約 1 分 HEAD 上で無効化された実事故がある。worker が
`npm test` を回している最中に司令官が `git status` / `git add -A` を打つと、**偽の dirty
判定**か**ゴミの誤コミット**になる。finally で消えるが、テスト失敗や kill では残る。

**取りこぼしの向きは、時系列で見ると直感と逆**(実測):

| 時刻 | commit | 出来事 |
|---|---|---|
| 07-19 12:07 | `5d227df9` | `og-fence-outside-` を導入(**古い方**)|
| 07-19 23:07 | `62b71c0b` | `.og-fence-probe-` を導入(**新しい方**)|
| 07-20 00:25 | `8081eb91` | `.gitignore` に `/.og-fence-probe-*` を追加 — **新しい方だけ** |

つまり gitignore 行を足した人は、**直前に自分が書いた実例 1 件だけを覆い、11 時間前から
repo を汚していた古い方を遡って覆わなかった**。しかもその行のコメントは「killed run を
カバーする」と**意図まで正しく言語化している** — 欠けていたのは理解ではなく**適用範囲**。

**副次的な脆さ**: 作成先が `process.cwd()` 由来だった。同スイートには `process.chdir()`
する file があり(swarmSafety / hooksInstall)、`--no-isolate` や afterEach 失敗で cwd が
別所に残ると、削除済み tmp に mkdtemp して ENOENT で落ちる。§5-2 が `--no-isolate` を
必須にしている以上、これも**契約が命じる回し方と衝突する**形(§4.9 の系)。

**修正**: repo 直下に dir を作る 2 箇所を module 定数 `REPO_ROOT` / `REPO_PROBE_PREFIX`
に寄せ、prefix を既存の gitignore 行に合わせた。**分岐していたから漏れた**ので、単一
定義にすることが修正の本体。加えて `.gitignore` との結合はテスト側から見えない —
これが漏れた理由そのもの — ので、`git check-ignore` で prefix が無視されることを
**1 件 pin** した。

> ⚠️ **この teeth は不十分だった**(§4.12 で実測・是正)。pin できたのは *const の値*
> であって *repo 直下に作るという行為* ではない。新しい probe が独自 prefix を持って
> 入る形 — つまり上の時系列で実際に起きた形 — は素通りする。

**teeth 実測(2026-07-20)**:

| # | 状態 | 結果 |
|---|---|---|
| baseline | 修正あり | **47 passed**(当該 file)|
| **A** | prefix を `og-fence-outside-` に改名 | 当該 1 件が**ちょうど赤** ✅ |
| **B** | `.gitignore` の `/.og-fence-probe-*` 行を削除 | 当該 1 件が**ちょうど赤** ✅ |
| 復元 | 両変異とも revert | 緑・tree は HEAD と完全一致 |

**残骸の実測**(kill された run の再現 — これが守りたい性質そのもの):

```
mkdir -p .og-fence-probe-killedrun/home
git status --porcelain             → 0 行(tree は clean のまま)
git status --porcelain --ignored   → !! .og-fence-probe-killedrun/
git check-ignore -v                → .gitignore:101:/.og-fence-probe-*
```

**クラス全体の掃引(2026-07-20・読み取り専用の並行監査)**: 教訓 (2) を今回はその場で
実行した。結果、**repo ワーキングツリーへ書き込むテストはこの file の 2 箇所だけ**で、
他には無い(当時 `:306` / `:424`・どちらも `.og-fence-probe-` 統一済み・実測 IGNORED)。
> 行番号は §4.13 の修正と main への rebase で動いた。**実測 2026-07-21 時点の 2 箇所**は
> `testHomeGuard.test.ts:407`(元からある probe)と `testHomeEnvGuard.test.ts:631`
> (§4.13 で追加した残骸検出 teeth 自身の probe)。掃引当時の 2 箇所のうち片方
> (TMPDIR 毒盛の fake home)は「そもそも何も作らない」形に変わった(§4.13 の MF2)ので、
> **内訳が入れ替わっただけで数は 2 のまま**。どちらも `.og-fence-probe-` 統一済み。

> **網の張り方を間違えると「該当なし」が嘘になる**。最初 `process.cwd()` だけを grep して
> 「他になし」を得たが、これは**見落としによる偽の該当なし**だった — 現行の 2 箇所は
> `process.cwd()` ではなく `REPO_ROOT`(= `import.meta.url` 起点。宣言は
> `src/test/repoRootFence.ts` の `export const REPO_ROOT` — 実測 2026-07-21 で `:82`)由来なので、その
> grep は**たった今自分が書いたコードすら拾わない**。成立する網は 4 系統:
> ① `process.cwd()` / `import.meta.url` / `__dirname` の 3 つ全部
> ② 「書き込み呼び出しがあるのに tmpdir に一言も触れない file」の機械抽出(0 件)
> ③ 文字列リテラルの相対パス書き込み(0 件)
> ④ `git init` / `git clone` の cwd(全て tmpdir 由来)

**潰した誤検知 2 件**(同じ掃引をする次の人が同じ道を辿らないように):

- `dist-web` / `.openground` が NOT IGNORED に見える → `git check-ignore` の
  **ディレクトリ限定パターン(末尾スラッシュ)の仕様**。`dist-web/index.html` のように
  内側のパスで測り直すと IGNORED。**穴ではない**。
- `perf/test-results` は NOT IGNORED だが **そもそも生成されない** → playwright の
  outputDir は configDir から上方向に package.json を探すため、`perf/` に package.json が
  無い以上 repo ルートの `/test-results`(IGNORED)へ解決される。reporter も list/github で
  HTML 不使用のため `playwright-report/` も出ない。

> **教訓 (1)**: §4.10 は「teeth が偶然の文字列一致で緑」だった。今回は **teeth が正しく
> 緑になりながら、副作用で統合を止めうる**。安全機構を足すときは「何を証明するか」だけ
> でなく **「回した後に何が残るか」**まで見る。この repo では *repo が汚れないこと自体*が
> swarm の稼働条件であり、テストの後始末は行儀ではなく契約。
>
> **教訓 (2)**: 上の時系列が示すのは、**気づいた人が「クラス」ではなく「たった今自分が
> 作った実例」だけを塞いだ**という形。`.gitignore` に 1 行足すその場で「同じ性質のものが
> 他に無いか」を一度 grep していれば、11 時間前の 1 件は同じコミットで死んでいた。
> **対症の 1 行と、単一定義への集約は別物** — 今回 prefix を `REPO_PROBE_PREFIX` に
> 寄せたのは、次に同じ分岐が起きないようにするため。

### 4.12 第8ラウンド(2026-07-20)— **§4.11 の teeth が、§4.11 の教訓を踏んだ**

§4.11 は教訓 (2) として「**クラスではなく、たった今作った実例だけを塞ぐな**」と書いた。
その §4.11 の修正自体が、まさにそれをやっていた。

**実測(敵対レビュー)**: probe の 1 つに新しいリテラル prefix を与える。

```
- const outside = await mkdtemp(join(REPO_ROOT, REPO_PROBE_PREFIX))
+ const outside = await mkdtemp(join(REPO_ROOT, 'og-fence-newprobe-'))

→ スイートは 54/54 GREEN
→ git check-ignore og-fence-newprobe-abc は exit 1(非 ignore)
```

つまり **teeth は、それが書かれた原因である事象そのものを素通しした**。§4.11 の
check-ignore case が pin しているのは `REPO_PROBE_PREFIX` という *const の値*であって、
*repo 直下に何かを作るという行為* ではない。**新しい probe が独自 prefix で入る**という
2026-07-19 に実際に起きた形は、何も赤くしない。

**修正 — 場所を変えた**。teeth を probe の隣(`testHomeGuard.test.ts`)から 1 階層上の
**repo 全体ガード `src/testHomeEnvGuard.test.ts`** へ移し、規則を「この const を使え」から
**「repo ルートアンカーに何かを作る行為は、単一の prefix を経由せよ」**に変えた。

> ⚠️ **この時点で書いた「新しいファイルでも、新しい probe でも、新しいリテラルでも
> 赤くなる」は偽だった**(§4.13 で実測・是正)。当時の実装は*ソースを読む*方式で、
> 動詞リスト 6 個・`join(` が動詞から 8 文字以内・アンカーは名前リテラル、という
> 3 条件を全て満たす綴りしか見えていない。**4 通りの書き換えが素通りした**。
> 過大主張のガードは、この章が戒めている失敗そのものである。

実装上の要点 2 つ(どちらも実測で決まった):

- **アンカー判定は `join()` の第1引数だけを見る**。最初は「呼び出し周辺 140 文字に
  アンカー名が出るか」で書いたが、`mkdir(join(dir, 'src', 'test'))`(gateEnvTamper)と
  `mkdir(join(wt, 'src', 'lib', 'server'))`(hooksInstall)が**誤検知で赤くなった** —
  無関係な `repoRoot` が後続の別文に居ただけ。tmpdir 由来のローカル変数に書く正当な
  コードで狼少年になるガードは、1 週間で無効化される。第1引数の抽出は**括弧を数える**
  (repo ルートは `fileURLToPath(new URL('../../..', import.meta.url))` のように
  **自分の中にカンマを持つ式**で書けるので、最初のカンマで切ると隠れる)。
- **prefix の宣言はソースから読む(import しない)**。テストファイルを import すると
  それが走ってしまう。読めなかったら「違反なし」ではなく **throw** する — 自分の対象を
  見失ったガードが永遠に緑を返すのが、この章で最も繰り返されている失敗だから。

**teeth 実測(2026-07-20・全変異とも復元後に tree は HEAD と完全一致)**:

| # | 変異 | 結果 |
|---|---|---|
| baseline | 修正あり | **56 passed**(2 files)|
| **A** | probe に新リテラル prefix(=本ラウンドの穴そのもの)| **赤・違反行を名指し** ✅(修正前は 54/54 緑)|
| **B** | `REPO_PROBE_PREFIX` の値を非 ignore 名に改名 | **2 ファイルとも赤** ✅ |
| **C** | `.gitignore` の `/.og-fence-probe-*` を削除 | **2 ファイルとも赤** ✅ |
| **D** | `REPO_ANCHOR` を何にもマッチしない正規表現に | **赤**(self-check「既知の probe を 1 つも検出できていない」)✅ |
| **E** | prefix 宣言の形を変えてスクレイプを外す | **赤**(fail-closed throw)✅ |

D と E が本ラウンドの肝 — **ガードが目隠しされたことを、ガード自身が検出する**。A だけを
塞いだのでは §4.11 と同じ「実例だけ」の修正になる。

> **教訓**: 「クラスを塞げ」と**書いた本人が、その同じコミットで実例だけを塞いだ**。
> 教訓を散文で書くことと、教訓を実行することは別の作業である。**自分の teeth に対して
> 「これは何を pin しているか — 値か、行為か」を明示的に問う**こと。値を pin した teeth は、
> その値を使わない新参者に対して無力で、しかも緑なので無力だと気づけない。
> 併せて §6-7 を追加した。

### 4.13 第9ラウンド(2026-07-20)— **§4.12 の「クラス級」が実測で否定された**

差し戻し 2 回目。独立レビューが**変異を実際に植えて測り**、§4.12 が宣言した
「行為を pin した」「新しいファイルでも新しい probe でも新しいリテラルでも赤くなる」が
**偽**であることを示した。同じ 1 つの禁止された書き込みを 4 通りに綴り直すと、
**4 通りとも 9/9 GREEN**(2 つは単独でも緑):

```
const rootAlias = REPO_ROOT; mkdirSync(join(rootAlias, 'x'))  → 別名を掴まない
const p = join(REPO_ROOT, 'x'); mkdirSync(p)                  → join が動詞から遠い
writeFileSync(`${REPO_ROOT}/x`, 'y')                          → join が無い
appendFileSync(join(REPO_ROOT, 'x'), 'y')                     → 動詞が未登録
```

**なぜ 4 つとも通ったか**(原因はどれも「ソースを読む」ことに内在する):
動詞リストが 6 個 / `join(` が動詞から 8 文字以内という隣接規則 / アンカーが名前リテラル /
**ガードが自分自身のファイルを丸ごと除外**していた(そこに書けば永久に無警察)。

**修正 — 検出対象を「綴り」から「結果」へ移した**。新設
`src/test/repoRootFence.ts` を `setup-home.ts` が装着し、**毎テスト後に repo 直下を
`readdirSync` して開始時との差分**を取る。`.gitignore` が覆わない新規エントリがあれば、
その場で赤くして**どのテストの後に現れたか**を名指しする。ソースを一切読まないので
綴りにも動詞にもファイル位置にも依存せず、**子プロセス(git / tsx / 入れ子 vitest)の
書き込みまで見える**。

**なぜ「スイート終了時に 1 回」ではなく毎テスト後か**: vitest はファイルを並列に回すので、
終了時 1 回では「汚したファイルが先に終わったときだけ見える」レースになる。毎テスト後なら
汚したファイル自身が次の hook に到達して自分で報告する。

**この層に見えないもの(明記する)**: 1 つの `it()` の中で作って消したものは残らないので
見えない。その窓は実在し(並行 `git status` は踏める)、元の bug の正常系がまさにその形
だった。そこは `src/testHomeEnvGuard.test.ts` のソース sweep が**補助として**狙う —
4 穴(動詞追加 / 隣接規則の廃止 / 単一代入の別名解決 / 自己除外の撤廃)を塞いだが、
**綴りの網羅は原理的に不可能**なので、範囲を掟 6 に明記した上で「補助」と呼ぶ。
2 層あわせて上の 4 通りが全て赤、が今回得た性質である。

**teeth 実測(2026-07-20・4 変異を同時に植えて 1 回で測定)**:

| 層 | 結果 |
|---|---|
| listing フェンス | `og-fence-newprobe-a` / `-b` / `-c` / `-d` を**各テスト後に個別に**名指しで赤 ✅ |
| ソース sweep | 4 行とも offender として赤(別名版は `mkdirSync(p)` として検出)✅ |
| 復元 | 変異を revert → `git status` 空・`git diff HEAD` 空 ✅ |

> 副作用として**誤検知 2 件**が出て、その場で潰した(掟 6 の「狼少年は 1 週間で無効化
> される」の実例)。どちらも**文字列リテラルを読んでいた**ことが原因:
> `mkdir(join(wt, 'src', …))` の `'src'` が、無関係な `const src = …join(repoRoot…)` 由来の
> 別名 `\bsrc\b` に一致した / 生成スクリプトを文字列配列で持っている file を、コードとして
> 読んだ。**コメントと文字列リテラルを同じ長さの空白でマスクしてから**走査するようにした
> (テンプレートリテラルの `${…}` だけは残す — でないと 3 番目の変異が見えなくなる)。

**MF2 — パス依存の偽緑を、修正の側が「方針として固定」しかけていた件**。
`testHomeProblem()` は**最初に一致した条件で return** する。条件 2 は
「解決先が real `~/.openground` (配下)か」。**swarm worker の worktree は
`~/.openground/projects/<uuid>/worktrees/` にある**ので、`REPO_ROOT` に作った probe は
条件 3 に到達する前に条件 2 で捕まる。つまり TMPDIR 毒盛 teeth 2 件は、
**worker では緑・primary では赤**という既知クラスに落ちていた(条件 3 を無効化した同一変異で:
worktree から 1 failed / 46 passed、primary 相当パスから 3 failed / 44 passed)。

修正は「probe をどこに作るか」ではなく**「そもそも作らない」**。probe fixture
(`__fixtures__/tempRootPoisonProbe.ts`)は自分のヘッダに
*「何も書かないし、ディレクトリが実在する必要もない」*と書いてある — パスに対する
判定を訊くだけだからで、TMPDIR は `OG_PROBE_TMPDIR` で子プロセス内から差し替えられる。
よって probe を **passwd home 起点の「作らないパス」**にした。どの checkout でも
`~/.openground` の外・かつ throwaway でない home の下なので、**条件 3 が載る**。
前提は `assertReachesCondition3()` が明示 assert する(実在しないこと / 条件 2 の
射程外であること / 条件 3 の射程内であること)ので、将来また場所依存に戻れば
**弱く通るのではなく名指しで落ちる**。

**同一変異での実測(この worktree = `~/.openground` 配下から)**:

| | 条件 3 を無効化 |
|---|---|
| 修正前 | **1 failed / 46 passed**(2 件が偽緑)|
| 修正後 | **3 failed / 44 passed** ✅ |

**MF3 — 文書の行番号が実測とずれていた**(§4.11 の sanctioned site を `:288` / `:406` と
書いていたが、出荷行は `:306` / `:424`。fence 本体の `:201` も実際は `:389`)。
TARGET-STATE §6「現物が正」に従って是正。**行番号は書いた瞬間から腐る**ので、追った先が
別物だったら文書を疑う。

> **教訓**: §4.12 は「値ではなく行為を pin せよ」と書いた。書いた本人は*ある綴りの*行為を
> pin し、それを「クラス級」と呼んだ。**ソースを読む限り、綴りは相手が無限に作れる** —
> 網羅の主張はそこでは原理的に成立しない。全称を主張したいなら、見るものを
> **実際に起きた結果**まで下げるしかない(ここでは「repo 直下に何が残ったか」)。
> そして下げてなお見えない範囲(作って消した窓)は、**塞いだと書かずに、見えないと書く**。

---

### 4.14 第10ラウンド(2026-07-21)— **同じ木を見る 2 つの sweep が、別々の目を持っていた**

`testHomeEnvGuard.test.ts` の 2 本の sweep は同じ木に別々の質問をする。だが
**「その木に何のファイルがあるか」で食い違っていた**。

| | 列挙 | 検出キー |
|---|---|---|
| unset sweep(delete / stubEnv)| `grep --include=*.ts --include=*.tsx` + `SWEPT_DIRS` | 4 パターン |
| resolver sweep(第2の `.openground` 解決式)| `git ls-files`(`.ts/.tsx/.js/.cjs/.mjs`)| **`'homedir' + '()'` の 1 文字列** |

`SWEPT_DIRS` は `scripts` / `electron` / `worker` を名指ししている。**この 3 つは
JavaScript のディレクトリ**なので、unset 側はそこを**名前だけ**掃引していた。
2 つのリストを並べて読んだ人は「両方カバー済み」と受け取る — **宣言と到達範囲のズレ**
(§3.1 が git の pathspec で `.mts`/`.cts`/`.jsx` を取りこぼしていたのと同じクラス、別の場所)。

さらに resolver 側の検出キーは**関数名 1 個**だった。同じファイルの 2 ブロック下、
§3.1 の `~/.claude` インベントリは既に 6 綴り(`BROAD_HOME`)を知っているのに、
`.openground` 側は 1 綴りのまま — **ファイル内部の非対称**。これは「行為(ホームを
解決する)」ではなく「`homedir()` という綴り」を見張る**スペルチェッカー**であり、
`userInfo().homedir` は fence の baseline (`testHomeGuard.ts`) が実際に使っている
形なので、次に生えるコピーは**新しい綴りの方が確率が高い**。

**実測(変異 → 赤 → 逆変異 → `git status` 空で復元証明)**:

```
# 植えた本物の漏れ 2 件
scripts/build-server.js:2   delete process.env.HOME
electron/cacheReset.js:2    join(require('os').userInfo().homedir, '.openground')
```

| 状態 | 結果 |
|---|---|
| 修正後(現行)| **3 failed / 48 passed** — 2 件とも file:line で名指しされる ✅ |
| 列挙を旧 `*.ts`/`*.tsx` だけに戻す | **51/51 GREEN** — 本物の漏れ 2 件が完全に不可視 |
| 検出キーを旧 `homedir()` 1 個に戻す | repo アサーションは **GREEN**(resolver 側は素通り)。赤くなったのは **teeth 自身 2 件だけ** |

3 行目が teeth の存在意義そのものである: **repo sweep は「異常なし」と「何も見て
いない」に同じ `[]` を返す**。narrowing を検出したのは合成ソースを食わせる純関数の
teeth だけだった。

**修正の中身**:

1. **列挙を 1 本化** — 両 sweep が `sweptSourceFiles()`(= `repoSourceFiles()` の
   `SWEPT_DIRS` ∪ **repo 直下** スライス)を共有。拡張子の判断は git の pathspec では
   なく JS 側の `SOURCE_EXT`(`.m/c?[jt]sx?`)に集約 — pathspec は `.mts`/`.cts`/`.jsx`
   を素通りする(§3.1 の実測)。grep をやめたので **NUL バイト入りファイルの無言
   スキップ**(`scripts/openground-guard.js`)も **BSD/GNU の exit code 分岐**も構造ごと消えた。
2. **repo 直下を含めた** — `vitest.config.ts` は `setupFiles` を配線する = **この
   ガード群を arm している当のファイル**なのに、どの `SWEPT_DIRS` にも属さず両 sweep から
   不可視だった。実測コスト(2026-07-21)= **+5 ファイル**
   (playwright / postcss / tailwind / vite / vitest の各 config)/ **新規 offender 0**。
3. **検出キーを行為へ** — `HOME_ANCHOR_SOURCES` 6 綴り(`\bhomedir\b` /
   `env.HOME` / `env['HOME']` / `USERPROFILE` / `HOMEPATH` / `getPath('home')`)。
   `userInfo(` を別建てしないのは `userInfo().homedir` が `\bhomedir\b` に含まれるから
   (§3.1 が自分の `userInfo(` エントリを「検出を増やさず誤検出面だけ増やす」と実測して
   落としたのと同じ理由)。誤アンカー `process.env.HOMEBREW_PREFIX` と
   `app.getPath('userData')` は teeth で除外を pin。
4. **精度ルール 2 種を ablation 可能に** — home var への**代入(pin)**は正当な行為なので
   除外する。ただし**右辺が別の home 式なら報告する**(`process.env.HOME =
   userInfo().homedir` は $HOME を実ホームへ**戻す**ので、この sweep が狩る read より悪い)。
   2 ルールは今日の木では相互に冗長(2026-07-21 実測: both on → 8 / 片方だけ → 8 /
   both off → 9・増える 1 件は `swarmSafety.test.ts`)なので、
   「外して赤くなる」証明は repo 全体ではなく**ルールごとに、そのルールしか救えない形**に
   対して teeth で行う。
5. **認可を skip list から「件数」へ** — ファイル単位の除外は**読む前に飛ばす**ので、
   認可済みファイルの中に生えた新しい resolver が不可視だった。**実測(2026-07-21)**:
   `electron/lockdown.js` に 2 本目の `join(homedir(), '.openground', …)` を植えると、
   件数 pin では **`sanctioned for 1 site(s), found 2` で赤**、同じ木で判定を skip list に
   戻すと **51/51 緑**。件数なら増えても減っても赤くなる = 死んだエントリも腐らない。
   現行 6 ファイル = `paths.ts` 1 / `hooksInstall.ts` 1 /
   `gateEnvTamper.test.ts` 2 / `lockdown.js` 1 / `swarm-lock.js` 1 /
   `openground-hook.js` 2 = 計 8。**この 8 件が緑であること自体が「.js を実際に読めている」証拠**
   (0 件なら「認可したつもりのファイルを 1 行も読んでいない」で赤になる)。
6. **「このリストは本物か」の 2 つの検査を列挙側へ移した** — 自己レビューで見つけた
   **移植の取りこぼし**。`SWEPT_DIRS` の存在チェックと「存在するのに 1 件も返さない」
   チェックは unset 側の中にあり、resolver 側はそれを継承していなかった。
   `SWEPT_DIRS` に消えたディレクトリが残ると、unset 側は throw するが resolver 側は
   **開いてもいない木に対して穏やかに `[]`** を返す(認可の件数チェックは「列挙が実際に
   返したファイル」に対してしか走らないため)。列挙の非対称と同じ形が 1 階層上に居た。
   **実測(2026-07-21)**: `SWEPT_DIRS` に存在しない名前を 1 つ足すと、移動後は
   **5 failed**(unset 4 + resolver 1)。移動前は resolver 側が緑のままだった。
7. **「3 つのバケットは filter であって partition ではない」** — unset 側の 3 アサーションは
   報告文字列を*空白 1 個の*部分一致で再フィルタしていたので、`delete<空白2つ>process.env.HOME`
   は sweep が拾ってもどのバケットにも入らず **3 件とも緑**だった。集合まるごとを
   assert する第 4 のアサーションを追加(バケットはメッセージを良くするためだけに残す)。

**同じ問いを隣の sweep に向けたら、そこにも同じ穴があった**(§3.1 の `~/.claude`
インベントリ・実測 2026-07-21)。`BROAD_HOME`(「このファイルは宣言が要るか」)は
`\bhomedir\b` で `userInfo().homedir` を捕まえるのに、`NARROW_HOME`(「この行は実
ホームを**解決している**か」= 生書き込みルールの唯一の判定)は**括弧を要求**していた。
結果、**宣言済みファイルが `writeFileSync(join(userInfo().homedir, '.claude',
'settings.json'), …)` を生やしても無言**(同じ書き込みを `homedir()` で綴れば
`UNFENCED WRITE` で赤)。`NARROW_HOME` の第1選択肢から括弧を外して解消 —
**コストゼロ**(誤検出 pin を含む他の全ケースが緑のまま)。teeth を 2 綴り並べて追加。

**同じ欠陥クラスの残り**は `testHomeGuard.test.ts` の mock-ban sweep にもあった
(`isHarness` は `src/test/**` を**拡張子不問**で受け、`vitest.config.[cm]?ts` を名指しする
のに、列挙は `*.ts`/`*.tsx` だった)。**setupFile は全テストプロセスで走る**ので、
`.mjs` ヘルパに `vi.doMock('./paths')` を 1 行置けば fence を全面無効化しつつガードは緑 —
最もレバレッジの高い迂回路だった。同じコミットで列挙を 8 拡張子へ拡張。
`isTest` は `*.test.ts(x)` のまま(vitest の `include` がそれしか収集しないので、
`.test.js` を守るのは芝居)。

> **教訓**: 1 つのファイルに複数の sweep が同居したら、**まず「見ているファイル集合」が
> 同一かを疑う**。検出パターンの議論より先に、列挙の非対称が穴を作る。そして
> **列挙を共有する**のがコメントで注意を促すより強い — ズレようがなくなる。

### 4.15 第11ラウンド(2026-07-28)— **teeth 自身が3世代にわたって誤った条件を踏んでいた**

`testHomeGuard.test.ts` の 6 件(いずれも「throw するはず」の側)が open-ground の
CI で毎回赤。**実測(`gh run view --log-failed`、`ci.yml`・`ubuntu-latest`・`npm test`):
0.11.32 から 0.11.38(この修正時点の最新)まで 7 リリース連続**、いずれも同一の
`src/lib/server/testHomeGuard.test.ts (47 tests | 6 failed)` シグネチャ。0.11.31 以前には
出ない。「0.11.36 / 0.11.37 の 2 リリース」という当初の申告は過小、後続レビューで出た
「0.11.36 は出ていない」という訂正案も誤り — **両方とも実測ログを見ずに書かれていた**。
release ジョブ自体は success なので配布は止まらず、**本章の安全網だけが CI で検証され
ない**状態が7リリース続いていた。

**柵は正しい。**バグはテスト側のヘルパー `unsafeWorld()` にあり、しかも**3世代連続で
誤った**——「不安全ホームを本当に安全でない場所に置く」という一点を、3回とも別の形で
外した。

**ラウンド1(〜2026-07-28)**: 不安全ホームを**実 tmp の中に mkdtemp** し、`TMPDIR` を
兄弟サブディレクトリへ stub して「temp の外」に見せていた。`tempRoots()` は非 win32 で
`/tmp` を**ハードコードで足す**(§2.1 の `vi.mock('os')` 対策)ため、ラウンド1の構成を
**そのまま**(`TMPDIR` stub 込みで)再現して実測すると:

| OS | 実 tmpdir(`outer` 生成時) | unsafeHome の実際の場所 | 柵の判定 |
|---|---|---|---|
| macOS | `/var/folders/…` | `/private/var/folders/…/home` | どの root にも該当せず → **不安全**(正しく throw)|
| **Linux(CI)** | **`/tmp`** | **`/tmp/…/home`** | **`/tmp` 配下 = 安全** → **throw しない** |

`TMPDIR` stub は `fakeTmp`(兄弟パス)だけを temp 扱いにする効果しか持たず、
`unsafeHome` 自身の判定は「`outer` が生成された瞬間の実 tmpdir が `/tmp` かどうか」で
決まる——Linux では tmpdir() 自体が `/tmp` なのでハードコード分岐にそのまま乗り、macOS
では `/var/folders` なので乗らない。**macOS が緑だったのは OS 配置の偶然**であり、
`/tmp/...` を安全と判定するのは柵として正しいので、**柵は1行も変えていない**。

再現(1 コマンド、実測): `TMPDIR=/tmp npx vitest run src/lib/server/testHomeGuard.test.ts`
→ **6 failed / 41 passed**(CI と同一の 6 件・同一理由)。TMPDIR 無しなら 47 緑。

**ラウンド2(同日、最初の修正)**: unsafeHome を repo root の `REPO_PROBE_PREFIX` 配下
(= §4.11 が「temp でない唯一の書込み可能地点」と定めた場所)に移した。ラウンド1の
失敗モードは消えたが、**別の条件が冗長な backstop として隠れる新しい穴**を開けた。

⚠ **この段落は当初「条件2で弾かれ条件1には届かない」と書かれていたが、実測で誤りと
判明し訂正した**(差し戻し2回目)。`testHomeGuard.ts` の条件順序は**条件1(:352)が
条件2(:358)より先**であり、無変異のまま repo-root アンカーを直接 `testHomeProblem()`
に渡すと(このワークツリー自身から実測)**条件1のメッセージが返る**——ラウンド3の
`/var/tmp` アンカーと同じ返り値。つまりラウンド2でも条件1は毎回きちんと発火していた。

本当の欠陥はこう: swarm worker のチェックアウトは
`~/.openground/projects/<uuid>/worktrees/…` 配下にあるため、そこでの repo-root パスは
条件1に**加えて**条件2(`isSamePathOrUnder(canon, REAL_OPENGROUND_HOME)`)**にも**
マッチしてしまう。条件2は普段は姿を見せない**冗長な backstop**——ところが統合レビューが
`testHomeGuard.ts` の `if (!isUnderTempRoot(home))` を
`if (false && !isUnderTempRoot(home))` に変異させ(**条件1を丸ごと無効化**)て実測した
ところ、ラウンド2の版で `testHomeGuard.test.ts` は **両方の TMPDIR 環境で 47 passed /
0 failed のまま**だった——条件1が死んだ瞬間に条件2が代わりに拾い、外から見える結果
(throw する/しない)は何も変わらなかった。

ラウンド2で足した前提 assert(`isUnderTempRoot(unsafeHome) === false`)は嘘を言っていた
わけではなく、実際に真だった。欠けていたのは別の問い——「条件1が**唯一の**拒否理由か」
——であり、それを確かめていなかったので、条件1が壊れても気づける形になっていなかった。

**ラウンド3(本ラウンド、修正)**: unsafeHome のアンカーを **`/var/tmp`** に置き直した。
実測(このワークツリーから、`TMPDIR=/tmp` と既定の両方)で以下の**3条件すべて**を
同時に満たすことを確認済み:

- `tempRoots()`(`tmpdir()`/`TMPDIR`/`TMP`/`TEMP` に加えハードコード `/tmp` のみ)には
  一度も含まれない — `/var/tmp` はここに無い
- `REAL_OPENGROUND_HOME` の外
- `PASSWD_HOMEDIR` / `EFFECTIVE_HOMEDIR` の両方の外

結果、`testHomeProblem('/var/tmp/og-fence-unsafe-<id>', {})` は条件1のメッセージ
(`"the resolved home is outside every OS temp root (canonical: …)"`)をそのまま返す。
**この world を使う消費側ケース全部を個別に実測**した結果(installHooks の `$HOME` stub
ケース・legacy 移行の `vi.resetModules()` 再 import ケースを含む)、**全ケースが条件1で
弾かれる**ことを確認した——`$HOME` stub や module reset は条件1の判定([`testHomeProblem`]
内で最初に評価される)に一切影響しない(条件1は `$HOME` を参照しない)ため。したがって
「一部のケースは条件2/3の teeth」という分割は不要で、**アンカー1つで全ケースに条件1の
teeth が均一に乗る**。

`/var/tmp` を採用するにあたり実測で潰した3点:
1. `TMPDIR=/var/tmp` という環境では `/var/tmp` 自体が `tempRoots()` に入るため条件1が
   発火しなくなる——実測: その環境で `testHomeProblem()` は `null`(問題なし)を返す。
   これは前提 assert(`toMatch(/outside every OS temp root/)`)が `null` に対して**大きな
   声で失敗する**ことで検知される(黙って無力化はしない)。
2. `/var/tmp` は再起動をまたいで残る共有・sticky ディレクトリなので、予測可能な名前は
   他ユーザ/前回実行の残骸に黙って乗る危険がある——`mkdtemp('/var/tmp/og-fence-unsafe-')`
   で OS 保証の一意な名前を発行させ(2行上の `tempOuter` と同じプリミティブ)、
   pid+counter の手組みは廃止(差し戻し2回目で反映)。掃除方針は他の tmp world と同じ
   (`cleanup()` で必ず `rm`、残るのは実行が kill された場合のみ)。
3. `$HOME` を `/var/tmp` 配下へ stub して module を再 import すると
   `EFFECTIVE_HOME_IS_TEMPORARY` が true になり得る(`homeIsThrowaway()` が
   `TRUSTED_TEMP_PREFIXES` に含まれる `/var/tmp` を throwaway と見なすため)が、実測では
   これは無関係——条件1が常に先に発火するため、条件3のこの抑制が効く場面は今回のケース
   群には存在しない。

「実体が不要なケース」(:832 `refuses a non-tmp $HOME through the same one fence` — path を
渡すだけで一切ファイルシステムに触れない)は `unsafeWorld()` から独立した footprint ゼロ
のヘルパー `outsideAnyHome()`(`/` 直下・作成しない)へ移した。**setSettings のケースは
移していない**——`/` 直下は非 root では書けないため、そこへ移すと「柵が拒否した」ではなく
「権限が無くて書けなかった」で `assertNeverCreated` が通ってしまい、teeth が偽物になる。

同型のバグを inline で抱えていた legacy 移行ケース(実 `~/.hove` を動かさない teeth)は
引き続き `unsafeWorld()` を共有させている——2つのコピーは prefix も作る対象も違うので
「同一だった」は言い過ぎで、正しくは**構成が同型だった**(同じ「実 tmp の中に不安全
ホームを作る」誤りを2箇所で別々に踏んでいた)。

**teeth(実測、最終形)**: 前提を assert に落とし(`testHomeProblem(unsafeHome, {})` が
条件1のメッセージ文言そのものにマッチすること)、`if (false &&
!isUnderTempRoot(home))` 変異を最終形の `unsafeWorld()`(`/var/tmp` アンカー)に対して
再実測:

| 環境 | 修正後(変異なし) | 条件1無効化の変異 |
|---|---|---|
| `TMPDIR=/tmp` | 47 passed | **6 failed / 41 passed** |
| TMPDIR なし(macOS) | 47 passed | **6 failed / 41 passed** |

ラウンド2の同じ変異は両環境とも 47 passed / 0 failed(teeth 無し)だった——**両OSで
赤になる**のがラウンド3で初めて成立した性質であり、ラウンド1の「アンカーのみを実 tmp 内
へ戻す(TMPDIR stub は戻さない)」という単純化した変異でも両OS赤になるが、これは
**トートロジー**(`mkdtemp(join(tmpdir(), …))` の直下に作れば tmpdir() の定義上
必ず temp 扱いになる)であり、ラウンド1の実際の構成(TMPDIR stub込み)を厳密に再現した
場合は macOS で条件1の前提が**真に成立してしまう**(上表参照)ため、「前提を assert すれば
書いた人の机の上でその日に落ちる」という主張はラウンド1の実際の構成には**適用できない**
——macOS では本当に安全なホームが作られていたから。この教訓が刺さるのはラウンド2
(条件2の混入)であり、ラウンド1(OS配置依存)ではない。書き分けが必要。

なお `src/testHomeEnvGuard.test.ts` の repo-tree write sweep self-check コメント
(「sanctioned なサイトは1本(:444 相当)だけ残る」)は、ラウンド2で `unsafeWorld()` が
repo root に書き込んでいた間は不正確になっていたが、ラウンド3で `/var/tmp` へ移したことで
repo 木への書き込みが再びゼロになり、**コメントは何も変更せずに正しさへ復帰した**——
コメント自体を直す必要はない(実測: `sanctionedSites` は元の1件に戻る)。

> **教訓**: teeth の「不安全な入力」は、**env を細工して不安全に見せるのではなく、
> 実際に不安全な場所に置く**——だけでは足りない。「実際に不安全な場所」が**どの条件で
> 弾かれるか**まで実測しないと、複数の拒否条件を持つ柵では「拒否はされるが狙った条件では
> ない」という形で同じ穴が再発する(ラウンド2がまさにそれ)。teeth の実測は
> 「throw するか」ではなく「**どの理由で** throw するか」まで見る。

**ラウンド4(差し戻し2回目、本ラウンド)**: ラウンド3の前提 assert
(`testHomeProblem(unsafeHome, {}) が条件1のメッセージを返す`)には、**それ自身が
ラウンド2と同じ穴**があった。ラウンド2の repo-root アンカーに対しても
`testHomeProblem()` は条件1のメッセージを返す(上の訂正どおり)ため、この assert は
**ラウンド2とラウンド3を区別できない**——将来誰かがアンカーを repo root や `~/` 配下へ
戻しても、この assert は緑のまま通り、teeth だけが静かに死ぬ(ラウンド2とまったく
同じ形)。

追加した `assertOnlyCondition1()` は「条件1のメッセージが返る」に加えて「条件2・条件3
どちらもこのパスにマッチしない」——**条件1が唯一の拒否理由である**——ことまで実測
assert 化する。既存の `assertReachesCondition3()`(執筆時点で :765-785 相当、逆方向の
目的で同じパターンを持つ——後続の編集で行番号は動きうるので目安)を鏡写しにした。
`unsafeWorld()` と、実体を持たない
`outsideAnyHome()`(footprint ゼロで docstring だけが保証を主張し、コード側には何の
assert も無かった非対称)の両方に適用。

実測で検証: `unsafeHome` を一時的に `mkdtemp(join(REPO_ROOT, REPO_PROBE_PREFIX))`
(ラウンド2と同じアンカー)へ戻すと、新しい `assertOnlyCondition1()` が「これは
round-2 バグそのもの」と名指しして 5 failed で落ちることを確認。元へ戻し
`git status --porcelain` 空を確認済み。

最終形で `if (false && !isUnderTempRoot(home))` を再実測(両アサート込みの完成形):
`TMPDIR=/tmp`・既定 TMPDIR の両方で **6 failed / 41 passed**(ラウンド3の値を維持)。

---

## 5. 検証コマンド(疑ったら自分の目で)

> **テストは必ず HOME ごと隔離して回す**(司令官指定・2026-07-19):
> `OPENGROUND_HOME=$(mktemp -d) HOME=$(mktemp -d) npm test`。
> fence は最後の砦であって、pin の代わりではない。

```bash
# 1. fence の回帰テスト(47 件)+ repo ガード(51 件)= 98 件
#    (件数は 2026-07-21 実測。§4.5 等の「22 件 / 5 件」は当時の値=履歴。
#     45→47 は check-ignore teeth と NODE_ENV teeth、9→11 は §4.13 の listing
#     フェンス teeth 2 件、11→36 は §3.1 の ~/.claude アンカーインベントリ
#     teeth 25 件、36→51 は §4.14 の 2 sweep の teeth 14 件 + unset の
#     「partition ではない」アサーション 1 件)
OPENGROUND_HOME=$(mktemp -d) HOME=$(mktemp -d) \
  npx vitest run src/lib/server/testHomeGuard.test.ts src/testHomeEnvGuard.test.ts

# 2. 隔離が --no-isolate でも破れないこと(全ファイル 1 プロセス共有)
npx vitest run --no-isolate

# 3. delete が復活していないか
#    ⚠️ 素の grep は 2026-07-19 以降「0 件」にならない(2026-07-21 実測: 5 ファイル
#    17 行)。M2 統合で「delete して throw を確かめる」teeth が正当な形で入り、
#    fence 本体と本章の説明文もパターンを文字列として持つため — §4.4 の自己言及の
#    罠そのもの。正典は静的ガードのテストで、除外はそこに符号化されている
#    (緑 = 再発ゼロ)。
npx vitest run src/testHomeEnvGuard.test.ts
#    ⚠️⚠️ 下の grep の `--include="*.ts" src server` は §4.14 で塞いだ盲点そのもの:
#    scripts/ electron/ worker/(JavaScript)を素通りし、`delete<空白2つ>` や
#    `vi.stubEnv(…, undefined)`、`const env = process.env; delete env.HOME` も見ない。
#    目視の補助にすぎないと理解して使うこと。出てよいのは次の 5 ファイルだけ:
#    testHomeEnvGuard.test.ts(自身の teeth)/ testHomeGuard.test.ts(fence の teeth)/
#    testHomeGuard.ts・paths.ts・setup-home.ts(規約を説明・エラー文に出力)
grep -rln "delete process\.env\.OPENGROUND_HOME" --include="*.ts" src server

# 3b. choke point を通らない第2の home 解決式が生えていないか(0 件であること)
#     — 差し戻し 1 回目の must-fix 1。paths.ts / testHomeGuard.ts 以外に出たら穴。
#     ⚠️ この grep は綴りを 1 つしか知らない(= §4.14 で直した当の欠陥)。
#     `userInfo().homedir` / `process.env.HOME` / `USERPROFILE` / `getPath('home')`
#     も同じ解決であり、この行では見えない。正典は上の常設テスト。
grep -rn "join(homedir(), *'\.openground')" --include="*.ts" src server \
  | grep -v "paths\.ts\|testHomeGuard\.ts\|hooksInstall\.ts"

# 3c. ~/.claude 側のアンカーが全て宣言どおりか(38 件・§3.1)
#     read-only tier の「書かない」は毎回ここで検証される。新しいアンカーが
#     生えたら UNDECLARED で赤 = 人が分類するまで通らない。
npx vitest run src/testHomeEnvGuard.test.ts

# 4. fence が 5 アンカー全てに繋がっているか(各1件ずつ出ること)
#    ⚠️ この grep は「人が思い出したときだけ走る」= one-time assurance。2026-07-20 に
#    実測で不足が出た(手で数えた「未 fence 5 本」に対し機械は 16 本)。正典は 3c の
#    常設テストで、この grep は目視の補助にすぎない。
grep -n "assertTestHomeIsolated" src/lib/server/{paths,hooksInstall,claudeTrust,ogManageSkill,generateSkill}.ts

# 4b. テスト中に fence が一度でも発火したか(0 であること。発火 = 実ホームに
#     到達しようとしたテストが居る = そのテストの env pin が漏れている)
npm test 2>&1 | grep -c "REFUSING to resolve"

# 5. 本番 settings が生きているか(事故後の確認用・読むだけ)
python3 -c "import json;d=json.load(open('$HOME/.openground/settings.json'));print(len(d.get('projects',[])),'projects')"
```

**信じてよい表示 / 疑うべき表示**:

- ✅ 信じてよい: `npx vitest run` が緑で終わること = fence が一度も発火しなかった
  = どのテストも本番ホームを解決していない。
- ⛔ 疑うべき: 「テストが緑だから安全」— **ガードを外して赤くなることを確かめない限り
  それは何の証拠でもない**(§4)。新しい安全機構を足したら必ず §4 の手順を踏む。

---

## 6. 変更するときの掟

1. **`openGroundHome()` を経由しない新しいホームパスを作らない。** 追加するなら
   `paths.ts` に足す(fence が自動で効く)。`join(homedir(), '.openground')` を
   自前で書いたら、その瞬間に §3 の残存リスク表へ 1 行増える。
2. **fence を fs 呼び出しの内側へ移さない**(§2.2)。寛容リーダーに食われて fail-open 化する。
3. **`delete process.env.OPENGROUND_HOME` / `delete process.env.HOME` を書かない。**
   保存値の復元(`if (saved !== undefined) process.env.X = saved`)にする。
   (`CLAUDE_CONFIG_PATH` は未設定が正当なベースラインなので、そこだけは
   `undefined` なら delete する厳密復元でよい。)
3b. **サーバ側コードを呼ぶテストは `OPENGROUND_HOME` だけでは足りない。**
   `homedir()` 起点のアンカーが 4 つある(§3 の表)。worker spawn / worktree 撤去 /
   hooks / skills に触るなら **`HOME` と `CLAUDE_CONFIG_PATH` も tmpdir へ pin** する。
   pin し忘れは fence が `REFUSING` で教えてくれる(§5 の 4b)。
3c. **`~/.claude` を新しく名指ししたら `CLAUDE_ANCHORS` に宣言する**(§3.1)。
   赤くなったら表に 1 行足すのが正しい直し方 — ただし **tier は正直に**。
   書くなら `assertTestHomeIsolated` を解決地点に繋いで `fenced`、読むだけなら
   `read-only`(そのファイルは fs 変異呼び出しをゼロに保つ義務を負う)、
   使い捨て home へ書くなら `writes-elsewhere` + どこへ書くかの理由。
   **黙らせるための tier 付け替えをしない** — 各 tier の主張は毎回機械で検証される。
   そして **tier に関わらず `writeFileSync(join(homedir(), '.claude', …))` の
   1 行書きを作らない**。パスを組む → `assertTestHomeIsolated` に渡す →
   検査済み変数で書く、の 3 手に割ること。
4. **テストを skip / 削除して通さない。** 判定不能なときは止める側に倒す。
4b. **完了ゲートの申告は「そのコミットの状態で実際に回した結果」だけ。**
   **docs だけの追記でも回し直す** — この repo の検査(`repoPiiGuard` / メタテスト)は
   **git 管理下の全ファイル**を走査するので、docs の 1 行が完了ゲートを赤にする。
   実際に 2 回やった: §4.4 の 4 と 5 はどちらも「緑を見た**後**の編集」で混入し、
   5 では**古い実行結果を緑として申告**した(司令官の再検証で発覚・差し戻し 2 回目)。
   緑の申告は、その時点の作業ツリーで
   `OPENGROUND_HOME=$(mktemp -d) HOME=$(mktemp -d) npm test` を回した結果に限る。
5. **`opt-out` env を足さない。** 「CI だけ外したい」が来たら、それは隔離の設計を
   直すべきサイン。
6. **repo ワーキングツリーに何かを作るテストは、`.gitignore` とセットで足す**(§4.11)。
   repo 直下に throwaway を作る正当な理由はある — OS の temp は全て信頼されるので
   「temp ではない home」の証明には使えない — が、**prefix は `REPO_PROBE_PREFIX` を
   使い回す**(宣言は `src/test/repoRootFence.ts` の `export const REPO_PROBE_PREFIX` 1 箇所
   — 実測 2026-07-21 で `:96`)。新しい prefix を足すなら
   `.gitignore` にも足し、check-ignore の teeth をそこまで伸ばすこと。**dirty ツリーは
   swarm 統合を止める**ので、テストの後始末は行儀ではなく契約。作成先は `process.cwd()`
   ではなく `import.meta.url` 起点にする(同スイートに `process.chdir()` する file が居る)。
   **そもそも「作らずに済むか」を先に問う** — §4.13 の MF2 は、実在ディレクトリが要ると
   思い込んでいた probe が、実は文字列だけで足りた例。
   規則を強制するのは 2 層で、**守備範囲が違う**(§4.13):
   - `src/test/repoRootFence.ts` — 毎テスト後に repo 直下を listing 比較。綴り・動詞・
     ファイル位置に**依存しない**(子プロセスの書き込みも見える)。ただし**残ったものしか
     見えない**(1 つの `it()` 内で作って消せば不可視)。
   - `src/testHomeEnvGuard.test.ts` のソース sweep — その「作って消す」窓を狙う**補助**。
     ソースを読む以上**綴りの網羅は原理的に不可能**で、実際に範囲は
     「`.ts`/`.tsx`・`SWEPT_DIRS` 配下・列挙した動詞・第1(または第2)引数の式に
     アンカー名かその別名が出る」だけ。**ここに書いていない綴りは赤くならない。**
7. **teeth を書いたら「これは値を pin したのか、行為を pin したのか」を自問する**(§4.12)。
   値を pin した teeth は、その値を使わない新参者に対して無力で、**しかも緑なので無力だと
   気づけない**。判定法は 1 つ — 「守りたい事象を実際に起こしてみて赤くなるか」。
   §4.11 の teeth はこれを省略したため、書かれた原因である事象そのものを素通しした。
7b. **「クラス級」と書くなら、範囲を実測してから書く**(§4.13)。§4.12 は「行為を pin
   した」と宣言したが、実際には*ある綴り方*を pin しただけで、4 通りの書き換えが素通り
   した。**ソースを読むガードに全称主張は付けられない** — 綴りは無限に作れる。全称を
   主張したければ、値でも綴りでもなく**結果(残骸・実際に起きた副作用)**を見るしかない。
   文書には必ず**守備範囲と、その外側**を書く。

---

## 7. 第2のクラス — テストが**マシンそのもの**を壊す(2026-07-28)

§1〜§6 は「テストがユーザーの**データ**を壊せない構造」だった。この節は同じ
テスト隔離の傘の下にある**別クラス**を扱う: テストが漏らした**実プロセス**が
OS を詰まらせ、**再起動するまで復旧できない**状態にする経路。

### 7.1 事故 — 症状は「claude code が重い」だった

オーナーからの申告は「claude code が重すぎる」。**OPEN GROUND の話ですらなかった**
— 素の Alacritty でも固まり、resume で上げ直しても再発した。実測でこうなっていた:

- `launchd`(PPID=1)を親に持つ **`git` が 41 個**、最長 **5 時間 35 分** 経過、全て
  **U(uninterruptible)状態**。load average ≈ 5。
- 各プロセスの cwd は `og-resume-a-*` / `og-resume-b-*` / `og-overseer-banner-*`
  — つまり **swarm ユニットテストの `mkdtemp` 一時 dir**(既に削除済み)。

指紋になる 1 行(**この節の唯一の診断コマンド**):

```bash
ps -axo pid,ppid,stat,command | awk '$2==1 && $3 ~ /^[UD]/ && /git/' | wc -l
```

0 以外なら該当。**親が launchd なので、OG や claude を再起動しても消えない** —
これが「resume しても直らない」の正体で、アプリ側をいくら疑っても外れる。

### 7.2 因果連鎖(5 段)

1. `swarmOrchestrator.resumeEngines.test.ts` /
   `swarmOrchestrator.overseerReminder.test.ts` が、orchestrator / overseer 経由で
   **本物の git**(`fetch origin`・`for-each-ref refs/heads/swarm`・
   `rev-parse --git-common-dir`・`symbolic-ref`)を **git リポではない**一時 dir で起動する。
2. `resumeEngines()` は最後に `void runEnginePass(engine, deps)` を
   **fire-and-forget** で撃つ(意図的な設計 — boot を待たせないため)。テストの
   assert は数ミリ秒で終わり、**in-flight の pass は誰も待っていない**。
3. `afterEach` の `rm(tempdir, {recursive:true})` が、**git がまだ走っている最中に
   その cwd を消す**。
4. cwd(vnode)を失った git がカーネル内で **U 状態に落ち、二度と戻らない**。
5. 孤児が積み上がり、run queue を詰まらせてマシン全体をフリーズさせる。

### 7.3 なぜ「timeout を付ける」では直らないか(実測)

**この節で一番間違えやすい点。** 対症療法に見える 2 つが**どちらも無効**だと実測で確定した:

- **`execFile` の `timeout` は効かない。** `swarmJanitor.ts` の `GIT_OPTS` は事故当時
  **既に `timeout: 60_000` を持っていた**。それでも 5 時間ハングした。Node は時間が来たら
  kill を送って自分は諦め null を返すが、**実プロセスは wedge したまま**残る。
- **`SIGKILL` も効かない。** PID を 1 つ選んで `kill -9` → **生存を確認**。U 状態の
  プロセスはカーネル syscall から戻らないので、**シグナルが配送されない**。

したがって **timeout を伸ばす / kill で掃除する系の対処は全部ハズレ**。
そして `rm` は timeout より先に勝つので、timeout をいくら短くしても競走に勝てない。

### 7.4 契約(いま保証されていること)

**`.git` を持たない cwd では、swarm は git を spawn しない。**

単一実装 `src/lib/server/gitRepoGuard.ts`:

```ts
export const isGitRepoRoot = (cwd: string): boolean => existsSync(join(cwd, '.git'))
```

これを **swarm 系の全 git ヘルパの冒頭**(`git` / `gitOk` / `gitExit` / `gitOut` /
`branchOfWorktree`)に置き、非リポなら **既存の失敗値**(`null` / `false` /
`'unknown'`)をそのまま返す。適用先 13 ファイル: `activeBranches` / `branchChanges` /
`gitBranches` / `mergedBranches` / `retention` / `reviewWorktree` /
`selfUpdateOnIntegrate` / `swarmIntegrate` / `swarmJanitor` / `swarmOrchestrator` /
`swarmWorker` / `swarmWorkerRegistry` / `worktreeCleanup`。

- **本番の挙動は不変** — 本番の cwd は常に実リポ(プロジェクト / worktree)。
- **既存の失敗時セマンティクスと等価**なので、呼び出し側の分岐は 1 行も変えていない。
- `existsSync` 1 回の stat は、それが防ぐ**プロセス spawn より桁で安い**。

**意図的に非適用の 2 箇所**(ここを「漏れ」と誤認して足すと壊れる):

| 非適用 | 理由 |
|---|---|
| `swarmEnvPreflight` の `git --version` | cwd に依存しない存在確認。リポ判定は無意味 |
| `swarmEnvPreflight` の `rev-parse --is-inside-work-tree` | **git 自身に「リポか」を聞くのが目的**。ガードを付けると聞く前に答えを決めることになる。cwd は登録済みプロジェクト(安定 dir) |
| `youCorpus` の `rev-parse --git-common-dir` / `--show-toplevel` | **任意の cwd から上へ遡上してリポ根を探す**のが仕様。root 限定ガードを付けるとサブディレクトリで誤って null になる |
| `swarmJanitor` / `swarmOrchestrator` の `swarmRepoKey`(`rev-parse --git-common-dir`) | 同上 — ただし**無防備ではなく `isUnderGitRepo` で守る**(下記) |

> **2026-07-29 の追補 — 遡上する呼び出し用の第2の述語 `isUnderGitRepo`。**
> 上の「非適用」を無防備の意味にしないため、遡上が仕様の呼び出しには専用の
> 述語を用意した(`gitRepoGuard.ts`)。**cwd が存在しなければ即 false**(= §7.2 の
> 消えた cwd に spawn しない、という肝心の保護は保つ)うえで、`.git` を上へ探す。
> 純 fs のみで、何も spawn しない。
>
> 適用先は **`swarmRepoKey` の2箇所だけ**(janitor 側 `gitAllowingRepoWalk` /
> orchestrator 側の同名関数)。ここを root 限定にしていたため、**リポの
> サブディレクトリを登録したプロジェクトで心拍ディレクトリ一式(worker 心拍・
> roster.json・manager.json)が丸ごと到達不能**になっていた(= 生きたリポなのに
> エンジンの記憶がゼロ)。
>
> **広げてはいけない。** `isGitRepoRoot` こそが「非リポに git を spawn しない」
> 契約の実体で、便利だからと一般の git ヘルパをこちらに差し替えた瞬間に §7.4 が
> 崩れる。実際 `swarmSelfSupply.test.ts` の歯(サブディレクトリでは `[]`)が赤く
> なるので、逸脱は自動で気づける。

### 7.5 teeth — 「守りたい事象を起こして赤くなるか」

§6-7 の掟どおり、**値ではなく結果(実際の副作用)**を見る。手順:

```bash
# 1) 実行前の孤児数を数える
ps -axo pid,ppid,stat,command | awk '$2==1 && $3 ~ /^[UD]/ && /git/' | wc -l
# 2) 事故を起こしていた 2 ファイルを回す
npx vitest run src/lib/server/swarmOrchestrator.resumeEngines.test.ts \
               src/lib/server/swarmOrchestrator.overseerReminder.test.ts
# 3) 「実行中に新しく git が生まれたか」を etime で見る(数分台のエントリが在れば漏れている)
ps -axo etime,stat,pid,command | grep -w git | grep -v grep | sort | head
```

2026-07-28 の実測: 38 tests pass、**etime の最短が実行時刻よりはるかに古い**
= 新規 spawn ゼロ。ガードを外せば同じ手順で数分台の `U` が湧く(= 赤くなる)。

> **注意**: この teeth は **プロセス表を見る**ので、他のテストや作業が同時に git を
> 回していると読み違える。孤児が既に溜まっている環境では **実行前後の差分**で見ること
> (総数は再起動するまで減らない)。

### 7.6 守備範囲と、**その外側**(§6-7b)

**これは予防であって、掃除ではない。**

- **既に U 状態に落ちた孤児は、このガードでは 1 個も消えない。** OS 再起動が唯一の
  手段(sudo でも不可)。事故当日も、修正の実証と再起動は**別作業**として扱った。
- **リポ根限定。** 見ているのは `<cwd>/.git` だけなので、**サブディレクトリを cwd に
  渡す呼び出しには使えない**(だから `youCorpus` は非適用 = §7.4 の表)。swarm の cwd が
  常にリポ根(プロジェクト / worktree)であることに依存している — その前提が崩れる
  呼び出しを足すなら、このガードは付けられない。
- **git 以外の子プロセスは無防備。** 同じ「cwd を消されて U 状態」は原理的に
  `tsc` / `lint` / `vitest` / `claude` PTY でも起こりうる。今回塞いだのは git だけ。
  → **2026-07-29 に一部前進**: OG 自身の撤去パスが作っていた分は塞いだ(§7.8)。

### 7.8 自分の撤去パスが同じ wedge を作っていた(2026-07-29)

§7.2 は「テストが cwd を消す」話だったが、**本番の撤去パスが同じことをしていた**。
共通の誤りは1つ — **シグナルを送ったことを、プロセスが死んだこととして扱っていた**。

`node-pty` の `kill()` は `process.kill(pid,'SIGHUP')` を投げて即 return し、
`finishedAt` は非同期の `onExit` が後から刻む。呼び出し側はその**次の行**で破壊操作を
していた:

| 場所 | 破壊操作 | 直し方 |
|---|---|---|
| `swarmWorker.removeSwarmWorktree` | `git worktree remove` | `killTerminalsByCwdAndWait` で死を確認。**確認できなければ撤去を拒否**して次回に回す |
| `canvasAi`(生成 / tweak の2箇所) | 一時 dir の `rm -rf` | 同上(こちらは最終的に削除する — tmp を永久リークさせないため) |
| `swarmOrchestrator.defaultRecoverWorker` | WIP 保全の `git add -A` | `waitForTerminalGone`。待たないと**半端な木をスナップショット**し、claude の git と `index.lock` を奪い合う |

**なぜ「シェルの pid が消えるのを待つ」のが正解か(実機計測 2026-07-29,
node-pty 1.2.0-beta.14 / darwin)**:

- PTY 直下の `zsh -l` はセッションリーダ(pid == pgid == sid)だが、**zsh の
  ジョブ制御で前景ジョブは自分のプロセスグループを持つ**。したがって
  `process.kill(-ptyPid, …)` は**シェルにしか届かず claude には届かない**。
  node-pty 側に pgid kill も無い。
- 実際に子孫へ届いているのは**カーネル**。セッションリーダが死ぬと制御端末の
  前景プロセスグループへ SIGHUP が飛ぶ(実測: zsh 配下の孫 `sleep` が消えた)。
- ゆえに **シェルの pid がプロセステーブルから消えたこと**が、カーネルが子孫に
  ハングアップを配送した証拠になる。待つべきはこれ。
- **負の pid への kill は採らない** — 届かないうえ、pid 再利用で無関係な
  グループを撃つ危険がある。
- **セッションを抜けたもの(`nohup … & disown` / `setsid`)には原理的に届かない**
  (実測: ppid=1 で永久生存 = §7.1 の孤児と同じ形)。契約は正直に
  「**PTY とその前景子孫まで**」と書く。

待機はすべて上限付き(既定5秒)で、中間で1度だけ SIGKILL に格上げする
(SIGKILL でも「制御プロセスの終了」なので前景グループへの SIGHUP は同様に飛ぶ)。

**同時に塞いだ増殖経路**: `spawnSwarmWorker` は「worktree 作成より前で fail-closed
だから孤児は残らない」と2箇所のコメントで宣言していたが、`launchClaude` だけが
その**外**にあった。throw すると worktree と `swarm/*` ブランチが残り、
`runDispatchPass` にバックオフが無い(3秒 tick・catch して continue)ため
**1つの恒常的な失敗が3秒ごとの worktree+ブランチ生成に化けた**(自動で回収する
機構も無い)。現在は try/catch で、**この呼び出しが作った分だけ**を撤去する
(RESTART パスの既存 worktree は絶対に触らない)。
- **fire-and-forget そのものは残っている。** テストは今も in-flight pass を待たない
  (§7.2-2 は設計として正しい)。**git を掴まなくなっただけ**なので、実リソースを掴む
  dep を新しく足せば**同じクラスが再発する**。新しい dep を足すときは
  「テスト終了後に走り続けても安全か」を必ず自問する。

### 7.6b 検知(2026-07-28 追加)— 気づくまでの5時間半を閉じる

§7.6 のとおり**掃除はできない**。できるのは**早く気づくこと**で、そこが今回いちばん
高くついた(修正は分かれば速かった。高かったのは「何かおかしい」→「原因はこれ」の距離)。

`src/lib/server/stuckProcessWatch.ts` が **10 分ごと**にスキャンし、
**孤児(PPID=1) × 中断不能(U/D) × 一定時間経過**の 3 条件を満たすプロセスが
`STUCK_MIN_COUNT`(3)以上あれば info 通知(`event:'stuck-processes'`)を上げる。

> **boot 1 回では見えなかった(2026-07-29 に定期化)。** 初版は起動時に 1 回だけ
> 走らせていたが、**起動直後こそ数がいちばん少ないことが保証される瞬間**で、
> 孤児は**アプリが動いている間に**溜まる(テスト実行のたび・回収のたび)。
> 1 回きりの検査は「昨日のニュース」を報告してその後セッション中ずっと盲目になる
> — 実際、0728 の事故(数時間の稼働で 41 個)は初版では**捕まえられなかった**。
> 再通知は**増えたときだけ**(`STUCK_RENOTIFY_MS` = 6 時間)。集合は再起動まで
> 減らないので、毎回鳴らすと「無視する習慣」を育ててしまう。
> 停止スイッチ: `OPENGROUND_STUCK_WATCH=0`。

- **報告専用**。掃除アクションは**意図的に置かない** — 消す方法が存在しない(§7.3)以上、
  「直そうとして毎回失敗するのに成功したように見える」コードにしかならない。
- **1 条件だけを見る**。ディスク/メモリ/温度は見ない — 健康ダッシュボードではなく、
  「OG 自身が作りうる × 静かに劣化する × 対処が再起動ただ一つ」の状態だけを見る。
- **閾値の根拠**: 年齢 10 分(数秒の D 状態はただのディスク待ちで正常)。個数 3(1〜2 個は
  実測で体感ゼロ。かつ野外の唯一の誤検知候補 —— 切断された SMB/NFS 共有 —— を吸収する)。
- **privacy**: `comm`(実行ファイル)だけを読む。`command`(argv)は worker のプロンプト全文を
  抱えているので通知に載せない。
- **Windows は no-op**(`ps` と U 状態は Unix の概念)。
- 文言はオーナー基準の平易文(「動かなくなった処理が N 個…再起動すると消えます」)。
  **kill を勧めない**ことをテストで pin してある(効かないと実測済みだから)。

**孤児を作らない側も同日に塞いだ**: `gateProcess` は fork プール(vitest/eslint)を
グループ kill するため `detached: true` で spawn する — これは**必要で外せない**が、
代償として**子はサーバより長生きする**。detached な子はこちらのプロセスグループに
居ないので、サーバが死んでも何も届かない(終了シグナルも 'close' も `settle` も
`reapGroup` も)。統合ゲートの `vitest run` が自分のエンジンより長生きし、その
worktree が撤去されれば §7.2 の wedge を新規生産する。現在は**実行中のグループを
登録**しておき、`installGateGroupReaper()`(本番エントリからのみ設置)が
`exit` / `SIGTERM` / `SIGINT` で一括 SIGKILL する。**サーバ自身の SIGKILL は
捕捉不能なので構造上カバー外** — その残余がまさに検知の担当。

teeth: `stuckProcessWatch.test.ts`(21 件)が判定を**壊れたマシンを再現せずに**全部押さえる
(事故当日の ps 出力をテキストとして再生)。`npx tsx scripts/probe-stuck-process-watch.mts` は
「今は黙る / 当日のテーブルなら鳴る」を 1 コマンドで実証する。
なお `findStuckProcesses` の「健全なら git はゼロ」ケースは **gitRepoGuard の回帰 teeth**
でもある — スイートを回して赤くなったら、また何かが子プロセスを漏らしている。

### 7.7 掟(§6 への追補)

8. **swarm から新しく git を呼ぶときは `isGitRepoRoot` ガードを通す。**
   例外を作るなら §7.4 の表に 1 行足して理由を書く(黙って外さない)。
9. **「重い / 固まる」の申告が来たら、アプリを疑う前に §7.1 の 1 行を打つ。**
   OG も claude も無実で、犯人が過去のテストの残骸ということがある。
10. **U 状態を見たら kill を試さない。** 時間の無駄だと実測済み(§7.3)。
   予防はコード側、復旧は再起動、と割り切る。
