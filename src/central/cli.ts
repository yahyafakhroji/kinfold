// `kinfold central ...`: turn this machine into the hub, pair devices with
// it, join a device to it, and leave again. Mode changes are saved in
// install.json and the background service is restarted so the daemon picks
// them up. Joining imports each local project the hub does not have yet; a
// project already on the hub keeps the hub's version, and this device's own
// store is left as it was.

import type { Parsed } from '../context/types'
import type { InstallEnv } from '../install/env'
import { managedServiceOf } from '../install/service/control'
import { readInstallRecord, setCentralMode } from '../install/setup/record'
import { type DbKeyStore, dbKeyStoreFor } from '../sqlite/keys'
import type { Database } from '../sqlite/types'
import type { ProjectKey } from '../store/project-key'
import { VERSION } from '../version'
import { type HubEndpoint, type HubFetch, callHub, pairWithHub, readKey } from './client'
import { listDevices, removeDevice } from './devices'
import { DEFAULT_HUB_PORT } from './hub-server'
import { hubPublicKey } from './hub-daemon'
import { exportProject, listLocalProjects, openLocalStore } from './import'
import { INVITE_LIFE_MS, cancelInvite, createInvite } from './invites'
import { type CentralMode, centralModeOf } from './mode'
import { DEVICE_KEY_FILE, removeCentralFile } from './paths'
import { centralProjectKey } from './project-key'
import { failureReason } from './relay'
import { type Tailscale, isLoopbackAddress, isTailscaleAddress, systemTailscale } from './tailscale'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type CentralArgs =
  | { command: 'serve'; port: number; off: boolean }
  | { command: 'invite' }
  | { command: 'devices' }
  | { command: 'remove'; device: string }
  | { command: 'join'; hub: string; port: number; code: string }
  | { command: 'leave' }
  | { command: 'import'; project: string }

export const CENTRAL_USAGE = [
  'kinfold central serve [--port <n>]   make this machine the hub and show a code for the first device',
  'kinfold central serve --off          stop being the hub',
  'kinfold central invite               a new code for another device (valid 10 minutes, single use)',
  'kinfold central devices              list paired devices',
  'kinfold central remove <device>      revoke a device at once',
  'kinfold central join <hub> <code>    use the hub\'s memory on this device',
  'kinfold central leave                go back to this device\'s own memory',
  'kinfold central import --project <key>  copy a kept local project into the hub',
].join('\n')

const EXIT_FAILED = 1
const EXIT_USAGE = 2

function portOf(text: string | undefined): number | null {
  const port = Number(text)
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : null
}

/** `<host>` or `<host>:<port>`; an IPv6 address may come bracketed. */
export function splitHub(text: string): { hub: string; port: number | null } | null {
  const bracketed = /^\[([0-9A-Fa-f:]+)\](?::(\d+))?$/.exec(text)
  if (bracketed !== null) return { hub: bracketed[1]!, port: bracketed[2] === undefined ? null : portOf(bracketed[2]) }
  const parts = text.split(':')
  if (parts.length === 2) return /^[A-Za-z0-9.-]{1,253}$/.test(parts[0]!) ? { hub: parts[0]!, port: portOf(parts[1]) } : null
  if (/^[A-Za-z0-9.-]{1,253}$/.test(text) || (parts.length > 2 && /^[0-9A-Fa-f:]+$/.test(text))) return { hub: text, port: null }
  return null
}

/** Null when argv is not a central command. */
export function parseCentralArgs(argv: readonly string[]): Parsed<CentralArgs> | null {
  if (argv[0] !== 'central') return null
  const [, command, ...rest] = argv
  const usage = { ok: false as const, error: CENTRAL_USAGE }
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest[at + 1]
  }
  switch (command) {
    case 'serve': {
      const off = rest.includes('--off')
      const portText = flag('--port')
      const port = portText === undefined ? DEFAULT_HUB_PORT : portOf(portText)
      if (port === null) return { ok: false, error: '--port must be a number from 1024 to 65535' }
      return { ok: true, value: { command: 'serve', port, off } }
    }
    case 'invite': return { ok: true, value: { command: 'invite' } }
    case 'devices': return { ok: true, value: { command: 'devices' } }
    case 'remove': return rest[0] === undefined ? usage : { ok: true, value: { command: 'remove', device: rest[0] } }
    case 'leave': return { ok: true, value: { command: 'leave' } }
    case 'import': {
      const project = flag('--project')
      return project === undefined ? usage : { ok: true, value: { command: 'import', project } }
    }
    case 'join': {
      const [address, code] = rest.filter((arg, index) => !arg.startsWith('--') && rest[index - 1] !== '--port')
      const where = address === undefined ? null : splitHub(address)
      if (where === null || code === undefined) return usage
      const portText = flag('--port')
      const port = portText !== undefined ? portOf(portText) : where.port ?? DEFAULT_HUB_PORT
      if (port === null) return { ok: false, error: '--port must be a number from 1024 to 65535' }
      return { ok: true, value: { command: 'join', hub: where.hub, port, code } }
    }
    default: return usage
  }
}

export interface CentralCliDeps {
  tailscale?: Tailscale
  fetch?: HubFetch
  /** Resolves a hub name to its addresses; default the system resolver. */
  resolve?: (name: string) => Promise<string[]>
  /** Tests only: a loopback hub stands in for the tailnet. */
  allowLoopback?: boolean
  version?: string
  dbKeys?: DbKeyStore
}

interface Context {
  env: InstallEnv
  deps: CentralCliDeps
  version: string
}

async function restartService(ctx: Context, why: string): Promise<void> {
  const service = managedServiceOf(ctx.env)
  if (service === null) {
    ctx.env.out(`Restart the Kinfold daemon to ${why}.`)
    return
  }
  try {
    if (await service.isRunning()) await service.stop()
    await service.start()
    ctx.env.out(`Restarted the ${service.label} to ${why}.`)
  } catch (error: unknown) {
    ctx.env.out(`warning: the ${service.label} did not restart (${error instanceof Error ? error.message : String(error)}); run kinfold status`)
  }
}

function needsRecord(ctx: Context): boolean {
  if (readInstallRecord(ctx.env.dataDir) !== null) return true
  ctx.env.out('This data folder has no install record; run kinfold install first.')
  return false
}

/** How a device should name this hub: the MagicDNS name when there is one, else its first Tailscale address. */
async function hubAddress(ctx: Context, port: number): Promise<string> {
  const self = await (ctx.deps.tailscale ?? systemTailscale()).self()
  if (self === null) return `<this machine's Tailscale name>${port === DEFAULT_HUB_PORT ? '' : `:${port}`}`
  const host = self.dnsName !== '' ? self.dnsName : self.addresses[0] ?? '<this machine>'
  return port === DEFAULT_HUB_PORT ? host : `${host.includes(':') ? `[${host}]` : host}:${port}`
}

async function printInvite(ctx: Context, port: number): Promise<void> {
  const code = createInvite(ctx.env.dataDir, ctx.env.now())
  ctx.env.out(`Code: ${code} (valid ${INVITE_LIFE_MS / 60_000} minutes, for one device)`)
  ctx.env.out(`On the device: kinfold central join ${await hubAddress(ctx, port)} ${code}`)
}

async function serve(ctx: Context, args: Extract<CentralArgs, { command: 'serve' }>): Promise<number> {
  const mode = centralModeOf(ctx.env.dataDir)
  if (args.off) {
    if (mode?.role !== 'hub') {
      ctx.env.out('This machine is not the hub.')
      return 0
    }
    setCentralMode(ctx.env.dataDir, null)
    cancelInvite(ctx.env.dataDir)
    ctx.env.out('Hub mode is off. Paired devices are kept, so kinfold central serve turns it back on for them.')
    await restartService(ctx, 'close the hub port')
    return 0
  }
  if (mode?.role === 'device') {
    ctx.env.out(`This device uses central memory on ${mode.hubName}; run kinfold central leave first.`)
    return EXIT_FAILED
  }
  if (!needsRecord(ctx)) return EXIT_FAILED
  hubPublicKey(ctx.env.dataDir)
  const changed = mode?.role !== 'hub' || mode.port !== args.port
  setCentralMode(ctx.env.dataDir, { role: 'hub', port: args.port })
  ctx.env.out(`This machine is the hub. Devices reach it over Tailscale only, on port ${args.port}.`)
  if (changed) await restartService(ctx, 'open the hub port')
  await printInvite(ctx, args.port)
  return 0
}

function hubOnly(ctx: Context): Extract<CentralMode, { role: 'hub' }> | null {
  const mode = centralModeOf(ctx.env.dataDir)
  if (mode?.role === 'hub') return mode
  ctx.env.out('This machine is not the hub; run kinfold central serve first.')
  return null
}

function deviceOnly(ctx: Context): Extract<CentralMode, { role: 'device' }> | null {
  const mode = centralModeOf(ctx.env.dataDir)
  if (mode?.role === 'device') return mode
  ctx.env.out('This device does not use central memory; run kinfold central join <hub> <code> first.')
  return null
}

function endpointOf(ctx: Context, mode: Extract<CentralMode, { role: 'device' }>): HubEndpoint | null {
  const privateKey = readKey(ctx.env.dataDir, DEVICE_KEY_FILE)
  return privateKey === null ? null : { hub: mode.hub, port: mode.port, hubPublicKey: mode.hubPublicKey, deviceId: mode.deviceId, privateKey, version: ctx.version }
}

function withLocalStore<T>(ctx: Context, read: (db: Database) => T): T | null {
  const db = openLocalStore(ctx.env.dataDir, ctx.deps.dbKeys ?? dbKeyStoreFor(ctx.env.dataDir))
  if (db === null) return null
  try {
    return read(db)
  } finally {
    db.close()
  }
}

/** Sends one local project to the hub; the counts of what the hub added, or the reason it could not. */
async function sendProject(ctx: Context, endpoint: HubEndpoint, project: ProjectKey): Promise<{ ok: true; added: Record<string, number> } | { ok: false; reason: string }> {
  const chunks = withLocalStore(ctx, (db) => [...exportProject(db, project, endpoint.deviceId)]) ?? []
  const added: Record<string, number> = { sessions: 0, prompts: 0, summaries: 0, observations: 0 }
  for (const chunk of chunks) {
    const call = await callHub(endpoint, '/central/import', chunk, { timeoutMs: 60_000, ...(ctx.deps.fetch !== undefined ? { fetch: ctx.deps.fetch } : {}) })
    if (!call.ok) return { ok: false, reason: failureReason(call.reason, 'the hub', call.gap ?? null) }
    if (call.status !== 200) return { ok: false, reason: `the hub answered ${call.status}` }
    for (const [key, value] of Object.entries(call.body as Record<string, number>)) added[key] = (added[key] ?? 0) + value
  }
  return { ok: true, added }
}

const addedLine = (added: Record<string, number>): string => `${added.observations ?? 0} memories, ${added.sessions ?? 0} sessions, ${added.prompts ?? 0} prompts`

/** Keys per known-check call: far under the hub's 1,000 and its 16 KB body. */
const KNOWN_BATCH = 100

/** Which of these central keys the hub holds; null when it could not say. */
async function knownOnHub(ctx: Context, endpoint: HubEndpoint, keys: readonly string[]): Promise<{ ok: true; known: Set<string> } | { ok: false; reason: string }> {
  const known = new Set<string>()
  for (let at = 0; at < keys.length; at += KNOWN_BATCH) {
    const call = await callHub(endpoint, '/central/import/known', { keys: keys.slice(at, at + KNOWN_BATCH) }, ctx.deps.fetch !== undefined ? { fetch: ctx.deps.fetch } : {})
    if (!call.ok) return { ok: false, reason: failureReason(call.reason, 'the hub', call.gap ?? null) }
    const listed = call.status === 200 ? (call.body as { known?: unknown }).known : undefined
    if (!Array.isArray(listed)) return { ok: false, reason: `the hub answered ${call.status}` }
    for (const key of listed) if (typeof key === 'string') known.add(key)
  }
  return { ok: true, known }
}

/**
 * The hub as this device will call it: an address in Tailscale's ranges, so
 * a name that some other resolver answers can never send memory off the
 * tailnet. A name is resolved once, here, and the address is what is saved.
 */
async function tailnetAddress(ctx: Context, hub: string): Promise<string | null> {
  if (isTailscaleAddress(hub) || (ctx.deps.allowLoopback === true && isLoopbackAddress(hub))) return hub
  if (isIP(hub) !== 0) return null
  const addresses = await (ctx.deps.resolve ?? resolveAll)(hub).catch(() => [])
  return addresses.find(isTailscaleAddress) ?? null
}

async function resolveAll(name: string): Promise<string[]> {
  return (await lookup(name, { all: true })).map((entry) => entry.address)
}

async function join(ctx: Context, args: Extract<CentralArgs, { command: 'join' }>): Promise<number> {
  const mode = centralModeOf(ctx.env.dataDir)
  if (mode?.role === 'hub') {
    ctx.env.out('This machine is the hub; a hub cannot also join one. Run kinfold central serve --off first.')
    return EXIT_FAILED
  }
  if (mode?.role === 'device') {
    ctx.env.out(`This device already uses central memory on ${mode.hubName}; run kinfold central leave first.`)
    return EXIT_FAILED
  }
  if (!needsRecord(ctx)) return EXIT_FAILED
  const address = await tailnetAddress(ctx, args.hub)
  if (address === null) {
    ctx.env.out(`${args.hub} does not resolve to a Tailscale address; use the hub's Tailscale name or its 100.x address, with Tailscale up on this device.`)
    return EXIT_FAILED
  }
  const paired = await pairWithHub({ dataDir: ctx.env.dataDir, hub: address, port: args.port, code: args.code, version: ctx.version, ...(ctx.deps.fetch !== undefined ? { fetch: ctx.deps.fetch } : {}) })
  if (!paired.ok) {
    ctx.env.out(paired.error)
    return EXIT_FAILED
  }
  const next: CentralMode = { role: 'device', hub: address, port: args.port, hubName: paired.value.hubName, hubPublicKey: paired.value.hubPublicKey, deviceId: paired.value.deviceId, joinedAt: ctx.env.now() }
  const endpoint = endpointOf(ctx, next)!
  ctx.env.out(`Paired with ${next.hubName}.`)
  // Imported while this device still captures into its own memory, so no live session reaches the hub
  // before its history does.
  const local = withLocalStore(ctx, listLocalProjects) ?? []
  const known = await knownOnHub(ctx, endpoint, local.map((project) => centralProjectKey(project, next.deviceId).key))
  if (!known.ok) {
    ctx.env.out(`Could not check which projects ${next.hubName} already has (${known.reason}), so none were copied. To copy one later: kinfold central import --project <key>`)
    for (const project of local) ctx.env.out(`  kinfold central import --project ${project.key}`)
  }
  const onHub = known.ok ? known.known : null
  for (const project of onHub === null ? [] : local) {
    if (onHub?.has(centralProjectKey(project, next.deviceId).key) === true) {
      ctx.env.out(`${project.displayName}: already on ${next.hubName}; the hub's version is used, and this device's copy is kept here.`)
      continue
    }
    const sent = await sendProject(ctx, endpoint, project)
    ctx.env.out(sent.ok ? `${project.displayName}: imported (${addedLine(sent.added)}).` : `${project.displayName}: not imported (${sent.reason}); run kinfold central import --project ${project.key} later.`)
  }
  setCentralMode(ctx.env.dataDir, next)
  ctx.env.out(`This device now uses ${next.hubName}'s memory. Its own memory is kept as it was; kinfold central leave goes back to it.`)
  await restartService(ctx, 'use central memory')
  return 0
}

async function leave(ctx: Context): Promise<number> {
  const mode = deviceOnly(ctx)
  if (mode === null) return 0
  setCentralMode(ctx.env.dataDir, null)
  removeCentralFile(ctx.env.dataDir, DEVICE_KEY_FILE)
  ctx.env.out(`This device uses its own memory again. What it captured while central stays on ${mode.hubName}.`)
  ctx.env.out(`On ${mode.hubName}, kinfold central remove ${mode.deviceId} revokes this device there too.`)
  await restartService(ctx, 'use this device\'s memory')
  return 0
}

async function importOne(ctx: Context, args: Extract<CentralArgs, { command: 'import' }>): Promise<number> {
  const mode = deviceOnly(ctx)
  if (mode === null) return EXIT_FAILED
  const endpoint = endpointOf(ctx, mode)
  if (endpoint === null) {
    ctx.env.out('This device has no key for the hub; run kinfold central leave, then join again.')
    return EXIT_FAILED
  }
  const project = (withLocalStore(ctx, listLocalProjects) ?? []).find((each) => each.key === args.project || centralProjectKey(each, mode.deviceId).key === args.project)
  if (project === undefined) {
    ctx.env.out(`No project ${args.project} in this device's own memory.`)
    return EXIT_FAILED
  }
  const sent = await sendProject(ctx, endpoint, project)
  if (!sent.ok) {
    ctx.env.out(`Not imported: ${sent.reason}.`)
    return EXIT_FAILED
  }
  ctx.env.out(`${project.displayName}: ${mode.hubName} added what it did not have (${addedLine(sent.added)}).`)
  return 0
}

export async function runCentralCommand(env: InstallEnv, args: CentralArgs, deps: CentralCliDeps = {}): Promise<number> {
  const ctx: Context = { env, deps, version: deps.version ?? VERSION }
  switch (args.command) {
    case 'serve': return serve(ctx, args)
    case 'invite': {
      const mode = hubOnly(ctx)
      if (mode === null) return EXIT_FAILED
      await printInvite(ctx, mode.port)
      return 0
    }
    case 'devices': {
      if (hubOnly(ctx) === null) return EXIT_FAILED
      const devices = listDevices(env.dataDir)
      if (devices.length === 0) env.out('No paired devices.')
      for (const device of devices) env.out(`${device.name}  ${device.id}  paired ${new Date(device.pairedAt).toISOString().slice(0, 10)}`)
      return 0
    }
    case 'remove': {
      if (hubOnly(ctx) === null) return EXIT_FAILED
      const removed = removeDevice(env.dataDir, args.device)
      env.out(removed === null ? `No paired device named ${args.device}.` : `Removed ${removed.name} (${removed.id}); it can no longer read or capture.`)
      return removed === null ? EXIT_FAILED : 0
    }
    case 'join': return join(ctx, args)
    case 'leave': return leave(ctx)
    case 'import': return importOne(ctx, args)
  }
}

export { EXIT_USAGE as CENTRAL_EXIT_USAGE }
