---
"kinfold": patch
---

The remaining fixes from the 0.6.0 audit. Most of them make Kinfold do less work; these are the ones you may notice.

`kinfold findings --purge <id>` finds a pending finding however old it is. It looked only at the newest 100, so after a rules update with hundreds of findings an older one read as "no pending finding".

`kinfold uninstall` names only the key store entries that exist. It printed a "kept keychain entry" line, with a delete command, for every provider Kinfold knows.

`kinfold install` checks a port you type, and asks again when another program holds it. It starts each agent's CLI once to read its version, a few at a time, where it started each one twice and one after another. If you or an agent save a config file (`~/.claude/settings.json`, `opencode.json`, a shell startup file) while the install runs, the install stops at that file and asks you to run it again; before, it wrote its own copy over your change.

The dashboard's Overview and Impact pages show a purge or a retention change at once. They kept the old counts for up to ten minutes. A browser now keeps the dashboard's script and style files between visits.

A backup is flushed to disk before `kinfold backup` reports it, and a backup whose worker stops answering fails after 30 minutes with an error.

In OpenCode and Kilo, a session still in use keeps its memory after the plugin has seen more than 256 sessions. The plugins tell the daemon about new events once per burst, not once per event.

On a hub, a paired device can no longer attach a memory to another device's session through an import.

After you replace an observer key, events that had failed retry within two minutes. The daemon asked the key store every 30 seconds until then, which on macOS starts a program each time.

Also: `kinfold scan`, `kinfold watch` with a filter, and a long Claude Code turn with the impact test on no longer hold the daemon's attention for seconds; the daemon stops cleanly when `daemon.json` is unreadable; a new index (schema 20, added on first start) speeds up the MCP timeline; and the release workflows pin each GitHub Action to a commit.
