#!/usr/bin/env bash
# Installs pinned CI tools from their GitHub releases after checking each
# archive against a SHA-256 recorded here. Used by CI and for local setup.
#
# Usage: scripts/install-ci-tools.sh gitleaks actionlint
#
#   CI_TOOLS_BIN    where binaries go (default ~/.local/bin)
#   CI_TOOLS_CACHE  where archives are kept between runs (default ~/.cache/ci-tools)
#
# Archives are verified on every run, including when they come from a cache,
# so a stale or tampered cache entry fails instead of being installed.
set -euo pipefail

GITLEAKS_VERSION=8.30.1
ACTIONLINT_VERSION=1.7.12

bin_dir="${CI_TOOLS_BIN:-$HOME/.local/bin}"
cache_dir="${CI_TOOLS_CACHE:-$HOME/.cache/ci-tools}"
mkdir -p "$bin_dir" "$cache_dir"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "install-ci-tools: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Checksums copied from each release's published checksum file.
expected_sum() {
  case "$1" in
    gitleaks_"${GITLEAKS_VERSION}"_linux_x64.tar.gz) echo 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    gitleaks_"${GITLEAKS_VERSION}"_linux_arm64.tar.gz) echo e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    gitleaks_"${GITLEAKS_VERSION}"_darwin_x64.tar.gz) echo dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
    gitleaks_"${GITLEAKS_VERSION}"_darwin_arm64.tar.gz) echo b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
    actionlint_"${ACTIONLINT_VERSION}"_linux_amd64.tar.gz) echo 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
    actionlint_"${ACTIONLINT_VERSION}"_linux_arm64.tar.gz) echo 325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
    actionlint_"${ACTIONLINT_VERSION}"_darwin_amd64.tar.gz) echo 5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
    actionlint_"${ACTIONLINT_VERSION}"_darwin_arm64.tar.gz) echo aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
    *) return 1 ;;
  esac
}

install_tool() {
  local name=$1 url=$2 archive=$3
  local want got path="$cache_dir/$archive"
  want=$(expected_sum "$archive") || { echo "install-ci-tools: no checksum for $archive" >&2; exit 1; }
  if [ ! -f "$path" ]; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$path.part" "$url"
    mv "$path.part" "$path"
  fi
  got=$(sha256 "$path")
  if [ "$got" != "$want" ]; then
    rm -f "$path"
    echo "install-ci-tools: checksum mismatch for $archive (got $got)" >&2
    exit 1
  fi
  local tmp
  tmp=$(mktemp -d)
  tar -xzf "$path" -C "$tmp" "$name"
  install -m 0755 "$tmp/$name" "$bin_dir/$name"
  rm -rf "$tmp"
  echo "installed $name from $archive"
}

for tool in "$@"; do
  case "$tool" in
    gitleaks)
      # gitleaks names amd64 "x64".
      a=$arch; [ "$a" = amd64 ] && a=x64
      f="gitleaks_${GITLEAKS_VERSION}_${os}_${a}.tar.gz"
      install_tool gitleaks "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/$f" "$f"
      ;;
    actionlint)
      f="actionlint_${ACTIONLINT_VERSION}_${os}_${arch}.tar.gz"
      install_tool actionlint "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/$f" "$f"
      ;;
    *)
      echo "install-ci-tools: unknown tool $tool" >&2
      exit 1
      ;;
  esac
done

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$bin_dir" >> "$GITHUB_PATH"
fi
