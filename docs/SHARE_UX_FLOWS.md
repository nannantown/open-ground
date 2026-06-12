# Git 共有 — 共有ライフサイクル・フロー台帳 & UX 再設計

この文書は 2 部構成: **第 1 部**が共有機能の全ペルソナ × 全フローの現状監査
（フロー台帳）、**第 2 部**がそれを受けた UX 再設計の設計決定。git エンジン
（`gitShare.ts` / `shareAutoSync.ts`）と正典のデータ設計（docs/SHARED_DATA_PLAN.md）
は一切変えない — 変えるのは「入口・語彙・開始フロー・招待」の 4 点のみ。

---

# 第 1 部 — フロー台帳

書式: `[S###] ペルソナ: フロー — ✅(現状OK) / ⚠️(痛点)`
ペルソナ: **A**=共有を始めるオーナー / **B**=招待される同僚 / **S**=ソロ利用者（共有しない）

参照実装: `server/routes/share.ts`, `src/lib/server/gitShare.ts`,
`src/lib/server/sharedData.ts`, `src/components/canvas/ProjectPanel.tsx`,
`src/components/canvas/modules/BoardModule.tsx`（歓迎ストリップ）

## 1. 共有開始（ソロ → 共有）

- [S001] A: 共有機能の存在に気づく — ⚠️ 唯一の入口が ⋯メニュー奥の「Share via Git…」。ヘッダーにも設定にも痕跡がない（ユーザー問題意識 #2）
- [S002] A: 押す前に「何が起きるか」を理解する — ⚠️ ShareConfirm は説明 1 段落 + Share ボタンのみ。どの設定（flow/branch/members/表示名）で始まるかの確認ゼロ（問題意識 #3）
- [S003] A: git repo でないフォルダで共有しようとする — ✅ メニュー項目 disabled + tooltip（`shareNeedsGitRepo`）、API 側も 412 `not-git`
- [S004] A: `.gitignore` が `.openground/` を無視している repo — ✅ 412 `ignored`、文言が「ルールを外せ」と実用的
- [S005] A: remote が無い repo で共有開始 — ⚠️ enable は黙って成功し、初回 Sync で初めて `noRemote`。開始時点で「相手とどう共有するのか」の案内が無い
- [S006] A: private repo（要 git 認証）で共有 — ✅ pure git 設計。push/pull はユーザー自身の認証、ダイアログにも明記
- [S007] A: クローンした repo に既に `.openground/` がある — ✅ マーカー自動検知で即共有モード、enable 不要（412 `already-shared` も防衛済み）
- [S008] A: enable 直後に「まだ公開されていない」と分かる — ✅ `shareEnabledNotice`「Sync を押して公開」/ ⚠️ 5 秒で消える一過性 notice のみで、見逃すと dirty ドットを眺めるだけ
- [S009] A: 開始時に自分の表示名を決める — ⚠️ 開始フローに表示名が存在しない。グローバル設定（SettingsPanel の displayName）に別置きで、Board の「自分の担当」表示が後から壊れていることに気づく
- [S010] A: 開始時に初期メンバーを登録する — ⚠️ 開始後に⋯メニュー→Project settings を別途開く必要。一連の流れになっていない
- [S011] A: 開始時に completionFlow / targetBranch を確認する — ⚠️ ShareConfirm に出てこない。チームの作業規約が「知らないデフォルト(merge)」で始まる
- [S012] A: enable が途中でクラッシュ — ✅ best-effort rollback（`.openground/` 削除）+ 再 enable で回復
- [S013] A: rebase/merge 進行中・detached HEAD で開始 — ✅ enable 自体はファイル書きのみで無害、Sync 時に preflight が理由つきで拒否
- [S014] A: 共有データが「ブランチに従う」ことを開始時に知る — ⚠️ 共有後の ⎇branch チップ + hint で初めて知る。開始ダイアログでは言われない

## 2. 相手の招待と参加

- [S015] A: 共有開始後、相手に何を渡せばいいか分かる — ⚠️ 何も出ない。clone URL・手順の案内が一切なく、オーナーが自力で説明文を書く
- [S016] B: clone → 「Import existing folder」→ 自動検知 — ✅ マーカー検知でゼロ設定、正典どおり
- [S017] B: 初参加の 5 分（ここは何？編集していい？） — ✅ 共有歓迎ストリップ（✕で永続 dismiss、非メンバーのみ表示）
- [S018] B: 表示名未設定のまま「自分の担当」を見ようとする — ✅ mineOnly disabled + 理由 title、ストリップが設定へ誘導 / ⚠️ 誘導先がグローバル設定パネルへの「文言」のみで、その場で入力できない
- [S019] B: 自分を members に載せる — ⚠️ A が足すのか B が足すのか導線上の答えがない（実装上は誰でも設定から追加でき config が同期するが、説明がどこにもない）
- [S020] B: read 権限しかない collaborator が編集 → Sync — ⚠️ push 失敗が raw git エラーで返る。権限の問題だと分かる文言がない
- [S021] B: import する前に「この repo は共有されてるのか」を気にする — ✅ 気にしなくてよい設計（検知が自動）

## 3. 日常運用

- [S022] A+B: 双方編集中の auto-sync（~15s 収束） — ✅ adaptive interval + debounced push、Live 表示
- [S023] A: 今すぐ反映したい → Sync クリック（force） — ✅ Live インジケータのクリック＝手動 sync
- [S024] A+B: 同一カード同時編集 → 競合 — ✅ resolve ダイアログ（mine/theirs、削除側も表現）、コード競合は対象外という線引きも正しい
- [S025] A: コードのコミットが ahead に混在 — ✅ `paused-code` で停止し自己説明、CODE IS SACRED が守られる
- [S026] B: オフライン編集 → 復帰 — ✅ pending push が生存、次ラウンドで pull→push
- [S027] A: upstream の force-push を吸収 — ✅ `forcedUpdate` sticky 警告
- [S028] A: ブランチを切り替えたら Board が変わった — ✅ ⎇branch チップ + `syncBranchHint` で説明済み

## 4. 設定変更の伝播

- [S029] A: メンバー追加が B に届く — ✅ marker `config` 経由で auto-sync 同期
- [S030] A: completionFlow / targetBranch 変更が B にどう見えるか — ⚠️ 同期はされるが変更通知はゼロ。B は次のラン前ナラティブ（flowText）で気づくのが最短 — 軽微だが「勝手に変わった」感
- [S031] B: 設定ダイアログの左列が「全員に効く」と認識して編集する — ⚠️ `settingsSharedHint` の 1 行のみ。非共有時とまったく同じ見た目で、共有時だけ重みが変わることが伝わらない
- [S032] A: Auto-sync を切るのは自分だけ — ✅ Personal 列 + hint「この端末のみ」
- [S033] S: 共有していないのに設定に「Shared policy」見出しが見える — ⚠️ **核心ペイン（問題意識 #1）**。「え、これ何？誰と共有？」になる
- [S034] S: 非共有なのに members 欄が見える — ⚠️ S033 と同根。assignee 用途と共有用途が同じ語で混線

## 5. 解除・離脱・削除

- [S035] A: Stop sharing → central へ戻す + フォルダ削除 — ✅ ダイアログが「削除のコミットは自分で」と明記
- [S036] A が解除した後の B — ⚠️ B が pull すると `.openground/` が消え central にフォールバックするが、B の central にはデータが無い（ボードが突然空に見える）。事前警告も B 側の説明も無い
- [S037] B: 自分だけ抜ける — ⚠️ 「離脱」という概念がない。Remove from canvas で実質離脱できるが members に名前が残り続ける
- [S038] A: 共有中のプロジェクトを Delete — ✅ central data + フォルダは消えるが remote の共有データは残る（git 的に正しい挙動）
- [S039] A: 解除 → 再共有 — ✅ disable→enable のラウンドトリップは migration が往復対応

## 6. 異常系

- [S040] B: push 権限なし（S020 の Sync 結果） — ⚠️ `message` が raw git。`reason` 細分化なし
- [S041] A: リモートが消えた / URL 変更 — ⚠️ unreachable は一律 `offline:true` 扱い。「オフラインです」と言われ続けて原因に辿りつけない
- [S042] A: git identity（user.name/email）未設定マシン — ✅ `no-identity` reason + 専用文言
- [S043] A: Canvas に巨大画像を貼り続ける — ⚠️ assets はバイナリ直コミットで履歴が肥大。ガード・警告なし（既知 idea）
- [S044] A: ユーザー自身の rebase/merge 進行中に Sync — ✅ preflight が何も触らず拒否、理由文言あり
- [S045] A: autostash 再適用衝突（git は exit 0） — ✅ `autostash-conflict` を ok:false で捕捉、loud error

## 7. ソロ git ユーザー（共有しないが workflow は使う）

- [S046] S: completionFlow / targetBranch を設定してタスクを回す — ✅ 機能は完動 / ⚠️ 設定上の置き場所が「Shared policy」で、共有の語に怯む（S033 と同根）
- [S047] S: 非 git プロジェクトの設定を開く — ⚠️ completionFlow / targetBranch / worktrees が意味を持たないのに表示される（flowText は非 git で消えるのに設定は消えない非対称）
- [S048] S: members に自分だけ入れて mineOnly フィルタ — ✅ assignee 機能として動く
- [S049] S: 後からチームができて共有に昇格 — ✅ 既存 config は `migrateBoardToShared` が marker に載せて持ち越す

**集計: ✅ 27 / ⚠️ 22。痛点はほぼ全て「開始前後の体験」（S001-S015）と「非共有時の語彙」（S033/S034/S046/S047）に集中。日常運用・競合・異常系の git エンジン側は堅い。**

---

# 第 2 部 — Git 共有 UX 再設計 設計決定

前提: ミニマル原則（テキストのみ・装飾アイコンなし・5状態・ja/en）を維持。

## a) 設定ダイアログの新しい情報設計（ProjectSettingsDialog）

「Shared policy / Personal」の固定 2 カラムを廃止し、**共有状態
（`shareStatus.shared`）と git 状態（`shareStatus.gitRepo`）でセクション構成が
変わる**構造にする。出し分けは純関数 `settingsSections()`
（`src/lib/shareUx.ts`）が決める。ダイアログは props で
`shareStatus: ShareStatus | null` / `onStartShare()` / `onShowInvite()` /
`onStopShare()` を受け取る。

### 状態 1: 非共有 × git repo（ソロ git ユーザー — 共有の語を一切見せない）

| セクション | 項目 | 出所 |
|---|---|---|
| **タスクのワークフロー** (Task workflow) | completionFlow（merge/pr + hint + gh 事前チェック）/ targetBranch | `config.*` — 旧 Shared policy の改名。hint は「タスク完了時に claude が何をするか」、共有・チームの語彙ゼロ |
| **Personal** | permissionMode / model / worktrees 一覧+掃除 | `launch.*` |
| **共有 CTA**（最下部、border-t 区切り） | 1 行説明 + テキストボタン「このプロジェクトを共有する…」→ ShareStartDialog | project.missing 時 disabled |

- **members は非共有時は設定から消す**（Board 側の assignee「+Add」導線は残る — S048 は困らない）。
- **autoSync チェックは非共有時は消す**（値は spread 温存で消えない）。

### 状態 2: 非共有 × 非 git

- **Personal セクションのみ。** completionFlow / targetBranch / worktrees /
  共有 CTA すべて非表示（S047 の非対称解消）。既存保存値は `{...data.config}`
  spread で温存。
- shareStatus が null（不明）のときは旧来どおり workflow を出す（保守的
  フォールバック）。CTA は「非共有 × git repo と判明」したときだけ。

### 状態 3: 共有中 — 「共有」セクションが出現する

| セクション | 項目 | 備考 |
|---|---|---|
| **共有 (Shared with your team)** ← 先頭 | 状態 1 行（remote 短縮名 · ⎇branch） | 読み物 |
| 〃 | あなたの表示名（inline input） | グローバル `settings.displayName` をここで読み書き（保存時に `/api/settings` へ POST）。S009/S018 の解消 |
| 〃 | メンバー（chips + add） | hint「全員に同期されます」 |
| 〃 | Auto-sync チェック | 注記「この端末のみの設定」 |
| 〃 | テキストリンク「招待方法を表示…」 | d) の InvitePanel を再表示（S015 の常設導線） |
| 〃 | テキストリンク「共有を解除…」（accent） | 既存 disable 確認へ。解除ダイアログに 1 行追加: 「同僚側は解除のコミットが届くとボードが空に見えます — 事前に伝えてください」（S036 の最小手当） |
| **タスクのワークフロー** | 状態 1 と同一 UI | hint 差し替え:「チーム全員に適用・同期されます」（S031） |
| **Personal** | permissionMode / model / worktrees | 既存どおり |

## b) Share via Git の表への出し方 — 入口 2 つ + ⋯メニュー撤去

1. **ヘッダー**: `!shared && gitRepo && !missing` のとき、共有後に Sync/Live が
   現れるのと同じ位置に控えめなテキストボタン「Share…」。クリック →
   ShareStartDialog。「共有前の Share」→「共有後の Sync/Live」が同一スロットの
   状態遷移になり、場所の学習が一度で済む。非 git プロジェクトのヘッダーには
   何も出ない。判定は純関数 `showHeaderShare()`。
2. **設定ダイアログ最下部の CTA**（a) 状態 1）。
3. MoreMenu の share/unshare エントリは**削除**（解除は a) の共有セクションへ）。

## c) 共有開始ダイアログ — ShareStartDialog（enable 側 ShareConfirm を置換）

`src/components/canvas/ShareStartDialog.tsx`。1 画面・縦 1 カラム
（ウィザードにしない）。既存 full-panel overlay 言語。上から:

1. label-cap「SHARE VIA GIT」+ タイトル「<project> をチームと共有」
2. 説明段落（既存 `shareDialogExplain`）+ 1 行追記「共有データはチェックアウト
   中のブランチに従います（現在: ⎇<branch>）」（S014）
3. **接続先**: remote 短縮名 + URL。remote 無し（S005）は accent 警告行
   （「remote を追加してから始めることをおすすめします」）— **開始はブロック
   しない**（後から `git remote add`→Sync の auto-publish が拾う）。
4. **あなたの表示名**（input、`settings.displayName` prefill）: 空のままなら
   開始ボタン disabled + 理由 title（**必須**）。
5. **メンバー**（任意、chips + add）: 初期値 = 既存 `config.members`。
   自分の表示名は開始時に自動で含まれる。
6. **タスクのワークフロー確認**: completionFlow + targetBranch（現 config を
   prefill — 設定ダイアログとコンポーネント共用）。（S011）
7. フッター: Cancel / primary「共有を開始」（busy 中「共有を準備中…」）。
8. **成功後**: ダイアログを閉じず、中身が **InvitePanel（d）に切り替わる**
   （S008/S015 をその場で解決）。

### API 拡張 — `POST /api/project/share/enable`

```
旧: { path }
新: { path, config?: { completionFlow?: 'merge'|'pr', targetBranch?: string, members?: string[] } }
```

- server（share.ts）: precondition 通過後、`config` があれば
  `readProjectData → { ...data.config, ...受領 config } → writeProjectData` を
  **`migrateBoardToShared` の前に**実行 — marker は migration が central config
  を読んで載せる既存経路（S049 で実証済み）に乗る。入力は share.ts 内で検証
  （許可 3 キーのみ・型チェック）、不正は 400。`config` 省略時は完全に従来挙動
  （後方互換）。
- **displayName は enable に混ぜない**: グローバル設定なので client が開始
  ボタン押下時に `/api/settings` へ先に保存 → 成功後 enable（settings 保存
  失敗時は enable に進まずインラインエラー）。

## d) 相手の参加体験 — InvitePanel

enable 成功直後の画面 + 設定「招待方法を表示…」から常時再表示:

1. **公開状態行**: `dirty || ahead > 0` なら「まだリモートに公開されていません」
   + primary「今すぐ公開 (Sync)」（既存 doSync）。公開済みなら「公開済み —
   相手はいつでも参加できます」。
2. **手順 3 行**: ①相手に repo の push 権限を渡す（ホスト側） ②相手が clone
   ③OPEN GROUND の「Import existing folder」で開く — 設定不要で同じ Board/Canvas。
3. **コピー可能な招待テキスト** + Copy ボタン（remote URL 埋め込み、UI 言語で
   生成）。remote 無しの間は「remote を追加すると招待文がここに出ます」。
4. フッター「完了」で閉じる。

（B 側ストリップの inline 表示名入力 + 「メンバーに自分を追加」1 クリックは
BoardModule 側のフォローアップ — 並行トラックの領域のため本ブランチ対象外。）

## 実装メモ

- 触るファイル: `ProjectPanel.tsx`（ダイアログ再構成・MoreMenu 撤去・ヘッダー
  Share）、`ShareStartDialog.tsx`（新規）、`src/lib/shareUx.ts`（出し分け純関数、
  新規）、`server/routes/share.ts`（enable body 拡張）、
  `src/i18n/messages/projectPanel.ts`（ja/en）、`src/lib/shareClient.ts`
  （enableShare に config 引数）。
- テスト: enable+config の central→marker 伝播、config 省略の後方互換、不正
  config 400、出し分け純関数のユニットテスト。
