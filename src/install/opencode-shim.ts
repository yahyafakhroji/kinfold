// The OpenCode wiring: one file in ~/.config/opencode/plugins/. A checkout
// install writes a shim that sets the data folder and loads the checkout's
// plugin; a program install writes the plugin bundle
// it carries, so no path points into a checkout or a cache. OpenCode 2.x loads
// every file in that directory by itself (claude-mem's installer relies on the
// same rule, and 2.x warns about file paths listed in opencode.json), so
// opencode.json and opencode.jsonc stay untouched.

// Shims written now carry SHIM_MARKER on their first line; a pre-rename
// install wrote LEGACY_SHIM_MARKER there. A program-mode file carries the same
// marker and the bundle, with no re-export, and is recognised by the marker.
import { join } from 'node:path'
import { LEGACY_SHIM_MARKER, SHIM_MARKER } from '../names'
import type { InstallMode } from './entry'

// The form written before the shim carried a data folder: a bare re-export.
const REEXPORT_PATTERN = /export\s*\{\s*default\s*\}\s*from\s*"([^"]*\/src\/plugins\/opencode\.ts)"/
// The current form loads the plugin with a dynamic import.
const IMPORT_PATTERN = /await\s+import\(\s*("(?:[^"\\]|\\.)*")\s*\)/
const PLUGIN_SUFFIX = '/src/plugins/opencode.ts'

export type ShimState = 'yes' | 'no' | 'stale' | 'foreign'

/**
 * A static `export ... from` is hoisted above every statement, so the data
 * folder could not be set before the plugin loads. A dynamic import runs after
 * the assignment. The plugin's default export must be { id, setup } and
 * nothing else, so the shim passes it through unchanged.
 */
export function shimContent(pluginEntry: string, dataDir: string): string {
  return [
    `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`,
    '// OpenCode 2.x loads every plugin in this folder; the plugin itself lives in',
    '// the checkout below, and reads its data folder from the line under this.',
    `globalThis.${DATA_DIR_CONSTANT} = ${JSON.stringify(dataDir)};`,
    `const plugin = await import(${JSON.stringify(pluginEntry)});`,
    'export default plugin.default;',
    '',
  ].join('\n')
}

/** The data-folder constant every program-mode plugin file carries. */
export const DATA_DIR_CONSTANT = 'KINFOLD_DATA_DIR'

/**
 * The file to write: a re-export of the checkout's plugin, or the program's
 * own bundle under a data-folder constant. JSON.stringify keeps a folder with
 * quotes, backslashes or spaces one valid string.
 */
export function pluginFileContent(mode: InstallMode, dataDir: string, bundle: string): string {
  if (mode.kind === 'checkout') return shimContent(join(mode.projectRoot, 'src', 'plugins', 'opencode.ts'), dataDir)
  return [
    `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`,
    `const ${DATA_DIR_CONSTANT} = ${JSON.stringify(dataDir)};`,
    bundle,
  ].join('\n')
}

/** The plugin entry a Kinfold shim loads, in the current or the older form, or null when the text is not one. */
export function shimTarget(text: string): string | null {
  const loaded = IMPORT_PATTERN.exec(text)?.[1]
  if (loaded !== undefined) {
    try {
      const path: unknown = JSON.parse(loaded)
      if (typeof path === 'string' && path.endsWith(PLUGIN_SUFFIX)) return path
    } catch {
      return null
    }
  }
  return REEXPORT_PATTERN.exec(text)?.[1] ?? null
}

function hasOurMarker(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? ''
  return first.startsWith(`// ${SHIM_MARKER}:`) || first.startsWith(`// ${LEGACY_SHIM_MARKER}:`)
}

/**
 * `foreign`: a file by our name that carries neither our marker nor our
 * plugin import; it is never overwritten or removed. A program-mode file has no
 * import of the checkout, so its first-line marker is what proves it is ours.
 */
export function inspectShim(text: string | null, expected: { pluginEntry: string; dataDir: string }): ShimState {
  if (text === null) return 'no'
  const target = shimTarget(text)
  // Anything but the exact current form is stale: another checkout, another
  // data folder, or the older re-export that carries no folder.
  if (target !== null) return text === shimContent(expected.pluginEntry, expected.dataDir) ? 'yes' : 'stale'
  return hasOurMarker(text) ? 'yes' : 'foreign'
}

/**
 * A file the migration may remove: it loads a checkout's plugin and its
 * first line carries our marker, new or legacy. Stricter than inspectShim, so
 * a hand-written file that happens to load the plugin is left alone, and
 * a program-mode bundle (which loads no other file) is never mistaken for a
 * shim left by the migration.
 */
export function isOwnShim(text: string | null): boolean {
  if (text === null || shimTarget(text) === null) return false
  return hasOurMarker(text)
}
