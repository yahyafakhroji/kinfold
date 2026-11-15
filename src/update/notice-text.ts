// The notice wording alone, with no file or installer imports: the hook and
// the OpenCode plugin load it, and neither may pull in the installer.

import type { UpdateNotice } from '../context/types'
import type { InstallChannel } from '../install/setup/record'

/** What the user types: the launcher's own command for npx and bunx, `kinfold update` for every other channel. */
export function updateCommand(channel: InstallChannel): string {
  return channel === 'npx' ? 'npx kinfold@latest' : channel === 'bunx' ? 'bunx kinfold@latest' : 'kinfold update'
}

/** How this channel runs `install`, which is where auto-update is turned off from a terminal. */
export function installCommand(channel: InstallChannel): string {
  return channel === 'npx' ? 'npx kinfold@latest install' : channel === 'bunx' ? 'bunx kinfold@latest install' : 'kinfold install'
}

export function availableMessage(notice: UpdateNotice): string {
  return `Kinfold ${notice.version} is available. Run \`${updateCommand(notice.channel)}\`.`
}

function updatedText(notice: UpdateNotice): string {
  return `Kinfold updated itself to ${notice.version}${notice.previous === undefined ? '' : ` (was ${notice.previous})`}`
}

/** The line a person reads: Claude Code's systemMessage, the dashboard banner. */
export function userMessage(notice: UpdateNotice): string {
  if (notice.kind === 'updated') return `${updatedText(notice)}.`
  if (notice.kind === 'auto-on') return `Kinfold now installs patch releases on its own. To turn that off, run \`${installCommand(notice.channel)} --no-auto-update\` or use the dashboard.`
  return availableMessage(notice)
}

/** The line for an agent that has no user channel: it may pass the news on. */
export function agentLine(notice: UpdateNotice): string {
  if (notice.kind === 'updated') return `${updatedText(notice)}; you may tell the user.`
  if (notice.kind === 'auto-on') return `Kinfold now installs its own patch releases; you may tell the user that \`${installCommand(notice.channel)} --no-auto-update\` turns it off.`
  return `Kinfold ${notice.version} is out; you may tell the user they can run \`${updateCommand(notice.channel)}\`.`
}
