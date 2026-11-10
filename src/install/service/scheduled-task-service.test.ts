import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DAEMON_INFO_FILE } from '../../store/data-dir'
import type { CommandRequest, InstallEnv } from '../env'
import { EXIT_OK, install } from '../install'
import { HEALTH_WAIT_MS } from '../plan'
import { status } from '../status'
import { BUN, type FakeWorld, YES, createWorld } from '../test-support'
import {
  STOP_POLL_MS, ScheduledTaskService, TASK_CONFIG_FILE, TASK_NAME, type TaskProcessDeps,
  splitWindowsArgs, taskConfigPath, taskDataDir, taskPort, taskXml, windowsArg,
} from './scheduled-task-service'

const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe'
const USER_VARS = { USERDOMAIN: 'HOST', USERNAME: 'me' }
const AWKWARD = 'C:\\Users\\José Ä & Co\\.kinfold'
const PROGRAM = 'C:\\Users\\me\\.kinfold\\bin\\kinfold.exe'
const PID = 4242

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

type Verb = 'Create' | 'Run' | 'Query' | 'End' | 'Delete'

/** A runner that records every argv and answers each schtasks verb with the exit code given, else 0. */
function schtasksRunner(exits: Partial<Record<Verb, number>> = {}): { argvs: string[][]; run: InstallEnv['run'] } {
  const argvs: string[][] = []
  const run = async (request: CommandRequest) => {
    argvs.push([...request.argv])
    const verb = (request.argv[1] ?? '').slice(1) as Verb
    return { exitCode: request.argv[0]?.endsWith('\\System32\\schtasks.exe') === true ? exits[verb] ?? 0 : 127, stdout: '' }
  }
  return { argvs, run }
}

/** Pid deps on a fake clock: the pid is alive until `diesAt` ms, and each kill is recorded. */
function clockedPid(diesAt: number): { deps: TaskProcessDeps; kills: number[]; sleep: InstallEnv['sleep'] } {
  let clock = 0
  const kills: number[] = []
  return {
    kills,
    sleep: async (ms) => void (clock += ms),
    deps: { pidAlive: () => clock < diesAt, kill: (pid) => void kills.push(pid) },
  }
}

/** /health as the daemon answers it, naming `pid`; null: nothing listens on the port. */
function healthFetch(pid: number | null): InstallEnv['fetch'] {
  return async () => {
    if (pid === null) throw new TypeError('connection refused (test)')
    return new Response(JSON.stringify({ ok: true, version: '0.0.1', schemaVersion: 1, pid }))
  }
}

function windowsWorld(vars: Record<string, string> = USER_VARS): FakeWorld {
  world = createWorld({ platform: 'win32', keychainRefs: [] })
  world.env = { ...world.env, envVars: { ...vars, LOCALAPPDATA: join(world.root, 'LocalAppData') } }
  return world
}

function writeDaemonInfo(dataDir: string, pid: number): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, DAEMON_INFO_FILE), JSON.stringify({ pid, port: 37811 }))
}

const planLines = (w: FakeWorld): string[] => w.out.filter((line) => /^ {2}\d+\. /.test(line)).map((line) => line.replace(/^ {2}\d+\. /, ''))

test('the task runs at logon for this user without admin', () => {
  const xml = taskXml({ user: 'HOST\\me', program: PROGRAM, dataDir: 'C:\\Users\\me\\.kinfold', port: 37811, logFile: 'C:\\Users\\me\\.kinfold\\logs\\daemon.log' })
  expect(xml.startsWith('\uFEFF<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
  expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
  expect(xml).toMatch(/<LogonTrigger>[\s\S]*<UserId>HOST\\me<\/UserId>[\s\S]*<\/LogonTrigger>/)
  expect(xml).toMatch(/<Principal id="Author">[\s\S]*<UserId>HOST\\me<\/UserId>/)
  expect(xml).toContain('conhost.exe')
  expect(xml).toContain('--headless')
  expect(xml).toContain(' daemon ')
  for (const absent of ['HighestAvailable', 'Password', 'S4U']) expect(xml).not.toContain(absent)

  const w = windowsWorld()
  const service = new ScheduledTaskService(w.env)
  expect(service.label).toBe('scheduled task')
  expect(service.unavailableReason()).toBeNull()
  expect(service.configContent(37811)).toContain('<UserId>HOST\\me</UserId>')
  expect(taskConfigPath(w.env)).toBe(`${join(w.root, 'LocalAppData')}\\Kinfold\\${TASK_CONFIG_FILE}`)
  expect(taskConfigPath({ homeDir: 'C:\\Users\\me', envVars: {} })).toBe('C:\\Users\\me\\AppData\\Local\\Kinfold\\kinfold-daemon.xml')
})

test('an awkward data folder round-trips', () => {
  const xml = taskXml({ user: 'HOST\\me', program: PROGRAM, dataDir: AWKWARD, port: 40000, logFile: `${AWKWARD}\\logs\\daemon.log` })
  expect(taskDataDir(xml)).toBe(AWKWARD)
  expect(taskPort(xml)).toBe(40000)
  expect(xml).toContain('&amp;')
  expect(xml.replaceAll(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&')
  // Read back the way WSL reads it, from a file on /mnt/c that keeps its BOM.
  expect(taskDataDir(Buffer.from(xml, 'utf8').toString('utf8'))).toBe(AWKWARD)
  for (const value of ['C:\\a b\\', 'C:\\a"b', '', 'plain', 'C:\\x\\\\"y z']) {
    expect(splitWindowsArgs(windowsArg(value))).toEqual([value])
  }
})

test('the default port writes no --port', () => {
  const xml = taskXml({ user: 'HOST\\me', program: PROGRAM, dataDir: 'C:\\k', port: 37811, logFile: 'C:\\k\\logs\\daemon.log' })
  expect(xml).not.toContain('--port')
  expect(taskPort(xml)).toBeNull()
  expect(taskDataDir(xml)).toBe('C:\\k')
})

test('start registers then runs', async () => {
  const w = windowsWorld()
  const ok = schtasksRunner()
  const service = new ScheduledTaskService({ ...w.env, run: ok.run })
  await service.start()
  const path = taskConfigPath(w.env)
  expect(ok.argvs).toEqual([[SCHTASKS, '/Create', '/TN', TASK_NAME, '/XML', path, '/F'], [SCHTASKS, '/Run', '/TN', 'KinfoldDaemon']])
  expect(service.describe('start')).toBe(`schtasks /Create /TN KinfoldDaemon /XML ${path} /F, then schtasks /Run /TN KinfoldDaemon`)

  const failing = schtasksRunner({ Create: 1 })
  await expect(new ScheduledTaskService({ ...w.env, run: failing.run }).start()).rejects.toThrow('scheduled task: schtasks /Create failed (exit 1)')
  expect(failing.argvs.map((argv) => argv[1])).toEqual(['/Create'])

  const notRun = schtasksRunner({ Run: 2 })
  await expect(new ScheduledTaskService({ ...w.env, run: notRun.run }).start()).rejects.toThrow('scheduled task: schtasks /Run failed (exit 2)')

  const elsewhere = schtasksRunner()
  await new ScheduledTaskService({ ...w.env, run: elsewhere.run, envVars: { ...USER_VARS, SystemRoot: 'D:\\Win' } }).start()
  expect(elsewhere.argvs[0]?.[0]).toBe('D:\\Win\\System32\\schtasks.exe')
})

test('no USERNAME means a manual start, not a broken task', async () => {
  const w = windowsWorld({ USERDOMAIN: 'HOST' })
  const service = new ScheduledTaskService(w.env)
  expect(service.unavailableReason()).toBe('USERNAME is not set, so the task cannot name its user')
  expect(service.configContent(37811)).toBeNull()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const plan = planLines(w)
  expect(plan.some((line) => line.includes('schtasks'))).toBe(false)
  expect(plan.some((line) => line.includes('GET /health'))).toBe(false)
  expect(plan.some((line) => line.includes(TASK_CONFIG_FILE))).toBe(false)
  const entry = `${BUN} ${join(w.projectRoot, 'src/daemon/main.ts')}`
  expect(w.out).toContain(`scheduled task: USERNAME is not set, so the task cannot name its user; start the daemon yourself with: ${entry}`)
  expect(w.commands.some((c) => c.argv[0] === SCHTASKS && c.argv[1] !== '/Query')).toBe(false)
})

test('stop waits for the daemon and kills only a pid that stays', async () => {
  const w = windowsWorld()
  writeDaemonInfo(w.dataDir, PID)
  const ours = { ...w.env, fetch: healthFetch(PID) }

  const dies = clockedPid(1_000)
  const quick = schtasksRunner()
  await new ScheduledTaskService({ ...ours, run: quick.run, sleep: dies.sleep }, dies.deps).stop()
  expect(dies.kills).toEqual([])
  expect(quick.argvs.map((argv) => argv[1])).toEqual(['/Query', '/End', '/Delete'])
  expect(quick.argvs[2]).toEqual([SCHTASKS, '/Delete', '/TN', TASK_NAME, '/F'])

  const stays = clockedPid(Number.POSITIVE_INFINITY)
  const slow = schtasksRunner({ End: 1 })
  let slept = 0
  const sleep = async (ms: number) => (slept += ms, stays.sleep(ms))
  await new ScheduledTaskService({ ...ours, run: slow.run, sleep }, stays.deps).stop()
  expect(stays.kills).toEqual([PID])
  expect(slept).toBeGreaterThanOrEqual(HEALTH_WAIT_MS - STOP_POLL_MS)
  expect(slept).toBeLessThanOrEqual(HEALTH_WAIT_MS)
  expect(slow.argvs.map((argv) => argv[1])).toEqual(['/Query', '/End', '/Delete'])

  const unknown = schtasksRunner({ Query: 1 })
  await new ScheduledTaskService({ ...ours, run: unknown.run }, clockedPid(0).deps).stop()
  expect(unknown.argvs.map((argv) => argv[1])).toEqual(['/Query'])
  expect(new ScheduledTaskService(w.env).describe('stop')).toBe('schtasks /End /TN KinfoldDaemon, wait for the daemon to exit, then schtasks /Delete /TN KinfoldDaemon /F')
})

test('a stale daemon.json pid that another process now holds is never waited on or killed', async () => {
  const w = windowsWorld()
  writeDaemonInfo(w.dataDir, PID)
  // The pid stays alive throughout: Windows gave it to some other process.
  for (const fetch of [healthFetch(null), healthFetch(PID + 1)]) {
    const reused = clockedPid(Number.POSITIVE_INFINITY)
    let slept = 0
    const sleep = async (ms: number) => (slept += ms, reused.sleep(ms))
    const run = schtasksRunner()
    const service = new ScheduledTaskService({ ...w.env, fetch, run: run.run, sleep }, reused.deps)
    expect(await service.isRunning()).toBe(false)
    await service.stop()
    expect(reused.kills).toEqual([])
    expect(slept).toBe(0)
    expect(run.argvs.map((argv) => argv[1])).toEqual(['/Query', '/Query', '/End', '/Delete'])
  }
})

test('running means registered, alive and answering /health with that pid', async () => {
  const w = windowsWorld()
  writeDaemonInfo(w.dataDir, PID)
  const alive: TaskProcessDeps = { pidAlive: (pid) => pid === PID, kill: () => {} }
  const dead: TaskProcessDeps = { pidAlive: () => false, kill: () => {} }
  const ours = { ...w.env, fetch: healthFetch(PID) }
  expect(await new ScheduledTaskService({ ...ours, run: schtasksRunner().run }, alive).isRunning()).toBe(true)
  expect(await new ScheduledTaskService({ ...ours, run: schtasksRunner().run }, dead).isRunning()).toBe(false)
  expect(await new ScheduledTaskService({ ...ours, run: schtasksRunner({ Query: 1 }).run }, alive).isRunning()).toBe(false)
  expect(await new ScheduledTaskService({ ...w.env, fetch: healthFetch(null), run: schtasksRunner().run }, alive).isRunning()).toBe(false)
  expect(await new ScheduledTaskService({ ...w.env, fetch: healthFetch(PID + 1), run: schtasksRunner().run }, alive).isRunning()).toBe(false)
})

test('an unset USERDOMAIN names the user by USERNAME alone', () => {
  const w = windowsWorld({ USERNAME: 'me' })
  const service = new ScheduledTaskService(w.env)
  expect(service.unavailableReason()).toBeNull()
  const xml = service.configContent(37811) ?? ''
  expect(xml.match(/<UserId>[^<]*<\/UserId>/g)).toEqual(['<UserId>me</UserId>', '<UserId>me</UserId>'])
  const empty = new ScheduledTaskService({ ...w.env, envVars: { USERNAME: 'me', USERDOMAIN: '' } })
  expect(empty.configContent(37811)).toBe(xml)
})

test('the install plan writes the task file and starts the task', async () => {
  const w = windowsWorld()
  const service = new ScheduledTaskService(w.env)
  expect(service.isConfigured()).toBe(false)
  expect(await install({ ...w.env, service }, { ...YES, dryRun: true })).toBe(EXIT_OK)
  const path = taskConfigPath(w.env)
  const content = service.configContent(37811) ?? ''
  expect(content).toBe(taskXml({ user: 'HOST\\me', program: BUN, script: join(w.projectRoot, 'src/cli/kinfold.ts'), dataDir: w.dataDir, port: 37811, logFile: `${w.dataDir}\\logs\\daemon.log` }))
  const plan = planLines(w)
  const write = plan.findIndex((line) => line.startsWith(`write ${path}: `))
  const start = plan.indexOf(service.describe('start'))
  const wait = plan.findIndex((line) => line.startsWith('wait up to ') && line.includes('GET /health'))
  expect(write).toBeGreaterThanOrEqual(0)
  expect(start).toBeGreaterThan(write)
  expect(wait).toBe(start + 1)

  // The file as install writes it, read back through the service.
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, service.configContent(40000) ?? '')
  expect(service.isConfigured()).toBe(true)
  expect(service.configuredDataDir()).toBe(w.dataDir)
  expect(service.configuredPort()).toBe(40000)
  expect(await service.fileHolders(join(w.dataDir, 'memory.db'))).toBe('')

  writeDaemonInfo(w.dataDir, PID)
  const answering = { ...w.env, fetch: healthFetch(PID) }
  const running = new ScheduledTaskService({ ...answering, run: schtasksRunner().run }, { pidAlive: (pid) => pid === PID, kill: () => {} })
  w.out.length = 0
  expect(await status({ ...answering, service: running })).toBe(EXIT_OK)
  expect(w.out).toContain('service (scheduled task): config present; running: yes')
})
