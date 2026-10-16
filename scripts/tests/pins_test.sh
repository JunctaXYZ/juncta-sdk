#!/usr/bin/env bash
# Tests for scripts/check-pins.sh. Each case writes one workflow into a
# fixture directory and checks the exit status and the reason printed.
#
# Usage: scripts/tests/pins_test.sh
set -euo pipefail

check_pins="$(cd "$(dirname "$0")/.." && pwd -P)/check-pins.sh"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "${work:?}"' EXIT

failures=0
cases=0

# check NAME WANT PATTERN DIR: WANT is pass or fail. A failure must print
# PATTERN, so a case cannot pass by failing for some other reason.
check() {
  local name=$1 want=$2 pattern=$3 dir=$4 status=0 out
  cases=$((cases + 1))
  out=$(bash "$check_pins" "$dir" 2>&1) || status=$?
  if [ "$want" = pass ] && [ "$status" -eq 0 ]; then
    echo "ok   $name"
  elif [ "$want" = fail ] && [ "$status" -ne 0 ] && [[ $out == *"$pattern"* ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $status, wanted $want)"
    printf '%s\n' "$out" | sed 's/^/     | /'
    failures=$((failures + 1))
  fi
}

sha=0123456789abcdef0123456789abcdef01234567
digest=$(printf '%064d' 0)

# workflow NAME LINE...: a fixture directory holding one workflow.
workflow() {
  local dir="$work/$1"
  shift
  mkdir -p "$dir/workflows"
  printf '%s\n' "jobs:" "  a:" "    steps:" "$@" >"$dir/workflows/w.yml"
  echo "$dir"
}

d=$(workflow pinned "      - uses: actions/checkout@$sha # v7.0.1")
check "an action pinned by SHA with a version passes" pass "" "$d"

d=$(workflow subpath "      - uses: github/codeql-action/init@$sha # v4.38.2")
check "an action in a subdirectory pinned by SHA passes" pass "" "$d"

d=$(workflow tag "      - uses: actions/checkout@v7")
check "an action pinned by tag fails" fail "not pinned to a full SHA" "$d"

d=$(workflow branch "      - uses: actions/checkout@main # v7.0.1")
check "an action pinned to a branch fails" fail "not pinned to a full SHA" "$d"

d=$(workflow short "      - uses: actions/checkout@${sha:0:12} # v7.0.1")
check "a short SHA fails" fail "not pinned to a full SHA" "$d"

d=$(workflow nocomment "      - uses: actions/checkout@$sha")
check "a SHA without a version comment fails" fail "not pinned to a full SHA" "$d"

d=$(workflow local "      - uses: ./.github/actions/setup")
check "a local action fails, since its code is not pinned" fail "not pinned to a full SHA" "$d"

d=$(workflow docker "      - uses: docker://alpine:3")
check "a docker action without a digest fails" fail "not pinned to a full SHA" "$d"

d=$(workflow quoted "      - uses: 'actions/checkout@v7'")
check "a quoted tag pin fails" fail "not pinned to a full SHA" "$d"

d=$(workflow image "      - uses: actions/checkout@$sha # v7.0.1" "    container:" "      image: semgrep/semgrep:1.179.0")
check "an image without a digest fails" fail "image not pinned" "$d"

d=$(workflow digest "      - uses: actions/checkout@$sha # v7.0.1" "    container:" "      image: semgrep/semgrep:1.179.0@sha256:$digest")
check "an image with a tag and digest passes" pass "" "$d"

d=$(workflow none "      - run: echo hi")
check "a directory with no actions at all fails" fail "found no uses: lines" "$d"

mkdir -p "$work/empty"
check "a directory with no workflow files fails" fail "no workflow files" "$work/empty"

check "a missing directory fails" fail "is not a directory" "$work/missing"

d=$(workflow yaml "      - uses: actions/checkout@v7")
mv "$d/workflows/w.yml" "$d/workflows/w.yaml"
check "a .yaml file is checked too" fail "not pinned to a full SHA" "$d"

if [ "$failures" -ne 0 ]; then
  echo "pin tests: $failures of $cases failed" >&2
  exit 1
fi
echo "pin tests: all $cases passed"
