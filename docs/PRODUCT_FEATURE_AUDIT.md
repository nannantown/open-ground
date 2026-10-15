# OpenGround 機能棚卸し・製品化バックログ

2026-10-15 / 初回棚卸し。対象は `codex/productize-subscriptions` の
`762b957d7f907f8a3e0bef65427fb00b560af897`。利用者向けの整理資料。
公開方針は [PUBLIC_LAUNCH_PLAN.md](./PUBLIC_LAUNCH_PLAN.md)、実装の索引は
[MAP.md](./MAP.md)、課金の導入手順は [BILLING_PLAN.md](./BILLING_PLAN.md)。

**基本機能の実装は広く存在するが、一般公開の受け入れ完了ではない。**
今回、設定の変更消失とブログの重複・送信先切替の不具合を隔離環境で再現した。
Owner専用であること、外部サービスが未設定であること、意図的に提供しないことを、
「未実装」と混同しない。今回は棚卸しと修正計画の作成までで、以下の不具合は未修正。

## 1. 決定済みの製品方針

- macOSで少人数テスト後、Free（月額0円）／Pro（月額2,980円）を一般公開する。
- 中心価値は複数プロジェクトとターミナルを扱いやすい作業環境。自動配車等は補助機能。
- 現在のFreeも複数プロジェクト・複数ターミナルを利用できる。新しい有料差分は未決定。
  この棚卸しを理由に既存のターミナル数やプロジェクト数を制限しない。
- AI用APIキー方式には変更しない。利用者自身のAIサブスクを使う方針を維持する。
- OwnerのSongs、Canvas、Research、ブログ、カスタムタブ、実験機能と保存データを維持する。
- Codex連携は未実装。問い合わせ済みと利用許可済みを区別し、初回公開の必須機能にしない。
- 公開サイトの修正、実装変更、署名付き配布、外部設定は、それぞれ別の完了条件を持つ。

## 2. 判定の読み方

| 表記 | 意味 |
| --- | --- |
| 実装あり | UI／API／保存・実行経路を確認した。新しい配布アプリでの実機合格を意味しない |
| 要修正 | 再現した不具合、またはコード上の明確な欠落がある |
| 外部設定待ち | コードはあるが、実サービスの設定・疎通・受け入れが残る |
| 未検証 | 今回は実操作や実サービスまで通していない |
| 仕様未決定 | 課金境界や一般公開範囲等の判断が必要。勝手に実装しない |
| 対象外／廃止済み | 意図的な非対応・撤去。実装不足として復活させない |

以下の「公開」は現在のFree／Pro両方の基本画面。「Owner」はApp Owner権限であり、
共同編集プロジェクトのowner権限とは別。表の公開方針は提案で、機能削除の実施記録ではない。

## 3. 機能一覧

### 作業場・Board・Terminal

| ID | 機能・入口 | 現状と残作業 | 初回公開の扱い |
| --- | --- | --- | --- |
| G01 | プロジェクト作成・既存フォルダ取込・再配置：`EmptyState.tsx`、`registry.ts`、`routes/misc.ts` | 実装あり。登録先の重複・包含・危険なフォルダを検査。新規Macでのフォルダ選択から初回操作は未検証 | 公開の中心 |
| G02 | Groundの一覧・検索・選択・配置・グループ・状態灯：`App.tsx`、`InfiniteCanvas.tsx`、`groundLamp.ts` | 実装あり。Groundの描画とプロジェクト内Canvasは別機能 | 公開。描画道具は既存の折りたたみを維持 |
| G03 | 表示名・フォルダ名変更、Groundから除去、フォルダ削除：`routes/project.ts`、`registry.ts` | 実装あり。「登録解除」と「フォルダ削除」は異なる操作。複製データで確認文・復帰可否を確認する | 公開。実データを使った削除試験は禁止 |
| G04 | プロジェクト説明生成：`generateDescription.ts`、`ProjectPanel.tsx` | CLIジョブ・保存・遅延応答防止あり。実Claudeでの生成結果と更新後の保持は今回未検証 | 公開。失敗時にも手作業を継続できること |
| B01 | Boardカード作成・編集・移動・削除・複数操作：`BoardTab.tsx`、`BoardCard.tsx`、`projectData.ts` | 実装あり。永続化はロック／CAS、共有時はY.Doc経由。通常操作の配布GUI受け入れが残る | 公開の中心 |
| B02 | 担当者・優先度・難易度・依存関係・下書き：同上、`boardDeps.ts` | 実装あり。下書きは自動配車しない。個人利用でどこまで常時見せるかはUI整理事項 | 公開。保存値は維持 |
| B03 | 画像添付・入力への挿入：`taskAssets.ts`、`routes/project.ts`、`routes/terminal.ts` | 実装あり。現行画像は中央の `task-assets/`。古い `task-attachments/` の保持処理と混同しない | 公開。長期保存・更新後の読み戻しを確認 |
| B04 | 手動実行、実行既定値、Claudeでのレビュー：`modules/BoardModule.tsx`、`composeTaskPrompt.ts` | 実装あり。Swarm表示時は同じRun操作がWorker経路に切り替わる。今回経路テスト合格、実Claudeは未検証 | Freeの手動操作を先に受け入れる |
| B05 | PR状態・ブランチ差分・レビュー用worktree：`routes/project.ts`、`branchChanges.ts` | 実装あり。`gh`未設定等では情報なしに縮退。実GitHub権限・PR取得は別途確認 | 公開の補助。必須設定にしない |
| T01 | 複数ターミナル、名前、並列表示：`ProjectPanel.tsx:141`、`:250` | 実装あり。上限は技術的な `STREAM_BUDGET` で、課金上限ではない。小幅画面・多数プロジェクト時の使いやすさを確認する | 公開の中心。Pro差分は仕様未決定 |
| T02 | 通常シェル／Claude、入力・貼付・リサイズ・停止・再接続：`TerminalPane.tsx`、`claudeTerminal.ts`、`terminal.ts`、`sse.ts` | 実装あり。ペイン設定の保持と、アプリ終了後の任意プロセス復元は別。すべてのシェル作業が復元するとは案内しない | 公開の中心 |
| T03 | ローカルClaudeの検出・ログイン確認：`claudeConnection.ts`、`useClaudeConnection.ts` | 実装あり。接続表示は診断で、全操作の事前合格ではない。CLI未導入／未ログインでの案内を新規Macで確認 | 公開。アプリのログインと区別する |
| T04 | エディタ起動・Finder表示・ブランチ切替・worktree掃除：`routes/project.ts` | 実装あり。dirtyなworktreeを残す経路あり。外部エディタなし・ブランチ競合時の案内は実操作で確認 | 公開の補助 |

### 認証・プラン・自動処理

| ID | 機能・入口 | 現状と残作業 | 初回公開の扱い |
| --- | --- | --- | --- |
| P01 | 任意のアプリログイン・ログアウト・トークン更新：`AuthContext.tsx`、`supabaseAuth.ts`、`routes/auth.ts` | 実装あり。設定なしでもFree。Google／GitHub OAuthと2アカウント・2端末の実試験が残る | Freeはログイン必須にしない |
| P02 | Free／Pro／Owner判定、Owner API保護：`billing.ts`、`roles.ts`、`server/app.ts:83` | 実装あり。Ownerは課金と独立。UI非表示に加えAPIを保護。実ロール更新・長時間オフラインは別途確認 | 公開の基盤 |
| P03 | Checkout・支払管理・解約・Webhook同期：`worker/src/billing.ts`、`BillingSection.tsx`、migration `0016_billing.sql` | 外部設定待ち。模擬Stripe／DBの検証はあるが、実DBの権限・実決済は未検証。通信不能時の表示はA06 | 有料公開の必須条件 |
| P04 | Proの期限失効・自動処理停止：`swarmGate.ts`、`swarmOrchestrator.ts` | 実装あり。新しい自動処理を止め、既存ジョブとデータ・停止操作を保持する。実Proアカウントでの期限切れ一巡は残る | 有料公開の必須条件 |
| S01 | 補給官・司令官・Worker、自動配車：`swarmSupply.ts`、`swarmManager.ts`、`swarmWorker.ts` | 実装あり。現在のWorker／司令官はAgent SDK。通常Terminalとは実行方式が異なる | macOS Pro／Owner。実行条件の未解決事項は計画書に記録 |
| S02 | 監視・quota・停止・復旧・再起動：`swarmOrchestrator.ts`、`swarmQuota.ts`、`workerRuntime.ts` | 実装あり。SDK／PTY両方の稼働を扱う。実モデルの枠切れ・クラッシュ・途中更新・復旧は未検証 | 「無停止・完全自動」と約束しない |
| S03 | 独立レビュー・差し戻し・統合・エスカレーション：`swarmOverseer.ts`、`swarmEscalations.ts`、`docs/commander/` | 実装あり。人の返答待ち・高リスク保留を含む。非OwnerのProで作業→レビュー→差し戻しの実完走が残る | 有料公開前に通す |
| S04 | 使用可能モデル・実行モード・文脈上限：`SwarmAllowedModelsSetting.tsx`、`swarmLaunch.ts`、`deskContextCap.ts` | 実装あり。上限値の一部はAPI／設定ファイルのみ。契約プラン別の実モデル利用可否は実測が必要 | 詳細設定。単なるモード名を課金プランと混同させない |
| S05 | Worker試行 `thinkInCode`：`SettingsPanel.tsx:770`、`workerTrials` | 実装あり。現在はSwarm利用者に表示され、Proにも出る。Owner実験と公開する設定の区別を決める（A11） | 初期公開の強みとして宣伝しない |
| S06 | Codex／ChatGPTサブスク接続 | 未実装。今回追加していない | 後続の独立した変更 |

### Ownerの高度機能

| ID | 機能・入口 | 現状と残作業 | 扱い |
| --- | --- | --- | --- |
| O01 | プロジェクトCanvas、図形・付箋・画像・画面・レイヤー・履歴：`CanvasWorkspace.tsx`、`canvasData.ts` | 実装あり。OCCと画像参照を扱う。既存データの複製で編集→保存→再起動→権限切替を確認する | Owner維持 |
| O02 | CanvasのAI生成・修正：`canvasAi.ts`、`routes/canvasAi.ts` | 実装あり。サーバー側ジョブで画面移動後も継続。実Claudeの生成／中断・競合は今回未検証 | Owner維持 |
| O03 | Research一覧・読書・再調査・要約・質問：`ResearchModule.tsx`、`researchReports.ts`、`researchKnowledge.ts` | 実装あり。`docs/research/*.md` と1階層下を読む。新規の実調査→表示→要約→質問は今回未検証 | Owner維持 |
| O04 | 調査チャンネル診断・X Cookie保存：`SettingsPanel.tsx:980`、`researchChannels.ts`、`researchAuth.ts` | 実装あり。診断はローカルのツール／保存状態の確認で、各サイトとの疎通保証ではない。初回読込失敗の表示はA05 | Owner維持。Cookieを公開・ログ出力しない |
| O05 | WordPress設定・選択レポートの下書き送信・追随：`blogPublish.ts`、`routes/research.ts:131` | 実装あり／要修正（A02〜A04、A08）。約5分ごとに同期し、選択ボタン時は即時送信。手動編集・公開済み投稿は上書きしない | Owner維持。実ブログ未接続 |
| O06 | Songs：`CustomModuleView.tsx`、`localAppFrame.ts`、`localAppLauncher.ts` | OpenGround側の起動・表示・マイク許可は実装あり。本体は別のNENEプロジェクト。登録済みNENEの `serve.js` 等が必要で、単体配布だけでは揃わない | Owner維持。録音・再生・書出しの全体受け入れは別リポジトリ込み |
| O07 | カスタムタブの作成・編集・取付・表示：`customModules.ts`、`CustomFrameHost.tsx` | ローカル利用を実装済み。iframeは権限を限定。Ownerを外すと表示・再生を閉じるがソースを消さない | Owner維持 |
| O08 | Global／Project Skillsの閲覧・生成：`GlobalSkillsPanel.tsx`、`projectSkills.ts`、`generateSkill.ts` | 実装あり。管理UIはOwner限定。実際のClaudeファイルへの生成・既存ユーザー記述の保持を複製環境で確認 | Owner維持 |
| O09 | 画面内Assistant、写真、提案→Board：`FloatingAssistant.tsx`、`phoneAssistant.ts` | 実装あり。写真・メモ・会話は別の永続体。実モデル・音声は今回未検証 | Owner維持 |
| O10 | iPhoneペアリング、暗号化中継、会話・通知：`PhoneLinkSetting.tsx`、`phoneLink.ts`、`worker/src/` | 実装あり。iPhoneアプリ・relay・APNs鍵等の別設定が必要。今回Mac／iPhoneの実機往復なし | Owner維持。初回一般公開の必須機能から外す案 |
| O11 | Assistantの会話保持日数・長期メモ・削除：`AssistantMemorySetting.tsx`、`assistantMemory.ts` | 実装あり。保持値を下げる操作には削除確認がある。実機での記憶更新・削除の観測は未実施 | Owner維持。試験はダミー会話のみ |
| O12 | 日次燃料レポート・改善提案・実験：`dailyFuelReport.ts`、`experiments.ts` | 実装あり。背景処理は実際のOwnerを再確認する。OS sandboxの実効性はA07 | Owner維持。Free向け背景処理を増やさない |

### 共通基盤・配布

| ID | 機能・入口 | 現状と残作業 | 扱い |
| --- | --- | --- | --- |
| C01 | 利用枠・トークン内訳：`UsageHud.tsx`、`claudeUsage.ts`、`claudeUsageCli.ts` | 実装あり。ローカル推計とCLI表示を使い、CLIの出力変更に追随が必要。金銭的な請求明細そのものではない | 公開の補助 |
| C02 | 通知・完了音・音量・試聴：`NotificationPanel.tsx`、`osNotify.ts`、`SettingsPanel.tsx` | 実装あり。OS通知は許可した種類のみ。音の試聴結果をUIが読まない点と日英文言はA05／A12 | 公開。失敗表示を整える |
| C03 | テーマ・言語・マニュアル・更新履歴・バージョン：`Toolbar.tsx`、`I18nContext.tsx`、`SettingsPanel.tsx` | 実装あり。文言と現行機能にずれあり（A10／A12） | 公開 |
| C04 | Feedback投稿・Owner受信箱：`FeedbackModal.tsx`、`routes/feedback.ts` | 実装あり／外部設定待ち。読み側の権限と入力のサニタイズあり。実窓口の受信確認は残る | 公開窓口を一本にする |
| C05 | 共同編集・招待・共有カード・ローカルフォルダ紐付：`App.tsx:193`、`SharedProjectBody.tsx`、`routes/collab.ts` | UIも実装あり。古い「member UI未実装」のTODOは陳腐化。既定OFF、実2ユーザー試験が残る。Canvasは別途App Ownerも必要 | 既存機能を維持。初回公開での積極提供は別判断 |
| C06 | 業務モード（外部通信制限）：`lockdown.ts`、`electron/lockdown.js` | 実装あり。ログイン・課金・更新・共有にも影響。特に契約継続中の説明と解約導線はA06 | 公開。契約の解約操作とは区別 |
| C07 | 自動保存・破損検知・世代バックアップ：`homeBackup.ts`、`homeIntegrity.ts` | 実装あり。ただし世代バックアップ対象は `settings.json` とGroundの `canvas.json` の2つ。全データのバックアップ／移行UIではない（A13） | 公開。保護範囲を正確に案内 |
| C08 | 管理ファイルの配備・旧データ移行・残骸掃除：`managedFileInstall.ts`、`paths.ts`、`retention.ts` | 実装あり。既存ユーザー記述を保護する経路あり。実際のOwner環境を複製して更新試験する | 既存データ保護の必須条件 |
| C09 | Electron配布・署名・更新・再起動：`electron/main.js`、`autoUpdatePolicy.js`、`release.yml` | 実装あり／配布候補未検証。依存更新、署名、Finder起動、更新と復旧が残る。既定の自動適用とREADMEが不一致 | macOSを先行。検品前に公開タグをpushしない |

### 意図的な非対応・撤去済み

- WordPressの**一般公開操作**、画像同期、複数サイト同時対応はv1の対象外。
  下書き機能が未完成だから公開操作を足す、とは判断しない。
  ただし設定から送信先を変更できる以上、A03の誤参照防止は必要。
- カスタムタブの市場・配布・申請・審査は廃止済み。復活させない。
- 旧Chats／Overview／batch-run、旧アプリ起動メニュー、Worker／司令官のruntime切替は撤去済み。
  互換データがディスクに残っていても、新しいUIで復活させない。
- Windows Proは実機検証まで新規購入／自動処理を閉じる現行方針。
  Ownerの既存権限と契約管理を勝手に削らない。

## 4. 設定画面を項目単位で整理

| 項目／入口 | 保存・反映 | 現在の対象 | 残る確認・整理 |
| --- | --- | --- | --- |
| プラン | hosted状態を読取。Checkout／Portalは外部ブラウザ | 全員。購入はログインしたmacOSユーザー | 外部設定、実決済、取得不能時の表示（A06） |
| 言語 | `language`。UIと生成プロンプトへ反映 | 全員 | 通知の日本語固定箇所（A12） |
| テーマ（Toolbar） | `theme` と初期描画用localStorage | 全員 | 保存競合と別画面からの変更を確認 |
| 表示名 | `displayName`。約500msの自動保存 | 全員 | 空欄・IME・保存失敗・連続操作（A01／A05） |
| 自動更新 | `autoUpdate`。未設定はON | 全員 | 実配布の更新・停止中作業・復帰を確認 |
| 調査チャンネル | ローカル診断。再確認で再読込 | Owner | 通信成功の表示ではない。初回失敗が空欄になる（A05） |
| X認証情報 | 別の `research-auth.json`、0600。APIは保存有無だけ返す | Owner | 保存・除去後の実調査は未検証。値を報告資料へ出さない |
| WordPress | `wordpress`。URL／ユーザー名／アプリパスワードを明示保存 | Owner | 接続試験なし。台帳・送信先・秘密の保管（A02〜A04、A08） |
| 完了音・音量・試聴 | `soundOnDone`／`soundOnDoneVolume`。試聴はOS再生 | 全員 | 連続保存、OS再生不能の説明（A01／A05） |
| 更新履歴・バージョン | 外部履歴／ローカルhealthを読取 | 全員 | オフライン・業務モードの表示、実配布との一致 |
| 一般ユーザー表示プレビュー | ウィンドウ内だけ。設定やロールを変更しない | 実際のOwnerのみ | データ操作は実データに効く。テスト用アカウントの代用ではない |
| 既定の作成先（詳細） | `defaultWorkspace`。約500msの自動保存 | 全員 | 登録済みプロジェクトの許可リストとは別。新規Macの選択確認 |
| Claude接続状況（詳細） | `claude auth status` 等を確認 | 全員 | アプリ認証・利用枠・起動可能の全保証と混同しない |
| 業務モード（詳細） | `lockdownMode`。保存後に外部通信を制限 | 全員 | 契約の継続・解約との関係（A06） |
| Swarm有効化（詳細） | `swarmOptIn` は同意。権利はサーバー判定 | macOSの有効Pro／Owner | 無料の解除スイッチに戻さない |
| 使用可能モデル（詳細） | `swarmAllowedModels`。最後の1モデルはOFF不可 | Swarm利用者 | モデルの利用可否を実契約で確認 |
| iPhone・APNs・会話メモ（詳細） | 専用ファイルとPhone API。鍵は返さない | Owner | iPhone・鍵・relayの外部設定と実機往復 |
| Worker試行（詳細） | `workerTrials.thinkInCode`。既存Workerには遡及しない | 現在はSwarm利用者 | 公開向け設定かOwner実験かを整理（A11） |
| 実験（詳細） | `experiments.swarm`／`sandbox` | Owner | SDKではOS sandboxが働かない点（A07） |
| プロジェクト別設定（⋯） | `ProjectConfig` の基準ブランチ・担当者、実行既定値はBoard側 | 公開 | 全体設定と入口が別。説明と保存競合を確認 |
| 文脈上限等の内部設定 | `deskContextCapTokens` 等。UIなしの値もある | API／ローカル設定 | 全キーを一般設定へ並べない。内部状態・旧キーを設定項目扱いしない |

整理案：一般画面は現行のBoard／Terminalを維持し、設定は「基本」「プラン」「詳細」を軸にする。
Research／ブログ／Phone／実験はOwner側にまとめる。個人利用の主画面に全機能を並べない。
まずA01／A05を直し、その後に既存のデザイン原則とinteractive statesを保って配置を調整する。

## 5. 修正バックログ

P1は該当機能を出す前に対応。P2は初回公開の範囲を絞って後続に回せる。
工数は実装と対象回帰テストのおおまかな目安で、確約ではない。実アカウントの準備・審査待ちは含まない。

| ID／分類 | 問題・影響と根拠 | 優先／いつまで | 工数目安・受け入れ条件 |
| --- | --- | --- | --- |
| A01 設定・データ | **連続操作で先の変更が戻る（再現済み）**。UIが `{...settings, changedKey}` を送り、serverはキー単位でmergeするため、後の古いスナップショットが先の値を上書き。`SettingsPanel.tsx:212,330,342`、`store.ts:258` | P1・Beta前 | 1〜2日。変更キーだけの保存と失敗時の扱いを整え、応答を遅らせた2操作・言語／テーマとの競合でも両方を本番読取で確認 |
| A02 ブログ・並行処理 | **同時送信で同じレポートから2つの下書き（再現済み）**。tickのinflightはtick同士だけを防ぎ、手動ボタンとsweepは同じロックを持たない。`blogPublish.ts:442,469` | P1・Owner更新前 | 1〜2日。手動／定期／再試行を同じプロジェクト・レポートの直列化に通し、同時2要求でも投稿1件・台帳1件 |
| A03 ブログ・データ境界 | **送信先変更後も旧postId／adminBaseを使用（再現済み）**。台帳はサイトに結び付かず、Bサイトの同番号を参照、リンクはAサイトのまま。条件が一致するとBの別下書きへPOSTする。`blogPublish.ts:94,302,339` | P1・Owner更新前 | 1〜2日。サイト識別を照合し、変更時の明示した引継ぎ方針を実装。旧記事・台帳を削除せず、新サイトへ古いIDを送らない |
| A04 秘密の保管 | **WordPressパスワード入り設定・設定バックアップに0600指定なし**。umask 022の隔離実測で644。`store.ts:142`、`homeBackup.ts:331`。他ユーザーから読めるかは親ディレクトリ権限にも依存し、外部漏えいは実証していない | P1・Owner更新前 | 0.5〜1日。現行ファイル・以後の世代を適切な権限にし、既存データを消さない。解除後もバックアップに値が残ることと保管方針を明示 |
| A05 設定・失敗状態 | **保存／診断の結果が分かりにくい**。一般設定の通信例外は `App.tsx:1065` でcatchなし。HTTPエラーはalertを出すがスイッチが保存済みと異なるまま。WordPress保存はbusy／成功・失敗の専用状態なし。調査診断の初回失敗はcatch後に空欄。音の試聴は `played` を見ない | P1・基本設定はBeta前、Owner部分はOwner更新前 | 1〜3日。読込・空・保存中・成功・失敗・再試行を実際の応答に合わせる。失敗した値を保存済みと案内しない |
| A06 課金・状態表示 | **契約確認不能と本当のFreeの表示が混ざる**。serverの `status:'unavailable'` をUIが判定せずFree価格を表示。業務モードでは `configured:false` となり「準備中」＋Portal非表示。Stripe上の契約はそれだけでは解約されない。`billing.ts:17,44,70`、`BillingSection.tsx:48` | P1・有料テスト前 | 1〜2日。機能権限は安全側を維持しつつ、契約未確認／業務モード／未設定を区別。請求が続き得ること・契約管理への復帰手順を確認 |
| A07 実験・安全性の表示 | **sandboxスイッチがSDK WorkerのOS隔離を保証しない**。`swarmWorkerSdk.ts:224` は警告を返して通常起動、`swarmWorker.ts:1083` はconsole.warnのみ。A3/L4のガードは別にあるが、OS sandboxとは異なる | P1・Owner更新前 | 0.5〜1日（表示と対応範囲の明確化）。各実行経路の対応を表示し、非対応をONで保護済みと受け取らせない。OS隔離実装を今すぐ全面改造する提案ではない |
| A08 ブログ・復旧 | 台帳読込破損→空、書込失敗→握りつぶし。送信成功とローカル記録を対応させられず、再送時の重複や選択記録消失につながる。接続テスト、レポート単位の同期解除もない。`blogPublish.ts:96,119`、`SettingsPanel.tsx:865` | P1・台帳保護はOwner更新前。接続テスト等はP2 | 1〜3日。台帳失敗を成功扱いせず診断可能にする。遠隔投稿後・台帳保存前の中断を試験。既存WP投稿を勝手に消さない |
| A09 課金価値・仕様 | コードと価格表のPro差分は今も自動処理が中心。作業管理を課金の中心にする新仕様は未決定・未実装 | P1・価格の訴求変更前 | まず仕様を1回確定。既存Freeの複数Terminalは保持。利用者が有料差分を説明できることをBetaで確認 |
| A10 ドキュメント・販売表示 | READMEは旧projects-root導入、プロジェクト内データ、Intel非配布、更新はnever mid-run等を記載。現行実装と不一致。landingは全員Canvas／自由タブ／共有Canvasが使えるように読め、Proの訴求も旧方針。collabの未実装TODOも古い | P1・Beta案内／一般公開前 | 1〜2日。Free／Pro／Owner、中央保存、実際の初回操作、対応OSと更新挙動を一本化。未確認の安全保証を書かない |
| A11 公開設定・実験の境界 | `workerTrials` はOwner限定の実験という資料と、Swarm利用者に出るUI／request-settable実装が一致しない | P2・一般向け設定整理時 | 0.5日程度。Owner実験にするか、意味を説明できるPro詳細設定にするかを確定。値を消さず表示とAPIを合わせる |
| A12 文言・サポート | Swarmの通知・質問・一部操作が日本語固定。`CLAUDE.md` Language policyにも記録済み。日英切替を提供する一般製品として未整理 | P2・非日本語Beta／公開前 | 1〜3日。利用者に届く通知・失敗・停止・質問を対象に確認。内部ログの全面翻訳は不要 |
| A13 データ保護・運用 | 自動世代バックアップは登録一覧とGround配置のみ。Board、各Canvas、Research、カスタムソース、WP台帳、Assistant等の全体移行・復元ではない。`homeBackup.ts:62` | P1・Owner更新／Beta前に手順、有料公開前に復旧実測 | 手順0.5〜1日＋受け入れ1〜2日。全保存領域の複製から読み戻す。バックアップUI新設は別の範囲判断 |

A03は「複数サイト同時対応」という新機能の要望ではなく、既存設定変更時の誤参照を防ぐ修正。
A01はserverの書込みロックを増やすだけでは直らない。古い全体スナップショットを送る契約自体を直す。
A02／A08はatomic renameだけでは投稿の一意性を保証できない。遠隔の作成と台帳記録の間の失敗も扱う。

### 外部設定・配布のゲート（コード修正と分けて管理）

| ID | 未完了の条件 | 完了の証拠 |
| --- | --- | --- |
| R01 | Supabase OAuth・billing migration／RLS／RPC・Stripe test/live・Worker設定 | 実DBのアクセス制御、ログイン、同時購入、通知の重複・遅延、失効・復帰・解約を実測 |
| R02 | 非OwnerのProで実Claudeの一巡 | 配車→監視→独立レビュー→差し戻し、枠切れ・停止・再起動を観測。Owner代用・fake CLIは不可 |
| R03 | 配布ランタイム／依存更新 | 既記録の全依存監査29件（moderate 6／high 22／critical 1）を再評価。Electronも配布物に含まれる。production依存監査0だけで合格にしない |
| R04 | 新しい署名・公証付きMac候補 | Finderから初回起動、実認証と決済復帰、PTY／SDK、更新、復旧。配布前後で同じ試験データが残る |
| R05 | 個人運営に合わせた販売・サポート情報 | 運営者情報、問い合わせ、利用条件、価格・税、解約・返金、障害時の案内を実際の運用と合わせる |
| R06 | AIサブスク連携の実装条件 | 手動CLIとSDK制御を分けて確認結果を記録。OpenAIへの問い合わせは提出済みだが回答・許可は未確認。APIキー方式へ変更しない |
| R07 | 共同編集／Phone／Songsの別系統 | 提供する範囲を決め、別Worker／NENE／iPhoneを含めて実測。初回一般公開の必須条件をむやみに増やさない |

## 6. 今回の再現と検証

### 隔離再現

実装コードを直接importする一時的なNode／tsxハーネスを実行した。
HOME、`OPENGROUND_HOME`、Claude設定先を新しい一時ディレクトリにし、登録プロジェクトもダミー。
WordPressは注入したfake fetchのみで、外部HTTPを使わない。実ユーザー設定や実ブログは未使用。

| 再現 | 手順 | 観測した結果 |
| --- | --- | --- |
| A01 | 同じ設定からsnapshot A／Bを取得。AでautoUpdateをON保存、BでsoundOnDoneをON保存。UIと同じ全体payloadを使用 | 期待：両方ON。実際：autoUpdateはOFFへ戻り、soundOnDoneだけON |
| A02 | 同じ選択済みレポート・空entriesの台帳を2つのsweepが読む。fake WPの作成応答を待ち合わせ、両方の処理を重ねる | 期待：下書き1件。実際：POST作成2件、台帳に残ったpostIdは1件分だけ |
| A03 | AサイトでpostId 100を作成後、レポートを書換え、Bサイトへ送信先を変更。同IDのdraft・同modified時刻をfake WPが返す | Bサイトの `/posts/100` へGETと更新POST。表示リンクはAサイトのまま。現実のサイトにこの条件があるとは断定しないが、サイト境界の検査欠落を再現 |
| A04 | 標準umask 022で、ダミーWordPress設定と設定世代を保存しstat | データディレクトリ755、settings.jsonと設定世代644。親の権限を含む他ユーザーアクセスは未検証 |

一時ハーネスは監査用で、CIの恒久的な回帰テストには未追加。修正時に、同じ観測を行うテストを追加し、
修正前の失敗と修正後の成功を確認する。既存テストの緑でA01〜A04を解決済みにしない。

### 既存テストの再実行

2026-10-15、`npx vitest run` に以下の22ファイルを指定：**285成功、失敗・skipなし、exit 0**。

```text
src/components/canvas/SettingsPanel.test.tsx
src/components/canvas/BillingSection.test.tsx
src/components/canvas/ProjectPanel.terminalBudget.test.tsx
src/components/canvas/modules/BoardModule.runRouting.test.tsx
src/components/canvas/modules/ResearchModule.test.tsx
server/routes/__tests__/settingsSecurity.test.ts
server/routes/__tests__/settingsRuntimeDials.test.ts
server/routes/__tests__/productAccess.test.ts
server/routes/__tests__/localAppStart.routes.test.ts
server/routes/__tests__/collabMemberFlow.test.ts
src/lib/server/blogPublish.test.ts
src/lib/server/storeSettingsRace.test.ts
src/lib/server/settingsWriteGuard.test.ts
src/lib/server/researchReports.test.ts
src/lib/server/researchChannels.test.ts
src/lib/server/researchAuth.test.ts
src/lib/server/researchKnowledge.test.ts
src/lib/server/localAppLauncher.test.ts
src/lib/server/homeBackup.test.ts
src/lib/server/homeIntegrity.test.ts
src/lib/server/experiments.test.ts
src/lib/server/swarmGate.test.ts
```

ログは `/tmp/og-feature-audit-targeted.log`。一時再現結果は
`/tmp/og-feature-audit-location.txt` が指す作業用ディレクトリの `result.log` にある。
これらはマシン内の補助証拠で、将来も残る成果物ではない。必要な観測結果は上表に記録した。

今回の変更はこの棚卸しと計画・索引の文書のみ。全件テスト、lint、型検査、ビルド、E2E、
署名付きGUI、実Claude、実Stripe／Supabase、実WordPress、NENE、iPhoneの再受け入れは行っていない。
過去の全件／E2E／Electron runtimeの記録は [PRODUCTIZATION_HANDOFF.md](./PRODUCTIZATION_HANDOFF.md) と
PR #2を参照する。今回の合格に読み替えない。

## 7. 実装を進める順序

1. **設定を安心して変更できる状態にする**：A01と一般設定のA05。失敗・連続操作を回帰テストにする。
2. **Ownerのブログとデータを保護する**：A02〜A04、A08の台帳、A07、A13。
   古い投稿・台帳・設定・実験値は保持。ダミーまたは複製だけで検証する。
3. **製品としての見せ方を揃える**：A09で有料差分を決め、A10〜A12と設定の整理を実装する。
   新機能を広げる前に、Freeだけで初回タスクを完了できるかを見る。
4. **公開候補を検品する**：R01〜R06、対象コードのテスト／全件／build／E2Eと実GUIを通す。
   各サービスの未設定状態も確認する。未解決・未検証はリストに残す。
5. **少人数Beta→一般公開**：同じ候補で導入・並列Terminal・Board・停止・解約を試し、
   問い合わせと失敗を直す。R07は提供範囲ごとに独立して受け入れる。

この棚卸しは全ソースの完全な安全証明ではない。画面・設定・主要API・永続化・起動処理と関連テストを
突き合わせた初回監査であり、未知の不具合や実環境依存の問題は残り得る。次の実装単位はA01／A05とする。
