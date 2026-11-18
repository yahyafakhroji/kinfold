# shellcheck shell=bash
# Sourced by macos.sh, linux.sh and windows.sh: the one claude-code version the
# smoke installs, and the install and start checks they share.
#
# A release run once spent 8 minutes in npm, added 2 of the usual 5 packages,
# and left a claude that said its native binary was not installed. The fetch
# timeout keeps one hung download from eating the step, the retries cover a
# failed install, and install.cjs recovers a missing native binary.

# The version every runner has passed the smoke with.
CLAUDE_CODE_VERSION=2.1.326
# shellcheck disable=SC2034 # read by the scripts that source this file
CLAUDE_CODE_PACKAGE="@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
CLAUDE_CODE_INSTALL_TRIES=3

# Usage: npm_install_retrying <npm install arguments...>
npm_install_retrying() {
  local try=1 backoff="${CLAUDE_CODE_INSTALL_BACKOFF_SECONDS:-10}"
  while true; do
    if npm install --no-audit --no-fund --fetch-timeout=60000 --fetch-retries=2 "$@"; then
      return 0
    fi
    if [ "$try" -ge "$CLAUDE_CODE_INSTALL_TRIES" ]; then
      echo "npm install failed $CLAUDE_CODE_INSTALL_TRIES times: $*" >&2
      return 1
    fi
    echo "npm install failed (try $try of $CLAUDE_CODE_INSTALL_TRIES); trying again in $((backoff * try)) s" >&2
    sleep "$((backoff * try))"
    try=$((try + 1))
  done
}

# Usage: check_claude_runs <claude command> <installed package folder>
check_claude_runs() {
  local claude="$1" package="$2" output
  if output="$("$claude" --version 2>&1)"; then
    echo "$output"
    return 0
  fi
  echo "$output" >&2
  if ! printf '%s\n' "$output" | grep -q 'native binary not installed'; then
    echo "claude --version failed, and not for a missing native binary" >&2
    return 1
  fi
  echo "claude has no native binary; running $package/install.cjs" >&2
  node "$package/install.cjs" || true
  if output="$("$claude" --version 2>&1)"; then
    echo "$output"
    return 0
  fi
  echo "$output" >&2
  echo "claude --version still fails after running install.cjs" >&2
  return 1
}
