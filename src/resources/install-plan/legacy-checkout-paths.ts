// The paths a checkout install wrote before src/ was regrouped (0.6.1 and
// earlier). Agent configs, plugin files and service definitions written then
// still name them, so the installer treats an entry naming one as its own,
// and install or uninstall replaces or removes it, when the checkout it names
// now holds the current file. Another program's src/cli/hook.ts has no
// Kinfold beside it and stays someone else's.

import { existsSync } from 'node:fs'
import type { EntryRole } from './entry'

export const LEGACY_CHECKOUT_PATHS: {
  scripts: Readonly<Record<EntryRole, string>>
  cli: string
  pluginFiles: readonly string[]
} = {
  scripts: { hook: 'src/cli/hook.ts', mcp: 'src/mcp/server.ts', daemon: 'src/daemon/main.ts' },
  cli: 'src/cli/kinfold.ts',
  pluginFiles: ['src/plugins/opencode.ts', 'src/plugins/kilo.ts'],
}

/**
 * The checkout root a path names through `legacy`, when the path ends in it
 * and that root now holds `current`; null otherwise. Both are relative to
 * the checkout root, with forward slashes; `path` may use either separator.
 */
export function legacyCheckoutRoot(path: string, legacy: string, current: string): string | null {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized.endsWith(`/${legacy}`)) return null
  const root = path.slice(0, path.length - legacy.length - 1)
  return root !== '' && existsSync(`${root}/${current}`) ? root : null
}
