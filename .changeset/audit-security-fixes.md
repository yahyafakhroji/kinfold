---
"kinfold": patch
---

BREAKING: security fixes from the 0.6.0 audit. Four things you may notice. A new install checks for updates daily and tells you, and installs nothing by itself: releases are not signed yet, so `patch` is now a choice (`kinfold install --updates patch`) and an install already at `patch` keeps it. `kinfold central join <hub>` asks for the pairing code or reads it from stdin; the code still works on the command line and in `kinfold install --central-code`, with a warning, since other programs on the machine can read a command line. The daemon makes a new token at every start, so a script that saved `daemon.token` must read it again. `KINFOLD_SQLITE3MC_LIB` is read only under `NODE_ENV=test`.

`kinfold project merge` and `kinfold project split` work again; the daemon answered 400 to every request.

`kinfold dashboard` signs in only the browser it opened. The command makes a one-time secret, and a sign-in without it gets nothing, so another program on the machine can no longer take the session by asking first. If the browser has not signed in after a few seconds, the command prints the address to open by hand. A page on another 127.0.0.1 port can no longer trigger a backup download, use up the update banner or call the hub with your dashboard session.

Kinfold no longer keeps the contents of a sensitive file an agent writes or edits (`.env`, `*.pem`, `id_rsa` and the like), or a command that names such a file; before, it withheld only the output. The secret scan now flags rows stored before this fix, so you can redact them. A private key cut off before its END line is redacted too.

A memory title containing the word "constructor" no longer stops that project's session-start memory from updating.

Also fixed: an observer setting could send the Claude login token to another provider's address; the observer followed redirects; clients sent the daemon token to whatever held the port after a crash; purge and redaction left a copy of the embedding in the search index; restore accepted a backup with database triggers or a damaged database; the hub read a request body before checking who sent it; a device name could carry terminal control characters; install could loosen a locked OpenCode folder; three downloads had no size limit while downloading; the port picker and the printed status command trusted input they should not.
