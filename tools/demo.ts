// The program behind the README recording (assets/demo.tape). It is a small
// shell that understands `kinfold install`, `kinfold status` and `clear`, and
// runs them in this process over the installer's test world: a temp HOME and
// data folder, a scripted launchctl, an in-memory keychain, scripted `claude`
// and `opencode` commands, and a daemon started in this process on a free
// loopback port. A real install would load a LaunchAgent, write Keychain
// entries and take port 37811, none of which a throwaway HOME isolates, so
// the recording never runs one. What is drawn is the real wizard, the real
// plan and the real status, on the real renderer.
//
// It refuses to start unless its world sits under KINFOLD_DEMO_ROOT, a folder
// the tape makes with mktemp. The world has this machine's platform and
// architecture and the pinned sqlite-vec build from .cache/vec0 (put there by
// `bun tools/fetch-vec0.ts`), so status reads as it does on a real machine.
//
// Three things are for the camera, and nothing else differs from a real run:
// the version is stamped from KINFOLD_DEMO_VERSION the way a release build
// stamps it; each step of the plan is held for a moment, so the bar can be
// seen on a machine where the fakes answer at once; and the last two groups
// of the recovery code are typed by this program, since a tape cannot read
// the code off the screen.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import '../test/preload'

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/
const version = process.env.KINFOLD_DEMO_VERSION ?? ''
if (VERSION_PATTERN.test(version)) {
  Bun.plugin({
    name: 'demo-version',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({ contents: `export const VERSION = '${version}'\n`, loader: 'ts' }))
    },
  })
}

const STEP_HOLD_MS = 110
const TYPE_DELAY_MS = 1_400
const KEY_INTERVAL_MS = 90
const CODE = /(?:[0-9A-Z]{5}-){10}[0-9A-Z]{5}/
const PLUGIN_BUNDLE = '// Kinfold OpenCode plugin (recording stand-in)\nexport default {}\n'

function fail(message: string): never {
  process.stderr.write(`demo: ${message}\n`)
  process.exit(1)
}

/** A free loopback port, so the daemon never asks for 37811. */
function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = server.port
  server.stop(true)
  return port
}

const root = process.env.KINFOLD_DEMO_ROOT ?? ''
if (root === '' || !resolve(root).includes('kinfold-demo')) fail('KINFOLD_DEMO_ROOT must name the throwaway folder the tape made')
// The world makes its folders under the temp folder, which is the tape's throwaway one.
process.env.TMPDIR = root
// The daemon runs in this process and would ask GitHub for the newest release once it has a real version; a recording reaches no network.
process.env.KINFOLD_NO_UPDATE_CHECK = '1'

const { createWorld } = await import('../src/controllers/tests/install/test-support')
const { install } = await import('../src/controllers/install/install')
const { status } = await import('../src/controllers/install/status')
const { installedProgramPath } = await import('../src/resources/install-plan/entry')
const { runFramed } = await import('../src/controllers/install/prompt/frame')
const { createClackPrompts } = await import('../src/controllers/install/prompt/clack')
const { fakeTerminal } = await import('../src/controllers/tests/install/prompt/fake-terminal')
const { vec0Path } = await import('../src/resources/vectors/extension')
const { vec0AssetFor } = await import('../src/resources/vectors/vec0-release')

const port = freePort()
let home = ''
const world = createWorld({
  claudeVersion: '2.1.325 (Claude Code)',
  opencodeVersion: 'opencode v2.2.5',
  keychainRefs: ['openrouter'],
  daemonPort: port,
  daemonVectors: true,
  // `claude mcp add-json` writes the entry into ~/.claude.json, as the real command does.
  commandOverride: (argv) => {
    // The disk check is a per-machine fact the world has no answer for; the recording says what most Macs say.
    if (argv[0] === '/usr/bin/fdesetup') return { exitCode: 0, stdout: 'FileVault is On.\n' }
    if (argv[0] !== 'claude' || argv[1] !== 'mcp' || argv[2] !== 'add-json') return undefined
    writeFileSync(join(home, '.claude.json'), `${JSON.stringify({ mcpServers: { [argv[5] as string]: JSON.parse(argv[6] as string) } }, null, 2)}\n`)
    return { exitCode: 0, stdout: '' }
  },
})
home = world.home
if (!resolve(home).startsWith(resolve(root)) || !home.includes('sam-install-')) fail(`${home} is not under the throwaway folder; nothing was run`)

// The program is in place already, as it is when an installed kinfold runs install.
const program = join(world.root, 'kinfold-build')
const binPath = installedProgramPath(world.dataDir, world.env.platform)
writeFileSync(program, 'kinfold program\n', { mode: 0o755 })
mkdirSync(dirname(binPath), { recursive: true, mode: 0o700 })
writeFileSync(binPath, 'kinfold program\n', { mode: 0o755 })
writeFileSync(join(home, '.zshrc'), 'export EDITOR=vim\n')

// The world is this machine's own platform and architecture, so status reads as it does on a real one. Its
// sqlite-vec build is the pinned one, put in place from .cache the way a release build carries it, so the
// install downloads nothing and the daemon loads it.
const vec0 = vec0AssetFor(world.env.platform, process.arch)
const cachedVec0 = vec0 === null ? null : join(import.meta.dir, '..', '.cache', 'vec0', vec0.member)
if (cachedVec0 === null || !existsSync(cachedVec0)) fail('the pinned sqlite-vec build is not in .cache/vec0; run `bun tools/fetch-vec0.ts` first')
mkdirSync(dirname(vec0Path(world.dataDir, world.env.platform)), { recursive: true, mode: 0o700 })
copyFileSync(cachedVec0, vec0Path(world.dataDir, world.env.platform))

/** The real renderer, with the two things a recording needs: a bar that can be seen, and the code's tail typed. */
function recordingPrompts() {
  const real = createClackPrompts()
  let code = ''
  return {
    ...real,
    say(line: string) {
      code = CODE.exec(line)?.[0] ?? code
      real.say(line)
    },
    text(question: string, initial: string, validate?: (value: string) => string | null) {
      if (!question.startsWith('Type the last two groups') || code === '') return real.text(question, initial, validate)
      const input = new PassThrough()
      const keys = [...code.split('-').slice(-2).join('-'), '\r']
      keys.forEach((key, index) => setTimeout(() => input.write(key), TYPE_DELAY_MS + index * KEY_INTERVAL_MS))
      return createClackPrompts({ input, output: process.stdout }).text(question, initial, validate)
    },
    progress(total: number) {
      const bar = real.progress(total)
      return { ...bar, step: (label: string) => (bar.step(label), Bun.sleepSync(STEP_HOLD_MS)) }
    },
  }
}

let env = {
  ...world.env,
  mode: { kind: 'program' as const, binPath },
  arch: process.arch,
  pathEnv: '/usr/bin:/bin',
  envVars: { SHELL: '/bin/zsh' },
  portFree: async () => true,
  terminal: fakeTerminal([]),
  promptsFor: recordingPrompts,
  io: { ...world.env.io, interactive: true, printsToTerminal: true },
  out: (line: string) => void process.stdout.write(`${line}\n`),
}

const assets = {
  sqlite3mc: { bytes: async () => new Uint8Array(), sha256: 'sqlite3mc-sha', sourceSha256: 'source-sha' },
  vec0: { bytes: async () => new Uint8Array(), sha256: 'vec0-sha' },
  dashboardFile: () => null, dashboardNames: () => [],
  opencodePlugin: async () => PLUGIN_BUNDLE,
  kiloPlugin: async () => PLUGIN_BUNDLE,
}

async function run(command: string): Promise<void> {
  if (command === 'clear') {
    process.stdout.write('\u001b[2J\u001b[3J\u001b[H')
    return
  }
  if (command === 'kinfold install') {
    const code = await install(env, { yes: false, dryRun: false, skipCheck: false, replaceCredential: false, credentialStdin: false, flags: [], hosts: null, takeover: false, port, programSource: program, opencodeAssets: assets })
    // A terminal opened after the install has ~/.local/bin on PATH; the next command runs in one.
    if (code === 0) env = { ...env, pathEnv: `${env.pathEnv}:${join(home, '.local', 'bin')}` }
    return
  }
  if (command === 'kinfold status') {
    await runFramed(env, 'status', (framed) => status(framed))
    return
  }
  if (command !== '') process.stdout.write('demo: this recording runs kinfold install, kinfold status and clear\n')
}

function readLine(): Promise<string | null> {
  return new Promise((done) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let answered = false
    reader.question('$ ', (line) => {
      answered = true
      reader.close()
      done(line.trim())
    })
    reader.on('close', () => {
      if (!answered) done(null)
    })
  })
}

for (;;) {
  const line = await readLine()
  if (line === null || line === 'exit') break
  await run(line)
}
await world.cleanup()
process.exit(0)
