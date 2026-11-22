import { afterEach, expect, test } from 'bun:test'
import { type FakeWorld, createWorld } from '../install/test-support'
import type { CentralArgs } from './cli'
import { offerCentral } from './wizard'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function setup(answers: string[], interactive: boolean): { world: FakeWorld; joins: CentralArgs[]; join: (args: CentralArgs) => Promise<number> } {
  world = createWorld({ answers, interactive })
  const joins: CentralArgs[] = []
  return { world, joins, join: async (args) => {
    joins.push(args)
    return 0
  } }
}

test('the wizard offers central memory on the named hub and asks for its code', async () => {
  const { world, joins, join } = setup(['', 'kf-4821-9tqx'], true)
  expect(await offerCentral(world.env, { hub: 'mini', code: null, yes: false, dryRun: false }, join)).toBe(0)
  expect(joins).toEqual([{ command: 'join', hub: 'mini', port: 37_812, code: 'kf-4821-9tqx' }])
})

test('saying no keeps this device\'s own memory', async () => {
  const { world, joins, join } = setup(['n'], true)
  expect(await offerCentral(world.env, { hub: 'mini:40000', code: null, yes: false, dryRun: false }, join)).toBe(0)
  expect(joins).toEqual([])
  expect(world.out).toContain('Kept this device\'s own memory. kinfold central join mini:40000 switches later.')
})

test('with --yes and a code it joins without asking; without a code it says what to run', async () => {
  const withCode = setup([], false)
  expect(await offerCentral(withCode.world.env, { hub: 'mini:40000', code: 'KF-4821-9TQX', yes: true, dryRun: false }, withCode.join)).toBe(0)
  // A code from --central-code was on the command line, so the join says so, as it does for its own positional code.
  expect(withCode.joins).toEqual([{ command: 'join', hub: 'mini', port: 40_000, code: 'KF-4821-9TQX', codeInArgs: true }])
  await withCode.world.cleanup()
  const noCode = setup([], false)
  expect(await offerCentral(noCode.world.env, { hub: 'mini', code: null, yes: true, dryRun: false }, noCode.join)).toBe(1)
  expect(noCode.world.out).toContain('To use central memory on mini, run kinfold central serve there for a code, then: kinfold central join mini (or install again with --central-code <code>).')
})

test('a dry run only says what it would do', async () => {
  const { world, joins, join } = setup([], true)
  expect(await offerCentral(world.env, { hub: 'mini', code: null, yes: false, dryRun: true }, join)).toBe(0)
  expect(joins).toEqual([])
  expect(world.out).toContain('would offer central memory on mini (kinfold central join)')
})

test('a hub name that is not an address is refused', async () => {
  const { world, join } = setup([], true)
  expect(await offerCentral(world.env, { hub: 'mini;rm', code: null, yes: true, dryRun: false }, join)).toBe(2)
})
