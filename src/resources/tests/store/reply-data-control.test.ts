// A reply is prompt text in every way that matters to data control: retention
// expires it with the prompt, the leak scanner reads it, purge removes it with
// its row, and the size estimate counts it.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { FAKE_SECRETS } from '../../../../test/fixtures/secrets'
import { scanBatch } from '../../data-control/scanner'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { RULES_VERSION } from '../../redaction/rules'
import { purge } from '../../data-control/purge'
import { PROMPT_EXPIRED_MARKER, countExpiring, expirePromptTexts } from '../../store/retention-store'
import { SCAN_SPECS, readScanRow, unscannedRows } from '../../store/scan-store'
import { projectBytes } from '../../store/size-store'
import { insertPrompt, setPromptReply, upsertProject, upsertSession } from '../../store/writes'

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('kinfold-reply-control-')
  upsertProject(temp.store.db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, T0)
  session = upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 's1', projectKey: 'org/repo', cwd: '/w', occurredAt: T0 })
  insertPrompt(temp.store.db, { sessionId: session, promptNumber: 1, text: 'old prompt', occurredAt: T0 })
  insertPrompt(temp.store.db, { sessionId: session, promptNumber: 2, text: 'new prompt', occurredAt: T0 + 10_000 })
  insertPrompt(temp.store.db, { sessionId: session, promptNumber: 3, text: 'old, never answered', occurredAt: T0 + 1 })
  setPromptReply(temp.store.db, session, 1, 'old reply text')
  setPromptReply(temp.store.db, session, 2, 'new reply')
})
afterEach(() => temp.cleanup())

const prompts = () => temp.store.db.query('SELECT prompt_number AS n, text, reply_text AS reply FROM prompts ORDER BY prompt_number').all()

test('retention expires a reply with its prompt, and counts it in the preview', () => {
  expect(countExpiring(temp.store.db, 'prompts', T0 + 5_000)).toEqual({ rows: 2, bytes: 'old prompt'.length + 'old reply text'.length + 'old, never answered'.length })
  expect(expirePromptTexts(temp.store.db, T0 + 5_000, T0 + 20_000, 100).length).toBe(2)
  expect(prompts()).toEqual([
    { n: 1, text: PROMPT_EXPIRED_MARKER, reply: PROMPT_EXPIRED_MARKER },
    { n: 2, text: 'new prompt', reply: 'new reply' },
    // No reply was ever stored, so none is invented.
    { n: 3, text: PROMPT_EXPIRED_MARKER, reply: null },
  ])
  // A Stop that arrives after the text expired does not bring the reply back.
  expect(setPromptReply(temp.store.db, session, 1, 'late reply')).toBe(false)
  expect((prompts()[0] as { reply: string }).reply).toBe(PROMPT_EXPIRED_MARKER)
})

test('the leak scanner reads the reply, and a redact resolution rewrites it in place', () => {
  expect(SCAN_SPECS.prompts.columns).toEqual(['text', 'reply_text'])
  const db = temp.store.db
  // A secret that got past capture (a rule added later): planted directly, marked as never scanned.
  db.query('UPDATE prompts SET reply_text = $reply, scanned_version = 0 WHERE prompt_number = 2').run({ reply: `token ${FAKE_SECRETS.github} here` })
  const pending = unscannedRows(db, 'prompts', RULES_VERSION, 10)
  expect(pending.map((row) => row.fields.reply_text)).toEqual([`token ${FAKE_SECRETS.github} here`])

  const result = scanBatch(db, { hmacKey: 'test-key', now: () => T0 + 60_000 })
  expect(result.findings).toBeGreaterThan(0)
  const finding = db.query("SELECT table_name AS t, field, rule FROM redaction_findings WHERE table_name = 'prompts'").get() as { t: string; field: string; rule: string }
  expect(finding).toMatchObject({ t: 'prompts', field: 'reply_text' })
  const id = (db.query('SELECT CAST(id AS TEXT) AS id FROM prompts WHERE prompt_number = 2').get() as { id: string }).id
  expect(readScanRow(db, 'prompts', id)?.fields.text).toBe('new prompt')
})

test('purging a session removes its replies, and the size estimate counted them', () => {
  const before = projectBytes(temp.store.db, 5).find((row) => row.projectKey === 'org/repo')!
  expect(before.promptBytes).toBe('old prompt'.length + 'new prompt'.length + 'old, never answered'.length + 'old reply text'.length + 'new reply'.length)
  purge(temp.store.db, { kind: 'session', id: session }, { dryRun: false, now: () => T0 + 30_000 })
  expect(prompts()).toEqual([])
})
