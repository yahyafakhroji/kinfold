// <dataDir>/logs/install.log: every line an install or uninstall says, kept
// whatever the screen showed. On a terminal the plan runs behind a progress
// bar, so this file is where the numbered list with its paths, backups and
// [done] marks lives. Lines wait in memory until the logs folder exists (a
// first install makes it partway through its plan), and a dry run writes
// nothing, since a dry run changes nothing. It never holds a secret: a
// recovery code and a typed key go to the terminal only, never through here.

import { appendFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_FILE_MODE } from '../../resources/store/data-dir'

export const INSTALL_LOG_FILE = 'install.log'

export function installLogPath(dataDir: string): string {
  return join(dataDir, 'logs', INSTALL_LOG_FILE)
}

export interface InstallLog {
  add(line: string): void
  /** Appends what has gathered to the log in `dataDir`, once its logs folder is there. Never throws: a log must not fail an install. */
  flush(dataDir: string): void
}

export function createInstallLog(now: () => number, command: string, options: { dryRun: boolean }): InstallLog {
  const startedAt = now()
  let pending: string[] = []
  let headerWritten = false
  return {
    add(line) {
      if (!options.dryRun) pending.push(line)
    },
    flush(dataDir) {
      if (options.dryRun || pending.length === 0) return
      const path = installLogPath(dataDir)
      if (!existsSync(join(dataDir, 'logs'))) return
      try {
        const fresh = !existsSync(path)
        // A blank line sets each run apart from the one above it.
        const header = headerWritten ? '' : `${fresh ? '' : '\n'}=== kinfold ${command} ${new Date(startedAt).toISOString()} ===\n`
        appendFileSync(path, `${header}${pending.join('\n')}\n`, { mode: DATA_FILE_MODE })
        if (fresh) chmodSync(path, DATA_FILE_MODE)
        headerWritten = true
        pending = []
      } catch {
        // The lines stay in memory for the next flush; the install goes on.
      }
    },
  }
}
