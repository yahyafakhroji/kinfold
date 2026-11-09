import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ERROR_CODES, MAX_LINE_CHARS, PROTOCOL_VERSIONS, handleLine } from './protocol'
import { type ToolOutcome, callTool as localCallTool } from './tools'
import { openMemoryReader } from './reader'
import { mcpToolCallerFor } from '../wsl/mcp-backend'
import { type McpServer, createMcpServer, runStdio } from './server'
import { type McpFixture, NOW, PAYLOAD_MARKER, PROJECT_A, gitForProjectA, openMcpFixture } from './test-support'

let fixture: McpFixture
let server: McpServer
let logs: string[]
beforeEach(() => {
  fixture = openMcpFixture()
  logs = []
  server = createMcpServer({ dataDir: fixture.dataDir, cwd: '/work/repo', git: gitForProjectA, log: (line) => logs.push(line), now: () => NOW })
})
afterEach(() => {
  server.close()
  fixture.cleanup()
})

async function send(message: unknown): Promise<Record<string, unknown>> {
  const reply = await server.handleLine(JSON.stringify(message))
  if (reply === null) throw new Error('expected a reply')
  return JSON.parse(reply) as Record<string, unknown>
}

const callTool = (id: number, name: string, args: unknown) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

test('the server resolves its project once from the cwd', async () => {
  expect(server.projectKey).toBe(PROJECT_A)
})

test('initialize echoes a supported protocol version and offers tools', async () => {
  const reply = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  expect(reply).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kinfold' } } })
  const unknown = await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  expect((unknown.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSIONS[0])
})

test('tools/list names the three tools with schemas that tell the agent to search first', async () => {
  const tools = ((await send({ jsonrpc: '2.0', id: 'a', method: 'tools/list' })).result as { tools: { name: string; description: string; inputSchema: { type: string } }[] }).tools
  expect(tools.map((tool) => tool.name)).toEqual(['search', 'timeline', 'get_observations'])
  expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true)
  expect(tools[0]!.description).toContain('Search first, then call get_observations')
})

test('tools/call returns text plus structured content and logs no query text', async () => {
  const reply = await callTool(3, 'search', { query: 'parser secretword' })
  const result = reply.result as { content: { type: string; text: string }[]; structuredContent: { status: string } }
  expect(result.content[0]!.type).toBe('text')
  expect(result.structuredContent.status).toBe('ok')
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatch(/^tool=search status=ok rows=\d+ ms=\d+\.\d$/)
  expect(logs.join('\n')).not.toContain('parser')
  expect(logs.join('\n')).not.toContain('secretword')
})

test('a usage error is a tool result with isError, not a JSON-RPC error', async () => {
  const reply = await callTool(4, 'search', { query: '' })
  expect(reply.error).toBeUndefined()
  expect((reply.result as { isError: boolean }).isError).toBe(true)
})

test('unknown methods, unknown tools and bad params get JSON-RPC errors', async () => {
  expect((await send({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error).toEqual({ code: ERROR_CODES.methodNotFound, message: 'method not found' })
  expect(((await callTool(6, 'drop_everything', {})).error as { code: number }).code).toBe(ERROR_CODES.invalidParams)
  expect(((await send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} })).error as { code: number }).code).toBe(ERROR_CODES.invalidParams)
  expect(await send({ jsonrpc: '2.0', id: 8, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 8, result: {} })
})

test('malformed lines get parse or invalid-request errors; notifications and replies get nothing', async () => {
  const parsed = async (line: string) => JSON.parse((await server.handleLine(line))!) as { id: unknown; error: { code: number } }
  expect(await parsed('{not json')).toEqual({ jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.parse, message: 'parse error' } } as never)
  expect((await parsed('[1,2]')).error.code).toBe(ERROR_CODES.invalidRequest)
  expect(await parsed('{"jsonrpc":"1.0","id":9,"method":"ping"}')).toMatchObject({ id: 9, error: { code: ERROR_CODES.invalidRequest } })
  expect((await parsed('{"jsonrpc":"2.0","id":{},"method":"ping"}')).error.code).toBe(ERROR_CODES.invalidRequest)
  expect((await parsed('x'.repeat(MAX_LINE_CHARS + 1))).error.code).toBe(ERROR_CODES.parse)
  expect(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull()
  expect(await server.handleLine('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search","arguments":{"query":"x"}}}')).toBeNull()
  expect(await server.handleLine('{"jsonrpc":"2.0","id":10,"result":{}}')).toBeNull()
  expect(await server.handleLine('   ')).toBeNull()
})

test('a tool that throws answers with isError and logs only the error class', async () => {
  await callTool(11, 'search', { query: 'parser' }) // opens the reader before the table goes away
  fixture.store.db.run('DROP TABLE summaries')
  const reply = await callTool(12, 'timeline', { anchorId: fixture.ids.parser })
  expect((reply.result as { isError: boolean; structuredContent: { status: string } }).structuredContent.status).toBe('internal_error')
  expect((reply.result as { isError: boolean }).isError).toBe(true)
  expect(logs.slice(-2)[0]).toMatch(/^tool=timeline status=internal_error class=\w+$/)
  expect(logs.at(-1)).toMatch(/^tool=timeline status=internal_error rows=0 ms=/)
})

test('runStdio splits lines across chunks and skips an oversize line', async () => {
  const chunks = [
    '{"jsonrpc":"2.0","id":1,"meth', 'od":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    'y'.repeat(MAX_LINE_CHARS + 10), 'tail of the long line\n', '{"jsonrpc":"2.0","id":2,"method":"ping"}',
  ]
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  const out: string[] = []
  await runStdio(server, input, (line) => out.push(line))
  const replies = out.join('').trim().split('\n').map((line) => JSON.parse(line) as { id: number | null; error?: { code: number } })
  expect(replies.map((reply) => reply.id)).toEqual([1, null, 2])
  expect(replies[1]!.error!.code).toBe(ERROR_CODES.parse)
  expect(out.join('')).not.toContain(PAYLOAD_MARKER)
})

test('an MCP tool call goes through the injected caller', async () => {
  const fixed: ToolOutcome = { result: { content: [{ type: 'text', text: 'from elsewhere' }], structuredContent: { status: 'ok' } }, count: 0 }
  const calls: [string, unknown][] = []
  const reader = openMemoryReader(fixture.dataDir)
  const tools = { reader: () => reader, projectKey: PROJECT_A, now: () => NOW }
  const base = { tools, log: () => {}, clock: () => 0 }
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'parser' } } })
  try {
    const injected = JSON.parse((await handleLine(line, { ...base, call: async (name, args) => (calls.push([name, args]), fixed) }))!)
    expect(injected.result).toEqual(fixed.result)
    expect(calls).toEqual([['search', { query: 'parser' }]])
    const local = JSON.parse((await handleLine(line, base))!)
    expect(local.result).toEqual((await localCallTool('search', { query: 'parser' }, tools))!.result)
  } finally {
    reader?.close()
  }
  expect(mcpToolCallerFor({ dataDir: fixture.dataDir, cwd: '/work/repo', platform: { os: 'macos', wsl: false, node: 'darwin' } })).toBeNull()
})
