// OpenCode V2 plugin body (decision D8: 2.x only). Capture handlers read
// OpenCode's events, write the spool, and hand nothing back, so OpenCode's own
// events and results are never changed. The nudge is not awaited; the spool
// write finishes before a handler returns.
// The one exception is ctx.session.hook("context"): it appends one text part
// holding the project's context pack to event.system, and never alters or
// removes the parts already there. The pack is fetched once per session
// (daemon first, read-only fallback second, 300 ms for both) and cached until
// the session compacts; a failure or an empty pack appends nothing. At most
// once per 30 s per session it also asks for the prompt-time delta and keeps
// it with the pack (context-injector.ts, P1-H). A new prompt asks at once and
// carries its text, for prompt-time related memory (P2-B).
// Kept apart from opencode.ts because that file may export only { id, setup }.
// Under the observer (KINFOLD_OBSERVER=1) setup registers nothing, so an observer
// process can never feed events back into the store.

import type { NormalizedEvent } from '../contract/event'
import { type OpenCodeContext, OPENCODE_HOST, createOpenCodeBusMapper, normalizeOpenCodePrompt, normalizeOpenCodeToolAfter } from '../adapters/opencode'
import { defaultAdapterContext } from '../adapters/context'
import { recordedHostVersion } from '../adapters/host-version'
import { recordEvent } from '../cli/record'
import { fetchContext } from '../context/client'
import type { ContextRequest, ContextResult } from '../context/types'
import { isObserverProcess } from '../observer/env'
import { resolveDataDir } from '../store/data-dir'
import { createContextInjector } from './context-injector'

export const OPENCODE_PLUGIN_ID = 'kinfold'

type Handler = (event: unknown) => void
type AsyncHandler = (event: unknown) => void | Promise<void>

/** The slice of OpenCode's setup context this plugin touches; typed structurally so no OpenCode package is needed. */
export interface OpenCodeSetupContext {
  location: { directory: string }
  tool: { hook: (name: 'execute.after', handler: Handler) => unknown }
  session: { hook: (name: 'prompt' | 'context' | 'compaction', handler: AsyncHandler) => unknown }
  event: { subscribe: (listener: Handler) => unknown }
}

export interface OpenCodePlugin {
  id: string
  setup: (ctx: OpenCodeSetupContext) => void
}

export type ContextFetcher = (request: ContextRequest) => Promise<ContextResult | null>

export interface OpenCodePluginOptions {
  dataDir?: () => string
  log?: (line: string) => void
  env?: Readonly<Record<string, string | undefined>>
  /** Test seam; the default asks the daemon, then the read-only fallback. */
  fetchContext?: ContextFetcher
  /** Test seam; the default is the process-wide registry on globalThis. */
  sessionOwners?: Map<string, string>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

const MAX_OWNED_SESSIONS = 256
const OWNERS_KEY = Symbol.for('shared-agent-memory.opencode.session-owners')

/**
 * One registry per process, on globalThis: a session started under the old
 * plugin code was still captured once after an edit without a service restart,
 * so instances can load separate copies of this module, and a module-level
 * map would not be shared between them.
 */
function processSessionOwners(): Map<string, string> {
  const holder = globalThis as { [OWNERS_KEY]?: Map<string, string> }
  holder[OWNERS_KEY] ??= new Map()
  return holder[OWNERS_KEY]
}

/** Returns true when the instance `instanceId` must ignore the envelope. */
export type InstanceFilter = (envelope: unknown, instanceId: string) => boolean

function sessionIdOf(envelope: unknown): string | undefined {
  if (typeof envelope !== 'object' || envelope === null || !('data' in envelope)) return undefined
  const data = envelope.data
  return typeof data === 'object' && data !== null && 'sessionID' in data && typeof data.sessionID === 'string' ? data.sessionID : undefined
}

/**
 * OpenCode 2.1 runs setup once per workspace instance in one process (seen
 * live: six setups for three directories, two per directory), and the bus is
 * shared, so every instance sees every envelope. The first instance to see an
 * envelope for a session owns that session, and only the owner maps it.
 * Matching on the envelope's directory lost session.created for a directory
 * opened for the first time: its instance subscribes only after the event, so
 * every instance that saw it was another directory's. The mapper takes cwd from
 * the envelope, so the owner's own directory does not matter.
 */
export function createInstanceFilter(owners: Map<string, string> = new Map()): InstanceFilter {
  const own = (sessionId: string, instanceId: string): void => {
    if (owners.size >= MAX_OWNED_SESSIONS) {
      const oldest = owners.keys().next().value
      if (oldest !== undefined) owners.delete(oldest)
    }
    owners.set(sessionId, instanceId)
  }
  return (envelope, instanceId) => {
    const sessionId = sessionIdOf(envelope)
    if (sessionId === undefined) return false
    const owner = owners.get(sessionId)
    if (owner === undefined) {
      own(sessionId, instanceId)
      return false
    }
    return owner !== instanceId
  }
}

/**
 * OpenCode publishes session.created for a directory it opens for the first
 * time before that directory's instance subscribes (seen live after a service
 * restart: the only instance never saw it). So the first envelope of a session
 * this instance owns, of any type, is preceded by a synthetic session.created
 * at the same bus time and location. A real one arriving later is dropped by
 * the mapper's once-per-session start.
 */
export function createStartSynthesizer(): (envelope: unknown) => unknown | null {
  const seen = new Set<string>()
  return (envelope) => {
    const sessionId = sessionIdOf(envelope)
    if (sessionId === undefined || seen.has(sessionId)) return null
    if (seen.size >= MAX_OWNED_SESSIONS) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    seen.add(sessionId)
    const record = envelope as { type?: unknown; created?: unknown; location?: unknown }
    if (record.type === 'session.created') return null
    return { type: 'session.created', created: record.created, location: record.location, data: { sessionID: sessionId } }
  }
}

/** subscribe() may take a listener or hand back a stream; both reach the same handler. */
async function drainStream(stream: AsyncIterable<unknown>, handler: Handler): Promise<void> {
  for await (const envelope of stream) handler(envelope)
}

export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): OpenCodePlugin {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const ignoreForInstance = createInstanceFilter(options.sessionOwners ?? processSessionOwners())

  const setup = (ctx: OpenCodeSetupContext): void => {
    if (isObserverProcess(options.env ?? process.env)) return
    const dataDir = (options.dataDir ?? (() => resolveDataDir()))()
    // host_version: session.created's data.version per session, else the installer's record, read once per setup.
    const context: OpenCodeContext = {
      ...defaultAdapterContext(recordedHostVersion(dataDir, OPENCODE_HOST)),
      directory: ctx.location.directory,
      sessionVersions: new Map(),
    }

    const record = (event: NormalizedEvent | null): void => {
      if (event === null) return
      recordEvent(event, dataDir).then(
        ({ nudge }) => {
          if (!nudge.ok) log(`kinfold-opencode: event ${event.eventId} spooled, nudge skipped: ${nudge.reason}`)
        },
        (error: unknown) => log(`kinfold-opencode: event ${event.eventId} not captured: ${errorMessage(error)}`),
      )
    }
    const guarded = (map: (input: unknown) => NormalizedEvent | null): Handler => (input) => {
      try {
        record(map(input))
      } catch (error: unknown) {
        log(`kinfold-opencode: event skipped: ${errorMessage(error)}`)
      }
    }

    const fetcher: ContextFetcher = options.fetchContext
      ?? (async (request) => (await fetchContext(dataDir, request, { log: (line) => log(`kinfold-opencode: ${line}`) })).result)
    const injector = createContextInjector({ host: OPENCODE_HOST, cwd: ctx.location.directory, fetch: fetcher, log })

    ctx.tool.hook('execute.after', guarded((input) => normalizeOpenCodeToolAfter(input, context)))
    const capturePrompt = guarded((input) => normalizeOpenCodePrompt(input, context))
    // One handler per hook name: the prompt is captured, and kept for the next request's related memory.
    ctx.session.hook('prompt', (input) => {
      injector.onPrompt(input)
      capturePrompt(input)
    })
    ctx.session.hook('context', injector.onContext)
    ctx.session.hook('compaction', injector.onCompaction)
    const mapBus = createOpenCodeBusMapper(context)
    const instanceId = crypto.randomUUID()
    const startFor = createStartSynthesizer()
    const mapOne = guarded(mapBus)
    const onBus: Handler = (envelope) => {
      if (ignoreForInstance(envelope, instanceId)) return
      const start = startFor(envelope)
      if (start !== null) mapOne(start)
      mapOne(envelope)
    }
    const subscription = ctx.event.subscribe(onBus)
    if (isAsyncIterable(subscription)) {
      drainStream(subscription, onBus).catch((error: unknown) => log(`kinfold-opencode: event stream ended: ${errorMessage(error)}`))
    }
  }

  return { id: OPENCODE_PLUGIN_ID, setup }
}
