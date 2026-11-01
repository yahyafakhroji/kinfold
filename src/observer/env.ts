// Recursion guard. The claude-cli observer is itself a Claude Code process; if
// its hooks (or an OpenCode plugin under an observer) captured events, every
// observer call would create new events to observe. The runner sets this
// flag in the child's env and every capture entry point checks it first.

export const OBSERVER_ENV_FLAG = 'SAM_OBSERVER'

export function isObserverProcess(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[OBSERVER_ENV_FLAG] === '1'
}
