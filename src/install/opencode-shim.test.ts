import { expect, test } from 'bun:test'
import type { InstallMode } from './entry'
import { inspectShim, isOwnShim, pluginFileContent, shimContent } from './opencode-shim'
import { posixOnly } from '../../test/platform-guards'

const CHECKOUT: InstallMode = { kind: 'checkout', bunPath: '/opt/bun/bin/bun', projectRoot: '/repo' }
const PROGRAM: InstallMode = { kind: 'program', binPath: '/home/u/.kinfold/bin/kinfold' }
const PLUGIN_ENTRY = '/repo/src/plugins/opencode.ts'
const DATA = '/home/u/.kinfold'
const EXPECTED = { pluginEntry: PLUGIN_ENTRY, dataDir: DATA }
const BUNDLE = [
  '// @bun',
  'var plugin_default = { id: "kinfold", setup() {} };',
  'export { plugin_default as default };',
  '',
].join('\n')

posixOnly('POSIX paths')('checkout mode writes the shim that sets the data folder and loads the checkout plugin', () => {
  const content = pluginFileContent(CHECKOUT, '/home/u/.kinfold', BUNDLE)
  expect(content).toBe(shimContent(PLUGIN_ENTRY, DATA))
  expect(content).toContain(`globalThis.KINFOLD_DATA_DIR = ${JSON.stringify(DATA)};`)
  expect(content).toContain(`await import(${JSON.stringify(PLUGIN_ENTRY)})`)
  expect(content).not.toMatch(/^export \{/m)
  expect(inspectShim(content, EXPECTED)).toBe('yes')
})

test('program mode starts with the marker, names the data folder, then carries the bundle whole', () => {
  const content = pluginFileContent(PROGRAM, '/home/u/.kinfold', BUNDLE)
  expect(content.split('\n')[0]).toBe('// kinfold: written by `kinfold install`, removed by `kinfold uninstall`.')
  expect(content.split('\n')[1]).toBe(`const KINFOLD_DATA_DIR = ${JSON.stringify('/home/u/.kinfold')};`)
  expect(content.endsWith(BUNDLE)).toBe(true)
  expect(inspectShim(content, EXPECTED)).toBe('yes')
})

test('the data folder constant stays one valid string for quotes, backslashes and spaces', () => {
  const dir = '/tmp/a "quoted" \\ folder/with spaces'
  const content = pluginFileContent(PROGRAM, dir, BUNDLE)
  const line = content.split('\n').find((candidate) => candidate.startsWith('const KINFOLD_DATA_DIR = '))
  expect(line).toBeDefined()
  const value = new Function(`${line} return KINFOLD_DATA_DIR`)() as string
  expect(value).toBe(dir)
})

test('a file without our marker stays foreign, even when it carries the bundle', () => {
  expect(inspectShim('export default { id: "someone-else" }\n', EXPECTED)).toBe('foreign')
  expect(inspectShim(`const KINFOLD_DATA_DIR = "/x";\n${BUNDLE}`, EXPECTED)).toBe('foreign')
})

test('the old marker still marks a program file as ours', () => {
  const content = `// shared-agent-memory: written by \`kinfold install\`, removed by \`kinfold uninstall\`.\nconst KINFOLD_DATA_DIR = "/x";\n${BUNDLE}`
  expect(inspectShim(content, EXPECTED)).toBe('yes')
})

test('a shim for another checkout is stale, not foreign', () => {
  expect(inspectShim(shimContent('/old/src/plugins/opencode.ts', DATA), EXPECTED)).toBe('stale')
})

test('a shim for another folder is stale', () => {
  expect(inspectShim(shimContent(PLUGIN_ENTRY, '/a'), { pluginEntry: PLUGIN_ENTRY, dataDir: '/b' })).toBe('stale')
  expect(inspectShim(shimContent(PLUGIN_ENTRY, '/a'), { pluginEntry: PLUGIN_ENTRY, dataDir: '/a' })).toBe('yes')
})

test('a shim in the old re-export-only form is stale, not foreign, and still ours to replace', () => {
  const old = [
    '// kinfold: written by `kinfold install`, removed by `kinfold uninstall`.',
    `export { default } from ${JSON.stringify(PLUGIN_ENTRY)};`,
    '',
  ].join('\n')
  expect(inspectShim(old, EXPECTED)).toBe('stale')
  expect(isOwnShim(old)).toBe(true)
  expect(isOwnShim(shimContent(PLUGIN_ENTRY, DATA))).toBe(true)
})

test('a data folder with quotes and spaces stays one string in the shim', () => {
  const dir = '/tmp/x "y" \\ z/data'
  const line = shimContent(PLUGIN_ENTRY, dir).split('\n').find((candidate) => candidate.startsWith('globalThis.KINFOLD_DATA_DIR = '))
  expect(new Function(`const globalThis = {}; ${line} return globalThis.KINFOLD_DATA_DIR`)()).toBe(dir)
  expect(inspectShim(shimContent(PLUGIN_ENTRY, dir), { pluginEntry: PLUGIN_ENTRY, dataDir: dir })).toBe('yes')
})
