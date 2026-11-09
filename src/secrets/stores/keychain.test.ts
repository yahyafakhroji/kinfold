import { expect, test } from 'bun:test'
import { type FakeKeychain, fakeSecurity } from '../../install/test-support'
import { DB_KEY_REF } from '../credentials'
import { dbKeyStoreOf } from '../../sqlite/keys'
import { type SecurityInvocation, createKeychainStore, keychainModule, legacyKeychainOf } from './keychain'
import { runKeyStoreContract } from './contract'
import { ITEM_NOT_FOUND_EXIT, type SecurityCommand, createKeychainProvider, keychainArgs } from '../keychain'
import { type SecurityRunner, addCommandLine, createKeychainWriter, credentialWriterFor } from '../keychain-writer'

function emptyKeychain(): FakeKeychain {
  return { refs: new Set<string>(), values: new Map<string, string>() }
}

function argvLines(calls: readonly SecurityInvocation[]): string[] {
  return calls.map((call) => call.args.join(' '))
}

runKeyStoreContract('keychain', () => {
  const calls: SecurityInvocation[] = []
  const store = createKeychainStore(fakeSecurity(emptyKeychain(), emptyKeychain(), calls))
  // A backend that fails every call and echoes its stdin, so a leak would show.
  const failing = () => createKeychainStore((invocation) => (calls.push(invocation), { exitCode: 51, stdout: invocation.stdin ?? '' }))
  return { store, observed: () => argvLines(calls), failing }
})

test('the keychain store reads the old service when kinfold has no entry', () => {
  const legacy = emptyKeychain()
  legacy.refs.add(DB_KEY_REF)
  legacy.values.set(DB_KEY_REF, 'legacy-value')
  const store = createKeychainStore(fakeSecurity(emptyKeychain(), legacy, []))
  expect(store.get(DB_KEY_REF)).toBe('legacy-value')
  expect(store.exists(DB_KEY_REF)).toBe(false)
  expect(dbKeyStoreOf(store).exists()).toBe(true)
  expect(legacyKeychainOf(store)?.exists(DB_KEY_REF)).toBe(true)
})

test('keychain describe texts are unchanged', () => {
  const store = createKeychainStore(() => ({ exitCode: 0, stdout: '' }))
  expect(store.describeSet('openrouter')).toBe('keychain: /usr/bin/security -i <<< "add-generic-password -U -s kinfold -a openrouter -w <hidden>"')
  expect(store.describeDelete('openrouter')).toBe('keychain: /usr/bin/security delete-generic-password -s kinfold -a openrouter')
  expect(store.describeEntry('db-key')).toBe('the Keychain item with service kinfold and account db-key')
  expect([store.kind, store.label, store.place, store.notes]).toEqual(['keychain', 'keychain', 'the Keychain', []])
  expect(keychainModule.location).toBeUndefined()
})

test('the keychain probe never runs security', () => {
  const calls: SecurityInvocation[] = []
  const security = (invocation: SecurityInvocation) => (calls.push(invocation), { exitCode: 51, stdout: '' })
  const deps = { platform: { os: 'macos', wsl: false, node: 'darwin' }, homeDir: '/h', dataDir: '/h/.kinfold', envVars: {}, security } as const
  expect(keychainModule.probe(deps)).toEqual({ usable: true })
  expect(calls).toEqual([])
})


function fake(exitCode: number, stdout = ''): { run: SecurityCommand; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return { calls, run: (args) => (calls.push(args), { exitCode, stdout }) }
}

test('looks up service kinfold with the ref as the account and -w', () => {
  const { run, calls } = fake(0, 'sk-or-value\n')
  expect(createKeychainProvider(run).get('openrouter')).toBe('sk-or-value')
  expect(calls).toEqual([['find-generic-password', '-s', 'kinfold', '-a', 'openrouter', '-w']])
  expect(keychainArgs('openrouter')).toEqual(calls[0] as string[])
})

test('a missing item is null, not an error', () => {
  expect(createKeychainProvider(fake(ITEM_NOT_FOUND_EXIT).run).get('openrouter')).toBeNull()
  expect(createKeychainProvider(fake(0, '\n').run).get('openrouter')).toBeNull()
})

test('another failure throws with the exit code only, never the output', () => {
  const provider = createKeychainProvider(fake(51, 'partial-secret-output').run)
  expect(() => provider.get('openrouter')).toThrow('keychain lookup failed (exit 51)')
  try {
    provider.get('openrouter')
  } catch (error: unknown) {
    expect((error as Error).message).not.toContain('partial-secret-output')
  }
})

test('a ref that is not a short lowercase name is refused before any command runs', () => {
  const { run, calls } = fake(0, 'x')
  expect(() => createKeychainProvider(run).get('-w; rm -rf')).toThrow('credential ref')
  expect(calls).toEqual([])
})

const LEGACY = 'shared-agent-memory'

/** A fake `security` holding entries by service, then account. */
function fakeStore(entries: Record<string, Record<string, string>>): { run: SecurityCommand; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  const run: SecurityCommand = (args) => {
    calls.push(args)
    const service = args[args.indexOf('-s') + 1] ?? ''
    const value = entries[service]?.[args[args.indexOf('-a') + 1] ?? '']
    return value === undefined ? { exitCode: ITEM_NOT_FOUND_EXIT, stdout: '' } : { exitCode: 0, stdout: `${value}\n` }
  }
  return { calls, run }
}

test('an entry only under the legacy service is read after kinfold misses', () => {
  const { run, calls } = fakeStore({ [LEGACY]: { 'db-key': 'legacy-value' } })
  expect(createKeychainProvider(run).get('db-key')).toBe('legacy-value')
  expect(calls).toEqual([keychainArgs('db-key', 'kinfold'), keychainArgs('db-key', LEGACY)])
  expect(keychainArgs('db-key', LEGACY)).toEqual(['find-generic-password', '-s', LEGACY, '-a', 'db-key', '-w'])
})

test('an entry under both services returns the kinfold value without asking the legacy one', () => {
  const { run, calls } = fakeStore({ kinfold: { 'db-key': 'new-value' }, [LEGACY]: { 'db-key': 'old-value' } })
  expect(createKeychainProvider(run).get('db-key')).toBe('new-value')
  expect(calls).toHaveLength(1)
})

test('a missing entry under both services is null; a non-44 failure never falls back', () => {
  expect(createKeychainProvider(fakeStore({}).run).get('db-key')).toBeNull()
  const failing = fake(51)
  expect(() => createKeychainProvider(failing.run).get('db-key')).toThrow('keychain lookup failed (exit 51)')
  expect(failing.calls).toHaveLength(1)
})


const VALUE = 'sk-or-v1-FAKEFAKEFAKE0123456789abcdef'

/** A fake keychain: an in-memory set of refs, every invocation recorded. */
function fakeKeychain(exitFor: (invocation: SecurityInvocation) => number | null = () => null): { run: SecurityRunner; calls: SecurityInvocation[]; refs: Set<string> } {
  const calls: SecurityInvocation[] = []
  const refs = new Set<string>()
  const run: SecurityRunner = (invocation) => {
    calls.push(invocation)
    const forced = exitFor(invocation)
    if (forced !== null) return { exitCode: forced, stdout: '' }
    const [verb] = invocation.args
    if (verb === '-i') {
      const match = /-a (\S+) -w/.exec(invocation.stdin ?? '')
      if (match?.[1] !== undefined) refs.add(match[1])
      return { exitCode: 0, stdout: 'security> ' }
    }
    const ref = invocation.args[invocation.args.indexOf('-a') + 1] ?? ''
    if (verb === 'delete-generic-password') return { exitCode: refs.delete(ref) ? 0 : ITEM_NOT_FOUND_EXIT, stdout: '' }
    return { exitCode: refs.has(ref) ? 0 : ITEM_NOT_FOUND_EXIT, stdout: 'keychain: "login.keychain-db"' }
  }
  return { run, calls, refs }
}

test('put sends the add command on stdin to security -i; argv never holds the value', () => {
  const keychain = fakeKeychain()
  createKeychainWriter(keychain.run).put('openrouter', VALUE)
  expect(keychain.calls[0]).toEqual({ args: ['-i'], stdin: `add-generic-password -U -s kinfold -a openrouter -w ${VALUE}\n` })
  expect(keychain.calls[1]).toEqual({ args: ['find-generic-password', '-s', 'kinfold', '-a', 'openrouter'] })
  for (const call of keychain.calls) expect(call.args.join(' ')).not.toContain(VALUE)
  expect(keychain.calls.slice(1).every((call) => call.stdin === undefined)).toBe(true)
})

test('exists never asks for the secret (-w) and maps 44 to false', () => {
  const keychain = fakeKeychain()
  const writer = createKeychainWriter(keychain.run)
  expect(writer.exists('openrouter')).toBe(false)
  writer.put('openrouter', VALUE)
  expect(writer.exists('openrouter')).toBe(true)
  expect(keychain.calls.some((call) => call.args.includes('-w'))).toBe(false)
})

test('a write security accepted but did not store is an error; errors never quote the value', () => {
  const silent = fakeKeychain((invocation) => (invocation.args[0] === '-i' ? 0 : null))
  expect(() => createKeychainWriter(silent.run).put('openrouter', VALUE)).toThrow('keychain write did not create the entry')
  const failing = fakeKeychain((invocation) => (invocation.args[0] === '-i' ? 1 : null))
  try {
    createKeychainWriter(failing.run).put('openrouter', VALUE)
    throw new Error('expected a failure')
  } catch (error: unknown) {
    expect((error as Error).message).toBe('keychain write failed (exit 1)')
  }
})

test('values that would need quoting on a security -i line are refused without echoing them', () => {
  for (const value of ['has space', 'quote"d', "it's", 'back\\slash', '', 'tab\there', 'x'.repeat(513)]) {
    try {
      addCommandLine('openrouter', value)
      throw new Error('expected a refusal')
    } catch (error: unknown) {
      expect((error as Error).message).toStartWith('credential must be')
      if (value.length > 2) expect((error as Error).message).not.toContain(value)
    }
  }
  expect(() => addCommandLine('Bad Ref', VALUE)).toThrow('credential ref')
})

test('remove deletes our entry by service and account, and reports a missing one', () => {
  const keychain = fakeKeychain()
  const writer = createKeychainWriter(keychain.run)
  writer.put('openrouter', VALUE)
  expect(writer.remove('openrouter')).toBe(true)
  expect(writer.remove('openrouter')).toBe(false)
  expect(keychain.calls.at(-1)?.args).toEqual(['delete-generic-password', '-s', 'kinfold', '-a', 'openrouter'])
})

test('no writer off macOS', () => {
  expect(credentialWriterFor('linux', fakeKeychain().run)).toBeNull()
  expect(credentialWriterFor('darwin', fakeKeychain().run)).not.toBeNull()
})

test('legacy reads, checks and removes under the shared-agent-memory service; the value stays out of argv', () => {
  const calls: SecurityInvocation[] = []
  const run: SecurityRunner = (invocation) => {
    calls.push(invocation)
    return invocation.args.includes('-w') ? { exitCode: 0, stdout: `${VALUE}\n` } : { exitCode: 0, stdout: '' }
  }
  const { legacy } = createKeychainWriter(run)
  expect(legacy.exists('db-key')).toBe(true)
  expect(legacy.read('db-key')).toBe(VALUE)
  expect(legacy.remove('db-key')).toBe(true)
  expect(calls.map((call) => call.args)).toEqual([
    ['find-generic-password', '-s', 'shared-agent-memory', '-a', 'db-key'],
    ['find-generic-password', '-s', 'shared-agent-memory', '-a', 'db-key', '-w'],
    ['delete-generic-password', '-s', 'shared-agent-memory', '-a', 'db-key'],
  ])
  for (const call of calls) expect(call.args.join(' ')).not.toContain(VALUE)
})

test('legacy.read maps 44 to null and other failures to an exit-code-only error', () => {
  expect(createKeychainWriter(() => ({ exitCode: ITEM_NOT_FOUND_EXIT, stdout: '' })).legacy.read('db-key')).toBeNull()
  try {
    createKeychainWriter(() => ({ exitCode: 51, stdout: VALUE })).legacy.read('db-key')
    throw new Error('expected a failure')
  } catch (error: unknown) {
    expect((error as Error).message).toBe('keychain lookup failed (exit 51)')
  }
})

test('the service argument reaches the add line, and put never writes to the legacy service', () => {
  expect(addCommandLine('db-key', VALUE, true, 'shared-agent-memory')).toBe(`add-generic-password -U -s shared-agent-memory -a db-key -w ${VALUE}\n`)
  const keychain = fakeKeychain()
  createKeychainWriter(keychain.run).put('db-key', VALUE)
  expect(keychain.calls.filter((call) => call.stdin !== undefined).every((call) => call.stdin?.includes('-s kinfold '))).toBe(true)
})
