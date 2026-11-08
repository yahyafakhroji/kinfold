import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALL_SH = join(import.meta.dir, 'install.sh')
const SH = process.platform === 'win32' ? null : Bun.which('sh')
const shellTest = test.skipIf(SH === null)

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
cat > "$KINFOLD_TEST_STDIN"
exit ${exitCode}
`)
}

function sumsFor(entries: Record<string, Uint8Array>): string {
  return `${Object.entries(entries)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join('\n')}\n`
}

interface Release {
  url: string
  requests: string[]
}

function releaseServer(files: Record<string, string | Uint8Array>): Release {
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
  return { url: `http://127.0.0.1:${server.port}/release`, requests }
}

interface InstallRun {
  exitCode: number
  stdout: string
  stderr: string
  argsPath: string
  received: string[] | null
}

async function runInstall(options: {
  base?: string
  os?: string
  machine?: string
  ldd?: string
  args?: string[]
  extraEnv?: Record<string, string>
}): Promise<InstallRun> {
  const root = temp('kinfold-install-')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of [['uname', UNAME], ['ldd', LDD]] as const) {
    const path = join(bin, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  const argsPath = join(root, 'received.txt')
  const child = Bun.spawn([SH!, INSTALL_SH, ...(options.args ?? [])], {
    cwd: join(import.meta.dir, '..'),
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`,
      HOME: root,
      TMPDIR: root,
      KINFOLD_TEST_OS: options.os ?? 'Linux',
      KINFOLD_TEST_MACHINE: options.machine ?? 'x86_64',
      KINFOLD_TEST_LDD: options.ldd ?? 'glibc',
      KINFOLD_TEST_ARGS: argsPath,
      KINFOLD_TEST_STDIN: join(root, 'stdin.txt'),
      KINFOLD_RELEASE_BASE: options.base ?? 'http://127.0.0.1:1',
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
  }
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

shellTest('a base URL that is not local is refused', async () => {
  const run = await runInstall({ base: 'https://example.invalid/releases' })

  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain('KINFOLD_RELEASE_BASE must start with http://127.0.0.1 or file://')
})

shellTest('a file URL release base is accepted', async () => {
  const root = temp('kinfold-install-file-')
  const program = fakeProgram()
  writeFileSync(join(root, 'SHA256SUMS'), sumsFor({ 'kinfold-darwin-x64': program }))
  writeFileSync(join(root, 'kinfold-darwin-x64'), program)

  const run = await runInstall({ base: `file://${root}`, os: 'Darwin', machine: 'x86_64' })

  expect(run.exitCode).toBe(0)
  expect(run.received).toEqual(['install'])
})
