import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_INFO_FILE } from '../../store/data-dir'
import type { CliObserverRunner } from '../../observer/runners/cli-core'
import { ObserverError } from '../../observer/types'
import { DB_KEY_REF } from '../../secrets/credentials'
import { NO_DB_KEYS, newDbKey } from '../../sqlite/keys'
import { encodeRecoveryCode } from '../../sqlite/recovery'
import { openStore } from '../../store/db'
import { type ObserverSettingsInput, upsertObserverSettings } from '../../store/observer-settings-store'
import { mergeSamHooks } from '../claude-hooks'
import { ENCRYPT_KEY_EXISTS } from '../encrypt'
import { installPaths } from '../env'
import { entryCommand } from '../entry'
import { hostHookInstallActions } from '../host-wiring'
import { ChoiceError, type ChoiceOptions } from '../observer-choice'
import { runPlan } from '../plan'
import { fakeTerminal } from '../prompt/fake-terminal'
import { type Key, decodeKeys } from '../prompt/keys'
import { PromptCancelled, createPrompts } from '../prompt/prompts'
import type { TerminalIO } from '../prompt/terminal'
import { type FakeWorld, createWorld, profilesWithDocsAgent, snapshotTree, startWorldDaemon } from '../test-support'
import { LOCKED_FOLDER_NOTE, type SetupState, readSetupState } from './prefill'
import { installRecordAction } from './record'
import { INSTALL_HOSTS } from '../detect'
import { withBlock } from '../path-setup'
import { DOCS_HINT, DRY_RUN_NO_CODE, NOT_INSTALLED_HINT, NO_AGENTS_NOTE, NO_TTY_ENCRYPTION_CHANGE, STALE_DB_KEY, type SetupFlags, UNDETECTABLE_HINT, freePortFrom, runWizard } from './wizard'
import { posixOnly } from '../../../test/platform-guards'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const ENTER = '\r'
const DOWN = '\u001b[B'
const CTRL_C = '\u0003'
const CODE_PATTERN = /(?:[0-9A-Z]{5}-){10}[0-9A-Z]{5}/g
const CLAUDE_ROW: ObserverSettingsInput = { host: 'claude-code', provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true }
const CODEX_ROW: ObserverSettingsInput = { host: 'codex', provider: 'codex-cli', model: 'gpt-x', credentialRef: null, enabled: true }
const NO_CHOICE: ChoiceOptions = { yes: false, dryRun: false, skipCheck: false, replaceCredential: false, credentialStdin: false, flags: [] }

const flagsOf = (over: Partial<SetupFlags> = {}): SetupFlags => ({ dataDir: null, hosts: null, observers: [], noEncrypt: false, port: null, noUpdateCheck: false, noAutoUpdate: false, autoUpdate: false, yes: false, ...over })

interface Setup {
  w: FakeWorld
  term: ReturnType<typeof fakeTerminal>
}

function setup(keys: readonly string[], options: Parameters<typeof createWorld>[0] = {}, terminal?: TerminalIO): Setup {
  const term = fakeTerminal(keys)
  world = createWorld({ interactive: true, terminal: terminal ?? term, ...options })
  world.env.portFree = async () => true
  return { w: world, term }
}

/** Types `prefix`, then reads the last code off the screen and types its last two groups followed by `after`. */
function readingCodeFrom(prefix: readonly string[], after: string): TerminalIO & { output(): string; rawStates(): boolean[] } {
  const base = fakeTerminal(prefix)
  let rest: Key[] | null = null
  return {
    ...base,
    async *keys() {
      yield* base.keys()
      rest ??= decodeKeys(`${([...base.output().matchAll(CODE_PATTERN)].at(-1)?.[0] ?? '').split('-').slice(-2).join('')}${after}`)
      while (rest.length > 0) yield rest.shift() as Key
    },
  }
}

const ask = (w: FakeWorld) => createPrompts(w.env.terminal as TerminalIO)

/** A re-run of a state with no hosts to ask about, so a test reaches one step in a few keys. */
const rerun = (state: SetupState, over: Partial<SetupState> = {}): SetupState => ({ ...state, installed: true, folderLocked: true, ...over })

async function installedWithTwoHosts(w: FakeWorld): Promise<void> {
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, JSON.stringify(mergeSamHooks({}, { entry: entryCommand(w.env.mode, 'hook', w.dataDir) }).settings))
  await runPlan(w.env, hostHookInstallActions(w.env, 'codex'), false)
  mkdirSync(w.dataDir, { recursive: true })
  await runPlan(w.env, [installRecordAction(w.dataDir, { channel: 'curl', updateCheck: false, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1_700_000_000_000 })], false)
  const store = openStore(w.dataDir, { keys: NO_DB_KEYS })
  try {
    upsertObserverSettings(store.db, CLAUDE_ROW, 1)
    upsertObserverSettings(store.db, CODEX_ROW, 1)
  } finally {
    store.db.close()
  }
}

test('Enter on every step keeps a re-run unchanged', async () => {
  const { w, term } = setup(Array(8).fill(ENTER), { claudeVersion: '2.0.0', codexVersion: '1.0.0' })
  await installedWithTwoHosts(w)
  const state = await readSetupState(w.env)
  expect(state.wiredHosts).toEqual(['claude-code', 'codex'])
  const answers = await runWizard(w.env, ask(w), state, flagsOf(), NO_CHOICE)
  expect(answers).toMatchObject({ dataDir: state.dataDir, hosts: state.wiredHosts, encryption: { kind: 'keep' }, port: state.port, updateCheck: state.updateCheck })
  expect(answers.observers.map((choice) => choice.input)).toEqual([CLAUDE_ROW, CODEX_ROW])
  expect(answers.observers.map((choice) => choice.check)).toEqual(['unchanged', 'unchanged'])
  expect(w.checks).toEqual([])
  expect(term.rawStates().at(-1)).toBe(false)
})

test('first install takes all defaults with --yes', async () => {
  const { w } = setup([], { interactive: false, terminal: null, claudeVersion: '2.0.0', codexVersion: '1.0.0', keychainRefs: ['openrouter'] })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, null, state, flagsOf({ yes: true }), { ...NO_CHOICE, yes: true })
  expect(answers).toMatchObject({ dataDir: w.dataDir, hosts: ['claude-code', 'codex'], encryption: { kind: 'new-encrypted', key: null }, port: 37811, updateCheck: true })
  expect(answers.observers.map((choice) => choice.origin)).toEqual(['default', 'default'])
})

test('--yes never asks, even with a terminal', async () => {
  const { w, term } = setup([], { claudeVersion: '2.0.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ yes: true }), { ...NO_CHOICE, yes: true })
  expect(answers.hosts).toEqual(['claude-code'])
  expect(term.output()).toBe('')
  expect(term.rawStates()).toEqual([])
})

test('the folder is shown locked on a re-run', async () => {
  const { w, term } = setup([])
  const state = rerun(await readSetupState(w.env))
  await expect(runWizard(w.env, ask(w), state, flagsOf(), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  expect(term.output()).toContain(LOCKED_FOLDER_NOTE)
  expect(term.output()).toContain(state.dataDir)
  expect(w.securityCalls).toEqual([])
})

test('--data-dir for another folder on a re-run is refused before any question', async () => {
  const { w, term } = setup([])
  const state = rerun(await readSetupState(w.env))
  const failure = await runWizard(w.env, ask(w), state, flagsOf({ dataDir: `${w.root}/elsewhere` }), NO_CHOICE).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ChoiceError)
  expect((failure as Error).message).toContain(LOCKED_FOLDER_NOTE)
  expect(term.output()).toBe('')
})

posixOnly('POSIX paths')('a first install asks for the folder and expands ~', async () => {
  const { w } = setup(['~/notes\r', ...Array(3).fill(ENTER)])
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [], noEncrypt: true }), NO_CHOICE)
  expect(answers.dataDir).toBe(`${w.home}/notes`)
})

test('a failed observer check asks again before encryption', async () => {
  let calls = 0
  const failingOnce: CliObserverRunner = {
    run: async () => {
      calls += 1
      if (calls === 1) throw new ObserverError('credential_error', 'x')
      return { text: 'OK', model: 'm' }
    },
    runWithFiles: async () => ({ text: 'nothing', model: 'm' }),
    probe: async () => ({ version: '1', binaryPath: '/x' }),
    listModels: async () => [],
  }
  const keys = [ENTER, DOWN, DOWN, DOWN, ENTER, 'gpt-x\r', ENTER, ENTER, ENTER, ENTER, ENTER, ENTER]
  const { w, term } = setup(keys, { claudeVersion: '2.0.0', codexVersion: '1.0.0', cliRunner: () => failingOnce })
  await installedWithTwoHosts(w)
  const state = rerun(await readSetupState(w.env), { wiredHosts: ['claude-code'] })
  let outputAtFailure = ''
  const out = w.env.out
  w.env.out = (line) => {
    if (line.includes('failed: credential_error')) outputAtFailure = term.output()
    out(line)
  }
  const answers = await runWizard(w.env, ask(w), state, flagsOf(), NO_CHOICE)
  expect(w.out.some((line) => line.includes('failed: credential_error'))).toBe(true)
  expect(outputAtFailure).toContain('Model for codex-cli')
  expect(outputAtFailure).not.toContain('Encrypt memory.db?')
  expect(term.output()).toContain('Encrypt memory.db?')
  expect(answers.observers[0]?.origin).toBe('saved')
})

test('a wrong tail asks again, and the new code is shown on the terminal only', async () => {
  const terminal = readingCodeFrom([ENTER, ENTER, ENTER, 'AAAAA-BBBBB\r'], '\r\r\r\r\r')
  const { w } = setup([], { claudeVersion: '2.0.0' }, terminal)
  const state = await readSetupState(w.env)
  const flags = flagsOf({ observers: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }] })
  const answers = await runWizard(w.env, createPrompts(terminal), state, flags, { ...NO_CHOICE, flags: flags.observers })
  expect(answers.encryption.kind).toBe('new-encrypted')
  const key = answers.encryption.kind === 'new-encrypted' ? answers.encryption.key : null
  expect(key).toMatch(/^[0-9a-f]{64}$/)
  const code = encodeRecoveryCode(key as string)
  expect(terminal.output().split(code).length - 1).toBe(2)
  expect(w.out.join('\n')).not.toContain(code)
  expect(w.out.join('\n')).not.toContain(key as string)
})

test('Ctrl-C at the code cancels and leaves the terminal in cooked mode', async () => {
  const { w, term } = setup([ENTER, ENTER, CTRL_C])
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  expect(term.output().match(CODE_PATTERN)?.length).toBe(1)
  expect(term.rawStates().at(-1)).toBe(false)
  expect(w.out.join('\n')).not.toMatch(CODE_PATTERN)
})

test('a db-key already in the Keychain is reused, never a second one', async () => {
  const key = newDbKey()
  const code = encodeRecoveryCode(key)
  const tail = code.split('-').slice(-2).join('')
  const { w, term } = setup([ENTER, ENTER, `${tail}\r`, ENTER, ENTER, ENTER], { keychainRefs: [DB_KEY_REF] })
  w.keychainValues.set(DB_KEY_REF, key)
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE)
  expect(answers.encryption).toEqual({ kind: 'new-encrypted', key })
  expect(term.output()).toContain(code)
})

test('a db-key whose code cannot be recomputed ends the step with a message', async () => {
  const { w, term } = setup([ENTER, ENTER], { keychainRefs: [DB_KEY_REF] })
  w.keychainValues.set(DB_KEY_REF, 'not-a-key')
  const state = await readSetupState(w.env)
  const failure = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE).catch((error: unknown) => error)
  expect(failure).toEqual(new ChoiceError(STALE_DB_KEY))
  // No store exists for show-recovery to read, so the message names the Keychain item, never its value.
  expect(STALE_DB_KEY).toContain('service kinfold and account db-key')
  expect(STALE_DB_KEY).not.toContain('show-recovery')
  expect(STALE_DB_KEY).not.toContain('not-a-key')
  expect(term.output()).not.toMatch(CODE_PATTERN)
  expect(w.securityCalls.some((call) => call.args[0] === '-i')).toBe(false)
})

test('encryption on an encrypted store shows no code', async () => {
  const { w, term } = setup([ENTER, ENTER, ENTER, ENTER])
  const state = rerun(await readSetupState(w.env), { encryption: 'on' })
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE)
  expect(answers.encryption).toEqual({ kind: 'keep' })
  expect(term.output()).toContain('kinfold key show-recovery')
  expect(term.output()).not.toMatch(CODE_PATTERN)
})

test('turning encryption off asks for decrypt', async () => {
  const tail = [ENTER, ENTER, ENTER]
  const state = async (w: FakeWorld): Promise<SetupState> => rerun(await readSetupState(w.env), { encryption: 'on' })
  const typed = setup(['n', 'decrypt\r', ...tail])
  const yes = await runWizard(typed.w.env, ask(typed.w), await state(typed.w), flagsOf({ hosts: [] }), NO_CHOICE)
  expect(yes.encryption).toEqual({ kind: 'decrypt-existing' })
  await world?.cleanup()
  const other = setup(['n', 'nope\r', ...tail])
  const kept = await runWizard(other.w.env, ask(other.w), await state(other.w), flagsOf({ hosts: [] }), NO_CHOICE)
  expect(kept.encryption).toEqual({ kind: 'keep' })
})

test('a plaintext store stays plain on Enter and encrypts with a confirmed code on yes', async () => {
  const plain = setup([ENTER, ENTER, ENTER, ENTER])
  const state = rerun(await readSetupState(plain.w.env), { encryption: 'off' })
  expect((await runWizard(plain.w.env, ask(plain.w), state, flagsOf({ hosts: [] }), NO_CHOICE)).encryption).toEqual({ kind: 'keep' })
  await world?.cleanup()
  const terminal = readingCodeFrom(['y'], '\r\r\r\r')
  const on = setup([], {}, terminal)
  const answers = await runWizard(on.w.env, createPrompts(terminal), rerun(await readSetupState(on.w.env), { encryption: 'off' }), flagsOf({ hosts: [] }), NO_CHOICE)
  expect(answers.encryption.kind).toBe('encrypt-existing')
  const key = answers.encryption.kind === 'encrypt-existing' ? (answers.encryption.key ?? '') : ''
  expect(terminal.output()).toContain(encodeRecoveryCode(key))
})

test('turning encryption on beside an existing db-key is refused before any code is shown', async () => {
  const { w, term } = setup(['y', ENTER, ENTER, ENTER], { keychainRefs: [DB_KEY_REF] })
  w.keychainValues.set(DB_KEY_REF, newDbKey())
  const state = rerun(await readSetupState(w.env), { encryption: 'off' })
  await expect(runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE)).rejects.toThrow(ENCRYPT_KEY_EXISTS)
  expect(term.output()).not.toMatch(CODE_PATTERN)
  expect(term.output()).not.toContain('Recovery code')
})

test('a taken port suggests the next free one', async () => {
  const { w, term } = setup([ENTER, ENTER, ENTER, ENTER])
  w.env.portFree = async (port) => port !== 37811
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [], noEncrypt: true }), NO_CHOICE)
  expect(answers.port).toBe(37812)
  expect(term.output()).toContain('Port 37811 is in use')
})

const holderIs = (pid: string) => (argv: readonly string[]) =>
  argv[0] === '/usr/sbin/lsof' ? { exitCode: 0, stdout: `${pid}\n` } : undefined

async function defaultPortWith(daemonPid: number, commandOverride?: (argv: readonly string[]) => { exitCode: number; stdout: string } | undefined): Promise<number> {
  const { w } = setup([], { commandOverride })
  w.env.portFree = async (port) => port !== 37811
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, DAEMON_INFO_FILE), JSON.stringify({ pid: daemonPid, port: 37811 }))
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, null, state, flagsOf({ hosts: [], noEncrypt: true, yes: true }), { ...NO_CHOICE, yes: true })
  return answers.port
}

test('our own daemon too busy to answer /health keeps its port under --yes', async () => {
  expect(await defaultPortWith(process.pid, holderIs(String(process.pid)))).toBe(37811)
  expect(await defaultPortWith(process.pid)).toBe(37811)
})

test('another process on the port moves the default even when daemon.json names that port', async () => {
  expect(await defaultPortWith(process.pid, holderIs('999999'))).toBe(37812)
})

test('a daemon.json pid that is no longer running does not claim the port', async () => {
  expect(await defaultPortWith(2_147_483_646)).toBe(37812)
})

test('a running daemon recorded on another port does not claim the taken one', async () => {
  const { w } = setup([])
  w.env.portFree = async (port) => port !== 37811
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, DAEMON_INFO_FILE), JSON.stringify({ pid: process.pid, port: 37900 }))
  const state = rerun(await readSetupState(w.env), { port: 37811 })
  const answers = await runWizard(w.env, null, state, flagsOf({ hosts: [], noEncrypt: true, yes: true }), { ...NO_CHOICE, yes: true })
  expect(answers.port).toBe(37812)
})

test('our own daemon on the saved port keeps it', async () => {
  const { w } = setup([ENTER, ENTER, ENTER, ENTER], { keychainRefs: [DB_KEY_REF] })
  w.keychainValues.set(DB_KEY_REF, newDbKey())
  mkdirSync(w.dataDir, { recursive: true })
  const daemon = startWorldDaemon(w, w.dataDir)
  try {
    w.env.portFree = async () => false
    const state = rerun(await readSetupState(w.env), { port: daemon.port, encryption: 'off' })
    const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE)
    expect(answers.port).toBe(daemon.port)
    expect(await freePortFrom(w.env, daemon.port)).toBe(daemon.port)
  } finally {
    await daemon.stop()
  }
})

test('a typed port outside 1024-65535 is asked again', async () => {
  const { w } = setup([ENTER, '80\r', '40000\r', ENTER, ENTER])
  const state = rerun(await readSetupState(w.env), { encryption: 'off' })
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: [] }), NO_CHOICE)
  expect(answers.port).toBe(40000)
})

test('without a TTY an existing-store encryption change refuses', async () => {
  const { w } = setup([], { interactive: false, terminal: null })
  const state = rerun(await readSetupState(w.env), { encryption: 'on' })
  const failure = await runWizard(w.env, null, state, flagsOf({ hosts: [], noEncrypt: true }), NO_CHOICE).catch((error: unknown) => error)
  expect(failure).toEqual(new ChoiceError(NO_TTY_ENCRYPTION_CHANGE))
  const kept = await runWizard(w.env, null, state, flagsOf({ hosts: [] }), NO_CHOICE)
  expect(kept.encryption).toEqual({ kind: 'keep' })
})

test('without a TTY a flag wins, then the saved value, and the observer step needs --yes or --observer', async () => {
  const { w } = setup([], { interactive: false, terminal: null, claudeVersion: '2.0.0' })
  const state = rerun(await readSetupState(w.env), { port: 38000, updateCheck: false, encryption: 'off', wiredHosts: ['claude-code'] })
  const failure = await runWizard(w.env, null, state, flagsOf(), NO_CHOICE).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ChoiceError)
  expect((failure as Error).message).toContain('without a TTY')
  const flags = flagsOf({ observers: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }], noUpdateCheck: true })
  const answers = await runWizard(w.env, null, state, flags, { ...NO_CHOICE, flags: flags.observers })
  expect(answers).toMatchObject({ port: 38000, updateCheck: false, encryption: { kind: 'keep' } })
  expect((await runWizard(w.env, null, state, { ...flags, port: 40000 }, { ...NO_CHOICE, flags: flags.observers })).port).toBe(40000)
})

test('a wired host whose agent is gone can still be kept or unticked', async () => {
  const { w } = setup(Array(6).fill(ENTER))
  const state = rerun(await readSetupState(w.env), { wiredHosts: ['claude-code'], encryption: 'off' })
  const flags = flagsOf({ observers: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }] })
  const answers = await runWizard(w.env, ask(w), state, flags, { ...NO_CHOICE, flags: flags.observers })
  expect(answers.hosts).toEqual(['claude-code'])
})

test('with no agent found the list is still shown, and Enter wires none', async () => {
  const { w, term } = setup([ENTER, ENTER, ENTER, ENTER, ENTER])
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.hosts).toEqual([])
  expect(term.output()).toContain('Which agents should share memory?')
  expect(term.output()).toContain('Claude Code (not installed)')
})

test('a headless no-agent run says so', async () => {
  const { w } = setup([], { interactive: false, terminal: null })
  const answers = await runWizard(w.env, null, await readSetupState(w.env), flagsOf({ yes: true, noEncrypt: true }), { ...NO_CHOICE, yes: true })
  expect(answers.hosts).toEqual([])
  expect(w.out.some((line) => line.includes('No supported agent was found'))).toBe(true)
})

test('--yes on a re-run keeps exactly the wired set', async () => {
  // claude-code is wired but not detected; codex is detected but not wired.
  const { w } = setup([], { interactive: false, terminal: null, codexVersion: '1.0.0' })
  const state = rerun(await readSetupState(w.env), { wiredHosts: ['claude-code'], encryption: 'off' })
  const flags = flagsOf({ yes: true, observers: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }] })
  const answers = await runWizard(w.env, null, state, flags, { ...NO_CHOICE, yes: true, flags: flags.observers })
  expect(answers.hosts).toEqual(['claude-code'])
  expect(answers.encryption).toEqual({ kind: 'keep' })
})

test('declining the summary cancels', async () => {
  const { w } = setup([ENTER, ENTER, ENTER, 'n'])
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, ask(w), state, flagsOf({ hosts: [], noEncrypt: true }), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
})

test('the wizard writes nothing to the machine', async () => {
  const { w } = setup(Array(8).fill(ENTER), { claudeVersion: '2.0.0', codexVersion: '1.0.0' })
  await installedWithTwoHosts(w)
  const state = await readSetupState(w.env)
  const before = snapshotTree(w.root)
  const calls = w.securityCalls.length
  await runWizard(w.env, ask(w), state, flagsOf(), NO_CHOICE)
  expect(snapshotTree(w.root)).toEqual(before)
  expect(w.securityCalls.slice(calls).some((call) => call.args[0] === '-i')).toBe(false)
})

test('a dry run shows no recovery code, and says a real run would show one at this step', async () => {
  const fresh = setup([ENTER, ENTER, ENTER, ENTER, ENTER])
  const state = await readSetupState(fresh.w.env)
  const answers = await runWizard(fresh.w.env, ask(fresh.w), state, flagsOf({ hosts: [] }), { ...NO_CHOICE, dryRun: true })
  expect(answers.encryption).toEqual({ kind: 'new-encrypted', key: null })
  expect(fresh.term.output()).not.toMatch(CODE_PATTERN)
  expect(fresh.term.output()).toContain(DRY_RUN_NO_CODE)
  await world?.cleanup()
  const plain = setup(['y', ENTER, ENTER, ENTER])
  const plainState = rerun(await readSetupState(plain.w.env), { encryption: 'off' })
  const converted = await runWizard(plain.w.env, ask(plain.w), plainState, flagsOf({ hosts: [] }), { ...NO_CHOICE, dryRun: true })
  expect(converted.encryption).toEqual({ kind: 'encrypt-existing', key: null })
  expect(plain.term.output()).not.toMatch(CODE_PATTERN)
  expect(plain.term.output()).toContain(DRY_RUN_NO_CODE)
})

const DOCS_NOTE = DOCS_HINT

test('a detected docs-level agent is listed but starts unticked', async () => {
  const { w, term } = setup(Array(7).fill(ENTER), { claudeVersion: '2.0.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE, undefined, profilesWithDocsAgent())
  expect(answers.hosts).toEqual(['claude-code'])
  expect(term.output()).toContain(`Gemini CLI`)
  expect(term.output()).toContain(`gemini answered --version · capture, context, search · ${DOCS_NOTE}`)
})

test('a detected live agent starts ticked', async () => {
  const { w, term } = setup(Array(7).fill(ENTER), { claudeVersion: '2.0.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE, undefined, profilesWithDocsAgent(false))
  expect(answers.hosts).toEqual(['claude-code'])
  expect(term.output()).toContain('Claude Code')
  expect(term.output()).toContain('2.0.0 · capture, context, search')
  // The agent step only: the observer step lists an unproven provider with its own reason.
  expect(term.output().split('Observer for ')[0]).not.toContain(DOCS_NOTE)
})

test('--yes installs detected live agents and leaves detected docs agents out unless --hosts names them', async () => {
  const { w } = setup([], { interactive: false, terminal: null, claudeVersion: '2.0.0', keychainRefs: ['openrouter'] })
  const state = await readSetupState(w.env)
  const profiles = profilesWithDocsAgent()
  const choice = { ...NO_CHOICE, yes: true }
  const byDefault = await runWizard(w.env, null, state, flagsOf({ yes: true }), choice, undefined, profiles)
  expect(byDefault.hosts).toEqual(['claude-code'])
  const named = await runWizard(w.env, null, state, flagsOf({ yes: true, hosts: ['claude-code', 'gemini-cli'] }), choice, undefined, profiles)
  expect(named.hosts).toEqual(['claude-code', 'gemini-cli'])
})

const ABSENT_BESIDE_CLAUDE = ['OpenCode', 'Codex', 'Cursor', 'Gemini CLI', 'Qwen Code', 'Factory Droid', 'Devin', 'Kilo Code', 'Cline', 'GitHub Copilot', 'Antigravity', 'Junie', 'Kiro', 'Amp', 'Kimi Code', 'Auggie', 'Goose', 'Crush', 'Zed', 'Warp']

/** The rows of the agent question as last drawn, without colour. */
function agentRows(output: string): string[] {
  const drawn = output.slice(output.lastIndexOf('Which agents should share memory?', output.lastIndexOf('[ ] ')))
  return drawn.split(/\r?\n/).map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter((line) => /^(> )?\[[ x]\] /.test(line))
}

test('every supported agent is a row: found ones can be ticked, the rest are shown as not installed', async () => {
  const { w, term } = setup(Array(7).fill(ENTER), { claudeVersion: '2.1.311 (Claude Code)' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.hosts).toEqual(['claude-code'])
  const rows = agentRows(term.output())
  expect(rows).toHaveLength(INSTALL_HOSTS.length)
  expect(rows).toHaveLength(22)
  expect(rows[0]).toBe('> [x] Claude Code  2.1.311 · capture, context, search')
  for (const name of ABSENT_BESIDE_CLAUDE) expect(rows).toContain(`[ ] ${name} (${NOT_INSTALLED_HINT})`)
  expect(rows).toContain(`[ ] Continue  ${UNDETECTABLE_HINT}`)
  // No folded line any more: the rows say it.
  expect(term.output()).not.toContain('not found: ')
})

test('Continue cannot be detected, so it starts unticked and can be picked', async () => {
  // Down moves from Claude Code over every disabled row to Continue, the only other open one.
  const { w, term } = setup([ENTER, DOWN, ' ', ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER], { claudeVersion: '2.0.0', keychainRefs: ['openrouter'] })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.hosts).toEqual(['claude-code', 'continue'])
  expect(agentRows(term.output())).toContain(`> [x] Continue  ${UNDETECTABLE_HINT}`)
})

test('an agent whose version is not supported is shown, disabled, with the reason', async () => {
  const { w, term } = setup(Array(7).fill(ENTER), { claudeVersion: '2.0.0', opencodeVersion: '1.4.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.hosts).toEqual(['claude-code'])
  expect(agentRows(term.output())).toContain('[ ] OpenCode (OpenCode 1.4.0 is not supported: the plugin needs OpenCode 2.0 or later)')
})

test('a disabled row cannot be ticked: Space on the list never adds an agent that is not installed', async () => {
  const { w } = setup([ENTER, ' ', DOWN, DOWN, ' ', ' ', ENTER, ENTER, ENTER, ENTER, ENTER, ENTER], { keychainRefs: ['openrouter'] })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  for (const host of answers.hosts) expect(host).toBe('continue')
})

test('auto-update is on by default, and a flag or a saved choice turns it off', async () => {
  const { w } = setup([], { interactive: false, terminal: null, claudeVersion: '2.0.0', codexVersion: '1.0.0', keychainRefs: ['openrouter'] })
  const state = await readSetupState(w.env)
  expect(state).toMatchObject({ autoUpdate: true, autoUpdateIntro: false })
  const yes = { ...NO_CHOICE, yes: true }
  expect((await runWizard(w.env, null, state, flagsOf({ yes: true }), yes)).autoUpdate).toBe(true)
  expect((await runWizard(w.env, null, state, flagsOf({ yes: true, noAutoUpdate: true }), yes)).autoUpdate).toBe(false)
  expect((await runWizard(w.env, null, { ...state, autoUpdate: false }, flagsOf({ yes: true }), yes)).autoUpdate).toBe(false)
})

test('one Updates question sets the daily check and automatic patch updates, with both on by default', async () => {
  const flags = flagsOf({ hosts: [], noEncrypt: true })
  const kept = setup([ENTER, ENTER, ENTER, ENTER])
  expect(await runWizard(kept.w.env, ask(kept.w), await readSetupState(kept.w.env), flags, NO_CHOICE)).toMatchObject({ updateCheck: true, autoUpdate: true })
  expect(kept.term.output()).toContain('Check daily and install patch releases')
  expect(kept.term.output()).toContain('Auto-update     patch releases')
  await kept.w.cleanup()

  const notify = setup([ENTER, ENTER, DOWN, ENTER, ENTER])
  expect(await runWizard(notify.w.env, ask(notify.w), await readSetupState(notify.w.env), flags, NO_CHOICE)).toMatchObject({ updateCheck: true, autoUpdate: false })
  expect(notify.term.output()).toContain('Auto-update     off')
  await notify.w.cleanup()

  const off = setup([ENTER, ENTER, DOWN, DOWN, ENTER, ENTER])
  expect(await runWizard(off.w.env, ask(off.w), await readSetupState(off.w.env), flags, NO_CHOICE)).toMatchObject({ updateCheck: false, autoUpdate: true })
  expect(off.term.output()).toContain('Auto-update     off (the update check is off)')
})

test('a saved choice is where the Updates question starts, and --no-auto-update takes that option away', async () => {
  const flags = flagsOf({ hosts: [], noEncrypt: true })
  const saved = setup([ENTER, ENTER, ENTER, ENTER])
  const state = rerun(await readSetupState(saved.w.env), { updateCheck: true, autoUpdate: false, encryption: 'off' })
  expect(await runWizard(saved.w.env, ask(saved.w), state, flagsOf({ hosts: [] }), NO_CHOICE)).toMatchObject({ updateCheck: true, autoUpdate: false })
  await saved.w.cleanup()

  const flagged = setup([ENTER, ENTER, ENTER, ENTER])
  expect(await runWizard(flagged.w.env, ask(flagged.w), await readSetupState(flagged.w.env), { ...flags, noAutoUpdate: true }, NO_CHOICE)).toMatchObject({ updateCheck: true, autoUpdate: false })
  expect(flagged.term.output()).not.toContain('install patch releases')
})

test('--auto-update turns a saved off back on, with or without a terminal', async () => {
  const quiet = setup([], { interactive: false, terminal: null, claudeVersion: '2.0.0', codexVersion: '1.0.0', keychainRefs: ['openrouter'] })
  const off = { ...(await readSetupState(quiet.w.env)), autoUpdate: false }
  expect((await runWizard(quiet.w.env, null, off, flagsOf({ yes: true, autoUpdate: true }), { ...NO_CHOICE, yes: true })).autoUpdate).toBe(true)
  await quiet.w.cleanup()
  const typed = setup([ENTER, ENTER, ENTER, ENTER])
  const state = { ...(await readSetupState(typed.w.env)), autoUpdate: false }
  expect(await runWizard(typed.w.env, ask(typed.w), state, flagsOf({ hosts: [], noEncrypt: true, autoUpdate: true }), NO_CHOICE)).toMatchObject({ updateCheck: true, autoUpdate: true })
})

// ---- the kinfold command ------------------------------------------------------

/** A world installed as a program in ~/.kinfold with zsh as the shell, where the PATH step applies. */
function programSetup(keys: readonly string[], pathEnv = '/usr/bin:/bin'): Setup {
  const made = setup(keys, { claudeVersion: '2.0.0', platform: 'linux' })
  made.w.env = { ...made.w.env, mode: { kind: 'program', binPath: join(made.w.dataDir, 'bin', 'kinfold') }, pathEnv, envVars: { SHELL: '/bin/zsh' } }
  return made
}

posixOnly('POSIX paths')('the PATH question comes after the updates, defaults to yes, and its answer is in the summary', async () => {
  // folder, agents, observer, port, updates, impact test, PATH, summary
  const { w, term } = programSetup(Array(8).fill(ENTER))
  const answers = await runWizard(w.env, ask(w), await readSetupState(w.env), flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.path).toBe('add')
  const output = term.output()
  expect(output.indexOf('Add kinfold to your PATH?')).toBeGreaterThan(output.indexOf('Updates:'))
  expect(output.indexOf('Add kinfold to your PATH?')).toBeLessThan(output.indexOf('Install with these choices?'))
  expect(output).toContain('kinfold command ~/.local/bin/kinfold, with ~/.local/bin on PATH through ~/.zshrc')
})

posixOnly('POSIX paths')('answering no is recorded as a decline, and the summary says PATH is left alone', async () => {
  const { w, term } = programSetup([ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, 'n', ENTER])
  const answers = await runWizard(w.env, ask(w), await readSetupState(w.env), flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.path).toBe('decline')
  expect(term.output()).toContain('kinfold command ~/.local/bin/kinfold; PATH left alone')
})

posixOnly('POSIX paths')('the PATH question is not asked when ~/.local/bin is on PATH, a flag answered it, or the run is a checkout', async () => {
  const onPath = programSetup(Array(7).fill(ENTER), '/usr/bin')
  onPath.w.env = { ...onPath.w.env, pathEnv: `/usr/bin:${join(onPath.w.home, '.local', 'bin')}` }
  expect((await runWizard(onPath.w.env, ask(onPath.w), await readSetupState(onPath.w.env), flagsOf({ noEncrypt: true }), NO_CHOICE)).path).toBeNull()
  expect(onPath.term.output()).not.toContain('Add kinfold to your PATH?')
  await world?.cleanup()
  const flagged = programSetup(Array(7).fill(ENTER))
  expect((await runWizard(flagged.w.env, ask(flagged.w), await readSetupState(flagged.w.env), flagsOf({ noEncrypt: true, path: 'no-path' }), NO_CHOICE)).path).toBeNull()
  expect(flagged.term.output()).not.toContain('Add kinfold to your PATH?')
  expect(flagged.term.output()).toContain('kinfold command not set up (--no-path)')
  await world?.cleanup()
  const checkout = setup(Array(7).fill(ENTER), { claudeVersion: '2.0.0' })
  expect((await runWizard(checkout.w.env, ask(checkout.w), await readSetupState(checkout.w.env), flagsOf({ noEncrypt: true }), NO_CHOICE)).path).toBeNull()
  expect(checkout.term.output()).not.toContain('kinfold command')
})

test('--yes and a run with no terminal never reach the PATH question', async () => {
  const { w, term } = programSetup([])
  const answers = await runWizard(w.env, ask(w), await readSetupState(w.env), flagsOf({ noEncrypt: true, yes: true }), { ...NO_CHOICE, yes: true })
  expect(answers.path).toBeNull()
  expect(term.output()).toBe('')
})

posixOnly('POSIX paths')('a block already in the startup file does not stop the question on an install that was never asked', async () => {
  const { w, term } = programSetup(Array(8).fill(ENTER))
  writeFileSync(join(w.home, '.zshrc'), withBlock('x\n', 'posix'))
  await runWizard(w.env, ask(w), await readSetupState(w.env), flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(term.output()).toContain('Add kinfold to your PATH?')
})

// ---- off: capture only --------------------------------------------------------

test('the observer question ends with off, and picking it saves the agent as capture only with no key and no check', async () => {
  // Agents, then down from the current row past the seven providers this machine can run (the cursor skips the others) to "off".
  const { w, term } = setup([ENTER, ENTER, ...Array(8).fill(DOWN), ENTER, ENTER, ENTER, ENTER, ENTER], { claudeVersion: '2.0.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  const plain = term.output().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  expect(plain).toContain('off (capture only, no summaries)')
  expect(answers.observers.map((choice) => choice.input)).toEqual([{ host: 'claude-code', provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: false }])
  expect(answers.observers[0]).toMatchObject({ origin: 'prompt', check: 'not run (observer off)', credential: null })
  // No model was called to test a choice that runs none.
  expect(w.commands.filter((command) => command.argv[0] === 'claude' && command.argv[1] !== '--version')).toEqual([])
})

// ---- the observer question follows what is installed -------------------------

/** The rows of the last observer question drawn, without colour. */
function observerRows(output: string): string[] {
  const plain = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  const drawn = plain.slice(plain.lastIndexOf('Observer for '))
  return drawn.split(/\r?\n/).slice(1).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('Model for'))
}

const versionProbes = (w: FakeWorld, binary: string): number => w.commands.filter((command) => command.argv[0] === binary && command.argv[1] === '--version').length

test('the observer question offers a CLI provider only when its CLI is on this machine', async () => {
  // Stops at the observer question: the keys run out there.
  const { w, term } = setup([ENTER, ENTER], { claudeVersion: '2.0.0', opencodeVersion: '2.1.0' })
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  expect(observerRows(term.output()).slice(0, 5)).toEqual([
    '> claude-cli/haiku  built-in default',
    'claude-cli',
    'openrouter',
    'codex-cli (codex not installed)',
    'opencode-cli',
  ])
  // The agent step asked each CLI for its version; the observer step asked none again.
  for (const binary of ['claude', 'codex', 'opencode']) expect(versionProbes(w, binary)).toBe(1)
})

test('a disabled observer row is skipped by the arrows, and another agent\'s installed CLI can be picked', async () => {
  // claude-code's observer: down, down lands on openrouter; down again skips codex-cli to opencode-cli.
  const keys = [ENTER, DOWN, DOWN, DOWN, ENTER, 'some/model\r', ENTER, ENTER, ENTER, ENTER, ENTER]
  const { w } = setup(keys, { claudeVersion: '2.0.0', opencodeVersion: '2.1.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: ['claude-code'], noEncrypt: true }), NO_CHOICE)
  expect(answers.observers[0]?.input).toMatchObject({ host: 'claude-code', provider: 'opencode-cli', model: 'some/model' })
})

test('a first row that names a missing CLI says so, and the cursor starts on the first row that can be picked', async () => {
  // Claude Code is found by its folder alone: no claude on PATH for the built-in default to run.
  const { w, term } = setup([ENTER, ENTER, ENTER, 'some/model\r', ENTER, ENTER, ENTER, ENTER], { keychainRefs: ['openrouter'] })
  mkdirSync(installPaths(w.env).claudeDir, { recursive: true })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), { ...NO_CHOICE, skipCheck: true })
  expect(answers.hosts).toEqual(['claude-code'])
  expect(answers.observers[0]?.input).toMatchObject({ provider: 'openrouter', model: 'some/model' })
  const plain = term.output().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  expect(plain).toContain('claude-cli/haiku  built-in default · claude not installed; pick another')
  expect(plain).toContain('claude-cli (claude not installed)')
  expect(plain).toContain('> openrouter')
})

test('an agent left out by --hosts still lends its CLI, looked for once and only when a question is asked', async () => {
  const { w, term } = setup([ENTER], { claudeVersion: '2.0.0', codexVersion: '0.9.0' })
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, ask(w), state, flagsOf({ hosts: ['claude-code'], noEncrypt: true }), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  expect(observerRows(term.output()).slice(0, 5)).toEqual(['> claude-cli/haiku  built-in default', 'claude-cli', 'openrouter', 'codex-cli', 'opencode-cli (opencode not installed)'])
  expect(versionProbes(w, 'codex')).toBe(1)
  expect(versionProbes(w, 'claude')).toBe(1)
})

test('--yes and --observer ask nothing, so they look for no CLI beyond the agent step', async () => {
  const { w } = setup([], { interactive: false, terminal: null, claudeVersion: '2.0.0', codexVersion: '0.9.0' })
  const state = await readSetupState(w.env)
  const flags = flagsOf({ yes: true, hosts: ['claude-code'], noEncrypt: true, observers: [{ host: 'claude-code', provider: 'codex-cli', model: 'gpt-x' }] })
  const answers = await runWizard(w.env, null, state, flags, { ...NO_CHOICE, yes: true, flags: flags.observers })
  expect(answers.observers[0]?.input.provider).toBe('codex-cli')
  expect(versionProbes(w, 'codex')).toBe(0)
  // A flag naming a CLI that is not there still fails at today's check, by its class.
  w.env.cliRunnerFor = () => ({ run: async () => { throw new ObserverError('cli_missing', 'x') }, runWithFiles: async () => ({ text: '', model: 'm' }), probe: async () => ({ version: '1', binaryPath: '/x' }), listModels: async () => [] })
  await expect(runWizard(w.env, null, state, flags, { ...NO_CHOICE, yes: true, flags: flags.observers })).rejects.toThrow('observer check for claude-code failed: cli_missing')
})

test('--plain on a terminal gets the same rules as plain lines', async () => {
  const { w } = setup([], { terminal: null, claudeVersion: '2.0.0', answers: ['codex-cli:gpt-x', ''] })
  const asked: string[] = []
  const plainAsk = w.env.io.ask
  w.env.io.ask = async (question) => (asked.push(question), plainAsk(question))
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, null, state, flagsOf({ hosts: ['claude-code'], noEncrypt: true }), { ...NO_CHOICE, skipCheck: true })
  expect(asked[0]).toContain('codex-cli (codex not installed), opencode-cli (opencode not installed), goose-cli (goose not installed),')
  expect(w.out).toContain('codex-cli cannot be picked: codex not installed')
  expect(answers.observers[0]?.origin).toBe('default')
})

test('a saved choice whose CLI is gone stays on its row with the warning, and can still be kept', async () => {
  // Wired and saved while claude was installed; now only the folder is left. Up from openrouter skips the disabled claude-cli row to the saved one.
  const { w, term } = setup([ENTER, '\u001b[A', ENTER, ENTER, ENTER, ENTER, ENTER, ENTER], { codexVersion: '1.0.0' })
  await installedWithTwoHosts(w)
  const state = rerun(await readSetupState(w.env), { wiredHosts: ['claude-code'] })
  const answers = await runWizard(w.env, ask(w), state, flagsOf(), NO_CHOICE)
  const plain = term.output().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  expect(plain).toContain('claude-cli/haiku  saved · claude not installed; pick another')
  expect(plain).toContain('> openrouter')
  expect(answers.observers[0]).toMatchObject({ input: CLAUDE_ROW, origin: 'saved', check: 'unchanged' })
})

// ---- the impact test ----------------------------------------------------------

const IMPACT_QUESTION = 'Run the impact test?'

/** A re-run with only the named hosts picked, so the keys reach the impact question quickly: observer, port, updates, then it. */
async function impactRun(keys: readonly string[], hosts: SetupFlags['hosts'], over: Partial<SetupFlags> = {}, prepare?: (w: FakeWorld) => void): Promise<{ answers: Awaited<ReturnType<typeof runWizard>>; output: string }> {
  const { w, term } = setup(keys, { claudeVersion: '2.0.0', codexVersion: '1.0.0', keychainRefs: ['openrouter'] })
  mkdirSync(w.dataDir, { recursive: true })
  prepare?.(w)
  const state = rerun(await readSetupState(w.env))
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts, noEncrypt: true, ...over }), NO_CHOICE)
  return { answers, output: term.output() }
}

test('the impact test is asked after Updates when Claude Code is picked, and defaults to no', async () => {
  // observer, port, updates, impact test, summary
  const { answers, output } = await impactRun(Array(5).fill(ENTER), ['claude-code'])
  expect(answers.holdout).toBe(false)
  expect(output).toContain('Run the impact test? Kinfold skips memory on about 1 in 10 Claude Code prompts and compares token use, to measure what memory saves.')
  expect(output.indexOf(IMPACT_QUESTION)).toBeGreaterThan(output.indexOf('Updates:'))
  expect(output.indexOf(IMPACT_QUESTION)).toBeLessThan(output.indexOf('Install with these choices?'))
  expect(output).toContain('Impact test     off')
})

test('answering yes turns the impact test on, and the summary says so', async () => {
  const { answers, output } = await impactRun([ENTER, ENTER, ENTER, 'y', ENTER], ['claude-code'])
  expect(answers.holdout).toBe(true)
  expect(output).toContain('Impact test     on for Claude Code')
})

test('the impact test is not asked when Claude Code is not among the picked agents', async () => {
  // observer, port, updates, summary
  const { answers, output } = await impactRun(Array(4).fill(ENTER), ['codex'])
  expect(answers.holdout).toBeUndefined()
  expect(output).not.toContain(IMPACT_QUESTION)
  expect(output).not.toContain('Impact test')
})

test('a saved impact test choice is the default on a later install', async () => {
  const { answers } = await impactRun(Array(5).fill(ENTER), ['claude-code'], {}, (w) => writeFileSync(join(w.dataDir, 'display.json'), JSON.stringify({ showRecall: true, holdout: true })))
  expect(answers.holdout).toBe(true)
})

test('--holdout and --no-holdout answer the impact question, so it is not asked', async () => {
  for (const holdout of [true, false]) {
    const { answers, output } = await impactRun(Array(4).fill(ENTER), ['claude-code'], { holdout })
    expect(answers.holdout).toBeUndefined()
    expect(output).not.toContain(IMPACT_QUESTION)
    await world?.cleanup()
    world = null
  }
})

test('--yes and a run with no terminal keep the saved impact test choice by asking nothing', async () => {
  const { w, term } = setup([], { claudeVersion: '2.0.0' })
  const answers = await runWizard(w.env, ask(w), await readSetupState(w.env), flagsOf({ yes: true }), { ...NO_CHOICE, yes: true })
  expect(answers.holdout).toBeUndefined()
  expect(term.output()).toBe('')
  const quiet = await runWizard(w.env, null, await readSetupState(w.env), flagsOf(), NO_CHOICE).catch(() => null)
  expect(quiet?.holdout).toBeUndefined()
})

// ---- API providers, endpoints, goose and auggie -------------------------------

test('the observer question lists the API providers with what each needs, and auggie-cli as not pickable', async () => {
  const { w, term } = setup([ENTER, ENTER], { claudeVersion: '2.0.0', opencodeVersion: '2.1.0' })
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  const rows = observerRows(term.output())
  expect(rows.slice(5, 12)).toEqual([
    'goose-cli (goose not installed)',
    'anthropic-api  your Anthropic API key',
    'openai-api  your OpenAI API key',
    'gemini-api  your Google AI Studio key',
    'qwen-api  your DashScope key and its region\'s address',
    'openai-compatible  any OpenAI-style server: Ollama, LM Studio, Groq, DeepSeek…',
    expect.stringMatching(/^auggie-cli \(built from the docs, not proven/) as unknown as string,
  ])
})

test('picking an API provider offers its cheap default model and saves its key ref', async () => {
  // claude installed only: pickable rows are current, claude-cli, openrouter, then the API providers.
  const keys = [ENTER, ...Array(3).fill(DOWN), ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER]
  const { w } = setup(keys, { claudeVersion: '2.0.0', keychainRefs: ['anthropic'] })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: ['claude-code'], noEncrypt: true }), { ...NO_CHOICE, skipCheck: true })
  expect(answers.observers[0]?.input).toEqual({ host: 'claude-code', provider: 'anthropic-api', model: 'claude-haiku-5-5', credentialRef: 'anthropic', enabled: true })
})

test('picking the OpenAI-compatible provider asks for the model, then the address, and a local one needs no key', async () => {
  const keys = [ENTER, ...Array(7).fill(DOWN), ENTER, 'llama3.2\r', ENTER, ENTER, ENTER, ENTER, ENTER, ENTER]
  const { w, term } = setup(keys, { claudeVersion: '2.0.0' })
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ hosts: ['claude-code'], noEncrypt: true }), { ...NO_CHOICE, skipCheck: true })
  expect(answers.observers[0]?.input).toEqual({ host: 'claude-code', provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, endpoint: 'http://127.0.0.1:11434/v1' })
  expect(term.output()).toContain('Endpoint for openai-compatible on claude-code (https, or http on this machine; Enter for http://127.0.0.1:11434/v1)')
})

test('an agent whose own CLI cannot observe is told why at its observer question', async () => {
  const { w, term } = setup([ENTER], { claudeVersion: '2.0.0' })
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, ask(w), state, flagsOf({ hosts: ['gemini-cli'], noEncrypt: true }), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  expect(term.output().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')).toContain('Gemini CLI cannot summarise through its own CLI')
})
