import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_VERSIONS_FILE, serializeHostVersions } from '../adapters/host-version'
import { rebuildProjectPacks } from '../context/packs'
import { seedObservation } from '../context/test-support'
import type { NormalizedEvent } from '../contract/event'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { openStore } from '../store/db'
import { upsertProject, upsertSession } from '../store/writes'
import { hostFromArgs } from './hook'

const HOOK = join(import.meta.dir, 'hook.ts')
const FIXTURES = join(import.meta.dir, '../../test/fixtures')

let root: string
let dataDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-hook-hosts-'))
  dataDir = join(root, 'data')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function runHook(stdin: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, HOOK, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: root, SAM_DATA_DIR: dataDir, [SQLITE3MC_LIB_ENV]: process.env[SQLITE3MC_LIB_ENV] ?? '', SAM_DB_KEYSTORE: 'none' },
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, stdout, stderr }
}

/** A fixture moved into the temp root, which is the project. */
function payload(host: string, name: string, extra: Record<string, unknown> = {}): string {
  const raw = JSON.parse(readFileSync(join(FIXTURES, host, `${name}.json`), 'utf8')) as Record<string, unknown>
  const moved = host === 'cursor' ? { ...raw, workspace_roots: [root], ...(raw.cwd !== undefined ? { cwd: root } : {}) } : { ...raw, cwd: root }
  return JSON.stringify({ ...moved, ...extra })
}

function spooledEvents(): NormalizedEvent[] {
  const dir = join(dataDir, 'spool')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as NormalizedEvent)
}

function seedProjectPack(title: string): void {
  const store = openStore(dataDir)
  try {
    upsertProject(store.db, { key: root, kind: 'path', displayName: 'hook-hosts-repo' }, Date.now())
    const session = upsertSession(store.db, { host: 'claude-code', hostSessionId: 'cc-seed', projectKey: root, cwd: root, occurredAt: Date.now() })
    seedObservation(store, { sessionId: session, projectKey: root, host: 'claude-code', title, at: Date.now() })
    rebuildProjectPacks(store.db, root, Date.now())
  } finally {
    store.db.close()
  }
}

function recordVersions(records: Record<string, { version: string; recordedAt: number; binary: { path: string; mtimeMs: number } | null }>): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, HOST_VERSIONS_FILE), serializeHostVersions(records))
}

test('--host picks the adapter; no flag is Claude Code; an unknown host is null', () => {
  expect(hostFromArgs([])).toBe('claude-code')
  expect(hostFromArgs(['--host', 'codex'])).toBe('codex')
  expect(hostFromArgs(['--host=cursor'])).toBe('cursor')
  expect(hostFromArgs(['--host', 'zed'])).toBeNull()
  expect(hostFromArgs(['--host'])).toBeNull()
})

test('Codex SessionStart is captured as codex and gets the pack in the hookSpecificOutput shape', async () => {
  seedProjectPack('Codex sees the shared pack')
  const run = await runHook(payload('codex', 'session-start'), ['--host', 'codex'])
  expect(run.exitCode).toBe(0)
  expect(run.stdout.trim().split('\n')).toHaveLength(1)
  const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(output.hookSpecificOutput.additionalContext).toContain('Codex sees the shared pack')
  expect(spooledEvents()).toEqual([expect.objectContaining({ host: 'codex', kind: 'session_start', cwd: root })])
})

test('Cursor sessionStart gets the pack as additional_context and nothing else', async () => {
  seedProjectPack('Cursor sees the shared pack')
  const run = await runHook(payload('cursor', 'session-start'), ['--host', 'cursor'])
  expect(run.exitCode).toBe(0)
  const output = JSON.parse(run.stdout) as Record<string, string>
  expect(Object.keys(output)).toEqual(['additional_context'])
  expect(output.additional_context).toContain('Cursor sees the shared pack')
  expect(spooledEvents()).toEqual([expect.objectContaining({ host: 'cursor', kind: 'session_start', hostVersion: '2.4.21' })])
})

test('every other Codex and Cursor event leaves stdout empty, even with a pack waiting', async () => {
  seedProjectPack('A pack nobody should print')
  for (const name of ['user-prompt-submit', 'post-tool-use.bash', 'stop', 'session-end']) {
    expect(await runHook(payload('codex', name), ['--host', 'codex'])).toMatchObject({ exitCode: 0, stdout: '' })
  }
  for (const name of ['before-submit-prompt', 'post-tool-use.shell', 'after-agent-response', 'session-end']) {
    expect(await runHook(payload('cursor', name), ['--host', 'cursor'])).toMatchObject({ exitCode: 0, stdout: '' })
  }
  expect(spooledEvents()).toHaveLength(8)
})

test('an unknown --host captures nothing and still exits 0', async () => {
  const run = await runHook(payload('codex', 'session-start'), ['--host', 'zed'])
  expect(run).toMatchObject({ exitCode: 0, stdout: '' })
  expect(run.stderr).toContain('unknown --host')
  expect(spooledEvents()).toEqual([])
})

test('host_version for Claude Code and Codex comes from the install record while the binary is unchanged', async () => {
  const binary = join(root, 'fake-codex')
  writeFileSync(binary, '#!/bin/sh\n')
  const mtimeMs = statSync(binary).mtimeMs
  recordVersions({
    'claude-code': { version: '2.1.310', recordedAt: Date.now(), binary: null },
    codex: { version: '0.120.0', recordedAt: Date.now(), binary: { path: binary, mtimeMs } },
  })
  await runHook(payload('codex', 'user-prompt-submit'), ['--host', 'codex'])
  const claude = JSON.parse(readFileSync(join(FIXTURES, 'claude-code', 'user-prompt-submit.json'), 'utf8')) as Record<string, unknown>
  await runHook(JSON.stringify({ ...claude, cwd: root }), [])
  const versions = Object.fromEntries(spooledEvents().map((event) => [event.host, event.hostVersion]))
  expect(versions).toEqual({ codex: '0.120.0', 'claude-code': '2.1.310' })

  // An upgrade replaces the binary: the record goes stale and the version is left out, not guessed.
  utimesSync(binary, new Date(), new Date(Date.now() + 60_000))
  rmSync(join(dataDir, 'spool'), { recursive: true, force: true })
  await runHook(payload('codex', 'stop'), ['--host', 'codex'])
  expect(spooledEvents()).toEqual([expect.not.objectContaining({ hostVersion: expect.anything() })])
})
