import { expect, test } from 'bun:test'
import { createPlainOutput } from './plain'

function plain(): { lines: string[]; output: ReturnType<typeof createPlainOutput> } {
  const lines: string[] = []
  return { lines, output: createPlainOutput((line) => void lines.push(line)) }
}

test('the plain renderer is not framed', () => {
  expect(plain().output.framed).toBe(false)
})

test('an intro prints nothing: a script reads the same first line as before', () => {
  const { lines, output } = plain()
  output.intro('Kinfold 0.3.1')
  expect(lines).toEqual([])
})

test('say, warn, error, outro and cancelled print the line as given', () => {
  const { lines, output } = plain()
  output.say('one')
  output.warn('two')
  output.error('three')
  output.outro('four')
  output.cancelled('five')
  expect(lines).toEqual(['one', 'two', 'three', 'four', 'five'])
})

test('an empty outro prints nothing', () => {
  const { lines, output } = plain()
  output.outro('')
  expect(lines).toEqual([])
})

test('a section is its title with a colon, then each row indented, with no marks', () => {
  const { lines, output } = plain()
  output.section('hosts', [{ mark: 'ok', text: 'claude-code: wired' }, { mark: 'fail', text: 'codex: not wired' }])
  expect(lines).toEqual(['hosts:', '  claude-code: wired', '  codex: not wired'])
})

test('progress prints only its notes and its last line', () => {
  const { lines, output } = plain()
  const progress = output.progress(3)
  progress.step('wiring Claude Code')
  progress.note('a warning', 'warn')
  progress.step('starting the daemon')
  progress.done('installed')
  expect(lines).toEqual(['a warning', 'installed'])
})

test('a failed progress and a failed busy print the failure', () => {
  const { lines, output } = plain()
  output.progress(1).fail('step 1 failed')
  output.busy('downloading').fail('no network')
  output.busy('checking').done('checked')
  output.busy('quiet').done('')
  expect(lines).toEqual(['step 1 failed', 'no network', 'checked'])
})

test('no line carries an escape code or a control character', () => {
  const { lines, output } = plain()
  output.say('ev\u001b[31mil')
  output.section('t\u0007', [{ mark: 'none', text: 'r\u001b[2J' }])
  expect(lines.join('\n')).not.toMatch(/[\u001b\u0007]/)
})
