# PII 露出レポートと恒久対応(2026-07-14 スクラブ)

repo に焼き込まれていた実個人情報(PII)のスクラブ実施記録と、**既に公開済みの
履歴に残る分**の選択肢整理。後者は force-push 厳禁・配布資産への影響があるため
**本ブランチでは実行していない — ユーザー判断事項**。

> 表記方針: このレポート自体が repo に入るため、除去した具体値(実メール・実名・
> 実ユーザー名)は平文で書かない。種別+ファイル位置で記述する。再導入は
> `src/repoPiiGuard.test.ts`(sha256 照合)が機械的に fail させる。

---

## 1. 事象

作者の実個人情報がテスト fixture・docs・perf ハーネスに焼き込まれた状態で
リリースされ、公開配布 repo(nannantown/open-ground)の各リリーススナップ
ショット(v0.8.0〜v0.11.27、タグ 45 本)に含まれて公開された。

焼き込まれていた種別と箇所(2026-07-14 全数走査の結果):

| 種別 | 箇所 |
| --- | --- |
| 実メールアドレス(icloud 1件・gmail 1件) | `src/components/canvas/CollabPresence.test.tsx`、`src/lib/collab/presence.test.ts`(presence fixture) |
| 実ホームパス `/Users/<実ユーザー名>/…` | `src/lib/server/youCorpus.test.ts`、`perf/canvas-perf.spec.ts`(出力先デフォルト)、`docs/SYNC_COVERAGE_AUDIT.md`(根拠パス)、`docs/commander/02-worker-lifecycle.md`・`05-board-api-contract.md`(コマンド例)、`docs/patches/README-nene-playback.md`、`REPORT_COLLAB_REBASE.md` |
| 実名断片(表示名 fixture・例示) | `src/components/canvas/BoardTab.test.ts`、`CollabPresence.test.tsx`、`src/lib/collab/presence.test.ts`、`src/lib/assignees.test.ts`、`src/lib/collab/__tests__/docMappers.test.ts`、`docs/SYNC_COVERAGE_AUDIT.md` |
| 署名者名 + Apple Team ID | `docs/DISTRIBUTION_AUDIT.md`、`spike/electron-skeleton/{SPIKE.md,package.json}` → §5(意図的に残す) |

ランタイムコード(`src/`・`server/` の非テストコード)への焼き込みは**ゼロ**
だった(認証まわりは Supabase 側テーブル参照設計で、email をコードに埋めない
方針が機能している)。漏れていたのは fixture / docs / ハーネスのみ。

## 2. 実施済み対応(このブランチ)

1. **全数置換**(コミット `611c633`、12 ファイル)
   - メール fixture → `alice@example.com` / `op@example.org`(example.* のみ)
   - 表示名 fixture → `alice` / `bob` / `Aoi` / `Yuki Sato` 等の中立名
   - ホームパス → `/Users/me/…` `/Users/dev/…` `/path/to/…` `~/…` プレースホルダ
   - perf ハーネスの出力先デフォルト → `os.tmpdir()` ベース(`PERF_OUT` での
     上書きは従来どおり)
   - テストのアサーション対象・検証意味は不変(fixture 値の差し替えのみ)
2. **再発ガード**(コミット `283ce9c`、`src/repoPiiGuard.test.ts`)
   - `npm test`(= CI)で git tracked 全ファイル(バイナリ除く)を走査
   - (a) 実在プロバイダ宛メール禁止(fixture は example.* 限定)
   - (b) `/Users|/home` のユーザー名セグメントを中立 allowlist で固定
     (`-Users-<seg>-` 符号化形も対象)
   - (c) 漏出済み実名トークンの再導入を **sha256 照合**で検出 — ガード自体に
     平文を残さない。違反レポートもマスク表示で CI ログに平文を出さない
   - 敵対的自己検証済み: 3 種の違反を一時注入し、全て fail することを実証

## 3. 公開履歴に残る分(未対応・ユーザー判断)

> **決定(2026-07-14・ユーザー確定)**: 公開 repo+無料 CI は維持しつつ、公開側の
> **全履歴から除去する**。方式は §3.2 B の filter-repo ではなく、open-ground の
> 「1 リリース = 1 スナップショット」線形履歴の特性を使った**単一 root commit への
> main+全タグ付け替え**(タグは削除せず付け替え = Release 資産と auto-update feed を
> 保全)。author メタデータも新 root から noreply 化。実行手順・承認バルブ(force 系は
> ユーザーのみ)・ロールバック・GitHub キャッシュ purge 依頼: **`docs/PII_SCRUB_RUNBOOK.md`**。
> 以下の選択肢整理は決定までの検討記録として保存。

### 3.1 露出の全容 — ファイル内容だけではない

- **ファイル内容**: v0.8.0〜v0.11.27 の各スナップショット tree に §1 の内容が
  含まれる。`git clone` / GitHub のコードブラウズ・コード検索で到達可能。
- **コミット author メタデータ(追加発見・重要)**: open-ground の公開コミット
  の author が **実名+実メールアドレス**になっている(`git log` で誰でも取得
  可能)。これはファイル内容とは独立で、**tree をスクラブしても消えない**。
  さらに今後もリリース実行環境の `git config user.name/user.email` が実名系で
  ある限り、**新しいリリースコミットで再発し続ける**(§6)。

つまり「実名+実メール」はファイル漏出以前に author メタデータとして構造的に
公開されており、ファイル漏出による増分は主に「マシンのユーザー名(ホームパス)
と fixture 断片」である。この事実は下の選択肢のコスト対効果評価に効く。

### 3.2 選択肢と影響

| 選択肢 | 消えるもの | 影響・リスク |
| --- | --- | --- |
| **A. 現状維持** — 本ブランチの置換のみ(次リリース以降のスナップショットはクリーン) | 今後の露出の増分 | 過去タグ 45 本の tree と全コミット author には残存。作業ゼロ・リスクゼロ。 |
| **B. 履歴書き換え** — `git filter-repo`/BFG で該当 blob 除去+全タグ付け替え+force-push | 過去 tree のファイル内容(GitHub 上の canonical 参照) | ①全コミット SHA 変更 = **force-push 必須** — 本プロジェクトの force-push 厳禁ルール(swarm guard が機械 block・配布 repo の一貫性前提)と正面衝突。②既存タグ 45 本の削除→再作成が必要で、タグ削除時に紐づく **GitHub Release が draft 落ちする既知挙動** → electron-updater の update feed(Release 資産の latest-mac.yml 等)が一時断し、既存ユーザーの自動更新が壊れうる。③クローン/フォーク済みコピーには残る。④GitHub は到達不能コミットをキャッシュし SHA 直 URL で開けるため、**Support への purge 依頼(D)なしでは不完全**。⑤author メタデータも消すなら全コミット改変 = 実質 C と同じ破壊度。 |
| **C. public repo 作り直し** — 削除(or private 化)→同名で新規作成→クリーン tree を push | 過去の全履歴+author(最も確実) | **既存 Release 資産(全 dmg/exe)が消滅** → 配布中 URL 404・既存インストールの auto-update feed 死亡(手動再インストール告知が必要)。旧バージョン資産の再アップロードにはローカル保管が必要。star/watch/issue も消える。 |
| **D. B or C + GitHub Support へキャッシュ purge 依頼** | GitHub 側キャッシュ・到達不能コミット | B/C の前提リスクに加え Support とのやり取り。個人情報除去は [GitHub の Private Information Removal ポリシー](https://docs.github.com/en/site-policy/content-removal-policies/github-private-information-removal-policy)の対象になりうる。 |

### 3.3 worker 私見(推奨)

**A を推奨**(+§6 の author 運用変更)。理由:

- 露出済み情報の実害プロファイルは「メール 2 件へのスパム可能性・氏名・マシンの
  ユーザー名の判明」。認証情報・鍵・トークンの漏出はゼロ(§7)。氏名・メールは
  author メタデータおよび署名済みバイナリの codesign 情報(§5)として、公開
  OSS 配布者の情報として既に構造的に公開されている範囲に近い。
- B は force-push 厳禁ルールと配布フィードの安定性を壊す割に、クローン・
  フォーク・キャッシュに残るため秘匿効果が不完全。
- C だけが「確実」だが、既存全ユーザーの更新経路を破壊するコストが露出の実害に
  見合わない。
- 将来 PII の質が重い漏出(鍵・トークン等)が起きた場合は、C+D+鍵ローテーション
  が正解になる — その際もまず**無効化(ローテーション)が先、履歴消しは後**。

## 4. 検証

- `npm test` — 全緑(repoPiiGuard 含む)/ `npx tsc --noEmit` 0 error /
  `npm run lint` 0 error(既存 warning のみ)— 実行ログは PR/report 参照。
- ガードの実効性: 実在風メール・実ホームパス・実名トークンをダミーファイルで
  一時注入 → 3 検査すべて fail を確認 → 注入物を完全除去(コミットに不混入)。

## 5. 署名者名の判断(意図的に残す)

`docs/DISTRIBUTION_AUDIT.md` と `spike/electron-skeleton/{SPIKE.md,package.json}`
の署名者名(実名)+ Apple Team ID は**残す**。

- Developer ID 署名済み `.dmg` から `codesign -dvv` で**誰でも取得できる公開
  情報**であり(Apple の配布モデル上、配布者名の公開は不可避)、除去しても
  秘匿効果がゼロ。
- `DISTRIBUTION_AUDIT.md` は「本体からの identity 除去」を記録した監査文書で、
  当時の値の記録が文書の本質。spike/ は同文書 §2.4 が「歴史記録として意図的に
  残す(fork 時に消してよい)」と判断済み。
- ガード上は、この 3 ファイルだけ実名トークン照合を免除(`TOKEN_EXEMPT_FILES`)。
  メール・ホームパス検査は免除していないので、同ファイルへの別種 PII の混入は
  引き続き検出される。

## 6. 今後の運用(ユーザー判断・本ブランチ未実施)

リリースコミットの author を noreply 化しない限り、実名+実メールは新しい公開
コミットのたびに author メタデータへ入り続ける。恒久化するなら:

- リリース実行環境(司令塔)の git 設定を
  `user.name = nannantown` / `user.email = <GitHub の noreply アドレス>`
  (Settings → Emails → *Keep my email addresses private* で発行される
  `<id>+nannantown@users.noreply.github.com`)へ変更し、GitHub 側で
  *Block command line pushes that expose my email* を有効化する。
- 変更は open-ground へのスナップショット commit を作る環境(release スキル
  実行環境)にのみ必要。過去コミットの author は履歴書き換え(§3.2 B/C)なし
  には変わらない。

## 7. スコープ外

- **secret 類(API キー・トークン・鍵)**: 本タスクの走査対象は PII のみ。
  PII 走査中に secret らしきものは目視していないが、網羅走査は別軸
  (public repo は GitHub secret scanning のデフォルト対象)。
- **`~/.openground` 等ローカルデータ**: repo 外・配布物外のため対象外。
