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

  // A value in no known format under a name no rule calls secret: only withholding stops it.
  const PLAIN_VALUE = 'plain-value-no-rule-knows-0001'
  const withheldInput = (chars: number): string => `<withheld reason="sensitive_path" chars="${chars}"/>`

  test('a Write to a sensitive path keeps the path and withholds the body', () => {
    const content = `STRIPE_KEY=${PLAIN_VALUE}\nA=1`
    for (const input of [{ file_path: '/repo/.env', content }, { filePath: '/home/dev/.ssh/id_rsa', content }]) {
      const prepared = prepareForSpool(toolEvent('Write', input, 'File created'), options)
      expect(JSON.stringify(prepared)).not.toContain(PLAIN_VALUE)
      expect(prepared.tool?.input).toEqual({ ...input, content: withheldInput(content.length) })
      expect(prepared.tool?.withheld).toBe('sensitive_path')
      expect(prepared.redactions).toContainEqual({ field: 'tool.input', rule: 'sensitive_path', count: 1 })
    }
  })

  test('an Edit or MultiEdit to a sensitive path withholds every string but the path', () => {
    const edit = { file_path: '/repo/.env', old_string: 'STRIPE_KEY=old', new_string: `STRIPE_KEY=${PLAIN_VALUE}`, replace_all: false }
    const edited = prepareForSpool(toolEvent('Edit', edit, 'ok'), options)
    expect(edited.tool?.input).toEqual({ file_path: '/repo/.env', old_string: withheldInput(14), new_string: withheldInput(edit.new_string.length), replace_all: false })
    const multi = { file_path: '/repo/certs/server.pem', edits: [{ old_string: 'a', new_string: PLAIN_VALUE }, { old_string: 'b', new_string: 'c' }] }
    const prepared = prepareForSpool(toolEvent('MultiEdit', multi, 'ok'), options)
    expect(JSON.stringify(prepared)).not.toContain(PLAIN_VALUE)
    expect(prepared.tool?.input).toMatchObject({ file_path: '/repo/certs/server.pem', edits: [{ old_string: withheldInput(1) }, { new_string: withheldInput(1) }] })
    expect(prepared.redactions).toContainEqual({ field: 'tool.input', rule: 'sensitive_path', count: 4 })
  })

  test('a command that names a sensitive path is withheld whole; other sensitive commands stay readable', () => {
    const command = `echo STRIPE_KEY=${PLAIN_VALUE} >> .env`
    const written = prepareForSpool(toolEvent('Bash', { command, description: 'add the key' }, ''), options)
    expect(JSON.stringify(written)).not.toContain(PLAIN_VALUE)
    expect(written.tool?.input).toEqual({ command: `<withheld reason="sensitive_command" chars="${command.length}"/>`, description: 'add the key' })
    expect(written.redactions).toContainEqual({ field: 'tool.input', rule: 'sensitive_command', count: 1 })
    const dumped = prepareForSpool(toolEvent('Bash', { command: 'printenv | sort' }, 'A=1'), options)
    expect(dumped.tool?.input).toEqual({ command: 'printenv | sort' })
    expect(dumped.tool?.withheld).toBe('sensitive_command')
  })

  test('withholding input a second time, as the daemon does at ingest, changes nothing and notes nothing new', () => {
    const write = toolEvent('Write', { file_path: '/repo/.env', content: `K=${PLAIN_VALUE}` }, 'ok')
    const shell = toolEvent('Bash', { command: `echo K=${PLAIN_VALUE} > /repo/.env` }, '')
    for (const event of [write, shell]) {
      const once = prepareForSpool(event, options)
      const twice = prepareForSpool(once, options)
      expect(twice.tool?.input).toEqual(once.tool?.input)
      expect((twice.redactions ?? []).filter((note) => note.field === 'tool.input')).toEqual([])
    }
  })

  test('a write to an ordinary path keeps its body', () => {
    const prepared = prepareForSpool(toolEvent('Write', { file_path: '/repo/src/a.ts', content: 'export const a = 1' }, 'ok'), options)
    expect(prepared.tool?.input).toEqual({ file_path: '/repo/src/a.ts', content: 'export const a = 1' })
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
