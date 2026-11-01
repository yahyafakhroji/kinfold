// Recursion guard. The claude-cli observer is itself a Claude Code process; if
// its hooks (or an OpenCode plugin under an observer) captured events, every
// observer call would create new events to observe. The runner sets this
// flag in the child's env and every capture entry point checks it first.

import { envName, legacyName, readEnv } from '../env-names'

export const OBSERVER_ENV_FLAG = envName('OBSERVER')
/**
 * Set beside OBSERVER_ENV_FLAG so hook code from before the rename, still
 * wired during the migration window, also sees the guard. It goes when the
 * SAM_* fallback in env-names.ts goes.
 */
export const LEGACY_OBSERVER_ENV_FLAG = legacyName('OBSERVER')

export function isObserverProcess(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return readEnv(env, 'OBSERVER') === '1'
}
