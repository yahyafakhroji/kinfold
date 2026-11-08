// A scripted terminal for tests: it plays back the given keys, records what
// was written and every raw-mode switch, and ends its key stream when the
// script runs out (which a prompt reads as a closed stdin).

import { type Key, decodeKeys } from './keys'
import type { TerminalIO } from './terminal'

export function fakeTerminal(input: readonly (string | Key)[]): TerminalIO & { output(): string; rawStates(): boolean[] } {
  const script = input.flatMap((item) => (typeof item === 'string' ? decodeKeys(item) : [item]))
  let position = 0
  let written = ''
  const raw: boolean[] = []
  return {
    async *keys() {
      while (position < script.length) yield script[position++] as Key
    },
    write: (text) => {
      written += text
    },
    setRaw: (on) => {
      raw.push(on)
    },
    output: () => written,
    rawStates: () => [...raw],
  }
}
