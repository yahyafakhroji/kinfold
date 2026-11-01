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
