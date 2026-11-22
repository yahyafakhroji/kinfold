import { expect, test } from 'bun:test'
import { stripVTControlCharacters } from 'node:util'
import { createBar } from './bar'

/** What the screen holds after every write: a carriage return starts the line over, a newline keeps it. */
function screen(writes: readonly string[]): string[] {
  const lines = ['']
  for (const chunk of writes.join('').split(/(\r|\n)/)) {
    if (chunk === '\n') lines.push('')
    else if (chunk === '\r') lines[lines.length - 1] = ''
    else lines[lines.length - 1] = stripVTControlCharacters(`${lines.at(-1)}${chunk}`)
  }
  return lines
}

function bar(total: number, columns = 80): { writes: string[]; progress: ReturnType<typeof createBar> } {
  const writes: string[] = []
  return { writes, progress: createBar((text) => void writes.push(text), { total, columns, unicode: true, color: false }) }
}

test('each step repaints one line: the bar, the count and the label', () => {
  const { writes, progress } = bar(4)
  progress.step('wiring Claude Code')
  expect(screen(writes)).toEqual([`◒  ${'─'.repeat(24)} 0/4  wiring Claude Code`])
  progress.step('starting the daemon')
  expect(screen(writes)).toEqual([`◒  ${'━'.repeat(6)}${'─'.repeat(18)} 1/4  starting the daemon`])
})

test('done replaces the bar with one finished line', () => {
  const { writes, progress } = bar(2)
  progress.step('a')
  progress.step('b')
  progress.done('Installed in 2 steps')
  expect(screen(writes)).toEqual(['◇  Installed in 2 steps', ''])
})

test('fail replaces the bar with the failure and leaves the cursor on a new line', () => {
  const { writes, progress } = bar(3)
  progress.step('a')
  progress.fail('stopped at step 1 of 3: a')
  expect(screen(writes)).toEqual(['▲  stopped at step 1 of 3: a', ''])
})

test('a note is printed above the bar, which is drawn again below it', () => {
  const { writes, progress } = bar(2)
  progress.step('a')
  progress.note('start the daemon yourself', 'warn')
  progress.note('  1. mkdir /x  [done]')
  expect(screen(writes)).toEqual(['▲  start the daemon yourself', '│    1. mkdir /x  [done]', `◒  ${'─'.repeat(24)} 0/2  a`])
})

test('the line never reaches the last column, so a narrow terminal does not wrap or scroll', () => {
  const { writes, progress } = bar(19, 30)
  progress.step('waiting for the daemon to answer /health on a slow machine')
  const [line] = screen(writes)
  expect(line?.length).toBeLessThanOrEqual(29)
  expect(line?.endsWith('…')).toBe(true)
})

test('with no total it is a spinner: the label alone', () => {
  const { writes, progress } = bar(0)
  progress.step('checking the download')
  expect(screen(writes)).toEqual(['◒  checking the download'])
})

test('without Unicode it draws in ASCII', () => {
  const writes: string[] = []
  const progress = createBar((text) => void writes.push(text), { total: 2, columns: 80, unicode: false, color: false })
  progress.step('a')
  progress.step('b')
  progress.note('careful', 'warn')
  progress.done('ok')
  expect(screen(writes)).toEqual(['!  careful', 'o  ok', ''])
  expect(writes.join('')).toContain(`*  ${'='.repeat(12)}${'-'.repeat(12)} 1/2  b`)
})

test('a ticker advances the spinner frame until the bar ends, then is stopped', () => {
  const writes: string[] = []
  let tick: (() => void) | null = null
  let stopped = 0
  const progress = createBar((text) => void writes.push(text), { total: 1, columns: 80, unicode: true, color: false, ticker: (repaint) => ((tick = repaint), () => void (stopped += 1)) })
  progress.step('a')
  ;(tick as unknown as () => void)()
  expect(screen(writes)[0]?.startsWith('◐')).toBe(true)
  progress.done('ok')
  expect(stopped).toBe(1)
})

test('labels and notes lose control characters', () => {
  const { writes, progress } = bar(1)
  progress.step('ev\u001b[2Jil')
  progress.note('no\u0007te')
  expect(writes.join('')).not.toContain('\u001b[2J')
  expect(writes.join('')).not.toContain('\u0007')
})

test('colour is used when asked for', () => {
  const writes: string[] = []
  const progress = createBar((text) => void writes.push(text), { total: 1, columns: 80, unicode: true, color: true })
  progress.step('a')
  expect(writes.join('')).toContain('\u001b[35m')
})
