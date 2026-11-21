// `kinfold watch --debug`: the trace the daemon keeps in memory, one block per
// event. Formatting is checked line by line; the poll runs against a scripted
// daemon, as watch.test.ts does.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TraceEvent } from '../debug/trace'
import { parseWatchArgs } from '../install/args'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { type WatchEnv, runWatch } from './cli'
import { formatDebugEvent } from './debug'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-watch-debug-')
  // runWatch reads where the daemon listens; nothing listens there, the fetch below answers.
  writeFileSync(join(temp.dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 1 }))
  writeFileSync(join(temp.dataDir, 'daemon.token'), 'a'.repeat(64))
})
afterEach(() => temp.cleanup())

const hhmm = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
const base = { seq: 1, at: T0, host: 'claude-code', project: 'repo', projectKey: 'org/repo', hostSessionId: 'cc-1' }

const PROMPT: TraceEvent = {
  ...base, kind: 'prompt',
  hook: { ms: 12, budgetMs: 180, late: false, heldOut: false },
  fresh: [{ id: 20, title: 'New from Codex' }],
  search: {
    mode: 'keyword and meaning', semantic: 'ok', space: 'local/bge-small', terms: ['csv', 'parser', 'quotes'], query: 'why does the csv parser drop quotes?',
    candidates: [
      { id: 12, title: 'CSV parser drops quotes', source: 'keyword and meaning', distance: 0.31, matchedTerms: 3, outcome: 'sent' },
      { id: 4, title: 'Release notes', source: 'meaning', distance: 0.9, matchedTerms: 1, outcome: 'below cutoff', rule: 'farther than 0.70 in meaning' },
      { id: 7, title: 'Old note', source: 'meaning', distance: 0.2, matchedTerms: 0, outcome: 'already delivered' },
    ],
  },
  sent: { ids: [20, 12], tokens: 85, line: 'kinfold · recalled 2 (1 related, 1 new from other sessions) · #20 New from Codex · #12 CSV parser drops quotes' },
}

test('a prompt prints the hook, the search with each candidate and its outcome, the new memory and what was sent', () => {
  expect(formatDebugEvent(PROMPT)).toEqual([
    `${hhmm(T0)}  claude-code · repo · prompt`,
    '  hook      daemon answered in 12 ms; the hook waits 180 ms',
    '  search    keyword and meaning · embeddings local/bge-small · terms csv, parser, quotes',
    '  query     "why does the csv parser drop quotes?"',
    '    sent               #12 CSV parser drops quotes · distance 0.31 · 3 terms · keyword and meaning',
    '    below cutoff       #4 Release notes · distance 0.90 · 1 term · meaning · farther than 0.70 in meaning',
    '    already delivered  #7 Old note · distance 0.20 · 0 terms · meaning',
    '  new       #20 New from Codex',
    '  sent      2 memories, 85 tokens · recalled 2 (1 related, 1 new from other sessions) · #20 New from Codex · #12 CSV parser drops quotes',
  ])
})

test('a late, held-out or keyword-only prompt says so', () => {
  const late = formatDebugEvent({ ...PROMPT, hook: { ...PROMPT.hook, ms: 400, late: true } } as TraceEvent)
  expect(late[1]).toBe('  hook      daemon answered in 400 ms, after the 180 ms the hook waits: the hook used its fallback, and this is not counted as sent')
  const held = formatDebugEvent({ ...PROMPT, hook: { ...PROMPT.hook, heldOut: true }, search: null, fresh: [], sent: { ids: [], tokens: 0, line: 'kinfold · recall held out for this prompt (impact test)' } } as TraceEvent)
  expect(held).toEqual([`${hhmm(T0)}  claude-code · repo · prompt`, '  hook      held out for the impact test (daemon answered in 12 ms)', '  search    none', '  new       none', '  sent      nothing · recall held out for this prompt (impact test)'])
  const keyword = formatDebugEvent({ ...PROMPT, search: { ...PROMPT.search!, mode: 'keyword', semantic: 'off', space: null, query: '', candidates: [] } } as TraceEvent)
  expect(keyword.slice(2, 4)).toEqual(['  search    keyword · meaning off · terms csv, parser, quotes', '    no candidates'])
})

test('a session start, a turn end and an observer run each print their own block', () => {
  expect(formatDebugEvent({ ...base, kind: 'start', rows: [{ id: 1, title: 'Bun is pinned' }, { id: 2, title: 'Service selection' }], tokens: 90 })).toEqual([
    `${hhmm(T0)}  claude-code · repo · session start`,
    '  pack      2 rows, 90 tokens · #1 Bun is pinned · #2 Service selection',
  ])
  const usage = { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 40_000, cacheCreationTokens: 500, toolCalls: 4, durationMs: 12_300 }
  expect(formatDebugEvent({ ...base, kind: 'turn', promptNumber: 3, usage, kinfoldTokens: 85 })).toEqual([
    `${hhmm(T0)}  claude-code · repo · turn end`,
    '  usage     input 1,200 · cache read 40,000 · cache write 500 · output 300 · 4 tool calls · 12.3 s',
    '  kinfold   85 tokens added to this prompt (0.2% of the turn\'s input)',
  ])
  expect(formatDebugEvent({ ...base, kind: 'turn', promptNumber: 3, usage: null, kinfoldTokens: 0 })[1]).toBe('  usage     not readable from the transcript')
  expect(formatDebugEvent({ ...base, kind: 'observer', status: 'succeeded', events: 12, written: 3 })).toEqual([`${hhmm(T0)}  claude-code · repo · observer ran on 12 events, wrote 3`])
  expect(formatDebugEvent({ ...base, kind: 'observer', status: 'skipped', events: 2, written: 0 })).toEqual([`${hhmm(T0)}  claude-code · repo · observer skipped 2 events`])
  expect(formatDebugEvent({ ...base, kind: 'observer', status: 'failed', events: 2, written: 0, note: 'claude-cli: the login Kinfold uses has expired\u001b[31m' })).toEqual([
    `${hhmm(T0)}  claude-code · repo · observer failed on 2 events`,
    '  why       claude-cli: the login Kinfold uses has expired [31m',
  ])
})

test('titles and project names are cleaned to one line, as everywhere else', () => {
  const lines = formatDebugEvent({ ...base, project: 'evil\u001b[31m\nname', kind: 'start', rows: [{ id: 1, title: 'a\nb\u0007c' }], tokens: 1 })
  expect(lines.every((line) => !/[\u0000-\u001f]/.test(line))).toBe(true)
})

interface Fake {
  env: WatchEnv
  out: string[]
  asked: string[]
}

function fakeWatch(answers: Response[], stop: AbortController): Fake {
  const out: string[] = []
  const asked: string[] = []
  const env: WatchEnv = {
    dataDir: temp.dataDir,
    out: (line) => out.push(line),
    sleep: async () => {},
    fetch: async (url) => {
      asked.push(String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, ''))
      const answer = answers.shift()
      if (answers.length === 0) stop.abort()
      return answer ?? Response.json({ cursor: 0, events: [] })
    },
  }
  return { env, out, asked }
}

const start = { ...base, seq: 5, kind: 'start', rows: [], tokens: 0 }

test('--debug polls /watch/debug from now with the filters and prints each event once', async () => {
  const stop = new AbortController()
  const fake = fakeWatch([Response.json({ cursor: 4, events: [] }), Response.json({ cursor: 5, events: [start] }), Response.json({ cursor: 5, events: [] })], stop)
  expect(await runWatch(fake.env, { command: 'watch', host: 'claude-code', project: null, debug: true, json: false }, { stop: stop.signal })).toBe(0)
  expect(fake.asked).toEqual(['/watch/debug?host=claude-code', '/watch/debug?after=4&host=claude-code', '/watch/debug?after=5&host=claude-code'])
  expect(fake.out).toEqual([
    'watching claude-code with the reasons behind each recall; Ctrl-C to stop',
    `${hhmm(T0)}  claude-code · repo · session start`,
    '  pack      0 rows, 0 tokens',
  ])
})

test('--json prints one JSON object per event and nothing else', async () => {
  const stop = new AbortController()
  const fake = fakeWatch([Response.json({ cursor: 4, events: [] }), Response.json({ cursor: 5, events: [start] }), Response.json({ cursor: 5, events: [] })], stop)
  expect(await runWatch(fake.env, { command: 'watch', host: null, project: null, debug: true, json: true }, { stop: stop.signal })).toBe(0)
  expect(fake.out.map((line) => JSON.parse(line))).toEqual([start])
})

test('a daemon without the debug route is named, and the flags parse', async () => {
  const old = fakeWatch([new Response('{}', { status: 404 })], new AbortController())
  expect(await runWatch(old.env, { command: 'watch', host: null, project: null, debug: true, json: false }, {})).toBe(1)
  expect(old.out).toEqual(['kinfold watch failed: the running daemon is an older build without watch --debug; run kinfold update'])
  expect(parseWatchArgs(['watch', '--debug'])).toEqual({ ok: true, value: { command: 'watch', host: null, project: null, debug: true, json: false } })
  expect(parseWatchArgs(['watch', '--debug', '--json', '--project', 'repo'])).toEqual({ ok: true, value: { command: 'watch', host: null, project: 'repo', debug: true, json: true } })
  expect(parseWatchArgs(['watch', '--json'])).toEqual({ ok: false, error: '--json goes with --debug' })
  expect(parseWatchArgs(['watch', '--debug=yes'])?.ok).toBe(false)
})

test('a daemon that restarted starts a new trace: the watch reads it from its start, once', async () => {
  const stop = new AbortController()
  const ev = (seq: number) => ({ ...start, seq })
  const fake = fakeWatch([
    Response.json({ cursor: 480, epoch: 'a', events: [] }),
    Response.json({ cursor: 481, epoch: 'a', events: [ev(481)] }),
    // The new daemon has 2 events; asked after 481 it has nothing to give, and says it is another trace.
    Response.json({ cursor: 2, epoch: 'b', events: [] }),
    Response.json({ cursor: 2, epoch: 'b', events: [ev(1), ev(2)] }),
    Response.json({ cursor: 2, epoch: 'b', events: [] }),
  ], stop)
  await runWatch(fake.env, { command: 'watch', host: null, project: null, debug: true, json: true }, { stop: stop.signal })
  expect(fake.asked).toEqual(['/watch/debug', '/watch/debug?after=480', '/watch/debug?after=481', '/watch/debug?after=0', '/watch/debug?after=2'])
  expect(fake.out.map((line) => JSON.parse(line).seq)).toEqual([481, 1, 2])
})
