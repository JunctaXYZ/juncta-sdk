#!/usr/bin/env bash
# Fast checks for every commit: types, lint, format, unit tests and the gate
# scripts' own lint. The full gate runs before each push (scripts/gate.sh).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_update_notifier=false

pnpm exec tsc --noEmit
pnpm exec eslint . --max-warnings 0
pnpm exec prettier --check .
pnpm exec vitest run
shellcheck scripts/*.sh scripts/tests/*.sh
scripts/check-workflow-permissions.sh
scripts/check-fail-closed.sh
scripts/check-pins.sh
