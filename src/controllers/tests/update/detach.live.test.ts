// The real service manager on each OS. Runs only with KINFOLD_TEST_DETACH=1
// (each smoke runner sets it). It proves the one thing the unit tests cannot:
// a child started the way the daemon starts its updater is still running
// after the service that started it has been stopped.
//
// The service is a probe with its own name, so it never touches a real
// Kinfold service, but its config is the production one: the plist, the unit
// and the task XML come from the same generators install uses, and it is
// stopped the way each ServiceControl stops the daemon. Its program is a
// stand-in that calls the production detachPlan and spawnDetached for a child
// that writes a heartbeat, and starts a second child the plain way, to show
// what the stop does to one that did not leave.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LAUNCH_AGENT_LABEL } from '../../../resources/install-plan/env'
import type { InstallMode } from '../../../resources/install-plan/entry'
import { encodeText } from '../../../resources/install-plan/files'
import { LAUNCHCTL, guiDomain, plistContent } from '../../install/launch-agent'
import { taskXml } from '../../install/service/scheduled-task-service'
import { SYSTEMCTL_CANDIDATES, unitContent } from '../../install/service/systemd-service'
import { windowsSystemTool } from '../../install/windows-system-path'
import { type OsName, currentPlatform } from '../../../system/platform/platform'

const OS = currentPlatform().os
const LIVE = process.env.KINFOLD_TEST_DETACH === '1'
const PROBE_LABEL = 'dev.kinfold.detach-probe'
const PROBE_UNIT = 'kinfold-detach-probe.service'
const PROBE_TASK = 'KinfoldDetachProbe'
const PORT = 37_811
const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 30_000
/** How long the detached child is watched after the stop; its heartbeat is every 200 ms. */
const WATCH_MS = 5_000
const POLL_MS = 250
const TEST_TIMEOUT_MS = 240_000
const EXPECTED_VIA: Readonly<Record<OsName, string>> = { macos: 'process-group', linux: 'systemd-run', windows: 'process-group' }

const moduleUrl = (file: string): string => pathToFileURL(join(import.meta.dir, file)).href

/** Stands where the daemon does: starts the two children, then idles as a daemon would. */
const STAND_IN = [
  "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  `import { detachPlan, spawnDetached } from ${JSON.stringify(moduleUrl('../../update/detach.ts'))}`,
  `import { currentPlatform } from ${JSON.stringify(moduleUrl('../../../system/platform/platform.ts'))}`,
  "const flag = process.argv.indexOf('--data-dir')",
  "const dataDir = (flag >= 0 ? process.argv[flag + 1] : process.env.KINFOLD_DATA_DIR) ?? ''",
  'mkdirSync(dataDir, { recursive: true })',
  "const trace = (step) => appendFileSync(join(dataDir, 'trace.txt'), step + '\\n')",
  "process.on('uncaughtException', (error) => trace('error: ' + (error instanceof Error ? error.name + ' ' + error.message : String(error))))",
  "trace('stand-in started')",
  "const child = join(dataDir, 'child.ts')",
  "const plan = detachPlan({ os: currentPlatform().os, program: process.execPath, args: [child, dataDir, 'detached'], envVars: process.env })",
  'if (!plan.ok) {',
  "  writeFileSync(join(dataDir, 'plan-error.txt'), plan.reason)",
  '  process.exit(1)',
  '}',
  "writeFileSync(join(dataDir, 'via.txt'), plan.via)",
  "trace('plan: ' + plan.argv.join(' '))",
  "trace('detached child started, pid ' + spawnDetached(plan.argv, process.env))",
  "Bun.spawn([process.execPath, child, dataDir, 'plain'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })",
  "trace('plain child started')",
  "writeFileSync(join(dataDir, 'service.pid'), String(process.pid))",
  'setInterval(() => undefined, 1_000)',
  'setTimeout(() => process.exit(0), 200_000)',
  '',
].join('\n')

const CHILD = [
  "import { writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "const dir = process.argv[2] ?? ''",
  "const name = process.argv[3] ?? 'child'",
  'writeFileSync(join(dir, `${name}.pid`), String(process.pid))',
  'let beats = 0',
  'setInterval(() => {',
  '  beats += 1',
  '  writeFileSync(join(dir, `${name}.beat`), String(beats))',
  '}, 200)',
  'setTimeout(() => process.exit(0), 180_000)',
  '',
].join('\n')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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

function run(argv: string[]): number {
  return Bun.spawnSync(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env } as Record<string, string> }).exitCode
}

function report(line: string): void {
  process.stdout.write(`detached updater (live, ${OS}): ${line}\n`)
}

interface Probe {
  start(): void
  /** The steps the platform's ServiceControl.stop() takes for the daemon. */
  stop(servicePid: number): Promise<void>
  /** Removes the probe service whatever state the test left it in. */
  remove(): void
}

function launchAgentProbe(root: string, mode: InstallMode, dataDir: string): Probe {
  const uid = process.getuid?.() ?? -1
  const target = `${guiDomain(uid)}/${PROBE_LABEL}`
  const plist = join(root, 'probe.plist')
  return {
    start() {
      const content = plistContent({ mode, pathEnv: process.env.PATH ?? '', homeDir: root, dataDir }, PORT).replaceAll(LAUNCH_AGENT_LABEL, PROBE_LABEL)
      expect(content).toContain(PROBE_LABEL)
      writeFileSync(plist, content)
      expect(run([LAUNCHCTL, 'bootstrap', guiDomain(uid), plist])).toBe(0)
    },
    async stop() {
      run([LAUNCHCTL, 'bootout', target])
      expect(await waitUntil(() => run([LAUNCHCTL, 'print', target]) !== 0, STOP_TIMEOUT_MS)).toBe(true)
    },
    remove() {
      run([LAUNCHCTL, 'bootout', target])
    },
  }
}

function systemdProbe(root: string, mode: InstallMode, dataDir: string): Probe {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? ''
  const systemctl = SYSTEMCTL_CANDIDATES.find((path) => existsSync(path)) ?? 'systemctl'
  // The runtime unit folder is on the user manager's search path and is gone at logout, so nothing is left in ~/.config.
  const unitDir = join(runtimeDir, 'systemd', 'user')
  const unitPath = join(unitDir, PROBE_UNIT)
  const state = (): string => new TextDecoder().decode(Bun.spawnSync([systemctl, '--user', 'is-active', PROBE_UNIT], { env: { ...process.env } as Record<string, string> }).stdout).trim()
  return {
    start() {
      expect(runtimeDir).not.toBe('')
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(unitPath, unitContent({ mode, pathEnv: process.env.PATH ?? '', homeDir: root, dataDir, envVars: process.env }, PORT))
      expect(run([systemctl, '--user', 'daemon-reload'])).toBe(0)
      expect(run([systemctl, '--user', 'start', PROBE_UNIT])).toBe(0)
    },
    async stop() {
      // disable --now is a stop plus a disable; the probe was never enabled, so the stop is the whole of it.
      run([systemctl, '--user', 'stop', PROBE_UNIT])
      expect(await waitUntil(() => ['inactive', 'failed'].includes(state()), STOP_TIMEOUT_MS)).toBe(true)
    },
    remove() {
      run([systemctl, '--user', 'stop', PROBE_UNIT])
      rmSync(unitPath, { force: true })
      run([systemctl, '--user', 'daemon-reload'])
      run([systemctl, '--user', 'reset-failed', PROBE_UNIT])
    },
  }
}

function scheduledTaskProbe(root: string, mode: InstallMode, dataDir: string): Probe {
  const schtasks = windowsSystemTool({ envVars: process.env }, 'System32\\schtasks.exe')
  const xmlPath = join(root, 'probe-task.xml')
  return {
    start() {
      if (mode.kind !== 'checkout') throw new Error('the probe runs a script under bun')
      const name = process.env.USERNAME ?? ''
      const domain = process.env.USERDOMAIN ?? ''
      const xml = taskXml({ user: domain === '' ? name : `${domain}\\${name}`, program: mode.bunPath, script: join(mode.projectRoot, 'src', 'controllers', 'cli', 'kinfold.ts'), dataDir, port: PORT, logFile: join(dataDir, 'logs', 'daemon.log') })
      writeFileSync(xmlPath, encodeText(xml, 'utf16le'))
      expect(run([schtasks, '/Create', '/TN', PROBE_TASK, '/XML', xmlPath, '/F'])).toBe(0)
      expect(run([schtasks, '/Run', '/TN', PROBE_TASK])).toBe(0)
    },
    async stop(servicePid) {
      // As ScheduledTaskService.stop: end the task, give the daemon a moment to go, kill it by pid, delete the task.
      run([schtasks, '/End', '/TN', PROBE_TASK])
      const left = await waitUntil(() => !pidAlive(servicePid), 3_000)
      report(`ending the task ${left ? 'ended' : 'did not end'} the stand-in daemon`)
      if (!left) process.kill(servicePid)
      expect(run([schtasks, '/Delete', '/TN', PROBE_TASK, '/F'])).toBe(0)
    },
    remove() {
      run([schtasks, '/Delete', '/TN', PROBE_TASK, '/F'])
    },
  }
}

const readNumber = (path: string): number => Number(readFileSync(path, 'utf8').trim())


describe.skipIf(!LIVE)('detached updater (live)', () => {
  test('a child started the way the updater is started outlives the stop of its service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kinfold-detach-live-'))
    const projectRoot = join(root, 'checkout')
    const dataDir = join(root, 'data')
    const mode: InstallMode = { kind: 'checkout', bunPath: process.execPath, projectRoot }
    const probe = OS === 'macos' ? launchAgentProbe(root, mode, dataDir) : OS === 'linux' ? systemdProbe(root, mode, dataDir) : scheduledTaskProbe(root, mode, dataDir)
    const file = (name: string): string => join(dataDir, name)
    const pids: number[] = []
    try {
      // The plist and the unit run src/controllers/daemon/main.ts; the task runs src/controllers/cli/kinfold.ts.
      for (const script of [join('src', 'controllers', 'daemon', 'main.ts'), join('src', 'controllers', 'cli', 'kinfold.ts')]) {
        mkdirSync(join(projectRoot, script, '..'), { recursive: true })
        writeFileSync(join(projectRoot, script), STAND_IN)
      }
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
      writeFileSync(file('child.ts'), CHILD)
      probe.remove()

      probe.start()
      const started = await waitUntil(() => existsSync(file('plan-error.txt')) || ['service.pid', 'detached.pid', 'detached.beat', 'plain.pid'].every((name) => existsSync(file(name))), START_TIMEOUT_MS)
      if (existsSync(file('plan-error.txt'))) throw new Error(`no detach plan here: ${readFileSync(file('plan-error.txt'), 'utf8')}`)
      if (!started) {
        // What the stand-in got through, so a failed start names its step.
        const trace = existsSync(file('trace.txt')) ? readFileSync(file('trace.txt'), 'utf8').trim().replaceAll('\n', ' | ') : 'the stand-in never ran'
        const present = ['service.pid', 'detached.pid', 'detached.beat', 'plain.pid'].filter((name) => existsSync(file(name))).join(', ')
        throw new Error(`the probe service did not report both children within ${START_TIMEOUT_MS} ms; files: ${present === '' ? 'none' : present}; trace: ${trace}`)
      }
      const servicePid = readNumber(file('service.pid'))
      const detachedPid = readNumber(file('detached.pid'))
      const plainPid = readNumber(file('plain.pid'))
      pids.push(servicePid, detachedPid, plainPid)
      expect(readFileSync(file('via.txt'), 'utf8')).toBe(EXPECTED_VIA[OS])
      expect(pidAlive(servicePid)).toBe(true)
      expect(pidAlive(detachedPid)).toBe(true)
      report(`service pid ${servicePid} started a detached child ${detachedPid} via ${EXPECTED_VIA[OS]} and a plain child ${plainPid}`)

      await probe.stop(servicePid)
      expect(await waitUntil(() => !pidAlive(servicePid), STOP_TIMEOUT_MS)).toBe(true)

      const beatsAtStop = readNumber(file('detached.beat'))
      await Bun.sleep(WATCH_MS)
      const beatsLater = readNumber(file('detached.beat'))
      expect(pidAlive(detachedPid)).toBe(true)
      expect(beatsLater).toBeGreaterThan(beatsAtStop + 10)
      const plainAlive = pidAlive(plainPid)
      report(`after the stop the detached child is alive (${beatsAtStop} -> ${beatsLater} heartbeats in ${WATCH_MS} ms); the plain child is ${plainAlive ? 'alive' : 'gone'}`)
      // launchd ends the job's process group, systemd the unit's cgroup, and on Windows the plain child dies
      // with the daemon: on each OS the plain child is the proof that leaving was needed.
      expect(plainAlive).toBe(false)
    } finally {
      probe.remove()
      for (const pid of pids) {
        if (!pidAlive(pid)) continue
        try {
          process.kill(pid)
        } catch {
          // It exited between the check and the kill.
        }
      }
      await Bun.sleep(500)
      rmSync(root, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
