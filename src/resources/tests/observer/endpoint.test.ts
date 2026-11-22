import { describe, expect, test } from 'bun:test'
import { DASHSCOPE_DEFAULT_ENDPOINT, checkEndpoint, isLoopbackEndpoint } from '../../observer/endpoint'

describe('checkEndpoint for the OpenAI-compatible provider', () => {
  test.each([
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['  http://127.0.0.2:9000  ', 'http://127.0.0.2:9000'],
  ])('%s is kept as %s', (input, expected) => {
    expect(checkEndpoint('openai-compatible', input)).toEqual({ ok: true, value: expected })
  })

  test.each([
    ['http://example.com/v1', 'the endpoint must use https unless it is on this machine (127.0.0.1, ::1 or localhost)'],
    ['http://192.168.1.20:11434/v1', 'the endpoint must use https unless it is on this machine (127.0.0.1, ::1 or localhost)'],
    ['ftp://127.0.0.1/v1', 'the endpoint must be an http or https URL'],
    ['not a url', 'the endpoint must be an http or https URL'],
    ['https://user:secret@api.example.com/v1', 'the endpoint must not carry a user name or password'],
    ['https://api.example.com/v1?key=abc', 'the endpoint must not carry a query or a fragment'],
    ['https://api.example.com/v1#x', 'the endpoint must not carry a query or a fragment'],
    ['', 'the endpoint must be an http or https URL'],
  ])('%s is refused', (input, error) => {
    const result = checkEndpoint('openai-compatible', input)
    expect(result).toEqual({ ok: false, error })
    // A refusal never quotes the URL, which may carry a secret.
    if (!result.ok && input !== '') expect(result.error).not.toContain(input.trim())
  })

  test('a long endpoint is refused', () => {
    expect(checkEndpoint('openai-compatible', `https://a.example.com/${'x'.repeat(600)}`)).toEqual({ ok: false, error: 'the endpoint must be at most 500 characters' })
  })
})

describe('checkEndpoint for qwen-api', () => {
  test('a DashScope URL in any region, or a Model Studio workspace host, is kept', () => {
    expect(checkEndpoint('qwen-api', DASHSCOPE_DEFAULT_ENDPOINT)).toEqual({ ok: true, value: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' })
    expect(checkEndpoint('qwen-api', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toMatchObject({ ok: true })
    expect(checkEndpoint('qwen-api', 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1')).toMatchObject({ ok: true })
    expect(checkEndpoint('qwen-api', 'https://ws-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')).toMatchObject({ ok: true })
  })

  // Other aliyuncs.com hosts belong to customers: an OSS bucket or a Function Compute endpoint.
  test.each(['https://api.example.com/v1', 'http://127.0.0.1:8080/v1', 'https://aliyuncs.com.example.com/v1', 'https://evilaliyuncs.com/v1', 'https://bucket.oss-cn-hangzhou.aliyuncs.com/v1', 'https://123.cn-hangzhou.fc.aliyuncs.com/v1', 'https://a.b.c.maas.aliyuncs.com/v1'])('%s is refused', (input) => {
    expect(checkEndpoint('qwen-api', input)).toEqual({ ok: false, error: 'the Qwen endpoint must be an https DashScope or Model Studio URL' })
  })
})

test('isLoopbackEndpoint is true only for an address on this machine', () => {
  expect(isLoopbackEndpoint('http://127.0.0.1:11434/v1')).toBe(true)
  expect(isLoopbackEndpoint('http://localhost:1234/v1')).toBe(true)
  expect(isLoopbackEndpoint('http://[::1]:1/v1')).toBe(true)
  expect(isLoopbackEndpoint('https://api.groq.com/openai/v1')).toBe(false)
  expect(isLoopbackEndpoint('nope')).toBe(false)
})
