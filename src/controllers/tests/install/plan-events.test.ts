import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Action, type PlanEvent, linesListener, runPlan, shortLabel } from '../../../resources/install-plan/plan'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const actionsIn = (w: FakeWorld): Action[] => [
  { kind: 'mkdir', path: join(w.root, 'made'), mode: 0o700 },
  { kind: 'touch', path: join(w.root, 'made', 'file'), mode: 0o600 },
]

test('with no listeners given, the plan prints the lines it always printed', async () => {
  world = createWorld()
  await runPlan(world.env, actionsIn(world), false)
  expect(world.out).toEqual([
    'applying 2 actions',
    `  1. mkdir ${join(world.root, 'made')} (mode 0700)  [done]`,
    `  2. create ${join(world.root, 'made', 'file')} if missing (mode 0600)  [done]`,
  ])
})

test('a dry run prints the plan and changes nothing', async () => {
  world = createWorld()
  await runPlan(world.env, actionsIn(world), true)
  expect(world.out).toEqual([
    'plan (dry run, nothing is changed): 2 actions',
    `  1. mkdir ${join(world.root, 'made')} (mode 0700)`,
    `  2. create ${join(world.root, 'made', 'file')} if missing (mode 0600)`,
  ])
  expect(existsSync(join(world.root, 'made'))).toBe(false)
})

test('an empty plan says so in both modes', async () => {
  world = createWorld()
  await runPlan(world.env, [], false)
  await runPlan(world.env, [], true)
  expect(world.out).toEqual(['nothing to change', 'plan: nothing to change'])
})

test('listeners see begin, then a start and an end for each action, with its label and its full line', async () => {
  world = createWorld()
  const events: PlanEvent[] = []
  await runPlan(world.env, actionsIn(world), false, undefined, { listeners: [(event) => void events.push(event)], labels: ['making the folder'] })
  expect(world.out).toEqual([])
  expect(events.map((event) => event.type)).toEqual(['begin', 'start', 'end', 'start', 'end'])
  expect(events[0]).toEqual({ type: 'begin', total: 2, dryRun: false })
  expect(events[1]).toEqual({ type: 'start', index: 0, total: 2, label: 'making the folder', line: `  1. mkdir ${join(world.root, 'made')} (mode 0700)` })
  expect(events[2]).toMatchObject({ type: 'end', index: 0, outcome: 'done' })
  expect(events[3]).toMatchObject({ type: 'start', index: 1, label: 'creating file' })
})

test('several listeners all hear the same stream', async () => {
  world = createWorld()
  const lines: string[] = []
  let ends = 0
  await runPlan(world.env, actionsIn(world), false, undefined, { listeners: [linesListener((line) => void lines.push(line)), (event) => void (ends += event.type === 'end' ? 1 : 0)] })
  expect(lines).toHaveLength(3)
  expect(ends).toBe(2)
})

test('a failing action ends as failed, with its error, and the plan still stops there', async () => {
  world = createWorld()
  const events: PlanEvent[] = []
  const actions: Action[] = [{ kind: 'backup', from: join(world.root, 'missing'), to: join(world.root, 'copy') }, ...actionsIn(world)]
  await expect(runPlan(world.env, actions, false, () => 'the daemon still runs', { listeners: [(event) => void events.push(event)] })).rejects.toThrow(/^step 1 failed: .*; the daemon still runs$/)
  const end = events.at(-1) as Extract<PlanEvent, { type: 'end' }>
  expect(end.outcome).toBe('failed')
  expect(end.error).toContain('ENOENT')
  expect(events.filter((event) => event.type === 'start')).toHaveLength(1)
})

test('the printed lines mark a failed step, as before', async () => {
  world = createWorld()
  await expect(runPlan(world.env, [{ kind: 'backup', from: join(world.root, 'missing'), to: join(world.root, 'copy') }], false)).rejects.toThrow('step 1 failed')
  expect(world.out.at(-1)).toMatch(/\[failed\]$/)
})

test('every action kind has a short label with no path in it', () => {
  const samples: Action[] = [
    { kind: 'mkdir', path: '/home/u/.kinfold', mode: 0o700 },
    { kind: 'write', path: '/home/u/.claude/settings.json', content: '', mode: 0o600, summary: 'x' },
    { kind: 'service', step: 'start', description: 'launchctl bootstrap' },
    { kind: 'service', step: 'stop', description: 'launchctl bootout' },
    { kind: 'wait-health' },
    { kind: 'install-program', from: '/tmp/a', to: '/home/u/.kinfold/bin/kinfold', assetName: null, expectedSha256: null, check: false },
  ]
  expect(samples.map(shortLabel)).toEqual(['creating the .kinfold folder', 'writing settings.json', 'starting the daemon', 'stopping the daemon', 'waiting for the daemon to answer', 'installing the kinfold program'])
  for (const label of samples.map(shortLabel)) expect(label).not.toContain('/')
})
