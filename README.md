# Kinfold

Kinfold is a local memory that your coding agents share. When you work in Claude Code, OpenCode, Codex or Cursor, Kinfold records what happened, condenses it into short observations, and hands the relevant ones to the next session, in whichever agent you open next.

Everything stays on your machine. The store is a SQLite file in `~/.kinfold`, encrypted at rest, with its key in the macOS Keychain.

## What it does

- Hooks in each agent record prompts, tool calls and their results. API keys, tokens, private keys and similar secrets are redacted before anything is written.
- A background observer reads finished turns and writes short observations that cite the events they came from: decisions, fixes, gotchas and how things work.
- When a session starts, and again on each prompt, Kinfold adds a small block of related memory to the agent's context.
- An MCP server gives every agent `search`, `timeline` and `get_observations` tools.
- A local dashboard lists sessions, observations and stats, and lets you pick the model each agent's observer uses.
- You set how long each kind of data is kept, purge by session, project or agent, and scan the store for leaked secrets.

## Requirements

- macOS on Apple silicon, or 64-bit Windows 10 or 11. Linux is planned.
- WSL (preview): inside a WSL distro, install links the distro's agents to the Windows memory. It needs mirrored networking. Not supported for production use yet.
- [Bun](https://bun.sh).
- A C compiler (`xcode-select --install`). Install builds the encryption library from its pinned source.
- At least one of Claude Code, OpenCode, Codex or Cursor.

## Install

```sh
git clone https://github.com/yahyafakhroji/kinfold.git
cd kinfold
bun src/cli/kinfold.ts install --dry-run   # shows every change first
bun src/cli/kinfold.ts install
```

Install finds the agents on your machine and wires each one: hooks, the MCP server, and for OpenCode a small plugin file. It also starts the daemon as a LaunchAgent. Pick agents with `--hosts claude-code,opencode,codex,cursor`.

Check that it is running:

```sh
bun src/cli/kinfold.ts status
bun src/cli/kinfold.ts dashboard
```

To remove it, run `bun src/cli/kinfold.ts uninstall --dry-run`, then the same without `--dry-run`. Your data stays in `~/.kinfold` until you delete it.

## WSL (preview)

Run `kinfold install` inside a WSL distro after Kinfold is installed and running on Windows. Install finds the Windows install through WSL interop and wires the distro's agents to the same memory: hooks write into the Windows data folder through `/mnt/c`, and the MCP server reads through the Windows daemon. The distro keeps its own copy of the program in `~/.kinfold-wsl`. `kinfold status` there shows the link, and `kinfold uninstall` there removes only the distro's wiring; uninstall the Windows side from Windows.

WSL reaches the Windows daemon only with mirrored networking. Under the default NAT networking, the distro's `127.0.0.1` is its own, so install refuses and memory search answers "unavailable". To switch, add this to `%UserProfile%\.wslconfig` on Windows, then run `wsl --shutdown`:

```ini
[wsl2]
networkingMode=mirrored
```

`kinfold encrypt` and `decrypt` run from Windows only. A checkout under WSL is a different project from the same repository checked out on Windows.

## Choosing the observer model

Each agent's sessions are summarised by a model you choose:

| Provider | Uses | Needs |
| --- | --- | --- |
| `claude-cli` | your Claude login, through the `claude` CLI | nothing extra |
| `codex-cli` | your ChatGPT login, through `codex exec` | Codex installed and logged in |
| `opencode-cli` | the providers you signed in to in OpenCode | OpenCode 2 |
| `openrouter` | any OpenRouter model | an OpenRouter API key, kept in the Keychain |

Claude Code defaults to `claude-cli` with Haiku. The others default to OpenRouter. Change it during install with `--observer <agent>=<provider>:<model>`, for example `--observer codex=codex-cli:<model>`, or later from the dashboard.

An observer reads raw session text, which can include web pages and file contents written by someone else. So every login-based observer runs with all of its tools turned off, from an empty private folder, without your settings, hooks, plugins or MCP servers. Before Kinfold uses one, it runs a test that plants an instruction to read a file. If the model uses a tool or leaks the file's contents, Kinfold stops that observer until you fix the cause and press Re-check in the dashboard.

## Encryption

New stores are encrypted. To encrypt an existing one:

```sh
bun src/cli/kinfold.ts encrypt
```

This prints a recovery code once. Keep it somewhere safe: it restores the key on another machine, or if the Keychain loses it. `kinfold key show-recovery` prints it again, `rekey` changes the key, and `decrypt` goes back to plaintext.

## Status

Kinfold is early software and changes often. It runs from a source checkout today. A single installable binary, and packages for npm, Homebrew and other channels, are next, followed by support for more agents.

## Development

```sh
bun test
bunx tsc --noEmit
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
