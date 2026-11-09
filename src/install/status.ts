// `kinfold status`: read-only. Hosts found and wired (yes/no/stale/partial), the
// LaunchAgent, daemon health, each host's observer and where it came from,
// the key store and its entries (metadata lookups only, never the value), the HMAC keys (master and legacy entries, sub-key epochs, leftover plain-text keys), data dir modes, and
// duplicate project wiring. It creates nothing, not even the data dir.

import type { EffectiveSettings } from '../daemon/settings-route'
import { OPENROUTER_CREDENTIAL_REF, providerTakesKey } from '../observer/settings'
import { inspectSamHooks } from './claude-hooks'
import { getObserverSettings } from './daemon-client'
import { dbStatusLines } from './db-encryption'
import { detectHosts } from './detect'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths, platformOf } from './env'
import { keyStoreStatusLine, noStoreWord, readKeyStore } from './key-store-choice'
import { entryCommand } from './entry'
import { readJsonObject, readTextOrNull } from './files'
import { EXIT_OK, daemonSituation } from './install'
import { serviceOf } from './service/control'
import { hmacStatusLines } from './hmac-migration'
import { hostWiringLine } from './host-wiring'
import { mcpStatusLines } from './mcp-wiring'
import { inspectShim } from './opencode-shim'
import { dataDirAccessFor } from './access/check'
import { vectorStatusLine } from './vec0-install'
import { updatesEnabled } from '../update/enabled'
import { availableMessage, pendingNotice } from '../update/notice'
import { readUpdateState } from '../update/state'
import { VERSION } from '../version'
import { readInstallRecord } from './setup/record'
import { wslStatus } from '../wsl/entry'

function claudeWiring(env: InstallEnv): string {
  const paths = installPaths(env)
  try {
    const file = readJsonObject(paths.claudeSettings)
    return file.exists ? inspectSamHooks(file.value, entryCommand(env.mode, 'hook', env.dataDir)) : 'no (no settings.json)'
  } catch (error: unknown) {
    return `unknown (${errorMessage(error)})`
  }
}

function opencodeWiring(env: InstallEnv): string {
  const paths = installPaths(env)
  const state = inspectShim(readTextOrNull(paths.opencodePlugin), { pluginEntry: paths.pluginEntry, dataDir: env.dataDir })
  return state === 'foreign' ? 'no (a file by our name exists but is not our shim)' : state === 'stale' ? 'stale path' : state
}

async function hostLines(env: InstallEnv): Promise<string[]> {
  const detections = await detectHosts(env, null)
  const paths = installPaths(env)
  return detections.map((detection) => {
    const found = detection.selected ? `detected${detection.version !== null ? ` ${detection.version}` : ''}` : `not detected (${detection.note})`
    const wired = detection.host === 'claude-code'
      ? `${claudeWiring(env)} in ${paths.claudeSettings}`
      : detection.host === 'opencode' ? `${opencodeWiring(env)} in ${paths.opencodePlugin}` : hostWiringLine(env, detection.host)
    return `  ${detection.host}: ${found}; wired: ${wired}`
  })
}

async function daemonLines(env: InstallEnv): Promise<string[]> {
  const situation = await daemonSituation(env)
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
  const { provider, model, credentialRef, enabled, source } = entry.settings
  return `  ${entry.host}: ${provider}/${model}${credentialRef !== null && providerTakesKey(provider) ? ` key ${credentialRef}` : ''}${enabled ? '' : ' (disabled)'}; source ${source}`
}

async function observerLines(env: InstallEnv): Promise<{ lines: string[]; refs: string[] }> {
  const read = await getObserverSettings(env)
  if (!read.ok) return { lines: [`observer settings: unknown (${read.reason})`], refs: [OPENROUTER_CREDENTIAL_REF] }
  const refs = read.view.effective.flatMap((entry) => ('settings' in entry && providerTakesKey(entry.settings.provider) ? [entry.settings.credentialRef ?? OPENROUTER_CREDENTIAL_REF] : []))
  return { lines: ['observer settings:', ...read.view.effective.map(effectiveLine)], refs: [...new Set([OPENROUTER_CREDENTIAL_REF, ...refs])] }
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

/** The saved update state only: status never fetches. */
export function updateLine(env: InstallEnv, running: string = VERSION): string {
  const record = readInstallRecord(env.dataDir)
  const vars = env.envVars ?? {}
  if (!updatesEnabled(running, record, vars)) return 'update check: off'
  const state = readUpdateState(env.dataDir)
  const notice = pendingNotice(state, record, running, vars)
  if (notice !== null) return `update: ${availableMessage(notice)}`
  return `update: none known (${state.checkedAt === null ? 'never checked' : `last checked ${new Date(state.checkedAt).toISOString()}`})`
}

export async function status(env: InstallEnv, running: string = VERSION): Promise<number> {
  const wsl = platformOf(env).wsl ? await wslStatus(env) : null
  for (const line of wsl?.lines ?? []) env.out(line)
  if (wsl?.replaces === true) return EXIT_OK
  const observer = await observerLines(env)
  const duplicates = findDuplicateWiring(env.cwd, [installPaths(env).claudeSettings])
  const lines = [
    'hosts:',
    ...(await hostLines(env)),
    ...mcpStatusLines(env),
    ...(await daemonLines(env)),
    ...(await databaseLines(env)),
    ...observer.lines,
    ...keyStoreLines(env, observer.refs),
    ...hmacStatusLines(env),
    ...(await dataDirAccessFor(env).statusLines(env.dataDir)),
    updateLine(env, running),
    ...(duplicates.length === 0 ? ['duplicate wiring: none in this directory'] : duplicateWarning(duplicates)),
  ]
  for (const line of lines) env.out(line)
  return EXIT_OK
}
