import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SmokeError, ensurePortFree, homeForSmoke } from './smoke'

describe('homeForSmoke', () => {
  test('refuses a real home without GitHub Actions', () => {
    expect(() => homeForSmoke({ HOME: '/Users/example' })).toThrow(SmokeError)
  })

  test('allows a real home on GitHub Actions', () => {
    expect(homeForSmoke({ HOME: '/Users/example', GITHUB_ACTIONS: 'true' })).toBe('/Users/example')
  })

  test('refuses a temporary home without GitHub Actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'kinfold-smoke-test-'))
    try {
      expect(() => homeForSmoke({ HOME: root })).toThrow(SmokeError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a missing HOME', () => {
    expect(() => homeForSmoke({})).toThrow(SmokeError)
  })
})

describe('ensurePortFree', () => {
  test('refuses a port already in use', () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      expect(() => ensurePortFree(server.port)).toThrow(SmokeError)
    } finally {
      server.stop(true)
    }
  })
})
