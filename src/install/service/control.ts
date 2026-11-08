// How the installer starts, stops and inspects Kinfold's background service.
// Everything platform-specific (launchctl, lsof, the plist) lives behind this
// interface, so the encrypt and update flows never name an OS tool.

import type { InstallEnv } from '../env'
import { LaunchAgentService } from './launch-agent-service'

export interface ServiceControl {
  /** Shown to the user: "LaunchAgent". */
  readonly label: string
  /** The service's config file exists. */
  isConfigured(): boolean
  /** The OS has the service loaded. */
  isRunning(): Promise<boolean>
  /** Loads and starts it; retries the busy exit as the install plan does. */
  start(): Promise<void>
  /** Stops and unloads it; resolves once the OS no longer runs it. */
  stop(): Promise<void>
  /** The data folder the service config names; null when not configured. */
  configuredDataDir(): string | null
  /** KINFOLD_PORT in the service config; null when unset. */
  configuredPort(): number | null
  /** Pids and command names holding a file, for a refusal message; '' when unknown. */
  fileHolders(path: string): Promise<string>
}

/** The service for this platform; null where none exists yet. */
export function serviceFor(env: InstallEnv): ServiceControl | null {
  return env.platform === 'darwin' ? new LaunchAgentService(env) : null
}

/** The injected service, else this platform's. An injected null means "no service". */
export function serviceOf(env: InstallEnv): ServiceControl | null {
  return env.service !== undefined ? env.service : serviceFor(env)
}
