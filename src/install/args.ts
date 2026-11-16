// `kinfold <install|uninstall|status|update> [flags]`. Hand-parsed, zero dependencies. A
// flag that does not apply to the command is an error rather than ignored, so
// `kinfold status --dry-run` cannot be mistaken for a promise.

import { KNOWN_HOSTS } from '../contract/event'
import type { Parsed } from '../context/types'
import { parsePurgeBody, parseRetentionPut } from '../data-control/requests'
import type { ResolveAction } from '../data-control/resolve'
import type { DataSettingsChange } from '../store/data-settings-store'
import { builtProfiles } from '../agents/install-profiles'
import { INSTALL_HOSTS, type InstallHost } from './detect'
import type { DisplayChange } from '../store/display-settings'
import { type EmbeddingSettings, parseEmbeddingSettings } from '../vectors/embedding-settings'
import { type ObserverFlag, defaultInput, parseProviderModel, withObserverEndpoint } from './observer-choice'
import { type UpdateLevel, isUpdateLevel } from './setup/record'
import { parseVersion } from '../update/version-order'

export const COMMANDS = ['install', 'uninstall', 'status', 'update'] as const
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
  /** --observer-endpoint as typed; parseArgs puts it on the --observer flags it applies to. */
  observerEndpoint: string | null
  noEncrypt: boolean
  noUpdateCheck: boolean
  noAutoUpdate: boolean
  autoUpdate: boolean
  /** `update --auto`: the run the daemon starts for a patch release. Not in USAGE, since no one types it. */
  auto: boolean
  /** --updates: the level. null: left as it is, or asked. */
  updates: UpdateLevel | null
  /** --beta / --no-beta: the beta channel. Neither: left as it is, or asked. */
  beta: boolean
  noBeta: boolean
  /** `update --staged <version>`: the run the dashboard's Install button starts. Not in USAGE either. */
  staged: string | null
  port: number | null
  /** --path or --no-path: the answer to the PATH question, given up front. null: neither. */
  path: 'path' | 'no-path' | null
  addPath: boolean
  noPath: boolean
  /** On a terminal, the numbered action list is shown beside the progress bar. */
  verbose: boolean
  /** --show-recall / --no-show-recall: whether agents show what Kinfold recalled. Neither: left as it is. */
  showRecall: boolean
  noShowRecall: boolean
  /** --holdout / --no-holdout: the opt-in impact test. Neither: left as it is. */
  holdout: boolean
  noHoldout: boolean
  /** --embeddings: the embedding provider, sent to the daemon. null: left as it is, or asked. */
  embeddings: EmbeddingSettings | null
}

type BooleanFlag = 'addPath' | 'noPath' | 'verbose' | 'dryRun' | 'yes' | 'skipCheck' | 'replaceCredential' | 'credentialStdin' | 'takeover' | 'removeCredentials' | 'removeHmacKeys' | 'noEncrypt' | 'noUpdateCheck' | 'noAutoUpdate' | 'autoUpdate' | 'auto' | 'beta' | 'noBeta'
  | 'showRecall' | 'noShowRecall' | 'holdout' | 'noHoldout'

/** What the display flags ask for: only the switches a flag named. */
export function displayChangeOf(args: Pick<CliArgs, 'showRecall' | 'noShowRecall' | 'holdout' | 'noHoldout'>): DisplayChange {
  return {
    ...(args.showRecall ? { showRecall: true } : args.noShowRecall ? { showRecall: false } : {}),
    ...(args.holdout ? { holdout: true } : args.noHoldout ? { holdout: false } : {}),
  }
}

const BOOLEAN_FLAGS: Readonly<Record<string, { key: BooleanFlag; commands: readonly Command[] }>> = {
  '--dry-run': { key: 'dryRun', commands: ['install', 'uninstall', 'update'] },
  '--yes': { key: 'yes', commands: ['install'] },
  '--skip-check': { key: 'skipCheck', commands: ['install'] },
  '--replace-credential': { key: 'replaceCredential', commands: ['install'] },
  '--credential-stdin': { key: 'credentialStdin', commands: ['install'] },
  '--takeover': { key: 'takeover', commands: ['install'] },
  '--no-encrypt': { key: 'noEncrypt', commands: ['install'] },
  '--no-update-check': { key: 'noUpdateCheck', commands: ['install'] },
  '--no-auto-update': { key: 'noAutoUpdate', commands: ['install'] },
  '--auto-update': { key: 'autoUpdate', commands: ['install'] },
  '--show-recall': { key: 'showRecall', commands: ['install'] },
  '--no-show-recall': { key: 'noShowRecall', commands: ['install'] },
  '--holdout': { key: 'holdout', commands: ['install'] },
  '--no-holdout': { key: 'noHoldout', commands: ['install'] },
  '--auto': { key: 'auto', commands: ['update'] },
  '--beta': { key: 'beta', commands: ['install'] },
  '--no-beta': { key: 'noBeta', commands: ['install'] },
  '--path': { key: 'addPath', commands: ['install'] },
  '--no-path': { key: 'noPath', commands: ['install'] },
  '--verbose': { key: 'verbose', commands: ['install', 'uninstall'] },
  '--remove-credentials': { key: 'removeCredentials', commands: ['uninstall'] },
  '--remove-hmac-keys': { key: 'removeHmacKeys', commands: ['uninstall'] },
}

export const USAGE = [
  'usage: kinfold <install|uninstall|status|update|size|retention|scan|findings|purge|dashboard|watch|backup|restore|encrypt|decrypt|rekey|key|hook|mcp|daemon|observe> [--data-dir <path>] [--version] [flags]',
  '  install    [--dry-run] [--yes] [--hosts claude-code,opencode,codex,cursor] [--observer <host>=<provider>:<model>|off]...',
  '             [--observer-endpoint <url>] (the address for qwen-api or openai-compatible: https, or http on this machine)',
  '             [--skip-check] [--replace-credential] [--credential-stdin] [--takeover]',
  '             [--no-encrypt] [--port <1024-65535>] [--updates off|notify|patch] [--beta | --no-beta]',
  '             --updates patch (the default) installs patch releases itself and downloads larger ones to install when you say so;',
  '             notify checks daily and tells you; off stops checking. --beta also offers prereleases, each waiting for your yes',
  '             [--path | --no-path] [--verbose] [--show-recall|--no-show-recall] [--holdout|--no-holdout]',
  '             --no-show-recall hides the line and list agents show for what Kinfold recalled; --holdout turns on the impact test, which',
  '             holds recall back on about 1 prompt in 10 (Claude Code only, and says so each time) to measure what memory changes',
  '             [--embeddings local|openrouter|local-llm:<model>@<url>]   what makes the vectors for semantic search: the bundled',
  '             local model (default, on this machine), OpenRouter (uses the OpenRouter key), or a local LLM server on loopback',
  '             --path puts the kinfold command on your PATH without asking; --no-path adds nothing and takes out what an earlier install added;',
  '             --verbose shows every step on a terminal (the full list is always in <data-dir>/logs/install.log)',
  '  update     [--dry-run]',
  '  uninstall  [--dry-run] [--verbose] [--remove-credentials] [--remove-hmac-keys]',
  '             --remove-hmac-keys deletes the stored hmac-master and hmac-legacy keys and hmac.d/: stored refs can no longer',
  '             be checked, and a later install starts a new master (hmac.key is written back from hmac-legacy first)',
  '  status',
  '  dashboard  [--print]',
  '  watch      [--host <agent>] [--project <name>]   what Kinfold recalled for each prompt, live, for every agent; Ctrl-C stops it',
  '  size',
  '  retention  [--set <events|prompts|observations|summaries>=<days|keep>]... [--set warn_bytes=<n>] [--yes]',
  '  scan',
  '  findings   [--all] [--redact <id> | --purge <id> [--yes]]',
  '             --purge shows the finding and asks before it deletes the row; --yes skips the question, and is needed where there is no terminal',
  '  purge      --session <id> | --project <key> | --host <host> | --observation <id> | --before <iso> [--after <iso>] [--dry-run] [--yes]',
  '             shows what it would delete and asks before deleting; --yes skips the question, and is needed where there is no terminal',
  '  backup     <file>   write the memory to one file, still encrypted; capture keeps running',
  '  restore    <file>   replace the memory with a backup; asks for its recovery code (typed, or on stdin)',
  '  restore    --undo   switch back to the memory the last restore replaced and kept; needs no recovery code',
  '  encrypt    convert memory.db to an encrypted file; shows a recovery code to keep',
  '  decrypt    store memory.db in plaintext again and delete its key',
  '  rekey      give memory.db a new key and a new recovery code',
  '  key show-recovery | key recover   show the recovery code, or put the key back from one (on stdin or typed)',
  '  key resume finish or undo a kinfold encrypt, decrypt, rekey or restore that was cut short',
  '  hook       [--host codex|cursor]   record one host hook payload from stdin, Claude Code by default',
  '  mcp        answer the MCP stdio protocol on stdin and stdout',
  '  daemon     run the local daemon on loopback',
  '  observe    <session-id>   run the observer once for one session',
  '  --data-dir <path>   the data folder for this process; wins over KINFOLD_DATA_DIR; may come before or after the command',
  '  --plain    print plain lines even on a terminal, as into a pipe; may come before or after the command',
  '  --help     print this usage; a bare kinfold runs install',
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
  /** yes: --yes, which lets --purge delete without the confirm. */
  | { command: 'findings'; all: boolean; resolve: { id: number; action: ResolveAction } | null; yes: boolean }
  /** yes: --yes, which deletes without the confirm; a script has no one to answer it. */
  | { command: 'purge'; body: Record<string, string | number | boolean>; yes: boolean }

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
  let yes = false
  let resolve: { id: number; action: ResolveAction } | null = null
  for (const flag of flags) {
    if (flag.name === '--all') {
      all = true
      continue
    }
    if (flag.name === '--yes' && flag.value === null) {
      yes = true
      continue
    }
    const action = flag.name === '--redact' ? 'redact' : flag.name === '--purge' ? 'purge' : null
    const id = Number(flag.value)
    if (action === null) return { ok: false, error: 'findings takes --all, --redact <id> or --purge <id>' }
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: `${flag.name} needs a finding id` }
    if (resolve !== null) return { ok: false, error: 'resolve one finding at a time' }
    resolve = { id, action }
  }
  if (yes && resolve?.action !== 'purge') return { ok: false, error: 'findings --yes goes with --purge <id>' }
  return { ok: true, value: { command: 'findings', all, resolve, yes } }
}

const PURGE_FLAGS: Readonly<Record<string, string>> = {
  '--session': 'session', '--project': 'project', '--host': 'host', '--observation': 'observation', '--before': 'before', '--after': 'after',
}

function purgeArgs(flags: readonly DataFlag[]): Parsed<DataArgs> {
  const body: Record<string, string | number | boolean> = {}
  let yes = false
  for (const flag of flags) {
    if (flag.name === '--dry-run') {
      body.dryRun = true
      continue
    }
    if (flag.name === '--yes' && flag.value === null) {
      yes = true
      continue
    }
    const key = PURGE_FLAGS[flag.name]
    if (key === undefined || flag.value === null) return { ok: false, error: `unknown purge flag ${JSON.stringify(flag.name)}\n${USAGE}` }
    if (key in body) return { ok: false, error: `${flag.name} given twice` }
    body[key] = key === 'session' || key === 'observation' ? Number(flag.value) : flag.value
  }
  const parsed = parsePurgeBody(body)
  return parsed.ok ? { ok: true, value: { command: 'purge', body, yes } } : { ok: false, error: `purge: ${parsed.error}` }
}

// ---- Dashboard: `kinfold dashboard [--print]` -------------------------------------
// Asks the daemon for a one-time login code and opens (or prints) the login
// link. Its only flag is --print.

export type BackupArgs = { command: 'backup' | 'restore'; file: string } | { command: 'restore'; undo: true }

/**
 * Null when argv is not `backup` or `restore`, so every other command parses
 * exactly as before. Each takes one file and no flags; `restore --undo` is the
 * one other form, and takes nothing else.
 */
export function parseBackupArgs(argv: readonly string[]): Parsed<BackupArgs> | null {
  const [command, file, ...rest] = argv
  if (command !== 'backup' && command !== 'restore') return null
  if (command === 'restore' && argv.includes('--undo')) {
    return argv.length === 2 ? { ok: true, value: { command, undo: true } } : { ok: false, error: `restore --undo takes no file and no other flag\n${USAGE}` }
  }
  if (file === undefined || file === '' || file.startsWith('--') || rest.length > 0) return { ok: false, error: `${command} takes one file\n${USAGE}` }
  return { ok: true, value: { command, file } }
}

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

export interface WatchArgs {
  command: 'watch'
  /** Only this agent's prompts; null for every agent. */
  host: string | null
  /** Only this project's prompts, by its name or key; null for every project. */
  project: string | null
}

const MAX_WATCH_PROJECT_CHARS = 300

/** Null when argv is not `watch`, so every other command parses exactly as before. */
export function parseWatchArgs(argv: readonly string[]): Parsed<WatchArgs> | null {
  if (argv[0] !== 'watch') return null
  const usage = `watch takes --host <agent> and --project <name>\n${USAGE}`
  let host: string | null = null
  let project: string | null = null
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const name = ['--host', '--project'].find((flag) => arg === flag || arg.startsWith(`${flag}=`))
    if (name === undefined) return { ok: false, error: usage }
    const value = arg === name ? argv[index + 1] : arg.slice(name.length + 1)
    if (value === undefined || value === '') return { ok: false, error: `${name} needs a value` }
    if (arg === name) index += 1
    if (name === '--host') {
      if (!(KNOWN_HOSTS as readonly string[]).includes(value)) return { ok: false, error: `--host takes one agent: ${KNOWN_HOSTS.join(', ')}` }
      host = value
    } else {
      if (value.length > MAX_WATCH_PROJECT_CHARS) return { ok: false, error: '--project takes a project name or key' }
      project = value
    }
  }
  return { ok: true, value: { command: 'watch', host, project } }
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
  const booleans = command === 'findings' ? ['--all', '--yes'] : command === 'purge' ? ['--dry-run', '--yes'] : command === 'retention' ? ['--yes'] : []
  const flags = dataFlags(argv, booleans)
  if (!flags.ok) return flags
  if (command === 'retention') return retentionArgs(flags.value)
  if (command === 'findings') return findingsArgs(flags.value)
  if (command === 'purge') return purgeArgs(flags.value)
  return { ok: true, value: { command: command as 'size' | 'scan' } }
}

/** The agents Kinfold wires today, for flag errors. */
function supportedList(): string {
  return builtProfiles().map((profile) => profile.id).join(', ')
}

function isKnownHost(name: string): name is InstallHost {
  return (INSTALL_HOSTS as readonly string[]).includes(name)
}

/** Why a name cannot be wired, or null: every known agent has a profile, so only an unknown name has a problem. */
function hostProblem(name: string): string | null {
  return isKnownHost(name) ? null : ''
}

function withReasons(base: string, reasons: readonly string[]): string {
  const named = reasons.filter((reason) => reason !== '')
  return named.length === 0 ? base : `${base}; ${named.join('; ')}`
}

export function parseHosts(value: string): Parsed<InstallHost[]> {
  const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '')
  const problems = names.map(hostProblem).filter((problem): problem is string => problem !== null)
  if (names.length === 0 || problems.length > 0) return { ok: false, error: withReasons(`--hosts takes a comma list of ${supportedList()}`, problems) }
  return { ok: true, value: [...new Set(names as InstallHost[])] }
}

export function parseObserverFlag(value: string): Parsed<ObserverFlag> {
  const at = value.indexOf('=')
  const host = value.slice(0, at)
  const problem = at <= 0 ? '' : hostProblem(host)
  if (problem !== null) {
    return { ok: false, error: withReasons(`--observer takes <host>=<provider>:<model> or <host>=off, host one of ${supportedList()}`, [problem]) }
  }
  const choice = value.slice(at + 1).trim()
  if (choice.toLowerCase() === 'off') {
    const builtIn = defaultInput(host as InstallHost)
    return { ok: true, value: { host: host as InstallHost, provider: builtIn.provider, model: builtIn.model, off: true } }
  }
  const parsed = parseProviderModel(choice)
  if (parsed === null) return { ok: false, error: `--observer ${host}=... needs <provider>:<model> with a known provider and a model, or off` }
  return { ok: true, value: { host: host as InstallHost, ...parsed } }
}

function initial(command: Command): CliArgs {
  return { command, dryRun: false, yes: false, skipCheck: false, replaceCredential: false, credentialStdin: false, takeover: false, removeCredentials: false, removeHmacKeys: false, hosts: null, observers: [], observerEndpoint: null, noEncrypt: false, noUpdateCheck: false, noAutoUpdate: false, autoUpdate: false, auto: false, updates: null, beta: false, noBeta: false, staged: null, port: null, path: null, addPath: false, noPath: false, verbose: false, showRecall: false, noShowRecall: false, holdout: false, noHoldout: false, embeddings: null }
}

/** `--flag value` or `--flag=value`; returns the value and how many argv slots it used. */
function valueOf(argv: readonly string[], index: number, name: string): { value: string; used: number } | null {
  const arg = argv[index] ?? ''
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), used: 1 }
  const next = argv[index + 1]
  return next === undefined ? null : { value: next, used: 2 }
}

const MIN_PORT = 1024
const MAX_PORT = 65_535

function parsePort(value: string): Parsed<number> {
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return { ok: false, error: `--port takes a whole number from ${MIN_PORT} to ${MAX_PORT}` }
  return { ok: true, value: port }
}

const EMBEDDINGS_USAGE = '--embeddings takes local, openrouter or local-llm:<model>@<url>'

/** local, openrouter, or local-llm:<model>@<url>; the URL is split at the last @, since a model name has none. */
export function parseEmbeddingsFlag(value: string): Parsed<EmbeddingSettings> {
  if (value === 'local' || value === 'openrouter') return parseEmbeddingSettings({ provider: value })
  if (!value.startsWith('local-llm:')) return { ok: false, error: EMBEDDINGS_USAGE }
  const rest = value.slice('local-llm:'.length)
  const at = rest.lastIndexOf('@')
  if (at <= 0) return { ok: false, error: EMBEDDINGS_USAGE }
  const parsed = parseEmbeddingSettings({ provider: 'local-llm', llmModel: rest.slice(0, at), llmUrl: rest.slice(at + 1) })
  return parsed.ok ? parsed : { ok: false, error: `--embeddings: ${parsed.error}` }
}

function applyValueFlag(args: CliArgs, name: string, value: string): Parsed<CliArgs> {
  if (name === '--embeddings') {
    const embeddings = parseEmbeddingsFlag(value)
    return embeddings.ok ? { ok: true, value: { ...args, embeddings: embeddings.value } } : embeddings
  }
  if (name === '--port') {
    const port = parsePort(value)
    return port.ok ? { ok: true, value: { ...args, port: port.value } } : port
  }
  if (name === '--updates') {
    if (!isUpdateLevel(value)) return { ok: false, error: '--updates takes off, notify or patch' }
    return { ok: true, value: { ...args, updates: value } }
  }
  if (name === '--staged') {
    // It becomes a file name and a URL path, so only a version passes.
    if (parseVersion(value) === null) return { ok: false, error: '--staged takes a version' }
    return { ok: true, value: { ...args, staged: value } }
  }
  if (name === '--hosts') {
    const hosts = parseHosts(value)
    return hosts.ok ? { ok: true, value: { ...args, hosts: hosts.value } } : hosts
  }
  if (name === '--observer-endpoint') {
    if (args.observerEndpoint !== null) return { ok: false, error: '--observer-endpoint given twice' }
    return { ok: true, value: { ...args, observerEndpoint: value } }
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
    const name = ['--hosts', '--observer-endpoint', '--observer', '--port', '--embeddings', '--updates', '--staged'].find((flag) => arg === flag || arg.startsWith(`${flag}=`))
    if (name === undefined) return { ok: false, error: `unknown argument ${JSON.stringify(arg)}\n${USAGE}` }
    if (args.command !== (name === '--staged' ? 'update' : 'install')) return { ok: false, error: `${name} does not apply to ${args.command}` }
    const found = valueOf(argv, index, name)
    if (found === null) return { ok: false, error: `${name} needs a value` }
    const applied = applyValueFlag(args, name, found.value)
    if (!applied.ok) return applied
    args = applied.value
    index += found.used
  }
  if (args.autoUpdate && args.noAutoUpdate) return { ok: false, error: '--auto-update and --no-auto-update cannot be given together' }
  if (args.beta && args.noBeta) return { ok: false, error: '--beta and --no-beta cannot be given together' }
  if (args.updates !== null && (args.noUpdateCheck || args.autoUpdate || args.noAutoUpdate)) return { ok: false, error: '--updates cannot be given with --no-update-check, --auto-update or --no-auto-update' }
  if (args.addPath && args.noPath) return { ok: false, error: '--path and --no-path cannot be given together' }
  if (args.showRecall && args.noShowRecall) return { ok: false, error: '--show-recall and --no-show-recall cannot be given together' }
  if (args.holdout && args.noHoldout) return { ok: false, error: '--holdout and --no-holdout cannot be given together' }
  const observers = withObserverEndpoint(args.observers, args.observerEndpoint)
  if (!observers.ok) return observers
  return { ok: true, value: { ...args, observers: observers.value, path: args.addPath ? 'path' : args.noPath ? 'no-path' : null } }
}
