#!/usr/bin/env bash
# Repository hygiene checks, run locally by scripts/gate.sh and in CI.
#
# Usage: scripts/hygiene.sh [BASE_REF]
#   Commit messages are checked over BASE_REF..HEAD. Without BASE_REF, or
#   with an empty one, the base is origin/development. A base that does not
#   resolve to a commit is a failure: checking only the latest commit would
#   let earlier commits on the branch through unchecked.
#
# PR title and body are checked in CI by passing them in PR_TITLE and PR_BODY.
set -euo pipefail

fail=0
report() { printf 'hygiene: %s\n' "$1" >&2; fail=1; }

# True when stdin has U+2013 or U+2014, matched by their UTF-8 bytes. perl,
# not grep -P, so it works the same on macOS and Linux.
has_dash() { LC_ALL=C perl -ne 'BEGIN{$f=1} $f=0 if /\xE2\x80[\x93\x94]/; END{exit $f}'; }

# matches ARGS...: grep -q on stdin. Exit 1 is grep finding nothing, which
# is an answer; anything else (a bad pattern, a read error) stops the check,
# because reading it as "no match" would pass whatever it was looking for.
matches() {
  local status=0
  grep -q "$@" || status=$?
  case "$status" in
    0) return 0 ;;
    1) return 1 ;;
    *) echo "hygiene: grep failed (exit $status); stopping" >&2; exit 2 ;;
  esac
}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# The tracked file list, read once. A git failure stops the check here
# instead of looking like a repository with no files.
if ! git ls-files -z >"$work/files"; then
  echo "hygiene: cannot list tracked files; run this inside the repository" >&2
  exit 1
fi
tr '\0' '\n' <"$work/files" >"$work/lines"

# 1. Internal files must never be tracked.
internal_re='(^|/)(\.internal/|\.claude/|docs/internal/)|(^|/)(implementation|IMPLEMENTATION|CLAUDE)\.md$|\.internal\.md$|(^|/)\.env($|\.)'
status=0
internal=$(grep -E -- "$internal_re" "$work/lines") || status=$?
case "$status" in
  0 | 1) ;;
  *) echo "hygiene: grep failed (exit $status) on the file list; stopping" >&2; exit 2 ;;
esac
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in *.env.example) continue ;; esac
  report "internal file is tracked: $path"
done <<<"$internal"

# 2. No en or em dashes in tracked text files. A file that cannot be read
# is a failure, not a skip: it would otherwise pass without being checked.
# Symlinks are checked by the path they hold and never followed, since the
# target can be missing or outside the repository.
while IFS= read -r -d '' path; do
  if [ -L "$path" ]; then
    target=$(readlink -- "$path")
    if printf '%s' "$target" | has_dash; then report "en or em dash in $path (symlink target)"; fi
    continue
  fi
  if [ ! -f "$path" ] || [ ! -r "$path" ]; then
    report "cannot read $path (missing, unreadable, a directory or a submodule)"
    continue
  fi
  # grep -I exits 1 for binary and empty files, which have nothing to check.
  status=0
  LC_ALL=C grep -Iq . -- "$path" 2>/dev/null || status=$?
  case "$status" in
    0) ;;
    1) continue ;;
    *) report "cannot read $path (grep exit $status)"; continue ;;
  esac
  # Prints the first line with a dash; exits 1 for none, 2 if unreadable.
  status=0
  line=$(LC_ALL=C perl -e '
    open(my $fh, "<", $ARGV[0]) or exit 2;
    while (<$fh>) { if (/\xE2\x80[\x93\x94]/) { print $.; exit 0 } }
    close($fh) or exit 2;
    exit 1' "$path") || status=$?
  case "$status" in
    0) report "en or em dash in $path:$line" ;;
    1) ;;
    *) report "cannot read $path (perl exit $status)" ;;
  esac
done <"$work/files"

# 3. Commit messages: no dashes, no co-author or generated-by trailers, and
# short lines. A squash merge copies every subject into the body as "* ",
# so a 70 character subject is the longest that still fits 72 there.
base="${1:-origin/development}"
if ! base_sha=$(git rev-parse -q --verify "$base^{commit}" 2>/dev/null); then
  report "cannot resolve base $base; fetch it or pass the base commit"
  commits=""
elif ! commits=$(git rev-list "$base_sha..HEAD"); then
  report "cannot list commits in $base..HEAD"
  commits=""
fi
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  msg=$(git log -1 --format=%B "$sha")
  if printf '%s' "$msg" | has_dash; then report "en or em dash in commit message $sha"; fi
  if matches -Ei '^co-authored-by:' <<<"$msg"; then report "co-author trailer in commit $sha"; fi
  if matches -Ei 'generated with' <<<"$msg"; then report "generated-by line in commit $sha"; fi
  # Counts characters, not bytes. Line 1 is the subject; the body follows.
  # Assigned first so a perl failure stops the check.
  problems=$(printf '%s\n' "$msg" | perl -CSD -ne '
    chomp; my $n = length;
    if ($. == 1) { print "subject is $n characters (limit 70)\n" if $n > 70 }
    elsif ($n > 72) { print "body line $. is $n characters (limit 72)\n" }')
  while IFS= read -r problem; do
    [ -n "$problem" ] || continue
    report "$problem in commit $sha"
  done <<<"$problems"
done <<<"$commits"

# 4. PR title and body, when CI provides them.
for field in PR_TITLE PR_BODY; do
  value="${!field:-}"
  [ -n "$value" ] || continue
  if printf '%s' "$value" | has_dash; then report "en or em dash in $field"; fi
  if matches -Ei 'co-authored-by:|generated with' <<<"$value"; then report "attribution line in $field"; fi
done

if [ "$fail" -ne 0 ]; then
  echo "hygiene: FAIL" >&2
  exit 1
fi
echo "hygiene: ok"
