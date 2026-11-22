// Manual one-shot observer: `KINFOLD_DATA_DIR=<dir> bun src/observer/once.ts <session-id>`.
// Runs batches for one session until nothing is retryable or a batch fails,
// with the runner its host's settings name. The daemon is the only writer,
// so this refuses a data dir that a daemon has claimed, and it needs
// KINFOLD_DATA_DIR spelled out so it never touches the default store by accident.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { daemonSecrets } from '../daemon/main'
import { readEnv } from '../env-names'
import { processKeyStoreDeps } from '../secrets/key-store-record'
import { DAEMON_INFO_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { type BatchOutcome, processSessionBatch } from './process'
import { runnerFactory } from './runners'

export const MAX_ONCE_BATCHES = 20

export async function observeSessionOnce(dataDir: string, sessionId: number, log: (line: string) => void): Promise<BatchOutcome[]> {
  if (existsSync(join(dataDir, DAEMON_INFO_FILE))) throw new Error('a daemon owns this data dir; stop it or use a copy')
  const { credentials, dbKeys } = daemonSecrets(dataDir, processKeyStoreDeps(dataDir))
  const store = openStore(dataDir, { keys: dbKeys })
  try {
    const runnerFor = runnerFactory({ dataDir, credentials })
    const outcomes: BatchOutcome[] = []
    for (let batch = 0; batch < MAX_ONCE_BATCHES; batch += 1) {
      const outcome = await processSessionBatch({ db: store.db, runnerFor, log }, sessionId)
      outcomes.push(outcome)
      if (outcome.status !== 'succeeded') break
    }
    return outcomes
  } finally {
    store.db.close()
  }
}

/** The observer entry when `kinfold observe` runs it; `argv` is the session id. */
export async function runObserveOnce(argv: readonly string[]): Promise<void> {
  const log = (line: string): void => {
    process.stderr.write(`kinfold-observe: ${line}\n`)
  }
  const dataDir = readEnv(process.env, 'DATA_DIR')
  const sessionId = Number(argv[0])
  if (dataDir === undefined || dataDir === '' || !Number.isSafeInteger(sessionId)) {
    log('usage: kinfold observe <session-id> with KINFOLD_DATA_DIR or --data-dir set')
    process.exit(2)
  }
  try {
    const outcomes = await observeSessionOnce(dataDir, sessionId, log)
    log(`done batches=${outcomes.length} last=${outcomes.at(-1)?.status ?? 'none'}`)
  } catch (error: unknown) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (import.meta.main) await runObserveOnce(process.argv.slice(2))
