import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCodexHome } from './codex-home'
import { installPaths } from './env'
import { CODEX_HOOK_SPEC } from './host-hooks'
import { EXIT_OK, install } from './install'
import { status } from './status'
import { type FakeWorld, YES, createWorld } from './test-support'
import { uninstall } from './uninstall'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function codexWorld(codexHomeEnv: string | undefined): FakeWorld {
  const w = createWorld({ codexVersion: 'codex-cli 0.120.0', keychainRefs: ['openrouter'] })
  world = w
  w.env = { ...w.env, codexHomeEnv }
  return w
}
const samEvents = (path: string): string[] => Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown> }).hooks)

test('resolveCodexHome follows Codex: unset or empty is ~/.codex; set must be an existing directory, canonicalized', () => {
  const w = codexWorld(undefined)
  expect(resolveCodexHome(undefined, w.home, w.home)).toEqual({ ok: true, dir: join(w.home, '.codex'), fromEnv: false })
  expect(resolveCodexHome('', w.home, w.home)).toEqual({ ok: true, dir: join(w.home, '.codex'), fromEnv: false })
  const real = join(w.home, 'codex-real')
  mkdirSync(real)
  symlinkSync(real, join(w.home, 'codex-link'))
  expect(resolveCodexHome('codex-link', w.home, w.home)).toMatchObject({ ok: true, fromEnv: true })
  expect((resolveCodexHome('codex-link', w.home, w.home) as { dir: string }).dir.endsWith('/codex-real')).toBe(true)
  expect(resolveCodexHome('missing', w.home, w.home)).toEqual({ ok: false, reason: 'CODEX_HOME points to "missing", but that path does not exist' })
  writeFileSync(join(w.home, 'a-file'), '')
  expect(resolveCodexHome(join(w.home, 'a-file'), w.home, w.home)).toMatchObject({ ok: false, reason: expect.stringContaining('is not a directory') })
})

test('install wires $CODEX_HOME/hooks.json, leaves ~/.codex alone, status names the file, uninstall removes ours', async () => {
  const w = codexWorld(undefined)
  const home = join(w.home, 'work-codex')
  mkdirSync(home)
  w.env = { ...w.env, codexHomeEnv: home }
  const hooks = installPaths(w.env).codexHooks
  expect(hooks.endsWith('/work-codex/hooks.json')).toBe(true)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(samEvents(hooks)).toEqual([...CODEX_HOOK_SPEC.events])
  expect(existsSync(join(w.home, '.codex'))).toBe(false)
  expect(w.out).toContain(`codex: CODEX_HOME is set; using ${hooks}`)
  w.out.length = 0
  await status(w.env)
  expect(w.out).toContain(`  codex: detected codex-cli 0.120.0; wired: yes in ${hooks}`)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(samEvents(hooks)).toEqual([])
})

test('an unusable CODEX_HOME skips Codex with the reason; the rest of install goes on; status reports it', async () => {
  const w = codexWorld('/nonexistent/codex-home')
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.out).toContain('codex: CODEX_HOME points to "/nonexistent/codex-home", but that path does not exist; Codex will not start with it either, so its hooks were not wired. Fix or unset CODEX_HOME and rerun')
  expect(existsSync(join(w.home, '.codex'))).toBe(false)
  expect(existsSync(installPaths(w.env).claudeSettings) || existsSync(installPaths(w.env).launchAgentPlist)).toBe(true)
  w.out.length = 0
  await status(w.env)
  expect(w.out.some((line) => line.startsWith('  codex:') && line.includes('wired: unknown (CODEX_HOME points to'))).toBe(true)
})

test('uninstall with CODEX_HOME set also cleans entries an earlier install put in ~/.codex', async () => {
  const w = codexWorld(undefined)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const fallback = installPaths(w.env).codexHooks
  expect(samEvents(fallback)).toEqual([...CODEX_HOOK_SPEC.events])
  const home = join(w.home, 'work-codex')
  mkdirSync(home)
  w.env = { ...w.env, codexHomeEnv: home }
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(samEvents(fallback)).toEqual([])
})
