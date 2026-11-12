# Kinfold

Kinfold gives Claude Code, OpenCode, Codex and Cursor one memory. It records what each agent did, condenses it into short observations, and hands the relevant ones to the next session in whichever agent you open. The memory is a SQLite file on your machine, encrypted at rest, and Kinfold ships as a single program with no runtime to install.

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

Kinfold needs at least one of Claude Code, OpenCode, Codex or Cursor. It never asks for admin or root rights.

## What it does

- **Capture.** Hooks in Claude Code, Codex and Cursor, and a plugin for OpenCode, record prompts, tool calls and their results. Secrets are redacted before anything is written.
- **Observations.** A background observer reads finished turns and writes short observations that cite the events they came from: decisions, fixes, gotchas, how things work.
- **Context.** When a session starts, Kinfold adds a small block of related memory to the agent's context. Claude Code, Codex and OpenCode also get one on each prompt.
- **Search.** An MCP server gives every agent `search`, `timeline` and `get_observations`. Search is full-text, plus semantic search when you give Kinfold an OpenRouter key for embeddings.
- **Dashboard.** `kinfold dashboard` opens a local page with sessions, observations, stats and the observer settings.
- **Data control.** `kinfold retention` sets how long each kind of data is kept, `kinfold purge` removes a session, project or agent, and `kinfold scan` checks the store for secrets that slipped through.
- **Updates.** `kinfold update` fetches the latest release and checks it against `SHA256SUMS` before it replaces the program.

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

## How it compares

Checked against each project's official pages on 2026-11-12. "Not documented" means those pages don't say, not that the feature is missing.

| | Kinfold | claude-mem | mem0 / OpenMemory | basic-memory |
| --- | --- | --- | --- | --- |
| Local, no account | Storage, yes: a daemon on 127.0.0.1. The observer uses the model account you pick | Partly; cloud sync is opt-in and the installer offers a hosted observer trial [1] | Partly. Self-hostable, but the defaults call OpenAI, and a hosted platform exists; OpenMemory is local per its launch post and still needs an OpenAI key [2][3][4] | Yes, local-first plain text; Cloud is optional [5] |
| Encrypted at rest by the tool | Yes by default, sqlite3mc | Not documented [1][8] | Not documented [2] | Not documented [5] |
| Secret redaction before storage | Yes, automatic, with HMAC markers | Content in `<private>` tags is kept out; an optional regex detector exists [1][8] | Not documented [2][3] | Not documented [5] |
| Coding agents | Claude Code, OpenCode, Codex, Cursor | 15+, some search-only [1][8] | Yes, through MCP and skills [2][4] | Yes, through MCP [5] |
| Automatic capture | Hooks and plugins, plus an observer | Hooks [1] | The library needs explicit `add()` calls [2] | A Claude Code plugin with briefings and checkpoints [5][9] |
| Search | Full-text plus semantic | FTS5 plus optional Chroma [1][8] | Semantic, BM25 and entity [2] | Full-text plus vector [5] |
| Install and runtime | One compiled program, through npx, curl or PowerShell | npx or the plugin marketplace; Node 20.19+ or 22.12+, and it installs Bun and uv if missing [1] | pip or npm; self-hosting uses Docker, and OpenMemory needs Docker plus an OpenAI key [2][3][4] | `uv tool install`; Python 3.12+ [5] |
| Platforms | macOS, Linux, Windows; WSL as a preview | Windows notes exist; others aren't listed [1] | Not documented [2][3] | Not documented [5] |
| Storage | A SQLite file, encrypted by default | SQLite plus Chroma [1] | Qdrant plus SQLite, or Postgres with pgvector [3] | Markdown files plus a SQLite index [5] |
| License | Apache-2.0 | Apache-2.0 [1] | Apache-2.0 [2] | AGPL-3.0 [5] |

Claude Code's built-in memory keeps Markdown files per project on one machine, for Claude Code only [6]. Letta Code is its own agent harness, with Letta Cloud as the default backend [7]. Neither serves other agents, so they're left out of the table.

The others are stronger in several places:
- **Hosting and sync:** mem0, basic-memory and Letta offer hosted services, and claude-mem has opt-in sync. Kinfold has no cloud.
- **Teams:** basic-memory Cloud and mem0's per-user keys share memory across people. Committed `CLAUDE.md` files do the same through git.
- **Graphs and UI:** basic-memory has a knowledge graph view, and mem0 links entities. claude-mem has a web viewer, and mem0 and OpenMemory have dashboards.
- **Plain files:** basic-memory and Claude Code keep memory as Markdown you can edit. Kinfold's encrypted store can't be edited by hand.
- **Breadth and setup:** claude-mem lists more agents, mem0 and basic-memory work through MCP, and Claude Code's built-in memory needs no setup.

Sources:
1. https://github.com/thedotmack/claude-mem
2. https://github.com/mem0ai/mem0
3. https://docs.mem0.ai/open-source/overview
4. https://mem0.ai/blog/introducing-openmemory-mcp
5. https://github.com/basicmachines-co/basic-memory
6. https://code.claude.com/docs/en/memory
7. https://github.com/letta-ai/letta-code
8. https://docs.claude-mem.ai/
9. basic-memory README, "Claude Code plugin" section

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

## Development

Kinfold is written in TypeScript and built with [Bun](https://bun.sh):

```sh
bun install
bun test
bunx tsc --noEmit
bun src/cli/kinfold.ts install --dry-run
```

`bun tools/build-release.ts <target> <version>` builds a release program. It needs a C compiler, because it builds the encryption library from pinned source.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
