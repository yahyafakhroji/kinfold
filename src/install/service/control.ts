// How the installer starts, stops and inspects Kinfold's background service.
// Everything platform-specific (launchctl, lsof, the plist) lives behind this
// interface, so the install, encrypt and update flows never name an OS tool.

import { type InstallEnv, platformOf } from '../env'
import type { TextEncoding } from '../files'
import { LaunchAgentService } from './launch-agent-service'
import { ScheduledTaskService } from './scheduled-task-service'
import { SystemdUserService } from './systemd-service'

export type ServiceStep = 'start' | 'stop'

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
  /** The config file install writes; null where this service has none yet. */
  configPath(): string | null
  /** That file's content for this port; null where configPath is null. */
  configContent(port: number): string | null
  /** How install writes that file; absent means UTF-8. */
  readonly configEncoding?: TextEncoding
  /** The dry-run line for a step: the launchctl argv on macOS. */
  describe(step: ServiceStep): string
  /** Why install cannot set the service up here, for the manual-start line; null when it can. */
  unavailableReason(): string | null
}

/** The service for this platform. */
export function serviceFor(env: InstallEnv): ServiceControl {
  switch (platformOf(env).os) {
    case 'macos': return new LaunchAgentService(env)
    case 'linux': return new SystemdUserService(env)
    case 'windows': return new ScheduledTaskService(env)
  }
}

/** The injected service, else this platform's. An injected null means "no service". */
export function serviceOf(env: InstallEnv): ServiceControl | null {
  return env.service !== undefined ? env.service : serviceFor(env)
}

/**
 * serviceOf, with a service that cannot be set up here counted as none: the
 * callers that stop or start the daemon must never touch one they cannot run.
 */
export function managedServiceOf(env: InstallEnv): ServiceControl | null {
  const service = serviceOf(env)
  return service !== null && service.unavailableReason() === null ? service : null
}
