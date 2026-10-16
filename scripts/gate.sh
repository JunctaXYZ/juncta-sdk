#!/usr/bin/env bash
# The full local gate. The pre-push hook runs it, and it runs every check CI
# runs, so a push that passes here should pass there.
#
# Usage: scripts/gate.sh [BASE_REF]
#   BASE_REF is what the coverage baseline and the commit message checks
#   compare against. Default: origin/development. A base that cannot be
#   resolved fails the gate; nothing falls back to a smaller check.
#
# In CI the package checks run in ci.yml. The rest run in security.yml and
# hygiene.yml, some only when the files they read change or weekly: gitleaks,
# osv-scanner, pnpm audit, semgrep, actionlint, zizmor, shellcheck and the
# script tests. Here they all run every time. CodeQL runs in CI only.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base_ref="${1:-origin/development}"

# No prompts and no update checks against the registry.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_update_notifier=false

step() { printf '\n==> %s\n' "$*"; }

# version_is NAME WANT COMMAND...: the tool must report exactly this version,
# so local results match CI's.
version_is() {
  local name=$1 want=$2 got
  shift 2
  command -v "$1" >/dev/null 2>&1 || { echo "gate: $name not found" >&2; exit 1; }
  got=$("$@" 2>&1 | head -n 1)
  case "$got" in
    *"$want"*) ;;
    *) echo "gate: $name must be $want, found: $got" >&2; exit 1 ;;
  esac
}

step "tools"
for tool in node pnpm perl docker git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "gate: $tool not found" >&2; exit 1; }
done
want_node=$(cat .nvmrc)
got_node=$(node --version)
if [ "${got_node#v}" != "$want_node" ]; then
  echo "gate: Node $got_node is running; .nvmrc pins $want_node" >&2
  exit 1
fi
want_pnpm=$(node -p 'require("./package.json").packageManager.split("@")[1].split("+")[0]')
got_pnpm=$(pnpm --version)
if [ "$got_pnpm" != "$want_pnpm" ]; then
  echo "gate: pnpm $got_pnpm is running; package.json pins $want_pnpm (run corepack enable pnpm)" >&2
  exit 1
fi
version_is gitleaks "8.30.1" gitleaks version
version_is actionlint "1.7.12" actionlint -version
version_is zizmor "1.30.1" zizmor --version
version_is osv-scanner "2.6.0" osv-scanner --version
command -v shellcheck >/dev/null 2>&1 || { echo "gate: shellcheck not found" >&2; exit 1; }
got=$(shellcheck --version | sed -n 's/^version: //p')
[ "$got" = 0.11.0 ] || { echo "gate: shellcheck $got, want 0.11.0" >&2; exit 1; }
if ! base_sha=$(git rev-parse --verify --quiet "${base_ref}^{commit}"); then
  echo "gate: cannot resolve $base_ref; run git fetch origin, or pass the base" >&2
  exit 1
fi
merge_base=$(git merge-base HEAD "$base_sha")

step "install from the committed lockfile"
# The lockfile is what CI installs and what the audits read, so the gate
# runs only against the committed one, and the install must not change it.
# Each state is assigned before it is tested, so a git failure stops here.
lock=$(git status --porcelain --untracked-files=all -- pnpm-lock.yaml)
if [ -n "$lock" ]; then
  echo "gate: pnpm-lock.yaml has uncommitted changes; commit or discard them first" >&2
  exit 1
fi
pnpm install --frozen-lockfile
lock=$(git status --porcelain --untracked-files=all -- pnpm-lock.yaml)
if [ -n "$lock" ]; then
  echo "gate: pnpm install changed pnpm-lock.yaml" >&2
  exit 1
fi

step "typecheck, lint, format"
pnpm exec tsc --noEmit
pnpm exec eslint . --max-warnings 0
pnpm exec prettier --check .

step "tests, coverage and its baseline"
pnpm exec vitest run --coverage
node scripts/check-coverage-baseline.mjs "$merge_base"
node --test scripts/tests/*.test.mjs

step "package: build, publint, attw, tarball contents, consumer, docs"
pnpm build
pnpm exec publint --strict
pnpm exec attw --pack . --profile esm-only
scripts/tests/pack_test.sh
scripts/tests/consume_test.sh
pnpm docs

step "dependency audit"
pnpm audit --audit-level low

step "gate scripts: self-tests, permissions, swallowed failures, shellcheck, pins"
scripts/tests/hygiene_test.sh
scripts/tests/security_filter_test.sh
scripts/tests/workflow_permissions_test.sh
scripts/tests/fail_closed_test.sh
scripts/tests/ci_filter_test.sh
scripts/tests/pins_test.sh
scripts/tests/git_env_test.sh
scripts/check-workflow-permissions.sh
scripts/check-fail-closed.sh
shellcheck scripts/*.sh scripts/tests/*.sh
scripts/check-pins.sh

step "workflows: actionlint, zizmor, review gate and branch audit tests"
actionlint
# CI runs zizmor online, which also checks that each pinned SHA belongs to
# the tag in its comment. Do the same here when a GitHub login is available.
if token=$(gh auth token 2>/dev/null) && [ -n "$token" ]; then
  GH_TOKEN="$token" zizmor --quiet .github/
else
  zizmor --quiet --offline .github/
fi
node --test .github/scripts/*.test.mjs

step "secrets and dependencies: gitleaks, osv-scanner"
gitleaks git --no-banner --redact --exit-code 1 .
# Scan a copy of the tracked files only, as CI sees them: node_modules,
# dist and coverage are local output.
tracked=$(mktemp -d)
trap 'rm -rf -- "${tracked:?}"' EXIT
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$tracked"
osv-scanner scan source --recursive --allow-no-lockfiles "$tracked"

step "semgrep, at the image and rulesets security.yml uses"
image=$(perl -ne 'print $1 if /^\s*image:\s*(semgrep\/semgrep:\S+\@sha256:[0-9a-f]{64})\s*$/' .github/workflows/security.yml)
rulesets=$(perl -ne 'print $1 if /^\s*SEMGREP_RULESETS:\s*(.+?)\s*$/' .github/workflows/security.yml)
if [ -z "$image" ] || [ -z "$rulesets" ]; then
  echo "gate: cannot read the semgrep image or rulesets from security.yml" >&2
  exit 1
fi
semgrep_args=()
for r in $rulesets; do semgrep_args+=(--config "$r"); done
docker run --rm -v "$tracked:/src:ro" -w /src "$image" \
  semgrep scan --metrics=off --error --quiet "${semgrep_args[@]}" .

step "hygiene"
scripts/hygiene.sh "$merge_base"

printf '\ngate: all checks passed\n'
