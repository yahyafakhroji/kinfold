// `kinfold <install|uninstall|status> [flags]`. Hand-parsed, zero dependencies. A
// flag that does not apply to the command is an error rather than ignored, so
// `kinfold status --dry-run` cannot be mistaken for a promise.

import type { Parsed } from '../context/types'
import { parsePurgeBody, parseRetentionPut } from '../data-control/requests'
import type { ResolveAction } from '../data-control/resolve'
import type { DataSettingsChange } from '../store/data-settings-store'
import { INSTALL_HOSTS, type InstallHost } from './detect'
import { type ObserverFlag, parseProviderModel } from './observer-choice'

export const COMMANDS = ['install', 'uninstall', 'status'] as const
export type Command = (typeof COMMANDS)[number]

export interface CliArgs {
  command: Command
  dryRun: boolean
  yes: boolean
  skipCheck: boolean
  replaceCredential: boolean
  credentialStdin: boolean
  takeover: boolean
  removeCredentials: boolean
  removeHmacKeys: boolean
  hosts: InstallHost[] | null
  observers: ObserverFlag[]
}

type BooleanFlag = 'dryRun' | 'yes' | 'skipCheck' | 'replaceCredential' | 'credentialStdin' | 'takeover' | 'removeCredentials' | 'removeHmacKeys'

const BOOLEAN_FLAGS: Readonly<Record<string, { key: BooleanFlag; commands: readonly Command[] }>> = {
  '--dry-run': { key: 'dryRun', commands: ['install', 'uninstall'] },
  '--yes': { key: 'yes', commands: ['install'] },
  '--skip-check': { key: 'skipCheck', commands: ['install'] },
  '--replace-credential': { key: 'replaceCredential', commands: ['install'] },
  '--credential-stdin': { key: 'credentialStdin', commands: ['install'] },
  '--takeover': { key: 'takeover', commands: ['install'] },
  '--remove-credentials': { key: 'removeCredentials', commands: ['uninstall'] },
  '--remove-hmac-keys': { key: 'removeHmacKeys', commands: ['uninstall'] },
}

export const USAGE = [
  'usage: kinfold <install|uninstall|status|size|retention|scan|findings|purge|dashboard|encrypt|decrypt|rekey|key|hook|mcp|daemon|observe> [--data-dir <path>] [--version] [flags]',
  '  install    [--dry-run] [--yes] [--hosts claude-code,opencode,codex,cursor] [--observer <host>=<provider>:<model>]...',
  '             [--skip-check] [--replace-credential] [--credential-stdin] [--takeover]',
  '  uninstall  [--dry-run] [--remove-credentials] [--remove-hmac-keys]',
  '             --remove-hmac-keys deletes Keychain hmac-master and hmac-legacy and hmac.d/: stored refs can no longer',
  '             be checked, and a later install starts a new master (hmac.key is written back from hmac-legacy first)',
  '  status',
  '  dashboard  [--print]',
  '  size',
  '  retention  [--set <events|prompts|observations|summaries>=<days|keep>]... [--set warn_bytes=<n>] [--yes]',
  '  scan',
  '  findings   [--all] [--redact <id> | --purge <id>]',
  '  purge      --session <id> | --project <key> | --host <host> | --observation <id> | --before <iso> [--after <iso>] [--dry-run]',
  '  encrypt    convert memory.db to an encrypted file; shows a recovery code to keep',
  '  decrypt    store memory.db in plaintext again and delete its key',
  '  rekey      give memory.db a new key and a new recovery code',
  '  key show-recovery | key recover   show the recovery code, or put the key back from one (on stdin or typed)',
  '  key resume finish or undo a kinfold encrypt, decrypt or rekey that was cut short',
  '  hook       [--host codex|cursor]   record one host hook payload from stdin, Claude Code by default',
  '  mcp        answer the MCP stdio protocol on stdin and stdout',
  '  daemon     run the local daemon on loopback',
  '  observe    <session-id>   run the observer once for one session',
  '  --data-dir <path>   the data folder for this process; wins over KINFOLD_DATA_DIR; may come before or after the command',
  '  --version  print the version of this build',
].join('\n')

// ---- Data control: `kinfold size|retention|scan|findings|purge` -----------------
// A separate dispatch from install/uninstall/status: these only talk to the
// daemon's /data routes, and their bodies are checked here with the same
// validators the daemon uses, so a usage error never reaches the daemon.

export const DATA_COMMANDS = ['size', 'retention', 'scan', 'findings', 'purge'] as const
export type DataCommand = (typeof DATA_COMMANDS)[number]

export type DataArgs =
  | { command: 'size' }
  | { command: 'scan' }
  /** apply: --yes; without it a change is only previewed. */
  | { command: 'retention'; change: DataSettingsChange | null; apply: boolean }
  | { command: 'findings'; all: boolean; resolve: { id: number; action: ResolveAction } | null }
  | { command: 'purge'; body: Record<string, string | number | boolean> }

interface DataFlag {
  name: string
  value: string | null
}

/** `--name value` or `--name=value`, for every flag of a data command; booleans take no value. */
function dataFlags(argv: readonly string[], booleans: readonly string[]): Parsed<DataFlag[]> {
  const flags: DataFlag[] = []
  for (let index = 1; index < argv.length; ) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('--')) return { ok: false, error: `unknown argument ${JSON.stringify(arg)}\n${USAGE}` }
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (booleans.includes(name) && !arg.includes('=')) {
      flags.push({ name, value: null })
      index += 1
      continue
    }
    const found = valueOf(argv, index, name)
    if (found === null) return { ok: false, error: `${name} needs a value` }
    flags.push({ name, value: found.value })
    index += found.used
  }
  return { ok: true, value: flags }
}

const RETENTION_SET = /^([a-z_]+)=(\d+|keep)$/

function retentionArgs(flags: readonly DataFlag[]): Parsed<DataArgs> {
  const retention: Record<string, number | null> = {}
  const body: Record<string, unknown> = {}
  const isYes = (flag: DataFlag): boolean => flag.name === '--yes' && flag.value === null
  const apply = flags.some(isYes)
  const sets = flags.filter((flag) => !isYes(flag))
  for (const flag of sets) {
    const match = flag.name === '--set' ? RETENTION_SET.exec(flag.value ?? '') : null
    if (match === null) return { ok: false, error: 'retention takes --set <table>=<days|keep> or --set warn_bytes=<n>, and --yes to apply' }
    const value = match[2] === 'keep' ? null : Number(match[2])
    if (match[1] === 'warn_bytes') body.warnBytes = value
    else retention[match[1]!] = value
  }
  if (sets.length === 0) return apply ? { ok: false, error: 'retention --yes needs at least one --set' } : { ok: true, value: { command: 'retention', change: null, apply: false } }
  const parsed = parseRetentionPut(Object.keys(retention).length > 0 ? { ...body, retention } : body)
  return parsed.ok ? { ok: true, value: { command: 'retention', change: parsed.value, apply } } : parsed
}

function findingsArgs(flags: readonly DataFlag[]): Parsed<DataArgs> {
  let all = false
  let resolve: { id: number; action: ResolveAction } | null = null
  for (const flag of flags) {
    if (flag.name === '--all') {
      all = true
      continue
    }
    const action = flag.name === '--redact' ? 'redact' : flag.name === '--purge' ? 'purge' : null
    const id = Number(flag.value)
    if (action === null) return { ok: false, error: 'findings takes --all, --redact <id> or --purge <id>' }
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: `${flag.name} needs a finding id` }
    if (resolve !== null) return { ok: false, error: 'resolve one finding at a time' }
    resolve = { id, action }
  }
  return { ok: true, value: { command: 'findings', all, resolve } }
}

const PURGE_FLAGS: Readonly<Record<string, string>> = {
  '--session': 'session', '--project': 'project', '--host': 'host', '--observation': 'observation', '--before': 'before', '--after': 'after',
}

function purgeArgs(flags: readonly DataFlag[]): Parsed<DataArgs> {
  const body: Record<string, string | number | boolean> = {}
  for (const flag of flags) {
    if (flag.name === '--dry-run') {
      body.dryRun = true
      continue
    }
    const key = PURGE_FLAGS[flag.name]
    if (key === undefined || flag.value === null) return { ok: false, error: `unknown purge flag ${JSON.stringify(flag.name)}\n${USAGE}` }
    if (key in body) return { ok: false, error: `${flag.name} given twice` }
    body[key] = key === 'session' || key === 'observation' ? Number(flag.value) : flag.value
  }
  const parsed = parsePurgeBody(body)
  return parsed.ok ? { ok: true, value: { command: 'purge', body } } : { ok: false, error: `purge: ${parsed.error}` }
}

// ---- Dashboard: `kinfold dashboard [--print]` -------------------------------------
// Asks the daemon for a one-time login code and opens (or prints) the login
// link. Its only flag is --print.

export type KeyArgs = { command: 'encrypt' | 'decrypt' | 'rekey' | 'show-recovery' | 'recover' | 'resume' }

/** Null when argv is not an encryption command, so every other command parses exactly as before. None of them takes flags. */
export function parseKeyArgs(argv: readonly string[]): Parsed<KeyArgs> | null {
  const [first, second, ...rest] = argv
  if (first === 'encrypt' || first === 'decrypt' || first === 'rekey') {
    return argv.length === 1 ? { ok: true, value: { command: first } } : { ok: false, error: `${first} takes no flags\n${USAGE}` }
  }
  if (first !== 'key') return null
  if ((second === 'show-recovery' || second === 'recover' || second === 'resume') && rest.length === 0) return { ok: true, value: { command: second } }
  return { ok: false, error: `key takes show-recovery, recover or resume\n${USAGE}` }
}

export interface DashboardArgs {
  command: 'dashboard'
  print: boolean
}

/** Null when argv is not `dashboard`, so every other command parses exactly as before. */
export function parseDashboardArgs(argv: readonly string[]): Parsed<DashboardArgs> | null {
  if (argv[0] !== 'dashboard') return null
  const rest = argv.slice(1)
  if (rest.length === 0) return { ok: true, value: { command: 'dashboard', print: false } }
  if (rest.length === 1 && rest[0] === '--print') return { ok: true, value: { command: 'dashboard', print: true } }
  return { ok: false, error: `dashboard takes only --print\n${USAGE}` }
}

/** Null when argv is not a data command, so install/uninstall/status parse exactly as before. */
export function parseDataArgs(argv: readonly string[]): Parsed<DataArgs> | null {
  const command = argv[0]
  if (!DATA_COMMANDS.includes(command as DataCommand)) return null
  if ((command === 'size' || command === 'scan') && argv.length > 1) return { ok: false, error: `${command} takes no flags` }
  const booleans = command === 'findings' ? ['--all'] : command === 'purge' ? ['--dry-run'] : command === 'retention' ? ['--yes'] : []
  const flags = dataFlags(argv, booleans)
  if (!flags.ok) return flags
  if (command === 'retention') return retentionArgs(flags.value)
  if (command === 'findings') return findingsArgs(flags.value)
  if (command === 'purge') return purgeArgs(flags.value)
  return { ok: true, value: { command: command as 'size' | 'scan' } }
}

export function parseHosts(value: string): Parsed<InstallHost[]> {
  const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '')
  const unknown = names.filter((name) => !INSTALL_HOSTS.includes(name as InstallHost))
  if (names.length === 0 || unknown.length > 0) return { ok: false, error: `--hosts takes a comma list of ${INSTALL_HOSTS.join(', ')}` }
  return { ok: true, value: [...new Set(names as InstallHost[])] }
}

export function parseObserverFlag(value: string): Parsed<ObserverFlag> {
  const at = value.indexOf('=')
  const host = value.slice(0, at)
  if (at <= 0 || !INSTALL_HOSTS.includes(host as InstallHost)) {
    return { ok: false, error: `--observer takes <host>=<provider>:<model>, host one of ${INSTALL_HOSTS.join(', ')}` }
  }
  const parsed = parseProviderModel(value.slice(at + 1))
  if (parsed === null) return { ok: false, error: `--observer ${host}=... needs <provider>:<model> with a known provider and a model` }
  return { ok: true, value: { host: host as InstallHost, ...parsed } }
}

function initial(command: Command): CliArgs {
  return { command, dryRun: false, yes: false, skipCheck: false, replaceCredential: false, credentialStdin: false, takeover: false, removeCredentials: false, removeHmacKeys: false, hosts: null, observers: [] }
}

/** `--flag value` or `--flag=value`; returns the value and how many argv slots it used. */
function valueOf(argv: readonly string[], index: number, name: string): { value: string; used: number } | null {
  const arg = argv[index] ?? ''
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), used: 1 }
  const next = argv[index + 1]
  return next === undefined ? null : { value: next, used: 2 }
}

function applyValueFlag(args: CliArgs, name: string, value: string): Parsed<CliArgs> {
  if (name === '--hosts') {
    const hosts = parseHosts(value)
    return hosts.ok ? { ok: true, value: { ...args, hosts: hosts.value } } : hosts
  }
  const flag = parseObserverFlag(value)
  if (!flag.ok) return flag
  if (args.observers.some((entry) => entry.host === flag.value.host)) return { ok: false, error: `--observer given twice for ${flag.value.host}` }
  return { ok: true, value: { ...args, observers: [...args.observers, flag.value] } }
}

export function parseArgs(argv: readonly string[]): Parsed<CliArgs> {
  const command = argv[0]
  if (!COMMANDS.includes(command as Command)) return { ok: false, error: USAGE }
  let args = initial(command as Command)
  for (let index = 1; index < argv.length; ) {
    const arg = argv[index] ?? ''
    const boolean = BOOLEAN_FLAGS[arg]
    if (boolean !== undefined) {
      if (!boolean.commands.includes(args.command)) return { ok: false, error: `${arg} does not apply to ${args.command}` }
      args = { ...args, [boolean.key]: true }
      index += 1
      continue
    }
    const name = ['--hosts', '--observer'].find((flag) => arg === flag || arg.startsWith(`${flag}=`))
    if (name === undefined) return { ok: false, error: `unknown argument ${JSON.stringify(arg)}\n${USAGE}` }
    if (args.command !== 'install') return { ok: false, error: `${name} does not apply to ${args.command}` }
    const found = valueOf(argv, index, name)
    if (found === null) return { ok: false, error: `${name} needs a value` }
    const applied = applyValueFlag(args, name, found.value)
    if (!applied.ok) return applied
    args = applied.value
    index += found.used
  }
  return { ok: true, value: args }
}
