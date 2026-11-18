// What a login CLI said when it failed. A run that exits non-zero names only
// its exit code otherwise, and the cause seen live (an OAuth login that
// expired in the daemon's environment) needs the CLI's own words to be fixed.
// The text is one line of the CLI's error (a failed JSON result, or stderr),
// capped and run through the redactor, so a key it echoes never reaches a log.

import { randomBytes } from 'node:crypto'
import { isRecord } from '../../contract/event'
import { redactText } from '../../redaction/redact'
import { ObserverError, type ObserverErrorClass } from '../types'

export type CliErrorKind = Extract<ObserverErrorClass, 'auth_expired' | 'not_logged_in' | 'rate_limited'>

const MAX_TEXT_CHARS = 160

const KINDS: readonly (readonly [RegExp, CliErrorKind])[] = [
  [/\b(expired|could not be refreshed|refresh token)\b/i, 'auth_expired'],
  [/\b(not logged in|not signed in|log ?in again|please run \/login|invalid api key|failed to authenticate|unauthori[sz]ed|authentication (failed|required))\b/i, 'not_logged_in'],
  [/(rate.?limit|usage limit|too many requests|\b429\b|quota)/i, 'rate_limited'],
]

export function classifyCliError(text: string): CliErrorKind | null {
  return KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.replace(/[\u0000-\u001f\u007f]/g, '').trim()).find((line) => line !== '') ?? ''
}

const ERROR_EVENT_TYPES: ReadonlySet<string> = new Set(['error', 'turn.failed'])

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The JSON values in a CLI's stdout: one value, or one per line. A CLI can
 * print a notice line before its JSON, so lines that are not JSON are skipped.
 */
function jsonValues(stdout: string): unknown[] {
  const whole = parsed(stdout)
  if (whole !== undefined) return Array.isArray(whole) ? whole : [whole]
  return stdout.split(/\r?\n/).flatMap((line) => {
    const value = line.trim() === '' ? undefined : parsed(line)
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  })
}

/**
 * The message of an error object only: a result that reports is_error
 * (claude), or an error or failed-turn event (codex, opencode). Other
 * events carry session text, so they are never read.
 */
function errorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (value.is_error === true) return typeof value.result === 'string' ? value.result : null
  if (typeof value.type !== 'string' || !ERROR_EVENT_TYPES.has(value.type)) return null
  if (typeof value.message === 'string') return value.message
  const error = value.error
  if (typeof error === 'string') return error
  if (!isRecord(error)) return null
  if (typeof error.message === 'string') return error.message
  return isRecord(error.data) && typeof error.data.message === 'string' ? error.data.message : null
}

/** The message of the first error object in stdout, else the first stderr line. */
export function cliErrorText(stdout: string, stderr: string): string {
  for (const value of jsonValues(stdout)) {
    const message = errorMessage(value)
    if (message !== null && firstLine(message) !== '') return firstLine(message)
  }
  return firstLine(stderr)
}

/** One line, capped, with anything secret-shaped replaced; the throwaway key makes the markers unlinkable. */
export function cleanCliText(text: string): string {
  const capped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}...` : text
  return redactText(capped, 'cli_error', { hmacKey: randomBytes(32), entropyMode: 'strict' }).value
}

/** The failure for a CLI run that exited non-zero or reported an error: classified by its text when that names the cause. */
export function cliFailure(what: string, text: string, fallback: ObserverErrorClass = 'exit_nonzero'): ObserverError {
  const line = firstLine(text)
  if (line === '') return new ObserverError(fallback, what)
  return new ObserverError(classifyCliError(line) ?? fallback, `${what}: ${cleanCliText(line)}`)
}
