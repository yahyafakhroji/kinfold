import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALL_SH = join(import.meta.dir, 'install.sh')
const SH = process.platform === 'win32' ? null : Bun.which('sh')
const shellTest = test.skipIf(SH === null)
const BASE_REFUSAL =
  'kinfold: KINFOLD_RELEASE_BASE must be http://127.0.0.1 with an optional port and path, or a file:// URL with an absolute path\n'

let roots: string[] = []
let servers: Array<{ stop(force?: boolean): void }> = []

afterEach(() => {
  for (const server of servers) server.stop(true)
  servers = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const UNAME = `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "\${KINFOLD_TEST_OS:-Linux}" ;;
  -m) printf '%s\\n' "\${KINFOLD_TEST_MACHINE:-x86_64}" ;;
  *) printf '%s\\n' "\${KINFOLD_TEST_OS:-Linux}" ;;
esac
`

const LDD = `#!/bin/sh
printf '%s\\n' "\${KINFOLD_TEST_LDD:-glibc}"
`

function fakeProgram(exitCode = 0): Uint8Array {
  return new TextEncoder().encode(`#!/bin/sh
printf '%s\\n' "$@" > "$KINFOLD_TEST_ARGS"
printf '%s\\n' "\${KINFOLD_INSTALL_CHANNEL:-}" > "$KINFOLD_TEST_ARGS.channel"
cat > "$KINFOLD_TEST_STDIN"
exit ${exitCode}
`)
}

/** Stands in for curl and wget so a refusal can be proven to make no network call. */
function fakeNetworkCommand(logPath: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "${logPath}"
exit 1
`
}

function sumsFor(entries: Record<string, Uint8Array>): string {
  return `${Object.entries(entries)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join('\n')}\n`
}

const REQUIRED_TOOLS = ['ls', 'mktemp', 'curl', 'tr', 'awk', 'cut', 'rm', 'chmod', 'cp']

/** A PATH that has the shell tools the script needs but neither hash program. */
function hashFreeTools(root: string): string {
  const dir = join(root, 'tools')
  mkdirSync(dir)
  for (const name of REQUIRED_TOOLS) {
    const real = Bun.which(name)
    if (real !== null) symlinkSync(real, join(dir, name))
  }
  return dir
}

interface Release {
  url: string
  origin: string
  requests: string[]
}

function releaseServer(files: Record<string, string | Uint8Array>, prefix = '/release'): Release {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      const body = files[path]
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
    },
  })
  servers.push(server)
  const origin = `http://127.0.0.1:${server.port}`
  return { url: `${origin}${prefix}`, origin, requests }
}

interface InstallRun {
  exitCode: number
  stdout: string
  stderr: string
  argsPath: string
  received: string[] | null
  root: string
  networkCalls: string[]
}

async function runInstall(options: {
  base?: string
  os?: string
  machine?: string
  ldd?: string
  args?: string[]
  extraEnv?: Record<string, string>
  fakeNetwork?: boolean
  restrictedTools?: boolean
}): Promise<InstallRun> {
  const root = temp('kinfold-install-')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of [['uname', UNAME], ['ldd', LDD]] as const) {
    const path = join(bin, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  const networkLog = join(root, 'network.log')
  if (options.fakeNetwork === true) {
    for (const name of ['curl', 'wget']) {
      const path = join(bin, name)
      writeFileSync(path, fakeNetworkCommand(networkLog))
      chmodSync(path, 0o755)
    }
  }
  const path = options.restrictedTools === true ? `${bin}:${hashFreeTools(root)}` : `${bin}:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`
  const argsPath = join(root, 'received.txt')
  const child = Bun.spawn([SH!, INSTALL_SH, ...(options.args ?? [])], {
    cwd: join(import.meta.dir, '..'),
    env: {
      PATH: path,
      HOME: root,
      TMPDIR: root,
      KINFOLD_TEST_OS: options.os ?? 'Linux',
      KINFOLD_TEST_MACHINE: options.machine ?? 'x86_64',
      KINFOLD_TEST_LDD: options.ldd ?? 'glibc',
      KINFOLD_TEST_ARGS: argsPath,
      KINFOLD_TEST_STDIN: join(root, 'stdin.txt'),
      KINFOLD_RELEASE_BASE: options.base ?? 'http://127.0.0.1:1',
      // A test never reads the terminal of whoever runs it.
      KINFOLD_TTY: join(root, 'no-terminal'),
      ...options.extraEnv,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return {
    exitCode,
    stdout,
    stderr,
    argsPath,
    received: existsSync(argsPath) ? readFileSync(argsPath, 'utf8').trim().split('\n') : null,
    root,
    networkCalls: existsSync(networkLog) ? readFileSync(networkLog, 'utf8').trim().split('\n') : [],
  }
}

function leftoverTempDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith('kinfold-install.'))
}

function unsupported(host: string): string {
  return `kinfold: no build for ${host}. Supported: macOS (arm64, x64), Linux glibc (x64, arm64), Windows x64.\n`
}

shellTest('Linux x64 picks the asset from uname, checks the hash and runs install with the arguments', async () => {
  const program = fakeProgram(3)
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': program }),
    '/release/kinfold-linux-x64': program,
  })

  const run = await runInstall({ base: release.url, args: ['--dry-run', '--yes'] })

  expect(run.exitCode).toBe(3)
  expect(run.stdout).toBe('')
  expect(run.stderr).toBe('')
  expect(release.requests).toEqual(['/release/SHA256SUMS', '/release/kinfold-linux-x64'])
  expect(run.received).toEqual(['install', '--dry-run', '--yes'])
})

shellTest('curl | sh gives the wizard the terminal', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': program }),
    '/release/kinfold-linux-x64': program,
  })
  const terminal = join(temp('kinfold-tty-'), 'tty')
  writeFileSync(terminal, 'typed at the terminal\n')

  const run = await runInstall({ base: release.url, extraEnv: { KINFOLD_TTY: terminal } })

  expect(run.exitCode).toBe(0)
  expect(readFileSync(join(run.root, 'stdin.txt'), 'utf8')).toBe('typed at the terminal\n')
  expect(readFileSync(`${run.argsPath}.channel`, 'utf8')).toBe('curl\n')
})

shellTest('with no readable terminal the program keeps the stdin it was given', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': program }),
    '/release/kinfold-linux-x64': program,
  })

  const run = await runInstall({ base: release.url })

  expect(run.exitCode).toBe(0)
  expect(readFileSync(join(run.root, 'stdin.txt'), 'utf8')).toBe('')
})

shellTest('--credential-stdin keeps the caller stdin even when a terminal is readable', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': program }),
    '/release/kinfold-linux-x64': program,
  })
  const terminal = join(temp('kinfold-tty-'), 'tty')
  writeFileSync(terminal, 'typed at the terminal\n')

  const run = await runInstall({ base: release.url, args: ['--credential-stdin'], extraEnv: { KINFOLD_TTY: terminal } })

  expect(run.exitCode).toBe(0)
  expect(readFileSync(join(run.root, 'stdin.txt'), 'utf8')).toBe('')
})

shellTest('Darwin arm64 picks the darwin arm64 asset', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-darwin-arm64': program }),
    '/release/kinfold-darwin-arm64': program,
  })

  const run = await runInstall({ base: release.url, os: 'Darwin', machine: 'arm64' })

  expect(run.exitCode).toBe(0)
  expect(release.requests).toContain('/release/kinfold-darwin-arm64')
  expect(run.received).toEqual(['install'])
})

shellTest('a bare loopback origin with a port is accepted', async () => {
  const program = fakeProgram()
  const release = releaseServer(
    {
      '/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': program }),
      '/kinfold-linux-x64': program,
    },
    '',
  )

  const run = await runInstall({ base: release.origin })

  expect(run.exitCode).toBe(0)
  expect(release.requests).toEqual(['/SHA256SUMS', '/kinfold-linux-x64'])
  expect(run.received).toEqual(['install'])
})

shellTest('a mismatched hash refuses before the program runs', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': new TextEncoder().encode('other') }),
    '/release/kinfold-linux-x64': program,
  })

  const run = await runInstall({ base: release.url })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain('does not match SHA256SUMS')
  expect(run.received).toBeNull()
})

shellTest('a failed install removes its temporary folder', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': new TextEncoder().encode('other') }),
    '/release/kinfold-linux-x64': program,
  })

  const run = await runInstall({ base: release.url })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toBe('kinfold: the downloaded kinfold-linux-x64 does not match SHA256SUMS; nothing was installed\n')
  expect(leftoverTempDirs(run.root)).toEqual([])
})

shellTest('a program missing from SHA256SUMS refuses before it runs', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-other': program }),
    '/release/kinfold-linux-x64': program,
  })

  const run = await runInstall({ base: release.url })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain('SHA256SUMS has no entry for kinfold-linux-x64')
  expect(run.received).toBeNull()
})

shellTest('a missing sha256 tool refuses instead of skipping the check', async () => {
  const program = fakeProgram()
  const release = releaseServer({
    '/release/SHA256SUMS': sumsFor({ 'kinfold-linux-x64': program }),
    '/release/kinfold-linux-x64': program,
  })

  const run = await runInstall({ base: release.url, restrictedTools: true })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toBe('kinfold: install needs sha256sum or shasum\n')
  expect(run.received).toBeNull()
  expect(release.requests).toEqual(['/release/SHA256SUMS', '/release/kinfold-linux-x64'])
  expect(leftoverTempDirs(run.root)).toEqual([])
})

shellTest('Linux musl prints the same unsupported message and downloads nothing', async () => {
  const release = releaseServer({})

  const run = await runInstall({ base: release.url, ldd: 'musl libc (x86_64)' })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toBe(unsupported('linux-x64'))
  expect(release.requests).toEqual([])
})

shellTest('an unsupported system prints the same message', async () => {
  const run = await runInstall({ os: 'FreeBSD', machine: 'x86_64' })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toBe(unsupported('freebsd-x64'))
})

shellTest('a base URL that is not loopback is refused once, before any request', async () => {
  const release = releaseServer({})

  const run = await runInstall({ base: 'https://example.invalid/releases', fakeNetwork: true })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toBe(BASE_REFUSAL)
  expect(run.networkCalls).toEqual([])
  expect(release.requests).toEqual([])
  expect(leftoverTempDirs(run.root)).toEqual([])
  expect(run.received).toBeNull()
})

const REFUSED_BASES = [
  'http://127.0.0.1.evil.com',
  'http://127.0.0.10',
  'http://127.0.0.1@evil.com',
  'http://127.0.0.1:99999.evil',
  'https://127.0.0.1',
  'http://localhost',
]

for (const base of REFUSED_BASES) {
  shellTest(`the release base ${base} is refused without a network call`, async () => {
    const release = releaseServer({})

    const run = await runInstall({ base, fakeNetwork: true })

    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe(BASE_REFUSAL)
    expect(run.networkCalls).toEqual([])
    expect(release.requests).toEqual([])
    expect(leftoverTempDirs(run.root)).toEqual([])
    expect(run.received).toBeNull()
  })
}

shellTest('a file URL release base is accepted', async () => {
  const root = temp('kinfold-install-file-')
  const program = fakeProgram()
  writeFileSync(join(root, 'SHA256SUMS'), sumsFor({ 'kinfold-darwin-x64': program }))
  writeFileSync(join(root, 'kinfold-darwin-x64'), program)

  const run = await runInstall({ base: `file://${root}`, os: 'Darwin', machine: 'x86_64' })

  expect(run.exitCode).toBe(0)
  expect(run.received).toEqual(['install'])
})
