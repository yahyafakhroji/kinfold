// The OpenCode wiring: one file in ~/.config/opencode/plugins/ that re-exports
// the checkout's plugin, like this project's .opencode/plugins shim. OpenCode
// 2.x loads every file in that directory by itself (claude-mem's installer
// relies on the same rule, and 2.x warns about file paths listed in
// opencode.json), so opencode.json and opencode.jsonc stay untouched.

const SHIM_MARKER = 'shared-agent-memory'
const IMPORT_PATTERN = /export\s*\{\s*default\s*\}\s*from\s*"([^"]*\/src\/plugins\/opencode\.ts)"/

export type ShimState = 'yes' | 'no' | 'stale' | 'foreign'

export function shimContent(pluginEntry: string): string {
  return [
    `// ${SHIM_MARKER}: written by \`sam install\`, removed by \`sam uninstall\`.`,
    '// OpenCode 2.x loads every plugin in this folder; the plugin itself lives in',
    '// the checkout below. Its default export must be { id, setup } and nothing else.',
    `export { default } from ${JSON.stringify(pluginEntry)};`,
    '',
  ].join('\n')
}

/** The plugin entry a SAM shim re-exports, or null when the text is not one. */
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
