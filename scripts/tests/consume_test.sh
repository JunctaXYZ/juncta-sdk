#!/usr/bin/env bash
# Installs the packed tarball into a scratch ESM project, as an integrator
# would, then imports it with Node and type checks the import under Node
# and bundler module resolution. Catches an exports map that works inside
# this repository but not from node_modules. TypeScript falls back to the
# .d.ts beside the import target, so the declared types path is checked
# for existence on its own.
#
# Usage: scripts/tests/consume_test.sh   (packing runs the build first)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd -P)
tsc="$root/node_modules/.bin/tsc"
[ -x "$tsc" ] || { echo "consume test: $tsc not found; run pnpm install" >&2; exit 1; }
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "${work:?}"' EXIT

want=$(node -p 'require(process.argv[1]).version' "$root/package.json")
if ! (cd "$root" && pnpm pack --pack-destination "$work" >"$work/pack.log" 2>&1); then
  cat "$work/pack.log" >&2
  echo "consume test: pnpm pack failed" >&2
  exit 1
fi
shopt -s nullglob
tarballs=("$work"/*.tgz)
[ "${#tarballs[@]}" -eq 1 ] || { echo "consume test: expected one tarball, found ${#tarballs[@]}" >&2; exit 1; }

app="$work/app"
mkdir -p "$app"
cat >"$app/package.json" <<'JSON'
{ "name": "consumer", "private": true, "type": "module" }
JSON
# Offline, with a private cache and no scripts: the tarball has no
# dependencies, so nothing is fetched and nothing runs at install time.
(cd "$app" && npm install --offline --ignore-scripts --no-audit --no-fund \
  --no-package-lock --cache "$work/npm-cache" "${tarballs[0]}" >"$work/install.log" 2>&1) || {
  cat "$work/install.log" >&2
  echo "consume test: npm install of the tarball failed" >&2
  exit 1
}

got=$(cd "$app" && node --input-type=module -e \
  'import { VERSION } from "@juncta/sdk"; process.stdout.write(VERSION);')
if [ "$got" != "$want" ]; then
  echo "consume test: imported VERSION is '$got', package.json says '$want'" >&2
  exit 1
fi
echo "ok   node imports VERSION $got from the installed tarball"

installed="$app/node_modules/@juncta/sdk"
types=$(node -p 'require(process.argv[1]).exports["."].types' "$installed/package.json")
if [ ! -f "$installed/$types" ]; then
  echo "consume test: exports types points at $types, which is not in the tarball" >&2
  exit 1
fi
echo "ok   the declared types file $types is in the tarball"

cat >"$app/index.ts" <<'TS'
import { VERSION } from '@juncta/sdk';
// A literal type in the declarations would make this a type error.
export const isOther = VERSION === '0.0.0-other';
TS
for resolution in nodenext:nodenext esnext:bundler; do
  module=${resolution%%:*}
  cat >"$app/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023",
    "module": "$module",
    "moduleResolution": "${resolution#*:}",
    "strict": true,
    "types": [],
    "noEmit": true
  },
  "files": ["index.ts"]
}
JSON
  (cd "$app" && "$tsc" -p tsconfig.json)
  echo "ok   types resolve with moduleResolution ${resolution#*:}"
done
echo "consume test: ok"
