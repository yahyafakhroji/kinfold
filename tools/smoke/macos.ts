// macOS runs the daemon as a LaunchAgent and keeps the database key in the
// keychain. The driver's own expect run and sh observer shim work here, so none
// of the optional hooks are defined.

import { posix } from 'node:path'
import type { SmokePlatform } from './platform'

const LAUNCH_AGENT_LABEL = 'dev.kinfold.daemon'

export const smokePlatform: SmokePlatform = {
  name: 'macos',
  programName: 'kinfold',
  keyStoreLabel: 'keychain',
  serviceLoaded(env) {
    const uid = process.getuid?.() ?? -1
    if (uid < 0) return true
    const result = Bun.spawnSync(['/bin/launchctl', 'print', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
      env: { ...env },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  },
  serviceFiles(home) {
    // macOS paths are POSIX; posix.join keeps the answer the same when the
    // shared tests run on Windows.
    return [posix.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)]
  },
}
