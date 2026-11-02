// Replaces secrets with typed markers. The marker's ref is an HMAC of the value
// under a local key: the same secret always gets the same ref, so the observer
// can tell two mentions apart or together without ever seeing the value.
// The key changes every epoch (a UTC month), so a ref names its epoch:
// `e202610.1a2b3c4d`. Untagged refs (`1a2b3c4d`, everything written before
// key rotation, and still what epoch 0 writes) belong to epoch 0. `x.1a2b3c4d` came
// from a throwaway key because capture found no key on disk; it groups
// mentions within one event and can never be verified.

import { createHmac } from 'node:crypto'
import type { RedactionNote } from '../contract/event'
import {
  ENTROPY_TOKEN,
  type EntropyMode,
  FORMAT_RULES,
  PREFIXED_RULES,
  SECRET_KEY_NAME,
  looksLikeSecretValue,
  looksRandom,
} from './rules'

export interface RedactOptions {
  /** Read from the OS keychain in production; never stored with the data. */
  hmacKey: string | Uint8Array
  /** The key's epoch, written into every ref; 0 (the default) writes untagged refs. */
  epoch?: number
  /** 'keyed' (default) redacts unnamed random strings only next to secret-looking keys. */
  entropyMode?: EntropyMode
}

/** A marker key and the epoch it belongs to, as the capture path and the daemon hold it. */
export interface MarkerKey {
  hmacKey: string
  epoch: number
}

export interface Redacted<T> {
  value: T
  notes: RedactionNote[]
}

const REF_LENGTH = 8
/** The epoch of an `x.` ref: a throwaway key, never verifiable. */
export const UNKEYED_EPOCH = -1
const REF_PATTERN = /^(?:e([1-9][0-9]{0,8})\.|(x)\.)?([0-9a-f]{8})$/
const MARKER_REF = /<redacted type="[a-z_]+" ref="([^"]*)"\/>/g

export interface ParsedRef {
  epoch: number
  hex: string
}

export function secretRef(secret: string, hmacKey: string | Uint8Array): string {
  return createHmac('sha256', hmacKey).update(secret).digest('hex').slice(0, REF_LENGTH)
}

export function formatRef(hex: string, epoch: number): string {
  if (epoch === UNKEYED_EPOCH) return `x.${hex}`
  return epoch === 0 ? hex : `e${epoch}.${hex}`
}

/** Both forms: untagged refs read as epoch 0. Null for anything else. */
export function parseRef(ref: string): ParsedRef | null {
  const match = REF_PATTERN.exec(ref)
  if (match === null) return null
  const epoch = match[2] !== undefined ? UNKEYED_EPOCH : match[1] !== undefined ? Number(match[1]) : 0
  return { epoch, hex: match[3]! }
}

/** Every ref in the markers of `text`, parsed; unparseable refs are skipped. */
export function markerRefs(text: string): ParsedRef[] {
  return [...text.matchAll(MARKER_REF)].map((match) => parseRef(match[1]!)).filter((ref): ref is ParsedRef => ref !== null)
}

/** Whether `secret` is the value behind `ref`, given the key of the ref's epoch (null when unknown). */
export function refMatches(secret: string, ref: string, keyFor: (epoch: number) => string | null): boolean {
  const parsed = parseRef(ref)
  if (parsed === null || parsed.epoch === UNKEYED_EPOCH) return false
  const key = keyFor(parsed.epoch)
  return key !== null && secretRef(secret, key) === parsed.hex
}

function marker(rule: string, secret: string, options: RedactOptions): string {
  return `<redacted type="${rule}" ref="${formatRef(secretRef(secret, options.hmacKey), options.epoch ?? 0)}"/>`
}

function lineAround(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1
  const end = text.indexOf('\n', offset)
  return text.slice(start, end === -1 ? undefined : end)
}

export function redactText(input: string, field: string, options: RedactOptions): Redacted<string> {
  const counts = new Map<string, number>()
  const hit = (rule: string): void => {
    counts.set(rule, (counts.get(rule) ?? 0) + 1)
  }
  const mode = options.entropyMode ?? 'keyed'

  let text = input
  for (const rule of FORMAT_RULES) {
    text = text.replace(rule.pattern, (match: string) => {
      hit(rule.name)
      return marker(rule.name, match, options)
    })
  }
  for (const rule of PREFIXED_RULES) {
    text = text.replace(rule.pattern, (match: string, prefix: string, secret: string) => {
      if (rule.name === 'keyed_value' && !looksLikeSecretValue(secret)) return match
      hit(rule.name)
      return prefix + marker(rule.name, secret, options)
    })
  }
  text = text.replace(ENTROPY_TOKEN, (token: string, offset: number, whole: string) => {
    if (!looksRandom(token, mode)) return token
    if (mode === 'strict' || SECRET_KEY_NAME.test(lineAround(whole, offset))) {
      hit('high_entropy')
      return marker('high_entropy', token, options)
    }
    hit('high_entropy_flagged')
    return token
  })

  return { value: text, notes: [...counts].map(([rule, count]) => ({ field, rule, count })) }
}

/** Redacts every string in a JSON value, and whole values under secret-looking keys. */
export function redactJson(value: unknown, field: string, options: RedactOptions): Redacted<unknown> {
  const notes: RedactionNote[] = []

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      const result = redactText(node, path, options)
      notes.push(...result.notes)
      return result.value
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`))
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => {
          const childPath = `${path}.${key}`
          if (typeof child === 'string' && SECRET_KEY_NAME.test(key) && looksLikeSecretValue(child)) {
            notes.push({ field: childPath, rule: 'keyed_value', count: 1 })
            return [key, marker('keyed_value', child, options)]
          }
          return [key, walk(child, childPath)]
        }),
      )
    }
    return node
  }

  return { value: walk(value, field), notes }
}
