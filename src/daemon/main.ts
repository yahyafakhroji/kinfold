// Daemon entry: `bun src/daemon/main.ts`. The umask goes first so the
// database, WAL, SHM and spool files are born owner-only, before any open.

import { deprecationLines, readEnv } from '../env-names'
import { type RunnerDeps, createCliRunner, runnerFactory } from '../observer/runners'
import { createSafetyGate } from '../observer/safety-gate'
import { OPENROUTER_CREDENTIAL_REF } from '../observer/settings'
import type { CredentialProvider } from '../secrets/credentials'
import { type KeyStoreDeps, credentialProviderOf } from '../secrets/key-store'
import { processKeyStoreDeps, resolveKeyStore } from '../secrets/key-store-record'
import { type DbKeyStore, dbKeyStoreOf } from '../sqlite/keys'
import { resolveDataDir } from '../store/data-dir'
import { applyDataDirFlag } from '../store/data-dir-flag'
import { type Embedder, createOpenRouterEmbedder } from '../vectors/embedder'
import { VERSION } from '../version'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { parsePort, startDaemon } from './daemon'
import { SHUTDOWN_SIGNALS, parseDaemonArgs } from './daemon-args'
import { applyServicePath } from '../install/service/service-path'
import { currentPlatform } from '../platform/platform'
import { logLine } from './log-line'
import { parseIdleMs, parseMaxWaitMs } from './observer-scheduler'

const OWNER_ONLY_UMASK = 0o077

/**
 * The observer's OpenRouter key, read at start and again after a 401; a keychain
 * error means no embeddings, not a failed start. With no key at start there is
 * no embedder until the next restart.
 */
function embedderFrom(credentials: CredentialProvider): Embedder | null {
  try {
    const apiKey = credentials.get(OPENROUTER_CREDENTIAL_REF)
    return apiKey === null ? null : createOpenRouterEmbedder({ apiKey, rereadKey: () => credentials.get(OPENROUTER_CREDENTIAL_REF) })
  } catch {
    return null
  }
}

/**
 * Credentials and the database key, both from the one store key-store.json
 * names. Throws the record's fixed message when the record cannot be trusted,
 * so the daemon stops before it opens memory.db or makes any key.
 */
export function daemonSecrets(dataDir: string, deps: KeyStoreDeps): { credentials: CredentialProvider; dbKeys: DbKeyStore } {
  const store = resolveKeyStore(dataDir, deps)
  return { credentials: credentialProviderOf(store), dbKeys: dbKeyStoreOf(store) }
}

const LOG_FILE_MODE = 0o600

/** Writes a finished log line to stderr, and to the --log-file when one is open. */
type LogSink = (line: string) => void

const stderrSink: LogSink = (line) => {
  process.stderr.write(line)
}

const LOG_DIR_MODE = 0o700

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Opened once, append-only, owner-only; a write that fails never stops the
 * daemon. The folder is made when missing, since a service with no console
 * has nowhere else to say why it could not start. A symlink is refused, so
 * the mode change can never land on another file.
 */
export function fileSink(path: string): { sink: LogSink; close: () => void } {
  mkdirSync(dirname(path), { recursive: true, mode: LOG_DIR_MODE })
  if (isSymlink(path)) throw new Error(`kinfold daemon: --log-file ${path} is a symlink; refused`)
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), LOG_FILE_MODE)
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    throw new Error(`kinfold daemon: --log-file ${path} is not a regular file; refused`)
  }
  fchmodSync(fd, LOG_FILE_MODE)
  return {
    sink: (line) => {
      process.stderr.write(line)
      try {
        writeSync(fd, line)
      } catch {
        // stderr still has the line.
      }
    },
    close: () => closeSync(fd),
  }
}

function fail(sink: LogSink, message: string): never {
  sink(logLine(message))
  process.exit(1)
}

/** Resolves on the first of SHUTDOWN_SIGNALS once the daemon has stopped, and takes its listeners back off. */
function untilShutdown(daemon: ReturnType<typeof startDaemon>, sink: LogSink): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false
    const listeners = SHUTDOWN_SIGNALS.map((signal) => {
      const listener = (): void => shutdown(signal)
      process.on(signal, listener)
      return [signal, listener] as const
    })
    function shutdown(signal: NodeJS.Signals): void {
      if (stopping) return
      stopping = true
      sink(logLine(`${signal}, shutting down`))
      daemon.stop().then(
        () => {
          for (const [name, listener] of listeners) process.off(name, listener)
          resolve()
        },
        (error: unknown) => fail(sink, `shutdown failed: ${error instanceof Error ? error.message : String(error)}`),
      )
    }
  })
}

/** The daemon entry when `kinfold daemon` runs it; `argv` is what follows the subcommand (daemon-args.ts lists the flags). */
export async function runDaemon(argv: readonly string[]): Promise<void> {
  process.umask(OWNER_ONLY_UMASK)
  let sink = stderrSink
  let closeLog = (): void => {}
  let daemon: ReturnType<typeof startDaemon>
  try {
    const args = parseDaemonArgs(applyDataDirFlag(argv))
    if (args.logFile !== null) {
      const file = fileSink(args.logFile)
      sink = file.sink
      closeLog = file.close
    }
    for (const line of deprecationLines(process.env)) sink(logLine(line))
    const dataDir = resolveDataDir()
    // Before anything spawns an observer: the scheduled task gave this process the registry PATH only.
    applyServicePath(dataDir, process.env, currentPlatform().os)
    const { credentials, dbKeys } = daemonSecrets(dataDir, processKeyStoreDeps(dataDir))
    const runnerDeps: RunnerDeps = { dataDir, credentials }
    daemon = startDaemon({
      dataDir,
      port: args.port ?? parsePort(readEnv(process.env, 'PORT')),
      version: VERSION,
      log: (line) => sink(logLine(line)),
      keychain: credentials,
      dbKeys,
      vectors: { embedder: embedderFrom(credentials) },
      observer: {
        runnerFor: runnerFactory(runnerDeps),
        cliRunnerFor: (settings) => createCliRunner(settings, runnerDeps),
        safety: (db, log) => createSafetyGate({ db, cliRunnerFor: (settings) => createCliRunner(settings, runnerDeps), log }),
        credentials,
        schedule: {
          sessionIdleMs: parseIdleMs(readEnv(process.env, 'SESSION_IDLE_MS')),
          maxWaitMs: parseMaxWaitMs(readEnv(process.env, 'OBSERVER_MAX_WAIT_MS')),
        },
      },
    })
  } catch (error: unknown) {
    fail(sink, `failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }

  // The server stays up until a stop signal arrives. The caller exits after
  // this resolves, so a `kinfold daemon` process never tears down its own server.
  await untilShutdown(daemon, sink)
  closeLog()
}

if (import.meta.main) {
  await runDaemon(process.argv.slice(2))
  process.exit(0)
}
