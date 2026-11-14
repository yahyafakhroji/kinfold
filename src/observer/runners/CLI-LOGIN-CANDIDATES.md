# CLI login observer candidates

Which agents could run the observer through the user's own CLI login, and why
each one is in or out. `CLI_LOGIN_PROVIDERS` in `../types.ts` lists the ones
that are in.

The observer reads untrusted session text, so a CLI becomes a provider only
when its official docs confirm all three:

1. **Headless**: a non-interactive mode that takes a prompt and exits.
2. **All tools off**: a documented way to turn off every tool (built-in, MCP,
   sub-agents, web), and to keep user settings, hooks and plugins out of the run.
3. **Login reuse**: the headless run uses the login the user already has, with
   no API key.

A provider also needs a documented (or captured) output format that shows tool
calls, because the shared core rejects a run on any tool event.

Docs were read on 2026-11-14. None of these CLIs was run; every entry is from
the docs alone.

## In

| Provider | Agent | Checked against |
|---|---|---|
| `codex-cli` | Codex | codex 0.166 docs and source (see `codex-cli.ts`) |
| `opencode-cli` | OpenCode | opencode 2.1.4 docs and source (see `opencode-cli.ts`) |

## Out

| Agent | Headless | All tools off | Login reuse | Fails on |
|---|---|---|---|---|
| Auggie | yes | yes, by reading two flags together | yes | undocumented output format |
| Gemini CLI | yes | no single switch | yes | all tools off |
| Copilot CLI | yes | no | yes | all tools off |
| Kiro | yes | not documented | no | login reuse |
| Amp | yes | not documented | no | login reuse |
| Factory Droid | yes | no | not stated | login reuse, all tools off |
| Qwen Code | yes | no | no | login reuse, all tools off |
| Kimi Code | yes | not documented | not stated | all tools off, login reuse |

### Auggie

Passes the three tests on paper. Blocked on the output format.

- Headless: `auggie --print --mode json`, "Output structured JSON events for
  automation workflows". Stdin is read as context.
  https://docs.augmentcode.com/cli/reference
- All tools off: `--no-tools`, "Disable all built-in tools". The docs do not
  say this covers MCP tools. No flag turns hooks, user MCP servers or custom
  commands off, so a run would have to move the whole config dir to an empty
  private folder with `--augment-cache-dir` ("Relocate the Augment config and
  cache directory (default `~/.augment`)") and pass an empty `--mcp-config`
  ("overrides MCP servers defined in settings files"), with `--no-rules`,
  `--no-skills`, `--no-extensions` and `--no-session`. Hooks and MCP servers in
  `/etc/augment/settings.json` cannot be redirected; a run would have to be
  refused while that file exists. https://docs.augmentcode.com/cli/hooks
- Login reuse: "login to create an authentication session that can be used by
  Auggie in both interactive and automation modes".
  https://docs.augmentcode.com/cli/setup-auggie/authentication
  With the config dir moved, the login is handed over by path with
  `--augment-session-json` ("Authenticate with inline session JSON or a session
  file"); `auggie auth login` "Creates a session file at
  `~/.augment/session.json`". https://docs.augmentcode.com/cli/sdk
- Blocker: the docs do not describe the `--mode json` events, so tool calls
  cannot be told apart from text.
- Other limits: the system prompt can only be appended
  (`--append-system-prompt`), Auggie 1.x is a prerelease, and the install page
  lists macOS, Linux and WSL, with no native Windows.

To unblock: capture real `auggie --print --mode json --no-tools` output, once
for a plain answer and once for a run where the model calls a tool (without
`--no-tools`). Then write a parser that fails closed on any event it does not
know, and add `auggie-cli` behind the planted-instruction safety gate.

### Gemini CLI

Fails **all tools off**.

- Headless: `gemini -p -o stream-json`, with `tool_use` and `tool_result`
  events. https://geminicli.com/docs/cli/headless/
- Login reuse: "Headless mode will use your existing authentication method, if
  an existing authentication credential is cached".
  https://geminicli.com/docs/get-started/authentication/
- All tools off: no documented switch. The policy engine says `*` "Matches any
  tool (built-in or MCP)" and that globally denied tools are "completely
  excluded from the model's memory", but shows no deny-all example. A policy
  can reach one run only through a planted system settings file
  (`GEMINI_CLI_SYSTEM_SETTINGS_PATH` with `adminPolicyPaths`), and such
  policies "are ignored if any `.toml` policy files are found in the standard
  system location". How system settings merge over user settings is not
  documented, and nothing skips `~/.gemini/settings.json` or `GEMINI.md`.
  https://geminicli.com/docs/reference/policy-engine/
- Also: "Unpaid tier and Google One users: Gemini CLI was replaced by
  Antigravity CLI on June 18th, 2026" (banner on every docs page).

### Copilot CLI

Fails **all tools off**.

- Headless: `copilot -p -s --output-format json`.
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- Login reuse: the OAuth token from `copilot login` is read from the system
  keychain when no token env var is set.
  https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- All tools off: `--available-tools` ("Restrict the model to only the tools you
  list; all other tools are unavailable") has no documented empty form.
  `--deny-tool` works per kind (`shell`, `write`, `read`, `url`, `memory`, or
  an MCP server by name) with no catch-all. Hooks can only be turned off in
  `settings.json` (`disableAllHooks`).
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- Also: the JSONL events of `-p --output-format json` are not documented.

### Kiro

Fails **login reuse**.

- "Headless mode requires an API key set as the `KIRO_API_KEY` environment
  variable." https://kiro.dev/docs/cli/headless/
- All tools off: an agent with an empty `tools` list is not documented.
  https://kiro.dev/docs/custom-agents/configuration-reference/

### Amp

Fails **login reuse**.

- "The CLI rejects the short-lived session token that `amp login` stores,
  because it expires within an hour and cannot be refreshed from an environment
  variable." Scripts need `AMP_API_KEY`.
  https://ampcode.com/docs/cli/execute-mode
- All tools off: `amp.tools.disable` takes globs, but no doc says every
  built-in tool can be turned off, and nothing skips plugins.
  https://ampcode.com/docs/cli/settings

### Factory Droid

Fails **login reuse** and **all tools off**.

- Login reuse: the `droid exec` page shows `FACTORY_API_KEY` only and does not
  say the interactive login is used.
  https://docs.factory.com/cli/droid-exec/overview
- All tools off: no no-tools mode. `--only-tools` and `--remove-tools` have no
  documented empty form, and the default is "Read-only by default... Droid can
  read files and run read-only commands". `--settings` merges on top of the
  user's settings. https://docs.factory.com/reference/cli-reference

### Qwen Code

Fails **login reuse** and **all tools off**.

- Login reuse: unattended runs should "use an API-key-based authentication
  method instead".
  https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
- All tools off: "`--max-tool-calls 0` limits tool execution; it does not
  remove tool schemas from the model request." `--safe-mode` "also keeps
  built-in tools". `--exclude-tools` needs each tool named.
  https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/

### Kimi Code

Fails **all tools off** and **login reuse**.

- All tools off: in `-p` mode "no human approval is requested" and tool calls
  run under the `auto` permission policy. No flag or documented config turns
  every tool off.
  https://moonshotai.github.io/kimi-code/en/reference/kimi-command
- Login reuse: not stated for `-p`. The page also documents no stdin prompt.
- The older `kimi-cli` is archived (changelog 1.52.0).
  https://moonshotai.github.io/kimi-cli/en/release-notes/changelog.html
