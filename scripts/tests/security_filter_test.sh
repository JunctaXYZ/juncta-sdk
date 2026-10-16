#!/usr/bin/env bash
# Tests for the change detection in security.yml. The real "Work out what
# changed" script is pulled out of the workflow and run in a throwaway
# repository with a base commit and a change on top, so the test follows
# any edit to the workflow. A scan filtered out by mistake is a check that
# silently never happens, so a grep error must fail the step.
#
# Usage: scripts/tests/security_filter_test.sh
#   Needs git 2.28 or later and perl.
set -euo pipefail

# Git hooks run with GIT_DIR and friends pointing at the repository being
# pushed. Clear them, then confirm none survived before touching anything.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
for name in $(git rev-parse --local-env-vars); do
  if [ -n "${!name+x}" ]; then
    echo "filter tests: $name is still set; refusing to touch any repository" >&2
    exit 1
  fi
done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

workflow="$(cd "$(dirname "$0")/../.." && pwd -P)/.github/workflows/security.yml"
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
  echo "filter tests: $*; stopping" >&2
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
cat >"$work/stub/grep" <<EOF
#!/usr/bin/env bash
if [ -n "\${GREP_FAIL_IF:-}" ]; then
  case "\$*" in *"\$GREP_FAIL_IF"*) echo "grep: simulated failure" >&2; exit 2 ;; esac
fi
exec "$real_grep" "\$@"
EOF
chmod +x "$work/stub/grep"

# A fixture with one base commit holding a few ordinary files.
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
  for f in README.md src/lib.rs scripts/gate.sh; do
    mkdir -p "$repo/$(dirname "$f")"
    echo base >"$repo/$f"
  done
  fgit -C "$repo" add -A
  fgit -C "$repo" commit -q -m base
  base=$(fgit -C "$repo" rev-parse HEAD)
}

# change PATH...: writes each path and commits.
change() {
  for f in "$@"; do
    mkdir -p "$repo/$(dirname "$f")"
    echo changed >>"$repo/$f"
  done
  fgit -C "$repo" add -A
  fgit -C "$repo" commit -q --allow-empty -m change
}

# run_filter [VAR=VALUE...]: runs the extracted script as a pull request
# against $base, the way Actions runs a bash step, leaving its exit status
# in $status, its outputs in $outputs and its stderr in $errors.
run_filter() {
  : >"$work/out"
  status=0
  (cd "$repo" && env GITHUB_OUTPUT="$work/out" EVENT=pull_request PR_BASE_SHA="$base" \
    PUSH_BEFORE= "$@" bash --noprofile --norc -eo pipefail "$work/filter.sh") \
    >/dev/null 2>"$work/err" || status=$?
  outputs=$(cat "$work/out")
  errors=$(cat "$work/err")
}

# expect NAME KEY=VALUE...: the filter succeeded and every pair is in its
# outputs.
expect() {
  local name=$1 pair ok=true
  shift
  cases=$((cases + 1))
  [ "$status" -eq 0 ] || ok=false
  for pair in "$@"; do
    grep -qx -- "$pair" <<<"$outputs" || ok=false
  done
  if $ok; then
    echo "ok   $name"
  else
    printf 'FAIL %s: wanted exit 0 and %s, got exit %s:\n%s\n%s\n' "$name" "$*" "$status" "$outputs" "$errors"
    failures=$((failures + 1))
  fi
}

# expect_error NAME: the filter failed instead of reporting anything.
expect_error() {
  cases=$((cases + 1))
  if [ "$status" -ne 0 ] && ! grep -qE '^(workflows|scripts|deps|code)=' <<<"$outputs"; then
    echo "ok   $1 (exit $status)"
  else
    printf 'FAIL %s: wanted a failure with no outputs, got exit %s:\n%s\n' "$1" "$status" "$outputs"
    failures=$((failures + 1))
  fi
}

new_repo
change src/pool.rs
run_filter
expect "a code change runs semgrep only" code=true deps=false workflows=false scripts=false

new_repo
change README.md docs/diagram.png LICENSE
run_filter
expect "prose and images alone run nothing" code=false deps=false workflows=false scripts=false

new_repo
fgit -C "$repo" commit -q --allow-empty -m empty
run_filter
expect "a change with no files runs nothing" code=false deps=false workflows=false scripts=false

new_repo
change .semgrepignore
run_filter
expect "a semgrep config change runs semgrep" code=true

new_repo
change Cargo.lock
run_filter
expect "a lockfile change runs the audits" deps=true code=true

new_repo
change .github/workflows/ci.yml
run_filter
expect "a workflow change runs the workflow and script checks" workflows=true scripts=true code=true

new_repo
change scripts/gate.sh
run_filter
expect "a script change runs the script checks" scripts=true workflows=false

new_repo
fgit -C "$repo" mv src/lib.rs notes.md
fgit -C "$repo" commit -q -m move
run_filter
expect "moving code out to prose still runs semgrep" code=true

new_repo
change src/lib.rs
run_filter EVENT=schedule
expect "the weekly run checks everything" workflows=true scripts=true deps=true code=true range=
run_filter PR_BASE_SHA= PUSH_BEFORE=0000000000000000000000000000000000000000
expect "a branch-creating push checks everything" workflows=true scripts=true deps=true code=true
run_filter PR_BASE_SHA=0123456789abcdef0123456789abcdef01234567
expect "a base that is not here checks everything" workflows=true scripts=true deps=true code=true

# A grep error (exit 2: a bad pattern, a read error) must fail the step.
# Read as "no match", it would skip the scan for that pull request.
for marker in '^\.github/' '^(\.github|scripts)/' 'Cargo' 'LICENSE'; do
  new_repo
  change src/lib.rs .github/workflows/ci.yml scripts/gate.sh Cargo.lock
  run_filter PATH="$work/stub:$PATH" GREP_FAIL_IF="$marker"
  expect_error "a grep error on the filter matching $marker fails the step"
done

if [ "$failures" -ne 0 ]; then
  echo "filter tests: $failures of $cases failed" >&2
  exit 1
fi
echo "filter tests: all $cases passed"
