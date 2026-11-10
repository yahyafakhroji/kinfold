// The service a WSL distro linked to a Windows install sees: the Windows
// scheduled task, read through /mnt/c and never driven from here. Its daemon
// owns memory.db on the Windows drive, so start and stop always refuse.
//
// It counts as running whatever /health says, and it is never "unavailable":
// a daemon WSL cannot reach (NAT networking, a firewall) may still have
// memory.db open, and the commands that convert the store (encrypt, decrypt,
// rekey) only stop a running service they manage. Reporting it running and
// managed sends them to stop(), whose refusal ends them before anything is
// written; reporting it down or unavailable would let them convert a file the
// Windows daemon is writing.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InstallEnv } from '../install/env'
import { readTextOrNull } from '../install/files'
import type { ServiceControl, ServiceStep } from '../install/service/control'
import { taskDataDir, taskPort } from '../install/service/scheduled-task-service'
import { type WslLink, readWslLink, wslHomeDir } from './link'
import { isOnWindowsDrive } from './mcp-backend'
import { windowsToolPath } from './windows-install'

export const LINKED_SERVICE_REFUSAL = 'the daemon belongs to the Windows install; run this from Windows'
export const LINKED_SERVICE_LABEL = 'Windows scheduled task (from WSL)'

export class WslLinkedService implements ServiceControl {
  readonly label = LINKED_SERVICE_LABEL
  private readonly link: WslLink

  // The env is part of every service's constructor; this one reads only the link.
  constructor(_env: InstallEnv, link: WslLink) {
    this.link = link
  }

  private readXml(): string | null {
    try {
      // The task file is UTF-16LE; readTextOrNull decodes it.
      return readTextOrNull(this.link.taskConfig)
    } catch {
      return null
    }
  }

  isConfigured(): boolean {
    return existsSync(this.link.taskConfig)
  }

  async isRunning(): Promise<boolean> {
    return true
  }

  async start(): Promise<void> {
    throw new Error(LINKED_SERVICE_REFUSAL)
  }

  async stop(): Promise<void> {
    throw new Error(LINKED_SERVICE_REFUSAL)
  }

  /** As a WSL path: the link's own conversion when the task still names that folder. */
  configuredDataDir(): string | null {
    const xml = this.readXml()
    const windowsDir = xml === null ? null : taskDataDir(xml)
    if (windowsDir === null) return null
    return windowsDir === this.link.windowsDataDir ? this.link.dataDir : windowsToolPath(windowsDir)
  }

  configuredPort(): number | null {
    const xml = this.readXml()
    return xml === null ? null : taskPort(xml)
  }

  async fileHolders(_path: string): Promise<string> {
    return ''
  }

  configPath(): string | null {
    return null
  }

  configContent(_port: number): string | null {
    return null
  }

  describe(_step: ServiceStep): string {
    return LINKED_SERVICE_REFUSAL
  }

  unavailableReason(): string | null {
    return null
  }
}

/**
 * The linked service when this distro is linked and the command runs on a
 * folder the Windows daemon may hold: the linked one, or any folder on a
 * Windows drive. A separate Linux memory in a linked distro gets null, so it
 * keeps the plain Linux service.
 */
export function linkedServiceFor(env: InstallEnv): WslLinkedService | null {
  const link = readWslLink(wslHomeDir(env.homeDir))
  if (link === null) return null
  const windowsFolder = isOnWindowsDrive(env.dataDir) || resolve(env.dataDir) === resolve(link.dataDir)
  return windowsFolder ? new WslLinkedService(env, link) : null
}
