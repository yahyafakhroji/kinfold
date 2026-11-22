// What a paired device's pages say about its hub. A late answer means the hub
// is busy (a large store, a long report); no route means it cannot be reached;
// a refusal (pairing, sign-in, versions) needs the user to act. Each reads
// differently, because each has a different fix.

import { plural } from './format'
import type { CentralStatus } from './types'

export interface DeviceNotice {
  tone: 'warn' | 'bad'
  text: string
}

const REFUSALS: ReadonlySet<string> = new Set(['refused', 'unpaired', 'version', 'bad-signature', 'too-large'])

export function deviceNotice(central: Extract<CentralStatus, { role: 'device' }>): DeviceNotice | null {
  const failure = central.failure ?? null
  const waiting = `Captures wait here (${plural(central.queued, 'event', 'events')})`
  if (failure === 'timeout') return { tone: 'warn', text: `${central.problem ?? `${central.hub} is busy and didn't answer in time`}; Kinfold asks again. ${waiting} and are sent when it answers.` }
  if (failure !== null && REFUSALS.has(failure)) return { tone: 'bad', text: `${central.hub} turned this device away: ${central.problem ?? failure}. ${waiting} and are sent once that is fixed.` }
  // It answered, with an error or something unreadable: the hub's own log says why.
  if (failure === 'hub-error' || failure === 'bad-answer') return { tone: 'bad', text: `${central.problem ?? `${central.hub} had an error answering`}. ${waiting} and are sent once it answers.` }
  if (central.reachable && failure === null) return null
  return { tone: 'bad', text: `This device cannot reach ${central.hub}${central.problem !== null ? `: ${central.problem}` : ''}. ${waiting} and are sent when it is back.` }
}
