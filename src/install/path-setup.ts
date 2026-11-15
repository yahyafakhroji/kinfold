// `kinfold` as a command after install. On macOS and Linux that is a link at
// ~/.local/bin/kinfold to <dataDir>/bin/kinfold, plus, when ~/.local/bin is
// not on PATH and the person agrees, one marked block in their shell's
// startup file. On Windows it is <dataDir>\bin on the user PATH
// (path-windows.ts). install.json records what was chosen and written, and a
// later install follows the record: a declined change, or a block the person
// deleted, never comes back on its own.
//
// Nothing here is done for a checkout (it has no installed program) or for
// an install outside ~/.kinfold (a second install must not take the name
// from the first). A file at ~/.local/bin/kinfold that is not our link is
// never replaced.

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DATA_DIR_NAME } from '../names'
import { type InstallEnv, platformOf } from './env'
import { installedProgramPath } from './entry'
import { plannedBackup, readTextOrNull } from './files'
import type { Action, StepNote } from './plan'
import type { InstallRecord, PathSetup } from './setup/record'

export type { PathSetup }
export type PathAnswer = 'add' | 'decline'
export type PathFlag = 'path' | 'no-path' | null

export const BLOCK_START = '# >>> kinfold >>>'
export const BLOCK_END = '# <<< kinfold <<<'

const DIR_MODE = 0o755
const FILE_MODE = 0o644
const POSIX_LINE = 'export PATH="$HOME/.local/bin:$PATH"'

type BlockKind = 'posix' | 'fish'

const BLOCKS: Readonly<Record<BlockKind, readonly string[]>> = {
  posix: [
    BLOCK_START,
    '# Added by kinfold install so the kinfold command is found. kinfold uninstall removes it.',
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    `  *) ${POSIX_LINE} ;;`,
    'esac',
    BLOCK_END,
  ],
  fish: [
    BLOCK_START,
    '# Added by kinfold install so the kinfold command is found. kinfold uninstall removes this file.',
    'if not contains -- "$HOME/.local/bin" $PATH',
    '    set -gx PATH "$HOME/.local/bin" $PATH',
    'end',
    BLOCK_END,
  ],
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

/** The text with the block below it, in the file's own line endings; unchanged when the block is already there. */
export function withBlock(text: string | null, kind: BlockKind): string {
  const before = text ?? ''
  if (before.includes(BLOCK_START)) return before
  const eol = eolOf(before)
  const block = `${BLOCKS[kind].join(eol)}${eol}`
  if (before === '') return block
  // A blank line sets the block apart; a file with no final newline gets only the newline that ends its last line.
  return `${before}${eol}${block}`
}

/**
 * The text with the block taken out, and the separator that withBlock put
 * above it: the blank line, or, when nothing follows the block, the newline
 * that was added to end the file's last line. What the person wrote before
 * and after stays byte for byte.
 */
export function withoutBlock(text: string): string {
  let next = text
  for (;;) {
    const start = next.indexOf(BLOCK_START)
    const endMark = start < 0 ? -1 : next.indexOf(BLOCK_END, start)
    if (start < 0 || endMark < 0) return next
    const eol = eolOf(next)
    let end = endMark + BLOCK_END.length
    if (next.startsWith(eol, end)) end += eol.length
    let head = next.slice(0, start)
    const tail = next.slice(end)
    if (head.endsWith(`${eol}${eol}`)) head = head.slice(0, -eol.length)
    else if (tail === '' && head.endsWith(eol)) head = head.slice(0, -eol.length)
    next = `${head}${tail}`
  }
}

export type ShellName = 'zsh' | 'bash' | 'fish' | 'other'

export interface ShellFiles {
  shell: ShellName
  kind: BlockKind
  /** The startup files that get the block; empty for a shell Kinfold does not edit. */
  files: string[]
}

type ShellEnv = Pick<InstallEnv, 'homeDir' | 'platform' | 'wsl' | 'envVars' | 'xdgConfigHomeEnv'>

function absoluteOr(value: string | undefined, fallback: string): string {
  return value !== undefined && value !== '' && isAbsolute(value) ? value : fallback
}

function fishFile(env: ShellEnv): string {
  return join(absoluteOr(env.xdgConfigHomeEnv, join(env.homeDir, '.config')), 'fish', 'conf.d', 'kinfold.fish')
}

/** The shell is the one $SHELL names: the person's login shell, whatever shell ran the installer. */
export function shellFiles(env: ShellEnv): ShellFiles {
  const name = basename(env.envVars?.SHELL ?? '')
  if (name === 'zsh') return { shell: 'zsh', kind: 'posix', files: [join(absoluteOr(env.envVars?.ZDOTDIR, env.homeDir), '.zshrc')] }
  if (name === 'bash') {
    const profile = join(env.homeDir, '.bash_profile')
    // A login bash (Terminal on macOS, ssh anywhere) reads .bash_profile when there is one, and then never .bashrc.
    const login = existsSync(profile) ? [profile] : []
    return { shell: 'bash', kind: 'posix', files: [join(env.homeDir, '.bashrc'), ...login] }
  }
  if (name === 'fish') return { shell: 'fish', kind: 'fish', files: [fishFile(env)] }
  return { shell: 'other', kind: 'posix', files: [] }
}

type LinkState = 'missing' | 'ours' | 'foreign'

function linkState(path: string, target: string): LinkState {
  try {
    if (!lstatSync(path).isSymbolicLink()) return 'foreign'
    return resolve(dirname(path), readlinkSync(path)) === resolve(target) ? 'ours' : 'foreign'
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/** The step behind `link-command`: never over something that appeared since the plan was made. */
export function linkCommand(path: string, target: string): StepNote | void {
  const state = linkState(path, target)
  if (state === 'foreign') return { kept: `${path} exists and is not Kinfold's link; left alone` }
  if (state === 'missing') symlinkSync(target, path)
}

/** The step behind `unlink-command`: only a link that still points at this install's program goes. */
export function unlinkCommand(path: string, target: string): StepNote | void {
  const state = linkState(path, target)
  if (state === 'foreign') return { kept: `${path} no longer points at ${target}; left alone` }
  if (state === 'ours') rmSync(path, { force: true })
}

interface Situation {
  /** Why the step is skipped here; null when it applies. */
  skip: 'checkout' | 'other-folder' | null
  windows: boolean
  /** The installed program: what the link points at, and on Windows the file whose folder goes on PATH. */
  program: string
  /** ~/.local/bin, or <dataDir>\bin on Windows. */
  binDir: string
  /** ~/.local/bin/kinfold; unused on Windows. */
  link: string
  onPath: boolean
}

function samePathEntry(a: string, b: string, windows: boolean): boolean {
  const trim = (value: string): string => value.replace(/[\\/]+$/, '')
  return windows ? trim(a).toLowerCase() === trim(b).toLowerCase() : resolve(a) === resolve(b)
}

function pathEntries(env: Pick<InstallEnv, 'pathEnv'>, windows: boolean): string[] {
  return env.pathEnv.split(windows ? ';' : ':').filter((entry) => entry !== '' && (windows || isAbsolute(entry)))
}

function situationOf(env: InstallEnv): Situation {
  const windows = platformOf(env).os === 'windows'
  const program = installedProgramPath(env.dataDir, env.platform)
  const binDir = windows ? dirname(program) : join(env.homeDir, '.local', 'bin')
  const skip = env.mode.kind === 'checkout' ? 'checkout' : resolve(env.dataDir) !== resolve(join(env.homeDir, DATA_DIR_NAME)) ? 'other-folder' : null
  return { skip, windows, program, binDir, link: join(binDir, 'kinfold'), onPath: pathEntries(env, windows).some((entry) => samePathEntry(entry, binDir, windows)) }
}

const tilde = (env: Pick<InstallEnv, 'homeDir'>, path: string): string => (path === env.homeDir || path.startsWith(`${env.homeDir}${sep}`) ? `~${path.slice(env.homeDir.length)}` : path)

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return FILE_MODE
  }
}

/** The file a write must land on: a startup file that is a link (a dotfiles folder) is written through, so the link survives the rename. */
function writeTarget(path: string): string {
  try {
    // Only the file's own link is followed: a linked folder above it is the same file under either name, and the plan names the path the person knows.
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path
  } catch {
    return path
  }
}

function mkdirIfMissing(path: string): Action[] {
  return existsSync(path) ? [] : [{ kind: 'mkdir', path, mode: DIR_MODE }]
}

function backupIfFirst(env: Pick<InstallEnv, 'now'>, path: string): Action[] {
  const to = plannedBackup(path, env.now())
  return to === null ? [] : [{ kind: 'backup', from: path, to }]
}

/** The block into one startup file: a backup before the first change, then one atomic write. None when it is there already. */
function blockActions(env: InstallEnv, path: string, kind: BlockKind): Action[] {
  const before = readTextOrNull(path)
  const after = withBlock(before, kind)
  if (after === before) return []
  const change = before === null ? `create, ${lineCount(after)} lines` : `${lineCount(before)} -> ${lineCount(after)} lines`
  return [
    ...mkdirIfMissing(dirname(path)),
    ...backupIfFirst(env, path),
    { kind: 'write', path: writeTarget(path), content: after, mode: modeOf(path), summary: `add the kinfold PATH block (${change})` },
  ]
}

function blockRemovalActions(env: InstallEnv, path: string): Action[] {
  const before = readTextOrNull(path)
  if (before === null || !before.includes(BLOCK_START)) return []
  // The fish file is ours whole; anywhere else only the block goes.
  if (path === fishFile(env)) return [{ kind: 'remove', path, summary: 'the kinfold PATH file for fish' }]
  const after = withoutBlock(before)
  if (after === before) return []
  return [
    ...backupIfFirst(env, path),
    { kind: 'write', path: writeTarget(path), content: after, mode: modeOf(path), summary: `remove the kinfold PATH block (${lineCount(before)} -> ${lineCount(after)} lines)` },
  ]
}

/** Every file a block could be in: the recorded ones, and each shell's own, since the record can be lost and $SHELL can change. */
function candidateFiles(env: InstallEnv, saved: InstallRecord | null): string[] {
  const home = env.homeDir
  return [...new Set([
    ...(saved?.pathFiles ?? []),
    join(absoluteOr(env.envVars?.ZDOTDIR, home), '.zshrc'),
    join(home, '.zshrc'),
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    fishFile(env),
  ])]
}

/** What uninstall, and --no-path after an earlier yes, take back out. Only what is Kinfold's: a link that points elsewhere and a file without the marker stay. */
export function pathRemovalActions(env: InstallEnv, saved: InstallRecord | null): Action[] {
  const at = situationOf(env)
  if (at.windows) return saved?.pathSetup === 'added' ? [{ kind: 'windows-user-path', change: 'remove', dir: at.binDir }] : []
  const unlink: Action[] = linkState(at.link, at.program) === 'ours' ? [{ kind: 'unlink-command', path: at.link, target: at.program }] : []
  return [...unlink, ...candidateFiles(env, saved).flatMap((path) => blockRemovalActions(env, path))]
}

export interface PathRecordFields {
  pathSetup?: PathSetup
  pathLink?: string
  pathFiles?: readonly string[]
}

export interface PathPlan {
  actions: Action[]
  /** What install.json holds afterwards; empty leaves the field absent, which reads as "not asked yet". */
  record: PathRecordFields
  /** One line on what was done or why nothing was; null when the step had nothing to say. */
  summary: string | null
  /** What makes the command work in the terminal the install ran in (`source ~/.zshrc`, or the program's full path); null when nothing is needed. */
  activate: string | null
}

const recordedFields = (saved: InstallRecord): PathRecordFields => ({
  ...(saved.pathSetup !== undefined ? { pathSetup: saved.pathSetup } : {}),
  ...(saved.pathLink !== undefined ? { pathLink: saved.pathLink } : {}),
  ...(saved.pathFiles !== undefined ? { pathFiles: saved.pathFiles } : {}),
})

const NOTHING: PathPlan = { actions: [], record: {}, summary: null, activate: null }

/** Whether the wizard has a PATH question to ask: a change Kinfold can make, that nothing has answered yet. */
export function pathQuestionNeeded(env: InstallEnv, saved: InstallRecord | null, flag: PathFlag): boolean {
  const at = situationOf(env)
  if (at.skip !== null || flag !== null || saved?.pathSetup !== undefined || at.onPath) return false
  if (at.windows) return true
  return shellFiles(env).files.length > 0 && linkState(at.link, at.program) !== 'foreign'
}

export interface PathChoice {
  /** The wizard's answer; null when nothing was asked, which takes the default (yes). */
  answer: PathAnswer | null
  yes: boolean
  flag: PathFlag
  /** install.json is there but could not be read: an install exists, and what it chose is unknown. */
  recordUnreadable?: boolean
}

/**
 * The PATH step of one install. A saved choice is followed and nothing is
 * planned. A record from before this step existed is "not asked yet": under
 * --yes (the auto-updater's install included) nothing is added for it, so an
 * update never edits a shell file the person was not asked about.
 */
export function planPathSetup(env: InstallEnv, saved: InstallRecord | null, choice: PathChoice): PathPlan {
  const at = situationOf(env)
  if (at.skip !== null) return NOTHING
  if (choice.flag === 'no-path') return { actions: pathRemovalActions(env, saved), record: { pathSetup: 'declined' }, summary: 'kinfold command: not set up (--no-path)', activate: null }
  if (choice.flag === null && saved?.pathSetup !== undefined) return { ...NOTHING, record: recordedFields(saved) }
  // An unreadable record is an install too; treating it as a first one would edit a shell file unasked.
  if (choice.flag === null && (saved !== null || choice.recordUnreadable === true) && choice.yes) {
    return { ...NOTHING, summary: `kinfold command: not set up; run ${at.program} install in a terminal, or pass --path, to add it` }
  }
  const add = choice.flag === 'path' || choice.answer !== 'decline'
  return at.windows ? windowsPlan(at, add) : posixPlan(env, at, add)
}

function windowsPlan(at: Situation, add: boolean): PathPlan {
  if (at.onPath) return { actions: [], record: { pathSetup: 'not-needed' }, summary: `kinfold command: ${at.binDir} is on your PATH`, activate: null }
  if (!add) return { actions: [], record: { pathSetup: 'declined' }, summary: `kinfold command: PATH left alone; run it as ${at.program}`, activate: null }
  return {
    actions: [{ kind: 'windows-user-path', change: 'add', dir: at.binDir }],
    record: { pathSetup: 'added' },
    summary: `kinfold command: ${at.binDir} on your user PATH`,
    activate: at.program,
  }
}

function posixPlan(env: InstallEnv, at: Situation, add: boolean): PathPlan {
  const link = tilde(env, at.link)
  const state = linkState(at.link, at.program)
  if (state === 'foreign') {
    // A PATH block would only make that other program the one `kinfold` runs.
    return { actions: [], record: { pathSetup: 'not-needed' }, summary: `kinfold command: ${link} is not Kinfold's link and was left alone`, activate: null }
  }
  const linking: Action[] = state === 'ours' ? [] : [...mkdirIfMissing(at.binDir), { kind: 'link-command', path: at.link, target: at.program }]
  if (at.onPath) return { actions: linking, record: { pathSetup: 'not-needed', pathLink: at.link }, summary: `kinfold command: ${link}, which is on your PATH`, activate: null }
  const shell = shellFiles(env)
  if (shell.files.length === 0) {
    return { actions: linking, record: { pathSetup: 'declined', pathLink: at.link }, summary: `kinfold command: ${link}; to run it by name, add this to your shell's startup file: ${POSIX_LINE}`, activate: null }
  }
  if (!add) return { actions: linking, record: { pathSetup: 'declined', pathLink: at.link }, summary: `kinfold command: ${link}; PATH left alone, so run it by that path`, activate: null }
  const first = tilde(env, shell.files[0] as string)
  return {
    actions: [...linking, ...shell.files.flatMap((path) => blockActions(env, path, shell.kind))],
    record: { pathSetup: 'added', pathLink: at.link, pathFiles: shell.files },
    summary: `kinfold command: ${link}, with ~/.local/bin on PATH through ${shell.files.map((path) => tilde(env, path)).join(' and ')}`,
    activate: `source ${first}`,
  }
}

const WINDOWS_NAMES = ['kinfold.exe', 'kinfold.cmd', 'kinfold.bat', 'kinfold']

/** The first `kinfold` on the PATH this process runs with: what typing the name would start. */
function resolveOnPath(env: InstallEnv, windows: boolean): string | null {
  for (const dir of pathEntries(env, windows)) {
    for (const name of windows ? WINDOWS_NAMES : ['kinfold']) {
      const candidate = join(dir, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not there, or a link to nothing: the shell would skip it too.
      }
    }
  }
  return null
}

function realOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function missingReason(env: InstallEnv, at: Situation, saved: InstallRecord | null): string {
  if (at.skip === 'checkout') return 'not on PATH; a checkout has no installed program'
  if (at.skip === 'other-folder') return `not on PATH; it is linked only for an install in ~/${DATA_DIR_NAME} (run ${at.program} --data-dir ${env.dataDir})`
  if (saved?.pathSetup === undefined) return `not on PATH; run ${at.program} install in a terminal to add it`
  if (saved.pathSetup === 'declined') return 'not on PATH; PATH was left alone at install (kinfold install --path adds it)'
  if (saved.pathSetup === 'added') {
    const where = at.windows ? `${at.binDir} is on the user PATH` : `the PATH line is in ${(saved.pathFiles ?? []).map((path) => tilde(env, path)).join(' and ')}`
    return `not on PATH in this shell; open a new terminal (${where})`
  }
  if (!at.windows && linkState(at.link, at.program) === 'foreign') return `not on PATH; ${tilde(env, at.link)} is not Kinfold's link`
  return `not on PATH; ${at.windows ? at.binDir : '~/.local/bin'} is not on PATH any more (kinfold install --path adds it)`
}

/** Status: whether typing `kinfold` finds a program, and whether it is this install's. Reads only. */
export function commandStatusLine(env: InstallEnv, saved: InstallRecord | null): string {
  const at = situationOf(env)
  const found = resolveOnPath(env, at.windows)
  if (found === null) return `kinfold command: ${missingReason(env, at, saved)}`
  const ours = at.skip !== 'checkout' && realOf(found) === realOf(at.program)
  return `kinfold command: on PATH at ${found}${ours ? ' (this install)' : ", which is not this install's program"}`
}
