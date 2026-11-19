// A central device's daemon in front of its hub. Hooks and the MCP server
// talk to this daemon over loopback as they always have; it answers by asking
// the hub. Before anything leaves the device, the device does what only it
// can: it resolves project keys (git runs in its own folders) and redacts
// (captures were redacted at the edge; prompts and search queries are
// redacted here). Captures wait in the spool until the hub has stored them,
// so a hub that is down, slow or on another version loses nothing. Recall
// is asked under the hook's own wait and answers "unavailable" rather than
// make a prompt wait.

import { cleanText, type PrepareOptions } from '../capture/prepare'
import { shownBudgetMs } from '../daemon/context-route'
import type { RouteAnswer } from '../daemon/data-routes'
import { unavailableOutcome } from '../wsl/daemon-tools'
import { type ContextRequest, type ContextResult, EMPTY_CONTEXT } from '../context/types'
import type { McpRead } from '../store/mcp-read-store'
import type { ProjectKey, ProjectKeyResolver } from '../store/project-key'
import { countSpool, quarantineSpoolEntry, readSpool, removeSpoolEntry } from '../spool/spool'
import type { SemanticAnswer, SemanticRequest } from '../vectors/search'
import { type HubCall, type HubEndpoint, type HubFailure, callHub } from './client'
import { centralProjectKey } from './project-key'
import { type VersionGap, gapLine } from './version-rule'

/** Events per capture call; the byte budget below usually ends a batch first. */
export const RELAY_BATCH_EVENTS = 200
/** Well under the hub's 4 MB batch cap. */
export const RELAY_BATCH_BYTES = 1_500_000
export const CAPTURE_TIMEOUT_MS = 15_000
export const READ_TIMEOUT_MS = 4_000
/** A dashboard page: a report on a large hub can take seconds, and nobody's prompt waits on it. */
export const VIEW_TIMEOUT_MS = 12_000
/** What the relay leaves of the hook's wait for its own work and the loopback hop. */
const CONTEXT_MARGIN_MS = 30
/** A round trip over the tailnet with signing at both ends, on a home network or a nearby relay. */
const TAILNET_TRIP_MS = 40

export interface RelayDeps {
  spoolDir: string
  /** The hub to ask; null when this data folder is not a paired device. */
  endpoint: () => HubEndpoint | null
  hubName: string
  projectKeyFor: ProjectKeyResolver
  /** This device's redaction keys, for prompts and queries. */
  prepare: () => PrepareOptions
  log: (line: string) => void
  now?: () => number
  /** The byte budget of one capture call; default RELAY_BATCH_BYTES. */
  batchBytes?: number
  /** Default VIEW_TIMEOUT_MS. */
  viewTimeoutMs?: number
}

export interface ForwardResult {
  sent: number
  failure: HubFailure | null
}

export interface RelayState {
  /** Null until the hub has been asked once. */
  reachable: boolean | null
  failure: HubFailure | null
  gap: VersionGap | null
  lastContactAt: number | null
  queued: number
}

export interface Relay {
  forward(): Promise<ForwardResult>
  context(request: ContextRequest): Promise<ContextResult>
  read(tool: string, args: unknown, cwd: string | null): Promise<RouteAnswer>
  semantic(request: SemanticRequest): Promise<SemanticAnswer>
  mcpRead(read: McpRead): Promise<RouteAnswer>
  view(path: string): Promise<RouteAnswer>
  hello(): Promise<HubCall>
  state(): RelayState
}

export const UNREACHABLE_PROMPT_LINE = "kinfold · central memory unreachable; this prompt is saved and will be sent when it's back"
export const UNREACHABLE_START_LINE = "kinfold · central memory unreachable; this session is saved and will be sent when it's back"

/** What a device says about a failed call, in plain words. */
export function failureReason(failure: HubFailure, hubName: string, gap: VersionGap | null): string {
  switch (failure) {
    case 'version': return gap !== null ? gapLine(gap) : 'hub and device run different Kinfold versions'
    case 'unpaired': return `this device is no longer paired with ${hubName}; run kinfold central join again, or kinfold central leave`
    case 'refused': return `${hubName} refused this device (check that both machines are signed in to Tailscale as the same user)`
    case 'bad-signature': return `the answer from ${hubName}'s address was not signed by your hub`
    case 'bad-answer': return `${hubName} sent an answer Kinfold cannot read`
    case 'hub-error': return `${hubName} had an error answering (its daemon log says why)`
    case 'too-large': return `${hubName} refused a request as too large`
    // An answer that came too late: the hub is there but busy, which no network fix changes.
    case 'timeout': return `${hubName} is busy and didn't answer in time`
    case 'unreachable': return `could not reach the hub ${hubName}`
  }
}

function unavailableLine(failure: HubFailure, request: ContextRequest, hubName: string, gap: VersionGap | null): string {
  if (failure === 'timeout') return `kinfold · ${failureReason(failure, hubName, gap)}; this ${request.channel === 'prompt' ? 'prompt' : 'session'} is saved and will be sent when it answers`
  if (failure === 'unreachable') return request.channel === 'prompt' ? UNREACHABLE_PROMPT_LINE : UNREACHABLE_START_LINE
  return `kinfold · central memory unavailable: ${failureReason(failure, hubName, gap)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A tool's string arguments that carry free text: the search query. */
const FREE_TEXT_ARGS = ['query'] as const

export function createRelay(deps: RelayDeps): Relay {
  const now = deps.now ?? Date.now
  let state: Omit<RelayState, 'queued'> = { reachable: null, failure: null, gap: null, lastContactAt: null }
  let forwarding: Promise<ForwardResult> | null = null

  const note = (call: HubCall): void => {
    // The hub answered, with or without what was asked: it is reachable. Only a silence is not.
    state = call.ok || !['unreachable', 'timeout', 'bad-signature'].includes(call.reason)
      ? { reachable: call.ok ? true : call.reason !== 'refused', failure: call.ok ? null : call.reason, gap: call.ok ? null : call.gap ?? null, lastContactAt: now() }
      : { ...state, reachable: false, failure: call.reason, gap: null }
  }
  /** quietTimeout: a timeout is not noted, because the caller asks again before saying anything. */
  const ask = async (path: string, payload: unknown, timeoutMs: number, quietTimeout = false): Promise<HubCall> => {
    const endpoint = deps.endpoint()
    if (endpoint === null) return { ok: false, reason: 'unpaired' }
    const call = await callHub(endpoint, path, payload, { timeoutMs })
    if (!(quietTimeout && !call.ok && call.reason === 'timeout')) note(call)
    return call
  }
  const scopedFor = (endpoint: HubEndpoint | null) => (cwd: string): ProjectKey => {
    const project = deps.projectKeyFor(cwd)
    return endpoint === null ? project : centralProjectKey(project, endpoint.deviceId)
  }
  const scoped = (cwd: string): ProjectKey => scopedFor(deps.endpoint())(cwd)
  const reasonOf = (call: Extract<HubCall, { ok: false }>): string => failureReason(call.reason, deps.hubName, call.gap ?? null)

  async function forwardOnce(): Promise<ForwardResult> {
    let sent = 0
    // Read once per forward: the key file does not change under a running daemon.
    const scope = scopedFor(deps.endpoint())
    const budget = deps.batchBytes ?? RELAY_BATCH_BYTES
    for (;;) {
      const batch = readSpool(deps.spoolDir, RELAY_BATCH_EVENTS)
      if (batch.quarantined.length > 0) deps.log(`relay quarantined=${batch.quarantined.length}`)
      if (batch.entries.length === 0) return { sent, failure: null }
      const taken: typeof batch.entries = []
      const items: unknown[] = []
      let bytes = 0
      for (const entry of batch.entries) {
        // The transcript is a file on this device; the hub must never be handed a path to read.
        const { transcriptPath: _local, ...event } = entry.event
        const item = { event, project: scope(event.cwd) }
        // Bytes, as the hub counts them: text of many-byte characters is several times its length.
        const size = Buffer.byteLength(JSON.stringify(item))
        if (items.length > 0 && bytes + size > budget) break
        items.push(item)
        taken.push(entry)
        bytes += size
      }
      const call = await ask('/central/capture', { events: items }, CAPTURE_TIMEOUT_MS)
      if (!call.ok || call.status !== 200) {
        const failure = call.ok ? 'refused' : call.reason
        if (call.ok) state = { ...state, failure: 'refused' }
        deps.log(`relay capture kept=${taken.length} reason=${failure}${call.ok ? ` status=${call.status}` : ''}`)
        return { sent, failure }
      }
      const rejected = new Set(rejectedIds(call.body))
      for (const entry of taken) {
        if (rejected.has(entry.event.eventId)) quarantineSpoolEntry(entry.path)
        else removeSpoolEntry(entry.path)
      }
      if (rejected.size > 0) deps.log(`relay capture rejected=${rejected.size}; set aside in the spool's quarantine`)
      sent += taken.length - rejected.size
      if (taken.length < batch.entries.length) continue
      if (batch.entries.length < RELAY_BATCH_EVENTS) return { sent, failure: null }
    }
  }

  return {
    forward: () => {
      forwarding ??= forwardOnce().finally(() => {
        forwarding = null
      })
      return forwarding
    },

    context: async (request) => {
      const prompt = request.prompt === undefined ? {} : { prompt: cleanText(request.prompt, 'prompt', deps.prepare()).value }
      const budget = Math.max(50, shownBudgetMs(request.host) - CONTEXT_MARGIN_MS)
      // The hub gets what is left after the trip there and back; past that, it records the answer late.
      const call = await ask('/central/context', { request: { ...request, ...prompt }, project: scoped(request.cwd), budgetMs: Math.max(20, budget - TAILNET_TRIP_MS) }, budget)
      if (call.ok && call.status === 200 && isRecord(call.body)) return call.body as unknown as ContextResult
      const failure: HubFailure = call.ok ? 'bad-answer' : call.reason
      return { ...EMPTY_CONTEXT, display: { unavailable: unavailableLine(failure, request, deps.hubName, call.ok ? null : call.gap ?? null) } }
    },

    read: async (tool, args, cwd) => {
      const cleaned = isRecord(args)
        ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' && (FREE_TEXT_ARGS as readonly string[]).includes(key) ? cleanText(value, `args.${key}`, deps.prepare()).value : value]))
        : args
      const call = await ask('/central/read', { tool, args: cleaned, projectKey: cwd === null ? null : scoped(cwd).key }, READ_TIMEOUT_MS)
      if (call.ok) return { status: call.status, body: call.body }
      return { status: 200, body: { outcome: unavailableOutcomeFor(call.reason, reasonOf(call)) } }
    },

    semantic: async (request) => {
      const query = cleanText(request.query, 'query', deps.prepare()).value
      const { giveUpMs: _local, ...rest } = request
      const call = await ask('/central/semantic', { ...rest, query }, request.deadlineMs)
      if (call.ok && call.status === 200) return call.body as SemanticAnswer
      return { status: 'unavailable', reason: call.ok ? `the hub answered ${call.status}` : `central memory unavailable: ${reasonOf(call)}` }
    },

    mcpRead: async (read) => {
      const call = await ask('/central/mcp-read', read, READ_TIMEOUT_MS)
      return call.ok ? { status: call.status, body: call.body } : { status: 503, body: { error: `central memory unavailable: ${reasonOf(call)}` } }
    },

    view: async (path) => {
      const timeoutMs = deps.viewTimeoutMs ?? VIEW_TIMEOUT_MS
      const first = await ask('/central/view', { path }, timeoutMs, true)
      // A page that came too late is asked for once more before the page says the hub is busy.
      const call = !first.ok && first.reason === 'timeout' ? await ask('/central/view', { path }, timeoutMs) : first
      if (call.ok) return { status: call.status, body: call.body }
      if (call.reason === 'timeout') return { status: 503, body: { error: `central memory busy: ${reasonOf(call)}`, central: { hub: deps.hubName, reachable: true, busy: true } } }
      const reachable = call.reason !== 'unreachable'
      return { status: 503, body: { error: `central memory ${reachable ? 'unavailable' : 'unreachable'}: ${reasonOf(call)}`, central: { hub: deps.hubName, reachable } } }
    },

    hello: () => ask('/central/hello', {}, READ_TIMEOUT_MS),

    state: () => ({ ...state, queued: countSpool(deps.spoolDir) }),
  }
}

/** The MCP answer while the hub cannot be asked: no memory, and the reason in the words the user reads. */
function unavailableOutcomeFor(failure: HubFailure, reason: string): ReturnType<typeof unavailableOutcome> {
  const outcome = unavailableOutcome(reason)
  const text = `central memory is ${failure === 'unreachable' || failure === 'timeout' ? 'unreachable' : 'unavailable'}: ${reason}`
  return { ...outcome, result: { ...outcome.result, content: [{ type: 'text', text }] } }
}

/** The event ids the hub would not take; anything unreadable counts as none. */
function rejectedIds(body: unknown): string[] {
  const rejected = isRecord(body) ? body.rejected : undefined
  return Array.isArray(rejected) ? rejected.filter((id): id is string => typeof id === 'string') : []
}
