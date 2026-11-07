import { expect, test } from 'bun:test'
import type { InstallMode } from './entry'
import { inspectShim, pluginFileContent, shimContent } from './opencode-shim'

const CHECKOUT: InstallMode = { kind: 'checkout', bunPath: '/opt/bun/bin/bun', projectRoot: '/repo' }
const PROGRAM: InstallMode = { kind: 'program', binPath: '/home/u/.kinfold/bin/kinfold' }
const PLUGIN_ENTRY = '/repo/src/plugins/opencode.ts'
const BUNDLE = [
  '// @bun',
  'var plugin_default = { id: "kinfold", setup() {} };',
  'export { plugin_default as default };',
  '',
].join('\n')

test('checkout mode writes the shim that re-exports the checkout plugin', () => {
  const content = pluginFileContent(CHECKOUT, '/home/u/.kinfold', BUNDLE)
  expect(content).toBe(shimContent(PLUGIN_ENTRY))
  expect(inspectShim(content, PLUGIN_ENTRY)).toBe('yes')
})

test('program mode starts with the marker, names the data folder, then carries the bundle whole', () => {
  const content = pluginFileContent(PROGRAM, '/home/u/.kinfold', BUNDLE)
  expect(content.split('\n')[0]).toBe('// kinfold: written by `kinfold install`, removed by `kinfold uninstall`.')
  expect(content.split('\n')[1]).toBe(`const KINFOLD_DATA_DIR = ${JSON.stringify('/home/u/.kinfold')};`)
  expect(content.endsWith(BUNDLE)).toBe(true)
  expect(inspectShim(content, PLUGIN_ENTRY)).toBe('yes')
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
  expect(inspectShim('export default { id: "someone-else" }\n', PLUGIN_ENTRY)).toBe('foreign')
  expect(inspectShim(`const KINFOLD_DATA_DIR = "/x";\n${BUNDLE}`, PLUGIN_ENTRY)).toBe('foreign')
})

test('the old marker still marks a program file as ours', () => {
  const content = `// shared-agent-memory: written by \`kinfold install\`, removed by \`kinfold uninstall\`.\nconst KINFOLD_DATA_DIR = "/x";\n${BUNDLE}`
  expect(inspectShim(content, PLUGIN_ENTRY)).toBe('yes')
})

test('a shim for another checkout is stale, not foreign', () => {
  expect(inspectShim(shimContent('/old/src/plugins/opencode.ts'), PLUGIN_ENTRY)).toBe('stale')
})
