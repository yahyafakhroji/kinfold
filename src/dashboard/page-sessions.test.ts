// The Sessions page: a list of sessions, and one session walked turn by turn
// with the prompt, what was recalled, the reply and what was saved. Stored
// text is another program's output, so it must reach the page as text nodes
// only; the fake document throws on any HTML-parsing API.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { SessionDetail, SessionList, SessionTurn } from '../store/session-reads'
import { type FakeElement, type FakeNode, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

type Hash = { page: string; params: Record<string, string> }
interface SessionsPage {
  REPLY_PREVIEW_CHARS: number
  clockTime(at: number): string
  sessionsList(answer: SessionList, state: Hash): FakeElement
  turnItem(turn: SessionTurn): FakeElement
  sessionView(detail: SessionDetail, state: Hash): FakeElement
  renderSessions(state: Hash): Promise<FakeElement>
}

const load = async (): Promise<SessionsPage> => (await import(join(PUBLIC_DIR, 'page-sessions.js'))) as SessionsPage
const text = (root: FakeNode): string => textNodes(root).map((node) => node.textContent).join('|')
const AT = Date.UTC(2026, 10, 15, 9, 12)

const TURN: SessionTurn = {
  promptNumber: 1, at: AT, prompt: 'how do we pin bun in CI?', reply: 'We pin Bun through .bun-version, and CI reads it.', expired: false, heldOut: false, recallKnown: true,
  recalled: [{ id: 28771, title: 'Bun 1.4.4 is pinned', part: 'related' }, { id: 94451, title: 'Schema version from MIGRATIONS', part: 'new' }],
  saved: [{ id: 95012, title: 'CI pins Bun with .bun-version', type: 'decision' }],
  summary: { request: 'pin bun in CI', learned: 'the version file drives CI', completed: 'explained it', nextSteps: 'none' },
}
const SESSION = { id: 7, host: 'claude-code', projectKey: 'org/repo', project: 'repo', startedAt: AT - 60_000, lastEventAt: AT + 60_000, endedAt: null, prompts: 2, startMemories: 12 }
const DETAIL: SessionDetail = { session: SESSION, turns: [TURN], nextAfter: null }

let saved: { document: unknown; fetch: unknown }
let answers: Record<string, unknown> = {}
const requested: string[] = []
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  saved = { document: globals.document, fetch: globals.fetch }
  globals.document = fakeDocument()
  globals.fetch = async (path: string) => {
    requested.push(path)
    return new Response(JSON.stringify(answers[path] ?? { error: 'not scripted' }), { status: path in answers ? 200 : 500, headers: { 'content-type': 'application/json' } })
  }
})
afterAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = saved.document
  globals.fetch = saved.fetch
})

const click = (element: FakeElement): void => {
  for (const listener of element.listeners.get('click') ?? []) listener({ preventDefault: () => {} })
}
const buttons = (root: FakeNode, label: string): FakeElement[] => elements(root).filter((element) => element.tagName === 'BUTTON' && element.textContent === label)
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('the list shows each session with its agent, project, start and prompt count, and links to it', async () => {
  const page = await load()
  const list: SessionList = { sessions: [SESSION, { ...SESSION, id: 6, host: 'codex', project: 'other', prompts: 0 }], nextBefore: 6 }
  const view = page.sessionsList(list, { page: 'sessions', params: {} })
  const rows = elements(view).filter((element) => element.tagName === 'TR').map((row) => text(row))
  expect(rows[0]).toBe('Started|Agent|Project|Prompts|')
  expect(rows[1]).toBe(`2026-11-15 09:11|claude-code|repo|2|open`)
  expect(rows[2]).toContain('codex|other|0|open')
  const links = elements(view).filter((element) => element.tagName === 'A').map((link) => link.getAttribute('href'))
  expect(links).toContain('#sessions?id=7')
  expect(links).toContain('#sessions?before=6')
  expect(text(page.sessionsList({ sessions: [], nextBefore: null }, { page: 'sessions', params: {} }))).toContain('No sessions recorded yet.')
})

test('a turn reads in order: you, recalled, agent, saved, with the summary as side detail', async () => {
  const page = await load()
  const turn = page.turnItem(TURN)
  const shown = text(turn)
  const order = ['you', 'how do we pin bun in CI?', 'recalled', '#28771', 'Bun 1.4.4 is pinned', '#94451', 'agent', 'We pin Bun through .bun-version, and CI reads it.', 'saved', '#95012', 'CI pins Bun with .bun-version']
  let from = 0
  for (const piece of order) {
    const at = shown.indexOf(piece, from)
    expect(at).toBeGreaterThanOrEqual(from)
    from = at
  }
  expect(shown).toContain(page.clockTime(AT))
  // Recalled and saved memories open in the memory browser.
  const links = elements(turn).filter((element) => element.tagName === 'A').map((link) => link.getAttribute('href'))
  expect(links).toEqual(['#memory?id=28771', '#memory?id=94451', '#memory?id=95012'])
  // The AI summary is there, folded away: plain text first.
  const details = elements(turn).filter((element) => element.tagName === 'DETAILS')
  expect(details).toHaveLength(1)
  expect(details[0]!.getAttribute('open')).toBeNull()
  expect(text(details[0]!)).toContain('the version file drives CI')
})

test('a turn with nothing recalled, a held-out turn, a turn with no reply and an expired one each say so', async () => {
  const page = await load()
  const bare = { ...TURN, recalled: [], saved: [], summary: null }
  expect(text(page.turnItem(bare))).toContain('nothing recalled')
  expect(text(page.turnItem({ ...bare, recallKnown: false }))).toContain('not recorded for turns from before this version')
  expect(text(page.turnItem({ ...bare, recallKnown: false }))).not.toContain('nothing recalled')
  expect(text(page.turnItem({ ...bare, heldOut: true }))).toContain('recall held out for this prompt (impact test)')
  expect(text(page.turnItem({ ...bare, reply: null }))).toContain('no reply captured')
  const expired = text(page.turnItem({ ...bare, expired: true, prompt: '<expired reason="retention"/>', reply: '<expired reason="retention"/>' }))
  expect(expired).toContain('removed by retention')
  expect(expired).not.toContain('<expired')
  expect(elements(page.turnItem(bare)).some((element) => element.tagName === 'DETAILS')).toBe(false)
})

test('stored text is shown as text: markup, a redaction marker and control characters are never parsed', async () => {
  const page = await load()
  const hostile = '<img src=x onerror=alert(1)> <redacted type="github_token" ref="ab12"/> \u001b[31mred'
  const turn = page.turnItem({ ...TURN, prompt: hostile, reply: hostile, recalled: [{ id: 1, title: '<script>x</script>', part: 'new' }], saved: [{ id: 2, title: '<b>bold</b>', type: 'decision' }] })
  // The fake document throws on innerHTML, so reaching here means none was used; the text is intact in text nodes.
  expect(text(turn)).toContain('<redacted type="github_token" ref="ab12"/>')
  expect(text(turn)).toContain('<script>x</script>')
  expect(elements(turn).some((element) => element.tagName === 'IMG' || element.tagName === 'SCRIPT' || element.tagName === 'B')).toBe(false)
})

test('a long reply is cut with "show all", which opens it and closes it again', async () => {
  const page = await load()
  const long = `${'word '.repeat(400)}THE-END`
  const turn = page.turnItem({ ...TURN, reply: long })
  expect(text(turn)).not.toContain('THE-END')
  const open = buttons(turn, 'show all')
  expect(open).toHaveLength(1)
  click(open[0]!)
  expect(text(turn)).toContain('THE-END')
  const close = buttons(turn, 'show less')
  expect(close).toHaveLength(1)
  click(close[0]!)
  expect(text(turn)).not.toContain('THE-END')
  // A short reply has nothing to open.
  expect(buttons(page.turnItem(TURN), 'show all')).toEqual([])
  expect(long.length).toBeGreaterThan(page.REPLY_PREVIEW_CHARS)
})

test('a session opens with its header, and a long one loads more turns on request', async () => {
  const page = await load()
  const first: SessionDetail = { session: SESSION, turns: [TURN], nextAfter: 1 }
  answers = {
    '/memory/sessions/7/turns': first,
    '/memory/sessions/7/turns?after=1': { session: SESSION, turns: [{ ...TURN, promptNumber: 2, prompt: 'and on Windows?', reply: 'The same file.', recalled: [], saved: [], summary: null }], nextAfter: null },
  }
  const view = await page.renderSessions({ page: 'sessions', params: { id: '7' } })
  expect(requested.at(-1)).toBe('/memory/sessions/7/turns')
  const shown = text(view)
  expect(shown).toContain('claude-code')
  expect(shown).toContain('repo')
  expect(shown).toContain('12 memories in its context at the start')
  expect(shown).not.toContain('and on Windows?')

  const more = buttons(view, 'Load more turns')
  expect(more).toHaveLength(1)
  click(more[0]!)
  await settle()
  expect(requested.at(-1)).toBe('/memory/sessions/7/turns?after=1')
  expect(text(view)).toContain('and on Windows?')
  // That was the last page.
  expect(buttons(view, 'Load more turns')).toEqual([])
  expect(elements(view).filter((element) => element.tagName === 'A').some((link) => link.getAttribute('href') === '#sessions')).toBe(true)
})

test('the list is what the page shows without a session id, and it carries the cursor and filters to the daemon', async () => {
  const page = await load()
  answers = { '/memory/sessions': { sessions: [SESSION], nextBefore: null }, '/memory/sessions?before=6&host=codex': { sessions: [], nextBefore: null } }
  expect(text(await page.renderSessions({ page: 'sessions', params: {} }))).toContain('claude-code')
  expect(requested.at(-1)).toBe('/memory/sessions')
  await page.renderSessions({ page: 'sessions', params: { before: '6', host: 'codex' } })
  expect(requested.at(-1)).toBe('/memory/sessions?before=6&host=codex')
  // A session id that is not a number never reaches a URL.
  answers = { '/memory/sessions': { sessions: [], nextBefore: null } }
  await page.renderSessions({ page: 'sessions', params: { id: '../../x' } })
  expect(requested.at(-1)).toBe('/memory/sessions')
})

test('a short DETAIL view shows no "Load more turns"', async () => {
  const page = await load()
  expect(buttons(page.sessionView(DETAIL, { page: 'sessions', params: { id: '7' } }), 'Load more turns')).toEqual([])
})
