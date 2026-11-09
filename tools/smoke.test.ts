import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { SmokeError, childEnvironment, descendantsOf, ensurePortFree, homeForSmoke, smoke } from './smoke'
import type { SmokeDeps } from './smoke'
import { smokePlatform as macos } from './smoke/macos'
import { loadSmokePlatform } from './smoke/platform'
import type { SmokePlatform, SmokeResult, SmokeWorld } from './smoke/platform'

describe('homeForSmoke', () => {
  test('refuses a real home without GitHub Actions', () => {
    expect(() => homeForSmoke({ HOME: '/Users/example' })).toThrow(SmokeError)
  })

  test('allows a real home on GitHub Actions', () => {
    expect(homeForSmoke({ HOME: '/Users/example', GITHUB_ACTIONS: 'true' })).toBe('/Users/example')
  })

  test('refuses a temporary home without GitHub Actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kinfold-smoke-test-'))
    try {
      expect(() => homeForSmoke({ HOME: root })).toThrow(SmokeError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a missing HOME', () => {
    expect(() => homeForSmoke({})).toThrow(SmokeError)
  })
})

describe('ensurePortFree', () => {
  test('refuses a port already in use', () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      expect(() => ensurePortFree(server.port)).toThrow(SmokeError)
    } finally {
      server.stop(true)
    }
  })
})

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(() => null, (caught: unknown) => caught)
}

function isNoStepsError(error: unknown): boolean {
  return error instanceof SmokeError && error.message.startsWith('no smoke steps')
}

/** Writes one platform file into a fresh folder and loads it from there. */
async function loadFrom(name: string, text: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'kinfold-smoke-platform-'))
  try {
    writeFileSync(join(dir, `${name}.ts`), text)
    return await rejection(loadSmokePlatform(name, dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('descendantsOf', () => {
  const PS = [
    '    1     0 10-00:00:00 /sbin/launchd',
    '  500     1    05:00 /bin/zsh',
    '  600   500    03:00 /dist/kinfold install --yes',
    '  610   600    02:59 /usr/local/bin/claude mcp add-json --scope user kinfold {}',
    '  620   610    02:58 node /usr/local/lib/claude/cli.js',
    '  630   600    02:00 /usr/bin/security find-generic-password -s kinfold -w',
    '  640   600    01:00 /usr/bin/security add-generic-password -s kinfold -w hunter2 -U',
    '  700   500    01:00 /bin/sleep 100',
    'not a ps row',
    '',
  ].join('\n')

  test('lists the timed-out process and everything under it, parent first', () => {
    const tree = descendantsOf(PS, 600)
    expect(tree.map((line) => line.split(/\s+/)[0])).toEqual(['600', '610', '620', '630', '640'])
    expect(tree[0]).toBe('600   500    03:00 /dist/kinfold install --yes')
  })

  test('leaves out siblings, parents and lines that are not rows', () => {
    const tree = descendantsOf(PS, 600).join('\n')
    expect(tree).not.toContain('/bin/sleep')
    expect(tree).not.toContain('/bin/zsh')
    expect(tree).not.toContain('not a ps row')
  })

  test('never shows a password flag value', () => {
    const tree = descendantsOf(PS, 600).join('\n')
    expect(tree).not.toContain('hunter2')
    expect(tree).toContain('-w <redacted> -U')
  })

  test('a pid that is gone gives an empty tree', () => {
    expect(descendantsOf(PS, 999)).toEqual([])
  })
})

describe('loadSmokePlatform', () => {
  test('a platform without steps stops at setup', async () => {
    const error = await rejection(loadSmokePlatform('plan9'))
    expect(error).toBeInstanceOf(SmokeError)
    expect((error as SmokeError).step).toBe('setup')
    expect((error as SmokeError).message).toBe('no smoke steps for plan9 yet')
  })

  test('a platform file that does not build fails loudly', async () => {
    const error = await loadFrom('broken', 'export const smokePlatform = \n')
    expect(error).toBeInstanceOf(Error)
    expect(isNoStepsError(error)).toBe(false)
  })

  test('a platform file whose own import is missing fails loudly', async () => {
    const error = await loadFrom('nested', "import { x } from './absent.ts'\nexport const smokePlatform = x\n")
    expect(error).toBeInstanceOf(Error)
    expect(isNoStepsError(error)).toBe(false)
  })

  test('a platform file without the export fails loudly', async () => {
    const error = await loadFrom('empty', 'export const other = 1\n')
    expect(error).toBeInstanceOf(SmokeError)
    expect((error as SmokeError).message).toBe('the smoke steps for empty do not export smokePlatform')
  })

  test('a name that is not a plain word is refused', async () => {
    const error = await rejection(loadSmokePlatform('../smoke'))
    expect(error).toBeInstanceOf(SmokeError)
    expect((error as SmokeError).step).toBe('setup')
    expect(isNoStepsError(error)).toBe(false)
  })

  test('macos loads its own steps', async () => {
    expect((await loadSmokePlatform('macos')).name).toBe('macos')
  })
})

describe('macOS smoke platform', () => {
  test('the macOS steps name the LaunchAgent and the keychain', () => {
    expect(macos.programName).toBe('kinfold')
    expect(macos.keyStoreLabel).toBe('keychain')
    expect(macos.serviceFiles('/h')).toEqual(['/h/Library/LaunchAgents/dev.kinfold.daemon.plist'])
  })

  test('macOS defines none of the optional hooks', () => {
    expect(macos.runConversion).toBeUndefined()
    expect(macos.foregroundDaemon).toBeUndefined()
    expect(macos.childEnv).toBeUndefined()
    expect(macos.writeObserverShim).toBeUndefined()
  })
})

function fakePlatform(overrides: Partial<SmokePlatform> = {}): SmokePlatform {
  return {
    name: 'macos',
    programName: 'kinfold',
    keyStoreLabel: 'keychain',
    serviceLoaded: () => false,
    serviceFiles: (home) => [join(home, 'service-file')],
    ...overrides,
  }
}

describe('childEnvironment', () => {
  test("a platform's child env is merged after the driver's own", () => {
    const env = childEnvironment('/home/smoke', '/fake/bin', fakePlatform({ childEnv: () => ({ EXTRA: '1', HOME: '/other' }) }))
    expect(env.EXTRA).toBe('1')
    expect(env.HOME).toBe('/other')
  })

  test("without the hook the map is the driver's own", () => {
    const expected: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) expected[key] = value
    }
    expected.HOME = '/home/smoke'
    expected.PATH = `/fake/bin${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`.trim()
    for (const key of ['KINFOLD_DATA_DIR', 'SAM_DATA_DIR', 'KINFOLD_PORT', 'SAM_PORT', 'KINFOLD_DB_KEYSTORE', 'SAM_DB_KEYSTORE']) delete expected[key]
    expect(childEnvironment('/home/smoke', '/fake/bin', fakePlatform())).toEqual(expected)
  })
})

interface Recorder {
  calls: string[]
  daemonRunning: boolean
  shimSeenAtInstall: boolean | null
}

function newRecorder(): Recorder {
  return { calls: [], daemonRunning: false, shimSeenAtInstall: null }
}

function ok(stdout = ''): SmokeResult {
  return { code: 0, stdout, stderr: '' }
}

/** Answers the MCP exchange the way the stdio server does, citing the marker the search asks for. */
function mcpReply(world: SmokeWorld, stdin: string): SmokeResult {
  const lines = stdin.trim().split('\n').map((line) => JSON.parse(line) as { params?: { name?: string } })
  const tool = lines[1]?.params?.name
  const result = tool === 'search'
    ? { structuredContent: { results: [{ id: 7, title: `Smoke event ${world.marker}` }] } }
    : { structuredContent: { observations: [{ narrative: `The program carried ${world.marker} into memory.` }] } }
  return ok(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, result })}\n`)
}

function statusText(encrypted: boolean): string {
  return [
    'daemon /health: up on 127.0.0.1:37811 (pid 1)',
    '  claude-code: version 2, wired: yes',
    '  opencode: version 2, wired: yes',
    encrypted ? 'database: encrypted (keychain db-key present)' : 'database: plaintext',
    '',
  ].join('\n')
}

type Kinfold = NonNullable<SmokeDeps['kinfold']>
type Conversion = NonNullable<SmokeDeps['runConversion']>

function recordingDeps(recorder: Recorder): { kinfold: Kinfold; runConversion: Conversion } {
  let encrypted = true
  return {
    kinfold: async (world, args, stdin) => {
      // The status probe runs in its own empty home before install.
      const command = world.home.endsWith('probe-home') ? `probe:${args[0] ?? ''}` : args[0] ?? ''
      recorder.calls.push(command)
      if (command === '--version') return ok('0.0.0-dev\n')
      if (command === 'install') {
        recorder.shimSeenAtInstall = existsSync(join(world.fakeBin, 'claude'))
        mkdirSync(join(world.dataDir, 'bin'), { recursive: true })
        writeFileSync(join(world.dataDir, 'bin', 'kinfold'), '')
        return ok('observer claude-code: claude-cli/haiku (flag)\nobserver opencode: claude-cli/haiku (flag)\n')
      }
      if (command === 'status') return ok(statusText(encrypted))
      if (command === 'mcp') return mcpReply(world, stdin ?? '')
      if (command === 'uninstall') rmSync(join(world.dataDir, 'bin'), { recursive: true, force: true })
      return ok()
    },
    runConversion: async (_world, operation) => {
      if (recorder.daemonRunning) throw new Error(`${operation} ran while the foreground daemon was started`)
      recorder.calls.push(operation)
      encrypted = operation === 'encrypt'
      return ok()
    },
  }
}

function recordingDaemon(recorder: Recorder): NonNullable<SmokePlatform['foregroundDaemon']> {
  return async () => {
    recorder.calls.push('fg-start')
    recorder.daemonRunning = true
    return {
      stop: async () => {
        recorder.calls.push('fg-stop')
        recorder.daemonRunning = false
      },
    }
  }
}

/**
 * A temp home, a stand-in program and a stand-in claude, with port 0 for the
 * port guard, so the run never meets the real home, port 37811 or CLI.
 */
async function runSmoke(platform: SmokePlatform, deps: { kinfold: Kinfold; runConversion: Conversion }): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-smoke-order-'))
  try {
    const program = join(root, 'kinfold')
    writeFileSync(program, '')
    const cliBin = join(root, 'cli')
    const home = join(root, 'home')
    mkdirSync(cliBin)
    mkdirSync(home)
    writeFileSync(join(cliBin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
    // Bun.which looks for a PATHEXT extension on Windows.
    writeFileSync(join(cliBin, 'claude.cmd'), '@echo off\r\n')
    await smoke(program, platform, { ...deps, env: { HOME: home, GITHUB_ACTIONS: 'true', PATH: cliBin }, port: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const SERVICE_ORDER = ['--version', 'probe:status', 'install', 'status', 'hook', 'decrypt', 'status', 'encrypt', 'status', 'uninstall']

function withoutSearches(calls: readonly string[]): string[] {
  return calls.filter((call) => call !== 'mcp')
}

describe('smoke order', () => {
  test('a foreground daemon is stopped around each conversion', async () => {
    const recorder = newRecorder()
    await runSmoke(fakePlatform({ foregroundDaemon: recordingDaemon(recorder) }), recordingDeps(recorder))
    expect(withoutSearches(recorder.calls)).toEqual([
      '--version', 'probe:status',
      'install', 'fg-start', 'status', 'hook', 'fg-stop',
      'decrypt', 'fg-start', 'status', 'fg-stop',
      'encrypt', 'fg-start', 'status', 'fg-stop',
      'uninstall',
    ])
    expect(recorder.calls).toContain('mcp')
    expect(recorder.daemonRunning).toBe(false)
  })

  test('without a foreground daemon the order is the service run', async () => {
    const recorder = newRecorder()
    await runSmoke(fakePlatform(), recordingDeps(recorder))
    expect(withoutSearches(recorder.calls)).toEqual(SERVICE_ORDER)
    expect(recorder.shimSeenAtInstall).toBe(true)
  })

  test("a platform's observer shim replaces the sh one", async () => {
    const recorder = newRecorder()
    const shimCalls: (string | null)[] = []
    const platform = fakePlatform({
      writeObserverShim: async (_world, realClaude) => {
        shimCalls.push(realClaude)
      },
    })
    await runSmoke(platform, recordingDeps(recorder))
    expect(shimCalls.length).toBe(1)
    expect(recorder.shimSeenAtInstall).toBe(false)
    expect(withoutSearches(recorder.calls)).toEqual(SERVICE_ORDER)
  })

  test('a failure while the foreground daemon runs stops it before the cleanup uninstall', async () => {
    const recorder = newRecorder()
    const deps = recordingDeps(recorder)
    const failingHook: Kinfold = async (world, args, stdin) => {
      if (args[0] !== 'hook') return await deps.kinfold(world, args, stdin)
      recorder.calls.push('hook')
      return { code: 1, stdout: '', stderr: 'hook broke' }
    }
    const error = await rejection(runSmoke(fakePlatform({ foregroundDaemon: recordingDaemon(recorder) }), { ...deps, kinfold: failingHook }))
    expect(error).toBeInstanceOf(SmokeError)
    expect((error as SmokeError).step).toBe('hook')
    expect(recorder.calls).toEqual(['--version', 'probe:status', 'install', 'fg-start', 'status', 'hook', 'fg-stop', 'uninstall'])
  })

  test('a compiled program that never finishes status fails before install, in its own step', async () => {
    const recorder = newRecorder()
    const deps = recordingDeps(recorder)
    const limits: (number | undefined)[] = []
    const spinning: Kinfold = async (world, args, stdin, timeoutMs) => {
      if (!world.home.endsWith('probe-home')) return await deps.kinfold(world, args, stdin)
      limits.push(timeoutMs)
      expect(world.env.HOME).toBe(world.home)
      throw new SmokeError('timeout', `${world.program} did not finish in ${timeoutMs} ms`)
    }
    const error = await rejection(runSmoke(fakePlatform(), { ...deps, kinfold: spinning }))
    expect(error).toBeInstanceOf(SmokeError)
    expect((error as SmokeError).step).toBe('compiled')
    expect((error as SmokeError).message).toContain('status in an empty home did not finish in 20 s')
    expect(limits).toEqual([20_000])
    // Nothing was installed, so the cleanup does not uninstall either.
    expect(recorder.calls).toEqual(['--version'])
  })
})
