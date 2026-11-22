import { expect, test } from 'bun:test'
import { MAX_QUERY_TERMS } from '../../mcp/fts'
import { MAX_PROMPT_CHARS, PROMPT_MAX_TERMS, promptHasSecrets, promptSecretRules, promptTerms, termMatches } from '../../../resources/context/prompt-query'

test('terms are lowercase words of three or more characters, minus stopwords, each once, in prompt order', () => {
  expect(promptTerms('Can you please fix the Parser? The parser drops "quotes" in CSV v2')).toEqual(['fix', 'parser', 'drops', 'quotes', 'csv'])
  expect(promptTerms('ok, can you do it?')).toEqual([])
  expect(promptTerms('')).toEqual([])
})

test('terms are capped in count, and text past the prompt cap is ignored', () => {
  const many = Array.from({ length: MAX_QUERY_TERMS + 5 }, (_, i) => `word${i}`).join(' ')
  expect(PROMPT_MAX_TERMS).toBeLessThan(MAX_QUERY_TERMS)
  expect(promptTerms(many)).toHaveLength(PROMPT_MAX_TERMS)
  expect(promptTerms(`${'x'.repeat(MAX_PROMPT_CHARS)} hidden`)).not.toContain('hidden')
})

test('every term is quoted, so FTS syntax in a prompt is plain words', () => {
  expect(termMatches(['near', 'or'])).toEqual({ any: '"near" OR "or"', each: ['"near"', '"or"'] })
})

test('a prompt with a key-shaped value is flagged, and an ordinary one is not', () => {
  expect(promptHasSecrets(`here is the key sk-or-v1-${'a1b2c3d4'.repeat(8)}`)).toBe(true)
  expect(promptHasSecrets('API_KEY=Zx81kQpL0vN3mR7tY2wB5cD9fG4hJ6sA')).toBe(true)
  expect(promptHasSecrets('why does the parser drop quotes in csv files?')).toBe(false)
})

test('the guard names the rules that fired, once each, and none for a plain prompt', () => {
  expect(promptSecretRules('why does the parser drop quotes in csv files?')).toEqual([])
  const rules = promptSecretRules('API_KEY=Zx81kQpL0vN3mR7tY2wB5cD9fG4hJ6sA and API_KEY=Qw81kQpL0vN3mR7tY2wB5cD9fG4hJ6sB')
  expect(rules.length).toBeGreaterThan(0)
  expect(new Set(rules).size).toBe(rules.length)
  expect(rules.every((rule) => /^[a-z_]+$/.test(rule))).toBe(true)
})

test('wrapper tags and paste ids never become terms', () => {
  const terms = promptTerms('check this <pasted_content id="bb24">\nsqlite3mc build failed\n</pasted_content id="bb24">')
  expect(terms).toEqual(['sqlite3mc', 'build', 'failed'])
  for (const leak of ['pasted', 'content', 'bb24']) expect(terms).not.toContain(leak)
})

test('past the cap, the user\'s own words win over a paste, and in a paste the repeated and longer words win', () => {
  const paste = 'alpha beta gamma delta epsilon zeta theta iota kappa lambda migration migration migration schemaversion'
  const terms = promptTerms(`why the importer stalls on windows <pasted_content id="1">${paste}</pasted_content id="1">`)
  expect(terms).toHaveLength(PROMPT_MAX_TERMS)
  expect(terms.slice(0, 3)).toEqual(['importer', 'stalls', 'windows'])
  expect(terms).toContain('migration')
  expect(terms).toContain('schemaversion')
})
