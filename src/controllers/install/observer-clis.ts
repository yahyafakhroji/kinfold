// Which observer providers this machine can run. A CLI provider runs its
// agent's own CLI, so it can be picked only where that CLI answered
// `--version`; the API providers need a key or an address and no CLI, so they are never missing. The
// agent step has already asked each CLI, and its detections are read here
// instead of asking again. Any installed CLI can observe any agent: an
// OpenCode session can be summarised through claude.

import { INSTALL_PROFILES } from '../agents/install-profiles'
import type { AgentId, ProfileTable } from '../agents/profile'
import type { ObserverProvider } from '../observer/types'
import { type HostDetection, detectFromSpec } from './detectors'
import { type InstallEnv, platformOf } from './env'

interface ProviderCli {
  /** The agent whose detection looked for the binary. */
  host: AgentId
  binary: string
}

/** The CLI each provider runs; a provider with no entry runs none. */
export const PROVIDER_CLI: Readonly<Partial<Record<ObserverProvider, ProviderCli>>> = {
  'claude-cli': { host: 'claude-code', binary: 'claude' },
  'codex-cli': { host: 'codex', binary: 'codex' },
  'opencode-cli': { host: 'opencode', binary: 'opencode' },
  'goose-cli': { host: 'goose', binary: 'goose' },
}

/** Each provider that cannot run here, with the reason shown beside it. */
export type MissingClis = ReadonlyMap<ObserverProvider, string>

export const notInstalled = (binary: string): string => `${binary} not installed`

/** An agent --hosts left out was never looked for, so its CLI is looked for here, once. */
async function detectionOf(env: InstallEnv, host: AgentId, detections: readonly HostDetection[], profiles: ProfileTable): Promise<HostDetection> {
  const known = detections.find((detection) => detection.host === host)
  if (known !== undefined && known.leftOut !== true) return known
  const { detection } = profiles[host]
  return typeof detection === 'function' ? detection(env, false) : detectFromSpec(env, host, detection, false)
}

export type Which = (binary: string, path: string) => string | null

/**
 * npm installs a CLI on Windows as a .cmd shim, which the version question
 * may fail to start while the observer runner, which reads the shim, runs it
 * fine. There a CLI on PATH counts as installed, so the list never turns
 * down a provider that would work.
 */
function onWindowsPath(env: InstallEnv, binary: string, which: Which): boolean {
  return platformOf(env).os === 'windows' && which(binary, env.pathEnv) !== null
}

export async function missingClis(
  env: InstallEnv,
  detections: readonly HostDetection[],
  profiles: ProfileTable = INSTALL_PROFILES,
  which: Which = (binary, path) => Bun.which(binary, { PATH: path }),
): Promise<MissingClis> {
  const missing = new Map<ObserverProvider, string>()
  for (const [provider, cli] of Object.entries(PROVIDER_CLI) as [ObserverProvider, ProviderCli][]) {
    const found = await detectionOf(env, cli.host, detections, profiles)
    if (found.binary === cli.binary || onWindowsPath(env, cli.binary, which)) continue
    missing.set(provider, found.binaryProblem ?? notInstalled(cli.binary))
  }
  return missing
}
