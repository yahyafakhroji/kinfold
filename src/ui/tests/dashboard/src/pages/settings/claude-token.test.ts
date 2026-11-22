import { expect, test } from 'bun:test'
import { claudeAuthText, showsClaudeToken } from '../../../../../dashboard/src/pages/settings/claude-token'

const view = (provider: string, claudeAuth?: 'token' | 'login' | 'unknown') => ({
  rows: [], effective: [{ host: 'claude-code', settings: { provider, model: 'haiku', credentialRef: null, enabled: true } }], ...(claudeAuth === undefined ? {} : { claudeAuth }),
})

test('the token field shows when an agent uses claude-cli and the daemon can say which login it uses', () => {
  expect(showsClaudeToken(view('claude-cli', 'login'))).toBe(true)
  expect(showsClaudeToken(view('openrouter', 'login'))).toBe(false)
  // A daemon from before tokens: nothing to save to.
  expect(showsClaudeToken(view('claude-cli'))).toBe(false)
})

test('the line says what summaries sign in with, and how to get a token', () => {
  expect(claudeAuthText('token')).toBe('Summaries sign in with a long-lived token, kept in the key store. When it expires, run claude setup-token again and paste the new one here.')
  expect(claudeAuthText('login')).toBe("Summaries sign in with the claude CLI's own login. If that login keeps expiring, run claude setup-token in a terminal and paste the token here.")
  expect(claudeAuthText('unknown')).toBe('The key store could not be asked whether a token is saved.')
})
