import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDaemonEndpoint } from './daemon-info'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kinfold-daemon-info-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const TOKEN = 'a'.repeat(64)
function leave(info: unknown, token: string = TOKEN): void {
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify(info))
  writeFileSync(join(dataDir, 'daemon.token'), token)
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, '--version'])
  expect(child.exitCode).toBe(0)
  return child.pid
}

test('a live daemon is found by its port and token', () => {
  leave({ pid: process.pid, port: 4321 })
  expect(readDaemonEndpoint(dataDir)).toEqual({ port: 4321, token: TOKEN })
})

test('files a crashed daemon left behind name no daemon, so its token is sent to nobody who took the port', () => {
  leave({ pid: deadPid(), port: 4321 })
  expect(readDaemonEndpoint(dataDir)).toBeNull()
})

test('a daemon.json without a pid is read as before; missing or damaged files are no daemon', () => {
  leave({ port: 4321 })
  expect(readDaemonEndpoint(dataDir)).toEqual({ port: 4321, token: TOKEN })
  leave({ pid: process.pid, port: 4321 }, '')
  expect(readDaemonEndpoint(dataDir)).toBeNull()
  writeFileSync(join(dataDir, 'daemon.json'), '{half')
  expect(readDaemonEndpoint(dataDir)).toBeNull()
  rmSync(join(dataDir, 'daemon.json'))
  expect(readDaemonEndpoint(dataDir)).toBeNull()
})
