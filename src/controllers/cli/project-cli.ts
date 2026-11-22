// `kinfold project list | merge <old> <into> | split <key>`: which key a
// repo's memory lives under. A thin client of the daemon's /projects routes
// (src/controllers/daemon/project-routes.ts), as the data commands are of /data. Merge
// and split show what would move unless --yes is given. One repo under two
// keys merges on its own (same first commit); merge is for folders git
// cannot match, split undoes either.

import type { Parsed } from '../../resources/context/types'
import { type DataCliEnv, daemonCall } from '../data-control/cli'
import type { MaintenanceAnswer, ProjectListRow } from '../../resources/store/project-merge'

export type ProjectArgs =
  | { command: 'list' }
  | { command: 'merge'; from: string; into: string; yes: boolean }
  | { command: 'split'; key: string; yes: boolean }

const PROJECT_USAGE = 'usage: kinfold project list | merge <old> <into> [--yes] | split <key> [--yes]'
const EXIT_OK = 0
const EXIT_FAILED = 1

/** Null when argv is not a project command. */
export function parseProjectArgs(argv: readonly string[]): Parsed<ProjectArgs> | null {
  if (argv[0] !== 'project') return null
  const [sub, ...rest] = argv.slice(1)
  const yes = rest.includes('--yes')
  const words = rest.filter((word) => word !== '--yes')
  if (words.some((word) => word.startsWith('--'))) return { ok: false, error: PROJECT_USAGE }
  if (sub === 'list' && rest.length === 0) return { ok: true, value: { command: 'list' } }
  if (sub === 'merge' && words.length === 2) return { ok: true, value: { command: 'merge', from: words[0]!, into: words[1]!, yes } }
  if (sub === 'split' && words.length === 1) return { ok: true, value: { command: 'split', key: words[0]!, yes } }
  return { ok: false, error: PROJECT_USAGE }
}

export type ProjectCliEnv = Pick<DataCliEnv, 'dataDir' | 'fetch' | 'out'>

const count = (n: number, word: string): string => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`

function listLine(row: ProjectListRow): string {
  if (row.mergedInto !== null) return `${row.name}  ${row.key}  merged into ${row.mergedInto} (kinfold project split ${row.key} undoes it)`
  return `${row.name}  ${row.key}  ${count(row.memories, 'memory').replace('memorys', 'memories')}, ${count(row.sessions, 'session')}${row.held ? ', kept apart' : ''}`
}

const moved = (answer: Extract<MaintenanceAnswer, { ok: true }>): string =>
  Object.entries(answer.counts).filter(([, n]) => (n ?? 0) > 0).map(([table, n]) => `${table} ${n}`).join(', ') || 'nothing'

export async function runProjectCommand(env: ProjectCliEnv, args: ProjectArgs): Promise<number> {
  const answer = args.command === 'list'
    ? await daemonCall(env, 'GET', '/projects')
    : args.command === 'merge'
      ? await daemonCall(env, 'POST', '/projects/merge', { from: args.from, into: args.into, dryRun: !args.yes })
      : await daemonCall(env, 'POST', '/projects/split', { key: args.key, dryRun: !args.yes })
  if (!answer.ok) {
    env.out(`kinfold project: ${answer.error}`)
    return EXIT_FAILED
  }
  if (args.command === 'list') {
    const rows = (answer.body as { projects: ProjectListRow[] }).projects
    for (const row of rows) env.out(listLine(row))
    if (rows.length === 0) env.out('no projects yet')
    return EXIT_OK
  }
  const done = answer.body as Extract<MaintenanceAnswer, { ok: true }>
  if (done.dryRun) {
    const [from, to] = args.command === 'merge' ? [done.from, done.into] : [done.into, done.from]
    env.out(`dry run, nothing changed; would move ${moved(done)} from ${from} to ${to}`)
    env.out(`run again with --yes to ${args.command}`)
    return EXIT_OK
  }
  env.out(args.command === 'merge'
    ? `moved ${moved(done)} from ${done.from} to ${done.into}; kinfold project split ${done.from} undoes it`
    : `moved ${moved(done)} from ${done.into} back to ${done.from}; ${done.from} stays apart from now on`)
  return EXIT_OK
}
