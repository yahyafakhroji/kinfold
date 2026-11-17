import { expect, test } from 'bun:test'
import { classifyCliError, cliErrorText, cliFailure } from './cli-error'

test('the CLI\'s own words name an expired login, a missing login and a usage limit', () => {
  expect(classifyCliError('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe('auth_expired')
  expect(classifyCliError('Your access token has expired. Please log in again.')).toBe('auth_expired')
  expect(classifyCliError('Not logged in · Please run /login')).toBe('not_logged_in')
  expect(classifyCliError('Invalid API key · Please run /login')).toBe('not_logged_in')
  expect(classifyCliError('Error: You are not signed in. Run `codex login`.')).toBe('not_logged_in')
  expect(classifyCliError('API Error: 429 rate_limit_error')).toBe('rate_limited')
  expect(classifyCliError("Claude AI usage limit reached|1763380800")).toBe('rate_limited')
  expect(classifyCliError('Error: model not found')).toBeNull()
  expect(classifyCliError('')).toBeNull()
})

test('the error text is the JSON result of a failed run, else the first stderr line', () => {
  const json = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired' })
  expect(cliErrorText(json, 'ignored')).toBe('Failed to authenticate: OAuth session expired')
  expect(cliErrorText('not json', '\n  error: config broken\nmore')).toBe('error: config broken')
  // A run that did not fail says nothing, whatever its result holds.
  expect(cliErrorText(JSON.stringify({ type: 'result', is_error: false, result: 'model text' }), '')).toBe('')
})

test('the detail is capped and never carries a secret the CLI printed', () => {
  const key = `sk-ant-api03-${'A1b2C3d4'.repeat(10)}`
  const failure = cliFailure('claude exited 1', `Invalid API key ${key} · Please run /login`)
  expect(failure.errorClass).toBe('not_logged_in')
  expect(failure.detail).toStartWith('claude exited 1: Invalid API key <redacted')
  expect(failure.detail).not.toContain(key)
  expect(cliFailure('exited 2', 'x'.repeat(1_000)).detail.length).toBeLessThan(220)
  expect(cliFailure('exited 2', '')).toMatchObject({ errorClass: 'exit_nonzero', detail: 'exited 2' })
  expect(cliFailure('exited 2', 'segfault')).toMatchObject({ errorClass: 'exit_nonzero', detail: 'exited 2: segfault' })
})
