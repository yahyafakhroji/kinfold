// The OpenCode wiring: one file in ~/.config/opencode/plugins/ that re-exports
// the checkout's plugin, like this project's .opencode/plugins shim. OpenCode
// 2.x loads every file in that directory by itself (claude-mem's installer
// relies on the same rule, and 2.x warns about file paths listed in
// opencode.json), so opencode.json and opencode.jsonc stay untouched.

// Shims written now carry SHIM_MARKER on their first line; a pre-rename
// install wrote LEGACY_SHIM_MARKER there.
import { LEGACY_SHIM_MARKER, SHIM_MARKER } from '../names'
const IMPORT_PATTERN = /export\s*\{\s*default\s*\}\s*from\s*"([^"]*\/src\/plugins\/opencode\.ts)"/

export type ShimState = 'yes' | 'no' | 'stale' | 'foreign'

export function shimContent(pluginEntry: string): string {
  return [
    `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`,
    '// OpenCode 2.x loads every plugin in this folder; the plugin itself lives in',
    '// the checkout below. Its default export must be { id, setup } and nothing else.',
    `export { default } from ${JSON.stringify(pluginEntry)};`,
    '',
  ].join('\n')
}

/** The plugin entry a Kinfold shim re-exports, or null when the text is not one. */
export function shimTarget(text: string): string | null {
  return IMPORT_PATTERN.exec(text)?.[1] ?? null
}

/** `foreign`: a file by our name that is not our shim; it is never overwritten or removed. */
export function inspectShim(text: string | null, pluginEntry: string): ShimState {
  if (text === null) return 'no'
  const target = shimTarget(text)
  if (target === null) return 'foreign'
  return target === pluginEntry ? 'yes' : 'stale'
}

/**
 * A file the migration may remove: it re-exports a checkout's plugin and its
 * first line carries our marker, new or legacy. Stricter than inspectShim, so
 * a hand-written file that happens to re-export the plugin is left alone.
 */
export function isOwnShim(text: string | null): boolean {
  if (text === null || shimTarget(text) === null) return false
  const first = text.split('\n', 1)[0] ?? ''
  return first.startsWith(`// ${SHIM_MARKER}:`) || first.startsWith(`// ${LEGACY_SHIM_MARKER}:`)
}
