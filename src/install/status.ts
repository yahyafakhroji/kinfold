// `kinfold status`: read-only. Hosts found and wired (yes/no/stale/partial), the
// LaunchAgent, daemon health, each host's observer and where it came from,
// keychain entries (metadata lookups only, never -w), the HMAC keys (P1-J:
// master and legacy entries, sub-key epochs, leftover plain-text keys), data dir modes, and
// duplicate project wiring. It creates nothing, not even the data dir.

import { existsSync } from 'node:fs'
import type { EffectiveSettings } from '../daemon/settings-route'
import { OPENROUTER_CREDENTIAL_REF } from '../observer/settings'
import { credentialWriterFor } from '../secrets/keychain-writer'
import { inspectSamHooks } from './claude-hooks'
import { getObserverSettings } from './daemon-client'
import { dbStatusLines } from './db-encryption'
import { detectHosts } from './detect'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { readJsonObject, readTextOrNull } from './files'
import { EXIT_OK, daemonSituation } from './install'
import { hmacStatusLines } from './hmac-migration'
import { hostWiringLine } from './host-wiring'
import { mcpStatusLines } from './mcp-wiring'
import { inspectShim } from './opencode-shim'
import { describeModeChange, scanDataDirModes } from './permissions'
import { vectorStatusLine } from './vec0-install'

function claudeWiring(env: InstallEnv): string {
  const paths = installPaths(env)
  try {
    const file = readJsonObject(paths.claudeSettings)
    return file.exists ? inspectSamHooks(file.value, paths.hookScript) : 'no (no settings.json)'
  } catch (error: unknown) {
    return `unknown (${errorMessage(error)})`
  }
}

function opencodeWiring(env: InstallEnv): string {
  const paths = installPaths(env)
  const state = inspectShim(readTextOrNull(paths.opencodePlugin), paths.pluginEntry)
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
  const plist = existsSync(installPaths(env).launchAgentPlist) ? 'present' : 'missing'
  const owner = situation.health.up ? (situation.foreign ? ', not started by the LaunchAgent' : ', LaunchAgent') : ''
  const pid = situation.pid !== null ? ` pid ${situation.pid}` : ''
  const health = situation.health.up
    ? `up on 127.0.0.1:${situation.port} version ${situation.health.version} schema ${situation.health.schemaVersion}${pid}${owner}`
    : `down (${situation.health.reason})`
  return [`launch agent: plist ${plist}; loaded: ${situation.loaded ? 'yes' : 'no'}`, `daemon /health: ${health}`, vectorStatusLine(env, situation.health)]
}

function effectiveLine(entry: EffectiveSettings): string {
  if ('error' in entry) return `  ${entry.host}: invalid setting (${entry.error})`
  const { provider, model, credentialRef, enabled, source } = entry.settings
  return `  ${entry.host}: ${provider}/${model}${credentialRef !== null ? ` key ${credentialRef}` : ''}${enabled ? '' : ' (disabled)'}; source ${source}`
}

async function observerLines(env: InstallEnv): Promise<{ lines: string[]; refs: string[] }> {
  const read = await getObserverSettings(env)
  if (!read.ok) return { lines: [`observer settings: unknown (${read.reason})`], refs: [OPENROUTER_CREDENTIAL_REF] }
  const refs = read.view.effective.flatMap((entry) => ('settings' in entry && entry.settings.provider !== 'claude-cli' ? [entry.settings.credentialRef ?? OPENROUTER_CREDENTIAL_REF] : []))
  return { lines: ['observer settings:', ...read.view.effective.map(effectiveLine)], refs: [...new Set([OPENROUTER_CREDENTIAL_REF, ...refs])] }
}

function keychainLines(env: InstallEnv, refs: readonly string[]): string[] {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) return [`keychain: none on ${env.platform}`]
  return refs.map((ref) => {
    try {
      return `keychain ${ref}: ${writer.exists(ref) ? 'present' : 'missing'}`
    } catch (error: unknown) {
      return `keychain ${ref}: unknown (${errorMessage(error)})`
    }
  })
}

function dataDirLines(env: InstallEnv): string[] {
  if (!existsSync(env.dataDir)) return [`data dir ${env.dataDir}: missing`]
  const scan = scanDataDirModes(env.dataDir)
  if (scan.changes.length === 0) return [`data dir ${env.dataDir}: modes ok (${scan.checked} checked, dirs 0700, files 0600)`]
  return [`data dir ${env.dataDir}: ${scan.changes.length} of ${scan.checked} need fixing (install fixes them):`, ...scan.changes.map((change) => `  ${describeModeChange(change)}`)]
}

export async function status(env: InstallEnv): Promise<number> {
  const observer = await observerLines(env)
  const duplicates = findDuplicateWiring(env.cwd, [installPaths(env).claudeSettings])
  const lines = [
    'hosts:',
    ...(await hostLines(env)),
    ...mcpStatusLines(env),
    ...(await daemonLines(env)),
    ...(await dbStatusLines(env)),
    ...observer.lines,
    ...keychainLines(env, observer.refs),
    ...hmacStatusLines(env),
    ...dataDirLines(env),
    ...(duplicates.length === 0 ? ['duplicate wiring: none in this directory'] : duplicateWarning(duplicates)),
  ]
  for (const line of lines) env.out(line)
  return EXIT_OK
}
