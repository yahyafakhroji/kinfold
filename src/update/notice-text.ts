// The notice wording alone, with no file or installer imports: the hook and
// the OpenCode plugin load it, and neither may pull in the installer.

import type { UpdateNotice } from '../context/types'
import type { InstallChannel } from '../install/setup/record'

/** What the user types: the launcher's own command for npx and bunx, `kinfold update` for every other channel. */
export function updateCommand(channel: InstallChannel): string {
  return channel === 'npx' ? 'npx kinfold@latest' : channel === 'bunx' ? 'bunx kinfold@latest' : 'kinfold update'
}

export function availableMessage(notice: UpdateNotice): string {
  return `Kinfold ${notice.version} is available. Run \`${updateCommand(notice.channel)}\`.`
}

export function agentLine(notice: UpdateNotice): string {
  return `Kinfold ${notice.version} is out; you may tell the user they can run \`${updateCommand(notice.channel)}\`.`
}
