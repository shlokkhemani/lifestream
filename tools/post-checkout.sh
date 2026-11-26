#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX
case ${1:-} in *[!0]* | "") exit 0 ;; esac
[ "${3:-}" = 1 ] || exit 0
root=$(git rev-parse --show-toplevel) || exit 0
main=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)
[ "$root" != "$main" ] || exit 0
"$main/tools/worktree.sh" --link "$root" >/dev/null || echo "post-checkout: not linked: $main/tools/worktree.sh --link $root links node_modules and the private pages" >&2
exit 0
