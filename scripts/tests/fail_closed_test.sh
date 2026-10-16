#!/usr/bin/env bash
# Tests for scripts/check-fail-closed.sh on fixture directories (no git).
# Each fixture is a root with scripts/, .github/ and an allowlist, and the
# check runs from that root the way a repository's gate runs it.
#
# Usage: scripts/tests/fail_closed_test.sh
set -euo pipefail

check="$(cd "$(dirname "$0")/.." && pwd -P)/check-fail-closed.sh"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'chmod -R u+rwx "$work" 2>/dev/null; rm -rf -- "${work:?}"' EXIT

failures=0
cases=0
n=0

# Built from pieces so this file does not trip the check it tests.
or="|""|"
coe="continue-on-erro""r"
plus_e="set +""e"
plus_o="set +""o errexit"

header='# Lines allowed to swallow a failure.'

# fixture [SCRIPT_LINE]: a clean root, with SCRIPT_LINE as line 2 of
# scripts/run.sh when given.
fixture() {
  n=$((n + 1))
  dir="$work/case$n"
  mkdir -p "$dir/scripts" "$dir/.github/workflows"
  printf '#!/usr/bin/env bash\n%s\n' "${1:-make test}" >"$dir/scripts/run.sh"
  printf 'jobs:\n  a:\n    steps:\n      - run: make test\n' >"$dir/.github/workflows/ci.yml"
  printf '%s\n' "$header" >"$dir/scripts/fail-closed-allowlist.txt"
}

allow() { printf '%s\n' "$@" >>"$dir/scripts/fail-closed-allowlist.txt"; }

expect() { # expect NAME pass|fail PATTERN [ARGS...]
  local name=$1 want=$2 pattern=$3 status=0 out
  shift 3
  cases=$((cases + 1))
  out=$(cd "$dir" && bash "$check" "$@" 2>&1) || status=$?
  if { [ "$want" = pass ] && [ "$status" -eq 0 ]; } ||
    { [ "$want" = fail ] && [ "$status" -ne 0 ] && grep -qF -- "$pattern" <<<"$out"; }; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $status, wanted $want)"
    printf '%s\n' "$out" | sed 's/^/     | /'
    failures=$((failures + 1))
  fi
}

fixture
expect "a clean root passes" pass ""

# Every way of turning a failure into a pass that the check knows about.
for line in "make test $or true" "make test ${or}true" "make test $or :" \
  "make test $or echo failed" "make test $or exit 0" \
  "make test $or return 0" "$plus_e" "$plus_o" "bash -c \"make test $or true\""; do
  fixture "$line"
  expect "fails: $line" fail "scripts/run.sh:2:"
done

fixture
printf '      %s: true\n' "$coe" >>"$dir/.github/workflows/ci.yml"
expect "a job allowed to fail fails" fail ".github/workflows/ci.yml:5:"

# Saying which status is accepted is the fix, so these pass. or-printf is
# not checked: it is how scripts print conditionally, and listing every
# such line would bury the allowlist.
for line in "make test $or exit 1" "grep -q x f $or [ \$? -eq 1 ]" "make test $or status=\$?" \
  "make test $or { echo failed >&2; exit 1; }" "make test $or true_check" "set -e" \
  "[ -z \"\$x\" ] $or printf 'x'"; do
  fixture "$line"
  expect "passes: $line" pass ""
done

fixture "make test $or true"
allow "# Why this one is fine." "scripts/run.sh:make test $or true"
expect "an exact allowlist entry passes" pass ""

fixture "make test $or true"
allow "# Two lines, one reason." "scripts/run.sh:make test $or true" "scripts/run.sh:make lint $or true"
printf 'make lint %s true\n' "$or" >>"$dir/scripts/run.sh"
expect "consecutive entries share the comment above them" pass ""

fixture "make test  $or true"
allow "# Why." "scripts/run.sh:make test $or true"
expect "an entry must match the whole line exactly" fail "scripts/run.sh:2:"

fixture "make test $or true"
printf '#!/usr/bin/env bash\nmake test %s true\n' "$or" >"$dir/scripts/other.sh"
allow "# Why." "scripts/run.sh:make test $or true"
expect "an entry covers only its own file" fail "scripts/other.sh:2:"

fixture
allow "# Was needed once." "scripts/run.sh:make test $or true"
expect "an entry that matches nothing fails" fail "matches nothing"

fixture "make test $or true"
allow "" "scripts/run.sh:make test $or true"
expect "an entry with no comment above it fails" fail "no comment above it"

fixture
rm "$dir/scripts/fail-closed-allowlist.txt"
expect "a missing allowlist fails" fail "cannot read the allowlist"

fixture
rm "$dir/scripts/fail-closed-allowlist.txt"
FAIL_CLOSED_ALLOWLIST="" expect "an empty FAIL_CLOSED_ALLOWLIST means no allowlist" pass ""

fixture
expect "a path that does not exist fails" fail "missing does not exist" scripts missing

fixture
mkdir -p "$dir/.githooks"
printf '#!/bin/sh\nmake test %s true\n' "$or" >"$dir/.githooks/pre-push"
expect "given paths are scanned instead of the default" fail ".githooks/pre-push:2:" .githooks

fixture
mkdir -p "$dir/scripts/sub"
printf 'make test %s true\n' "$or" >"$dir/scripts/sub/fail-closed-allowlist.txt"
expect "only the allowlist itself is skipped, not its name elsewhere" fail "scripts/sub/fail-closed-allowlist.txt:1:"

# grep exit 2 (a bad pattern, an unreadable file) must fail the check, not
# read as "nothing found".
fixture
real_grep=$(command -v grep)
mkdir -p "$work/stub"
# The dollar signs belong to the stub, not to this shell.
# shellcheck disable=SC2016
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = -rnE ] && { echo "grep: simulated failure" >&2; exit 2; }; done\nexec "%s" "$@"\n' \
  "$real_grep" >"$work/stub/grep"
chmod +x "$work/stub/grep"
PATH="$work/stub:$PATH" expect "a grep error fails" fail "grep failed"

fixture
printf 'make test\n' >"$dir/scripts/locked.sh"
chmod 000 "$dir/scripts/locked.sh"
if [ -r "$dir/scripts/locked.sh" ]; then
  # Root reads any file, so there is no unreadable file to test with. The
  # grep error case above covers the same branch.
  echo "ok   an unreadable file fails (not run: this user can read mode 000 files)"
else
  expect "an unreadable file fails" fail "grep failed"
fi
chmod 600 "$dir/scripts/locked.sh"

if [ "$failures" -ne 0 ]; then
  echo "fail-closed tests: $failures of $cases failed" >&2
  exit 1
fi
echo "fail-closed tests: all $cases passed"
