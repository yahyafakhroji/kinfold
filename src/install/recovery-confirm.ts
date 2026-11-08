// Shows a recovery code and checks that the person saved it by retyping its
// last two groups. The code goes to `say` only, never into the question, an
// error or a log; callers must hand it a `say` that reaches a terminal.

import { RECOVERY_GROUP } from '../sqlite/recovery'

const normalize = (text: string): string => text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')

/** True when the typed tail matches; false when the person typed something else. */
export async function confirmRecoveryCode(ask: (question: string) => Promise<string>, say: (line: string) => void, code: string): Promise<boolean> {
  say('')
  say('Recovery code for memory.db. Write it down or put it in a password manager, away from this machine:')
  say('')
  say(`    ${code}`)
  say('')
  say('Without the key or this code, the memory cannot be read again. Anyone with the code can read it.')
  const tail = code.split('-').slice(-2).join('')
  const typed = await ask(`Type the last two groups (${'*'.repeat(RECOVERY_GROUP)}-${'*'.repeat(RECOVERY_GROUP)}) to confirm you saved it: `)
  return normalize(typed) === normalize(tail)
}
