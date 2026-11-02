import type { ObserverPrompt } from './types'

/** Fixed and harmless: no project data, no tools, a one-word answer. */
export const CHECK_PROMPT: ObserverPrompt = {
  system: 'This is a connectivity check for a memory tool. Reply with the single word OK.',
  user: 'Reply with OK.',
  eventIds: [],
}
