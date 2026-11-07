import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginFileContent } from '../install/opencode-shim'
import type { InstallMode } from '../install/entry'
import { assertStandalone, bundlePlugin, importSpecifiers, isBuiltinSpecifier } from '../../tools/bundle-plugin'

let root: string | null = null
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

async function built(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'kinfold-plugin-bundle-'))
  const out = join(root, 'kinfold.js')
  await bundlePlugin(out)
  return out
}

test('the bundle imports only Node and Bun builtins, never a checkout path or SQLite', async () => {
  const text = readFileSync(await built(), 'utf8')
  const specifiers = importSpecifiers(text)
  expect(specifiers.length).toBeGreaterThan(0)
  for (const specifier of specifiers) {
    expect(isBuiltinSpecifier(specifier)).toBe(true)
    expect(specifier).not.toContain('/src/')
    expect(specifier.toLowerCase()).not.toContain('sqlite')
  }
  // bun:ffi is how SQLite is loaded; its absence is the proof that no store code rode along.
  expect(specifiers).not.toContain('bun:ffi')
  expect(text).not.toContain('bun:sqlite')
  expect(text).not.toContain('node:sqlite')
})

test('the bundle carries no module-path comments from the build machine', async () => {
  const text = readFileSync(await built(), 'utf8')
  expect(text.split('\n').filter((line) => line.startsWith('// '))).toEqual(['// @bun'])
})

test('assertStandalone names a checkout path, an npm package and a SQLite loader', () => {
  expect(() => assertStandalone('import x from "/Users/dev/repo/src/plugins/opencode.ts"\n')).toThrow('imports a checkout path')
  expect(() => assertStandalone('import x from "left-pad"\n')).toThrow('not a Node or Bun builtin')
  expect(() => assertStandalone('import x from "bun:sqlite"\n')).toThrow('would load SQLite')
  expect(() => assertStandalone('import { join } from "node:path"\n')).not.toThrow()
})

test('the standalone file installs as an OpenCode plugin and spools a prompt with the daemon down', async () => {
  const out = await built()
  const dataDir = join(root!, 'data')
  mkdirSync(dataDir, { recursive: true })
  const previous = process.env.KINFOLD_DATA_DIR
  process.env.KINFOLD_DATA_DIR = dataDir
  try {
    const plugin = (await import(`${pathToFileURL(out).href}?run=${Date.now()}`)).default as {
      id: string
      setup: (ctx: unknown) => void
    }
    expect(plugin.id).toBe('kinfold')
    const handlers = new Map<string, (event: unknown) => unknown>()
    plugin.setup({
      location: { directory: root },
      tool: { hook: (name: string, handler: (event: unknown) => unknown) => handlers.set(`tool.${name}`, handler) },
      session: { hook: (name: string, handler: (event: unknown) => unknown) => handlers.set(`session.${name}`, handler) },
      event: { subscribe: () => {} },
    })
    handlers.get('session.prompt')!({ sessionID: 'ses_bundle', messageID: 'msg_bundle', prompt: { text: 'read the bundle' }, delivery: 'steer' })
    await new Promise((resolve) => setImmediate(resolve))

    const spool = join(dataDir, 'spool')
    expect(readdirSync(spool).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  } finally {
    if (previous === undefined) delete process.env.KINFOLD_DATA_DIR
    else process.env.KINFOLD_DATA_DIR = previous
  }
})

test('the program-mode file reads the data folder it carries, with no environment', async () => {
  const out = await built()
  const dataDir = join(root!, 'data')
  const composed = join(root!, 'kinfold.js')
  writeFileSync(composed, pluginFileContent({ kind: 'program', binPath: '/x/bin/kinfold' } satisfies InstallMode, dataDir, readFileSync(out, 'utf8')))

  const previousDir = process.env.KINFOLD_DATA_DIR
  const previousHome = process.env.HOME
  delete process.env.KINFOLD_DATA_DIR
  process.env.HOME = join(root!, 'home')
  try {
    const plugin = (await import(`${pathToFileURL(composed).href}?run=${Date.now()}`)).default as {
      setup: (ctx: unknown) => void
    }
    const handlers = new Map<string, (event: unknown) => unknown>()
    plugin.setup({
      location: { directory: root },
      tool: { hook: (name: string, handler: (event: unknown) => unknown) => handlers.set(`tool.${name}`, handler) },
      session: { hook: (name: string, handler: (event: unknown) => unknown) => handlers.set(`session.${name}`, handler) },
      event: { subscribe: () => {} },
    })
    handlers.get('session.prompt')!({ sessionID: 'ses_written', messageID: 'msg_written', prompt: { text: 'read the written folder' }, delivery: 'steer' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(readdirSync(join(dataDir, 'spool')).filter((name) => name.endsWith('.json'))).toHaveLength(1)
    expect(existsSync(join(root!, 'home', '.kinfold'))).toBe(false)
  } finally {
    if (previousDir === undefined) delete process.env.KINFOLD_DATA_DIR
    else process.env.KINFOLD_DATA_DIR = previousDir
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test('the bundled plugin adds no context when the daemon is down', async () => {
  const out = await built()
  const dataDir = join(root!, 'data')
  mkdirSync(dataDir, { recursive: true })
  const previous = process.env.KINFOLD_DATA_DIR
  process.env.KINFOLD_DATA_DIR = dataDir
  try {
    const plugin = (await import(`${pathToFileURL(out).href}?run=${Date.now()}`)).default as {
      setup: (ctx: unknown) => void
    }
    const handlers = new Map<string, (event: unknown) => unknown>()
    plugin.setup({
      location: { directory: root },
      tool: { hook: (name: string, handler: (event: unknown) => unknown) => handlers.set(`tool.${name}`, handler) },
      session: { hook: (name: string, handler: (event: unknown) => unknown) => handlers.set(`session.${name}`, handler) },
      event: { subscribe: () => {} },
    })
    const system = [{ type: 'text', text: 'host system prompt' }]
    await handlers.get('session.context')!({ sessionID: 'ses_bundle', system })
    expect(system).toEqual([{ type: 'text', text: 'host system prompt' }])
  } finally {
    if (previous === undefined) delete process.env.KINFOLD_DATA_DIR
    else process.env.KINFOLD_DATA_DIR = previous
  }
})
