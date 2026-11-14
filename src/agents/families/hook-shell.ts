// One hook entry as the command string a shell reads, for the agents that
// take a string and run it through a shell, and the readers that turn such a
// string back into its words. Three shells:
//   posix:      '/p/bin/kinfold' --data-dir '/d' hook --host x
//   powershell: & 'C:\p\bin\kinfold.exe' --data-dir 'C:\d' hook --host x
//   cmd:        @"C:\p\bin\kinfold.exe" --data-dir "C:\d" hook --host x
// PowerShell reads a quoted string at the start of a line as a value, so the
// call operator comes first. It holds no double quote, so an agent can pass
// the whole string as one process argument unchanged.
// cmd /c strips the first and last quote of a command line that starts with
// one, which breaks a line holding more than one quoted word; the leading @
// (echo off, for one command) keeps the line from starting with a quote, and
// the line still reads right when the agent wraps it in quotes of its own
// (Codex's `/C "<line>"`, Node's `/d /s /c "<line>"`). cmd expands %NAME%
// inside quotes too, so a percent sign sits outside them behind a caret.
// The live test (windows-hook-command.live.test.ts) runs both forms through
// the real shells on a Windows runner.
// Types only from the installer, so entry.ts can import the readers.

import type { EntryCommand } from '../../install/entry'

export type HookShell = 'posix' | 'powershell' | 'cmd'

const BARE_WORDS: ReadonlySet<string> = new Set(['hook', 'mcp', 'daemon'])

/** The entry's words with `quote` on each path; flags, the host id and the subcommand stay bare. */
function render(entry: EntryCommand, quote: (word: string) => string): string[] {
  const words = [entry.command, ...entry.args]
  const parts: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (word === '--host') {
      parts.push(word, words[index + 1] ?? '')
      index += 1
      continue
    }
    parts.push(word.startsWith('--') || BARE_WORDS.has(word) ? word : quote(word))
  }
  return parts
}

const posixQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function posixCommand(entry: EntryCommand): string {
  return render(entry, posixQuote).join(' ')
}

/** PowerShell ends a single-quoted string at any of these, the curly ones included. */
const POWERSHELL_QUOTES = "'\u2018\u2019\u201A\u201B"
const POWERSHELL_QUOTE = new RegExp(`[${POWERSHELL_QUOTES}]`, 'g')

const powershellQuote = (value: string): string => `'${value.replace(POWERSHELL_QUOTE, (quote) => quote + quote)}'`

export function powershellCommand(entry: EntryCommand): string {
  return `& ${render(entry, powershellQuote).join(' ')}`
}

/** A quoted run for cmd; the program reads backslashes before the closing quote as escapes, so those are doubled. */
function cmdQuotedRun(run: string): string {
  const trailing = /\\*$/.exec(run)?.[0] ?? ''
  return `"${run}${trailing}"`
}

function cmdQuote(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error(`a hook command for cmd cannot carry a double quote or a line break: ${JSON.stringify(value)}`)
  if (value === '') return '""'
  return value.split('%').map((run) => (run === '' ? '' : cmdQuotedRun(run))).join('^%')
}

export function cmdCommand(entry: EntryCommand): string {
  return `@${render(entry, cmdQuote).join(' ')}`
}

export function hookCommandText(entry: EntryCommand, shell: HookShell): string {
  if (shell === 'powershell') return powershellCommand(entry)
  return shell === 'cmd' ? cmdCommand(entry) : posixCommand(entry)
}

/** What an unquoted word may hold in either Windows reader: nothing a shell would act on. */
const BARE_CHAR = /[A-Za-z0-9._=/\\:+~-]/

const isSpace = (char: string): boolean => /\s/.test(char)

/** One single-quoted PowerShell string starting at `start`; the value and the index after its closing quote. */
function powershellString(text: string, start: number): { value: string; next: number } | null {
  let value = ''
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (!POWERSHELL_QUOTES.includes(char)) {
      value += char
      continue
    }
    const after = text[index + 1] ?? ''
    if (after === '' || !POWERSHELL_QUOTES.includes(after)) return { value, next: index + 1 }
    value += char
    index += 1
  }
  return null
}

/**
 * The words of `& <program> <args>` as PowerShell reads them, or null when
 * the text is anything else: a pipeline, a second statement, a variable or a
 * double-quoted string, none of which an install writes.
 */
export function powershellWords(text: string): string[] | null {
  const line = text.trim()
  if (!line.startsWith('&') || !isSpace(line[1] ?? '')) return null
  const words: string[] = []
  let index = 1
  while (index < line.length) {
    const char = line[index] ?? ''
    if (isSpace(char)) {
      index += 1
      continue
    }
    if (POWERSHELL_QUOTES.includes(char)) {
      const quoted = powershellString(line, index)
      if (quoted === null) return null
      words.push(quoted.value)
      index = quoted.next
    } else {
      let end = index
      while (end < line.length && BARE_CHAR.test(line[end] ?? '')) end += 1
      if (end === index) return null
      words.push(line.slice(index, end))
      index = end
    }
    if (index < line.length && !isSpace(line[index] ?? '')) return null
  }
  return words.length === 0 ? null : words
}

/** A quoted cmd run starting at `start`, with the doubled backslashes before its closing quote undone. */
function cmdRun(text: string, start: number): { value: string; next: number } | null {
  const end = text.indexOf('"', start + 1)
  if (end === -1) return null
  const run = text.slice(start + 1, end)
  const trailing = /\\*$/.exec(run)?.[0].length ?? 0
  if (trailing % 2 !== 0) return null
  return { value: run.slice(0, run.length - trailing / 2), next: end + 1 }
}

/**
 * The words of `@<program> <args>` as cmd and then the program read them, or
 * null when the text is anything else: a second command, a redirect or a
 * variable, none of which an install writes.
 */
export function cmdWords(text: string): string[] | null {
  const line = text.trim()
  if (!line.startsWith('@')) return null
  const words: string[] = []
  let current: string | null = null
  let index = 1
  while (index < line.length) {
    const char = line[index] ?? ''
    if (isSpace(char)) {
      if (current !== null) words.push(current)
      current = null
      index += 1
    } else if (char === '"') {
      const run = cmdRun(line, index)
      if (run === null) return null
      current = (current ?? '') + run.value
      index = run.next
    } else if (char === '^' && index + 1 < line.length) {
      current = (current ?? '') + (line[index + 1] ?? '')
      index += 2
    } else if (BARE_CHAR.test(char)) {
      current = (current ?? '') + char
      index += 1
    } else {
      return null
    }
  }
  if (current !== null) words.push(current)
  return words.length === 0 ? null : words
}
