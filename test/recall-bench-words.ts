// Made-up words for src/controllers/tests/daemon/recall.bench.test.ts and its load process: a
// fixed pseudo-random sequence over a 3,000-word vocabulary, Zipf-like, so a
// few words are everywhere and most are rare, as in real notes, and every run
// seeds the same store.

const VOCABULARY = 3_000
const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo', 'ze', 'pa', 'qu', 'dor', 'fen', 'gri', 'hal', 'jun', 'bex', 'cy', 'wo', 'yt']

const WORDS = Array.from({ length: VOCABULARY }, (_, index) => {
  let word = ''
  let n = index + 1
  while (n > 0) {
    word += SYLLABLES[n % SYLLABLES.length]
    n = Math.floor(n / SYLLABLES.length)
  }
  return word.length < 4 ? `${word}ix` : word
})

export interface Words {
  word(): string
  sentence(count: number): string
}

export function benchWords(seed: number): Words {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  const word = (): string => WORDS[Math.min(VOCABULARY - 1, Math.floor(VOCABULARY * next() ** 3))]!
  return { word, sentence: (count) => Array.from({ length: count }, word).join(' ') }
}
