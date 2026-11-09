// The macOS LaunchAgent behind ServiceControl: launchctl for load and unload,
// lsof and ps for who holds a file, and a small reader for the plist
// plistContent writes.

import { existsSync, readFileSync } from 'node:fs'
import { envName } from '../../env-names'
import { type InstallEnv, installPaths } from '../env'
import { bootoutArgv, bootstrapArgv, isAgentLoaded, plistContent } from '../launch-agent'
import { HEALTH_WAIT_MS, runLaunchctl } from '../plan'
import type { ServiceControl, ServiceStep } from './control'

export const LSOF = '/usr/sbin/lsof'
export const PS = '/bin/ps'
/** bootout returns before launchd has finished; stop waits as long as the daemon's health wait for the job to go. */
export const STOP_RETRY_MS = 250
export const STOP_ATTEMPTS = Math.ceil(HEALTH_WAIT_MS / STOP_RETRY_MS)
const PROBE_TIMEOUT_MS = 5_000
const MAX_PORT = 65_535

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

/** One pass, so `&amp;lt;` reads back as `&lt;` and not as `<`. */
function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => XML_ENTITIES[name] ?? '')
}

/** The string and integer entries of the plist's EnvironmentVariables dict. */
function environmentVariables(plist: string): Map<string, string> {
  const found = new Map<string, string>()
  const start = plist.indexOf('<key>EnvironmentVariables</key>')
  if (start < 0) return found
  const end = plist.indexOf('</dict>', start)
  const section = plist.slice(start, end < 0 ? undefined : end)
  for (const match of section.matchAll(/<key>([^<]*)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g)) {
    found.set(unescapeXml(match[1] ?? ''), unescapeXml(match[3] ?? ''))
  }
  return found
}

export class LaunchAgentService implements ServiceControl {
  readonly label = 'LaunchAgent'

  constructor(private readonly env: InstallEnv) {}

  private get plistPath(): string {
    return installPaths(this.env).launchAgentPlist
  }

  isConfigured(): boolean {
    return existsSync(this.plistPath)
  }

  isRunning(): Promise<boolean> {
    return isAgentLoaded(this.env)
  }

  start(): Promise<void> {
    return runLaunchctl(this.env, bootstrapArgv(this.env))
  }

  async stop(): Promise<void> {
    const { exitCode } = await this.env.run({ argv: bootoutArgv(this.env.uid), timeoutMs: 15_000 })
    for (let attempt = 1; await this.isRunning(); attempt += 1) {
      if (attempt >= STOP_ATTEMPTS) throw new Error(`the ${this.label} is still loaded after bootout (exit ${exitCode})`)
      await this.env.sleep(STOP_RETRY_MS)
    }
  }

  private readEnvironment(): Map<string, string> | null {
    try {
      return environmentVariables(readFileSync(this.plistPath, 'utf8'))
    } catch {
      return null
    }
  }

  configuredDataDir(): string | null {
    const value = this.readEnvironment()?.get(envName('DATA_DIR'))
    return value === undefined || value === '' ? null : value
  }

  configuredPort(): number | null {
    const value = this.readEnvironment()?.get(envName('PORT'))
    if (value === undefined || !/^\d+$/.test(value)) return null
    const port = Number(value)
    return port >= 1 && port <= MAX_PORT ? port : null
  }

  configPath(): string {
    return this.plistPath
  }

  configContent(port: number): string {
    return plistContent(this.env, port)
  }

  describe(step: ServiceStep): string {
    return (step === 'start' ? bootstrapArgv(this.env) : bootoutArgv(this.env.uid)).join(' ')
  }

  unavailableReason(): string | null {
    return null
  }

  async fileHolders(path: string): Promise<string> {
    const listed = await this.env.run({ argv: [LSOF, '-t', path], timeoutMs: PROBE_TIMEOUT_MS })
    const pids = listed.stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line) && Number(line) !== process.pid)
    if (pids.length === 0) return ''
    const names = await this.env.run({ argv: [PS, '-o', 'pid=,comm=', '-p', pids.join(',')], timeoutMs: PROBE_TIMEOUT_MS })
    return names.stdout.trim().split('\n').map((line) => line.trim()).filter((line) => line !== '').join('; ')
  }
}
