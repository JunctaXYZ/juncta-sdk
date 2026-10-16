#!/usr/bin/env bash
# Runs every test that creates scratch git repositories the way a git hook
# would run it: with GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE pointing at a
# repository. Each test must still pass, and that repository must not change
# at all. A test that wrote its fixtures through inherited variables like
# these once set core.bare on a real clone.
#
# Usage: scripts/tests/git_env_test.sh
set -euo pipefail

# This script makes the decoy itself, so it clears the variables too.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
for name in $(git rev-parse --local-env-vars); do
  if [ -n "${!name+x}" ]; then
    echo "git env tests: $name is still set; refusing to run" >&2
    exit 1
  fi
done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

tests="$(cd "$(dirname "$0")" && pwd -P)"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "${work:?}"' EXIT

fgit() {
  git -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"
}

decoy="$work/decoy"
mkdir -p "$decoy"
fgit -C "$decoy" init -q -b main
echo decoy >"$decoy/file"
fgit -C "$decoy" add file
fgit -C "$decoy" commit -q -m decoy
[ "$(fgit -C "$decoy" rev-parse --absolute-git-dir)" = "$decoy/.git" ] \
  || { echo "git env tests: the decoy is not its own repository" >&2; exit 1; }

# Read-only views of the decoy: HEAD, every ref, status, the index bytes,
# the config bytes and core.bare.
fingerprint() {
  fgit -C "$decoy" rev-parse HEAD
  fgit -C "$decoy" for-each-ref --format='%(objectname) %(refname)'
  fgit -C "$decoy" status --porcelain --untracked-files=all
  fgit hash-object --no-filters "$decoy/.git/index"
  fgit hash-object --no-filters "$decoy/.git/config"
  fgit -C "$decoy" config --get core.bare
}

failures=0
for t in hygiene_test.sh security_filter_test.sh ci_filter_test.sh coverage_baseline.test.mjs; do
  case "$t" in
    *.mjs) cmd=(node --test "$tests/$t") ;;
    *) cmd=(bash "$tests/$t") ;;
  esac
  before=$(fingerprint)
  status=0
  out=$(GIT_DIR="$decoy/.git" GIT_WORK_TREE="$decoy" GIT_INDEX_FILE="$decoy/.git/index" \
    "${cmd[@]}" 2>&1) || status=$?
  after=$(fingerprint)
  if [ "$status" -eq 0 ]; then
    echo "ok   $t passes with GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE set"
  else
    printf 'FAIL %s under a hook environment: exit %d\n%s\n' "$t" "$status" "$(tail -n 5 <<<"$out")"
    failures=$((failures + 1))
  fi
  if [ "$before" = "$after" ]; then
    echo "ok   $t leaves the decoy's HEAD, refs, status, index, config and core.bare alone"
  else
    printf 'FAIL %s changed the decoy:\nbefore:\n%s\nafter:\n%s\n' "$t" "$before" "$after"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "git env tests: $failures failed" >&2
  exit 1
fi
echo "git env tests: all passed"
