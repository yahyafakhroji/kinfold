// Renders the agent support table in README.md from the install profiles, so
// the table can't drift from what install wires:
// `bun tools/gen-agent-table.ts` rewrites the section between the markers, and
// `--check` exits 1 when README.md differs from what the profiles render.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { builtProfiles } from '../src/agents/install-profiles'
import { type AgentProfile, type Capabilities, capabilitySummary } from '../src/agents/profile'
import type { OsName } from '../src/platform/platform'

export class AgentTableError extends Error {
  override name = 'AgentTableError'
}

export const README_PATH = join(import.meta.dir, '..', 'README.md')
export const SECTION_START = '<!-- agents:start -->'
export const SECTION_END = '<!-- agents:end -->'
/** The longest note that still reads as one line under the table on GitHub. */
export const SHORT_LIMIT_MAX = 120

const HEADER = ['Agent', 'Captures', 'Context', 'Search', 'Observer', 'Checked', 'Windows']
const CAPTURE_CELL: Readonly<Record<Capabilities['capture'], string>> = { full: 'yes', partial: 'tool results', none: 'no' }

function contextCell(context: Capabilities['context']): string {
  const parts = [context.sessionStart ? 'start' : null, context.prompt ? 'prompt' : null].filter((part) => part !== null)
  return parts.length === 0 ? 'no' : parts.join(', ')
}

function windowsCell(base: Capabilities, windows: Capabilities): string {
  if (isDeepStrictEqual(base, windows)) return 'same'
  const summary = capabilitySummary(windows)
  return summary === '' ? 'none' : summary
}

function noteOf(profile: AgentProfile, os: OsName): string | null {
  return profile.shortLimit?.(os) ?? profile.limit(os)
}

/** One row stands for macOS and Linux, so a profile that tells them apart has no honest row. */
function requireLinuxMatchesMacos(profile: AgentProfile): void {
  if (isDeepStrictEqual(profile.capabilities('macos'), profile.capabilities('linux')) && noteOf(profile, 'macos') === noteOf(profile, 'linux')) return
  throw new AgentTableError(`${profile.name} differs between macOS and Linux, and the table has one row for both; give it a Linux column first`)
}

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`

/** The table, then its numbered notes: each distinct note once, numbered in the order the rows first use it. */
export function renderAgentTable(profiles: readonly AgentProfile[]): string {
  const notes: string[] = []
  const marked = (cell: string, note: string | null): string => {
    if (note === null) return cell
    if (!notes.includes(note)) notes.push(note)
    return `${cell} <sup>${notes.indexOf(note) + 1}</sup>`
  }
  const rows = profiles.map((profile) => {
    requireLinuxMatchesMacos(profile)
    const caps = profile.capabilities('macos')
    const note = noteOf(profile, 'macos')
    const windowsNote = noteOf(profile, 'windows')
    return row([
      marked(profile.name, note),
      CAPTURE_CELL[caps.capture],
      contextCell(caps.context),
      caps.search ? 'yes' : 'no',
      caps.observer ? 'yes' : 'no',
      profile.verification,
      // The row's own note already covers Windows when the two are the same.
      marked(windowsCell(caps, profile.capabilities('windows')), windowsNote === note ? null : windowsNote),
    ])
  })
  const table = [row(HEADER), row(HEADER.map(() => '---')), ...rows].join('\n')
  return notes.length === 0 ? table : `${table}\n\n${notes.map((note, index) => `${index + 1}. ${note}`).join('\n')}`
}

export function replaceSection(readme: string, body: string): string {
  const start = readme.indexOf(SECTION_START)
  const end = readme.indexOf(SECTION_END)
  if (start === -1 || end < start) throw new AgentTableError(`README.md needs ${SECTION_START} followed by ${SECTION_END}`)
  return `${readme.slice(0, start + SECTION_START.length)}\n${body}\n${readme.slice(end)}`
}

if (import.meta.main) {
  try {
    // A checkout with CRLF endings holds the same table.
    const readme = readFileSync(README_PATH, 'utf8').replaceAll('\r\n', '\n')
    const next = replaceSection(readme, renderAgentTable(builtProfiles()))
    if (process.argv.includes('--check')) {
      if (next !== readme) {
        console.error('README.md agent table is out of date; run `bun tools/gen-agent-table.ts`')
        process.exitCode = 1
      }
    } else if (next !== readme) {
      writeFileSync(README_PATH, next)
      console.log('wrote the agent table to README.md')
    } else {
      console.log('README.md agent table is up to date')
    }
  } catch (error: unknown) {
    if (!(error instanceof AgentTableError)) throw error
    console.error(`agent table failed: ${error.message}`)
    process.exitCode = 1
  }
}
