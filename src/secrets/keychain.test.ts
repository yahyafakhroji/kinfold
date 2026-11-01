import { expect, test } from 'bun:test'
import { ITEM_NOT_FOUND_EXIT, type SecurityCommand, createKeychainProvider, keychainArgs } from './keychain'

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
