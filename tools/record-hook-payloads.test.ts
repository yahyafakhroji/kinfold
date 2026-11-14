import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'record-hook-payloads.ts')
const FAKE_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl'

let out: string
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'kinfold-record-'))
})
afterEach(() => rmSync(out, { recursive: true, force: true }))

async function run(args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

describe('capture', () => {
  test('writes a redacted pretty file named after the event', async () => {
    const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: `use ${FAKE_KEY} please` })
    const result = await run(['capture', 'gemini-cli', out], payload)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(readdirSync(out)).toEqual(['UserPromptSubmit-1.json'])
    const text = readFileSync(join(out, 'UserPromptSubmit-1.json'), 'utf8')
    expect(text).not.toContain(FAKE_KEY)
    expect(text).toContain('<redacted')
    expect(text).toContain('\n  "hook_event_name"')
  })

  test('numbers files instead of overwriting', async () => {
    const payload = JSON.stringify({ event: 'Stop' })
    await run(['capture', 'zed', out], payload)
    await run(['capture', 'zed', out], payload)
    expect(readdirSync(out).sort()).toEqual(['Stop-1.json', 'Stop-2.json'])
  })

  test('falls back to unknown without an event name', async () => {
    await run(['capture', 'zed', out], '{"a":1}')
    expect(readdirSync(out)).toEqual(['unknown-1.json'])
  })

  test('non-JSON stdin writes nothing and exits 0 silently', async () => {
    const result = await run(['capture', 'zed', out], `not json ${FAKE_KEY}`)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain(FAKE_KEY)
    expect(readdirSync(out)).toEqual([])
  })

  test('refuses an outDir under test/', async () => {
    const inside = join(import.meta.dir, '..', 'test', 'fixtures', 'nope')
    const result = await run(['capture', 'zed', inside], '{"event":"Stop"}')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('test/')
    const cmd = await run(['command', 'zed', inside])
    expect(cmd.code).not.toBe(0)
  })

  test('refuses a relative outDir', async () => {
    const result = await run(['capture', 'zed', 'relative/dir'], '{"event":"Stop"}')
    expect(result.stderr).toContain('absolute')
    expect(readdirSync(out)).toEqual([])
  })
})

describe('command', () => {
  test('prints an absolute, shell-quoted capture command', async () => {
    const dir = join(out, "with space's")
    const result = await run(['command', 'kimi-code', dir])
    expect(result.code).toBe(0)
    const line = result.stdout.trim()
    expect(isAbsolute(process.execPath)).toBe(true)
    expect(line.startsWith(`'${process.execPath}'`)).toBe(true)
    expect(line).toContain(`'${SCRIPT}' 'capture' 'kimi-code' `)
    expect(line).toContain(`'\\''`)
  })
})
