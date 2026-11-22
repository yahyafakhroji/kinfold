// What a purge or retention change would remove, in plain words.

import { count } from './format'

export const COUNT_NAMES: Readonly<Record<string, [string, string]>> = {
  observations: ['memory', 'memories'],
  summaries: ['summary', 'summaries'],
  prompts: ['prompt', 'prompts'],
  events: ['captured event', 'captured events'],
  sessions: ['session', 'sessions'],
  injections: ['recall record', 'recall records'],
  injectionsTrimmed: ['recall record shortened', 'recall records shortened'],
  mcp_reads: ['search record', 'search records'],
  activity: ['activity entry', 'activity entries'],
  observer_runs: ['summary run', 'summary runs'],
  turn_usage: ['impact test turn', 'impact test turns'],
  context_packs: ['start pack', 'start packs'],
  projects: ['project', 'projects'],
  findings: ['leak finding', 'leak findings'],
  links: ['link between memories', 'links between memories'],
}

export function describeCounts(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([table, n]) => {
    const [one, many] = COUNT_NAMES[table] ?? [table, table]
    return `${count(n)} ${n === 1 ? one : many}`
  })
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}
