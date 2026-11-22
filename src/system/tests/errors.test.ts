import { describe, expect, test } from 'bun:test'
import { errorCode, errorMessage, errorName } from './errors'

describe('error readers', () => {
  test('errorMessage reads an Error and turns anything else into text', () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(null)).toBe('null')
  })

  test('errorName never returns the message', () => {
    expect(errorName(new TypeError('secret path /x'))).toBe('TypeError')
    expect(errorName('secret path /x')).toBe('unknown error')
    expect(errorName(undefined, 'error')).toBe('error')
  })

  test('errorCode reads a string code and nothing else', () => {
    expect(errorCode(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorCode({ code: 'EEXIST' })).toBe('EEXIST')
    expect(errorCode(Object.assign(new Error('x'), { code: 7 }))).toBeUndefined()
    expect(errorCode(new Error('x'))).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
    expect(errorCode('ENOENT')).toBeUndefined()
  })
})
