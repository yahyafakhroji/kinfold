import { afterEach, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { createClackPrompts } from './clack'
import { type Choice, PromptCancelled, type Prompts } from './prompts'

const ENTER = '\r'
const DOWN = '\u001b[B'
const SPACE = ' '
const CTRL_C = '\u0003'
const ESC = '\u001b'

interface Screen {
  ask: Prompts
  /** Types the keys one at a time, each after the prompt has drawn. */
  type(keys: readonly string[]): void
  text(): string
  raw(): string
}

let timers: ReturnType<typeof setInterval>[] = []
afterEach(() => {
  for (const timer of timers) clearInterval(timer)
  timers = []
})

function screen(): Screen {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.on('data', (chunk: Buffer) => (written += chunk.toString()))
  return {
    ask: createClackPrompts({ input, output }),
    type(keys) {
      let next = 0
      const timer = setInterval(() => {
        if (next < keys.length) input.write(keys[next++] as string)
        else clearInterval(timer)
      }, 3)
      timers.push(timer)
    },
    text: () => stripVTControlCharacters(written),
    raw: () => written,
  }
}

const agents: Choice<string>[] = [
  { value: 'claude-code', label: 'Claude Code', hint: '2.1.311 · capture, context, search' },
  { value: 'windsurf', label: 'Windsurf', disabled: 'not installed' },
  { value: 'codex', label: 'Codex', hint: '0.9.0 · capture, search' },
]

test('the clack renderer is framed', () => {
  expect(screen().ask.framed).toBe(true)
})

test('multiSelect lists every row with its hint, a disabled row with its reason, and returns the ticked ones', async () => {
  const s = screen()
  s.type([DOWN, SPACE, ENTER])
  expect(await s.ask.multiSelect('Which agents should share memory?', agents, ['claude-code'])).toEqual(['claude-code', 'codex'])
  const text = s.text()
  expect(text).toContain('Which agents should share memory?')
  // Every row says its hint, ticked or not, focused or not.
  expect(text).toContain('◼ Claude Code (2.1.311 · capture, context, search)')
  expect(text).toContain('◻ Codex (0.9.0 · capture, search)')
  expect(text).toContain('◻ Windsurf (not installed)')
  // The answer line names a row that started ticked by its name alone; one ticked by hand keeps its note.
  expect(text.trimEnd().endsWith('Claude Code, Codex (0.9.0 · capture, search)')).toBe(true)
})

test('a terminal that reports no width is drawn at 80 columns, not one character per line', async () => {
  const input = new PassThrough()
  const output = Object.assign(new PassThrough(), { columns: 0, rows: 0 })
  let written = ''
  output.on('data', (chunk: Buffer) => (written += chunk.toString()))
  const ask = createClackPrompts({ input, output })
  setTimeout(() => input.write(ENTER), 5)
  await ask.text('Port for the daemon:', '37811')
  ask.section('Installed', [{ mark: 'ok', text: 'Agents wired: Claude Code' }])
  const text = stripVTControlCharacters(written)
  expect(text).toContain('Port for the daemon:')
  expect(text).toContain('✓ Agents wired: Claude Code')
})

test('multiSelect skips a disabled row: Down from the first lands on the third', async () => {
  const s = screen()
  s.type([SPACE, DOWN, SPACE, ENTER])
  expect(await s.ask.multiSelect('Agents', agents, ['claude-code'])).toEqual(['codex'])
})

test('multiSelect accepts nothing ticked', async () => {
  const s = screen()
  s.type([ENTER])
  expect(await s.ask.multiSelect('Agents', agents, [])).toEqual([])
})

test('a disabled row is never returned, even when it starts ticked', async () => {
  const s = screen()
  s.type([ENTER])
  expect(await s.ask.multiSelect('Agents', agents, ['windsurf', 'codex'])).toEqual(['codex'])
})

test('select starts on the initial value and moves with the arrows', async () => {
  const s = screen()
  s.type([ENTER])
  expect(await s.ask.select('Updates:', [{ value: 'auto', label: 'Auto' }, { value: 'off', label: 'Off' }], 'off')).toBe('off')
  const t = screen()
  t.type([DOWN, ENTER])
  expect(await t.ask.select('Updates:', [{ value: 'auto', label: 'Auto', hint: 'patches' }, { value: 'off', label: 'Off' }], 'auto')).toBe('off')
  // The focused row shows its hint; the answer line is the label alone.
  expect(t.text()).toContain('● Auto (patches)')
  expect(t.text().trimEnd().endsWith('Off')).toBe(true)
})

test('text: Enter takes the default, typing replaces it', async () => {
  const s = screen()
  s.type([ENTER])
  expect(await s.ask.text('Port for the daemon:', '37811')).toBe('37811')
  expect(s.text()).toContain('37811')
  const t = screen()
  t.type(['4', '0', '0', '0', '0', ENTER])
  expect(await t.ask.text('Port for the daemon:', '37811')).toBe('40000')
})

test('text shows the validation problem and asks again', async () => {
  const s = screen()
  s.type(['x', ENTER, '\u007f', '2', '0', '0', '0', ENTER])
  const port = await s.ask.text('Port:', '37811', (value) => (/^\d+$/.test(value) ? null : 'a whole number'))
  expect(port).toBe('2000')
  expect(s.text()).toContain('a whole number')
})

test('text validates the default too, when Enter is pressed on nothing', async () => {
  const s = screen()
  s.type([ENTER, 'o', 'k', ENTER])
  const seen: string[] = []
  const value = await s.ask.text('Folder:', '', (typed) => (seen.push(typed), typed.trim() === '' ? 'a folder is needed' : null))
  expect(value).toBe('ok')
  expect(seen[0]).toBe('')
  expect(s.text()).toContain('a folder is needed')
})

test('password never echoes what is typed', async () => {
  const s = screen()
  s.type(['s', 'k', '-', 's', 'e', 'c', 'r', 'e', 't', ENTER])
  expect(await s.ask.password('Key for openrouter')).toBe('sk-secret')
  expect(s.raw()).not.toContain('sk-secret')
  expect(s.raw()).not.toContain('secret')
})

test('confirm answers with y, n or Enter for the default', async () => {
  const yes = screen()
  yes.type(['y'])
  expect(await yes.ask.confirm('Encrypt memory.db?', false)).toBe(true)
  const no = screen()
  no.type(['n'])
  expect(await no.ask.confirm('Encrypt memory.db?', true)).toBe(false)
  const kept = screen()
  kept.type([ENTER])
  expect(await kept.ask.confirm('Encrypt memory.db?', true)).toBe(true)
})

for (const [name, key] of [['Ctrl-C', CTRL_C], ['Esc', ESC]] as const) {
  test(`${name} at any question rejects with PromptCancelled`, async () => {
    for (const run of [
      (ask: Prompts) => ask.select('q', [{ value: 'a', label: 'A' }], 'a'),
      (ask: Prompts) => ask.multiSelect('q', agents, []),
      (ask: Prompts) => ask.text('q', ''),
      (ask: Prompts) => ask.password('q'),
      (ask: Prompts) => ask.confirm('q', true),
    ]) {
      const s = screen()
      s.type([key])
      await expect(run(s.ask)).rejects.toBeInstanceOf(PromptCancelled)
    }
  })
}

test('intro, say, warn, error, outro and cancelled draw on the rail', () => {
  const s = screen()
  s.ask.intro('Kinfold 0.3.1')
  s.ask.say('Memory folder   ~/.kinfold')
  s.ask.warn('port 37811 is in use')
  s.ask.error('step 3 failed')
  s.ask.outro('Run kinfold status to check it.')
  s.ask.cancelled('install cancelled; nothing was changed')
  const lines = s.text().split('\n')
  expect(lines[0]).toBe('┌  Kinfold 0.3.1')
  expect(lines).toContain('│  Memory folder   ~/.kinfold')
  expect(lines).toContain('▲  port 37811 is in use')
  expect(lines).toContain('■  step 3 failed')
  expect(lines).toContain('└  Run kinfold status to check it.')
  expect(lines).toContain('└  install cancelled; nothing was changed')
})

test('a section is a titled box whose rows carry their marks', () => {
  const s = screen()
  s.ask.section('Installed', [{ mark: 'ok', text: 'Claude Code wired' }, { mark: 'warn', text: 'PATH left alone' }, { mark: 'fail', text: 'Codex not wired' }, { mark: 'none', text: 'log: ~/.kinfold/logs/install.log' }])
  const text = s.text()
  expect(text).toContain('Installed')
  expect(text).toContain('✓ Claude Code wired')
  expect(text).toContain('▲ PATH left alone')
  expect(text).toContain('✗ Codex not wired')
  expect(text).toContain('  log: ~/.kinfold/logs/install.log')
})

test('locked shows the label, the value and the note, and asks nothing', () => {
  const s = screen()
  s.ask.locked('Memory folder', '/home/u/.kinfold', 'Chosen at first install.')
  expect(s.text()).toContain('Memory folder  /home/u/.kinfold  Chosen at first install.')
})

test('progress draws one bar that ends in one line', () => {
  const s = screen()
  const progress = s.ask.progress(2)
  progress.step('wiring Claude Code')
  progress.note('  1. write x  [done]')
  progress.step('starting the daemon')
  progress.done('2 steps done')
  expect(s.text()).toContain('0/2  wiring Claude Code')
  expect(s.text()).toContain('1/2  starting the daemon')
  expect(s.text()).toContain('◇  2 steps done')
})

test('busy shows its label until it ends', () => {
  const s = screen()
  s.ask.busy('checking the download').done('checked')
  expect(s.text()).toContain('checking the download')
  expect(s.text()).toContain('◇  checked')
})

test('control and format characters in a question, a label, a hint or a line never reach the screen', async () => {
  const s = screen()
  s.type([ENTER])
  await s.ask.select('Pick\u001b[2J', [{ value: 'x', label: 'ev\u001b[31mil‮', hint: 'h\u0007' }], 'x')
  s.ask.say('li\u001b[2Jne')
  s.ask.section('ti\u001b[2Jtle', [{ mark: 'none', text: 'ro\u001b[2Jw' }])
  expect(s.raw()).not.toContain('\u001b[2J')
  expect(s.raw()).not.toContain('\u001b[31mil')
  expect(s.raw()).not.toContain('‮')
  expect(s.raw()).not.toContain('\u0007')
})

test('select shows a warning on its row even when another row is focused, and a disabled row says why', async () => {
  const s = screen()
  s.type([ENTER])
  const rows: Choice<string>[] = [
    { value: 'current', label: 'claude-cli/haiku', hint: 'built-in default', warn: 'claude not installed; pick another' },
    { value: 'claude-cli', label: 'claude-cli', disabled: 'claude not installed' },
    { value: 'openrouter', label: 'openrouter' },
  ]
  expect(await s.ask.select('Observer for codex:', rows, 'openrouter')).toBe('openrouter')
  expect(s.text()).toContain('claude-cli/haiku (claude not installed; pick another)')
  expect(s.text()).toContain('claude-cli (claude not installed)')
})

test('a row too long for the box wraps under its own text, past the mark, and no line runs past the box', () => {
  const input = new PassThrough()
  const output = Object.assign(new PassThrough(), { columns: 44, rows: 24 })
  let written = ''
  output.on('data', (chunk: Buffer) => (written += chunk.toString()))
  const ask = createClackPrompts({ input, output })
  const long = 'kinfold command: ~/.local/bin/kinfold, with ~/.local/bin on PATH through ~/.bashrc and ~/.bash_profile'
  ask.section('Installed', [{ mark: 'ok', text: long }, { mark: 'none', text: 'Encryption: off' }])
  const lines = stripVTControlCharacters(written).split('\n')
  const first = lines.findIndex((line) => line.includes('kinfold command:'))
  const last = lines.findIndex((line) => line.includes('Encryption: off'))
  expect(first).toBeGreaterThan(-1)
  const continued = lines.slice(first + 1, last)
  expect(continued.length).toBeGreaterThan(0)
  // The bar, two spaces of the box, then two more where the mark and its space stand on the first line.
  for (const line of continued) expect(line).toMatch(/^│ {4}\S/)
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(44)
  // Nothing of the row is lost to the wrapping.
  const words = [lines[first]!, ...continued].map((line) => line.replace(/^│\s+(✓|\+)?\s*/, '').replace(/\s*│$/, '')).join(' ')
  expect(words.replace(/\s+/g, ' ')).toBe(long)
})

test('a row that fits keeps its own spacing: only a row too long for the box is wrapped', () => {
  const input = new PassThrough()
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  let written = ''
  output.on('data', (chunk: Buffer) => (written += chunk.toString()))
  createClackPrompts({ input, output }).section('Agents', [{ mark: 'none', text: '  codex:   wired' }])
  expect(stripVTControlCharacters(written)).toContain('    codex:   wired')
})
