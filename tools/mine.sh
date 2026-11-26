#!/bin/sh
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
usage="usage: tools/mine.sh sync"
case ${1:-} in
  sync) ;;
  -h | --help) echo "$usage"; exit 0 ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
mine=$HOME/Projects/lifestream-wt/mine
if [ ! -e "$mine/.git" ]; then
  echo "mine.sh: no worktree at $mine; nothing to sync"
  exit 0
fi
branch=$(git -C "$mine" rev-parse --abbrev-ref HEAD)
if [ "$branch" != wp-mine ]; then
  echo "mine.sh: $mine is on $branch, not wp-mine; main was not merged into it" >&2
  exit 1
fi
if said=$(git -C "$mine" merge --no-edit main 2>&1); then
  echo "mine.sh: $mine holds main: $(git -C "$mine" log -1 --format='%h %s')"
  exit 0
fi
if git -C "$mine" rev-parse -q --verify MERGE_HEAD >/dev/null; then
  conflicts=$(git -C "$mine" diff --name-only --diff-filter=U)
  git -C "$mine" merge --abort
  echo "mine.sh: main conflicts with wp-mine in $mine; the merge was aborted. Conflicting files:" >&2
  echo "$conflicts" | sed 's/^/  /' >&2
else
  echo "mine.sh: git would not merge main into $mine:" >&2
  echo "$said" | sed 's/^/  /' >&2
fi
exit 1
