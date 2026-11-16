// The runtime shape of one agent's hook: how its payload becomes an event and
// how context is handed back on its stdout. No installer imports, so the hook
// command can load it.

import type { AdapterContext } from '../adapters/context'
import type { UpdateNotice } from '../context/types'
import type { NormalizedEvent } from '../contract/event'
import type { AgentId } from './profile'

export interface HookHostSpec {
  normalize: (payload: unknown, context: AdapterContext) => NormalizedEvent | null
  /** The stdout line that hands `text` to the host as session context. */
  sessionContext: (text: string) => string
  /** The session-start line when an update notice rides along: the user sees it, or the agent is told. */
  sessionContextWithNotice: (text: string, notice: UpdateNotice) => string
  /** The agent drops session-start context (Junie documents that it ignores it), so the hook asks for none and prints nothing then. */
  sessionContextIgnored?: true
  /** The stdout line that adds the prompt-time delta to a turn; absent for hosts not wired for it yet (Cursor). Codex documents the same UserPromptSubmit shape as Claude Code. */
  promptContext?: (text: string) => string
  /**
   * For an agent that shows the user a message the model never sees: the
   * stdout line carrying `message` beside the context line already built
   * (`output`, or null when there is no context to hand over). Absent for an
   * agent with no such channel; its output is then untouched.
   */
  userMessage?: (output: string | null, message: string) => string
  /**
   * For an agent that takes a line out of the hook's stdout and shows it to
   * the user: that line, carrying `message`. It is printed on its own line
   * before the hook's normal output, which is left exactly as it would be
   * without it, so the model reads the same bytes either way. The message is
   * always one line: the session list goes in its one-line form.
   */
  progressLine?: (message: string) => string
  /**
   * Another agent that runs this agent's hooks, named by a documented signal
   * in its payload or environment; null when nothing shows one. Payload and
   * env only: it runs on every hook call.
   */
  callerOf?: (payload: unknown, env: NodeJS.ProcessEnv) => AgentId | null
}
