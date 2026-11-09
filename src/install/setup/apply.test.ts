import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envForDataDir } from '../../cli/kinfold'
import { DB_KEY_REF } from '../../secrets/credentials'
import { NO_DB_KEYS, newDbKey } from '../../sqlite/keys'
import { fileState, openEncrypted } from '../../sqlite/open'
import { encodeRecoveryCode } from '../../sqlite/recovery'
import { DB_FILE } from '../../store/data-dir'
import { openStore } from '../../store/db'
import { DB_KEY_MISMATCH, STALE_DB_KEY } from '../db-encryption'
import { type InstallEnv, installPaths } from '../env'
import { installedProgramPath } from '../entry'
import { EXIT_FAILED, EXIT_OK, type InstallOptions, install } from '../install'
import { LAUNCHCTL, bootoutArgv } from '../launch-agent'
import { MCP_SERVER_NAME, claudeMcpEntry } from '../mcp-config'
import { mcpPaths, mcpTarget } from '../mcp-wiring'
import type { ObserverChoice } from '../observer-choice'
import { fakeTerminal } from '../prompt/fake-terminal'
import type { TerminalIO } from '../prompt/terminal'
import type { ServiceControl } from '../service/control'
import { LaunchAgentService } from '../service/launch-agent-service'
import { type FakeWorld, UID, YES, createWorld, fakeService, snapshotTree } from '../test-support'
import { SHOW_RECOVERY_LINE, applySetup, doneLines } from './apply'
import { type SetupState, readSetupState } from './prefill'
import { INSTALL_RECORD_FILE } from './record'
import type { EncryptionAnswer, SetupAnswers } from './wizard'

const CLAUDE = '2.1.310 (Claude Code)'
const OPENCODE = 'opencode v2.1.4'
const CODEX = 'codex-cli 0.50.0'
const ENTER = '\r'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function make(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld({ claudeVersion: CLAUDE, keychainRefs: ['openrouter'], ...options })
  return world
}

const planLines = (w: FakeWorld): string[] => w.out.filter((line) => /^ {2}\d+\. /.test(line))
const backupsOf = (path: string): string[] => (existsSync(dirname(path)) ? readdirSync(dirname(path)).filter((name) => name.startsWith(`${path.split('/').at(-1)}.kinfold-backup-`)) : [])

/** The answers a re-run gives when every step keeps what the machine has, with `over` changed. */
function keeping(state: SetupState, over: Partial<SetupAnswers> = {}): SetupAnswers {
  const observers: ObserverChoice[] = state.wiredHosts.flatMap((host) => {
    const input = state.observers.get(host)
    return input === undefined ? [] : [{ input, origin: 'saved' as const, credential: null, credentialNote: 'no key needed', check: 'unchanged' as const }]
  })
  return { dataDir: state.dataDir, hosts: state.wiredHosts, observers, encryption: { kind: 'keep' }, port: state.port, updateCheck: state.updateCheck, ...over }
}

/** The real LaunchAgent service over the world's launchctl, recording what the encrypt and decrypt flows ask of it. */
function recordingService(env: InstallEnv): ServiceControl & { calls: string[] } {
  const real = new LaunchAgentService(env)
  const calls: string[] = []
  return {
    label: real.label,
    calls,
    isConfigured: () => real.isConfigured(),
    isRunning: () => real.isRunning(),
    start: async () => (calls.push('start'), real.start()),
    stop: async () => (calls.push('stop'), real.stop()),
    configuredDataDir: () => real.configuredDataDir(),
    configuredPort: () => real.configuredPort(),
    fileHolders: (path) => real.fileHolders(path),
    configPath: () => real.configPath(),
    configContent: (port) => real.configContent(port),
    describe: (step) => real.describe(step),
    unavailableReason: () => real.unavailableReason(),
  }
}

async function applyWith(w: FakeWorld, encryption: EncryptionAnswer, options: InstallOptions = YES): Promise<{ code: number; state: SetupState }> {
  const state = await readSetupState(w.env)
  return { code: await applySetup(w.env, state, keeping(state, { encryption }), options), state }
}

test('unticking an agent unwires it and ticking one wires it', async () => {
  const w = make({ opencodeVersion: OPENCODE, codexVersion: CODEX })
  const paths = installPaths(w.env)
  const opencodeConfig = mcpPaths(w.env).opencodeConfig
  mkdirSync(dirname(opencodeConfig), { recursive: true })
  const opencodeOriginal = `${JSON.stringify({ theme: 'x', mcp: { other: { type: 'local', command: ['other-server'] } } }, null, 2)}\n`
  writeFileSync(opencodeConfig, opencodeOriginal)
  expect(await install(w.env, { ...YES, hosts: ['claude-code', 'opencode'] })).toBe(EXIT_OK)
  expect(existsSync(paths.opencodePlugin)).toBe(true)
  const claudeBefore = readFileSync(paths.claudeSettings, 'utf8')
  mkdirSync(dirname(paths.codexHooks), { recursive: true })
  const codexOriginal = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-stop' }] }] } }, null, 2)}\n`
  writeFileSync(paths.codexHooks, codexOriginal)

  w.out.length = 0
  expect(await install(w.env, { ...YES, hosts: ['claude-code', 'codex'] })).toBe(EXIT_OK)

  expect(existsSync(paths.opencodePlugin)).toBe(false)
  const opencode = JSON.parse(readFileSync(opencodeConfig, 'utf8'))
  expect(opencode).toEqual({ theme: 'x', mcp: { other: { type: 'local', command: ['other-server'] } } })
  expect(backupsOf(opencodeConfig).length).toBe(1)
  // One backup beside each config, of the file as it was before Kinfold first changed it.
  expect(readFileSync(join(dirname(opencodeConfig), backupsOf(opencodeConfig)[0]!), 'utf8')).toBe(opencodeOriginal)
  const codex = JSON.parse(readFileSync(paths.codexHooks, 'utf8'))
  expect(JSON.stringify(codex)).toContain('their-stop')
  expect(JSON.stringify(codex)).toContain('kinfold')
  expect(readFileSync(join(dirname(paths.codexHooks), backupsOf(paths.codexHooks)[0]!), 'utf8')).toBe(codexOriginal)
  expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(claudeBefore)
  // The kept and the new host are wired before the dropped one goes.
  const lines = planLines(w)
  const codexWrite = lines.findIndex((line) => line.includes(`write ${paths.codexHooks}`))
  const pluginRemove = lines.findIndex((line) => line.includes(`remove ${paths.opencodePlugin}`))
  expect(codexWrite).toBeGreaterThanOrEqual(0)
  expect(pluginRemove).toBeGreaterThan(codexWrite)
  expect(w.out).toContain('No longer wired: opencode.')
  expect((await readSetupState(w.env)).wiredHosts).toEqual(['claude-code', 'codex'])
})

test('a re-run with nothing changed writes nothing but the health check', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const record = join(w.dataDir, INSTALL_RECORD_FILE)
  const recorded = readFileSync(record, 'utf8')
  const mtime = statSync(record).mtimeMs
  // What `claude mcp add-json` would have written; the fake claude writes nothing.
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(w.env)) } }))
  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const lines = planLines(w)
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('wait up to')
  expect(lines.some((line) => /\. (write|chmod|back up|mkdir)\b/.test(line))).toBe(false)
  expect(readFileSync(record, 'utf8')).toBe(recorded)
  expect(statSync(record).mtimeMs).toBe(mtime)
})

test('a changed port reaches the plist and restarts the daemon', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(readFileSync(installPaths(w.env).launchAgentPlist, 'utf8')).not.toContain('KINFOLD_PORT')
  w.commands.length = 0
  w.out.length = 0
  expect(await install(w.env, { ...YES, port: 40000 })).toBe(EXIT_OK)
  expect(readFileSync(installPaths(w.env).launchAgentPlist, 'utf8')).toContain('<key>KINFOLD_PORT</key><string>40000</string>')
  const verbs = w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => c.argv[1])
  expect(verbs.filter((verb) => verb !== 'print')).toEqual(['bootout', 'bootstrap'])
  expect(planLines(w).at(-1)).toContain('wait up to')
  expect((await readSetupState(w.env)).port).toBe(40000)
})

test('--no-encrypt on a new store creates it plaintext before the daemon starts', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, noEncrypt: true })).toBe(EXIT_OK)
  expect(fileState(join(w.dataDir, DB_FILE))).toBe('plain')
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
})

test('encryption on an existing plaintext store runs encrypt after the plan', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, noEncrypt: true })).toBe(EXIT_OK)
  const service = recordingService(w.env)
  w.env = { ...w.env, service }
  w.out.length = 0
  const key = newDbKey()
  const { code } = await applyWith(w, { kind: 'encrypt-existing', key })
  expect(code).toBe(EXIT_OK)
  const path = join(w.dataDir, DB_FILE)
  expect(fileState(path)).toBe('encrypted')
  openEncrypted(path, key, { readonly: true }).close()
  expect(w.keychainValues.get(DB_KEY_REF)).toBe(key)
  expect(service.calls).toEqual(['stop', 'start'])
  const printed = w.out.join('\n')
  expect(printed).not.toContain(encodeRecoveryCode(key))
  expect(printed).not.toContain(key)
  expect(printed).toContain('memory.db is encrypted.')
})

test('encryption off runs decrypt and removes db-key', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(fileState(join(w.dataDir, DB_FILE))).toBe('encrypted')
  const { code } = await applyWith(w, { kind: 'decrypt-existing' })
  expect(code).toBe(EXIT_OK)
  expect(fileState(join(w.dataDir, DB_FILE))).toBe('plain')
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
})

test('a new encrypted store uses the key whose code was shown', async () => {
  const w = make()
  const key = newDbKey()
  const { code } = await applyWith(w, { kind: 'new-encrypted', key })
  expect(code).toBe(EXIT_OK)
  expect(w.keychainValues.get(DB_KEY_REF)).toBe(key)
  openEncrypted(join(w.dataDir, DB_FILE), key, { readonly: true }).close()
  expect(planLines(w).join('\n')).not.toContain(key)
  expect(w.out).not.toContain(SHOW_RECOVERY_LINE)
})

test('a db-key that is not the shown one fails the key step and no store is made under it', async () => {
  const w = make()
  const other = newDbKey()
  w.keychain.add(DB_KEY_REF)
  w.keychainValues.set(DB_KEY_REF, other)
  const { code } = await applyWith(w, { kind: 'new-encrypted', key: newDbKey() })
  expect(code).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain(DB_KEY_MISMATCH)
  expect(w.keychainValues.get(DB_KEY_REF)).toBe(other)
  expect(fileState(join(w.dataDir, DB_FILE))).toBe('new')
  expect(w.launchd.loaded).toBe(false)
})

test('--yes on a new store reuses a usable db-key and points to its code', async () => {
  const w = make()
  const key = newDbKey()
  w.keychain.add(DB_KEY_REF)
  w.keychainValues.set(DB_KEY_REF, key)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.keychainValues.get(DB_KEY_REF)).toBe(key)
  openEncrypted(join(w.dataDir, DB_FILE), key, { readonly: true }).close()
  expect(w.out).toContain(SHOW_RECOVERY_LINE)
})

test('--yes on a new store refuses a db-key whose code cannot be recomputed, before anything is written', async () => {
  const w = make()
  w.keychain.add(DB_KEY_REF) // no value: the fake answers a value that is not a key
  const before = snapshotTree(w.home)
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe(`install failed: ${STALE_DB_KEY}`)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(w.out.at(-1)).toContain('service kinfold and account db-key')
  expect(w.out.join('\n')).not.toContain('show-recovery')
})

test('the done screen names the next steps', async () => {
  const w = make()
  const binPath = installedProgramPath(w.dataDir, w.env.platform)
  const env: InstallEnv = { ...w.env, mode: { kind: 'program', binPath } }
  const state = await readSetupState(env)
  const lines = doneLines(env, keeping(state, { hosts: ['claude-code'], encryption: { kind: 'new-encrypted', key: null } }), state)
  expect(lines).toContain(`installed. Check it with: ${binPath} status`)
  expect(lines).toContain(`Open the dashboard with: ${binPath} dashboard`)
  expect(lines.join('\n')).toContain('kinfold dashboard')
  expect(lines.join('\n')).toContain('run kinfold key show-recovery in a terminal to see your recovery code')
  const shown = doneLines(env, keeping(state, { hosts: ['claude-code'], encryption: { kind: 'new-encrypted', key: newDbKey() } }), state)
  expect(shown.join('\n')).not.toContain('show-recovery')
})

test('a checkout install on another folder prints a usable status command', async () => {
  const w = make()
  const env = envForDataDir(w.env, '/x y')
  const state = { ...(await readSetupState(w.env)), dataDir: '/x y' }
  expect(doneLines(env, keeping(state), state)[0]).toBe('installed. Check it with: bun src/cli/kinfold.ts --data-dir "/x y" status')
})

/** A terminal and env.out writing into one log, so the order across both shows. */
function logged(w: FakeWorld, keys: readonly string[]): { log: string[]; terminal: TerminalIO } {
  const log: string[] = []
  const term = fakeTerminal(keys)
  const out = w.env.out
  w.env = { ...w.env, out: (line) => (log.push(line), out(line)) }
  return { log, terminal: { ...term, write: (text) => (log.push(text), term.write(text)) } }
}

function programWorld(): { w: FakeWorld; binPath: string; source: string } {
  const w = make()
  const binPath = installedProgramPath(w.dataDir, w.env.platform)
  w.env = { ...w.env, mode: { kind: 'program', binPath } }
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program v1\n', { mode: 0o755 })
  return { w, binPath, source }
}

test('a newer program from npx replaces bin/kinfold after the summary', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, { ...YES, programSource: source })).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n', { mode: 0o755 })
  // agents, observer, keep encryption, port, update check, summary
  const { log, terminal } = logged(w, Array(6).fill(ENTER))
  w.env = { ...w.env, terminal, io: { ...w.env.io, interactive: true } }
  expect(await install(w.env, { ...YES, yes: false, programSource: source })).toBe(EXIT_OK)
  expect(readFileSync(binPath, 'utf8')).toBe('kinfold program v2\n')
  const summary = log.findIndex((line) => line.includes('Install with these choices?'))
  const copy = log.findIndex((line) => line.includes(`install program ${binPath}`))
  // The wiring is unchanged on this re-run, so the service start that follows it marks the end of the plan.
  const start = log.findIndex((line) => /^ {2}\d+\. .*launchctl bootstrap/.test(line))
  expect(summary).toBeGreaterThanOrEqual(0)
  expect(copy).toBeGreaterThan(summary)
  expect(start).toBeGreaterThan(copy)
})

test('re-running the installed program works offline', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, { ...YES, programSource: source })).toBe(EXIT_OK)
  // A release version would fetch its SHA256SUMS, and every fetch off loopback fails.
  const fetch = w.env.fetch
  w.env = { ...w.env, fetch: async (url, init) => {
    if (!url.startsWith('http://127.0.0.1:')) throw new TypeError('offline')
    return fetch(url, init)
  } }
  w.fetches.length = 0
  w.out.length = 0
  expect(await install(w.env, { ...YES, programSource: binPath, releaseVersion: '1.2.3' })).toBe(EXIT_OK)
  expect(w.fetches.some((line) => line.includes('SHA256SUMS'))).toBe(false)
  expect(planLines(w).some((line) => line.includes('install program'))).toBe(false)
})

test('a dry run lists the encrypt step and changes nothing', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, noEncrypt: true })).toBe(EXIT_OK)
  await w.env.run({ argv: bootoutArgv(UID) })
  const beside = (): string[] => readdirSync(w.dataDir).filter((name) => name.startsWith(DB_FILE)).sort()
  expect(beside()).toEqual([DB_FILE])
  const before = snapshotTree(w.home)
  // The daemon is down, so the saved observers come from the store itself.
  const state = await readSetupState(w.env)
  expect(state.observersError).toBeNull()
  expect(state.observers.size).toBe(1)
  const refs = [...w.keychain].sort()
  w.fetches.length = 0
  w.out.length = 0
  const code = await applySetup(w.env, state, keeping(state, { encryption: { kind: 'encrypt-existing', key: newDbKey() } }), { ...YES, dryRun: true })
  expect(code).toBe(EXIT_OK)
  expect(w.out).toContain('then: kinfold encrypt')
  expect(w.out.some((line) => line.startsWith('plan (dry run'))).toBe(true)
  expect(snapshotTree(w.home)).toEqual(before)
  expect([...w.keychain].sort()).toEqual(refs)
  expect(w.fetches.filter((line) => line.startsWith('PUT'))).toEqual([])
  expect(fileState(join(w.dataDir, DB_FILE))).toBe('plain')
  expect(beside()).toEqual([DB_FILE])
})

test('--yes never asks for a missing observer key, even on a terminal', async () => {
  const term = fakeTerminal(['sk-typed-key', ENTER])
  const w = make({ claudeVersion: null, opencodeVersion: OPENCODE, keychainRefs: [], interactive: true, secrets: ['sk-typed-key'], terminal: term })
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe('install failed: the openrouter key is not in the keychain and --yes asks nothing; pass --credential-stdin')
  expect(term.output()).toBe('')
  expect(w.keychain.has('openrouter')).toBe(false)
})

test('a key asked between the questions goes through the same terminal session', async () => {
  const w = make({ claudeVersion: null, opencodeVersion: OPENCODE, keychainRefs: [], interactive: true })
  // folder, agents, observer, then the key, then no encryption, port, update check, summary
  const term = fakeTerminal([ENTER, ENTER, ENTER, 'sk-typed-key', ENTER, 'n', ENTER, ENTER, ENTER])
  w.env = {
    ...w.env,
    terminal: term,
    io: { ...w.env.io, askSecret: async () => { throw new Error('a second stdin reader was used') } },
  }
  expect(await install(w.env, { ...YES, yes: false })).toBe(EXIT_OK)
  expect(w.keychainValues.get('openrouter')).toBe('sk-typed-key')
  expect(term.output()).not.toContain('sk-typed-key')
  expect(term.rawStates().at(-1)).toBe(false)
})

test('a first install on a typed folder plans against that folder as it is', async () => {
  const w = make({ interactive: true })
  const other = join(w.root, 'other-memory')
  openStore(other, { keys: NO_DB_KEYS }).db.close()
  // folder, agents, observer, keep it plaintext, port, update check, summary
  const term = fakeTerminal([other, ENTER, ENTER, ENTER, 'n', ENTER, ENTER, ENTER])
  w.env = { ...w.env, terminal: term }
  expect(await install(w.env, { ...YES, yes: false, dryRun: true })).toBe(EXIT_OK)
  const plan = planLines(w).join('\n')
  expect(plan).toContain(`${other}/logs`)
  expect(plan).not.toContain(w.dataDir)
  // Read for the default folder, the store would have been new and 'n' would plan a new plaintext store.
  expect(plan).not.toContain('as a plaintext store')
  expect(w.out).toContain(`database: ${join(other, DB_FILE)} is plaintext; it stays that way until kinfold encrypt`)
  expect(term.output()).toContain('Encrypt memory.db?')
  expect(term.output()).toContain('(y/N)')
})

test('a failed encrypt after the code was shown says the code is unused and memory.db was not changed', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, noEncrypt: true })).toBe(EXIT_OK)
  const path = join(w.dataDir, DB_FILE)
  const before = readFileSync(path)
  w.env = { ...w.env, service: fakeService({ stopError: new Error('stop refused') }) }
  w.out.length = 0
  const key = newDbKey()
  const { code } = await applyWith(w, { kind: 'encrypt-existing', key })
  expect(code).toBe(EXIT_FAILED)
  expect(fileState(path)).toBe('plain')
  expect(readFileSync(path).equals(before)).toBe(true)
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
  const last = w.out.at(-1) ?? ''
  expect(last).toContain('kinfold encrypt failed')
  expect(last).toMatch(/memory\.db was not changed and is still plaintext, so the recovery code shown is not used; discard it$/)
  expect(w.out.join('\n')).not.toContain(encodeRecoveryCode(key))
})

test('a failing note check keeps the encrypt failure line', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, noEncrypt: true })).toBe(EXIT_OK)
  const path = join(w.dataDir, DB_FILE)
  const refusing = fakeService({ stopError: new Error('stop refused') })
  // memory.db turns into a directory before the note reads it, so the note's own check throws.
  const stop = async (): Promise<void> => {
    rmSync(path, { force: true })
    mkdirSync(path)
    await refusing.stop()
  }
  w.env = { ...w.env, service: { ...refusing, stop } }
  w.out.length = 0
  const { code } = await applyWith(w, { kind: 'encrypt-existing', key: newDbKey() })
  expect(code).toBe(EXIT_FAILED)
  expect(w.out.some((line) => line.startsWith('install: everything else is in place, but kinfold encrypt failed:'))).toBe(true)
  expect(w.out.some((line) => line.startsWith('install failed:'))).toBe(false)
})
