import { expect, test } from 'bun:test'
import { fakeTerminal } from './prompt/fake-terminal'
import { NOT_A_TERMINAL, type RecoverySink, confirmRecoveryCode, recoverySinkFromEnv, recoverySinkFromTerminal } from './recovery-confirm'

const CODE = 'ABCDE-FGH23-45678-JKMNP-QRSTV'

function envSink(typed: string, overrides: { interactive?: boolean; printsToTerminal?: boolean } = {}): { sink: () => RecoverySink; said: string[]; asked: string[] } {
  const said: string[] = []
  const asked: string[] = []
  const io = { interactive: overrides.interactive ?? true, printsToTerminal: overrides.printsToTerminal, ask: async (q: string) => (asked.push(q), typed), askSecret: async () => '', readStdin: async () => '' }
  return { sink: () => recoverySinkFromEnv({ io, out: (line) => said.push(line) }), said, asked }
}

test('the last two groups confirm, in lower case and with O for 0', async () => {
  expect(await confirmRecoveryCode(envSink('jkmnp-qrstv').sink(), CODE)).toBe(true)
  expect(await confirmRecoveryCode(envSink(' JKMNP QRSTV ').sink(), CODE)).toBe(true)
  expect(await confirmRecoveryCode(envSink('jkmop-qrstv').sink(), 'ABCDE-FGH23-45678-JKM0P-QRSTV')).toBe(true)
})

test('a wrong tail does not confirm', async () => {
  expect(await confirmRecoveryCode(envSink('jkmnp-qrstw').sink(), CODE)).toBe(false)
  expect(await confirmRecoveryCode(envSink('').sink(), CODE)).toBe(false)
  expect(await confirmRecoveryCode(envSink(CODE).sink(), CODE)).toBe(false)
})

test('the code appears only in say lines, never in the question', async () => {
  const world = envSink('jkmnp-qrstv')
  await confirmRecoveryCode(world.sink(), CODE)
  expect(world.said.some((line) => line.includes(CODE))).toBe(true)
  expect(world.asked.join('\n')).not.toContain('JKMNP')
  expect(world.asked.join('\n')).not.toContain('ABCDE')
})

test('no sink is minted without a terminal', () => {
  expect(() => recoverySinkFromTerminal(null)).toThrow(NOT_A_TERMINAL)
  expect(() => envSink('', { interactive: false }).sink()).toThrow(NOT_A_TERMINAL)
  expect(() => envSink('', { printsToTerminal: false }).sink()).toThrow(NOT_A_TERMINAL)
})

test('a hand-made sink refuses and prints nothing of the code', async () => {
  const said: string[] = []
  const asked: string[] = []
  const forged = { kind: 'recovery-sink', say: (line: string) => said.push(line), ask: async (q: string) => (asked.push(q), 'jkmnp-qrstv') } as RecoverySink
  await expect(confirmRecoveryCode(forged, CODE)).rejects.toThrow(NOT_A_TERMINAL)
  expect(said).toEqual([])
  expect(asked).toEqual([])
})

test('the refusal message never holds the code', async () => {
  const forged = { kind: 'recovery-sink', say: () => {}, ask: async () => '' } as RecoverySink
  const error = await confirmRecoveryCode(forged, CODE).catch((e: unknown) => e)
  expect(String(error)).not.toContain('ABCDE')
})

test('a terminal sink shows the code on the terminal and reads the tail there', async () => {
  const term = fakeTerminal(['jkmnp-qrstv\r'])
  expect(await confirmRecoveryCode(recoverySinkFromTerminal(term), CODE)).toBe(true)
  expect(term.output()).toContain(CODE)
  expect(term.rawStates().at(-1)).toBe(false)
})
