import { expect, test } from 'bun:test'
import { type SpawnDetachedFn, detachPlan, spawnDetached } from './detach'

const ARGS = ['--data-dir', '/home/u/.kinfold', 'update', '--auto']
const none = (): boolean => false

test('macOS starts the program itself: a new process group is outside what launchd stops', () => {
  expect(detachPlan({ os: 'macos', program: '/Users/u/.kinfold/bin/kinfold', args: ARGS, envVars: {}, exists: none }))
    .toEqual({ ok: true, via: 'process-group', argv: ['/Users/u/.kinfold/bin/kinfold', ...ARGS] })
})

test('Linux under a user manager starts a transient unit, outside the service cgroup', () => {
  const envVars = { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/home/u/.kinfold/bin:/usr/bin', HOME: '/home/u' }
  const exists = (path: string): boolean => path === '/run/user/1000/systemd/private' || path === '/usr/bin/systemd-run'
  expect(detachPlan({ os: 'linux', program: '/home/u/.kinfold/bin/kinfold', args: ARGS, envVars, exists })).toEqual({
    ok: true,
    via: 'systemd-run',
    argv: ['/usr/bin/systemd-run', '--user', '--collect', '--quiet', '--description=Kinfold update', '--setenv=PATH=/home/u/.kinfold/bin:/usr/bin', '--setenv=HOME=/home/u', '--', '/home/u/.kinfold/bin/kinfold', ...ARGS],
  })
})

test('Linux under a user manager without systemd-run cannot detach, and says why', () => {
  const envVars = { XDG_RUNTIME_DIR: '/run/user/1000' }
  const exists = (path: string): boolean => path === '/run/user/1000/systemd/private'
  expect(detachPlan({ os: 'linux', program: '/p/kinfold', args: ARGS, envVars, exists }))
    .toEqual({ ok: false, reason: 'systemd-run is not installed, so an update started by the service would be stopped with it' })
})

test('Linux with no user manager has no service cgroup to leave', () => {
  for (const envVars of [{}, { XDG_RUNTIME_DIR: '' }, { XDG_RUNTIME_DIR: '/run/user/1000' }]) {
    expect(detachPlan({ os: 'linux', program: '/p/kinfold', args: ARGS, envVars, exists: none })).toEqual({ ok: true, via: 'process-group', argv: ['/p/kinfold', ...ARGS] })
  }
})

test('Windows starts the program itself, detached: outside the job that ends the daemon\'s children with it', () => {
  // Not under conhost --headless as the scheduled task is: started that way from the daemon, the program never ran (live test, windows-latest).
  expect(detachPlan({ os: 'windows', program: 'C:\\Users\\u\\.kinfold\\bin\\kinfold.exe', args: ARGS, envVars: { SystemRoot: 'D:\\Windows' }, exists: none }))
    .toEqual({ ok: true, via: 'process-group', argv: ['C:\\Users\\u\\.kinfold\\bin\\kinfold.exe', ...ARGS] })
})

test('the child is detached, hidden, wired to nothing and not waited for', () => {
  const calls: { argv: string[]; options: unknown }[] = []
  let unrefs = 0
  const spawn: SpawnDetachedFn = (argv, options) => {
    calls.push({ argv, options })
    return { pid: 4242, unref: () => { unrefs += 1 } }
  }
  expect(spawnDetached(['/p/kinfold', 'update', '--auto'], { PATH: '/usr/bin', EMPTY: undefined }, spawn)).toBe(4242)
  expect(calls).toEqual([{ argv: ['/p/kinfold', 'update', '--auto'], options: { detached: true, windowsHide: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin' } } }])
  expect(unrefs).toBe(1)
})
