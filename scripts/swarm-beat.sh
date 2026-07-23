#!/usr/bin/env bash
# managed-by: openground — OPEN GROUND がアプリ起動時に ~/.claude/swarm-beat.sh へ自動配備する。
# 手編集は上書きされる。正典は OPEN GROUND repo の scripts/swarm-beat.sh。
# swarm-beat.sh — a goal-swarm WORKER calls this to update its heartbeat, which
# the swarm-manager reads. Run from INSIDE the worktree (it auto-detects the
# branch + path + project). Safe to call as often as you like; overwrites one file.
#
#   Usage:  bash ~/.claude/swarm-beat.sh <phase> <ready:true|false> "<task summary>" ["<blockers>"]
#   e.g.    bash ~/.claude/swarm-beat.sh implement false "Board のカード検索を削除"
#           bash ~/.claude/swarm-beat.sh done true "全テスト緑・マージ可"
set -u
# Shared swarm helpers (sw_hbdir — the per-repo heartbeat dir, single source of truth).
# Source by SCRIPT dir (not ~) so a HOME-override (the isolated test harness) finds it.
# 名前は openground- 接頭辞つき: ユーザ手書きの旧 ~/.claude/swarm-lib.sh(tmux 時代の
# コックピット用・別スクリプト群が source 中)と衝突させないため。SWARM_LIB_BASENAME
# (src/lib/server/swarmToolingInstall.ts)と必ず一致させること。
. "$(dirname "$0")/openground-swarm-lib.sh"
phase="${1:-?}"; ready="${2:-false}"; task="${3:-}"; blockers="${4:-}"
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
[ "$branch" = "?" ] && { echo "swarm-beat: not inside a git repo — run from your worktree" >&2; exit 1; }
wt=$(pwd -P)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[ "$ready" = true ] && ready=true || ready=false

# Per-repo heartbeat dir from swarm-lib (sw_hbdir, single source of truth — same key
# for every worktree of a repo, identical to swarm-new / og-worktrees / janitor).
HB_DIR=$(sw_hbdir) || { echo "swarm-beat: cannot resolve repo key" >&2; exit 1; }
mkdir -p "$HB_DIR"

# Minimal JSON string escaper: newlines/tabs → spaces, DROP other C0 control
# chars (they'd produce invalid JSON), then escape backslash + double-quote.
# UTF-8 (日本語) needs no escaping.
jstr() { printf '"%s"' "$(printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

printf '{"branch":%s,"worktree":%s,"task":%s,"phase":%s,"blockers":%s,"readyToMerge":%s,"updatedAt":%s}\n' \
  "$(jstr "$branch")" "$(jstr "$wt")" "$(jstr "$task")" "$(jstr "$phase")" "$(jstr "$blockers")" \
  "$ready" "$(jstr "$now")" > "$HB_DIR/${branch//\//-}.json"

echo "beat: $branch [$phase] ready=$ready"
