// The one-line progress bar and spinner, drawn in clack's style but by
// Kinfold. clack's own spinner puts stdin in raw mode and ends the process
// with exit 0 when Ctrl-C arrives there, so an interrupted install would look
// like a finished one; this bar only writes, and a signal does what it did
// before there was a bar.

import type { Mark, Progress } from './prompts'

export interface BarOptions {
  /** How many steps the bar counts; 0 draws a spinner with no bar. */
  total: number
  /** The terminal's width; the line stops one short of it, since a full line wraps on some terminals. */
  columns: number
  unicode: boolean
  color: boolean
  /** Calls `repaint` on a timer until the returned stop is called, so a long step still shows life. Default: no timer. */
  ticker?: (repaint: () => void) => () => void
}

const BAR_SIZE = 24
const MIN_BAR_SIZE = 4
/** Room kept for the label before the bar itself gives up width. */
const LABEL_ROOM = 12
const ERASE_LINE = '\r\u001b[2K'
const MIN_COLUMNS = 20

/** Control and format characters never reach the screen, as in the prompts. */
const clean = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '')

interface Glyphs {
  frames: readonly string[]
  filled: string
  empty: string
  done: string
  failed: string
  warn: string
  rail: string
  more: string
}

const UNICODE: Glyphs = { frames: ['◒', '◐', '◓', '◑'], filled: '━', empty: '─', done: '◇', failed: '▲', warn: '▲', rail: '│', more: '…' }
const ASCII: Glyphs = { frames: ['*', 'o', 'O', '0'], filled: '=', empty: '-', done: 'o', failed: 'x', warn: '!', rail: '|', more: '...' }

const CODES = { magenta: 35, green: 32, red: 31, yellow: 33, gray: 90, dim: 2 } as const

export function createBar(write: (text: string) => void, options: BarOptions): Progress {
  const glyphs = options.unicode ? UNICODE : ASCII
  const paint = (code: keyof typeof CODES, text: string): string => (options.color && text !== '' ? `\u001b[${CODES[code]}m${text}\u001b[${code === 'dim' ? 22 : 39}m` : text)
  const width = Math.max(MIN_COLUMNS, options.columns) - 1
  let started = 0
  let label = ''
  let frame = 0
  let stopTicker: (() => void) | null = null
  let live = false

  /** Cut to the terminal's width before any colour goes on, so an escape code is never split. */
  const fit = (text: string, room: number): string => (text.length <= room ? text : `${text.slice(0, Math.max(0, room - glyphs.more.length))}${glyphs.more}`)

  const line = (): string => {
    const spin = glyphs.frames[frame % glyphs.frames.length] as string
    if (options.total <= 0) return `${paint('magenta', spin)}  ${fit(label, width - 3)}`
    const finished = Math.max(0, started - 1)
    const count = `${finished}/${options.total}`
    const fixed = 3 + 1 + count.length + 2
    const size = Math.min(BAR_SIZE, Math.max(MIN_BAR_SIZE, width - fixed - LABEL_ROOM))
    const filled = Math.min(size, Math.floor((finished / options.total) * size))
    return `${paint('magenta', spin)}  ${paint('magenta', glyphs.filled.repeat(filled))}${paint('dim', glyphs.empty.repeat(size - filled))} ${count}  ${fit(label, width - fixed - size)}`
  }

  const draw = (): void => {
    if (live) write(`${ERASE_LINE}${line()}`)
  }

  const end = (symbol: string, message: string): void => {
    stopTicker?.()
    stopTicker = null
    if (live) write(ERASE_LINE)
    live = false
    if (message !== '') write(`${symbol}  ${clean(message)}\n`)
  }

  return {
    step(next) {
      started += 1
      label = clean(next)
      if (!live) {
        live = true
        stopTicker = options.ticker?.(() => {
          frame += 1
          draw()
        }) ?? null
      }
      draw()
    },
    note(text, mark: Mark = 'none') {
      const symbol = mark === 'warn' ? paint('yellow', glyphs.warn) : mark === 'fail' ? paint('red', glyphs.failed) : mark === 'ok' ? paint('green', glyphs.done) : paint('gray', glyphs.rail)
      write(`${live ? ERASE_LINE : ''}${symbol}  ${clean(text)}\n`)
      draw()
    },
    done: (message) => end(paint('green', glyphs.done), message),
    fail: (message) => end(paint('red', glyphs.failed), message),
  }
}
