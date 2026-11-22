import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { readEnv } from '../env-names'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { activeSpace, buildingSpace, startActive } from '../store/vector-spaces'
import { upsertVectors } from '../store/vector-store'
import { mergeProjects } from '../store/project-merge'
import { upsertProject } from '../store/writes'
import { createSpaceManager, withFastDelete } from './space-manager'
import { createVecIndex, knnCandidates, vecIndexExists } from './vec-index'

const VEC0 = readEnv(process.env, 'TEST_VEC0')
const OLD = { model: 'old', dims: 2 }
const NEW = { model: 'new', dims: 2 }

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('kinfold-space-manager-')
  session = seedSession(temp.store, 'claude-code', 's1')
})
afterEach(() => temp.cleanup())

const db = () => temp.store.db
const hashOf = (id: number): string => (db().query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
const seed = (title: string): number => seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title, at: T0 })
const embed = (id: number, model: string, x = 1): void => {
  upsertVectors(db(), model, [{ id, contentHash: hashOf(id), vector: Float32Array.from([x, 1 - x]) }], T0)
}
const rowsOf = (model: string): number => (db().query('SELECT count(*) AS n FROM observation_vectors WHERE model = ?').get(model) as { n: number }).n

describe('without sqlite-vec', () => {
  test('a store with no space starts the target as active', () => {
    const manager = createSpaceManager({ db: db(), vec0: false, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    manager.step()
    expect(activeSpace(db())).toMatchObject({ ...NEW, state: 'active' })
    expect(manager.searchSpace()).toMatchObject(NEW)
  })

  test('a new target builds beside the active space; search stays on the old one until every observation is embedded', () => {
    const ids = [seed('a'), seed('b')]
    for (const id of ids) embed(id, OLD.model)
    startActive(db(), OLD, T0)
    const lines: string[] = []
    const manager = createSpaceManager({ db: db(), vec0: false, target: NEW, now: () => T0, promoteBacklog: 0, log: (line) => lines.push(line) })
    manager.step()
    expect(buildingSpace(db())).toMatchObject(NEW)
    expect(manager.searchSpace()).toMatchObject(OLD)
    embed(ids[0]!, NEW.model)
    manager.step()
    expect(manager.searchSpace()).toMatchObject(OLD)
    embed(ids[1]!, NEW.model)
    manager.step()
    expect(manager.searchSpace()).toMatchObject(NEW)
    expect(buildingSpace(db())).toBeNull()
    expect(lines.some((line) => line.includes('vectors switched to new'))).toBe(true)
    // The old space's rows go on the next steps.
    manager.step()
    expect(rowsOf(OLD.model)).toBe(0)
    expect(rowsOf(NEW.model)).toBe(2)
  })

  test('switching back to the active space drops the half-built one', () => {
    const id = seed('a')
    embed(id, OLD.model)
    startActive(db(), OLD, T0)
    createSpaceManager({ db: db(), vec0: false, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} }).step()
    embed(id, NEW.model)
    seed('b')
    const back = createSpaceManager({ db: db(), vec0: false, target: OLD, now: () => T0, promoteBacklog: 0, log: () => {} })
    back.step()
    back.step()
    expect(buildingSpace(db())).toBeNull()
    expect(rowsOf(NEW.model)).toBe(0)
    expect(rowsOf(OLD.model)).toBe(1)
  })

  test('status counts the active and the building space', () => {
    const id = seed('a')
    seed('b')
    embed(id, OLD.model)
    startActive(db(), OLD, T0)
    const manager = createSpaceManager({ db: db(), vec0: false, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    manager.step()
    expect(manager.status()).toEqual({
      active: { model: 'old', dims: 2, indexed: 1, pending: 1, vecReady: false },
      building: { model: 'new', dims: 2, indexed: 0, pending: 2, vecReady: false },
    })
  })

  test('a store opened without sqlite-vec no longer trusts an index it cannot keep up', () => {
    const space = startActive(db(), NEW, T0)
    db().run(`UPDATE vector_spaces SET vec_ready = 1 WHERE id = ${space.id}`)
    createSpaceManager({ db: db(), vec0: false, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} }).step()
    expect(activeSpace(db())!.vecReady).toBe(false)
  })

  test('a switch is promoted once the backlog is under one batch, so a busy store still switches', () => {
    const ids = Array.from({ length: 80 }, (_, i) => seed(`o${i}`))
    for (const id of ids) embed(id, OLD.model)
    startActive(db(), OLD, T0)
    const manager = createSpaceManager({ db: db(), vec0: false, target: NEW, now: () => T0, log: () => {} })
    manager.step()
    for (const id of ids.slice(0, 40)) embed(id, NEW.model)
    manager.step()
    expect(manager.searchSpace()).toMatchObject(OLD)
    for (const id of ids.slice(40, 50)) embed(id, NEW.model)
    manager.step()
    expect(manager.searchSpace()).toMatchObject(NEW)
  })

  test('with no target nothing changes', () => {
    startActive(db(), OLD, T0)
    createSpaceManager({ db: db(), vec0: false, target: null, now: () => T0, promoteBacklog: 0, log: () => {} }).step()
    expect(activeSpace(db())).toMatchObject(OLD)
    expect(buildingSpace(db())).toBeNull()
  })
})

describe.skipIf(VEC0 === undefined || VEC0 === '')('with sqlite-vec', () => {
  beforeEach(() => db().loadExtension(VEC0!))

  test('the active space gets its vec0 index, filled in chunks, then marked ready', () => {
    const ids = [seed('a'), seed('b'), seed('c')]
    for (const id of ids) embed(id, NEW.model)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {}, reconcileChunk: 2 })
    manager.step()
    const space = activeSpace(db())!
    expect(vecIndexExists(db(), space)).toBe(true)
    expect(space.vecReady).toBe(false)
    manager.step()
    expect(activeSpace(db())!.vecReady).toBe(true)
    expect(knnCandidates(db(), space, Float32Array.from([1, 0]), null, 10).sort()).toEqual([...ids].sort())
  })

  test('rows the indexer writes go straight into the index', () => {
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    manager.step()
    const id = seed('a')
    embed(id, NEW.model)
    manager.written([{ id, vector: Float32Array.from([1, 0]) }])
    expect(knnCandidates(db(), activeSpace(db())!, Float32Array.from([1, 0]), PROJECT, 5)).toEqual([id])
  })

  test('a deleted vector (purge, redaction) marks its index not ready until reconcile has removed it', () => {
    const ids = [seed('a'), seed('b')]
    for (const id of ids) embed(id, NEW.model)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    manager.step()
    expect(activeSpace(db())!.vecReady).toBe(true)
    db().query('DELETE FROM observations WHERE id = ?').run(ids[0]!)
    expect(activeSpace(db())!.vecReady).toBe(false)
    manager.step()
    expect(activeSpace(db())!.vecReady).toBe(true)
    expect(knnCandidates(db(), activeSpace(db())!, Float32Array.from([1, 0]), null, 10)).toEqual([ids[1]!])
  })

  test('the building index must be complete before it switches', () => {
    const ids = [seed('a'), seed('b'), seed('c')]
    for (const id of ids) embed(id, OLD.model)
    startActive(db(), OLD, T0)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {}, reconcileChunk: 1 })
    manager.step()
    for (const id of ids) embed(id, NEW.model)
    manager.step()
    expect(manager.searchSpace()).toMatchObject(OLD)
    for (let i = 0; i < 4; i += 1) manager.step()
    expect(manager.searchSpace()).toMatchObject(NEW)
    expect(knnCandidates(db(), activeSpace(db())!, Float32Array.from([1, 0]), null, 10).sort()).toEqual([...ids].sort())
  })

  test('the sweep leaves the active and the building space alone', () => {
    const id = seed('a')
    embed(id, OLD.model)
    embed(id, NEW.model)
    embed(id, 'gone')
    startActive(db(), OLD, T0)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    seed('b')
    manager.step()
    expect([rowsOf(OLD.model), rowsOf(NEW.model), rowsOf('gone')]).toEqual([1, 1, 0])
  })

  test('a promoted switch drops the old space vec0 table', () => {
    const id = seed('a')
    embed(id, OLD.model)
    const old = startActive(db(), OLD, T0)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    manager.step()
    expect(vecIndexExists(db(), old)).toBe(true)
    embed(id, NEW.model)
    manager.step()
    manager.step()
    manager.step()
    expect(manager.searchSpace()).toMatchObject(NEW)
    expect(vecIndexExists(db(), old)).toBe(false)
  })

  test('a switch takes the old index away a vector chunk per step, never in one drop', () => {
    const ids = [seed('a'), seed('b')]
    for (const id of ids) embed(id, OLD.model)
    const old = startActive(db(), OLD, T0)
    createVecIndex(db(), old)
    // Two partitions, two vector chunks.
    upsertProject(db(), { key: 'other', kind: 'path', displayName: 'other' }, T0)
    db().query('UPDATE observations SET project_key = ? WHERE id = ?').run('other', ids[1]!)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    manager.step()
    for (const id of ids) embed(id, NEW.model)
    let steps = 0
    while (manager.searchSpace()?.model !== NEW.model && steps < 10) {
      manager.step()
      steps += 1
    }
    expect(manager.searchSpace()).toMatchObject(NEW)
    const chunks = (): number => (db().query(`SELECT count(*) AS n FROM vec_space_${old.id}_vector_chunks00`).get() as { n: number }).n
    // Each step takes at most one vector chunk; the table goes once none is left.
    expect(vecIndexExists(db(), old)).toBe(true)
    let before = chunks()
    for (let i = 0; i < 10 && vecIndexExists(db(), old); i += 1) {
      const more = manager.step()
      if (!vecIndexExists(db(), old)) break
      expect(more).toBe(true)
      expect(before - chunks()).toBeLessThanOrEqual(1)
      before = chunks()
    }
    expect(vecIndexExists(db(), old)).toBe(false)
    expect(manager.step()).toBe(false)
  })

  test('a pass that began on a ready index and saw a delete runs again before it is ready', () => {
    const ids = [seed('a'), seed('b'), seed('c')]
    for (const id of ids) embed(id, NEW.model)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {}, window: 1, reconcileChunk: 10 })
    for (let i = 0; i < 6 && activeSpace(db())?.vecReady !== true; i += 1) manager.step()
    expect(activeSpace(db())!.vecReady).toBe(true)
    // A new pass starts on the ready index; the first window passes ids[0], then it is deleted.
    manager.step()
    db().query('DELETE FROM observations WHERE id = ?').run(ids[0]!)
    expect(activeSpace(db())!.vecReady).toBe(false)
    for (let i = 0; i < 3; i += 1) manager.step()
    // That pass ended, but it began ready and lost it: not trusted.
    expect(activeSpace(db())!.vecReady).toBe(false)
    for (let i = 0; i < 4 && activeSpace(db())?.vecReady !== true; i += 1) manager.step()
    expect(activeSpace(db())!.vecReady).toBe(true)
    expect(knnCandidates(db(), activeSpace(db())!, Float32Array.from([1, 0]), null, 10).sort()).toEqual([ids[1]!, ids[2]!].sort())
  })

  test('a project merge behind a pass that began not ready makes the pass run again before the index is ready', () => {
    upsertProject(db(), { key: 'other', kind: 'path', displayName: 'other' }, T0)
    const ids = [seed('a'), seed('b'), seed('c'), seed('d')]
    for (const id of ids) embed(id, NEW.model)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {}, window: 1, reconcileChunk: 10 })
    manager.step()
    manager.step()
    expect(activeSpace(db())!.vecReady).toBe(false)
    // The first id is behind the pass now; the merge takes its index row out and files it under 'other'.
    mergeProjects(db(), PROJECT, 'other', T0, { dryRun: false })
    for (let i = 0; i < 20 && activeSpace(db())?.vecReady !== true; i += 1) manager.step()
    expect(activeSpace(db())!.vecReady).toBe(true)
    expect(knnCandidates(db(), activeSpace(db())!, Float32Array.from([1, 0]), 'other', 10).sort()).toEqual([...ids].sort())
  })

  test('each part of a step runs as a named step, so a slow one shows in the stall log by name', () => {
    const id = seed('a')
    embed(id, OLD.model)
    startActive(db(), OLD, T0)
    const labels: string[] = []
    const manager = createSpaceManager({
      db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {},
      step: (label, fn) => {
        labels.push(label)
        return fn()
      },
    })
    manager.step()
    expect(labels).toEqual(['reconcile old', 'reconcile new', 'promote', 'sweep', 'sweep rows'])
  })

  test('the sweep of a retired space puts secure_delete back on for everything else', () => {
    const id = seed('a')
    embed(id, OLD.model)
    startActive(db(), OLD, T0)
    const manager = createSpaceManager({ db: db(), vec0: true, target: NEW, now: () => T0, promoteBacklog: 0, log: () => {} })
    embed(id, NEW.model)
    for (let i = 0; i < 6; i += 1) manager.step()
    expect(rowsOf(OLD.model)).toBe(0)
    expect((db().query('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete).toBe(1)
  })
})

test('withFastDelete runs with secure_delete FAST and restores the mode it found, even when the work throws', () => {
  const mode = (): number => (db().query('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete
  expect(mode()).toBe(1)
  expect(withFastDelete(db(), mode)).toBe(2)
  expect(mode()).toBe(1)
  expect(() => withFastDelete(db(), () => {
    throw new Error('locked')
  })).toThrow('locked')
  expect(mode()).toBe(1)
})
