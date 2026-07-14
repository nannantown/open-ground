#!/usr/bin/env bash
#
# og-clean-reset.sh — open-ground(公開配布 repo)の main を「PII スクラブ済み tree の
# 単一 root スナップショット commit」へ付け替えるための【ローカル準備+検証】スクリプト。
#
#   bash scripts/og-clean-reset.sh [X.Y.Z]
#
# 背景(2026-07-14): 公開 repo の全リリーススナップショット(v0.8.0〜)の tree と全 commit
# author に実個人情報が焼き込まれていた。open-ground の履歴は「1 リリース = 1 スナップ
# ショット commit」の線形チェーンなので、清潔 tree の新 root commit へ main と全タグを
# 付け替える一回のリセットで、公開側の全履歴から PII を到達不能にできる。
# 正典 runbook: docs/PII_SCRUB_RUNBOOK.md(全手順・実行主体・ロールバック・GitHub キャッシュ)。
#
# ここでやること(すべてローカル・可逆・push しない):
#   1. origin/main の tree から、親なし(root)・noreply author のスナップショット commit を生成
#   2. 生成 commit を機械検証:
#        a. tree が origin/main と完全一致(別 tree の公開を防ぐ — release runbook と同じゲート)
#        b. 親なし root であること(旧履歴への参照を持たない)
#        c. author/committer が GitHub noreply であること(実名・実メールの再導入防止)
#        d. 追加防御: 実行環境の実トークン($USER / git config user.email の localpart)が
#           tree に無いこと
#   3. 実行フェーズで叩く push コマンド列(refspec ファイル)を生成・表示
#
# ここでやらないこと(意図的):
#   - push(main 付け替え・タグ付け替えは force 相当 = 非 manager セッションのユーザーが実行
#     する。swarm-guard が manager の force 系 push を機械 block するのは仕様であり回避しない)
#   - GitHub Actions の無効化/再有効化(公開 repo の設定変更 — ユーザー実行)
#
# PII ゼロの主保証はこのスクリプトの grep ではない:
#   (a) tree 一致 × origin/main での `npm test` 緑(src/repoPiiGuard.test.ts が tracked 全
#   ファイルを走査)の合成で「公開される tree に禁止パターンが無い」ことが保証される。
#   (d) は「リリース環境の実トークンだけは環境から動的に取れる」ことを利用した追加の砦 —
#   このスクリプト自体に個人情報の平文を書かないための設計(repoPiiGuard と同じ原則)。

set -euo pipefail

# bash 必須(zsh だと $VAR:r が modifier 解釈され refspec が壊れる — dry-run 実測)。
if [ -z "${BASH_VERSION:-}" ]; then
  echo "og-clean-reset: ERROR: bash で実行する(bash scripts/og-clean-reset.sh)" >&2
  exit 1
fi

die(){ echo "og-clean-reset: ERROR: $*" >&2; exit 1; }
note(){ echo "og-clean-reset: $*"; }

# --- 前提 -------------------------------------------------------------------
git rev-parse --git-dir >/dev/null 2>&1 || die "git repo の中で実行する"
git rev-parse --verify -q origin/main >/dev/null || die "origin/main が無い(先に: git fetch origin main)"
git remote get-url openground >/dev/null 2>&1 || \
  die "remote 'openground' が無い(追加: git remote add openground https://github.com/nannantown/open-ground.git)"

VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || true)}"
[ -n "$VERSION" ] || die "version を特定できない(引数で X.Y.Z を渡す)"

# GitHub の noreply アドレス(公開 commit に載せるための公開情報)。
NOREPLY_NAME="nannantown"
NOREPLY_EMAIL="48724510+nannantown@users.noreply.github.com"

# --- 1. スナップショット生成(root・noreply) --------------------------------
SNAP=$(GIT_AUTHOR_NAME="$NOREPLY_NAME" GIT_AUTHOR_EMAIL="$NOREPLY_EMAIL" \
       GIT_COMMITTER_NAME="$NOREPLY_NAME" GIT_COMMITTER_EMAIL="$NOREPLY_EMAIL" \
       git commit-tree "origin/main^{tree}" -m "OPEN GROUND $VERSION")
note "SNAP = $SNAP (OPEN GROUND $VERSION)"

# --- 2a. tree 一致 -----------------------------------------------------------
git diff --quiet "$SNAP" origin/main || die "tree mismatch: SNAP と origin/main の tree が一致しない — 公開してはいけない"
note "OK: tree == origin/main"

# --- 2b. root であること ------------------------------------------------------
if git rev-parse --verify -q "$SNAP^" >/dev/null 2>&1; then
  die "SNAP に親がある(root commit でない)"
fi
note "OK: root commit(親なし = 旧履歴への参照ゼロ)"

# --- 2c. author/committer が noreply -----------------------------------------
ids=$(git show -s --format='%an <%ae> / %cn <%ce>' "$SNAP")
n_noreply=$(git show -s --format='%ae%n%ce' "$SNAP" | grep -cxF "$NOREPLY_EMAIL" || true)
[ "$n_noreply" = 2 ] || die "author/committer が noreply でない: $ids"
note "OK: author/committer = $ids"

# --- 2d. 追加防御: 環境由来の実トークンが tree に無いこと ----------------------
local_email_user=$(git config user.email 2>/dev/null | sed 's/@.*//' || true)
for tok in "${USER:-}" "$local_email_user"; do
  [ -n "$tok" ] && [ "${#tok}" -ge 4 ] || continue
  case "$tok" in *noreply*|"$NOREPLY_NAME") continue ;; esac  # 公開ハンドルは検査対象外
  if git grep -I -i -q --fixed-strings "$tok" "$SNAP" -- . 2>/dev/null; then
    echo "--- ヒットしたファイル(先頭5件):" >&2
    git grep -I -i -l --fixed-strings "$tok" "$SNAP" -- . | head -5 >&2
    die "環境トークン '$(printf '%.1s' "$tok")***' が SNAP tree 内に存在する — 公開してはいけない"
  fi
done
note "OK: 環境トークン(\$USER / user.email localpart)は tree に無い"

# --- 3. push コマンド列の生成(実行はユーザー — runbook §4) -------------------
# タグはローカルでなく公開側のライブ一覧から取る(取りこぼし防止)。
TAGS=$(git ls-remote --tags openground | awk '{print $2}' | grep -v '\^{}$' | sed 's|refs/tags/||')
NTAGS=$(printf '%s\n' "$TAGS" | grep -c . || true)
[ "$NTAGS" -ge 1 ] || die "openground のタグを1本も取得できなかった(ネットワーク/権限を確認)"

OUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/og-clean-reset.XXXXXX")
RS="$OUT_DIR/refspecs.txt"
# ${SNAP} の braces と while read は意図的(zsh 誤実行でも壊れない形)。
{
  echo "+${SNAP}:refs/heads/main"
  printf '%s\n' "$TAGS" | while IFS= read -r t; do
    [ -n "$t" ] && echo "+${SNAP}:refs/tags/$t"
  done
} > "$RS"

CMD="$OUT_DIR/push-commands.sh"
{
  echo "#!/usr/bin/env bash"
  echo "# open-ground clean reset — 【ユーザー実行】(manager セッションでは実行しない)"
  echo "# 前提: docs/PII_SCRUB_RUNBOOK.md §4 のとおり Actions 無効化+mirror バックアップ済み。"
  echo "# --atomic: 全 ref 成功 or 全失敗(中途半端な状態を作らない)。"
  echo "set -euo pipefail"
  echo "git push --atomic openground \$(cat '$RS')"
} > "$CMD"
chmod +x "$CMD"

echo
note "生成完了(push は一切していない):"
note "  SNAP          = $SNAP"
note "  refspecs      = $RS  ($((NTAGS + 1)) refs: main + $NTAGS tags)"
note "  push コマンド = $CMD"
echo
echo "次(実行主体を厳守 — docs/PII_SCRUB_RUNBOOK.md が正典):"
echo "  [ユーザー]  Actions 無効化 → mirror バックアップ → bash $CMD → Actions 再有効化"
echo "  [司令官]   read-back 検証(runbook §6)"
