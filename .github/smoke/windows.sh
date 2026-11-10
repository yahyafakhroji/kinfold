#!/usr/bin/env bash
# The Windows runner's setup and cleanup around tools/smoke.ts. setup installs
# the agent CLIs and pywinpty for the ConPTY driver; cleanup removes the
# scheduled task, every Credential Manager entry Kinfold can write, and the
# smoke's shim folder from the user PATH.
#
# Usage: bash .github/smoke/windows.sh setup|cleanup
set -eo pipefail

# Same as the macOS tap's opencode-v2 formula; npm's opencode-ai still
# reports 1.x, which Kinfold refuses.
OPENCODE_VERSION=2.2.6

# Task Scheduler starts the daemon with the logon PATH, and the runner's npm
# prefix is on the machine PATH. A private prefix keeps the real claude off
# that PATH, so the daemon finds only the smoke's shim, which the smoke adds
# to the user PATH.
install_agent_clis() {
  prefix="$RUNNER_TEMP/agent-clis"
  mkdir -p "$prefix"
  npm install --global --prefix "$prefix" --no-audit --no-fund \
    @anthropic-ai/claude-code "@opencode/cli@$OPENCODE_VERSION"
  prefix_win="$(cygpath -w "$prefix")"
  echo "$prefix_win" >> "$GITHUB_PATH"
  export PATH="$prefix:$PATH"
  echo "claude: $(claude --version)"
  opencode --version | tee "$RUNNER_TEMP/opencode-version.txt"
  if ! grep -Eq '(^|[^0-9])2\.[0-9]+\.[0-9]+' "$RUNNER_TEMP/opencode-version.txt"; then
    echo "opencode did not report a 2.x version; Kinfold will not wire it"
    exit 1
  fi
}

install_pywinpty() {
  python -m pip install --disable-pip-version-check pywinpty==2.0.15
}

remove_task() {
  schtasks /Delete /TN KinfoldDaemon /F || true
}

remove_credentials() {
  for ref in db-key db-key-next hmac-master hmac-legacy openrouter; do
    cmdkey /delete:kinfold/$ref || true
  done
}

# The smoke's temporary folders are named kinfold-smoke-*; only those leave
# the user PATH, and an emptied PATH is removed rather than left blank.
remove_shim_from_user_path() {
  powershell.exe -NoProfile -NonInteractive -Command "
    \$old = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (\$old) {
      \$kept = (\$old -split ';' | Where-Object { \$_ -ne '' -and \$_ -notlike '*kinfold-smoke-*' }) -join ';'
      if (\$kept) { [Environment]::SetEnvironmentVariable('Path', \$kept, 'User') }
      else { [Environment]::SetEnvironmentVariable('Path', \$null, 'User') }
    }
  " || true
}

case "${1:-}" in
  setup)
    install_agent_clis
    install_pywinpty
    ;;
  cleanup)
    # Git Bash would rewrite /Delete and /delete:... into Windows paths.
    export MSYS_NO_PATHCONV=1
    remove_task
    remove_credentials
    remove_shim_from_user_path
    ;;
  *)
    echo "usage: bash .github/smoke/windows.sh setup|cleanup" >&2
    exit 2
    ;;
esac
