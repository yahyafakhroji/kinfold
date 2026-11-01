import { expect, test } from 'bun:test'
import { parseObserverOutput } from './parse'

const IDS = ['01JA', '01JB', '01JC']

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'discovery',
    title: 'Spool drains in host-time order',
    narrative: 'Entries sort by occurredAt.',
    facts: ['drain order follows host time'],
    files: ['src/spool/spool.ts'],
    evidence: { strength: 'tool-verified', sourceEventIds: ['01JA'] },
    ...overrides,
  }
}

const reply = (value: unknown): string => JSON.stringify(value)
const summary = { request: 'r', learned: 'l', completed: 'c', nextSteps: 'n' }

test('a valid reply is parsed with its summary', () => {
  const result = parseObserverOutput(reply({ observations: [observation()], summary }), IDS)
  expect(result).toEqual({
    ok: true,
    output: {
      observations: [expect.objectContaining({ type: 'discovery', evidence: { strength: 'tool-verified', sourceEventIds: ['01JA'] } })],
      summary,
      droppedIds: 0,
      droppedObservations: 0,
      droppedRelations: 0,
    },
  })
})

test.each([
  ['not json', 'not valid JSON'],
  ['[]', 'must be a JSON object'],
  [reply({ observations: {} , summary: null }), 'observations must be an array'],
  [reply({ observations: [] }), 'summary is required'],
  [reply({ observations: [observation({ title: '  ' })], summary: null }), 'title must not be empty'],
  [reply({ observations: [observation({ facts: [1] })], summary: null }), 'facts must be an array of strings'],
  [reply({ observations: [observation({ evidence: { strength: 'certain', sourceEventIds: ['01JA'] } })], summary: null }), 'strength must be one of'],
  [reply({ observations: [], summary: { request: 'r' } }), 'summary.learned must be a string'],
])('an invalid reply %p is rejected', (text, message) => {
  const result = parseObserverOutput(text, IDS)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain(message)
})

test('a null summary field is an empty field; a missing one is still rejected', () => {
  const result = parseObserverOutput(reply({ observations: [], summary: { ...summary, completed: null, nextSteps: null } }), IDS)
  expect(result.ok && result.output.summary).toEqual({ request: 'r', learned: 'l', completed: '', nextSteps: '' })
})

test('an unknown type drops only that observation and is counted', () => {
  const gossip = observation({ type: 'gossip', title: 'gossip' })
  const result = parseObserverOutput(reply({ observations: [gossip, observation()], summary }), IDS)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.output.observations.map((o) => o.title)).toEqual(['Spool drains in host-time order'])
  expect(result.output.droppedObservations).toBe(1)
  expect(result.output.summary).toEqual(summary)
})

test('cited ids that are not in the batch are dropped and counted', () => {
  const result = parseObserverOutput(reply({ observations: [observation({ evidence: { strength: 'interpretation', sourceEventIds: ['01JA', '01JZ', '01JA'] } })], summary: null }), IDS)
  expect(result.ok && result.output.observations[0]!.evidence.sourceEventIds).toEqual(['01JA'])
  expect(result.ok && result.output.droppedIds).toBe(1)
})

test('an observation left with no valid citation is dropped, and an uncited one too', () => {
  const unknownOnly = observation({ title: 'unknown', evidence: { strength: 'tool-verified', sourceEventIds: ['01JZ'] } })
  const uncited = observation({ title: 'uncited', evidence: { strength: 'tool-verified', sourceEventIds: [] } })
  const result = parseObserverOutput(reply({ observations: [unknownOnly, uncited, observation()], summary: null }), IDS)
  expect(result.ok && result.output.observations.map((o) => o.title)).toEqual(['Spool drains in host-time order'])
  expect(result.ok && result.output.droppedObservations).toBe(2)
})

test('a reply wrapped whole in one json fence is accepted', () => {
  const fenced = '```json\n' + reply({ observations: [], summary: null }) + '\n```'
  expect(parseObserverOutput(fenced, IDS).ok).toBe(true)
  expect(parseObserverOutput(`Here you go:\n${fenced}`, IDS).ok).toBe(false)
})

test('error messages never quote the reply', () => {
  const result = parseObserverOutput('SECRET-LOOKING-REPLY-TEXT {', IDS)
  expect(!result.ok && result.error).not.toContain('SECRET')
})

test('oversized fields are capped', () => {
  const result = parseObserverOutput(reply({ observations: [observation({ title: 't'.repeat(1_000), facts: Array(50).fill('f') })], summary: null }), IDS)
  expect(result.ok && result.output.observations[0]!.title.length).toBe(200)
  expect(result.ok && result.output.observations[0]!.facts.length).toBe(20)
})

test('relations keep known ids only, read "#12" as 12, and count every dropped entry', () => {
  const relations = [
    { kind: 'contradicts', observationId: 12 },
    { kind: 'updates', observationId: '#40' },
    { kind: 'confirms', observationId: 12 },
    { kind: 'contradicts', observationId: 12 },
    { kind: 'contradicts', observationId: 99 },
    { kind: 'refines', observationId: 12 },
    { kind: 'updates', observationId: 1.5 },
    'not an object',
  ]
  const result = parseObserverOutput(reply({ observations: [observation({ relations })], summary: null }), IDS, [12, 40])
  if (!result.ok) throw new Error(result.error)
  expect(result.output.observations[0]?.relations).toEqual([
    { kind: 'contradicts', observationId: 12 },
    { kind: 'updates', observationId: 40 },
    { kind: 'confirms', observationId: 12 },
  ])
  expect(result.output.droppedRelations).toBe(5)
  expect(result.output.droppedObservations).toBe(0)
})

test('with no prior memory shown, every relation is dropped; a missing relations field means none', () => {
  const result = parseObserverOutput(reply({ observations: [observation({ relations: [{ kind: 'contradicts', observationId: 1 }] }), observation({ title: 'other' })], summary: null }), IDS)
  if (!result.ok) throw new Error(result.error)
  expect(result.output.observations.map((item) => item.relations)).toEqual([[], []])
  expect(result.output.droppedRelations).toBe(1)
})

test('relations that are not an array reject the reply without quoting it', () => {
  const result = parseObserverOutput(reply({ observations: [observation({ relations: 'contradicts #12' })], summary: null }), IDS, [12])
  expect(result).toEqual({ ok: false, error: 'observations[0].relations must be an array' })
})
