---
"kinfold": patch
---

A hub re-indexing a large store no longer stops answering. Vectors upkeep used to reconcile the whole vector index on the daemon's thread once a minute, and on a 700 MB encrypted store each pass held it for 2 to 3.5 seconds, so /health, recall and a paired device's dashboard waited. Upkeep now works through the index in windows of observation ids, reading only index ranges, and yields between slices; an old index left after a switch is dropped a chunk at a time. WAL checkpoints now run on a worker of their own: the daemon's connection no longer checkpoints, since the sync at the end of one held its thread for seconds on Windows. The daemon's stall watch now also names the data scan, retention, the observer's work and each request, so a slow step shows in the log by name.

A paired device now tells a busy hub from one it cannot reach. A request that times out says "<hub> is busy and didn't answer in time" and is asked again quietly; a refused connection still says the hub cannot be reached; and a pairing, sign-in or version refusal names that reason. Dashboard pages get a longer wait than recall does.

An expired or missing login is now named when the claude, codex or opencode CLI prints its error as a JSON array, as JSON lines, after a notice line, or as an error event, instead of "its command-line tool stopped with an error".

The claude-cli observer can run on a long-lived token from `claude setup-token`, for a machine where its login keeps expiring. Paste it in the dashboard's Settings, or run `kinfold install --observer-token-stdin`; setup also offers it when the login is failing. Kinfold keeps the token in the system key store and passes it only to the observer's `claude` run, in `CLAUDE_CODE_OAUTH_TOKEN`. `kinfold status` says which login the observer uses, a token that stops working says to run `claude setup-token` again, and uninstall removes it.
