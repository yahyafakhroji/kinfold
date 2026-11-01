import { expect, test } from 'bun:test'
import { ITEM_NOT_FOUND_EXIT } from './keychain'
import { type SecurityInvocation, type SecurityRunner, addCommandLine, createKeychainWriter, credentialWriterFor } from './keychain-writer'

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
