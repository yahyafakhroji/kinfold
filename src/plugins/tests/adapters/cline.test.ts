import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { CLINE_HOOK_FILES, contextModificationOutput, normalizeCline } from './cline'

const DIR = join(import.meta.dir, '../../test/fixtures/cline')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

test('every Cline fixture, VS Code and CLI shaped, normalizes to the right kind with session and cwd', () => {
  const expected: Record<string, EventKind> = {
    'docs-constructed-cli-agent-end.json': 'turn_end',
    'docs-constructed-cli-agent-start.json': 'session_start',
    'docs-constructed-cli-prompt-submit.json': 'user_prompt',
    'docs-constructed-cli-session-shutdown.json': 'session_end',
    'docs-constructed-cli-tool-result.json': 'tool_result',
    'docs-constructed-vscode-post-tool-use-failed.json': 'tool_result',
    'docs-constructed-vscode-post-tool-use.json': 'tool_result',
    'docs-constructed-vscode-task-cancel.json': 'turn_end',
    'docs-constructed-vscode-task-complete.json': 'turn_end',
    'docs-constructed-vscode-task-start.json': 'session_start',
    'docs-constructed-vscode-user-prompt-submit.json': 'user_prompt',
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const raw = fixture(file)
    const event = normalizeCline(raw, context)
    expect(event?.kind).toBe(kind)
    expect(event).toMatchObject({ host: 'cline', hostSessionId: raw.taskId, cwd: '/workspace/project' })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(normalizeCline(fixture('docs-constructed-vscode-user-prompt-submit.json'), context)).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true })
  expect(normalizeCline(fixture('docs-constructed-cli-prompt-submit.json'), context)).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true })
  expect(normalizeCline(fixture('docs-constructed-vscode-post-tool-use.json'), context)?.tool).toEqual({ name: 'read_file', input: { path: 'src/parser.ts' }, output: 'export function parse() {}' })
  expect(normalizeCline(fixture('docs-constructed-vscode-post-tool-use-failed.json'), context)?.tool).toMatchObject({ name: 'execute_command', output: '1 fail', isError: true })
  expect(normalizeCline(fixture('docs-constructed-cli-tool-result.json'), context)?.tool).toEqual({ name: 'read_files', input: { filePath: '/workspace/project/src/parser.ts' }, output: 'file contents here' })
})

test('a CLI tool_result with an error and no postToolUse block is a failed call', () => {
  const raw = fixture('docs-constructed-cli-tool-result.json')
  const { postToolUse: _vscodeBlock, ...cli } = raw
  const event = normalizeCline({ ...cli, tool_result: { id: 'c', name: 'run', input: {}, output: { code: 1 }, error: 'boom' } }, context)
  expect(event?.tool).toEqual({ name: 'run', input: {}, output: 'boom', isError: true })
})

test('a minimal or garbage Cline payload gives null and never throws', () => {
  const start = fixture('docs-constructed-vscode-task-start.json')
  for (const payload of [null, 'x', [], {}, { hookName: 'TaskStart' }, { ...start, taskId: '' }, { ...start, workspaceRoots: [] }, { ...start, workspaceRoots: ['relative'] },
    { ...start, hookName: 'PreToolUse' }, { ...start, hookName: 'TaskResume' }, { ...fixture('docs-constructed-vscode-post-tool-use.json'), postToolUse: {} }]) {
    expect(() => normalizeCline(payload, context)).not.toThrow()
    expect(normalizeCline(payload, context)).toBeNull()
  }
})

test('the hook files install registers, and the one output shape both Cline hosts read', () => {
  expect(CLINE_HOOK_FILES).toEqual(['TaskStart', 'UserPromptSubmit', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'SessionShutdown'])
  expect(contextModificationOutput('<kinfold>pack</kinfold>')).toBe(JSON.stringify({ cancel: false, contextModification: '<kinfold>pack</kinfold>' }))
})
