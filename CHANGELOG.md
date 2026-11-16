# kinfold

## 0.5.0

### Minor Changes

- 20448a8: Everything merged since 0.4.0:
  
  - See what Kinfold recalls. After each prompt the agent shows a line naming the memories Kinfold sent, and a session starts with a short list of recent memories. This goes through `systemMessage` in Claude Code, Codex, Gemini CLI, Qwen Code, Factory Droid, Junie and Auggie, a toast in OpenCode and Kilo Code, a notification in Amp and the progress line in Copilot CLI. `kinfold watch` prints the recall line for every agent.
  - The dashboard has a Sessions page with each turn's prompt, recalled memories, reply and saved memories. Replies are stored in `prompts.reply_text` and follow prompt retention.
  - Metrics shows the tokens Kinfold adds to context, observer tokens and embedding calls. An opt-in impact test (`--holdout`) skips recall on about 1 in 10 Claude Code prompts and compares token use.
  - The observer can be turned off per agent (`--observer <agent>=off`, the wizard or the dashboard), and the wizard's observer question offers only CLIs installed on this machine.
  - `kinfold restore --undo` switches back to the store a restore replaced, keys included, and the Backup page offers the same.
  - Kilo Code captures again, with its own plugin and a recall toast. The plugin Kinfold wrote for Kilo before was refused by Kilo, so nothing was captured from it.
  - Fixes: a second CLI restore refuses at once, uninstall and first install take the update lock, purge removes `turn_usage` rows, late answers are recorded and left out of the counts, and `kinfold status` gives macOS bash users the line to add when there is no `~/.bash_profile`.
  - Migrations 12 and 13. Backups made by this version carry schema 13, which older versions refuse; older backups restore here.
- 20448a8: `kinfold size` and the dashboard Data page break the store down by part: prompts, replies, events, observations, summaries, vectors and other. Past the size warning, a line names the largest part and the setting that trims it, such as `warning: replies are 61% of 2.1 GB; set prompts retention to trim them`. Release notes now carry the version's CHANGELOG.md section, and releases come from changesets and wait for the maintainer's approval.
