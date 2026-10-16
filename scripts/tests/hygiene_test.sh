#!/usr/bin/env bash
# Tests for scripts/hygiene.sh. Each case builds a throwaway git repository
# with a base commit standing in for origin/development, adds commits on top
# and runs the check there, then compares the exit status and the reason.
#
# Usage: scripts/tests/hygiene_test.sh
#   Needs git 2.28 or later and perl.
set -euo pipefail

# Git hooks run with GIT_DIR and friends pointing at the repository being
# pushed. Left in place, every git command below would act on that
# repository instead of the fixtures, so clear them first.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

# Then confirm, before any git command writes anything, that none of them
# survived. If the line above is ever lost, this stops the run instead of
# letting it write fixture commits into the real repository.
for name in $(git rev-parse --local-env-vars); do
  if [ -n "${!name+x}" ]; then
    echo "hygiene tests: $name is still set; refusing to touch any repository" >&2
    exit 1
  fi
done

# Fixtures read only their own config: no global or system hooks directory,
# template or signing setting, so every machine runs the same test.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

hygiene="$(cd "$(dirname "$0")/.." && pwd -P)/hygiene.sh"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "${work:?}"' EXIT
# Repository discovery never climbs above the work directory, so a fixture
# can only ever be its own repository.
export GIT_CEILING_DIRECTORIES=$work

failures=0
case_no=0

fgit() {
  git -c user.name=fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false "$@"
}

stop() {
  echo "hygiene tests: $*; stopping" >&2
  exit 1
}

# new_repo [--no-origin]: a fixture with one clean base commit. Unless told
# otherwise, origin/development points at it, as after a fetch.
new_repo() {
  case_no=$((case_no + 1))
  repo="$work/case$case_no"
  mkdir -p "$repo"
  # An empty directory must not belong to any repository yet. If it does,
  # init would re-initialise that one instead of creating the fixture.
  if fgit -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    stop "$repo already resolves to $(fgit -C "$repo" rev-parse --absolute-git-dir)"
  fi
  fgit -C "$repo" init -q -b main
  local got
  got=$(fgit -C "$repo" rev-parse --absolute-git-dir)
  [ "$got" = "$repo/.git" ] || stop "fixture $repo uses git directory $got"
  printf 'base\n' >"$repo/README.md"
  fgit -C "$repo" add README.md
  fgit -C "$repo" commit -q -m "Add readme"
  if [ "${1:-}" != --no-origin ]; then
    fgit -C "$repo" update-ref refs/remotes/origin/development HEAD
  fi
}

# commit MESSAGE: an empty commit with exactly this message.
commit() {
  printf '%s\n' "$1" >"$work/msg"
  fgit -C "$repo" commit -q --allow-empty --cleanup=verbatim -F "$work/msg"
}

# pad N TEXT: TEXT followed by "a" up to N characters.
pad() { perl -CSA -e 'my ($n, $t) = @ARGV; print $t, "a" x ($n - length $t)' "$1" "$2"; }

# check NAME WANT PATTERN [ARGS...]: runs hygiene.sh in the fixture with
# ARGS. WANT is pass or fail. A failure must print PATTERN, so a case cannot
# pass by failing for some other reason.
check() {
  local name=$1 want=$2 pattern=$3 status=0 out
  shift 3
  out=$(cd "$repo" && bash "$hygiene" "$@" 2>&1) || status=$?
  if [ "$want" = pass ] && [ "$status" -eq 0 ]; then
    echo "ok   $name"
  elif [ "$want" = fail ] && [ "$status" -ne 0 ] && printf '%s' "$out" | grep -Eq -- "$pattern"; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $status, wanted $want)"
    printf '%s\n' "$out" | sed 's/^/     | /'
    failures=$((failures + 1))
  fi
}

# Subject length.

new_repo
commit "$(pad 70 'Fix ')"
check "subject of 70 characters passes" pass "" origin/development

new_repo
commit "$(pad 71 'Fix ')"
check "subject of 71 characters fails" fail "subject is 71 characters" origin/development

new_repo
commit "$(pad 69 'Fix ')é"
check "subject length counts characters, not bytes" pass "" origin/development

new_repo
commit "$(pad 71 'Fix ')"
commit "Fix the next thing"
check "a long subject anywhere in the range fails" fail "subject is 71 characters" origin/development

new_repo
commit "$(pad 71 'Fix ')"
fgit -C "$repo" update-ref refs/remotes/origin/development HEAD
commit "Fix the next thing"
check "commits already on the base are not checked" pass "" origin/development

# Body width.

new_repo
commit "Fix it

$(pad 72 'Explain ')"
check "body line of 72 characters passes" pass "" origin/development

new_repo
commit "Fix it

Short line.
$(pad 73 'Explain ')"
check "body line of 73 characters fails" fail "body line 4 is 73 characters" origin/development

# Base resolution: never fall back to the latest commit.

new_repo
commit "Fix it"
check "an unresolvable base fails" fail "cannot resolve base origin/missing" origin/missing

new_repo
commit "Fix it"
check "a base that is not a commit fails" fail "cannot resolve base 0123456789abcdef" 0123456789abcdef0123456789abcdef01234567

new_repo --no-origin
commit "Fix it"
check "no base and no origin/development fails" fail "cannot resolve base origin/development"

new_repo
commit "$(pad 71 'Fix ')"
check "no base checks origin/development..HEAD" fail "subject is 71 characters"

new_repo
commit "Fix it"
check "an empty base means origin/development" pass "" ""

# The checks that were there before.

new_repo
commit "Fix it $(printf '\342\200\224') now"
check "a dash in a commit message fails" fail "en or em dash in commit message" origin/development

new_repo
# Built at run time so this file does not itself trip attribution scanners.
commit "Fix it

$(printf 'Co-%s: x <x@example.invalid>' authored-by)"
check "a co-author trailer fails" fail "co-author trailer" origin/development

new_repo
printf 'one %s two\n' "$(printf '\342\200\223')" >"$repo/notes.txt"
fgit -C "$repo" add notes.txt
commit "Add notes"
check "a dash in a tracked file fails" fail "en or em dash in notes.txt:1" origin/development

new_repo
mkdir -p "$repo/.internal"
printf 'x\n' >"$repo/.internal/plan.md"
fgit -C "$repo" add -f .internal/plan.md
commit "Add plan"
check "a tracked internal file fails" fail "internal file is tracked: .internal/plan.md" origin/development

new_repo
commit "Fix it"
PR_TITLE="Fix it $(printf '\342\200\224') now" check "a dash in the pull request title fails" fail "en or em dash in PR_TITLE" origin/development

# Fail closed: a check that cannot run is a failure, never a pass.

# Stand-ins on PATH. The git one fails `ls-files` and passes everything
# else to the real git. The grep one exits 2 when its arguments contain
# GREP_FAIL_IF and runs the real grep otherwise, so each call site can be
# broken on its own.
real_git=$(command -v git)
real_grep=$(command -v grep)
git_stub="$work/stub-git"
grep_stub="$work/stub-grep"
mkdir -p "$git_stub" "$grep_stub"
cat >"$git_stub/git" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  if [ "\$arg" = ls-files ]; then echo "fatal: simulated ls-files failure" >&2; exit 128; fi
done
exec "$real_git" "\$@"
EOF
cat >"$grep_stub/grep" <<EOF
#!/usr/bin/env bash
if [ -n "\${GREP_FAIL_IF:-}" ]; then
  case "\$*" in *"\$GREP_FAIL_IF"*) echo "grep: simulated failure" >&2; exit 2 ;; esac
fi
exec "$real_grep" "\$@"
EOF
chmod +x "$git_stub/git" "$grep_stub/grep"

case_no=$((case_no + 1))
repo="$work/case$case_no"
mkdir -p "$repo"
if fgit -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  stop "$repo is inside a repository"
fi
check "outside a repository fails on the file list" fail "cannot list tracked files" origin/development

new_repo
commit "Fix it"
PATH="$git_stub:$PATH" check "a failing git ls-files fails" fail "cannot list tracked files" origin/development

new_repo
mkdir -p "$repo/.internal"
printf 'x\n' >"$repo/.internal/plan.md"
fgit -C "$repo" add -f .internal/plan.md
commit "Add plan"
GREP_FAIL_IF=docs/internal PATH="$grep_stub:$PATH" check "a grep error in the internal file check fails" fail "grep failed" origin/development

new_repo
printf 'one %s two\n' "$(printf '\342\200\223')" >"$repo/notes.txt"
fgit -C "$repo" add notes.txt
commit "Add notes"
GREP_FAIL_IF=-Iq PATH="$grep_stub:$PATH" check "a grep error in the binary file test fails" fail "cannot read notes.txt" origin/development

new_repo
commit "Fix it

$(printf 'Co-%s: x <x@example.invalid>' authored-by)"
GREP_FAIL_IF=co-authored-by PATH="$grep_stub:$PATH" check "a grep error in the commit trailer check fails" fail "grep failed" origin/development

new_repo
commit "Fix it"
GREP_FAIL_IF='by:|gen' PR_BODY="Fixed" PATH="$grep_stub:$PATH" check "a grep error in the pull request text check fails" fail "grep failed" origin/development

new_repo
printf 'one %s two\n' "$(printf '\342\200\223')" >"$repo/notes.txt"
fgit -C "$repo" add notes.txt
commit "Add notes"
rm "$repo/notes.txt"
check "a tracked file missing from the checkout fails" fail "cannot read notes.txt" origin/development

new_repo
fgit -C "$repo" update-index --add --cacheinfo "160000,$(fgit -C "$repo" rev-parse HEAD),vendor/sub"
commit "Add submodule"
check "a submodule entry fails instead of being skipped" fail "cannot read vendor/sub" origin/development

new_repo
printf 'one %s two\n' "$(printf '\342\200\223')" >"$repo/notes.txt"
fgit -C "$repo" add notes.txt
commit "Add notes"
chmod 000 "$repo/notes.txt"
if [ -r "$repo/notes.txt" ]; then
  # Root reads any file, so there is no unreadable file to test with. The
  # missing file case above covers the same branch.
  echo "ok   an unreadable tracked file fails (not run: this user can read mode 000 files)"
else
  check "an unreadable tracked file fails" fail "cannot read notes.txt" origin/development
fi
chmod 600 "$repo/notes.txt"

# Symlinks are checked by the path they hold and never followed: the target
# may be outside the repository, or missing.

new_repo
ln -s "missing $(printf '\342\200\224') file" "$repo/link"
fgit -C "$repo" add link
commit "Add link"
check "a dash in a symlink target fails" fail "en or em dash in link" origin/development

new_repo
printf 'one %s two\n' "$(printf '\342\200\224')" >"$work/outside-case$case_no.txt"
ln -s "$work/outside-case$case_no.txt" "$repo/link"
fgit -C "$repo" add link
commit "Add link"
check "a symlink to a file outside the repository is not followed" pass "" origin/development

if [ "$failures" -ne 0 ]; then
  echo "hygiene tests: $failures failed" >&2
  exit 1
fi
echo "hygiene tests: all $case_no passed"
