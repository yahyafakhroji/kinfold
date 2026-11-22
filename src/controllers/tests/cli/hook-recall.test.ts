// What the user sees from the hook: the recall line after a prompt and the
// list at session start. The line must name exactly the ids the hook put in
// the model's context, cost no second request, and change nothing the model reads.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userPromptContextOutput } from '../../../plugins/adapters/claude-code'
import { DEVIN_HOOK_ENV } from '../../../plugins/agents/hook-specs'
import type { AgentId } from '../../../plugins/agents/profile'
import { writeDisplayFile } from '../../../resources/context/display-file'
import { DAEMON_DOWN_LINE, DAEMON_DOWN_START_LINE, HELD_OUT_LINE, NO_ANSWER_LINE, NO_ANSWER_START_LINE, NO_PROMPT_MEMORY_LINE, idsInLine } from '../../../resources/context/recall-line'
import { seedObservation } from '../../../resources/tests/context/test-support'
import type { ContextRequest } from '../../../resources/context/types'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import { openStore } from '../../../resources/store/db'
import { upsertProject, upsertSession } from '../../../resources/store/writes'
import { runHook } from '../../cli/hook'

const FIXTURES = join(import.meta.dir, '../../../../test/fixtures')

let root: string
let dataDir: string
let daemon: RunningDaemon | null
let asked: ContextRequest[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-hook-recall-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  daemon = null
  asked = []
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  rmSync(root, { recursive: true, force: true })
})

type Out = Record<string, any>

const payload = (host: string, name: string, extra: Record<string, unknown> = {}): string => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, host, `${name}.json`), 'utf8')) as Record<string, unknown>
  return JSON.stringify(host === 'cursor' ? { ...raw, workspace_roots: [root], ...extra } : { ...raw, cwd: root, ...extra })
}

/** A daemon endpoint on disk and a fetch that answers for it, so a test fixes exactly what the daemon said. */
function fakeDaemon(): void {
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 4 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
}

interface RunOptions {
  env?: Record<string, string>
  status?: number
}

async function run(host: AgentId, name: string, answer: Record<string, unknown>, options: RunOptions = {}): Promise<Out | null> {
  const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
    asked.push(JSON.parse(String(init.body)) as ContextRequest)
    return new Response(JSON.stringify({ text: '', observationIds: [], tokens: 0, ...answer }), { status: options.status ?? 200 })
  }
  const line = await runHook(payload(host, name), dataDir, () => undefined, options.env ?? {}, { fetch: fetchFake, fallback: false }, host)
  if (line === null) return null
  expect(line.includes('\n')).toBe(false)
  return JSON.parse(line) as Out
}

const PROMPT_ANSWER = {
  text: '<kinfold>\n[opencode · 2h · tool-verified] Bun 1.4.4 is pinned (#28771)\n[codex · 1d · tool-verified] Service selection (#28768)\n</kinfold>',
  observationIds: [28771, 28768],
  tokens: 30,
  display: { recalled: [{ id: 28771, title: 'Bun 1.4.4 is pinned', part: 'new' }, { id: 28768, title: 'Service selection', part: 'related' }] },
}

const PACK_ANSWER = {
  text: '<kinfold>pack</kinfold>',
  observationIds: [3, 2, 1],
  tokens: 9,
  display: {
    firstScreen: {
      project: 'repo', total: 12, lastSessionAt: null,
      rows: [{ id: 3, title: 'Newest', occurredAt: Date.now() - 7_200_000 }, { id: 2, title: 'Older', occurredAt: Date.now() - 90_000_000 }, { id: 1, title: 'Oldest', occurredAt: Date.now() - 200_000_000 }],
    },
  },
}

// --- The proof: line and context agree, one request, nothing new for the model. ---

test('against a real daemon the recall line names exactly the ids the hook injected, with one request', async () => {
  const store = openStore(dataDir)
  let other: number
  try {
    upsertProject(store.db, { key: root, kind: 'path', displayName: 'recall-repo' }, Date.now())
    other = upsertSession(store.db, { host: 'opencode', hostSessionId: 'oc-seed', projectKey: root, cwd: root, occurredAt: Date.now() })
    seedObservation(store, { sessionId: other, projectKey: root, host: 'opencode', title: 'In the start pack', at: Date.now() })
  } finally {
    store.db.close()
  }
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  let requests = 0
  const counting = (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith('/context')) requests += 1
    return fetch(url, init)
  }
  const hook = (name: string): Promise<string | null> => runHook(payload('claude-code', name), dataDir, () => undefined, {}, { fetch: counting }, 'claude-code')

  const start = JSON.parse((await hook('session-start'))!) as Out
  const packIds = [...String(start.hookSpecificOutput.additionalContext).matchAll(/\(#(\d+)\)/g)].map((match) => Number(match[1]))
  expect(packIds.length).toBe(1)
  expect(String(start.systemMessage).split('\n')[0]).toBe('kinfold · recall-repo · 1 memory · last session 1m ago')
  expect(idsInLine(start.systemMessage)).toEqual(packIds)
  expect(requests).toBe(1)

  const later = openStore(dataDir)
  try {
    seedObservation(later, { sessionId: other, projectKey: root, host: 'opencode', title: 'Learned mid-session', at: Date.now() + 5_000 })
    seedObservation(later, { sessionId: other, projectKey: root, host: 'opencode', title: 'And another', at: Date.now() + 6_000 })
  } finally {
    later.db.close()
  }
  requests = 0
  const prompt = JSON.parse((await hook('user-prompt-submit'))!) as Out
  const context = String(prompt.hookSpecificOutput.additionalContext)
  const injected = [...context.matchAll(/\(#(\d+)\)/g)].map((match) => Number(match[1]))
  expect(injected.length).toBe(2)
  // The line names what the model was sent, in the same order, and nothing else.
  expect(idsInLine(prompt.systemMessage)).toEqual(injected)
  expect(String(prompt.systemMessage)).toContain('Learned mid-session')
  expect(String(prompt.systemMessage).startsWith('kinfold · recalled 2 (new from other sessions) · ')).toBe(true)
  expect(requests).toBe(1)
  // The line is for the user: none of it is in the model's text.
  expect(context).not.toContain('kinfold · recalled')
  // And it is what the daemon recorded as sent.
  const recorded = openStore(dataDir)
  try {
    const row = recorded.db.query("SELECT observation_ids AS ids FROM injections WHERE channel = 'prompt'").get() as { ids: string }
    expect(JSON.parse(row.ids)).toEqual(injected)
  } finally {
    recorded.db.close()
  }

  requests = 0
  const again = JSON.parse((await hook('user-prompt-submit'))!) as Out
  expect(again).toEqual({ systemMessage: 'kinfold · nothing recalled' })
  expect(requests).toBe(1)
})

test('showing the line changes nothing the model reads, and turning it off restores the old output byte for byte', async () => {
  fakeDaemon()
  const shown = await run('claude-code', 'user-prompt-submit', PROMPT_ANSWER)
  expect(shown!.systemMessage).toBe('kinfold · recalled 2 (1 related, 1 new from other sessions) · #28771 Bun 1.4.4 is pinned · #28768 Service selection')
  expect(shown!.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_ANSWER.text })
  expect(asked.length).toBe(1)

  writeDisplayFile(dataDir, { showRecall: false })
  const fetchFake = async (): Promise<Response> => new Response(JSON.stringify(PROMPT_ANSWER))
  const hidden = await runHook(payload('claude-code', 'user-prompt-submit'), dataDir, () => undefined, {}, { fetch: fetchFake, fallback: false }, 'claude-code')
  expect(hidden).toBe(userPromptContextOutput(PROMPT_ANSWER.text))
  const hiddenStart = await runHook(payload('claude-code', 'session-start'), dataDir, () => undefined, {}, { fetch: async () => new Response(JSON.stringify(PACK_ANSWER)), fallback: false }, 'claude-code')
  expect(JSON.parse(hiddenStart!)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACK_ANSWER.text } })
  // Nothing to add and nothing to show is no output at all, as before.
  expect(await runHook(payload('claude-code', 'user-prompt-submit'), dataDir, () => undefined, {}, { fetch: async () => new Response(JSON.stringify({ text: '', observationIds: [], tokens: 0 })), fallback: false }, 'claude-code')).toBeNull()
})

test('titles the daemon sent for ids it did not send never reach the line', async () => {
  fakeDaemon()
  const out = await run('claude-code', 'user-prompt-submit', { ...PROMPT_ANSWER, display: { recalled: [...PROMPT_ANSWER.display.recalled, { id: 999, title: 'Not in the context', part: 'related' }] } })
  expect(idsInLine(out!.systemMessage)).toEqual(PROMPT_ANSWER.observationIds)
  expect(String(out!.systemMessage)).not.toContain('Not in the context')
})

test('an answer from a daemon that predates the line still gets one, by id', async () => {
  fakeDaemon()
  const { display: _none, ...old } = PROMPT_ANSWER
  expect((await run('claude-code', 'user-prompt-submit', old))!.systemMessage).toBe('kinfold · recalled 2 · #28771 · #28768')
  expect((await run('claude-code', 'session-start', { text: 'pack', observationIds: [1, 2], tokens: 1 }))!.systemMessage)
    .toBe("kinfold · 2 memories in this session's context · kinfold dashboard")
  // A display block of the wrong shape is ignored, not fatal.
  expect((await run('claude-code', 'user-prompt-submit', { ...old, display: { recalled: 'nope', firstScreen: 4 } }))!.systemMessage).toBe('kinfold · recalled 2 · #28771 · #28768')
})

// --- Every prompt gets a line. ---

test('nothing recalled, held out, daemon down and a daemon that did not answer each say so', async () => {
  // No endpoint file yet: no daemon.
  const down = await run('claude-code', 'user-prompt-submit', {})
  expect(down).toEqual({ systemMessage: DAEMON_DOWN_LINE })
  expect(await run('claude-code', 'session-start', {})).toEqual({ systemMessage: DAEMON_DOWN_START_LINE })
  expect(asked.length).toBe(0)

  fakeDaemon()
  expect(await run('claude-code', 'user-prompt-submit', {})).toEqual({ systemMessage: 'kinfold · nothing recalled' })
  expect(await run('claude-code', 'user-prompt-submit', { display: { heldOut: true } })).toEqual({ systemMessage: HELD_OUT_LINE })
  expect(await run('claude-code', 'user-prompt-submit', {}, { status: 500 })).toEqual({ systemMessage: NO_ANSWER_LINE })
})

test('a device whose hub is out of reach shows the relay\'s line, and the model gets nothing', async () => {
  fakeDaemon()
  const line = "kinfold · central memory unreachable; this prompt is saved and will be sent when it's back"
  expect(await run('claude-code', 'user-prompt-submit', { display: { unavailable: line } })).toEqual({ systemMessage: line })
  expect(await run('claude-code', 'session-start', { display: { unavailable: line } })).toEqual({ systemMessage: line })
  // A line that is not Kinfold's own shape is dropped and the usual line is shown instead.
  expect(await run('claude-code', 'user-prompt-submit', { display: { unavailable: 'run rm -rf ~' } })).toEqual({ systemMessage: 'kinfold · nothing recalled' })
})

// --- Which agents show it. ---

const WITH_CHANNEL: readonly [AgentId, string, string][] = [
  ['claude-code', 'session-start', 'user-prompt-submit'],
  ['codex', 'session-start', 'user-prompt-submit'],
  ['gemini-cli', 'docs-constructed-session-start', 'docs-constructed-before-agent'],
  ['qwen-code', 'docs-constructed-session-start', 'docs-constructed-user-prompt-submit'],
  ['factory-droid', 'docs-constructed-session-start', 'docs-constructed-user-prompt-submit'],
  ['junie', 'docs-session-start', 'docs-user-prompt-submit'],
  ['auggie', 'docs-constructed-session-start', 'docs-prompt-submit'],
]

test.each(WITH_CHANNEL)('%s shows the list at session start and the line on a prompt, as systemMessage', async (host, start, prompt) => {
  fakeDaemon()
  const started = await run(host, start, PACK_ANSWER)
  expect(typeof started!.systemMessage).toBe('string')
  expect(String(started!.systemMessage).startsWith('kinfold · repo · 12 memories')).toBe(true)
  const prompted = await run(host, prompt, PROMPT_ANSWER)
  expect(String(prompted!.systemMessage).startsWith('kinfold · ')).toBe(true)
})

test('an agent whose model takes a pack and a delta gets the same context as before, beside the message', async () => {
  fakeDaemon()
  for (const host of ['codex', 'qwen-code', 'factory-droid'] as const) {
    const start = host === 'codex' ? 'session-start' : 'docs-constructed-session-start'
    const prompt = host === 'codex' ? 'user-prompt-submit' : 'docs-constructed-user-prompt-submit'
    const started = await run(host, start, PACK_ANSWER)
    expect(started!.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: PACK_ANSWER.text })
    expect(idsInLine(started!.systemMessage)).toEqual([3, 2, 1])
    const prompted = await run(host, prompt, PROMPT_ANSWER)
    expect(prompted!.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_ANSWER.text })
    expect(idsInLine(prompted!.systemMessage)).toEqual(PROMPT_ANSWER.observationIds)
  }
  const gemini = await run('gemini-cli', 'docs-constructed-before-agent', PROMPT_ANSWER)
  expect(gemini!.hookSpecificOutput).toEqual({ hookEventName: 'BeforeAgent', additionalContext: PROMPT_ANSWER.text })
})

test('Junie takes no pack at session start, so it is told so and nothing is recorded as sent', async () => {
  fakeDaemon()
  const started = await run('junie', 'docs-session-start', { display: { firstScreen: { project: 'repo', total: 12, lastSessionAt: null, rows: [] } } })
  expect(asked).toEqual([expect.objectContaining({ channel: 'session_start', displayOnly: true })])
  expect(started).toEqual({ systemMessage: 'kinfold · repo · 12 memories\n  no memory is sent at session start on this agent · kinfold dashboard' })
  const prompted = await run('junie', 'docs-user-prompt-submit', PROMPT_ANSWER)
  expect(prompted!.additionalContext).toBe(PROMPT_ANSWER.text)
  expect(idsInLine(prompted!.systemMessage)).toEqual(PROMPT_ANSWER.observationIds)
})

test('Auggie takes no memory on a prompt: it gets a line, and the daemon is not asked', async () => {
  fakeDaemon()
  expect(await run('auggie', 'docs-prompt-submit', PROMPT_ANSWER)).toEqual({ systemMessage: NO_PROMPT_MEMORY_LINE })
  expect(asked).toEqual([])
})

test('Amp gets the line as `notify` for its plugin to show, beside the message the model is given', async () => {
  fakeDaemon()
  const started = await run('amp', 'docs-constructed-session-start', PACK_ANSWER)
  expect(started!.message).toEqual({ content: PACK_ANSWER.text, display: false })
  expect(String(started!.notify).startsWith('kinfold · repo · 12 memories')).toBe(true)
  const prompted = await run('amp', 'docs-constructed-agent-start', PROMPT_ANSWER)
  expect(prompted!.message).toEqual({ content: PROMPT_ANSWER.text, display: false })
  expect(idsInLine(prompted!.notify)).toEqual(PROMPT_ANSWER.observationIds)
  expect(await run('amp', 'docs-constructed-agent-start', {})).toEqual({ notify: 'kinfold · nothing recalled' })
})

test.each([
  ['devin', 'docs-constructed-session-start', 'docs-constructed-user-prompt-submit'],
  ['cursor', 'session-start', 'before-submit-prompt'],
] as const)('%s has no user channel, so its output is what it always was', async (host, start, prompt) => {
  fakeDaemon()
  const started = await run(host, start, PACK_ANSWER)
  expect(JSON.stringify(started)).not.toContain('systemMessage')
  expect(JSON.stringify(started)).not.toContain('kinfold · ')
  const prompted = await run(host, prompt, PROMPT_ANSWER)
  expect(JSON.stringify(prompted)).not.toContain('systemMessage')
})

test("Devin running Claude Code's hooks gets no message: only its own docs could say it shows one", async () => {
  fakeDaemon()
  const raw = JSON.parse(payload('claude-code', 'user-prompt-submit')) as Record<string, unknown>
  delete raw.transcript_path
  const line = await runHook(JSON.stringify(raw), dataDir, () => undefined, { [DEVIN_HOOK_ENV]: root }, { fetch: async () => new Response(JSON.stringify(PROMPT_ANSWER)), fallback: false }, 'claude-code')
  expect(line).toBe(userPromptContextOutput(PROMPT_ANSWER.text))
})

// --- The update notice. ---

const NOTICE = { version: '0.5.0', channel: 'curl' } as const
const NOTICE_TEXT = 'Kinfold 0.5.0 is available. Run `kinfold update`.'

test.each(['codex', 'gemini-cli', 'qwen-code', 'factory-droid'] as const)('%s shows the update notice to the user and keeps it out of the context', async (host) => {
  fakeDaemon()
  const start = host === 'codex' ? 'session-start' : 'docs-constructed-session-start'
  const out = await run(host, start, { ...PACK_ANSWER, updateNotice: NOTICE })
  expect(String(out!.systemMessage).split('\n')[0]).toBe(NOTICE_TEXT)
  expect(String(out!.systemMessage)).toContain('kinfold · repo · 12 memories')
  expect(out!.hookSpecificOutput.additionalContext).toBe(PACK_ANSWER.text)
})

test.each(['junie', 'auggie'] as const)('%s shows the update notice too, though its model takes no pack', async (host) => {
  fakeDaemon()
  const out = await run(host, host === 'junie' ? 'docs-session-start' : 'docs-constructed-session-start', { updateNotice: NOTICE, display: { firstScreen: { project: 'repo', total: 0, lastSessionAt: null, rows: [] } } })
  expect(out).toEqual({ systemMessage: `${NOTICE_TEXT}\nkinfold · repo · no memories yet` })
})

test('with the line off, the six still show the notice, and nothing else', async () => {
  fakeDaemon()
  writeDisplayFile(dataDir, { showRecall: false })
  const out = await run('codex', 'session-start', { ...PACK_ANSWER, updateNotice: NOTICE })
  expect(out).toEqual({ systemMessage: NOTICE_TEXT, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACK_ANSWER.text } })
})

// --- Copilot: a progress line before the hook's normal output, which stays as it was. ---

const COPILOT_EVENTS = ['session-start', 'user-prompt-submit', 'post-tool-use', 'post-tool-use-failure', 'stop', 'session-end'] as const

/** Copilot's hook output as written to stdout: every line, since its user line is one of its own. */
async function copilot(name: (typeof COPILOT_EVENTS)[number], answer: Record<string, unknown> | null): Promise<string | null> {
  const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
    asked.push(JSON.parse(String(init.body)) as ContextRequest)
    return answer === null ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ text: '', observationIds: [], tokens: 0, ...answer }), { status: 200 })
  }
  return runHook(payload('copilot', `docs-constructed-${name}`), dataDir, () => undefined, {}, { fetch: fetchFake, fallback: false }, 'copilot')
}

const isProgress = (line: string): boolean => {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    return value.type === 'progress' && typeof value.message === 'string' && Object.keys(value).length === 2
  } catch {
    return false
  }
}

/** What the model is handed: the output with the lines Copilot strips taken out. */
const modelFacing = (output: string | null): string | null => {
  if (output === null) return null
  const rest = output.split('\n').filter((line) => !isProgress(line))
  return rest.length === 0 ? null : rest.join('\n')
}

test('Copilot gets the session list as one progress line, on its own line before the context', async () => {
  fakeDaemon()
  const output = await copilot('session-start', PACK_ANSWER)
  expect(output!.split('\n')).toEqual([
    JSON.stringify({ type: 'progress', message: "kinfold · repo · 12 memories · 3 in this session's context" }),
    JSON.stringify({ additionalContext: PACK_ANSWER.text }),
  ])
})

test('Copilot gets a progress line on a prompt, where its model takes nothing, and the daemon is not asked', async () => {
  fakeDaemon()
  expect(await copilot('user-prompt-submit', PROMPT_ANSWER)).toBe(JSON.stringify({ type: 'progress', message: NO_PROMPT_MEMORY_LINE }))
  expect(asked).toEqual([])
})

test("Copilot's model reads byte for byte what it read before the progress line existed", async () => {
  fakeDaemon()
  const packOut = JSON.stringify({ additionalContext: PACK_ANSWER.text })
  // What the hook printed before this change, for each event and each kind of answer.
  const before: [(typeof COPILOT_EVENTS)[number], Record<string, unknown> | null, string | null][] = [
    ['session-start', PACK_ANSWER, packOut],
    ['session-start', {}, null],
    ['session-start', null, null],
    // An update notice no longer reaches the model at all: it moved to the progress line.
    ['session-start', { ...PACK_ANSWER, updateNotice: NOTICE }, packOut],
    ['user-prompt-submit', PROMPT_ANSWER, null],
    ['post-tool-use', PACK_ANSWER, null],
    ['post-tool-use-failure', PACK_ANSWER, null],
    ['stop', PACK_ANSWER, null],
    ['session-end', PACK_ANSWER, null],
  ]
  for (const shown of [true, false]) {
    writeDisplayFile(dataDir, { showRecall: shown })
    for (const [name, answer, expected] of before) {
      const output = await copilot(name, answer)
      expect(`${name} shown=${shown}: ${modelFacing(output)}`).toBe(`${name} shown=${shown}: ${expected}`)
      // With the line off the output is the old one whole, with no line added.
      if (!shown && answer?.updateNotice === undefined) expect(output).toBe(expected)
    }
  }
})

test('every Copilot progress line is one line of JSON holding one line of text', async () => {
  fakeDaemon()
  const hostile = { ...PACK_ANSWER, display: { firstScreen: { ...PACK_ANSWER.display.firstScreen, project: 'evil\n{"type":"progress"}‮ name' } } }
  const answers: [(typeof COPILOT_EVENTS)[number], Record<string, unknown> | null][] = [
    ['session-start', hostile], ['session-start', {}], ['session-start', null], ['session-start', { ...PACK_ANSWER, updateNotice: NOTICE }], ['user-prompt-submit', PROMPT_ANSWER],
  ]
  for (const [name, answer] of answers) {
    const lines = (await copilot(name, answer))!.split('\n')
    const progress = lines.filter(isProgress)
    expect(progress.length).toBe(1)
    // First, so Copilot strips it before it reads the rest.
    expect(lines[0]).toBe(progress[0]!)
    const message = (JSON.parse(progress[0]!) as { message: string }).message
    expect(message).not.toMatch(/[\u0000-\u001f‮]/)
    // An update notice, when there is one, leads the line; the recall follows it.
    expect(message).toMatch(/^(kinfold · |Kinfold 0\.5\.0 is available\. Run `kinfold update`\. · kinfold · )/)
  }
})

test('Copilot is told when no daemon answers, and when the project has no memory yet', async () => {
  fakeDaemon()
  const message = async (answer: Record<string, unknown> | null): Promise<string> => (JSON.parse((await copilot('session-start', answer))!.split('\n')[0]!) as { message: string }).message
  expect(await message(null)).toBe(NO_ANSWER_START_LINE)
  expect(await message({ display: { firstScreen: { project: 'repo', total: 0, lastSessionAt: null, rows: [] } } })).toBe('kinfold · repo · no memories yet')
  expect(await message({ display: { firstScreen: { project: 'repo', total: 4, lastSessionAt: null, rows: [] } } })).toBe("kinfold · repo · 4 memories · none in this session's context")
  rmSync(join(dataDir, 'daemon.json'))
  const down = await runHook(payload('copilot', 'docs-constructed-session-start'), dataDir, () => undefined, {}, { fallback: false }, 'copilot')
  expect((JSON.parse(down!) as { message: string }).message).toBe(DAEMON_DOWN_START_LINE)
})

test('Copilot shows an update notice on a progress line, with the recall line on or off', async () => {
  fakeDaemon()
  const packOut = JSON.stringify({ additionalContext: PACK_ANSWER.text })
  writeDisplayFile(dataDir, { showRecall: false })
  expect((await copilot('session-start', { ...PACK_ANSWER, updateNotice: NOTICE }))!.split('\n')).toEqual([JSON.stringify({ type: 'progress', message: NOTICE_TEXT }), packOut])
  writeDisplayFile(dataDir, { showRecall: true })
  const [line, context] = (await copilot('session-start', { ...PACK_ANSWER, updateNotice: NOTICE }))!.split('\n')
  expect(JSON.parse(line ?? '').message).toStartWith(`${NOTICE_TEXT} · kinfold · repo`)
  expect(context).toBe(packOut)
})
