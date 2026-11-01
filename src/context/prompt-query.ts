// What a prompt becomes before it is matched against memory (P2-B). Terms:
// lowercase words of three or more characters, minus common English and
// request words, each once, at most MAX_QUERY_TERMS; FTS5 then matches any
// of them. The guard decides whether the prompt may leave the machine to be
// embedded: the redaction rules run in strict mode, and any hit, even one
// redaction would only flag, keeps the prompt local (the user's choice,
// 2026-10-26). Neither function logs or keeps the text.

import { MAX_QUERY_TERMS, ftsMatch } from '../mcp/fts'
import { redactText } from '../redaction/redact'
import { MAX_CONTEXT_PROMPT_CHARS } from './types'

/** Longer prompts are cut here before matching or embedding. */
export const MAX_PROMPT_CHARS = MAX_CONTEXT_PROMPT_CHARS
const MIN_TERM_CHARS = 3
const WORD = /[\p{L}\p{N}]+/gu

const STOPWORDS: ReadonlySet<string> = new Set(`
  the and for are but not you your yours with this that these those there their them they then than what when where which who whom why how
  can could would should will shall may might must have has had having does did doing done was were been being from into onto over under
  about after before again also just only very more most some such any all each both few other own same too out off our ours its it's
  i'm i've i'll let let's please thanks thank okay yes now here want need like make sure use using get got see look check tell show give
  try know think thing things way able going still well really much many lot something anything everything
`.trim().split(/\s+/))

/** Distinct match terms of a prompt, in prompt order; empty when nothing is left to match on. */
export function promptTerms(prompt: string): string[] {
  const words = prompt.slice(0, MAX_PROMPT_CHARS).toLowerCase().match(WORD) ?? []
  const terms = words.filter((word) => word.length >= MIN_TERM_CHARS && !STOPWORDS.has(word))
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS)
}

/** One MATCH expression for the search, plus one per term for counting matches. */
export function termMatches(terms: readonly string[]): { any: string; each: string[] } {
  return { any: ftsMatch(terms, 'any'), each: terms.map((term) => ftsMatch([term], 'any')) }
}

/** The key only shapes marker refs, which are thrown away; no real key is needed to find secrets. */
const THROWAWAY_KEY = 'prompt-guard'

/** The redaction rules that find or flag something in the prompt, sorted; rule ids only, safe to log. */
export function promptSecretRules(prompt: string): string[] {
  const { notes } = redactText(prompt.slice(0, MAX_PROMPT_CHARS), 'prompt', { hmacKey: THROWAWAY_KEY, entropyMode: 'strict' })
  return [...new Set(notes.map((note) => note.rule))].sort()
}

/** True when the redaction rules find or flag anything that looks like a secret. */
export function promptHasSecrets(prompt: string): boolean {
  return promptSecretRules(prompt).length > 0
}
