#!/usr/bin/env bash
# Every action a workflow uses is pinned to a full commit SHA with its
# version in a comment, and every container image to a digest. A tag can be
# moved to other code after review; a SHA or digest cannot. Local actions
# fail too: their code comes from the branch under test, unpinned.
#
# Usage: scripts/check-pins.sh [DIR]   (default .github)
set -euo pipefail

dir="${1:-.github}"
[ -d "$dir" ] || { echo "check-pins: $dir is not a directory" >&2; exit 1; }

# Read the file list first, so a failure to list is a failure, not an empty
# list that passes.
files=$(find "$dir" -type f \( -name '*.yml' -o -name '*.yaml' \))
[ -n "$files" ] || { echo "check-pins: no workflow files under $dir" >&2; exit 1; }

fail=0
uses=0
while IFS= read -r file; do
  # grep exits 1 when a file has no matches, which is fine; anything else
  # stops the check.
  hits=$(grep -nE '^[[:space:]-]*(uses|image):' "$file") || [ $? -eq 1 ]
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    line=${hit%%:*}
    text=${hit#*:}
    case "$text" in
      *uses:*)
        uses=$((uses + 1))
        if ! [[ $text =~ uses:[[:space:]]+[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*v[0-9][^[:space:]]*[[:space:]]*$ ]]; then
          echo "check-pins: $file:$line: action not pinned to a full SHA with a version comment:$text" >&2
          fail=1
        fi
        ;;
      *image:*)
        if ! [[ $text =~ image:[[:space:]]+[^[:space:]]+:[^[:space:]@]+@sha256:[0-9a-f]{64}[[:space:]]*$ ]]; then
          echo "check-pins: $file:$line: image not pinned to a tag and digest:$text" >&2
          fail=1
        fi
        ;;
    esac
  done <<<"$hits"
done <<<"$files"

if [ "$uses" -eq 0 ]; then
  echo "check-pins: found no uses: lines at all; is the pattern still right?" >&2
  fail=1
fi
if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-pins: ok ($uses actions)"
