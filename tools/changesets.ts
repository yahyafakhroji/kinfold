// Changeset rules for CI and the version workflow.
//   bun tools/changesets.ts check <base-ref>   fails a pull request that changes
//     shipped code without a changeset, or adds an invalid one.
//   bun tools/changesets.ts plan               prints pending=<n> and version=<v>
//     for the version workflow (GITHUB_OUTPUT lines).
//   bun tools/changesets.ts notes <version>    prints that version's CHANGELOG.md
//     section, or a line saying there is none.
//   bun tools/changesets.ts digest <version>   prints one line per entry of that
//     section (its commit and first sentence), for the Version PR's body.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE = 'kinfold'
const BUMPS = new Set(['patch', 'minor', 'major'])
/** Paths whose change reaches a user: shipped code, installers, release tooling and packaging. */
const SHIPPED = [/^src\//, /^scripts\//, /^tools\//, /^npm\//, /^package\.json$/, /^bun\.lock$/, /^\.bun-version$/]
const TEST_FILE = /\.test\.[jt]s$/
/** The branch the version workflow pushes; its PR consumes changesets instead of adding one. */
const VERSION_BRANCH = /^changeset-release\//
export const NO_CHANGELOG = 'No changelog for this release.'

export interface PreState {
  mode: string
}

/** Markdown files changesets never reads as changesets. */
const IGNORED_MD = [/^readme\.md$/i, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^GEMINI\.md$/]

export interface FileChange {
  status: string
  path: string
}

export interface CheckInput {
  files: FileChange[]
  headRef: string
  baseRef: string
  read: (path: string) => string
}

export interface CheckResult {
  ok: boolean
  message: string
}

const isChangesetName = (name: string): boolean => name.endsWith('.md') && !name.startsWith('.') && !IGNORED_MD.some((pattern) => pattern.test(name))
const idOf = (name: string): string => name.slice(0, -'.md'.length)

/**
 * Changeset ids waiting for a Version PR. changesets 3 moves the ones a
 * prerelease used into .changeset/pre/; they count again once pre mode exits,
 * or when pre.json is gone, as after a beta merges into main.
 */
export function pendingChangesets(files: readonly string[], preFiles: readonly string[], pre: PreState | null): string[] {
  const top = files.filter(isChangesetName).map(idOf)
  const used = pre === null || pre.mode === 'exit' ? preFiles.filter(isChangesetName).map((name) => `pre/${idOf(name)}`) : []
  return [...top, ...used].sort()
}

export function changesetNeeded(paths: readonly string[]): boolean {
  return paths.some((path) => !TEST_FILE.test(path) && SHIPPED.some((pattern) => pattern.test(path)))
}

/** Null when the changeset names only kinfold with a bump and has a summary, or is empty. */
export function validateChangeset(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)^---\r?\n?([\s\S]*)$/m.exec(text)
  if (match === null || !text.startsWith('---')) return 'has no front matter; write it with bunx changeset'
  const entries = (match[1] ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (entries.length === 0) return null
  for (const entry of entries) {
    const parsed = /^\s*["']?([^"':]+)["']?\s*:\s*(\S+)\s*$/.exec(entry)
    if (parsed === null) return `has a line changesets cannot read: ${entry}`
    const [, name, bump] = parsed
    if (name !== PACKAGE) return `names ${name}; the only package is ${PACKAGE}`
    if (!BUMPS.has(bump ?? '')) return `has bump ${bump}; use patch, minor or major`
  }
  if ((match[2] ?? '').trim() === '') return 'has no summary; the summary is the changelog line'
  return null
}

export function parseNameStatus(text: string): FileChange[] {
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [status = '', ...rest] = line.split('\t')
    return { status: status.charAt(0), path: rest[rest.length - 1] ?? '' }
  })
}

const isChangeset = (path: string): boolean => /^\.changeset\/[^/]+$/.test(path) && isChangesetName(path.slice('.changeset/'.length))

export function checkPullRequest({ files, headRef, baseRef, read }: CheckInput): CheckResult {
  if (VERSION_BRANCH.test(headRef)) return { ok: true, message: 'the Version PR consumes changesets; nothing to check' }
  if (baseRef === 'main' && files.some((file) => file.path === '.changeset/pre.json' && file.status !== 'D')) {
    return { ok: false, message: 'main never enters pre mode; run changeset pre enter on the beta branch' }
  }
  // Only a new file counts: editing a changeset already on the base branch adds no release note for this change.
  const added = files.filter((file) => file.status === 'A' && isChangeset(file.path)).map((file) => file.path)
  for (const path of added) {
    const problem = validateChangeset(read(path))
    if (problem !== null) return { ok: false, message: `${path} ${problem}` }
  }
  if (added.length > 0) return { ok: true, message: `changeset: ${added.join(', ')}` }
  if (changesetNeeded(files.map((file) => file.path))) {
    return { ok: false, message: 'this change reaches users and has no changeset; add one with bunx changeset (bunx changeset --empty for a change with no release note)' }
  }
  return { ok: true, message: 'no shipped code changed; no changeset needed' }
}

/** The text under `## <version>` up to the next `## ` heading, or null. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return body === '' ? null : body
}

/** An entry's first sentence: up to the first `.`, `!` or `?` followed by a space or the end. */
function firstSentence(text: string): string {
  return /^(.+?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text
}

/**
 * A short form of a CHANGELOG section: each `### ... Changes` heading kept,
 * and each entry cut to its commit and first sentence. The full section stays
 * the CHANGELOG entry and the release notes; the Version PR only needs to say
 * what is in the release.
 */
export function changelogDigest(section: string): string {
  const out: string[] = []
  for (const line of section.split(/\r?\n/)) {
    if (line.startsWith('### ')) {
      if (out.length > 0) out.push('')
      out.push(line, '')
    } else if (line.startsWith('- ')) {
      out.push(`- ${firstSentence(line.slice(2).trim())}`)
    }
  }
  return out.join('\n').trim()
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

function readPre(dir: string): PreState | null {
  const path = join(dir, 'pre.json')
  if (!existsSync(path)) return null
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const mode = typeof parsed === 'object' && parsed !== null ? (parsed as { mode?: unknown }).mode : undefined
  if (typeof mode !== 'string') throw new Error('.changeset/pre.json has no mode')
  return { mode }
}

const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])

function main(argv: string[]): number {
  const root = join(import.meta.dir, '..')
  const [command, arg = ''] = argv
  if (command === 'check') {
    if (arg === '') throw new Error('usage: bun tools/changesets.ts check <base-ref>')
    const files = parseNameStatus(git(['diff', '--name-status', '--no-renames', `${arg}...HEAD`]))
    const result = checkPullRequest({
      files,
      headRef: process.env.GITHUB_HEAD_REF ?? '',
      baseRef: process.env.GITHUB_BASE_REF ?? 'main',
      read: (path) => readFileSync(join(root, path), 'utf8'),
    })
    ;(result.ok ? console.log : console.error)(result.message)
    return result.ok ? 0 : 1
  }
  if (command === 'plan') {
    const dir = join(root, '.changeset')
    const pending = pendingChangesets(listDir(dir), listDir(join(dir, 'pre')), readPre(dir))
    const version: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    if (typeof version !== 'string') throw new Error('package.json has no version')
    console.log(`pending=${pending.length}`)
    console.log(`version=${version}`)
    return 0
  }
  if (command === 'notes') {
    const path = join(root, 'CHANGELOG.md')
    console.log(changelogSection(existsSync(path) ? readFileSync(path, 'utf8') : '', arg) ?? NO_CHANGELOG)
    return 0
  }
  if (command === 'digest') {
    const path = join(root, 'CHANGELOG.md')
    const section = changelogSection(existsSync(path) ? readFileSync(path, 'utf8') : '', arg)
    console.log(section === null ? NO_CHANGELOG : changelogDigest(section))
    return 0
  }
  console.error('usage: bun tools/changesets.ts check <base-ref> | plan | notes <version> | digest <version>')
  return 2
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
