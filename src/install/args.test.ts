import { expect, test } from 'bun:test'
import { USAGE, parseArgs } from './args'

const INSTALL = ['install', '--hosts', 'opencode', '--observer', 'opencode=claude-cli:haiku', '--no-encrypt', '--port', '40000', '--no-update-check', '--yes']

test('every step has a flag', () => {
  const parsed = parseArgs(INSTALL)
  expect(parsed).toMatchObject({ ok: true, value: { command: 'install', hosts: ['opencode'], noEncrypt: true, port: 40000, noUpdateCheck: true, yes: true } })
  expect(parseArgs(['install', '--port=40001'])).toMatchObject({ ok: true, value: { port: 40001 } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { noEncrypt: false, noUpdateCheck: false, port: null } })
})

test('a port outside 1024-65535 or not a number is a usage error', () => {
  for (const port of ['80', '1023', '65536', 'x', '40000.5', '']) {
    const parsed = parseArgs(['install', '--port', port])
    expect(parsed.ok).toBe(false)
  }
  expect(parseArgs(['install', '--port'])).toEqual({ ok: false, error: '--port needs a value' })
})

test('the new flags apply to install only', () => {
  expect(parseArgs(['status', '--no-encrypt'])).toEqual({ ok: false, error: '--no-encrypt does not apply to status' })
  expect(parseArgs(['uninstall', '--no-update-check'])).toEqual({ ok: false, error: '--no-update-check does not apply to uninstall' })
  expect(parseArgs(['status', '--port', '40000'])).toEqual({ ok: false, error: '--port does not apply to status' })
})

test('USAGE lists the new flags and the update command', () => {
  for (const text of ['--no-encrypt', '--port <1024-65535>', '--updates off|notify|patch']) expect(USAGE).toContain(text)
  expect(USAGE).toMatch(/update\s+\[--dry-run\]/)
})

test('update --auto is the run the daemon starts, and is not advertised', () => {
  expect(parseArgs(['update', '--auto'])).toMatchObject({ ok: true, value: { command: 'update', auto: true, dryRun: false } })
  expect(parseArgs(['update'])).toMatchObject({ ok: true, value: { auto: false } })
  expect(parseArgs(['install', '--auto'])).toEqual({ ok: false, error: '--auto does not apply to install' })
  expect(USAGE).not.toContain(' --auto')
  expect(USAGE).not.toContain('[--auto]')
})

test('install --no-auto-update turns automatic patch updates off', () => {
  expect(parseArgs(['install', '--no-auto-update'])).toMatchObject({ ok: true, value: { command: 'install', noAutoUpdate: true } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { noAutoUpdate: false } })
  expect(parseArgs(['update', '--no-auto-update'])).toEqual({ ok: false, error: '--no-auto-update does not apply to update' })
})

test('install --auto-update turns automatic patch updates back on, and cannot be combined with its opposite', () => {
  expect(parseArgs(['install', '--auto-update'])).toMatchObject({ ok: true, value: { command: 'install', autoUpdate: true, noAutoUpdate: false } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { autoUpdate: false } })
  expect(parseArgs(['install', '--auto-update', '--no-auto-update'])).toEqual({ ok: false, error: '--auto-update and --no-auto-update cannot be given together' })
  expect(parseArgs(['update', '--auto-update'])).toEqual({ ok: false, error: '--auto-update does not apply to update' })
  expect(USAGE).toContain('[--beta | --no-beta]')
})

test('update takes only --dry-run', () => {
  expect(parseArgs(['update'])).toMatchObject({ ok: true, value: { command: 'update', dryRun: false } })
  expect(parseArgs(['update', '--dry-run'])).toMatchObject({ ok: true, value: { command: 'update', dryRun: true } })
  expect(parseArgs(['update', '--yes'])).toEqual({ ok: false, error: '--yes does not apply to update' })
  expect(parseArgs(['update', '--port', '40000'])).toEqual({ ok: false, error: '--port does not apply to update' })
})

test('--path and --no-path apply to install, and not together', () => {
  expect(parseArgs(['install', '--path'])).toMatchObject({ ok: true, value: { path: 'path' } })
  expect(parseArgs(['install', '--no-path'])).toMatchObject({ ok: true, value: { path: 'no-path' } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { path: null } })
  expect(parseArgs(['install', '--path', '--no-path'])).toEqual({ ok: false, error: '--path and --no-path cannot be given together' })
  expect(parseArgs(['uninstall', '--path'])).toEqual({ ok: false, error: '--path does not apply to uninstall' })
  expect(parseArgs(['status', '--no-path'])).toEqual({ ok: false, error: '--no-path does not apply to status' })
})

test('--verbose applies to install and uninstall', () => {
  expect(parseArgs(['install', '--verbose'])).toMatchObject({ ok: true, value: { verbose: true } })
  expect(parseArgs(['uninstall', '--verbose'])).toMatchObject({ ok: true, value: { verbose: true } })
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { verbose: false } })
  expect(parseArgs(['status', '--verbose'])).toEqual({ ok: false, error: '--verbose does not apply to status' })
})

test('USAGE lists the PATH flags and --verbose', () => {
  for (const text of ['[--path | --no-path]', '[--verbose]']) expect(USAGE).toContain(text)
  expect(USAGE).toMatch(/uninstall\s+\[--dry-run\] \[--verbose\]/)
})

test('--observer-endpoint gives the OpenAI-compatible observer its address, in either order', () => {
  for (const argv of [
    ['install', '--observer', 'codex=openai-compatible:llama3.2', '--observer-endpoint', 'http://127.0.0.1:11434/v1'],
    ['install', '--observer-endpoint=http://127.0.0.1:11434/v1/', '--observer', 'codex=openai-compatible:llama3.2'],
  ]) {
    expect(parseArgs(argv)).toMatchObject({ ok: true, value: { observers: [{ host: 'codex', provider: 'openai-compatible', model: 'llama3.2', endpoint: 'http://127.0.0.1:11434/v1' }] } })
  }
  expect(parseArgs(['install', '--observer', 'codex=openai-compatible:m'])).toEqual({ ok: false, error: '--observer codex=openai-compatible:... needs --observer-endpoint <url>' })
  expect(parseArgs(['install', '--observer-endpoint', 'https://api.groq.com/openai/v1'])).toEqual({ ok: false, error: '--observer-endpoint is only for an --observer naming qwen-api or openai-compatible' })
  expect(parseArgs(['status', '--observer-endpoint', 'https://x.example.com'])).toEqual({ ok: false, error: '--observer-endpoint does not apply to status' })
  expect(USAGE).toContain('--observer-endpoint <url>')
})

test('--embeddings picks the provider; a local LLM takes its model and loopback address', () => {
  expect(parseArgs(['install'])).toMatchObject({ ok: true, value: { embeddings: null } })
  expect(parseArgs(['install', '--embeddings', 'local'])).toMatchObject({ ok: true, value: { embeddings: { provider: 'local', llmUrl: null, llmModel: null, llmDims: null } } })
  expect(parseArgs(['install', '--embeddings=openrouter'])).toMatchObject({ ok: true, value: { embeddings: { provider: 'openrouter' } } })
  expect(parseArgs(['install', '--embeddings', 'local-llm:nomic-embed-text@http://127.0.0.1:11434/v1'])).toMatchObject({
    ok: true, value: { embeddings: { provider: 'local-llm', llmModel: 'nomic-embed-text', llmUrl: 'http://127.0.0.1:11434/v1', llmDims: null } },
  })
  expect(parseArgs(['install', '--embeddings', 'local-llm:m@http://10.0.0.1:11434'])).toMatchObject({ ok: false, error: expect.stringContaining('on this machine') })
  expect(parseArgs(['install', '--embeddings', 'agent'])).toMatchObject({ ok: false, error: expect.stringContaining('--embeddings takes local, openrouter or local-llm:<model>@<url>') })
  expect(parseArgs(['status', '--embeddings', 'local'])).toEqual({ ok: false, error: '--embeddings does not apply to status' })
  expect(USAGE).toContain('--embeddings local|openrouter|local-llm:<model>@<url>')
})

test('--updates takes a level, and --beta or --no-beta the channel', () => {
  expect(parseArgs(['install', '--updates', 'notify'])).toMatchObject({ ok: true, value: { updates: 'notify', beta: false, noBeta: false } })
  expect(parseArgs(['install', '--updates=off', '--beta'])).toMatchObject({ ok: true, value: { updates: 'off', beta: true } })
  expect(parseArgs(['install', '--no-beta'])).toMatchObject({ ok: true, value: { updates: null, noBeta: true } })
  expect(parseArgs(['install', '--updates', 'weekly'])).toEqual({ ok: false, error: '--updates takes off, notify or patch' })
  expect(parseArgs(['install', '--beta', '--no-beta'])).toEqual({ ok: false, error: '--beta and --no-beta cannot be given together' })
  expect(parseArgs(['update', '--beta'])).toEqual({ ok: false, error: '--beta does not apply to update' })
})

test('--updates does not mix with the older update flags it replaces', () => {
  expect(parseArgs(['install', '--updates', 'patch', '--no-update-check'])).toEqual({ ok: false, error: '--updates cannot be given with --no-update-check, --auto-update or --no-auto-update' })
})

test('update --staged names the staged release the dashboard installs', () => {
  expect(parseArgs(['update', '--staged', '0.6.0'])).toMatchObject({ ok: true, value: { staged: '0.6.0' } })
  expect(parseArgs(['update', '--staged', '../x'])).toEqual({ ok: false, error: '--staged takes a version' })
  expect(parseArgs(['install', '--staged', '0.6.0'])).toEqual({ ok: false, error: '--staged does not apply to install' })
})
