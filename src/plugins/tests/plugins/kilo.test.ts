import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextRequest, ContextResult } from '../../../resources/context/types'
import * as entry from '../../plugins/kilo'
import { type KiloHooks, KILO_LOG_FILE, MAX_LOG_BYTES, createKiloPlugin, fileLog } from '../../plugins/kilo-plugin'

const FIXTURES = join(import.meta.dir, '../../../../test/fixtures/kilo-code')
const fixture = <T = Record<string, any>>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T

const SESSION = 'ses_e1e6d0192ffe7pZ5J19xRJk76C'
let root: string
let logs: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-kilo-'))
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function spooledEvents(): Record<string, any>[] {
  const dir = join(root, 'spool')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, any>)
}

interface Loaded {
  hooks: KiloHooks
  asked: ContextRequest[]
}

/** The plugin as Kilo starts it: server() with Kilo's recorded input, the daemon's answers faked. */
async function load(answers: Partial<Record<ContextRequest['channel'], ContextResult | null>> = {}, env: Record<string, string> = {}): Promise<Loaded> {
  const asked: ContextRequest[] = []
  const plugin = createKiloPlugin({
    dataDir: () => root,
    log: (line) => logs.push(line),
    env,
    fetchContext: async (request) => {
      asked.push(request)
      return answers[request.channel] ?? null
    },
  })
  const hooks = await plugin.server(fixture('server.input'))
  return { hooks, asked }
}

const PACK: ContextResult = { text: '<kinfold>\n[claude-code · 2h] CI pins Bun (#7)\n</kinfold>', observationIds: [7], tokens: 12 }

test('the entry file exports only a default { id, server }, the shape Kilo loads', () => {
  expect(Object.keys(entry)).toEqual(['default'])
  expect(Object.keys(entry.default).sort()).toEqual(['id', 'server'])
  expect(entry.default.id).toBe('kinfold')
  expect(typeof entry.default.server).toBe('function')
})

test('a session, its prompt, a tool result and the turn end reach the spool as Kilo Code events, and Kilo\'s own objects are not changed', async () => {
  const { hooks } = await load()
  const chat = fixture('chat.message')
  const tool = fixture('tool.execute.after.read')
  const text = fixture('experimental.text.complete')
  const calls: [() => Promise<void>, unknown[]][] = [
    [() => hooks.event!({ event: fixture('event.session.created') }), []],
    [() => hooks['chat.message']!(chat.input, chat.output), [chat.input, chat.output]],
    [() => hooks['tool.execute.after']!(tool.input, tool.output), [tool.input, tool.output]],
    [() => hooks['experimental.text.complete']!(text.input, text.output), [text.input, text.output]],
    [() => hooks.event!({ event: fixture('event.session.status') }), []],
    [() => hooks.event!({ event: fixture('event.session.idle') }), []],
  ]
  for (const [call, values] of calls) {
    const before = structuredClone(values)
    expect(await call()).toBeUndefined()
    expect(values).toEqual(before)
  }
  await flush()

  const events = spooledEvents()
  expect(events.map((event) => event.kind).sort()).toEqual(['session_start', 'tool_result', 'turn_end', 'user_prompt'])
  for (const event of events) expect(event).toMatchObject({ host: 'kilo-code', hostSessionId: SESSION, cwd: '/Users/me/project', hostVersion: '7.8.27' })
  expect(events.find((event) => event.kind === 'user_prompt')).toMatchObject({ promptText: 'how do we pin bun in CI?', hostPromptId: 'msg_1e192fe7d001mVkFE9r3rMzZZ1' })
  expect(events.find((event) => event.kind === 'tool_result')?.tool).toMatchObject({ name: 'read' })
  expect(events.find((event) => event.kind === 'turn_end')).toMatchObject({ assistantText: 'Fake model reply: pinned with .bun-version.' })
  expect(logs.every((line) => line.includes('nudge skipped'))).toBe(true)
})

test('the pack is added to the system prompt once per session, after what Kilo put there, and recorded as this session\'s', async () => {
  const { hooks, asked } = await load({ request: PACK })
  await hooks.event!({ event: fixture('event.session.created') })
  const system = ['You are Kilo.', 'Project rules.']
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system })
  expect(system).toEqual(['You are Kilo.', 'Project rules.', PACK.text])
  expect(asked).toEqual([{ host: 'kilo-code', cwd: '/Users/me/project', hostSessionId: SESSION, channel: 'request' }])
  // Kilo hands a fresh list on each request; the cached pack is added again, and the daemon is not asked twice.
  const next = ['You are Kilo.']
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: next })
  expect(next).toEqual(['You are Kilo.', PACK.text])
  // A list that already holds the text is left as it is.
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: next })
  expect(next).toEqual(['You are Kilo.', PACK.text])
  expect(asked.filter((request) => request.channel === 'request')).toHaveLength(1)
})

test('a prompt asks for its related memory with the next request, and that reaches the system prompt too', async () => {
  const related = '<kinfold>\n[codex · 1d] Related to the prompt (#9)\n</kinfold>'
  const { hooks, asked } = await load({ request: PACK, prompt: { text: related, observationIds: [9], tokens: 8, relatedText: related } })
  const chat = fixture('chat.message')
  await hooks['chat.message']!(chat.input, chat.output)
  const system: string[] = ['You are Kilo.']
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system })
  expect(system).toEqual(['You are Kilo.', PACK.text, related])
  expect(asked.find((request) => request.channel === 'prompt')).toMatchObject({ host: 'kilo-code', hostSessionId: SESSION, prompt: 'how do we pin bun in CI?' })
})

test('a request with no session, a daemon that is down and a broken system list each leave the request alone', async () => {
  const { hooks, asked } = await load({})
  const untouched = ['Write a title.']
  // Kilo's own helper requests (a title, a summary) carry no session id.
  await hooks['experimental.chat.system.transform']!({ model: {} }, { system: untouched })
  expect(untouched).toEqual(['Write a title.'])
  expect(asked).toEqual([])
  await hooks.event!({ event: fixture('event.session.created') })
  const down = ['You are Kilo.']
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: down })
  expect(down).toEqual(['You are Kilo.'])
  expect(asked.map((request) => request.channel)).toEqual(['request'])
  await expect(hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: 'not a list' } as never)).resolves.toBeUndefined()
  await expect(hooks['experimental.chat.system.transform']!(null as never, null as never)).resolves.toBeUndefined()
})

test('compaction drops the session\'s pack, so the next request asks again', async () => {
  const { hooks, asked } = await load({ request: PACK })
  await hooks.event!({ event: fixture('event.session.created') })
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: [] })
  const output = { context: ['keep this'] }
  await hooks['experimental.session.compacting']!({ sessionID: SESSION }, output)
  expect(output).toEqual({ context: ['keep this'] })
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: [] })
  expect(asked.filter((request) => request.channel === 'request')).toHaveLength(2)
})

test('a hook that throws inside never reaches Kilo: the event is skipped and said in the log', async () => {
  const plugin = createKiloPlugin({ dataDir: () => join(root, 'missing', '\u0000bad'), log: (line) => logs.push(line), env: {}, fetchContext: async () => { throw new Error('boom') } })
  const hooks = await plugin.server(fixture('server.input'))
  const chat = fixture('chat.message')
  await expect(hooks['chat.message']!(chat.input, chat.output)).resolves.toBeUndefined()
  await expect(hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: [] })).resolves.toBeUndefined()
  await expect(hooks.event!({ event: null } as never)).resolves.toBeUndefined()
  await flush()
  expect(logs.length).toBeGreaterThan(0)
  for (const line of logs) expect(line).not.toContain('how do we pin bun')
})

test('under the observer the plugin registers no hook, so an observer run never feeds the store', async () => {
  const { hooks } = await load({ request: PACK }, { KINFOLD_OBSERVER: '1' })
  expect(hooks).toEqual({})
})

test('server input without a usable directory registers nothing rather than recording a wrong place', async () => {
  const plugin = createKiloPlugin({ dataDir: () => root, log: (line) => logs.push(line), env: {} })
  expect(await plugin.server({ directory: 'relative/path' })).toEqual({})
  expect(await plugin.server(null as never)).toEqual({})
  expect(logs.some((line) => line.includes('directory'))).toBe(true)
})

test("Kilo's helper requests, which run under a session id of their own, get no memory and start no session", async () => {
  const { hooks, asked } = await load({ request: PACK })
  const chat = fixture('chat.message')
  await hooks['chat.message']!(chat.input, chat.output)
  // Seen live on 7.8.27: the title for a session is asked for under `title-<session id>`.
  const title = ['Write a title.']
  await hooks['experimental.chat.system.transform']!({ sessionID: `title-${SESSION}`, model: {} }, { system: title })
  expect(title).toEqual(['Write a title.'])
  expect(asked.some((request) => request.hostSessionId.startsWith('title-'))).toBe(false)
  const real: string[] = []
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: real })
  expect(real).toEqual([PACK.text])
})

test('with no log given, lines go to a file in the data folder and never to stderr, which Kilo draws its screen on', async () => {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const plugin = createKiloPlugin({ dataDir: () => root, env: {}, fetchContext: async () => PACK })
    const hooks = await plugin.server(fixture('server.input'))
    const chat = fixture('chat.message')
    await hooks['chat.message']!(chat.input, chat.output)
    await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: [] })
    await flush()
  } finally {
    process.stderr.write = original
  }
  expect(written.join('')).not.toContain('kinfold')
  const path = join(root, 'logs', KILO_LOG_FILE)
  const text = readFileSync(path, 'utf8')
  expect(text).toContain(`kinfold-kilo: context session=${SESSION} ids=1`)
  expect(text).not.toContain('how do we pin bun')
  for (const line of text.trimEnd().split('\n')) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z kinfold-kilo: /)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('the log file starts over when it has grown past its cap, so it never fills the disk', async () => {
  const path = join(root, 'logs', KILO_LOG_FILE)
  const plugin = createKiloPlugin({ dataDir: () => root, env: {}, fetchContext: async () => PACK })
  const hooks = await plugin.server(fixture('server.input'))
  // Left by an earlier Kilo run: the file is measured when this run writes its first line.
  mkdirSync(join(root, 'logs'), { recursive: true })
  writeFileSync(path, 'x'.repeat(MAX_LOG_BYTES + 1))
  const chat = fixture('chat.message')
  await hooks['chat.message']!(chat.input, chat.output)
  await hooks['experimental.chat.system.transform']!({ sessionID: SESSION, model: {} }, { system: [] })
  await hooks['experimental.session.compacting']!({ sessionID: SESSION }, { context: [] })
  expect(statSync(path).size).toBeLessThan(1024)
  expect(readFileSync(path, 'utf8')).toContain('compaction')
})

test('the log file also starts over when this run itself grows it past the cap, counting its own lines', () => {
  const path = join(root, 'logs', KILO_LOG_FILE)
  const log = fileLog(root)
  const line = 'y'.repeat(64 * 1024)
  for (let written = 0; written < MAX_LOG_BYTES; written += line.length) log(line)
  expect(statSync(path).size).toBeGreaterThan(MAX_LOG_BYTES)
  log('after the cap')
  expect(statSync(path).size).toBeLessThan(1024)
  expect(readFileSync(path, 'utf8')).toContain('after the cap')
})

test('a log folder removed while Kilo runs is made again for the line after the one that was lost', () => {
  const log = fileLog(root)
  log('first')
  rmSync(join(root, 'logs'), { recursive: true, force: true })
  log('lost')
  log('second')
  expect(readFileSync(join(root, 'logs', KILO_LOG_FILE), 'utf8')).toContain('second')
})
