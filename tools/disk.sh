#!/bin/sh
set -u
usage="usage: tools/disk.sh <GB that must be free> <path> | --merged"
merged() {
  main=$(git -C "$(dirname "$0")" worktree list --porcelain | sed -n 's/^worktree //p' | head -1)
  firsts=$(mktemp)
  git -C "$main" rev-list --first-parent main >"$firsts"
  idle=$(($(git -C "$main" log -1 --format=%ct main) - 86400))
  git -C "$main" worktree list --porcelain | awk '/^worktree / { wt = substr($0, 10) } /^branch refs\/heads\// { print substr($0, 19) " " wt }' |
    tail -n +2 | while read -r branch wt; do
      [ "$branch" != wp-main-run ] || continue
      tip=$(git -C "$main" rev-parse -q --verify "refs/heads/$branch") || continue
      git -C "$main" merge-base --is-ancestor "$tip" main || continue
      ! grep -qx "$tip" "$firsts" || [ "$(git -C "$main" log -1 --format=%ct "$tip")" -lt "$idle" ] || continue
      [ -z "$(git -C "$wt" status --porcelain 2>/dev/null)" ] || continue
      case $wt in "$HOME"/Projects/lifestream-wt/*) name=${wt##*/} ;; *) name=$wt ;; esac
      echo "  merged and clean: tools/worktree.sh --remove $name"
    done
  rm -f "$firsts"
}
if [ "${1:-}" = --merged ]; then
  merged
  exit 0
fi
floor=${1:?$usage}
at=${2:?$usage}
free=$(df -Pk "$at" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')
[ -n "$free" ] && [ "$free" -lt "$floor" ] || exit 0
echo "disk: refused: $free GB free on the disk of $at, and this needs $floor: free space first (a run that fills it dies without a word, with whatever else is running)" >&2
merged >&2
exit 1
