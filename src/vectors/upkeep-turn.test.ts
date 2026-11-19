import { expect, test } from 'bun:test'
import { createUpkeepTurns } from './upkeep-turn'

test('a turn runs slices while there is more, yielding to the event loop between them', async () => {
  const order: string[] = []
  let left = 3
  const turns = createUpkeepTurns({
    slice: () => {
      order.push('slice')
      left -= 1
      return left > 0
    },
    budgetMs: 1_000,
  })
  // Waiting when the turn starts: the first slice runs at once, then the turn yields and this goes before the second.
  setTimeout(() => order.push('other work'), 0)
  await turns.run()
  expect(order).toEqual(['slice', 'other work', 'slice', 'slice'])
})

test('a turn stops at its budget and leaves the rest for the next turn', async () => {
  let clock = 0
  let slices = 0
  const turns = createUpkeepTurns({
    slice: () => {
      slices += 1
      clock += 40
      return true
    },
    budgetMs: 100,
    now: () => clock,
  })
  await turns.run()
  // 40, 80, 120: the third slice crossed the budget.
  expect(slices).toBe(3)
})

test('a turn asked for while one runs does not start a second', async () => {
  let slices = 0
  const turns = createUpkeepTurns({ slice: () => (slices += 1) < 3, budgetMs: 1_000 })
  await Promise.all([turns.run(), turns.run()])
  expect(slices).toBe(3)
})

test('a slice that throws ends the turn; the next turn starts again', async () => {
  let calls = 0
  const turns = createUpkeepTurns({
    slice: () => {
      calls += 1
      if (calls === 1) throw new Error('locked')
      return false
    },
    budgetMs: 1_000,
    onError: () => {},
  })
  await turns.run()
  await turns.run()
  expect(calls).toBe(2)
})

test('stop waits for the running turn and runs no slice after it', async () => {
  let slices = 0
  const turns = createUpkeepTurns({ slice: () => (slices += 1) < 100, budgetMs: 10_000 })
  const running = turns.run()
  await turns.stop()
  const at = slices
  expect(at).toBeLessThan(100)
  await running
  await turns.run()
  expect(slices).toBe(at)
})
