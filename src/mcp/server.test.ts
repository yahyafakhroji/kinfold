import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { openStore } from '../store/db'
import { PAYLOAD_MARKER, T0, seedMcpObservation, seedMcpSession, seedPayloadEvent } from './test-support'

const SERVER = join(import.meta.dir, 'server.ts')

let root: string
let cwd: string
let dataDir: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sam-mcp-e2e-')))
  cwd = join(root, 'project')
  dataDir = join(root, 'data')
  mkdirSync(cwd)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A store keyed by the temp cwd's path (not a git checkout), closed like a stopped daemon. */
function seedAndClose(): number {
  const store = openStore(dataDir)
  try {
    const session = seedMcpSession(store, cwd, 'claude-code', 'e2e')
    seedPayloadEvent(store, session)
    return seedMcpObservation(store, { sessionId: session, projectKey: cwd, title: 'Stdio server answers search', at: T0 })
  } finally {
    store.db.close()
  }
}

function hashes(): Record<string, string> {
  return Object.fromEntries(['memory.db', 'memory.db-wal'].filter((name) => existsSync(join(dataDir, name)))
    .map((name) => [name, createHash('sha256').update(readFileSync(join(dataDir, name))).digest('hex')]))
}

interface Run {
  replies: Record<string, unknown>[]
  stdout: string
  stderr: string
  exitCode: number
}

async function runServer(messages: readonly unknown[]): Promise<Run> {
  const child = Bun.spawn(['bun', SERVER], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: root, KINFOLD_DATA_DIR: dataDir, [SQLITE3MC_LIB_ENV]: process.env[SQLITE3MC_LIB_ENV] ?? '', KINFOLD_DB_KEYSTORE: 'none' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  child.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
  await child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const replies = stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
  return { replies, stdout, stderr, exitCode }
}

const handshake = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
]

test('end to end over real stdio: initialize, list, search, fetch; read-only and payload-free', async () => {
  const id = seedAndClose()
  const before = hashes()
  const run = await runServer([
    ...handshake,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'stdio search' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_observations', arguments: { ids: [id, 777] } } },
    { jsonrpc: '2.0', id: 5, method: 'nope' },
  ])
  expect(run.exitCode).toBe(0)
  expect(run.replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4, 5])
  expect((run.replies[1]!.result as { tools: unknown[] }).tools).toHaveLength(3)
  const search = run.replies[2]!.result as { content: { text: string }[]; structuredContent: { results: { id: number }[] } }
  expect(search.structuredContent.results.map((row) => row.id)).toEqual([id])
  expect(search.content[0]!.text).toContain(`#${id} · claude-code · discovery · tool-verified`)
  const fetched = run.replies[3]!.result as { structuredContent: { missing: number[] } }
  expect(fetched.structuredContent.missing).toEqual([777])
  expect((run.replies[4]!.error as { code: number }).code).toBe(-32601)
  expect(run.stdout).not.toContain(PAYLOAD_MARKER)
  expect(run.stderr).not.toContain('stdio search')
  expect(run.stderr).toContain('kinfold-mcp: tool=search status=ok rows=1')
  expect(hashes()).toEqual(before)
})

test('end to end with no database: every tool says "no memory yet" and nothing is created', async () => {
  const run = await runServer([
    ...handshake,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'anything' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'timeline', arguments: { anchorId: 1 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_observations', arguments: { ids: [1] } } },
  ])
  expect(run.exitCode).toBe(0)
  for (const reply of run.replies.slice(2)) {
    expect((reply.result as { structuredContent: { status: string } }).structuredContent.status).toBe('no_memory')
  }
  expect(existsSync(dataDir)).toBe(false)
})
