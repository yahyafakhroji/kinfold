import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHostVersions, recordedHostVersion } from '../adapters/host-version'
import { installPaths } from './env'
import { CODEX_HOOK_SPEC, CURSOR_HOOK_SPEC, samItem } from './host-hooks'
import { CODEX_TRUST_NOTE } from './host-wiring'
import { EXIT_OK, install } from './install'
import { status } from './status'
import { BUN, type FakeWorld, YES, createWorld, snapshotTree } from './test-support'
import { uninstall } from './uninstall'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const FOREIGN_CURSOR = { command: "/bin/sh '/Users/dev/.other/cursor-hook.sh'", timeout: 10 }
const CURSOR_FILE = { hooks: { beforeSubmitPrompt: [FOREIGN_CURSOR], stop: [FOREIGN_CURSOR], afterAgentResponse: [FOREIGN_CURSOR] }, version: 1 }
const CODEX_FILE = { hooks: {} }

/** A home that already has the files another tool left in ~/.codex and ~/.cursor. */
function seedForeignFiles(w: FakeWorld): void {
  const paths = installPaths(w.env)
  mkdirSync(paths.codexDir, { recursive: true })
  mkdirSync(paths.cursorDir, { recursive: true })
  writeFileSync(paths.codexHooks, `${JSON.stringify(CODEX_FILE, null, 2)}\n`)
  writeFileSync(paths.cursorHooks, `${JSON.stringify(CURSOR_FILE, null, 2)}\n`)
}

/** Cursor.app with an XML Info.plist, as a detected-by-app host. */
function seedCursorApp(w: FakeWorld, version: string): string {
  const contents = join(w.root, 'Applications', 'Cursor.app', 'Contents')
  mkdirSync(contents, { recursive: true })
  const plist = join(contents, 'Info.plist')
  writeFileSync(plist, `<plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>\n`)
  return plist
}

test('hosts not detected: install, status and uninstall never touch ~/.codex or ~/.cursor', async () => {
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', keychainRefs: ['openrouter'] })
  world = w
  seedForeignFiles(w)
  const paths = installPaths(w.env)
  const before = { codex: snapshotTree(paths.codexDir), cursor: snapshotTree(paths.cursorDir) }
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect({ codex: snapshotTree(paths.codexDir), cursor: snapshotTree(paths.cursorDir) }).toEqual(before)
  expect(w.out).toContain('host codex: skip (not found (no codex on PATH, no Codex.app))')
  expect(w.out).toContain('host cursor: skip (not found (no cursor-agent or cursor on PATH, no Cursor.app))')
  expect(w.out.some((line) => line.includes(paths.codexHooks) && line.includes('write'))).toBe(false)
  expect(w.out).toContain(`  codex: not detected (not found (no codex on PATH, no Codex.app)); wired: no in ${paths.codexHooks}`)
})

test('detected Codex (CLI) and Cursor (app): wired with backups, foreign entries kept, idempotent, removed cleanly', async () => {
  const w = createWorld({ codexVersion: 'codex-cli 0.120.0', keychainRefs: ['openrouter'] })
  world = w
  seedForeignFiles(w)
  seedCursorApp(w, '2.4.21')
  const paths = installPaths(w.env)
  const hookScript = paths.hookScript
  expect(await install(w.env, YES)).toBe(EXIT_OK)

  const codex = JSON.parse(readFileSync(paths.codexHooks, 'utf8')) as { hooks: Record<string, unknown[]> }
  for (const event of CODEX_HOOK_SPEC.events) expect(codex.hooks[event]).toEqual([samItem(CODEX_HOOK_SPEC, event, { bunPath: BUN, hookScript })])
  const cursor = JSON.parse(readFileSync(paths.cursorHooks, 'utf8')) as { version: number; hooks: Record<string, unknown[]> }
  expect(cursor.version).toBe(1)
  expect(cursor.hooks.beforeSubmitPrompt).toEqual([FOREIGN_CURSOR, samItem(CURSOR_HOOK_SPEC, 'beforeSubmitPrompt', { bunPath: BUN, hookScript })])
  expect(cursor.hooks.sessionStart).toEqual([samItem(CURSOR_HOOK_SPEC, 'sessionStart', { bunPath: BUN, hookScript })])
  expect(readdirSync(paths.codexDir).filter((name) => name.includes('.kinfold-backup-'))).toHaveLength(1)
  expect(readdirSync(paths.cursorDir).filter((name) => name.includes('.kinfold-backup-'))).toHaveLength(1)
  expect(w.out).toContain(CODEX_TRUST_NOTE)
  expect(w.out).toContain('observer codex: openrouter/openrouter/auto (default); keychain entry openrouter present; check ok')
  expect(w.out).toContain('observer cursor: openrouter/openrouter/auto (default); keychain entry openrouter present; check ok')

  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.out).toContain(`codex: hooks already wired in ${paths.codexHooks}`)
  expect(w.out).toContain(`cursor: hooks already wired in ${paths.cursorHooks}`)

  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(w.out).toContain(`  codex: detected codex-cli 0.120.0; wired: yes in ${paths.codexHooks}`)
  expect(w.out).toContain(`  cursor: detected 2.4.21; wired: yes in ${paths.cursorHooks}`)

  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(JSON.parse(readFileSync(paths.codexHooks, 'utf8'))).toEqual(CODEX_FILE)
  expect(JSON.parse(readFileSync(paths.cursorHooks, 'utf8'))).toEqual(CURSOR_FILE)
})

test('an unparseable Cursor hooks.json stops the install and stays untouched', async () => {
  const w = createWorld({ cursorVersion: '2.4.21', keychainRefs: ['openrouter'] })
  world = w
  const paths = installPaths(w.env)
  mkdirSync(paths.cursorDir, { recursive: true })
  writeFileSync(paths.cursorHooks, '{ not json')
  expect(await install(w.env, YES)).not.toBe(EXIT_OK)
  expect(readFileSync(paths.cursorHooks, 'utf8')).toBe('{ not json')
  expect(readdirSync(paths.cursorDir)).toEqual(['hooks.json'])
})

test('host_version is recorded for all four hosts, pinned to the binary or app, and a re-run writes nothing', async () => {
  const bin = 'bin'
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', codexVersion: 'codex-cli 0.120.0', keychainRefs: ['openrouter'] })
  world = w
  const binDir = join(w.root, bin)
  mkdirSync(binDir)
  for (const name of ['claude', 'codex']) writeFileSync(join(binDir, name), '#!/bin/sh\n')
  const original = w.env.run
  w.env.run = async (request) => {
    const name = request.argv[1] ?? ''
    return request.argv[0] === '/usr/bin/which' && ['claude', 'codex'].includes(name) ? { exitCode: 0, stdout: `${join(binDir, name)}\n` } : original(request)
  }
  const plist = seedCursorApp(w, '2.4.21')
  expect(await install(w.env, YES)).toBe(EXIT_OK)

  const records = readHostVersions(w.dataDir)
  expect(Object.fromEntries(Object.entries(records).map(([host, record]) => [host, record.version]))).toEqual({
    'claude-code': '2.1.310', opencode: '2.1.4', codex: '0.120.0', cursor: '2.4.21',
  })
  expect(records.codex?.binary?.path).toBe(join(binDir, 'codex'))
  expect(records.cursor?.binary?.path).toBe(plist)
  expect(records.opencode?.binary).toBeNull()
  for (const host of ['claude-code', 'opencode', 'codex', 'cursor']) expect(recordedHostVersion(w.dataDir, host)).toBe(records[host]?.version)

  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.out.some((line) => line.includes('record host_version'))).toBe(false)
  expect(existsSync(installPaths(w.env).hostVersionsFile)).toBe(true)
})
