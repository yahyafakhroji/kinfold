// What a prompt becomes before it is matched against memory. Terms:
// lowercase words of three or more characters, minus common English and
// request words, each once, from the prompt with its agent wrappers stripped
// (prompt-text.ts). Past PROMPT_MAX_TERMS the user's own words are kept
// before pasted text, and inside each the repeated, then longer, words win:
// every term widens FTS5's any-term match, and a long paste once gave 16. The guard decides whether the prompt may leave the machine to be
// embedded: the redaction rules run in strict mode, and any hit, even one
// redaction would only flag, keeps the prompt local (the user's choice,
// 2026-10-26). Neither function logs or keeps the text.

import { ftsMatch } from '../mcp/fts'
import { redactText } from '../redaction/redact'
import { splitPrompt } from './prompt-text'
import { MAX_CONTEXT_PROMPT_CHARS } from './types'

/** Longer prompts are cut here before matching or embedding. */
export const MAX_PROMPT_CHARS = MAX_CONTEXT_PROMPT_CHARS
/** Terms a prompt is matched on; the MCP search, where an agent writes the query, keeps its own 16. */
export const PROMPT_MAX_TERMS = 8
/** Terms handed to the recall read, which keeps the rarest PROMPT_MAX_TERMS of them (recall-reads.ts chooseTerms). */
export const PROMPT_CANDIDATE_TERMS = 16
const MIN_TERM_CHARS = 3
const WORD = /[\p{L}\p{N}]+/gu

const STOPWORDS: ReadonlySet<string> = new Set(`
  the and for are but not you your yours with this that these those there their them they then than what when where which who whom why how
  can could would should will shall may might must have has had having does did doing done was were been being from into onto over under
  about after before again also just only very more most some such any all each both few other own same too out off our ours its it's
  i'm i've i'll let let's please thanks thank okay yes now here want need like make sure use using get got see look check tell show give
  try know think thing things way able going still well really much many lot something anything everything
`.trim().split(/\s+/))

interface Candidate {
  term: string
  own: boolean
  count: number
  first: number
}

function candidatesOf(text: string, own: boolean, offset: number, into: Map<string, Candidate>): number {
  const words = text.toLowerCase().match(WORD) ?? []
  words.forEach((word, index) => {
    if (word.length < MIN_TERM_CHARS || STOPWORDS.has(word)) return
    const known = into.get(word)
    if (known === undefined) into.set(word, { term: word, own, count: 1, first: offset + index })
    else into.set(word, { ...known, count: known.count + 1 })
  })
  return offset + words.length
}

const rank = (a: Candidate, b: Candidate): number =>
  Number(b.own) - Number(a.own) || b.count - a.count || b.term.length - a.term.length || a.first - b.first

/** Distinct match terms of a prompt: the best PROMPT_MAX_TERMS, in prompt order (own words first); empty when nothing is left to match on. */
export function promptTerms(prompt: string): string[] {
  return promptTermCandidates(prompt, PROMPT_MAX_TERMS)
}

/** As promptTerms, with room for the recall read to drop the common ones. */
export function promptTermCandidates(prompt: string, max: number = PROMPT_CANDIDATE_TERMS): string[] {
  const { own, pasted } = splitPrompt(prompt.slice(0, MAX_PROMPT_CHARS))
  const found = new Map<string, Candidate>()
  let offset = candidatesOf(own, true, 0, found)
  for (const part of pasted) offset = candidatesOf(part, false, offset, found)
  const kept = [...found.values()].sort(rank).slice(0, max)
  return kept.sort((a, b) => a.first - b.first).map((candidate) => candidate.term)
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
