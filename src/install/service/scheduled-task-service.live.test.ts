// The real scheduled task on Windows. Runs only with KINFOLD_TEST_WINDOWS_TASK=1
// (the Windows smoke runner sets it). It registers KinfoldDaemon against a
// stand-in daemon that never answers /health, reads the task's state the way
// the CLI's children run (PATH and HOME only), times that read, and stops the
// task. It refuses to run where a KinfoldDaemon task already exists.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import type { InstallEnv } from '../env'
import { encodeText } from '../files'
import { createCommandRunner } from '../system'
import { windowsSystemTool } from '../windows-system-path'
import { ScheduledTaskService, TASK_NAME } from './scheduled-task-service'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_TASK === '1'
const PID_FILE = 'stand-in.pid'
const START_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 10_000
const POLL_MS = 250
const TIMED_READS = 3
const TEST_TIMEOUT_MS = 180_000

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

      const costs: number[] = []
      for (let read = 0; read < TIMED_READS; read += 1) {
        const startedAt = performance.now()
        expect(await service.isRunning()).toBe(true)
        costs.push(Math.round(performance.now() - startedAt))
      }
      report(`isRunning with PATH and HOME only took ${costs.join(', ')} ms (schtasks /Query plus the task-state query)`)

      const stopStartedAt = performance.now()
      await service.stop()
      report(`stop took ${Math.round(performance.now() - stopStartedAt)} ms`)
      expect(await service.isRegistered()).toBe(false)
      expect(await service.isRunning()).toBe(false)
      const exited = await waitUntil(() => pid === null || !pidAlive(pid), EXIT_TIMEOUT_MS)
      report(`ending the task ${exited ? 'ended' : 'did NOT end'} the daemon process it had started`)
    } finally {
      await run({ argv: [windowsSystemTool(env, 'System32\\schtasks.exe'), '/Delete', '/TN', TASK_NAME, '/F'], timeoutMs: 15_000 })
      if (pid !== null && pidAlive(pid)) process.kill(pid)
      rmSync(root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
