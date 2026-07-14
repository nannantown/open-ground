# open-ground クリーン main リセット runbook(2026-07-14)

公開配布 repo **nannantown/open-ground** の main・全タグを「PII スクラブ済み tree の
単一 root スナップショット commit」へ付け替え、公開側の全履歴から個人情報を到達不能に
する一回きりのオペレーション手順書。

- 背景・除去対象の種別と箇所: `docs/PII_EXPOSURE_REPORT.md`
- 準備スクリプト(生成+検証): `scripts/og-clean-reset.sh`
- 通常リリース手順の正典: `docs/DISTRIBUTION.md` §0(本件の恒久変更は §0.5)

> 表記方針: このファイルも repo に入るため、除去対象の具体値(実メール・実名・実ユーザー名)
> は平文で書かない。再導入は `src/repoPiiGuard.test.ts` が機械的に fail させる。

---

## 0. 方針(ユーザー確定 2026-07-14)

配布は **公開 repo + 無料 CI を維持**する。ただし個人情報(実メール・実名・実ホームパス)は
公開側に**一切**載せない。open-ground の履歴は「1 リリース = 1 スナップショット commit」の
線形チェーン(実測済み — 各リリース commit が直前リリース commit を唯一の親に持つ)なので、
**清潔 tree の新 root commit へ main と全タグを一回付け替える**ことで全履歴から除去できる。

**制約(厳守)**:
- open-ground repo の削除・作り直しは**厳禁**(Releases 資産が消え、既存ユーザーの
  electron-updater auto-update が壊れる)。リセットは branch/tag ref の付け替えのみ。
- 実行は**ユーザー承認後のみ**。force 系操作は worker/司令官とも直接実行しない
  (swarm-guard が manager セッションの force push を機械 block する — 仕様であり回避しない)。

## 1. 前提(2026-07-14 実測)

| 項目 | 実測値 |
| --- | --- |
| PMmap `origin/main` のスクラブ | 完了(`e1b7615`+`284e000`+`56edf1d`)・`src/repoPiiGuard.test.ts` **4 テスト緑** |
| open-ground `main` HEAD | `3eec60a3…`(OPEN GROUND 0.11.28)— author/committer が実名+実メール(**全 46 commit 同様**) |
| open-ground の履歴構造 | 線形チェーン 46 commits(スナップショットのみ・ブランチ分岐なし) |
| タグ | 46 本(v0.1.0〜v0.11.28)・**全て lightweight**(annotated なし = tagger メタデータなし) |
| Releases | 46 本。v0.4.0 のみ元から draft(配布対象外)。各 Release に dmg/exe/zip/yml/blockmap 資産 |
| 配布資産の PII | **クリーン実証済み** — electron-builder `files` は `electron/**, server/dist/**, dist-web/**, scripts/openground-{hook,guard}.js, skills/og-manage/SKILL.md, src/designs/**, node_modules/node-pty/**` のみ(src 本体・テスト非同梱)。0.11.28 arm64 dmg 実物を全走査(テキスト+バイナリ)して禁止パターン 0 件 |
| Actions 設定(復元用) | `{"enabled":true,"allowed_actions":"all"}` |

## 2. 設計 — 何が起きるか

1. **新 root commit(SNAP)** をローカル生成: tree = PMmap `origin/main`(スクラブ済み
   0.11.28)と完全一致・**親なし**(旧履歴への参照ゼロ)・author/committer =
   `nannantown <48724510+nannantown@users.noreply.github.com>`(noreply 化 — author
   メタデータの実名+実メールも今回で断つ)。
2. `main` → SNAP へ **force 付け替え**(旧 46 commits は unreachable 化)。
3. **全 46 タグ** → SNAP へ **force 付け替え**。タグを**削除しない**理由:
   - GitHub Release は tag ref の削除で **draft 落ちする既知挙動**があり、資産 URL
     (`releases/download/vX.Y.Z/…`)と electron-updater feed が死ぬ。
   - 付け替えなら Release エンティティと資産(dmg/exe/yml)は **tag_name 紐付けのまま無傷**。
   - 副作用(意図的): 各 Release ページの自動 "Source code (zip/tar.gz)" リンクは全て
     清潔 tree(0.11.28 相当)になる。旧バージョンのソース公開は本件の除去対象そのもの
     なので、これは望む挙動。バイナリ資産はバージョンごとに本物のまま。
4. 旧 commit は GitHub 内部にキャッシュされ **SHA 直指定 URL では暫く到達可能**(§7)。
   完全消去には GitHub Support への purge 依頼が必要。

## 3. 実行主体の原則(承認バルブ)

| 操作 | 実行者 | 理由 |
| --- | --- | --- |
| SNAP 生成・検証・refspec 生成(ローカル・push なし) | ユーザー(推奨)or 司令官 | 可逆・outward でない。guard は司令官の `bash <script>` 実行を block するため、実務上はユーザーの素の端末が確実 |
| mirror バックアップ(read-only clone) | ユーザー or 司令官 | read-only |
| Actions 無効化/再有効化(repo 設定変更) | **ユーザー** | 公開 repo の設定変更 = outward |
| **force push(main+全タグ付け替え)** | **ユーザーのみ** | swarm-guard が manager の force を機械 block(仕様)。**承認行為そのもの** — ユーザーがこの runbook を読み §4.4 を自分の手で打つことが実行承認 |
| read-back 検証(gh api / ls-remote / DL 確認) | 司令官 | read-only |
| GitHub Support purge 依頼 | **ユーザー** | アカウント本人のみ可 |

## 4. 実行手順

> 4.1〜4.5 は**この順番どおり**。4.3(Actions 無効化)を飛ばすと、タグ force update の
> push イベント 46 発が release.yml を 46 回発火させ、既存 Release へ 0.11.28 の tree で
> ビルドした資産を上書きアップロードしにいく(実害級の事故)。

### 4.1 [ユーザー] SNAP 生成+検証(PMmap checkout・push なし)

```bash
cd ~/projects/OPEN-GROUND        # origin=PMmap / openground=open-ground の両 remote を持つ checkout
git fetch origin main
bash scripts/og-clean-reset.sh   # 生成+4種機械検証+refspec/pushコマンド生成
```

出力の `SNAP = <40hex>` と `push コマンド = <path>/push-commands.sh` を控える。
スクリプトは以下を機械検証して fail-closed する(1つでも落ちたら push に進まない):
tree == origin/main / 親なし root / author+committer noreply / 実行環境の実トークン
($USER・user.email localpart)が tree に不在。

さらに PII ゼロの主保証として、スクラブ済み origin/main で `npm test` 緑
(`src/repoPiiGuard.test.ts` — tracked 全ファイル走査)を確認しておく:

```bash
npx vitest run src/repoPiiGuard.test.ts   # 4 passed であること
```

### 4.2 [ユーザー] mirror バックアップ(ロールバック材料)

```bash
cd "$(mktemp -d)"
git clone --mirror https://github.com/nannantown/open-ground.git og-backup-$(date +%Y%m%d).git
# 旧 main・全タグ・全 commit object の完全コピー。ロールバック(§5)と purge 依頼(§7)の材料。
# 終わったらパスを控え、少なくとも purge 依頼完了まで消さない。
```

### 4.3 [ユーザー] GitHub Actions を一時無効化

```bash
gh api -X PUT repos/nannantown/open-ground/actions/permissions -F enabled=false
gh api repos/nannantown/open-ground/actions/permissions   # {"enabled":false} を確認
```

無効化中に届いた push イベントは(後で再有効化しても)遡って実行されない — タグ 46 本の
force update で release.yml が 46 連発する事故をこれで塞ぐ。

### 4.4 [ユーザー] force push(main+全 46 タグ・atomic 一発)

```bash
bash <4.1 で控えた OUT_DIR>/push-commands.sh
# 中身は: git push --atomic openground $(cat <OUT_DIR>/refspecs.txt)
# --atomic: 47 refs 全部成功 or 全部失敗(中途半端な状態を作らない)
```

これが**不可逆の一手**(厳密には §5 のロールバック窓があるが、公開状態は即座に変わる)。
実行前チェックリスト:
- [ ] 4.1 の検証がすべて OK だった
- [ ] 4.2 の mirror バックアップが存在する
- [ ] 4.3 で Actions が `enabled:false` になっている

### 4.5 [ユーザー] Actions を再有効化

```bash
gh api -X PUT repos/nannantown/open-ground/actions/permissions -F enabled=true -f allowed_actions=all
gh api repos/nannantown/open-ground/actions/permissions   # §1 の元設定に戻ったことを確認
```

### 4.6 [司令官] read-back 検証 → §6 を全部実行

## 5. ロールバック

mirror バックアップ(4.2)がある限り、**旧状態への完全復元が可能**(GitHub 上の旧 object が
GC される前なら SHA 参照だけでも戻るが、mirror があれば GC 後でも object ごと push し直せる):

```bash
cd <og-backup-YYYYMMDD.git>
git push --atomic --force https://github.com/nannantown/open-ground.git \
  '+refs/heads/main:refs/heads/main' '+refs/tags/*:refs/tags/*'
```

- ロールバックも force = **ユーザー実行**。実行前に §4.3 と同様 Actions を無効化する
  (タグ 46 本が旧 SHA へ戻る push イベントでも release.yml 46 連発は同じ)。
- Release 資産はこの間ずっと無傷(ref 操作は Release エンティティに触らない)。

## 6. read-back 検証(実行後・司令官=read-only で可)

`<SNAP>` は 4.1 の値。すべて観測可能な true/false で判定する。

```bash
# (1) 全 ref が SNAP を指す(main + 46 タグ = 47 行、全行 SNAP)
git ls-remote https://github.com/nannantown/open-ground.git | grep -v '\^{}'
#    → 期待: HEAD / refs/heads/main / refs/tags/v* の全行が <SNAP>

# (2) デフォルトブランチ履歴が 1 commit のみ・author/committer が noreply
gh api 'repos/nannantown/open-ground/commits?per_page=100' \
  --jq 'length, (.[0] | {sha, author: .commit.author, committer: .commit.committer, parents})'
#    → 期待: 1 / sha==<SNAP> / email が 48724510+nannantown@users.noreply.github.com / parents==[]

# (3) 公開 tree に禁止パターンがない(実物 clone で走査)
cd "$(mktemp -d)" && git clone --depth 1 https://github.com/nannantown/open-ground.git og-verify
cd og-verify && npm ci --ignore-scripts && npx vitest run src/repoPiiGuard.test.ts
#    → 期待: 4 passed(tree 自体が自分のガードで清潔を自己証明する)

# (4) Releases 無傷 — feed と実 DL
gh api 'repos/nannantown/open-ground/releases?per_page=100' --paginate \
  --jq '[.[] | select(.draft==false)] | length'
#    → 期待: 45(v0.4.0 は元から draft)
gh release download v0.11.28 --repo nannantown/open-ground --pattern 'latest-mac.yml' --dir "$(mktemp -d)"
gh release download v0.11.28 --repo nannantown/open-ground --pattern '*arm64.dmg' --dir "$(mktemp -d)"
#    → 期待: 両方ダウンロード成功(= electron-updater feed と配布導線が生きている)

# (5) 旧 main SHA のキャッシュ到達性(purge 依頼の要否判定)
gh api repos/nannantown/open-ground/commits/3eec60a313836b4d58a584b7e1fae0117ec51172 --jq .sha
#    → 200 が返る間は GitHub キャッシュに残存 = §7 の purge 依頼を出す(想定どおりの挙動)
```

## 7. GitHub キャッシュと Support への purge 依頼

**force 後も旧 commit は消えない**: GitHub は到達不能 object を即座に GC せず、
`https://github.com/nannantown/open-ground/commit/<旧SHA>` や API の SHA 直指定で
暫く閲覧できる(既知仕様)。フォーク・ローカル clone に残る分は GitHub 側では消せない。

完全消去にはユーザー本人が GitHub Support へ依頼する:

1. <https://support.github.com/contact> →「Clearing cached views / removing sensitive data」
   系のフォーム(個人情報は [Private Information Removal ポリシー](https://docs.github.com/en/site-policy/content-removal-policies/github-private-information-removal-policy)の対象)。
2. 依頼内容(英語テンプレ):
   > I force-pushed my repository `nannantown/open-ground` to remove personal
   > information (private email address, real name, and home directory paths)
   > from its entire history. Please run garbage collection and clear cached
   > views so the old unreachable commits are no longer accessible by SHA.
   > The repository now has a single clean root commit `<SNAP>`.
   > Old commit SHAs to purge: see the list below (46 commits).
3. 旧 SHA 一覧は §9 の表(main 側は同一 SHA がタグと重複するので表がそのまま使える)。
   mirror バックアップ(4.2)から `git log --format=%H` で全列挙も可。

## 8. 恒久運用(再発防止の閉環)

今回のリセット後、公開側に PII が再流入する経路は次で塞がっている:

1. **tree 内容**: PMmap CI(`ci.yml`)の `npm test` に `src/repoPiiGuard.test.ts` が入って
   おり(tracked 全ファイル走査・sha256 照合)、リリース手順は「SNAP tree == origin/main
   tree」を必須ゲートにしている(`docs/DISTRIBUTION.md` §0)— つまり**テストが走った tree
   と公開される tree が同一**であることが機械保証される。
2. **公開直前の最終防衛線**: `release.yml`(タグの tree 自体を checkout してビルドする)に
   PII ガード単体実行ステップを追加済み — 万一ゲートを迂回した tree がタグに載っても、
   公開ビルドが fail する。
3. **author メタデータ**: 今後のスナップショット commit は noreply author で作る —
   `docs/DISTRIBUTION.md` §0 のコマンド(env 付き `commit-tree`)と release skill
   (`~/.claude/skills/release/SKILL.md`)手順 3 を更新済み/更新すること(§8.1)。
4. **(推奨・ユーザー)** GitHub Settings → Emails →
   *Keep my email addresses private* + *Block command line pushes that expose my email*
   を有効化 — 実メール author の push を GitHub 側でも機械拒否させる。

### 8.1 [司令官] release skill への反映(リセット実行とは独立に適用可)

`~/.claude/skills/release/SKILL.md` 手順 3 の `SNAP=$(git commit-tree …)` を
`docs/DISTRIBUTION.md` §0.5 の noreply env 付き形へ差し替える(正典は DISTRIBUTION.md —
skill は要約なので同じコマンドにする)。次リリース時は付け替え後の `openground/main`
(= 新 root)を親に取るため、**必ず `git fetch openground` してから** `-p openground/main`
を評価する(古い ref を親にすると旧履歴が復活する)。

## 9. 旧 SHA 対応表(ロールバック §5・purge 依頼 §7 の材料)

`main` = `3eec60a313836b4d58a584b7e1fae0117ec51172`(v0.11.28 と同一)。

| タグ | 旧 SHA |
| --- | --- |
| v0.1.0 | `f54b7684014d8e7198f310dfb54db94ea37fee2a` |
| v0.2.0 | `6af2961e9a6bbb07807a9f27ffecacae38568b7b` |
| v0.3.0 | `5a52671608230a0f9da37574917070d7b8682709` |
| v0.3.1 | `ea851887b3ca7e06e45761ae23973af226d0b0ec` |
| v0.4.0 | `2b3210bcb3975411a9c719cda7f7f4a3446cadbb` |
| v0.4.1 | `3dbcf65b56c459134bd85461e6fbd08ab3946039` |
| v0.5.0 | `3bd0ca51bf716d2525186ef8392d2421e159a280` |
| v0.5.1 | `e853c986dd051fa6a3e05744807fa2e4e3027a7e` |
| v0.6.0 | `558b45751a6bd5af6479d3b8bb913e45508de0c7` |
| v0.7.0 | `ceb83e672a0216a9675cfc03736b2a9d98bfd7e5` |
| v0.8.0 | `c2722267f8b1e964591ba40c1b3811050b133aab` |
| v0.8.1 | `0ce498693a86a121624a9827d89b8b0bd35e2a01` |
| v0.8.2 | `17b42712348d1270cf3cac3b2d49bc2f58d7610d` |
| v0.9.0 | `735918d3d612c77ea1759f11ae99b1483ce8c071` |
| v0.9.1 | `dac75cf37f3c97e550c2a6160d1f36098affb377` |
| v0.10.0 | `d4ba3fecdf6095c4adacd1b566c9a52e8b165054` |
| v0.10.1 | `d0375ed637827fb84a76e55fb52791a76a095e1c` |
| v0.11.0 | `ad77f1d95929af5856e8c8563a57c94d600bfd02` |
| v0.11.1 | `83acdb60e6706d11dbc130192db16f1e40a317af` |
| v0.11.2 | `bffd8835a5154483a6e21199e15ee953197d470a` |
| v0.11.3 | `36ac3b3a8aed3b2deb5c15c3d5ed7d2e1df3341d` |
| v0.11.4 | `ae49f2ab0e71f4eb01ab9e40c7c1c12b4cc21c4d` |
| v0.11.5 | `bed7980664a56f61c7e7ad5936932f99c8e47224` |
| v0.11.6 | `ccd2d5676dfcdc77f7e5dcdcf39c0aa60476a688` |
| v0.11.7 | `a55e149d3694a00c3ad7fd6f1fc0bbde3202d834` |
| v0.11.8 | `fde00e5321b825393642d3b62be59a8ad44388f1` |
| v0.11.9 | `aecf1a5ad53d20316c21a362e89b77b941983afd` |
| v0.11.10 | `548863ca3519df67f666f39e6e7109ea7a24e5c6` |
| v0.11.11 | `7b1faaccac5e0fd6b6dbfc37cd4afe1a1d2174bc` |
| v0.11.12 | `17b683052db88a7c237e41c29abe241ffeb4f45d` |
| v0.11.13 | `4e360812deaec593c43edc87cb446623cf9221c8` |
| v0.11.14 | `4ec40325c951abb91093ae3f8e17807c11373141` |
| v0.11.15 | `560aab9dff581a32e1432de1177f57f0a31d8f9b` |
| v0.11.16 | `76e56c4be0e6e3fb6800fc74d9b6f86548b72b09` |
| v0.11.17 | `68d27291285cd2fdcab7f655103406ce83e605aa` |
| v0.11.18 | `736472d87b44b27bc31205a6d43e306cc1245655` |
| v0.11.19 | `fa8bee6e6ea57ddd94fdf29e928fe2d6753a9d1d` |
| v0.11.20 | `77129f9db89d3c904ae90ec78076a3b4e57d0cc8` |
| v0.11.21 | `f08e6cbff0c750f9f10127f45e40016541585903` |
| v0.11.22 | `4bc342364e7e83f502f22833241e79feaeb1d2c1` |
| v0.11.23 | `2daf750490e8180cdfaeef3947e69bd716b8236c` |
| v0.11.24 | `2f2aa62c9dba155b5cbcc3af19b3ce5fdffdaeb5` |
| v0.11.25 | `4b5966aeb275ca1e079f0fe00bd6f1f7df2459cd` |
| v0.11.26 | `f2e52d207c7fa09e6ee4b2bd4e56005bf12a194e` |
| v0.11.27 | `7ee6f4bc80c1fd2fcae1d06a294033b02527ad3a` |
| v0.11.28 | `3eec60a313836b4d58a584b7e1fae0117ec51172` |
