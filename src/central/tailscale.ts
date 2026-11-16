// What Tailscale says about a node: who owns it and which node it is. The hub
// asks through the tailscale command (`whois --json` for a caller, `status
// --json` for itself) rather than the LocalAPI socket, whose path differs on
// every OS and install. Every failure reads as "no identity", which the hub
// treats as a refusal. Only a successful answer is cached, for a minute, so a
// node removed from the tailnet stops passing within that minute.

import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { currentPlatform } from '../platform/platform'

export interface TailscaleIdentity {
  /** The owning user's numeric id, as a string. */
  userId: string
  loginName: string
  /** The node's stable id: it survives address and name changes. */
  nodeId: string
  nodeName: string
  tags: string[]
}

export interface TailscaleSelf {
  identity: TailscaleIdentity
  addresses: string[]
  /** The MagicDNS name without its trailing dot; empty when MagicDNS is off. */
  dnsName: string
}

export interface Tailscale {
  whois(address: string): Promise<TailscaleIdentity | null>
  self(): Promise<TailscaleSelf | null>
}

/** Runs the tailscale command with these arguments; its stdout, or null when it is missing, fails or runs past its time. */
export type TailscaleRunner = (args: readonly string[]) => Promise<string | null>

export const TAILSCALE_TIMEOUT_MS = 3_000
export const WHOIS_CACHE_MS = 60_000

/** 100.64.0.0/10, Tailscale's IPv4 range, as written or IPv4-mapped. */
function isTailscaleV4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 100 && second !== undefined && second >= 64 && second <= 127
}

/** fd7a:115c:a1e0::/48, Tailscale's IPv6 range. */
function isTailscaleV6(address: string): boolean {
  if (isIP(address) !== 6) return false
  const groups = expandV6(address)
  return groups !== null && groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0
}

function expandV6(address: string): number[] | null {
  const [head = '', tail] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const missing = 8 - left.length - right.length
  if (tail === undefined && missing !== 0) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((group) => Number.parseInt(group, 16))
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null
}

export function isTailscaleAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return isTailscaleV4(mapped) || isTailscaleV6(address)
}

export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** The hub's user owns the node, and neither the hub nor the node is a tagged (service) node. */
export function sameOwner(hub: TailscaleIdentity, node: TailscaleIdentity): boolean {
  return hub.tags.length === 0 && node.tags.length === 0 && node.userId === hub.userId
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

const idString = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' && value !== '' ? value : null)
const tagsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [])
const shortName = (name: unknown): string => (typeof name === 'string' ? name.replace(/\.$/, '').split('.')[0] ?? '' : '')

function parseWhois(text: string | null): TailscaleIdentity | null {
  const value = parseJson(text)
  if (value === null || !isRecord(value.Node) || !isRecord(value.UserProfile)) return null
  const node = value.Node
  const user = value.UserProfile
  const userId = idString(user.ID)
  const nodeId = idString(node.StableID)
  if (userId === null || nodeId === null) return null
  return { userId, loginName: typeof user.LoginName === 'string' ? user.LoginName : '', nodeId, nodeName: shortName(node.Name), tags: tagsOf(node.Tags) }
}

function parseStatus(text: string | null): TailscaleSelf | null {
  const value = parseJson(text)
  if (value === null || value.BackendState !== 'Running' || !isRecord(value.Self)) return null
  const self = value.Self
  const userId = idString(self.UserID)
  const nodeId = idString(self.ID)
  if (userId === null || nodeId === null) return null
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string' && isTailscaleAddress(ip)) : []
  const nodeName = typeof self.HostName === 'string' && self.HostName !== '' ? self.HostName : shortName(self.DNSName)
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : ''
  return { identity: { userId, loginName: '', nodeId, nodeName, tags: tagsOf(self.Tags) }, addresses, dnsName }
}

export function cliTailscale(run: TailscaleRunner): Tailscale {
  return {
    whois: async (address) => {
      // Only an address is ever passed, so nothing the caller controls can read as a flag.
      if (isIP(address) === 0) return null
      return parseWhois(await run(['whois', '--json', address]))
    },
    self: async () => parseStatus(await run(['status', '--json', '--peers=false'])),
  }
}

/** Successful lookups per address for WHOIS_CACHE_MS; failures are never kept. */
export function cachedWhois(lookup: (address: string) => Promise<TailscaleIdentity | null>, now: () => number = Date.now): (address: string) => Promise<TailscaleIdentity | null> {
  const cache = new Map<string, { identity: TailscaleIdentity; until: number }>()
  return async (address) => {
    const hit = cache.get(address)
    if (hit !== undefined && hit.until > now()) return hit.identity
    cache.delete(address)
    const identity = await lookup(address)
    if (identity !== null) cache.set(address, { identity, until: now() + WHOIS_CACHE_MS })
    return identity
  }
}

/** Where the tailscale command lives when it is not on PATH: the macOS app bundle and the Windows installer's folder. */
const KNOWN_PLACES: Readonly<Record<string, readonly string[]>> = {
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
}

export function findTailscale(platform: NodeJS.Platform = currentPlatform().node, which: (name: string) => string | null = (name) => Bun.which(name), exists: (path: string) => boolean = existsSync): string | null {
  return which('tailscale') ?? KNOWN_PLACES[platform]?.find(exists) ?? null
}

/** The real runner: the command found above, bounded by TAILSCALE_TIMEOUT_MS, stdout only. */
export function processRunner(program: string | null = findTailscale()): TailscaleRunner {
  return async (args) => {
    if (program === null) return null
    try {
      const child = Bun.spawn([program, ...args], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: TAILSCALE_TIMEOUT_MS })
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      return code === 0 ? out : null
    } catch {
      return null
    }
  }
}

export function systemTailscale(): Tailscale {
  const cli = cliTailscale(processRunner())
  return { whois: cachedWhois(cli.whois), self: cli.self }
}
