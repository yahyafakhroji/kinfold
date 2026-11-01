// Near-duplicate detection for context packs. Two hosts often record the same
// fact in different words ("Test suite passes: 197 tests" from claude-code,
// "test suite: 197 tests passing" from opencode), and content_hash cannot see
// that. Titles are compared as sets of normalized tokens; a Jaccard score at
// or above the threshold means one fact. Stored rows are never rewritten: the
// merge happens only when a pack is built.

export const NEAR_DUPLICATE_THRESHOLD = 0.6

/** Number words become digits, so "three tests" and "3 tests" share a token. */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100',
}

/** Filler that carries no fact: articles, prepositions, auxiliaries, and connective words observers like. */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'across', 'into', 'via',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'all', 'now', 'has', 'have',
])

const SHORTEST_STEM = 3

/** Drops plural and verb endings so "passes", "passing" and "passed" meet at "pass". */
export function stem(word: string): string {
  const cut = (suffix: number): string => (word.length - suffix >= SHORTEST_STEM ? word.slice(0, -suffix) : word)
  if (word.endsWith('ing')) return cut(3)
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (/(ss|sh|ch|x|z)es$/.test(word)) return cut(2)
  if (word.endsWith('ed')) return cut(2)
  if (word.endsWith('s') && !word.endsWith('ss')) return cut(1)
  return word
}

/**
 * Lowercase, punctuation to spaces, number words to digits, noise words and
 * `ignore` (the project's own name, which every title in a pack could carry)
 * dropped, then stemmed.
 */
export function titleTokens(title: string, ignore: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  const words = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').split(' ')
  const tokens = words
    .filter((word) => word !== '')
    .map((word) => NUMBER_WORDS[word] ?? word)
    .filter((word) => !NOISE_WORDS.has(word) && !ignore.has(word))
    .map(stem)
  return new Set(tokens)
}

/** Tokens of a project name, so they can be ignored in that project's titles. */
export function nameTokens(name: string): ReadonlySet<string> {
  return new Set(name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word !== ''))
}

/** |A ∩ B| / |A ∪ B|; an empty set shares nothing (0), so blank titles never merge. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

export function isNearDuplicate(a: ReadonlySet<string>, b: ReadonlySet<string>, threshold: number = NEAR_DUPLICATE_THRESHOLD): boolean {
  return jaccard(a, b) >= threshold
}
