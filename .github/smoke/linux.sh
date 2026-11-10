#!/usr/bin/env bash
# The Linux runner's setup and cleanup around tools/smoke.ts. setup installs
# the packages and agent CLIs, starts a user systemd through linger, runs the
# live libsecret test in a bus of its own, and picks the key store under test:
# an unlocked keyring on x64, the key file on arm64. cleanup removes what the
# smoke may have left behind.
#
# Usage: bash .github/smoke/linux.sh setup|cleanup
set -euo pipefail

OPENCODE_VERSION=2.2.6
SECRET_SERVICE_WAIT_SECONDS=30
USER_MANAGER_WAIT_SECONDS=30

install_packages() {
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends expect ripgrep dbus-user-session gnome-keyring libsecret-1-0
}

# The smoke checks the unit at ~/.config/systemd/user; another config folder
# would put it somewhere the checks do not look. The hosted images export
# XDG_CONFIG_HOME as that same folder, which names the same unit path.
refuse_xdg_config_home() {
  if [ -n "${XDG_CONFIG_HOME+set}" ] && [ "$XDG_CONFIG_HOME" != "$HOME/.config" ]; then
    echo "XDG_CONFIG_HOME names a folder other than \$HOME/.config; the smoke expects the unit under \$HOME/.config"
    exit 1
  fi
}

start_user_manager() {
  local uid runtime waited=0
  uid="$(id -u)"
  runtime="/run/user/$uid"
  sudo loginctl enable-linger "$(id -un)"
  while [ "$waited" -lt "$USER_MANAGER_WAIT_SECONDS" ]; do
    if [ -e "$runtime/systemd/private" ] && [ -e "$runtime/bus" ]; then
      {
        echo "XDG_RUNTIME_DIR=$runtime"
        echo "KINFOLD_SMOKE_SERVICE=systemd"
      } >> "$GITHUB_ENV"
      export XDG_RUNTIME_DIR="$runtime"
      SMOKE_SERVICE=systemd
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "::warning::no user service manager; the daemon runs in the foreground"
  {
    echo "XDG_RUNTIME_DIR="
    echo "KINFOLD_SMOKE_SERVICE=foreground"
  } >> "$GITHUB_ENV"
  SMOKE_SERVICE=foreground
}

install_claude_code() {
  local prefix="$RUNNER_TEMP/npm-global"
  npm install --global --prefix "$prefix" --no-audit --no-fund @anthropic-ai/claude-code
  echo "$prefix/bin" >> "$GITHUB_PATH"
  "$prefix/bin/claude" --version
}

# npm's opencode-ai reports 1.x, and Kinfold refuses anything below 2.0. These
# are the archives and sums the author's tap formula pins for 2.2.6.
install_opencode() {
  local asset sum dir binary
  case "${RUNNER_ARCH:-}" in
    X64)
      asset=opencode-linux-x64-baseline.tar.gz
      sum=08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c
      ;;
    ARM64)
      asset=opencode-linux-arm64.tar.gz
      sum=f2d27600c367e45057d6a16f6a5c2aa8d77b41a9b10d4bc3d849c2f88870e944
      ;;
    *)
      echo "no OpenCode archive for RUNNER_ARCH=${RUNNER_ARCH:-unset}"
      exit 1
      ;;
  esac
  dir="$RUNNER_TEMP/opencode"
  mkdir -p "$dir/bin"
  curl -fsSL --retry 3 -o "$dir/$asset" "https://opencode.ai/files/bin/$OPENCODE_VERSION/$asset"
  (cd "$dir" && echo "$sum  $asset" | sha256sum --check --strict)
  tar -xzf "$dir/$asset" -C "$dir/bin"
  binary="$(find "$dir/bin" -type f -name opencode | head -n 1)"
  if [ -z "$binary" ]; then
    echo "the OpenCode archive holds no opencode program"
    exit 1
  fi
  chmod +x "$binary"
  dirname "$binary" >> "$GITHUB_PATH"
  "$binary" --version | tee "$RUNNER_TEMP/opencode-version.txt"
}

check_agent_clis() {
  if ! grep -Eq '(^|[^0-9])2\.[0-9]+\.[0-9]+' "$RUNNER_TEMP/opencode-version.txt"; then
    echo "opencode did not report a 2.x version; Kinfold will not wire it"
    cat "$RUNNER_TEMP/opencode-version.txt"
    exit 1
  fi
}

# gnome-keyring answers on the bus before its login collection exists, and a
# write in that gap fails. The default alias names a collection once it does,
# and the collection must also be unlocked, since nothing here may prompt.
wait_for_secret_service() {
  local waited=0 reply collection locked
  while [ "$waited" -lt "$SECRET_SERVICE_WAIT_SECONDS" ]; do
    reply="$(dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default 2>/dev/null || true)"
    collection="$(printf '%s\n' "$reply" | sed -n 's|.*object path "\(/org/freedesktop/secrets/collection/[^"]*\)".*|\1|p' | head -n 1)"
    if [ -n "$collection" ]; then
      locked="$(dbus-send --session --print-reply --dest=org.freedesktop.secrets "$collection" org.freedesktop.DBus.Properties.Get string:org.freedesktop.Secret.Collection string:Locked 2>/dev/null || true)"
      if printf '%s\n' "$locked" | grep -q 'boolean false'; then
        return 0
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "the Secret Service did not offer an unlocked default collection within ${SECRET_SERVICE_WAIT_SECONDS} s"
  return 1
}
export -f wait_for_secret_service
export SECRET_SERVICE_WAIT_SECONDS

# The real libsecret binding against a real keyring, in a bus that ends with
# the test. bunfig.toml preloads the sqlite3mc build, which the smoke job never
# makes; this test opens no database, so any non-empty override satisfies it.
# gnome-keyring keeps its login keyring under XDG_DATA_HOME, so the test gets
# its own: one left in ~/.local/share would hold this run's password, and the
# keyring under test could then not unlock it with its own.
run_live_libsecret_test() {
  local log="$RUNNER_TEMP/libsecret-live.log"
  local data="$RUNNER_TEMP/libsecret-live-data"
  mkdir -p "$data"
  # shellcheck disable=SC2016 # the inner bash expands these
  XDG_DATA_HOME="$data" dbus-run-session -- bash -c '
    set -euo pipefail
    password="$(openssl rand -hex 24)"
    printf "%s" "$password" | gnome-keyring-daemon --unlock --components=secrets --daemonize > /dev/null
    wait_for_secret_service
    KINFOLD_SQLITE3MC_LIB=/nonexistent KINFOLD_TEST_SECRET_SERVICE=1 bun test ./src/secrets/stores/libsecret.live.test.ts 2>&1
  ' | tee "$log"
  if grep -q '(skip)' "$log" || ! grep -q '(pass)' "$log"; then
    echo "the live libsecret test skipped or passed nothing"
    exit 1
  fi
}

# install picks the key file when its probe finds the keyring unusable, and the
# smoke would then fail far later on the status label. The same probe, run from
# source here, names the reason at once. Its reasons are fixed strings.
probe_libsecret() {
  bun -e "
    import { libsecretModule } from './src/secrets/stores/libsecret'
    import { currentPlatform } from './src/platform/platform'
    const probe = libsecretModule.probe({ platform: currentPlatform(), homeDir: process.env.HOME ?? '', dataDir: '', envVars: process.env, security: undefined as never })
    console.log(probe.usable ? 'libsecret probe: usable' : 'libsecret probe: ' + probe.reason)
    if (!probe.usable) process.exit(1)
  "
}

start_store_under_test() {
  local address password
  case "${RUNNER_ARCH:-}" in
    X64)
      if [ "$SMOKE_SERVICE" = systemd ]; then
        address="unix:path=/run/user/$(id -u)/bus"
      else
        address="$(dbus-daemon --session --fork --print-address=1 --print-pid=3 3> "$RUNNER_TEMP/kinfold-dbus.pid")"
      fi
      password="$(openssl rand -hex 24)"
      echo "::add-mask::$password"
      printf '%s' "$password" | DBUS_SESSION_BUS_ADDRESS="$address" gnome-keyring-daemon --replace --unlock --components=secrets --daemonize > /dev/null
      DBUS_SESSION_BUS_ADDRESS="$address" wait_for_secret_service
      DBUS_SESSION_BUS_ADDRESS="$address" probe_libsecret
      {
        echo "DBUS_SESSION_BUS_ADDRESS=$address"
        echo "KINFOLD_SMOKE_KEY_STORE=libsecret"
      } >> "$GITHUB_ENV"
      ;;
    ARM64)
      # No bus: install's probe finds no Secret Service and picks the key file.
      {
        echo "DBUS_SESSION_BUS_ADDRESS="
        echo "KINFOLD_SMOKE_KEY_STORE=key file"
      } >> "$GITHUB_ENV"
      ;;
    *)
      echo "no key store under test for RUNNER_ARCH=${RUNNER_ARCH:-unset}"
      exit 1
      ;;
  esac
}

cleanup() {
  systemctl --user disable --now kinfold.service || true
  pkill -u "$(id -u)" gnome-keyring-d || true
  if [ -f "$RUNNER_TEMP/kinfold-dbus.pid" ]; then
    kill "$(cat "$RUNNER_TEMP/kinfold-dbus.pid")" || true
  fi
  rm -rf "$HOME/.config/kinfold" || true
  sudo loginctl disable-linger "$(id -un)" || true
}

case "${1:-}" in
  setup)
    install_packages
    refuse_xdg_config_home
    start_user_manager
    install_claude_code
    install_opencode
    check_agent_clis
    run_live_libsecret_test
    start_store_under_test
    ;;
  cleanup)
    cleanup
    ;;
  *)
    echo "usage: bash .github/smoke/linux.sh setup|cleanup" >&2
    exit 2
    ;;
esac
