// What every host adapter needs from its caller. Injected so tests can pin
// time and ids; the capture CLI and the OpenCode plugin use the defaults.

import { ulid } from '../contract/ulid'

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
