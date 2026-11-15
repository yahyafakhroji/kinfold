import { expect, test } from 'bun:test'
import { USAGE, parseArgs } from './args'

const INSTALL = ['install', '--hosts', 'opencode', '--observer', 'opencode=claude-cli:haiku', '--no-encrypt', '--port', '40000', '--no-update-check', '--yes']

test('every step has a flag', () => {
  const parsed = parseArgs(INSTALL)
  expect(parsed).toMatchObject({ ok: true, value: { command: 'install', hosts: ['opencode'], noEncrypt: true, port: 40000, noUpdateCheck: true, yes: true } })
  expect(parseArgs(['install', '--port=40001'])).toMatchObject({ ok: true, value: { port: 40001 } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { noEncrypt: false, noUpdateCheck: false, port: null } })
})

test('a port outside 1024-65535 or not a number is a usage error', () => {
  for (const port of ['80', '1023', '65536', 'x', '40000.5', '']) {
    const parsed = parseArgs(['install', '--port', port])
    expect(parsed.ok).toBe(false)
  }
  expect(parseArgs(['install', '--port'])).toEqual({ ok: false, error: '--port needs a value' })
})

test('the new flags apply to install only', () => {
  expect(parseArgs(['status', '--no-encrypt'])).toEqual({ ok: false, error: '--no-encrypt does not apply to status' })
  expect(parseArgs(['uninstall', '--no-update-check'])).toEqual({ ok: false, error: '--no-update-check does not apply to uninstall' })
  expect(parseArgs(['status', '--port', '40000'])).toEqual({ ok: false, error: '--port does not apply to status' })
})

test('USAGE lists the new flags and the update command', () => {
  for (const text of ['--no-encrypt', '--port <1024-65535>', '--no-update-check']) expect(USAGE).toContain(text)
  expect(USAGE).toMatch(/update\s+\[--dry-run\]/)
})

test('update --auto is the run the daemon starts, and is not advertised', () => {
  expect(parseArgs(['update', '--auto'])).toMatchObject({ ok: true, value: { command: 'update', auto: true, dryRun: false } })
  expect(parseArgs(['update'])).toMatchObject({ ok: true, value: { auto: false } })
  expect(parseArgs(['install', '--auto'])).toEqual({ ok: false, error: '--auto does not apply to install' })
  expect(USAGE).not.toContain(' --auto')
  expect(USAGE).not.toContain('[--auto]')
})

test('install --no-auto-update turns automatic patch updates off', () => {
  expect(parseArgs(['install', '--no-auto-update'])).toMatchObject({ ok: true, value: { command: 'install', noAutoUpdate: true } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { noAutoUpdate: false } })
  expect(parseArgs(['update', '--no-auto-update'])).toEqual({ ok: false, error: '--no-auto-update does not apply to update' })
})

test('install --auto-update turns automatic patch updates back on, and cannot be combined with its opposite', () => {
  expect(parseArgs(['install', '--auto-update'])).toMatchObject({ ok: true, value: { command: 'install', autoUpdate: true, noAutoUpdate: false } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { autoUpdate: false } })
  expect(parseArgs(['install', '--auto-update', '--no-auto-update'])).toEqual({ ok: false, error: '--auto-update and --no-auto-update cannot be given together' })
  expect(parseArgs(['update', '--auto-update'])).toEqual({ ok: false, error: '--auto-update does not apply to update' })
  expect(USAGE).toContain('[--auto-update | --no-auto-update]')
})

test('update takes only --dry-run', () => {
  expect(parseArgs(['update'])).toMatchObject({ ok: true, value: { command: 'update', dryRun: false } })
  expect(parseArgs(['update', '--dry-run'])).toMatchObject({ ok: true, value: { command: 'update', dryRun: true } })
  expect(parseArgs(['update', '--yes'])).toEqual({ ok: false, error: '--yes does not apply to update' })
  expect(parseArgs(['update', '--port', '40000'])).toEqual({ ok: false, error: '--port does not apply to update' })
})
