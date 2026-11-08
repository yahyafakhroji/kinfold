#!/bin/sh
# Installs Kinfold on macOS and Linux: downloads the program for this machine,
# checks it against the release's SHA256SUMS, then runs the program's own
# `install`, which writes <dataDir>/bin/kinfold and wires the hosts.
#
# KINFOLD_VERSION picks a release. Without it the latest release is used.
# KINFOLD_RELEASE_BASE replaces the release folder. It is honoured only when it
# is an exact loopback origin or a file URL, so an environment variable cannot
# point a real install at another host and a test never reaches GitHub.
# KINFOLD_TTY names the terminal the setup questions are read from; it defaults
# to /dev/tty, which `curl | sh` needs because stdin is the script itself.

set -u

fail() {
  printf 'kinfold: %s\n' "$1" >&2
  exit 1
}

unsupported() {
  fail "no build for $1. Supported: macOS (arm64, x64), Linux glibc (x64, arm64), Windows x64."
}

# A prefix test would also admit http://127.0.0.1.evil.com, http://127.0.0.10 and
# the userinfo form http://127.0.0.1@evil.com, so the whole origin is checked:
# host exactly 127.0.0.1, an optional numeric port, then the end or a path.
local_base() {
  case "$1" in
    http://127.0.0.1|http://127.0.0.1/*) return 0 ;;
    http://127.0.0.1:*)
      rest=${1#http://127.0.0.1:}
      port=${rest%%/*}
      case "$port" in
        ''|*[!0-9]*) return 1 ;;
      esac
      case "$rest" in
        "$port"|"$port"/*) return 0 ;;
      esac
      return 1
      ;;
    file:///*) return 0 ;;
    *) return 1 ;;
  esac
}

release_base() {
  if [ -n "${KINFOLD_RELEASE_BASE:-}" ]; then
    local_base "$KINFOLD_RELEASE_BASE" || fail 'KINFOLD_RELEASE_BASE must be http://127.0.0.1 with an optional port and path, or a file:// URL with an absolute path'
    printf '%s\n' "${KINFOLD_RELEASE_BASE%/}"
    return
  fi
  if [ -n "${KINFOLD_VERSION:-}" ]; then
    case "$KINFOLD_VERSION" in
      *[!0-9A-Za-z.+-]*) fail 'KINFOLD_VERSION must be a version, using letters, digits, dots, plus and hyphen' ;;
    esac
    printf '%s\n' "https://github.com/yahyafakhroji/kinfold/releases/download/v${KINFOLD_VERSION}"
    return
  fi
  printf '%s\n' 'https://github.com/yahyafakhroji/kinfold/releases/latest/download'
}

download() {
  url=$1
  destination=$2
  case "$url" in
    file://*)
      cp "${url#file://}" "$destination" 2>/dev/null || fail "could not read $url"
      ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$destination" || fail "could not download $url"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$destination" "$url" || fail "could not download $url"
      else
        fail 'install needs curl or wget'
      fi
      ;;
  esac
}

sha256_command() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 1
  fi
}

system=$(uname -s 2>/dev/null || true)
machine=$(uname -m 2>/dev/null || true)

case "$system" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) platform=$(printf '%s' "$system" | tr '[:upper:]' '[:lower:]') ;;
esac
case "$machine" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) arch=$(printf '%s' "$machine" | tr '[:upper:]' '[:lower:]') ;;
esac
[ -n "$platform" ] || platform=unknown
[ -n "$arch" ] || arch=unknown

# The release builds link against glibc. A musl host would start a program that
# cannot load its libraries, so it is refused here with the same message as an
# unlisted platform.
if [ "$platform" = linux ]; then
  if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
    unsupported "$platform-$arch"
  fi
  if command -v ldd >/dev/null 2>&1; then
    ldd_version=$(ldd --version 2>&1) || true
    case "$(printf '%s' "$ldd_version" | tr '[:upper:]' '[:lower:]')" in
      *musl*) unsupported "$platform-$arch" ;;
    esac
  fi
fi

case "$platform-$arch" in
  darwin-arm64) asset=kinfold-darwin-arm64 ;;
  darwin-x64) asset=kinfold-darwin-x64 ;;
  linux-x64) asset=kinfold-linux-x64 ;;
  linux-arm64) asset=kinfold-linux-arm64 ;;
  *) unsupported "$platform-$arch" ;;
esac

# The validator exits in a subshell, so the parent has to stop on its status;
# otherwise the script would report the refusal and then try to download anyway.
base=$(release_base) || exit 1
tmp=$(mktemp -d "${TMPDIR:-/tmp}/kinfold-install.XXXXXX") || fail 'could not create a temporary folder'
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

sums="$tmp/SHA256SUMS"
program="$tmp/$asset"
download "$base/SHA256SUMS" "$sums"
download "$base/$asset" "$program"

expected=$(tr -d '\r' < "$sums" | awk -v name="$asset" 'NF == 2 && $2 == name { print $1 }')
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset; nothing was installed"
case "$expected" in
  *[!0-9a-f]*) fail "SHA256SUMS is malformed for $asset; nothing was installed" ;;
esac
if [ "${#expected}" -ne 64 ]; then
  fail "SHA256SUMS is malformed for $asset; nothing was installed"
fi

actual=$(sha256_command "$program") || fail 'install needs sha256sum or shasum'
if [ "$actual" != "$expected" ]; then
  fail "the downloaded $asset does not match SHA256SUMS; nothing was installed"
fi

chmod 0755 "$program" || fail "could not make $asset executable"

KINFOLD_INSTALL_CHANNEL=curl
export KINFOLD_INSTALL_CHANNEL

# Under `curl | sh` stdin is the script, so the wizard reads its answers from
# the terminal. A caller that pipes a key in keeps its stdin, and so does a
# run with no terminal at all (opening /dev/tty then fails).
tty_path=${KINFOLD_TTY:-/dev/tty}
use_tty=1
for argument in "$@"; do
  [ "$argument" = --credential-stdin ] && use_tty=0
done
if [ "$use_tty" -eq 1 ] && ( : < "$tty_path" ) 2>/dev/null; then
  "$program" install "$@" < "$tty_path"
else
  "$program" install "$@"
fi
exit $?
