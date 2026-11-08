// Select, multi-select, text and confirm prompts on a raw terminal, drawn with
// plain ANSI. Every prompt puts the terminal back in cooked mode with the
// cursor shown however it ends. Ctrl-C, Ctrl-D and a closed key stream all
// reject with PromptCancelled; the caller decides the exit code.

import type { Key } from './keys'
import type { TerminalIO } from './terminal'

export class PromptCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'PromptCancelled'
  }
}

export interface Choice<T extends string> {
  value: T
  label: string
  hint?: string
  /** Why the choice cannot be taken; a disabled choice is shown but skipped. */
  disabled?: string
}

export interface Prompts {
  select<T extends string>(question: string, choices: readonly Choice<T>[], initial: T): Promise<T>
  multiSelect<T extends string>(question: string, choices: readonly Choice<T>[], initial: readonly T[]): Promise<T[]>
  text(question: string, initial: string, validate?: (value: string) => string | null): Promise<string>
  confirm(question: string, initial: boolean): Promise<boolean>
  /** A display-only line: the label, the value and a note; takes no input. */
  locked(label: string, value: string, note: string): void
  /** Plain lines between questions. */
  say(line: string): void
}

const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const CLEAR_LINE = '\u001b[2K'
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const RESET = '\u001b[0m'
const up = (lines: number): string => (lines > 0 ? `\u001b[${lines}A` : '')

/** Labels can come from files, hosts or models; control and format characters (escapes, bidi marks) never reach the screen. */
const clean = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '')

type NextKey = () => Promise<Key>

/** Runs one prompt in raw mode and always restores the terminal. */
async function session<R>(io: TerminalIO, hideCursor: boolean, body: (next: NextKey) => Promise<R>): Promise<R> {
  const iterator = io.keys()[Symbol.asyncIterator]()
  io.setRaw(true)
  if (hideCursor) io.write(HIDE_CURSOR)
  const next: NextKey = async () => {
    const result = await iterator.next()
    if (result.done === true) throw new PromptCancelled()
    if (result.value.name === 'ctrl-c' || result.value.name === 'ctrl-d') throw new PromptCancelled()
    return result.value
  }
  try {
    return await body(next)
  } catch (error: unknown) {
    if (error instanceof PromptCancelled) io.write('\r\n')
    throw error
  } finally {
    // Cooked mode first: nothing after it may skip it, even a failed write.
    try {
      io.setRaw(false)
    } finally {
      try {
        io.write(SHOW_CURSOR)
      } finally {
        await iterator.return?.()
      }
    }
  }
}

/** Redraws a block of lines in place. */
function painter(io: TerminalIO): { paint(lines: readonly string[]): void; erase(): void } {
  let drawn = 0
  const erase = (): void => {
    io.write(up(drawn))
    for (let i = 0; i < drawn; i++) io.write(`${CLEAR_LINE}\r\n`)
    io.write(up(drawn))
    drawn = 0
  }
  return {
    paint(lines) {
      erase()
      for (const line of lines) io.write(`${CLEAR_LINE}${line}\r\n`)
      drawn = lines.length
    },
    erase,
  }
}

function enabledIndexes<T extends string>(choices: readonly Choice<T>[]): number[] {
  return choices.flatMap((choice, index) => (choice.disabled === undefined ? [index] : []))
}

function step<T extends string>(choices: readonly Choice<T>[], from: number, direction: 1 | -1): number {
  for (let offset = 1; offset <= choices.length; offset++) {
    const index = (from + direction * offset + choices.length * offset) % choices.length
    if (choices[index]?.disabled === undefined) return index
  }
  return from
}

function choiceLine<T extends string>(choice: Choice<T>, current: boolean, mark: string): string {
  const label = clean(choice.label)
  if (choice.disabled !== undefined) return `    ${DIM}${mark}${label} (${clean(choice.disabled)})${RESET}`
  const hint = choice.hint === undefined ? '' : `  ${DIM}${clean(choice.hint)}${RESET}`
  return current ? `  ${BOLD}> ${mark}${label}${RESET}${hint}` : `    ${mark}${label}${hint}`
}

function startIndex<T extends string>(choices: readonly Choice<T>[], initial: T | undefined): number {
  const enabled = enabledIndexes(choices)
  if (enabled.length === 0) throw new Error('a prompt needs at least one choice that can be taken')
  const wanted = choices.findIndex((choice) => choice.value === initial && choice.disabled === undefined)
  return wanted >= 0 ? wanted : (enabled[0] as number)
}

export function createPrompts(io: TerminalIO): Prompts {
  const answered = (question: string, answer: string): string => `${clean(question)} ${DIM}${clean(answer)}${RESET}\r\n`

  return {
    select(question, choices, initial) {
      return session(io, true, async (next) => {
        const screen = painter(io)
        let cursor = startIndex(choices, initial)
        for (;;) {
          screen.paint([`${BOLD}${clean(question)}${RESET}`, ...choices.map((choice, i) => choiceLine(choice, i === cursor, ''))])
          const key = await next()
          if (key.name === 'up') cursor = step(choices, cursor, -1)
          else if (key.name === 'down') cursor = step(choices, cursor, 1)
          else if (key.name === 'enter') {
            const picked = choices[cursor] as Choice<typeof initial>
            screen.erase()
            io.write(answered(question, picked.label))
            return picked.value
          }
        }
      })
    },

    multiSelect(question, choices, initial) {
      return session(io, true, async (next) => {
        const screen = painter(io)
        const chosen = new Set(choices.filter((choice) => choice.disabled === undefined && initial.includes(choice.value)).map((choice) => choice.value))
        let cursor = startIndex(choices, undefined)
        for (;;) {
          screen.paint([
            `${BOLD}${clean(question)}${RESET} ${DIM}(space toggles, enter confirms)${RESET}`,
            ...choices.map((choice, i) => choiceLine(choice, i === cursor, chosen.has(choice.value) ? '[x] ' : '[ ] ')),
          ])
          const key = await next()
          if (key.name === 'up') cursor = step(choices, cursor, -1)
          else if (key.name === 'down') cursor = step(choices, cursor, 1)
          else if (key.name === 'space') {
            const value = (choices[cursor] as Choice<typeof choices[number]['value']>).value
            if (chosen.has(value)) chosen.delete(value)
            else chosen.add(value)
          } else if (key.name === 'enter') {
            const result = choices.filter((choice) => chosen.has(choice.value)).map((choice) => choice.value)
            screen.erase()
            io.write(answered(question, result.length === 0 ? 'none' : choices.filter((c) => chosen.has(c.value)).map((c) => c.label).join(', ')))
            return result
          }
        }
      })
    },

    text(question, initial, validate) {
      return session(io, false, async (next) => {
        let typed = ''
        const prompt = (): string => `${BOLD}${clean(question)}${RESET} ${DIM}${initial === '' ? '' : `(${clean(initial)}) `}${RESET}`
        io.write(prompt())
        for (;;) {
          const key = await next()
          if (key.name === 'char') {
            const char = clean(key.char)
            typed += char
            io.write(char)
          } else if (key.name === 'space') {
            typed += ' '
            io.write(' ')
          } else if (key.name === 'backspace') {
            if (typed.length > 0) {
              const last = [...typed].pop() as string
              typed = typed.slice(0, typed.length - last.length)
              io.write('\b \b')
            }
          } else if (key.name === 'enter') {
            const value = typed === '' ? initial : typed
            const problem = validate?.(value) ?? null
            io.write('\r\n')
            if (problem === null) return value
            io.write(`  ${clean(problem)}\r\n`)
            typed = ''
            io.write(prompt())
          }
        }
      })
    },

    confirm(question, initial) {
      return session(io, false, async (next) => {
        io.write(`${BOLD}${clean(question)}${RESET} ${DIM}${initial ? '(Y/n)' : '(y/N)'}${RESET} `)
        for (;;) {
          const key = await next()
          const char = key.name === 'char' ? key.char.toLowerCase() : ''
          const answer = key.name === 'enter' ? initial : char === 'y' ? true : char === 'n' ? false : null
          if (answer === null) continue
          io.write(`${answer ? 'yes' : 'no'}\r\n`)
          return answer
        }
      })
    },

    locked(label, value, note) {
      io.write(`  ${clean(label)}  ${clean(value)}  ${DIM}${clean(note)}${RESET}\n`)
    },

    say(line) {
      io.write(`${clean(line)}\n`)
    },
  }
}
