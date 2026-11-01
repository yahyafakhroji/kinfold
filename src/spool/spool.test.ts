import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RedactedEvent, prepareForSpool } from '../capture/prepare'
import type { NormalizedEvent } from '../contract/event'
import { ulid } from '../contract/ulid'
import { ALL_SECRET_VALUES, FAKE_SECRETS, leakyOutput } from '../../test/fixtures/secrets'
import { DIR_MODE, FILE_MODE, QUARANTINE_DIR, readSpool, removeSpoolEntry, writeSpoolEntry } from './spool'

const options = { hmacKey: 'test-hmac-key' }
let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-spool-'))
  dir = join(root, 'spool')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const event = (occurredAt: number, output = 'ok'): NormalizedEvent => ({
  schemaVersion: 1,
  eventId: ulid(occurredAt),
  host: 'opencode',
  hostSessionId: 'ses_1',
  kind: 'tool_result',
  occurredAt,
  cwd: '/Users/dev/repo',
  tool: { name: 'bash', input: { command: 'ls' }, output, exitCode: 0 },
})

const prepared = (e: NormalizedEvent): RedactedEvent => prepareForSpool(e, options)
const mode = (path: string): number => statSync(path).mode & 0o777

describe('writeSpoolEntry', () => {
  test('writes an owner-only file in an owner-only directory', () => {
    const path = writeSpoolEntry(dir, prepared(event(1_792_839_465_000)))
    expect(mode(dir)).toBe(DIR_MODE)
    expect(mode(path)).toBe(FILE_MODE)
    expect(path).toMatch(/\/1792839465000-[0-9A-Z]{26}\.json$/)
    expect(readdirSync(dir).some((name) => name.startsWith('.tmp-'))).toBe(false)
  })

  test('refuses an invalid event', () => {
    const broken = { ...prepared(event(1_792_839_465_000)), cwd: 'relative' } as RedactedEvent
    expect(() => writeSpoolEntry(dir, broken)).toThrow('cwd must be an absolute path')
  })

  test('the file on disk holds none of the corpus secrets', () => {
    const leaky: NormalizedEvent = {
      ...event(1_792_839_465_000, leakyOutput()),
      tool: {
        name: 'Bash',
        input: { command: `OPENROUTER_API_KEY=${FAKE_SECRETS.openrouter} bun run sync`, env: { API_TOKEN: FAKE_SECRETS.envPassword } },
        output: leakyOutput(),
        exitCode: 0,
      },
    }
    const raw = readFileSync(writeSpoolEntry(dir, prepared(leaky)), 'utf8')
    for (const secret of ALL_SECRET_VALUES) expect(raw).not.toContain(secret)
    expect(raw).toContain('Loaded config for app')
  })
})

describe('readSpool', () => {
  test('returns entries oldest first and honors the limit', () => {
    writeSpoolEntry(dir, prepared(event(1_792_839_465_300)))
    writeSpoolEntry(dir, prepared(event(1_792_839_465_100)))
    writeSpoolEntry(dir, prepared(event(1_792_839_465_200)))
    expect(readSpool(dir).entries.map((entry) => entry.event.occurredAt)).toEqual([
      1_792_839_465_100, 1_792_839_465_200, 1_792_839_465_300,
    ])
    expect(readSpool(dir, 2).entries).toHaveLength(2)
  })

  test('moves corrupt entries to quarantine and reports why', () => {
    writeSpoolEntry(dir, prepared(event(1_792_839_465_000)))
    const bad = `1792839465001-${ulid(1_792_839_465_001)}.json`
    writeFileSync(join(dir, bad), '{not json', { mode: FILE_MODE })

    const { entries, quarantined } = readSpool(dir)
    expect(entries).toHaveLength(1)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.path).toBe(join(dir, QUARANTINE_DIR, bad))
    expect(quarantined[0]?.reason).toStartWith('unreadable JSON')
  })

  test('returns nothing for a missing directory, and removed entries stay gone', () => {
    expect(readSpool(join(root, 'missing'))).toEqual({ entries: [], quarantined: [] })
    const path = writeSpoolEntry(dir, prepared(event(1_792_839_465_000)))
    removeSpoolEntry(path)
    expect(readSpool(dir).entries).toHaveLength(0)
  })
})
