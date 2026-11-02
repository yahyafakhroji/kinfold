import { expect, test } from 'bun:test'
import { parseProviderModel, settingsInputFor } from './observer-choice'

test('settingsInputFor gives a CLI-login provider no credential ref', () => {
  expect(settingsInputFor('codex', 'codex-cli', 'gpt-x').credentialRef).toBeNull()
  expect(settingsInputFor('codex', 'openrouter', 'm').credentialRef).toBe('openrouter')
})

test('parseProviderModel keeps the slash in the model and splits only on the first colon', () => {
  expect(parseProviderModel('opencode-cli:anthropic/claude-x')).toEqual({ provider: 'opencode-cli', model: 'anthropic/claude-x' })
})
