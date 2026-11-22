import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeClaudeCode } from '../adapters/claude-code'
import { FAKE_SECRETS } from '../../test/fixtures/secrets'
import { captureEvent } from './capture'

let spoolDir: string
beforeEach(() => {
  spoolDir = join(mkdtempSync(join(tmpdir(), 'sam-capture-')), 'spool')
})
afterEach(() => rmSync(join(spoolDir, '..'), { recursive: true, force: true }))

test('a recorded Claude Code payload with a secret in its output reaches the spool redacted', () => {
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, '../../test/fixtures/claude-code/post-tool-use.bash.json'), 'utf8'))
  const leaky = { ...recorded, tool_response: { ...recorded.tool_response, stdout: `token ok: ${FAKE_SECRETS.github}` } }
  const event = normalizeClaudeCode(leaky, { now: () => 1_792_841_878_000, newId: () => '01JB0000000000000000000001' })

  const path = captureEvent(event!, { spoolDir, hmacKey: 'test' })
  const raw = readFileSync(path, 'utf8')
  expect(raw).not.toContain(FAKE_SECRETS.github)
  const stored = JSON.parse(raw)
  expect(stored.tool.output).toStartWith('token ok: <redacted type="github_token"')
  expect(stored.tool.exitCode).toBe(0)
})
