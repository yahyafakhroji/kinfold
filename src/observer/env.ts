// Recursion guard. The claude-cli observer is itself a Claude Code process; if
// its hooks (or an OpenCode plugin under an observer) captured events, every
// observer call would create new events to observe. The runner sets this
// flag in the child's env and every capture entry point checks it first.

import { envName, readEnv } from '../env-names'

export const OBSERVER_ENV_FLAG = envName('OBSERVER')

export function isObserverProcess(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return readEnv(env, 'OBSERVER') === '1'
}
