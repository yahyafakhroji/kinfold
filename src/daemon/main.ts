// Daemon entry: `bun src/daemon/main.ts`. The umask goes first so the
// database, WAL, SHM and spool files are born owner-only, before any open.

import { deprecationLines, readEnv } from '../env-names'
import { type RunnerDeps, createCliRunner, runnerFactory } from '../observer/runners'
import { createSafetyGate } from '../observer/safety-gate'
import { OPENROUTER_CREDENTIAL_REF } from '../observer/settings'
import type { CredentialProvider } from '../secrets/credentials'
import { platformCredentialProvider } from '../secrets/keychain'
import { resolveDataDir } from '../store/data-dir'
import { type Embedder, createOpenRouterEmbedder } from '../vectors/embedder'
import { parsePort, startDaemon } from './daemon'
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

function fail(message: string): never {
  process.stderr.write(logLine(message))
  process.exit(1)
}

function main(): void {
  process.umask(OWNER_ONLY_UMASK)
  for (const line of deprecationLines(process.env)) process.stderr.write(logLine(line))
  let daemon: ReturnType<typeof startDaemon>
  try {
    const dataDir = resolveDataDir()
    const credentials = platformCredentialProvider()
    const runnerDeps: RunnerDeps = { dataDir, credentials }
    daemon = startDaemon({
      dataDir,
      port: parsePort(readEnv(process.env, 'PORT')),
      keychain: credentials,
      vectors: { embedder: embedderFrom(credentials) },
      observer: {
        runnerFor: runnerFactory(runnerDeps),
        safety: (db, log) => createSafetyGate({ db, cliRunnerFor: (settings) => createCliRunner(settings, runnerDeps), log }),
        credentials,
        schedule: {
          sessionIdleMs: parseIdleMs(readEnv(process.env, 'SESSION_IDLE_MS')),
          maxWaitMs: parseMaxWaitMs(readEnv(process.env, 'OBSERVER_MAX_WAIT_MS')),
        },
      },
    })
  } catch (error: unknown) {
    fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stderr.write(logLine(`${signal}, shutting down`))
    daemon.stop().then(
      () => process.exit(0),
      (error: unknown) => fail(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (import.meta.main) main()
