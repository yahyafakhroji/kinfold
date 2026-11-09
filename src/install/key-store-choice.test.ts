import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DB_KEY_REF } from '../secrets/credentials'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF } from '../secrets/hmac-keys'
import type { KeyStoreDeps, KeyStoreKind, KeyStoreModule } from '../secrets/key-store'
import { KEY_STORE_FILE, recordUnreadableMessage } from '../secrets/key-store-record'
import { createKeychainStore } from '../secrets/stores/keychain'
import { KEY_STORE_MODULES } from '../secrets/stores/select'
import { stubKeyStoreModule } from '../secrets/stores/stub'
import { newDbKey } from '../sqlite/keys'
import { openStore } from '../store/db'
import { HMAC_KEY_FILE } from '../store/data-dir'
import { runKeyCommand } from './encrypt'
import { EXIT_FAILED, EXIT_OK, install } from './install'
import { chooseInstallKeyStore, keyStoreRecordActions, keyStoreStatusLine, secretDeleteAction, secretSetAction } from './key-store-choice'
import { describeAction } from './plan'
import { fakeTerminal } from './prompt/fake-terminal'
import { PromptCancelled, createPrompts } from './prompt/prompts'
import type { TerminalIO } from './prompt/terminal'
import { readSetupState } from './setup/prefill'
import { type SetupFlags, runWizard } from './setup/wizard'
import { status } from './status'
import { type FakeWorld, YES, createWorld, forbiddenSecurity, recordingKeyStore, snapshotTree } from './test-support'
import { uninstall } from './uninstall'

type ModuleTable = Readonly<Record<KeyStoreKind, KeyStoreModule>>

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function make(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', keychainRefs: ['openrouter'], ...options })
  return world
}

async function fresh(options: Parameters<typeof createWorld>[0] = {}): Promise<FakeWorld> {
  await world?.cleanup()
  return make(options)
}

const DRY = { ...YES, dryRun: true } as const
const planLines = (w: FakeWorld): string[] => w.out.filter((line) => /^ {2}\d+\. /.test(line))
const firstIndex = (lines: readonly string[], text: string): number => lines.findIndex((line) => line.includes(text))
const recordPath = (w: FakeWorld): string => join(w.dataDir, KEY_STORE_FILE)

function writeRecord(w: FakeWorld, content: string): void {
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(recordPath(w), content)
}

/** The real modules with each probe counted. */
function countingModules(): { modules: ModuleTable; probes: () => number } {
  let count = 0
  const entries = Object.entries(KEY_STORE_MODULES).map(([kind, module]) => [kind, { ...module, probe: (deps: KeyStoreDeps) => (count++, module.probe(deps)) }])
  return { modules: Object.fromEntries(entries) as unknown as ModuleTable, probes: () => count }
}

test('a first install records the key store before any key is written', async () => {
  const w = make()
  expect(await install(w.env, DRY)).toBe(EXIT_OK)
  const lines = planLines(w)
  const record = firstIndex(lines, `record the key store (keychain) in ${recordPath(w)}`)
  expect(record).toBeGreaterThanOrEqual(0)
  const keyLines = lines.flatMap((line, index) => (line.includes(`create ${DB_KEY_REF}`) || line.includes('add-generic-password') ? [index] : []))
  expect(keyLines.length).toBeGreaterThan(0)
  for (const index of keyLines) expect(index).toBeGreaterThan(record)

  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(JSON.parse(readFileSync(recordPath(w), 'utf8')).store).toBe('keychain')
})

test('a re-run keeps the recorded store and never chooses again', async () => {
  const w = make()
  writeRecord(w, `${JSON.stringify({ store: 'keychain', chosenAt: 1_792_900_000_000 })}\n`)
  const { modules, probes } = countingModules()
  expect(chooseInstallKeyStore(w.env, modules).kind).toBe('recorded')
  expect(await install(w.env, { ...DRY, keyStoreModules: modules })).toBe(EXIT_OK)
  expect(probes()).toBe(0)
  expect(planLines(w).some((line) => line.includes('record the key store'))).toBe(false)
})

test('an install from before the record is recorded as the Keychain and nothing else changes', async () => {
  const key = newDbKey()
  const w = make({ keychainRefs: ['openrouter', DB_KEY_REF, HMAC_MASTER_REF] })
  w.keychainValues.set(DB_KEY_REF, key)
  openStore(w.dataDir, { keys: { name: 'fixture', read: () => key, exists: () => true } }).db.close()
  expect(await install(w.env, DRY)).toBe(EXIT_OK)
  const lines = planLines(w)
  expect(firstIndex(lines, 'record the key store (keychain)')).toBeGreaterThanOrEqual(0)
  expect(lines.some((line) => line.includes(`create ${DB_KEY_REF}`))).toBe(false)
  expect(lines.some((line) => line.includes('add-generic-password'))).toBe(false)
})

test('an unreadable record stops install before anything is written', async () => {
  const w = make()
  writeRecord(w, '{"store": "keychain", "chosenAt": ')
  const before = snapshotTree(w.dataDir)
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out).toContain(`install failed: ${recordUnreadableMessage(recordPath(w))}`)
  expect(snapshotTree(w.dataDir)).toEqual(before)
  expect(w.securityCalls.filter((call) => call.stdin !== undefined)).toEqual([])
})

test('no usable store leaves a new store plaintext and records nothing', async () => {
  const w = make({ platform: 'linux', keychainRefs: [] })
  const modules: ModuleTable = {
    ...KEY_STORE_MODULES,
    libsecret: stubKeyStoreModule('libsecret', 'libsecret', 'the Secret Service'),
    'key-file': stubKeyStoreModule('key-file', 'key file', 'the key file'),
  }
  expect(await install(w.env, { ...DRY, keyStoreModules: modules })).toBe(EXIT_OK)
  expect(planLines(w).some((line) => line.includes('record the key store'))).toBe(false)
  expect(w.out).toContain('database: no key store on linux yet; the new store is created plaintext')
  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(w.out).toContain('key store: none on linux; new stores are created plaintext')
})

test('a chosen store records its location', async () => {
  const w = make({ platform: 'linux' })
  const modules: ModuleTable = {
    ...KEY_STORE_MODULES,
    libsecret: {
      kind: 'libsecret',
      label: 'libsecret',
      probe: () => ({ usable: true }),
      open: () => recordingKeyStore({ kind: 'libsecret', label: 'libsecret' }),
      location: () => '/h/.config/kinfold',
    },
  }
  const choice = chooseInstallKeyStore(w.env, modules)
  expect(choice.kind).toBe('chosen')
  const [action] = keyStoreRecordActions(w.env, choice, modules)
  expect(action?.kind === 'record-key-store' ? action.record.location : null).toBe('/h/.config/kinfold')

  const mac = await fresh()
  const [keychain] = keyStoreRecordActions(mac.env, chooseInstallKeyStore(mac.env))
  expect(keychain?.kind === 'record-key-store' ? keychain.record.store : null).toBe('keychain')
  expect(keychain?.kind === 'record-key-store' ? 'location' in keychain.record : true).toBe(false)
})

const ENTER = '\r'
const CTRL_C = '\u0003'
const CODE = /(?:[0-9A-Z]{5}-){10}[0-9A-Z]{5}/g
const NO_CHOICE = { yes: false, dryRun: false, skipCheck: false, replaceCredential: false, credentialStdin: false, flags: [] } as const
const flagsOf = (over: Partial<SetupFlags> = {}): SetupFlags => ({ dataDir: null, hosts: [], observers: [], noEncrypt: false, port: null, noUpdateCheck: false, yes: false, ...over })

/** The wizard on a new store up to the recovery code, where Ctrl-C stops it; the terminal's text with the code masked. */
async function encryptionScreen(notes: readonly string[] | null): Promise<string> {
  const term = fakeTerminal([ENTER, ENTER, CTRL_C])
  const w = await fresh({ interactive: true, terminal: term })
  w.env.portFree = async () => true
  if (notes !== null) w.env.keyStore = recordingKeyStore({ notes })
  const state = await readSetupState(w.env)
  await expect(runWizard(w.env, createPrompts(term as TerminalIO), state, flagsOf(), NO_CHOICE)).rejects.toBeInstanceOf(PromptCancelled)
  return term.output().replace(CODE, '<code>')
}

test("the encryption step prints the chosen store's notes", async () => {
  const screen = await encryptionScreen(['note one', 'note two'])
  const question = screen.indexOf('Encrypt memory.db?')
  expect(question).toBeGreaterThanOrEqual(0)
  expect(screen.indexOf('note one')).toBeGreaterThan(question)
  expect(screen.indexOf('note two')).toBeGreaterThan(screen.indexOf('note one'))

  const w = await fresh()
  w.env.keyStore = recordingKeyStore({ notes: ['note one', 'note two'] })
  await runWizard(w.env, null, await readSetupState(w.env), flagsOf({ yes: true }), { ...NO_CHOICE, yes: true })
  expect(w.out.filter((line) => line === 'note one')).toHaveLength(1)
  expect(w.out.filter((line) => line === 'note two')).toHaveLength(1)

  // The Keychain has no notes, so its screen is the one a store without notes gives.
  expect(createKeychainStore(forbiddenSecurity()).notes).toEqual([])
  expect(await encryptionScreen(null)).toBe(await encryptionScreen([]))
})

test('macOS dry-run lines are unchanged', () => {
  const keychain = createKeychainStore(forbiddenSecurity())
  expect(describeAction(secretSetAction(keychain, 'openrouter', 'sk-or-v1-abc'))).toBe('keychain: /usr/bin/security -i <<< "add-generic-password -U -s kinfold -a openrouter -w <hidden>"')
  expect(describeAction(secretDeleteAction(keychain, 'hmac-master'))).toBe('keychain: /usr/bin/security delete-generic-password -s kinfold -a hmac-master')
  expect(describeAction(secretDeleteAction(keychain, 'hmac-master', 'the HMAC master'))).toBe('keychain: /usr/bin/security delete-generic-password -s kinfold -a hmac-master: the HMAC master')
})

test('status names the key store in use', async () => {
  const w = make()
  expect(keyStoreStatusLine(w.env)).toBe('key store: keychain (not recorded yet; the next install records it)')
  writeRecord(w, `${JSON.stringify({ store: 'keychain', chosenAt: 1_792_900_000_000 })}\n`)
  expect(keyStoreStatusLine(w.env)).toBe('key store: keychain (recorded in key-store.json)')
  expect(await status(w.env)).toBe(EXIT_OK)
  const database = w.out.findIndex((line) => line.startsWith('database: '))
  expect(w.out[database + 1]).toBe('key store: keychain (recorded in key-store.json)')
  writeRecord(w, 'not json')
  expect(keyStoreStatusLine(w.env)).toBe(`key store: unknown (${recordUnreadableMessage(recordPath(w))})`)
})

test('every secret goes through the store', async () => {
  const w = make({ opencodeVersion: 'opencode v2.1.4', keychainRefs: [], stdin: 'sk-or-v1-0123456789abcdef', interactive: true })
  const store = recordingKeyStore()
  w.env.keyStore = store
  w.env.security = forbiddenSecurity()
  w.env.io = { ...w.env.io, printsToTerminal: true }
  writeFileSync(join(w.dataDir, HMAC_KEY_FILE), newDbKey(), { mode: 0o600 })

  expect(await install(w.env, { ...YES, credentialStdin: true })).toBe(EXIT_OK)
  expect(await runKeyCommand(w.env, 'show-recovery')).toBe(EXIT_OK)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_OK)

  expect(new Set(store.seen)).toEqual(new Set([DB_KEY_REF, HMAC_MASTER_REF, HMAC_LEGACY_REF, 'openrouter']))
  expect(store.values.has('openrouter')).toBe(true)
  expect(store.values.has(HMAC_MASTER_REF)).toBe(false)
})

test('an unreadable record still lets uninstall remove what it can, skipping only the key deletes', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  writeRecord(w, 'not json')
  const keysBefore = new Set(w.keychain)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: true, removeHmacKeys: true })).toBe(EXIT_FAILED)
  expect(w.out).toContain(`key store: unknown (${recordUnreadableMessage(recordPath(w))}); --remove-credentials and --remove-hmac-keys skipped, no key was deleted`)
  expect(w.keychain).toEqual(keysBefore)
  expect(w.launchd.loaded).toBe(false)
})

test("encrypt refuses with today's message where there is no key store", async () => {
  const w = make({ platform: 'linux', interactive: true })
  w.env.io = { ...w.env.io, printsToTerminal: true }
  expect(await runKeyCommand(w.env, 'encrypt')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe('kinfold encrypt: encryption needs the macOS Keychain; linux gets its key store in a later release')
})

test('a first install on another folder records the store there, and an injected store stays with the first folder', async () => {
  const w = make()
  const other = join(w.root, 'other-memory')
  const injected = recordingKeyStore()
  w.env.keyStore = injected
  expect(await install(w.env, { ...DRY, dataDirFlag: other })).toBe(EXIT_OK)
  const lines = planLines(w)
  // The folder the wizard ends on gets a store of its own: the Keychain, chosen afresh, not the injected one.
  expect(lines.some((line) => line.includes(`record the key store (keychain) in ${join(other, KEY_STORE_FILE)}`))).toBe(true)
  expect(lines.some((line) => line.includes(recordPath(w)))).toBe(false)
  expect(injected.seen).toEqual([])
})
