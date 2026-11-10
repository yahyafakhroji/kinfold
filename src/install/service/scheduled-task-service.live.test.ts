// The real scheduled task on Windows. Runs only with KINFOLD_TEST_WINDOWS_TASK=1
// (the Windows smoke runner sets it). It registers KinfoldDaemon against a
// stand-in daemon that never answers /health, reads the task's state the way
// the CLI's children run (PATH and HOME only), times that read, ends the task
// and stops it. It refuses to run where a KinfoldDaemon task already exists.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import type { InstallEnv } from '../env'
import { encodeText } from '../files'
import { createCommandRunner } from '../system'
import { windowsSystemTool } from '../windows-system-path'
import { WINDOWS_QUERY_TIMEOUT_MS, powershellArgv } from '../access/windows-acl'
import { ScheduledTaskService, TASK_NAME, taskStateOf, taskStateScript } from './scheduled-task-service'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_TASK === '1'
const PID_FILE = 'stand-in.pid'
const START_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 10_000
const POLL_MS = 250
const TIMED_READS = 3
const TEST_TIMEOUT_MS = 180_000
/** Task Scheduler's TASK_STATE numbers. */
const READY = 3
const RUNNING = 4

/** What the CLI hands its children (src/cli/kinfold.ts): PATH and HOME, nothing else. */
function cliChildEnv(home: string): Record<string, string> {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  return { PATH: process.env[pathKey] ?? '', HOME: home }
}

/** Stands where the checkout's CLI does: writes its pid into the data folder it is given, then idles and answers nothing. */
const STAND_IN_DAEMON = [
  "import { mkdirSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "const dataDir = process.argv[process.argv.indexOf('--data-dir') + 1] ?? ''",
  'mkdirSync(dataDir, { recursive: true })',
  `writeFileSync(join(dataDir, ${JSON.stringify(PID_FILE)}), String(process.pid))`,
  'setTimeout(() => process.exit(0), 150_000)',
  '',
].join('\n')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(POLL_MS)
  }
  return true
}

function report(line: string): void {
  process.stdout.write(`scheduled task (live): ${line}\n`)
}

describe.skipIf(!LIVE)('scheduled task (live)', () => {
  test('a task whose daemon answers nothing reads as running, and stop removes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kinfold-task-live-'))
    const projectRoot = join(root, 'checkout')
    const dataDir = join(root, 'data')
    const run = createCommandRunner(cliChildEnv(root))
    const env = {
      homeDir: root,
      dataDir,
      envVars: { ...process.env, LOCALAPPDATA: join(root, 'LocalAppData') },
      mode: { kind: 'checkout', bunPath: process.execPath, projectRoot },
      run,
      sleep: (ms: number) => Bun.sleep(ms),
      now: () => Date.now(),
      fetch: async () => {
        throw new TypeError('nothing answers /health (live test)')
      },
    } as unknown as InstallEnv
    const service = new ScheduledTaskService(env)
    expect(await service.isRegistered()).toBe(false)
    let pid: number | null = null
    try {
      mkdirSync(join(projectRoot, 'src', 'cli'), { recursive: true })
      writeFileSync(join(projectRoot, 'src', 'cli', 'kinfold.ts'), STAND_IN_DAEMON)
      const path = service.configPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, encodeText(service.configContent(37811) ?? '', 'utf16le'))

      await service.start()
      const pidFile = join(dataDir, PID_FILE)
      expect(await waitUntil(() => existsSync(pidFile), START_TIMEOUT_MS)).toBe(true)
      pid = Number(readFileSync(pidFile, 'utf8'))
      expect(pidAlive(pid)).toBe(true)

      const schtasks = windowsSystemTool(env, 'System32\\schtasks.exe')
      const readState = async (): Promise<{ state: number | null; ms: number }> => {
        const startedAt = performance.now()
        const result = await run({ argv: powershellArgv(env, taskStateScript()), timeoutMs: WINDOWS_QUERY_TIMEOUT_MS })
        return { state: taskStateOf(result), ms: Math.round(performance.now() - startedAt) }
      }
      const costs: number[] = []
      for (let read = 0; read < TIMED_READS; read += 1) {
        const { state, ms } = await readState()
        expect(state).toBe(RUNNING)
        expect(ms).toBeLessThan(WINDOWS_QUERY_TIMEOUT_MS)
        costs.push(ms)
      }
      report(`the task-state query with PATH and HOME only took ${costs.join(', ')} ms`)
      const startedAt = performance.now()
      expect(await service.isRunning()).toBe(true)
      report(`isRunning (schtasks /Query plus the state query) took ${Math.round(performance.now() - startedAt)} ms`)

      // An ended task stays registered and reads as stopped.
      await run({ argv: [schtasks, '/End', '/TN', TASK_NAME], timeoutMs: 15_000 })
      await Bun.sleep(1_000)
      expect((await readState()).state).toBe(READY)
      expect(await service.isRegistered()).toBe(true)
      expect(await service.isRunning()).toBe(false)
      const exited = await waitUntil(() => pid === null || !pidAlive(pid), EXIT_TIMEOUT_MS)
      report(`ending the task ${exited ? 'ended' : 'did NOT end'} the daemon process it had started`)

      const stopStartedAt = performance.now()
      await service.stop()
      report(`stop of the ended task took ${Math.round(performance.now() - stopStartedAt)} ms`)
      expect(await service.isRegistered()).toBe(false)
      expect(await service.isRunning()).toBe(false)
    } finally {
      await run({ argv: [windowsSystemTool(env, 'System32\\schtasks.exe'), '/Delete', '/TN', TASK_NAME, '/F'], timeoutMs: 15_000 })
      // The daemon itself would be killed by pid after answering /health; the stand-in never answers.
      if (pid !== null && pidAlive(pid)) process.kill(pid)
      rmSync(root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
