#!/usr/bin/env bash
# Installs the pinned Bun on a CI runner and puts it on PATH. The version comes
# from .bun-version and the hashes from tools/bun-pins.txt. The release URL is
# tried first; a server error or a timeout moves on to the pinned API asset
# id. The sha256 is checked on whichever file arrives, so a mismatch fails.
# This runs before any Bun exists, which is why it is shell and not the
# TypeScript download helper the other build tools use.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/.bun-version")"
pins="$root/tools/bun-pins.txt"

pinned_version="$(awk '$1 == "version" { print $2 }' "$pins")"
if [ "$pinned_version" != "$version" ]; then
  echo "tools/bun-pins.txt pins Bun $pinned_version but .bun-version says $version" >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) name="bun-darwin-aarch64.zip" ;;
  Darwin-x86_64) name="bun-darwin-x64.zip" ;;
  Linux-x86_64) name="bun-linux-x64.zip" ;;
  Linux-aarch64) name="bun-linux-aarch64.zip" ;;
  MINGW*|MSYS*) name="bun-windows-x64.zip" ;;
  *) echo "no pinned Bun for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

read -r asset_id expected < <(awk -v n="$name" '$1 == n { print $2, $3 }' "$pins")
if [ -z "${asset_id:-}" ] || [ -z "${expected:-}" ]; then
  echo "tools/bun-pins.txt has no entry for $name" >&2
  exit 1
fi

work="${RUNNER_TEMP:-$(mktemp -d)}/bun-install"
rm -rf "$work"
mkdir -p "$work"
zip="$work/$name"

sha256_of() {
  # Reading stdin keeps the file name out of the output; sha256sum prefixes a
  # backslash to the hash when the name has one, as Windows temp paths do.
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1; else shasum -a 256 < "$1" | cut -d' ' -f1; fi
}

# Prints the HTTP status; 000 means the request itself failed or timed out.
fetch() {
  curl -sSL --max-time 180 -o "$zip" -w '%{http_code}' "$@" || true
}

status="$(fetch "https://github.com/oven-sh/bun/releases/download/bun-v$version/$name")"
if [ "$status" = "000" ] || [ "$status" -ge 500 ]; then
  echo "the Bun release URL answered $status; trying the API asset URL" >&2
  auth=()
  if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
  status="$(fetch ${auth[@]+"${auth[@]}"} -H 'Accept: application/octet-stream' "https://api.github.com/repos/oven-sh/bun/releases/assets/$asset_id")"
fi
if [ "$status" != "200" ]; then
  echo "the Bun download answered $status; nothing was installed" >&2
  exit 1
fi

actual="$(sha256_of "$zip")"
if [ "$actual" != "$expected" ]; then
  echo "the Bun download (sha256 $actual) does not match the pinned sha256; nothing was installed" >&2
  exit 1
fi

if command -v unzip >/dev/null 2>&1; then
  unzip -q "$zip" -d "$work"
else
  powershell -NoProfile -Command "Expand-Archive -Path '$(cygpath -w "$zip")' -DestinationPath '$(cygpath -w "$work")'"
fi
bin_dir="$(dirname "$(find "$work" -type f \( -name bun -o -name bun.exe \) | head -n 1)")"
chmod +x "$bin_dir"/bun* 2>/dev/null || true
export PATH="$bin_dir:$PATH"
installed="$(bun --version)"
if [ "$installed" != "$version" ]; then
  echo "installed Bun reports $installed, expected $version" >&2
  exit 1
fi

if [ -n "${GITHUB_PATH:-}" ]; then
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$bin_dir" >> "$GITHUB_PATH"; else echo "$bin_dir" >> "$GITHUB_PATH"; fi
fi
echo "Bun $installed installed from the pinned $name"
