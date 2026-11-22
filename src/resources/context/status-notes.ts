// Short-lived status notes: "Task 9 commit pushed", "CI run green", "PR #8
// checks pass". The observer writes them tool-verified, the strongest
// evidence, so they used to fill the top of a session pack, and they stop
// being true or useful within a day. A pack ranks them below every lasting
// memory and leaves them out after STATUS_NOTE_TTL_MS; they stay in the store
// and in search. The rule reads titles only, and stays narrow: a lasting
// lesson phrased like "Tests fail when HOME is real" is not a status.

export const STATUS_NOTE_TTL_MS = 24 * 60 * 60_000

const STATUS_WORD = '(?:green|red|pass|passes|passed|passing|fail|fails|failed|failing|ok)'
const TAIL = '(?:\\s+(?:on|in|for|at)\\s+[\\w#./-]+(?:\\s+[\\w#./-]+)?)?\\s*[.!]?$'

const STATUS_PATTERNS: readonly RegExp[] = [
  // Something was pushed: a commit, a branch, a fix.
  /\bpushed\b/i,
  // A pull request's state.
  /\b(?:pr|pull request)\s*#?\d+\b.*\b(?:merged|opened|open|created|approved|checks?|green|ready)\b/i,
  // A branch landing.
  /\bmerged\s+(?:in)?to\s+(?:main|master|beta|develop|dev)\b/i,
  // A run's outcome, said at the end of the title: "CI run green", "All tests pass on Windows CI".
  new RegExp(`\\b(?:ci|checks?|tests?|build|smoke|workflow|pipeline|run)\\b[^.;:]*\\b${STATUS_WORD}${TAIL}`, 'i'),
  // A numbered task's progress.
  /\btask\s*#?\d+\b.*\b(?:done|complete|completed|finished|committed|started)\b/i,
  /\bcommit(?:ted)?\b.*\b(?:landed|created)\b/i,
]

export function isStatusNote(title: string): boolean {
  return STATUS_PATTERNS.some((pattern) => pattern.test(title))
}

/** Whether a pack still carries the row: a status note only while it is fresh. */
export function stillCurrent(row: { title: string; occurredAt: number }, now: number): boolean {
  return !isStatusNote(row.title) || now - row.occurredAt <= STATUS_NOTE_TTL_MS
}
