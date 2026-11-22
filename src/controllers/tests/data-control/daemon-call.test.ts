import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_INFO_FILE, TOKEN_FILE } from '../store/data-dir'
import { REQUEST_TIMEOUT_MS, daemonCall } from './cli'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kinfold-daemon-call-'))
  writeFileSync(join(dataDir, DAEMON_INFO_FILE), JSON.stringify({ pid: process.pid, port: 40_000 }))
  writeFileSync(join(dataDir, TOKEN_FILE), 'token')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const failing = (error: Error) => async (): Promise<Response> => {
  throw error
}

test('a request past the wait says it timed out and after how long, not the error class', async () => {
  const answer = await daemonCall({ dataDir, fetch: failing(new DOMException('The operation timed out.', 'TimeoutError')) }, 'GET', '/data/size')
  expect(answer).toEqual({ ok: false, error: `GET /data/size timed out after ${REQUEST_TIMEOUT_MS / 1000} s` })
})

test('a connection the daemon dropped says so', async () => {
  const answer = await daemonCall({ dataDir, fetch: failing(new TypeError('fetch failed')) }, 'GET', '/data/size')
  expect(answer).toEqual({ ok: false, error: 'GET /data/size failed: the daemon closed the connection before answering' })
})
