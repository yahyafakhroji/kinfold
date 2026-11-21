import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USAGE } from '../install/args'
import { parseProjectArgs, runProjectCommand } from './project-cli'

let root: string
let dataDir: string
let lines: string[]
let asked: { method: string; path: string; body: unknown }[]
let answer: { status: number; body: unknown }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-project-cli-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 1 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  lines = []
  asked = []
  answer = { status: 200, body: {} }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const env = () => ({
  dataDir,
  out: (line: string) => lines.push(line),
  fetch: (async (url: string, init: RequestInit) => {
    asked.push({ method: init.method ?? 'GET', path: new URL(url).pathname, body: init.body === undefined ? undefined : JSON.parse(init.body as string) })
    return Response.json(answer.body, { status: answer.status })
  }) as typeof fetch,
})

test('the project commands parse, and a wrong one says how to use it', () => {
  expect(parseProjectArgs(['status'])).toBeNull()
  expect(parseProjectArgs(['project', 'list'])).toEqual({ ok: true, value: { command: 'list' } })
  expect(parseProjectArgs(['project', 'merge', 'a', 'b'])).toEqual({ ok: true, value: { command: 'merge', from: 'a', into: 'b', yes: false } })
  expect(parseProjectArgs(['project', 'split', 'a', '--yes'])).toEqual({ ok: true, value: { command: 'split', key: 'a', yes: true } })
  expect(parseProjectArgs(['project', 'merge', 'a'])).toMatchObject({ ok: false })
  expect(parseProjectArgs(['project'])).toMatchObject({ ok: false })
  expect(USAGE).toContain('project    list | merge <old> <into> [--yes] | split <key> [--yes]')
})

test('list prints each key with its memory and session counts, and where a merged key went', async () => {
  answer = { status: 200, body: { projects: [
    { key: 'github.com/me/kinfold', name: 'kinfold', kind: 'git-remote', memories: 1284, sessions: 40, lastAt: 1, mergedInto: null, held: false },
    { key: 'github.com/me/shared-agent-memory', name: 'shared-agent-memory', kind: 'git-remote', memories: 0, sessions: 0, lastAt: null, mergedInto: 'github.com/me/kinfold', held: false },
  ], merges: [] } }
  expect(await runProjectCommand(env(), { command: 'list' })).toBe(0)
  expect(lines).toEqual([
    'kinfold  github.com/me/kinfold  1,284 memories, 40 sessions',
    'shared-agent-memory  github.com/me/shared-agent-memory  merged into github.com/me/kinfold (kinfold project split github.com/me/shared-agent-memory undoes it)',
  ])
})

test('merge without --yes is a dry run that says what would move and how to go ahead', async () => {
  answer = { status: 200, body: { ok: true, dryRun: true, from: '/Users/me/rea', into: 'github.com/me/kinfold', counts: { sessions: 2, observations: 31 } } }
  expect(await runProjectCommand(env(), { command: 'merge', from: '/Users/me/rea', into: 'github.com/me/kinfold', yes: false })).toBe(0)
  expect(asked).toEqual([{ method: 'POST', path: '/projects/merge', body: { from: '/Users/me/rea', into: 'github.com/me/kinfold', dryRun: true } }])
  expect(lines).toEqual(['dry run, nothing changed; would move sessions 2, observations 31 from /Users/me/rea to github.com/me/kinfold', 'run again with --yes to merge'])
})

test('split with --yes moves the rows back, and a refusal is exit 1 with the reason', async () => {
  answer = { status: 200, body: { ok: true, dryRun: false, from: 'a', into: 'b', counts: { observations: 3 } } }
  expect(await runProjectCommand(env(), { command: 'split', key: 'a', yes: true })).toBe(0)
  expect(asked[0]).toEqual({ method: 'POST', path: '/projects/split', body: { key: 'a', dryRun: false } })
  expect(lines).toEqual(['moved observations 3 from b back to a; a stays apart from now on'])
  lines = []
  answer = { status: 409, body: { error: 'this device uses central memory: run kinfold project on the hub' } }
  expect(await runProjectCommand(env(), { command: 'list' })).toBe(1)
  expect(lines.join('\n')).toContain('run kinfold project on the hub')
})
