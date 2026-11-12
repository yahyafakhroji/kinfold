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
import { type FakeWorld, createWorld, snapshotTree, startWorldDaemon } from '../test-support'
import { LOCKED_FOLDER_NOTE, type SetupState, readSetupState } from './prefill'
import { installRecordAction } from './record'
import { DRY_RUN_NO_CODE, NO_TTY_ENCRYPTION_CHANGE, STALE_DB_KEY, type SetupFlags, freePortFrom, runWizard } from './wizard'
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

const flagsOf = (over: Partial<SetupFlags> = {}): SetupFlags => ({ dataDir: null, hosts: null, observers: [], noEncrypt: false, port: null, noUpdateCheck: false, yes: false, ...over })

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
  await runPlan(w.env, [installRecordAction(w.dataDir, { channel: 'curl', updateCheck: false, firstInstalledAt: 1_700_000_000_000 })], false)
  const store = openStore(w.dataDir, { keys: NO_DB_KEYS })
  try {
    upsertObserverSettings(store.db, CLAUDE_ROW, 1)
    upsertObserverSettings(store.db, CODEX_ROW, 1)
  } finally {
    store.db.close()
  }
}

test('Enter on every step keeps a re-run unchanged', async () => {
  const { w, term } = setup(Array(7).fill(ENTER), { claudeVersion: '2.0.0', codexVersion: '1.0.0' })
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
  const keys = [ENTER, DOWN, DOWN, DOWN, ENTER, 'gpt-x\r', ENTER, ENTER, ENTER, ENTER, ENTER]
  const { w, term } = setup(keys, { claudeVersion: '2.0.0', cliRunner: () => failingOnce })
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
  const terminal = readingCodeFrom([ENTER, ENTER, ENTER, 'AAAAA-BBBBB\r'], '\r\r\r\r')
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
  const { w } = setup([ENTER, ENTER, ENTER, ENTER, ENTER])
  const state = rerun(await readSetupState(w.env), { wiredHosts: ['claude-code'], encryption: 'off' })
  const flags = flagsOf({ observers: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }] })
  const answers = await runWizard(w.env, ask(w), state, flags, { ...NO_CHOICE, flags: flags.observers })
  expect(answers.hosts).toEqual(['claude-code'])
})

test('no detected agent on a first install skips the agent question', async () => {
  const { w, term } = setup([ENTER, ENTER, ENTER, ENTER])
  const state = await readSetupState(w.env)
  const answers = await runWizard(w.env, ask(w), state, flagsOf({ noEncrypt: true }), NO_CHOICE)
  expect(answers.hosts).toEqual([])
  expect(term.output()).toContain('No supported agent was found')
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
  const { w } = setup(Array(7).fill(ENTER), { claudeVersion: '2.0.0', codexVersion: '1.0.0' })
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
