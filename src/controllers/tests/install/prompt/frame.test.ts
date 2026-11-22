import { afterEach, expect, test } from 'bun:test'
import type { InstallEnv } from '../../../../resources/install-plan/env'
import { type FakeWorld, createWorld } from '../test-support'
import { fakeTerminal } from './fake-terminal'
import { EXIT_CANCELLED, runFramed } from '../../../install/prompt/frame'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const ENTER = '\r'

function onTerminal(keys: readonly string[] = []): { env: InstallEnv; term: ReturnType<typeof fakeTerminal>; out: string[] } {
  const term = fakeTerminal(keys)
  world = createWorld({ terminal: term, interactive: true })
  return { env: world.env, term, out: world.out }
}

/** What stays on the screen, without colour or the bar's repaints. */
const screen = (term: ReturnType<typeof fakeTerminal>): string[] =>
  term.output().split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((line) => line !== '')

test('without a terminal the command runs on the env it was given: no frame, no ui', async () => {
  world = createWorld()
  const given = world.env
  let seen: InstallEnv | null = null
  expect(await runFramed(given, 'status', async (env) => ((seen = env), env.out('a line'), 0))).toBe(0)
  expect(seen as InstallEnv | null).toBe(given)
  expect(given.ui).toBeUndefined()
  expect(world.out).toEqual(['a line'])
})

test('on a terminal the run has a title, its lines on the rail, and an end', async () => {
  const { env, term, out } = onTerminal()
  expect(await runFramed(env, 'size', async (framed) => (framed.out('database 1.0 MB'), 0))).toBe(0)
  expect(out).toEqual([])
  const lines = screen(term)
  expect(lines[0]).toMatch(/^Kinfold \S+ size$/)
  expect(lines.slice(1)).toEqual(['database 1.0 MB', 'Done.'])
})

test('next names the command to run, in place of the plain ending', async () => {
  const { env, term } = onTerminal()
  await runFramed(env, 'status', async (framed) => (framed.ui?.next('Open the dashboard with: kinfold dashboard'), 0))
  expect(screen(term).at(-1)).toBe('Open the dashboard with: kinfold dashboard')
})

test('a section and an error draw as the layer draws them, and a failed run does not end with Done', async () => {
  const { env, term } = onTerminal()
  const code = await runFramed(env, 'scan', async (framed) => {
    framed.ui?.section('Findings', [{ mark: 'warn', text: 'aws-key x2' }])
    framed.ui?.error('kinfold scan failed: the daemon is not running')
    return 1
  })
  expect(code).toBe(1)
  expect(screen(term).slice(1)).toEqual(['Findings', '  ! aws-key x2', 'x kinfold scan failed: the daemon is not running', 'kinfold scan did not finish.'])
})

test('a question and a secret go through the layer: the secret is never drawn', async () => {
  const { env, term } = onTerminal(['d', 'e', 'c', 'r', 'y', 'p', 't', ENTER, 's', 'e', 'c', 'r', 'e', 't', ENTER])
  let typed = ''
  let secret = ''
  await runFramed(env, 'decrypt', async (framed) => {
    expect(framed.io.interactive).toBe(true)
    typed = await framed.io.ask('Type decrypt to go on: ')
    secret = await framed.io.askSecret('Recovery code: ')
    return 0
  })
  expect(typed).toBe('decrypt')
  expect(secret).toBe('secret')
  expect(term.output()).toContain('Type decrypt to go on:')
  expect(term.output()).toContain('Recovery code:')
  expect(term.output()).not.toContain('secret')
})

test('Ctrl-C at a question ends the frame once and exits 130', async () => {
  const { env, term } = onTerminal(['\u0003'])
  const code = await runFramed(env, 'decrypt', async (framed) => {
    await framed.io.ask('Type decrypt to go on: ')
    return 0
  })
  expect(code).toBe(EXIT_CANCELLED)
  expect(code).toBe(130)
  expect(screen(term).at(-1)).toBe('decrypt cancelled; nothing was changed')
  expect(term.rawStates().at(-1)).toBe(false)
})

test('busy shows its label, keeps earlier lines above it, and ends on the last line the command said', async () => {
  const { env, term } = onTerminal()
  await runFramed(env, 'backup', async (framed) => {
    const busy = framed.ui?.busy('writing the backup')
    expect(term.output()).toContain('writing the backup')
    framed.out('stopping nothing')
    framed.out('backup written: /tmp/a.kinfold')
    busy?.done()
    framed.out('  made today')
    return 0
  })
  expect(screen(term).slice(1)).toEqual(['|  stopping nothing', 'o  backup written: /tmp/a.kinfold', '  made today', 'Done.'])
})

test('a busy that fails ends on the last line as a failure, and one left open is closed with the run', async () => {
  const failed = onTerminal()
  await runFramed(failed.env, 'restore', async (framed) => {
    const busy = framed.ui?.busy('restoring')
    framed.out('kinfold restore: the recovery code does not open this backup')
    busy?.fail()
    return 1
  })
  expect(screen(failed.term).slice(1)).toEqual(['x  kinfold restore: the recovery code does not open this backup', 'kinfold restore did not finish.'])
  await world?.cleanup()
  const open = onTerminal()
  await runFramed(open.env, 'update', async (framed) => (framed.ui?.busy('downloading'), framed.out('half a line'), 1))
  expect(screen(open.term).slice(1)).toEqual(['x  half a line', 'kinfold update did not finish.'])
})

test('a refusal of several lines is drawn as several lines, as plain output prints it', async () => {
  const { env, term } = onTerminal()
  await runFramed(env, 'encrypt', async (framed) => {
    framed.ui?.error('kinfold encrypt: memory.db is in use\n  held by: claude (pid 4)\n  close those agent sessions and run it again')
    framed.out('one\ntwo')
    return 1
  })
  expect(screen(term).slice(1, -1)).toEqual(['x kinfold encrypt: memory.db is in use', 'x   held by: claude (pid 4)', 'x   close those agent sessions and run it again', 'one', 'two'])
})

test('a process that exits while a spinner is live leaves the cursor on a new line', async () => {
  const { env, term } = onTerminal()
  const before = process.listenerCount('exit')
  let during = 0
  await runFramed(env, 'update', async (framed) => {
    const busy = framed.ui?.busy('downloading')
    during = process.listenerCount('exit')
    // What a signal handler's process.exit would run.
    for (const listener of process.listeners('exit').slice(before)) (listener as () => void)()
    busy?.done()
    return 1
  })
  expect(during).toBe(before + 1)
  expect(process.listenerCount('exit')).toBe(before)
  expect(term.output().endsWith('\n')).toBe(true)
  expect(screen(term)).toContain('x  update interrupted')
})

test('busy can change its label while it runs', async () => {
  const { env, term } = onTerminal()
  await runFramed(env, 'update', async (framed) => {
    const busy = framed.ui?.busy('looking for a newer release')
    busy?.label('downloading Kinfold 0.3.1')
    expect(term.output()).toContain('downloading Kinfold 0.3.1')
    busy?.done()
    return 0
  })
})

test('an error thrown by the command closes the frame and is thrown on', async () => {
  const { env, term } = onTerminal()
  await expect(runFramed(env, 'size', async () => {
    throw new Error('boom')
  })).rejects.toThrow('boom')
  expect(screen(term).at(-1)).toBe('kinfold size did not finish.')
})
