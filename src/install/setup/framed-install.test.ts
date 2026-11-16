// A whole install, as each kind of run shows it: framed on a terminal (the
// bar, the summary, the log behind it), and plain everywhere else, where a
// script, a pipe, --yes and the auto-updater must read what they always read
// and never wait at a question.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { posixOnly } from '../../../test/platform-guards'
import { EXIT_CANCELLED, runKinfold } from '../../cli/kinfold'
import { installedProgramPath } from '../entry'
import { EXIT_FAILED, EXIT_OK, type InstallOptions, install } from '../install'
import { installLogPath } from '../install-log'
import { CODEX_TRUST_NOTE } from '../host-wiring'
import { BLOCK_START, withBlock } from '../path-setup'
import { runPlan } from '../plan'
import { createClackPrompts } from '../prompt/clack'
import { fakeTerminal } from '../prompt/fake-terminal'
import { type FakeWorld, YES, createWorld, fakeService, snapshotTree } from '../test-support'
import { INSTALL_RECORD_FILE, readInstallRecord } from './record'

const ENTER = '\r'
/** The log as the summary names it: under ~, in this OS's own separators. */
const TILDE_LOG = join('~', '.kinfold', 'logs', 'install.log')
const ESCAPE = '\u001b'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

interface Made {
  w: FakeWorld
  options: InstallOptions
  link: string
  zshrc: string
}

/** A machine where Kinfold installs as a program into ~/.kinfold, the shell is zsh, and ~/.local/bin is not on PATH. */
function program(over: Parameters<typeof createWorld>[0] = {}): Made {
  world = createWorld({ claudeVersion: '2.1.311 (Claude Code)', keychainRefs: ['openrouter'], ...over })
  const w = world
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program\n', { mode: 0o755 })
  w.env = { ...w.env, mode: { kind: 'program', binPath: installedProgramPath(w.dataDir, w.env.platform) }, pathEnv: '/opt/fake/bin:/usr/bin', envVars: { SHELL: '/bin/zsh' } }
  writeFileSync(join(w.home, '.zshrc'), 'export A=1\n')
  return { w, options: { ...YES, programSource: source, noEncrypt: true }, link: join(w.home, '.local', 'bin', 'kinfold'), zshrc: join(w.home, '.zshrc') }
}

/** The run on a terminal: the keys answer the questions in order. */
function onTerminal(made: Made, keys: readonly string[]): ReturnType<typeof fakeTerminal> {
  const term = fakeTerminal(keys)
  made.w.env = { ...made.w.env, terminal: term, io: { ...made.w.env.io, interactive: true } }
  return term
}

/** What the terminal holds once the run is over: a repainted bar line leaves only its last text. */
function screenLines(output: string): string[] {
  return output.split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((line) => line !== '')
}

/** A path as a terminal run draws it: under the home, it starts with ~. */
const tilde = (made: Made, path: string): string => path.replace(made.w.home, '~')
const logOf = (w: FakeWorld): string[] => readFileSync(installLogPath(w.dataDir), 'utf8').split('\n')
const numbered = (lines: readonly string[]): string[] => lines.filter((line) => /^ {2}\d+\. /.test(line))

// folder, agents, observer, port, updates, impact test, PATH, summary
const EIGHT_ENTERS = Array(8).fill(ENTER)

posixOnly('POSIX paths')('a terminal install shows the bar and a summary, and keeps every line in logs/install.log', async () => {
  const made = program()
  const term = onTerminal(made, EIGHT_ENTERS)
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_OK)

  // Nothing went to the plain output, and no numbered step reached the screen.
  expect(made.w.out).toEqual([])
  const raw = term.output()
  expect(raw).toContain('wiring Claude Code')
  expect(raw).toContain('setting up the kinfold command')
  expect(raw).not.toMatch(/\d+\. (mkdir|write|install program)/)
  const screen = screenLines(raw)
  expect(screen[0]).toMatch(/^Kinfold \S+ setup$/)
  expect(screen).toContain('Installed')
  expect(screen).toContain('  + Agents wired: Claude Code')
  expect(screen).toContain('  + Daemon: running on 127.0.0.1:37811')
  expect(screen).toContain('  Encryption: off')
  expect(screen).toContain('  + kinfold command: ~/.local/bin/kinfold, with ~/.local/bin on PATH through ~/.zshrc')
  expect(screen).toContain(`  Full log: ${TILDE_LOG}`)
  expect(screen.at(-1)).toBe('Check it in a new terminal with: kinfold status (in this one: source ~/.zshrc, then kinfold status)')

  // The audit trail: the header, the count, each step with its outcome, and the lines outside the plan.
  const log = logOf(made.w)
  expect(log[0]).toMatch(/^=== kinfold install \d{4}-\d{2}-\d{2}T[\d:.]+Z ===$/)
  const count = Number(/^applying (\d+) actions$/.exec(log.find((line) => line.startsWith('applying ')) ?? '')?.[1])
  expect(count).toBeGreaterThan(5)
  expect(numbered(log)).toHaveLength(count)
  for (const line of numbered(log)) expect(line).toMatch(/ {2}\[(done|kept)\]$/)
  expect(log.some((line) => line.startsWith('daemon: '))).toBe(true)
  expect(log.some((line) => line.startsWith('host claude-code 2.1.311 (Claude Code): install'))).toBe(true)
  expect(log.some((line) => line.startsWith('observer claude-code: '))).toBe(true)
  expect(log.some((line) => line.startsWith('installed. Check it with: '))).toBe(true)
  // The bar's step count is the plan's.
  expect(raw).toContain(`${count} steps done`)

  expect(readlinkSync(made.link)).toBe(installedProgramPath(made.w.dataDir, made.w.env.platform))
  expect(readFileSync(made.zshrc, 'utf8')).toBe(withBlock('export A=1\n', 'posix'))
  expect(readInstallRecord(made.w.dataDir)).toMatchObject({ pathSetup: 'added', pathLink: made.link, pathFiles: [made.zshrc] })
})

posixOnly('POSIX paths')('--verbose shows each numbered step above the bar, as it ends', async () => {
  const made = program()
  const term = onTerminal(made, EIGHT_ENTERS)
  expect(await install(made.w.env, { ...made.options, yes: false, verbose: true })).toBe(EXIT_OK)
  const shown = screenLines(term.output()).filter((line) => /^\| {4}\d+\. .* {2}\[done\]$/.test(line))
  expect(shown).toHaveLength(numbered(logOf(made.w)).length)
  expect(shown.some((line) => line.includes(`link ${tilde(made, made.link)} -> `))).toBe(true)
})

posixOnly('POSIX paths')('answering no to the PATH question links the command and leaves the startup file alone', async () => {
  const made = program()
  onTerminal(made, [ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, 'n', ENTER])
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_OK)
  expect(lstatSync(made.link).isSymbolicLink()).toBe(true)
  expect(readFileSync(made.zshrc, 'utf8')).toBe('export A=1\n')
  expect(readInstallRecord(made.w.dataDir)).toMatchObject({ pathSetup: 'declined', pathLink: made.link })
  // And it stays declined: the next install neither asks nor adds.
  const again = onTerminal(made, Array(7).fill(ENTER))
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_OK)
  expect(again.output()).not.toContain('Add kinfold to your PATH?')
  expect(await install({ ...made.w.env, terminal: null }, made.options)).toBe(EXIT_OK)
  expect(readFileSync(made.zshrc, 'utf8')).toBe('export A=1\n')
  expect(readInstallRecord(made.w.dataDir)?.pathSetup).toBe('declined')
})

test('a step that fails stops the bar and shows its line, the reason and the log, which holds every step up to it', async () => {
  const made = program()
  made.w.env = { ...made.w.env, service: fakeService({ running: false, startError: new Error('the service manager said no') }) }
  const term = onTerminal(made, EIGHT_ENTERS)
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_FAILED)
  const screen = screenLines(term.output())
  const stopped = screen.findIndex((line) => /^x {2}stopped at step \d+ of \d+: starting the daemon$/.test(line))
  expect(stopped).toBeGreaterThan(-1)
  const step = Number(/step (\d+) of/.exec(screen[stopped] as string)?.[1])
  expect(screen.slice(stopped + 1)).toEqual([
    `x ${step}. FakeService start`,
    `x install failed: step ${step} failed: the service manager said no`,
    `The full log is in ${TILDE_LOG}`,
  ])
  const log = logOf(made.w)
  expect(numbered(log)).toHaveLength(step)
  expect(numbered(log).at(-1)).toBe(`  ${step}. FakeService start  [failed]`)
  expect(log).toContain(`install failed: step ${step} failed: the service manager said no`)
  expect(made.w.out).toEqual([])
})

test('Ctrl-C at a question ends the frame, exits 130 and writes nothing, not even a log', async () => {
  const made = program()
  const term = onTerminal(made, ['\u0003'])
  const before = snapshotTree(made.w.home)
  expect(await runKinfold(['install', '--no-encrypt'], made.w.env)).toBe(EXIT_CANCELLED)
  expect(screenLines(term.output()).at(-1)).toBe('install cancelled; nothing was changed')
  expect(snapshotTree(made.w.home)).toEqual(before)
})

test('a dry run on a terminal lists the whole plan, PATH steps included, and changes nothing', async () => {
  const made = program()
  const term = onTerminal(made, EIGHT_ENTERS)
  const before = snapshotTree(made.w.home)
  expect(await install(made.w.env, { ...made.options, yes: false, dryRun: true })).toBe(EXIT_OK)
  const screen = screenLines(term.output())
  expect(screen.some((line) => /^plan \(dry run, nothing is changed\): \d+ actions$/.test(line))).toBe(true)
  expect(screen).toContain(`  ${numbered(screen).findIndex((line) => line.includes('link ')) + 1}. link ${tilde(made, made.link)} -> ${tilde(made, installedProgramPath(made.w.dataDir, made.w.env.platform))}`)
  expect(screen.some((line) => line.endsWith(`write ${tilde(made, made.zshrc)}: add the kinfold PATH block (1 -> 9 lines)`))).toBe(true)
  expect(screen.at(-1)).toBe('Dry run: nothing was changed.')
  expect(snapshotTree(made.w.home)).toEqual(before)
})

test('the impact test answer is sent to the daemon only when it changes what is saved', async () => {
  const sent = async (keys: readonly string[], saved?: boolean, flag?: boolean): Promise<string[]> => {
    const made = program()
    if (saved !== undefined) {
      mkdirSync(made.w.dataDir, { recursive: true })
      writeFileSync(join(made.w.dataDir, 'display.json'), JSON.stringify({ showRecall: true, holdout: saved }))
    }
    const term = onTerminal(made, keys)
    expect(await install(made.w.env, { ...made.options, yes: false, dryRun: true, ...(flag !== undefined ? { display: { holdout: flag } } : {}) })).toBe(EXIT_OK)
    const lines = screenLines(term.output()).filter((line) => line.includes('PUT /data/display'))
    await world?.cleanup()
    world = null
    return lines.map((line) => line.replace(/^\s*\d+\. /, ''))
  }
  const yes = [ENTER, ENTER, ENTER, ENTER, ENTER, 'y', ENTER, ENTER]
  // Yes on a machine where it is off: sent. Enter keeps the default, no: nothing to send.
  expect(await sent(yes)).toEqual(['PUT /data/display holdout=true'])
  expect(await sent(EIGHT_ENTERS)).toEqual([])
  // A saved yes is the default: Enter keeps it and sends nothing; no turns it off.
  expect(await sent(EIGHT_ENTERS, true)).toEqual([])
  expect(await sent([ENTER, ENTER, ENTER, ENTER, ENTER, 'n', ENTER, ENTER], true)).toEqual(['PUT /data/display holdout=false'])
  // A flag answers the question, so it is not asked and the flag is what is sent.
  expect(await sent(Array(7).fill(ENTER), false, true)).toEqual(['PUT /data/display holdout=true'])
})

test('a failure is said once on a terminal, in a dry run too', async () => {
  // A build with no OpenCode plugin cannot wire OpenCode: the plan fails before any step.
  for (const dryRun of [true, false]) {
    const made = program({ opencodeVersion: 'opencode v2.1.4' })
    const term = onTerminal(made, Array(9).fill(ENTER))
    expect(await install(made.w.env, { ...made.options, yes: false, dryRun })).toBe(EXIT_FAILED)
    const said = screenLines(term.output()).filter((line) => line.includes('install failed: this build carries no OpenCode plugin'))
    expect(said).toEqual(['x install failed: this build carries no OpenCode plugin; reinstall from a release build'])
    await world?.cleanup()
    world = null
  }
})

test('a note the person has to act on shows above the bar: Codex asks for its hooks to be trusted', async () => {
  const made = program({ codexVersion: 'codex-cli 0.50.0' })
  // folder, agents, observer x2, port, updates, impact test, PATH, summary
  const term = onTerminal(made, Array(9).fill(ENTER))
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_OK)
  expect(screenLines(term.output())).toContain(`! ${CODEX_TRUST_NOTE}`)
  expect(logOf(made.w)).toContain(CODEX_TRUST_NOTE)
})

test('under --takeover the command that stops the other daemon shows above the bar', async () => {
  const made = program()
  const notices: string[] = []
  made.w.env = { ...made.w.env, notice: (line) => void notices.push(line), fetch: async () => { throw new TypeError('down') } }
  await runPlan(made.w.env, [{ kind: 'wait-takeover', pid: 4242, port: 37811 }], false, undefined, { listeners: [] })
  expect(notices).toEqual(['waiting for you to stop the running daemon: kill 4242'])
  expect(made.w.out).toEqual([])
})

posixOnly('POSIX paths')('an install.json that cannot be read is still an install: --yes adds no link and no block', async () => {
  const made = program()
  mkdirSync(made.w.dataDir, { recursive: true })
  writeFileSync(join(made.w.dataDir, INSTALL_RECORD_FILE), '{ not json')
  expect(await install(made.w.env, made.options)).toBe(EXIT_OK)
  expect(existsSync(made.link)).toBe(false)
  expect(readFileSync(made.zshrc, 'utf8')).toBe('export A=1\n')
})

// ---- automation: plain text, and never a question -------------------------------

/** Fails the test if anything asks: a plain run has no one to answer. */
function neverAsks(w: FakeWorld): void {
  const refuse = async (): Promise<never> => {
    throw new Error('a question was asked')
  }
  w.env = { ...w.env, io: { ...w.env.io, ask: refuse, askSecret: refuse } }
}

function expectPlain(lines: readonly string[]): void {
  expect(lines.length).toBeGreaterThan(5)
  for (const line of lines) expect(line).not.toContain(ESCAPE)
  expect(lines.some((line) => /^applying \d+ actions$/.test(line))).toBe(true)
  expect(numbered(lines).length).toBeGreaterThan(5)
  expect(lines.some((line) => line.startsWith('installed. Check it with: '))).toBe(true)
}

posixOnly('POSIX paths')('--yes on a terminal prints the plain lines, draws nothing, and sets the command up by default', async () => {
  const made = program()
  const term = onTerminal(made, [])
  neverAsks(made.w)
  expect(await install(made.w.env, made.options)).toBe(EXIT_OK)
  expect(term.output()).toBe('')
  expect(term.rawStates()).toEqual([])
  expectPlain(made.w.out)
  expect(made.w.out.slice(-2)).toEqual([
    'kinfold command: ~/.local/bin/kinfold, with ~/.local/bin on PATH through ~/.zshrc',
    'kinfold command: new terminals have it; in this one run "source ~/.zshrc" first',
  ])
  // What was printed is what the log holds.
  expect(logOf(made.w).slice(1, -1)).toEqual(made.w.out)
  expect(readInstallRecord(made.w.dataDir)?.pathSetup).toBe('added')
  expect(readFileSync(made.zshrc, 'utf8')).toContain(BLOCK_START)
})

test('with no terminal and no --yes (a pipe, CI) the run is plain and asks nothing', async () => {
  const made = program()
  neverAsks(made.w)
  // As before, a run that cannot ask needs its observer named; without it the refusal is the same plain line.
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_FAILED)
  expect(made.w.out.at(-1)).toBe('install failed: cannot ask about the claude-code observer without a TTY; pass --yes or --observer claude-code=<provider>:<model>')
  for (const line of made.w.out) expect(line).not.toContain(ESCAPE)
  made.w.out.length = 0
  expect(await install(made.w.env, { ...made.options, yes: false, flags: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }] })).toBe(EXIT_OK)
  expectPlain(made.w.out)
})

test('--credential-stdin reads the key from stdin, prints plain lines and never prints the key', async () => {
  const made = program({ keychainRefs: [], stdin: 'sk-from-stdin\n' })
  neverAsks(made.w)
  expect(await install(made.w.env, { ...made.options, credentialStdin: true, flags: [{ host: 'claude-code', provider: 'openrouter', model: 'openrouter/auto' }] })).toBe(EXIT_OK)
  expectPlain(made.w.out)
  expect(made.w.out.join('\n')).not.toContain('sk-from-stdin')
  expect(readFileSync(installLogPath(made.w.dataDir), 'utf8')).not.toContain('sk-from-stdin')
  expect(made.w.keychainValues.get('openrouter')).toBe('sk-from-stdin')
})

posixOnly('POSIX paths')('--no-path under --yes makes no link and no block, and says so', async () => {
  const made = program()
  expect(await install(made.w.env, { ...made.options, path: 'no-path' })).toBe(EXIT_OK)
  expect(existsSync(made.link)).toBe(false)
  expect(readFileSync(made.zshrc, 'utf8')).toBe('export A=1\n')
  expect(made.w.out.at(-1)).toBe('kinfold command: not set up (--no-path)')
  expect(readInstallRecord(made.w.dataDir)?.pathSetup).toBe('declined')
})

// ---- installs from before the PATH step -----------------------------------------

/** install.json as 0.3.0 wrote it: no pathSetup. */
function installedBefore(made: Made): void {
  mkdirSync(made.w.dataDir, { recursive: true })
  writeFileSync(join(made.w.dataDir, INSTALL_RECORD_FILE), `${JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1 }, null, 2)}\n`)
}

posixOnly('POSIX paths')('an install --yes over a record without pathSetup (the auto-updater\'s run) adds no link and edits no shell file', async () => {
  const made = program()
  installedBefore(made)
  neverAsks(made.w)
  expect(await install(made.w.env, made.options)).toBe(EXIT_OK)
  expect(existsSync(made.link)).toBe(false)
  expect(existsSync(join(made.w.home, '.local'))).toBe(false)
  expect(readFileSync(made.zshrc, 'utf8')).toBe('export A=1\n')
  expect(readInstallRecord(made.w.dataDir)?.pathSetup).toBeUndefined()
  expect(readFileSync(join(made.w.dataDir, INSTALL_RECORD_FILE), 'utf8')).not.toContain('path')
  expect(made.w.out.at(-1)).toBe(`kinfold command: not set up; run ${installedProgramPath(made.w.dataDir, made.w.env.platform)} install in a terminal, or pass --path, to add it`)
  // Still nothing on the next unattended run.
  expect(await install(made.w.env, made.options)).toBe(EXIT_OK)
  expect(existsSync(made.link)).toBe(false)
})

posixOnly('POSIX paths')('the next interactive install asks, and after a yes later --yes runs follow the record', async () => {
  const made = program()
  installedBefore(made)
  expect(await install(made.w.env, made.options)).toBe(EXIT_OK)
  // The folder is locked on a re-run, so there is no folder question: agents, observer, port, updates, PATH, summary.
  const term = onTerminal(made, Array(6).fill(ENTER))
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_OK)
  expect(term.output()).toContain('Add kinfold to your PATH?')
  expect(readInstallRecord(made.w.dataDir)?.pathSetup).toBe('added')
  expect(readFileSync(made.zshrc, 'utf8')).toBe(withBlock('export A=1\n', 'posix'))
  // The person deletes the block; an unattended run must not put it back.
  writeFileSync(made.zshrc, 'export A=1\n')
  made.w.out.length = 0
  expect(await install({ ...made.w.env, terminal: null }, made.options)).toBe(EXIT_OK)
  expect(readFileSync(made.zshrc, 'utf8')).toBe('export A=1\n')
  expect(made.w.out.some((line) => line.startsWith('kinfold command'))).toBe(false)
})

// ---- the real renderer ----------------------------------------------------------

/** Answers each question as it is drawn: the keys for a question are typed once its text shows up. */
function clackSession(script: readonly (readonly [string, readonly string[]])[]) {
  const input = new PassThrough()
  // A terminal's size, so the list is drawn whole as it is on a real one.
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 50 })
  let written = ''
  let next = 0
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString()
    const step = script[next]
    if (step === undefined || !stripVTControlCharacters(written).includes(step[0])) return
    next += 1
    step[1].forEach((key, index) => setTimeout(() => input.write(key), 2 + index * 2))
  })
  return { prompts: createClackPrompts({ input, output }), text: () => stripVTControlCharacters(written), asked: () => next }
}

posixOnly('POSIX paths')('the whole wizard runs on clack: 22 agent rows, the bar, the summary box and the outro', async () => {
  const made = program()
  const session = clackSession([
    ['Memory folder:', [ENTER]],
    ['Which agents should share memory?', [ENTER]],
    ['Observer for claude-code:', [ENTER]],
    ['Port for the daemon:', [ENTER]],
    ['Updates:', [ENTER]],
    ['Run the impact test?', [ENTER]],
    ['Add kinfold to your PATH?', [ENTER]],
    ['Install with these choices?', [ENTER]],
  ])
  made.w.env = { ...made.w.env, terminal: fakeTerminal([]), promptsFor: () => session.prompts, io: { ...made.w.env.io, interactive: true } }
  expect(await install(made.w.env, { ...made.options, yes: false })).toBe(EXIT_OK)
  expect(session.asked()).toBe(8)
  const text = session.text()
  expect(text).toMatch(/^┌ {2}Kinfold \S+ setup\n/)
  expect(text).toContain('◼ Claude Code (2.1.311 · capture, context, search)')
  expect(text).toContain('│  Claude Code\n')
  expect(text).toContain('◻ Zed (not installed)')
  expect(text.match(/\(not installed\)/g)?.length).toBeGreaterThanOrEqual(20)
  expect(text).toContain("◻ Continue (can't detect IDE extensions; pick it if you use it)")
  expect(text).toContain('Your choices')
  expect(text).toContain('wiring Claude Code')
  expect(text).toMatch(/◇ {2}\d+ steps done/)
  expect(text).toContain('◇  Installed')
  expect(text).toContain('✓ Agents wired: Claude Code')
  expect(text.trimEnd().endsWith('└  Check it in a new terminal with: kinfold status (in this one: source ~/.zshrc, then kinfold status)')).toBe(true)
  expect(made.w.out).toEqual([])
  expect(readInstallRecord(made.w.dataDir)?.pathSetup).toBe('added')
})

test('Esc at a clack question cancels the install with exit 130 and nothing written', async () => {
  const made = program()
  const session = clackSession([['Memory folder:', [ESCAPE]]])
  made.w.env = { ...made.w.env, terminal: fakeTerminal([]), promptsFor: () => session.prompts, io: { ...made.w.env.io, interactive: true } }
  const before = snapshotTree(made.w.home)
  expect(await runKinfold(['install', '--no-encrypt'], made.w.env)).toBe(EXIT_CANCELLED)
  expect(session.text().trimEnd().endsWith('└  install cancelled; nothing was changed')).toBe(true)
  expect(snapshotTree(made.w.home)).toEqual(before)
})
