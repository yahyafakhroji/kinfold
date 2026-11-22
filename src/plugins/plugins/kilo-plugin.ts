// Kilo Code's plugin body. Kilo CLI 7.x runs OpenCode's 1.x plugin contract:
// the file's default export is { id, server }, and server() returns the hooks.
// (It rejects OpenCode 2.x's { id, setup }: "must default export an object
// with server()", seen live on 7.8.27.) The hooks here read Kilo's events,
// write the spool and hand nothing back, so Kilo's own values are never
// changed; the nudge is not awaited.
// The one exception is experimental.chat.system.transform: it appends the
// project's context pack, and what was written since, to the request's system
// prompt, after what Kilo put there. It is the same injector OpenCode uses
// (context-injector.ts): the pack comes from the daemon only, is cached per
// session, and a daemon that is down adds nothing. That the appended text
// reaches the model was checked live on 7.8.27.
// Kilo draws its screen in the process that runs this plugin, so a line on
// stderr lands in the middle of the user's terminal (seen live). Log lines go
// to <data folder>/logs/kilo-plugin.log instead; they carry session ids,
// counts and error names, never a prompt or a path.
// Kept apart from kilo.ts because that file may export only { id, server }.
// Under the observer (KINFOLD_OBSERVER=1) server() registers nothing, so an
// observer process can never feed events back into the store.

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { defaultAdapterContext } from '../adapters/context'
import { recordedHostVersion } from '../adapters/host-version'
import { KILO_HOST, createKiloMapper, promptText } from '../adapters/kilo-code'
import { DAEMON_ONLY_TIMEOUT_MS, fetchDaemonContext } from '../context/daemon'
import type { ContextRequest, ContextResult } from '../context/types'
import type { NormalizedEvent } from '../contract/event'
import { isObserverProcess } from '../observer/env'
import { resolveDataDir } from '../store/data-dir'
import { createContextInjector } from './context-injector'
import { createPluginRecorder } from './recorder'
import { errorName } from '../errors'
import { isRecord } from '../contract/event'

export const KILO_PLUGIN_ID = 'kinfold'
const LOG_LABEL = 'kinfold-kilo'
export const KILO_LOG_FILE = 'kilo-plugin.log'
/** Past this the file starts over: a few thousand lines is all anyone reads. */
export const MAX_LOG_BYTES = 512 * 1024
const LOG_DIR_MODE = 0o700
const LOG_FILE_MODE = 0o600

/** Appends to the plugin's log file. A line that cannot be written is dropped: logging must never fail a request. */
export function fileLog(dataDir: string): (line: string) => void {
  const dir = join(dataDir, 'logs')
  const path = join(dir, KILO_LOG_FILE)
  // The folder is made and the file measured once; after that the size is counted here, so a line costs one append
  // on the thread that draws Kilo. null until that first look, and again after a failed write.
  let size: number | null = null
  const measure = (): number => {
    mkdirSync(dir, { recursive: true, mode: LOG_DIR_MODE })
    try {
      return statSync(path).size
    } catch {
      return 0 // No file yet.
    }
  }
  return (line) => {
    try {
      const text = `${new Date().toISOString()} ${line}\n`
      const before = size ?? measure()
      if (before > MAX_LOG_BYTES) writeFileSync(path, text, { mode: LOG_FILE_MODE })
      else appendFileSync(path, text, { mode: LOG_FILE_MODE })
      size = (before > MAX_LOG_BYTES ? 0 : before) + Buffer.byteLength(text)
    } catch {
      // Nowhere to say it. The next line looks at the disk again.
      size = null
    }
  }
}

/** The hooks this plugin registers, typed structurally so no Kilo package is needed. */
export interface KiloHooks {
  event?: (input: { event: unknown }) => Promise<void>
  'chat.message'?: (input: unknown, output: unknown) => Promise<void>
  'tool.execute.after'?: (input: unknown, output: unknown) => Promise<void>
  'experimental.text.complete'?: (input: unknown, output: unknown) => Promise<void>
  'experimental.chat.system.transform'?: (input: unknown, output: unknown) => Promise<void>
  'experimental.session.compacting'?: (input: unknown, output: unknown) => Promise<void>
}

export interface KiloPlugin {
  id: string
  server: (input: unknown) => Promise<KiloHooks>
}

export type ContextFetcher = (request: ContextRequest) => Promise<ContextResult | null>

export interface KiloPluginOptions {
  dataDir?: () => string
  log?: (line: string) => void
  env?: Readonly<Record<string, string | undefined>>
  /** Test seam; the default asks the daemon only, with no read of the store. */
  fetchContext?: ContextFetcher
}

export function createKiloPlugin(options: KiloPluginOptions = {}): KiloPlugin {
  const server = async (input: unknown): Promise<KiloHooks> => {
    if (isObserverProcess(options.env ?? process.env)) return {}
    const dataDir = (options.dataDir ?? (() => resolveDataDir()))()
    const log = options.log ?? fileLog(dataDir)
    const directory = isRecord(input) && typeof input.directory === 'string' ? input.directory : ''
    if (!isAbsolute(directory)) {
      log(`${LOG_LABEL}: Kilo gave no absolute directory; nothing is captured`)
      return {}
    }
    const mapper = createKiloMapper({ ...defaultAdapterContext(recordedHostVersion(dataDir, KILO_HOST)), directory })

    const recorder = createPluginRecorder({ dataDir, onNudgeSkipped: (reason, events) => log(`${LOG_LABEL}: ${events} event(s) spooled, nudge skipped: ${reason}`) })
    const record = (events: readonly NormalizedEvent[]): void => {
      for (const event of events) {
        try {
          recorder.record(event)
        } catch (error: unknown) {
          log(`${LOG_LABEL}: event ${event.eventId} not captured: ${errorName(error)}`)
        }
      }
    }
    /** Whatever a hook does, Kilo sees it return: a throw here would fail the user's request. */
    const guarded = (name: string, run: () => void | Promise<void>): Promise<void> =>
      Promise.resolve().then(run).catch((error: unknown) => log(`${LOG_LABEL}: ${name} skipped: ${errorName(error)}`))

    const fetcher: ContextFetcher = options.fetchContext
      ?? ((request) => fetchDaemonContext(dataDir, request, { timeoutMs: DAEMON_ONLY_TIMEOUT_MS, log: (line) => log(`${LOG_LABEL}: ${line}`) }))
    const injector = createContextInjector({ host: KILO_HOST, cwd: directory, fetch: fetcher, log, label: LOG_LABEL })

    return {
      event: (hook) => guarded('event', () => record(mapper.event(isRecord(hook) ? hook.event : null))),
      'chat.message': (hookInput, output) => guarded('chat.message', () => {
        // The prompt's text is kept for the next request's related memory, as OpenCode's prompt hook keeps it.
        if (isRecord(hookInput) && typeof hookInput.sessionID === 'string') injector.onPrompt({ sessionID: hookInput.sessionID, prompt: { text: promptText(isRecord(output) ? output.parts : undefined) } })
        record(mapper.chatMessage(hookInput, output))
      }),
      'tool.execute.after': (hookInput, output) => guarded('tool.execute.after', () => record(mapper.toolAfter(hookInput, output))),
      'experimental.text.complete': (hookInput, output) => guarded('experimental.text.complete', () => mapper.textComplete(hookInput, output)),
      'experimental.chat.system.transform': (hookInput, output) => guarded('experimental.chat.system.transform', async () => {
        // Kilo's helper requests carry no session, or an id of their own (a title runs under `title-<id>`, seen live):
        // they get no memory, and no pack is recorded as sent to a session that is not one.
        if (!isRecord(hookInput) || typeof hookInput.sessionID !== 'string' || !mapper.knows(hookInput.sessionID)) return
        if (!isRecord(output) || !Array.isArray(output.system)) return
        const system = output.system as unknown[]
        // The injector works on OpenCode's text parts; Kilo's list holds plain strings.
        const parts = system.map((text) => ({ type: 'text', text }))
        const before = parts.length
        await injector.onContext({ sessionID: hookInput.sessionID, system: parts })
        for (const part of parts.slice(before)) system.push(part.text)
      }),
      'experimental.session.compacting': (hookInput) => guarded('experimental.session.compacting', () => injector.onCompaction(hookInput)),
    }
  }

  return { id: KILO_PLUGIN_ID, server }
}
