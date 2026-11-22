// The one switch: a run is framed (a terminal, drawn with clack) or plain
// (lines), decided once here and never per call. --yes is plain even on a
// terminal, because the run an update starts, a CI job and a script all pass
// it and none of them may draw a frame or wait at a question.

import type { InstallEnv } from '../../../resources/install-plan/env'
import { createPlainOutput } from './plain'
import { type Output, type Prompts, withShortHome } from './prompts'

export interface Ui {
  framed: boolean
  /** The questions; null whenever nothing may be asked. */
  prompts: Prompts | null
  output: Output
}

export async function uiFor(env: Pick<InstallEnv, 'terminal' | 'out' | 'promptsFor' | 'homeDir'>, options: { yes: boolean }): Promise<Ui> {
  if (env.terminal === null || options.yes) return { framed: false, prompts: null, output: createPlainOutput(env.out) }
  // Loaded here and nowhere else, so a plain run never loads clack.
  const renderer = env.promptsFor !== undefined ? env.promptsFor(env.terminal) : (await import('./clack')).createClackPrompts()
  // On a screen a path under the home reads as ~; the plain renderer above keeps it whole for scripts.
  const prompts = withShortHome(renderer, env.homeDir)
  return { framed: true, prompts, output: prompts }
}
