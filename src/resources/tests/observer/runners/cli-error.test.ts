import { expect, test } from 'bun:test'
import { classifyCliError, cliErrorText, cliFailure } from '../../../observer/runners/cli-error'

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

const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed'

test('the hub\'s exact output, with a line before it, as an array or as JSON lines, still names the expired login', () => {
  const exact = `{"is_error": true, "result": "${EXPIRED}"}`
  expect(cliFailure('claude exited 1', cliErrorText(exact, '')).errorClass).toBe('auth_expired')
  expect(cliErrorText(`Warning: a newer version is available\n${exact}\n`, '')).toBe(EXPIRED)
  const array = JSON.stringify([{ type: 'system', subtype: 'init', session_id: 's' }, { type: 'result', subtype: 'success', is_error: true, result: EXPIRED }])
  expect(cliErrorText(array, '')).toBe(EXPIRED)
  const lines = [{ type: 'system', subtype: 'init' }, { type: 'result', is_error: true, result: EXPIRED }].map((value) => JSON.stringify(value)).join('\n')
  expect(cliErrorText(lines, '')).toBe(EXPIRED)
})

test('codex and opencode error events give their message; nothing else in stdout is read', () => {
  const codex = [{ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: 'session text' } }, { type: 'error', message: 'Not logged in. Run `codex login`.' }]
  expect(cliErrorText(codex.map((value) => JSON.stringify(value)).join('\n'), '')).toBe('Not logged in. Run `codex login`.')
  const failedTurn = JSON.stringify({ type: 'turn.failed', error: { message: 'Your access token could not be refreshed' } })
  expect(classifyCliError(cliErrorText(failedTurn, ''))).toBe('auth_expired')
  const opencode = JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'Invalid API key' } } })
  expect(classifyCliError(cliErrorText(opencode, ''))).toBe('not_logged_in')
  // Text events never become an error line.
  expect(cliErrorText(JSON.stringify({ type: 'text', part: { text: 'not logged in' } }), 'stderr line')).toBe('stderr line')
})
