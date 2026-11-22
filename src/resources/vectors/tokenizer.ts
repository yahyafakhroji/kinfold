// BERT's uncased WordPiece tokenizer, the one all-MiniLM-L6-v2 was trained
// with, written out so the program carries no tokenizer library. It follows
// Hugging Face's BertTokenizer step by step: clean control characters, space
// out CJK characters, split on whitespace, lowercase, strip accents, split off
// punctuation, then the longest-match WordPiece with "##" continuations.
// test/minilm-reference.json holds the reference tokenizer's ids for texts
// that exercise each step.

export interface Tokenizer {
  /** Token ids wrapped in [CLS] and [SEP], at most maxTokens long. */
  encode(text: string): number[]
}

/** BertTokenizer's own bound: a longer word is one [UNK]. */
const MAX_WORD_CHARS = 100

const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch)
const isControl = (ch: string): boolean => ch !== '\t' && ch !== '\n' && ch !== '\r' && /[\p{Cc}\p{Cf}]/u.test(ch)

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  // BERT counts every non-alphanumeric ASCII character as punctuation, $ and ^ included.
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return /\p{P}/u.test(ch)
}

function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
}

function clean(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0)!
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue
    if (isWhitespace(ch)) out += ' '
    else if (isCjk(cp)) out += ` ${ch} `
    else out += ch
  }
  return out
}

function splitPunctuation(word: string): string[] {
  const parts: string[] = []
  let current = ''
  for (const ch of word) {
    if (isPunctuation(ch)) {
      if (current !== '') parts.push(current)
      parts.push(ch)
      current = ''
    } else current += ch
  }
  if (current !== '') parts.push(current)
  return parts
}

/** The basic tokenizer's words, before WordPiece. */
export function basicWords(text: string): string[] {
  return clean(text)
    .split(' ')
    .filter((word) => word !== '')
    .flatMap((word) => splitPunctuation(word.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '')))
}

/** Builds a tokenizer from vocab.txt: one token per line, the line number is its id. */
export function createWordPiece(vocabText: string, maxTokens: number): Tokenizer {
  const vocab = new Map<string, number>()
  vocabText.split(/\r?\n/).forEach((token, id) => {
    if (token !== '' && !vocab.has(token)) vocab.set(token, id)
  })
  const special = (token: string): number => {
    const id = vocab.get(token)
    if (id === undefined) throw new Error(`the vocabulary has no ${token}`)
    return id
  }
  const unk = special('[UNK]')
  const cls = special('[CLS]')
  const sep = special('[SEP]')

  const pieces = (word: string): number[] => {
    const chars = [...word]
    if (chars.length > MAX_WORD_CHARS) return [unk]
    const ids: number[] = []
    for (let start = 0; start < chars.length;) {
      let end = chars.length
      let found: number | undefined
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('')
        found = vocab.get(piece)
        if (found !== undefined) break
        end -= 1
      }
      if (found === undefined) return [unk]
      ids.push(found)
      start = end
    }
    return ids
  }

  return {
    encode: (text) => {
      const budget = maxTokens - 2
      const ids: number[] = []
      for (const word of basicWords(text)) {
        if (ids.length >= budget) break
        ids.push(...pieces(word))
      }
      return [cls, ...ids.slice(0, budget), sep]
    },
  }
}
