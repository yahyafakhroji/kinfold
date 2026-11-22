// The install wizard's central step, for `kinfold install --central <hub>`:
// once this device is installed, offer to use the hub's memory and, on a yes,
// join it with the code the hub showed. Without an answer to the question
// (no terminal and no --yes) or without a code, it says what to run instead.

import type { InstallEnv } from '../../resources/install-plan/env'
import { type CentralArgs, runCentralCommand, splitHub } from './cli'
import { DEFAULT_HUB_PORT } from './hub-server'
import { centralModeOf } from './mode'

export interface CentralOffer {
  hub: string
  code: string | null
  yes: boolean
  dryRun: boolean
}

const EXIT_FAILED = 1
const EXIT_USAGE = 2

export async function offerCentral(env: InstallEnv, offer: CentralOffer, join: (args: CentralArgs) => Promise<number> = (args) => runCentralCommand(env, args)): Promise<number> {
  const where = splitHub(offer.hub)
  if (where === null) {
    env.out(`--central takes the hub's Tailscale name or address, optionally with :<port>; got ${JSON.stringify(offer.hub)}`)
    return EXIT_USAGE
  }
  if (offer.dryRun) {
    env.out(`would offer central memory on ${offer.hub} (kinfold central join)`)
    return 0
  }
  const mode = centralModeOf(env.dataDir)
  if (mode?.role === 'device') {
    env.out(`This device already uses central memory on ${mode.hubName}.`)
    return 0
  }
  if (!offer.yes) {
    if (!env.io.interactive) {
      env.out(`To use central memory on ${offer.hub}, run kinfold central join ${offer.hub}.`)
      return 0
    }
    const answer = (await env.io.ask(`Use central memory on ${offer.hub}? This device's own memory is kept. [Y/n] `)).trim().toLowerCase()
    if (answer === 'n' || answer === 'no') {
      env.out(`Kept this device's own memory. kinfold central join ${offer.hub} switches later.`)
      return 0
    }
  }
  const code = offer.code ?? (env.io.interactive ? (await env.io.ask('Code from the hub (KF-XXXX-XXXX): ')).trim() : '')
  if (code === '') {
    env.out(`To use central memory on ${where.hub}, run kinfold central serve there for a code, then: kinfold central join ${offer.hub} (or install again with --central-code <code>).`)
    return EXIT_FAILED
  }
  // A code from --central-code was on the command line, and the join says so.
  return join({ command: 'join', hub: where.hub, port: where.port ?? DEFAULT_HUB_PORT, code, ...(offer.code !== null ? { codeInArgs: true as const } : {}) })
}
