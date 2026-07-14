# Sync カバレッジ監査 — 共同開発シナリオ × OPEN GROUND の対応状況

2026-06-11 実施。マルチエージェント監査（コード読解4系統 → シナリオ36件列挙 → 実装マッピング → 非カバー判定23件は全件コードに対する反証検証済み）。
凡例: ○=カバー / △=部分カバー / ×=ギャップ。詳細は各シナリオの節を参照。

**集計: ○ 13 / △ 18 / × 5（全36シナリオ）**

## 対応履歴（2026-06-11 同日実装）

監査直後に以下を実装済み — 各シナリオの「現状」記述は監査時点（実装前）のもの:

- **S22** autostash 復元衝突を検知し `reason:'autostash-conflict'` で永続エラー表示（無言の "Synced" を廃止）
- **S29/S26** Sync 前に rebase/merge 進行中・detached HEAD を検査してブロック（ユーザーの rebase を abort しない）
- **S24/S32** push が non-fast-forward のとき pull→push を1周だけ自動リトライ
- **S4** upstream 無しブランチは `push -u origin <branch>` で自動公開
- **S25** fetch/pull の "(forced update)" を検知 — status に sticky な `forcedUpdate`（Sync ボタンに ⚠）、取り込んだ Sync は永続警告
- **S23/S28/S3** オフライン / identity 未設定 / remote 無しを分類し、日英の行動可能な通知文に置換（`offline`/`reason:'no-identity'`/`noRemote`）
- **S15–S20** 衝突時に unmerged ファイルを abort 前に収集し `conflictFiles`（`card "タイトル"` / `notes` / 相対パス）として通知に表示
- **S9/S33** Sync ダイジェストがカード名を表示（追加/完了/移動「X」→列/担当変更「X」→名前、2件まで命名・以降は件数）
- **S27** ShareStatus に `branch` を追加し Sync ボタン横に ⎇ブランチ名を常時表示
- **S10** 最終 Sync 時刻を Sync ボタンの tooltip に表示
- **S1** 共有有効化直後に「Sync を押すとリモートに公開されます」を通知
- **S36** 「自分のみ」は表示名未設定でも disabled で表示し、設定への導線を tooltip に表示
- 通知の truncation 修正: エラーは 480px + 全文 tooltip

## 一覧

| # | 判定 | シナリオ | 一言 |
|---|------|----------|------|
| S1 | △ | 共有を有効化する（Share via Git） | 有効化は1クリックで完了するが、期待にある「初回コミット・プッシュ」は enable では一切行われない（server/routes/share.ts:43-6… |
| S2 | ○ | 同僚が共有クローンをインポートする | 「共有プロジェクトとして読み込みました」のような明示的なお知らせ表示は無い — Sync ボタンと remote 名が黙って現れるだけ。機能的にはゼロ設定で完全… |
| S3 | △ | remote が無いリポジトリで共有を有効化しようとする | 期待の後者（ローカルのみ許容＋Sync 時に案内）はほぼ満たすが、「次の一手」の提示が無い — `git remote add origin …` のコマンド例… |
| S4 | × | ブランチに upstream が無い状態で Sync を押す | 新ブランチ上ではコミットがローカルに溜まり続けるのに ↑ バッジは 0 のまま（『未公開』状態の表示が無い）。ユーザーは Sync するたびに 'push sk… |
| S5 | ○ | privateリポジトリの認証がそのマシンに無い | git の生エラーは見えるが、「ターミナルで git fetch が通るようにしてください」のような復旧手順の案内文は無い。また behind バッジ用 fet… |
| S6 | ○ | アプリを開いている間に同僚が push したことに気づく | バッジ点灯までの最悪レイテンシは 90s ポーリング＋fetch が 2.5s を超えた場合は次のポーリング待ちで実質 ~3 分になり得る（期待の『数十秒〜1分… |
| S7 | ○ | アプリを閉じていた間の同僚の更新に、起動時に気づく | fetch が 2.5s を超える遅い回線では初回 status は behind=0 で返り、バックグラウンドで完了した fetch の結果は次のポーリング（… |
| S8 | △ | 自分に未 push のローカル変更があることに気づく | バッジの存在場所が ProjectPanel のヘッダーのみ。Ground（ポートフォリオキャンバス）のプロジェクトカードには share 状態の表示が一切なく… |
| S9 | △ | pull 後に「何が変わったか」を知る | ダイジェストは件数ベースで、カード名（タイトル）は出ない — 追加カードの assignee 名のみ括弧表示。期待されている『どのカードが Doing→Revi… |
| S10 | △ | 同僚が作業中であることを盤面から察知する | 『最後に Sync した時刻』の表示が無いため、見ている assignee/列情報の鮮度（同僚情報が10分前のものか3日前のものか）を判断する手がかりがない。b… |
| S11 | ○ | 作業開始前に最新を取り込む | 『Pulled n commits』というコミット数表示は無い（Board 単位のダイジェストか汎用 'Synced'）。実用上の朝イチ取り込みフローは完全に機… |
| S12 | ○ | 編集を終えたら push する | git add -A -- .openground/ と commit の pathspec 限定（SHARED_DIR）はコントラクトテストで固定されており、… |
| S13 | ○ | 双方が変更したが別ファイル同士の Sync | 1カード=1ファイル（board/cards/<id>.json）の設計が『append never conflicts』を明示目的としており、別ファイル同士の… |
| S14 | ○ | 何も変更が無い状態で Sync を押す | 文言が『Already up to date / 最新です』ではなく汎用の『Synced / 同期しました』である点だけが期待とのズレだが、実害なし。 |
| S15 | △ | 同じカードの同じフィールドを両者が編集して衝突 | 中途半端な rebase 状態には絶対ならない（テストで rebase-merge/rebase-apply 不在・クリーンツリーを固定済み）が、期待される「カ… |
| S16 | △ | 同じカードの別フィールドを両者が編集 | 行が隣接して git 的に衝突した場合は S15 と同じ汎用 abort（conflict:true ＋手動解決メッセージ）に落ち、カード単位の解決 UI は無… |
| S17 | △ | 一方が削除したカードを他方が編集していた | 「復活させる / 削除を受け入れる」の二択 UI は無い。ユーザーには汎用の「同期が競合しました。手動で pull して解決してください。」しか出ず、削除との衝… |
| S18 | ○ | カードの並び順・列ファイルが両者で食い違う | 唯一の穴は「両者が“同じ”カードをドラッグした」場合で、同一ファイル衝突として S15 の汎用 abort に落ちる（自動解決はされない）。ただしカード本体デー… |
| S19 | △ | Canvas の同じ要素（付箋など）を両者が編集 | 「Canvas『Y』が衝突」というファイル名提示すら無い — conflict 時の message はサーバの固定文字列で、どのファイルかは含まれない。ユーザ… |
| S20 | △ | notes.md を両者が編集して衝突 | 「notes.md が衝突しています」というファイル名の明示が無い — UI のメッセージは固定文（手動で pull して解決してください）で、サーバ側 mes… |
| S21 | ○ | Sync 途中の rebase 衝突で処理が中断する | ほぼ満点だが 2 つの小さな残差：(1) abort は best-effort（catch して握りつぶす）なので、abort 自体が失敗する異常系では理論上… |
| S22 | △ | 自分のコード（.openground 外）が dirty な状態で Sync / autostash 復元失敗 | autostash の適用が衝突すると git は『Applying autostash resulted in conflicts. Your changes… |
| S23 | △ | オフラインで Sync を押す | オフライン特有の案内がない: https リモートの『Could not resolve host』は NO_UPSTREAM_RE に一致しないので生の gi… |
| S24 | △ | push が non-fast-forward で拒否される | 期待される自動リトライ（fetch→rebase→push をもう一周）が無い。non-fast-forward は1クリックで透過的に直るべき典型ケースだが、… |
| S25 | × | upstream が force-push / 履歴書き換えされていた | force-push 後の Sync は (a) 衝突しなければ黙って成功し、書き換え前の自分の旧コミットが rebase で新履歴に重複 replay される… |
| S26 | × | detached HEAD で Sync を押す | 期待と真逆の挙動になる: detached HEAD でも pathspec commit は成功するため『openground: sync』コミットがどのブラ… |
| S27 | × | ブランチを切り替えたら共有データはどうなるか | git switch すると .openground/ がブランチごと差し替わり Board が突然別物になるが、UI は『なぜ変わったか』を一切説明しない（ブ… |
| S28 | △ | git の user.name / user.email 未設定で Sync | 原因特定と導線が不足: 表示されるのは git の生の一行『Author identity unknown』だけで、『git config --global u… |
| S29 | × | リポジトリが rebase/merge 途中の状態で Sync を押す | ユーザーが衝突解決の途中だった手動 rebase（.git/rebase-merge あり）の上で Sync を押すと、(1) .openground/ が d… |
| S30 | ○ | 同一ユーザーの2台のマシン間で同期する | 盤面データは .openground/（カード=1ファイル、notes.md、canvas/）として git で運ばれ、自宅マシン側はマーカー検知で自動的に s… |
| S31 | △ | claude タスクセッションが API でカードを書いている最中に Sync | shareSync 自体は board 書き込みキューと直列化されておらず、git 操作と claude の書き込みの相対順序は保証されない。具体的なエッジ: … |
| S32 | △ | 二人が同時に Sync ボタンを押す | 期待されている『rejected → 自動 fetch+rebase+push リトライで数秒後に成功』は未実装。負けた側のユーザーは notice に『pus… |
| S33 | △ | 担当者（assignee）変更が同僚に伝わる | S9 型の取り込みサマリ（boardDiffDigest）は added / done / moved / removed しか数えず、assignee 名が出… |
| S34 | ○ | Review 列 + PR URL が同僚から見える | reviewColumn は共有 ProjectConfig としてマーカー（.openground/openground.json の config）に乗り、… |
| S35 | ○ | メンバーリストの変更がチームに伝播する | members（assignee 候補リスト）は ProjectConfig の一部としてマーカーファイル側（.openground/openground.js… |
| S36 | △ | 「自分のみ」フィルタが名前ベースで正しく効く | 2点が未カバー。(1) identity マッピングが存在しない — 照合は文字列完全一致のみで、メールアドレス vs 表示名、'Yuki' vs 'Yuki … |

## 詳細

### S1 △ 共有を有効化する（Share via Git）

- **ユーザー行動**: プロジェクトオーナーが設定パネルから「Share via Git」を有効化する。中央(~/.openground/projects/<uuid>/)にあるBoard+Canvasデータがリポジトリ内の .openground/ に移動し、マーカー .openground/openground.json が作られる。
- **期待**: 有効化は1クリックで完了し、移動されたファイル一覧（board/cards/*.json, canvas/ 等）が初回コミットとして .openground/ スコープでコミット・プッシュされる。ユーザーのコードには一切触れないことが明示される。失敗時（remoteなし等）は有効化前に警告される。
- **現状**: More メニュー「Share via Git…」→ 確認ダイアログ → POST /api/project/share/enable が中央データを .openground/ に移行しマーカーを作成（Board 先・Canvas 後、失敗時は半端な .openground/ を rm -rf してロールバック）。ダイアログで「.openground/ がリポジトリに作られる」「Sync は自分の git remote+credentials を使う」と説明。前提条件チェックは not-git / already-shared / ignored(.gitignore が飲み込む) の3つで 412 表示。
- **ギャップ**: 有効化は1クリックで完了するが、期待にある「初回コミット・プッシュ」は enable では一切行われない（server/routes/share.ts:43-62 — 'Nothing is committed by enable — the first Sync publishes it'）。ユーザーは有効化後に dirty ドット付きの Sync ボタンを見て自分で Sync を押す必要があり、それを促す明示的な案内は出ない。また remote 不在は enable 前にチェックされない（preconditions は not-git/already-shared/ignored のみ）。移動されたファイル一覧の提示も無い。
- **検証** (confirmed): 主張どおり「partial」が正しい。(1) enable は移行のみでコミット・プッシュを一切行わない — server/routes/share.ts:46-47 にコメントで明記（"Nothing is committed here; the first Sync (or the user's own git flow) publishes it"）、ハンドラ本体(48-68行)も migrateBoardToShared/migrateCanvasToShared と失敗時の rm -rf ロールバックだけで git コマンドを呼ばない。(2) 前提条件チェックは not-git / already-shared / ignored の3つのみ — src/lib/server/gitShare.ts:291-311 (enablePreconditions)。remote 不在は enable 前に警告されず、むしろ sync 時に "no remote/upstream configured — nothing to pull / push skipped" のノート付きで「成功」扱いになる（gitShare.ts:257,272 と 187 付近のコメント）。(3) 確認ダイアログの説明文は「.openground/ がリポジトリ内に作られる」「Sync は自分の git remote と credentials を使う」のみ — src/i18n/messages/projectPanel.ts:90 (shareDialogExplain)。移動されたファイル一覧の提示や「次に Sync を押せ」という明示的案内はない。enable 成功後は refreshShareStatus/reloadProjectData で状態を取り直すだけ（src/components/canvas/ProjectPanel.tsx:1043-1064 confirmShareDialog）で、ユーザー体験としては Sync ボタンの dirty 表示から自分で察して押す必要がある。よってシナリオの期待のうち「初回コミット・プッシュが enable で行われる」「remote なしは有効化前に警告」「移動ファイル一覧の提示」は未充足で、coverage は partial が妥当。
- **根拠**: server/routes/share.ts:43-68; src/lib/server/gitShare.ts:291-311, 255-272; src/i18n/messages/projectPanel.ts:88-91; src/components/canvas/ProjectPanel.tsx:1043-1064

### S2 ○ 同僚が共有クローンをインポートする

- **ユーザー行動**: 同僚が git clone した共有リポジトリを「Import existing folder」でOPEN GROUNDに登録する。
- **期待**: .openground/openground.json の存在を自動検知し、ゼロ設定で共有モードとして開く。Board のカードと Canvas がオーナーの作った状態のまま表示され、Sync ボタンが最初から使える。「共有プロジェクトとして読み込みました」のような表示があると安心。
- **現状**: 共有モードはマーカー .openground/openground.json の存在だけで自動検知（isShared は毎回 fs を読む非キャッシュ判定）。clone にはマーカーとカードファイルが含まれて travel するので、Import existing folder で登録するだけでゼロ設定で共有モードとして開く。テストで pin 済み: B が clone 直後に sync → 純 pull、isShared(B)=true、カード読める。Sync ボタンは shareStatus.shared=true で最初から表示され、remote の owner/repo 短縮名も隣に出る。
- **ギャップ**: 「共有プロジェクトとして読み込みました」のような明示的なお知らせ表示は無い — Sync ボタンと remote 名が黙って現れるだけ。機能的にはゼロ設定で完全動作するが、初見の同僚が『共有モードに入った』と気づく手がかりは UI の Sync ボタンのみ。
- **根拠**: src/lib/server/sharedData.ts:73-110; gitShare.test.ts:210-232; src/components/canvas/ProjectPanel.tsx:1329-1389, 1346-1353; docs/SHARED_DATA_PLAN.md:49-52

### S3 △ remote が無いリポジトリで共有を有効化しようとする

- **ユーザー行動**: origin が設定されていないローカルだけの git リポジトリで「Share via Git」を押す。
- **期待**: 黙って壊れるのではなく「このリポジトリには remote がありません。先に origin を設定してください」と有効化前にブロックされる。あるいはローカルコミットのみで有効化を許し、Sync 時に「push 先がありません」と案内する — どちらにせよ次の一手（git remote add のコマンド例）が示される。
- **現状**: remote 無しでも enable はブロックされない（preconditions は not-git/already-shared/ignored のみ）。Sync は成功扱い（ok:true, committed:true, pulled:false, pushed:false）で、NO_UPSTREAM_RE がマッチすると notice に 'no remote/upstream configured — nothing to pull' / 'push skipped' が表示される。コミットはローカルに安全に残り、次回 Sync が再試行する。テストで pin 済み（standalone repo の degrade）。
- **ギャップ**: 期待の後者（ローカルのみ許容＋Sync 時に案内）はほぼ満たすが、「次の一手」の提示が無い — `git remote add origin …` のコマンド例や remote 設定への誘導は notice に含まれず、英語の git 寄り文言が 11px の通知に出るだけ。有効化前の警告も無いので、remote を後で設定する必要があることに気づきにくい。
- **検証** (confirmed): 主張は正確。(1) enable 前のブロックは無い — enablePreconditions の reason は 'not-git' | 'already-shared' | 'ignored' の3つのみで remote 有無は検査しない（gitShare.ts:293-307）。getRemoteUrl は存在する（gitShare.ts:76-84）が status 表示用で、enable のゲートには使われない。(2) Sync は remote 無しでも ok:true で degrade — pull/push の失敗を NO_UPSTREAM_RE（gitShare.ts:62-63）でマッチし notes に 'no remote/upstream configured — nothing to pull'（:257）/ '— push skipped'（:272）を積み、コミットはローカルに残る（設計コメント gitShare.ts:185-190、テスト pin gitShare.test.ts:234-249 'no remote: ok with message, committed locally, pulled/pushed false'）。(3) 「次の一手」の不提示も事実 — src/ server/ docs/ 全体を grep しても `git remote add` の案内は一切無い。さらにユーザー体験はクレームよりやや悪い: この caveat は kind:'ok' の通知として出るため 5 秒で自動消滅し（ProjectPanel.tsx:963-971 setTimeout 5000）、表示自体も max-w-[260px] truncate text-[11px] の1行（ProjectPanel.tsx:1339 同系スタイル、doSync の message 連結は :1019-1024）で、digest と '— ' 連結されると no-remote 部分が切り捨てられ得る。i18n も未翻訳の生英語。期待シナリオの後者（ローカル許容＋Sync 時案内）の骨格は満たすが、案内が一過性・truncate 可能・コマンド例無しで partial 評価は妥当。
- **根拠**: src/lib/server/gitShare.ts:62-63 (NO_UPSTREAM_RE), :256-274 (notes 'nothing to pull'/'push skipped'), :293-307 (enablePreconditions = not-git/already-shared/ignored のみ); src/lib/server/gitShare.test.ts:234-249 (no-remote degrade pin); src/components/canvas/ProjectPanel.tsx:963-971 (ok 通知5秒で消滅), :1019-1024 (message を notice に連結), :1339 (max-w-[260px] truncate text-[11px]); `grep -rln "remote add" src server docs` = ヒット無し

### S4 × ブランチに upstream が無い状態で Sync を押す

- **ユーザー行動**: 新しいブランチを切った直後（origin に同名ブランチが無い）で Sync を押す。
- **期待**: `push -u origin <branch>` 相当を自動でやってくれるか、「このブランチはまだリモートにありません。公開しますか？」と確認される。ahead/behind バッジは upstream 不在時に「未公開」のような状態を出し、↑n/↓n の誤表示をしない。
- **現状**: shareSync の push は素の `git push` のみ（gitShare.ts: `await git(projectPath, ['push'], …)`）。upstream 不在は NO_UPSTREAM_RE で拾われ notice に 'no remote/upstream configured — push skipped' が出るが、`push -u origin <branch>` の自動実行も「公開しますか？」確認も無い。ahead/behind は rev-list が upstream 不在でエラー → 両方 0 に degrade。
- **ギャップ**: 新ブランチ上ではコミットがローカルに溜まり続けるのに ↑ バッジは 0 のまま（『未公開』状態の表示が無い）。ユーザーは Sync するたびに 'push skipped' の一行通知を見るだけで、アプリ内にブランチを公開する手段が無く、ターミナルで自力 `git push -u` するしかない。誤った ↑n/↓n は出ない（0 に落ちる）が、同期済みと誤解しうる。
- **検証** (confirmed): 主張は正確。shareSync の push は素の `git push` のみ（gitShare.ts:267）で、`-u`/`--set-upstream` も「公開しますか？」確認も、リポジトリ全体のどこにも存在しない（server/routes/share.ts・shareClient.ts・ProjectPanel.tsx に publish/set-upstream 系コードなし）。upstream 不在の push エラーは NO_UPSTREAM_RE（gitShare.ts:63 に 'no upstream branch' を含む）で握られ notes に 'no remote/upstream configured — push skipped'（gitShare.ts:271-272）、pull 側も同様（256-257）。結果は ok:true なので UI は kind:'ok' の通知（ProjectPanel.tsx:1013-1024 で caveat message を連結表示するのみ）。ahead/behind は @{upstream} 参照の rev-list（gitShare.ts:174-177）が sharedCommitCount の catch で 0 に degrade（143-151）し、types.ts:488-494 も「0 when no upstream」を明文化＝『未公開』状態の表現は仕様上存在しない。さらに悪いことに、Sync でコミット自体は成功するため dirty ドット（openGroundDirty）も消え、バッジ ↑0/dirty 無し＋緑系 ok 通知で「同期済み」に見える。加えて通知文言は origin が存在して upstream だけ無いケースでも 'no remote/upstream configured' と表示し誤解を招く。テスト（gitShare.test.ts:234-242, 278）も no-remote 時 pushed:false を仕様としてピン留めしており、意図的な degrade であってブランチ公開手段が無いのは設計どおり＝ユーザー体験としてのギャップは実在。誤った ↑n 表示が出ない点も主張どおり。
- **根拠**: src/lib/server/gitShare.ts:267 (`await git(projectPath, ['push'], NETWORK_TIMEOUT_MS)` — 引数なし、-u なし); gitShare.ts:63 (NO_UPSTREAM_RE), 271-272 ('push skipped' note), 143-151+174-177 (rev-list @{upstream} → catch で 0); src/lib/types.ts:488-494 ('0 when not shared / no upstream'); server/routes/share.ts:45-47 ('the first Sync (or the user's own git flow) publishes it' — 自動公開は想定外と明記); src/components/canvas/ProjectPanel.tsx:1013-1024 (caveat を ok 通知に連結するだけ), 1377-1384 (↑/↓ バッジは >0 のみ表示)

### S5 ○ privateリポジトリの認証がそのマシンに無い

- **ユーザー行動**: 同僚のマシンに SSH 鍵 / credential helper が未設定のまま Sync（fetch/push）を押す。
- **期待**: 無限スピナーやハングではなく「認証に失敗しました（Permission denied）」と git のエラーをそのまま見せ、ターミナルで `git fetch` が通るようにしてくださいと案内される。アプリがトークンを預かろうとしないこと（pure git の原則維持）。
- **現状**: 全 git は execFile + GIT_TERMINAL_PROMPT=0 で実行 — 認証プロンプトで吊らず即失敗。network 系は 60s / fetch 15s のタイムアウト、status エンドポイントは 2.5s レースで UI を絶対にブロックしない。push/pull の認証失敗は throw せず notice に 'push failed: <git の先頭行>'（Permission denied 等そのまま）が出て、コミットはローカルに残り次回再試行。アプリはトークンを一切預からない（pure git が locked decision）。status の fetch 失敗は黙殺で UI は静かに degrade。
- **ギャップ**: git の生エラーは見えるが、「ターミナルで git fetch が通るようにしてください」のような復旧手順の案内文は無い。また behind バッジ用 fetch の認証失敗は完全に無音（カウントが 0 のまま）なので、Sync を押すまで認証問題に気づかない。
- **根拠**: src/lib/server/gitShare.ts:29-40,26-27,121,134-138,166-173,263-276; docs/SHARED_DATA_PLAN.md:9-10; src/components/canvas/ProjectPanel.tsx:989-1007

### S6 ○ アプリを開いている間に同僚が push したことに気づく

- **ユーザー行動**: 自分はパネルを開いて作業中。同僚がカードを追加して push した。
- **期待**: 60秒スロットルの fetch により、数十秒〜1分以内に Sync ボタンに ↓1 バッジが点く。勝手に pull はされない（自分の見ている盤面が突然書き換わらない）。バッジを見て自分のタイミングで Sync できる。
- **現状**: パネル表示中＋ウィンドウ可視なら 90s ごとに share status を再取得し、サーバ側は project ごと 60s スロットルで `git fetch --quiet` を裏で実行。behind = HEAD..@{upstream} を .openground/ pathspec でカウントし、↓n がアクセント色で Sync ボタン内に点灯（tooltip『{count} shared change(s) on the remote — Sync to pull them』）。pull は絶対に勝手に走らない — 取り込みはユーザーが Sync を押した時だけで、盤面が突然書き換わることはない。ウィンドウ refocus でも（3s デバウンス）即 status 再取得。
- **ギャップ**: バッジ点灯までの最悪レイテンシは 90s ポーリング＋fetch が 2.5s を超えた場合は次のポーリング待ちで実質 ~3 分になり得る（期待の『数十秒〜1分以内』よりやや遅いケースがある）。実害は小さい。
- **根拠**: src/lib/server/gitShare.ts:120-139,141-151,166-173; src/components/canvas/ProjectPanel.tsx:1103-1114,1382-1386; src/i18n/messages/projectPanel.ts:70-72

### S7 ○ アプリを閉じていた間の同僚の更新に、起動時に気づく

- **ユーザー行動**: 昨晩同僚が大量にカードを動かした。翌朝アプリを起動してプロジェクトを開く。
- **期待**: プロジェクトパネルを開いた時点で fetch が走り、↓n バッジが即座に出る。「先に Sync して最新を取り込んでから作業を始める」という判断が、開いた直後にできる。
- **現状**: プロジェクトパネルを開くと useEffect（ProjectPanel.tsx:1068-1078）が即 refreshShareStatus → GET /api/project/share/status を呼び、サーバ側で throttled `git fetch`（起動直後はスロットル窓が空なので必ず走る）→ behind を計算。fetch が 2.5s 以内に終われば開いた直後に ↓n バッジが点く。ウィンドウ focus 時の再取得（3s デバウンス）も併走。バッジ＋tooltip で『先に Sync して取り込む』判断が開いた時点でできる。
- **ギャップ**: fetch が 2.5s を超える遅い回線では初回 status は behind=0 で返り、バックグラウンドで完了した fetch の結果は次のポーリング（90s 後）か refocus まで反映されない — 朝一の巨大 fetch だとバッジ点灯が少し遅れる可能性がある。
- **根拠**: src/components/canvas/ProjectPanel.tsx:1068-1078,1087-1101; src/lib/server/gitShare.ts:120-139,166-173（2.5s レース＋background 完了は次 poll で反映）

### S8 △ 自分に未 push のローカル変更があることに気づく

- **ユーザー行動**: カードを数枚編集・移動した後、push せずに他の作業をしている。
- **期待**: Sync ボタンに ↑n（未pushコミット数、または未コミット変更あり表示）が出続け、「自分の変更はまだ同僚に届いていない」ことが一目で分かる。アプリ終了時に ↑ が残っていれば気づける位置にバッジがある。
- **現状**: Sync ボタン内に ↑n バッジ（ahead = .openground/ 限定の未pushコミット数、rev-list --count '@{upstream}..HEAD' -- .openground/）と、未コミット変更を示す5pxのアクセント色ドット（git status --porcelain -- .openground/）が常時表示される。パネル可視中は90秒ポーリング＋同期後の status 再取得で更新される。
- **ギャップ**: バッジの存在場所が ProjectPanel のヘッダーのみ。Ground（ポートフォリオキャンバス）のプロジェクトカードには share 状態の表示が一切なく（ProjectCard.tsx に share 参照なし）、パネルを閉じて他プロジェクトの作業をしている間や、アプリ終了直前に Ground だけ見ている場合は「未pushの変更が残っている」ことに気づけない。アプリ全体としての終了時警告も無い。パネルを開いている限りの認知は十分。
- **検証** (confirmed): 主張どおり「partial」が正しい。仕組み自体は実在: gitShare.ts の shareStatus が .openground/ 限定の ahead/behind を rev-list --count '@{upstream}..HEAD' -- .openground/ で算出し（gitShare.ts:143-151,174-177）、未コミット変更は git status --porcelain -- .openground/ で dirty 化（gitShare.ts:88）、fetch は 60 秒スロットル（gitShare.ts:120-139）。UI 側は Sync ボタン内に 5px のアクセントドット（dirty, ProjectPanel.tsx:1367-1372）と ↑n（1377-1381）/↓n（1382-1386）を表示し、共有中かつパネル可視中に 90 秒ポーリング（1103-1114）＋ window focus 時再取得（1086-1101）＋ Sync 後再取得で更新される。ただしギャップも事実: ShareStatus の消費者は ProjectPanel.tsx と shareClient.ts のみで（grep で全 src 横断確認）、Ground のプロジェクトカード ProjectCard.tsx には share/ahead 参照がゼロ。パネルを閉じて Ground だけ見ている間は未 push の存在を知る手段がない。アプリ終了時の警告も無し — Electron の before-quit はサーバ子プロセスの teardown のみ（electron/main.js:180-188）で、renderer 側にも beforeunload ガードは無い。よって「パネルを開いている限りは ↑n/ドットで一目で分かるが、Ground 視点・終了直前の認知経路は存在しない」という partial 判定は正確。なお通常編集はコミットされず dirty ドット表示で、↑n は未 push コミット（push 失敗・オフライン Sync 後など）にのみ出る点もシナリオの expectation（『未pushコミット数、または未コミット変更あり表示』）の両方をパネル内では満たしている。
- **根拠**: src/lib/server/gitShare.ts:88,120-139,143-151,156-180; src/components/canvas/ProjectPanel.tsx:1086-1114,1367-1386; src/components/canvas/ProjectCard.tsx (share 参照ゼロ — grep 空); electron/main.js:180-188 (before-quit はサーバ停止のみ、未同期警告なし)

### S9 △ pull 後に「何が変わったか」を知る

- **ユーザー行動**: ↓3 を見て Sync を押し、同僚の変更を取り込んだ。
- **期待**: 「カード『API設計』が Doing→Review に移動」「カード2枚追加」のような取り込みサマリが Sync 結果として表示される（1カード1ファイルなので diff からカード単位の差分が出せるはず）。最低でも変更/追加/削除されたカード名の一覧。Board 上で新着カードがハイライトされるとなお良い。
- **現状**: Sync 成功かつ pull が変更を持ち込んだ場合、boardDiffDigest（src/lib/boardDigest.ts）が同期前後のタスクスナップショットを diff し、「+2 cards (Yuki) · 1 done · 1 moved · 1 removed」形式のダイジェストをボタン横の notice に表示する（5秒で自動フェード）。Canvas は canvasReloadToken のバンプで黙って再読込される。
- **ギャップ**: ダイジェストは件数ベースで、カード名（タイトル）は出ない — 追加カードの assignee 名のみ括弧表示。期待されている『どのカードが Doing→Review に移動したか』『変更/追加/削除されたカード名の一覧』は得られない。Board 上での新着カードのハイライトも無い。Canvas 側の変更はサマリに一切現れない（黙って再読込のみ）。通知は5秒で消えるため見逃すと再確認できない。
- **検証** (confirmed): 主張は正しい。Sync成功かつ pull が変更を持ち込んだ場合のみ、ProjectPanel.doSync が同期前スナップショット(beforeTasks)と reloadProjectData() の結果を boardDiffDigest で diff し、件数ベースのダイジェスト（+N cards (担当者名) · N done · N moved · N removed）を notice に表示、5秒で自動消滅する。コードで確認した事実: (1) boardDigest.ts はカードタイトルを一切出力せず、追加カードの assignee 名だけを括弧で列挙（src/lib/boardDigest.ts:60-72、segments は count と names のみ）。「どのカードが Doing→Review に移動したか」「変更/追加/削除されたカード名一覧」は不可能。(2) i18n キーも件数フォーマットのみ（src/i18n/messages/projectPanel.ts:76-82, 207-213）。(3) Board 上の新着カードハイライトは存在しない（BoardTab.tsx / BoardModule.tsx に highlight/pulse/flash 該当コードなし）。(4) Canvas は setCanvasReloadToken(v=>v+1) で黙って再読込されるだけでサマリに現れない（ProjectPanel.tsx:1015）。(5) ok 通知は setTimeout 5000ms で消える（ProjectPanel.tsx:968-969）。さらに主張より弱い点も発見: ダイジェストは r.result.pulled && beforeTasks && reloaded がすべて真の時のみ生成され、未保存ローカル編集がある場合 reloadProjectData が null を返してダイジェストごとスキップ、汎用「Synced」にフォールバックする（ProjectPanel.tsx:946-949, 1016-1019）。シナリオ S9 の「partial」評価は妥当。
- **根拠**: src/lib/boardDigest.ts:33-74（件数のみ・タイトル無し）; src/components/canvas/ProjectPanel.tsx:961-970（5秒フェード）, 983-1024（doSync: snapshot→sync→reload→digest, canvasReloadToken バンプ）, 946-949（ローカル編集時 reload スキップ→digest 不成立）; src/i18n/messages/projectPanel.ts:76-82, 207-213; BoardTab.tsx/BoardModule.tsx に新着ハイライト無し（grep ヒットは drop target の既存コメントのみ BoardTab.tsx:456）; src/lib/server/gitShare.ts:228-231（pulled フラグはサーバ側で真偽のみ、差分内容は返さない）

### S10 △ 同僚が作業中であることを盤面から察知する

- **ユーザー行動**: Sync 後の Board を見ると、あるカードに同僚の assignee が付き Doing 列にある。
- **期待**: assignee 名と列（Doing）がそのまま「同僚が今これをやっている」シグナルとして読める。自分が同じカードを触る前に気づける。リアルタイム在席表示までは期待しないが、最後の Sync 時刻が分かると鮮度を判断できる。
- **現状**: ProjectTask.assignee（git config user.name をデフォルト候補にする自由文字列）と boardColumn はカードファイルに載って Sync で同期されるため、Sync 後の Board でそのまま『同僚 X が Doing/Review にいる』と読める。担当者リスト（ProjectConfig.members）やレビュー列もマーカー経由でチーム共有。パネル可視中は project data の5秒ポーリング＋フォーカス時再取得で盤面は新鮮に保たれる。
- **ギャップ**: 『最後に Sync した時刻』の表示が無いため、見ている assignee/列情報の鮮度（同僚情報が10分前のものか3日前のものか）を判断する手がかりがない。behind バッジ（↓n）が間接的な『盤面が古い』シグナルにはなるが、fetch は60秒スロットルかつ失敗時は黙って0に縮退するため確実な鮮度指標ではない。
- **検証** (confirmed): クレームの通り「partial」が正しい。(1) シグナル自体は実在: assignee と boardColumn はカードの固定キー直列化に含まれ (projectData.ts normalizeCard)、git共有モードでは board/cards/<id>.json として1カード1ファイルで同期される (sharedData.ts:29)。members も ProjectConfig として共有 (types.ts:424-427)。よって Sync 後の盤面で「同僚Xが Doing にいる」はそのまま読める。(2) しかし「最後に Sync した時刻」の表示は皆無: リポジトリ全体を syncedAt/lastSync/最終同期 で grep してもヒットゼロ。ShareStatus (types.ts:478-495) にタイムスタンプ系フィールドは無く、UI は dirty ドットと ↑/↓ バッジのみ (ProjectPanel.tsx:1356-1373)。(3) behind バッジの鮮度指標としての弱さも事実: fetch は 60秒スロットル (gitShare.ts:120) かつ失敗は黙殺 (gitShare.ts:136-138「Offline / no remote / auth — the counts below degrade to 0」)、カウントもエラー時 0 (gitShare.ts:148-150)、クライアント側のステータス再取得は 90秒間隔 (ProjectPanel.tsx:1108-1114)。さらに補足の精緻化: 5秒ポーリング (ProjectPanel.tsx:1121-1129) はローカルディスクの再読込であり、同僚の変更は手動 Sync の pull でしか届かない。つまり盤面の assignee/列情報は「最後に Sync ボタンを押した時点」の古さを持ち、その時点がいつか分かる手がかりがゼロ — ギャップはクレームの記述よりむしろやや深い。
- **根拠**: src/lib/server/gitShare.ts:120,136-138,148-150,156-179; src/lib/types.ts:478-495; src/components/canvas/ProjectPanel.tsx:1108-1129,1356-1373; src/lib/server/projectData.ts:143-157; src/lib/server/sharedData.ts:29

### S11 ○ 作業開始前に最新を取り込む

- **ユーザー行動**: 朝、作業を始める前にまず Sync を1回押す。
- **期待**: behind 分が pull --rebase で取り込まれ、Board/Canvas が即座に再読込されて最新になる。「Pulled n commits」のような完了表示。ローカルに変更が無ければ純粋な早送りで一瞬で終わる。
- **現状**: Sync 一発で commit（ローカル変更が無ければ porcelain チェックによりスキップ）→ pull --rebase --autostash → push。ローカル変更ゼロなら rebase は実質早送りで完了。成功後は project data 再取得＋canvasReloadToken バンプで Board/Canvas が即座に再読込され、pull が盤面に変更を持ち込めば boardDiffDigest、無ければ『Synced / 同期しました』が表示される。pull 成功は fetch スロットルにも刻印され直後の status 呼び出しが再 fetch しない。
- **ギャップ**: 『Pulled n commits』というコミット数表示は無い（Board 単位のダイジェストか汎用 'Synced'）。実用上の朝イチ取り込みフローは完全に機能する。
- **根拠**: src/lib/server/gitShare.ts:191-285, 232-234; src/components/canvas/ProjectPanel.tsx:1008-1024, 910-913, 1015; gitShare.test.ts:210-232

### S12 ○ 編集を終えたら push する

- **ユーザー行動**: カードを編集・追加した後、Sync を押す。
- **期待**: .openground/ 配下の変更だけが自動コミット（pathspec 限定）→push され、自分のコードの未コミット変更は絶対にコミットに混ざらない。完了後 ↑ バッジが消え、同僚側に届いたと確信できる。
- **現状**: git add -A -- .openground/ と commit の pathspec 限定（SHARED_DIR）はコントラクトテストで固定されており、src/ のステージ済みファイルが sync 後もステージされたまま残ることまで pin されている。コミット件名は 'openground: sync'。push 後に refreshShareStatus が走り、ahead が0になれば ↑ バッジとドットが消える。push 失敗（オフライン/認証）でもコミットはローカルに安全で、message（'push failed: …'）が notice に出て次回 Sync が再試行する。
- **根拠**: src/lib/server/gitShare.ts:8-11, 199, 210, 263-276; gitShare.test.ts:181-208; src/components/canvas/ProjectPanel.tsx:1026-1028

### S13 ○ 双方が変更したが別ファイル同士の Sync

- **ユーザー行動**: 自分はカードAを編集、同僚はカードBを編集して先に push 済み。自分が Sync を押す。
- **期待**: 1カード1ファイル設計のおかげで rebase は無衝突で通り、commit→pull --rebase→push が全自動で完了する。ユーザーには「衝突」という言葉すら見えず、両方の変更が共存した盤面になる。これが日常の99%のケースとして摩擦ゼロであること。
- **現状**: 1カード=1ファイル（board/cards/<id>.json）の設計が『append never conflicts』を明示目的としており、別ファイル同士の変更は pull --rebase が無衝突で通過し commit→pull→push が全自動完了する。コードの dirty は --autostash が運ぶ。ユーザーには成功 notice（digest または 'Synced'）だけが見え、conflict 経路（rebase --abort + conflict:true）は同一ファイル衝突時のみ。ゼロ設定の同僚 round-trip も実 git フィクスチャのテストで pin 済み。
- **根拠**: docs/SHARED_DATA_PLAN.md:37, 11-13; src/lib/server/gitShare.ts:191-285; gitShare.test.ts:210-232, 260-287

### S14 ○ 何も変更が無い状態で Sync を押す

- **ユーザー行動**: 念のため Sync を押すが、ローカル変更も behind も無い。
- **期待**: 空コミットを作らず「Already up to date / 最新です」と即座に返る。何度連打しても履歴が汚れない。
- **現状**: コミットは openGroundDirty（git status --porcelain -- .openground/ が非空）にゲートされており、変更ゼロなら commit 自体が走らない＝空コミットは絶対に作られず、連打しても履歴は汚れない。pull は up-to-date で即終了、push は 'Everything up-to-date' で成功扱い。UI には committed:false・pull 差分なしのため汎用成功 notice『Synced / 同期しました』が即時表示される（doSync の in-flight ガードで二重実行も防止）。
- **ギャップ**: 文言が『Already up to date / 最新です』ではなく汎用の『Synced / 同期しました』である点だけが期待とのズレだが、実害なし。
- **根拠**: src/lib/server/gitShare.ts:204-222 (openGroundDirty ゲート); gitShare.test.ts:234-249; src/components/canvas/ProjectPanel.tsx:978-980, 1008-1024; src/i18n/messages/projectPanel.ts:73

### S15 △ 同じカードの同じフィールドを両者が編集して衝突

- **ユーザー行動**: 自分と同僚が同じカードのタイトルをそれぞれ書き換え、同僚が先に push。自分が Sync。
- **期待**: rebase 衝突がカード単位で検出され、「カード『X』のタイトルが衝突：あなた=…/同僚=…」とアプリ内で提示され、どちらを採るか（または手動マージ）選べる。生の <<<<<<< マーカー入り JSON をエディタで直させるのは最終手段。中途半端な rebase 状態で放置されないこと。
- **現状**: rebase 衝突を検知すると shareSync が `git rebase --abort` で必ずクリーン状態に巻き戻し、ok:false/conflict:true を返す。UI は「同期が競合しました。手動で pull して解決してください。」のエラーノーティスを出すのみ。カード単位の衝突提示・選択 UI は存在しない（docs/SHARED_DATA_PLAN.md:81-84 が「App does NOT attempt resolution」と明記）。
- **ギャップ**: 中途半端な rebase 状態には絶対ならない（テストで rebase-merge/rebase-apply 不在・クリーンツリーを固定済み）が、期待される「カード『X』のタイトルが衝突：あなた=…/同僚=…」という提示は無い。ユーザーはターミナルで `git pull` し、<<<<<<< マーカー入りの board/cards/<id>.json を手で直すしかない — 「最終手段」が唯一の手段。どのカードが衝突したかすらアプリ内では分からない。
- **検証** (confirmed): 主張は正しい。rebase 衝突時、shareSync は `git rebase --abort` でクリーン状態へ巻き戻し `{ok:false, conflict:true, message:'…Run `git pull` … resolve the conflict manually…'}` を返すだけで（gitShare.ts:236-254）、カード単位の衝突検出・提示・選択 UI はコードベースのどこにも存在しない。UI 側は ProjectPanel.tsx:994-1000 で conflict:true を受けてエラーノーティス（projectPanel.ts:83 'Sync hit a conflict — pull and resolve it manually.' + サーバの message）を出すのみ。projectData.ts / sharedData.ts に <<<<<<< マーカー解析や衝突カード特定のロジックは皆無（projectData.ts:365 の "conflict" は楽観ロック用の別物）。docs/SHARED_DATA_PLAN.md:77-83 も「rebase conflict: abort して conflict:true を返し、手動 pull を促す」と設計として明記。よってユーザー体験は、(a) 中途半端な rebase 状態に放置されない点だけは満たす（gitShare.test.ts:260-275 で abort 後の非 rebase・conflict:true を固定）が、(b) どのカードのどのフィールドが衝突したかはアプリ内で一切分からず、ターミナルで git pull → 生のコンフリクトマーカー入り board/cards/<id>.json を手で直すのが唯一の手段 — シナリオが「最終手段」と位置づけた方法しか無い。coverage 監査の "partial" 判定は妥当。
- **根拠**: src/lib/server/gitShare.ts:236-254 (rebase --abort + conflict:true + 手動解決メッセージ); src/components/canvas/ProjectPanel.tsx:994-1000 (conflict→エラーノーティスのみ); src/i18n/messages/projectPanel.ts:83; src/lib/server/gitShare.test.ts:260-275 (abort後クリーン状態を固定); docs/SHARED_DATA_PLAN.md:77-83 (設計として手動解決と明記); src/lib/server/projectData.ts・sharedData.ts にカード単位衝突解決ロジック不在

### S16 △ 同じカードの別フィールドを両者が編集

- **ユーザー行動**: 自分はカードの説明文を、同僚は同じカードの assignee を変更して両方 Sync。
- **期待**: 同一ファイル内でも行が離れていれば git が自動マージし、両方の変更が残るのが理想。git 的に衝突した場合でも、フィールド単位で「説明=自分の版、担当=同僚の版」を自動合成（structural merge）するか、最低限 S15 と同じカード単位の解決 UI に落ちる。片方の変更が黙って消えるのが最悪。
- **現状**: カードは normalizeCard で固定キー順・pretty-print 整形されて 1 カード=1 ファイルなので、description と assignee は別行になり、行が十分離れていれば git のテキストマージ（rebase 中の 3-way マージ）が自動合成し両方の変更が残る。フィールド単位の structural merge は実装されていない。
- **ギャップ**: 行が隣接して git 的に衝突した場合は S15 と同じ汎用 abort（conflict:true ＋手動解決メッセージ）に落ち、カード単位の解決 UI は無い。ただし最悪ケース（片方の変更が黙って消える）は起きない — 衝突時は abort で双方のコミットが保全される。自動合成の成否は JSON 内の行距離という git の機械的判定任せで、フィールドの組み合わせによっては衝突になる。
- **検証** (confirmed): 主張どおり。(1) カードは normalizeCard で固定キー順 + JSON.stringify(…, null, 2) の pretty-print（projectData.ts:143-157、serializeCard:157）で 1 カード=1 ファイル（SHARED_DATA_PLAN.md:37「ONE ProjectTask per file」）なので、説明（notes、JSON 3行目）と assignee（done/createdAt/boardColumn を挟んで数行下）は別行になり、git の 3-way マージ（pull --rebase）が非重複なら自動合成して両方残る。フィールド単位の structural merge は存在しない — gitShare.ts/sharedData.ts に .gitattributes や merge driver の設定は一切なし（grep でゼロ件）。(2) git 的に衝突した場合は shareSync が rebase --abort して {ok:false, conflict:true, 手動解決メッセージ} を返すだけ（gitShare.ts:236-256）。UI 側も ProjectPanel.tsx:994-1000 で汎用エラーノーティス（syncConflict 文言 + message）を出すのみで、カード単位の解決 UI は無い。(3) 最悪ケース（黙って消える）は起きない: ローカルコミットは abort 後も残り（committed:true）、リモート側コミットも無傷、テスト gitShare.test.ts:260-275 が「abort して repo クリーン・conflict:true」を pin している。なお UX 補足: notes と assignee は normalizeCard の出力で 3〜4 行しか離れていないため、隣接フィールド（例 boardColumn と assignee）の同時編集では git 衝突→abort に落ちる頻度は「行が十分離れていれば」という表現より高めで、自動合成の成否は完全に git の行距離判定任せ — この点も主張の gapDetail どおり。
- **根拠**: src/lib/server/projectData.ts:143-157 (normalizeCard 固定キー順 + pretty-print, serializeCard); src/lib/server/gitShare.ts:236-256 (rebase conflict → abort + conflict:true + 手動解決メッセージ); src/components/canvas/ProjectPanel.tsx:994-1000 (conflict は汎用エラーノーティスのみ、解決 UI なし); src/lib/server/gitShare.test.ts:260-275 (abort 動作を pin); docs/SHARED_DATA_PLAN.md:37 (1カード1ファイル); merge driver/.gitattributes 設定は gitShare.ts/sharedData.ts に存在しない (grep 0件)

### S17 △ 一方が削除したカードを他方が編集していた

- **ユーザー行動**: 同僚がカードを削除して push。自分はそのカードを編集していて Sync。
- **期待**: 「カード『X』は同僚に削除されましたが、あなたは編集しています。復活させる / 削除を受け入れる」の二択が提示される。デフォルトでどちらかに倒すなら「編集を残す（復活）」が安全側。編集内容が無言で消えないこと。
- **現状**: 自分の編集は Sync 冒頭で必ずコミットされてから pull するため、同僚の削除と modify/delete 衝突になる。git の出力に CONFLICT が含まれ /conflict/i にマッチ → rebase --abort で巻き戻し、conflict:true ＋手動解決メッセージ。編集内容は自分のローカルコミットとして保全される（テストで committed:true・内容復元を固定）。
- **ギャップ**: 「復活させる / 削除を受け入れる」の二択 UI は無い。ユーザーには汎用の「同期が競合しました。手動で pull して解決してください。」しか出ず、削除との衝突だとは分からない。手動 git では modify/delete の解決（git add で復活 or git rm で削除受入）は JSON 衝突マーカーより更に git 知識を要求する。一方、無言で編集が消えることは無い（安全側）。
- **検証** (confirmed): 主張は正しい。(1) Sync は冒頭で .openground/ 配下を必ず add→commit するため (gitShare.ts:199-213)、自分の編集はローカルコミットとして保全される。(2) pull --rebase が失敗したとき `rebaseInProgress() || /conflict/i.test(text)` で衝突を検知し (gitShare.ts:237)、modify/delete 衝突は rebase を途中停止させる＋git が「CONFLICT (modify/delete)」を出力するので両条件とも拾う。検知後は rebase --abort で巻き戻し、conflict:true と固定文言「Run `git pull` ... resolve the conflict manually」を返すだけ (gitShare.ts:240-254)。(3) 衝突種別の判別や delete/modify 専用の処理・UI はサーバにもクライアントにも一切ない。ProjectPanel は r.result.conflict を見て汎用エラー通知を出すのみで (ProjectPanel.tsx:994-1000)、文言は i18n の「同期が競合しました。手動で pull して解決してください。」(projectPanel.ts:214) ＋ サーバ message。「復活させる / 削除を受け入れる」の二択は存在せず、削除との衝突だとユーザーには分からない。docs/SHARED_DATA_PLAN.md にも modify/delete の特別扱いは無い。(4) 一方で無言で編集が消えることは無い: abort 後も自分のコミットが残ることをテストが固定 (gitShare.test.ts:260-287 — committed:true、abort 後に自分の内容がファイルに復元)。唯一の微修正点: 引用テストは add/add 衝突を固定したもので modify/delete 衝突そのもののテストは存在しないが、検知機構 (rebaseInProgress) は種別非依存なので「partial」評価自体は妥当。つまり S17 は「データ喪失は無い（安全側）が、期待される二択 UI・削除衝突の説明は皆無で、解決には git add/git rm の知識が必要」= partial で正しい。
- **根拠**: src/lib/server/gitShare.ts:199-254 (commit→pull→conflict検知→abort→汎用message); src/components/canvas/ProjectPanel.tsx:994-1000 (conflict→汎用エラー通知のみ); src/i18n/messages/projectPanel.ts:214 (「同期が競合しました。手動で pull して解決してください。」); src/lib/server/gitShare.test.ts:260-287 (abort後もローカルコミット・内容保全を固定、ただし add/add 衝突)

### S18 ○ カードの並び順・列ファイルが両者で食い違う

- **ユーザー行動**: 自分と同僚がそれぞれ別カードを別の列にドラッグし、共有 order ファイル（canvas/ 配下の shared order）が両側で変わった状態で Sync。
- **期待**: order/列メタはホットスポットだと分かっているので、衝突時はユーザーに JSON を見せず自動解決する（例：両方の移動を適用、消えたIDは除去、重複は一意化）。カード本体のデータは無傷で、最悪でも並び順だけが片方優先になる、と振る舞いが予測できること。
- **現状**: Board のカード位置（column / boardOrder）は共有の order ファイルではなく各カード自身のファイル（board/cards/<id>.json）に入っている — 「append never conflicts」設計。別カードを別列にドラッグした場合は別ファイルの変更なので git 衝突は起きず、rebase で両方の移動がそのまま適用される。読み取り側も column→boardOrder→createdAt→id の決定的ソートで並びを再構成する。Canvas タブ順の canvas/index.json は order 配列のみで、マージで壊れた JSON は [] に degrade → listCanvases の self-healing がディスク上のファイルから順序を再構築する。
- **ギャップ**: 唯一の穴は「両者が“同じ”カードをドラッグした」場合で、同一ファイル衝突として S15 の汎用 abort に落ちる（自動解決はされない）。ただしカード本体データは無傷で、シナリオ本文（別カードを別列）は設計上そもそも衝突しない。
- **根拠**: src/lib/server/projectData.ts:159-176 (決定的ソート); docs/SHARED_DATA_PLAN.md:37; src/lib/server/canvasData.ts:90-97 (壊れた index は [] に degrade + self-healing)

### S19 △ Canvas の同じ要素（付箋など）を両者が編集

- **ユーザー行動**: 自分と同僚が同じ Canvas の同じ付箋のテキスト/位置をそれぞれ変更して Sync。
- **期待**: Canvas は canvases/<id>.json 単位なので git 衝突になりやすい。要素単位で「どちらの付箋を残すか」を提示するか、せめて「Canvas『Y』が衝突：自分の版/同僚の版」のファイル単位二択 UI がある。解決後に Canvas が再読込され、壊れた JSON で白画面にならない。
- **現状**: Canvas は canvases/<id>.json に丸ごと 1 ファイルなので同一付箋の編集は高確率で git 衝突 → rebase --abort で巻き戻し、汎用の「同期が競合しました。手動で pull して解決してください。」ノーティス。要素単位・ファイル単位の二択 UI は無い。白画面は起きない：abort で常にクリーンな JSON に戻り、Sync 後は canvasReloadToken で Canvas が再読込され、壊れた index も defensive parse で degrade する。
- **ギャップ**: 「Canvas『Y』が衝突」というファイル名提示すら無い — conflict 時の message はサーバの固定文字列で、どのファイルかは含まれない。ユーザーはターミナルで git pull して巨大な canvas JSON の衝突マーカーを手で直す羽目になり、これは事実上「同僚の版か自分の版を git checkout --theirs/--ours で選ぶ」しか現実的でない。データ破壊・白画面は防がれているが、解決体験は最悪に近い。
- **検証** (confirmed): 主張どおり。(1) 衝突時はサーバが rebase --abort で巻き戻し、固定文字列「Sync hit a rebase conflict and was rolled back. Run `git pull` ... manually」を返すだけで、衝突したファイル名（どの Canvas か）は一切含まれない（gitShare.ts:237-254）。UI 側もこのメッセージに i18n の汎用文「同期が競合しました。手動で pull して解決してください。」を連結して表示するのみ（ProjectPanel.tsx:994-1000, i18n/messages/projectPanel.ts:214）。要素単位・ファイル単位の二択 UI はコードベースのどこにも存在せず、.gitattributes の merge driver も union merge も無い（gitShare.ts / sharedData.ts / SHARED_DATA_PLAN.md を grep して該当ゼロ。設計書自体が「conflict:true + pull manually」を正式仕様としている: SHARED_DATA_PLAN.md:81-82）。(2) 白画面防止も主張どおり: abort で常にクリーンな JSON に戻り（テストで固定: gitShare.test.ts:260-275「aborts, returns conflict:true, repo left clean」）、merge マーカー入り index でも defensive parse が [] に degrade して自己修復する（canvasData.ts:90-99）。微修正点が1つだけ: canvasReloadToken の bump は sync 成功パスのみ（ProjectPanel.tsx:1015）で衝突時には走らないが、abort で内容が変わらないため再読込不要であり実害なし。ユーザー体験としては主張の gapDetail どおり — Canvas 丸ごと1ファイル（canvas/<id>.json）の同一付箋編集は高確率で衝突し、解決手段はターミナルで巨大 JSON の衝突マーカーを手作業（実質 checkout --ours/--theirs の二択）。「partial」評価は妥当。
- **根拠**: src/lib/server/gitShare.ts:237-254 (abort+固定message・ファイル名なし); src/components/canvas/ProjectPanel.tsx:994-1000,1014-1015 (汎用notice / okパスのみcanvasReloadToken); src/i18n/messages/projectPanel.ts:83,214 (固定文言); src/lib/server/canvasData.ts:90-99 (defensive parse); src/lib/server/gitShare.test.ts:260-275 (abort後clean固定); docs/SHARED_DATA_PLAN.md:81-82 (manual pull が正式仕様)

### S20 △ notes.md を両者が編集して衝突

- **ユーザー行動**: 双方がプロジェクトの notes.md に追記して Sync。
- **期待**: 別の場所への追記なら git のテキストマージで自動的に両方残る。同じ行で衝突したら、Markdown なので衝突マーカー入りで開くか、両版を並べて選ばせる UI。少なくとも「notes.md が衝突しています」とファイル名を明示して放置しない。
- **現状**: notes.md は素の markdown ファイルなので、別の場所への追記は pull --rebase 中の git テキストマージが自動で両方残す（期待どおり）。同じ行で衝突した場合は rebase --abort → conflict:true → 汎用ノーティス。
- **ギャップ**: 「notes.md が衝突しています」というファイル名の明示が無い — UI のメッセージは固定文（手動で pull して解決してください）で、サーバ側 message も固定英文字列のためファイル名は伝わらない。両版を並べて選ばせる UI も無い。なおテストは notes.md の add/add 衝突で abort・クリーンツリー・自分の内容復元を固定済みなので、放置や消失は起きない。
- **検証** (confirmed): 主張どおり「partial」。(1) notes.md は素の markdown として書かれる（sharedData.ts:31-33 の boardNotesPath、コメントに "ProjectData.notes as plain markdown"）ので、別ハンクへの追記は pull --rebase の git テキストマージで自動的に両方残り、sync 成功後に ProjectPanel が reloadProjectData でマージ結果を UI に取り込む（ProjectPanel.tsx:1009-1014）— 期待の前半は満たす。(2) 同一行衝突時は gitShare.ts:236-255 が rebase --abort して conflict:true と固定英文メッセージ（'Sync hit a rebase conflict and was rolled back. Run `git pull` ... resolve the conflict manually'）を返すのみで、衝突ファイル名は一切含まれない。UI 側も固定文 projectPanel.syncConflict（i18n/messages/projectPanel.ts:83/214「同期が競合しました。手動で pull して解決してください。」）にサーバの固定 message を連結するだけ（ProjectPanel.tsx:994-1000）で、「notes.md が衝突しています」というファイル名明示も、両版を並べて選ばせる UI も存在しない。(3) ただし放置・消失ではない: gitShare.test.ts:261-287 が notes.md の add/add 衝突で abort 後に rebase 状態ディレクトリ無し・クリーンツリー・自分の 'notes from B' の内容復元・ローカルコミット保持(committed:true)を固定している。ユーザー体験として「自分の編集は安全だが、何が衝突したかは git を自分で叩くまで分からない」— 主張のギャップ記述は正確。
- **根拠**: src/lib/server/gitShare.ts:236-255 (abort + 固定メッセージ・ファイル名なし); src/i18n/messages/projectPanel.ts:83,214 (固定文言); src/components/canvas/ProjectPanel.tsx:994-1000 (conflict 通知は固定文+message のみ); src/lib/server/sharedData.ts:31-33 (notes.md = plain markdown); src/lib/server/gitShare.test.ts:261-287 (notes.md add/add 衝突: abort・クリーン・内容復元を固定)

### S21 ○ Sync 途中の rebase 衝突で処理が中断する

- **ユーザー行動**: Sync 中に .openground/ 内で rebase 衝突が発生し、自動解決できない。
- **期待**: アプリは `git rebase --abort` で必ず元の状態に巻き戻し、「衝突のため同期を中止しました。ローカルの変更は失われていません」と報告する。リポジトリが rebase 途中（REBASE_HEAD 残存）のまま放置され、ユーザーのターミナル作業を壊すことが絶対に無い。その後の解決手段（S15系のUI or 手順案内）が示される。
- **現状**: pull 失敗時、rebaseInProgress()（rev-parse --git-path で rebase-merge / rebase-apply 両方を stat、worktree 対応）または /conflict/i マッチで `git rebase --abort` を実行し、必ず非 rebase のクリーン状態へ巻き戻して ok:false/conflict:true を返す。message は「Sync hit a rebase conflict and was rolled back. Run `git pull` … resolve the conflict manually, then sync again.」で、巻き戻した事実と次の手順を案内。ローカル変更は pull 前に必ずコミット済み（committed:true）なので失われない。テストが rebase-merge/rebase-apply ディレクトリ不在・クリーンツリー・自分のファイル内容復元まで固定している。
- **ギャップ**: ほぼ満点だが 2 つの小さな残差：(1) abort は best-effort（catch して握りつぶす）なので、abort 自体が失敗する異常系では理論上 rebase 状態が残り得る（検知済みパスでは実質起きない）。(2) UI の日本語ノーティスは「手動で pull して解決してください」で、「ローカルの変更は失われていません」という安心文言は明示されない（rolled back はサーバ message 側のみ）。解決手段は手順案内（git pull → 手動解決 → 再 Sync）のみで、S15 系の UI は無い。
- **根拠**: src/lib/server/gitShare.ts:95-111 (rebaseInProgress), 235-254 (abort + message); gitShare.test.ts:260-287; src/i18n/messages/projectPanel.ts:83

### S22 △ 自分のコード（.openground 外）が dirty な状態で Sync / autostash 復元失敗

- **ユーザー行動**: src/ にコミット前のコード変更がある状態で Sync。pull --rebase --autostash が走り、運悪く stash pop が衝突する。
- **期待**: 通常時：コードの未コミット変更は autostash で退避→復元され、Sync コミットには一切含まれず作業ツリーは元通り。pop 失敗時：「あなたのコード変更が同期後の状態と衝突し、stash に退避されています（stash@{0}）」と明示し、復旧コマンドを提示する。コード変更が黙って消える・勝手にコミットされるのは絶対 NG（このリポジトリの stash 不可視問題そのもの）。
- **現状**: 通常時は完全カバー: commit は常に `-- .openground/` の pathspec 付き（gitShare.ts:199,210）なのでコード変更は絶対にコミットされず、`pull --rebase --autostash` (gitShare.ts:230) が .openground 外の dirty を退避→自動復元する。「src/ の staged ファイルが sync 後も staged のまま残る」ことはテストで pinned（gitShare.test.ts:181-208）。しかし autostash の復元（pop）が衝突したケースの専用ハンドリングは一切ない。
- **ギャップ**: autostash の適用が衝突すると git は『Applying autostash resulted in conflicts. Your changes are safe in the stash.』を stderr に出しつつ pull 自体は exit 0 で成功する。shareSync は成功時の stderr を読まないため ok:true・notes 空で返り、UI は『Synced』とだけ表示。ユーザーのコード変更は黙って stash@{0} に置き去りになり、UI からは何の警告も復旧手順も出ない — このリポジトリが CLAUDE.md で禁忌としている『不可視 stash』問題がそのまま起きる。検知（pull 成功時 stderr の autostash 警告チェック）と通知が未実装。
- **検証** (confirmed): 主張は正しい（実機 git で再現確認済み、実態はやや悪い方向）。通常時のカバーは事実: commit は常に `-- .openground/` pathspec（gitShare.ts:199,210）、staged コード温存はテストで pin 済み（gitShare.test.ts:181-208）。しかし autostash 適用衝突の専用ハンドリングはゼロ。/tmp で再現したところ、`pull --rebase --autostash` は「Applying autostash resulted in conflicts. Your changes are safe in the stash.」を出しつつ exit 0、stash@{0}: autostash が残り、さらに作業ツリーは UU（unmerged・コンフリクトマーカー入り）の状態で放置される。shareSync の成功パス（gitShare.ts:230-234）は stdout/stderr を一切検査せず pulled=true で進み、ok:true・notes 空で返す。rebaseInProgress/conflict 判定（gitShare.ts:237）は catch 節のみで exit 0 では到達しない。UI 側も ProjectPanel.tsx:978-1029 の doSync は ok:true なら digest（「Pulled n cards」等）か汎用 Synced を表示するだけで、autostash 警告を運ぶ経路が存在しない（shareClient.ts:128 は body.message を素通しするがサーバが入れない）。結果: ユーザーのコード変更は不可視 stash に置き去り＋作業ツリーは黙ってコンフリクト状態なのに UI は「Synced」— CLAUDE.md が禁忌とする不可視 stash 問題そのもの。grep でも autostash 衝突検知の実装はリポジトリ内に皆無。修正案: pull 成功時の stderr に /Applying autostash resulted in conflicts/ を検知して message/notes（できれば conflict 級の警告）として `git stash pop` 復旧手順とともに返す。
- **根拠**: src/lib/server/gitShare.ts:229-234（成功時 stdout/stderr 不検査・notes 追加なし）, gitShare.ts:236-254（conflict 処理は catch 節のみ）, src/components/canvas/ProjectPanel.tsx:1011-1021（ok:true は digest/Synced 表示のみ）, src/lib/server/gitShare.test.ts:181-208（pathspec contract のみ pin、autostash 衝突テストなし）, 実機再現: git pull --rebase --autostash → EXIT=0 / stash@{0}: autostash / status UU code.txt

### S23 △ オフラインで Sync を押す

- **ユーザー行動**: 機内/圏外で Sync を押す。
- **期待**: ローカルコミットまでは成功し（変更は保全）、fetch/push の失敗を「オフラインのようです。コミットは保存済み、接続後にもう一度 Sync してください」と区別して伝える。↑n バッジが残り、再接続後の Sync で全部送れる。長時間ハングしない（タイムアウト）。
- **現状**: データ保全と無ハングはカバー: commit はネットワーク前にローカルで成功し（gitShare.ts:204-223）、pull/push は各 60s タイムアウト + GIT_TERMINAL_PROMPT=0 で必ず返る（gitShare.ts:27,39,230,267）。pull/push 失敗は throw せず ok:true + notes（'pull failed: …' / 'push failed: …'）で返り（gitShare.ts:256-276）、sync 後の status 再取得（ProjectPanel.tsx:1026-1028）で ↑n バッジが残る。再接続後の再 Sync で push が成功する設計（gitShare.ts:263-264 コメント）。
- **ギャップ**: オフライン特有の案内がない: https リモートの『Could not resolve host』は NO_UPSTREAM_RE に一致しないので生の git 一行（'pull failed: Could not resolve host github.com; push failed: …'）がそのまま出る。しかも ok:true なので“成功”扱いの薄い ok 通知（5 秒で自動消去, ProjectPanel.tsx:962-974）として表示され、『オフラインです。コミットは保存済み、接続後に再 Sync を』というメッセージ区別・恒久表示はない。ssh の『could not read from remote repository』は逆に NO_UPSTREAM_RE に誤ヒットし『no remote/upstream configured』と誤った理由を表示する可能性もある。
- **検証** (confirmed): 主張は正確。(1) データ保全と無ハングはカバー済み: commit は pull/push より前にローカルで完結し（gitShare.ts:204-223、失敗時のみ ok:false で停止）、pull/push は各 NETWORK_TIMEOUT_MS=60s + GIT_TERMINAL_PROMPT=0 で必ず返る（gitShare.ts:26-27,39,230,267。直列なので最悪 ~120s だが有界）。pull/push 失敗は設計方針として throw せず ok:true + notes で返し（gitShare.ts:185-190 のコメント「Auth/network push failures likewise report through message, never a throw」、263-264「the commit is safely local and the next sync will retry」）、sync 後に refreshShareStatus() が走るので ↑n バッジは残る（ProjectPanel.tsx:1026-1028, 1377-1380）。(2) ギャップも実在: オフライン判定の分岐は一切なく、https リモートの「Could not resolve host」は NO_UPSTREAM_RE（gitShare.ts:62-63）に不一致なので生の git 一行が notes に入り（gitShare.ts:259,274）、ok:true ルートで kind:'ok' の通知として表示され 5 秒で自動消去される（ProjectPanel.tsx:1001-1024 の else 分岐 + 962-974 の setTimeout 5000）。「オフラインです。コミットは保存済み、再接続後に Sync」という区別された恒久メッセージは存在しない。さらに NO_UPSTREAM_RE は 'could not read from remote repository' を含むため、ssh リモートのオフライン失敗（ssh: Could not resolve hostname → fatal: Could not read from remote repository）は誤ヒットし「no remote/upstream configured — push skipped」と誤った理由を表示する（gitShare.ts:63,271-272）。ユーザー体験としては「変更は守られ再Syncで送れるが、オフラインだと気づきにくい」— partial 評価は妥当。
- **根拠**: src/lib/server/gitShare.ts:26-27,39 (タイムアウト+prompt無効), 62-63 (NO_UPSTREAM_RE に 'could not read from remote repository' を含む), 185-190,204-223 (commit先行・ok:false は commit/conflict のみ), 256-276 (pull/push 失敗→notes, ok:true), 278-284; src/components/canvas/ProjectPanel.tsx:962-974 (ok 通知は 5s で消える), 1001-1024 (message ありでも kind:'ok'), 1026-1028+1377-1383 (status 再取得で ↑n バッジ残存)

### S24 △ push が non-fast-forward で拒否される

- **ユーザー行動**: 自分の pull と push のわずかな間に同僚が push し、自分の push が rejected になる。
- **期待**: アプリが自動でもう一周（fetch→rebase→push）リトライして成功させる。リトライでも衝突するなら通常の衝突フローへ。ユーザーには成功なら何も見せず、失敗時だけ「同僚の更新と競合したため再取り込みが必要」と出る。force push は絶対にしない。
- **現状**: 安全側は完全: force push は存在せず（push は引数なしの `git push` のみ, gitShare.ts:267）、rejected でもコミットはローカルに残り ok:true + 'push failed: ! [rejected]…' の note で返る（gitShare.ts:269-276）。ユーザーがもう一度 Sync を押せば pull --rebase → push で解消する。dirty/ahead バッジは status 再取得で残る。
- **ギャップ**: 期待される自動リトライ（fetch→rebase→push をもう一周）が無い。non-fast-forward は1クリックで透過的に直るべき典型ケースだが、現状ユーザーには ok 扱いの通知に生 git 文言『push failed: failed to push some refs…』が出るだけで、『もう一度 Sync すれば直る』という案内もなく、5 秒で消える ok 通知なので見落としやすい。
- **検証** (confirmed): 主張は正確。自動リトライは存在しない: shareSync は commit→pull --rebase --autostash→push を各1回だけ実行し、push 失敗は catch で notes に『push failed: <git stderr 1行目>』を積んで ok:true で返るのみ（src/lib/server/gitShare.ts:263-276、コメント自身が "the next sync will retry"＝次回 Sync 任せと明言）。server/routes/share.ts:38 のルートも shareSync を素通しするだけで再試行ループなし。クライアント側 doSync も result.ok:true なら ok 通知ブランチに入り、digest と message を結合して表示するだけ（ProjectPanel.tsx:1008-1024）。ok 通知は setShareNoticeFading の 5 秒タイマーで自動消滅する（ProjectPanel.tsx:969-970, コメント "Successes auto-fade" 902行）ため、生 git 文言の push 失敗が緑表示で 5 秒後に消える、という UX 指摘もコード通り。安全側の主張も正しい: push は常に引数なし `git push`（gitShare.ts:267）で --force 系は repo 全体に存在せず、commit はローカルに残る。ユーザー視点の救済は (1) doSync 末尾の refreshShareStatus（ProjectPanel.tsx:1028）と可視時 5 秒ポーリングで ↑n バッジが残り続けること、(2) もう一度 Sync を押せば pull --rebase→push で解消すること、のみで、『もう一度 Sync で直る』という案内文言は無い。テスト（gitShare.test.ts）にも non-fast-forward rejected のケースは無い（no-remote と rebase conflict のみ）。よって S24 の期待『自動でもう一周』は未実装、coverage "partial" 判定は妥当。
- **根拠**: src/lib/server/gitShare.ts:263-276 (push 1回のみ・失敗は note 化・"the next sync will retry"); src/lib/server/gitShare.ts:267 (引数なし git push、force なし); src/components/canvas/ProjectPanel.tsx:1008-1024 (ok 扱いで message 表示のみ・リトライなし); src/components/canvas/ProjectPanel.tsx:969-970 (ok 通知 5000ms で自動消滅); server/routes/share.ts:34-46 (ルートは素通し)

### S25 × upstream が force-push / 履歴書き換えされていた

- **ユーザー行動**: 誰かが共有ブランチを rebase + force-push した後、自分が Sync。
- **期待**: behind が異常値になったり rebase が大量衝突する状況を検知し、「リモートの履歴が書き換えられています」と警告。自動で reset --hard はせず、ローカルの .openground 変更を保全した上で取るべき手順を提示する。データが片方向に黙って吹き飛ばないこと。
- **現状**: 履歴書き換えの検知ロジックは存在しない。受動的な安全性のみ: pull --rebase はローカルコミットを新 upstream に replay するので reset --hard 的な破壊はなく、衝突した場合は rebase --abort でクリーンに戻して conflict:true を返す（gitShare.ts:235-254）。behind カウントも通常の rev-list で計算されるだけ（gitShare.ts:174-177）。
- **ギャップ**: force-push 後の Sync は (a) 衝突しなければ黙って成功し、書き換え前の自分の旧コミットが rebase で新履歴に重複 replay される（重複コミット・データの意図せぬ復活がありうる）、(b) 衝突すれば汎用の『Sync hit a rebase conflict』だけが出て、『リモート履歴が書き換えられた』という診断は一切ない。@{upstream} の reflog 比較や fetch 時の forced-update 検知（git fetch の '(forced update)' 出力）は未実装で、ユーザーは何が起きたか分からないまま手動 pull に放り出される。
- **検証** (confirmed): 履歴書き換え（force-push）の検知ロジックは実在しない。shareStatus は throttled fetch（gitShare.ts:129-139）後に rev-list --count @{upstream}..HEAD / HEAD..@{upstream} を数えるだけで（gitShare.ts:174-177）、fetch の '(forced update)' 出力も @{upstream} の reflog 比較も見ていない（fetch は --quiet で catch{} 握り潰し、gitShare.ts:135-138）。shareSync は pull --rebase --autostash → 失敗時に rebaseInProgress か /conflict/i のときだけ rebase --abort して汎用文言「Sync hit a rebase conflict… Run `git pull` … manually」を返す（gitShare.ts:235-254）— 「リモート履歴が書き換えられた」という診断分岐はゼロ。UI 側も conflict メッセージをそのまま出すだけ（ProjectPanel.tsx:994, shareClient.ts:127-128）、docs/SHARED_DATA_PLAN.md の sync 仕様（81-84 付近）にも rewritten history への言及なし。gitShare.test.ts にも force-push ケースは無い。claim の受動的安全性の記述も正確: reset --hard 相当は無く、conflict 時は abort でクリーンに戻る。唯一の軽微な過大評価は gapDetail(a) の「重複コミット」— git pull --rebase は fork-point（remote-tracking の reflog）と patch-id スキップを既定で使うため、upstream が単純 rebase されただけなら旧コミットの重複 replay は git 自身がかなり防ぐ。ただしこれは git の偶発的恩恵であり、書き換えで内容が変更/削除された場合は旧データの黙った復活が依然起こり得るし、ユーザーへの検知・警告・手順提示が皆無という gap の本体はそのまま成立する。
- **根拠**: src/lib/server/gitShare.ts:129-139 (fetch --quiet, エラー握り潰し、forced-update 未検査), :174-177 (rev-list カウントのみ), :235-254 (汎用 conflict 文言・診断なし); src/components/canvas/ProjectPanel.tsx:994; src/lib/shareClient.ts:127-128; docs/SHARED_DATA_PLAN.md sync 仕様節 (rewritten history 言及なし); gitShare.ts/share.ts/shareClient.ts/SHARED_DATA_PLAN.md/gitShare.test.ts 全体 grep で force|forced|reflog|rewrite|reset --hard の該当ロジック 0 件

### S26 × detached HEAD で Sync を押す

- **ユーザー行動**: 過去コミットを checkout して detached HEAD のまま Board を編集し Sync。
- **期待**: 「ブランチ上にいないため同期できません。ブランチに戻ってください」と事前にブロックされる（Sync ボタン自体が disabled + 理由表示でも良い）。detached のままコミットを積んで宙に浮かせない。
- **現状**: detached HEAD の事前チェックは存在しない。shareSync はブランチ状態を見ずに commit→pull→push を実行する（gitShare.ts:191-285）。Sync ボタンの disabled 条件も syncing 中 / project missing のみ（ProjectPanel.tsx:1357,1373）。
- **ギャップ**: 期待と真逆の挙動になる: detached HEAD でも pathspec commit は成功するため『openground: sync』コミットがどのブランチにも属さず宙に浮く。続く pull は『You are not currently on a branch.』で失敗（NO_UPSTREAM_RE に不一致→『pull failed: …』note）、push も同様に失敗するが、結果は ok:true なので UI は薄い ok 通知を出すだけ。ahead/behind は @{upstream} が解決できず 0 に退化し、宙に浮いたコミットの存在を示すバッジすら出ない。その後ブランチに戻ると Board の編集が（reflog 以外から）消えたように見える。事前ブロックも理由表示もない。
- **検証** (confirmed): 主張はほぼ全点正しい。(1) 事前チェック不在: shareSync は add→commit→pull→push を実行するだけでブランチ状態を一切見ない（gitShare.ts:191-285）。repo 全体で detached/symbolic-ref の検査はゼロ（gitShare.ts / share.ts / sharedData.ts / ProjectPanel.tsx / gitShare.test.ts / SHARED_DATA_PLAN.md に該当コードなし）。(2) Sync ボタンの disabled は `syncing || project.missing` のみ（ProjectPanel.tsx:1357）。(3) detached HEAD でも pathspec commit は成功し「openground: sync」コミットが無名ブランチに積まれる。続く pull の "You are not currently on a branch." は NO_UPSTREAM_RE（gitShare.ts:62-63）に不一致→ notes に "pull failed: …"、push も同様に "push failed: …"。conflict 分岐（:237）にも入らないため結果は ok:true（:278-284）。(4) ahead/behind は @{upstream} 解決失敗で catch→0 に退化（gitShare.ts:143-151,174-177）し、宙に浮いたコミットを示すバッジは出ない。commit 成功で dirty ドットも消える。唯一の微修正点: UI は完全沈黙ではなく、ok:true でも r.result.message が ok 通知のテキストに連結される（ProjectPanel.tsx:1020-1023）ので「pull failed: You are not currently on a branch.; push failed: …」は緑系のフェード通知として一応表示される。ただし kind は 'ok' で、事前ブロックも理由付き disabled も無く、編集はその時点で既に detached コミットに取り込まれ済み — ブランチに戻ると Board 編集が reflog 以外から消えたように見える、という核心のギャップは事実。ギャップ判定は妥当。
- **根拠**: src/lib/server/gitShare.ts:191-285 (ブランチ確認なしの commit→pull→push), :62-63 (NO_UPSTREAM_RE が detached メッセージに不一致), :143-151,174-177 (ahead/behind が @{upstream} 失敗で 0), src/components/canvas/ProjectPanel.tsx:1357 (disabled={syncing || project.missing}), :1008-1024 (ok:true は kind:'ok' 通知、message は連結表示)

### S27 × ブランチを切り替えたら共有データはどうなるか

- **ユーザー行動**: feature ブランチに git switch すると、.openground/ もそのブランチの内容に変わる（リポジトリ内ファイルなので）。Board が突然違って見える。
- **期待**: 「共有データはブランチに従う」という仕様が UI から理解できる（現在ブランチ名の表示、ahead/behind もそのブランチの upstream 基準）。ユーザーの合理的期待は『Board はブランチで変わってほしくない』かもしれないので、メインと違うブランチで .openground を編集したら「このブランチで共有データを編集しています」と気づかせる表示が欲しい。
- **現状**: 『共有データはブランチに従う』を UI に伝える要素がない。share UI に出る文脈情報はリモート短縮名（owner/repo, ProjectPanel.tsx:1346-1353）のみで、現在ブランチ名はどこにも表示されない。ahead/behind は現在ブランチの @{upstream} 基準で黙って計算される（gitShare.ts:174-177）。5 秒ポーリング＋focus refetch（ProjectPanel.tsx:1080-1129）により branch switch 後の Board 内容の変化自体は数秒で画面に反映される。
- **ギャップ**: git switch すると .openground/ がブランチごと差し替わり Board が突然別物になるが、UI は『なぜ変わったか』を一切説明しない（ブランチ名表示なし、ShareStatus にも branch フィールドなし — types.ts:478-495）。main 以外のブランチで Board を編集していることへの注意表示もないため、feature ブランチに積んだ共有データ編集が main に存在せず『カードが消えた』と誤認するリスクが設計上未対応。SHARED_DATA_PLAN.md にもこの awareness 項目はない。
- **検証** (confirmed): 主張どおりのギャップが実在する。(1) ShareStatus 型に branch フィールドはなく shared/gitRepo/remoteUrl/dirty/ahead/behind のみ (src/lib/types.ts:478-495)。(2) share UI が表示する文脈はリモート短縮名 remoteName だけで、現在ブランチ名はコードベース全体のどこにも表示されない（src/components/canvas/ProjectPanel.tsx:1346-1353。`grep -rn branch src/components` で出るのは ProjectCard.tsx:65 の「git リポジトリかどうか」アイコンと BoardModule.tsx:589-596 のタスク別ブランチチップのみで、リポジトリの HEAD ブランチ表示はゼロ。`rev-parse --abbrev-ref HEAD` 等の現在ブランチ取得コードも存在しない）。(3) ahead/behind は現在チェックアウト中ブランチの @{upstream} を黙って基準に計算 (src/lib/server/gitShare.ts:173-176)。upstream の無い feature ブランチでは sharedCommitCount が 0 にフォールバックしバッジが黙って消えるだけで、警告にはならない。(4) 共有データは working tree の .openground/ を直接読むため git switch で内容ごと差し替わり、5秒ポーリング＋focus refetch (ProjectPanel.tsx:1086-1131) で Board は数秒で「別物」に変わるが、変化理由の説明 UI は皆無。(5) docs/SHARED_DATA_PLAN.md にもブランチ awareness の項目はない（grep で branch/upstream に該当するのは upstream 不在時の縮退仕様の記述のみ）。唯一の微かなヒントは sync 時の「no remote/upstream configured」notes (gitShare.ts:256-258, 270-272) だが、これはブランチ意識の機構ではない。feature ブランチ上の Board 編集が main に存在せず「カードが消えた」と誤認するリスクは設計上未対応 — 確証。
- **根拠**: src/lib/types.ts:478-495 (ShareStatus に branch なし); src/components/canvas/ProjectPanel.tsx:1346-1353 (表示は remoteName のみ); src/lib/server/gitShare.ts:173-176 (@{upstream} 基準の ahead/behind を無言で計算); ProjectPanel.tsx:1086-1131 (focus refetch + 90s status + 5s data poll — 内容変化のみ即反映、理由表示なし); docs/SHARED_DATA_PLAN.md (branch awareness 項目なし)

### S28 △ git の user.name / user.email 未設定で Sync

- **ユーザー行動**: 新しいマシンで git identity 未設定のまま Sync（コミットが必要な変更あり）。
- **期待**: commit が失敗した生エラーではなく「git のユーザー名/メールが未設定です」と原因を特定して `git config --global user.name ...` の例を提示する。チーム機能（assignee 名）にもこの identity を使うなら、設定導線が一箇所にまとまっている。
- **現状**: 安全側はカバー: identity 未設定だと commit が失敗し、shareSync は ok:false で即停止（pull/push に進まない, gitShare.ts:212-222）。UI はエラー通知『Sync failed: commit failed: Author identity unknown』（firstLine が git 出力の先頭非空行を採る, gitShare.ts:52-57）を出し、エラー通知は自動消去されず残る（ProjectPanel.tsx:962-974,989-1007）。データは .openground/ の working tree に無傷で残る。
- **ギャップ**: 原因特定と導線が不足: 表示されるのは git の生の一行『Author identity unknown』だけで、『git config --global user.name/email を設定してください』という具体例・コマンド提示はない（identity エラーを特別扱いするパターンマッチが未実装）。また assignee のデフォルト候補に git config user.name を使う設計（types.ts:383-397）にもかかわらず、identity 設定への統一導線（設定画面・ヘルプ）は存在しない。新マシンのユーザーは git の知識なしには復旧手順に辿り着けない。
- **検証** (confirmed): クレームは正確。(1) 安全側のカバーは事実: shareSync は commit 失敗時に ok:false で即 return し pull/push に進まない（gitShare.ts:207-222、message は `commit failed: <firstLine>`)。identity エラーを特別扱いするパターンマッチはコード上どこにも存在しない（gitShare.ts 内で identity/Author を扱うのはコメントのみ、gitShare.test.ts:18-20 もテスト環境の identity 設定に言及するだけ）。(2) UI 表示は ProjectPanel.tsx:989-1007 の syncFailed 通知（i18n: projectPanel.ts:84 'Sync failed: {error}'）で、error 種の通知は自動消去されず残る（ProjectPanel.tsx:902, 963-974: ok のみ 5 秒 fade）。(3) むしろクレームより一段悪い点を補強: git 自身は失敗時 stderr に「Run\n  git config --global user.email ...\n  git config --global user.name ...」という復旧コマンドをフルで出力するが、firstLine()（gitShare.ts:52-57）が最初の非空行だけを採るため、ユーザーに届くのは『Sync failed: commit failed: Author identity unknown』の一行のみ — gitが提供する復旧手順をアプリが能動的に切り落としている。(4) identity 導線の不在も事実: git config user.name は server/routes/misc.ts:97-102 で読み取り専用の displayName プレースホルダ提案（types.ts:62-66, SettingsResponse.suggestedDisplayName）に使われるだけで、git identity を設定する画面・ヘルプ・案内は存在しない。データは .openground/ working tree に無傷で残る点も正しい（commit 前に add のみ、gitShare.ts:199-201）。severity は「partial」のままで妥当。
- **根拠**: src/lib/server/gitShare.ts:52-57 (firstLine が複数行の git 復旧手順を一行に切り詰め), gitShare.ts:207-222 (commit 失敗→ok:false 即停止・identity 特別扱いなし), src/components/canvas/ProjectPanel.tsx:963-974,989-1007 (error 通知は残留・生 message をそのまま表示), src/i18n/messages/projectPanel.ts:84, server/routes/misc.ts:97-102 + src/lib/types.ts:51-66 (user.name はプレースホルダ提案のみで設定導線なし)

### S29 × リポジトリが rebase/merge 途中の状態で Sync を押す

- **ユーザー行動**: ターミナルでの手動 rebase が衝突して中断中（.git/rebase-merge あり）に、アプリで Sync を押す。
- **期待**: Sync 実行前に git の状態を検査し、「リポジトリが rebase 途中です。先にターミナルで解決（または --abort）してください」とブロックする。途中状態の上にコミットや pull を重ねて事態を悪化させない。
- **現状**: shareSync に「実行前の git 状態検査」は存在しない。手順は無条件に add→(dirtyなら)commit→pull→push と進む。pull が失敗したとき rebaseInProgress() が true なら best-effort で `git rebase --abort` を実行するが、これは Sync 自身が起こした rebase と、ユーザーが手動で進めていた rebase を区別しない。
- **ギャップ**: ユーザーが衝突解決の途中だった手動 rebase（.git/rebase-merge あり）の上で Sync を押すと、(1) .openground/ が dirty なら commit が unmerged files で失敗し『commit failed: …』で止まる（こちらは無害）、(2) dirty でなければ pull が失敗 → アプリが勝手に `git rebase --abort` を発行し、ユーザーが途中まで解決していた rebase が破棄される。期待される『rebase 途中です、先に解決してください』という事前ブロックは無く、最悪ケースではユーザーの作業（解決済みコンフリクト）が失われる。
- **検証** (confirmed): 主張どおり。shareSync (src/lib/server/gitShare.ts:191) には実行前の git 状態検査が一切なく、無条件に add(199)→dirty なら commit(208-223)→pull --rebase --autostash(230)→push(267) と進む。手動 rebase が衝突中断中（.git/rebase-merge あり）に Sync を押すと: (1) .openground/ 配下に未マージがあれば commit が失敗し「commit failed: …」で停止（無害だが「rebase 途中です」という案内はない）。(2) それ以外では pull が「rebase in progress」系エラーで失敗し、catch 節 (gitShare.ts:235-254) が `rebaseInProgress(projectPath) || /conflict/i` の判定だけで `git rebase --abort` (241行) を発行する。この判定は Sync 自身が起こした rebase かユーザーの手動 rebase かを区別しないため、ユーザーが途中まで解決していた rebase が破棄され、解決済みコンフリクトの作業が失われる。rebaseInProgress (gitShare.ts:98-111) は状態検出のみで、shareSync 冒頭からは呼ばれていない。route (server/routes/share.ts:38) もクライアント (src/lib/shareClient.ts:106, ProjectPanel.tsx:976) もパススルーでガードなし。テスト (gitShare.test.ts:260-284) は「Sync 自身が起こした rebase 衝突の abort」だけを pin しており、手動 rebase 中のケースは未カバー。さらに悪い派生ケース: rebase 中断中に .openground/ だけ dirty（未マージなし）だと commit が detached HEAD 上で成功し得て、その後の abort/ユーザーの --abort でそのコミットが迷子になる可能性もある。期待される「rebase 途中です、先に解決してください」の事前ブロックは存在しない。
- **根拠**: src/lib/server/gitShare.ts:191-261 (shareSync に事前チェックなし), gitShare.ts:237-244 (無差別 `git rebase --abort`), gitShare.ts:98-111 (rebaseInProgress は catch 節でのみ使用), src/lib/server/gitShare.test.ts:260-284 (Sync発rebaseのabortのみpin)

### S30 ○ 同一ユーザーの2台のマシン間で同期する

- **ユーザー行動**: 会社の Mac でカードを編集して Sync、帰宅後に自宅マシンで同じ共有リポジトリを開く。
- **期待**: 自宅側で ↓n が出て Sync 一発で会社の状態が再現される。個人状態（tabOrder、canvas の activeId）は中央保存なのでマシンごとに違ってよい、という切り分け通りに振る舞う（盤面データは一致、開いているタブは各マシンの記憶）。
- **現状**: 盤面データは .openground/（カード=1ファイル、notes.md、canvas/）として git で運ばれ、自宅マシン側はマーカー検知で自動的に shared モードになる（ゼロ設定、gitShare.test.ts のコラボレータ round-trip テストでピン留め）。↓n は status 内の throttled `git fetch`（60s）＋ 90s の可視ウィンドウポーリングで点灯し、Sync 一発（pure pull: committed:false, pulled:true）で会社の盤面が再現される。tabOrder / canvas activeId / 起動プロファイルは各マシンの ~/.openground/ 中央保存のままなので、マシンごとに別でよいという2層切り分け通り。
- **根拠**: gitShare.test.ts:210-232（B クローンが pull だけで card 取得・isShared=true）; src/lib/server/gitShare.ts:120-151（fetch throttle + ahead/behind）; ProjectPanel.tsx:1103-1114（90s poll）/1382-1386（↓バッジ）; sharedData.ts:15-49 + docs/SHARED_DATA_PLAN.md:45-47（個人状態は中央のまま）。

### S31 △ claude タスクセッションが API でカードを書いている最中に Sync

- **ユーザー行動**: Board カードの ▶ で起動した claude が API 経由でカード JSON を更新し続けている最中に、ユーザーが Sync を押す。
- **期待**: コミット時点のスナップショットが取られ、書き込み途中の壊れた JSON がコミットされたり、Sync 直後の claude の書き込みが rebase で消えたりしない。Sync 中もカード書き込み API は失敗せず（直列化 or 完了後反映）、Sync 完了時に取り込み漏れがあれば ↑ バッジが再点灯して気づける。
- **現状**: 壊れた JSON のコミットは起きない: カードファイルは atomicWriteText/atomicWriteJson（temp+rename）で書かれるので git が見るのは常に完全なファイル。Board 書き込み API は git と独立した fs 書き込み＋per-project 直列キュー（globalThis.__openground_board_writes）なので Sync 中も失敗しない。commit 後〜rebase 中に claude が書いた .openground/ の変更は --autostash が運んで自己復元する。Sync 完了後は必ず refreshShareStatus が走り、取り込み漏れ分は dirty ドット（次の Sync の commit 後は ↑）として再点灯する。
- **ギャップ**: shareSync 自体は board 書き込みキューと直列化されておらず、git 操作と claude の書き込みの相対順序は保証されない。具体的なエッジ: pull が変更したカードと同じカードを claude が rebase 中に書き換えていた場合、autostash の pop がコンフリクトして .openground/ にコンフリクトマーカー入りファイルが残り得るが、UI はこのケースを narrate しない（テストでもピン留めされていない）。また add と commit の間の書き込みは『そのとき働いていた最新内容』がコミットされる（pathspec commit は working tree を取る）— 実害はないがスナップショット時点は不定。
- **検証** (adjusted): 主張の骨子（部分カバー）は正しいが、エッジケースの故障モードの記述が事実と異なる。確認できた点: (1) カード書き込みは temp+rename の atomicWriteText 経由（atomicWrite.ts:22-36, projectData.ts:316）なので git が途中状態の壊れた JSON を見ることはない。(2) shared 書き込みは per-project 直列キュー globalThis.__openground_board_writes（projectData.ts:261-277）で、git とは独立した fs 書き込みのため Sync 中も API は失敗しない。(3) shareSync はこのキューの外で直接呼ばれ（server/routes/share.ts:40-44）、git 操作と claude 書き込みの相対順序は無保証 — ここまでは claim 通り。(4) Sync 後は必ず refreshShareStatus が走る（ProjectPanel.tsx:1026-1028）。誤りはエッジの帰結: claude が rebase 中に pull と同じカードを書き換えた場合、git の autostash 適用失敗は「コンフリクトマーカー入りファイルが残る」のではなく、git が autostash を通常の stash として保存し working tree を hard-reset する（"Applying autostash resulted in conflicts. Your changes are safe in the stash."、rebase 自体は exit 0）。つまりユーザー体験は claim より悪い方向: ① claude の Sync 中の書き込みは working tree から消えて stash に退避され、Sync は ok:true・pulled:true を返す（gitShare.ts:230-234 — autostash 適用失敗を検出する分岐がない。catch されるのは rebase コンフリクトのみ、gitShare.ts:237-254）。② working tree は clean なので dirty ドットも ↑ バッジも再点灯せず、claim が安全網とした「取り込み漏れは ↑ で気づける」がこのケースでは成立しない。③ このリポジトリの方針（stash 禁止＝stash は次セッションに不可視）から見ても、stash に沈んだ書き込みは UI からもユーザーからも見えない。なお gitShare.test.ts には rebase コンフリクト abort のテスト（:260-285）はあるが autostash 適用失敗をピン留めするテストは存在しない点は claim 通り。緩和要素: claude が「書き続けている」前提なら次の API 書き込みで working tree が再 dirty 化し、消えるのは中間 1 回分のみ。severity は「partial」のまま妥当だが、説明は『マーカー残留を narrate しない』→『autostash 適用失敗時に書き込みが stash に消え、Sync が成功と報告し、バッジ安全網も働かない（未検出・未テスト）』に訂正すべき。
- **根拠**: src/lib/server/gitShare.ts:230 (pull --rebase --autostash), gitShare.ts:237-254 (rebaseコンフリクトのみ検出、autostash apply失敗の分岐なし), gitShare.ts:278-284 (この場合 ok:true で返る); server/routes/share.ts:40-44 (shareSync はキュー外); src/lib/server/projectData.ts:261-277,316 (直列キュー + atomicWriteText); src/lib/server/atomicWrite.ts:22-36 (temp+rename); src/components/canvas/ProjectPanel.tsx:1014-1028 (Sync後の reload + refreshShareStatus); src/lib/server/gitShare.test.ts:260-285 (autostash適用失敗のテストは無し)

### S32 △ 二人が同時に Sync ボタンを押す

- **ユーザー行動**: スタンドアップ後、自分と同僚がほぼ同じ瞬間に Sync を押す。
- **期待**: 片方の push が先に通り、もう片方は rejected→自動 fetch+rebase+push リトライ（S24）で数秒後に成功する。ユーザー体験としては両者とも「Sync 成功」で終わり、最終状態は両方の変更を含む。リポジトリ側にロックや壊れた状態が残らない。
- **現状**: 後から push した側は non-fast-forward で reject されるが、shareSync はこれを throw せず note『push failed: <一行>』を付けて ok:true を返す（commit はローカルに安全）。UI は成功扱いの notice に server message を ' — ' で連結して表示し、status 再取得で ↑ バッジが残るので未送信に気づける。次の Sync の pull --rebase --autostash が相手の変更を取り込み、push が通る。リポジトリにロックや壊れた状態は残らない（全て通常の git 操作）。
- **ギャップ**: 期待されている『rejected → 自動 fetch+rebase+push リトライで数秒後に成功』は未実装。負けた側のユーザーは notice に『push failed: …』という caveat を見て、もう一度 Sync を押す必要がある（押せば確実に直る）。両者とも何もせず『Sync 成功・両方の変更が反映』とはならない。
- **検証** (confirmed): 主張どおり。shareSync は commit → pull --rebase --autostash → push を各1回ずつ実行するだけで、push が non-fast-forward で reject されてもリトライループは存在しない（gitShare.ts:263-276 のコメントが明記:「Failures … are reported, not thrown — the commit is safely local and the next sync will retry」。実装は notes.push(`push failed: ${firstLine(text)}`) して ok:true / pushed:false を返す）。UI 側は ok:true を成功扱いの notice (kind:'ok') にし、caveat message を ' — ' で連結表示（ProjectPanel.tsx:1020-1024、コメント1013「keeps any caveat message」）、直後に refreshShareStatus で ↑ バッジが残る（1026-1028）。よって S32 の期待「rejected→自動 fetch+rebase+push リトライで両者とも無操作で成功」は未実装で、負けた側はもう一度 Sync を押す必要がある（押せば pull --rebase が相手の変更を取り込み push が通る）。リポジトリは通常 git 操作のみで壊れず、conflict 時も rebase --abort でクリーンに戻る（gitShare.ts:237-254、test:283-284 が rebase 残骸なしを pin）。補足ニュアンス: pull 自体が fetch を伴うため、reject が起きるのは相手の push が自分の pull→push の数百ms の窓に着地した場合のみ。本当に「同時押し」だと両者 pull が空→push 競争でちょうどこのケースに当たるので、シナリオの timing では claim の挙動が現実。docs/SHARED_DATA_PLAN.md にもリトライ設計の言及なし。
- **根拠**: src/lib/server/gitShare.ts:263-284 (push 失敗は note のみ・ok:true、リトライなし); src/components/canvas/ProjectPanel.tsx:1008-1028 (ok notice に caveat 連結 + refreshShareStatus); src/lib/server/gitShare.ts:237-254 (conflict は abort でロールバック、ロック残らず)

### S33 △ 担当者（assignee）変更が同僚に伝わる

- **ユーザー行動**: PM がカードの assignee を自分から同僚に変えて Sync。同僚が次の Sync をする。
- **期待**: 同僚側の Sync 後、カードに自分の名前が付いて見える。S9 の取り込みサマリに「『X』の担当があなたになりました」と出ると、振られたことに確実に気づける。
- **現状**: assignee は ProjectTask の Shared フィールドとしてカードファイル（board/cards/<id>.json）に乗るので、PM の Sync → 同僚の Sync（pull）で確実に伝わり、Board のカードに同僚の名前が表示される。データ伝播自体は完全。
- **ギャップ**: S9 型の取り込みサマリ（boardDiffDigest）は added / done / moved / removed しか数えず、assignee 名が出るのは『新規追加カード』の場合のみ。既存カードの担当者変更は digest 上は無変化扱い → digest が null になり generic な『Synced / 同期しました』だけが出る。『「X」の担当があなたになりました』に相当する通知は無く、振られた本人は Board を眺めてカード上の名前に気づくしかない。
- **検証** (confirmed): 主張は正確。①データ伝播は完全: assignee は Shared フィールドで（src/lib/types.ts:383-385 「Shared data」コメント明記）、shared モードではカードファイル board/cards/<id>.json に書かれる（src/lib/server/projectData.ts:143-155 の normalizeCard が assignee を含めて serialize、:150）。よって PM の Sync → 同僚の Sync(pull) → reloadProjectData でカード上の担当者名は確実に更新表示される。②通知ギャップも事実: boardDiffDigest は added/done/moved/removed の4種のみ集計し（src/lib/boardDigest.ts:41-51, 53-71）、assignee 名が出るのは「新規追加カード」の names 連結だけ（:54-66）。既存カードの assignee 変更だけの pull では segments が空 → null を返し（:73）、ProjectPanel.tsx:1016-1023 で generic な 'projectPanel.syncDone'（同期しました）にフォールバックする。「『X』の担当があなたになりました」に相当するキーは i18n（projectPanel.ts/board.ts）にも存在せず、grep でも assignee 変更を通知する経路はゼロ。BoardModule の担当者フィルター（自分のみ）は能動的に見に行く手段であって通知ではない。ユーザー体験としては、振られた本人は Sync 後に Board を開いてカードの名前を目視で発見するしかない — 「partial」評価は妥当。
- **根拠**: src/lib/boardDigest.ts:41-73（added/done/moved/removed のみ、assignee 変更の diff セグメントなし、空なら null）; src/lib/types.ts:383-385（assignee は Shared data）; src/lib/server/projectData.ts:150（カードファイルに assignee を serialize）; src/components/canvas/ProjectPanel.tsx:1016-1023（digest null 時は generic 'syncDone' にフォールバック）

### S34 ○ Review 列 + PR URL が同僚から見える

- **ユーザー行動**: 開発者がカードを Review 列に移して PR URL を添えて Sync。レビュアーが Sync する。
- **期待**: レビュアーの Board で Review 列にカードが現れ、PR URL がリンクとしてクリックできる。「レビュー待ちが来た」ことが Sync するだけで分かり、Slack で URL を貼り直す必要がない。
- **現状**: reviewColumn は共有 ProjectConfig としてマーカー（.openground/openground.json の config）に乗り、prUrl はカードファイルの Shared フィールドとして乗るので、開発者の Sync → レビュアーの Sync で両方届く。レビュアーの Board には Review 列にカードが現れ（hidden 扱いの環境では 'doing' 扱いにフォールバック）、prUrl は BoardModule でクリック可能な <a href> リンク（プロトコル省略表示 + ↗、詳細ドロワーにも表示）としてレンダリングされる。Sync 後は board データが refetch されるので操作は Sync のみで完結する。
- **根拠**: src/lib/types.ts:411-428（ProjectConfig.reviewColumn 共有）/383-397（prUrl Shared、setPrUrl で claude が記録）; src/components/canvas/BoardModule.tsx:293-304, 589-606（prUrl を <a href> でレンダリング）; projectData.ts:243-257（parseSharedConfig）。

### S35 ○ メンバーリストの変更がチームに伝播する

- **ユーザー行動**: オーナーがチーム設定（共有側 config）に新メンバーを追加して Sync。既存メンバーが Sync する。
- **期待**: 共有 config はマーカー側（.openground/）にあるので、Sync だけで全員の assignee 候補に新メンバーが現れる。各自の起動プロファイル等の個人設定（中央保存）は影響を受けない、という2層の切り分け通りに動く。
- **現状**: members（assignee 候補リスト）は ProjectConfig の一部としてマーカーファイル側（.openground/openground.json の config）に保存される共有チームポリシーなので、オーナーの Sync → 既存メンバーの Sync（pull でマーカー更新）だけで全員の assignee ピッカーに新メンバーが現れる。isShared/マーカー読みは毎回 fresh な fs read（キャッシュなし）なので pull 直後の次のリクエストから反映。一方 ProjectLaunchPrefs（permissionMode/model 等の起動プロファイル）は『my trust level ≠ my teammate's』として明示的に中央保存（~/.openground/）にとどまり、config 伝播の影響を受けない — 2層切り分け通り。parseSharedConfig が junk フィールドを落とすので手編集されたマーカーでも読みが壊れない。
- **根拠**: src/lib/types.ts:411-428（ProjectConfig.members、marker.config として共有）/430-437（ProjectLaunchPrefs は中央）; projectData.ts:243-257（parseSharedConfig）; sharedData.ts:106-110（検知は毎回 fresh read）; docs/SHARED_DATA_PLAN.md:45-47。

### S36 △ 「自分のみ」フィルタが名前ベースで正しく効く

- **ユーザー行動**: 同僚が Sync で取り込んだ大量のカードの中から、「自分のみ」フィルタを ON にして自分の担当だけ見る。
- **期待**: フィルタは共有データ内の assignee 名と自分のローカル名（identity 設定）の対応で判定され、表記ゆれ（メール vs 表示名）で自分のカードが漏れない。名前未設定なら「自分の名前を設定してください」と案内され、空フィルタで全部消える事故にならない。
- **現状**: 「自分のみ」トグルは BoardTab に実装済み（src/components/canvas/BoardTab.tsx:63-70,176-205）。判定は assigneeMatches = カードの assignee と Settings.displayName を trim + 小文字化した完全一致（どちらか空なら不一致、未割当カードは決して「自分」にならない）。displayName は設定画面で入力（src/components/canvas/SettingsPanel.tsx:209-212、ヒント「共有ボードでの担当者名として使われます」）、プレースホルダ提案として `git config --global user.name` がサーバから返る（types.ts SettingsResponse.suggestedDisplayName — 保存はされない）。名前未設定の場合はトグルボタン自体が hasDisplayName ゲートで非表示になり filterActive=false → 全カード表示のまま（BoardTab.tsx:182-183,269-281）なので「空フィルタで全部消える」事故は構造的に起きない。表記ゆれ対策は (a) 大文字小文字・空白の正規化、(b) 担当者はフリー入力ではなく共有 members リスト + 自分の displayName からのチップ選択（src/lib/assignees.ts assigneeCandidates — 重複は case-insensitive で除去、+Add は共有 config.members に登録してから割当）で、チーム全員が同じ登録名から選ぶため揺れが構造的に減る。フィルタ状態は localStorage にプロジェクト UUID キーで永続。
- **ギャップ**: 2点が未カバー。(1) identity マッピングが存在しない — 照合は文字列完全一致のみで、メールアドレス vs 表示名、'Yuki' vs 'Yuki Sato' のような別名は対応付けられない。同僚が +Add で自分を指す別表記を登録してカードに割り当てると、そのカードは自分の「自分のみ」フィルタから漏れる（チップ選択 UI が揺れを抑えるが防げはしない）。(2) 名前未設定時の案内がない — トグルが黙って消えるだけで、「設定で表示名を設定してください」という導線はボード上に出ない（説明は設定画面のヒント文のみ）。事故（全消え）は防がれているが、機能の存在に気づけない可能性がある。
- **検証** (confirmed): 監査の claim は正確。実装の実態: (1) 「自分のみ」判定は assigneeMatches（BoardTab.tsx:63-70）で、カードの assignee と Settings.displayName を trim+小文字化した「完全一致」のみ。どちらか空なら不一致で、未割当カードは決して自分扱いにならない。identity マッピング（メール↔表示名、別名の対応付け）は皆無 — sharedData.ts / gitShare.ts / SHARED_DATA_PLAN.md を grep しても assignee/displayName への言及ゼロで、共有レイヤーは担当者名をただの文字列として運ぶだけ。同僚が 'Yuki' と 'Yuki Sato' を別チップとして +Add 登録すれば（assignees.ts withRegisteredAssignee は case-insensitive 重複排除のみで部分一致は別名扱い）、片方に割り当てられたカードは自分のフィルタから漏れる。緩和策はチップ選択UI（BoardModule.tsx:316-376、members リスト駆動）と正規化のみで、防止保証はない。 (2) displayName 未設定時はトグルが hasDisplayName ゲートで丸ごと非表示（BoardTab.tsx:184「Unset hides the "Mine only" filter entirely」コメント、:296-313 の hasDisplayName && レンダリング、:182 filterActive = mineOnly && hasDisplayName）→ 全カード表示のままなので「空フィルタで全消え」事故は構造的に起きないが、ボード上に「表示名を設定してください」という案内は一切ない（i18n board.ts に該当キーなし、settings.ts:47-48 のヒント文のみ）。機能の存在に気づけない gap は実在。suggestedDisplayName は git config --global user.name 由来の提案のみで保存されない（server/routes/misc.ts:93-99、types.ts:65）。 ユーザー体験としては「事故は起きないが、表記ゆれ漏れと未設定時の無言非表示」という partial 判定が正しい。
- **根拠**: src/components/canvas/BoardTab.tsx:63-70 (assigneeMatches trim+lowercase 完全一致), :182 (filterActive = mineOnly && hasDisplayName), :296-313 (hasDisplayName && でトグル非表示・案内なし); src/lib/assignees.ts:10-29,36-53 (members チップ + case-insensitive 重複排除のみ、alias 対応なし); src/components/canvas/modules/BoardModule.tsx:54-61,316-376; server/routes/misc.ts:93-99 (suggestedDisplayName = git user.name、非永続); src/lib/types.ts:53,65; src/i18n/messages/settings.ts:47-48; src/lib/server/sharedData.ts・gitShare.ts・docs/SHARED_DATA_PLAN.md に assignee/displayName/identity マッピングの記述なし (grep 0件)
