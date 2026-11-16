// The hub listener as the daemon runs it. At boot Tailscale may not be up
// yet, so the daemon asks it for this machine's identity and addresses, and
// keeps asking on a slow timer until it answers; only then is the listener
// bound, on that Tailscale address. The hub's key is made on first use and
// kept owner-only in the data folder.

import { createNonceCache } from './auth'
import { loadOrCreateKey } from './client'
import { type HubAnswer, type RunningHub, bindAddress, startHubServer } from './hub-server'
import { type CentralCore, hubRoutes } from './hub-routes'
import { publicKeyOf } from './keys'
import { HUB_KEY_FILE } from './paths'
import type { Tailscale, TailscaleIdentity } from './tailscale'

export const HUB_RETRY_MS = 30_000

export interface HubDaemonDeps {
  dataDir: string
  version: string
  port: number
  tailscale: Tailscale
  /** The current store's handlers; a restore swaps them. */
  core: () => CentralCore
  view: (path: string) => Promise<HubAnswer>
  log: (line: string) => void
  /** Tests only: bind loopback in place of a Tailscale address. */
  allowLoopback?: boolean
  retryMs?: number
  now?: () => number
}

export interface HubState {
  /** host:port once bound; null while waiting for Tailscale. */
  listening: string | null
  hubName: string | null
  error: string | null
}

export interface HubDaemon {
  state(): HubState
  /** Settles once the listener is bound (or the hub was stopped first). */
  ready: Promise<void>
  stop(): Promise<void>
}

export function startHubWhenReady(deps: HubDaemonDeps): HubDaemon {
  let state: HubState = { listening: null, hubName: null, error: null }
  let server: RunningHub | null = null
  let timer: Timer | null = null
  let stopped = false
  let settle = (): void => {}
  const ready = new Promise<void>((resolve) => {
    settle = resolve
  })
  const privateKey = loadOrCreateKey(deps.dataDir, HUB_KEY_FILE)
  const publicKey = publicKeyOf(privateKey)

  async function attempt(): Promise<void> {
    if (stopped) return
    const self = await deps.tailscale.self()
    if (stopped) return
    try {
      if (self === null) throw new Error('Tailscale is not running or not signed in on this machine')
      if (self.identity.tags.length > 0) throw new Error('this machine is a tagged Tailscale node; a hub must be a node owned by your own Tailscale user')
      const identity: TailscaleIdentity = self.identity
      const hostname = bindAddress(self.addresses, deps.allowLoopback === true)
      server = startHubServer({
        dataDir: deps.dataDir,
        version: deps.version,
        hubName: identity.nodeName,
        hubPrivateKey: privateKey,
        hubPublicKey: publicKey,
        auth: { dataDir: deps.dataDir, hub: () => identity, whois: (address) => deps.tailscale.whois(address), now: deps.now ?? Date.now, nonces: createNonceCache(deps.now) },
        routes: hubRoutes({ core: deps.core, view: deps.view, version: deps.version, hubName: identity.nodeName }),
        log: deps.log,
        hostname,
        port: deps.port,
        ...(deps.allowLoopback === true ? { allowLoopback: true } : {}),
      })
      state = { listening: `${hostname.includes(':') ? `[${hostname}]` : hostname}:${server.port}`, hubName: identity.nodeName, error: null }
      deps.log(`central hub listening on ${state.listening}`)
      settle()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (state.error !== message) deps.log(`central hub not listening: ${message}; trying again every ${Math.round((deps.retryMs ?? HUB_RETRY_MS) / 1000)} s`)
      state = { ...state, error: message }
      timer = setTimeout(() => void attempt(), deps.retryMs ?? HUB_RETRY_MS)
    }
  }
  void attempt()

  return {
    state: () => state,
    ready,
    stop: async () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      settle()
      await server?.stop()
      server = null
    },
  }
}

/** The hub's public key as devices store it, for `kinfold central serve` to print. */
export function hubPublicKey(dataDir: string): string {
  return publicKeyOf(loadOrCreateKey(dataDir, HUB_KEY_FILE))
}
