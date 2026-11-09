// Flags for `kinfold daemon`. A service manager that cannot set environment
// variables for its program (a Windows scheduled task, for one) passes the
// port and a log file here instead. The LaunchAgent plist passes none, so a
// macOS daemon reads KINFOLD_PORT and logs to stderr as before.
// `--data-dir` is taken out earlier by applyDataDirFlag.

import { type PlatformInfo, currentPlatform } from '../platform/platform'

export interface DaemonArgs {
  /** Wins over KINFOLD_PORT when set. */
  port: number | null
  /** Every log line is appended here as well as to stderr. */
  logFile: string | null
}

const MIN_PORT = 1024
const MAX_PORT = 65_535

function portFrom(value: string | undefined): number {
  const port = Number(value)
  if (value === undefined || !/^\d+$/.test(value) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`kinfold daemon: --port takes ${MIN_PORT}-${MAX_PORT}`)
  }
  return port
}

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  let port: number | null = null
  let logFile: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--port') {
      port = portFrom(argv[index + 1])
      index += 1
    } else if (arg === '--log-file') {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new Error('kinfold daemon: --log-file takes a path')
      logFile = value
      index += 1
    } else {
      throw new Error(`kinfold daemon: unknown argument ${arg}`)
    }
  }
  return { port, logFile }
}

/** SIGHUP too, since a closed console or a session logout sends it; SIGBREAK is Ctrl+Break on Windows. */
export function shutdownSignalsFor(platform: PlatformInfo): readonly NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  return platform.os === 'windows' ? [...signals, 'SIGBREAK'] : signals
}

export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = shutdownSignalsFor(currentPlatform())
