import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { posixOnly } from '../../test/platform-guards'
import type { InstallEnv } from './env'
import { BLOCK_END, BLOCK_START, commandStatusLine, pathQuestionNeeded, pathRemovalActions, planPathSetup, shellFiles, withBlock, withoutBlock } from './path-setup'
import { type Action, describeAction, runPlan } from './plan'
import type { InstallRecord } from './setup/record'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

interface Options {
  shell?: string
  platform?: NodeJS.Platform
  onPath?: boolean
  vars?: Record<string, string>
}

/** A world whose install is a program in the default folder, so the PATH step applies. */
function programWorld(options: Options = {}): FakeWorld {
  world = createWorld({ platform: options.platform ?? 'linux' })
  const bin = join(world.dataDir, 'bin', 'kinfold')
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n')
  world.env = {
    ...world.env,
    mode: { kind: 'program', binPath: bin },
    pathEnv: options.onPath === true ? `/usr/bin:${join(world.home, '.local', 'bin')}` : '/usr/bin:/bin',
    envVars: { SHELL: options.shell ?? '/bin/zsh', ...options.vars },
  }
  return world
}

const record = (over: Partial<InstallRecord> = {}): InstallRecord => ({ channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1, ...over })
const FIRST = { answer: null, yes: true, flag: null } as const
const link = (w: FakeWorld): string => join(w.home, '.local', 'bin', 'kinfold')
const kinds = (actions: readonly Action[]): string[] => actions.map((action) => action.kind)
const apply = (w: FakeWorld, actions: readonly Action[]): Promise<void> => runPlan(w.env, actions, false, undefined, { listeners: [] })

describe('the marked block', () => {
  test('goes below the text with a blank line between, and keeps the file\'s line endings', () => {
    expect(withBlock('export A=1\n', 'posix')).toBe(`export A=1\n\n${BLOCK_START}\n# Added by kinfold install so the kinfold command is found. kinfold uninstall removes it.\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n${BLOCK_END}\n`)
    expect(withBlock('export A=1\r\n', 'posix')).toContain(`export A=1\r\n\r\n${BLOCK_START}\r\n`)
    expect(withBlock('export A=1\r\n', 'posix').endsWith(`${BLOCK_END}\r\n`)).toBe(true)
  })

  test('starts on its own line when the file has no final newline', () => {
    expect(withBlock('export A=1', 'posix').startsWith(`export A=1\n${BLOCK_START}\n`)).toBe(true)
  })

  test('is the whole file when there was none', () => {
    expect(withBlock(null, 'posix').startsWith(`${BLOCK_START}\n`)).toBe(true)
    expect(withBlock('', 'fish')).toContain('if not contains -- "$HOME/.local/bin" $PATH\n    set -gx PATH "$HOME/.local/bin" $PATH\nend\n')
  })

  test('is not added twice', () => {
    const once = withBlock('x\n', 'posix')
    expect(withBlock(once, 'posix')).toBe(once)
  })

  test('only prepends ~/.local/bin, and only when it is missing', () => {
    const body = withBlock(null, 'posix').split('\n').filter((line) => !line.startsWith('#') && line !== '')
    expect(body).toEqual(['case ":$PATH:" in', '  *":$HOME/.local/bin:"*) ;;', '  *) export PATH="$HOME/.local/bin:$PATH" ;;', 'esac'])
  })

  for (const original of ['export A=1\n', 'export A=1', 'export A=1\n\n', 'a\r\nb\r\n', '']) {
    test(`taking it out restores ${JSON.stringify(original)} byte for byte`, () => {
      expect(withoutBlock(withBlock(original, 'posix'))).toBe(original)
    })
  }

  test('taking it out keeps what the person wrote after it, on its own line', () => {
    expect(withoutBlock(`${withBlock('a\n', 'posix')}b\n`)).toBe('a\nb\n')
    expect(withoutBlock(`${withBlock('a', 'posix')}b\n`)).toBe('a\nb\n')
  })

  test('a file without the block is returned as it is', () => {
    expect(withoutBlock('export A=1\n')).toBe('export A=1\n')
  })
})

describe('which startup files a shell reads', () => {
  test('zsh: ~/.zshrc, or $ZDOTDIR/.zshrc', () => {
    const w = programWorld({ shell: '/bin/zsh' })
    expect(shellFiles(w.env)).toEqual({ shell: 'zsh', kind: 'posix', files: [join(w.home, '.zshrc')] })
    expect(shellFiles({ ...w.env, envVars: { SHELL: '/bin/zsh', ZDOTDIR: join(w.home, 'zsh') } }).files).toEqual([join(w.home, 'zsh', '.zshrc')])
    expect(shellFiles({ ...w.env, envVars: { SHELL: '/bin/zsh', ZDOTDIR: 'relative' } }).files).toEqual([join(w.home, '.zshrc')])
  })

  for (const platform of ['linux', 'darwin'] as const) {
    test(`bash on ${platform}: ~/.bashrc, and ~/.bash_profile too when it exists, since a login shell reads that instead`, () => {
      const w = programWorld({ shell: '/bin/bash', platform })
      expect(shellFiles(w.env).files).toEqual([join(w.home, '.bashrc')])
      writeFileSync(join(w.home, '.bash_profile'), '')
      expect(shellFiles(w.env).files).toEqual([join(w.home, '.bashrc'), join(w.home, '.bash_profile')])
    })
  }

  test('fish: a file of its own in conf.d, under XDG_CONFIG_HOME when that is set', () => {
    const w = programWorld({ shell: '/usr/local/bin/fish' })
    expect(shellFiles(w.env)).toEqual({ shell: 'fish', kind: 'fish', files: [join(w.home, '.config', 'fish', 'conf.d', 'kinfold.fish')] })
    expect(shellFiles({ ...w.env, xdgConfigHomeEnv: join(w.home, 'xdg') }).files).toEqual([join(w.home, 'xdg', 'fish', 'conf.d', 'kinfold.fish')])
  })

  test('any other shell, or none named, has no file Kinfold edits', () => {
    const w = programWorld({ shell: '/bin/tcsh' })
    expect(shellFiles(w.env).files).toEqual([])
    expect(shellFiles({ ...w.env, envVars: {} }).files).toEqual([])
  })
})

describe('a first install', () => {
  posixOnly('POSIX paths')('with --yes: links the command and adds the block when ~/.local/bin is not on PATH', async () => {
    const w = programWorld()
    writeFileSync(join(w.home, '.zshrc'), 'export A=1\n')
    const plan = planPathSetup(w.env, null, FIRST)
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command', 'backup', 'write'])
    expect(plan.record).toEqual({ pathSetup: 'added', pathLink: link(w), pathFiles: [join(w.home, '.zshrc')] })
    await apply(w, plan.actions)
    expect(readlinkSync(link(w))).toBe(join(w.dataDir, 'bin', 'kinfold'))
    expect(readFileSync(join(w.home, '.zshrc'), 'utf8')).toBe(withBlock('export A=1\n', 'posix'))
    const backups = readdirSync(w.home).filter((name) => name.startsWith('.zshrc.kinfold-backup-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(w.home, backups[0] as string), 'utf8')).toBe('export A=1\n')
    expect(plan.summary).toContain('~/.zshrc')
    expect(plan.activate).toBe('source ~/.zshrc')
  })

  posixOnly('POSIX paths')('creates the startup file when the shell has none yet', async () => {
    const w = programWorld({ shell: '/bin/bash' })
    const plan = planPathSetup(w.env, null, FIRST)
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command', 'write'])
    await apply(w, plan.actions)
    expect(readFileSync(join(w.home, '.bashrc'), 'utf8')).toBe(withBlock(null, 'posix'))
  })

  posixOnly('POSIX paths')('fish gets its own file and no other file is touched', async () => {
    const w = programWorld({ shell: '/usr/bin/fish' })
    const plan = planPathSetup(w.env, null, FIRST)
    await apply(w, plan.actions)
    const file = join(w.home, '.config', 'fish', 'conf.d', 'kinfold.fish')
    expect(readFileSync(file, 'utf8')).toBe(withBlock(null, 'fish'))
    expect(plan.record.pathFiles).toEqual([file])
    expect(plan.activate).toBe('source ~/.config/fish/conf.d/kinfold.fish')
  })

  posixOnly('POSIX paths')('with ~/.local/bin already on PATH: the link only', () => {
    const w = programWorld({ onPath: true })
    const plan = planPathSetup(w.env, null, FIRST)
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command'])
    expect(plan.record).toEqual({ pathSetup: 'not-needed', pathLink: link(w) })
    expect(plan.activate).toBeNull()
  })

  posixOnly('POSIX paths')('another shell: the link, the line to add printed, and nothing edited', () => {
    const w = programWorld({ shell: '/bin/tcsh' })
    const plan = planPathSetup(w.env, null, FIRST)
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command'])
    expect(plan.record).toEqual({ pathSetup: 'declined', pathLink: link(w) })
    expect(plan.summary).toContain('export PATH="$HOME/.local/bin:$PATH"')
  })

  posixOnly('POSIX paths')('answering no keeps the link and leaves PATH alone', () => {
    const w = programWorld()
    const plan = planPathSetup(w.env, null, { answer: 'decline', yes: false, flag: null })
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command'])
    expect(plan.record).toEqual({ pathSetup: 'declined', pathLink: link(w) })
  })

  posixOnly('POSIX paths')('--no-path makes neither', () => {
    const w = programWorld()
    const plan = planPathSetup(w.env, null, { answer: null, yes: true, flag: 'no-path' })
    expect(plan.actions).toEqual([])
    expect(plan.record).toEqual({ pathSetup: 'declined' })
  })

  posixOnly('POSIX paths')('a link that is already ours is left as it is', () => {
    const w = programWorld({ onPath: true })
    mkdirSync(dirname(link(w)), { recursive: true })
    symlinkSync(join(w.dataDir, 'bin', 'kinfold'), link(w))
    const plan = planPathSetup(w.env, null, FIRST)
    expect(plan.actions).toEqual([])
    expect(plan.record).toEqual({ pathSetup: 'not-needed', pathLink: link(w) })
  })

  posixOnly('POSIX paths')('anything else at ~/.local/bin/kinfold is left untouched, said, and gets no PATH block', () => {
    const w = programWorld()
    mkdirSync(dirname(link(w)), { recursive: true })
    writeFileSync(link(w), 'someone else\n')
    const plan = planPathSetup(w.env, null, FIRST)
    expect(plan.actions).toEqual([])
    expect(plan.record).toEqual({ pathSetup: 'not-needed' })
    expect(plan.summary).toContain('is not Kinfold\'s link and was left alone')
    expect(readFileSync(link(w), 'utf8')).toBe('someone else\n')
  })

  posixOnly('POSIX paths')('a startup file that is a link into a dotfiles folder stays a link, and its target gets the block', async () => {
    const w = programWorld()
    const dotfiles = join(w.root, 'dotfiles')
    mkdirSync(dotfiles)
    writeFileSync(join(dotfiles, 'zshrc'), 'export A=1\n')
    symlinkSync(join(dotfiles, 'zshrc'), join(w.home, '.zshrc'))
    await apply(w, planPathSetup(w.env, null, FIRST).actions)
    expect(lstatSync(join(w.home, '.zshrc')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dotfiles, 'zshrc'), 'utf8')).toBe(withBlock('export A=1\n', 'posix'))
  })

  posixOnly('POSIX paths')('a file that already holds the block is recorded and not written again', () => {
    const w = programWorld()
    writeFileSync(join(w.home, '.zshrc'), withBlock('x\n', 'posix'))
    const plan = planPathSetup(w.env, null, FIRST)
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command'])
    expect(plan.record.pathFiles).toEqual([join(w.home, '.zshrc')])
  })

  posixOnly('POSIX paths')('the plan lines name the link and the file, and no file content', () => {
    const w = programWorld()
    const lines = planPathSetup(w.env, null, FIRST).actions.map(describeAction)
    expect(lines[1]).toBe(`link ${link(w)} -> ${join(w.dataDir, 'bin', 'kinfold')}`)
    expect(lines.at(-1)).toBe(`write ${join(w.home, '.zshrc')}: add the kinfold PATH block (create, 7 lines)`)
  })
})

describe('where the step does not apply', () => {
  test('a checkout has no installed program: nothing is planned or recorded', () => {
    world = createWorld({ platform: 'linux' })
    const plan = planPathSetup(world.env, null, FIRST)
    expect(plan).toMatchObject({ actions: [], record: {}, summary: null })
    expect(pathQuestionNeeded(world.env, null, null)).toBe(false)
  })

  test('an install in another folder gets no link and no block', () => {
    const w = programWorld()
    const env: InstallEnv = { ...w.env, dataDir: join(w.root, 'elsewhere'), mode: { kind: 'program', binPath: join(w.root, 'elsewhere', 'bin', 'kinfold') } }
    expect(planPathSetup(env, null, FIRST)).toMatchObject({ actions: [], record: {}, summary: null })
    expect(pathQuestionNeeded(env, null, null)).toBe(false)
  })
})

describe('an install that already has a record', () => {
  test('without pathSetup, --yes adds nothing and the field stays absent', () => {
    const w = programWorld()
    const plan = planPathSetup(w.env, record(), FIRST)
    expect(plan.actions).toEqual([])
    expect(plan.record).toEqual({})
    expect(plan.summary).toContain('install in a terminal')
  })

  posixOnly('POSIX paths')('without pathSetup, an interactive install asks, and yes adds', () => {
    const w = programWorld()
    expect(pathQuestionNeeded(w.env, record(), null)).toBe(true)
    expect(planPathSetup(w.env, record(), { answer: 'add', yes: false, flag: null }).record.pathSetup).toBe('added')
  })

  for (const saved of ['added', 'declined', 'not-needed'] as const) {
    test(`recorded ${saved}: never asked again, nothing planned, the record carried over`, () => {
      const w = programWorld()
      const before = record({ pathSetup: saved, pathLink: link(w), pathFiles: [join(w.home, '.zshrc')] })
      expect(pathQuestionNeeded(w.env, before, null)).toBe(false)
      const plan = planPathSetup(w.env, before, { answer: null, yes: false, flag: null })
      expect(plan.actions).toEqual([])
      expect(plan.record).toEqual({ pathSetup: saved, pathLink: link(w), pathFiles: [join(w.home, '.zshrc')] })
    })
  }

  posixOnly('POSIX paths')('a block the person deleted after it was added is not put back', () => {
    const w = programWorld()
    writeFileSync(join(w.home, '.zshrc'), 'export A=1\n')
    const plan = planPathSetup(w.env, record({ pathSetup: 'added', pathLink: link(w), pathFiles: [join(w.home, '.zshrc')] }), FIRST)
    expect(plan.actions).toEqual([])
  })

  posixOnly('POSIX paths')('--path adds it whatever was recorded, and without asking', () => {
    const w = programWorld()
    expect(pathQuestionNeeded(w.env, record({ pathSetup: 'declined' }), 'path')).toBe(false)
    const plan = planPathSetup(w.env, record({ pathSetup: 'declined' }), { answer: null, yes: true, flag: 'path' })
    expect(kinds(plan.actions)).toEqual(['mkdir', 'link-command', 'write'])
    expect(plan.record.pathSetup).toBe('added')
  })

  posixOnly('POSIX paths')('--no-path takes out what an earlier install added', async () => {
    const w = programWorld()
    writeFileSync(join(w.home, '.zshrc'), 'export A=1\n')
    const first = planPathSetup(w.env, null, FIRST)
    await apply(w, first.actions)
    const plan = planPathSetup(w.env, record(first.record), { answer: null, yes: true, flag: 'no-path' })
    await apply(w, plan.actions)
    expect(plan.record).toEqual({ pathSetup: 'declined' })
    expect(existsSync(link(w))).toBe(false)
    expect(readFileSync(join(w.home, '.zshrc'), 'utf8')).toBe('export A=1\n')
  })

  posixOnly('POSIX paths')('the question is not asked when ~/.local/bin is on PATH, the shell is unknown, or a flag answered it', () => {
    expect(pathQuestionNeeded(programWorld({ onPath: true }).env, null, null)).toBe(false)
    expect(pathQuestionNeeded(programWorld({ shell: '/bin/tcsh' }).env, null, null)).toBe(false)
    expect(pathQuestionNeeded(programWorld().env, null, 'no-path')).toBe(false)
  })

  posixOnly('POSIX paths')('the question is asked on a first interactive install with ~/.local/bin off PATH', () => {
    expect(pathQuestionNeeded(programWorld().env, null, null)).toBe(true)
  })
})

describe('removal', () => {
  posixOnly('POSIX paths')('takes out the link, the block from every startup file and the fish file, and nothing else', async () => {
    const w = programWorld({ shell: '/bin/bash', platform: 'darwin' })
    writeFileSync(join(w.home, '.bashrc'), 'export A=1\n')
    writeFileSync(join(w.home, '.bash_profile'), 'export B=2')
    writeFileSync(join(w.home, '.zshrc'), 'untouched\n')
    const added = planPathSetup(w.env, null, FIRST)
    await apply(w, added.actions)
    const fish = planPathSetup({ ...w.env, envVars: { SHELL: '/usr/bin/fish' } }, null, { answer: null, yes: true, flag: 'path' })
    await apply(w, fish.actions.filter((action) => action.kind !== 'link-command' && !(action.kind === 'mkdir' && action.path.endsWith('bin'))))
    const removal = pathRemovalActions(w.env, record(added.record))
    await apply(w, removal)
    expect(existsSync(link(w))).toBe(false)
    expect(readFileSync(join(w.home, '.bashrc'), 'utf8')).toBe('export A=1\n')
    expect(readFileSync(join(w.home, '.bash_profile'), 'utf8')).toBe('export B=2')
    expect(readFileSync(join(w.home, '.zshrc'), 'utf8')).toBe('untouched\n')
    expect(existsSync(join(w.home, '.config', 'fish', 'conf.d', 'kinfold.fish'))).toBe(false)
  })

  posixOnly('POSIX paths')('leaves a link that points somewhere else, and a fish file that is not ours', async () => {
    const w = programWorld()
    mkdirSync(dirname(link(w)), { recursive: true })
    symlinkSync('/opt/other/kinfold', link(w))
    const fish = join(w.home, '.config', 'fish', 'conf.d', 'kinfold.fish')
    mkdirSync(dirname(fish), { recursive: true })
    writeFileSync(fish, 'set -gx MINE 1\n')
    expect(pathRemovalActions(w.env, null)).toEqual([])
    expect(readlinkSync(link(w))).toBe('/opt/other/kinfold')
  })

  posixOnly('POSIX paths')('a link swapped for another program between the plan and the step is kept', async () => {
    const w = programWorld({ onPath: true })
    await apply(w, planPathSetup(w.env, null, FIRST).actions)
    const removal = pathRemovalActions(w.env, null)
    expect(kinds(removal)).toEqual(['unlink-command'])
    const { rmSync } = await import('node:fs')
    rmSync(link(w))
    symlinkSync('/opt/other/kinfold', link(w))
    await apply(w, removal)
    expect(readlinkSync(link(w))).toBe('/opt/other/kinfold')
  })

  posixOnly('POSIX paths')('finds a block with no record at all, since the record can be lost', async () => {
    const w = programWorld()
    writeFileSync(join(w.home, '.zshrc'), withBlock('export A=1\n', 'posix'))
    await apply(w, pathRemovalActions(w.env, null))
    expect(readFileSync(join(w.home, '.zshrc'), 'utf8')).toBe('export A=1\n')
  })
})

describe('Windows', () => {
  function windowsWorld(onPath = false): FakeWorld {
    const w = programWorld({ platform: 'win32' })
    const bin = join(w.dataDir, 'bin')
    w.env = { ...w.env, mode: { kind: 'program', binPath: join(bin, 'kinfold.exe') }, pathEnv: onPath ? `C:\\Windows;${bin.toUpperCase()}\\` : 'C:\\Windows' }
    return w
  }

  test('a first --yes install plans the user PATH entry and records it', () => {
    const w = windowsWorld()
    const plan = planPathSetup(w.env, null, FIRST)
    expect(plan.actions).toEqual([{ kind: 'windows-user-path', change: 'add', dir: join(w.dataDir, 'bin') }])
    expect(plan.record).toEqual({ pathSetup: 'added' })
    expect(describeAction(plan.actions[0] as Action)).toBe(`add ${join(w.dataDir, 'bin')} to the user PATH (HKCU\\Environment) and tell open programs`)
    expect(plan.summary).toBe(`kinfold command: ${join(w.dataDir, 'bin')} on your user PATH`)
    expect(plan.activate).toBe(join(w.dataDir, 'bin', 'kinfold.exe'))
  })

  test('already on PATH, in any letter case: nothing to add', () => {
    const plan = planPathSetup(windowsWorld(true).env, null, FIRST)
    expect(plan.actions).toEqual([])
    expect(plan.record).toEqual({ pathSetup: 'not-needed' })
  })

  test('the question is asked, and no declines', () => {
    const w = windowsWorld()
    expect(pathQuestionNeeded(w.env, null, null)).toBe(true)
    expect(planPathSetup(w.env, null, { answer: 'decline', yes: false, flag: null })).toMatchObject({ actions: [], record: { pathSetup: 'declined' } })
  })

  test('a record without pathSetup and --yes never touches the user PATH', () => {
    expect(planPathSetup(windowsWorld().env, record(), FIRST).actions).toEqual([])
  })

  test('removal takes the entry out only when install added it', () => {
    const w = windowsWorld()
    expect(pathRemovalActions(w.env, record({ pathSetup: 'added' }))).toEqual([{ kind: 'windows-user-path', change: 'remove', dir: join(w.dataDir, 'bin') }])
    expect(pathRemovalActions(w.env, record({ pathSetup: 'declined' }))).toEqual([])
    expect(pathRemovalActions(w.env, null)).toEqual([])
  })
})

describe('the status line', () => {
  posixOnly('POSIX paths')('names the program kinfold resolves to, and says when it is this install', async () => {
    const w = programWorld({ onPath: true })
    await apply(w, planPathSetup(w.env, null, FIRST).actions)
    expect(commandStatusLine(w.env, record({ pathSetup: 'not-needed', pathLink: link(w) }))).toBe(`kinfold command: on PATH at ${link(w)} (this install)`)
  })

  posixOnly('POSIX paths')('says when kinfold on PATH is another program', () => {
    const w = programWorld({ onPath: true })
    mkdirSync(dirname(link(w)), { recursive: true })
    writeFileSync(link(w), '#!/bin/sh\n', { mode: 0o755 })
    expect(commandStatusLine(w.env, record({ pathSetup: 'not-needed' }))).toBe(`kinfold command: on PATH at ${link(w)}, which is not this install's program`)
  })

  test('not on PATH: says why for each recorded state', () => {
    const w = programWorld()
    const bin = join(w.dataDir, 'bin', 'kinfold')
    expect(commandStatusLine(w.env, record())).toBe(`kinfold command: not on PATH; run ${bin} install in a terminal to add it`)
    expect(commandStatusLine(w.env, record({ pathSetup: 'declined' }))).toBe('kinfold command: not on PATH; PATH was left alone at install (kinfold install --path adds it)')
    expect(commandStatusLine(w.env, record({ pathSetup: 'added', pathFiles: [join(w.home, '.zshrc')] }))).toBe(`kinfold command: not on PATH in this shell; open a new terminal (the PATH line is in ${join('~', '.zshrc')})`)
    expect(commandStatusLine(w.env, record({ pathSetup: 'not-needed' }))).toBe('kinfold command: not on PATH; ~/.local/bin is not on PATH any more (kinfold install --path adds it)')
  })

  test('a checkout and an install in another folder say why there is no command', () => {
    world = createWorld({ platform: 'linux' })
    expect(commandStatusLine(world.env, null)).toBe('kinfold command: not on PATH; a checkout has no installed program')
    const w = programWorld()
    const elsewhere = join(w.root, 'elsewhere')
    const env: InstallEnv = { ...w.env, dataDir: elsewhere, mode: { kind: 'program', binPath: join(elsewhere, 'bin', 'kinfold') } }
    expect(commandStatusLine(env, null)).toBe(`kinfold command: not on PATH; it is linked only for an install in ~/.kinfold (run ${join(elsewhere, 'bin', 'kinfold')} --data-dir ${elsewhere})`)
  })
})
