// Turns an agent's search text into an FTS5 MATCH expression that cannot
// carry FTS syntax. Every term becomes a double-quoted string (inner quotes
// doubled), so `*`, `NEAR(`, `OR`, `^`, column filters and parentheses are
// plain words to the tokenizer. Terms with no letter or digit would quote to
// an empty phrase, so they are dropped; a query left with no terms is a usage
// error, never a match-everything.

export const MAX_QUERY_CHARS = 500
export const MAX_QUERY_TERMS = 16
export const MAX_TERM_CHARS = 64

const WORD_CHAR = /[\p{L}\p{N}]/u

export type FtsMode = 'all' | 'any'

export type FtsQuery = { ok: true; terms: string[] } | { ok: false; error: string }

function quote(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/** Splits on whitespace, keeps terms that hold a word character, caps count and length. */
export function parseSearchQuery(raw: string): FtsQuery {
  const text = raw.trim()
  if (text === '') return { ok: false, error: 'query must not be empty' }
  if (text.length > MAX_QUERY_CHARS) return { ok: false, error: `query must be at most ${MAX_QUERY_CHARS} characters` }
  const terms = text.split(/\s+/)
    .filter((term) => WORD_CHAR.test(term))
    .map((term) => term.slice(0, MAX_TERM_CHARS))
    .slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) return { ok: false, error: 'query must contain at least one word' }
  return { ok: true, terms }
}

/** `all`: every term must match (FTS5's implicit AND). `any`: one is enough; our own OR joins quoted strings. */
export function ftsMatch(terms: readonly string[], mode: FtsMode): string {
  return terms.map(quote).join(mode === 'all' ? ' ' : ' OR ')
}
