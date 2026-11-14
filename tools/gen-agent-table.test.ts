import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { builtProfiles } from '../src/agents/install-profiles'
import type { AgentProfile, Capabilities } from '../src/agents/profile'
import type { OsName } from '../src/platform/platform'
import { AgentTableError, README_PATH, SHORT_LIMIT_MAX, renderAgentTable, replaceSection } from './gen-agent-table'

const FULL: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }
const SEARCH_ONLY: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }
const NOTHING: Capabilities = { ...SEARCH_ONLY, search: false }

type PerOs<T> = T | Partial<Record<OsName, T>>

function perOs<T>(value: PerOs<T>, fallback: T): (os: OsName) => T {
  const isMap = typeof value === 'object' && value !== null && ('macos' in value || 'linux' in value || 'windows' in value)
  return (os) => (isMap ? ((value as Partial<Record<OsName, T>>)[os] ?? fallback) : (value as T))
}

function fake(name: string, caps: PerOs<Capabilities>, limit: PerOs<string | null> = null, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'claude-code',
    name,
    family: 'custom',
    verification: 'docs',
    capabilities: perOs(caps, FULL),
    limit: perOs(limit, null),
    detection: { binaries: [] },
    wiring: { install: async () => [], uninstall: () => [], state: () => 'no', line: () => '' },
    manualSteps: () => [],
    ...extra,
  }
}

const rows = (table: string): string[] => table.split('\n').filter((line) => line.startsWith('| ')).slice(2)

test('each cell comes from the capabilities and the verification', () => {
  const table = renderAgentTable([
    fake('Alpha', { ...FULL, observer: true }, null, { verification: 'live' }),
    fake('Beta', { capture: 'partial', context: { sessionStart: true, prompt: false }, search: false, observer: false }),
    fake('Gamma', { ...SEARCH_ONLY, context: { sessionStart: false, prompt: true } }),
    fake('Delta', SEARCH_ONLY),
  ])
  expect(table.split('\n').slice(0, 2)).toEqual(['| Agent | Captures | Context | Search | Observer | Checked | Windows |', '| --- | --- | --- | --- | --- | --- | --- |'])
  expect(rows(table)).toEqual([
    '| Alpha | yes | start, prompt | yes | yes | live | same |',
    '| Beta | tool results | start | no | no | docs | same |',
    '| Gamma | no | prompt | yes | no | docs | same |',
    '| Delta | no | no | yes | no | docs | same |',
  ])
})

test('the Windows cell says same, search only or none, and spells out anything else', () => {
  const table = renderAgentTable([
    fake('Alpha', { windows: SEARCH_ONLY }),
    fake('Beta', { windows: NOTHING }),
    fake('Gamma', { windows: { ...FULL, context: { sessionStart: true, prompt: false } } }),
  ])
  expect(rows(table).map((row) => row.split(' | ').at(-1))).toEqual(['search only |', 'none |', 'captures, context at start, search |'])
})

test('notes are numbered by first appearance, shared text shares a number, and a Windows note marks the Windows cell only when it differs', () => {
  const table = renderAgentTable([
    fake('Alpha', FULL, 'Needs a plugin.'),
    fake('Beta', { windows: SEARCH_ONLY }, { windows: 'Hooks are off on Windows.' }),
    fake('Gamma', { windows: SEARCH_ONLY }, { macos: 'Needs a plugin.', linux: 'Needs a plugin.', windows: 'Hooks are off on Windows.' }),
  ])
  expect(rows(table)).toEqual([
    '| Alpha <sup>1</sup> | yes | start, prompt | yes | no | docs | same |',
    '| Beta | yes | start, prompt | yes | no | docs | search only <sup>2</sup> |',
    '| Gamma <sup>1</sup> | yes | start, prompt | yes | no | docs | search only <sup>2</sup> |',
  ])
  expect(table.endsWith('\n\n1. Needs a plugin.\n2. Hooks are off on Windows.')).toBe(true)
})

test('a short limit stands in for the limit text', () => {
  const table = renderAgentTable([fake('Alpha', FULL, 'a long story about why', { shortLimit: () => 'Short.' })])
  expect(table).toContain('1. Short.')
  expect(table).not.toContain('long story')
})

test('a table with no notes ends at its last row', () => {
  expect(renderAgentTable([fake('Alpha', FULL)]).endsWith('| same |')).toBe(true)
})

test('a profile whose Linux differs from macOS is refused, since one row stands for both', () => {
  expect(() => renderAgentTable([fake('Alpha', { linux: SEARCH_ONLY })])).toThrow(AgentTableError)
  expect(() => renderAgentTable([fake('Alpha', FULL, { linux: 'Linux only.' })])).toThrow(AgentTableError)
})

test('the section between the markers is replaced and the rest is kept', () => {
  const readme = 'before\n<!-- agents:start -->\nold\n<!-- agents:end -->\nafter\n'
  expect(replaceSection(readme, 'new')).toBe('before\n<!-- agents:start -->\nnew\n<!-- agents:end -->\nafter\n')
  expect(replaceSection(replaceSection(readme, 'new'), 'new')).toBe(replaceSection(readme, 'new'))
})

test('a README without both markers, in order, is refused', () => {
  expect(() => replaceSection('no markers', 'new')).toThrow(AgentTableError)
  expect(() => replaceSection('<!-- agents:end -->\n<!-- agents:start -->', 'new')).toThrow(AgentTableError)
})

test('every profile with a limit has a short one for the same OS, within the length a table note can carry', () => {
  for (const profile of builtProfiles()) {
    for (const os of ['macos', 'linux', 'windows'] as const) {
      const short = profile.shortLimit?.(os) ?? null
      expect({ id: profile.id, os, hasShort: short !== null }).toEqual({ id: profile.id, os, hasShort: profile.limit(os) !== null })
      expect({ id: profile.id, os, fits: (short ?? '').length <= SHORT_LIMIT_MAX }).toEqual({ id: profile.id, os, fits: true })
    }
  }
})

test('README.md carries the table the profiles render; run `bun tools/gen-agent-table.ts` after changing a profile', () => {
  const readme = readFileSync(README_PATH, 'utf8').replaceAll('\r\n', '\n')
  expect(replaceSection(readme, renderAgentTable(builtProfiles()))).toBe(readme)
})
