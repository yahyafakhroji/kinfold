import { expect, test } from 'bun:test'
import { fakeTerminal } from './fake-terminal'
import { decodeKeys } from './keys'
import { type Choice, PromptCancelled, createPrompts } from './prompts'

const choices: Choice<string>[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: 'not here' },
  { value: 'c', label: 'Gamma', hint: 'third' },
]

test('decodeKeys names arrows, space, enter and Ctrl-C', () => {
  expect(decodeKeys('\u001b[A\u001b[B \r\u0003').map((key) => key.name)).toEqual(['up', 'down', 'space', 'enter', 'ctrl-c'])
})

test('decodeKeys keeps typed text, and drops unknown sequences and control bytes', () => {
  expect(decodeKeys('h\u001b[5~i\u0001\u007f')).toEqual([{ name: 'char', char: 'h' }, { name: 'char', char: 'i' }, { name: 'backspace' }])
  expect(decodeKeys('\u001b')).toEqual([{ name: 'escape' }])
  expect(decodeKeys('\u001bOB')).toEqual([{ name: 'down' }])
})

test('select: Enter accepts the default', async () => {
  const term = fakeTerminal(['\r'])
  expect(await createPrompts(term).select('Port', choices, 'c')).toBe('c')
})

test('select skips disabled choices', async () => {
  const term = fakeTerminal(['\u001b[B', '\r'])
  expect(await createPrompts(term).select('Pick', choices, 'a')).toBe('c')
})

test('select wraps upward over a disabled choice', async () => {
  const term = fakeTerminal(['\u001b[A', '\r'])
  expect(await createPrompts(term).select('Pick', choices, 'a')).toBe('c')
})

test('select strips control and format characters from labels', async () => {
  const term = fakeTerminal(['\r'])
  await createPrompts(term).select('Pick\u001b[2J', [{ value: 'x', label: 'ev\u001b[31mil‮' }], 'x')
  expect(term.output()).toContain('ev[31mil')
  expect(term.output()).not.toContain('‮')
  expect(term.output()).not.toContain('\u001b[2J')
  expect(term.output()).not.toContain('\u001b[31m')
})

test('multiSelect toggles with space', async () => {
  const two: Choice<string>[] = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
  const term = fakeTerminal([{ name: 'space' }, { name: 'down' }, { name: 'space' }, { name: 'enter' }])
  expect(await createPrompts(term).multiSelect('Hosts', two, ['a'])).toEqual(['b'])
})

test('multiSelect cannot toggle a disabled choice', async () => {
  const term = fakeTerminal(['\u001b[B', ' ', '\r'])
  expect(await createPrompts(term).multiSelect('Hosts', choices, [])).toEqual(['c'])
})

test('text validates and asks again', async () => {
  const term = fakeTerminal(['x\r', '40000\r'])
  const value = await createPrompts(term).text('Port', '', (v) => (v === 'x' ? 'not a port' : null))
  expect(value).toBe('40000')
  expect(term.output().split('not a port').length - 1).toBe(1)
})

test('text takes the default on an empty answer, and backspace edits', async () => {
  expect(await createPrompts(fakeTerminal(['\r'])).text('Port', '37811')).toBe('37811')
  expect(await createPrompts(fakeTerminal(['ab\u007fc\r'])).text('Name', '')).toBe('ac')
})

test('confirm takes y, n and the default', async () => {
  expect(await createPrompts(fakeTerminal(['\r'])).confirm('Go?', true)).toBe(true)
  expect(await createPrompts(fakeTerminal(['n'])).confirm('Go?', true)).toBe(false)
  expect(await createPrompts(fakeTerminal(['q', 'Y'])).confirm('Go?', false)).toBe(true)
})

test('Ctrl-C cancels and restores the terminal', async () => {
  const term = fakeTerminal(['\u001b[B', '\u0003'])
  await expect(createPrompts(term).select('Pick', choices, 'a')).rejects.toBeInstanceOf(PromptCancelled)
  expect(term.rawStates()).toEqual([true, false])
  expect(term.output().endsWith('\u001b[?25h')).toBe(true)
})

test('a closed key stream cancels the same way, for every prompt', async () => {
  for (const run of [
    (p: ReturnType<typeof createPrompts>) => p.select('Pick', choices, 'a'),
    (p: ReturnType<typeof createPrompts>) => p.multiSelect('Pick', choices, []),
    (p: ReturnType<typeof createPrompts>) => p.text('Name', ''),
    (p: ReturnType<typeof createPrompts>) => p.confirm('Go?', true),
  ]) {
    const term = fakeTerminal([])
    await expect(run(createPrompts(term))).rejects.toBeInstanceOf(PromptCancelled)
    expect(term.rawStates().at(-1)).toBe(false)
  }
})

test('a validator that throws still restores the terminal', async () => {
  const term = fakeTerminal(['x\r'])
  await expect(createPrompts(term).text('Port', '', () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(term.rawStates().at(-1)).toBe(false)
})

test('keys left over from one prompt serve the next', async () => {
  const term = fakeTerminal(['\r', 'y'])
  const prompts = createPrompts(term)
  expect(await prompts.select('Pick', choices, 'a')).toBe('a')
  expect(await prompts.confirm('Go?', false)).toBe(true)
})

test('locked takes no input', () => {
  const term = fakeTerminal([])
  createPrompts(term).locked('Observer', 'claude-cli', 'set by --observer')
  const out = term.output()
  expect(out).toContain('Observer')
  expect(out).toContain('claude-cli')
  expect(out).toContain('set by --observer')
  expect(term.rawStates()).toEqual([])
})
