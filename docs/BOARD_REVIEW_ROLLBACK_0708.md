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
