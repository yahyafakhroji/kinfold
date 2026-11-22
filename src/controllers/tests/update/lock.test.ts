import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCK_MAX_AGE_MS, TAKEOVER_CLAIM_FILE, TAKEOVER_CLAIM_MAX_AGE_MS, UPDATE_LOCK_FILE, acquireUpdateLock, updateLockHolder } from '../../update/lock'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-update-lock-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const alive = (...pids: number[]) => (pid: number): boolean => pids.includes(pid)

test('the first run takes the lock and a second run is refused while the first lives', () => {
  const first = acquireUpdateLock(dir, { pid: 100, alive: alive(100) })
  expect(first).not.toBeNull()
  expect(updateLockHolder(dir, alive(100))).toBe(100)
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(100, 200) })).toBeNull()
  first?.release()
  expect(existsSync(join(dir, UPDATE_LOCK_FILE))).toBe(false)
  expect(updateLockHolder(dir, alive(100))).toBeNull()
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(200) })).not.toBeNull()
})

test('a lock left by a run that was killed is taken over', () => {
  expect(acquireUpdateLock(dir, { pid: 100, alive: alive(100) })).not.toBeNull()
  expect(updateLockHolder(dir, alive())).toBeNull()
  const next = acquireUpdateLock(dir, { pid: 200, alive: alive(200) })
  expect(next).not.toBeNull()
  expect(updateLockHolder(dir, alive(200))).toBe(200)
})

test('an empty or unreadable lock file never blocks an update', () => {
  for (const text of ['', 'not a pid', '-4', '0']) {
    writeFileSync(join(dir, UPDATE_LOCK_FILE), text)
    expect(updateLockHolder(dir, alive(100))).toBeNull()
    const lock = acquireUpdateLock(dir, { pid: 100, alive: alive(100) })
    expect(lock).not.toBeNull()
    lock?.release()
  }
})

test('release leaves a lock that another run has since taken over', () => {
  const first = acquireUpdateLock(dir, { pid: 100, alive: alive(100) })
  // The first run looked dead to the second (its pid was reused and freed), which took the lock over.
  const second = acquireUpdateLock(dir, { pid: 200, alive: alive(200) })
  expect(second).not.toBeNull()
  first?.release()
  expect(updateLockHolder(dir, alive(200))).toBe(200)
})

test('taking the lock leaves no temp file behind', () => {
  acquireUpdateLock(dir, { pid: 100, alive: alive(100) })?.release()
  expect(acquireUpdateLock(dir, { pid: 100, alive: alive(100) })).not.toBeNull()
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(100, 200) })).toBeNull()
  expect(readdirSync(dir)).toEqual([UPDATE_LOCK_FILE])
})

test('the default liveness check knows this process is alive', () => {
  const lock = acquireUpdateLock(dir)
  expect(lock).not.toBeNull()
  expect(updateLockHolder(dir)).toBe(process.pid)
})

test('a lock older than an hour is taken over even though its pid is alive', () => {
  // After a power loss the pid in the file can belong to some unrelated process.
  const T = 1_792_900_000_000
  expect(acquireUpdateLock(dir, { pid: 100, alive: alive(100), now: () => T })).not.toBeNull()
  expect(updateLockHolder(dir, alive(100), T + LOCK_MAX_AGE_MS - 1)).toBe(100)
  expect(updateLockHolder(dir, alive(100), T + LOCK_MAX_AGE_MS + 1)).toBeNull()
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(100, 200), now: () => T + LOCK_MAX_AGE_MS + 1 })).not.toBeNull()
  expect(updateLockHolder(dir, alive(100, 200), T + LOCK_MAX_AGE_MS + 2)).toBe(200)
  expect(LOCK_MAX_AGE_MS).toBe(3_600_000)
})

test('a pid with no start time beside it never blocks an update', () => {
  writeFileSync(join(dir, UPDATE_LOCK_FILE), '100\n')
  expect(updateLockHolder(dir, alive(100))).toBeNull()
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(100, 200) })).not.toBeNull()
})

test('a folder that cannot hold a hard link still gets an exclusive lock', () => {
  const link = (): void => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  }
  const first = acquireUpdateLock(dir, { pid: 100, alive: alive(100), link })
  expect(first).not.toBeNull()
  expect(updateLockHolder(dir, alive(100))).toBe(100)
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(100, 200), link })).toBeNull()
  first?.release()
  expect(readdirSync(dir)).toEqual([])
})

// ---- taking over a dead lock is one run's to do ----

const T = 1_792_900_000_000
const deadLock = (): void => writeFileSync(join(dir, UPDATE_LOCK_FILE), `100\n${T}\n`)

test('while one run is taking a dead lock over, another leaves it alone', () => {
  deadLock()
  writeFileSync(join(dir, TAKEOVER_CLAIM_FILE), `300\n${T + 10}\n`)
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(200, 300), now: () => T + 20 })).toBeNull()
  expect(readdirSync(dir).sort()).toEqual([UPDATE_LOCK_FILE, TAKEOVER_CLAIM_FILE].sort())
})

test('a takeover that died half way holds nothing back for long', () => {
  deadLock()
  writeFileSync(join(dir, TAKEOVER_CLAIM_FILE), `300\n${T}\n`)
  const later = T + TAKEOVER_CLAIM_MAX_AGE_MS + 1
  // The stale claim is cleared, and this call still steps back: two runs that both cleared it must not both go on.
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(200), now: () => later })).toBeNull()
  expect(acquireUpdateLock(dir, { pid: 200, alive: alive(200), now: () => later })).not.toBeNull()
  expect(readdirSync(dir)).toEqual([UPDATE_LOCK_FILE])
  expect(TAKEOVER_CLAIM_MAX_AGE_MS).toBe(30_000)
})

test('of many runs racing for one dead lock, exactly one wins', async () => {
  // A pid no system hands out, so the lock is dead to the real liveness check.
  writeFileSync(join(dir, UPDATE_LOCK_FILE), `4194000\n${Date.now()}\n`)
  const script = join(dir, 'race.ts')
  writeFileSync(script, [
    `import { acquireUpdateLock } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, '../../update/lock.ts')).href)}`,
    'const lock = acquireUpdateLock(process.argv[2] ?? "")',
    'process.stdout.write(lock === null ? "lost" : "won")',
    // The winner stays alive while the others look, as a real update would.
    'if (lock !== null) await Bun.sleep(1500)',
    '',
  ].join('\n'))
  const runs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, script, dir], { stdout: 'pipe', stderr: 'inherit' }))
  const results = await Promise.all(runs.map(async (run) => {
    const text = await new Response(run.stdout).text()
    await run.exited
    return text
  }))
  expect(results.filter((result) => result === 'won')).toHaveLength(1)
  expect(results.filter((result) => result === 'lost')).toHaveLength(7)
}, 30_000)
