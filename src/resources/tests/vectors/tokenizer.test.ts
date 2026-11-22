import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWordPiece } from './tokenizer'
import { testModelDir } from './local-test-support'

const TINY = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', 'world', 'un', '##aff', '##able', ',', '!', 'cafe', '中'].join('\n')

describe('createWordPiece', () => {
  const tokenizer = createWordPiece(TINY, 8)

  test('wraps the pieces in CLS and SEP', () => {
    expect(tokenizer.encode('Hello world')).toEqual([2, 4, 5, 3])
  })

  test('splits a word into the longest pieces it can', () => {
    expect(tokenizer.encode('unaffable')).toEqual([2, 6, 7, 8, 3])
  })

  test('splits punctuation off and lowercases', () => {
    expect(tokenizer.encode('HELLO,world!')).toEqual([2, 4, 9, 5, 10, 3])
  })

  test('strips accents after lowercasing', () => {
    expect(tokenizer.encode('Café')).toEqual([2, 11, 3])
  })

  test('a word with no full split is one UNK', () => {
    expect(tokenizer.encode('unknown hello')).toEqual([2, 1, 4, 3])
  })

  test('each CJK character is its own word', () => {
    expect(tokenizer.encode('中中')).toEqual([2, 12, 12, 3])
  })

  test('truncates to the limit with SEP kept last', () => {
    const ids = tokenizer.encode('hello world hello world hello world hello world')
    expect(ids).toHaveLength(8)
    expect(ids[0]).toBe(2)
    expect(ids[7]).toBe(3)
  })

  test('empty text is CLS and SEP', () => {
    expect(tokenizer.encode('   ')).toEqual([2, 3])
  })
})

const modelDir = testModelDir()

describe.skipIf(modelDir === null)('the real vocabulary', () => {
  test('matches the reference tokenizer on every fixture', () => {
    const tokenizer = createWordPiece(readFileSync(join(modelDir!, 'vocab.txt'), 'utf8'), 512)
    const fixtures = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'test', 'minilm-reference.json'), 'utf8')) as { text: string; ids: number[] }[]
    for (const fixture of fixtures) expect({ text: fixture.text, ids: tokenizer.encode(fixture.text) }).toEqual({ text: fixture.text, ids: fixture.ids })
  })
})
