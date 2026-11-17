// One plain sentence per activity row. The daemon stores kinds, ids and
// counts only; the words are made here.

import { agentName, deviceName, plural } from './format'
import type { ActivityKind, ActivityRow } from './types'

/** What each summary error class means, in the words the page uses. */
export const PROBLEMS: Readonly<Record<string, string>> = {
  credential_missing: 'no API key was found',
  credential_error: 'the API key could not be read',
  cli_missing: 'its command-line tool is not installed',
  exit_nonzero: 'its command-line tool stopped with an error',
  timeout: 'the model took too long to answer',
  http_error: 'the model\'s service returned an error',
  bad_response: 'the model\'s service sent an answer Kinfold could not read',
  bad_output: 'the model\'s answer was not in the expected form',
  config_invalid: 'its settings are not valid',
  interrupted: 'the run was interrupted',
  internal: 'Kinfold hit an internal error',
  tool_attempt: 'the model tried to run a tool, so Kinfold stopped it',
  safety_check_failed: 'the model failed Kinfold\'s safety check',
  auth_expired: 'its sign-in expired',
  not_logged_in: 'its command-line tool is not signed in',
  rate_limited: 'the service asked Kinfold to slow down',
  other: 'something unexpected went wrong',
}

export function problemText(errorClass: string | null): string {
  return PROBLEMS[errorClass ?? 'other'] ?? PROBLEMS.other!
}

export const KIND_LABELS: Readonly<Record<ActivityKind, string>> = {
  recall: 'Memory recalled',
  save: 'Memories saved',
  summary: 'Turns summarized',
  'observer-failed': 'Summaries failed',
  backup: 'Backups',
  restore: 'Restores',
  'update-installed': 'Updates',
  'sign-in': 'Sign-ins',
  'device-paired': 'Devices joined',
}

const where = (row: ActivityRow): string => (row.project !== null ? ` in ${row.project}` : '')

export function activitySentence(row: ActivityRow, names: ReadonlyMap<string, string> = new Map()): string {
  const agent = agentName(row.host)
  const n = row.count ?? 0
  switch (row.kind) {
    case 'recall': return `${agent}${where(row)} was given ${plural(n, 'memory', 'memories')}`
    case 'save': return `${agent}${where(row)}: ${plural(n, 'new memory', 'new memories')} saved`
    case 'summary': return `${agent}${where(row)}: a turn was summarized`
    case 'observer-failed': return `Summaries for ${agent}${where(row)} failed: ${problemText(row.detail)}`
    case 'backup': return 'A backup was downloaded'
    case 'restore': return row.detail === 'undo' ? 'Kinfold switched back to the memory a restore replaced' : 'A backup was restored'
    case 'update-installed': return row.detail !== null ? `Kinfold ${row.detail} was installed` : 'An update was installed'
    case 'sign-in': return 'The dashboard was opened in a browser'
    case 'device-paired': return `${deviceName(row.device, names)} joined as a device`
  }
}
