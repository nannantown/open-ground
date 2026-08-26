# 共有(コラボ)機能の現状 — 仕様・実測・詰めるべきこと

**調査日**: 2026-08-23 / **最終更新**: 2026-08-26(§2赤の決着 + §8 消去の実施記録 + §9 削除経路の設計)
**対象コミット**: `claude/yomeru-1atrmg` 時点の実コード
**方法**: 6並列の読み手(docs / server / worker / client / gate / tests)+ 実テスト実行 + 3本の敵対的検証(全 verdict を実コードで再確認)

> **この文書の位置づけ**: `docs/COLLAB_*.md` の6本は**すべて実装より古い**(§5)。
> どれか1本を読んでも現物と食い違う。**現状の正典はこの文書 + 実コード**。

> ## ⚠ 現在の方針(2026-08-26 オーナー決定) — 共有機能は**利用者に対して閉じています**
>
> **「一旦ユーザーからは閉じる。機能としては残しておいて、落ち着いたらそこも作っていく」**
>
> - **畳むのではありません。** コードも Cloudflare の Worker も Supabase のテーブルも
>   そのまま残します。撤去しないでください。
> - **開き直さないでください。** 出荷ビルドは collab OFF(§7)、DB は書き込み凍結
>   (§8.1 / `0015`)。この2つが「閉じている」の実体です。**実機一巡や動作確認のために
>   一時的に開けたら、必ず元に戻してから終わること。**
> - **再開するときの順番は §6。** 先に「利用者が自分で消せる経路」(§9)を作ります。

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

### ~~赤~~ → **4つとも実測で閉じました(2026-08-26、運用者の手元から)**

調査時は外向き通信が塞がれていて確認できなかった4項目です。**どれも外れていません
でした** — つまり「collab が静かに死んでいる」状態ではありませんでした。

| # | 項目 | 実測結果 |
|---|---|---|
| 1 | 運用 Worker が現行コードでデプロイ済みか | **YES** — `curl https://og-collab.mindbrew.workers.dev/health` → `200 og-collab ok`。バンドル内に `/ticket`・JWKS 検証・`ASSET_BUCKET` を確認済み |
| 2 | Supabase の非対称 JWT 署名(JWKS)が有効か | **YES** — `/auth/v1/.well-known/jwks.json` が **ES256(P-256, `use:sig`)の鍵を1本**返します。`keys` は空ではない = レガシー HS256 ではない。**「いちばん可能性の高い故障モード」は外れ** |
| 3 | マイグレーション 0010–0014 が適用済みか | **YES** — `og_projects_unique_owner_name`(0014)まで全部適用済み |
| 4 | R2 バケットと Worker の env | **YES** — バケット `og-collab-assets` 実在(2026-06-16 作成)。secret は `OPENGROUND_COLLAB_TICKET_SECRET` / `SUPABASE_URL` / `SUPABASE_ANON_KEY` の**3つとも設定済み** |

**これが意味すること**: 本番の鎖は繋がっていました。§2黄の「本番の鎖を一度も通して
いない」は依然として本当ですが、その理由は**配管が壊れているからではなく、単に
一巡していないから**です。P0-(2) の実機一巡は、この4項目に阻まれずに実施できます。

**再測の仕方**(この表を信じる前に自分で確かめたいとき):

```bash
curl https://og-collab.mindbrew.workers.dev/health           # → og-collab ok
curl https://tlyicnxiitfoxzvojwhy.supabase.co/auth/v1/.well-known/jwks.json   # → keys[0].alg == ES256
cd worker && npx wrangler secret list                        # → 上記3つ + ADMIN_SECRET
```

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
1. ~~すでにクラウドに載っている分は消えていません~~ → **棚卸しと消去を完了しました
   (2026-08-26)。§8 に件数と手順の実測記録があります。** 併せて DB 側の書き込みを
   凍結したので(`supabase/migrations/0015_collab_freeze_writes.sql`)、**古い版の
   インストールが残っていても行は復活しません**。
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

**(5) クラウドのコピーを消す道が存在しない** 〔**運用者の経路は実装済み / 利用者の
経路は未実装** — 設計は §9〕

元の状態: DO SQLite の Y.Doc にも R2 の画像にも **DELETE ルートがありませんでした**
(`assets.ts` は GET / PUT のみ、R2 のライフサイクル規則も無し)。ローカルでプロジェクトを
削除しても、Supabase の行・DO の中身・R2 の画像は**残りました**。(1) と組み合わさると
「サインインして開いたプロジェクトは全部、取り消し不能でクラウドに残る」。

**2026-08-26 に入れたもの**: Worker に `POST /admin/rooms/purge`(`worker/src/admin.ts`)。
**運用者専用**で、メンバーのチケットではなく別のシークレット
(`OPENGROUND_COLLAB_ADMIN_SECRET`)で認証します。未設定なら 503 で不活性。room 名でも
生の DO id でも消せます(id 形式は、名前が分からない・P1-(8) の緩い検証で作られた
room も含めて**網羅**できる唯一の形)。

**まだ無いもの**: **利用者自身が消せる経路**。プロジェクトをローカルで削除しても、
「共有をやめる」を押しても、クラウドのコピーは今も残ります —— 運営者が手で消すしか
ありません。これは元の欠陥の主要部分がそのまま残っているということです。設計は **§9**。

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

1. ~~**§2赤の4項目を実機で確認**~~ → **完了(2026-08-26)。4つとも問題なし** — §2 の表。
2. ~~**(1) 自動アップロードの扱いを決める**~~ → **完了**。既定 OFF 化(§7)+ 溜まった分の
   消去 + DB 側の書き込み凍結(§8)。**ただし利用者が自分で消す経路はまだ無い**(§9)。
3. **(5) 削除経路の利用者向け半分を作る** — §9 の設計に判断が3つ残っています。
   collab を再開するかどうかに関わらず、これが先。**再開しないなら尚更**、
   残ったデータを消す手段が要ります。
4. **(2) 実機一巡**(招待→参加→収束→追放→再利用拒否)を1回通して記録する。
   §2赤が晴れたので、いま塞がっているものはありません。**注意: 0015 の凍結が効いている
   ので、一巡する前に UNDO を当てる必要があります**(当てたら戻すこと)。
5. **(3) キルスイッチ統一 →(4) 追放の即時反映** の順で塞ぐ。
6. §5 の文書ズレを直す(Track E の後始末)。

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

**→ 決着しました(2026-08-26、運用者機から)**:

```
$ curl https://og-collab.mindbrew.workers.dev/health
og-collab ok          (HTTP 200)

$ cd worker && npm test
66 checks passed, 0 failed    (40 → 66。TEST 7 消去 / TEST 7z 順序契約 / TEST 8 fail-closed)

$ npx tsc --noEmit -p worker/tsconfig.json
clean
```

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

**2026-08-26 — 溜まっていた分を消し、DB 側で書き込みを凍結した**(オーナー判断)

- Supabase 21/23/2/0 行 → **すべて 0**。R2 22オブジェクト(4.50 MiB)→ **0**。
  Durable Object 41インスタンス → **全消去**。件数と検証は **§8**。
- `supabase/migrations/0015_collab_freeze_writes.sql`: クライアントの INSERT 経路を
  RLS ごと止め、RLS を迂回する3つの `SECURITY DEFINER` RPC の EXECUTE を剥奪。
  **古い版のインストールが残っていても行は復活しません。** 可逆(UNDO は同ファイル末尾)。
- `worker/src/admin.ts`: 運営者専用の消去ルート `POST /admin/rooms/purge`。
  未設定なら 503 で不活性。worker のチェックは 40 → 66 に増え、5つの変異のうち4つで
  赤を実測(残る1つ — 接続クローズ — は赤にならず、コメントを実測に合わせて訂正)。
- **利用者自身が消せる経路はまだありません。** 設計は **§9**。
- 手元に残っていた「共有オン」入りのビルド成果物5つを削除(`dist-electron/` 丸ごと)。§8.4。

**2026-08-26 — 共有機能は当面「利用者に対して閉じる」**(オーナー決定)

「一旦ユーザーからは閉じよう。機能としては残しておいて落ち着いたらそこも作っていく」。
畳むのではなく、コードもクラウドの入れ物も残したまま閉じます。実体は ①出荷ビルドの
collab OFF(2026-08-23)②DB の書き込み凍結(0015)の2つ。併せて削除の仕様も決まりました
——**「プロジェクトのオーナーが消したら消える。他のユーザーは消せない」**(§9.4)。

**2026-08-23 — 出荷ビルドの既定 ON を外した**(再掲・下記が原文)

---

## 8. クラウドに溜まった分の消去 — 実施記録(2026-08-26)

出荷ビルドの既定 ON(§7)によって同意なく運用者のクラウドに載っていた分を、棚卸し
して消しました。**すべて実測値です**(「たぶん空」で進めた手順はありません)。

### 8.1 先に確かめたこと — 消しても復活しないか

消してもクライアントが再びサインインして Board/Canvas を開けば行は復活するので、
**先に流入を止めてから**消しています。

| 確認 | 実測 |
|---|---|
| GitHub リリース | `v0.11.96` が Latest(2026-08-26 03:28Z) |
| 運用者機の `/Applications/OPEN GROUND.app` | **0.11.96** |
| その `Contents/Resources/app/electron/runtime-config.json` の現物 | `SUPABASE_URL` と `SUPABASE_ANON_KEY` のみ。**collab の2キーは無い** |
| 稼働中サーバの本番の読み手 | `GET /api/collab/config` → **`{"enabled":false}`** |

**それでも足りない、と判断した理由**: 運用者機が更新済みでも、**他人の端末は分かり
ません**。og_project_members には運用者以外のメールが1つあり(外部メンバー)、その
端末が ≤0.11.95 のままなら消した行が復活します。アプリ側の修正はその機械に届きません。

**そこで DB 側で凍結しました** — `supabase/migrations/0015_collab_freeze_writes.sql`。
クライアントの版に関係なく効く唯一の場所です。

- `og_projects` / `og_project_members` の **INSERT ポリシーを削除**(RLS 既定拒否へ)
- `join_with_invite` / `approve_join_request` / `accept_invite` の **EXECUTE を
  `authenticated` から剥奪** — この3つは `SECURITY DEFINER` で **RLS を迂回する**ので、
  ポリシー削除だけでは招待リンクと承認経由の参加が素通りしたままになります
- **SELECT と DELETE は温存**。読めなくすると監査ができなくなり、消せなくすると
  今回作っている削除経路そのものが死ぬからです

**赤で実測してから緑にしました**(適用が効いたかを status ではなく挙動で見る):

```
適用前: authenticated として og_projects に INSERT   → 成功(= 再流入の経路は生きていた)
適用後: 同じ INSERT                                  → ERROR 42501 row-level security
        3つの RPC の has_function_privilege          → すべて false
        INSERT ポリシー数 og_projects / members      → 0 / 0
        DELETE ポリシー数 og_projects / members      → 1 / 1(温存を確認)
```

`get_advisors(security)` は**新規の指摘ゼロ**(残る1件は collab と無関係の既存 WARN)。

**これは可逆で、可逆であることが前提の措置です。** Phase 7 で opt-in 付きで再開する
ときは、マイグレーション末尾の UNDO ブロックを 0016 として適用してください。

### 8.2 消した中身(削除前の件数 → 削除後)

| 対象 | 前 | 後 | 備考 |
|---|---|---|---|
| `og_projects` | **21** | **0** | オーナー2アカウント。うち **意図して共有したのは2件だけ**(`kickstand` / `YukiNan`、2026-06-21、外部メンバー各1名)。残る19件は開いただけで自動生成 |
| `og_project_members` | **23** | **0** | owner 21 + 外部 2。メール3種 |
| `og_project_invites` | **2** | **0** | 両方すでに失効済み(2026-07-02 / 07-03) |
| `og_project_join_requests` | **0** | **0** | — |
| **R2 `og-collab-assets`** | **22 オブジェクト / 4,722,871 bytes (4.50 MiB)** | **0 / 0 bytes** | 全部が1プロジェクト・1キャンバス配下。2026-07-29 11:10Z の35秒間に一括アップされた PNG 群。**バケット自体は残しています**(消すと Worker の `ASSET_BUCKET` バインディングが壊れるため) |
| **DO `og-collab_OgCollabDoc`** | **41 インスタンス**(全て `hasStoredData: true`) | 下記 | Board のカード・ノートと Canvas の要素・テキストの**本文そのもの** |

**バックアップ**: `~/Documents/openground-collab-backup-2026-08-26/`(パーミッション
700。メールアドレスと招待トークンを含むのでリポジトリには置いていません)。Supabase
の4テーブルは Management API から**直接 dump**しています(転記ではありません)。R2 の
マニフェストと DO の id 一覧も同じ場所です。**DO の中身だけはバックアップがありません** —
外から読み出す API が存在しないためで、消去は完全に不可逆です。

### 8.3 Durable Object の消し方 — 案A ではなく「id 名指しの全消去」を採った理由

当初案は wrangler の `migrations` に `deleted_classes` を足して `OgCollabDoc` を削除→
再作成する案Aでした。**Cloudflare の現行ドキュメントで裏を取った結果、1回のデプロイでは
できません**:

> Delete migration は「**先にバインディングと Worker コードからクラスを取り除いてから**
> デプロイする」手順。削除にはクラスがコードに**無い**ことが必要で、再作成には**在る**
> ことが必要 — 両立しません。

つまり最低2回のデプロイになり、その間 Worker は壊れた状態になります。代わりに:

**Cloudflare の API が「保存データを持つ全インスタンス」の権威ある一覧を hex id で
返す**ので(`/workers/durable_objects/namespaces/<ns>/objects`)、room 名を推測せずに
41個を名指しできます。網羅性は案Aと同一で、デプロイは1回、namespace は壊れません。

```
POST /admin/rooms/purge   {"ids":[...10件ずつ...]}
  → 5バッチ: purged=41  failed=0   hadDoc=38
```

`hadDoc` が 38 で 41 ではないのは、3つが `ydoc` キーを持たなかったからです(接続は
されたが文書を保存する前に終わった room。partyserver 側のメタデータだけが残っていた)。
`deleteAll()` はキーの有無に関わらず**ストレージ全体**を消すので、41件すべてが空に
なっています。

**消えたことの確認 — ここで一度引っかかりました。** 消去直後に Cloudflare の namespace
一覧を数えると **41件のまま `hasStoredData: true`** でした。この一覧は遅延反映です。
そこで**本番のストレージを直接読み返しました** — 同じ41個の id に2周目の purge を
かけると:

```
second pass over 41 ids:  ok=41  failed=0
  still holding a persisted ydoc = 0
```

`hadDoc` は毎回 `storage.get()` を実行した結果なので、**0 は「1周目で本当に空に
なっていた」ことの直接の証拠**です。一覧 API の数字を待たずにこちらで判定しました。

その後、一覧 API も追いつきました(90秒間隔で監視):

```
05:01:48Z  objects=41  hasStoredData=41     ← 消去直後。まだ古い数字
05:03:18Z  objects=41  hasStoredData=36
05:04:50Z  objects=41  hasStoredData=29
06:30:59Z  objects=0   hasStoredData=0      ← 反映完了
```

**教訓**: `/workers/durable_objects/namespaces/<ns>/objects` は**遅延反映**で、消去
直後は古い値を返します。ここで「消えていない」と判断していたら、効いている消去を
やり直すか、案A(namespace 削除)へ不必要にエスカレートしていました。**DO の中身を
判定するなら、一覧 API ではなく DO 自身に読ませること。**

### 8.4 ついでに見つかったもの(未処理・要判断)

### 8.4 手元に残っていた「共有オン」の成果物 — **処理済み**

`dist-electron/` の中に、**collab 既定 ON が焼き付いたビルド成果物が5つ**残っていました。
`/Applications` の 0.11.96 とは別物ですが、起動・インストールされれば**いま消したものを
もう一度アップロードする経路**です。CLAUDE.md が記録している「消したはずのランチャーが
名前解決を横取りして、生きている方を隠した」事故と同じ形をしています。

| 成果物 | 焼かれていたか |
|---|---|
| `dist-electron/mac/OPEN GROUND.app`(0.11.6) | **あり** |
| `OPEN GROUND-0.11.6-arm64.dmg` / `-x64.dmg` | **あり** |
| `OPEN GROUND-0.11.6-arm64.zip` / `-x64.zip` | **あり** |
| `dist-electron/mac-arm64/OPEN GROUND.app`(0.11.7) | なし(`{}`) |
| 0.1.0 / 0.2.0 の dmg・zip | なし(`runtime-config.json` を持たない版) |

**`dist-electron/` を丸ごと削除しました**(1.2GB、`.gitignore` 済みのビルド出力で、
ソースからいつでも再生成できます)。削除後にリポジトリ全体を掃引し、
`OPENGROUND_REALTIME` を含む成果物が**ゼロ**であることを確認済み。

> **検査そのものを間違えかけた記録**: 最初の `.dmg` 検査は `find -maxdepth 5` で
> `runtime-config.json` を探しており、**深くて見つからなかっただけなのに「共有オン無し」と
> 表示**していました。dmg 4つを「無害」と誤って報告する寸前でした。存在検査は沈黙で失敗
> します —— **「見つからなかった」と「無かった」を出力で区別する**まで信用しないこと。
> 測り直しは「ファイルの個数」と「中身そのもの」を出す形に変えました。

---

## 9. 削除経路の設計(P1-(5) の本体・**提案**)

§8 は一回限りの後始末です。**根本は「ローカルで消してもクラウドに残り続ける」構造**で、
そこは直っていません。以下は設計の提案で、まだ実装していません。

### 9.1 いま何が無いのか

`POST /api/project/delete` はフォルダをゴミ箱へ送り、レジストリ項目を外し、中央データ
ディレクトリを `rm -rf` します。**クラウドには一切触れません。** 「共有をやめる」も
「Canvas を削除」も同じです。結果として、消える経路を持たないコピーが3層に残ります:

| 層 | 残るもの | いま消せるのは |
|---|---|---|
| Supabase | `og_projects` / `og_project_members` / `og_project_invites` の行 | 手作業(RLS の DELETE ポリシーはある) |
| Durable Object | Board と Canvas の Y.Doc 本文 | **運営者のみ**(§8 で入れた `/admin/rooms/purge`) |
| R2 | Canvas の画像バイト | 誰も(`assets.ts` は GET / PUT のみ) |

### 9.2 設計の核 — 3つの決定

**(a) 運営者用と利用者用は別の経路にする。** 管理シークレットは利用者に配れないので、
`/admin/rooms/purge` を製品経路に流用することはできません。利用者向けには
**オーナーのチケットで認証する削除**を別に用意します(チケットは `role` を運んでいて、
`OgCollabDoc.isReadOnly` のコメントが「将来の権限分岐の縫い目」と書いている箇所が
まさにここです)。管理経路は運営者の掃除用として残します。

- Worker: `DELETE /rooms/<pid>` — `role === 'owner'` のチケット必須
- Worker: `DELETE /assets/<pid>` / `DELETE /assets/<pid>/<canvasId>` — 同じくオーナー限定
  (`assets.ts` の PUT が既にオーナー限定なので、判定はそのまま使えます)

**(b) 順序は好みではなく契約。** §8 の worker テスト(TEST 7z)で**実測**しました —
**接続したままのクライアントは、消した直後に自分の手元の Y.Doc をサーバへ押し戻します**。
消去だけでは足りません。正しい順序は:

```
1. メンバーシップの行を消す      ← これで新しいチケットが発行できなくなる
2. DO の room を消す(board + 全 canvas)
3. R2 の <pid>/ 配下を消す
4. og_projects の行を消す        ← pid が要るので最後
```

1 を飛ばすと 2 が無意味になります。この契約は `worker/src/admin.ts` の冒頭と
`OgCollabDoc.purgeStorage()` のコメントに書いてあり、テストが守っています。

**(c) room の一覧を推測に頼らない。** ここが設計上いちばん重要です。プロジェクトの
room は `<pid>:board` と `<pid>:canvas:<id>` ×N で、**N を知っているのはクライアント
だけ**です(`canvases-index.json`)。クライアントの一覧を信じて回すと、取りこぼした
room が黙って生き残ります —— **存在検査は沈黙で失敗する**、という CLAUDE.md が
繰り返し記録している型です。

構造で止めます。**room が自分自身を索引に登録する**:

- 各 `OgCollabDoc` は初回の `onSave` で、`<pid>:__index` room に自分の scope を登録する
- プロジェクト削除は索引を読んで**そこに載っている全部**を消し、最後に索引自身を消す
- 索引に載らずに保存された room は原理的に存在しない(登録と保存が同じ経路にあるため)

クライアントの一覧は「速い道」として使い、索引は「正しい道」として使います。両者が
食い違ったら索引が正です。

**(d) 取りこぼしの受け皿 — 孤児掃除。** (c) があっても、途中で失敗した削除・過去の
データ・バグは残り得ます。**og_projects に対応する行が無い DO / R2 を定期的に見つけて
消す照合処理**を運営側に置きます。これは「全部の経路が正しい」ことに依存しない唯一の
保証で、§8 でやったことを自動化したものです。

### 9.3 触る場所

| 場所 | 変更 |
|---|---|
| `worker/src/admin.ts` | オーナーチケット経路を追加(消去の実体は `purgeStorage()` を再利用) |
| `worker/src/assets.ts` | `DELETE` を追加(prefix 単位、オーナー限定) |
| `worker/src/OgCollabDoc.ts` | `onSave` の初回に索引登録。索引 room 用の分岐 |
| `src/lib/server/projectMembers.ts` | `deleteProjectCompletely(pid)` — 9.2(b) の順序を1関数に閉じ込める |
| `server/routes/collab.ts` | `POST /api/collab/delete-cloud-copy` |
| `server/routes/project.ts` | `/api/project/delete` から上を呼ぶ。**失敗しても削除は止めない**(ローカル削除がクラウドの都合で失敗するのは筋が悪い)。代わりに「クラウドのコピーが消えていません」と残し、再試行できるようにする |
| UI | 設定に「クラウドに残っているコピー」の一覧と削除ボタン。**collab が OFF でも表示する** — §8 で消した21件はまさに「OFF なのに残っていた」分で、OFF だと見えない設計だと同じことが起きます |

### 9.4 決まったこと(2026-08-26)

**オーナー決定 — 削除の権限と伝播**:

> **「プロジェクトのオーナーが消したら消える。他のユーザーは消せない。」**

これが仕様です。実装に落とすと:

- **オーナーの削除は共有相手の画面にも伝播する。** クラウドのコピー(DO / R2 / Supabase の行)
  を消すので、メンバーの Board / Canvas タブからも消えます。
- **メンバーは削除できない。** メンバーにできるのは「自分が抜ける」ことだけ。
  Worker 側の削除ルートは `role === 'owner'` のチケットしか受け付けない、という
  §9.2(a) の設計はこの決定と一致しています(`isReadOnly` のコメントが言っている
  「将来の権限分岐の縫い目」がここ)。
- **メンバーの手元のキャッシュ**(`~/.openground/shared/<pid>/`)は他人の機械の中なので
  運営者からは消せません。オーナーの削除がメンバーに届いた時点で、メンバー側のアプリが
  自分で捨てる、という形にします。

**技術的な判断(こちらで決めたもの、オーナー判断を要さない部分)**:

- **削除時に確認を出す**: 共有相手が居るプロジェクトに限り、「相手の画面からも消えます」と
  1回確認します。オーナーの意思で消えるという上の決定は変えず、事故だけを防ぐためです。
  共有相手が居なければ黙って消します。
- **索引 room は入れる**(§9.2(c))。入れない場合、削除の網羅性が「クライアントの
  canvas 一覧が正しいこと」に依存し続けます。取りこぼした room は**エラーも出さずに
  生き残る**ので、今回と同じ「気づかないまま残っている」状態を作ります。
  CLAUDE.md が繰り返し記録している「存在検査は沈黙で失敗する / 過大近似はビルドで落ちる」
  の判定の向きの問題そのもので、構造で止める側を採ります。
- **孤児掃除は入れる**(§9.2(d))。全経路が正しいことに依存しない唯一の保証で、
  §8 で手作業でやったことの自動化です。

**この作業自体の着手時期は未定**です(上の方針どおり、共有機能は当面閉じたまま)。
ただし**閉じたままでもこの経路は要ります** — 今回のように「使っていないのに残っている」
分を、運営者の手作業ではなく仕組みで消せるようにするためです。
