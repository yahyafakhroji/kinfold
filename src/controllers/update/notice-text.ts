// The notice wording alone, with no file or installer imports: the hook and
// the OpenCode plugin load it, and neither may pull in the installer.

import type { UpdateNotice } from '../context/types'
import type { InstallChannel } from '../install/setup/record'

/** What the user types: the launcher's own command for npx and bunx, from npm's next tag for a beta; `kinfold update` for every other channel. */
export function updateCommand(channel: InstallChannel, prerelease: boolean = false): string {
  const tag = prerelease ? 'next' : 'latest'
  return channel === 'npx' ? `npx kinfold@${tag}` : channel === 'bunx' ? `bunx kinfold@${tag}` : 'kinfold update'
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** "3 changes, 1 breaking", or null when the counts are not known. */
function countsText(notice: UpdateNotice): string | null {
  if (notice.changes === undefined || notice.breaking === undefined) return null
  if (notice.changes === 0) return 'no changelog for this release'
  return notice.breaking === 0 ? plural(notice.changes, 'change') : `${plural(notice.changes, 'change')}, ${notice.breaking} breaking`
}

/** A staged release waiting for the user's yes. */
function offerMessage(notice: UpdateNotice): string {
  const counts = countsText(notice)
  return `Kinfold ${notice.version} is ready · ${counts === null ? '' : `${counts} · `}${updateCommand(notice.channel, notice.prerelease === true)} to install`
}

/** How this channel runs `install`, which is where auto-update is turned off from a terminal. */
export function installCommand(channel: InstallChannel): string {
  return channel === 'npx' ? 'npx kinfold@latest install' : channel === 'bunx' ? 'bunx kinfold@latest install' : 'kinfold install'
}

export function availableMessage(notice: UpdateNotice): string {
  const counts = countsText(notice)
  return `Kinfold ${notice.version} is available${counts === null ? '' : ` · ${counts}`}. Run \`${updateCommand(notice.channel, notice.prerelease === true)}\`.`
}

function updatedText(notice: UpdateNotice): string {
  return `Kinfold updated itself to ${notice.version}${notice.previous === undefined ? '' : ` (was ${notice.previous})`}`
}

/** The line a person reads: Claude Code's systemMessage, the dashboard banner. */
export function userMessage(notice: UpdateNotice): string {
  if (notice.kind === 'updated') return `${updatedText(notice)}.${notice.addCommand === undefined ? '' : ` Run ${notice.addCommand} install to add the kinfold command.`}`
  if (notice.kind === 'offer') return offerMessage(notice)
  if (notice.kind === 'auto-on') return `Kinfold now installs patch releases on its own. To turn that off, run \`${installCommand(notice.channel)} --no-auto-update\` or use the dashboard.`
  return availableMessage(notice)
}
