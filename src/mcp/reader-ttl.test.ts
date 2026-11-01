import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../store/db'
import { READER_TTL_MS, createMcpServer } from './server'
import { NOW, PROJECT_A, gitForProjectA, seedMcpObservation, seedMcpSession } from './test-support'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-mcp-ttl-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

/** A fresh database file holding one observation; the old file, if any, is unlinked first. */
function writeDatabase(title: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `memory.db${suffix}`), { force: true })
  const store = openStore(dataDir)
  try {
    const session = seedMcpSession(store, PROJECT_A, 'claude-code', `s-${title}`)
    seedMcpObservation(store, { sessionId: session, projectKey: PROJECT_A, title, at: NOW - 1_000 })
  } finally {
    store.db.close()
  }
}

test('the reader is reopened after READER_TTL_MS, so a long-lived server sees a database it did not open', async () => {
  writeDatabase('Original memory title')
  let clock = NOW
  const server = createMcpServer({ dataDir, cwd: '/work/repo', git: gitForProjectA, now: () => clock })
  const search = async (query: string): Promise<string> =>
    String(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query } } })))

  expect(await search('original')).toContain('Original memory title')
  // The open handle keeps reading the unlinked file until the reader is reopened.
  writeDatabase('Replacement memory title')
  clock += READER_TTL_MS - 1
  expect(await search('replacement')).not.toContain('Replacement memory title')
  clock += 1
  expect(await search('replacement')).toContain('Replacement memory title')
  server.close()
})
