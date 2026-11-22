// The behaviour every key store must share, run by each store's own test file
// over that store's fake backend. Test files only import this.

import { expect, test } from 'bun:test'
import type { KeyStore } from '../key-store'

export interface ContractSubject {
  store: KeyStore
  /** One line per backend call, argv only: what `ps` or a log could show. */
  observed(): readonly string[]
  /** The same store over a backend where every call fails. */
  failing(): KeyStore
}

const FIRST = 'contract-first-0123456789abcdef'
const SECOND = 'contract-second-fedcba9876543210'

function messageOf(action: () => unknown): string {
  try {
    action()
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a failure')
}

export function runKeyStoreContract(name: string, setup: () => ContractSubject, teardown?: () => void): void {
  const withSubject = (body: (subject: ContractSubject) => void) => () => {
    try {
      body(setup())
    } finally {
      teardown?.()
    }
  }

  test(`${name}: set then get returns the value`, withSubject(({ store }) => {
    store.set('openrouter', FIRST)
    expect(store.get('openrouter')).toBe(FIRST)
  }))

  test(`${name}: create never replaces an entry`, withSubject(({ store }) => {
    expect(store.create('db-key', FIRST)).toBe(true)
    expect(store.create('db-key', SECOND)).toBe(false)
    expect(store.get('db-key')).toBe(FIRST)
  }))

  test(`${name}: delete says whether there was an entry`, withSubject(({ store }) => {
    store.set('openrouter', FIRST)
    expect(store.delete('openrouter')).toBe(true)
    expect(store.delete('openrouter')).toBe(false)
  }))

  test(`${name}: exists reads no value`, withSubject(({ store, observed }) => {
    store.set('openrouter', FIRST)
    const before = observed().length
    expect(store.exists('openrouter')).toBe(true)
    const lines = observed().slice(before)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain(FIRST)
      expect(line.split(' ')).not.toContain('-w')
    }
  }))

  test(`${name}: a bad account name throws before the store is touched`, withSubject(({ store, observed }) => {
    expect(() => store.get('Bad Ref')).toThrow('credential ref must be a short lowercase name')
    expect(observed()).toEqual([])
  }))

  test(`${name}: a failing backend never shows the value`, withSubject(({ failing, observed }) => {
    const store = failing()
    const messages = [
      messageOf(() => store.get('openrouter')),
      messageOf(() => store.exists('openrouter')),
      messageOf(() => store.set('openrouter', FIRST)),
      messageOf(() => store.create('db-key', SECOND)),
      messageOf(() => store.delete('openrouter')),
    ]
    for (const text of [...messages, ...observed()]) {
      expect(text).not.toContain(FIRST)
      expect(text).not.toContain(SECOND)
    }
  }))
}
