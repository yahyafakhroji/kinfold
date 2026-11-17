import { expect, test } from 'bun:test'
import { agentName, ago, bytes, deviceName, measuredSentence, savedLabel, tokens, when } from './format'

test('token figures are rounded to what a reader takes in', () => {
  expect([tokens(181_937), tokens(14_049), tokens(3_215), tokens(412)]).toEqual(['182,000', '14,000', '3,220', '412'])
})

test('a measured saving, a cost and no difference each say so plainly', () => {
  expect(savedLabel({ kind: 'measured', status: 'saving', tokens: 14_049, turnsCompared: 412 })).toMatchObject({ text: '~14,000', source: 'measured, 412 turns compared', tone: 'good' })
  expect(savedLabel({ kind: 'measured', status: 'cost', tokens: -1_200, turnsCompared: 80 })).toMatchObject({ text: 'Cost ~1,200 more', tone: 'bad' })
  expect(savedLabel({ kind: 'measured', status: 'no-difference', tokens: null, turnsCompared: 80 })).toMatchObject({ text: 'No measurable saving yet', source: 'measured, 80 turns compared' })
})

test('an estimate reads as an upper bound and says when it is partial', () => {
  expect(savedLabel({ kind: 'estimate', tokens: 3_215, partial: false })).toMatchObject({ text: 'up to ~3,220', source: 'estimate' })
  expect(savedLabel({ kind: 'estimate', tokens: 3_215, partial: true }).source).toBe('estimate, partial')
  expect(savedLabel({ kind: 'none' }).text).toBe('—')
})

test('every saved label explains itself without internal terms', () => {
  for (const saved of [{ kind: 'measured', status: 'saving', tokens: 1, turnsCompared: 60 }, { kind: 'estimate', tokens: 1, partial: true }, { kind: 'none' }] as const) {
    expect(savedLabel(saved).explain).not.toMatch(/observer|injection|delta|p95|held.out/i)
  }
})

test('the impact sentence names the agent and the sample', () => {
  expect(measuredSentence('claude-code', { status: 'not-enough', heldOut: 4, normal: 50, minSample: 30 })).toBe('Claude Code: not enough turns yet. The test needs 30 turns with memory and 30 without; it has 50 and 4.')
  expect(measuredSentence('claude-code', { status: 'no-difference', perTurn: 12, low: -40, high: 60, heldOut: 40, normal: 400 })).toBe('Claude Code: no measurable saving yet (440 turns compared; the difference is within normal variation).')
})

test('times read as a person says them', () => {
  const now = new Date(2026, 10, 17, 10, 0).getTime()
  expect(when(new Date(2026, 10, 17, 9, 12).getTime(), now)).toBe('Today 09:12')
  expect(when(new Date(2026, 10, 16, 17, 2).getTime(), now)).toBe('Yesterday 17:02')
  expect(ago(now - 90_000, now)).toBe('1 min ago')
  expect(ago(now - 3 * 3_600_000, now)).toBe('3 hours ago')
  expect(ago(now - 2 * 86_400_000, now)).toBe('2 days ago')
})

test('devices and sizes', () => {
  const names = new Map([['dev-a', 'MacBook Air']])
  expect([deviceName('local', names), deviceName('local', names, 'mac-mini'), deviceName('dev-a', names), deviceName(null, names)]).toEqual(['This computer', 'mac-mini', 'MacBook Air', 'Not recorded'])
  expect([bytes(512), bytes(1536), bytes(708 * 1024 ** 2)]).toEqual(['512 B', '1.5 KB', '708 MB'])
})

test('every agent Kinfold has a profile for reads by its own name, not its id', async () => {
  const { readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ids = readdirSync(join(import.meta.dir, '../../../../agents/profiles')).filter((name) => /^[a-z-]+\.ts$/.test(name)).map((name) => name.slice(0, -3))
  expect(ids.length).toBeGreaterThan(10)
  expect(ids.filter((id) => agentName(id) === id)).toEqual([])
})

test('a device that was not recorded says since when Kinfold records it', () => {
  expect(deviceName(null, new Map(), null, new Date(2026, 10, 17).getTime())).toBe('Not recorded before Nov 17, 2026')
})
