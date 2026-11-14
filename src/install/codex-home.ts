// Where Codex keeps hooks.json, resolved the way Codex resolves it
// (codex-rs/utils/home-dir find_codex_home): a non-empty CODEX_HOME must be an
// existing directory and is canonicalized; Codex refuses to start otherwise,
// so install skips Codex instead of writing somewhere Codex never reads.
// Unset or empty means ~/.codex, which need not exist yet.

import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type CodexHome = { ok: true; dir: string; fromEnv: boolean } | { ok: false; reason: string }

/**
 * An agent home a variable can move (CODEX_HOME, COPILOT_HOME, JUNIE_HOME,
 * GEMINI_CLI_HOME):
 * unset or empty is the default; set, it must be an existing directory and is
 * canonicalized, else the agent is skipped with the reason rather than wired
 * somewhere it may never read.
 */
export function resolveAgentHome(name: string, value: string | undefined, defaultDir: string, cwd: string): CodexHome {
  if (value === undefined || value === '') return { ok: true, dir: defaultDir, fromEnv: false }
  const path = resolve(cwd, value)
  try {
    if (!statSync(path).isDirectory()) return { ok: false, reason: `${name} points to ${JSON.stringify(value)}, but that path is not a directory` }
    return { ok: true, dir: realpathSync(path), fromEnv: true }
  } catch (error: unknown) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { ok: false, reason: missing ? `${name} points to ${JSON.stringify(value)}, but that path does not exist` : `${name} ${JSON.stringify(value)} could not be read` }
  }
}

export function resolveCodexHome(value: string | undefined, homeDir: string, cwd: string): CodexHome {
  return resolveAgentHome('CODEX_HOME', value, join(homeDir, '.codex'), cwd)
}
