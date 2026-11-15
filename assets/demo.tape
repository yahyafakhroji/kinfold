# The README's terminal recording: `vhs assets/demo.tape`, run from the
# repository root, writes assets/demo.gif.
#
# It shows a real install on a terminal (the wizard, the progress bar, the
# summary) and then `kinfold status`. A real install loads a LaunchAgent,
# writes Keychain entries and takes the daemon's port, and a throwaway HOME
# isolates none of those. So nothing here runs the installed program. The tape
# starts tools/demo.ts, a small shell that runs `kinfold install` and
# `kinfold status` in one process over the installer's test world:
#   - HOME and the memory folder are temp folders under a mktemp directory
#   - launchctl is scripted, and "loading" the service starts a daemon in the
#     same process on a free loopback port, never 37811
#   - the Keychain is an in-memory map
#   - `claude` and `opencode` are scripted commands that answer --version
#   - sqlite-vec is the pinned build, copied from .cache/vec0, so the install
#     downloads nothing; fetch it once with `bun tools/fetch-vec0.ts`
# tools/demo.ts refuses to start unless its world is under that mktemp
# directory, and it turns the daemon's update check off, so the recording
# reaches no network. Its header lists the three things it does for the camera.
#
# Two variables, so this file holds no local paths:
#   KINFOLD_DEMO_BUN=/path/to/bun        the pinned Bun (default: bun on PATH)
#   KINFOLD_DEMO_VERSION=0.4.0           the version the frames show

Output assets/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1280
Set Height 1040
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Framerate 20
Set PlaybackSpeed 1.0

Hide
Type `export KINFOLD_DEMO_ROOT="$(mktemp -d /tmp/kinfold-demo.XXXXXX)" KINFOLD_DEMO_VERSION="${KINFOLD_DEMO_VERSION:-0.4.0}" && clear && exec "${KINFOLD_DEMO_BUN:-bun}" tools/demo.ts`
Enter
Sleep 2.5s
Show

Sleep 400ms
Type "kinfold install"
Sleep 300ms
Enter
Sleep 1.6s

# Memory folder, then the agent list: Claude Code and OpenCode found and
# ticked, the rest shown as not installed.
Enter
Sleep 2.8s
Enter
Sleep 1.3s

# An observer for each picked agent.
Enter
Sleep 1.3s
Enter
Sleep 1.5s

# Encrypt memory.db: the recovery code is shown, and its last two groups are
# typed by tools/demo.ts, since a tape cannot read the code off the screen.
Enter
Sleep 4.4s

# Updates, the PATH question, then the summary and its confirm.
Enter
Sleep 1.4s
Enter
Sleep 3.4s
Enter

# The bar runs to the end and the Installed box follows.
Sleep 7.5s

Type "clear"
Enter
Sleep 300ms
Type "kinfold status"
Sleep 300ms
Enter
Sleep 6.5s
