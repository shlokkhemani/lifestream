#!/bin/sh
set -u
floor=${1:?usage: tools/disk.sh <GB that must be free> <path>}
at=${2:?usage: tools/disk.sh <GB that must be free> <path>}
free=$(df -Pk "$at" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')
[ -n "$free" ] && [ "$free" -lt "$floor" ] || exit 0
echo "disk: refused: $free GB free on the disk of $at, and this needs $floor: free space first (a run that fills it dies without a word, with whatever else is running)" >&2
main=$(git -C "$(dirname "$0")" worktree list --porcelain | sed -n 's/^worktree //p' | head -1)
firsts=$(mktemp)
trap 'rm -f "$firsts"' EXIT
git -C "$main" rev-list --first-parent main >"$firsts"
for wt in "$HOME"/Projects/lifestream-wt/*/; do
  wt=${wt%/}
  lane=${wt##*/}
  tip=$(git -C "$main" rev-parse -q --verify "refs/heads/wp-$lane") || continue
  git -C "$main" merge-base --is-ancestor "$tip" main || continue
  ! grep -qx "$tip" "$firsts" || continue
  [ -z "$(git -C "$wt" status --porcelain)" ] || continue
  echo "  merged and clean: tools/worktree.sh --remove $lane" >&2
done
exit 1
