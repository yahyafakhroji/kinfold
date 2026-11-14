import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENCODE_PLUGIN_SPEC } from '../../install/host-wiring'
import type { InstallMode } from '../../install/entry'
import { createWorld } from '../../install/test-support'
import { posixOnly } from '../../../test/platform-guards'
import { KILO_PLUGIN_SPEC } from '../profiles/kilo-code'
import { pluginFileActions, pluginFileContent, pluginFileState, pluginFileUninstallActions, shimContent } from './plugin-file'

const PROGRAM: InstallMode = { kind: 'program', binPath: '/home/u/.kinfold/bin/kinfold' }
const BUNDLE = '// @bun\nvar plugin_default = { id: "kinfold", setup() {} };\nexport { plugin_default as default };\n'
const DATA = '/home/u/.kinfold'
const ENTRY = '/repo/src/plugins/opencode.ts'

test('the plugin file for kilo-code names host kilo-code and the data dir', () => {
  const program = pluginFileContent(PROGRAM, DATA, BUNDLE, 'kilo-code')
  const lines = program.split('\n')
  expect(lines[1]).toBe(`const KINFOLD_DATA_DIR = ${JSON.stringify(DATA)};`)
  expect(lines[2]).toBe('const KINFOLD_HOST = "kilo-code";')
  expect(program.endsWith(BUNDLE)).toBe(true)
  const shim = shimContent(ENTRY, DATA, 'kilo-code')
  expect(shim).toContain(`globalThis.KINFOLD_DATA_DIR = ${JSON.stringify(DATA)};`)
  expect(shim).toContain('globalThis.KINFOLD_HOST = "kilo-code";')
})

const writeKiloShim = async (w: ReturnType<typeof createWorld>): Promise<string> => {
  const path = join(KILO_PLUGIN_SPEC.dir(w.env), KILO_PLUGIN_SPEC.fileName)
  for (const action of await pluginFileActions(w.env, KILO_PLUGIN_SPEC)) {
    if (action.kind === 'mkdir') mkdirSync(action.path, { recursive: true })
    if (action.kind === 'write') writeFileSync(action.path, action.content)
  }
  return path
}

test("Kilo's checkout shim says Kilo Code loads the folder", async () => {
  const w = createWorld()
  try {
    const written = readFileSync(await writeKiloShim(w), 'utf8')
    expect(written.split('\n')[1]).toBe('// Kilo Code loads every plugin in this folder; the plugin itself lives in')
    expect(written).not.toContain('OpenCode 2.x')
    expect(pluginFileState(w.env, KILO_PLUGIN_SPEC)).toBe('yes')
  } finally {
    await w.cleanup()
  }
})

test("a Kilo shim that still names OpenCode is stale and is rewritten", async () => {
  const w = createWorld()
  try {
    const path = await writeKiloShim(w)
    const written = readFileSync(path, 'utf8')
    writeFileSync(path, written.replace('// Kilo Code loads', '// OpenCode 2.x loads'))
    expect(pluginFileState(w.env, KILO_PLUGIN_SPEC)).toBe('stale')
    expect((await pluginFileActions(w.env, KILO_PLUGIN_SPEC)).some((action) => action.kind === 'write' && action.content === written)).toBe(true)
  } finally {
    await w.cleanup()
  }
})

test("OpenCode's plugin file is byte-identical to before", () => {
  expect(shimContent(ENTRY, DATA)).toBe(
    [
      '// kinfold: written by `kinfold install`, removed by `kinfold uninstall`.',
      '// OpenCode 2.x loads every plugin in this folder; the plugin itself lives in',
      '// the checkout below, and reads its data folder from the line under this.',
      `globalThis.KINFOLD_DATA_DIR = ${JSON.stringify(DATA)};`,
      `const plugin = await import(${JSON.stringify(ENTRY)});`,
      'export default plugin.default;',
      '',
    ].join('\n'),
  )
  expect(pluginFileContent(PROGRAM, DATA, BUNDLE)).toBe(['// kinfold: written by `kinfold install`, removed by `kinfold uninstall`.', `const KINFOLD_DATA_DIR = ${JSON.stringify(DATA)};`, BUNDLE].join('\n'))
})

posixOnly('POSIX paths')('install, re-run and uninstall meet the plugin-file contract, for both agents', async () => {
  const w = createWorld()
  const assets = { opencodePlugin: async () => BUNDLE } as never
  const program = { ...w.env, mode: PROGRAM }
  for (const spec of [KILO_PLUGIN_SPEC, OPENCODE_PLUGIN_SPEC]) {
    const path = join(spec.dir(program), spec.fileName)
    expect(pluginFileState(program, spec)).toBe('no')
    const planned = await pluginFileActions(program, spec, assets)
    for (const action of planned) {
      if (action.kind === 'mkdir') mkdirSync(action.path, { recursive: true })
      if (action.kind === 'write') writeFileSync(action.path, action.content)
    }
    expect(readFileSync(path, 'utf8')).toBe(pluginFileContent(PROGRAM, program.dataDir, BUNDLE, spec.host))
    expect(pluginFileState(program, spec)).toBe('yes')
    expect(await pluginFileActions(program, spec, assets)).toEqual([])
    const removal = pluginFileUninstallActions(program, spec)
    expect(removal.map((a) => a.kind)).toEqual(['remove'])
    rmSync(path)
    expect(pluginFileUninstallActions(program, spec)).toEqual([])
    // A file by our name that is not ours is neither replaced nor removed.
    writeFileSync(path, 'export default { id: "someone-else" }\n')
    expect(pluginFileState(program, spec)).toBe('foreign')
    expect(pluginFileUninstallActions(program, spec)).toEqual([])
    await expect(pluginFileActions(program, spec, assets)).rejects.toThrow('not a Kinfold plugin file')
    rmSync(path)
  }
  await w.cleanup()
})
