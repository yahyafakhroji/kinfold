// Uninstall takes back what the PATH step added, and speaks through the
// output layer: a bar and a summary on a terminal, the plain lines elsewhere.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { posixOnly } from '../../../../test/platform-guards'
import { installedProgramPath } from '../../../resources/install-plan/entry'
import { EXIT_FAILED, EXIT_OK, type InstallOptions, install } from '../../install/install'
import { installLogPath } from '../../install/install-log'
import { planPathSetup } from '../../install/path-setup'
import { leftBehindLine } from '../../install/program-files'
import { fakeTerminal } from './prompt/fake-terminal'
import { readInstallRecord } from '../../../resources/install-plan/setup/record'
import { type FakeWorld, YES, createWorld, fakeService, snapshotTree } from './test-support'
import { uninstall } from '../../install/uninstall'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const PLAIN = { dryRun: false, removeCredentials: false } as const

interface Made {
  w: FakeWorld
  options: InstallOptions
  link: string
  zshrc: string
}

/** Installed as a program in ~/.kinfold with the command linked and the PATH block in ~/.zshrc. */
async function installed(): Promise<Made> {
  world = createWorld({ claudeVersion: '2.1.311 (Claude Code)', keychainRefs: ['openrouter'] })
  const w = world
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program\n', { mode: 0o755 })
  w.env = { ...w.env, mode: { kind: 'program', binPath: installedProgramPath(w.dataDir, w.env.platform) }, pathEnv: '/opt/fake/bin:/usr/bin', envVars: { SHELL: '/bin/zsh' } }
  const made: Made = { w, options: { ...YES, programSource: source, noEncrypt: true }, link: join(w.home, '.local', 'bin', 'kinfold'), zshrc: join(w.home, '.zshrc') }
  writeFileSync(made.zshrc, 'export A=1\n')
  expect(await install(w.env, made.options)).toBe(EXIT_OK)
  expect(readInstallRecord(w.dataDir)?.pathSetup).toBe('added')
  w.out.length = 0
  return made
}

const screenLines = (output: string): string[] => output.split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((line) => line !== '')
const numbered = (lines: readonly string[]): string[] => lines.filter((line) => /^ {2}\d+\. /.test(line))

posixOnly('POSIX paths')('uninstall removes the link and the PATH block, and forgets the PATH choice', async () => {
  const { w, link, zshrc } = await installed()
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_OK)
  expect(existsSync(link)).toBe(false)
  expect(readFileSync(zshrc, 'utf8')).toBe('export A=1\n')
  const record = readInstallRecord(w.dataDir)
  expect(record).not.toBeNull()
  expect(record?.pathSetup).toBeUndefined()
  expect(record?.pathLink).toBeUndefined()
  // The plain lines, as uninstall has always printed them, with the new steps among them.
  expect(w.out[0]).toMatch(/^applying \d+ actions$/)
  expect(numbered(w.out).some((line) => line.endsWith(`remove ${link}: the kinfold command link  [done]`))).toBe(true)
  expect(numbered(w.out).some((line) => line.endsWith(`write ${zshrc}: remove the kinfold PATH block (9 -> 1 lines)  [done]`))).toBe(true)
  expect(w.out.some((line) => line.startsWith(`kept the data dir ${w.dataDir}`))).toBe(true)
  for (const line of w.out) expect(line).not.toContain('\u001b')
  // The program goes last, after the link that pointed at it.
  const lines = numbered(w.out)
  expect(lines.findIndex((line) => line.includes('the kinfold command link'))).toBeLessThan(lines.findIndex((line) => line.includes('the installed kinfold program')))
})

posixOnly('POSIX paths')('uninstall appends its lines to the install log under its own header', async () => {
  const { w } = await installed()
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_OK)
  const log = readFileSync(installLogPath(w.dataDir), 'utf8')
  const [, uninstallPart] = log.split(/\n=== kinfold uninstall [^\n]+ ===\n/)
  expect(log).toMatch(/^=== kinfold install /)
  expect(uninstallPart?.split('\n').slice(0, -1)).toEqual(w.out)
})

posixOnly('POSIX paths')('a link someone pointed elsewhere, and a startup file with no block, are left as they are', async () => {
  const { w, link, zshrc } = await installed()
  rmSync(link)
  symlinkSync('/opt/other/kinfold', link)
  writeFileSync(zshrc, 'export A=1\n')
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_OK)
  expect(readlinkSync(link)).toBe('/opt/other/kinfold')
  expect(readFileSync(zshrc, 'utf8')).toBe('export A=1\n')
  expect(w.out.join('\n')).not.toContain('the kinfold command link')
})

posixOnly('POSIX paths')('after an uninstall, an unattended install does not put the command back unless --path says so', async () => {
  const { w, link } = await installed()
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_OK)
  const saved = readInstallRecord(w.dataDir)
  const unattended = planPathSetup(w.env, saved, { answer: null, yes: true, flag: null })
  expect(unattended.actions).toEqual([])
  expect(unattended.summary).toContain('kinfold command: not set up; run ')
  const asked = planPathSetup(w.env, saved, { answer: null, yes: true, flag: 'path' })
  expect(asked.record).toMatchObject({ pathSetup: 'added', pathLink: link })
})

posixOnly('POSIX paths')('uninstall --dry-run lists the PATH steps and changes nothing', async () => {
  const { w, link } = await installed()
  const before = snapshotTree(w.home)
  expect(await uninstall(w.env, { ...PLAIN, dryRun: true })).toBe(EXIT_OK)
  expect(w.out[0]).toMatch(/^plan \(dry run, nothing is changed\): \d+ actions$/)
  expect(numbered(w.out).some((line) => line.endsWith(`remove ${link}: the kinfold command link`))).toBe(true)
  expect(snapshotTree(w.home)).toEqual(before)
})

posixOnly('POSIX paths')('on a terminal uninstall draws a bar, then says what was removed and what was kept', async () => {
  const { w, link } = await installed()
  const term = fakeTerminal([])
  w.env = { ...w.env, terminal: term }
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_OK)
  expect(w.out).toEqual([])
  expect(existsSync(link)).toBe(false)
  const raw = term.output()
  expect(raw).toContain('unwiring Claude Code')
  expect(raw).toContain('removing the kinfold command')
  expect(raw).not.toMatch(/\d+\. remove /)
  const screen = screenLines(raw)
  expect(screen[0]).toMatch(/^Kinfold \S+ uninstall$/)
  expect(screen.some((line) => /^o {2}\d+ steps done$/.test(line))).toBe(true)
  expect(screen).toContain('Uninstalled')
  expect(screen.some((line) => line.startsWith(`  kept the data dir ${w.dataDir.replace(w.home, '~')}`))).toBe(true)
  expect(screen).toContain(`  Full log: ${join('~', '.kinfold', 'logs', 'install.log')}`)
  expect(screen.at(-1)).toBe(`Kinfold is removed. Your memory is still in ${w.dataDir.replace(w.home, '~')}.`)
  // The numbered list is in the log.
  expect(readFileSync(installLogPath(w.dataDir), 'utf8')).toMatch(/\n {2}\d+\. remove .*the kinfold command link {2}\[done\]\n/)
})

test('on a terminal --verbose shows the numbered steps too', async () => {
  const { w } = await installed()
  const term = fakeTerminal([])
  w.env = { ...w.env, terminal: term }
  expect(await uninstall(w.env, { ...PLAIN, verbose: true })).toBe(EXIT_OK)
  expect(screenLines(term.output()).some((line) => /^\| {4}\d+\. .* {2}\[done\]$/.test(line))).toBe(true)
})

test('a failed step on a terminal stops the bar and shows the step, the reason and the log', async () => {
  const { w } = await installed()
  const term = fakeTerminal([])
  w.env = { ...w.env, terminal: term, service: fakeService({ running: true, stopError: new Error('the service manager said no') }) }
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_FAILED)
  const screen = screenLines(term.output())
  expect(screen.some((line) => /^x {2}stopped at step 1 of \d+: stopping the daemon$/.test(line))).toBe(true)
  expect(screen).toContain('x 1. FakeService stop')
  expect(screen).toContain('x uninstall failed: step 1 failed: the service manager said no')
  expect(screen.at(-1)).toBe(`The full log is in ${join('~', '.kinfold', 'logs', 'install.log')}`)
})

test('a dry run on a terminal lists the plan there and ends by saying nothing was changed', async () => {
  const { w } = await installed()
  const term = fakeTerminal([])
  w.env = { ...w.env, terminal: term }
  const before = snapshotTree(w.home)
  expect(await uninstall(w.env, { ...PLAIN, dryRun: true })).toBe(EXIT_OK)
  const screen = screenLines(term.output())
  expect(screen.some((line) => /^plan \(dry run, nothing is changed\): \d+ actions$/.test(line))).toBe(true)
  expect(screen.at(-1)).toBe('Dry run: nothing was changed.')
  expect(snapshotTree(w.home)).toEqual(before)
})

test('on a terminal a file uninstall had to leave behind is said above the bar, not only in the log', async () => {
  const { w } = await installed()
  const term = fakeTerminal([])
  w.env = { ...w.env, terminal: term, programFiles: { replace: () => {}, removeBinDir: () => ['/d/bin/.kinfold-old-1'] } }
  expect(await uninstall(w.env, PLAIN)).toBe(EXIT_OK)
  expect(screenLines(term.output())).toContain(`!  ${leftBehindLine('/d/bin/.kinfold-old-1')}`)
})

test('on a terminal an uninstall that skipped the key deletes shows why it ended as failed', async () => {
  const { w } = await installed()
  writeFileSync(join(w.dataDir, 'key-store.json'), 'not json')
  const term = fakeTerminal([])
  w.env = { ...w.env, terminal: term }
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: true })).toBe(EXIT_FAILED)
  const screen = screenLines(term.output())
  expect(screen.some((line) => line.includes('key store: unknown') && line.includes('--remove-credentials skipped, no key was deleted'))).toBe(true)
  expect(screen).toContain('x uninstall did not finish')
})
