#!/usr/bin/env bash
# Tests for scripts/check-workflow-permissions.sh on fixture directories
# (no git needed).
#
# Usage: scripts/tests/workflow_permissions_test.sh
set -euo pipefail

check="$(cd "$(dirname "$0")/.." && pwd -P)/check-workflow-permissions.sh"
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'chmod -R u+rwx "$work" 2>/dev/null; rm -rf -- "${work:?}"' EXIT

failures=0
cases=0
n=0

# The shape every shared workflow has: nothing at the top, a little per job.
good_ci='name: ci
on: pull_request
permissions: {}
jobs:
  test:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - run: make test'

# The one workflow allowed to post statuses.
review_gate='name: review-gate
on: pull_request_target
permissions: {}
jobs:
  gate:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: read
      statuses: write
    steps:
      - run: echo gate'

# fixture: a root holding review-gate.yml and a clean ci.yml. Cases then
# add or overwrite files under $dir/.github/workflows.
fixture() {
  n=$((n + 1))
  dir="$work/case$n"
  mkdir -p "$dir/.github/workflows"
  printf '%s\n' "$review_gate" >"$dir/.github/workflows/review-gate.yml"
  printf '%s\n' "$good_ci" >"$dir/.github/workflows/ci.yml"
}

# workflow NAME BODY: writes a workflow file in the current fixture.
workflow() {
  mkdir -p "$(dirname "$dir/.github/workflows/$1")"
  printf '%s\n' "$2" >"$dir/.github/workflows/$1"
}

expect() { # expect NAME pass|fail PATTERN
  local status=0 out
  cases=$((cases + 1))
  out=$(bash "$check" "$dir" 2>&1) || status=$?
  if { [ "$2" = pass ] && [ "$status" -eq 0 ]; } ||
    { [ "$2" = fail ] && [ "$status" -ne 0 ] && grep -qF -- "$3" <<<"$out"; }; then
    echo "ok   $1"
  else
    echo "FAIL $1 (exit $status, wanted $2)"
    printf '%s\n' "$out" | sed 's/^/     | /'
    failures=$((failures + 1))
  fi
}

# job_with LINES: a workflow whose one job has these permission lines.
job_with() {
  printf 'name: x\non: pull_request\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    permissions:\n%s\n    steps:\n      - run: make\n' "$1"
}

fixture
expect "the shared shape and review-gate.yml pass" pass ""

fixture
workflow other.yml "$(job_with '      statuses: write')"
expect "a job granting statuses: write fails" fail "other.yml:8: grants statuses: write"

fixture
workflow other.yml 'name: x
on: pull_request
permissions:
  statuses: write
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: make'
expect "a workflow granting statuses: write at the top fails" fail "other.yml:4: grants statuses: write"

fixture
workflow other.yml "$(job_with '      statuses: read')"
expect "statuses: read passes" pass ""

fixture
workflow other.yml "$(job_with '      contents: write
      statuses: none')"
expect "statuses: none passes" pass ""

fixture
workflow other.yaml "$(job_with '      statuses: write')"
expect "a .yaml workflow is checked too" fail "other.yaml:8: grants statuses: write"

fixture
workflow nested/other.yml "$(job_with '      statuses: write')"
expect "a workflow in a subdirectory is checked too" fail "nested/other.yml:8: grants statuses: write"

fixture
workflow other.yml "$(job_with '      "statuses": write')"
expect "a quoted key fails" fail "other.yml:8: write each permission"

fixture
workflow other.yml "$(job_with "      statuses: 'write'")"
expect "a quoted value fails" fail "other.yml:8: write each permission"

fixture
workflow other.yml "$(job_with '      Statuses: write')"
expect "another spelling of the key fails" fail "other.yml:8: write each permission"

fixture
workflow other.yml "$(job_with '      statuses:
        write')"
expect "a value on the next line fails" fail "other.yml:8: write each permission"

fixture
workflow other.yml "$(job_with '      "st\x61tuses": write')"
expect "an escaped key fails" fail "other.yml:8:"

fixture
workflow other.yml 'name: x
on: pull_request
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    "perm\x69ssions": {"st\x61tuses": write}
    steps:
      - run: make'
expect "an escaped permissions key fails" fail "other.yml:7: escaped key"

fixture
workflow other.yml 'name: x
on: pull_request
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    permissions: { statuses: write }
    steps:
      - run: make'
expect "a flow mapping fails" fail "other.yml:7: permissions must be"

fixture
workflow other.yml 'name: x
on: pull_request
permissions: write-all
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: make'
expect "write-all fails" fail "other.yml:3: permissions must be"

fixture
workflow other.yml 'name: x
on: pull_request
x-perms: &perms write-all
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: make'
expect "write-all anywhere fails" fail "other.yml:3: write-all"

fixture
workflow other.yml 'name: x
on: pull_request
permissions: *perms
jobs: {}'
expect "an alias for the permissions fails" fail "other.yml:3: permissions must be"

fixture
workflow other.yml 'name: x
on: pull_request
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    permissions:
      <<: *write
    steps:
      - run: make'
expect "a merge key in a permissions block fails" fail "other.yml:8: write each permission"

fixture
workflow other.yml 'name: x
on: pull_request
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: make'
expect "a workflow with no top-level permissions fails" fail "other.yml: no top-level permissions"

fixture
workflow other.yml 'name: x
on: pull_request
permissions: read-all
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      # Posting statuses: write is review-gate.yml only.
      - run: make'
expect "read-all and a comment that mentions statuses pass" pass ""

fixture
workflow other.yml 'name: x
on: pull_request
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: bash scripts/check-workflow-permissions.sh statuses
      - run: |
          echo "permissions: none needed here"
          echo "statuses: read"'
expect "the words inside a run step, not shaped like keys, pass" pass ""

fixture
workflow other.yml 'name: x
on: pull_request
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "write-all"'
expect "write-all inside a run step still fails" fail "other.yml:8: write-all"

fixture
rm "$dir/.github/workflows/review-gate.yml"
workflow review-gate.yml 'name: review-gate
on: pull_request_target
jobs:
  gate:
    runs-on: ubuntu-24.04
    permissions:
      statuses: write
    steps:
      - run: echo gate'
expect "review-gate.yml itself is not checked" pass ""

fixture
workflow sub/review-gate.yml "$(job_with '      statuses: write')"
expect "only the top-level review-gate.yml is exempt" fail "sub/review-gate.yml:8: grants statuses: write"

fixture
rm -r "$dir/.github/workflows"
expect "a root with no workflows directory fails" fail "no workflows directory"

fixture
workflow other.yml "$(job_with '      contents: read')"
chmod 000 "$dir/.github/workflows/other.yml"
if [ -r "$dir/.github/workflows/other.yml" ]; then
  # Root reads any file, so there is no unreadable file to test with.
  echo "ok   an unreadable workflow fails (not run: this user can read mode 000 files)"
else
  expect "an unreadable workflow fails" fail "cannot read"
fi

if [ "$failures" -ne 0 ]; then
  echo "workflow permissions tests: $failures of $cases failed" >&2
  exit 1
fi
echo "workflow permissions tests: all $cases passed"
