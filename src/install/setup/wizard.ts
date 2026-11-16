// The setup wizard's questions: folder, agents, an observer per agent,
// encryption, port, update check, the impact test, then a summary. It only asks; the answer set
// goes to the plan, so a Ctrl-C or a closed stdin anywhere leaves nothing
// written. Without a terminal, or under --yes, nothing is asked and each step
// takes its flag, then the saved value, then the default.

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { checkEndpoint } from '../../observer/endpoint'
import { defaultModelFor, isEndpointProvider } from '../../observer/settings'
import { type EndpointProvider, OBSERVER_PROVIDERS, type ObserverProvider, UNPROVEN_CLI_PROVIDERS } from '../../observer/types'
import { readDisplayFile } from '../../context/display-file'
import { HOLDOUT_HOSTS } from '../../context/holdout'
import { encodeRecoveryCode } from '../../sqlite/recovery'
import { newDbKey } from '../../sqlite/keys'
import { checkHealth, getEmbeddingSettings, readDaemonInfo } from '../daemon-client'
import { type EmbeddingProvider, type EmbeddingSettings, LOCAL_SETTINGS, isLoopbackUrl } from '../../vectors/embedding-settings'
import { STALE_DB_KEY, staleDbKey, storedDbKey } from '../db-encryption'
import { encryptKeyExists, isProcessAlive } from '../encrypt'
import { INSTALL_PROFILES } from '../../agents/install-profiles'
import { type AgentProfile, type ProfileTable, capabilityBrief } from '../../agents/profile'
import type { OsName } from '../../platform/platform'
import { type HostDetection, type InstallHost, detectHosts, selectedHosts } from '../detect'
import { type InstallEnv, platformOf } from '../env'
import { keyStoreOf } from '../key-store-choice'
import {
  type Candidate,
  type ChoiceOptions,
  ChoiceError,
  MAX_CHOICE_ATTEMPTS,
  OFF_LABEL,
  type ObserverChoice,
  type ObserverFlag,
  chooseObserverWith,
  chooseObservers,
  defaultEndpoint,
  defaultInput,
  describeInput,
  endpointQuestion,
  GOOSE_MODEL_HINT,
  flagInput,
  isCliLoginProvider,
  listModelsFor,
  modelProblem,
  newCredentialSession,
  offInput,
  pickAnother,
  selfObserverNote,
  settingsInputFor,
  showModels,
} from '../observer-choice'
import { type MissingClis, missingClis } from '../observer-clis'
import { type PathAnswer, type PathFlag, pathQuestionNeeded, planPathSetup } from '../path-setup'
import { type Choice, PromptCancelled, type Prompts } from '../prompt/prompts'
import { confirmRecoveryCode, recoverySinkFromPrompts } from '../recovery-confirm'
import { LOCKED_FOLDER_NOTE, type SetupState, lockedFolderProblem, savedObserversForYes } from './prefill'
import { readInstallRecord } from './record'

export interface SetupFlags {
  dataDir: string | null
  hosts: InstallHost[] | null
  observers: readonly ObserverFlag[]
  noEncrypt: boolean
  port: number | null
  noUpdateCheck: boolean
  noAutoUpdate: boolean
  /** --auto-update: on, whatever was saved. */
  autoUpdate: boolean
  yes: boolean
  /** --path or --no-path: the PATH question answered up front. */
  path?: PathFlag
  /** --holdout or --no-holdout: the impact test question answered up front. */
  holdout?: boolean
  /** --embeddings: the embedding question answered up front. */
  embeddings?: EmbeddingSettings
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
  autoUpdate: boolean
  /** The answer to "Add kinfold to your PATH?"; null or absent when it was not asked. */
  path?: PathAnswer | null
  /** The answer to "Run the impact test?"; absent when it was not asked, and the setting then stays as it is. */
  holdout?: boolean
  /** The embedding provider, from --embeddings or the question; absent: the setting stays as it is. */
  embeddings?: EmbeddingSettings
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

/**
 * Held by the daemon daemon.json names: that port, a pid still running, and,
 * where the system names the port's listener, that same pid. A daemon busy
 * with a long query misses the /health timeout but is still ours, and
 * moving a re-run to another port would rewrite the service for nothing.
 * Only macOS has lsof at that path; Linux and Windows rely on the pid alone,
 * and a wrong claim ends with install's failed /health wait, port unchanged.
 */
async function ownDaemonHolds(env: InstallEnv, port: number): Promise<boolean> {
  const info = readDaemonInfo(env.dataDir)
  if (info.port !== port || info.pid === null || !isProcessAlive(info.pid)) return false
  const holder = await portHolder(env, port)
  return holder === null || holder === String(info.pid)
}

/** Free to bind, or already held by our own daemon, which an install restarts anyway. */
async function portAvailable(env: InstallEnv, port: number): Promise<boolean> {
  if (await (env.portFree ?? bindFree)(port)) return true
  if ((await checkHealth(env, port)).up) return true
  return ownDaemonHolds(env, port)
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
  if (state.folderLocked) {
    ask?.locked('Memory folder', state.dataDir, LOCKED_FOLDER_NOTE)
    return state.dataDir
  }
  if (flags.dataDir !== null) return flags.dataDir
  if (ask === null) return state.dataDir
  const typed = await ask.text('Memory folder:', tildeHome(env, state.dataDir), (value) => (value.trim() === '' ? 'a folder is needed' : null))
  return expandFolder(env, typed.trim())
}

// ---- agents -----------------------------------------------------------------

/** A detected docs-level agent is listed but not ticked: nothing recorded has shown it working. */
function startsTicked(found: HostDetection, profiles: ProfileTable): boolean {
  return found.selected && profiles[found.host].verification === 'live'
}

export const NOT_INSTALLED_HINT = 'not installed'
export const DOCS_HINT = 'built from the docs'
export const UNDETECTABLE_HINT = "can't detect IDE extensions; pick it if you use it"
export const WIRED_GONE_HINT = 'wired, not found now'

/** "2.1.311" out of "2.1.311 (Claude Code)"; a version with no number in it is shown whole. */
const VERSION_NUMBER = /\d+(?:\.\d+)+\S*/

/**
 * One row per supported agent, found or not, so the list also says what
 * Kinfold supports. A row that cannot be ticked says why. One that is wired
 * but no longer found stays open, so it can still be unticked.
 */
function agentChoice(found: HostDetection, profile: AgentProfile, os: OsName, wiredNow: boolean): Choice<InstallHost> {
  const row = { value: found.host, label: profile.name }
  if (found.selected) {
    const version = found.version === null ? found.note : (VERSION_NUMBER.exec(found.version)?.[0] ?? found.version)
    return { ...row, hint: [version, capabilityBrief(profile, os), ...(profile.verification === 'docs' ? [DOCS_HINT] : [])].join(' · ') }
  }
  if (wiredNow) return { ...row, hint: WIRED_GONE_HINT }
  if (found.undetectable === true) return { ...row, hint: UNDETECTABLE_HINT }
  return { ...row, disabled: found.absent === true ? NOT_INSTALLED_HINT : found.note }
}

/** The agents to wire, and what detection found on the way: the observer question reads it instead of looking again. */
interface AgentsAnswer {
  hosts: InstallHost[]
  detections: readonly HostDetection[]
}

async function agentsStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags, profiles: ProfileTable): Promise<AgentsAnswer> {
  const detections = await detectHosts(env, flags.hosts, profiles)
  return { hosts: await pickAgents(env, ask, state, flags, profiles, detections), detections }
}

async function pickAgents(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags, profiles: ProfileTable, detections: readonly HostDetection[]): Promise<InstallHost[]> {
  if (flags.hosts !== null) return selectedHosts(detections)
  const wired = new Set(state.wiredHosts)
  // A re-run starts from the saved wiring, whatever its level, so it never drops or adds wiring unasked.
  const defaults = state.installed ? state.wiredHosts : detections.filter((found) => startsTicked(found, profiles) || wired.has(found.host)).map((found) => found.host)
  if (ask === null) {
    // Under --yes a host whose agent is gone stays wired until someone unticks it.
    if (defaults.length === 0) env.out(NO_AGENTS_NOTE)
    return defaults
  }
  const os = platformOf(env).os
  const choices = detections.map((found) => agentChoice(found, profiles[found.host], os, wired.has(found.host)))
  if (choices.every((choice) => choice.disabled !== undefined)) {
    ask.say(NO_AGENTS_NOTE)
    return []
  }
  return ask.multiSelect('Which agents should share memory?', choices, defaults)
}

// ---- observers --------------------------------------------------------------

type ProviderPick = 'current' | 'off' | ObserverProvider | 'unproven'

/** What an API provider asks for, shown beside it; a CLI provider's row says only whether its CLI is here. */
const PROVIDER_HINTS: Readonly<Partial<Record<ObserverProvider, string>>> = {
  'anthropic-api': 'your Anthropic API key',
  'openai-api': 'your OpenAI API key',
  'gemini-api': 'your Google AI Studio key',
  'qwen-api': "your DashScope key and its region's address",
  'openai-compatible': 'any OpenAI-style server: Ollama, LM Studio, Groq, DeepSeek…',
}


async function askModel(env: InstallEnv, ask: Prompts, host: InstallHost, provider: ObserverProvider, current: Candidate): Promise<string> {
  // goose has no model list: its question says the format instead.
  if (isCliLoginProvider(provider) && provider !== 'goose-cli') showModels(env, provider, await listModelsFor(env, provider))
  const initial = current.input.provider === provider ? current.input.model : (defaultModelFor(provider) ?? '')
  const format = provider === 'goose-cli' ? `, ${GOOSE_MODEL_HINT}` : ''
  const check = (value: string): string | null => (value.trim() === '' ? 'a model name is needed' : modelProblem(provider, value.trim()))
  const model = await ask.text(`Model for ${provider} on ${host}${format}:`, initial, check)
  return model.trim()
}

async function askEndpoint(ask: Prompts, host: InstallHost, provider: EndpointProvider, current: Candidate, saved: ChoiceOptions['saved'], embeddingUrl: ChoiceOptions['embeddingUrl']): Promise<string> {
  const fallback = current.input.provider === provider && current.input.endpoint !== undefined
    ? current.input.endpoint
    : defaultEndpoint(provider, host, saved, provider === 'openai-compatible' ? await embeddingUrl?.() : null)
  const check = (value: string): string | null => {
    const checked = checkEndpoint(provider, value.trim() === '' ? fallback : value)
    return checked.ok ? null : checked.error
  }
  const answer = await ask.text(`${endpointQuestion(provider, host, fallback)}:`, '', check)
  const checked = checkEndpoint(provider, answer.trim() === '' ? fallback : answer)
  if (!checked.ok) throw new ChoiceError(checked.error)
  return checked.value
}

/**
 * The first row is what the agent has now, then one row per provider. A
 * provider whose CLI is not on this machine is shown but cannot be picked. A
 * first row that names one stays open, since a saved choice is the person's
 * to keep, but says so, and the cursor starts on a row that will work.
 */
function observerChoices(current: Candidate, missing: MissingClis): { choices: Choice<ProviderPick>[]; initial: ProviderPick } {
  const stale = missing.get(current.input.provider)
  const providers = OBSERVER_PROVIDERS.map((provider): Choice<ProviderPick> => {
    const reason = missing.get(provider)
    const hint = PROVIDER_HINTS[provider]
    if (reason !== undefined) return { value: provider, label: provider, disabled: reason }
    return hint === undefined ? { value: provider, label: provider } : { value: provider, label: provider, hint }
  })
  // Listed so the reason is seen, never pickable: each would run an agent no live check has proven safe.
  const unproven = Object.entries(UNPROVEN_CLI_PROVIDERS).map(([provider, reason]): Choice<ProviderPick> => ({ value: 'unproven', label: provider, disabled: reason }))
  const first: Choice<ProviderPick> = {
    value: 'current',
    label: describeInput(current.input),
    hint: current.origin === 'saved' ? 'saved' : 'built-in default',
    ...(stale === undefined ? {} : { warn: pickAnother(stale) }),
  }
  const pickable = providers.find((choice) => choice.disabled === undefined)
  // Last, and only when the agent is not off already: then the first row is that choice.
  const off: Choice<ProviderPick>[] = current.input.enabled ? [{ value: 'off', label: OFF_LABEL }] : []
  return { choices: [first, ...providers, ...unproven, ...off], initial: stale === undefined || pickable === undefined ? 'current' : pickable.value }
}

async function askCandidate(env: InstallEnv, ask: Prompts, host: InstallHost, current: Candidate, missing: MissingClis, saved: ChoiceOptions['saved'], embeddingUrl?: ChoiceOptions['embeddingUrl']): Promise<Candidate> {
  const { choices, initial } = observerChoices(current, missing)
  const picked = await ask.select(`Observer for ${host}:`, choices, initial)
  if (picked === 'current') return current
  if (picked === 'off') return { input: offInput(current.input), origin: 'prompt' }
  if (picked === 'unproven') throw new ChoiceError('an unproven provider cannot be picked')
  const model = await askModel(env, ask, host, picked, current)
  const endpoint = isEndpointProvider(picked) ? await askEndpoint(ask, host, picked, current, saved, embeddingUrl) : undefined
  return { input: settingsInputFor(host, picked, model, endpoint), origin: 'prompt' }
}

async function observerFor(env: InstallEnv, ask: Prompts, host: InstallHost, flags: SetupFlags, choice: ChoiceOptions, saved: ChoiceOptions['saved'], clis: () => Promise<MissingClis>): Promise<ObserverChoice> {
  const row = saved?.get(host)
  const current: Candidate = row === undefined ? { input: defaultInput(host), origin: 'default' } : { input: row, origin: 'saved' }
  const flag = flags.observers.find((entry) => entry.host === host)
  const session = newCredentialSession()
  const note = choice.observerNote?.(host) ?? null
  if (note !== null && flag === undefined) ask.say(note)
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const candidate: Candidate = attempt === 0 && flag !== undefined ? { input: flagInput(host, flag, row), origin: 'flag' } : await askCandidate(env, ask, host, current, await clis(), saved, choice.embeddingUrl)
    const result = await chooseObserverWith(env, host, candidate, choice, session)
    if (!('failed' in result)) return result
  }
  throw new ChoiceError(`no working observer for ${host} after ${MAX_CHOICE_ATTEMPTS} tries`)
}

async function observersStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags, choice: ChoiceOptions, agents: AgentsAnswer, profiles: ProfileTable): Promise<ObserverChoice[]> {
  const { hosts } = agents
  const saved = ask !== null || flags.yes ? savedObserversForYes(state, hosts, flags.observers) : undefined
  // Worked out at the first question and kept: a run that asks nothing (--yes, a flag for every agent) looks for no CLI.
  let found: Promise<MissingClis> | null = null
  const clis = (): Promise<MissingClis> => (found ??= missingClis(env, agents.detections, profiles))
  const observerNote = (host: InstallHost): string | null => selfObserverNote(profiles[host])
  let embeddings: Promise<string | null> | null = null
  const embeddingUrl = (): Promise<string | null> => (embeddings ??= getEmbeddingSettings(env).then((settings) => (settings?.provider === 'local-llm' ? settings.llmUrl : null)))
  const options: ChoiceOptions = { ...choice, yes: choice.yes || flags.yes, flags: flags.observers, ...(saved === undefined ? {} : { saved }), missingClis: clis, observerNote, embeddingUrl }
  if (ask === null) return chooseObservers(env, hosts, options)
  const choices: ObserverChoice[] = []
  for (const host of hosts) choices.push(await observerFor(env, ask, host, flags, options, saved, clis))
  return choices
}

// ---- encryption -------------------------------------------------------------

/** The key for a store about to be encrypted, its code shown on the terminal and retyped. Never a second key beside one that exists. */
async function keyWithConfirmedCode(env: InstallEnv, ask: Prompts, reuseStored: boolean): Promise<string> {
  let key = newDbKey()
  if (reuseStored) {
    const stored = storedDbKey(env)
    if (stored.kind === 'unreadable') throw new ChoiceError(staleKeyMessage(env))
    if (stored.kind === 'usable') {
      ask.say(`A database key from an earlier install is already in ${keyStoreOf(env)?.place ?? 'the key store'}; it is used again, and its recovery code is shown once more.`)
      key = stored.key
    }
  }
  const sink = recoverySinkFromPrompts(ask)
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
  if (reuseStored && storedDbKey(env).kind === 'unreadable') throw new ChoiceError(staleKeyMessage(env))
  ask.say(DRY_RUN_NO_CODE)
  return null
}

/** storedDbKey reads 'unreadable' only through a store, so there is one to name. */
function staleKeyMessage(env: InstallEnv): string {
  const store = keyStoreOf(env)
  return store === null ? STALE_DB_KEY : staleDbKey(store)
}

/** What the chosen store says about keeping a key there; [] for the Keychain. */
function storeNotes(env: InstallEnv): readonly string[] {
  return keyStoreOf(env)?.notes ?? []
}

function sayNotes(env: InstallEnv, ask: Prompts): void {
  for (const note of storeNotes(env)) ask.say(note)
}

function headlessEncryption(state: SetupState, flags: SetupFlags): EncryptionAnswer {
  if (state.encryption === 'new') return flags.noEncrypt ? { kind: 'new-plain' } : { kind: 'new-encrypted', key: null }
  if (state.encryption === 'on' && flags.noEncrypt) throw new ChoiceError(NO_TTY_ENCRYPTION_CHANGE)
  return { kind: 'keep' }
}

async function encryptedStoreStep(env: InstallEnv, ask: Prompts, flags: SetupFlags): Promise<EncryptionAnswer> {
  ask.say(ENCRYPTION_IS_ON)
  if (!flags.noEncrypt && (await ask.confirm('Keep memory.db encrypted?', true))) {
    sayNotes(env, ask)
    return { kind: 'keep' }
  }
  const typed = await ask.text('Type decrypt to store memory.db in plaintext again:', '')
  return typed.trim() === 'decrypt' ? { kind: 'decrypt-existing' } : { kind: 'keep' }
}

/** Without a terminal the notes go to the output once, whenever the store ends up encrypted. */
function headlessStep(env: InstallEnv, state: SetupState, flags: SetupFlags): EncryptionAnswer {
  const answer = headlessEncryption(state, flags)
  const encrypted = answer.kind === 'new-encrypted' || (answer.kind === 'keep' && state.encryption === 'on')
  if (encrypted) for (const note of storeNotes(env)) env.out(note)
  return answer
}

async function encryptionStep(env: InstallEnv, ask: Prompts | null, state: SetupState, flags: SetupFlags, dryRun: boolean): Promise<EncryptionAnswer> {
  if (ask === null) return headlessStep(env, state, flags)
  if (state.encryption === 'on') return encryptedStoreStep(env, ask, flags)
  if (state.encryption === 'new') {
    if (flags.noEncrypt || !(await ask.confirm('Encrypt memory.db?', true))) return { kind: 'new-plain' }
    sayNotes(env, ask)
    return { kind: 'new-encrypted', key: await confirmedKey(env, ask, true, dryRun) }
  }
  if (flags.noEncrypt || !(await ask.confirm('Encrypt memory.db?', false))) return { kind: 'keep' }
  // A key already there may open an older encrypted copy; refused here, before a code is shown for a key that would be thrown away.
  if (storedDbKey(env).kind !== 'none') throw new ChoiceError(encryptKeyExists(keyStoreOf(env) ?? { place: 'the key store' }))
  sayNotes(env, ask)
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

const COMMAND_PREFIX = 'kinfold command: '

/** What the PATH step will do with these answers, in the words the done screen uses; null when it does nothing here. */
function commandRow(env: InstallEnv, answers: SetupAnswers, flags: SetupFlags): string | null {
  const summary = planPathSetup(env, readInstallRecord(env.dataDir), { answer: answers.path ?? null, yes: false, flag: flags.path ?? null }).summary
  return summary === null ? null : summary.startsWith(COMMAND_PREFIX) ? summary.slice(COMMAND_PREFIX.length) : summary
}

async function summaryStep(env: InstallEnv, ask: Prompts, answers: SetupAnswers, flags: SetupFlags, profiles: ProfileTable, embeddings: EmbeddingSettings | null = null): Promise<void> {
  const command = commandRow(env, answers, flags)
  const rows = [
    `Memory folder   ${tildeHome(env, answers.dataDir)}`,
    `Agents          ${answers.hosts.length === 0 ? 'none' : answers.hosts.join(', ')}`,
    ...answers.observers.map((observer) => `Observer        ${observer.input.host}: ${describeInput(observer.input)} (${observer.check})`),
    `Encryption      ${ENCRYPTION_TEXT[answers.encryption.kind]}`,
    `Port            ${answers.port}`,
    `Update check    ${answers.updateCheck ? 'daily' : 'off'}`,
    `Auto-update     ${!answers.updateCheck ? 'off (the update check is off)' : answers.autoUpdate ? 'patch releases' : 'off'}`,
    ...(answers.holdout === undefined ? [] : [`Impact test     ${answers.holdout ? `on for ${impactAgents(profiles)}` : 'off'}`]),
    ...(embeddings === null ? [] : [`Embeddings      ${describeEmbeddings(embeddings)}`]),
    ...(command === null ? [] : [`kinfold command ${command}`]),
  ]
  ask.section('Your choices', rows.map((text) => ({ mark: 'none' as const, text })))
  if (!(await ask.confirm('Install with these choices?', true))) throw new PromptCancelled()
}

// ---- the kinfold command ------------------------------------------------------

/** Asked only where Kinfold would change PATH and nothing has answered yet: a flag, a saved choice, or ~/.local/bin already on PATH. */
async function pathStep(env: InstallEnv, ask: Prompts | null, flags: SetupFlags): Promise<PathAnswer | null> {
  if (ask === null || !pathQuestionNeeded(env, readInstallRecord(env.dataDir), flags.path ?? null)) return null
  return (await ask.confirm('Add kinfold to your PATH?', true)) ? 'add' : 'decline'
}

// ---- the sequence -----------------------------------------------------------

type UpdatesChoice = 'auto' | 'notify' | 'off'

const UPDATES_CHOICES: readonly Choice<UpdatesChoice>[] = [
  { value: 'auto', label: 'Check daily and install patch releases', hint: 'larger releases wait for kinfold update' },
  { value: 'notify', label: 'Check daily and tell me' },
  { value: 'off', label: 'Off' },
]

/**
 * One question for both settings, since auto-update only means something
 * while the daily check runs. Turning the check off keeps the saved
 * auto-update choice, so turning it back on later brings that choice back.
 */
async function updatesStep(ask: Prompts | null, state: SetupState, flags: SetupFlags): Promise<{ updateCheck: boolean; autoUpdate: boolean }> {
  const autoUpdate = flags.noAutoUpdate ? false : flags.autoUpdate ? true : state.autoUpdate
  if (flags.noUpdateCheck) return { updateCheck: false, autoUpdate }
  if (ask === null) return { updateCheck: state.updateCheck, autoUpdate }
  const choices = flags.noAutoUpdate ? UPDATES_CHOICES.filter((choice) => choice.value !== 'auto') : UPDATES_CHOICES
  const picked = await ask.select('Updates:', choices, !state.updateCheck ? 'off' : autoUpdate ? 'auto' : 'notify')
  return picked === 'off' ? { updateCheck: false, autoUpdate } : { updateCheck: true, autoUpdate: picked === 'auto' }
}

const impactAgents = (profiles: ProfileTable): string => HOLDOUT_HOSTS.map((host) => profiles[host as InstallHost].name).join(', ')

/**
 * The opt-in impact test, asked only when an agent it runs on is being wired:
 * elsewhere it would hold nothing back and measure nothing. A flag answers it,
 * and with nothing to ask the setting stays as it is. The default is the
 * saved choice, read from the copy the daemon keeps in the data folder.
 */
async function holdoutStep(env: InstallEnv, ask: Prompts | null, flags: SetupFlags, hosts: readonly InstallHost[], profiles: ProfileTable): Promise<boolean | undefined> {
  if (ask === null || flags.holdout !== undefined || !hosts.some((host) => HOLDOUT_HOSTS.includes(host))) return undefined
  const agents = impactAgents(profiles)
  return ask.confirm(`Run the impact test? Kinfold skips memory on about 1 in 10 ${agents} prompts and compares token use, to measure what memory saves.`, readDisplayFile(env.dataDir).holdout)
}

// ---- embeddings ----------------------------------------------------------------

export const DEFAULT_LLM_URL = 'http://127.0.0.1:11434/v1'
export const DEFAULT_LLM_MODEL = 'nomic-embed-text'

const EMBEDDING_CHOICES: readonly Choice<EmbeddingProvider>[] = [
  { value: 'local', label: 'Local model', hint: 'runs on this machine, free, nothing leaves it' },
  { value: 'openrouter', label: 'OpenRouter', hint: 'uses the OpenRouter key and sends memory text to OpenRouter' },
  { value: 'local-llm', label: 'Local LLM server', hint: 'Ollama, LM Studio or another /embeddings server on this machine' },
]

export function describeEmbeddings(settings: EmbeddingSettings): string {
  if (settings.provider === 'local') return 'local model (on this machine)'
  if (settings.provider === 'openrouter') return 'OpenRouter'
  return `local LLM ${settings.llmModel ?? ''} at ${settings.llmUrl ?? ''}`
}

const loopbackOnly = (value: string): string | null => (isLoopbackUrl(value.trim()) ? null : 'an http address on this machine (127.0.0.1, localhost or ::1)')

const sameEmbeddings = (a: EmbeddingSettings, b: EmbeddingSettings): boolean => a.provider === b.provider && a.llmUrl === b.llmUrl && a.llmModel === b.llmModel

interface EmbeddingsAnswer {
  /** What the summary shows; null when nothing was asked. */
  shown: EmbeddingSettings | null
  /** What to send: the flag, or an answer that differs from what is saved. */
  send: EmbeddingSettings | undefined
}

/**
 * Which embedder makes the vectors. Asked on a terminal only; a flag answers
 * it. The default is what the running daemon has saved, else the local model,
 * which is what a store with no saved choice gets anyway.
 */
/**
 * The local LLM address offered for embeddings: the saved one, then an
 * OpenAI-compatible observer's address on this machine (a separate setting;
 * this only saves typing it twice), then Ollama's. A remote observer address
 * is never offered, since embeddings stay on this machine.
 */
export function embeddingUrlDefault(saved: string | null, observers: readonly ObserverChoice[]): string {
  if (saved !== null) return saved
  const local = observers.find((choice) => choice.input.provider === 'openai-compatible' && choice.input.endpoint !== undefined && isLoopbackUrl(choice.input.endpoint))
  return local?.input.endpoint ?? DEFAULT_LLM_URL
}

async function embeddingsStep(env: InstallEnv, ask: Prompts | null, flags: SetupFlags, observers: readonly ObserverChoice[] = []): Promise<EmbeddingsAnswer> {
  if (flags.embeddings !== undefined) return { shown: flags.embeddings, send: flags.embeddings }
  if (ask === null) return { shown: null, send: undefined }
  const saved = (await getEmbeddingSettings(env)) ?? LOCAL_SETTINGS
  const provider = await ask.select('Embeddings for semantic search:', EMBEDDING_CHOICES, saved.provider)
  let picked: EmbeddingSettings = { ...LOCAL_SETTINGS, provider }
  if (provider === 'local-llm') {
    const llmUrl = (await ask.text('Local LLM address:', embeddingUrlDefault(saved.llmUrl, observers), loopbackOnly)).trim()
    const llmModel = (await ask.text('Embedding model:', saved.llmModel ?? DEFAULT_LLM_MODEL, (value) => (value.trim() === '' ? 'a model name is needed' : null))).trim()
    picked = { provider, llmUrl, llmModel, llmDims: null }
  }
  return { shown: picked, send: sameEmbeddings(picked, saved) ? undefined : picked }
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
  profiles: ProfileTable = INSTALL_PROFILES,
): Promise<SetupAnswers> {
  // --yes never asks, even on a terminal: a child `install --yes` must not stop at a question.
  const ask = flags.yes ? null : prompts
  const problem = lockedFolderProblem(firstState, flags.dataDir)
  if (problem !== null) throw new ChoiceError(problem)
  const dataDir = await folderStep(first, ask, firstState, flags)
  const { env, state } = retarget !== undefined && resolve(dataDir) !== resolve(firstState.dataDir) ? await retarget(dataDir) : { env: first, state: firstState }
  const agents = await agentsStep(env, ask, state, flags, profiles)
  const { hosts } = agents
  const observers = await observersStep(env, ask, state, flags, choice, agents, profiles)
  const encryption = await encryptionStep(env, ask, state, flags, choice.dryRun)
  const port = await portStep(env, ask, state, flags)
  const { updateCheck, autoUpdate } = await updatesStep(ask, state, flags)
  const holdout = await holdoutStep(env, ask, flags, hosts, profiles)
  const embeddings = await embeddingsStep(env, ask, flags, observers)
  const path = await pathStep(env, ask, flags)
  const answers: SetupAnswers = {
    dataDir, hosts, observers, encryption, port, updateCheck, autoUpdate, path, ...(holdout !== undefined ? { holdout } : {}), ...(embeddings.send !== undefined ? { embeddings: embeddings.send } : {}),
  }
  if (ask !== null) await summaryStep(env, ask, answers, flags, profiles, embeddings.shown)
  return answers
}
