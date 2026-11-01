import { describe, expect, test } from 'bun:test'
import type { NormalizedEvent } from '../contract/event'
import { ulid } from '../contract/ulid'
import { FAKE_SECRETS, leakyOutput } from '../../test/fixtures/secrets'
import { prepareForSpool, toolTargets } from './prepare'

const options = { hmacKey: 'test-hmac-key' }

const toolEvent = (name: string, input: unknown, output: string): NormalizedEvent => ({
  schemaVersion: 1,
  eventId: ulid(),
  host: 'claude-code',
  hostSessionId: 'session-1',
  kind: 'tool_result',
  occurredAt: 1_792_839_465_000,
  cwd: '/Users/dev/repo',
  tool: { name, input, output, exitCode: 0 },
})

describe('toolTargets', () => {
  test('reads Claude Code and OpenCode input shapes', () => {
    expect(toolTargets({ file_path: '/repo/.env' })).toEqual({ paths: ['/repo/.env'], commands: [] })
    expect(toolTargets({ filePath: '/repo/a.ts' })).toEqual({ paths: ['/repo/a.ts'], commands: [] })
    expect(toolTargets({ command: 'ls -la' })).toEqual({ paths: [], commands: ['ls -la'] })
    expect(toolTargets('not an object')).toEqual({ paths: [], commands: [] })
  })
})

describe('prepareForSpool', () => {
  test('withholds the output of a .env read and keeps its size', () => {
    const output = `A=1\nDATABASE_PASSWORD=${FAKE_SECRETS.envPassword}\nB=2`
    const prepared = prepareForSpool(toolEvent('Read', { file_path: '/repo/.env' }, output), options)
    expect(prepared.tool?.withheld).toBe('sensitive_path')
    expect(prepared.tool?.output).toBe(`<withheld reason="sensitive_path" lines="3" chars="${output.length}"/>`)
    expect(prepared.redactions).toContainEqual({ field: 'tool.output', rule: 'sensitive_path', count: 1 })
  })

  test('keeps a .env.example read and redacts inside it', () => {
    const prepared = prepareForSpool(toolEvent('Read', { file_path: '/repo/.env.example' }, leakyOutput()), options)
    expect(prepared.tool?.withheld).toBeUndefined()
    expect(prepared.tool?.output).toContain('Loaded config for app')
    expect(prepared.tool?.output).not.toContain(FAKE_SECRETS.anthropic)
  })

  test('redacts secrets in tool input', () => {
    const prepared = prepareForSpool(
      toolEvent('Bash', { command: `GITHUB_TOKEN=${FAKE_SECRETS.github} gh pr list` }, 'ok'),
      options,
    )
    expect(JSON.stringify(prepared.tool?.input)).not.toContain(FAKE_SECRETS.github)
  })

  test('replaces private spans in prompts before anything else', () => {
    const { tool: _tool, ...rest } = toolEvent('x', {}, '')
    const prompt: NormalizedEvent = {
      ...rest,
      kind: 'user_prompt',
      promptText: 'deploy with <private>my card 4111 1111 1111 1111</private> please',
    }
    const prepared = prepareForSpool(prompt, options)
    expect(prepared.promptText).toBe('deploy with <private/> please')
    expect(prepared.redactions).toEqual([{ field: 'promptText', rule: 'private_tag', count: 1 }])
  })

  test('caps oversized output after redaction', () => {
    const output = `${FAKE_SECRETS.aws}\n${'x'.repeat(100)}`
    const prepared = prepareForSpool(toolEvent('Bash', { command: 'cat big.log' }, output), { ...options, maxFieldChars: 60 })
    expect(prepared.tool?.output).not.toContain(FAKE_SECRETS.aws)
    expect(prepared.tool?.output).toContain('<truncated chars=')
    expect(prepared.redactions).toContainEqual({ field: 'tool.output', rule: 'oversize', count: 1 })
  })

  test('does not mutate the original event', () => {
    const event = toolEvent('Bash', { command: 'printf' }, leakyOutput())
    const snapshot = structuredClone(event)
    prepareForSpool(event, options)
    expect(event).toEqual(snapshot)
  })
})
