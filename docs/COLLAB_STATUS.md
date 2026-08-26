# 共有(コラボ)機能の現状 — 仕様・実測・詰めるべきこと

**調査日**: 2026-08-23 / **対象コミット**: `claude/yomeru-1atrmg` 時点の実コード
**方法**: 6並列の読み手(docs / server / worker / client / gate / tests)+ 実テスト実行 + 3本の敵対的検証(全 verdict を実コードで再確認)

> **この文書の位置づけ**: `docs/COLLAB_*.md` の6本は**すべて実装より古い**(§5)。
> どれか1本を読んでも現物と食い違う。**現状の正典はこの文書 + 実コード**。

---

## この調査の問い

「OPEN GROUND でプロジェクトを共有できる」と言えるのか。**仕様は何で、本当に動くのか、
人に使わせる前に何を詰めるべきか。**

## 30秒の答え

**実装は「ほぼ全部ある」。動作は「一度も実機で確かめていない」。そして出荷版では
すでに ON になっている。** — この3つが同時に成り立っているのが今の状態です。

- **実装**: 招待(メール/リンク/承認制/回数制限/人数上限)、参加、リアルタイム同期
  (Board + Canvas)、プレゼンス、画像共有(R2)、メンバー用のローカルキャッシュと
  フォルダ紐付け — **全部コードがある**。関連テストは **305 pass / 0 fail(実測)**。
- **でも**: そのテストは **Supabase と Worker を全部モックしている**。実際の
  Cloudflare Worker × 実際の Supabase × 2台のマシン、という本番の鎖は
  **一度も通したことがない**。リポジトリにも記録がない。
- **そして(2026-08-23 に是正済み)**: 出荷ビルドは `OPENGROUND_REALTIME=1` と運用
  Worker の URL が**焼き込まれていました**。つまりサインインしたユーザーが Board か
  Canvas タブを開いただけで、そのプロジェクトの全内容がクラウドに載っていた
  ——「共有する」操作は不要で、消す手段もない状態。**この既定 ON は外しました**(§7)。

一言でいうと: **機能としては完成度が高い。しかし「使える」と言うには実機一巡が
未実施。「安全」の側は既定 OFF 化で新規流入を止めたが、すでに載っている分の
後始末が残っている。**

---

## 1. 実際の仕様(現物ベース)

### 1.1 三層分離 — 何が共有され、何が共有されないか

| 層 | 中身 | 置き場所 | 経路 | リポジトリに書くか |
|---|---|---|---|---|
| **L1 状態** | Board(カード・ノート)/ Canvas(要素・画像) | Cloudflare DO の `Y.Doc`(正) + ローカルキャッシュ | **collab**(CRDT) | **書かない** |
| **L2 実体** | コードとドキュメント | Git 作業ツリー | **Git**(ユーザー自身の remote) | それがリポジトリ |
| **L3 identity** | 誰か / 誰が触れてよいか | Supabase(OAuth + メンバーシップ) | loopback → Worker / Supabase | 書かない |

**`claude` の PTY は共有されません**。共有されるのは Board と Canvas の中身だけです。

### 1.2 入口 → 参加 → 同期(実際の道筋)

```
オーナー: GET /api/collab/project?path=
  → findOrCreateOwnProject → og_projects 行を作成(name = sha256(ownerId:絶対パス)
    ← 生パスは送らない)、自分を role=owner で登録

招待A メール: POST /api/collab/invite {emails}
  → og_project_members に status='pending' で行を作る(この時点でアクセス権はゼロ)
  → 招待された人は Ground のお知らせベル(GET /api/collab/invites)で気づく
  → POST /api/collab/accept → accept_invite RPC(自分の行だけを反転)

招待B リンク: POST /api/collab/invite-link {mode, maxUses, memberCap}
  → 256bit トークン、既定 7日で失効、open(即参加)/ approval(オーナー承認)
  → POST /api/collab/join {code} → join_with_invite RPC(呼び出し元だけを INSERT)
  → openground://join?code= のディープリンクも登録済み(貼り付けも可)

同期: GET /api/collab/ticket?scope=&path|collabProjectId
  → Hono が **ユーザーの Supabase access トークンを Worker に server-to-server で中継**
    (ブラウザには渡さない)
  → Worker が JWKS で JWT 検証(ES256/RS256のみ)→ Supabase でメンバーシップ再確認
    → **HMAC チケット発行(TTL 60秒)**
  → wss://…/parties/og-collab-doc/<pid>:<scope>?token=…
  → onBeforeConnect でチケット検証(署名・期限・room 一致)→ 接続
  → OgCollabDoc(y-partyserver, hibernate)が DO SQLite に永続化
```

**room** = `collabProjectId + ":" + scope`、scope は `board` か `canvas:<id>`。
再接続のたびに partysocket がチケットを取り直します(タイマー不要)。

### 1.3 メンバー側(ローカルフォルダを持たない人)

ツールバー「Shared with me」→ 一覧 or コード入力 → **Board タブ + Canvas タブ**が
開きます。**Terminal は `POST /api/collab/link` で自分のクローンを紐付けた後だけ**
出ます(オーナーのコードが渡るわけではない — 各自が自分で clone する)。
オフライン用に `~/.openground/shared/<pid>/` にキャッシュ(上限 8MB)。

### 1.4 ゲート(どこで止まるか)

```
collabEnabled() = 業務モード(lockdown)でない
                AND OPENGROUND_REALTIME ∈ {1,true,yes,on}
                AND OPENGROUND_COLLAB_WS_URL が空でない
                AND サインイン済みセッションがある
```
`/api/collab/*` 全体に lockdown ミドルウェアがかかります(`/config` のみ例外)。
クライアントは `/api/collab/config` を1回だけ叩き、`enabled:false` なら
**yjs / y-partyserver / partysocket を一切バンドルしません**(OFF ビルドの保証)。

---

## 2. 「ちゃんと動くのか」— 3層に分けた正直な答え

### 緑(実測済み)

- **collab 関連テスト: 305 pass / 0 fail**(vitest 18ファイル 264件 + Worker スクリプト
  テスト 40件 + worker tsc)。2026-08-23 実行。
- **Worker のローカル実測**(`worker/test/local.mjs`, wrangler を実際に起動):
  2クライアントの収束 / 後発参加者が過去の状態を受け取る(= DO が保持している)/
  改竄チケットは 401 / room 違いのチケットは繋がらない / **`POST /ticket` に実際の
  ES256・RS256 JWT を投げて JWKS 検証とメンバーシップ判定を通す**(TEST 5・6)。
  → **ここは「呼べる」ではなく「効く」を見ている。**
- **チケット認証の敵対的検証**: チケット無しの WS は開かない、期限切れは弾く、
  room(pid+scope)が一致しないと通らない — **全 CONFIRMED**(worker/src/index.ts,
  ticket.ts の実コードで再確認)。

### 黄(実装はあるが未検証)

- **本番の鎖を一度も通していない**。上のテストは全て **Supabase をモック**しています。
  実際の RLS ポリシー(これがセキュリティの本丸)を実行したテストは**ゼロ**。
  Hono の中継 → 実 Worker → 実 Supabase を跨ぐテストも**ゼロ**。
  Playwright にも collab のシナリオは**ありません**。
- **2台のマシンでオーナーとメンバーが実際に繋がった記録がリポジトリにない。**
  `REPORT_COLLAB_REBASE.md:111` が「rebase 後にライブ QA は再実施していない」と
  明記しているのが最後の記録です。
  → **これは `docs/VERIFICATION.md` の掟3(プロセス/git/FS/ネットワークに触るなら
  実機で一度は通す)を満たしていない状態です。**

### 赤(リポジトリからは分からない = 実際に確かめるまで不明)

この4つのどれか1つでも外れていると、**collab は誰にとっても静かに死にます**
(この環境からは外向き通信が塞がれていて確認できませんでした):

1. **運用 Worker `og-collab.mindbrew.workers.dev` が現在のコードでデプロイされているか**
   (zero-config の `/ticket` と `/assets` が入った版か)
2. **Supabase の非対称 JWT 署名(JWKS)が有効か** — Worker の `jwt.ts` は
   **ES256/RS256 しか受け付けません**。本番がレガシーの HS256 のままなら
   **チケット発行が全部 401** になります。**いちばん可能性の高い故障モード。**
3. **マイグレーション 0010–0014 が本番 Supabase に適用済みか**
   (記録は 0008 あたりまでしか残っていない)
4. **R2 バケット `og-collab-assets` と Worker の env(SUPABASE_URL / ANON_KEY /
   TICKET_SECRET)が設定済みか**

---

## 3. 詰めるべきこと(優先順)

### P0 — 人に使わせる前に決着が必要

**(1) 同意なしの自動アップロード** 〔既定 ON は**是正済み** / 後始末は**未了**〕

出荷ビルドは `release.yml` が `OPENGROUND_REALTIME=1` と運用 Worker URL を
**既定で焼き込んでいました**(repo Variables 未設定時のフォールバック)。その結果:

> **サインインしたユーザーが、あるプロジェクトの Board か Canvas タブを開いただけで**、
> ① Supabase に `og_projects` 行と自分のメール入りメンバー行が作られ、
> ② Worker に接続され、③ **そのプロジェクトの Board / Canvas の全内容が
> クラウドの Y.Doc に書き込まれ**、④ DO SQLite に永続化されていました。
> **「共有する」ボタンを押す必要はありません。**

`CollabConsentDialog`(同意チェックボックス)は実装されていますが、**招待ダイアログの
経路にしか掛かっていません**。Board/Canvas のマウント経路(`RealtimeContext.tsx`)は
このゲートを通りません。`docs/SECURITY.md §8-1` が【最重要/critical】として
記録している事象です。

**是正(2026-08-23、オーナー判断)**: `release.yml` のフォールバック 2 行を削除。
以後、出荷ビルドは repo Variables を**両方明示的に設定したときだけ** collab 有効。
未設定なら `write-runtime-config.js` が両キーを落とし → `collabEnabled()` が false →
SPA は yjs / y-partyserver のチャンクすら読み込みません。既定 ON の復活は
`server/__tests__/runtimeConfig.test.ts` の GUARD ブロックが止めます(4変異で赤を実測)。

**まだ残っていること**:
1. **すでにクラウドに載っている分は消えていません**(§P1-(5) — 削除経路が存在しない)。
   誰かが出荷版でサインインして Board / Canvas を開いていれば、その中身は運用者の
   Cloudflare DO と R2、Supabase の行として**今もあります**。棚卸しと削除が要ります。
2. ~~repo Variables の確認~~ → **確認済み・問題なし(2026-08-23)**。
   `nannantown/open-ground` の Settings → Secrets and variables → Actions →
   Variables を目視: **Repository variables / Environment variables ともに空**
   ("This repository has no variables." / "This environment has no variables.")。
   したがって出荷物に焼かれていた collab 設定の出所は**削除したフォールバックだけ**
   であり、**今回の修正で新規の流入は止まります**。(release.yml は `environment:`
   を使っていないので Environment 側は元々効きませんが、そちらも空でした。)

   **その前提の実測**: 出荷済み `v0.11.95` の zip を Range リクエストで開き、
   `OPEN GROUND.app/Contents/Resources/app/electron/runtime-config.json` を直接読むと —

   ```json
   "OPENGROUND_REALTIME": "1",
   "OPENGROUND_COLLAB_WS_URL": "wss://og-collab.mindbrew.workers.dev"
   ```

   **出荷物には collab が確かに焼かれていました**(推測ではなく現物)。成果物だけでは
   フォールバック由来か Variable 由来かを区別できませんでしたが、Variables が空だと
   確認できたことで**フォールバック由来と確定**しました。

3. **既存インストールは既定 ON のまま**。是正が効くのは次のリリース以降です。
4. Phase 7 で再開するときは、swarm / persona と同じ **opt-in トグル**にするのが本筋
   (フラグではなくユーザーの意思で入る形)。

**(2) 実機一巡が未実施** 〔作業〕

実 Supabase + デプロイ済み Worker + アプリ2インスタンスで、
**招待 → 参加 → 収束 → 追放 → 追放後のコード再利用が弾かれる**、までを1回通す。
掟3が要求している一巡です。**これを通すまで「動く」とは言えません。**
先に §2赤の4項目(Worker のデプロイ版・JWKS・マイグレーション・R2)を確認するのが
最短経路です。

### P1 — 仕様として穴が空いているところ

**(3) キルスイッチが効かない** — `collabEnabled()` を見ているのは `/config` `/accept`
`/ticket` と `/asset` 2本**だけ**。`join` / `invite` / `invite-link` / `label` /
`members` / `projects` / `shared-data` など**約20本は `OPENGROUND_REALTIME` を無視**して
動きます(Supabase env とセッションは要る)。フラグを 0 にしても
メンバーシップと招待の書き込みは止まりません。サーバ側ミラーも同様。

**(4) 追放しても、開いているセッションは切れない** — チケット検証は**接続時の1回だけ**。
`OgCollabDoc.isReadOnly()` は常に false。**追放されたメンバーは、ソケットが切れるまで
読み書きし続けられます**。DO 側に kick も再認証もありません(再接続はチケットで止まる)。

**(5) クラウドのコピーを消す道が存在しない** — DO SQLite の Y.Doc にも R2 の画像にも
**DELETE ルートがありません**(`assets.ts` は GET / PUT のみ、R2 のライフサイクル規則も無し)。
ローカルでプロジェクトを削除しても、Supabase の行・DO の中身・R2 の画像は**残ります**。
(1) と組み合わさると「サインインして開いたプロジェクトは全部、取り消し不能でクラウドに残る」。

**(6) 権限が1段階しかない** — チケットは `role: owner|member` を運んでいますが
**DO は無視**。閲覧専用の段はありません。メンバーは誰でも Board / Canvas を全書き換え可。
(ただし R2 への PUT だけは owner 限定 — つまりメンバーは画像を貼れません。)

**(7) メンバーのフォルダ紐付けを外せない** — `POST /api/collab/link` で登録した後、
別フォルダへの付け替えは 409、解除の UI もありません(`SharedProjectBody.tsx` に
「there's no unlink yet」)。

**(8) `canvas:<id>` の scope に上限がない** — `issueTicket.ts` の検証は
`/^canvas:(.+)$/` で、長さも文字種も無制限(`pid` は `SAFE_PID` で絞っているのに)。
認証済みメンバーが任意の room を無限に作れる = 運用者のアカウントに
DO とストレージが無制限に生える余地。

### P2 — 効くが急がない

- **(9) ミラーの取りこぼし(既知・受容済み)**: 再起動を跨いだ未送信の削除は失われる /
  ディスク保存→ミラー適用の窓に入ったメンバーの編集は巻き戻る / `swarm-board.sh` の
  アプリ停止時フォールバック書き込みはミラーされない。
- **(10) ミラーの抜け道(今回新規発見)**: `shareEvac.ts`(Share via Git 撤去の一回限りの
  退避処理)が `tasks.json` と canvas を**直接書き**、ミラーを通りません。
  Canvas のタブ一覧(`canvases-index.json`)もサーバ側ではミラーされず、
  オーナーが Canvas タブを開くまでメンバーのタブ列に反映されません。
  削除した Canvas の room も消えないので、メンバーは削除済み Canvas を編集し続けられます。
- **(11) ミラーはオーナー機でしか効かない**: ミラーは `sha256(自分のid:パス)` で
  自分の `og_projects` 行を引くため、**メンバーのマシンでのサーバ側書き込み
  (swarm など)は共有 room に入りません**。メンバーが紐付けたクローンで swarm を回すと、
  元の巻き戻しバグが共有プロジェクトで再現します。
- **(12) プレゼンスがメールアドレス全体を配る**(設計文書は local-part のみと言っている)。
- **(13) `/ticket` にレート制限が無い**(1回ごとに JWKS fetch + PostgREST read)。
- **(14) 招待メール経路だけ `member_cap` を無視**(リンク経由と承認経由は効く)。
- **(15) `OPENGROUND_COLLAB_MEMBER_PROJECTS`** はメンバーシップ確認を飛ばす開発用の
  抜け道で、`GATE_ENV_FORBIDDEN` の除去リストに入っていません。
- **(16) 一覧系が全件取得**(`listMyProjects` / `listInvitesForMe` はページングなし)。

---

## 4. 意外だったこと(認識を改めるべき点)

- **「まだ作りかけ」ではない。** 承認制招待・使用回数制限・人数上限・ディープリンク・
  プレゼンス・R2画像共有・メンバー用オフラインキャッシュまで**作り切ってあります**。
  設計文書が「未実装」と書いているものが実際には動いています(§5)。
- **セキュリティ設計は素直に良い。** service-role キーを一切使わない / 生の絶対パスを
  送らない(sha256) / チケット TTL 60秒 / 秘密は Worker のみ / メンバー追放時に
  招待リンクを自動ローテーション / RLS で DB 側にも権限を寄せる。
  **敵対的検証3本はすべて CONFIRMED**(1件だけ REFUTED — 「Supabase-JWT 経路の
  自動テストが無い」は誤りで、実際には `local.mjs` TEST 5/6 が実行している)。
- **弱いのは「作り」ではなく「確かめ」と「同意」。** 未検証の本番鎖と、
  共有操作なしの自動アップロード — この2つが残っているだけです。

---

## 5. 設計文書が現物とズレている箇所(読む前に知っておく)

| 文書 | 書いてあること | 実際 |
|---|---|---|
| `COLLAB_ZEROCONFIG_PLAN.md` | 「design canon, **not yet implemented**」(2026-06-20) | Track A–D は**出荷済み** |
| `COLLAB_CF_DO_PLAN.md` | 「transport canon」/ Hono がチケットを発行、ローカルに HMAC 秘密が要る | **Worker が発行**、Hono は中継。ローカル秘密は**廃止** |
| `COLLAB_IMAGE_SHARING_PLAN.md` | 「planned, not implemented」/ R2 binding は `ASSETS` | **実装済み**。binding は `ASSET_BUCKET` |
| `COLLAB_MEMBER_CLIENT_PLAN.md` | メンバーの Canvas は未実装 | **実装済み** |
| `COLLAB_PLAN.md` | v1(Supabase Realtime Broadcast) | 自ら「history」と宣言済み。読まなくてよい |
| `worker/README.md` | Hono 側にも `OPENGROUND_COLLAB_TICKET_SECRET` を設定せよ | **不要**(Worker のみ)。`/ticket` `/assets` の記載も無い |
| `CLAUDE.md` | 「feature-gated and OFF by default — inert unless enabled」 | ソースツリーでは真。**出荷ビルドでは ON** |

**→ ZEROCONFIG の Track E(文書同期)が実行されていません。** この表の修正は
P1 と一緒に片付けるのが自然です。

---

## 6. おすすめの順番

1. **§2赤の4項目を実機で確認**(Worker のデプロイ版 / JWKS / マイグレーション / R2)
   — 30分。ここが外れていると他の議論が全部無意味になる。
2. **(1) 自動アップロードの扱いを決める** — オーナー判断。実装より先に決める。
3. **(2) 実機一巡**(招待→参加→収束→追放→再利用拒否)を1回通して記録する。
4. **(3) キルスイッチ統一 →(5) 削除経路 →(4) 追放の即時反映** の順で塞ぐ。
5. §5 の文書ズレを直す(Track E の後始末)。

---

## 付録 — 実測ログ

```
$ npx vitest run <collab 18ファイル>
Test Files  18 passed (18)
Tests  264 passed (264)     Duration 4.26s

$ cd worker && npm test
40 checks passed, 0 failed     (wrangler 実起動 + 2クライアント収束 + JWT/JWKS 経路)

$ npx tsc --noEmit -p worker/tsconfig.json
clean

$ curl https://og-collab.mindbrew.workers.dev/health
CONNECT tunnel failed, response 403   ← 調査環境の egress 制限。Worker の生死は未確認
```

**未確認事項の扱い**: 上の curl は**この調査環境から外に出られなかった**という事実で
あって、**Worker が落ちているという証拠ではありません**。運用者の手元から
`curl https://og-collab.mindbrew.workers.dev/health` を1回叩けば決着します。

---

## 7. 変更履歴

**2026-08-23 — 出荷ビルドの既定 ON を外した**(オーナー判断)

- `.github/workflows/release.yml`: `OPENGROUND_REALTIME` と
  `OPENGROUND_COLLAB_WS_URL` の `|| '1'` / `|| 'wss://og-collab…'`
  フォールバックを削除。repo Variables を明示設定したときだけ collab が乗ります。
- `server/__tests__/runtimeConfig.test.ts`: GUARD ブロックを追加。
  既定の復活(`||` フォールバック / WS URL のリテラル直書き / env 行の削除 /
  ログインの巻き添え)を検出します。**4変異すべてで赤を実測**し、復元後は
  byte 一致で緑。
- `CLAUDE.md`: 「OFF by default」の記述がリリースでも真になったので追随。

**この変更が止めるのは新規の流入だけです。** すでにクラウドにある分と、
既存インストール(次のリリースまでは既定 ON のまま)は別途対応が要ります。
