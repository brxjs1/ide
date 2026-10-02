#!/usr/bin/env bash
# Worktrees isolados para tarefas autônomas.
#   new  <slug> [base]  cria ../<repo>.worktrees/<slug> no branch task/<slug>
#   list                lista worktrees de tarefa
#   diff <slug>         diff da tarefa contra o ponto de partida
#   log  <slug>         commits da tarefa
#   rm   <slug>         remove o worktree (mantém o branch)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
base_dir="$(dirname "$root")/$(basename "$root").worktrees"

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

require_slug() {
  [[ -n "${1:-}" ]] || usage
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "slug inválido: use [a-z0-9-]" >&2; exit 1; }
}

cmd="${1:-}"; shift || true
case "$cmd" in
  new)
    require_slug "${1:-}"
    slug="$1"; base="${2:-HEAD}"
    path="$base_dir/$slug"
    mkdir -p "$base_dir"
    git -C "$root" worktree add -b "task/$slug" "$path" "$base" >&2
    echo "$path"
    ;;
  list)
    git -C "$root" worktree list | grep -F "$base_dir/" || echo "nenhum worktree de tarefa"
    ;;
  diff)
    require_slug "${1:-}"
    git -C "$root" diff "$(git -C "$root" merge-base HEAD "task/$1")...task/$1"
    ;;
  log)
    require_slug "${1:-}"
    git -C "$root" log --oneline "$(git -C "$root" merge-base HEAD "task/$1")..task/$1"
    ;;
  rm)
    require_slug "${1:-}"
    git -C "$root" worktree remove "$base_dir/$1"
    echo "worktree removido; branch task/$1 mantido (git branch -d task/$1 para apagar)"
    ;;
  *) usage ;;
esac
