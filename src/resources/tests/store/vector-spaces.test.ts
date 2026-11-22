import { afterEach, beforeEach, expect, test } from 'bun:test'
import { T0, type TempStore, openTempStore } from '../observer/test-support'
import { activeSpace, buildingSpace, promoteBuilding, setVecReady, spaceOf, startBuilding, startActive } from '../../store/vector-spaces'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-spaces-')
})
afterEach(() => temp.cleanup())

test('a fresh store has no space', () => {
  expect(activeSpace(temp.store.db)).toBeNull()
  expect(buildingSpace(temp.store.db)).toBeNull()
})

test('the first space starts active, not ready', () => {
  const space = startActive(temp.store.db, { model: 'local/m', dims: 384 }, T0)
  expect(space).toEqual({ id: space.id, model: 'local/m', dims: 384, state: 'active', vecReady: false })
  expect(activeSpace(temp.store.db)).toEqual(space)
  expect(spaceOf(temp.store.db, { model: 'local/m', dims: 384 })).toEqual(space)
})

test('a switch builds beside the active space, then promotes and hands back the old one', () => {
  const old = startActive(temp.store.db, { model: 'openai/x', dims: 512 }, T0)
  const next = startBuilding(temp.store.db, { model: 'local/m', dims: 384 }, T0)
  expect(buildingSpace(temp.store.db)?.id).toBe(next.id)
  expect(activeSpace(temp.store.db)?.id).toBe(old.id)
  setVecReady(temp.store.db, next.id, true)
  const retired = promoteBuilding(temp.store.db)
  expect(retired?.id).toBe(old.id)
  expect(activeSpace(temp.store.db)).toEqual({ ...next, state: 'active', vecReady: true })
  expect(buildingSpace(temp.store.db)).toBeNull()
  expect(spaceOf(temp.store.db, { model: 'openai/x', dims: 512 })).toBeNull()
})

test('starting a different build replaces the earlier one and hands it back', () => {
  startActive(temp.store.db, { model: 'a', dims: 2 }, T0)
  const first = startBuilding(temp.store.db, { model: 'b', dims: 2 }, T0)
  const replaced: number[] = []
  startBuilding(temp.store.db, { model: 'c', dims: 2 }, T0, (space) => replaced.push(space.id))
  expect(replaced).toEqual([first.id])
  expect(buildingSpace(temp.store.db)?.model).toBe('c')
})

test('building the space that is already building keeps it', () => {
  startActive(temp.store.db, { model: 'a', dims: 2 }, T0)
  const first = startBuilding(temp.store.db, { model: 'b', dims: 2 }, T0)
  expect(startBuilding(temp.store.db, { model: 'b', dims: 2 }, T0).id).toBe(first.id)
})

test('a new space never takes the id of an index table still being dropped', () => {
  const db = temp.store.db
  startActive(db, { model: 'a', dims: 2 }, T0)
  const first = startBuilding(db, { model: 'b', dims: 2 }, T0)
  // The replaced build's table is dropped a chunk at a time, after its row is gone.
  db.run(`CREATE TABLE vec_space_${first.id} (x)`)
  const second = startBuilding(db, { model: 'c', dims: 2 }, T0)
  expect(second.id).toBeGreaterThan(first.id)
})
