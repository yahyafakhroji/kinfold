// What every host adapter needs from its caller. Injected so tests can pin
// time and ids; the capture CLI and the OpenCode plugin use the defaults.

import { ulid } from '../../system/contract/ulid'

export interface AdapterContext {
  /** Neither host puts an event time on its hook payloads, so capture time stands in. */
  now: () => number
  newId: () => string
  hostVersion?: string
}

export function defaultAdapterContext(hostVersion?: string): AdapterContext {
  return { now: () => Date.now(), newId: () => ulid(), ...(hostVersion !== undefined ? { hostVersion } : {}) }
}

/** The payload is not something this adapter can map. The capture CLI logs it and exits 0. */
export class AdapterInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterInputError'
  }
}

/** A payload field when it is a string; an empty string is still a string. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A payload field when it is a string with something in it. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Turns a parser that throws AdapterInputError into one that answers null for a payload it cannot map. Any other error still throws. */
export function lenient<Args extends unknown[], Result>(parse: (...args: Args) => Result): (...args: Args) => Result | null {
  return (...args) => {
    try {
      return parse(...args)
    } catch (error: unknown) {
      if (error instanceof AdapterInputError) return null
      throw error
    }
  }
}
