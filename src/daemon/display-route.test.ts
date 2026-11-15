// The two switches the dashboard and `kinfold install` set: whether agents
// show what was recalled, and the opt-in impact test. The daemon stores them,
// and keeps display.json in step so a hook can read them without it.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISPLAY_FILE, readDisplayFile, writeDisplayFile } from '../context/display-file'
import { type TempStore, openTempStore } from '../observer/test-support'
import { readDisplaySettings, writeDisplaySettings } from '../store/display-settings'
import { type RunningDaemon, startDaemon } from './daemon'

let temp: TempStore
let daemon: RunningDaemon | null
beforeEach(() => {
  temp = openTempStore('kinfold-display-route-')
  daemon = null
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  temp.cleanup()
})

const start = (): RunningDaemon => (daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} }))
const token = (): string => readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
const call = (method: string, body?: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${daemon!.port}/data/display`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

test('the display file reads as "shown, no holdout" when it is missing or unreadable, and round-trips', () => {
  expect(readDisplayFile(temp.dataDir)).toEqual({ showRecall: true, holdout: false })
  writeDisplayFile(temp.dataDir, { showRecall: false, holdout: true })
  expect(readDisplayFile(temp.dataDir)).toEqual({ showRecall: false, holdout: true })
  writeDisplayFile(temp.dataDir, { showRecall: true })
  expect(readDisplayFile(temp.dataDir)).toEqual({ showRecall: true, holdout: false })
  expect(readDisplayFile(join(temp.dataDir, 'no-such-folder'))).toEqual({ showRecall: true, holdout: false })
})

test('the daemon writes display.json at start from the stored settings', () => {
  writeDisplaySettings(temp.store.db, { showRecall: false, holdout: true }, 1)
  expect(existsSync(join(temp.dataDir, DISPLAY_FILE))).toBe(false)
  start()
  expect(readDisplayFile(temp.dataDir)).toEqual({ showRecall: false, holdout: true })
})

test('GET /data/display reads the switches; PUT saves the ones named and rewrites the file', async () => {
  start()
  const read = (await (await call('GET')).json()) as Record<string, unknown>
  expect(read).toMatchObject({ showRecall: true, holdout: false, holdoutHosts: ['claude-code'] })
  expect(typeof read.since).toBe('number')

  const saved = await call('PUT', { holdout: true })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ showRecall: true, holdout: true, holdoutHosts: ['claude-code'] })
  expect(readDisplaySettings(temp.store.db)).toMatchObject({ showRecall: true, holdout: true })
  expect(readDisplayFile(temp.dataDir)).toEqual({ showRecall: true, holdout: true })

  expect((await call('PUT', { showRecall: false })).status).toBe(200)
  expect(readDisplayFile(temp.dataDir)).toEqual({ showRecall: false, holdout: true })
})

test('PUT /data/display refuses anything but booleans for the two keys', async () => {
  start()
  for (const body of [{}, { holdout: 'yes' }, { showRecall: 1 }, { since: 5 }, [true], 'on']) {
    const response = await call('PUT', body)
    expect(response.status).toBe(400)
  }
  expect((await call('POST', { holdout: true })).status).toBe(405)
  expect(readDisplaySettings(temp.store.db)).toMatchObject({ showRecall: true, holdout: false })
})

test('a request without the token is refused', async () => {
  start()
  const response = await fetch(`http://127.0.0.1:${daemon!.port}/data/display`)
  expect(response.status).toBe(401)
})
