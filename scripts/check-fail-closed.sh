#!/usr/bin/env bash
# No check may swallow a failure. Scans for the usual ways a shell step or a
# workflow job turns a failure into a pass: or-true, or-colon, or-echo,
# or-exit-0, or-return-0, turning off errexit, and a job that continues
# on error. A command whose failure really is fine says which exit status
# it accepts instead, for example `|| [ $? -eq 1 ]` for grep finding
# nothing.
#
# The only exceptions are lines listed exactly, path and full text, in the
# allowlist, under a comment saying why. An entry that matches nothing fails
# the check, so the list only shrinks once a line is fixed.
#
# Usage: scripts/check-fail-closed.sh [PATH...]   (default: scripts .github)
#   Run from the repository root. FAIL_CLOSED_ALLOWLIST names the allowlist
#   (default scripts/fail-closed-allowlist.txt); set it empty for none.
set -euo pipefail

[ "$#" -gt 0 ] || set -- scripts .github
allowlist="${FAIL_CLOSED_ALLOWLIST-scripts/fail-closed-allowlist.txt}"

# Written so that this file does not match its own patterns.
pattern='\|\|[[:space:]]*(true|:|exit[[:space:]]+0|return[[:space:]]+0|ech[o])([^[:alnum:]_-]|$)'
pattern="$pattern"'|continue-on-erro[r]|set[[:space:]]+[+]e|set[[:space:]]+[+]o[[:space:]]+errexit'

for path in "$@"; do
  [ -e "$path" ] || { echo "check-fail-closed: $path does not exist" >&2; exit 1; }
done

# Entries are `path:line text`. Blank lines and comments are skipped. Each
# group of entries needs a comment directly above it saying why.
entries=()
if [ -n "$allowlist" ]; then
  [ -r "$allowlist" ] || { echo "check-fail-closed: cannot read the allowlist $allowlist" >&2; exit 1; }
  prev=blank
  lineno=0
  while IFS= read -r entry || [ -n "$entry" ]; do
    lineno=$((lineno + 1))
    case "$entry" in
      '') prev=blank ;;
      '#'*) prev=comment ;;
      *)
        if [ "$prev" = blank ]; then
          echo "check-fail-closed: $allowlist:$lineno has no comment above it saying why" >&2
          exit 1
        fi
        entries+=("$entry")
        prev=entry
        ;;
    esac
  done <"$allowlist"
fi

# grep exits 1 when nothing matches, which is the passing case. Anything
# else (a bad pattern, an unreadable file) fails rather than reading as
# "nothing found".
status=0
hits=$(grep -rnE --binary-files=without-match "$pattern" "$@") || status=$?
case "$status" in
  0 | 1) ;;
  *) echo "check-fail-closed: grep failed (exit $status)" >&2; exit 1 ;;
esac

fail=0
used=()
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  # path:line:text becomes path:text, the allowlist's form.
  path=${hit%%:*}
  rest=${hit#*:}
  text=${rest#*:}
  # The allowlist quotes the lines it lists, so it is not itself a hit.
  [ "$path" != "$allowlist" ] || continue
  listed=false
  for i in "${!entries[@]}"; do
    if [ "${entries[$i]}" = "$path:$text" ]; then
      listed=true
      used[i]=1
    fi
  done
  if ! $listed; then
    if [ "$fail" -eq 0 ]; then
      echo "check-fail-closed: a failure is swallowed here; accept the exact exit status instead:" >&2
    fi
    printf '%s\n' "$hit" >&2
    fail=1
  fi
done <<<"$hits"

for i in "${!entries[@]}"; do
  if [ -z "${used[i]:-}" ]; then
    echo "check-fail-closed: allowlist entry matches nothing; remove it: ${entries[$i]}" >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1
echo "check-fail-closed: ok (${#entries[@]} listed exceptions)"
