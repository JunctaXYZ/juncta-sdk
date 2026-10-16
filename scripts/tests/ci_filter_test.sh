#!/usr/bin/env bash
# Tests for the change detection in ci.yml. The real "Work out what changed"
# script is pulled out of the workflow and run in a throwaway repository
# with a base commit and a change on top, so the test follows any edit to
# the workflow. A check filtered out by mistake never runs at all, so a
# grep error must fail the step.
#
# Usage: scripts/tests/ci_filter_test.sh
#   Needs git 2.28 or later and perl.
set -euo pipefail

# Git hooks run with GIT_DIR and friends pointing at the repository being
# pushed. Clear them, then confirm none survived before touching anything.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
for name in $(git rev-parse --local-env-vars); do
  if [ -n "${!name+x}" ]; then
    echo "ci filter tests: $name is still set; refusing to touch any repository" >&2
    exit 1
  fi
done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

workflow="$(cd "$(dirname "$0")/../.." && pwd -P)/.github/workflows/ci.yml"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "${work:?}"' EXIT
export GIT_CEILING_DIRECTORIES=$work

failures=0
cases=0
case_no=0

fgit() {
  git -c user.name=fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false "$@"
}

stop() {
  echo "ci filter tests: $*; stopping" >&2
  exit 1
}

# The run block of the step with `id: changes`, de-indented.
perl -e '
  my ($in_step, $in_run, $indent) = (0, 0, undef);
  while (<STDIN>) {
    if (!$in_run) {
      $in_step = 1 if /^\s+id: changes\s*$/;
      if ($in_step && /^(\s+)run: \|\s*$/) { $in_run = 1; $indent = length($1) + 2; }
      next;
    }
    if (/^\s*$/) { print "\n"; next; }
    /^(\s*)/; last if length($1) < $indent;
    print substr($_, $indent);
  }
' <"$workflow" >"$work/filter.sh"
[ -s "$work/filter.sh" ] || stop "no changes step found in $workflow"

# A grep that exits 2 when its arguments contain GREP_FAIL_IF and runs the
# real grep otherwise, so each call in the filter can be broken on its own.
real_grep=$(command -v grep)
mkdir -p "$work/stub"
cat >"$work/stub/grep" <<STUB
#!/usr/bin/env bash
if [ -n "\${GREP_FAIL_IF:-}" ]; then
  case "\$*" in *"\$GREP_FAIL_IF"*) echo "grep: simulated failure" >&2; exit 2 ;; esac
fi
exec "$real_grep" "\$@"
STUB
chmod +x "$work/stub/grep"

new_repo() {
  case_no=$((case_no + 1))
  repo="$work/case$case_no"
  mkdir -p "$repo"
  if fgit -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    stop "$repo already resolves to $(fgit -C "$repo" rev-parse --absolute-git-dir)"
  fi
  fgit -C "$repo" init -q -b main
  local got
  got=$(fgit -C "$repo" rev-parse --absolute-git-dir)
  [ "$got" = "$repo/.git" ] || stop "fixture $repo uses git directory $got"
  for f in README.md src/index.ts .github/workflows/ci.yml .github/scripts/review-gate.mjs; do
    mkdir -p "$repo/$(dirname "$f")"
    echo base >"$repo/$f"
  done
  fgit -C "$repo" add -A
  fgit -C "$repo" commit -q -m base
  base=$(fgit -C "$repo" rev-parse HEAD)
}

change() {
  for f in "$@"; do
    mkdir -p "$repo/$(dirname "$f")"
    echo changed >>"$repo/$f"
  done
  fgit -C "$repo" add -A
  fgit -C "$repo" commit -q --allow-empty -m change
}

# run_filter [VAR=VALUE...]: runs the extracted script as a pull request
# against $base, the way Actions runs a bash step.
run_filter() {
  : >"$work/out"
  status=0
  (cd "$repo" && env GITHUB_OUTPUT="$work/out" PR_BASE_SHA="$base" PUSH_BEFORE= "$@" \
    bash --noprofile --norc -eo pipefail "$work/filter.sh") \
    >/dev/null 2>"$work/err" || status=$?
  outputs=$(cat "$work/out")
  errors=$(cat "$work/err")
}

expect() {
  local name=$1 want=$2
  cases=$((cases + 1))
  if [ "$status" -eq 0 ] && [ "$outputs" = "package=$want" ]; then
    echo "ok   $name"
  else
    printf 'FAIL %s: wanted exit 0 and package=%s, got exit %s:\n%s\n%s\n' \
      "$name" "$want" "$status" "$outputs" "$errors"
    failures=$((failures + 1))
  fi
}

expect_error() {
  cases=$((cases + 1))
  if [ "$status" -ne 0 ] && ! grep -q '^package=' <<<"$outputs"; then
    echo "ok   $1 (exit $status)"
  else
    printf 'FAIL %s: wanted a failure with no output, got exit %s:\n%s\n' "$1" "$status" "$outputs"
    failures=$((failures + 1))
  fi
}

new_repo
change src/index.ts
run_filter
expect "a source change runs the package checks" true

new_repo
change README.md
run_filter
expect "a readme change runs them, since it is packed and formatted" true

new_repo
change scripts/tests/pack_test.sh
run_filter
expect "a script change runs them" true

new_repo
change .github/workflows/ci.yml
run_filter
expect "a change to this workflow runs them" true

new_repo
change .github/scripts/review-gate.mjs .github/workflows/security.yml
run_filter
expect "shared tooling under .github alone skips them" false

new_repo
change .github/scripts/review-gate.mjs src/index.ts
run_filter
expect "shared tooling plus source runs them" true

new_repo
fgit -C "$repo" commit -q --allow-empty -m empty
run_filter
expect "a change with no files skips them" false

new_repo
fgit -C "$repo" mv src/index.ts .github/moved.ts
fgit -C "$repo" commit -q -m move
run_filter
expect "moving source into .github still runs them" true

new_repo
change .github/scripts/review-gate.mjs
run_filter PR_BASE_SHA= PUSH_BEFORE=0000000000000000000000000000000000000000
expect "a branch-creating push runs everything" true
run_filter PR_BASE_SHA=0123456789abcdef0123456789abcdef01234567
expect "a base that is not here runs everything" true

for marker in '-qEv' '-qx'; do
  new_repo
  change .github/scripts/review-gate.mjs
  run_filter PATH="$work/stub:$PATH" GREP_FAIL_IF="$marker"
  expect_error "a grep error in the $marker filter fails the step"
done

if [ "$failures" -ne 0 ]; then
  echo "ci filter tests: $failures of $cases failed" >&2
  exit 1
fi
echo "ci filter tests: all $cases passed"
