// Runs the built program through install, a hook, MCP search, encryption and
// uninstall against the home CI gives it. It is the smoke job's body on every
// OS that has a steps file under tools/smoke/: each step prints as it passes,
// the first mismatch stops the run, and a finally block always tries to
// uninstall and remove the temporary folder.
// A real home is refused unless GitHub Actions is running, so a local run
// cannot install into a developer's home. What differs per OS (the service, the
// key store label, the program name) comes from tools/smoke/<os>.ts.
//
// The job installs the agent CLIs, but nothing can log in there, so the
// observer stands in for a logged-in one: a small `claude` wrapper in front of
// the real CLI answers only the observer's print call. Every other call goes
// to the installed CLI, which is why the hook and MCP wiring are still real.
//
// Usage: bun tools/smoke.ts <program path>

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { currentPlatform } from '../src/platform/platform'
import { SmokeError, loadSmokePlatform } from './smoke/platform'
import type { SmokePlatform, SmokeResult, SmokeWorld } from './smoke/platform'

export { SmokeError }
export type { SmokeResult, SmokeWorld }

const DEFAULT_PORT = 37_811
const PROGRAM_TIMEOUT_MS = 180_000
const SHORT_TIMEOUT_MS = 20_000
const SEARCH_TIMEOUT_MS = 45_000
const SEARCH_POLL_MS = 500
const OUTPUT_LIMIT = 6_000

/** The smoke writes to the default keychain and the launchd user domain, so it only runs on an ephemeral CI runner. */
export function homeForSmoke(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? ''
  if (home === '') throw new SmokeError('setup', 'HOME is not set; the smoke needs a home to install into')
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new SmokeError('setup', 'the smoke touches the keychain and launchd; it only runs on GitHub Actions (set GITHUB_ACTIONS=true)')
  }
  return home
}

export interface SmokeDeps {
  kinfold?: (world: SmokeWorld, args: readonly string[], stdin?: string) => Promise<SmokeResult>
  /** Test seam for the pty conversion; default platform.runConversion, else the expect-based one. */
  runConversion?: (world: SmokeWorld, operation: 'encrypt' | 'decrypt') => Promise<SmokeResult>
  /** Where HOME, PATH (to find claude) and KINFOLD_RELEASE_SUMS_URL are read; default process.env. */
  env?: NodeJS.ProcessEnv
  /** The port that must be free before install; default 37811. */
  port?: number
}

/** The steps' view of one run: the world plus the seams resolved once. */
interface Run {
  world: SmokeWorld
  platform: SmokePlatform
  kinfold: (world: SmokeWorld, args: readonly string[], stdin?: string) => Promise<SmokeResult>
  runConversion: (world: SmokeWorld, operation: 'encrypt' | 'decrypt') => Promise<SmokeResult>
  daemon: ForegroundDaemon
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cap(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}<truncated>`
}

/** The command's own output, trimmed to a readable tail. Secrets never reach this path: encrypt output is not printed. */
function describe(result: SmokeResult): string {
  const parts = [
    result.stdout.trim() === '' ? '' : `stdout:\n${cap(result.stdout.trim())}`,
    result.stderr.trim() === '' ? '' : `stderr:\n${cap(result.stderr.trim())}`,
  ].filter((part) => part !== '')
  return parts.join('\n')
}

export function childEnvironment(home: string, fakeBin: string, platform: SmokePlatform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.HOME = home
  env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`.trim()
  // The data folder and the port are fixed by the smoke, so a caller's
  // environment must not move the run to another store or another daemon.
  delete env.KINFOLD_DATA_DIR
  delete env.SAM_DATA_DIR
  delete env.KINFOLD_PORT
  delete env.SAM_PORT
  delete env.KINFOLD_DB_KEYSTORE
  delete env.SAM_DB_KEYSTORE
  return { ...env, ...platform.childEnv?.(home) }
}

interface RunOptions {
  cwd: string
  env: Record<string, string>
  stdin?: string
  timeoutMs?: number
  /** Adds what the command printed to a timeout error; never set for the key conversions, whose output holds the recovery code. */
  showOutputOnTimeout?: boolean
}

async function run(argv: readonly string[], options: RunOptions): Promise<SmokeResult> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs ?? PROGRAM_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([
      child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : '',
      child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : '',
      child.exited,
    ])
    if (timedOut) {
      const output = options.showOutputOnTimeout === true ? describe({ code: -1, stdout, stderr }) : ''
      throw new SmokeError('timeout', `${argv[0]} did not finish in ${options.timeoutMs ?? PROGRAM_TIMEOUT_MS} ms${output === '' ? '' : `\n${output}`}`)
    }
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

// The version probe and each MCP exchange answer at once, so they get the
// short limit; install and the rest may wait on downloads and the service.
function timeoutFor(args: readonly string[]): number {
  return args[0] === '--version' || args[0] === 'mcp' ? SHORT_TIMEOUT_MS : PROGRAM_TIMEOUT_MS
}

async function kinfold(world: SmokeWorld, args: readonly string[], stdin?: string): Promise<SmokeResult> {
  return await run([world.program, ...args], {
    cwd: world.project,
    env: world.env,
    timeoutMs: timeoutFor(args),
    showOutputOnTimeout: true,
    ...(stdin !== undefined ? { stdin } : {}),
  })
}

function expectOk(step: string, result: SmokeResult): void {
  if (result.code === 0) return
  const output = describe(result)
  throw new SmokeError(step, `the program exited ${result.code}${output === '' ? '' : `\n${output}`}`)
}

function expectContains(step: string, text: string, needle: string | RegExp): void {
  const found = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
  if (!found) throw new SmokeError(step, `the output did not contain ${String(needle)}\n${cap(text)}`)
}

/** The job must not meet another daemon on the fixed port; silently moving ports would test a different program. */
export function ensurePortFree(port: number): void {
  let server: { stop(force?: boolean): void } | null = null
  try {
    server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
  } catch {
    throw new SmokeError('port', `127.0.0.1:${port} is already in use; the smoke needs the default port and will not move to another one`)
  } finally {
    server?.stop(true)
  }
}

function shQuote(value: string): string {
  if (value.includes("'")) throw new SmokeError('setup', 'a path used by the smoke contains a single quote')
  return `'${value}'`
}

/**
 * The observer needs a model reply and nothing can log in. The wrapper answers
 * only the print call with one observation that cites the event it was given;
 * every other call goes to the real CLI, so version detection and MCP
 * registration keep working.
 */
function writeObserverShim(world: SmokeWorld, realClaude: string | null): void {
  mkdirSync(world.fakeBin, { recursive: true, mode: 0o700 })
  if (realClaude === null) throw new SmokeError('setup', 'claude is not on PATH; the workflow installs it before the smoke')
  const delegate = `exec ${shQuote(realClaude)} "$@"`
  const text = [
    '#!/bin/sh',
    'set -eu',
    'if [ "${1:-}" != "--print" ]; then',
    delegate,
    'fi',
    'input=$(cat)',
    `ids=$(printf '%s\\n' "$input" | sed -n 's/.*Valid event_id values: *//p' | head -n 1)`,
    'id=${ids%%.*}',
    'id=${id%%,*}',
    `id=$(printf '%s' "$id" | tr -d ' ')`,
    `text=$(printf '%s\\n' "$input" | sed -n 's/.*"assistant":"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    'if [ -z "$id" ] || [ -z "$text" ]; then',
    '  exit 1',
    'fi',
    `payload='{"observations":[{"type":"discovery","title":"Smoke event ${world.marker}","narrative":"'"$text"'","facts":["${world.marker}"],"files":[],"evidence":{"strength":"interpretation","sourceEventIds":["'"$id"'"]},"relations":[]}],"summary":null}'`,
    `escaped=$(printf '%s' "$payload" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')`,
    `printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","modelUsage":{"claude-haiku":{}}}\\n' "$escaped"`,
    '',
  ].join('\n')
  const path = join(world.fakeBin, 'claude')
  writeFileSync(path, text, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function jsonObjects(text: string): unknown[] {
  const values: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      values.push(JSON.parse(line))
    } catch {
      // The stdio server writes protocol lines only; anything else is ignored.
    }
  }
  return values
}

function replyFor(stdout: string, id: number): Record<string, unknown> | null {
  for (const value of jsonObjects(stdout)) {
    if (isRecord(value) && value.id === id && isRecord(value.result)) return value.result
  }
  return null
}

/** One stdio MCP exchange: initialize, then the tool call, then close stdin so the server exits. */
async function mcpCall(ctx: Run, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kinfold-smoke', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
  ].map((request) => JSON.stringify(request)).join('\n')
  const result = await ctx.kinfold(ctx.world, ['mcp'], `${requests}\n`)
  if (result.code !== 0) throw new SmokeError('mcp', `the MCP server exited ${result.code}\n${describe(result)}`)
  const reply = replyFor(result.stdout, 2)
  if (reply === null) throw new SmokeError('mcp', `the MCP server did not answer the ${tool} call\n${describe(result)}`)
  if (reply.isError === true) throw new SmokeError('mcp', `the ${tool} call failed\n${cap(JSON.stringify(reply))}`)
  return reply
}

interface SearchHit {
  id: number
  title: string
}

function searchHits(reply: Record<string, unknown>): SearchHit[] {
  const structured = isRecord(reply.structuredContent) ? reply.structuredContent : {}
  const results = Array.isArray(structured.results) ? structured.results : []
  return results.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== 'number' || typeof row.title !== 'string') return []
    return [{ id: row.id, title: row.title }]
  })
}

async function waitForSearch(ctx: Run, step: string): Promise<SearchHit> {
  const { world } = ctx
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  let last: SearchHit[] = []
  for (;;) {
    const reply = await mcpCall(ctx, 'search', { query: world.marker })
    last = searchHits(reply)
    const found = last.find((hit) => hit.title.includes(world.marker))
    if (found !== undefined) return found
    if (Date.now() >= deadline) {
      throw new SmokeError(step, `the hook event did not reach search within ${SEARCH_TIMEOUT_MS} ms; last result(s): ${JSON.stringify(last)}\n${daemonLogTail(world)}`)
    }
    await Bun.sleep(SEARCH_POLL_MS)
  }
}

/** The observation still answers after a key change, with the text the hook carried. */
async function expectEventStillSearchable(ctx: Run, step: string): Promise<void> {
  const { world } = ctx
  const hit = await waitForSearch(ctx, step)
  const fetched = await mcpCall(ctx, 'get_observations', { ids: [hit.id] })
  const structured = isRecord(fetched.structuredContent) ? fetched.structuredContent : {}
  const observations = Array.isArray(structured.observations) ? structured.observations : []
  const first = observations[0]
  const narrative = isRecord(first) && typeof first.narrative === 'string' ? first.narrative : ''
  expectContains(step, narrative, world.marker)
  expectContains(step, narrative, 'carried')
}

function daemonLogTail(world: SmokeWorld): string {
  const path = join(world.dataDir, 'logs', 'daemon.log')
  if (!existsSync(path)) return 'the daemon log does not exist'
  try {
    const text = readFileSync(path, 'utf8')
    return `daemon log tail:\n${cap(text.slice(-OUTPUT_LIMIT))}`
  } catch {
    return 'the daemon log could not be read'
  }
}

/** The interval that converts memory.db needs a terminal; expect supplies one and answers its prompts. */
async function runPty(world: SmokeWorld, operation: 'encrypt' | 'decrypt'): Promise<SmokeResult> {
  const scriptPath = join(world.root, `expect-${operation}.exp`)
  writeFileSync(scriptPath, operation === 'encrypt' ? ENCRYPT_EXPECT : DECRYPT_EXPECT, { mode: 0o600 })
  if (!existsSync('/usr/bin/expect')) throw new SmokeError('setup', '/usr/bin/expect is missing; the key commands need a terminal')
  return await run(['/usr/bin/expect', '-f', scriptPath, world.program], {
    cwd: world.project,
    env: world.env,
    timeoutMs: PROGRAM_TIMEOUT_MS,
  })
}

const ENCRYPT_EXPECT = [
  'set timeout 180',
  'log_user 0',
  'set program [lindex $argv 0]',
  'spawn $program encrypt',
  'expect {',
  '  -re {([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}} {',
  '    set code $expect_out(0,string)',
  '    set groups [split $code "-"]',
  '    set tail "[lindex $groups end-1][lindex $groups end]"',
  '    expect {',
  '      "to confirm you saved it: " {}',
  '      timeout { exit 2 }',
  '      eof { exit 3 }',
  '    }',
  '    send "$tail\\r"',
  '  }',
  '  timeout { exit 4 }',
  '  eof { exit 5 }',
  '}',
  'expect {',
  '  eof {}',
  '  timeout { exit 6 }',
  '}',
  'catch wait result',
  'exit [lindex $result 3]',
  '',
].join('\n')

const DECRYPT_EXPECT = [
  'set timeout 180',
  'log_user 1',
  'set program [lindex $argv 0]',
  'spawn $program decrypt',
  'expect {',
  '  "Type decrypt to go on: " { send "decrypt\\r"; exp_continue }',
  '  eof {}',
  '  timeout { exit 2 }',
  '}',
  'catch wait result',
  'exit [lindex $result 3]',
  '',
].join('\n')

interface ForegroundDaemon {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * The platform's hand-started daemon, or nothing when the service runs it.
 * The conversions replace memory.db and the commands only stop and restart a
 * service they installed, so the driver stops a hand-started daemon around
 * each one itself.
 */
function foregroundDaemon(platform: SmokePlatform, world: SmokeWorld): ForegroundDaemon {
  let running: { stop(): Promise<void> } | null = null
  return {
    async start() {
      if (platform.foregroundDaemon === undefined || running !== null) return
      running = await platform.foregroundDaemon(world)
    },
    async stop() {
      const handle = running
      running = null
      await handle?.stop()
    },
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function encryptedLine(platform: SmokePlatform): RegExp {
  return new RegExp(`^database: encrypted \\(${escapeRegExp(platform.keyStoreLabel)} db-key present\\)`, 'm')
}

async function steps(ctx: Run): Promise<void> {
  const { world, platform, kinfold, daemon } = ctx
  process.stdout.write('smoke: install\n')
  const installed = await kinfold(world, [
    'install',
    '--yes',
    '--hosts', 'claude-code,opencode',
    '--observer', 'claude-code=claude-cli:haiku',
    '--observer', 'opencode=claude-cli:haiku',
    '--skip-check',
  ])
  expectOk('install', installed)
  expectContains('install', installed.stdout, 'observer claude-code: claude-cli/haiku (flag)')
  expectContains('install', installed.stdout, 'observer opencode: claude-cli/haiku (flag)')
  const binPath = join(world.dataDir, 'bin', platform.programName)
  if (!existsSync(binPath)) throw new SmokeError('install', `${binPath} was not installed`)
  await daemon.start()

  process.stdout.write('smoke: status\n')
  const status = await kinfold(world, ['status'])
  expectOk('status', status)
  expectContains('status', status.stdout, /daemon \/health: up on 127\.0\.0\.1:37811\b/)
  expectContains('status', status.stdout, /^ {2}claude-code: .*wired: yes/m)
  expectContains('status', status.stdout, /^ {2}opencode: .*wired: yes/m)
  expectContains('status', status.stdout, encryptedLine(platform))

  process.stdout.write('smoke: hook\n')
  const hook = await kinfold(world, ['hook', '--host', 'claude-code'], `${JSON.stringify({
    session_id: `smoke-${world.marker}`,
    cwd: world.project,
    hook_event_name: 'Stop',
    last_assistant_message: `The compiled program carried ${world.marker} through the hook into memory.`,
  })}\n`)
  expectOk('hook', hook)

  process.stdout.write('smoke: search\n')
  await expectEventStillSearchable(ctx, 'search')

  // A new install creates the store encrypted, so decrypt comes first; the
  // pair then covers both conversions and the recovery code.
  process.stdout.write('smoke: decrypt\n')
  await daemon.stop()
  const decrypted = await ctx.runConversion(world, 'decrypt')
  expectOk('decrypt', decrypted)
  await daemon.start()
  const afterDecrypt = await kinfold(world, ['status'])
  expectOk('decrypt', afterDecrypt)
  expectContains('decrypt', afterDecrypt.stdout, /daemon \/health: up on 127\.0\.0\.1:37811\b/)
  expectContains('decrypt', afterDecrypt.stdout, /^database: plaintext/m)
  await expectEventStillSearchable(ctx, 'decrypt')

  process.stdout.write('smoke: encrypt\n')
  await daemon.stop()
  const encrypted = await ctx.runConversion(world, 'encrypt')
  if (encrypted.code !== 0) throw new SmokeError('encrypt', `encrypt did not finish (expect exit ${encrypted.code})`)
  await daemon.start()
  const afterEncrypt = await kinfold(world, ['status'])
  expectOk('encrypt', afterEncrypt)
  expectContains('encrypt', afterEncrypt.stdout, /daemon \/health: up on 127\.0\.0\.1:37811\b/)
  expectContains('encrypt', afterEncrypt.stdout, encryptedLine(platform))
  await expectEventStillSearchable(ctx, 'encrypt')
}

interface Cleanup {
  problems: string[]
}

async function cleanup(ctx: Run, installStarted: boolean, uninstalled: boolean): Promise<Cleanup> {
  const { world } = ctx
  const problems: string[] = []
  try {
    await ctx.daemon.stop()
  } catch (error: unknown) {
    problems.push(`the foreground daemon could not be stopped (${error instanceof Error ? error.message : String(error)})`)
  }
  if (installStarted && !uninstalled) {
    try {
      const result = await ctx.kinfold(world, ['uninstall'])
      if (result.code !== 0) problems.push(`uninstall exited ${result.code}\n${describe(result)}`)
    } catch (error: unknown) {
      problems.push(`uninstall could not run (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  try {
    rmSync(world.root, { recursive: true, force: true })
  } catch (error: unknown) {
    problems.push(`the temporary folder could not be removed (${error instanceof Error ? error.message : String(error)})`)
  }
  return { problems }
}

export async function smoke(programPath: string, platform: SmokePlatform, deps: SmokeDeps = {}): Promise<void> {
  const env = deps.env ?? process.env
  const program = resolve(programPath)
  if (!existsSync(program)) throw new SmokeError('setup', `${program} does not exist`)
  const home = homeForSmoke(env)
  const root = mkdtempSync(join(tmpdir(), 'kinfold-smoke-'))
  const projectRoot = join(root, 'project')
  const fakeBin = join(root, 'bin')
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 })
  // The daemon resolves the hook event's cwd from the payload, while the MCP
  // server resolves its own process.cwd(). On macOS the temporary directory is
  // a symlink, so the kernel reports the real path to the child; the payload
  // and the child must name the same project or the search misses the event.
  const project = realpathSync(projectRoot)
  const world: SmokeWorld = {
    program,
    root,
    home,
    project,
    dataDir: join(home, '.kinfold'),
    fakeBin,
    env: childEnvironment(home, fakeBin, platform),
    marker: `smokeevent${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  }
  const ctx: Run = {
    world,
    platform,
    kinfold: deps.kinfold ?? kinfold,
    runConversion: deps.runConversion ?? platform.runConversion?.bind(platform) ?? runPty,
    daemon: foregroundDaemon(platform, world),
  }

  let installStarted = false
  let uninstalled = false
  let failure: unknown = null
  try {
    const version = await ctx.kinfold(world, ['--version'])
    expectOk('version', version)
    const release = version.stdout.trim()
    if (release !== '0.0.0-dev' && (env.KINFOLD_RELEASE_SUMS_URL ?? '') === '') {
      throw new SmokeError('setup', `${release} needs KINFOLD_RELEASE_SUMS_URL; the self-check must read the release SHA256SUMS`)
    }
    // These guards run before anything is installed, so a busy port or an
    // existing agent stops the smoke without touching the machine, and the
    // cleanup in the failure path never runs uninstall against them.
    ensurePortFree(deps.port ?? DEFAULT_PORT)
    if (platform.serviceLoaded(world.env)) throw new SmokeError('setup', `the ${platform.name} service is already loaded; the smoke will not take over an existing install`)
    const realClaude = Bun.which('claude', { PATH: env.PATH ?? '' })
    if (platform.writeObserverShim !== undefined) await platform.writeObserverShim(world, realClaude)
    else writeObserverShim(world, realClaude)

    installStarted = true
    await steps(ctx)

    process.stdout.write('smoke: uninstall\n')
    await ctx.daemon.stop()
    const result = await ctx.kinfold(world, ['uninstall'])
    expectOk('uninstall', result)
    uninstalled = true
    const binPath = join(world.dataDir, 'bin')
    if (existsSync(binPath)) throw new SmokeError('uninstall', `${binPath} is still there`)
    for (const file of platform.serviceFiles(home)) {
      if (existsSync(file)) throw new SmokeError('uninstall', `${file} is still there`)
    }
    if (platform.serviceLoaded(world.env)) throw new SmokeError('uninstall', `the ${platform.name} service is still loaded`)
  } catch (error: unknown) {
    failure = error
  } finally {
    const cleaned = await cleanup(ctx, installStarted, uninstalled)
    if (cleaned.problems.length > 0) {
      if (failure === null) failure = new SmokeError('cleanup', cleaned.problems.join('; '))
      else process.stderr.write(`smoke: cleanup also failed: ${cleaned.problems.join('; ')}\n`)
    }
  }
  if (failure !== null) throw failure
}

async function main(): Promise<void> {
  const program = process.argv[2]
  if (program === undefined || program === '') {
    process.stderr.write('usage: bun tools/smoke.ts <program path>\n')
    process.exit(1)
  }
  try {
    await smoke(program, await loadSmokePlatform(currentPlatform().os))
    process.stdout.write('smoke ok\n')
  } catch (error: unknown) {
    if (error instanceof SmokeError) process.stderr.write(`smoke failed at ${error.step}: ${error.message}\n`)
    else process.stderr.write(`smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

if (import.meta.main) await main()
