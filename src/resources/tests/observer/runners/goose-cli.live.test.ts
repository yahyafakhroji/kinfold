// The real goose CLI. Runs only with KINFOLD_TEST_GOOSE_LIVE=1, in a throwaway
// HOME with goose on PATH and KINFOLD_TEST_GOOSE_MODEL naming a model goose
// can reach without a key there (such as ollama/qwen2.5:1.5b against a scratch
// Ollama). It runs the planted-instruction check through the production
// adapter and core, then checks that nothing new landed in HOME.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runPlantedCheck } from '../../../observer/planted-check'
import { type TempStore, openTempStore } from '../test-support'
import { createCliObserverRunner } from '../../../observer/runners/cli-core'
import { gooseAdapter } from '../../../observer/runners/goose-cli'

const LIVE = process.env.KINFOLD_TEST_GOOSE_LIVE === '1'
const MODEL = process.env.KINFOLD_TEST_GOOSE_MODEL ?? ''
const RUN_TIMEOUT_MS = 300_000

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
  } catch {
    return []
  }
}

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-goose-live-')
})
afterEach(() => temp.cleanup())

describe.skipIf(!LIVE)('goose-cli (live)', () => {
  test('passes the planted-instruction check, runs no tool and leaves nothing in HOME', async () => {
    expect(MODEL).not.toBe('')
    const home = process.env.HOME ?? ''
    const before = filesUnder(home)
    const runner = createCliObserverRunner(gooseAdapter, { dataDir: temp.dataDir, model: MODEL, timeoutMs: RUN_TIMEOUT_MS })
    expect((await runner.probe()).version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(await runPlantedCheck(runner)).toEqual({ ok: true })
    expect(filesUnder(home)).toEqual(before)
    expect(filesUnder(join(temp.dataDir, 'observer', 'runs'))).toEqual([])
  }, RUN_TIMEOUT_MS * 2)
})
