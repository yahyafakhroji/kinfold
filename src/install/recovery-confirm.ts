// Shows a recovery code and checks that the person saved it by retyping its
// last two groups. The code goes to `say` only, never into the question, an
// error or a log, and only a sink minted from a terminal can show it.

import { RECOVERY_GROUP } from '../sqlite/recovery'
import type { InstallEnv } from './env'
import { createPrompts } from './prompt/prompts'
import type { TerminalIO } from './prompt/terminal'

const normalize = (text: string): string => text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')

export const NOT_A_TERMINAL = 'a recovery code is only shown on a terminal'

/**
 * Where a recovery code may be shown. Only the two factories below mint one,
 * and each refuses unless the output is a terminal, so a pipe, a log or an
 * error message cannot be handed the code by mistake.
 */
export interface RecoverySink {
  readonly kind: 'recovery-sink'
  say(line: string): void
  ask(question: string): Promise<string>
}

const minted = new WeakSet<object>()

function mint(sink: Omit<RecoverySink, 'kind'>): RecoverySink {
  const made: RecoverySink = { kind: 'recovery-sink', ...sink }
  minted.add(made)
  return made
}

/** From the wizard's terminal, which exists only when stdin and stdout are both TTYs. */
export function recoverySinkFromTerminal(terminal: TerminalIO | null): RecoverySink {
  if (terminal === null) throw new Error(NOT_A_TERMINAL)
  const prompts = createPrompts(terminal)
  return mint({ say: (line) => prompts.say(line), ask: (question) => prompts.text(question, '') })
}

/** From the line-based env that `kinfold encrypt` uses: stdin interactive and stdout not a pipe or file. */
export function recoverySinkFromEnv(env: Pick<InstallEnv, 'io' | 'out'>): RecoverySink {
  if (!env.io.interactive || env.io.printsToTerminal === false) throw new Error(NOT_A_TERMINAL)
  return mint({ say: (line) => env.out(line), ask: (question) => env.io.ask(question) })
}

/** True when the typed tail matches; false when the person typed something else. Throws, saying nothing, for a sink it did not mint. */
export async function confirmRecoveryCode(sink: RecoverySink, code: string): Promise<boolean> {
  if (!minted.has(sink)) throw new Error(NOT_A_TERMINAL)
  const say = sink.say
  say('')
  say('Recovery code for memory.db. Write it down or put it in a password manager, away from this machine:')
  say('')
  say(`    ${code}`)
  say('')
  say('Without the key or this code, the memory cannot be read again. Anyone with the code can read it.')
  const tail = code.split('-').slice(-2).join('')
  const typed = await sink.ask(`Type the last two groups (${'*'.repeat(RECOVERY_GROUP)}-${'*'.repeat(RECOVERY_GROUP)}) to confirm you saved it: `)
  return normalize(typed) === normalize(tail)
}
