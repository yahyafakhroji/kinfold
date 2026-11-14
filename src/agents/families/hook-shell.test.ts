import { describe, expect, test } from 'bun:test'
import { cmdCommand, cmdWords, hookCommandText, posixCommand, powershellCommand, powershellWords } from './hook-shell'

const PROGRAM = 'C:\\Users\\dev\\.kinfold\\bin\\kinfold.exe'
const DATA = 'C:\\Users\\dev\\.kinfold'
const entry = (command: string, dataDir: string, host = 'copilot') => ({ command, args: ['--data-dir', dataDir, 'hook', '--host', host] })
const words = (e: { command: string; args: string[] }): string[] => [e.command, ...e.args]

// Every character the installer can meet in a Windows profile path and that one of the shells treats specially.
const AWKWARD: readonly string[] = [
  'C:\\Users\\Jo Ann\\.kinfold',
  "C:\\Users\\O'Brien\\.kinfold",
  'C:\\Users\\R&D\\.kinfold',
  'C:\\Users\\100%\\.kinfold',
  'C:\\Users\\%TEMP%\\.kinfold',
  'C:\\Users\\a^b\\.kinfold',
  'C:\\Users\\Zoë 山田\\.kinfold',
  'C:\\Users\\it’s ‘q’ ‚x‛\\.kinfold',
  'C:\\Users\\$env:X `t (x) {y} ;z\\.kinfold',
  'C:\\Users\\!a! #b @c ,d =e\\.kinfold',
  'C:\\Users\\tail\\%x',
  "C:\\Users\\O'Brien & Co\\100%\\a^b\\données",
]

describe('the POSIX form', () => {
  test('quotes paths in single quotes and leaves flags, the subcommand and the host bare', () => {
    expect(posixCommand(entry('/Users/dev/.kinfold/bin/kinfold', "/Users/dev/it's here"))).toBe(
      `'/Users/dev/.kinfold/bin/kinfold' --data-dir '/Users/dev/it'\\''s here' hook --host copilot`,
    )
    expect(hookCommandText(entry(PROGRAM, DATA), 'posix')).toBe(posixCommand(entry(PROGRAM, DATA)))
  })
})

describe('the PowerShell form', () => {
  test('calls the program with the call operator and single-quoted paths', () => {
    expect(powershellCommand(entry(PROGRAM, DATA))).toBe(`& '${PROGRAM}' --data-dir '${DATA}' hook --host copilot`)
    expect(hookCommandText(entry(PROGRAM, DATA), 'powershell')).toBe(powershellCommand(entry(PROGRAM, DATA)))
  })

  test('doubles an apostrophe, and the curly quotes PowerShell reads as one', () => {
    expect(powershellCommand(entry(PROGRAM, "C:\\Users\\O'Brien"))).toContain(`--data-dir 'C:\\Users\\O''Brien' hook`)
    expect(powershellCommand(entry(PROGRAM, 'C:\\it’s ‘q‛ ‚'))).toContain(`--data-dir 'C:\\it’’s ‘‘q‛‛ ‚‚' hook`)
  })

  test('holds no double quote, so the string survives being passed as one process argument', () => {
    for (const path of AWKWARD) expect(powershellCommand(entry(`${path}\\bin\\kinfold.exe`, path))).not.toContain('"')
  })

  test('reads back to the words it was written from', () => {
    for (const path of AWKWARD) {
      const e = entry(`${path}\\bin\\kinfold.exe`, path)
      expect(powershellWords(powershellCommand(e))).toEqual(words(e))
    }
  })

  test('reads a bare call too, and nothing that is more than one call', () => {
    expect(powershellWords('& C:\\k\\bin\\kinfold.exe hook --host cursor')).toEqual(['C:\\k\\bin\\kinfold.exe', 'hook', '--host', 'cursor'])
    expect(powershellWords(`&   'C:\\k\\bin\\kinfold.exe'   hook`)).toEqual(['C:\\k\\bin\\kinfold.exe', 'hook'])
    for (const text of [
      `'C:\\k\\bin\\kinfold.exe' hook`,
      `& 'C:\\k\\bin\\kinfold.exe' hook; Remove-Item x`,
      `& 'C:\\k\\bin\\kinfold.exe' hook | Out-Null`,
      `& 'C:\\k\\bin\\kinfold.exe' $env:X`,
      `& "C:\\k\\bin\\kinfold.exe" hook`,
      `& 'C:\\k\\bin\\kinfold.exe' 'unterminated`,
      `& 'C:\\k\\bin\\kinfold.exe''hook`,
      '&',
    ]) expect(powershellWords(text)).toBeNull()
  })
})

describe('the cmd form', () => {
  test('starts with @ so cmd /c strips no quote, and double-quotes the paths', () => {
    expect(cmdCommand(entry(PROGRAM, DATA, 'junie'))).toBe(`@"${PROGRAM}" --data-dir "${DATA}" hook --host junie`)
    expect(hookCommandText(entry(PROGRAM, DATA), 'cmd')).toBe(cmdCommand(entry(PROGRAM, DATA)))
  })

  test('keeps & and ^ inside the quotes, where cmd reads them as text', () => {
    expect(cmdCommand(entry(PROGRAM, 'C:\\R&D\\a^b'))).toContain('--data-dir "C:\\R&D\\a^b" hook')
  })

  test('puts a percent sign outside the quotes behind a caret, so no variable expands', () => {
    expect(cmdCommand(entry(PROGRAM, 'C:\\Users\\100%\\d'))).toContain('--data-dir "C:\\Users\\100"^%"\\d" hook')
    expect(cmdCommand(entry(PROGRAM, 'C:\\%TEMP%'))).toContain('--data-dir "C:\\\\"^%"TEMP"^% hook')
    expect(cmdCommand(entry(PROGRAM, '%%x'))).toContain('--data-dir ^%^%"x" hook')
  })

  test('doubles the backslashes before a closing quote, which the program would read as an escape', () => {
    expect(cmdCommand(entry(PROGRAM, 'C:\\data dir\\'))).toContain('--data-dir "C:\\data dir\\\\" hook')
    expect(cmdCommand(entry(PROGRAM, 'C:\\a\\\\'))).toContain('--data-dir "C:\\a\\\\\\\\" hook')
  })

  test('refuses a word cmd cannot carry', () => {
    expect(() => cmdCommand(entry(PROGRAM, 'C:\\a"b'))).toThrow('cmd')
    expect(() => cmdCommand(entry(PROGRAM, 'C:\\a\nb'))).toThrow('cmd')
  })

  test('reads back to the words it was written from', () => {
    for (const path of [...AWKWARD, 'C:\\data dir\\', '%%x']) {
      const e = entry(`${path}\\bin\\kinfold.exe`, path)
      expect(cmdWords(cmdCommand(e))).toEqual(words(e))
    }
  })

  test('reads nothing that is more than one command', () => {
    expect(cmdWords('@C:\\k\\bin\\kinfold.exe hook --host junie')).toEqual(['C:\\k\\bin\\kinfold.exe', 'hook', '--host', 'junie'])
    for (const text of [
      '"C:\\k\\bin\\kinfold.exe" hook',
      '@"C:\\k\\bin\\kinfold.exe" hook & del x',
      '@"C:\\k\\bin\\kinfold.exe" hook > out.txt',
      '@"C:\\k\\bin\\kinfold.exe" %X%',
      '@"C:\\k\\bin\\kinfold.exe" "unterminated',
      '@"C:\\k\\bin\\kinfold.exe\\" hook',
      '@',
    ]) expect(cmdWords(text)).toBeNull()
  })
})
