# Kinfold

Kinfold gives 22 coding agents one memory. The [Supported agents](#supported-agents) table lists them and shows which were checked against a real run. What each agent can do depends on its hooks, and `kinfold status` shows it per agent. It records what each agent did, condenses it into short observations, and hands the relevant ones to the next session in whichever agent you open. The memory is a SQLite file on your machine, encrypted at rest. Kinfold ships as a single program with no runtime to install, and it's open source under Apache-2.0.

![Kinfold's setup wizard in a terminal: the list of agents, the setup questions, a progress bar and the summary of what was installed, then kinfold status in sections](assets/demo.gif)

## Install

With Node 18 or later:

```sh
npx kinfold install
```

On macOS or Linux, without Node:

```sh
curl -fsSL https://github.com/yahyafakhroji/kinfold/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/yahyafakhroji/kinfold/releases/latest/download/install.ps1 | iex
```

To install a specific release, run `npx kinfold@<version> install`, or set `KINFOLD_VERSION` for the script: `curl … | KINFOLD_VERSION=<version> sh`, or `$env:KINFOLD_VERSION = '<version>'` before `irm`. The curl and PowerShell installers download the program for your machine and check it against the release's `SHA256SUMS` before they run it. A program installed through npm checks its own bytes against the same list before `install` changes anything. The setup wizard asks where to keep the memory, which agents to wire, which model observes each one, whether to encrypt the store, which port the daemon uses, how to handle updates (off, tell you, or install patch releases and download larger ones for your yes) and whether to offer betas, what makes the vectors for semantic search, and whether to put `kinfold` on your `PATH`. The agent list shows all 22 supported agents: you can tick the ones it found, and it shows the rest as not installed. Add `--dry-run` to see every change first, or `--yes` to take the defaults.

On a terminal the install runs behind one progress bar and ends with a short summary. The full list of steps, with paths and backups, is in `~/.kinfold/logs/install.log`, and `--verbose` shows it on screen as it runs. When the output is not a terminal (a pipe, a script, CI) or under `--yes`, install prints that list as plain text and asks nothing.

Install copies the program to the `bin` folder of the memory folder (`~/.kinfold/bin` by default) and starts the daemon as a user service: a LaunchAgent on macOS, a systemd user unit on Linux, a scheduled task on Windows.

**The `kinfold` command.** On macOS and Linux, install links `~/.local/bin/kinfold` to the installed program. If `~/.local/bin` is not on your `PATH`, the wizard asks before it adds one marked block to your shell's startup file, after backing the file up:

| Shell | File |
| --- | --- |
| zsh | `~/.zshrc`, or `$ZDOTDIR/.zshrc` |
| bash | `~/.bashrc`, and also `~/.bash_profile` when that file exists, since a login shell reads it instead |
| fish | `~/.config/fish/conf.d/kinfold.fish`, a file of its own |

For any other shell, install prints the line to add. On Windows it adds `~\.kinfold\bin` to your user `PATH`, with no admin rights. The command works in terminals you open afterwards, and the summary gives the one line that makes it work in the current one.

- `--path` adds it without asking. `--no-path` adds nothing, and removes the link and the block if an earlier install added them.
- Install records your answer and follows it on later runs. It does not repeat a change you declined or restore a block you deleted.
- Install leaves an existing `~/.local/bin/kinfold` alone unless it is Kinfold's own link.
- An install in a folder other than `~/.kinfold` gets no link. Run it as `<folder>/bin/kinfold --data-dir <folder>`.
- If you installed before this step existed, an automatic update does not add the command. Run `~/.kinfold/bin/kinfold install` in a terminal and the wizard asks.

`kinfold status` shows whether `kinfold` resolves on your `PATH` and to which program. The examples below say `kinfold`.

| Platform | Program |
| --- | --- |
| macOS | arm64 and x64 |
| Linux (glibc) | x64 and arm64 |
| Windows | x64 |
| WSL | preview, see below |

Kinfold needs at least one supported coding agent. `kinfold status` lists them and shows which ones it found on your machine. It never asks for admin or root rights.

## What it does

- **Capture.** Hooks or plugins in each agent that has them record prompts, tool calls and their results. Most agents without hooks can still search Kinfold's memory through MCP. Secrets are redacted before anything is written.
- **Observations.** A background observer reads finished turns and writes short observations that cite the events they came from: decisions, fixes, gotchas, how things work.
- **Context.** Where an agent's hooks allow it, Kinfold adds a small block of related memory to the agent's context at session start, on each prompt, or both. `kinfold status` shows which.
- **Search.** An MCP server gives agents `search`, `timeline` and `get_observations`. Goose and Continue need the server added by hand; Warp may need a setting turned on. Search is full-text plus semantic. The vectors for semantic search come from a small model Kinfold carries and runs on your CPU, so it is free, works offline, and no memory text leaves the machine. You can pick OpenRouter or a local LLM server instead. See [Embeddings for semantic search](#embeddings-for-semantic-search).
- **What it recalled, on your screen.** After each prompt your agent shows one line, for example `kinfold · recalled 2 · #28771 Bun 1.4.4 is pinned · #94451 Schema version from MIGRATIONS`, or `kinfold · nothing recalled`. At session start it shows the newest memories it put in context. You see both; the model sees neither. See [Seeing what Kinfold does](#seeing-what-kinfold-does).
- **Dashboard.** `kinfold dashboard` opens a local page. Sessions shows your prompts and the agents' replies as plain text, with what Kinfold recalled for each turn. Memory, Metrics and the observer settings sit beside it.
- **Data control.** `kinfold retention` sets how long each kind of data is kept, `kinfold purge` removes a session, project or agent, and `kinfold scan` checks the store for secrets that slipped through. Purge shows what it would delete and asks first, and so does `kinfold findings --purge <id>`, which shows the finding and never the secret. A script passes `--yes`. Without a terminal or `--yes`, neither deletes anything.
- **Backup and restore.** `kinfold backup <file>` writes the whole memory to one file while capture keeps running, and `kinfold restore <file>` brings it back on a fresh system. The dashboard's Backup page does both in the browser. See [Backup and restore](#backup-and-restore).
- **Updates.** Pick a level with the wizard's Updates question, `kinfold install --updates off|notify|patch`, or the dashboard's Data page. `patch` is the default. `notify` checks once a day and tells you; nothing installs by itself. `off` stops checking.
- **Patch releases** (0.2.0 to 0.2.1) install themselves at the `patch` level: the daemon checks once a day, waits until nothing has reached it for ten minutes (a hook event, a context request, an MCP read, the dashboard or a restore), then runs the same steps as `kinfold update`. The updater checks for quiet again after the download and waits up to 30 minutes for it. A failed update leaves the running version in place and is tried again after the next daily check. The next session, `kinfold status` and the dashboard tell you when an update happened. An automatic update runs its install with the agent home variables (`CODEX_HOME`, `XDG_CONFIG_HOME` and the like) that your last install ran with; `kinfold status` lists them.
- **Minor and major releases never install without you.** At the `patch` level the daemon downloads the new program in the background, checks it against that release's `SHA256SUMS`, and keeps it in `~/.kinfold/updates/` (one release at a time; a failed check deletes it). It then tells you once at the next session start, for example `Kinfold 0.6.0 is ready · 3 changes, 1 breaking · kinfold update to install`, and the dashboard shows the release's changelog lines, breaking ones first, with an Install button. `kinfold update` or the button installs it, after checking the downloaded program against `SHA256SUMS` again. The daemon restarts during the install, so the dashboard waits for it and reloads; sign in again with `kinfold dashboard`. Breaking lines are the release's major changes and the ones its changelog marks `BREAKING:`.
- **Betas.** `kinfold install --beta` (or the wizard, or the dashboard) offers prereleases such as 0.6.0-beta.1 the same way, each waiting for your yes, and a running beta is offered the next beta or the final release. `--no-beta` turns it off; that never downgrades, so a running beta waits for the next final release above it.
- **Where you see update news.** Claude Code, Codex, Gemini CLI and the other agents with a user line show it there, OpenCode and Kilo Code as a toast, and Copilot CLI on its progress line. No update notice goes into a model's context. Agents with no user line (Cursor, Cline, Kiro, Antigravity and a few more) leave it to `kinfold status`, the dashboard banner and `kinfold watch`; their status line says so. A build from a checkout is never offered an update.

## Supported agents

What Kinfold wires for each agent on macOS and Linux. **Observer** is `yes` when the agent's own login can run the observer model. **Checked** is `live` when the profile was tested against a real run of the agent, and `docs` when it was built from the agent's docs. **Windows** compares Windows with the other two.

<!-- agents:start -->
| Agent | Captures | Context | Search | Observer | Checked | Windows |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | yes | start, prompt | yes | yes | live | same |
| OpenCode | yes | no | yes | yes | live | same |
| Codex | yes | start, prompt | yes | yes | live | same |
| Cursor | yes | start | yes | no | live | same |
| Gemini CLI | yes | start, prompt | yes | no | docs | same |
| Qwen Code | yes | start, prompt | yes | no | docs | same |
| Factory Droid | yes | start, prompt | yes | no | docs | search only <sup>1</sup> |
| Devin <sup>2</sup> | yes | start, prompt | yes | no | docs | search only <sup>1</sup> |
| Kilo Code <sup>3</sup> | yes | start, prompt | yes | no | live | same <sup>4</sup> |
| Cline <sup>5</sup> | yes | prompt | yes | no | docs | search only <sup>6</sup> |
| GitHub Copilot | yes | start | yes | no | docs | same |
| Antigravity <sup>7</sup> | yes | start | yes | no | docs | search only <sup>1</sup> |
| Junie <sup>8</sup> | yes | prompt | yes | no | docs | same |
| Kiro <sup>9</sup> | yes | no | yes | no | docs | search only <sup>1</sup> |
| Amp <sup>10</sup> | yes | start, prompt | yes | no | docs | same |
| Kimi Code <sup>11</sup> | yes | prompt | yes | no | docs | search only <sup>1</sup> |
| Auggie <sup>12</sup> | yes | no | yes | no | docs | same |
| Goose <sup>13</sup> | tool results | no | no | yes | docs | none <sup>14</sup> |
| Crush <sup>15</sup> | no | no | yes | no | docs | same |
| Zed <sup>16</sup> | no | no | yes | no | docs | same <sup>17</sup> |
| Continue <sup>18</sup> | no | no | no | no | docs | same |
| Warp <sup>16</sup> | no | no | yes | no | docs | same |

1. Hooks stay off on Windows until the hook command is checked against the shell the agent runs them in.
2. Runs Claude Code's hooks when Claude Code is wired; not yet checked on a live run.
3. The config folder can't be moved with an environment variable.
4. The Windows config folder is unconfirmed, and no environment variable moves it.
5. Context on each prompt reaches the VS Code extension only, not the Cline CLI.
6. The agent's hooks don't run on Windows.
7. Tool calls are recorded without their output; later prompts in a conversation may be missed.
8. Events without a session id are not recorded; the docs show one only on session start and prompts.
9. Needs Kiro CLI V3; tool output is recorded only if the agent sends it.
10. Run `amp plugins list` to check that the plugin loaded.
11. Session-start output is dropped, so context arrives with each prompt.
12. Hook output never reaches the agent, and the assistant's reply is not recorded.
13. Records tool calls only; search needs the MCP server added to config.yaml by hand.
14. Nothing is wired on Windows; search needs the MCP server added to config.yaml by hand.
15. Hooks live in crushrc, which Kinfold can't edit safely; add the `hook add` lines by hand to record tool calls.
16. The agent has no hooks.
17. The agent has no hooks; add the MCP entry by hand, no Windows settings path is documented.
18. The agent has no hooks; search needs the MCP block added to ~/.continue/config.yaml by hand.
<!-- agents:end -->

## Seeing what Kinfold does

**The recall line.** Kinfold builds the line from the memory ids it sent with that prompt, so the line and the model's context match. It names two kinds of memory: memory related to your prompt, and memory other sessions wrote since this one last received any. A missing line means Kinfold did not run. If the daemon is down, the line says so and your prompt is captured once the daemon starts.

**Where it shows.**

| Agents | How |
|---|---|
| Claude Code, Codex, Gemini CLI, Qwen Code, Factory Droid, Junie, Auggie | A message from the hook, on session start and on each prompt. Codex and Droid style it as a warning. |
| OpenCode | Toasts: the list when a session starts, then a line for each prompt. Install adds a small folder, `kinfold-recall`, beside the plugin in `~/.config/opencode/plugins/`. |
| Kilo Code | The same toasts. Install writes `~/.config/kilo/kinfold-recall/tui.js` and adds its path to `plugin` in `~/.config/kilo/tui.json`, after a backup. Uninstall takes out only that entry. |
| GitHub Copilot CLI | An info row, through Copilot's progress line. At session start it is one line: the project, how many memories it holds, and how many are in this session's context. Built from Copilot's source, not yet checked on a live run. |
| Amp | A notification from the plugin. |
| Every other agent | `kinfold watch` and the dashboard. |

**`kinfold watch`** prints one line per prompt for every agent, with the time, the agent and the project. `--host <agent>` and `--project <name>` narrow it. Ctrl-C stops it.

**`kinfold watch --debug`** adds the reasons. For each prompt it prints how long the hook waited and whether the daemon answered in time, how the search matched (keyword or meaning, and which embedding model), the prompt's terms, each candidate with its distance and matched terms and why it was sent or left out (below the cutoff, already delivered, over the 200-token budget), the new memory from other sessions, and what was sent. At a Claude Code turn end it prints the turn's usage from the transcript beside the tokens Kinfold added. It also shows session-start packs and observer runs. `--json` prints one JSON object per event for scripts. The daemon records the trace only while a debug watch is connected and keeps it in memory (the last few hundred events, gone after a restart). The prompt hook makes no extra request for it.

**Sessions in the dashboard.** Open a session to read it turn by turn: your prompt, the memories recalled, the agent's reply, and the memories saved from that turn. Prompt and reply are the stored text after the secret scan, so a secret shows as its redaction marker. The AI summary of a turn is folded away under it. Replies follow the prompts retention setting.

**Turning the line off.** Run `kinfold install --no-show-recall`, or use the switch on the dashboard's Data page. Memory still reaches the model.

**What it costs.** The Metrics page shows, per agent, the tokens Kinfold added to context per session and per prompt, the tokens the observer spent where its provider reports them, and embedding calls. These numbers start on the day your store was upgraded, and the page shows that date.

**The impact test (opt-in).** `kinfold install` asks about it when you pick Claude Code, and the answer is no unless you saved a yes before. `--holdout`, `--no-holdout` or the switch on the Data page turn it on or off. The test measures what memory changes: about 1 prompt in 10 on Claude Code goes without recalled memory, and the line says `kinfold · recall held out for this prompt (impact test)`. Kinfold then reads that turn's token counts from Claude Code's transcript, and nothing else from it. The Metrics page sets held-out turns beside normal turns of the same projects: median tokens, tool calls and time per turn, with sample sizes. Below 30 turns in either group it says "not enough turns yet". Other agents keep full recall. `kinfold status` says when the test is on.

## Choosing the observer model

Each agent's sessions are summarised by a model you choose. Some providers borrow a CLI login you already have, and the others call a model API with your own key:

| Provider | Uses | Needs | Default model |
| --- | --- | --- | --- |
| `claude-cli` | your Claude login, through the `claude` CLI | nothing extra | `haiku` |
| `codex-cli` | your ChatGPT login, through `codex exec` | Codex 0.166 or later, logged in | none |
| `opencode-cli` | the providers you signed in to in OpenCode | OpenCode 2 | none |
| `goose-cli` | a provider key you gave Goose, through `goose run` | Goose 1.59 or later | none |
| `openrouter` | any OpenRouter model | an OpenRouter API key | `openrouter/auto` |
| `anthropic-api` | the Anthropic API | an Anthropic API key | `claude-haiku-5-5` |
| `openai-api` | the OpenAI API | an OpenAI API key | `gpt-6-luna` |
| `gemini-api` | the Gemini API | a Google AI Studio key | `gemini-3.5-flash-lite` |
| `qwen-api` | Qwen through DashScope | a DashScope key and its region's address | `qwen3.8-flash` |
| `openai-compatible` | any server with an OpenAI-style chat API: Ollama, LM Studio, Groq, DeepSeek, Together, Mistral | its address, and a key unless it runs on this machine | none |

Keys go in the system key store (Keychain, Credential Manager or libsecret, or a 0600 key file where there is none), never on a command line or in a log. The default models are each vendor's cheapest fast tier, since the observer only writes short summaries.

Claude Code defaults to `claude-cli` with Haiku. The others default to OpenRouter. Pick one in the wizard, with `--observer <agent>=<provider>:<model>` (for example `--observer codex=anthropic-api:claude-haiku-5-5`), or later in the dashboard. A CLI provider is offered only when its CLI is installed.

- `openai-compatible` takes `--observer-endpoint <url>`. The address must use https, or plain http on this machine: `http://127.0.0.1:11434/v1` for Ollama, `http://127.0.0.1:1234/v1` for LM Studio. A server on this machine needs no key. Setup asks for a key for any other server; for one that needs none, clear the Keychain entry on the dashboard Models page. Small local models often return JSON that misses a field the observer needs; a 1.5B model did in our test, so pick a 7B model or larger.
- `qwen-api` uses the Singapore address `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` unless you give another. A DashScope key works only with the region it was created in.
- `goose-cli` models are `<goose provider>/<model>`, such as `anthropic/claude-haiku-5-5` or `ollama/qwen2.5:7b`. The goose provider must be one that calls a model API: `anthropic`, `openai`, `google`, `openrouter`, `xai`, `ollama` or `tetrate`. Goose providers that run another agent's CLI, such as `claude-code` or `codex`, are refused, because that agent's tools would run where Goose cannot show them.
- Auggie is listed and cannot be picked. Its docs describe the switches a safe run needs, but a live check needs an Augment account and the docs do not describe its JSON output.

The wizard says why an agent's own CLI is not offered. Most agent CLIs have no switch that turns every tool off, so they could act on what a session tells them; Cline, Cursor, Kimi Code and Factory Droid run tools on their own in headless mode.

To stop summaries for one agent, pick "off (capture only, no summaries)" in the wizard or pass `--observer <agent>=off`. Kinfold still captures that agent's prompts and replies, shows them in Sessions, and recalls memory that exists. Turns captured while the observer is off are not summarised later, so turning it back on starts from the next turn.

The observer sends session text to the model you picked. That text can include web pages and files someone else wrote. An API provider gets no tools in its request, so no tool can run, and an answer that asks for one is refused. Every login-based observer runs with its tools off, from a private folder, without your settings, hooks, plugins or MCP servers. Before Kinfold uses Codex, OpenCode or Goose as an observer, it plants an instruction to read a file. If the model calls a tool or repeats the file's contents, Kinfold stops that observer until its version or path changes, or you press Re-check in the dashboard.

## Embeddings for semantic search

Semantic search compares vectors, and something has to turn each memory and each query into one. You pick what:

| Embedder | Runs | Costs | Needs |
| --- | --- | --- | --- |
| `local` (default) | all-MiniLM-L6-v2, bundled, on your CPU | nothing | nothing |
| `openrouter` | `openai/text-embedding-3-small` at OpenRouter | OpenRouter's price per token | an OpenRouter API key; memory text goes to OpenRouter |
| `local-llm` | an OpenAI-style `/embeddings` server on this machine, such as Ollama or LM Studio | nothing | the server's address on loopback and a model name |

Pick one in the wizard, with `--embeddings local`, `--embeddings openrouter` or `--embeddings local-llm:<model>@<url>` (for example `--embeddings local-llm:nomic-embed-text@http://127.0.0.1:11434/v1`), or on the dashboard's Models page. A local LLM address must be 127.0.0.1, localhost or ::1, and Kinfold asks the server for one embedding before it saves the choice. The embedding address and the OpenAI-compatible observer's endpoint are separate settings, but setting up either one offers the other's address on this machine as its default.

Each embedder and model has its own index. When you switch, Kinfold builds the new index in the background, about 64 memories every 10 seconds with the local model, and search keeps using the old one until the new index is complete. Then search moves over and the old vectors are deleted. Leaving OpenRouter or a local LLM server is the exception: queries stop going there at once, so semantic search falls back to keywords until the new index is ready. A store that already has OpenRouter vectors stays on OpenRouter until you switch. Any other store moves to the local model, even with an OpenRouter key, since that key may be there only for the observer.

The local model and its runtime make the program about 36 MB larger: the model is 23 MB and the WebAssembly build of [ONNX Runtime](https://onnxruntime.ai) that runs it is 12 MB. Both are inside the program, checked against pinned SHA-256 hashes, and never downloaded at run time. The model runs in a worker thread on one core, so capture and the hooks don't wait for it, and a search query goes ahead of any indexing.

## Performance

Measured on 2026-11-16 by `src/vectors/knn-bench.test.ts` on an Apple-silicon Mac, against a store seeded with 50,000 vectors of 384 dimensions:

| What | Time |
| --- | --- |
| Nearest 10 across every project, through the index | 26 ms (38 ms for a full scan) |
| Nearest 10 in one project of 2,500 vectors | 1.4 ms (8.5 ms for a scan) |
| Loading the local model | 0.2 to 1 s on the five release targets |
| Embedding three short texts with the local model | 39 to 176 ms on the same runners |

Each embedding space has a [sqlite-vec](https://github.com/asg017/sqlite-vec) `vec0` index inside the store, partitioned by project, so a search reads one project's vectors instead of every row. The index only proposes candidates: the exact distances and the filters come from the stored vectors. Searches run in a worker thread on their own connection, so they don't hold up capture or the hooks.

## Security

- **Encrypted at rest.** The store is encrypted with [SQLite3 Multiple Ciphers](https://github.com/utelle/SQLite3MultipleCiphers). The key lives in the macOS Keychain, Windows Credential Manager or libsecret on Linux. On Linux without a working libsecret, Kinfold keeps it in a 0600 file under the XDG config folder, outside the memory folder, so copying or syncing that folder never carries the key.
- **A recovery code.** Encrypting a store prints a recovery code. It restores the key on another machine, or if the key store loses it. `kinfold key show-recovery` prints it again, `rekey` changes the key and issues a new code, and `decrypt` goes back to plaintext.
- **Redaction before storage.** API keys, tokens, private keys and similar secrets become typed markers before an event is written. Each marker carries a short reference derived from an HMAC of the value, so two mentions of one secret match without the secret being stored. Redacting an observation later also drops the vector embedded from its old text.
- **Loopback only.** The daemon listens on 127.0.0.1. Every route except `/health` needs its token, and a Host check blocks DNS rebinding. A hub for [central memory](#one-memory-for-all-your-devices) also listens on its Tailscale address, where only paired devices of your own Tailscale user get an answer.
- **No elevation.** Install, update and uninstall run as you.
- **Two runtime dependencies.** The program bundles [`@clack/prompts`](https://github.com/bombshell-dev/clack) to draw the CLI's output on a terminal, and [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) to run the local embedding model. Both are pinned to an exact version. The hook, the MCP server and the daemon do not load clack, and a test enforces that. Only the daemon's embedding worker loads ONNX Runtime.
- **Checked downloads.** The curl and PowerShell installers, `kinfold install` and `kinfold update` refuse a program whose SHA-256 doesn't match the release's `SHA256SUMS`. The npm packages carry the same programs, published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

What leaves your machine: session text goes to the observer model you chose (nothing leaves when that model runs on this machine), and observation text goes to OpenRouter for embeddings only if you choose OpenRouter as the embedder. The local model and a local LLM server keep it on this machine.

## Backup and restore

Before you reinstall your operating system or move to another machine, save the memory to a file:

```sh
kinfold key show-recovery     # write the recovery code down, away from this machine
kinfold backup ~/kinfold.kfb
```

The backup is a consistent copy of the store, taken while agents keep working. It stays encrypted with the store's own key, and the file holds no key, recovery code or token. Keep the recovery code somewhere else: restore needs it, and the reinstall wipes the key store that holds the key.

On the new system, install Kinfold, then restore:

```sh
kinfold install
kinfold restore ~/kinfold.kfb
```

Restore asks for the recovery code and checks that it opens the backup before it changes anything. A wrong code, a damaged file or a backup from a newer Kinfold leaves the current memory as it was. An older backup is migrated forward. The daemon keeps running: it closes the store, swaps in the backup and opens it again.

- **The store that was there.** If it held no memory, as on a fresh install, it is removed. If it held memory, it is kept as `memory.db.kinfold-replaced` with its key under `db-key-replaced`, and `kinfold status` mentions it. Restore replaces the store. It does not merge two memories.
- **What a backup leaves out.** The OpenRouter key and any other observer key, which you enter again. The key behind redaction markers, so markers written after a restore don't match older markers for the same secret. Nothing old is lost. Records about the machine, such as the install channel and logs, also stay behind.
- **An unencrypted store** backs up and restores without a code. The file is then readable by anyone who has it.
- **Switching back.** `kinfold restore --undo` puts the kept store back in use, with no recovery code, and keeps the restored one in its place, so you can switch again. It refuses when nothing is kept, when the kept store's key doesn't open it, or while a backup or restore is running.
- **If a restore or a switch back is cut short,** `kinfold key resume` finishes it or puts things back as they were.

The dashboard's Backup page downloads the same file and restores from one: choose the file, check its date and version, type the recovery code and confirm. When a store is kept, the page offers to switch back to it, with the date it was replaced. Once you have made a backup, `kinfold status` shows when.

## One memory for all your devices

If your machines are on one [Tailscale](https://tailscale.com) tailnet, one of them can hold the memory for all of them. Pick a machine that is usually on, such as a Mac mini, and make it the hub:

```sh
kinfold central serve
```

It shows a code, valid for 10 minutes and for one device, and the command to run on that device:

```sh
kinfold central join mini.tail1234.ts.net KF-4821-9TQX
```

From then on the device's agents capture into the hub's memory and recall from it. `kinfold central invite` on the hub gives a code for the next device. A fresh device can join while it installs with `kinfold install --central <hub>`.

- **Your projects when you join.** Joining copies each project the hub has never seen from the device's own memory: sessions, prompts and replies, observations and summaries. The hub embeds the copied observations itself. A project the hub already has keeps the hub's version. Joining leaves the device's own memory as it was, and `kinfold central import --project <key>` copies a kept project in later, adding only what the hub doesn't have yet.
- **Project identity.** A project with a git remote is the same project on every device. A folder without one, such as `~/scratch`, belongs to the device it is on, so two devices' scratch folders never mix.
- **When the hub is away.** Captures wait on the device, which sends them when the hub is back. Recall says `kinfold · central memory unreachable; this prompt is saved and will be sent when it's back` instead of making the prompt wait.
- **What a device can do.** Read and capture: recall, search, MCP reads, and the dashboard's Sessions, Memory and Metrics pages, all showing the hub's memory. Anything that changes or removes stored memory runs on the hub only: purge, retention, findings, backup, restore, encrypt, decrypt, rekey, key recover and observer settings. The device's dashboard shows those controls disabled with "run this on the hub".
- **Where things run.** The device redacts and strips `<private>` before anything leaves it, and works out project keys itself. The hub runs the observer with its own settings, embeds recall queries, and never reads a device's files. Keys, recovery codes and provider keys stay on their own machine.
- **Versions.** The hub and its devices must run the same major.minor version. When they don't, recall says which side to update, and captures wait until they match.
- **Managing devices.** `kinfold central devices` lists them on the hub and `kinfold central remove <device>` revokes one at once. `kinfold central leave` on a device returns it to its own memory; what it captured centrally stays on the hub. `kinfold central serve --off` stops being the hub. `kinfold status` shows which mode a machine is in, whether the hub answers and how many captures are waiting.

How Kinfold keeps it private: the hub listens on its Tailscale address only, on port 37812, never on a LAN or public address. Only nodes owned by the hub's own Tailscale user can pair; shared-in and tagged nodes are refused. Pairing proves the code on both sides without sending it, and gives the device its own Ed25519 key. The device signs every request with that key, the hub checks it against the node the device paired from, and the hub signs every answer. Tailscale encrypts the traffic.

## WSL (preview)

Run `kinfold install` inside a WSL distro after Kinfold is installed and running on Windows. Install finds the Windows install through WSL interop and wires the distro's agents to the same memory: hooks write into the Windows data folder through `/mnt/c`, and the MCP server reads through the Windows daemon. The distro keeps its own copy of the program in `~/.kinfold-wsl`. `kinfold status` there shows the link, and `kinfold uninstall` there removes only the distro's wiring; uninstall the Windows side from Windows.

WSL reaches the Windows daemon only with mirrored networking. Under the default NAT networking, the distro's `127.0.0.1` is its own, so install refuses and memory search answers "unavailable". To switch, add this to `%UserProfile%\.wslconfig` on Windows, then run `wsl --shutdown`:

```ini
[wsl2]
networkingMode=mirrored
```

`kinfold encrypt` and `decrypt` run from Windows only. A checkout under WSL is a different project from the same repository checked out on Windows. A desktop app that runs on Windows reads its Windows settings, so wire it from the Windows install.

What is tested: every agent's wiring in a linked distro, its hooks spooling into the Windows folder, and its recall channel, all against fakes. CI also runs the built programs on a Windows runner with an Ubuntu WSL2 distro: the distro finds the Windows install, install refuses under NAT, and a hook run in the distro lands in the Windows memory. The last hop, the distro reaching the Windows daemon over loopback, is checked only by fakes. GitHub's Windows Server 2025 runners refuse mirrored networking (WSL falls back with error 0x803b0015), so no CI run can cover it, and WSL stays in preview until it has run on a Windows 11 machine.

## Output

On a terminal, each command draws a short frame: `status` groups its lines into sections with a mark on each row, the commands that ask (`encrypt`, `decrypt`, `rekey`, `restore`, `key recover`, `purge`) ask inside it and mask a recovery code as you type, and the ones that take a while (`backup`, `restore`, `rekey`, `update`) show a spinner and end on one result line. Ctrl+C at a question stops the command with nothing changed. Paths under your home folder are shown as `~/...`.

When the output is not a terminal, every command prints the same plain lines as before, with full paths, so scripts and logs keep working. Add `--plain` to get those lines on a terminal too, for example `kinfold status --plain`.

## Configuration

| Variable | Effect |
| --- | --- |
| `KINFOLD_DATA_DIR` | An absolute path for the memory folder instead of `~/.kinfold` |
| `KINFOLD_PORT` | The daemon's port instead of 37811 |
| `KINFOLD_VERSION` | The release the install scripts fetch |
| `KINFOLD_NO_UPDATE_CHECK=1` | Set when you run `kinfold install`: turns off the update check, and automatic updates with it. Install saves it, since the daemon does not read your shell's environment |
| `KINFOLD_NO_AUTO_UPDATE=1` | Set when you run `kinfold install`: keeps the update check and turns off automatic patch updates. Install saves it, since the daemon does not read your shell's environment |

Install flags: `--hosts claude-code,opencode,codex,cursor` picks agents, `--observer <agent>=<provider>:<model>` sets an observer, `--observer-endpoint <url>` gives `openai-compatible` or `qwen-api` its address, `--port <n>` sets the port, `--no-encrypt` creates a new store in plaintext, `--updates off|notify|patch` sets the updates level, and `--beta` or `--no-beta` turns the beta channel on or off. The older `--no-update-check`, `--no-auto-update` and `--auto-update` still work: they set `off`, `notify` and `patch`.

## Uninstall

```sh
kinfold uninstall --dry-run
kinfold uninstall
```

Uninstall removes the hooks, MCP entries, plugin, service and program. It also removes the `~/.local/bin/kinfold` link if it still points at Kinfold, the marked block from your shell's startup file, and the Windows `PATH` entry. Your memory stays in `~/.kinfold` until you delete it, and the stored credentials and HMAC keys stay unless you pass `--remove-credentials` or `--remove-hmac-keys`.

## Build from source

Kinfold is open source, so you can run it from a checkout, change it, and build your own program. You need git, [Bun](https://bun.sh) 1.4.4 (the version in `.bun-version`) and a C compiler (`xcode-select --install` on macOS, `build-essential` on Debian or Ubuntu), because Kinfold builds its encryption library from pinned source.

```sh
git clone https://github.com/yahyafakhroji/kinfold.git
cd kinfold
bun install
bun tools/build-sqlite3mc.ts   # builds the pinned sqlite3mc into .cache
bun tools/fetch-vec0.ts        # downloads the pinned sqlite-vec build for semantic search
bun tools/fetch-model.ts       # downloads the pinned embedding model and checks every file
```

Run the tests and the type check:

```sh
bun test
bun run typecheck
```

Run any command from source with `bun src/cli/kinfold.ts`, for example `bun src/cli/kinfold.ts install --dry-run`. A source run reports version `0.0.0-dev` and skips the release checksum check. It wires your real agents and service the same way a release does, so try changes with `--dry-run` first, or give the run a throwaway home: `HOME=$(mktemp -d) bun src/cli/kinfold.ts install --dry-run`.

To build a single program for this machine, pick its target (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` or `windows-x64`) and a version:

```sh
bun tools/build-release.ts darwin-arm64 0.1.0-local.1
./dist/kinfold-darwin-arm64 --version
```

The build embeds the sqlite3mc, sqlite-vec and embedding model files from `.cache`, so build on the platform you target. `./dist/kinfold-<target> embed-check` loads the bundled model and embeds three fixed texts, which shows the program carries a working model. `.github/workflows/release-build.yml` shows the same steps CI runs for each target.

## Changes and releases

Every pull request that changes what users get (anything under `src/`, `scripts/`, `tools/` or `npm/`, or the packaging files) adds a changeset, and CI fails one that doesn't:

```sh
bunx changeset          # pick patch, minor or major, then write the changelog line
bunx changeset --empty  # a docs or tests change with no release note
```

Start the line with `BREAKING:` for any change a script or user could notice, in 0.x too. `.changeset/README.md` has the details.

Releases come from those files:

1. Each merge to main opens or updates one pull request named `Version x.y.z`. It runs `changeset version`, which sets the version in `package.json` and writes `CHANGELOG.md`.
2. The maintainer merges that pull request, and the merge tags `vx.y.z`. The release workflow builds every program, smoke-tests them on each OS against a GitHub prerelease, then promotes the Release and publishes to npm. The Release notes carry that version's `CHANGELOG.md` section.

Nothing is published without the maintainer's approval. The jobs that create the GitHub Release, promote it and publish to npm run in the `release` environment, which has the maintainer as its required reviewer. A release pauses at each of those jobs until the maintainer clicks "Approve and deploy" on the run; the builds and the smoke run without waiting. npm's trusted publisher for each package is pinned to the `release` environment, so a publish from outside it is refused. Only admins and GitHub Actions can create `v*` tags, and no one can move or delete one.

Betas come from the `beta` branch in changesets pre mode (`bunx changeset pre enter beta` there). Its versions look like `0.6.0-beta.1` and publish as GitHub prereleases and under npm's `next` tag. Main never enters pre mode, so patches keep shipping from main while a beta runs. A push to `beta` can publish a prerelease, so give `beta` the same ruleset as main before you create it. To end a beta, run `bunx changeset pre exit` on `beta` and merge it into main; its changesets then go into main's next Version PR.

If a release never started after its tag was pushed, the next push to main starts it, or you can start it yourself with `gh workflow run release.yml --ref v<version>`.

The version workflow uses the workflow's own token, so the repository needs "Allow GitHub Actions to create and approve pull requests" turned on (Settings, Actions, General). A pull request opened by that token gets no CI run of its own. The version pull request changes only `package.json`, `CHANGELOG.md` and `.changeset/`, and it needs the maintainer's merge.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
