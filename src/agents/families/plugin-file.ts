// The plugin-file wiring of OpenCode and of the agents that load OpenCode-style
// plugins from a folder of their own (Kilo Code, ~/.config/kilo/plugin/; Amp
// through a template): one file in ~/.config/opencode/plugins/ or the agent's
// folder. A checkout install writes a shim that sets the data folder and
// loads the checkout's plugin; a program install writes the plugin bundle
// it carries, so no path points into a checkout or a cache. OpenCode 2.x loads
// every file in that directory by itself (claude-mem's installer relies on the
// same rule, and 2.x warns about file paths listed in opencode.json), so
// opencode.json and opencode.jsonc stay untouched. Kilo's docs give its
// folder the same rule, and its shim names Kilo, not OpenCode.

// Shims written now carry SHIM_MARKER on their first line; a pre-rename
// install wrote LEGACY_SHIM_MARKER there. A program-mode file carries the same
// marker and the bundle, with no re-export, and is recognised by the marker.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallEnv } from '../../install/env'
import { installPaths } from '../../install/env'
import type { InstallMode } from '../../install/entry'
import { describeTextChange, readTextOrNull } from '../../install/files'
import type { Action } from '../../install/plan'
import { LEGACY_SHIM_MARKER, SHIM_MARKER } from '../../names'
import { type EmbeddedAssets, embeddedAssets } from '../../runtime/embedded'
import type { AgentId } from '../profile'

const DIR_MODE = 0o755
const FILE_MODE = 0o644

/** An agent that loads OpenCode-style plugin files from one folder. */
export interface PluginFileSpec {
  dir(env: InstallEnv): string
  fileName: string
  host: AgentId
  /** How messages name the agent; defaults to the id. */
  label?: string
  /**
   * The whole file, for an agent whose plugin is a file of its own rather
   * than OpenCode's (Amp). Ours by the first-line marker; anything else
   * carrying it is stale.
   */
  template?: (env: InstallEnv) => string
}

export const OPENCODE_HOST_ID: AgentId = 'opencode'
/** The constant a non-OpenCode plugin file carries so the one bundle reports its own host. */
export const HOST_CONSTANT = 'KINFOLD_HOST'

// The form written before the shim carried a data folder: a bare re-export.
const REEXPORT_PATTERN = /export\s*\{\s*default\s*\}\s*from\s*("(?:[^"\\]|\\.)*")/
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
export function shimContent(pluginEntry: string, dataDir: string, host: AgentId = OPENCODE_HOST_ID, label?: string): string {
  // The comment names the agent whose folder the file sits in; OpenCode's line is pinned byte for byte.
  const loader = host === OPENCODE_HOST_ID ? 'OpenCode 2.x' : (label ?? host)
  return [
    `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`,
    `// ${loader} loads every plugin in this folder; the plugin itself lives in`,
    '// the checkout below, and reads its data folder from the line under this.',
    `globalThis.${DATA_DIR_CONSTANT} = ${JSON.stringify(dataDir)};`,
    ...(host === OPENCODE_HOST_ID ? [] : [`globalThis.${HOST_CONSTANT} = ${JSON.stringify(host)};`]),
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
export function pluginFileContent(mode: InstallMode, dataDir: string, bundle: string, host: AgentId = OPENCODE_HOST_ID, label?: string): string {
  if (mode.kind === 'checkout') return shimContent(join(mode.projectRoot, 'src', 'plugins', 'opencode.ts'), dataDir, host, label)
  return [
    `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`,
    `const ${DATA_DIR_CONSTANT} = ${JSON.stringify(dataDir)};`,
    ...(host === OPENCODE_HOST_ID ? [] : [`const ${HOST_CONSTANT} = ${JSON.stringify(host)};`]),
    bundle,
  ].join('\n')
}

/** The plugin entry a Kinfold shim loads, in the current or the older form, or null when the text is not one. */
export function shimTarget(text: string): string | null {
  return pluginPathIn(IMPORT_PATTERN.exec(text)?.[1]) ?? pluginPathIn(REEXPORT_PATTERN.exec(text)?.[1])
}

/**
 * The path a quoted JS string holds, when it is a checkout's plugin entry.
 * A Windows checkout writes it with backslashes, so the suffix is matched on
 * either separator; without that a Windows shim read as marker-only and was
 * never found stale.
 */
function pluginPathIn(literal: string | undefined): string | null {
  if (literal === undefined) return null
  try {
    const path: unknown = JSON.parse(literal)
    return typeof path === 'string' && path.replaceAll('\\', '/').endsWith(PLUGIN_SUFFIX) ? path : null
  } catch {
    return null
  }
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
export function inspectShim(text: string | null, expected: { pluginEntry: string; dataDir: string; host?: AgentId; label?: string }): ShimState {
  if (text === null) return 'no'
  const target = shimTarget(text)
  // Anything but the exact current form is stale: another checkout, another
  // data folder, or the older re-export that carries no folder.
  if (target !== null) return text === shimContent(expected.pluginEntry, expected.dataDir, expected.host, expected.label) ? 'yes' : 'stale'
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

function shimExpectation(env: InstallEnv, spec: PluginFileSpec): { pluginEntry: string; dataDir: string; host: AgentId; label?: string } {
  return { pluginEntry: installPaths(env).pluginEntry, dataDir: env.dataDir, host: spec.host, ...(spec.label !== undefined ? { label: spec.label } : {}) }
}

const fileOf = (env: InstallEnv, spec: PluginFileSpec): string => join(spec.dir(env), spec.fileName)

/** An empty file holds nothing of anyone's, so it is written over. */
function templateState(text: string | null, content: string): ShimState {
  if (text === null || text.trim() === '') return 'no'
  if (text === content) return 'yes'
  return hasOurMarker(text) ? 'stale' : 'foreign'
}

/** The plugin file's state, read-only; a file that is not ours reads as 'foreign'. */
export function pluginFileState(env: InstallEnv, spec: PluginFileSpec): ShimState {
  const text = readTextOrNull(fileOf(env, spec))
  return spec.template !== undefined ? templateState(text, spec.template(env)) : inspectShim(text, shimExpectation(env, spec))
}

function writeActions(env: InstallEnv, spec: PluginFileSpec, before: string | null, content: string, state: ShimState): Action[] {
  const summary = `${describeTextChange(before, content) ?? 'unchanged'}${state === 'stale' ? ', replacing a stale plugin path' : ''}`
  return [
    ...(existsSync(spec.dir(env)) ? [] : [{ kind: 'mkdir', path: spec.dir(env), mode: DIR_MODE } as const]),
    { kind: 'write', path: fileOf(env, spec), content, mode: FILE_MODE, summary },
  ]
}

/** A template plugin file: written whole, nothing to load or bundle, so it plans synchronously. */
export function templatePluginFileActions(env: InstallEnv, spec: PluginFileSpec): Action[] {
  if (spec.template === undefined) throw new Error(`${spec.host} has no plugin template`)
  const path = fileOf(env, spec)
  const before = readTextOrNull(path)
  const content = spec.template(env)
  const state = templateState(before, content)
  if (state === 'foreign') throw new Error(`${path} exists and is not a Kinfold plugin file; move it away first`)
  if (state === 'yes') {
    env.out(`${spec.host}: plugin already in ${path}`)
    return []
  }
  return writeActions(env, spec, before, content, state)
}

/**
 * Our plugin file: a checkout writes the shim that loads its plugin; a program
 * writes the bundle it carries. Both carry our marker; a file without it is
 * never touched.
 */
export async function pluginFileActions(env: InstallEnv, spec: PluginFileSpec, assets: EmbeddedAssets | null = embeddedAssets()): Promise<Action[]> {
  if (spec.template !== undefined) return templatePluginFileActions(env, spec)
  const path = fileOf(env, spec)
  const label = spec.label ?? spec.host
  const before = readTextOrNull(path)
  const state = inspectShim(before, shimExpectation(env, spec))
  if (state === 'foreign') throw new Error(`${path} exists and is not a Kinfold plugin file; move it away first`)
  const bundle = env.mode.kind === 'program' ? (assets === null ? null : await assets.opencodePlugin()) : ''
  if (bundle === null) throw new Error(`this build carries no ${label} plugin; reinstall from a release build`)
  const content = pluginFileContent(env.mode, env.dataDir, bundle, spec.host, spec.label)
  if (state === 'yes' && before === content) {
    env.out(`${spec.host}: plugin already in ${path}`)
    return []
  }
  return writeActions(env, spec, before, content, state)
}

/** Our plugin file out; a file by our name that is not ours is named and left alone. */
export function pluginFileUninstallActions(env: InstallEnv, spec: PluginFileSpec): Action[] {
  const path = fileOf(env, spec)
  const state = pluginFileState(env, spec)
  if (state === 'foreign') env.out(`${spec.host}: ${path} is not a Kinfold plugin file; left alone`)
  return state === 'yes' || state === 'stale' ? [{ kind: 'remove', path, summary: `the Kinfold ${spec.label ?? spec.host} plugin file` }] : []
}

/** For status: the state word with the file's path. */
export function pluginFileLine(env: InstallEnv, spec: PluginFileSpec): string {
  const state = pluginFileState(env, spec)
  const word = state === 'foreign' ? 'no (a file by our name exists but is not our shim)' : state === 'stale' ? 'stale path' : state
  return `${word} in ${fileOf(env, spec)}`
}
