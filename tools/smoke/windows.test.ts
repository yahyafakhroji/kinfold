// Reads the generated sources and the runner script as text, so these checks
// run on every OS and start no process.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SmokeWorld } from './platform'
import { SmokeError } from './platform'
import { PYWINPTY_VERSION, type SmokeFetch, checkReadRoute, conptyDriverSource, observerShimSource, smokePlatform } from './windows'

const RUNNER_SCRIPT = join(import.meta.dir, '..', '..', '.github', 'smoke', 'windows.sh')
const CODE_PATTERN = '([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}'

describe('windows smoke platform', () => {
  test('the Windows steps name the task, the program and the store', () => {
    expect(smokePlatform.name).toBe('windows')
    expect(smokePlatform.programName).toBe('kinfold.exe')
    expect(smokePlatform.keyStoreLabel).toBe('Credential Manager')
    expect(smokePlatform.serviceFiles('C:\\h')).toEqual(['C:\\h\\AppData\\Local\\Kinfold\\kinfold-daemon.xml'])
  })

  test('the child environment points every profile folder at the smoke home', () => {
    expect(smokePlatform.childEnv?.('C:\\h')).toEqual({
      USERPROFILE: 'C:\\h',
      LOCALAPPDATA: 'C:\\h\\AppData\\Local',
      APPDATA: 'C:\\h\\AppData\\Roaming',
    })
  })

  test('the shim answers only the print call', () => {
    const marker = 'smokeeventabc123'
    const real = 'C:\\npm\\prefix\\claude.exe'
    const source = observerShimSource(marker, real)
    expect(source).toContain("'--print'")
    expect(source).toContain(JSON.stringify(marker))
    expect(source).toContain(JSON.stringify(real))
    expect(source).toContain('Valid event_id values:')
    expect(source).toContain('process.exit(child.exitCode')
  })

  test('the shim runs a .cmd claude through cmd.exe by its full path', () => {
    const source = observerShimSource('m', 'C:\\npm\\prefix\\claude.cmd')
    expect(source).toMatch(/\\\\System32\\\\cmd\.exe/)
    expect(source).toContain('"/c"')
    const direct = observerShimSource('m', 'C:\\npm\\prefix\\claude.exe')
    expect(direct).not.toMatch(/cmd\.exe/)
  })

  test('the drive script waits for the same prompts as the expect scripts', () => {
    const source = conptyDriverSource()
    expect(source).toContain('to confirm you saved it: ')
    expect(source).toContain('Type decrypt to go on: ')
    expect(source).toContain(CODE_PATTERN)
    expect(source).toContain('PtyProcess')
    for (const code of [2, 3, 4, 5, 6]) expect(source).toContain(`sys.exit(${code})`)
  })

  test('the drive script never prints what the program wrote', () => {
    const source = conptyDriverSource()
    expect(source).not.toMatch(/\bprint\(/)
    expect(source).not.toContain('sys.stdout.write')
  })

  test('setup pins pywinpty to the version the platform names', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf8')
    expect(PYWINPTY_VERSION).toBe('2.0.15')
    expect(script).toContain(`pywinpty==${PYWINPTY_VERSION}`)
  })

  test('cleanup removes every entry the store can hold', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf8')
    expect(script).toContain('KinfoldDaemon')
    for (const ref of ['db-key', 'db-key-next', 'hmac-master', 'hmac-legacy', 'openrouter']) {
      expect(script).toMatch(new RegExp(`\\b${ref}\\b`))
    }
    expect(script).toContain("cmdkey /delete:kinfold/")
    expect(script).toContain('kinfold/live-')
  })

  test('setup runs every Windows live test with its flag', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf8')
    for (const flag of ['KINFOLD_TEST_CREDENTIAL_MANAGER=1', 'KINFOLD_TEST_WINDOWS_DISK=1', 'KINFOLD_TEST_WINDOWS_ACL=1', 'KINFOLD_TEST_WINDOWS_TASK=1']) {
      expect(script).toContain(flag)
    }
    for (const file of [
      './src/secrets/stores/credential-manager.live.test.ts',
      './src/install/disk/bitlocker.live.test.ts',
      './src/install/access/windows-acl.live.test.ts',
      './src/install/service/scheduled-task-service.live.test.ts',
    ]) {
      expect(script).toContain(file)
      expect(existsSync(join(import.meta.dir, '..', '..', file))).toBe(true)
    }
  })

  test('status after install must show the running task and the ok access list', () => {
    const world = { dataDir: 'C:\\h\\.kinfold' } as SmokeWorld
    expect(smokePlatform.statusLines?.(world)).toEqual([
      'service (scheduled task): config present; running: yes',
      'data dir C:\\h\\.kinfold: access list ok (only you, SYSTEM and Administrators can read it)',
    ])
  })

  test('the read route must answer the token only, and failures never carry the token', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kinfold-smoke-read-'))
    try {
      const TOKEN = 'smoke-token-value'
      const world = { dataDir, project: 'C:\\p', marker: 'marker-123' } as SmokeWorld
      const failure = async (fetcher: SmokeFetch): Promise<string> => {
        try {
          await checkReadRoute(world, fetcher)
          return ''
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(SmokeError)
          return (error as SmokeError).message
        }
      }
      expect(await failure(async () => new Response('{}'))).toBe('daemon.json or daemon.token could not be read')
      writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 40_123 }))
      writeFileSync(join(dataDir, 'daemon.token'), `${TOKEN}\n`)

      const calls: { url: string; auth: string | null; cookie: string | null; body: string }[] = []
      /** A daemon that answers the token, and `open` everything else too when it is broken. */
      const daemon = (open: boolean, found = true): SmokeFetch => async (url, init) => {
        const headers = new Headers(init.headers)
        calls.push({ url, auth: headers.get('authorization'), cookie: headers.get('cookie'), body: String(init.body) })
        if (headers.get('authorization') !== `Bearer ${TOKEN}` && !open) return new Response('{}', { status: 401 })
        return Response.json({ structuredContent: { results: found ? [{ id: 1, title: `saw ${world.marker}` }] : [] } })
      }
      expect(await failure(daemon(false))).toBe('')
      expect(calls.map((call) => call.url)).toEqual(Array(3).fill('http://127.0.0.1:40123/read/search'))
      expect(calls.map((call) => call.auth)).toEqual([`Bearer ${TOKEN}`, null, null])
      expect(calls.map((call) => call.cookie !== null)).toEqual([false, false, true])
      expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ args: { query: 'marker-123' }, cwd: 'C:\\p' })

      const messages = [
        await failure(daemon(true)),
        await failure(daemon(false, false)),
        await failure(async () => new Response('{}', { status: 500 })),
        await failure(async () => {
          throw new TypeError('refused')
        }),
      ]
      expect(messages).toEqual([
        'POST /read/search with no token answered 200, not 401',
        'POST /read/search with the token did not return the hook event',
        'POST /read/search with the token answered 500',
        'POST /read/search did not answer (TypeError)',
      ])
      for (const message of messages) expect(message).not.toContain(TOKEN)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
