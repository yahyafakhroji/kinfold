#!/usr/bin/env bash
# The macOS runner's setup and cleanup around tools/smoke.ts. setup installs
# the agent CLIs and switches to a throwaway keychain; cleanup puts the
# runner's own keychains back.
#
# Usage: bash .github/smoke/macos.sh setup|cleanup
set -eo pipefail

install_claude_code() {
  npm install --global --no-audit --no-fund @anthropic-ai/claude-code
  echo "$(npm prefix --global)/bin" >> "$GITHUB_PATH"
  "$(npm prefix --global)/bin/claude" --version
}

# npm's opencode-ai reports 1.x, and Kinfold refuses anything below 2.0.
# The author runs the v2 formula from this tap; homebrew-core's opencode
# formula is older on some runners.
install_opencode() {
  export HOMEBREW_NO_AUTO_UPDATE=1
  brew install anomalyco/tap/opencode-v2
  echo "$(brew --prefix)/bin" >> "$GITHUB_PATH"
  "$(brew --prefix)/bin/opencode" --version | tee "$RUNNER_TEMP/opencode-version.txt"
}

check_agent_clis() {
  if ! grep -Eq '(^|[^0-9])2\.[0-9]+\.[0-9]+' "$RUNNER_TEMP/opencode-version.txt"; then
    echo "opencode did not report a 2.x version; Kinfold will not wire it"
    cat "$RUNNER_TEMP/opencode-version.txt"
    exit 1
  fi
}

# The commands write their keys to the default keychain. A throwaway one
# keeps the runner's login keychain untouched and goes away afterwards.
create_keychain() {
  keychain="$RUNNER_TEMP/kinfold-smoke.keychain-db"
  original="$(security default-keychain -d user | tr -d '"' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  security list-keychains -d user | tr -d '"' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' > "$RUNNER_TEMP/kinfold-original-keychains.txt"
  password="$(openssl rand -hex 24)"
  echo "::add-mask::$password"
  {
    echo "KINFOLD_SMOKE_KEYCHAIN=$keychain"
    echo "KINFOLD_SMOKE_ORIGINAL_KEYCHAIN=$original"
  } >> "$GITHUB_ENV"
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  security default-keychain -s "$keychain"
  security list-keychains -d user -s "$keychain"
}

restore_keychain() {
  if [ -n "${KINFOLD_SMOKE_ORIGINAL_KEYCHAIN:-}" ]; then
    security default-keychain -s "$KINFOLD_SMOKE_ORIGINAL_KEYCHAIN" || true
  fi
  if [ -f "$RUNNER_TEMP/kinfold-original-keychains.txt" ]; then
    set --
    while IFS= read -r keychain; do
      if [ -n "$keychain" ]; then
        set -- "$@" "$keychain"
      fi
    done < "$RUNNER_TEMP/kinfold-original-keychains.txt"
    if [ "$#" -gt 0 ]; then
      security list-keychains -d user -s "$@" || true
    fi
  fi
  if [ -n "${KINFOLD_SMOKE_KEYCHAIN:-}" ] && [ -f "$KINFOLD_SMOKE_KEYCHAIN" ]; then
    security delete-keychain "$KINFOLD_SMOKE_KEYCHAIN" || true
  fi
}

case "${1:-}" in
  setup)
    install_claude_code
    install_opencode
    check_agent_clis
    create_keychain
    ;;
  cleanup)
    restore_keychain
    ;;
  *)
    echo "usage: bash .github/smoke/macos.sh setup|cleanup" >&2
    exit 2
    ;;
esac
