# Board doneカードのreview巻き戻り — 調査報告 (2026-07-08)

## 症状

カード `74ec0b` が2026-07-08中に複数回 (09:46 / 10:20 / 11:12) `review`/`done` から
巻き戻った。ユーザーのBoard操作 (09:52 前後の `blocked→todo` 等) と時間的に相関して
いるように見えた。

## 除外済みの原因（本調査開始時点で既に確認済み）

1. git-shared モードではない
2. リアルタイム collab (Yjs) は稼働していない
3. in-app swarm engine (`src/lib/server/swarmOrchestrator.ts`) は停止中
4. サーバのAPI経由の書込 (`POST /api/project/tasks` の `setColumn` 等) はフルUUID
   を使い、書込直後の読み戻しでも正しい値を確認済み

## 調査して分かったこと

### クライアント（React SPA）側は「疑いなし」と確認できた

- `PUT /api/project` (`src/components/canvas/ProjectPanel.tsx:753` の `persist()`) は
  常にBoard全体 (`ProjectData`丸ごと) を送信する設計だが、サーバ側 CAS
  (`src/lib/server/projectData.ts` `writeCasGuarded` / `writeProjectData`) が
  `updatedAt` トークンの不一致を確実に 409 で弾く。これは
  `server/routes/__tests__/dualWriter.test.ts` で既にテスト済みで、追加検証でも
  再現しなかった。
- `reconcileExternalData` (`src/lib/projectDataReconcile.ts`) の `skip-local-edit`
  はローカル編集中に外部変更の取り込みを一時停止するが、CASが「古いトークンでの
  上書き」を確実に拒否するため、これ単体では巻き戻りを起こせない。

### 実際の書込元 — `swarm-board.sh` の「app DOWN」直接ファイル書込 fallback

`~/.claude/swarm-board.sh`（このリポジトリの外、ユーザーのグローバルswarmツール。
git管理外）の `move` / `rework` コマンドは、アプリの `/api/health` が応答しない
（tsx watch のdev-server再起動中など）場合に、Node サーバの CAS を完全にバイパス
して `~/.openground/projects/<uuid>/tasks.json` を**直接** read-modify-write する
fallback を持つ（コメントで明示的に設計されている挙動）:

```bash
# swarm-board.sh:69-83 (修正前)
_central_write_jq() {
  local f tmp prog; f=$(_central_file) || return 1
  [ -f "$f" ] || return 1
  prog="$1"; shift
  tmp="$f.tmp.$$"
  if jq "$@" "$prog | .updatedAt = (now | todateiso8601)" "$f" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$f"
  else
    rm -f "$tmp"; return 1
  fi
}
```

これは **read → jq計算 → mv** の間、他の書込者と一切協調しない：

- Node サーバの `withBoardLock` はプロセス内メモリのロックであり、外部プロセスの
  直接ファイル書込には何の保護も及ばない。
- この関数自体は `updatedAt` を無条件に「今の時刻」で書き換えるだけで、書込直前に
  ファイルが変わっていないかの確認（CAS）を一切していない。
- しかも `swarm-board.sh` の複数の呼び出し（複数worker・複数paneから並行実行され得
  る）同士でも排他制御がない。

### 再現したレース

このリポジトリは自分自身を開発する自己ホスティング環境で、`npm run dev:server` は
`tsx watch` で動いており、サーバファイルの保存のたびに**数秒間アプリが落ちる**
（`/api/health` が応答しない）。この間に:

1. あるworkerが `swarm-board.sh rework <id>` / `move <id> review` を実行し、
   `_up` が false と判定 → 直接ファイル書込 fallback に入る（read開始）。
2. その直後にdevサーバが復帰し、**別の書込**（別workerの `move <id> done` が
   HTTP API経由で、あるいはユーザーのUI操作のPUTが正しくCASを通って）先に着地する。
3. 手順1のシェルの `mv` が**後から**着地し、CAS抜きで手順2の結果を丸ごと上書きする
   （`updatedAt` は「今の時刻」で新しく見えるため、サーバ側の次回CASも普通に通って
   しまう＝サイレントな巻き戻り）。

`docs`配下には置けないため `scratchpad` に切り出した最小再現スクリプトで実証済み
（同一ロジックを抽出し、遅い書込者と速い書込者を並行実行）:

```
=== 修正前ロジック ===
final boardColumn: review   ← "done" への書込みが消え、review に巻き戻る（症状と一致）

=== 修正後ロジック（mutex + 書込直前CAS再チェック）===
final boardColumn: done     ← 10/10 回とも正しく収束
```

## 修正案（`~/.claude/swarm-board.sh` — このリポジトリの外、ガード保護下のため
本workerは直接編集不可）

`_central_write_jq` に (a) 全direct-writer間のmutex (mkdir方式・stale lock自動奪還)、
(b) mv直前の楽観的CAS再チェック（読んだ時と書く直前で `updatedAt` が変わっていたら
再読込して再計算）を追加する。パッチ全文:

```bash
# ── WRITE (app DOWN): atomic read-modify-write of central tasks.json ──────────
# $1 = jq program over the whole doc; $2.. = extra jq args (e.g. --arg id X).
# Bumps updatedAt so the app sees a fresh CAS token on its next read.
#
# CAS + mutex (bug 0708: doneカードのreview巻き戻り再発): この関数が触るのは
# Node サーバも書くのと同じ central tasks.json だが、サーバのロック
# (withBoardLock, src/lib/server/projectData.ts) はin-process onlyで、この
# fallbackのような外部プロセスの直接書込には無力。以下の2レースが実際に起きて
# いた:
#   1. 複数の swarm-board.sh 呼び出し（別worker/別pane）が同時に「app down」と
#      判定して並行 read→compute→mv すると、後勝ちが先勝ちの move を丸ごと消す。
#   2. read〜mv の間にアプリが復帰（tsx watch のdev再起動は日常的）し、サーバの
#      正規のCAS付き書込が先に着地 → このシェルの古いmvが後から着地して復帰後の
      # 変更をサイレントに巻き戻す。
# 修正: (a) 全direct-writerをmkdirロックで直列化 (b) mv直前に updatedAt を再確認
# し、read時と変わっていたら中断して再read+再計算（サーバ側と同じCAS規律をシェル
# 層でも適用）。
_central_write_lock() {
  local f="$1" lockdir="$1.lock" tries=0
  while [ "$tries" -lt 100 ]; do
    if mkdir "$lockdir" 2>/dev/null; then return 0; fi
    if [ -d "$lockdir" ]; then
      local age; age=$(( $(date +%s) - $(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0) ))
      if [ "$age" -gt 10 ]; then rmdir "$lockdir" 2>/dev/null; continue; fi
    fi
    tries=$((tries+1)); sleep 0.05
  done
  echo "swarm-board: central write lock busy (another writer stuck?) — giving up on $f" >&2
  return 1
}
_central_write_unlock() { rmdir "$1.lock" 2>/dev/null || true; }

_central_write_jq() {
  local f tmp prog; f=$(_central_file) \
    || { echo "swarm-board: can't resolve this repo's central tasks.json (open the project in OPEN GROUND once)" >&2; return 1; }
  [ -f "$f" ] || { echo "swarm-board: no central tasks.json yet (open the project in OPEN GROUND once)" >&2; return 1; }
  prog="$1"; shift
  _central_write_lock "$f" || return 1
  local ok=1 tries=0
  while [ "$tries" -lt 5 ]; do
    tries=$((tries+1))
    local before; before=$(jq -r '.updatedAt // ""' "$f" 2>/dev/null)
    tmp="$f.tmp.$$"
    if ! jq "$@" "$prog | .updatedAt = (now | todateiso8601)" "$f" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"; ok=1; break
    fi
    local now_stamp; now_stamp=$(jq -r '.updatedAt // ""' "$f" 2>/dev/null)
    if [ "$now_stamp" != "$before" ]; then
      rm -f "$tmp"; continue
    fi
    if mv "$tmp" "$f"; then ok=0; else rm -f "$tmp"; ok=1; fi
    break
  done
  _central_write_unlock "$f"
  if [ "$ok" -ne 0 ] && [ "$tries" -ge 5 ]; then
    echo "swarm-board: central write conflict — file kept changing concurrently, gave up after $tries tries" >&2
  fi
  return "$ok"
}
```

呼び出し側 (`move` / `rework` / `add` の app-down 分岐 / `branch` / `pr` の
app-down 分岐) は変更不要 — `_central_write_jq` の戻り値だけを見ている。

**適用手順（司令塔/オーナーが実施）**: 上記ブロックで `~/.claude/swarm-board.sh` の
既存 `_central_write_jq`（69-83行目付近）を置き換える。このファイルは
`openground-guard` の保護対象 (`~/.claude/swarm-*.sh` はガード済みセッションから
編集不可) のため、本worker（ガード配下）は直接適用できない。

## 検証

再現・修正効果は `scratchpad` の最小ロジック抽出スクリプトで実測済み（本文中の
ログ参照）。10回連続で「修正前=review に巻き戻る」「修正後=done に正しく収束」を
確認。`~/.claude/swarm-board.sh` 本体はガード対象のため、このリポジトリの
`npm test` / `tsc` の対象外（そもそもリポジトリに含まれていない）。

## 完了条件との対応

- 書込元の特定: 完了 — `swarm-board.sh` の app-down 直接ファイル書込 fallback
  (`_central_write_jq`)。CAS/mutexなしで、Nodeサーバの書込と非協調に競合する。
- 再現手順: 完了 — 上記レース手順 + `scratchpad` 実測ログ。
- 修正: パッチとして特定・実測検証済み。**適用は司令塔/オーナーの承認が必要**
  （ガード保護ファイルのため本worker権限では適用不可）。

## 追補調査 (2026-07-08 再監査): collabMirror / Y.Doc 経路は無関係と再確認

`mirrorBoardPreserving` / `setKey` / seen-set の実装を読み直し、上記の結論
（Yjs collabは無関係）を裏付ける経路レベルの根拠を追加する。

- `setKey` (`src/lib/collab/ydoc.ts:57-64`) は `jsonEqual` で現在値と一致する
  書込を無条件にno-opする設計 — `collabMirror.ts:27` のコメント通り、これは
  「ミラーのエコー/ループ防止」用であり、CASのような排他制御ではない。
  つまり万一 collab 経路が有効でも、setKey 自体が巻き戻りを起こす一次原因には
  なり得ない（同一値の再書込を防ぐだけで、異なる値同士の競合には無力＝
  `swarm-board.sh` 側のレースと同じ「非協調な後勝ち」問題を内包し得るが、
  今回の症状の実書込元ではない）。
- seen-set (`src/lib/server/collabMirrorCore.ts:100-101, 202-227`) は
  「直近1回のミラー時点のdisk snapshot」を毎回無条件に上書きする
  (`e.seen = diskIds`, L217) 設計。これは `deletable`（doc側カード削除対象）
  計算のみに使われ、フィールド値の巻き戻り（review→done等の値の逆行）には
  経路として関与しない — `mirrorBoardPreserving` (`collabMirror.ts:136-194`)
  はdisk→doc方向の一方向コピーであり、setKeyされる値は常に引数`data`
  （呼び出し時点のdisk内容）そのもの。doc側の古い値がdiskに書き戻される
  経路は本ファイル内に存在しない。
- 呼び出し起点 `writeCasGuarded` (`src/lib/server/projectData.ts`) は
  書込成功「後」にfire-and-forgetでミラーをキューするだけで、ミラー処理が
  disk書込のCAS判定自体に関与することはない。
- 結論: collabMirror/Y.Doc機構は「症状の直接原因」ではなく、`swarm-board.sh`
  の `_central_write_jq` レースという既存結論を変更する材料は見つからなかった。
  ただし setKey の「同値no-op」設計とseen-setの「毎回上書き」設計はいずれも
  “非協調な後勝ち”を防ぐ機構を持たないため、**将来collab経路が有効化された
  場合の追加リスク**として記録しておく（該当時は `mirrorBoardPreserving` の
  呼び出し順序保証・キュー直列化の要件を別途設計する必要がある）。

---

# 続報 (2026-07-09): 上の結論は誤り。真因は collab の doc→disk 経路だった

0.11.20 で同じカード `74ec0b0d` が再び 2 回 `done → review` へ巻き戻った
（01:19 finalize → 〜02:02 巻き戻り、02:04 再 finalize → 02:16〜02:29 に再巻き戻り。
いずれも setColumn は生API・フルUUID・読み戻し検証済み）。

## 前提が間違っていた — collab は稼働している

上の調査は「リアルタイム collab (Yjs) は稼働していない」を除外条件の 2 番目に
置いていた。稼働中のアプリに実測で問い合わせると、そうではなかった:

```
GET /api/collab/config                     → {"enabled":true}
GET /api/collab/project?path=<OPEN GROUND> → {"collabProjectId":"31719b6b-…","member":true,"label":"OG Team"}
```

さらに `~/.openground/projects/3de870a679fa/collab-mirror-seen.json` は
`74ec0b0d…` を含む 186 件の id を持ち、02:44 の finalize と同時刻に更新されて
いた。この sidecar は `mirrorOnce` が `pid !== null`（＝共有中）で doc への
書き込みに成功したときにしか保存されない。**サーバ側 mirror は実際に動いており、
このプロジェクトは collab 共有中だった。**

「git-shared ではない」（`.openground/openground.json` 無し）と
「collab 共有中」は別物で、前者の確認が後者の除外に流用されていた。

## 真因 — doc が disk より古い間に doc→disk が無条件で走る

owner にとって disk（中央 `tasks.json`）が権威で、doc はその射影である。
両者を結ぶ経路は 2 本:

- **disk → doc**: `projectData.ts` の全書き込みが `queueBoardMirror` を fire-and-forget
  で呼ぶ（`collabMirror.ts`）。失敗時は 5s/30s/120s とバックオフして無限リトライ。
- **doc → disk**: `BoardModule.tsx` の `collab.onRemote(() => persistLocal(collab.extract(…)))`。
  `boardDocToProjectData` は **タスク一覧を doc から丸ごと** 取る
  (`readCollectionFlat`)。この persist は `dataRef.current.updatedAt`、すなわち
  **新鮮な CAS トークン**を積むので、store の compare-and-swap では止まらない。

doc が disk より古くなる窓は現実に存在する:

1. mirror が失敗してリトライ中（バックオフの間ずっと）。
2. `swarm-board.sh` の app-down 直接ファイル書込（上の 0708 調査で特定した経路）は
   サーバを通らないので **mirror が一度も走らない** → doc は永久に古い。
3. クライアントの楽観 seed: `persistLocal` は PUT の成否に関わらず `seed(next)` する。
   409 で拒否された draft も doc に入る。

その窓の中で **カードと無関係な remote update が 1 つ届くだけ**で、クライアントは
doc の古いタスク一覧を disk に書き戻す。引き金は単一クライアントでも起きる:
`ProjectCanvas` が board scope の **2 本目の binding**（別 Y.Doc・同じ room）を張り、
`writeBoardCanvasIndex` を publish するので、**ユーザーが Canvas タブを開くだけ**で
BoardModule の doc から見れば remote update になる。

これで観測事実がすべて説明できる: engine の log に `promoted to review` が無い、
`reviews[]` から消えた後でも 2 回目が起きる、外部操作をしていないのに戻る、
巻き戻りのタイミングが不規則。**書き手は engine でも swarm-board.sh でもなく、
自分のブラウザだった。**

## 現行犯 — room と tasks.json を同時監視して捕まえた (03:54〜03:58 UTC)

推論を止めて、`scripts/dump-board-room.mjs` / `scripts/watch-board-room.mjs`（読み取り専用の
診断プローブ）で room を、`fs.watch` で中央 `tasks.json` を同時に観測した。

```
03:54:05  tasks.json  done            (司令官が setColumn で再finalize)
03:54:07  mirror 成功 (collab-mirror-seen.json 更新)
03:55:35  room を読む  → boardColumn = "review"   ← disk は done なのに doc は review
03:56:20  tasks.json  done → review               ← 巻き戻り(現行犯)
03:56:42  tasks.json  review (updatedAt だけ更新)  ← クライアントの persist ループ
03:56:45  tasks.json  review (同上)
03:58:31  setColumn done を1回叩く → disk done
03:58:33  room が review → done へ (author = mirror の clientID 2616927931)
03:58:33〜04:01:35  room=done の間、巻き戻りゼロ
04:02:46  全クライアント切断後に再接続 → room は再び "review"
          (author が新しい clientID 3490019879 / 4248540463 = 新規の書き込み)
```

読み取れること:

- **room の値がそのまま disk に書き戻される**（03:56:20）。room を done に直すと巻き戻りは止まる
  （03:58:33〜04:01:35）。因果は疑いようがない。
- **mirror は正常**（03:58:33 に room を直した）。Durable Object の永続化取りこぼしでもない。
- それでも room は `review` に戻る。04:02:46 の author は**新しい clientID** ＝ 誰かが
  書き直している。接続していたのはアプリだけ。

## 毒を入れているのはアプリの「楽観 seed」

`BoardModule.persistLocal` は `persist(next)` の直後に、**PUT の結果を待たずに**
`collab.seed(next)` を実行する。`persist` は 350ms デバウンス後に PUT し、
`updatedAt` が古ければサーバは **409 で拒否**して、クライアントは fresh を adopt する。
——だが `seed(next)` はもう終わっている。**store が拒否したスナップショットが、
権威である doc には焼き付いている。**

これで一周する:

1. mirror が doc を `done` にする
2. アプリが古いスナップショット（`review`）を楽観 seed → doc は `review`
3. その PUT は 409 → アプリは fresh(`done`) を adopt（＝ CAS トークンは最新になる）
4. 次の remote update が来ると `onRemote → extract(doc)` が `review` を返し、
   **新鮮な CAS トークン**を積んで PUT → **disk が review に落ちる**
5. 司令官が done に直す → 1 に戻る

engine も `swarm-board.sh` も無関係。CAS は「トークンが古い書き込み」しか防げず、
この書き込みのトークンは常に最新なのですり抜ける。司令官の容疑 1 と容疑 3 は
**同じ一本の経路の入口と出口**だった。

## 修正 — doc に「どの disk 状態を焼いたか」を持たせ、追いつくまで採用しない

`m:diskStamp`（その doc の board 内容が導出された disk の `updatedAt`）を導入し、
**規律を 2 本**にした。

**(1) 採用ゲート（doc → disk）** — `boardDocToProjectData` は doc が base の disk 状態を
見ていなければ **`base` をそのまま（同一参照で）返す**。`BoardModule` は identity で
「採用なし」を判定して persist ごとスキップする。これは未 seed の room が空のタスク一覧で
board を消す事故（c2e4c57c）も同時に塞ぐ。

**(2) 陳腐化 seed の拒否（→ doc）** — doc が既に反映している disk 状態より
**証明可能に古い**スナップショットは、**内容ごと書き込みを拒否**する（`seedIsStale`）。
これが無いと (1) は無力だった: 楽観 seed は内容を `review` に汚染する一方、stamp は単調なので
`done` のまま残り、**ゲートは開いたまま**になる。stamp の意味は「この内容はその disk 状態から
導出された」なので、内容と stamp は必ず一緒に動かねばならない。
サーバ mirror にも同じ規律を課した（リトライが、直接ファイル書込に追い越された payload を
再適用しうるため）。

補足:

- stamp を書くのは **disk 真実を主張する 2 人だけ**: サーバ mirror (`mirrorBoardPreserving`)
  と owner の authoritative seed (`projectDataToBoardDoc`)。member（`updatedAt: ''`）は
  disk 真実を持たないので、stamp を書かず、拒否もされない（ただのピア編集）。
- **単調**（`writeBoardDiskStamp`）。拒否 (2) とセットで初めて健全になる。
- **stamp は点でなく区間**。`swarm-board.sh` は秒精度で書くので、`…T01:19:00Z` は
  「01:19:00.000〜01:19:00.999 のどこか」を意味する。ミリ秒 stamp は点。
  `docSeesDisk` は「doc の**最早**時刻が disk の**最遅**時刻に届くか」を問う
  （＝証明できるときだけ開く）。`seedIsStale` は「seed の**最遅**時刻が doc の**最早**
  時刻より前か」を問う（＝証明できるときだけ拒む）。どちらも区間が重なれば安全側に倒れる。
  辞書順比較もバイト比較も不可（`…T01:19:00Z` > `…T01:19:00.500Z` と逆転する）。
- `binding.synced` まで seed を遅らせる。未同期 doc への seed は全キーが room と
  **並行 op** になり、Y.Map の衝突解決（clientID 比較＝実質コイントス）で
  こちらの古い値が room の新しい値に勝ちうる。サーバの `openScopedDoc` は
  同じ理由で sync を待っている。採用（`onRemote`）の購読は従来どおり即時に行うので、
  `synced` が来ないまま（＝古いトランスポート）でも peer の編集は取り込める。

副作用として mirror は **書き込みごとに必ず 1 update を出す**ようになった
（stamp を書かないと gate が二度と開かない）。従来の「同一内容の再ミラーはゼロ更新」
というループ遮断が使えなくなるので、**遮断をクライアント側の正しい位置へ移した**:
`boardDocToProjectData` は doc の共有フィールドが base と一致すれば（echo）
やはり `base` を返す。比較は `jsonEqual`（構造比較）で、doc から組み直した
タスクのキー順の違いを「変更」と誤認しない。

## 検証

- 回帰テスト `src/lib/collab/__tests__/boardDocDiskStamp.test.ts`（12 本）。
  実インシデントをそのまま再現する `THE REPRO` と、上の現行犯トレースを再現する
  `THE POISON` を含む。**歯の確認済み**: ゲートの 1 行を外すと 3 本が落ち、
  `adopted` が `review` を持つ doc 由来のオブジェクトになる。陳腐化 seed の拒否を
  外すと `THE POISON` が落ちる（`expected 'review' to be 'done'`）。
- `src/lib/server/collabMirror.test.ts` に stamp の書き込み・古い payload の拒否・
  移設後のループ遮断（content キーは 1 つも変わらず、クライアントは何も採用しない）を追加。
- 診断プローブ `scripts/dump-board-room.mjs` / `scripts/watch-board-room.mjs` を同梱
  （読み取り専用。room の実値・キーごとの著者 clientID・接続ピアを出す）。
  次に「Board が勝手に戻る」類を見たら、まずこれで room と disk を突き合わせること。
- 完了ゲート: `npx tsc --noEmit` 0 error / `npm test` 243 files・3580 tests 緑 /
  変更ファイルの eslint 0。

## 0708 のパッチ案について

`_central_write_jq` の mutex + CAS 再チェックは、シェルとサーバの間の lost-update
という**別の実在する危険**への正しい対処であり、依然として適用する価値がある
（ガード保護下のため適用は司令塔/オーナー）。ただし今回観測された 2 回の巻き戻りは
setColumn が生API で行われており、その writer ではなかった。

なお `swarm-board.sh` は `now | todateiso8601` で **秒精度**の `updatedAt` を書く。
これはサーバのミリ秒 stamp と**同一秒内で数値順が実時間順と逆転**する
（実 01:19:00.85 の書込が `…00.000Z` になり、先行するサーバの `…00.800Z` より小さい）。
初版の gate は stamp を値として比べていたため、この同一秒衝突で
**ゲートが誤って開き、巻き戻りが残っていた**（統合前の敵対レビューが probe で実証）。
現在は stamp を「その stamp が指しうる instant の**区間**」として比べ、
`docSeesDisk` は doc が disk を**証明できるときだけ**開く。したがって
「mirror を通らなかった直接書込」で doc が古くなるケース（上の窓 2）も、
秒精度の書き手が居る場合を含めて巻き戻りの原因としては無効化される。
（初版のコード注釈と本節にあった「巻き戻りは不可能」「窓 2 も無効化する」という
断言は、この同一秒ケースで破れていた。訂正済み。）

## 残る既知の弱点（本修正のスコープ外・別カード候補）

- `persistLocal` は依然として **PUT の結果を待たずに** seed する。陳腐化 seed は拒否
  されるようになったので毒は入らないが、本来は「サーバが確認した disk 状態」だけを
  焼くべき。`persist` の結果（保存成功 / 409 adopt）を `BoardModule` へ配線するのが筋。
- owner の seed は `reconcileCollectionFlat`（authoritative）なので、mirror の
  preserving 設計と非対称に、doc-only の member カードを消す。既存挙動であり
  今回は触れていない。
- mirror が**恒久的に**壊れている（サインアウト・ws URL 欠落など）と、owner が
  一度保存した時点で gate が閉じたままになり、peer の編集を採用しなくなる
  （board タブを開き直せば seed が stamp を進めて再開する）。**安全側の縮退**であり、
  修正前の「自分の disk を黙って巻き戻す」より望ましい。恒久対策は
  「PUT 成功後にその `updatedAt` で doc を stamp し直す」だが、
  `persist` の結果を `BoardModule` へ配線する必要があるので別カードとする。
