# OPEN GROUND セキュリティ監査 — 外部エグレス経路の全数調査と業務利用判断材料

- **監査対象**: OPEN GROUND 0.11.27(commit `a64c8cc` 時点のソースツリー)
- **監査日**: 2026-07-14
- **監査方法**:
  1. **コード全数調査** — src/ server/ electron/ scripts/ worker/ supabase/ を領域別に7エージェントで並列全数列挙し、その結果に対して**独立した2本の grep 網**(API 面 / URL 面)で「列挙に漏れがあること」を証明しにいく敵対的検証をかけた。→ この敵対的検証が実際に**列挙漏れを1件発見**した(§8-9b のアバター CDN 経路。領域別の7本は全員見落としていた)。
  2. **実測** — 出荷相当ビルド(`npm run build` → `node server/dist/index.cjs`)を隔離 HOME で起動し、プロセスツリーの全ソケットを lsof ポーリング + nettop + ブラウザのネットワークログでキャプチャ。
  3. **サプライチェーン** — package-lock.json 全 776 パッケージの resolved ホスト・telemetry SDK・postinstall チェーンを検査。
- **位置づけ**: **read-only 監査**。発見した問題は §8 に列挙するのみで、本監査では一切修正していない(修正は別カードの起票材料)。
- **重要な検証**: §8-1(最重要の発見)は、報告した2エージェントとは独立に、監査担当が **コード経路を端から端まで自分で再確認** した(`BoardModule.tsx:385` → `RealtimeContext.tsx:135-166` → `collab.ts:244` → `projectMembers.ts:757` → `BoardModule.tsx:414` の各リンクを実コードで確認)。
- **棄却した報告**: 調査エージェントの1体が「カードを作成しただけでタイトルが Anthropic へ自動送信される」と high 判定で報告したが、**再確認の結果これは誤り**だった — `task-title` の呼び出し元は「実行」ボタン(タイトル未設定時のみ)と明示的な「✦ 再生成」ボタンの2箇所だけで、カード作成では発火しない(`BoardModule.tsx:488,555`)。実行ボタンは元より本文を Anthropic へ送る操作なので、追加の露出は無い。本レポートには**自分で裏取りできた事実だけ**を記載している。

---

## 0. 要約 — 業務利用の可否判断

**アプリにサインインしていないデフォルト状態で、OPEN GROUND が「ユーザーの操作なしに」外へ出す通信は3本だけ**である — GitHub のアップデート確認(起動時+4時間毎)、Google Fonts(ウィンドウを開くたび)、そして claude の起動前プローブ(サーバ起動のたび、固定文字列1発)。**いずれにも業務データは載らない**。加えて、ユーザーが claude を使えば当然その内容は Anthropic に出る(§7 — 製品の本質)。

隔離 HOME での実測では、**サーバプロセスからの外部接続はゼロ**だった(未ログインなら Supabase / Cloudflare へは一切出ない = fail-closed をコードと実測の両面で確認)。ただし実測環境には `claude` が存在しなかったため、上記の起動時プローブは発火していない — **claude がインストール済みの実機では、アプリを起動しただけで Anthropic への呼び出しが1回発生する**(§2.2 の注記)。

しかし業務導入にあたって、**先に必ず理解しておくべき事実が2つ**ある。

**(1) アプリログインには「共有」の副作用がある(§8-1・最重要)**
出荷版 .app でアプリにサインインすると、**共有ボタンを押さなくても・同意ダイアログを見なくても**、開いたプロジェクトの Board / Canvas の中身(タスクのタイトル・本文・ノート・付箋・mock のソース)が運営者の Cloudflare インフラへ自動的にアップロードされ、永続保存される。ログインは「任意機能」と説明されているが、実際には**そのプロジェクトのデータをクラウドに載せるスイッチ**として機能している。しかもクラウド側に削除経路が存在しない(§8-2)。

> **業務 Mac での必須の緩和策**: **アプリにサインインしない**。ログインは機能を何もゲートしていないため、サインインしなくても Board / Canvas / ターミナル / swarm はすべて動く。より強く止めるなら、`.app` 内の `Contents/Resources/app/electron/runtime-config.json`(asar 無しなので編集可)を `{}` にすれば collab・ログイン・フィードバックがまとめて無効化される。

**(2) claude に読ませた業務コードは Anthropic に送られる(§7)**
これは OPEN GROUND ではなく **Claude Code 自体の性質**であり、遮断対象ではなく前提条件。業務導入の可否は、まず**会社の Claude 利用契約(商用データの取り扱い・保持・学習利用)の確認**で決まる。

上記2点を運用で管理できるなら、OPEN GROUND 自体は「ローカル単一ユーザーのコックピット」という設計どおりに振る舞う。ローカル面(127.0.0.1 のみバインド・LAN 非露出)も実測で確認した。ただしループバック API は**呼び出し元認証を持たない**ため、同一マシンで動く他プロセスからは事実上すべての操作(PTY 起動 = 任意コマンド実行を含む)に到達できる(§3・§8-3)。共用 Mac や不審なソフトが同居する端末では、これがローカル面の最上位リスクになる。

---

## 1. データフロー一覧表(外部エグレス経路の全数)

判定基準: **このマシンの外へパケットが出る経路のみ**。`127.0.0.1` 宛(アプリ内 loopback API・SSE)は egress ではないので除外。「自動」= ユーザーの明示操作なしに発火するもの。

### 1-A. デフォルト状態(未ログイン・共有なし)で発火するもの

| # | 宛先 | 送信されるデータ | 契機 | 自動 | 無効化方法 | コード |
|---|---|---|---|:--:|---|---|
| 1 | **api.anthropic.com**(`claude` CLI 子プロセス) | **claude に渡した全て** — プロンプト、タスクのタイトル+本文、claude が読んだ業務コード、ツール実行結果 | ターミナルで claude 起動 / Board の「実行」/ カード説明の自動生成 / Canvas AI / swarm dispatch | 操作依存 | **不可**(製品の本質)。使わない以外にない | `claudeTerminal.ts`, `swarmLaunch.ts`, `canvasAi.ts`, `generateDescription.ts` |
| 2 | **api.anthropic.com**(同上・**起動時に自動**) | 固定文字列のみ(`reply with exactly: PROBE_OK`)。業務データなし | **サーバ起動のたび自動**(tier プローブ / `claude --model <tier> -p`)。claude ログイン済みかつ判定未キャッシュ時 | ✅ | 設定なし。claude 未ログインなら走らない | `server/index.ts:79`(`warmTierProbeAtBoot`), `swarmTierProbe.ts:110` |
| 2b | **ユーザーが設定した MCP サーバ**(任意ホスト) | claude が MCP ツールを呼べば、そのツールの宛先へ**任意のデータ**が出る。宛先はユーザーの `~/.claude.json` / プロジェクトの `.mcp.json` 次第 | **対話ターミナルと Board「実行」の claude セッション**。これらは `--strict-mcp-config` を付けないため、ユーザー設定の MCP サーバを読み込む | 操作依存 | `~/.claude.json` の `mcpServers` を空にする(アプリ側からは抑止できない)。※ swarm worker / 自動生成系(タイトル・説明・Canvas AI・skill)は `strictMcpConfig: true` で MCP を遮断済み | `claudeTerminal.ts:74-83,336`, `terminal.ts:208`(strict 指定なし) vs `swarmWorker.ts:444`, `generateTaskTitle.ts:123` |
| 2c | **api.anthropic.com**(カードの説明・タイトルの自動生成) | 説明生成: **README / package.json / ディレクトリ構成**。タイトル生成: そのカードの本文 | 説明生成 = カードの説明を生成する操作。タイトル生成 = **「実行」ボタン押下時**(タイトル未設定のカード)または「✦ 再生成」ボタン。**カードを作成しただけでは飛ばない**(実測: 呼び出し元は2箇所のみ) | ❌ | 該当機能を使わない | `generateDescription.ts:163`, `generateTaskTitle.ts:112`, `BoardModule.tsx:488,555` |
| 3 | **api.anthropic.com**(同上・`/usage` スクレイプ) | 固定操作のみ(使用量画面の読み取り) | UsageHud が `GET /api/usage` を叩くたび claude を PTY spawn | ✅ | HUD を無効化する設定はない | `claudeUsageCli.ts:15`, `misc.ts:374` |
| 4 | **github.com / objects.githubusercontent.com**(electron-updater) | GET のみ(IP・UA `electron-builder`・リポジトリパス)。**新版検出時はバイナリを無確認で自動ダウンロード**(適用のみ手動) | **出荷版 .app の起動直後 + 以後4時間毎に自動** | ✅ | **アプリ内に opt-out なし**。FW/プロキシで github.com を遮断(失敗は非致命でアプリは正常動作) | `electron/main.js:1671`(`AUTO_UPDATE_INTERVAL_MS = 4h`), `:1674`, `package.json:108` |
| 5 | **fonts.googleapis.com / fonts.gstatic.com** | GET のみ(IP・UA・フォント名)。業務データなし | **アプリのウィンドウを開くたびに自動**(index.html の `<link>`) | ✅ | **設定なし**。index.html:24-27 を削って再ビルド、または FW 遮断(フォールバックフォントで動作継続) | `index.html:24-27`, `dist-web/index.html:24` |
| 6 | **api.github.com**(サーバ側 fetch) | GET のみ(IP・Accept ヘッダ)。10分キャッシュ | 設定パネルを開いた時(`/api/release-notes`)。`/api/update/check` は現状 SPA から呼ばれていない(dormant) | ❌ | 設定を開かない。遮断してもエラー表示のみ | `misc.ts:429`, `misc.ts:476` |
| 7 | **unpkg.com / cdn.tailwindcss.com** | GET のみ(IP・UA)。**取得した JS が iframe 内で実行される**(mock のソース自体は srcdoc でローカル) | Canvas の **mock(React)/ screen 要素を描画した瞬間**に自動 | ✅ | mock/screen 要素を使わない。設定なし | `mockSrcdoc.ts:79-81`, `screenSrcdoc.ts:363,383,387` |
| 8 | **ユーザー自身の git remote**(`git push` / `fetch`) | **コミットの内容(= 業務コード)**。宛先はユーザーが設定した origin | swarm の統合(`swarmIntegrate`)。**swarm 自律運転を ON にすると無人で push される**(既定 OFF・owner のみ起動可・`--force` は不使用・remote trunk が無ければ skip)。ほかに レビュー worktree 準備の `git fetch`、カードの完了フローを `pr` にした場合の claude 自身による `git push` + `gh pr create`(既定は `merge` = ローカル統合) | 自律 ON 時✅ | swarm 自律運転を起動しない / 完了フローを `pr` にしない | `swarmIntegrate.ts:288,339`, `swarmOrchestrator.ts:2685`, `taskPrompt.ts:72`, `swarmJanitor.ts:264` |
| 8b | **ログインシェルの rc 依存**(間接) | OPEN GROUND 自身は何も送らないが、PTY 起動のたびに `zsh -l` が走るため、ユーザーの `~/.zshrc` / `~/.zprofile` に外部通信する処理があればそれが実行される | 全 PTY 起動 + Electron の PATH 解決(`zsh -lic`) | ✅ | ユーザーの rc 側の問題(`OPENGROUND_TERMINAL_SHELL` でシェル差し替えは可) | `terminal.ts:249`, `electron/main.js:262` |
| 9 | **api.github.com**(`gh` CLI 子プロセス) | 認証済みトークンで PR メタデータ照会 | `GET /api/gh-status`、カードの PR 情報取得(`gh pr view`) | 操作依存 | PR 連携機能を使わない | `ghCli.ts:32`, `prInfo.ts:98` |

### 1-B. **アプリにサインインすると発火するもの**(ログインは任意だが、その副作用が §8-1)

| # | 宛先 | 送信されるデータ | 契機 | 自動 | 無効化方法 | コード |
|---|---|---|---|:--:|---|---|
| 10 | **tlyicnxiitfoxzvojwhy.supabase.co** `/auth/v1/*` | PKCE 認可コード+verifier、refresh トークン。受信したトークン・メール・表示名・アバターURL を `~/.openground/auth.json`(0600)に保存 | 「Sign in」押下時。以後は**トークン失効前に自動リフレッシュ** | 一部✅ | サインインしない / `runtime-config.json` を空に | `auth.ts:209-247`, `supabaseAuth.ts:84-144` |
| 11 | **Supabase** `/rest/v1/og_projects` + `og_project_members`(**INSERT**) | owner uid、`sha256(uid + ':' + 絶対パス)`(**生パスは送らない**)、**自分のメールアドレス** | **⚠️ サインイン済みでプロジェクトの Board か Canvas タブを開いただけ**。共有ボタン・同意ダイアログは不要 | ✅ | サインインしない / `OPENGROUND_REALTIME=0` | `collab.ts:244`, `projectMembers.ts:757`, `RealtimeContext.tsx:135-166` |
| 12 | **og-collab.mindbrew.workers.dev** `/ticket`(HTTPS) | **ユーザーの Supabase access トークン(JWT・メール入り)** を運営者の Worker へ server-to-server 中継(~60秒 TTL のチケットを発行してもらう) | 上記と同じ契機。再接続のたび | ✅ | 同上 | `ticket.ts:75-115` |
| 13 | **wss://og-collab.mindbrew.workers.dev**(Cloudflare Durable Object) | **⚠️ Board 全文**(全タスクのタイトル・本文・ノート・説明)+ **Canvas 全要素**(付箋・テキスト・mock/screen のソース)。**presence でログインメールアドレス全文**を同室にブロードキャスト。Worker 側は Y.Doc 全体を DO の SQLite に**永続保存** | 同上。以後はサーバ側 `collabMirror` が**タブを閉じても全書込を自動追随** | ✅ | 同上 | `RealtimeContext.tsx:178-204`, `BoardModule.tsx:414`(`collab.seed(dataRef.current)`), `collabMirrorCore.ts:342-373`, `worker/src/OgCollabDoc.ts:49-69` |
| 14 | **og-collab.mindbrew.workers.dev** `/assets/*` → Cloudflare **R2** | **Canvas に貼った画像の生バイト列**(1枚最大10MB) | 共有 Canvas に画像がある間、自動アップロード(sweep) | ✅ | 同上 / Canvas に画像を置かない | `assetSync.ts:19-36`, `collab.ts:852-898` |
| 15 | **Supabase** `/rest/v1/og_project_members`・`og_projects`・`og_project_invites`(**ポーリング**) | 認証済み読み取り。受信: 自分が属するプロジェクトのロスター(他メンバーのメール)・招待 | サインイン+collab 有効時に**5分毎+フォーカス毎に自動** | ✅ | サインインしない | `App.tsx:280-288`, `projectMembers.ts:189-224` |
| 16 | **Supabase** `/rest/v1/og_roles` | ユーザーの JWT(uid/メール)。受信はロールのみ | サインイン済みでカスタムタブのロール解決時(5分キャッシュ) | ✅ | サインインしない / `OPENGROUND_OWNER_EMAILS` 設定で照会スキップ | `roles.ts:81-134` |
| 16b | **lh3.googleusercontent.com / avatars.githubusercontent.com**(= OAuth プロバイダのアバター CDN。厳密には Supabase の `user_metadata` が指す**任意のホスト**) | 画像 GET(IP・UA)。**Toolbar 側の `<img>` は `referrerPolicy` 未指定 = Referer も送出**(AccountModal 側だけ `no-referrer` が付いており非対称) | **サインイン済みならウィンドウを開くたび自動** — Toolbar のアカウントボタンが `<img src={user.avatarUrl}>` を無条件に描画する | ✅ | サインインしない。CSP は無く、`isAllowedOauthUrl` のような allowlist 検証も通らない | `Toolbar.tsx:315-321`, `AccountModal.tsx:58-64`, `supabaseAuth.ts:68`, `auth.ts:268` |
| 17 | **Supabase** collab 管理系の書込(招待・メンバー削除・共有名 など) | 招待相手のメールアドレス、招待コード(256bit)、共有名 | オーナーの明示操作のみ(同意チェック後に解禁) | ❌ | 共有機能を使わない | `collabInvites.ts:106-150`, `collab.ts:377-668` |

### 1-C. ユーザーの明示操作でのみ発火するもの

| # | 宛先 | 送信されるデータ | 契機 | 自動 | 無効化方法 | コード |
|---|---|---|---|:--:|---|---|
| 18 | **Supabase** `/rest/v1/feedback`(INSERT) | フィードバック本文・任意入力のメール・**添付スクリーンショット最大6枚(base64)** + サーバが付加するアプリ版・OS・登録プロジェクト数。**未サインインでも送信可**(anon key) | フィードバックフォームの送信ボタン | ❌ | 使わない。スクショに機密画面が写り込む点に運用注意 | `feedback.ts:270-319` |
| 19 | **Supabase** `/rest/v1/og_custom_modules` / `og_module_submissions` | 公開/提出時: **モジュールのソースコード全文** + 提出者メール | マーケットプレイスの公開/提出ボタン(owner/tester ロールのみ UI 表示) | ❌ | 使わない | `customModulesSubmissions.ts:97-114` |
| 20 | **Supabase authorize / accounts.google.com / github.com**(OS ブラウザ) | OAuth authorize URL(PKCE challenge 等)。認証自体はアプリ外のブラウザが担う | 「Sign in」のプロバイダボタン | ❌ | サインインしない | `electron/main.js:491-513`(https + allowlist 強制) |
| 21 | **任意ホスト**(カスタムタブ/マーケットのモジュール JS) | そのタブ内でユーザーが入力した内容・IP/UA(モジュール作者のコード次第) | マーケットからインストールしたカスタムタブを開いている間 | モジュール依存 | マーケットからインストールしない | `CustomFrameHost.tsx:282`(`sandbox="allow-scripts"`、ネットワーク制限なし) |
| 22 | **anthropic.com / claude.ai:443**(egress プロキシ経由) | claude の TLS トラフィックを Hono が CONNECT 中継(中身は不可視)。**allowlist 2ドメイン・443・CONNECT のみ・127.0.0.1 バインド** | swarm 監督ノード(overseer brain)を owner が起動した構成でのみ。既定では起動しない | ❌ | swarm 自律機能を使わない(再起動で必ず OFF) | `egressProxy.ts:30,86-125` |

### 1-D. ビルド/インストール時のみ(エンドユーザーの .app 利用では発生しない)

| 宛先 | 契機 | 備考 |
|---|---|---|
| registry.npmjs.org | `npm install` / `npm ci` | lock の resolved **775件すべてこのホスト**。npm audit で依存グラフが送られる(`--no-audit` で抑止可) |
| github.com(git clone: `electron/node-gyp`) | 同上 | **lock 内で唯一の非 registry 依存**(commit ハッシュ固定) |
| github.com/electron/electron/releases | 同上(electron バイナリ ~90MB) | `ELECTRON_MIRROR` で社内ミラー可 |
| electronjs.org/headers | postinstall(`electron-builder install-app-deps` が node-pty を再ビルド) | `~/.electron-gyp` に事前配置でオフライン化可 |
| electron-builder-binaries / registry(自バージョン照会) | `npm run dist`(配布ビルド時のみ) | `NO_UPDATE_NOTIFIER=1` で照会抑止 |
| Apple notary service | `npm run dist`(署名・公証) | リリース作業機のみ |
| **開発用スクリプトの手動実行** | `scripts/sandbox-probe.ts`(到達性テスト: api.anthropic.com / example.com)、`scripts/overseer-brain-smoke.ts`(**実 claude を1回呼ぶ** — スクリプト自身が "COSTS ONE SUBSCRIPTION CALL" と明記)、`scripts/dump-board-room.mjs` / `watch-board-room.mjs`(collab Worker へ WS 接続して Board の中身を読む) | いずれも開発者が明示的に叩いたときのみ。**アプリの利用では発生しない** |

### 1-E. **git-shared モード(Share via Git)— この版には存在しない**

ゴールの指示で表に含めるよう求められたが、**この機能は現行 0.11.27 では削除済み**である。

- `src/lib/server/shareEvac.ts` が旧機能の**一方向の退避処理**として残っているだけで、`gitShare.ts` / `sharedData.ts` / `server/routes/share.ts` はいずれも**存在しない**(`/api/project/share/*` ルートもゼロ)。
- したがって現行版では、**Board / Canvas のデータがユーザーのリポジトリに書き込まれることも、会社の git リモートへ push されることもない**。per-project データは常に `~/.openground/projects/<uuid>/` に中央保管される。
- 旧バージョンで共有を有効化していた場合、リポジトリ内に `.openground/` ディレクトリが残っている可能性がある。shareEvac は中央ストアへコピーし直すだけで**そのディレクトリを削除しない**(git 追跡下のファイルを勝手に消して作業ツリーを汚さないため)。git 追跡されていたなら、その中身は**すでに会社のリポジトリに push 済み**の可能性がある — 旧ユーザーは履歴を確認すること。
- ⚠️ **`CLAUDE.md` は git-shared モードを現役機能として記述しており、実装と食い違っている**(§8-9)。

---

## 2. 実測(隔離 HOME + 出荷相当ビルド)

### 2.1 方法

- **ビルド**: worktree(0.11.27)で `npm run build`。出荷 .app が Electron から fork するのと**同一のサーバ bundle**(`server/dist/index.cjs`)+ 同一の `dist-web/` を直接起動。
- **隔離**: `env -i HOME=<隔離dir> PATH=<最小> PORT=479xx node server/dist/index.cjs`。**本番 `~/.openground` / `~/.claude` には一切触れていない**(起動ログで hooks/skill の書込先が隔離 HOME 配下であることを確認済み)。
- **観測**: サーバのプロセスツリー(node + 全子孫)のソケットを lsof で 0.3 秒間隔ポーリング + ps スナップショットでツリー再構成、nettop で累積バイト数、ブラウザ側は Chrome のタブ単位ネットワークログ。
- **2条件**:
  - **条件A(credential-free)**: 素の起動(`SUPABASE_*` なし)。自前ビルド相当。
  - **条件B(出荷相当)**: 配布 .app と同じく `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `OPENGROUND_REALTIME=1` / `OPENGROUND_COLLAB_WS_URL` を env 注入(`electron/main.js` が `runtime-config.json` から行う注入の再現)。**未ログイン**。
- **操作シナリオ**(両条件共通): 起動(boot 窓を4秒観測)→ SPA 配信取得 → プロジェクト import → Board カード追加 → Ground canvas 書込 → PTY(`zsh -l`)起動・入力・終了 → auth/collab/feedback の config 取得。条件B ではさらにブラウザで SPA を開いて自動発火リクエストを記録し、`/api/update/check` を明示実行(**陽性対照** — 観測手法が実際に外部接続を捉えられることの確認)。

### 2.2 結果

| 条件 | 観測された外部接続 | 判定 |
|---|---|---|
| **A: credential-free、boot〜全操作** | **ゼロ**(node は `127.0.0.1:47901 LISTEN` のみ。子孫の `zsh` はソケットを1本も持たない) | 列挙と一致 |
| **B: 出荷相当 env、未ログインで全操作** | **ゼロ** | 列挙と一致。**Supabase 設定が焼かれていても、サインインしない限り接続は起きない**(`/api/collab/config` → `{enabled:false}`、`/api/auth/session` → `{user:null}`)= fail-closed をコードと実測の両面で確認 |
| **B: `/api/update/check` 明示実行** | `api.github.com`(観測時 `20.27.177.116:443`)へ TLS 1本 | 列挙済み経路の実証(陽性対照 — 観測手法が機能している証明を兼ねる) |
| **B: ブラウザで SPA を開く** | `fonts.googleapis.com` + `fonts.gstatic.com`(woff2 ×3)。**それ以外の全リクエストは 127.0.0.1 宛**(`/api/experiments`, `/api/auth/config`, `/api/collab/config`, `/api/settings`, `/api/projects`, `/api/usage`, `/api/custom-modules` ほか) | Google Fonts は**当初の既知起点リスト(Anthropic/GitHub/Supabase/Cloudflare)に無かった経路**で、実測が先に発見しコード調査で根拠(`index.html:24-27`)を確定した。※未ログインのため、アバター CDN(§8-9b)は発火していない |

**突合結論**: 実測で観測された外部接続はすべて §1 の表で説明できる。**表にない未知の接続はゼロ**。

> ⚠️ **実測の限界1 — `claude` が実測環境に存在しなかった**: 隔離環境の PATH に `claude` が無かったため、**起動時の tier プローブ(§1-A #2)と `/api/usage` の CLI スクレイプ(#3)は発火していない**(`GET /api/usage` の応答が 24ms = claude を spawn していない証拠。実機なら約9秒かかる)。つまり「サーバプロセスからの外部接続ゼロ」という実測値は、**claude 由来の egress を除いた値**である。claude がインストール済み・ログイン済みの実機では、**アプリを起動しただけで Anthropic への呼び出しが1回発生する**。この経路はコードで確認済み(`server/index.ts:79`)。
>
> ⚠️ **実測の限界2 — サインイン後は未実測**: §1-B / §8-1 の挙動は、監査担当がユーザーの認証情報でログインすることを避けたため**コード解析でのみ確認**した(経路は端から端まで実コードで追跡済み)。導入判断でサインインを許可する場合は、実機で `lsof` / Little Snitch による確認を推奨する。

### 2.3 ローカル面の実測

- **LAN 非露出**: LAN インタフェース(`en0` = 192.168.x.x)のアドレスへ同ポートで接続 → **即時 connection refused**。`server/index.ts:26` の `HOSTNAME = '127.0.0.1'` 契約を実測で確認した。
- **隔離 HOME に生成されたファイルのパーミッション**:
  - `~/.openground/settings.json`(全プロジェクトの絶対パス)= **0644**
  - `~/.openground/projects/<uuid>/tasks.json`(**タスクのタイトル・本文**)= **0644**
  - `~/.openground/canvas.json` = **0644**、ディレクトリ = 0755
  - → **同一 Mac の別ローカルアカウントから読める**(§8-4)。
  - 一方 `auth.json`(Supabase トークン)は **0600 + 書込のたび chmod 再適用**、`you-corpus.md` も 0600、escalations は 0600/0700 と、**機微度に応じて正しく使い分けられている**(タスク本文と設定だけが保護から漏れている)。
- **本番非接触の確認**: hooks(`~/.claude/settings.json`)と og-manage スキルの**起動時自動インストール**は、隔離 HOME 側に書かれた(HOME を基準に解決されることを確認)。
- **コマンド履歴の残留**: PTY(`zsh -l`)で打ったコマンドは `$HOME/.zsh_history` に残る(zsh の性質だが、機密コマンドの残留面として記録)。

---

## 3. ローカル攻撃面

### 3.1 バインドと LAN 露出 — 良好

- `server/index.ts:26` — `127.0.0.1` 固定バインド。`0.0.0.0` へのバインド箇所は全コードでゼロ。ポート衝突時は auto-increment せず**失敗して落ちる**(単一インスタンス契約)。実測でも LAN からは到達不能。

### 3.2 ループバック API の認証 — **認証は無い**(要理解)

- **クロスオリジン防御はある**: `server/app.ts:55-70` が **POST/PUT/PATCH/DELETE** に対し、Origin が非ループバックなら 403、Host が非ループバックなら 403(DNS リバインディング対策)。→ **悪意ある Web ページからの書き込みは防がれる**。
- **しかし GET は素通し**(`app.ts` の guard は状態変更メソッドのみ検査)。GET にループバック検証を持つのは `youCorpus` ルートだけで、他は無防備。DNS リバインディングが成立すると、悪意あるページが `GET /api/settings`(全プロジェクトの絶対パス)、`GET /api/project/file-diff`(**リポジトリのソース差分そのもの**)、`GET /api/project`(タスク本文)、`GET /api/auth/session`(メール)などを**読み取れる**(§8-3)。
- **呼び出し元認証は存在しない**: `terminal` / `project` / `canvas` / `misc` の各ルーターにセッション検査はゼロ(owner ゲートがあるのは swarm / collab / customModules / feedback / moduleSubmissions のみ)。**同一マシンで動く非ブラウザのプロセス**は Origin ヘッダを付けずに全 API を叩けるため、`POST /api/terminal` → `POST /api/terminal/:id/input` で**任意コマンドを実行できる**(§8-3)。これは「ローカル単一ユーザーツール」という設計前提の裏返しであり、共用端末では前提が崩れる。

### 3.3 機密ファイルの保存場所

| ファイル | 内容 | パーミッション |
|---|---|---|
| `~/.openground/auth.json` | Supabase の access/refresh トークン、メール、表示名 | **0600**(+ chmod 再適用)✅ |
| `~/.openground/you-corpus.md` | 個人の判断軸 | **0600** ✅ |
| `~/.openground/swarm/escalations*` | エスカレーション記録 | **0600 / 0700** ✅ |
| `~/.openground/settings.json` | 全プロジェクトの絶対パス、git 実名 | **0644** ⚠️ |
| `~/.openground/projects/<uuid>/tasks.json` | **タスクのタイトル・本文** | **0644** ⚠️ |
| `~/.openground/canvas.json`, `canvases/` | Canvas の全要素 | **0644** ⚠️ |
| `~/.claude/projects/**/*.jsonl` | **claude セッション全文**(見せたコード・出力) | Claude Code の管轄(§7) |

### 3.4 ログ・一時ファイルへの機密残留

- **console へのトークン・タスク本文の出力は検出されなかった**(`console.*(token|prompt|content|session|email|key)` の全数 grep でヒットなし)。認証エラーのログもステータスと理由のみ。
- ただし **claude 起動時の初期プロンプト(= タスクのタイトル+本文)が、平文で一時ファイルに書かれる**: `$TMPDIR/openground-prompt-*/prompt.txt`(mode 指定なし = 0644。ただし包含ディレクトリは `mkdtemp` の 0700 で保護される)。60秒後に削除されるが、その間にプロセスが落ちると孤児ファイルとして OS のクリーンアップまで残る(`claudeTerminal.ts:484`)。

### 3.5 Electron シェル — 概ね良好

- `contextIsolation: true` / `nodeIntegration: false` / preload 隔離。`webSecurity` の明示無効化なし。
- `will-navigate` と `setWindowOpenHandler` で**アプリ origin 外への遷移を全て OS ブラウザへ弾く**(renderer が侵害されてもウィンドウを外部サイトへ飛ばせない)。`shell.openExternal` は https + Supabase/Google/GitHub の allowlist。
- **crashReporter は未使用**(Electron のクラッシュ送信は opt-in なので発生しない)。analytics ライブラリの require もゼロ。
- 一方 **session.webRequest による egress フィルタも CSP 注入も無い**ため、renderer 側が侵害された場合にシェル層で外部送信を止める手段はない(§8-7)。

---

## 4. サプライチェーン

**結論: analytics / telemetry / crash-report 系 SDK は、直接依存にも推移依存にも存在しない。**

- `package-lock.json`(776パッケージ)・`worker/package-lock.json`(100)・`spike/` の lock に対し、sentry / posthog / segment / mixpanel / amplitude / bugsnag / datadog / newrelic / statsig / launchdarkly / plausible / fullstory / hotjar / logrocket / crashlytics / opentelemetry / telemetry / analytics / gtag など**25キーワードを grep → 該当ゼロ**(唯一のヒットは `es-set-tostringtag` への部分一致という誤検知)。
- **resolved ホスト**: 775件すべて `registry.npmjs.org`。唯一の例外は `@electron/node-gyp` の git 依存 1件(**commit ハッシュ固定**)。第三のホストは存在しない。
- **postinstall チェーン**: `patch-package`(ローカル `patches/` の適用のみ・ネットワークなし)→ `electron-builder install-app-deps`(node-pty を Electron ABI 向けに再ビルド。`electronjs.org/headers` からヘッダを取得 = **インストール時 egress**であり、実行時の phone-home ではない)。
- **実行時依存 21 パッケージ**(hono / react / yjs / partysocket / y-partyserver / ws / node-pty / xterm ほか)の URL リテラルを全抽出 → **ハードコードされた外部宛先はゼロ**(partysocket・y-partyserver に既定の接続先は無く、URL は常にアプリ側が供給する)。
- **`electron-updater` のみが例外的に外部と話す**が、宛先は `package.json` の `build.publish`(nannantown/open-ground)に固定され、`setFeedURL` による上書きは存在しない。
- `patches/` の中身は node-pty の MSVC フラグ(`/std:c++20`)追加のみ — セキュリティに関わる変更なし。
- **アプリ自身の利用統計テレメトリは存在しない**。

---

## 5. 業務利用チェックリスト

導入前に、次を上から順に確認する。

**必須(これをやらないと業務データが外に出る)**

- [ ] **会社の Claude 利用契約を確認した** — claude に読ませた業務コードは Anthropic に送信される(§7)。これが承認されない限り、そもそも OPEN GROUND を業務コードに使えない。
- [ ] **`~/.claude.json` の `mcpServers` を棚卸しした** — 対話ターミナル/Board 実行の claude はユーザー設定の MCP サーバをロードするため、Anthropic 以外の任意ホストへデータが出る経路になる(§8-3b)。
- [ ] **アプリにサインインしない運用を決めた** — サインインすると、開いた Board/Canvas の中身が運営者の Cloudflare へ自動同期される(§8-1)。ログインは何もゲートしていないので、サインインしなくても全機能が使える。(監査時点で唯一の例外だった swarm も、2026-07-14 以降は §11 のローカル解錠でサインインなしのまま使える。)
- [ ] (より強く止めるなら)`.app` 内 `Contents/Resources/app/electron/runtime-config.json` を `{}` に置き換えた — collab・ログイン・フィードバックがまとめて無効化される(asar 無しなので編集可能。アップデートで復活する点に注意)。

**推奨(egress を最小化する)**

- [ ] FW / プロキシで **github.com** を遮断した — 起動時+4時間毎の自動アップデートチェック+バイナリ自動ダウンロードが止まる(遮断してもアプリは正常動作。ただし**セキュリティ修正も届かなくなる**トレードオフを理解した上で)。
- [ ] FW で **fonts.googleapis.com / fonts.gstatic.com** を遮断した — 起動のたびに Google へ出る接続が止まる(フォールバックフォントで動作継続)。
- [ ] Canvas の **mock(React)/ screen 要素を使わない**方針にした — 使うと unpkg / cdn.tailwindcss.com から外部 JS を取得して実行する(`lucide@latest` はバージョン未固定)。
- [ ] **カスタムタブをマーケットからインストールしない**方針にした — 第三者の JS がネットワーク無制限の iframe で動く。
- [ ] **フィードバック機能を使わない**(または送信時にスクリーンショットへ機密が写り込まないことを都度確認する)。

**ローカル面**

- [ ] **swarm の自律運転を使う場合**、生成された業務コードが**無人で origin へ push される**ことを承知した(既定 OFF・owner のみ起動可能 — 2026-07-14 以降は §11 のローカル解錠でも起動可・`--force` は不使用)。カードの完了フローを `pr` にすると claude 自身が push + PR 作成を行う(既定は `merge` = ローカル統合)(§1-A #8)。
- [ ] 業務 Mac が**単一ユーザー専有**であることを確認した — ループバック API に呼び出し元認証がないため、同一マシンで動く他プロセスは PTY 起動(= 任意コマンド実行)に到達できる(§8-3)。共用端末・不審なソフトが同居する端末では前提が崩れる。
- [ ] **FileVault が有効**であることを確認した — `~/.claude/projects/**/*.jsonl`(claude セッション全文)と `~/.openground/projects/<uuid>/tasks.json`(タスク本文、0644)がディスクに残る。
- [ ] ブラウザで OPEN GROUND を開いた状態で**未知のサイトを閲覧しない**運用にした(GET が DNS リバインディングで読まれ得る、§8-3)。Electron ウィンドウのみで使えば影響しない。
- [ ] 退職・端末返却時に `~/.openground/` と `~/.claude/projects/` を**ワイプする手順**を整備した。

**確認しておくとよい**

- [ ] `npm install` を業務ネットワークで行う場合、依存グラフが npm audit として registry へ送られる(`--no-audit` で抑止可)。
- [ ] OPEN GROUND が**起動のたびに `~/.claude/settings.json` を自動書き換えする**(hooks の自動インストール)ことを、端末の構成管理ポリシーと突き合わせた(§8-6)。

---

## 6. 「遮断してよい経路」早見表

| 経路 | 遮断した場合の影響 |
|---|---|
| fonts.googleapis.com / gstatic | フォントがシステムフォントにフォールバックするだけ。**機能影響なし** |
| github.com(auto-update) | 自動更新が止まる。**アプリは正常動作**(失敗はログのみ)。※セキュリティ修正も届かなくなる |
| api.github.com(リリースノート) | 設定パネルにエラー文言が出るだけ |
| unpkg / cdn.tailwindcss.com | Canvas の **mock(React)/ screen 要素の描画が壊れる**(HTML mock は生存) |
| supabase.co / og-collab.workers.dev | ログイン・共有・フィードバック・マーケットが使えなくなる(**サインインしないなら元々使わない**) |
| **api.anthropic.com** | **アプリの存在意義が消える**(claude が動かない)。遮断対象外 |

---

## 7. 既知の限界 — Claude Code の性質(最重要の前提)

- OPEN GROUND のターミナル / Board の実行 / swarm / Canvas AI で `claude` を起動した瞬間から、**そのセッションで Claude が読んだファイル・打ち込んだプロンプト・タスク本文・ツール実行結果は Anthropic のサーバへ送信される**。これは Claude Code(サブスクリプションの `claude` CLI)自体の動作であり、OPEN GROUND が追加でデータを送っているわけではない。しかし **OPEN GROUND を業務コードで使う = 業務コードを Anthropic に読ませる**ことを意味する。
- したがって業務導入の前提として、**所属組織の Claude 利用契約・ポリシー(商用データの取り扱い、データ保持、学習利用の可否)の確認が必須**である。この経路は OPEN GROUND 側の設定では遮断できない(遮断 = 製品の存在意義の喪失)ため、本監査では「**遮断対象外の既知経路**」として扱う。
- OPEN GROUND は **subscription-only** で、Anthropic の API キーは一切使わない(常にユーザーの `claude` CLI を駆動する)。したがって送信は**ユーザー自身の Claude アカウント**の下で行われる。
- **副次的な残留面**: Claude Code 自身がセッションの全文を `~/.claude/projects/**/*.jsonl` に保存する(ローカル)。業務コードの断片がディスクに残ることを意味し、ファイルモードは Claude Code の管轄で OPEN GROUND からは変更できない。FileVault と端末返却時のワイプ手順の対象に含めること。
- **起動しただけで claude が1回呼ばれる**点にも注意(§1-A #2): サーバ起動のたびに tier プローブが `claude --model <tier> -p 'reply with exactly: PROBE_OK'` を実行する。送信内容は固定文字列のみで機密は載らないが、「アプリを起動しただけで外部 AI サービスへの API 呼び出しが発生する」挙動には無効化フラグがなく、外部通信を申請制にしている組織ではポリシー抵触になり得る。

---

## 8. 発見事項(read-only 監査 — 本監査では修正していない)

### 8-1. 【最重要 / critical】サインインするだけで、開いた全プロジェクトの Board/Canvas が同意なしにクラウドへ自動アップロードされる

**事象**: 出荷版(`runtime-config.json` に `OPENGROUND_REALTIME=1` と WS URL が焼き込まれている)でアプリにサインインすると、**プロジェクトの Board タブまたは Canvas タブを開いただけで**:

1. `GET /api/collab/project?path=` が発火(`RealtimeContext.tsx:135-166` — ゲートは `enabled` のみで、`enabled` は `/api/collab/config` = **REALTIME フラグ + WS URL + サインイン済みセッション**の3条件だけ。**プロジェクト単位のオプトインは存在しない**)
2. サーバが Supabase に `og_projects` 行を **INSERT** し、オーナーのメンバーシップ行(**メールアドレス入り**)も seed する(`collab.ts:244` → `projectMembers.ts:757` → `resolveOwnProjectRow` の "None found → create one")
3. `member: true` が返るのでクライアントはチケットを取得(**ユーザーの Supabase access トークンが運営者の Worker へ中継される**)し、`wss://og-collab.mindbrew.workers.dev` へ接続
4. sync 完了と同時に **`collab.seed(dataRef.current)` でローカルの ProjectData 全体**(全タスクのタイトル・本文・ノート・説明)を Y.Doc に書き込む(`BoardModule.tsx:414`)。Canvas タブなら Canvas の全要素(付箋・mock のソース)。画像は R2 へ自動アップロード
5. Worker の `OgCollabDoc.onSave` が Y.Doc 全状態を **Durable Object の SQLite に永続保存**
6. 以後はサーバ側の `collabMirror` が、**タブを閉じていても** Board/Canvas への全書込を自動でミラーし続ける

**なぜ問題か**: コードには同意ダイアログ(`CollabConsentDialog`)が実装されており、そのコメントは「チェックするまで何もマシンを出ない」と明記している。招待ダイアログは実際に同意まで `/api/collab/project` の呼び出しを遅延させている。**しかし Board/Canvas のマウント経路はこのゲートを通らない**。ユーザーから見れば「ログインしただけ」「共有していない」のに、業務データがクラウドに載る。

**業務 Mac での緩和策**: **サインインしない**(ログインは何もゲートしていない)。または `.app` 内の `electron/runtime-config.json` を `{}` にする。

**根拠**: `RealtimeContext.tsx:135-166`, `RealtimeContext.tsx:42`, `server/routes/collab.ts:119-122`, `collab.ts:244-257`, `projectMembers.ts:757`, `BoardModule.tsx:385`, `BoardModule.tsx:414`, `ProjectCanvas.tsx:198-204`, `collabMirrorCore.ts:342-373`, `worker/src/OgCollabDoc.ts:49-69`, `electron/runtime-config.json`
(※ 独立した2エージェントが発見し、監査担当が全リンクを実コードで再確認した)

### 8-2. 【high】クラウド側コピーに削除・保持期限の経路が存在しない

Durable Object の Y.Doc(`OgCollabDoc`)には削除ルートがなく、R2 のアセット(`worker/src/assets.ts`)も GET/PUT のみで DELETE が無い。ローカルの「プロジェクト削除」(`rm -rf`)も Supabase の行やクラウドのコピーには触れない。**一度 8-1 の経路が発火すると、利用者がそのデータを取り消す手段がない**。
根拠: `worker/src/OgCollabDoc.ts:49-69`, `worker/src/assets.ts:72-99`, `server/routes/collab.ts`(削除ルート不在)

### 8-3. 【high】ループバック API に呼び出し元認証がなく、同一マシンの他プロセスから任意コマンド実行に到達できる

`terminal` / `project` / `canvas` / `misc` の各ルーターにセッション検査はゼロ。`app.ts` のガードは **Origin/Host の検査のみ**で、これはブラウザ由来のリクエストしか止められない。ローカルの非ブラウザプロセス(別アカウントのスクリプト、MDM エージェント、既に動いているマルウェア)は Origin を付けずに送れるため素通りする。攻撃連鎖: `GET /api/settings`(無認証でプロジェクトの絶対パスを取得)→ `POST /api/terminal {cwd}`(`zsh -l` 起動)→ `POST /api/terminal/:id/input`(**任意コマンド実行**)。`POST /api/project/delete`(フォルダを削除)も同様に無認証で到達可能。
**加えて GET はガードの対象外**(`app.ts:56` — 状態変更メソッドのみ検査)なので、DNS リバインディングが成立すると悪意ある Web ページが `GET /api/project/file-diff`(**ソース差分**)、`GET /api/settings`、`GET /api/auth/session`(メール)などを読み取れる。GET のループバック検証を持つのは `youCorpus` ルートだけである(そのコメント自身がこの攻撃を明記している = 作者は認識しているが1ルートにしか対策していない)。
根拠: `server/app.ts:55-70`, `server/routes/youCorpus.ts:29`, `server/routes/terminal.ts:56,346`, `server/routes/project.ts:568,712`

### 8-3b. 【high】対話ターミナルの claude はユーザーの MCP サーバを読み込み、Anthropic 以外の任意ホストへデータを出し得る

OPEN GROUND は自動生成系のセッション(タイトル / 説明 / Canvas AI / skill)と swarm worker には **`--strict-mcp-config` を付けて**ユーザースコープの `~/.claude.json` の `mcpServers` を無効化している(サンドボックス硬化の一環)。しかし**ユーザーが直接触る対話ターミナルと Board の「実行」は意図的に strict を付けない**ため、ユーザーが設定した MCP サーバ(社内 DB・Slack・任意の HTTP エンドポイント等)がロードされ、claude がそのツールを呼べば**業務データがその宛先へ出る**。宛先は完全にユーザー設定依存で、OPEN GROUND 側からは制御できない。

**業務 Mac での前提条件**: `~/.claude.json` の `mcpServers` とプロジェクトの `.mcp.json` の**棚卸し**。これは Claude Code 自体の仕様であり(§7 と同種)、OPEN GROUND 固有の欠陥ではないが、egress の全数把握には必須の項目。
根拠: `claudeTerminal.ts:74-83`(opt の設計意図が明記されている), `claudeTerminal.ts:336`, `server/routes/terminal.ts:208`(strict 指定なし) / 対照: `swarmWorker.ts:444`, `generateTaskTitle.ts:123`

### 8-4. 【medium】タスク本文・プロジェクトパスが world-readable(0644)で保存される

`~/.openground/settings.json`(全プロジェクトの絶対パス + git 実名)、`projects/<uuid>/tasks.json`(**タスクのタイトル・本文**)、`canvas.json` / `canvases/` が **mode 指定なし = 0644**、ホームディレクトリは 0755。同一 Mac の別ローカルアカウントから読める。実測でも確認した。
対照的に `auth.json` / `you-corpus.md` / escalations は 0600/0700 で正しく保護されている — **機微度の判断が漏れているのはタスク本文と設定だけ**。
根拠: `paths.ts:133`, `store.ts:59`, `projectData.ts:266`, `atomicWrite.ts:82`(実測: 隔離 HOME の生成物すべて 0644)

### 8-5. 【medium】自動アップデートに opt-out がなく、起動時+4時間毎に GitHub へ到達しバイナリを無確認で自動ダウンロードする

出荷版は起動直後と4時間毎に GitHub を照会し、新版があれば `autoDownload = true` でバイナリまで無操作で受信する(適用のみユーザーの「Restart now」)。**設定・環境変数によるオプトアウトが一切ない**(分岐は `app.isPackaged` のみ)。機密環境では「4時間毎の恒常ビーコン + 無確認のコード受信」になり、配布リポの侵害が全ユーザーのコード置換に直結する供給経路でもある。緩和はネットワーク層での遮断のみ(遮断してもアプリは正常動作する)。
根拠: `electron/main.js:1671`(`AUTO_UPDATE_INTERVAL_MS = 4h`), `:1674`, `:1687`, `package.json:108-112`

### 8-6. 【medium】起動のたびにユーザーの `~/.claude/settings.json` を自動改変する

サーバは毎起動 `installHooks()` を実行し、グローバルな Claude Code 設定に SessionStart/Stop/PostToolUse/**PreToolUse** フックを upsert し、`~/.openground/guard/` にガードスクリプト・`~/.openground/hooks/` にフックスクリプトをコピー(settings.json が参照するのは常にこの homedir 基準の安定パスのみ — 解決元 checkout/worktree のパスは書かれない)、`~/.claude/skills/og-manage/` にスキルを設置する。egress ではない(フックの通信先は 127.0.0.1 のみ)し、既存のユーザー定義フックは保持されるが、**他ツールのグローバル設定を無断で書き換える**挙動は業務端末の構成管理と衝突し得る。加えて `POST/DELETE /api/observer/install-hooks` は**無認証**なので、ローカルの他プロセスがこのガード(`--dangerously-skip-permissions` すら貫通する唯一の拒否 veto)を**取り外せる**。
根拠: `server/index.ts:144-167`, `hooksInstall.ts:15-24`, `misc.ts:530-537`

### 8-7. 【medium】Canvas の mock/screen が外部 CDN から実行コードを取得する(バージョン未固定・CSP なし)

mock/screen 要素の iframe が unpkg.com から `react@18` / `react-dom@18` / `@babel/standalone@8` / **`lucide@latest`(完全未固定)**、cdn.tailwindcss.com から Tailwind を読み込んで実行する。iframe は `sandbox="allow-scripts"`(same-origin なし)なのでホスト側には波及しないが、**srcdoc に CSP が無い**ため、CDN 侵害時に悪性スクリプトが iframe 内の内容を任意の外部ホストへ持ち出せる。Electron シェル側にも `session.webRequest` フィルタや CSP 注入が無く、egress を止める層が存在しない。
根拠: `mockSrcdoc.ts:79-81`, `screenSrcdoc.ts:363,383,386,387`, `ElementView.tsx:520`, `electron/main.js:554-597`(webRequest 設定の不在)

> **追記(2026-07-14)**: 業務モード ON でこの経路は遮断される — webRequest
> フィルタ + srcdoc CSP + プレースホルダ(§12.1 層3)。OFF 時の CDN 依存
> (バージョン未固定を含む)は従来どおり残る。

### 8-8. 【medium】Google Fonts が起動ビーコンになっている(無効化不可)

`index.html:24-27` の Web フォント参照により、**アプリのウィンドウを開くたびに必ず** Google へ接続する(IP + UA)。設定・環境変数での停止手段はなく、`index.html` の編集 + 再ビルドが唯一の手段。フォントをローカル同梱すれば根治できる構造。egress 監視のある環境では「このマシンで OPEN GROUND が起動した」ことが常時観測される。実測でも確認した。

> **追記(2026-07-14)**: **根治済み** — フォントは `public/fonts/` に同梱され、
> `index.html` / srcdoc は Google Fonts を一切参照しない(§12.1 層3-2。
> lockdown OFF でも接続ゼロ。`srcdocLockdown.test.ts` で固定)。

### 8-9. 【low / ドキュメント】`CLAUDE.md` が削除済みの「git-shared モード」を現役機能として記述している

`CLAUDE.md` の "Exception — git-shared mode" 節は `sharedData.ts` / `gitShare.ts` / `server/routes/share.ts` を実在するものとして説明しているが、**いずれも現行ツリーに存在しない**(`shareEvac.ts` = 旧データの一方向退避のみが残る)。セキュリティ判断では「Board/Canvas がリポジトリに書き込まれ会社の git リモートへ push される経路がある」という**誤った前提**を生むため、実装に合わせて訂正すべき(§1-E)。

### 8-9b. 【low】サインイン中はアバター画像を第三者 CDN から毎起動ロードし、Referer まで送っている

Supabase の `user_metadata.avatar_url || picture`(= **OAuth プロバイダが決める任意のホスト**)を無検証で `AuthUser.avatarUrl` に載せ、Toolbar のアカウントボタンが `<img src={user.avatarUrl}>` を**無条件に描画する**。結果、サインイン済みなら**ウィンドウを開くたびに** `lh3.googleusercontent.com` / `avatars.githubusercontent.com` へ画像 GET が飛ぶ。

問題は2点: (a) **Toolbar 側の `<img>` には `referrerPolicy` が無い**ため Referer が送出される(**AccountModal 側だけ `referrerPolicy="no-referrer"` が付いている** = コードベース自身が漏洩を意識しているのに片側にしか適用していない非対称)。(b) renderer に CSP が無く、`isAllowedOauthUrl` のような allowlist 検証も通らないため、宛先は実質「Supabase の user_metadata に入った任意のホスト」になる。

**この経路は、敵対的 sweep 2本が独立に発見したもの**(領域別の調査7本はいずれも見落としていた — アバター URL がサーバ経由でクライアントに渡り、そこから第三者 CDN へ出る、という経路の跨ぎ方が原因)。
根拠: `Toolbar.tsx:315-321`, `AccountModal.tsx:58-64`, `supabaseAuth.ts:68`, `server/routes/auth.ts:268`

### 8-10. 【low】その他

- **presence がログインメールアドレス全文を同室の全 peer にブロードキャストする**(`CollabPresence.tsx:34`)。8-1 により同意が表示されないまま部屋が成立し得るため、意図せぬ PII 配信になり得る。
- **`task.prUrl` がスキーム検証なしで `href` に直挿しされる**(`schemas.ts:82` → `BoardCard.tsx:487`)。`tasks.json` は swarm worker や外部スクリプトが書くため、`javascript:` が書き込まれるとクリック時に renderer コンテキストで実行される。
- **claude 起動時の初期プロンプト(タスク本文)が平文で `$TMPDIR` を経由する**(60秒後削除。包含ディレクトリは 0700。異常終了時に残留)(`claudeTerminal.ts:484`)。
- **招待コードが `og_project_invites.token` に平文保存される**(RLS で owner のみ可読・7日期限のため影響は限定的)。
- **`npm install` 時に依存グラフが npm audit として registry へ送られる**(`--no-audit` で抑止可)。
- **GitHub Actions がタグ pin(SHA pin でない)**(`release.yml`)。配布物の生成経路の堅牢化余地。

### 8-11. 【info】良好な設計(肯定所見 — 維持すべき点)

- **未サインインでの fail-closed が徹底されている**: `collabEnabled` はセッションが無ければネットワーク到達前に短絡。`roles` はセッション無しで即 `'none'`。実測でも「出荷相当 env + 未ログイン」で外部接続ゼロを確認した。
- **プロジェクトの絶対パスは外部送信前に不可逆ハッシュ化される**(`sha256(uid + ':' + path)`)。生パスがマシン外へ出る経路は存在しない。
- **service-role キーと HMAC secret は絶対に焼き込まれない**: `BAKED_KEYS` は公開4値のみの明示 allowlist で、`SERVICE_ROLE|SECRET|PASSWORD|PRIVATE` 名のキーが混入したらモジュールロード時に throw する(`runtimeConfig.js:51-56`)。実物の `runtime-config.json` も anon キーと公開 WS URL のみだった。
- **collab のトークン中継先は env で改竄できない**(焼き込み値が `process.env` より後勝ち — `forkEnv.js`)。
- **SaaS 側の認可設計は堅牢**: 全経路が利用者自身の JWT + RLS、anon の書込は REVOKE 済み、WS は room 束縛の 60 秒 HMAC チケット、Worker は JWKS で署名検証。**懸念は「何が守られているか」ではなく「何がいつ送られるか」(8-1)に集中する**。
- **egress プロキシ**(overseer brain 用)は CONNECT-only・allowlist 2ドメイン・443 限定・127.0.0.1 バインド・拒否ログ付きと防御的に実装されている。
- **秘密値をログに出す箇所は検出されなかった**。
- **Electron のナビゲーション堅牢化**(`will-navigate` / `setWindowOpenHandler` / openExternal allowlist)により、外部ページが preload 付きウィンドウで開くことは構造的にできない。
- **`POST /api/settings` は allowlist で `projects`(= パス境界の許可リスト)への書き込みを遮断**しているため、偽装リクエストでパス境界を広げることはできない。

---

## 9. swarm 経路への言及と `docs/commander/` の更新要否

本レポートは swarm 経路に次のとおり言及する: `claudeTerminal` / `swarmLaunch`(claude CLI = Anthropic への既知経路、§1-A #1)、`swarmTierProbe`(**起動時に自動で claude を1回呼ぶ**、§1-A #2・§7)、`swarmIntegrate` / `swarmJanitor`(**ユーザー自身の git remote への push**、§1-A #8)、`egressProxy`(overseer brain の CONNECT 中継、§1-C #22)。

**判断: `docs/commander/` の更新は不要。**

理由 — 本監査は read-only であり、swarm コアの動作仕様には一切変更を加えていない。上記の言及はいずれも既存実装の egress 面の記述であって、`docs/commander/` が正典とする運用手順・診断手順・症状対応表と矛盾しない(`TARGET-STATE.md` §6 の「現物が正」に照らして、文書側に直すべき食い違いは見つからなかった)。ただし `docs/commander/04章 §5.8`(層E = 起動前プローブ)が記述するプローブは、本レポート §1-A #2 の「起動時に自動発火する Anthropic 呼び出し」と同一物である — **将来 egress に影響する swarm 改修**(プローブ先の変更、リモート統合先の追加など)を行う際は、本表(§1)への追随を完了条件に含めること。

なお、**`CLAUDE.md` は更新が必要**(§8-9 — 削除済みの git-shared モードを現役として記述している)。本監査は read-only のため修正していない。

---

## 10. 本監査の限界

- **サインイン後の実測は行っていない**(監査担当がユーザーの認証情報でログインすることを避けたため)。§1-B / §8-1 の経路はコードを端から端まで追跡して確認したが、実パケットの観測はしていない。サインインを許可する運用にする場合は実機での確認を推奨する。
- **配布 DMG そのものではなく、同一コミットからビルドした出荷相当ビルドで実測した**。実際の配布物に `OPENGROUND_REALTIME` / `COLLAB_WS_URL` が焼かれているかは CI Secrets 依存であり、**インストール済み `.app` の `Contents/Resources/app/electron/runtime-config.json` を直接確認するのが確実**(本監査では開発ツリーの実物にこれらが焼かれていることを確認した)。
- **macOS OS レベルの通信**(Gatekeeper / notarization のオンライン検証)はアプリコード外のため対象外。
- **`node_modules` の全ファイル逐読は行っていない**(URL リテラル・install script・主要実行時依存の重点確認でカバー)。
- **Supabase 側の実 RLS 状態**が migrations と一致しているかは、コードからは検証できない。

---

## 11. 業務モード(サインインしない運用)での swarm — ローカル owner 解錠

**本章のみ、§0-§10 の監査(`a64c8cc` 時点・read-only)より後に入った実装の記述である
(2026-07-14 追加)。**

swarm の全ルート(`/api/swarm/*`)は owner の**アプリログイン**でゲートされていた
ため、§5 必須の「アプリにサインインしない運用」では swarm が使用不能だった。これを
ログインなしで解錠できる**サーバローカルの明示フラグ**として実装した(seam:
`src/lib/server/swarmGate.ts` — `hasSwarmOwnerAccess()` = owner ログイン **or**
ローカル解錠)。UI にトグルは存在しない(隠しフラグ)— 本節が正典の手順書である。

### 11.1 解錠手順(どちらか一方でよい)

1. **settings.json(推奨 — Electron/Finder 起動でも効く)**: `~/.openground/settings.json`
   をエディタで開き、トップレベルに次のキーを**手で**追記する:

   ```json
   { "swarmLocalOwner": true }
   ```

   サーバ再起動は不要(設定はリクエスト毎にディスクから読む)。Swarm タブを出すには
   アプリのウィンドウを再読込する。

2. **環境変数(ターミナル起動向け)**: サーバプロセスに `OPENGROUND_LOCAL_OWNER=1`
   (文字列 `'1'` 厳密一致)を与える:

   ```bash
   OPENGROUND_LOCAL_OWNER=1 npm run start
   ```

   Finder から起動する `.app` には環境変数を渡せないため、パッケージ版では 1. を使う。

既定はロック(何も設定しなければ従来どおり、未ログインの swarm ルートは全て 403)。
解錠すると `/api/swarm/*` の全ルートと Swarm タブ(`GET /api/experiments` の
`flags.swarm` ミラー経由)が開く。

### 11.2 安全性の根拠 — この gate は「機能公開フラグ」でありセキュリティ境界ではない

本監査自身が実測・記載したとおり(§3.2 / §8-3)、**ループバック API には呼び出し元
認証がなく、`POST /api/terminal` は role gate なしで登録済みプロジェクトに zsh を
spawn できる** — 同一マシンのローカルプロセスは、swarm を経由せずとも既に任意コマンド
実行へ到達できる。API は 127.0.0.1 バインド限定(§3.1)なので、「解錠済み」の状態が
見えるのもローカルプロセスだけである。したがって swarm の owner gate はローカルに
対する防御線ではなく**機能の公開範囲を決めるフラグ**であり、ローカル完結の解錠を
足しても攻撃面は増えない(むしろ swarm 経路は validateProjectPath・claude preflight・
worktree 隔離・PreToolUse 拒否ガード(`docs/SWARM_SAFETY_INVARIANTS.md`)という、
素の PTY ルートには無い多層ガード付きである)。

エグレス面(§1 の表)への影響もない: 解錠はローカル判定のみで、新しい外部経路を
一切追加しない。解錠後に swarm が外へ出すものは監査時と同一である(claude =
Anthropic §1-A #1、ユーザー自身の git remote への push §1-A #8 — 後者は §5
「ローカル面」のチェック項目どおり)。

### 11.3 解錠フラグ自体の防御 — リクエスト由来では絶対に開かない

- 解錠の根拠は**サーバローカル状態のみ**(プロセス環境変数 / 手編集された
  settings.json)。リクエストが運ぶ値(ヘッダ/ボディ/クエリ)は一切見ない。
- `swarmLocalOwner` は `POST /api/settings` の書込 allowlist(`USER_SETTINGS_KEYS`
  — `src/lib/server/store.ts`)に**意図的に入れていない**。HTTP 経由では設定不能
  なので、ローカル API に到達できるページ/スクリプトが自分でこのゲートを開ける
  ことはできない(§3.2 の「GET 素通し」問題とも独立に成立する防御)。
- **スコープは swarm 限定**: マーケットプレイス/カスタムタブ公開系(Supabase 実
  書込 — §1-C)と sandbox 実験(`docs/SANDBOX_EXPERIMENT.md`)は、解錠しても
  閉じたまま(従来どおりサインイン済みロールが必要)。
- **サブスクリプション専用原則は不変**: 解錠が変えるのは制御面への到達可否だけで、
  実行は常にユーザー自身の `claude` CLI(対話 PTY)。API キー経路は存在しない。

固定するテスト: `server/routes/__tests__/swarmSafety.routes.test.ts`(ロック既定 —
未ログイン 403 の全ルート sweep)、`server/routes/__tests__/swarmLocalOwner.routes.test.ts`
(両解錠経路で全ルート通過・swarm 限定スコープ・HTTP からの設定不能・escalations の
実 read/write、いずれも未ログイン+Supabase 環境変数なしで検証)、
`src/lib/server/swarmGate.test.ts`(解錠源の解決)。

---

## 12. 業務モード(ロックダウン) — Anthropic 以外の外部通信を一括遮断するキルスイッチ

**本章は §11 と同じく、§0-§10 の監査(`a64c8cc` 時点)より後に入った実装の記述である
(2026-07-14 追加)。**

§1 の表のうち「遮断してよい経路」(§6)を、1トグルでまとめて落とすアプリ内キル
スイッチ。Settings パネルの **業務モード(ロックダウン)** トグル =
`Settings.lockdownMode`(settings.json 永続・既定 **OFF** = 既存ユーザーの挙動は
不変)。ON の間、このアプリ由来の外部エグレスは「ユーザー自身の claude
サブスクリプション(Anthropic)」だけになる。claude CLI(§1-A #1,#2,#3 — 製品の
本質)には一切触れない(subscription-only 原則も不変 — API キー経路は存在しない)。

### 12.1 実装 — 遮断の3層(サーバ / Electron / renderer)

**層1: 機能ゲート** — 各 route / seam が `isLockdownEnabled()`(store.ts、毎リク
エストにディスクの settings.json を参照)を消灯条件に加える:

| 遮断対象(§1 の行) | ON 時の観測可能な振る舞い |
|---|---|
| #4 electron-updater | `electron/lockdown.js` — **毎チェック直前**(起動時+4時間毎 tick)に settings.json を読み直し、ON なら check ごとスキップ(再起動不要でトグルが効く)。§8-5 の「opt-out なし」はこのトグルで解消 |
| #6 GitHub リリース照会 | `/api/update/check` `/api/release-notes` がローカル応答(`lockdown:true`)を返し、GitHub への fetch はゼロ |
| #18 feedback | `/api/feedback/config` → `{enabled:false}`、送信/一覧 route は 503。UI の送信導線も無効表示 |
| #10 Supabase ログイン | `/api/auth/config` → `{enabled:false}`(Sign in UI 非表示)、start/callback/signout は 503。`/api/auth/session` は**トークンリフレッシュせず・auth.json に触れず**サインアウト扱いを返す(保存済みセッションはローカルに保持 = OFF で復帰・revoke しない) |
| #11-16 collab / roles | `/api/collab/config` → `{enabled:false}`(SPA は collab バンドル自体をロードしない → CF Worker への WS が張られない)、他の collab route は group middleware で 503。`supabaseAuth.postToken` / `getFreshSession` が null を返す(projectMembers / collabInvites / roles を網ごと止める単一 seam)。roles は env override(`OPENGROUND_OWNER_EMAILS`)か最終キャッシュへ degrade — **業務モードで swarm を使う owner は §11 のローカル解錠と `OPENGROUND_OWNER_EMAILS` を併用する** |
| #13 サーバ側 collab mirror(ws) | `collabMirrorCore` が enqueue を入口で drop + `openScopedDoc` が接続前に throw。トグル前から生きていた mirror 接続は ~60秒の idle 解体で自然死し、再接続は不能(チケット発行が lockdown-null)。ON 中に漏れた書込は既存の再起動ギャップと同じ治癒(OFF 後の最初の書込がディスク全量を再ミラー) |
| #19 marketplace / 提出 | 一覧・インストール・公開・提出 route は 503。`GET /api/custom-modules` は 200 のまま `marketAvailable:false` を返す(ローカル CRUD は生存・市場導線だけ UI から消える) |

**層2: fetch 底網** — `installLockdownFetchGuard()`(`src/lib/server/lockdown.ts`、
server/index.ts で常設)。サーバプロセスの global `fetch` を wrap し、ON の間、宛先
ホストが loopback でも Anthropic(`anthropic.com` / `claude.ai` — egressProxy.ts と
同一 allowlist)でもない http(s) リクエストは接続前に `LockdownEgressError` で落ち
る。層1 の取りこぼし(将来のコード追加を含む)への保険。

**層3: renderer 遮断** — SPA(ウィンドウ)と iframe が Chromium のネットワーク
スタック経由で直接出すリクエストは層1・層2 に掛からない(監査の §1-A #5 Google
Fonts / #7 iframe CDN・§8-7・§8-8 がまさにこれ)。3点で塞ぐ:

1. **Electron `session.webRequest` フィルタ**(`electron/main.js`
   `installLockdownWebRequestGuard` + 判定は `electron/lockdown.js`)— ON の間、
   renderer 発のリクエストは allowlist(loopback / `file:` `data:` `blob:` /
   Anthropic)以外**接続前に cancel**。allowlist 判定が先に走るので loopback の
   ホットパス(API/SSE)はディスク読みゼロ、非 allowlist 宛だけが settings.json
   の再読を払う(= トグルは再起動不要で即時反映、updater ガードと同じ契約)。
2. **Google Fonts の根治(§8-8)** — Web フォント3família を `public/fonts/` に
   **同梱**(woff2 11本・OFL・`LICENSE.txt` 同梱)し、`index.html` と
   `screenSrcdoc.ts` はローカル `/fonts/fonts.css` だけを参照する。これは
   lockdown と無関係の**常時**変更 — OFF でも Google への接続はもう存在しない
   (起動ビーコンの根絶。フォールバック劣化も無くなる)。null-origin の srcdoc
   iframe からフォントを読めるよう、サーバは `/fonts/*` にだけ
   `Access-Control-Allow-Origin: *` を付ける(`server/app.ts` — loopback 専用
   サーバの GET 静的アセットなので露出は増えない)。
3. **srcdoc iframe の CSP + 明示プレースホルダ**(`mockSrcdoc.ts` /
   `screenSrcdoc.ts`、client 側の鏡 = `src/lib/lockdownClient.ts`)— ON の間:
   外部 CDN ランタイムを**必要とする**テンプレート(mock 'react'、screen の
   全 framework、カスタムタブ、提出レビューのプレビュー)は描画せず
   **「業務モードによりブロック中」のプレースホルダ**(バイリンガル・外部参照
   ゼロ)に差し替える — 黙って壊れない。CDN 不要の mock 'html' は描画を続け、
   `default-src 'none'; connect-src 'none'` の CSP `<meta>` を注入して中の
   コード(マーケット製第三者コード含む)が fetch/beacon で外へ持ち出すのを
   **文書層で**遮断する。CSP は iframe 自身の文書に効くため、Electron を
   介さないブラウザ利用でも有効(層3-1 の補完)。トグルは
   `useClientLockdown()` 経由で live iframe にも両方向即時反映。

### 12.2 可観測性・往復

- ON 中は Settings 冒頭に控えめなバッジを表示。無効化された各 surface は自分で理由
  を名乗る(`lockdown:true` / 503 "disabled by work mode" / `enabled:false` /
  iframe はプレースホルダ)— 黙って壊れない。
- OFF に戻すと全機能が復帰する(トグル往復はテストで固定)。

### 12.3 ON 中に残る通信(全数)

- **Anthropic のみ**: claude CLI(子プロセス)と、その claude が読む MCP サーバ
  (ユーザーの `~/.claude.json` 次第 — §8-3b。アプリからは制御不能)。
- ユーザーが PTY 内で自分で打つコマンド(git push / curl 等)はアプリの管轄外。

### 12.4 限界(業務導入者は必読)

- **settings.json が破損して読めない場合、フラグは既定値 OFF(= 外部通信が復活)へ
  倒れる(fail-open)**。サーバ(store.ts)・Electron(lockdown.js)・SPA の三者が
  同じ「壊れたら OFF」に解決するので食い違いはしないが、**業務 Mac では
  settings.json の健全性(バックアップ・構成管理)も運用対象に含めること**。
  ON の証拠は Settings バッジ(§12.2)で常時視認できる。
- **dev モード(Vite :5174 直開き)の renderer は webRequest の対象外** —
  層3-1 は Electron ウィンドウにしか効かない。ブラウザで開いた場合の遮断は
  層1(route ゲート)+層2(サーバ fetch 底網)+層3-3(CSP)+フォント同梱で
  成立しており、通常利用で外部へ出る経路は残らないが、**ネットワーク層での
  強制は Electron 利用時のみ**である(既知の限界)。
- アプリ内スイッチであり OS ファイアウォールではない: 他のプロセス、claude 自身と
  その MCP(§8-3b)、PTY 内でユーザーが打つコマンドは対象外(そこは §5 の FW /
  sandbox の領分)。

### 12.5 テスト

`server/routes/__tests__/lockdown.test.ts`(route ゲート全数 + トグル往復 + fetch
ゼロ)、`src/lib/server/lockdown.test.ts`(fetch 底網 / Anthropic・loopback
allowlist / supabaseAuth seam)、`server/__tests__/electronLockdown.test.ts`
(Electron main プロセスの updater ガード probe + webRequest allowlist —
lookalike ドメイン拒否・IPv6 loopback 含む)、`src/lib/srcdocLockdown.test.ts`
(srcdoc の CSP / プレースホルダ / OFF 時の完全非改変、index.html と
`public/fonts/fonts.css` の外部参照ゼロ固定)。
