#!/usr/bin/env bash
# Packs the package the way a publish would and checks the tarball holds
# only the build output, the readme, the license and the manifest. Anything
# else (sources, tests, config, a stray local file) would ship to everyone
# who installs it.
#
# Usage: scripts/tests/pack_test.sh   (packing runs the build first)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd -P)
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "${work:?}"' EXIT

(cd "$root" && pnpm pack --pack-destination "$work" >"$work/pack.log")
shopt -s nullglob
tarballs=("$work"/*.tgz)
if [ "${#tarballs[@]}" -ne 1 ]; then
  echo "pack test: expected one tarball, found ${#tarballs[@]}" >&2
  cat "$work/pack.log" >&2
  exit 1
fi
tar -tzf "${tarballs[0]}" | LC_ALL=C sort >"$work/files"

fail=0
while IFS= read -r path; do
  case "$path" in
    package/package.json | package/README.md | package/LICENSE) ;;
    package/dist/*.test.* | package/dist/*.tsbuildinfo)
      echo "pack test: test or build state in the tarball: $path" >&2
      fail=1
      ;;
    package/dist/*) ;;
    *)
      echo "pack test: unexpected file in the tarball: $path" >&2
      fail=1
      ;;
  esac
done <"$work/files"

for want in package.json README.md LICENSE dist/index.js dist/index.d.ts; do
  if ! grep -qxF "package/$want" "$work/files"; then
    echo "pack test: missing from the tarball: $want" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "pack test: FAIL; the tarball holds:" >&2
  sed 's/^/  /' "$work/files" >&2
  exit 1
fi
echo "pack test: ok ($(wc -l <"$work/files" | tr -d ' ') files)"
