// The framed renderer: the output layer drawn with @clack/prompts on a
// terminal. This is the only file that imports clack, and it is loaded with
// import() by the run that needs it, so a hook, the MCP server and the daemon
// never pay for it. Every label passes through clean() first: names come from
// files, hosts and models. A cancelled question (Ctrl-C or Esc) rejects with
// PromptCancelled, as the layer's other implementations do.

import * as clack from '@clack/prompts'
import type { Readable, Writable } from 'node:stream'
import { styleText } from 'node:util'
import { createBar } from './bar'
import { type Busy, type Choice, type Mark, type Progress, PromptCancelled, type Prompts, clean } from './prompts'

export interface PromptStreams {
  input: Readable
  output: Writable
}

const TICK_MS = 120
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24

function answerOf<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new PromptCancelled()
  return value as Exclude<T, symbol>
}

/**
 * clack draws a hint on a row that is focused, ticked or disabled, and leaves
 * it off the answer line. `pinned` puts the hint in the label instead, for a
 * row that would otherwise show none: one that starts unticked, whose hint is
 * the reason it is unticked. A `warn` is always in the label.
 */
function optionOf<T extends string>(choice: Choice<T>, pinned: boolean): { value: T; label: string; hint?: string; disabled?: boolean } {
  // A caution is part of the label, so it stays on the row when the cursor starts somewhere else.
  const label = choice.warn === undefined ? clean(choice.label) : `${clean(choice.label)} ${styleText('yellow', `(${clean(choice.warn)})`)}`
  if (choice.disabled !== undefined) return { value: choice.value, label, hint: clean(choice.disabled), disabled: true }
  if (choice.hint === undefined) return { value: choice.value, label }
  return pinned ? { value: choice.value, label: `${label} ${styleText('dim', `(${clean(choice.hint)})`)}` } : { value: choice.value, label, hint: clean(choice.hint) }
}

/** Some ptys report a width of 0, which clack would wrap at: one character per line. */
function withUsableSize(output: Writable): void {
  const sized = output as Writable & { columns?: number; rows?: number }
  if (sized.columns === 0) Object.defineProperty(sized, 'columns', { value: DEFAULT_COLUMNS, configurable: true, writable: true })
  if (sized.rows === 0) Object.defineProperty(sized, 'rows', { value: DEFAULT_ROWS, configurable: true, writable: true })
}

const MARK_TEXT: Readonly<Record<Mark, string>> = {
  ok: styleText('green', clack.unicodeOr('✓', '+')),
  warn: styleText('yellow', clack.unicodeOr('▲', '!')),
  fail: styleText('red', clack.unicodeOr('✗', 'x')),
  none: ' ',
}

export function createClackPrompts(streams: PromptStreams = { input: process.stdin, output: process.stdout }): Prompts {
  const { input, output } = streams
  withUsableSize(output)
  const common = { input, output }
  const write = (text: string): void => void output.write(text)
  const columns = (): number => (output as Writable & { columns?: number }).columns ?? DEFAULT_COLUMNS
  const color = process.env.NO_COLOR === undefined || process.env.NO_COLOR === ''

  const bar = (total: number): Progress =>
    createBar(write, {
      total,
      columns: columns(),
      unicode: clack.unicode,
      color,
      ticker: (repaint) => {
        const timer = setInterval(repaint, TICK_MS)
        // The bar never keeps the process alive: a finished command exits even if its bar was left open.
        timer.unref()
        return () => clearInterval(timer)
      },
    })

  return {
    framed: true,
    intro: (title) => clack.intro(clean(title), { output }),
    outro: (message) => clack.outro(clean(message), { output }),
    cancelled: (message) => clack.cancel(clean(message), { output }),
    say: (line) => clack.log.message(clean(line), { output, spacing: 0 }),
    warn: (line) => clack.log.warn(clean(line), { output }),
    error: (line) => clack.log.error(clean(line), { output }),
    section: (title, rows) => clack.note(rows.map((row) => `${MARK_TEXT[row.mark]} ${clean(row.text)}`).join('\n'), clean(title), { output, format: (line) => line }),
    progress(total) {
      write(`${styleText('gray', clack.S_BAR)}\n`)
      return bar(total)
    },
    busy(label): Busy {
      write(`${styleText('gray', clack.S_BAR)}\n`)
      const spinner = bar(0)
      spinner.step(label)
      return { label: (text) => spinner.step(text), note: (line, mark) => spinner.note(line, mark), done: (message) => spinner.done(message), fail: (message) => spinner.fail(message) }
    },

    async select(question, choices, initial) {
      return answerOf(await clack.select({ ...common, message: clean(question), options: choices.map((choice) => optionOf(choice, false)) as never, initialValue: initial as never })) as typeof initial
    },

    async multiSelect(question, choices, initial) {
      const open = new Set(choices.filter((choice) => choice.disabled === undefined).map((choice) => choice.value))
      const picked = answerOf(await clack.multiselect({
        ...common,
        message: clean(question),
        options: choices.map((choice) => optionOf(choice, !initial.includes(choice.value))) as never,
        initialValues: initial.filter((value) => open.has(value)) as never,
        required: false,
      })) as string[]
      // Returned in the list's order, whatever order they were ticked in.
      return choices.filter((choice) => picked.includes(choice.value) && open.has(choice.value)).map((choice) => choice.value)
    },

    async text(question, initial, validate) {
      const valueOf = (typed: string | undefined): string => (typed === undefined || typed === '' ? initial : typed)
      const typed = answerOf(await clack.text({
        ...common,
        message: clean(question),
        ...(initial === '' ? {} : { placeholder: clean(initial), defaultValue: initial }),
        validate: (value) => validate?.(valueOf(value)) ?? undefined,
      }))
      return valueOf(typed)
    },

    async password(question) {
      return answerOf(await clack.password({ ...common, message: clean(question) })) ?? ''
    },

    async confirm(question, initial) {
      return answerOf(await clack.confirm({ ...common, message: clean(question), initialValue: initial }))
    },

    locked(label, value, note) {
      clack.log.message(`${clean(label)}  ${clean(value)}  ${styleText('dim', clean(note))}`, { output, spacing: 0 })
    },
  }
}
