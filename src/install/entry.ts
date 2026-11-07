// One place decides what a host runs and which entries are Kinfold's. A
// checkout install starts bun on a script in the checkout; an installed
// program runs <dataDir>/bin/kinfold. Both forms carry the data folder, the
// checkout through the store defaults and the program through --data-dir
// before the subcommand, so a hook, MCP server or daemon always reads the
// store the installer chose.
//
// Recognition is by what the command runs, never by position or by a name
// alone: the checkout form must be bun with one of our scripts, and the
// program form must be a kinfold program in a bin folder with one of the
// subcommands. A user's hook, MCP server or kinfold-named binary with other
// arguments therefore never matches.

import { join } from 'node:path'

export { isCompiledProgram } from '../runtime/program'

export type EntryRole = 'hook' | 'mcp' | 'daemon'

export type InstallMode =
  | { kind: 'program'; binPath: string }
  | { kind: 'checkout'; bunPath: string; projectRoot: string }

export interface EntryCommand {
  command: string
  args: string[]
}

export interface ParsedEntry {
  command: string
  args: string[]
  role: EntryRole
}

const CHECKOUT_SCRIPTS: Readonly<Record<EntryRole, string>> = {
  hook: 'src/cli/hook.ts',
  mcp: 'src/mcp/server.ts',
  daemon: 'src/daemon/main.ts',
}

const PROGRAM_SUBCOMMANDS: readonly EntryRole[] = ['hook', 'mcp', 'daemon']

export function installedProgramPath(dataDir: string, platform: string): string {
  return join(dataDir, 'bin', platform === 'win32' ? 'kinfold.exe' : 'kinfold')
}

export function entryCommand(mode: InstallMode, role: EntryRole, dataDir: string, host?: string): EntryCommand {
  const hostArgs = role === 'hook' && host !== undefined ? ['--host', host] : []
  if (mode.kind === 'program') {
    return { command: mode.binPath, args: ['--data-dir', dataDir, role, ...hostArgs] }
  }
  return { command: mode.bunPath, args: [join(mode.projectRoot, CHECKOUT_SCRIPTS[role]), ...hostArgs] }
}

/** What an entry of ours names: the checkout script, or the program path. */
export function entryIdentity(mode: InstallMode, role: EntryRole, dataDir: string, host?: string): string {
  const entry = entryCommand(mode, role, dataDir, host)
  return entryPath(entry.command, entry.args) ?? entry.command
}

export function isOurEntry(command: string, args: readonly string[]): boolean {
  return parseEntry(command, args) !== null
}

/** The role an entry of ours runs, or null when the entry is not ours. */
export function entryRole(command: string, args: readonly string[]): EntryRole | null {
  return parseEntry(command, args)?.role ?? null
}

/** The checkout script path, or the program path, an entry of ours runs; null when it is not ours. */
export function entryPath(command: string, args: readonly string[]): string | null {
  const parsed = parseEntry(command, args)
  if (parsed === null) return null
  return isProgram(parsed.command) ? parsed.command : (parsed.args[0] ?? null)
}

/**
 * The entry a host config holds, read as a command plus its arguments. A
 * command string such as a Codex or Cursor hook is split the way a shell
 * reads it; an absolute path with spaces is used whole, because an argv
 * command never needs the shell.
 */
export function parseEntry(command: string, args: readonly string[]): ParsedEntry | null {
  const direct = classify(command, args)
  if (direct !== null) return direct
  const words = shellWords(command)
  if (words === null || words.length < 2) return null
  const [program, ...rest] = words
  return program === undefined ? null : classify(program, [...rest, ...args])
}

function classify(command: string, args: readonly string[]): ParsedEntry | null {
  const list = args.filter((arg): arg is string => typeof arg === 'string')
  const role = isBun(command) ? checkoutRole(list) : isProgram(command) ? programRole(list) : null
  return role === null ? null : { command, args: list, role }
}

/** A checkout runs bun with one of our scripts; a hook may add its host. */
function checkoutRole(args: readonly string[]): EntryRole | null {
  const script = normalizePath(args[0] ?? '')
  const role = PROGRAM_SUBCOMMANDS.find((candidate) => script.endsWith(`/${CHECKOUT_SCRIPTS[candidate]}`))
  if (role === undefined) return null
  const rest = args.slice(1)
  if (rest.length === 0) return role
  return role === 'hook' && rest.length === 2 && rest[0] === '--host' && rest[1] !== undefined && rest[1] !== '' ? role : null
}

/**
 * A program in a bin folder takes our subcommand, after --data-dir when it
 * is there. A hook may add its host. Anything else is someone else's program.
 */
function programRole(args: readonly string[]): EntryRole | null {
  const first = args[0]
  const start = first === '--data-dir' ? 2 : first?.startsWith('--data-dir=') === true ? 1 : 0
  const role = args[start]
  if (role === undefined || !PROGRAM_SUBCOMMANDS.includes(role as EntryRole)) return null
  const rest = args.slice(start + 1)
  if (rest.length === 0) return role as EntryRole
  return role === 'hook' && rest.length === 2 && rest[0] === '--host' && rest[1] !== undefined && rest[1] !== '' ? (role as EntryRole) : null
}

const BUN_NAMES: ReadonlySet<string> = new Set(['bun', 'bun.exe'])
const PROGRAM_NAMES: ReadonlySet<string> = new Set(['kinfold', 'kinfold.exe'])

function isBun(command: string): boolean {
  return BUN_NAMES.has(baseName(command).toLowerCase())
}

function isProgram(command: string): boolean {
  return PROGRAM_NAMES.has(baseName(command).toLowerCase()) && parentName(command) === 'bin'
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function baseName(command: string): string {
  const path = normalizePath(command)
  return path.slice(path.lastIndexOf('/') + 1)
}

function parentName(command: string): string {
  const path = normalizePath(command)
  const at = path.lastIndexOf('/')
  return at <= 0 ? '' : (path.slice(0, at).split('/').at(-1) ?? '')
}

/** Splits a shell command string, keeping quoted paths and an escaped quote in one word. */
function shellWords(input: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ''
    if (char === "'") {
      inWord = true
      const end = input.indexOf("'", index + 1)
      if (end === -1) return null
      current += input.slice(index + 1, end)
      index = end
      continue
    }
    if (char === '"') {
      inWord = true
      for (index += 1; index < input.length; index += 1) {
        const inner = input[index] ?? ''
        if (inner === '"') break
        if (inner === '\\' && input[index + 1] === '"') {
          current += '"'
          index += 1
          continue
        }
        current += inner
      }
      if (index >= input.length) return null
      continue
    }
    if (/\s/.test(char)) {
      if (inWord) {
        words.push(current)
        current = ''
        inWord = false
      }
      continue
    }
    inWord = true
    if (char === '\\' && index + 1 < input.length) {
      index += 1
      current += input[index] ?? ''
      continue
    }
    current += char
  }
  if (inWord) words.push(current)
  return words
}
