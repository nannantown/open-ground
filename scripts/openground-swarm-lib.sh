#!/usr/bin/env bash
# managed-by: openground — OPEN GROUND がアプリ起動時に ~/.claude/openground-swarm-lib.sh
# へ自動配備する。手編集は上書きされる。正典は OPEN GROUND repo の
# scripts/openground-swarm-lib.sh。
#
# openground-swarm-lib.sh — shared helper for scripts/swarm-beat.sh: SOURCE this, don't exec.
#     . ~/.claude/openground-swarm-lib.sh
#
# ⚠ ファイル名は意図的に `swarm-lib.sh` ではない。ユーザの ~/.claude には tmux コックピット
# 時代の**手書き** swarm-lib.sh(pane 解決・送信ヘルパー 12 関数)が残っていることがあり、
# ~/.claude 配下の多数のスクリプトがそれを source している。同名で配備すると(kept-user が
# 効かなくなった瞬間に)その 10 関数が消えて `sw_session: command not found` 系で静かに壊れる。
# → 配備先を衝突しない名前に分けるのが恒久解(swarmToolingInstall.ts の SWARM_LIB_BASENAME)。
# in-app swarm(OG アプリ内蔵)は tmux に依存しない([[feedback_openground_self_contained_no_tmux]])
# ので、ここでは swarm-beat.sh が実際に使う最小限(リポジトリ鍵→心拍ディレクトリ)だけを持つ。
#
# Every function tolerates `set -u`. This file does NOT set it itself (a sourced
# file must not change the CALLER's shell options out from under it) — the caller
# (swarm-beat.sh) already does before sourcing this.

# Per-repo key = basename(parent)+sha1(.git common dir)[:8]. worktree ごとに違う
# パスでも同じ元 repo なら同じ鍵になる(git-common-dir が worktree 間で共通のため)。
sw_repokey() {
  local cdir abs h
  cdir=$(git -C "${1:-$PWD}" rev-parse --git-common-dir 2>/dev/null) || return 1
  abs=$(cd "${1:-$PWD}" 2>/dev/null && cd "$cdir" 2>/dev/null && pwd -P) || return 1
  h=$(printf '%s' "$abs" | shasum 2>/dev/null | cut -c1-8); [ -n "$h" ] || return 1
  printf '%s-%s' "$(basename "$(dirname "$abs")" | tr ' /' '__')" "$h"
}

# Heartbeat dir for a repo: ~/.openground/swarm/<key>.
sw_hbdir() { local k; k=$(sw_repokey "${1:-$PWD}") || return 1; printf '%s/.openground/swarm/%s' "$HOME" "$k"; }
