# Kinfold

Kinfold gives 22 coding agents one memory. The [Supported agents](#supported-agents) table lists them and shows which were checked against a real run. What each agent can do depends on its hooks, and `kinfold status` shows it per agent. It records what each agent did, condenses it into short observations, and hands the relevant ones to the next session in whichever agent you open. The memory is a SQLite file on your machine, encrypted at rest. Kinfold ships as a single program with no runtime to install, and it's open source under Apache-2.0.

![Kinfold's setup wizard in a terminal: version, a dry-run install that walks each step, then status](assets/demo.gif)

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

To install a specific release, run `npx kinfold@<version> install`, or set `KINFOLD_VERSION` for the script: `curl … | KINFOLD_VERSION=<version> sh`, or `$env:KINFOLD_VERSION = '<version>'` before `irm`. The curl and PowerShell installers download the program for your machine and check it against the release's `SHA256SUMS` before they run it. A program installed through npm checks its own bytes against the same list before `install` changes anything. The setup wizard asks where to keep the memory, which agents to wire, which model observes each one, whether to encrypt the store, which port the daemon uses, and whether to check for updates. Add `--dry-run` to see every change first, or `--yes` to take the defaults.

Install copies the program to the `bin` folder of the memory folder (`~/.kinfold/bin` by default) and starts the daemon as a user service: a LaunchAgent on macOS, a systemd user unit on Linux, a scheduled task on Windows. It doesn't change your `PATH`, so run `~/.kinfold/bin/kinfold` or add that folder yourself. The examples below say `kinfold`.

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
- **Search.** An MCP server gives agents `search`, `timeline` and `get_observations`. Goose and Continue need the server added by hand; Warp may need a setting turned on. Search is full-text, plus semantic search when you give Kinfold an OpenRouter key for embeddings.
- **Dashboard.** `kinfold dashboard` opens a local page with sessions, observations, stats and the observer settings.
- **Data control.** `kinfold retention` sets how long each kind of data is kept, `kinfold purge` removes a session, project or agent, and `kinfold scan` checks the store for secrets that slipped through.
- **Backup and restore.** `kinfold backup <file>` writes the whole memory to one file while capture keeps running, and `kinfold restore <file>` brings it back on a fresh system. The dashboard's Backup page does both in the browser. See [Backup and restore](#backup-and-restore).
- **Updates.** `kinfold update` fetches the latest release and checks it against `SHA256SUMS` before it replaces the program.

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
| Kilo Code <sup>3</sup> | yes | no | yes | no | docs | same <sup>4</sup> |
| Cline <sup>5</sup> | yes | prompt | yes | no | docs | search only <sup>6</sup> |
| GitHub Copilot | yes | start | yes | no | docs | same |
| Antigravity <sup>7</sup> | yes | start | yes | no | docs | search only <sup>1</sup> |
| Junie <sup>8</sup> | yes | prompt | yes | no | docs | same |
| Kiro <sup>9</sup> | yes | no | yes | no | docs | search only <sup>1</sup> |
| Amp <sup>10</sup> | yes | start, prompt | yes | no | docs | same |
| Kimi Code <sup>11</sup> | yes | prompt | yes | no | docs | search only <sup>1</sup> |
| Auggie <sup>12</sup> | yes | no | yes | no | docs | same |
| Goose <sup>13</sup> | tool results | no | no | no | docs | none <sup>14</sup> |
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

## Choosing the observer model

Each agent's sessions are summarised by a model you choose:

| Provider | Uses | Needs |
| --- | --- | --- |
| `claude-cli` | your Claude login, through the `claude` CLI | nothing extra |
| `codex-cli` | your ChatGPT login, through `codex exec` | Codex 0.166 or later, logged in |
| `opencode-cli` | the providers you signed in to in OpenCode | OpenCode 2 |
| `openrouter` | any OpenRouter model | an OpenRouter API key, kept in the system key store |

Claude Code defaults to `claude-cli` with Haiku. The others default to OpenRouter. Pick one in the wizard, with `--observer <agent>=<provider>:<model>` (for example `--observer codex=codex-cli:<model>`), or later in the dashboard.

The observer sends session text to the model you picked. That text can include web pages and files someone else wrote, so every login-based observer runs with its tools off, from a private folder, without your settings, hooks, plugins or MCP servers. Before Kinfold uses Codex or OpenCode as an observer, it plants an instruction to read a file. If the model calls a tool or repeats the file's contents, Kinfold stops that observer until its version or path changes, or you press Re-check in the dashboard.

## Performance

Measured on 2026-11-12 on an Apple-silicon Mac, against a 450 MB encrypted store holding 30,747 vectors:

| What | Time or size |
| --- | --- |
| Semantic vector ranking, per search | 62 to 204 ms (2.5 s cold and 0.7 s warm before the in-memory vector cache) |
| Daemon `/health` while searches run | under 2 ms |
| Daemon memory | about 234 MB RSS |
| Loading the vector cache at start | about 0.4 s |

Ranking runs in a worker thread over a 16-bit copy of the vectors, so searches don't hold up capture or the hooks: `/health` stayed under 2 ms while they ran. Most of a semantic search's time is the embedding call to OpenRouter, which took 1.1 to 1.6 s in the same test.

## Security

- **Encrypted at rest.** The store is encrypted with [SQLite3 Multiple Ciphers](https://github.com/utelle/SQLite3MultipleCiphers). The key lives in the macOS Keychain, Windows Credential Manager or libsecret on Linux. On Linux without a working libsecret, Kinfold keeps it in a 0600 file under the XDG config folder, outside the memory folder, so copying or syncing that folder never carries the key.
- **A recovery code.** Encrypting a store prints a recovery code. It restores the key on another machine, or if the key store loses it. `kinfold key show-recovery` prints it again, `rekey` changes the key and issues a new code, and `decrypt` goes back to plaintext.
- **Redaction before storage.** API keys, tokens, private keys and similar secrets become typed markers before an event is written. Each marker carries a short reference derived from an HMAC of the value, so two mentions of one secret match without the secret being stored. Redacting an observation later also drops the vector embedded from its old text.
- **Loopback only.** The daemon listens on 127.0.0.1. Every route except `/health` needs its token, and a Host check blocks DNS rebinding.
- **No elevation.** Install, update and uninstall run as you.
- **Checked downloads.** The curl and PowerShell installers, `kinfold install` and `kinfold update` refuse a program whose SHA-256 doesn't match the release's `SHA256SUMS`. The npm packages carry the same programs, published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

What leaves your machine: session text goes to the observer model you chose, and observation text goes to OpenRouter for embeddings if you gave Kinfold an OpenRouter key.

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

- **The store that was there.** If it held no memory, as on a fresh install, it is removed. If it held memory, it is kept as `memory.db.kinfold-replaced` with its key under `db-key-replaced`, and restore prints how to switch back. Restore replaces the store. It does not merge two memories.
- **What a backup leaves out.** The OpenRouter key, which you enter again. The key behind redaction markers, so markers written after a restore don't match older markers for the same secret. Nothing old is lost. Records about the machine, such as the install channel and logs, also stay behind.
- **An unencrypted store** backs up and restores without a code. The file is then readable by anyone who has it.
- **If a restore is cut short,** `kinfold key resume` finishes it or puts the old store back.

The dashboard's Backup page downloads the same file and restores from one: choose the file, check its date and version, type the recovery code and confirm. Once you have made a backup, `kinfold status` shows when.

## WSL (preview)

Run `kinfold install` inside a WSL distro after Kinfold is installed and running on Windows. Install finds the Windows install through WSL interop and wires the distro's agents to the same memory: hooks write into the Windows data folder through `/mnt/c`, and the MCP server reads through the Windows daemon. The distro keeps its own copy of the program in `~/.kinfold-wsl`. `kinfold status` there shows the link, and `kinfold uninstall` there removes only the distro's wiring; uninstall the Windows side from Windows.

WSL reaches the Windows daemon only with mirrored networking. Under the default NAT networking, the distro's `127.0.0.1` is its own, so install refuses and memory search answers "unavailable". To switch, add this to `%UserProfile%\.wslconfig` on Windows, then run `wsl --shutdown`:

```ini
[wsl2]
networkingMode=mirrored
```

`kinfold encrypt` and `decrypt` run from Windows only. A checkout under WSL is a different project from the same repository checked out on Windows.

## Configuration

| Variable | Effect |
| --- | --- |
| `KINFOLD_DATA_DIR` | An absolute path for the memory folder instead of `~/.kinfold` |
| `KINFOLD_PORT` | The daemon's port instead of 37811 |
| `KINFOLD_VERSION` | The release the install scripts fetch |
| `KINFOLD_NO_UPDATE_CHECK=1` | Turns off the update check |

Install flags: `--hosts claude-code,opencode,codex,cursor` picks agents, `--observer <agent>=<provider>:<model>` sets an observer, `--port <n>` sets the port, and `--no-encrypt` creates a new store in plaintext.

## Uninstall

```sh
kinfold uninstall --dry-run
kinfold uninstall
```

Uninstall removes the hooks, MCP entries, plugin, service and program. Your memory stays in `~/.kinfold` until you delete it, and the stored credentials and HMAC keys stay unless you pass `--remove-credentials` or `--remove-hmac-keys`.

## Build from source

Kinfold is open source, so you can run it from a checkout, change it, and build your own program. You need git, [Bun](https://bun.sh) 1.4.4 (the version in `.bun-version`) and a C compiler (`xcode-select --install` on macOS, `build-essential` on Debian or Ubuntu), because Kinfold builds its encryption library from pinned source.

```sh
git clone https://github.com/yahyafakhroji/kinfold.git
cd kinfold
bun install
bun tools/build-sqlite3mc.ts   # builds the pinned sqlite3mc into .cache
bun tools/fetch-vec0.ts        # downloads the pinned sqlite-vec build for semantic search
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

The build embeds the sqlite3mc and sqlite-vec files from `.cache`, so build on the platform you target. `.github/workflows/release-build.yml` shows the same steps CI runs for each target.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
