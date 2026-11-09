// The setup wizard's questions: folder, agents, an observer per agent,
// encryption, port, update check, then a summary. It only asks; the answer set
// goes to the plan, so a Ctrl-C or a closed stdin anywhere leaves nothing
// written. Without a terminal, or under --yes, nothing is asked and each step
// takes its flag, then the saved value, then the default.

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { OBSERVER_PROVIDERS, type ObserverProvider } from '../../observer/types'
import { encodeRecoveryCode } from '../../sqlite/recovery'
import { newDbKey } from '../../sqlite/keys'
import { checkHealth } from '../daemon-client'
import { STALE_DB_KEY, storedDbKey } from '../db-encryption'
import { ENCRYPT_KEY_EXISTS } from '../encrypt'
import { type InstallHost, detectHosts, selectedHosts } from '../detect'
import type { InstallEnv } from '../env'
import {
  type Candidate,
  type ChoiceOptions,
  ChoiceError,
  MAX_CHOICE_ATTEMPTS,
  type ObserverChoice,
  type ObserverFlag,
  chooseObserverWith,
  chooseObservers,
  defaultInput,
  describeInput,
  isCliLoginProvider,
  listModelsFor,
  newCredentialSession,
  settingsInputFor,
  showModels,
} from '../observer-choice'
import { type Choice, PromptCancelled, type Prompts } from '../prompt/prompts'
import { confirmRecoveryCode, recoverySinkFromTerminal } from '../recovery-confirm'
import { LOCKED_FOLDER_NOTE, type SetupState, lockedFolderProblem, savedObserversForYes } from './prefill'

export interface SetupFlags {
  dataDir: string | null
  hosts: InstallHost[] | null
  observers: readonly ObserverFlag[]
  noEncrypt: boolean
  port: number | null
  noUpdateCheck: boolean
  yes: boolean
}

export type EncryptionAnswer =
  | { kind: 'keep' }
  | { kind: 'new-encrypted'; key: string | null } // null: --yes, key made at run time and never shown
  | { kind: 'new-plain' }
  | { kind: 'encrypt-existing'; key: string | null } // code shown and confirmed already; null only in a dry run, which converts nothing
  | { kind: 'decrypt-existing' } // confirmed already

export interface SetupAnswers {
  dataDir: string
  hosts: InstallHost[]
  observers: ObserverChoice[]
  encryption: EncryptionAnswer
  port: number
  updateCheck: boolean
}

export const NO_TTY_ENCRYPTION_CHANGE = 'changing encryption on an existing store needs a terminal; run kinfold encrypt or kinfold decrypt'
export { STALE_DB_KEY }
export const NO_AGENTS_NOTE = 'No supported agent was found on this machine, so none will be wired.'
export const ENCRYPTION_IS_ON = 'Encryption is on. Run kinfold key show-recovery to see the recovery code.'

const MIN_PORT = 1024
const MAX_PORT = 65_535
const PORT_SCAN_LIMIT = 200
const LSOF = '/usr/sbin/lsof'
const HOLDER_TIMEOUT_MS = 3_000

// ---- ports ------------------------------------------------------------------

async function bindFree(port: number): Promise<boolean> {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

/** Free to bind, or already held by our own daemon, which an install restarts anyway. */
async function portAvailable(env: InstallEnv, port: number): Promise<boolean> {
  if (await (env.portFree ?? bindFree)(port)) return true
  return (await checkHealth(env, port)).up
}

export async function freePortFrom(env: InstallEnv, start: number): Promise<number> {
  for (let port = start; port <= MAX_PORT && port < start + PORT_SCAN_LIMIT; port += 1) {
    if (await portAvailable(env, port)) return port
  }
  throw new ChoiceError(`no free port found from ${start}`)
}

/** The process number listening on the port, when the system will say; null otherwise. */
async function portHolder(env: InstallEnv, port: number): Promise<string | null> {
  try {
    const result = await env.run({ argv: [LSOF, '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], timeoutMs: HOLDER_TIMEOUT_MS })
    const pid = result.stdout.split('\n')[0]?.trim() ?? ''
    return result.exitCode === 0 && /^\d+$/.test(pid) ? pid : null
  } catch {
    return null
  }
}

async function defaultPort(env: InstallEnv, wanted: number, lookUpHolder: boolean): Promise<{ port: number; takenBy: string | null | undefined }> {
  if (await portAvailable(env, wanted)) return { port: wanted, takenBy: undefined }
  const holder = lookUpHolder ? await portHolder(env, wanted) : null
  return { port: await freePortFrom(env, wanted + 1), takenBy: holder }
}

const validPort = (value: string): string | null => {
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN
  return port >= MIN_PORT && port <= MAX_PORT ? null : `a whole number from ${MIN_PORT} to ${MAX_PORT}`
}

async function portStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags): Promise<number> {
  if (flags.port !== null) return flags.port
  const wanted = await defaultPort(env, state.port, ask !== null)
  if (ask === null) return wanted.port
  const taken = wanted.takenBy === undefined ? '' : `Port ${state.port} is in use${wanted.takenBy === null ? '' : ` (process ${wanted.takenBy})`}. `
  return Number(await ask.text(`${taken}Port for the daemon:`, String(wanted.port), validPort))
}

// ---- folder -----------------------------------------------------------------

const tildeHome = (env: InstallEnv, path: string): string => (path === env.homeDir || path.startsWith(`${env.homeDir}/`) ? `~${path.slice(env.homeDir.length)}` : path)

function expandFolder(env: InstallEnv, typed: string): string {
  const home = env.homeDir === '' ? homedir() : env.homeDir
  const expanded = typed === '~' ? home : typed.startsWith('~/') ? join(home, typed.slice(2)) : typed
  return isAbsolute(expanded) ? resolve(expanded) : resolve(env.cwd, expanded)
}

async function folderStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags): Promise<string> {
  if (state.installed) {
    ask?.locked('Memory folder', state.dataDir, LOCKED_FOLDER_NOTE)
    return state.dataDir
  }
  if (flags.dataDir !== null) return flags.dataDir
  if (ask === null) return state.dataDir
  const typed = await ask.text('Memory folder:', tildeHome(env, state.dataDir), (value) => (value.trim() === '' ? 'a folder is needed' : null))
  return expandFolder(env, typed.trim())
}

// ---- agents -----------------------------------------------------------------

async function agentsStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags): Promise<InstallHost[]> {
  if (flags.hosts !== null) return selectedHosts(await detectHosts(env, flags.hosts))
  const detections = await detectHosts(env, null)
  const detected = selectedHosts(detections)
  const wired = new Set(state.wiredHosts)
  // Not detected and not wired is the only untickable host; a wired one whose agent is gone can still be unticked to drop its wiring.
  const choices: Choice<InstallHost>[] = detections.map((found) => ({
    value: found.host,
    label: found.host,
    hint: found.note,
    ...(!found.selected && !wired.has(found.host) ? { disabled: found.note } : {}),
  }))
  if (ask === null) {
    // Under --yes the saved wiring is the default; a host whose agent is gone stays wired until someone unticks it.
    const hosts = state.installed ? state.wiredHosts : detected
    if (hosts.length === 0) env.out(NO_AGENTS_NOTE)
    return hosts
  }
  if (choices.every((choice) => choice.disabled !== undefined)) {
    ask.say(NO_AGENTS_NOTE)
    return []
  }
  return ask.multiSelect('Which agents should share memory?', choices, state.installed ? state.wiredHosts : detected)
}

// ---- observers --------------------------------------------------------------

type ProviderPick = 'current' | ObserverProvider

async function askModel(env: InstallEnv, ask: Prompts, host: InstallHost, provider: ObserverProvider, current: Candidate): Promise<string> {
  if (isCliLoginProvider(provider)) showModels(env, provider, await listModelsFor(env, provider))
  const initial = current.input.provider === provider ? current.input.model : ''
  const model = await ask.text(`Model for ${provider} on ${host}:`, initial, (value) => (value.trim() === '' ? 'a model name is needed' : null))
  return model.trim()
}

async function askCandidate(env: InstallEnv, ask: Prompts, host: InstallHost, current: Candidate): Promise<Candidate> {
  const choices: Choice<ProviderPick>[] = [
    { value: 'current', label: describeInput(current.input), hint: current.origin === 'saved' ? 'saved' : 'built-in default' },
    ...OBSERVER_PROVIDERS.map((provider) => ({ value: provider, label: provider })),
  ]
  const picked = await ask.select(`Observer for ${host}:`, choices, 'current')
  if (picked === 'current') return current
  return { input: settingsInputFor(host, picked, await askModel(env, ask, host, picked, current)), origin: 'prompt' }
}

async function observerFor(env: InstallEnv, ask: Prompts, host: InstallHost, flags: SetupFlags, choice: ChoiceOptions, saved: ChoiceOptions['saved']): Promise<ObserverChoice> {
  const row = saved?.get(host)
  const current: Candidate = row === undefined ? { input: defaultInput(host), origin: 'default' } : { input: row, origin: 'saved' }
  const flag = flags.observers.find((entry) => entry.host === host)
  const session = newCredentialSession()
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const candidate: Candidate = attempt === 0 && flag !== undefined ? { input: settingsInputFor(host, flag.provider, flag.model), origin: 'flag' } : await askCandidate(env, ask, host, current)
    const result = await chooseObserverWith(env, host, candidate, choice, session)
    if (!('failed' in result)) return result
  }
  throw new ChoiceError(`no working observer for ${host} after ${MAX_CHOICE_ATTEMPTS} tries`)
}

async function observersStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags, choice: ChoiceOptions, hosts: readonly InstallHost[]): Promise<ObserverChoice[]> {
  const saved = ask !== null || flags.yes ? savedObserversForYes(state, hosts, flags.observers) : undefined
  const options: ChoiceOptions = { ...choice, yes: choice.yes || flags.yes, flags: flags.observers, ...(saved === undefined ? {} : { saved }) }
  if (ask === null) return chooseObservers(env, hosts, options)
  const choices: ObserverChoice[] = []
  for (const host of hosts) choices.push(await observerFor(env, ask, host, flags, options, saved))
  return choices
}

// ---- encryption -------------------------------------------------------------

/** The key for a store about to be encrypted, its code shown on the terminal and retyped. Never a second key beside one that exists. */
async function keyWithConfirmedCode(env: InstallEnv, ask: Prompts, reuseStored: boolean): Promise<string> {
  let key = newDbKey()
  if (reuseStored) {
    const stored = storedDbKey(env)
    if (stored.kind === 'unreadable') throw new ChoiceError(STALE_DB_KEY)
    if (stored.kind === 'usable') {
      ask.say('A database key from an earlier install is already in the Keychain; it is used again, and its recovery code is shown once more.')
      key = stored.key
    }
  }
  const sink = recoverySinkFromTerminal(env.terminal)
  const code = encodeRecoveryCode(key)
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    if (await confirmRecoveryCode(sink, code)) return key
  }
  throw new ChoiceError('the recovery code was not confirmed')
}

export const DRY_RUN_NO_CODE = 'A dry run shows no recovery code: a real run shows one here and asks you to confirm it.'

/** The confirmed key, or null in a dry run: a code shown then would belong to a key that is thrown away. */
async function confirmedKey(env: InstallEnv, ask: Prompts, reuseStored: boolean, dryRun: boolean): Promise<string | null> {
  if (!dryRun) return keyWithConfirmedCode(env, ask, reuseStored)
  if (reuseStored && storedDbKey(env).kind === 'unreadable') throw new ChoiceError(STALE_DB_KEY)
  ask.say(DRY_RUN_NO_CODE)
  return null
}

function headlessEncryption(state: SetupState, flags: SetupFlags): EncryptionAnswer {
  if (state.encryption === 'new') return flags.noEncrypt ? { kind: 'new-plain' } : { kind: 'new-encrypted', key: null }
  if (state.encryption === 'on' && flags.noEncrypt) throw new ChoiceError(NO_TTY_ENCRYPTION_CHANGE)
  return { kind: 'keep' }
}

async function encryptedStoreStep(ask: Prompts, flags: SetupFlags): Promise<EncryptionAnswer> {
  ask.say(ENCRYPTION_IS_ON)
  if (!flags.noEncrypt && (await ask.confirm('Keep memory.db encrypted?', true))) return { kind: 'keep' }
  const typed = await ask.text('Type decrypt to store memory.db in plaintext again:', '')
  return typed.trim() === 'decrypt' ? { kind: 'decrypt-existing' } : { kind: 'keep' }
}

async function encryptionStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags, dryRun: boolean): Promise<EncryptionAnswer> {
  if (ask === null) return headlessEncryption(state, flags)
  if (state.encryption === 'on') return encryptedStoreStep(ask, flags)
  if (state.encryption === 'new') {
    if (flags.noEncrypt || !(await ask.confirm('Encrypt memory.db?', true))) return { kind: 'new-plain' }
    return { kind: 'new-encrypted', key: await confirmedKey(env, ask, true, dryRun) }
  }
  if (flags.noEncrypt || !(await ask.confirm('Encrypt memory.db?', false))) return { kind: 'keep' }
  // A key already there may open an older encrypted copy; refused here, before a code is shown for a key that would be thrown away.
  if (storedDbKey(env).kind !== 'none') throw new ChoiceError(ENCRYPT_KEY_EXISTS)
  return { kind: 'encrypt-existing', key: await confirmedKey(env, ask, false, dryRun) }
}

// ---- summary ----------------------------------------------------------------

const ENCRYPTION_TEXT: Readonly<Record<EncryptionAnswer['kind'], string>> = {
  keep: 'unchanged',
  'new-encrypted': 'encrypted',
  'new-plain': 'not encrypted',
  'encrypt-existing': 'will be encrypted',
  'decrypt-existing': 'will be stored in plaintext',
}

async function summaryStep(ask: Prompts, answers: SetupAnswers): Promise<void> {
  ask.say('')
  ask.say(`Memory folder   ${answers.dataDir}`)
  ask.say(`Agents          ${answers.hosts.length === 0 ? 'none' : answers.hosts.join(', ')}`)
  for (const observer of answers.observers) ask.say(`Observer        ${observer.input.host}: ${describeInput(observer.input)} (${observer.check})`)
  ask.say(`Encryption      ${ENCRYPTION_TEXT[answers.encryption.kind]}`)
  ask.say(`Port            ${answers.port}`)
  ask.say(`Update check    ${answers.updateCheck ? 'daily' : 'off'}`)
  if (!(await ask.confirm('Install with these choices?', true))) throw new PromptCancelled()
}

// ---- the sequence -----------------------------------------------------------

async function updateCheckStep(ask: Prompts | null, state: SetupState, flags: SetupFlags): Promise<boolean> {
  if (flags.noUpdateCheck) return false
  return ask === null ? state.updateCheck : ask.confirm('Check for updates once a day?', state.updateCheck)
}

/** The machine as seen from another folder: the env aimed there and the state read from it. */
export interface FolderTarget {
  env: InstallEnv
  state: SetupState
}

/**
 * `retarget` is called when a first install names a folder other than the one
 * the state was read from: every later step (wiring, observers, the store's
 * encryption, the port) is about that folder, not the default one.
 */
export async function runWizard(
  first: InstallEnv,
  prompts: Prompts | null,
  firstState: SetupState,
  flags: SetupFlags,
  choice: ChoiceOptions,
  retarget?: (dataDir: string) => Promise<FolderTarget>,
): Promise<SetupAnswers> {
  // --yes never asks, even on a terminal: a child `install --yes` must not stop at a question.
  const ask = flags.yes ? null : prompts
  const problem = lockedFolderProblem(firstState, flags.dataDir)
  if (problem !== null) throw new ChoiceError(problem)
  const dataDir = await folderStep(first, ask, firstState, flags)
  const { env, state } = retarget !== undefined && resolve(dataDir) !== resolve(firstState.dataDir) ? await retarget(dataDir) : { env: first, state: firstState }
  const hosts = await agentsStep(env, ask, state, flags)
  const observers = await observersStep(env, ask, state, flags, choice, hosts)
  const encryption = await encryptionStep(env, ask, state, flags, choice.dryRun)
  const port = await portStep(env, ask, state, flags)
  const updateCheck = await updateCheckStep(ask, state, flags)
  const answers: SetupAnswers = { dataDir, hosts, observers, encryption, port, updateCheck }
  if (ask !== null) await summaryStep(ask, answers)
  return answers
}
