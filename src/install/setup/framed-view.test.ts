import { expect, test } from 'bun:test'
import type { PlanEvent } from '../plan'
import { fakeTerminal } from '../prompt/fake-terminal'
import { createPrompts } from '../prompt/prompts'
import { uiFor } from '../prompt/ui'
import { createWorld } from '../test-support'
import { createFramedView } from './framed-view'
import { openSession } from './session'

const LOG = '/home/u/.kinfold/logs/install.log'

function view(options: { verbose?: boolean; dryRun?: boolean; log?: string | null } = {}) {
  const term = fakeTerminal([])
  const made = createFramedView(createPrompts(term), { command: 'install', verbose: options.verbose ?? false, dryRun: options.dryRun ?? false, logPath: () => (options.log === undefined ? LOG : options.log) })
  const tell = (event: PlanEvent): void => {
    for (const listener of made.planListeners) listener(event)
  }
  /** What stays on the screen: the bar's own repaints are erased, so only finished lines count. */
  const lines = (): string[] => term.output().split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')).filter((line) => line !== '')
  return { made, tell, lines, term }
}

const start = (index: number, total: number, label: string): PlanEvent => ({ type: 'start', index, total, label, line: `  ${index + 1}. write /x/${label}` })
const end = (index: number, label: string, outcome: 'done' | 'failed' = 'done', error?: string): PlanEvent => ({ type: 'end', index, line: `  ${index + 1}. write /x/${label}`, outcome, ...(error !== undefined ? { error } : {}) })

test('a run draws one bar across the plan and its extra stages, then the summary and the next step', () => {
  const { made, tell, lines, term } = view()
  made.extraStages(1)
  tell({ type: 'begin', total: 2, dryRun: false })
  tell(start(0, 2, 'wiring Claude Code'))
  expect(term.output()).toContain('0/3  wiring Claude Code')
  tell(end(0, 'a'))
  tell(start(1, 2, 'starting the daemon'))
  tell(end(1, 'b'))
  made.stage('encrypting memory.db')
  expect(term.output()).toContain('2/3  encrypting memory.db')
  made.finish('Installed', [{ mark: 'ok', text: 'Agents: Claude Code' }], 'Check it with: kinfold status')
  expect(lines()).toEqual(['o  3 steps done', 'Installed', '  + Agents: Claude Code', `  Full log: ${LOG}`, 'Check it with: kinfold status'])
  expect(made.closed).toBe(true)
})

test('the numbered list stays off the screen unless --verbose', () => {
  const quiet = view()
  quiet.tell({ type: 'begin', total: 1, dryRun: false })
  quiet.tell(start(0, 1, 'a'))
  quiet.tell(end(0, 'a'))
  expect(quiet.term.output()).not.toContain('1. write /x/a')
  const loud = view({ verbose: true })
  loud.tell({ type: 'begin', total: 1, dryRun: false })
  loud.tell(start(0, 1, 'a'))
  loud.tell(end(0, 'a'))
  loud.tell({ type: 'end', index: 0, line: '  1. write /x/a', outcome: 'kept', kept: 'another install got there first' })
  expect(loud.lines()).toContain('|    1. write /x/a  [done]')
  expect(loud.lines()).toContain('|       another install got there first')
})

test('a failed step stops the bar and shows its full line, the reason and where the log is', () => {
  const { made, tell, lines } = view()
  tell({ type: 'begin', total: 3, dryRun: false })
  tell(start(0, 3, 'a'))
  tell(end(0, 'a'))
  tell(start(1, 3, 'starting the daemon'))
  tell(end(1, 'starting the daemon', 'failed', 'launchctl bootstrap failed (exit 5)'))
  made.stage('starting the daemon again')
  made.fail('install failed: step 2 failed: launchctl bootstrap failed (exit 5)')
  expect(lines()).toEqual([
    'x  stopped at step 2 of 3: starting the daemon',
    'x 2. write /x/starting the daemon',
    'x install failed: step 2 failed: launchctl bootstrap failed (exit 5)',
    `The full log is in ${LOG}`,
  ])
  expect(made.closed).toBe(true)
})

test('a failure before any step ran shows the reason alone, and names no log that was never written', () => {
  const { made, lines } = view({ log: null })
  made.fail('install failed: no key store on linux')
  expect(lines()).toEqual(['x install failed: no key store on linux', 'Nothing was changed.'])
})

test('a note prints above a running bar, and as a warning when no bar is running', () => {
  const { made, tell, lines } = view()
  made.note('before the bar')
  tell({ type: 'begin', total: 1, dryRun: false })
  tell(start(0, 1, 'a'))
  made.note('start the daemon yourself')
  expect(lines()).toContain('! before the bar')
  expect(lines()).toContain('!  start the daemon yourself')
})

test('a dry run draws no bar: the list is printed by whoever prints the lines', () => {
  const { made, tell, term } = view({ dryRun: true })
  tell({ type: 'begin', total: 2, dryRun: true })
  tell(start(0, 2, 'a'))
  tell({ type: 'end', index: 0, line: '  1. write /x/a', outcome: 'planned' })
  expect(term.output()).toBe('')
  made.finish('Dry run', [], 'Nothing was changed.')
  expect(term.output()).toContain('Nothing was changed.')
})

test('a plan with nothing to do still ends with the summary', () => {
  const { made, tell, lines } = view()
  tell({ type: 'begin', total: 0, dryRun: false })
  made.finish('Installed', [{ mark: 'none', text: 'nothing needed changing' }], 'next')
  expect(lines()).toEqual(['Installed', '  nothing needed changing', `  Full log: ${LOG}`, 'next'])
})

test('the session keeps the bar out of a plan that runs before the questions, and still logs it', async () => {
  const world = createWorld({ terminal: fakeTerminal([]) })
  try {
    const session = openSession(world.env, await uiFor(world.env, { yes: false }), 'install', { dryRun: false, verbose: false })
    expect(session.planListeners).toHaveLength(2)
    expect(session.logListeners).toHaveLength(1)
    for (const listener of session.logListeners) listener({ type: 'start', index: 0, total: 2, label: 'moving to the Kinfold names', line: '  1. move' })
    expect((world.env.terminal as ReturnType<typeof fakeTerminal>).output()).toBe('')
  } finally {
    await world.cleanup()
  }
})

test('cancelling ends the frame once, and later calls are ignored', () => {
  const { made, lines } = view()
  made.cancel('install cancelled; nothing was changed')
  made.fail('late')
  made.finish('late', [], 'late')
  expect(lines()).toEqual(['install cancelled; nothing was changed'])
})
