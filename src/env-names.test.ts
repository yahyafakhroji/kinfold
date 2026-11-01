import { expect, test } from 'bun:test'
import { deprecationLines, envName, readEnv } from './env-names'

test('envName prefixes the key with KINFOLD_', () => {
  expect(envName('PORT')).toBe('KINFOLD_PORT')
})

test('KINFOLD_PORT wins over SAM_PORT', () => {
  expect(readEnv({ KINFOLD_PORT: '1', SAM_PORT: '2' }, 'PORT')).toBe('1')
})

test('SAM_PORT is read when KINFOLD_PORT is unset or empty', () => {
  expect(readEnv({ SAM_PORT: '2' }, 'PORT')).toBe('2')
  expect(readEnv({ KINFOLD_PORT: '', SAM_PORT: '2' }, 'PORT')).toBe('2')
  expect(readEnv({}, 'PORT')).toBeUndefined()
})

test('deprecationLines names each legacy variable in use and never a value', () => {
  const lines = deprecationLines({ SAM_PORT: '4000', KINFOLD_DATA_DIR: 'x', SAM_DATA_DIR: 'y' })
  expect(lines).toEqual(['deprecated: SAM_PORT is read as KINFOLD_PORT; rename it'])
  expect(lines.join('\n')).not.toContain('4000')
  expect(lines.join('\n')).not.toMatch(/\by\b/)
})
