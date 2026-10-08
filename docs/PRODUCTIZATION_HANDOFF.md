# OpenGround 製品化引き継ぎ — 2026-10-08

**公開判定：未完了。課金と権限制御を実装したレビュー用ブランチ。**
外部設定・実決済・署名付き配布アプリの受け入れ検証を完了するまで、Proを一般販売しない。
既存ユーザーのデータ削除、設定移行、本番DB変更、デプロイ、リリース、インストールは行っていない。

## ブランチと基準

- 対象：`nannantown/open-ground`、`codex/productize-subscriptions`。
- 公開リポジトリの `main` (`cc82c1e0`) を基準とする。最初に開いた私有開発元
  `nannantown/PMmap` は別の履歴だったため、その無関係な差分をPRに混ぜていない。
- ローカルGitHub認証による push dry-run は成功。以前の連携403とは別経路。
- 既存UIの設計原則と `~/.claude/skills/ui-interactive-states.md` に従い、既存のBtn、
  Settings、ブラウザ起動、Supabase認証、StripeのCheckout/Portalを利用。
  新しい決済SDK・UIフレームワークは追加していない。

## 監査と対応

リポジトリの構成、公開資料、APIルーター、権限の呼び出し元、保存・認証・Swarm起動経路、
配布設定、テスト、依存パッケージを確認した。全高度機能の実サービス受け入れ試験は未実施。

| 領域 | 問題／状態 | この変更 |
| --- | --- | --- |
| 製品仕様 | `BILLING_PLAN.md` は未実装と記載、公開資料はFree Swarmを許容 | Free/Pro/Owner仕様と設定手順に更新 |
| 課金 | Checkout・解約・契約同期なし | 独立した課金Worker、Checkout/Portal、署名Webhook、正規Stripe状態の再取得、専用RLSテーブル/RPC |
| Pro判定 | ローカル設定でFreeがSwarmを開ける | Ownerまたは有効Proを共有ゲートで判定。設定は同意のみ |
| 失効・再起動 | UIを閉じてもエンジンが自動起動し得る | 本番エンジンの配車・監視・復旧・再開で権限を再確認。既存ジョブと保存データを保持 |
| 安全操作 | 全API一律遮断では失効後に停止できない | 稼働状態・quota・stopの明示した経路は保持、新規自動処理は拒否 |
| Owner API | UIだけ隠れてCanvas等へ直接アクセスできる | Canvas AI/ファイル、Research/ブログ、Songs、カスタムタブ、Skillsをハンドラー前にOwner限定 |
| 共有Canvas | プロジェクトメンバー権限だけでCanvasに入れる | ローカルキャッシュと接続チケットにApp Ownerも要求。Boardの既存会員制は保持 |
| Phone/Assistant | ローカルSwarm解除がOwner権限を代替 | 実際のApp Ownerに統一。Freeの背景ポーリングも停止 |
| Owner保存値 | 一般設定の読出しでWordPress秘密が見える、UI省略フィールドが失われ得る | 一般読出しで除外、書込みで既存値とタブ順・非表示・カスタムIDを保護 |
| 認証更新 | 同時更新と遅延応答がログアウトを巻き戻す可能性 | 更新の共有、アカウント／トークン照合、保存失敗の伝達。通信障害でトークンを削除しない |
| UI | 課金入口なし、Owner APIへの不要な背景アクセス | 設定のPlan欄と価格・期限・解約・再確認。FreeはBoard/Terminal固定、Swarmバーなし |
| 配布設定 | 課金URLを配布バイナリへ引き渡せない | 公開URLだけをruntime configとrelease workflowの変数に追加 |
| 公開サイト | Canvas高度機能と「追加料金なし」が一般機能のように掲載 | Free/Pro価格、Claude別契約、Pro準備中、復帰ページ、決済データ処理の説明 |
| Windows | Swarm安全装置・SDKの今回実機検証なし | 新規Pro購入とPro SwarmはmacOS限定。契約管理・解約とOwner既存権限を保持 |
| 依存脆弱性 | runtime依存にも既知脆弱性あり | 互換範囲のlock更新、Worker nanoid更新。concurrentlyが固定しているshell-quoteを修正済み1.12へnpm overrideで更新 |
| 実装済み基本機能 | Board手動実行／通常Terminal、Swarm独立レビュー・差し戻し・安全復旧は既存 | 既存経路を再利用。課金/API関連変更を高リスクレビュー対象へ追加 |
| 残る高度機能 | TODOや過去の検証記述が残る、外部環境依存 | 宣伝範囲を絞り、未検証の項目は下記に残す。過去の実測を今回の完了証拠としない |

OwnerとProは別の権限。課金停止やWorker未設定はOwnerロールを降格しない。
Ownerの既存ローカルメール許可設定は維持する。`swarmLocalOwner` は実際のOwnerの同意に
寄与するだけで、FreeにProやPhone権限を付与しない。

## 検証記録

- 設定なしのFree、署名JWT、Checkout金額/保存先、期限・未払い・解約・回復・不正署名・
  重複通知・正規状態再取得、別アカウント、遅延ログアウト、失効による自動処理停止を検証。
  Stripe/Supabase RESTは模擬応答。実際の決済／DBポリシー動作の証明ではない。
- Free E2E初回：10成功・1失敗。Owner API背景ポーリングを修正し、再実行11成功。
  Board/Terminalと説明生成は隔離HOMEのfake ClaudeをPTYで起動。
- Owner E2E初回：13成功・1失敗。再読込がOwner表示へ戻る既存仕様を反映してfixtureを修正。
  Ownerは使い捨てauth.jsonと実際のロール解決経路で起動する。
- 課金WorkerのWrangler dry-runビルド成功。デプロイは行っていない。
- TypeScriptはroot/Worker成功。ESLintは0エラー（既存警告あり）。
- 最終の全件・E2E・破壊テスト・Electron runtime検証結果は下の追記で記録する。

VitestとPlaywright/buildは同時に実行しない。リポジトリ変更検知の番人が成果物再生成を
正しく異常として検出するため。すべての今回テストは隔離データで行う。

## 公開前に必要な残作業（完了扱いにしない）

1. **外部設定**：`BILLING_PLAN.md` の手順で専用Supabaseテーブル/RPC/RLS、Stripe
   test/liveモード、月額JPY 2,980価格、解約Portal、署名Webhook、課金Workerを設定する。
   認証情報を取得／利用していないため、今回は未設定・未デプロイ。
2. **認証・課金実環境試験**：Google/GitHubログインとJWKS、2アカウント・2端末、
   同時Checkout、支払成功／失敗／再試行、月末解約、失効・回復、Webhook遅延・重複、
   通信障害、再起動・再インストールをStripe test modeで観測する。最後に制御した
   live決済・解約で検証。SQLのprivilege/条件付き更新は実DBで未検証。
3. **実Claude・Pro機能受け入れ**：有効ProでSDK Worker配車、監視／復旧、独立レビュー、
   差し戻しを実Claudeで実行し、失効後の自動再開拒否と既存ジョブ停止・データ保持を確認。
   fake CLIやpure engineテストを実モデルの完了証拠にしない。
4. **配布基盤の更新**：Electron 31と旧electron-builder/rebuild系は古い。
   全依存監査に残る開発／配布ツール脆弱性の更新、互換性・署名・notarization・
   自動更新を別途検証する。ElectronはdevDependencyでも配布ランタイムなので、
   `audit --omit=dev` が0であることだけで公開可能と判定しない。
5. **署名付きGUIとWindows**：新しい署名付きMacアプリのFinder起動、ログイン→Stripeの
   外部ブラウザ→アプリ復帰、PTY/SDK、更新、OwnerのSongs/Canvas/Research/ブログを
   保存済みデータの複製で確認。Windowsの署名証明書・署名も整備する。
   実Windowsで同じ基本操作と安全装置を測定するまで
   Windows Pro購入を開放しない。インストール済みアプリは置換していない。
6. **事業者・販売資料**：運営者の正式名称・住所・問い合わせ先、特商法表記、利用規約、
   価格／税・返金／紛争処理・データ保存方針を確定し、公開サイト/Stripeに反映する。
   仮の運営者情報や未確定ポリシーは作らない。返金／紛争だけではactive契約が停止しないため、
   運用上必要なStripe解約と権限停止を確認する。
7. **一般公開**：PRレビュー、CI、上記受け入れと事業設定の完了後にリリース承認。
   現行タグworkflowは自動publishするため、検証中にタグをpushしない。

未設定時はFreeを使える。支払秘密はデスクトップへ配布しない。決済完了URLやローカル設定を
根拠にProを付与しない。本番データを消す手順はない。

### 今回の追加検証

- Freeの全Playwright対象：25成功。Ownerの初回全対象：77件中66成功・11失敗を検出。
  Assistantの正しい余白をテストに反映し、実際にはみ出した司令官幅をCSSの利用可能幅で
  制約した後、該当11件を含む28件が成功。最終のOwner全対象を再実行して77件すべて成功。
  1280/390pxのFree設定画面を目視確認。landingの価格・決済復帰・privacyページも両幅で検査。
- Cloudflareの実ローカルランタイム：collabの全チェックとPhone relayの全チェック成功。
  非OwnerのCanvas ticket拒否、Owner＋membershipの許可も実際のWorkerで確認。
- 破壊テスト：Owner APIの判定、Proの期限判定、Checkoutの金額判定を一つずつ外して
  各回帰テストの失敗を確認。すべて復元した23件が成功。
  追加で課金先URL固定と再利用Checkoutの価格判定を外して失敗を確認、復元した22件が成功。
- インストール済みElectron 31.7.7 / Node 20.18.0で最新サーバーバンドルを3回起動。
  隔離HOME・dummy Owner・fake ClaudeでOwner→Free→OwnerのCanvas/WordPress/タブ設定保持、
  FreeのSwarm拒否、通常Claude PTYの起動/停止を確認。終了後の専用ポート解放も確認。
  実サービスや新しい署名付きGUIの検証ではない。
- ESLint：0エラー・205警告。root/Workerの型検査成功。根本依存とWorkerのproduction監査は0件。
  配布/開発依存を含む監査は29件（moderate 6 / high 22 / critical 1）残る。
  tar/electron-builder系のmajor更新とElectron更新は公開前に必要。
- 全ユニット初回では旧Freeローカル解除を許すfixture等が失敗し、最終の再開テストが
  権限拒否で待ち続けたため中断。既存機能のテストには明示したライセンスを注入し、
  実際のFree拒否・期限失効の検証は維持した。関連261件と残るAPI契約171件が成功。
  全件の最終結果はPRの検証記録とCIを参照する。
