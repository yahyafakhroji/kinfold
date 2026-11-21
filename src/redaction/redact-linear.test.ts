// Redaction on long single-line input: the key-name patterns and the entropy
// pass must stay linear, and must still find exactly what the patterns they
// replaced found.

import { describe, expect, test } from 'bun:test'
import { lineVerdicts, redactText } from './redact'
import { PREFIXED_RULES, SECRET_KEY_NAME, looksLikeSecretValue } from './rules'

// The patterns as they were before they were made linear, kept here as the reference.
const OLD_KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)s?[A-Za-z0-9_.-]*|[A-Za-z0-9_]+_pwd`
const OLD_SECRET_KEY_NAME = new RegExp(String.raw`(?:^|[^A-Za-z0-9])(?:${OLD_KEY_NAME})(?:$|[^A-Za-z0-9])|^(?:${OLD_KEY_NAME})$`, 'i')
const OLD_KEYED_VALUE = new RegExp(String.raw`(\b(?:${OLD_KEY_NAME})\b\s*["']?\s*[:=]\s*["']?)([^\s"'\x60,;{}<>]+)`, 'gi')
const OLD_URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi

const PIECES = [
  'password', 'Passwd', 'secret', 'TOKEN', 'tokens', 'api_key', 'api-key', 'apikey', 'access_key', 'private-key', 'credential', 'credentials',
  '_pwd', 'db_pwd', 'pwd', 'PWD', 'max', 'name', 'a', 'B', '9', 's', '_', '.', '-', ' ', ' ', '=', ':', ': ', ' = ', '"', "'", '\n', ',', ';', '{', '}',
  'hunter2abc', 'abc123XYZ789', 'true', '$VAR', '4096', '/', '@', '@', '://', '://', 'https', 'postgres+ssl', 'user', 'host.example',
]

/** Deterministic, so a failure names the same text on every run. */
function samples(count: number, seed: number): string[] {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
    return state
  }
  return Array.from({ length: count }, () => Array.from({ length: 1 + (next() % 9) }, () => PIECES[next() % PIECES.length]!).join(''))
}

const keyedValue = PREFIXED_RULES.find((rule) => rule.name === 'keyed_value')!.pattern
const urlCredentials = PREFIXED_RULES.find((rule) => rule.name === 'url_credentials')!.pattern
const mark = (text: string, pattern: RegExp): string =>
  text.replace(pattern, (match: string, prefix: string, secret: string) => (looksLikeSecretValue(secret) ? `${prefix}<R ${secret}>` : match))

describe('the linear key-name patterns find what the old ones found', () => {
  const corpus = [
    ...samples(20_000, 7),
    'API_KEY', 'DATABASE_PASSWORD', 'github_token', 'client_secret', 'db_pwd', 'aws_access_key_id', 'author', 'PWD', 'keyboard', 'monkey', '__pwd', '_pwd', 'x_pwd9', 'x_pwd-',
    'export DB_PASSWORD="hunter2abc"', 'my.service.token: abc123XYZ789', 'token- = abc123XYZ789', 'db_pwd.token = abc123XYZ789', 'max_tokens=4096', 'a token_secret = abc123XYZ789 and x_pwd: hunter2abc',
  ]

  test('SECRET_KEY_NAME gives the same verdict on every sample', () => {
    const differing = corpus.filter((text) => SECRET_KEY_NAME.test(text) !== OLD_SECRET_KEY_NAME.test(text))
    expect(differing).toEqual([])
  })

  test('keyed_value redacts the same values in the same places on every sample', () => {
    const differing = corpus.filter((text) => mark(text, keyedValue) !== mark(text, OLD_KEYED_VALUE))
    expect(differing).toEqual([])
    expect(mark('export DB_PASSWORD="hunter2abc"', keyedValue)).toBe('export DB_PASSWORD="<R hunter2abc>"')
  })

  test('url_credentials redacts the same passwords in the same places on every sample', () => {
    const urls = ['postgres://user:hunter2abc@host.example/db', 'see https://user:hunter2abc@host.example and ftp://a:b@c', 'a://b:c+d://e:hunter2abc@g', '9x://user:hunter2abc@host', 'x.y-z+w://user:hunter2abc@host']
    const differing = [...corpus, ...urls].filter((text) => mark(text, urlCredentials) !== mark(text, OLD_URL_CREDENTIALS))
    expect(differing).toEqual([])
    expect(mark(urls[0]!, urlCredentials)).toBe('postgres://user:<R hunter2abc>@host.example/db')
  })
})

describe('the entropy pass asks about each line once', () => {
  test('every token on one long line shares one verdict; a new line gets its own', () => {
    const asked: string[] = []
    const text = `${'tok '.repeat(500)}\nsecond line\n${'more '.repeat(500)}`
    const verdict = lineVerdicts(text, (line) => {
      asked.push(line.slice(0, 6))
      return line.startsWith('second')
    })
    const answers: boolean[] = []
    // A token never starts on a line break, so those offsets are not asked.
    for (let offset = 0; offset < text.length; offset += 4) if (text[offset] !== '\n') answers.push(verdict(offset))
    expect(asked).toEqual(['tok to', 'second', 'more m'])
    expect(answers.filter(Boolean).length).toBeGreaterThan(0)
    expect(answers[0]).toBe(false)
    expect(answers.at(-1)).toBe(false)
    // An earlier offset still gets the right line, at the cost of asking again.
    expect(verdict(text.indexOf('second'))).toBe(true)
    expect(verdict(0)).toBe(false)
  })

  test('a random-looking value is still redacted only on a line that names a secret', () => {
    const value = 'q7Rz2Lm9Xb4Tn8Kd3Wf6Hs1Vc5Py0Ja'
    const out = redactText(`first ${value}\nthe token follows ${value}\nlast ${value}`, 'f', { hmacKey: 'k' })
    expect(out.value.split('\n').map((line) => line.includes(value))).toEqual([true, false, true])
    expect(out.notes).toContainEqual({ field: 'f', rule: 'high_entropy', count: 1 })
    expect(out.notes).toContainEqual({ field: 'f', rule: 'high_entropy_flagged', count: 2 })
  })
})

// Each of these took 6 s or more before (the audit measured 6.1 s, 27 s and 0.85 s growing fourfold per doubling);
// linear, they take tens of milliseconds. The budget is far above that, so a slow machine does not fail it, and far below the old cost.
describe('long single-line input is redacted in linear time', () => {
  const BUDGET_MS = 2_000
  const base64 = (bytes: number): string => {
    let state = 99
    return Buffer.from(Uint8Array.from({ length: bytes }, () => (state = (state * 1_103_515_245 + 12_345) & 0x7fffffff) & 0xff)).toString('base64')
  }
  const cases: [string, string][] = [
    ['a 400 KB base64 blob on one line', base64(300_000)],
    ['a 400 KB base64 blob on a line that names a token', `token ${base64(300_000)}`],
    ['a 200 KB dotted run', 'a.'.repeat(100_000)],
    ['a 200 KB dotted run after a key name', `password.${'a.'.repeat(100_000)}`],
    ['a 200 KB base64url blob', base64(150_000).replace(/\+/g, '-').replace(/\//g, '_')],
    ['a 200 KB run of key names', 'token.'.repeat(33_000)],
    ['a 200 KB underscore run', 'a_'.repeat(100_000)],
  ]
  test.each(cases)('%s', (_name, input) => {
    const startedAt = performance.now()
    const out = redactText(input, 'f', { hmacKey: 'k' })
    expect(performance.now() - startedAt).toBeLessThan(BUDGET_MS)
    expect(out.value.length).toBeGreaterThan(0)
  })
})
