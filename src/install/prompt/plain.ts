// The plain renderer: what every command prints when its output is not a
// terminal, or under --yes. Lines only, no escape codes, nothing that waits,
// so a script, a log and the auto-updater read what they always read.

import { type Busy, type Output, type Progress, clean } from './prompts'

export function createPlainOutput(out: (line: string) => void): Output {
  const line = (text: string): void => {
    if (text !== '') out(clean(text))
  }
  const ending = { done: line, fail: line }
  return {
    framed: false,
    // A frame's title is decoration; a script's first line stays what it was.
    intro: () => undefined,
    outro: line,
    cancelled: line,
    say: (text) => out(clean(text)),
    warn: line,
    error: line,
    section(title, rows) {
      out(`${clean(title)}:`)
      for (const row of rows) out(`  ${clean(row.text)}`)
    },
    progress: (): Progress => ({ step: () => undefined, note: line, ...ending }),
    busy: (): Busy => ({ label: () => undefined, note: line, ...ending }),
  }
}
