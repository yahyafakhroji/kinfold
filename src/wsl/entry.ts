// What install, status and uninstall do first when they run inside WSL. Each
// hook answers null to let the command go on as on plain Linux; no WSL
// behaviour exists yet, so every hook answers null.

import type { InstallEnv } from '../install/env'
import type { InstallOptions } from '../install/install'
import type { UninstallOptions } from '../install/uninstall'

export interface WslStatus {
  lines: string[]
  /** True: these lines are the whole status, and the plain Linux status is not printed. */
  replaces: boolean
}

/** An exit code ends the install there; null goes on with the plain install. */
export async function wslInstall(_env: InstallEnv, _options: InstallOptions): Promise<number | null> {
  return null
}

/** Lines printed before the status, or null for none. */
export async function wslStatus(_env: InstallEnv): Promise<WslStatus | null> {
  return null
}

/** An exit code ends the uninstall there; null goes on with the plain uninstall. */
export async function wslUninstall(_env: InstallEnv, _options: UninstallOptions): Promise<number | null> {
  return null
}
