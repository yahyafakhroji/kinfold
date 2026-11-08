import { expect, test } from 'bun:test'
import { confirmRecoveryCode } from './recovery-confirm'

const CODE = 'ABCDE-FGH23-45678-JKMNP-QRSTV'

async function run(typed: string): Promise<{ ok: boolean; said: string[]; asked: string[] }> {
  const said: string[] = []
  const asked: string[] = []
  const ok = await confirmRecoveryCode(async (question) => (asked.push(question), typed), (line) => said.push(line), CODE)
  return { ok, said, asked }
}

test('the last two groups confirm, in lower case and with O for 0', async () => {
  expect((await run('jkmnp-qrstv')).ok).toBe(true)
  expect((await run(' JKMNP QRSTV ')).ok).toBe(true)
  const withZero = 'ABCDE-FGH23-45678-JKM0P-QRSTV'
  const said: string[] = []
  expect(await confirmRecoveryCode(async () => 'jkmop-qrstv', (line) => said.push(line), withZero)).toBe(true)
})

test('a wrong tail does not confirm', async () => {
  expect((await run('jkmnp-qrstw')).ok).toBe(false)
  expect((await run('')).ok).toBe(false)
  expect((await run(CODE)).ok).toBe(false)
})

test('the code appears only in say lines, never in the question', async () => {
  const { said, asked } = await run('jkmnp-qrstv')
  expect(said.some((line) => line.includes(CODE))).toBe(true)
  expect(asked.join('\n')).not.toContain('JKMNP')
  expect(asked.join('\n')).not.toContain('ABCDE')
})
