import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NO_DB_KEYS } from '../../sqlite/keys'
import { fileState } from '../../sqlite/open'
import { DAEMON_INFO_FILE, DB_FILE } from '../../store/data-dir'
import { openStore } from '../../store/db'
import { START_WAIT_MS, waitForStart } from '../daemon-client'
import { runKeyCommand } from '../encrypt'
import type { CommandRequest, CommandResult, InstallEnv } from '../env'
import { readTextOrNull } from '../files'
import { EXIT_OK, install, serviceActions } from '../install'
import { uninstall } from '../uninstall'
import { HEALTH_WAIT_MS, applyAction } from '../plan'
import { status } from '../status'
import { BUN, type FakeWorld, YES, createWorld } from '../test-support'
import {
  STOP_POLL_MS, ScheduledTaskService, TASK_CONFIG_FILE, TASK_NAME, type TaskProcessDeps,
  splitWindowsArgs, taskConfigPath, taskDataDir, taskPort, taskStateOf, taskStateScript, taskXml, windowsArg,
} from './scheduled-task-service'

const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** Task Scheduler's TASK_STATE numbers. */
const DISABLED = 1
const QUEUED = 2
const READY = 3
const RUNNING = 4
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

/**
 * A runner that records every schtasks argv and answers each verb with the
 * exit code given, else 0. The task-state query is recorded apart and answers
 * `state`: a TASK_STATE number, or a result to return as it is.
 */
function schtasksRunner(exits: Partial<Record<Verb, number>> = {}, state: number | CommandResult = RUNNING): { argvs: string[][]; queries: CommandRequest[]; run: InstallEnv['run'] } {
  const argvs: string[][] = []
  const queries: CommandRequest[] = []
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    if (request.argv[0]?.endsWith('\\powershell.exe') === true) {
      queries.push(request)
      return typeof state === 'number' ? { exitCode: 0, stdout: `state\t${state}\r\n` } : state
    }
    argvs.push([...request.argv])
    const verb = (request.argv[1] ?? '').slice(1) as Verb
    return { exitCode: request.argv[0]?.endsWith('\\System32\\schtasks.exe') === true ? exits[verb] ?? 0 : 127, stdout: '' }
  }
  return { argvs, queries, run }
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
  expect(xml.startsWith('\uFEFF<?xml version="1.0" encoding="UTF-16"?>')).toBe(true)
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
  expect(unknown.queries).toEqual([])
  expect(new ScheduledTaskService(w.env).describe('stop')).toBe('schtasks /End /TN KinfoldDaemon, wait for the daemon to exit, then schtasks /Delete /TN KinfoldDaemon /F')
})

test('a stale daemon.json pid that another process now holds is never killed', async () => {
  const w = windowsWorld()
  writeDaemonInfo(w.dataDir, PID)
  // The pid stays alive throughout: Windows gave it to some other process.
  const stopWith = async (fetch: InstallEnv['fetch'], state: number) => {
    const reused = clockedPid(Number.POSITIVE_INFINITY)
    let slept = 0
    const sleep = async (ms: number) => (slept += ms, reused.sleep(ms))
    const run = schtasksRunner({}, state)
    await new ScheduledTaskService({ ...w.env, fetch, run: run.run, sleep }, reused.deps).stop()
    expect(reused.kills).toEqual([])
    expect(run.argvs.map((argv) => argv[1])).toEqual(['/Query', '/End', '/Delete'])
    return slept
  }
  // No instance of the task ran, so the pid is not waited on either.
  expect(await stopWith(healthFetch(null), READY)).toBe(0)
  expect(await stopWith(healthFetch(PID + 1), READY)).toBe(0)
  // Another daemon answers on the port: the pid is not ours whatever the task does.
  expect(await stopWith(healthFetch(PID + 1), RUNNING)).toBe(0)
  // The task ran and nothing answers: the pid may be a daemon too busy to answer, so stop waits, and still kills nothing unproven.
  expect(await stopWith(healthFetch(null), RUNNING)).toBe(HEALTH_WAIT_MS)
})

test('stop kills a daemon that answers late, and one that closed its server but lives on', async () => {
  const w = windowsWorld()
  writeDaemonInfo(w.dataDir, PID)
  const stopWith = async (answers: (clock: number) => boolean) => {
    let clock = 0
    const kills: number[] = []
    const fetch: InstallEnv['fetch'] = (url, init) => healthFetch(answers(clock) ? PID : null)(url, init)
    const run = schtasksRunner()
    const env = { ...w.env, fetch, run: run.run, sleep: async (ms: number) => void (clock += ms) }
    await new ScheduledTaskService(env, { pidAlive: () => true, kill: (pid) => void kills.push(pid) }).stop()
    expect(run.argvs.map((argv) => argv[1])).toEqual(['/Query', '/End', '/Delete'])
    return kills
  }
  expect(await stopWith((clock) => clock >= 3_000)).toEqual([PID])
  expect(await stopWith((clock) => clock < 1_000)).toEqual([PID])
})

test('stop waits for a daemon that had not answered yet when the task was ended', async () => {
  const w = windowsWorld()
  // The daemon writes daemon.json and answers /health only once its store is open, here 2 s into the stop.
  const stopWith = async (state: number) => {
    let clock = 0
    const kills: number[] = []
    const fetch: InstallEnv['fetch'] = (url, init) => healthFetch(clock >= 2_000 ? PID : null)(url, init)
    const sleep = async (ms: number) => {
      clock += ms
      if (clock >= 2_000) writeDaemonInfo(w.dataDir, PID)
    }
    const run = schtasksRunner({}, state)
    await new ScheduledTaskService({ ...w.env, fetch, run: run.run, sleep }, { pidAlive: () => true, kill: (pid) => void kills.push(pid) }).stop()
    expect(run.argvs.map((argv) => argv[1])).toEqual(['/Query', '/End', '/Delete'])
    rmSync(join(w.dataDir, DAEMON_INFO_FILE), { force: true })
    return { kills, clock }
  }
  expect(await stopWith(RUNNING)).toEqual({ kills: [PID], clock: HEALTH_WAIT_MS })
  // With no instance of the task there is no daemon of ours to wait for.
  expect(await stopWith(READY)).toEqual({ kills: [], clock: 0 })
})

test('running is the task state Task Scheduler reports, whatever /health says', async () => {
  const w = windowsWorld()
  writeDaemonInfo(w.dataDir, PID)
  const alive: TaskProcessDeps = { pidAlive: () => true, kill: () => {} }
  const silent = { ...w.env, fetch: healthFetch(null) }
  const answering = { ...w.env, fetch: healthFetch(PID) }
  const running = (env: InstallEnv, runner: ReturnType<typeof schtasksRunner>) => new ScheduledTaskService({ ...env, run: runner.run }, alive).isRunning()

  // A daemon that is still opening its store answers nothing, and its task runs.
  const starting = schtasksRunner({}, RUNNING)
  expect(await running(silent, starting)).toBe(true)
  expect(await running(silent, schtasksRunner({}, QUEUED))).toBe(true)
  // A task between runs is stopped, even while a daemon someone started by hand answers.
  expect(await running(answering, schtasksRunner({}, READY))).toBe(false)
  expect(await running(answering, schtasksRunner({}, DISABLED))).toBe(false)

  const unregistered = schtasksRunner({ Query: 1 })
  expect(await running(answering, unregistered)).toBe(false)
  expect(unregistered.queries).toEqual([])

  // A registered task whose state cannot be read counts as running.
  for (const unreadable of [{ exitCode: 1, stdout: '' }, { exitCode: 0, stdout: '', timedOut: true }, { exitCode: 0, stdout: 'Bereit\r\n' }]) {
    expect(await running(silent, schtasksRunner({}, unreadable))).toBe(true)
  }

  // One bounded, read-only query, named by full path, with the task name inside the encoded script.
  expect(starting.queries).toHaveLength(1)
  const [query] = starting.queries
  expect(query?.timeoutMs).toBe(15_000)
  expect(query?.argv.slice(0, -1)).toEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  expect(Buffer.from(query?.argv.at(-1) ?? '', 'base64').toString('utf16le')).toBe(taskStateScript())
  expect(taskStateScript()).toContain("GetTypeFromProgID('Schedule.Service')")
  // No cmdlet: loading one's module outlasts the timeout under the CLI's bare child environment.
  expect(taskStateScript()).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)
  expect(taskStateScript()).toContain("GetFolder('\\').GetTask('KinfoldDaemon')")
  expect(taskStateScript()).not.toMatch(/schtasks|Register-|Start-|Stop-|\.Run\(|\.Stop\(|\.Delete/)
})

test('the task state reads only from a clean answer', () => {
  expect(taskStateOf({ exitCode: 0, stdout: 'state\t4\r\n' })).toBe(4)
  expect(taskStateOf({ exitCode: 0, stdout: '\uFEFFstate\t3\n' })).toBe(3)
  expect(taskStateOf({ exitCode: 1, stdout: 'state\t4\n' })).toBeNull()
  expect(taskStateOf({ exitCode: 0, stdout: 'state\t4\n', timedOut: true })).toBeNull()
  for (const stdout of ['', 'state\t', 'state\tRunning', 'Running', 'state\t4\nstate\t3']) expect(taskStateOf({ exitCode: 0, stdout })).toBeNull()
})

/** A clock the env's now and sleep share, with /health answering from `upAt` ms on. */
function startingDaemon(upAt: number): Pick<InstallEnv, 'now' | 'sleep' | 'fetch'> {
  let clock = 0
  return {
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetch: (url, init) => healthFetch(clock >= upAt ? PID : null)(url, init),
  }
}

test('a start that takes longer than the first running check still gets the whole wait', async () => {
  const w = windowsWorld()
  const slow = { ...w.env, ...startingDaemon(6_000) }
  const service = new ScheduledTaskService({ ...slow, run: schtasksRunner().run })
  expect(await waitForStart(slow, service)).toEqual({ ok: true, waitedMs: 6_000 })

  // A store that takes most of the allowance to open is still waited for.
  const slower = { ...w.env, ...startingDaemon(START_WAIT_MS - 1_000) }
  expect(await waitForStart(slower, new ScheduledTaskService({ ...slower, run: schtasksRunner().run }))).toEqual({ ok: true, waitedMs: START_WAIT_MS - 1_000 })

  // A task that ended without a daemon answering stops the wait at the first check.
  const never = { ...w.env, ...startingDaemon(Number.POSITIVE_INFINITY) }
  expect(await waitForStart(never, new ScheduledTaskService({ ...never, run: schtasksRunner({}, READY).run }))).toEqual({ ok: false, reason: 'not-running' })
})

test('encrypt stops a task whose daemon is still starting, then starts it again', async () => {
  world = createWorld({ keychainRefs: [] })
  const w = world
  openStore(w.dataDir, { keys: NO_DB_KEYS }).db.close()
  // Nothing answers /health until the task is run again: the daemon has not opened its store yet.
  let restarted = false
  const runner = schtasksRunner()
  const run: InstallEnv['run'] = (request) => {
    if (request.argv[1] === '/Run') restarted = true
    return runner.run(request)
  }
  const code = /([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}/
  const lastGroups = async () => (code.exec([...w.out].reverse().find((line) => code.test(line)) ?? '')?.[0] ?? '').split('-').slice(-2).join('-')
  const base: InstallEnv = {
    ...w.env,
    envVars: { ...USER_VARS, LOCALAPPDATA: join(w.root, 'LocalAppData') },
    run,
    fetch: (url, init) => healthFetch(restarted ? PID : null)(url, init),
    io: { ...w.env.io, interactive: true, ask: lastGroups, askSecret: lastGroups },
  }
  const env = { ...base, service: new ScheduledTaskService(base) }
  expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_OK)
  expect(fileState(join(w.dataDir, DB_FILE))).toBe('encrypted')
  expect(runner.argvs.map((argv) => argv[1]).filter((verb) => verb !== '/Query')).toEqual(['/End', '/Delete', '/Create', '/Run'])
  expect(w.out).toContain('daemon: stopped the scheduled task')
  expect(w.out).toContain('daemon: started again')
})

test('uninstall deletes the task even when its daemon is not answering', async () => {
  for (const state of [READY, RUNNING]) {
    const w = windowsWorld()
    const path = taskConfigPath(w.env)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, new ScheduledTaskService(w.env).configContent(37811) ?? '')
    const runner = schtasksRunner({}, state)
    const env = { ...w.env, fetch: healthFetch(null), run: runner.run }
    expect(await uninstall(env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
    expect(runner.argvs).toContainEqual([SCHTASKS, '/Delete', '/TN', TASK_NAME, '/F'])
    expect(readTextOrNull(path)).toBeNull()
    await w.cleanup()
  }
  world = null

  // With no task registered there is nothing to delete, and uninstall does not try.
  const w = windowsWorld()
  const none = schtasksRunner({ Query: 1 })
  expect(await uninstall({ ...w.env, fetch: healthFetch(null), run: none.run }, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(none.argvs.every((argv) => argv[1] === '/Query')).toBe(true)
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

test('install writes the task file as UTF-16LE with a BOM, and the service reads it back', async () => {
  const w = windowsWorld()
  const service = new ScheduledTaskService(w.env)
  const situation = { health: { up: false, reason: 'down' } as const, loaded: false, pid: null, port: 40000, legacyLoaded: false, foreign: false }
  const actions = serviceActions(w.env, service, situation, false, false, 40000)
  const write = actions.find((action) => action.kind === 'write')
  if (write?.kind !== 'write') throw new Error('no write action')
  expect(write.encoding).toBe('utf16le')
  for (const action of actions.filter((action) => action.kind === 'mkdir')) await applyAction(w.env, action)
  await applyAction(w.env, write)

  const path = taskConfigPath(w.env)
  const content = service.configContent(40000) ?? ''
  const bytes = readFileSync(path)
  expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00])
  expect(bytes.equals(Buffer.from(content, 'utf16le'))).toBe(true)
  expect(bytes.length).toBe(content.length * 2)
  expect(content).toContain('encoding="UTF-16"')
  // The same text comes back, so a re-install sees no change and rewrites nothing.
  expect(readTextOrNull(path)).toBe(content)
  expect(service.configuredDataDir()).toBe(w.dataDir)
  expect(service.configuredPort()).toBe(40000)

  // A file an earlier install wrote as UTF-8 still reads.
  writeFileSync(path, Buffer.from(content.replace('encoding="UTF-16"', 'encoding="UTF-8"'), 'utf8'))
  expect(service.configuredDataDir()).toBe(w.dataDir)
  expect(service.configuredPort()).toBe(40000)
  expect(serviceActions(w.env, service, situation, false, false, 40000).some((action) => action.kind === 'write')).toBe(true)
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
