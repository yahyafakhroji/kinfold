// The daemon's central-memory pieces, built from its own store and handlers:
// the hub's view of the current store (what devices may ask of it), a
// device's endpoint for its relay, and the status both report.

import { callTool } from '../mcp/tools'
import type { PrepareOptions } from '../capture/prepare'
import type { ContextRequest, ContextResult } from '../context/types'
import type { CentralAsk } from '../daemon/context-route'
import type { ReadRouteDeps } from '../daemon/read-routes'
import type { Database } from '../sqlite/types'
import type { McpRead } from '../store/mcp-read-store'
import { canonicalKey, registerProject } from '../store/project-merge'
import type { SemanticAnswer, SemanticRequest } from '../vectors/search'
import { readKey } from './client'
import type { HubEndpoint, HubFailure } from './client'
import { listDevices } from './devices'
import { captureHandler } from './hub-capture'
import { importChunk, knownProjects } from './import'
import type { HubDaemon } from './hub-daemon'
import type { CentralCore } from './hub-routes'
import type { CentralMode } from './mode'
import { DEVICE_KEY_FILE } from './paths'
import { type Relay, failureReason } from './relay'

export interface HubCoreDeps {
  db: Database
  marker: () => PrepareOptions
  /** Called after new captures are stored: the observer's tick. */
  onStored: () => void
  context: (request: ContextRequest, central?: CentralAsk) => Promise<ContextResult>
  reads: ReadRouteDeps
  semantic: (request: SemanticRequest) => Promise<SemanticAnswer>
  mcpRead: (read: McpRead) => number
  now: () => number
}

export function hubCore(deps: HubCoreDeps): CentralCore {
  return {
    capture: captureHandler({ db: deps.db, prepare: deps.marker, now: deps.now, onStored: deps.onStored }),
    context: (request, project, budgetMs) => {
      // A device may ask before its first capture of this project has arrived.
      const projectKey = registerProject(deps.db, project, deps.now())
      return deps.context(request, { projectKey, ...(budgetMs !== undefined ? { budgetMs } : {}) })
    },
    // A device names its project by its own key; the hub may have merged that key into another.
    read: (tool, args, projectKey) => callTool(tool, args, { reader: deps.reads.reader, projectKey: projectKey === null ? null : canonicalKey(deps.db, projectKey), now: deps.reads.now, ...(deps.reads.semantic !== undefined ? { semantic: deps.reads.semantic } : {}) }),
    semantic: deps.semantic,
    mcpRead: deps.mcpRead,
    importChunk: (body, context) => {
      const answer = importChunk(deps.db, body, context.deviceId, deps.now(), deps.marker())
      if (answer.status === 200) deps.onStored()
      return answer
    },
    knownProjects: (keys) => knownProjects(deps.db, keys),
  }
}

/** The relay's hub, or null when this device's key is missing (it was never paired, or its files were removed). */
export function deviceEndpoint(dataDir: string, mode: Extract<CentralMode, { role: 'device' }>, version: string): HubEndpoint | null {
  const privateKey = readKey(dataDir, DEVICE_KEY_FILE)
  return privateKey === null ? null : { hub: mode.hub, port: mode.port, hubPublicKey: mode.hubPublicKey, deviceId: mode.deviceId, privateKey, version }
}

export type CentralStatus =
  | { role: 'local' }
  | { role: 'hub'; hubName: string | null; listening: string | null; error: string | null; devices: { id: string; name: string; pairedAt: number }[] }
  | { role: 'device'; hub: string; address: string; deviceId: string; reachable: boolean | null; failure: HubFailure | null; problem: string | null; queued: number; lastContactAt: number | null }

export function centralStatus(dataDir: string, mode: CentralMode | null, hub: HubDaemon | null, relay: Relay | null): CentralStatus {
  if (mode?.role === 'hub') {
    const state = hub?.state() ?? { listening: null, hubName: null, error: 'the hub listener did not start' }
    return { role: 'hub', ...state, devices: listDevices(dataDir).map(({ id, name, pairedAt }) => ({ id, name, pairedAt })) }
  }
  if (mode?.role === 'device' && relay !== null) {
    const state = relay.state()
    return {
      role: 'device', hub: mode.hubName, address: `${mode.hub}:${mode.port}`, deviceId: mode.deviceId, reachable: state.reachable, failure: state.failure,
      problem: state.failure === null ? null : failureReason(state.failure, mode.hubName, state.gap), queued: state.queued, lastContactAt: state.lastContactAt,
    }
  }
  return { role: 'local' }
}
