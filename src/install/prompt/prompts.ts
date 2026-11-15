// The output layer every command speaks through. A command says what it has
// to say (a section, rows with marks, a question, progress) and never writes
// an escape code; the renderer decides how it looks. Two renderers draw it: a
// framed one built on @clack/prompts for a terminal (clack.ts) and a plain
// one that prints lines (plain.ts). One of them is chosen for a whole run
// (ui.ts).
//
// This file also holds a third, key-driven implementation on a raw
// TerminalIO. It is the scripted double the wizard's tests run on: a test
// lists the keys, and the same questions are asked and answered without a
// real terminal. Every prompt puts the terminal back in cooked mode with the
// cursor shown however it ends. Ctrl-C, Ctrl-D and a closed key stream all
// reject with PromptCancelled; the caller decides the exit code.

import { createBar } from './bar'
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
  /** A caution about a choice that can still be taken; shown on its row whether or not the row is focused. */
  warn?: string
  /** Why the choice cannot be taken; a disabled choice is shown but skipped. */
  disabled?: string
}

/** How a row reads at a glance: fine, worth a look, broken, or no mark at all. */
export type Mark = 'ok' | 'warn' | 'fail' | 'none'

export interface Row {
  mark: Mark
  text: string
}

/** One bar for a run of steps. */
export interface Progress {
  /** The next step starts; its short label sits beside the bar. */
  step(label: string): void
  /** A line shown above the bar while it runs. */
  note(line: string, mark?: Mark): void
  done(message: string): void
  fail(message: string): void
}

/** A wait with no count: a download, a check. */
export interface Busy {
  /** What the spinner says from now on. */
  label(text: string): void
  /** A line shown above the spinner while it runs. */
  note(line: string, mark?: Mark): void
  done(message: string): void
  fail(message: string): void
}

/** What a command says. Both renderers implement it; neither asks anything. */
export interface Output {
  /** True for a terminal frame; false for plain lines. */
  readonly framed: boolean
  intro(title: string): void
  outro(message: string): void
  /** The last line of a run the person stopped. */
  cancelled(message: string): void
  /** One line of running text. */
  say(line: string): void
  warn(line: string): void
  error(line: string): void
  /** A titled group of rows, each with its mark. */
  section(title: string, rows: readonly Row[]): void
  progress(total: number): Progress
  busy(label: string): Busy
}

/** The questions, which only a terminal can answer. */
export interface Prompts extends Output {
  select<T extends string>(question: string, choices: readonly Choice<T>[], initial: T): Promise<T>
  multiSelect<T extends string>(question: string, choices: readonly Choice<T>[], initial: readonly T[]): Promise<T[]>
  text(question: string, initial: string, validate?: (value: string) => string | null): Promise<string>
  /** A line typed without echo, for a key or a recovery code. */
  password(question: string): Promise<string>
  confirm(question: string, initial: boolean): Promise<boolean>
  /** A display-only line: the label, the value and a note; takes no input. */
  locked(label: string, value: string, note: string): void
}

const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const CLEAR_LINE = '\u001b[2K'
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const RESET = '\u001b[0m'
const up = (lines: number): string => (lines > 0 ? `\u001b[${lines}A` : '')

/** Labels can come from files, hosts or models; control and format characters (escapes, bidi marks) never reach the screen. */
export const clean = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '')

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/**
 * Turns a path under the person's home into ~/..., as a shell shows it. Only
 * a whole folder name counts: /home/ann-backup is not under /home/ann.
 */
export function homeShortener(homeDir: string): (text: string) => string {
  const home = homeDir.replace(/[\\/]+$/, '')
  // A home of "/" or nothing would turn every path into ~.
  if (home.length < 2) return (text) => text
  const pattern = new RegExp(`${home.replace(REGEX_SPECIALS, '\\$&')}(?![\\w.-])`, 'g')
  return (text) => text.replace(pattern, '~')
}

/**
 * The same prompts, drawing ~ for the home in everything they show. A screen
 * is read by the person whose home it is, so the long prefix says nothing;
 * plain output goes to scripts and logs and keeps the full path. Answers are
 * never touched: a default folder is still returned whole.
 */
export function withShortHome(prompts: Prompts, homeDir: string): Prompts {
  const short = homeShortener(homeDir)
  const choice = <T extends string>(given: Choice<T>): Choice<T> => ({
    ...given,
    label: short(given.label),
    ...(given.hint !== undefined ? { hint: short(given.hint) } : {}),
    ...(given.warn !== undefined ? { warn: short(given.warn) } : {}),
    ...(given.disabled !== undefined ? { disabled: short(given.disabled) } : {}),
  })
  return {
    framed: prompts.framed,
    intro: (title) => prompts.intro(short(title)),
    outro: (message) => prompts.outro(short(message)),
    cancelled: (message) => prompts.cancelled(short(message)),
    say: (line) => prompts.say(short(line)),
    warn: (line) => prompts.warn(short(line)),
    error: (line) => prompts.error(short(line)),
    section: (title, rows) => prompts.section(short(title), rows.map((row) => ({ mark: row.mark, text: short(row.text) }))),
    progress(total) {
      const bar = prompts.progress(total)
      return { step: (label) => bar.step(short(label)), note: (line, mark) => bar.note(short(line), mark), done: (message) => bar.done(short(message)), fail: (message) => bar.fail(short(message)) }
    },
    busy(label) {
      const spinner = prompts.busy(short(label))
      return { label: (text) => spinner.label(short(text)), note: (line, mark) => spinner.note(short(line), mark), done: (message) => spinner.done(short(message)), fail: (message) => spinner.fail(short(message)) }
    },
    select: (question, choices, initial) => prompts.select(short(question), choices.map(choice), initial),
    multiSelect: (question, choices, initial) => prompts.multiSelect(short(question), choices.map(choice), initial),
    async text(question, initial, validate) {
      // The default is drawn short and handed back whole: what is shown is not what is returned.
      const shown = short(initial)
      const whole = (value: string): string => (value === shown ? initial : value)
      return whole(await prompts.text(short(question), shown, validate === undefined ? undefined : (value) => validate(whole(value))))
    },
    password: (question) => prompts.password(short(question)),
    confirm: (question, initial) => prompts.confirm(short(question), initial),
    locked: (label, value, note) => prompts.locked(short(label), short(value), short(note)),
  }
}

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
  // The caution is not dimmed: it has to be read on a row the cursor is not on.
  const dim = choice.hint === undefined ? '' : `  ${DIM}${clean(choice.hint)}${RESET}`
  const hint = choice.warn === undefined ? dim : `${dim}${choice.hint === undefined ? '  ' : ' · '}${clean(choice.warn)}`
  return current ? `  ${BOLD}> ${mark}${label}${RESET}${hint}` : `    ${mark}${label}${hint}`
}

function startIndex<T extends string>(choices: readonly Choice<T>[], initial: T | undefined): number {
  const enabled = enabledIndexes(choices)
  if (enabled.length === 0) throw new Error('a prompt needs at least one choice that can be taken')
  const wanted = choices.findIndex((choice) => choice.value === initial && choice.disabled === undefined)
  return wanted >= 0 ? wanted : (enabled[0] as number)
}

/**
 * A line typed without echo, for a key. It runs in the same raw session as
 * every other prompt, so a credential question between two of them never
 * reads stdin through a second reader; Ctrl-C cancels it like any prompt.
 */
export function askHidden(io: TerminalIO, question: string): Promise<string> {
  return session(io, false, async (next) => {
    let typed = ''
    io.write(`${BOLD}${clean(question)}${RESET} `)
    for (;;) {
      const key = await next()
      if (key.name === 'char') typed += key.char
      else if (key.name === 'space') typed += ' '
      else if (key.name === 'backspace') typed = [...typed].slice(0, -1).join('')
      else if (key.name === 'enter') {
        io.write('\r\n')
        return typed
      }
    }
  })
}

const MARKS: Readonly<Record<Mark, string>> = { ok: '+ ', warn: '! ', fail: 'x ', none: '' }
const RAW_COLUMNS = 100

export function createPrompts(io: TerminalIO): Prompts {
  const say = (line: string): void => io.write(`${line}\n`)
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

    password: (question) => askHidden(io, question),

    locked(label, value, note) {
      io.write(`  ${clean(label)}  ${clean(value)}  ${DIM}${clean(note)}${RESET}\n`)
    },

    framed: true,
    intro: (title) => say(`${BOLD}${clean(title)}${RESET}`),
    outro: (message) => say(clean(message)),
    cancelled: (message) => say(clean(message)),
    say: (line) => say(clean(line)),
    warn: (line) => say(`! ${clean(line)}`),
    error: (line) => say(`x ${clean(line)}`),
    section(title, rows) {
      say(`${BOLD}${clean(title)}${RESET}`)
      for (const row of rows) say(`  ${MARKS[row.mark]}${clean(row.text)}`)
    },
    progress: (total) => createBar((text) => io.write(text), { total, columns: RAW_COLUMNS, unicode: false, color: false }),
    busy: (label) => {
      const bar = createBar((text) => io.write(text), { total: 0, columns: RAW_COLUMNS, unicode: false, color: false })
      bar.step(label)
      return { label: (text) => bar.step(text), note: (line, mark) => bar.note(line, mark), done: (message) => bar.done(message), fail: (message) => bar.fail(message) }
    },
  }
}
