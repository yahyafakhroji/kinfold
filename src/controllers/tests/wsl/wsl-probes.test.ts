import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseNetworkingMode, parseTasklist, runProbe } from './wsl-probes'

const BUN = process.execPath
// The test's own env, so the Bun binary starts on every OS; the probes themselves pass a minimal one.
const ENV = { ...process.env }

test('parseNetworkingMode takes one lowercase word', () => {
  expect(parseNetworkingMode('nat\n')).toBe('nat')
  expect(parseNetworkingMode('Mirrored\r\n')).toBe('mirrored')
  expect(parseNetworkingMode('')).toBeNull()
  expect(parseNetworkingMode('not a mode')).toBeNull()
  expect(parseNetworkingMode(null)).toBeNull()
})

test('parseTasklist finds the pid in the second CSV field only', () => {
  expect(parseTasklist('"bun.exe","4242","Console","1","52,120 K"\r\n', 4242)).toBe(true)
  expect(parseTasklist('"bun.exe","14242","Console","1","52,120 K"\r\n', 4242)).toBe(false)
  expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n', 4242)).toBe(false)
  expect(parseTasklist('INFORMATION : aucune tâche en service ne correspond aux critères spécifiés.\r\n', 4242)).toBe(false)
  expect(parseTasklist(null, 4242)).toBeNull()
})

test('runProbe returns stdout of a command that exits 0, and null otherwise', async () => {
  expect(await runProbe([BUN, '-e', 'process.stdout.write("mirrored")'], 10_000, ENV)).toBe('mirrored')
  expect(await runProbe([BUN, '-e', 'process.exit(3)'], 10_000, ENV)).toBeNull()
  expect(await runProbe([join(import.meta.dir, 'no-such-probe')], 10_000, ENV)).toBeNull()
})

test('runProbe gives up at its timeout', async () => {
  const started = performance.now()
  expect(await runProbe([BUN, '-e', 'setTimeout(() => {}, 30_000)'], 300, ENV)).toBeNull()
  expect(performance.now() - started).toBeLessThan(5_000)
})
