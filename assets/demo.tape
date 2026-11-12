# The README's terminal recording: `vhs assets/demo.tape` writes assets/demo.gif.
#
# It needs a release build of the program and the SHA256SUMS it was released
# with, named by two variables, so this file holds no local paths:
#   KINFOLD_DEMO_BIN=/path/to/kinfold-darwin-arm64
#   KINFOLD_DEMO_SUMS=/path/to/SHA256SUMS
#
# Everything runs under a throwaway HOME in the per-user temp folder, and the
# install is a dry run, so nothing is written, no service is touched and no key
# store is read. Stub `claude` and `opencode` commands stand in for the agents.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

Hide
Type `export HOME="$(mktemp -d "$(getconf DARWIN_USER_TEMP_DIR)kinfold-demo.XXXX")" && cd "$HOME" && mkdir bin`
Enter
Type `cp "$KINFOLD_DEMO_BIN" bin/kinfold && printf '#!/bin/sh\necho 2.1.0\n' > bin/claude && printf '#!/bin/sh\necho 2.1.4\n' > bin/opencode && chmod +x bin/claude bin/opencode`
Enter
Type `export PATH="$HOME/bin:/usr/bin:/bin" KINFOLD_DB_KEYSTORE=none KINFOLD_NO_UPDATE_CHECK=1 KINFOLD_RELEASE_SUMS_URL="file://$KINFOLD_DEMO_SUMS" PS1='$ '`
Enter
Type "clear"
Enter
Show

Sleep 500ms
Type "kinfold --version"
Sleep 300ms
Enter
Sleep 1.5s

Type "kinfold install --dry-run"
Sleep 400ms
Enter
Sleep 2.5s

# Memory folder, agents, an observer per agent, encryption, port, update check,
# then the summary's confirmation, after which the dry run prints its plan.
Enter
Sleep 1.2s
Enter
Sleep 1.5s
Enter
Sleep 1.5s
Enter
Sleep 1.5s
Enter
Sleep 1.5s
Enter
Sleep 1.2s
Enter
Sleep 2.5s
Enter
Sleep 7s
