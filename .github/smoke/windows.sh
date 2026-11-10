#!/usr/bin/env bash
# The Windows runner's setup and cleanup around tools/smoke.ts. setup installs
# the agent CLIs and pywinpty for the ConPTY driver; cleanup removes the
# scheduled task, every Credential Manager entry Kinfold or the live tests can
# write, and the smoke's shim folder from the user PATH. setup also runs the
# live tests against the real Credential Manager, BitLocker and access list,
# which the smoke itself reaches only through install and status.
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
  # RUNNER_TEMP is a Windows path; bash needs the POSIX spelling and npm the
  # Windows one, or the sh shims npm writes name a drive that does not exist.
  prefix="$(cygpath -u "$RUNNER_TEMP")/agent-clis"
  mkdir -p "$prefix"
  prefix_win="$(cygpath -w "$prefix")"
  npm install --global --prefix "$prefix_win" --no-audit --no-fund \
    @anthropic-ai/claude-code "@opencode/cli@$OPENCODE_VERSION"
  echo "$prefix_win" >> "$GITHUB_PATH"
  export PATH="$prefix:$PATH"
  claude --version
  opencode --version | tee "$RUNNER_TEMP/opencode-version.txt"
  if ! grep -Eq '(^|[^0-9])2\.[0-9]+\.[0-9]+' "$RUNNER_TEMP/opencode-version.txt"; then
    echo "opencode did not report a 2.x version; Kinfold will not wire it"
    exit 1
  fi
}

install_pywinpty() {
  python -m pip install --disable-pip-version-check pywinpty==2.0.15
}

# The test preload wants a sqlite3mc build for the stores it opens; these tests
# open none, so a named placeholder stands in for building one on this runner.
run_live_tests() {
  KINFOLD_SQLITE3MC_LIB=not-opened-by-the-live-tests \
  KINFOLD_TEST_CREDENTIAL_MANAGER=1 KINFOLD_TEST_WINDOWS_DISK=1 KINFOLD_TEST_WINDOWS_ACL=1 \
    bun test \
      ./src/secrets/stores/credential-manager.live.test.ts \
      ./src/install/disk/bitlocker.live.test.ts \
      ./src/install/access/windows-acl.live.test.ts
}

remove_task() {
  schtasks /Delete /TN KinfoldDaemon /F || true
}

remove_credentials() {
  for ref in db-key db-key-next hmac-master hmac-legacy openrouter; do
    cmdkey /delete:kinfold/$ref || true
  done
  # A live test that stopped before its own cleanup leaves kinfold/live-* targets.
  for target in $(cmdkey /list | grep -o 'kinfold/live-[a-z0-9._-]*' | sort -u || true); do
    cmdkey /delete:$target || true
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
    run_live_tests
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
