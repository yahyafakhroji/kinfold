---
"kinfold": patch
---

Fixes from the 0.6.0 audit for stalls and wrong results.

The daemon answers while it works through a backlog. After a sleep or a restart it stored every waiting capture in one go, before it listened for requests; now it starts answering first and stores 200 captures at a time, with requests served in between. It asks git for a folder's project once per batch and before it opens the write, a folder whose git times out is asked again after 30 seconds and no longer once per capture, and MCP reads skip the walk through a repo's history.

Retention deletes old memories and summaries 500 at a time, up to 10,000 per run, and the next run 10 minutes later carries on. Tightening retention on a long history used to delete everything in one write and could hold the daemon for seconds. Deleting memories is faster on a large store too: a new index (schema 19, added on first start) removes a full scan per deleted memory, and the dashboard's metrics page reads its turn times through an index and reuses a summary for 30 seconds.

Capturing a long single line (a base64 blob, a minified bundle, a long dotted name) no longer hangs the capture hook. Redaction took seconds to minutes on such lines, the agent killed the hook and the event was lost. It finds the same secrets as before, with one limit: a key name that runs on for more than 256 characters after the word `token`, `password` and the like no longer counts as a key name.

Search results that match any term can be paged. Page 2 of such a search came back empty under the heading "matched every term".

`sh install.sh --observer-token-stdin` reads the token you pipe in. On a machine with a terminal it read the terminal and dropped the piped token.

`kinfold uninstall` no longer stops when one agent's config file is not valid JSON. It leaves that file alone, prints `<agent>: skipped; <file> is not valid JSON`, and still removes the service, the other agents' wiring and the program.

In OpenCode and Kilo, a session that started while the daemon was down could stay without its memory pack until the next compaction, and text from before a compaction could reappear after it. A restore started during an embedding change now waits for it and no longer opens the store twice. The observer is shown the 40 memories a long session received last, so it stops saving restatements of them as new. Background indexing no longer stalls for good when the local embedding worker exits without an error.
