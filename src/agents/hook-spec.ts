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
   * Another agent that runs this agent's hooks, named by a documented signal
   * in its payload or environment; null when nothing shows one. Payload and
   * env only: it runs on every hook call.
   */
  callerOf?: (payload: unknown, env: NodeJS.ProcessEnv) => AgentId | null
}
