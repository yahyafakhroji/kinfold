// `kinfold status`: read-only. Hosts found and wired (yes/no/stale/partial), the
// LaunchAgent, daemon health, each host's observer and where it came from,
// the key store and its entries (metadata lookups only, never the value), the HMAC keys (master and legacy entries, sub-key epochs, leftover plain-text keys), data dir modes, and
// the time of the last backup, whether `kinfold` resolves on PATH and to which program, and duplicate project wiring. It creates nothing,
// not even the data dir.

import { centralStatusLines } from '../central/status'
import { readBackupRecord } from '../backup/record'
import { keptStore } from '../backup/undo'
import { readDisplayFile } from '../context/display-file'
import { HOLDOUT_HOSTS } from '../context/holdout'
import type { EffectiveSettings } from '../daemon/settings-route'
import { envName, readEnv } from '../env-names'
import { OPENROUTER_CREDENTIAL_REF, credentialRefFor } from '../observer/settings'
import { getObserverSettings, projectMergeLines } from './daemon-client'
import { dbStatusLines } from './db-encryption'
import { detectHosts } from './detect'
import { isFoldedAbsent } from './detectors'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths, platformOf } from './env'
import { keyStoreStatusLine, noStoreWord, readKeyStore } from './key-store-choice'
import { type DaemonSituation, EXIT_OK, daemonSituation } from './install'
import { managedServiceOf, serviceOf } from './service/control'
import { hmacStatusLines } from './hmac-migration'
import { mcpStatusLines } from './mcp-wiring'
import type { Mark, Row } from './prompt/prompts'
import { commandStatusLine, loginShellNote } from './path-setup'
import { dataDirAccessFor } from './access/check'
import { vectorStatusLine } from './vec0-install'
import { QUIET_MS, autoUpdateView } from '../update/auto'
import { readAutoState } from '../update/auto-state'
import { detachPlan } from '../update/detach'
import { autoUpdateSetting, betaChannelOn, isPrerelease, updatesEnabled } from '../update/enabled'
import { pendingNotice, userMessage } from '../update/notice'
import { knownRelease, readUpdateState } from '../update/state'
import { compareVersions, isPatchUpdate, parseVersion } from '../update/version-order'
import { VERSION } from '../version'
import { type InstallRecord, readInstallRecord } from './setup/record'
import { type WslStatus, wslStatus } from '../wsl/entry'
import type { HookHostSpec } from '../agents/hook-spec'
import { HOOK_SPECS } from '../agents/hook-specs'
import { INSTALL_PROFILES, hasWiring, isWired, overlapPlan, overlapState, profileOf } from '../agents/install-profiles'
import { type AgentId, type ProfileTable, capabilityBrief, capabilityLine, verificationNote } from '../agents/profile'

type SpecTable = Readonly<Record<AgentId, HookHostSpec | null>>

/** The agents wired now, as install would have chosen them. */
function wiredHosts(env: InstallEnv, profiles: ProfileTable): AgentId[] {
  return Object.values(profiles).flatMap((profile) => (isWired(profile.wiring.state(env)) ? [profile.id] : []))
}

async function hostLines(env: InstallEnv, profiles: ProfileTable, specs: SpecTable): Promise<string[]> {
  const os = platformOf(env).os
  const detections = await detectHosts(env, null, profiles)
  const overlap = overlapPlan(wiredHosts(env, profiles), env, profiles, specs)
  const folded: string[] = []
  const lines = detections.flatMap((detection) => {
    const profile = profiles[detection.host]
    const state = overlapState(env, profile, profiles)
    if (isFoldedAbsent(detection, hasWiring(state))) {
      folded.push(detection.host)
      return []
    }
    const found = detection.selected ? `detected${detection.version !== null ? ` ${detection.version}` : ''}` : `not detected (${detection.note})`
    const wired = profile.wiring.line(env)
    const note = verificationNote(profile.verification)
    const line = `  ${detection.host}: ${found}; wired: ${wired}; ${capabilityLine(profile, os)}${note === null ? '' : `; ${note}`}`
    // Steps and notes for an agent that is neither here nor wired would be noise on every status run.
    const present = detection.selected || isWired(state)
    const overlapNote = overlap.notes[profile.id]
    const extra = [...(overlapNote !== undefined ? [overlapNote] : []), ...profile.manualSteps(os, env)]
    return [line, ...(present ? extra.map((step) => `    ${step}`) : [])]
  })
  return folded.length > 0 ? [...lines, `  not found: ${folded.join(', ')}`] : lines
}

/** Every host's detection, wiring and capability line, then the MCP lines: what status prints under `hosts:`. */
export async function hostStatusLines(env: InstallEnv, profiles: ProfileTable = INSTALL_PROFILES, specs: SpecTable = HOOK_SPECS): Promise<string[]> {
  return [...(await hostLines(env, profiles, specs)), ...mcpStatusLines(env)]
}

function daemonLines(env: InstallEnv, situation: DaemonSituation): string[] {
  const service = serviceOf(env)
  const label = service?.label ?? 'none'
  const config = service !== null && service.isConfigured() ? 'present' : 'missing'
  const owner = situation.health.up ? (situation.foreign ? `, not started by the ${label}` : situation.loaded || situation.legacyLoaded ? `, ${label}` : ', started by hand') : ''
  const pid = situation.pid !== null ? ` pid ${situation.pid}` : ''
  const health = situation.health.up
    ? `up on 127.0.0.1:${situation.port} version ${situation.health.version} schema ${situation.health.schemaVersion}${pid}${owner}`
    : `down (${situation.health.reason})`
  return [`service (${label}): config ${config}; running: ${situation.loaded ? 'yes' : 'no'}`, `daemon /health: ${health}`, vectorStatusLine(env, situation.health)]
}

function effectiveLine(entry: EffectiveSettings): string {
  if ('error' in entry) return `  ${entry.host}: invalid setting (${entry.error})`
  const { provider, model, enabled, source, endpoint } = entry.settings
  // Off runs no model: the agent is still captured, and nothing is summarised.
  if (!enabled) return `  ${entry.host}: off (capture only); source ${source}`
  const ref = credentialRefFor(entry.settings)
  return `  ${entry.host}: ${provider}/${model}${endpoint === undefined ? '' : ` at ${endpoint}`}${ref === null ? '' : ` key ${ref}`}; source ${source}`
}

/**
 * The two display switches, said only when they are not at their defaults: a
 * hidden recall line and a running impact test are the states a person needs
 * to be told about. Read from display.json, which the daemon keeps in step
 * with the store, so status can say it with the daemon down.
 */
function displayLines(env: InstallEnv): string[] {
  const display = readDisplayFile(env.dataDir)
  const agents = HOLDOUT_HOSTS.map((host) => profileOf(host as AgentId).name).join(', ')
  return [
    ...(display.showRecall ? [] : ['recall line: off; agents show nothing about what Kinfold recalled (turn it on with kinfold install --show-recall or in the dashboard)']),
    ...(display.holdout ? [`impact test: on for ${agents}; about 1 prompt in 10 goes without recalled memory, and says so (turn it off with kinfold install --no-holdout or in the dashboard)`] : []),
  ]
}

/** What the claude-cli observer signs in with, as the daemon sees it; an older daemon does not say, and nothing is guessed. */
function claudeAuthLine(auth: string | undefined): string | null {
  if (auth === 'token') return 'claude-cli auth: a long-lived token from `claude setup-token`, kept in the key store'
  if (auth === 'login') return "claude-cli auth: the claude CLI's own login (store a long-lived token with kinfold install --observer-token-stdin)"
  if (auth === 'unknown') return 'claude-cli auth: unknown (the key store could not be asked)'
  return null
}

async function observerLines(env: InstallEnv): Promise<{ lines: string[]; refs: string[] }> {
  const read = await getObserverSettings(env)
  if (!read.ok) return { lines: [`observer settings: unknown (${read.reason})`], refs: [OPENROUTER_CREDENTIAL_REF] }
  const refs = read.view.effective.flatMap((entry) => {
    const ref = 'settings' in entry && entry.settings.enabled ? credentialRefFor(entry.settings) : null
    return ref === null ? [] : [ref]
  })
  // An older daemon sends no backoff list.
  const backoff = Array.isArray(read.view.backoff) ? read.view.backoff.map((entry) => `  observer backing off: ${entry.line}`) : []
  const usesClaude = read.view.effective.some((entry) => 'settings' in entry && entry.settings.enabled && entry.settings.provider === 'claude-cli')
  const auth = usesClaude ? claudeAuthLine(read.view.claudeAuth) : null
  return { lines: ['observer settings:', ...read.view.effective.map(effectiveLine), ...backoff, ...(auth === null ? [] : [auth])], refs: [...new Set([OPENROUTER_CREDENTIAL_REF, ...refs])] }
}

function keyStoreLines(env: InstallEnv, refs: readonly string[]): string[] {
  const read = readKeyStore(env)
  // The key store line above already names why the store is unknown.
  if (!read.ok) return []
  const store = read.store
  if (store === null) return [`${noStoreWord(env)}: none on ${env.platform}`]
  return refs.map((ref) => {
    try {
      return `${store.label} ${ref}: ${store.exists(ref) ? 'present' : 'missing'}`
    } catch (error: unknown) {
      return `${store.label} ${ref}: unknown (${errorMessage(error)})`
    }
  })
}

/** The database lines with the key store line right after the `database:` one. */
async function databaseLines(env: InstallEnv): Promise<string[]> {
  const [database, ...rest] = await dbStatusLines(env)
  return database === undefined ? [keyStoreStatusLine(env)] : [database, keyStoreStatusLine(env), ...rest]
}

/**
 * Why a patch release cannot install itself here though the setting is on;
 * null when it can. The update stops and starts the service, so the service
 * must be the one running the daemon, and the updater must be able to leave it.
 */
export function autoUpdateBlocker(env: InstallEnv, loaded: boolean, exists?: (path: string) => boolean): string | null {
  const service = managedServiceOf(env)
  if (service === null) return 'no background service runs the daemon here'
  if (!loaded) return `the daemon is not run by the ${service.label}`
  const plan = detachPlan({ os: platformOf(env).os, program: '', args: [], envVars: env.envVars ?? {}, ...(exists !== undefined ? { exists } : {}) })
  return plan.ok ? null : plan.reason
}

/**
 * The saved update state only: status never fetches. A patch that auto-update
 * holds back from the notice is named here either way: as about to install
 * itself, or, where `blocker` says it cannot, as available to install by hand.
 */
export function updateLine(env: InstallEnv, running: string = VERSION, blocker: string | null = null): string {
  const record = readInstallRecord(env.dataDir)
  const vars = env.envVars ?? {}
  if (!updatesEnabled(running, record, vars)) return 'update check: off'
  const state = readUpdateState(env.dataDir)
  // Held back only where the patch will install itself; elsewhere it is offered by hand like any release.
  const hold = blocker === null ? { auto: readAutoState(env.dataDir), now: env.now() } : undefined
  // Staging runs where an automatic update could: the same daemon, the same service.
  const stage = { dataDir: env.dataDir, platform: env.platform, arch: env.arch ?? process.arch, capable: blocker === null, now: env.now() }
  const notice = pendingNotice(state, record, running, vars, hold, stage)
  if (notice !== null) return `update: ${userMessage(notice)}`
  const offered = knownRelease(state, betaChannelOn(record, running))
  if (offered !== null && parseVersion(running) !== null && compareVersions(offered.version, running) > 0 && !isPatchUpdate(running, offered.version) && autoUpdateSetting(running, record, vars).on && blocker === null) {
    return `update: downloading Kinfold ${offered.version} so it is ready to install`
  }
  const latest = state.latestVersion
  if (hold !== undefined && latest !== null && isPatchUpdate(running, latest) && autoUpdateSetting(running, record, vars).on) {
    return `update: Kinfold ${latest} will install itself once no agent has been active for ${QUIET_MS / 60_000} minutes`
  }
  return `update: none known (${state.checkedAt === null ? 'never checked' : `last checked ${new Date(state.checkedAt).toISOString()}`})`
}

/** When the last backup was made, from backup.json; null when none was. Stated only: an old backup is the person's call. */
export function backupLine(env: InstallEnv): string | null {
  const record = readBackupRecord(env.dataDir)
  return record === null ? null : `backup: last made ${new Date(record.lastBackupAt).toISOString()}`
}

/** The store a restore replaced and kept, with the command that switches back to it; null when none is kept. */
export function keptStoreLine(env: InstallEnv): string | null {
  const kept = keptStore(env.dataDir)
  return kept === null ? null : `kept store: the store replaced on ${new Date(kept.replacedAt).toISOString()} is kept as ${kept.path}; kinfold restore --undo switches back to it`
}

/** The beta channel's line: on by the record, or on because a prerelease is running (which reads it whatever the record says). */
function betaLines(record: InstallRecord | null, running: string): string[] {
  if (record?.beta === true) return ['beta releases: on (each one waits for your yes)']
  if (!isPrerelease(running)) return []
  const release = running.replace(/-.*$/, '')
  return [`beta releases: on while this prerelease runs (each one waits for your yes); kinfold install --beta keeps them after ${release}`]
}

/** Whether patch releases install themselves, the last one that did, and the last attempt that failed. Reads only. */
export function autoUpdateLines(env: InstallEnv, running: string, blocker: string | null): string[] {
  const vars = env.envVars ?? {}
  // The daemon runs under the service and reads its own environment, so this shell's variable is reported, not obeyed.
  const shellOnly = readEnv(vars, 'NO_AUTO_UPDATE') === '1'
  const view = autoUpdateView(env.dataDir, running, { ...vars, [envName('NO_AUTO_UPDATE')]: undefined }, env.now())
  const state = !view.on ? `off (${view.reason})` : blocker === null ? 'on (patch releases install themselves)' : `manual (${blocker}; run kinfold update for each release)`
  const note = shellOnly && view.on ? `; ${envName('NO_AUTO_UPDATE')} is set in this shell only, which the daemon does not read: run kinfold install --no-auto-update to turn it off` : ''
  const date = (at: number): string => new Date(at).toISOString()
  const homes = Object.entries(readInstallRecord(env.dataDir)?.agentHomes ?? {})
  return [
    `auto-update: ${state}${note}`,
    ...betaLines(readInstallRecord(env.dataDir), running),
    ...(view.lastUpdate === null ? [] : [`  last update: ${view.lastUpdate.version} (was ${view.lastUpdate.previous}) on ${date(view.lastUpdate.at)}`]),
    ...(view.lastError === null ? [] : [`  last error: ${view.lastError.version} on ${date(view.lastError.at)}: ${view.lastError.reason}. ${view.lastError.blocked === true ? 'It is tried again when the daemon restarts or the install changes.' : 'It is tried again after the next daily check.'}`]),
    ...(homes.length === 0 ? [] : [`  agent homes used by an automatic update: ${homes.map(([name, value]) => `${name}=${value}`).join(', ')}`]),
  ]
}

/** "2.1.311" out of "2.1.311 (Claude Code)". */
const VERSION_NUMBER = /\d+(?:\.\d+)+\S*/

/**
 * The agents as a terminal shows them: one short row each for those found or
 * wired, with the rest counted. The plain lines carry paths and steps for
 * every agent; a section is read at a glance, and `--plain` has the rest.
 */
async function agentRows(env: InstallEnv, profiles: ProfileTable): Promise<{ rows: Row[]; present: ReadonlySet<string> }> {
  const os = platformOf(env).os
  const detections = await detectHosts(env, null, profiles)
  const rows: Row[] = []
  // The agents that are here in some way: found, or with wiring in place.
  const present = new Set<string>()
  let absent = 0
  for (const found of detections) {
    const profile = profiles[found.host]
    const state = overlapState(env, profile, profiles)
    const wired = isWired(state)
    if (isFoldedAbsent(found, hasWiring(state))) {
      absent += 1
      continue
    }
    const where = found.selected ? (found.version === null ? 'found' : (VERSION_NUMBER.exec(found.version)?.[0] ?? found.version)) : found.undetectable === true ? "can't be detected" : 'not found now'
    if (wired || found.selected) present.add(found.host)
    // Only wiring that is whole and current is "wired": stale or partial wiring says which.
    const wiring = state === 'yes' ? 'wired' : state === 'no' ? 'not wired' : `wiring ${state}`
    // Found with nothing wired, wired with nothing found, or wired in part is the row to look at.
    const mark = state === 'yes' && found.selected ? 'ok' : wired || found.selected ? 'warn' : 'none'
    rows.push({ mark, text: `${profile.name}: ${where}, ${wiring} · ${capabilityBrief(profile, os)}` })
  }
  return { rows: absent === 0 ? rows : [...rows, { mark: 'none', text: `Not installed: ${absent} other supported agent${absent === 1 ? '' : 's'}` }], present }
}

const MARK_RULES: readonly (readonly [RegExp, Mark])[] = [
  // A line that calls itself a warning is one, whatever else it names.
  [/^warning: /, 'warn'],
  [/^observer backing off: /, 'warn'],
  [/^daemon \/health: up\b/, 'ok'],
  [/^daemon \/health: down\b/, 'fail'],
  [/^service \(.*running: yes/, 'ok'],
  [/^service \(.*running: no/, 'warn'],
  [/^semantic search: on$/, 'ok'],
  // Everything is in place and the daemon has yet to load it: a restart away.
  [/^semantic search: off in the running daemon/, 'warn'],
  [/^database: encrypted \(.*present\)$/, 'ok'],
  // Encrypted with its key gone: nothing can open the memory until the key is back.
  [/^database: encrypted \(.*missing\)$/, 'fail'],
  [/^database: encrypted\b/, 'warn'],
  [/^database: plaintext\b/, 'warn'],
  [/ need fixing\b/, 'warn'],
  [/: invalid setting \(/, 'warn'],
  [/: present$/, 'ok'],
  [/: (missing|unknown\b.*)$/, 'warn'],
  [/^update: Kinfold \S+ is available/, 'warn'],
  [/^update: /, 'ok'],
  [/^auto-update: on\b/, 'ok'],
  [/^last error: /, 'warn'],
  [/^kinfold command: on PATH at .*\(this install\)$/, 'ok'],
  [/^kinfold command: /, 'warn'],
  [/^duplicate wiring: none\b/, 'ok'],
  [/^duplicate wiring\b/, 'warn'],
  [/^[a-z0-9-]+: yes in /, 'ok'],
  [/^[a-z0-9-]+: (no|stale|partial)\b.* in /, 'warn'],
]

/** The mark a status line calls for, read from the words the plain output already uses, so the two renderers cannot disagree. */
export function statusMark(line: string): Mark {
  const text = line.trim()
  return MARK_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'none'
}

/** A marked row stands at the margin; an unmarked one keeps its indent under the line it belongs to. */
const rowsOf = (lines: readonly string[]): Row[] => lines.map((line) => {
  const mark = statusMark(line)
  return { mark, text: mark === 'none' ? line.trimEnd() : line.trim() }
})

/**
 * The observers someone chose. The plain lines list all 22 agents, most on
 * the built-in default and not wired; on a terminal those say nothing new.
 */
function observerRows(lines: readonly string[]): Row[] {
  const chosen = lines.filter((line) => line.startsWith('  ') && !line.endsWith('source built-in'))
  if (chosen.length === 0 && lines[0] === 'observer settings:') return [{ mark: 'none', text: 'every agent is on its built-in default' }]
  // With the heading line gone, the rows stand at the margin.
  return rowsOf(chosen.length > 0 ? chosen.map((line) => line.trim()) : lines)
}

/** The host a `  <host>: ...` row is about, or null. */
const hostOf = (line: string): string | null => /^\s+([a-z0-9-]+): /.exec(line)?.[1] ?? null

/** A row that only matters for an agent that is here: for one that is not installed, "no" is a fact and not a fault. */
function rowsForPresent(lines: readonly string[], present: ReadonlySet<string>): Row[] {
  return lines.map((line) => {
    const host = hostOf(line)
    const mark = statusMark(line)
    const flagged = mark !== 'warn' || host === null || present.has(host)
    return flagged ? { mark, text: mark === 'none' ? line.trimEnd() : line.trim() } : { mark: 'none', text: line.trimEnd() }
  })
}

/** The credentials an agent that is here needs: a missing one is flagged only when something would use it. */
function neededRefs(observerLines: readonly string[], present: ReadonlySet<string>): ReadonlySet<string> {
  const refs = new Set<string>()
  for (const line of observerLines) {
    const host = hostOf(line)
    const ref = / key (\S+)/.exec(line)?.[1]
    if (host !== null && ref !== undefined && present.has(host)) refs.add(ref.replace(/;$/, ''))
  }
  return refs
}

function credentialRows(lines: readonly string[], needed: ReadonlySet<string>): Row[] {
  return lines.map((line) => {
    const ref = /^\S+ (\S+): missing$/.exec(line)?.[1]
    return ref !== undefined && !needed.has(ref) ? { mark: 'none', text: line } : rowsOf([line])[0] as Row
  })
}

export async function status(env: InstallEnv, running: string = VERSION, profiles: ProfileTable = INSTALL_PROFILES): Promise<number> {
  let wsl: WslStatus | null = null
  if (platformOf(env).wsl) {
    // The Windows side can fail in ways this host cannot fix; the rest of status still holds.
    try {
      wsl = await wslStatus(env)
    } catch (error: unknown) {
      env.out(`WSL (preview): status unknown (${errorMessage(error)})`)
    }
  }
  for (const line of wsl?.lines ?? []) env.out(line)
  if (wsl?.replaces === true) return EXIT_OK
  const observer = await observerLines(env)
  const display = displayLines(env)
  const duplicates = findDuplicateWiring(env.cwd, [installPaths(env).claudeSettings])
  const situation = await daemonSituation(env)
  const blocker = autoUpdateBlocker(env, situation.loaded)
  const daemon = [...daemonLines(env, situation), ...(await centralStatusLines({ dataDir: env.dataDir, fetch: (url, init) => env.fetch(url, init ?? {}) }))]
  const database = [...(await databaseLines(env)), ...(await projectMergeLines(env))]
  const credentials = keyStoreLines(env, observer.refs)
  const keys = [
    ...credentials,
    ...hmacStatusLines(env),
    ...(await dataDirAccessFor(env).statusLines(env.dataDir)),
    ...[backupLine(env), keptStoreLine(env)].filter((line) => line !== null),
  ]
  const update = updateLine(env, running, blocker)
  const updates = [update, ...autoUpdateLines(env, running, blocker)]
  const record = readInstallRecord(env.dataDir)
  const login = loginShellNote(env, record)
  const command = [commandStatusLine(env, record), ...(login === null ? [] : [login]), ...(duplicates.length === 0 ? ['duplicate wiring: none in this directory'] : duplicateWarning(duplicates))]
  if (env.ui !== undefined) {
    const agents = await agentRows(env, profiles)
    env.ui.section('Agents', [...agents.rows, ...rowsForPresent(mcpStatusLines(env), agents.present)])
    env.ui.section('Daemon', rowsOf(daemon))
    env.ui.section('Memory', [...rowsOf(database), ...credentialRows(credentials, neededRefs(observer.lines, agents.present)), ...rowsOf(keys.slice(credentials.length))])
    env.ui.section('Observers', [...observerRows(observer.lines), ...rowsOf(display)])
    env.ui.section('Updates', rowsOf(updates))
    env.ui.section('Command', rowsOf(command))
    env.ui.next(!situation.health.up ? 'Start the daemon with: kinfold install' : statusMark(update) === 'warn' ? update.replace(/^update: /, '') : 'Open the dashboard with: kinfold dashboard')
    return EXIT_OK
  }
  // The order scripts have always read: the observer lines sit between the database and the key entries.
  const lines = ['hosts:', ...(await hostStatusLines(env, profiles)), ...daemon, ...database, ...observer.lines, ...display, ...keys, ...updates, ...command]
  for (const line of lines) env.out(line)
  return EXIT_OK
}
