// Bundles the OpenCode plugin into one ESM file whose only imports are Node
// and Bun builtins. `kinfold install` writes that file beside the user's
// OpenCode config, so it must not reach into the checkout or load SQLite.
//
// Usage: bun tools/bundle-plugin.ts <outfile>

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '..')

export const PLUGIN_ENTRY = join(ROOT, 'src', 'plugins', 'opencode.ts')

/**
 * Bare names Bun emits for Node builtins, plus everything that may appear
 * prefixed with `node:` or `bun:`. Anything else would be an npm package or a
 * checkout path, which the installed file cannot rely on.
 */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers',
  'stream/promises', 'stream/web', 'string_decoder', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url',
  'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

export function isBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || specifier.startsWith('bun:') || NODE_BUILTINS.has(specifier)
}

const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g

/** Every module specifier the file imports, static or dynamic, in order. */
export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER_PATTERN)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
}

/**
 * Refuses anything the installed file cannot load on its own: a checkout path,
 * an npm package or a SQLite loader. The build fails here rather than at a
 * user's first prompt.
 */
export function assertStandalone(text: string): void {
  for (const specifier of importSpecifiers(text)) {
    // A checkout path is not a builtin either; naming it as such is the clearer error.
    if (specifier.includes('/src/')) throw new Error(`the plugin bundle imports a checkout path: ${specifier}`)
    if (!isBuiltinSpecifier(specifier)) throw new Error(`the plugin bundle imports ${specifier}, which is not a Node or Bun builtin`)
    if (/sqlite|ffi/i.test(specifier)) throw new Error(`the plugin bundle imports ${specifier}, so it would load SQLite`)
  }
}

const MODULE_COMMENT = /^\/\/ .+[\\/].+\.[cm]?[jt]sx?$/

/**
 * Bun writes a `// <module path>` line above every module it emits, and a
 * build run from another directory writes an absolute path there. The
 * installed file must not carry the build machine's layout, so those lines
 * are dropped. The `// @bun` banner does not match and stays.
 */
export function stripModulePaths(text: string): string {
  return text.split('\n').filter((line) => !MODULE_COMMENT.test(line)).join('\n')
}

/** Writes the bundle to `outfile` and returns that path. */
export async function bundlePlugin(outfile: string): Promise<string> {
  const target = resolve(outfile)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const result = await Bun.build({
    entrypoints: [PLUGIN_ENTRY],
    target: 'bun',
    format: 'esm',
    outdir: dirname(target),
    naming: basename(target),
  })
  if (!result.success || result.outputs.length === 0) {
    throw new Error(`could not bundle the OpenCode plugin: ${result.logs.map(String).join(' | ')}`)
  }
  const output = result.outputs[0]!.path
  const text = stripModulePaths(await Bun.file(output).text())
  assertStandalone(text)
  writeFileSync(output, text)
  return output
}

if (import.meta.main) {
  const outfile = process.argv[2]
  if (outfile === undefined || outfile === '') {
    console.error('usage: bun tools/bundle-plugin.ts <outfile>')
    process.exit(2)
  }
  console.log(await bundlePlugin(outfile))
}
