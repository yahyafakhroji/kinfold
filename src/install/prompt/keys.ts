// Turns the bytes a raw terminal delivers into named keys. Printable text
// (typed or pasted) becomes one 'char' key per character; every control byte
// or escape sequence this module does not know is dropped, so stray input
// cannot reach a prompt as text.

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'space' | 'enter' | 'backspace' | 'tab' | 'escape' | 'ctrl-c' | 'ctrl-d' }
  | { name: 'char'; char: string }

const ESC = '\u001b'
const ARROWS: Readonly<Record<string, 'up' | 'down' | 'right' | 'left'>> = { A: 'up', B: 'down', C: 'right', D: 'left' }

const SINGLE_BYTE: Readonly<Record<string, Key>> = {
  '\r': { name: 'enter' },
  '\n': { name: 'enter' },
  '\t': { name: 'tab' },
  '\u007f': { name: 'backspace' },
  '\b': { name: 'backspace' },
  '\u0003': { name: 'ctrl-c' },
  '\u0004': { name: 'ctrl-d' },
  ' ': { name: 'space' },
}

const isControl = (char: string): boolean => /^[\p{Cc}\p{Cf}]$/u.test(char)

/** Reads one escape sequence starting at `at`; returns the key (or null) and where the sequence ends. */
function escapeSequence(chunk: string, at: number): { key: Key | null; end: number } {
  const lead = chunk[at + 1]
  if (lead !== '[' && lead !== 'O') return { key: { name: 'escape' }, end: at + 1 }
  // CSI: parameters, then one final byte in @..~. Anything but an arrow is skipped whole.
  let end = at + 2
  while (end < chunk.length && !/[@-~]/.test(chunk[end] as string)) end++
  const final = chunk[end]
  const arrow = final === undefined || end !== at + 2 ? undefined : ARROWS[final]
  return { key: arrow === undefined ? null : { name: arrow }, end: end + 1 }
}

export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = []
  const text = chunk
  let at = 0
  while (at < text.length) {
    const char = String.fromCodePoint(text.codePointAt(at) as number)
    if (char === ESC) {
      const parsed = escapeSequence(text, at)
      if (parsed.key !== null) keys.push(parsed.key)
      at = parsed.end
      continue
    }
    at += char.length
    const named = SINGLE_BYTE[char]
    if (named !== undefined) keys.push(named)
    else if (!isControl(char)) keys.push({ name: 'char', char })
  }
  return keys
}
