// What Tailscale says about a node: who owns it and which node it is. The hub
// asks through the tailscale command (`whois --json` for a caller, `status
// --json` for itself) rather than the LocalAPI socket, whose path differs on
// every OS and install. A failed whois reads as "no identity", which the hub
// treats as a refusal; a failed self lookup says why, for status and the log. Only a successful answer is cached, for a minute, so a
// node removed from the tailnet stops passing within that minute.

import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { currentPlatform } from '../platform/platform'
import { isRecord } from '../contract/event'

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

/** Why this machine has no Tailscale identity, in words for status and the log. */
export interface TailscaleProblem {
  problem: string
}

export interface Tailscale {
  whois(address: string): Promise<TailscaleIdentity | null>
  self(): Promise<TailscaleSelf | TailscaleProblem>
}

export type TailscaleRun = { ok: true; stdout: string } | { ok: false; problem: string }

/** Runs the tailscale command with these arguments: its stdout, or why it gave none. */
export type TailscaleRunner = (args: readonly string[]) => Promise<TailscaleRun>

export const TAILSCALE_MISSING = 'tailscale command not found'
export const TAILSCALE_STOPPED = 'Tailscale is not running or not signed in on this machine'
const FAILED = 'the tailscale command failed'
const MAX_PROBLEM_CHARS = 200

export function isTailscaleProblem(value: TailscaleSelf | TailscaleProblem): value is TailscaleProblem {
  return 'problem' in value
}

/** The first non-blank line of the command's output, without escape codes, control or direction characters, bounded. */
export function firstLine(output: string): string {
  const plain = output
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
  const line = plain.split(/\r?\n/).map((part) => part.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim()).find((part) => part !== '') ?? ''
  return line.length > MAX_PROBLEM_CHARS ? `${line.slice(0, MAX_PROBLEM_CHARS)}...` : line
}

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

function parseStatus(run: TailscaleRun): TailscaleSelf | TailscaleProblem {
  if (!run.ok) return { problem: run.problem }
  const value = parseJson(run.stdout)
  if (value === null) return { problem: `${FAILED}: ${firstLine(run.stdout) || 'it printed no status'}` }
  if (value.BackendState !== 'Running' || !isRecord(value.Self)) return { problem: TAILSCALE_STOPPED }
  const self = value.Self
  const userId = idString(self.UserID)
  const nodeId = idString(self.ID)
  if (userId === null || nodeId === null) return { problem: TAILSCALE_STOPPED }
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
      const answer = await run(['whois', '--json', address])
      return answer.ok ? parseWhois(answer.stdout) : null
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

/**
 * The macOS app binary (and the /usr/local/bin wrapper that calls it) acts as
 * a CLI only when TERM is set; without it, it tries to start the GUI and
 * fails. A LaunchAgent has no TERM, so one is always given. "xterm" is the
 * value confirmed against the app; a TERM already set is kept.
 */
export function tailscaleEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value
  if (out.TERM === undefined || out.TERM === '') out.TERM = 'xterm'
  return out
}

type Finished = readonly [string, string, number]

/** The real runner: the command found above (program and leading arguments), bounded by timeoutMs. */
export function processRunner(command: readonly string[] | null = defaultCommand(), env: Readonly<Record<string, string | undefined>> = process.env, timeoutMs: number = TAILSCALE_TIMEOUT_MS): TailscaleRunner {
  return async (args) => {
    if (command === null || command.length === 0) return { ok: false, problem: TAILSCALE_MISSING }
    let child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>
    try {
      child = Bun.spawn([...command, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: tailscaleEnv(env) })
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error'
      return { ok: false, problem: code === 'ENOENT' ? TAILSCALE_MISSING : `${FAILED}: it could not start (${code})` }
    }
    // The deadline covers the output too: a wrapper's child can hold the pipes open after the command itself is gone.
    let timer: Timer | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), timeoutMs)
    })
    const finished: Promise<Finished> = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    finished.catch(() => {})
    try {
      const outcome = await Promise.race([finished, late])
      if (outcome === 'late') {
        child.kill('SIGKILL')
        return { ok: false, problem: `${FAILED}: no answer within ${timeoutMs / 1000} s` }
      }
      const [out, err, code] = outcome
      if (code === 0) return { ok: true, stdout: out }
      return { ok: false, problem: `${FAILED}: ${firstLine(err) || firstLine(out) || `exit code ${code}`}` }
    } catch (error: unknown) {
      return { ok: false, problem: `${FAILED}: ${error instanceof Error ? error.name : 'unknown error'}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

function defaultCommand(): string[] | null {
  const program = findTailscale()
  return program === null ? null : [program]
}

export function systemTailscale(): Tailscale {
  const cli = cliTailscale(processRunner())
  return { whois: cachedWhois(cli.whois), self: cli.self }
}
