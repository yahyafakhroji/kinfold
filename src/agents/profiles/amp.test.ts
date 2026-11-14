import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { ampPluginContent } from '../families/amp-plugin'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { pluginFileActions, pluginFileUninstallActions, templatePluginFileActions } from '../families/plugin-file'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { capabilityLine } from '../profile'
import { AMP_MCP_FILE, AMP_PLUGIN_SPEC, ampPluginDir } from './amp'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, cwd: root })
const message = JSON.stringify({ message: { content: '<kinfold>pack</kinfold>', display: false } })

test('amp: the hook answers session.start and agent.start with a message, and prints nothing otherwise', async () => {
  for (const file of ['docs-constructed-tool-result.json', 'docs-constructed-tool-result-error.json', 'docs-constructed-agent-end.json']) {
    expect(await bench.hook('amp', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(await bench.hook('amp', 'docs-constructed-session-start.json', moved)).toBe(message)
  expect(await bench.hook('amp', 'docs-constructed-agent-start.json', moved)).toBe(message)
  expect(bench.asked.map((request) => request.channel)).toEqual(['session_start', 'prompt'])
})

test('amp: a minimal payload is not captured and the hook stays silent', async () => {
  expect(await bench.hook('amp', 'docs-constructed-agent-start.json', () => ({ event: 'agent.start', message: 'x' }))).toBeNull()
  expect(bench.asked).toEqual([])
})

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown

/** A stub `amp` that keeps each handler the plugin registers. */
function stubAmp(): { amp: Record<string, unknown>; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const amp = { on: (name: string, handler: Handler) => (handlers.set(name, handler), { unsubscribe: () => {} }), helpers: { filePathFromURI: (uri: { toString(): string }) => new URL(uri.toString()).pathname } }
  return { amp, handlers }
}

/** A hook stand-in: records each payload, and answers both context events with the message the real hook prints. */
function stubHook(root: string): string[] {
  const script = join(root, 'stub-hook.ts')
  const log = join(root, 'payloads.jsonl')
  writeFileSync(script, [
    `const input = await Bun.stdin.text();`,
    `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, input + '\\n');`,
    `const payload = JSON.parse(input);`,
    `if (payload.event === 'session.start') console.log(JSON.stringify({ message: { content: 'pack', display: false } }));`,
    `if (payload.event === 'agent.start') console.log(JSON.stringify({ message: { content: 'delta for ' + payload.message, display: false } }));`,
  ].join('\n'))
  return [process.execPath, script]
}

test('the Amp plugin returns the delta from agent.start, against a stub amp object', async () => {
  const [command, script] = stubHook(bench.root)
  const file = join(bench.root, 'kinfold.ts')
  writeFileSync(file, ampPluginContent({ command: command ?? '', args: [script ?? ''] }))
  const plugin = (await import(file)) as { default: (amp: unknown) => void }
  const { amp, handlers } = stubAmp()
  plugin.default(amp)
  expect([...handlers.keys()].sort()).toEqual(['agent.end', 'agent.start', 'session.start', 'tool.result'])
  const ctx = { system: { workspaceRoot: pathToFileURL(bench.root) } }
  const thread = { id: 'T-1' }

  await handlers.get('session.start')?.({ thread }, ctx)
  // The pack from session start rides on the first prompt, since session.start has no return channel.
  expect(await handlers.get('agent.start')?.({ thread, message: 'fix it', id: 1 }, ctx)).toEqual({ message: { content: 'pack\n\ndelta for fix it', display: false } })
  expect(await handlers.get('agent.start')?.({ thread, message: 'again', id: 2 }, ctx)).toEqual({ message: { content: 'delta for again', display: false } })
  expect(await handlers.get('tool.result')?.({ thread, toolUseID: 't', tool: 'Read', input: {}, status: 'done', output: 'x' }, ctx)).toBeUndefined()
  expect(await handlers.get('agent.end')?.({ thread, message: 'again', id: 2, status: 'done', messages: [{ big: true }] }, ctx)).toBeUndefined()
  const log = join(bench.root, 'payloads.jsonl')
  const lines = (): string[] => readFileSync(log, 'utf8').trim().split('\n')
  for (let waited = 0; lines().length < 5 && waited < 5000; waited += 20) await Bun.sleep(20)

  const payloads = lines().map((line) => JSON.parse(line))
  // tool.result and agent.end don't wait for the hook, so their order is not fixed.
  expect(payloads.map((payload) => payload.event).sort()).toEqual(['agent.end', 'agent.start', 'agent.start', 'session.start', 'tool.result'])
  expect(payloads.every((payload) => payload.cwd === bench.root && payload.thread.id === 'T-1')).toBe(true)
  expect(payloads.find((payload) => payload.event === 'agent.end').messages).toBeUndefined()
})

/** A hook stand-in that logs when each payload arrives and when its answer leaves, answering session.start only after `packMs`. */
function slowHook(root: string, packMs: number): { argv: string[]; log: string } {
  const script = join(root, 'slow-hook.ts')
  const log = join(root, 'timing.jsonl')
  writeFileSync(script, [
    `const fs = require('node:fs');`,
    `const note = (what, event) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ what, event, at: Date.now() }) + '\\n');`,
    `const payload = JSON.parse(await Bun.stdin.text());`,
    `note('recv', payload.event);`,
    `if (payload.event === 'session.start') await Bun.sleep(${packMs});`,
    `const content = payload.event === 'session.start' ? 'pack' : 'delta for ' + payload.message;`,
    `note('done', payload.event);`,
    `console.log(JSON.stringify({ message: { content, display: false } }));`,
  ].join('\n'))
  return { argv: [process.execPath, script], log }
}

test('the Amp plugin asks for the prompt delta while the session pack is still coming, and keeps pack before delta', async () => {
  const { argv, log } = slowHook(bench.root, 800)
  const file = join(bench.root, 'parallel.ts')
  writeFileSync(file, ampPluginContent({ command: argv[0] ?? '', args: argv.slice(1) }))
  const plugin = (await import(file)) as { default: (amp: unknown) => void }
  const { amp, handlers } = stubAmp()
  plugin.default(amp)
  const thread = { id: 'T-P' }
  handlers.get('session.start')?.({ thread }, {})
  expect(await handlers.get('agent.start')?.({ thread, message: 'go', id: 1 }, {})).toEqual({ message: { content: 'pack\n\ndelta for go', display: false } })
  const marks = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { what: string; event: string; at: number })
  const at = (what: string, event: string): number => marks.find((mark) => mark.what === what && mark.event === event)?.at ?? Number.NaN
  // The delta was asked for before the pack came back, not after it.
  expect(at('recv', 'agent.start')).toBeLessThan(at('done', 'session.start'))
})

test('the Amp plugin drops a thread\'s pending pack when its run ends', async () => {
  const [command, script] = stubHook(bench.root)
  const file = join(bench.root, 'pruned.ts')
  writeFileSync(file, ampPluginContent({ command: command ?? '', args: [script ?? ''] }))
  const plugin = (await import(file)) as { default: (amp: unknown) => void }
  const { amp, handlers } = stubAmp()
  plugin.default(amp)
  const thread = { id: 'T-E' }
  await handlers.get('session.start')?.({ thread }, {})
  await handlers.get('agent.end')?.({ thread, message: 'x', id: 1, status: 'done' }, {})
  expect(await handlers.get('agent.start')?.({ thread, message: 'later', id: 2 }, {})).toEqual({ message: { content: 'delta for later', display: false } })
})

test('the Amp plugin returns nothing when the hook prints nothing or cannot run', async () => {
  const file = join(bench.root, 'broken.ts')
  writeFileSync(file, ampPluginContent({ command: join(bench.root, 'missing-binary'), args: [] }))
  const plugin = (await import(file)) as { default: (amp: unknown) => void }
  const { amp, handlers } = stubAmp()
  plugin.default(amp)
  expect(await handlers.get('agent.start')?.({ thread: { id: 'T-2' }, message: 'x', id: 1 }, {})).toBeUndefined()
})

test('amp: the plugin file meets the writer contract, follows XDG_CONFIG_HOME, and a foreign kinfold.ts is left alone', async () => {
  const w = bench.world()
  expect(ampPluginDir(w.env)).toBe(join(w.env.homeDir, '.config', 'amp', 'plugins'))
  const path = join(ampPluginDir(w.env), 'kinfold.ts')
  const { write, remove } = fileWriter(path, () => templatePluginFileActions(w.env, AMP_PLUGIN_SPEC), () => pluginFileUninstallActions(w.env, AMP_PLUGIN_SPEC))
  assertWriterContract(write, remove, [null])
  const after = write(null) ?? ''
  expect(after).toContain('"--host","amp"')
  expect(await pluginFileActions(w.env, AMP_PLUGIN_SPEC)).toEqual([])

  const xdg = { ...w.env, xdgConfigHomeEnv: join(w.root, 'xdg') }
  expect(ampPluginDir(xdg)).toBe(join(w.root, 'xdg', 'amp', 'plugins'))

  mkdirSync(ampPluginDir(w.env), { recursive: true })
  writeFileSync(path, 'export default function () {}\n')
  await expect(pluginFileActions(w.env, AMP_PLUGIN_SPEC)).rejects.toThrow('is not a Kinfold plugin file')
  expect(pluginFileUninstallActions(w.env, AMP_PLUGIN_SPEC)).toEqual([])
  // The profile skips its plugin with the reason and still plans the MCP entry, so other agents install.
  expect(writesOf(await profile('amp').wiring.install(w.env))).toEqual([AMP_MCP_FILE.path(w.env)])
  expect(w.out.some((line) => line.startsWith('amp: plugin skipped;') && line.includes('is not a Kinfold plugin file'))).toBe(true)
})

test('amp: the MCP entry goes under "amp.mcpServers" in settings.json and meets the writer contract', () => {
  const w = bench.world()
  const path = AMP_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.config', 'amp', 'settings.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'amp', AMP_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'amp', AMP_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ 'amp.dangerouslyAllowAll': false, 'amp.mcpServers': { other: { command: 'npx' } } }, null, 2)}\n`])
  expect(JSON.parse(write(null) ?? '{}')['amp.mcpServers'][MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'amp' })
})

test('amp: with settings.jsonc present, no settings.json is written and the reason is printed', async () => {
  const w = bench.world()
  mkdirSync(join(w.env.homeDir, '.config', 'amp'), { recursive: true })
  writeFileSync(join(w.env.homeDir, '.config', 'amp', 'settings.jsonc'), '{ // mine\n}\n')
  const actions = await profile('amp').wiring.install(w.env)
  expect(writesOf(actions)).toEqual([join(ampPluginDir(w.env), 'kinfold.ts')])
  expect(w.out.some((line) => line.includes('settings.jsonc found; add the kinfold MCP server under "amp.mcpServers" there by hand'))).toBe(true)
})

test('amp: built from the docs, context at start and on each prompt on every OS, and a load failure is named in the limit', async () => {
  const amp = profile('amp')
  expect(amp).toMatchObject({ id: 'amp', verification: 'docs', detection: { binaries: ['amp'] } })
  for (const os of ['macos', 'linux', 'windows'] as const) expect(amp.capabilities(os)).toEqual({ capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false })
  expect(capabilityLine(amp, 'macos')).toContain('amp plugins list')
  const w = bench.world()
  apply(await amp.wiring.install(w.env))
  expect(amp.wiring.state(w.env)).toBe('yes')
  expect(await amp.wiring.install(w.env)).toEqual([])
  expect(amp.wiring.line(w.env)).toBe(`plugin yes in ${join(ampPluginDir(w.env), 'kinfold.ts')}; MCP yes in ${AMP_MCP_FILE.path(w.env)}`)
  apply(amp.wiring.uninstall(w.env))
  expect(amp.wiring.state(w.env)).toBe('no')
})

test('amp: the settings.jsonc step prints the MCP entry install would write', () => {
  const w = bench.world()
  const entry = AMP_MCP_FILE.mcp?.entry(mcpTarget(w.env), 'amp')
  expect(profile('amp').manualSteps('macos', w.env).join(' ')).toContain(`"${MCP_SERVER_NAME}": ${JSON.stringify(entry)}`)
})
