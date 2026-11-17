// Writes the module a release build compiles into the `kinfold` program:
// src/runtime/embedded.generated.ts. Every asset is imported with
// `with { type: 'file' }`, so Bun carries the bytes inside the program and
// `Bun.file` reads them back at run time.
//
// The generator expects the target's inputs already in .cache:
//   .cache/sqlite3mc/libsqlite3mc.<ext>  (bun tools/build-sqlite3mc.ts)
//   .cache/vec0/vec0.<ext>               (bun tools/fetch-vec0.ts)
//   .cache/embed-model/*                 (bun tools/fetch-model.ts)
// plus src/plugins/opencode.ts. It builds the dashboard app (src/dashboard/app)
// and bundles the plugin, so the program can serve the pages and write a
// self-contained file for OpenCode.
//
// The committed embedded.generated.ts is the developer stub that exports null.
// A release run replaces it in a throwaway checkout and never commits the
// result; the warning below says so when the working tree has it tracked.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { SQLITE3MC_ZIP_SHA256, sqlite3mcLibraryExtension } from '../src/sqlite/release'
import { vec0AssetFor } from '../src/vectors/vec0-release'
import { vec0FileName } from '../src/vectors/extension'
import { LOCAL_MODEL_FILES, MAX_ADDED_BYTES } from '../src/vectors/local-model'
import { APP_ASSETS, APP_DIST, APP_PAGES, buildApp, listAssets } from '../src/dashboard/app-files'
import { KILO_PLUGIN_ENTRY, PLUGIN_ENTRY, bundlePlugin } from './bundle-plugin'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'src', 'runtime', 'embedded.generated.ts')
const CACHE_DIR = join(ROOT, '.cache')

interface Target {
  platform: NodeJS.Platform
  arch: string
}

const TARGETS: Readonly<Record<string, Target>> = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
  'windows-x64': { platform: 'win32', arch: 'x64' },
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A path in the generated file, relative and always slash-separated. */
function specifier(path: string): string {
  const value = relative(dirname(OUT), path).replaceAll('\\', '/')
  return value.startsWith('.') ? value : `./${value}`
}

function identifier(name: string): string {
  return `dashboard_${name.replace(/[^A-Za-z0-9]/g, '_')}`
}

function readRequired(path: string, hint: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`${path} is missing; ${hint}`)
  return new Uint8Array(readFileSync(path))
}

/** One self-contained file per plugin (OpenCode's and Kilo Code's), which the program writes at install time. */
async function bundlesFor(target: string): Promise<{ opencode: string; kilo: string }> {
  const dir = join(CACHE_DIR, 'embedded', target)
  rmSync(dir, { recursive: true, force: true })
  return { opencode: await bundlePlugin(join(dir, 'opencode-plugin.js'), PLUGIN_ENTRY), kilo: await bundlePlugin(join(dir, 'kilo-plugin.js'), KILO_PLUGIN_ENTRY) }
}

async function generate(targetName: string): Promise<string> {
  const target = TARGETS[targetName]
  if (target === undefined) throw new Error(`unknown target ${targetName}; expected one of ${Object.keys(TARGETS).join(', ')}`)

  const sqlite3mcExtension = sqlite3mcLibraryExtension(target.platform)
  const vec0Member = vec0FileName(target.platform)
  const asset = vec0AssetFor(target.platform, target.arch)
  if (sqlite3mcExtension === null || vec0Member === null || asset === null) throw new Error(`no pinned sqlite3mc or sqlite-vec build for ${targetName}`)

  const sqlite3mcPath = join(CACHE_DIR, 'sqlite3mc', `libsqlite3mc.${sqlite3mcExtension}`)
  const vec0Path = join(CACHE_DIR, 'vec0', vec0Member)
  const sqlite3mc = readRequired(sqlite3mcPath, 'run `bun tools/build-sqlite3mc.ts` first')
  const vec0 = readRequired(vec0Path, 'run `bun tools/fetch-vec0.ts` first')
  const vec0Sha256 = sha256(vec0)
  if (vec0Sha256 !== asset.fileSha256) throw new Error(`${vec0Path} does not match the pinned sqlite-vec sha256 for ${targetName}; nothing was written`)

  const modelPaths = localModelPaths()
  const plugins = await bundlesFor(targetName)
  // A fresh build every time: a dist left from another checkout state must never ship.
  buildApp()
  const dashboard = [...APP_PAGES.map((name) => ({ name, path: join(APP_DIST, name) })), ...[...listAssets()].sort().map((name) => ({ name, path: join(APP_ASSETS, name) }))]

  const imports = [
    "import type { GeneratedAssets } from './embedded'",
    `import sqlite3mcFile from ${JSON.stringify(specifier(sqlite3mcPath))} with { type: 'file' }`,
    `import vec0File from ${JSON.stringify(specifier(vec0Path))} with { type: 'file' }`,
    `import pluginFile from ${JSON.stringify(specifier(plugins.opencode))} with { type: 'file' }`,
    `import kiloPluginFile from ${JSON.stringify(specifier(plugins.kilo))} with { type: 'file' }`,
    `import modelFile from ${JSON.stringify(specifier(modelPaths.model))} with { type: 'file' }`,
    `import vocabFile from ${JSON.stringify(specifier(modelPaths.vocab))} with { type: 'file' }`,
    `import wasmFile from ${JSON.stringify(specifier(modelPaths.wasm))} with { type: 'file' }`,
    ...dashboard.map((entry) => `import ${identifier(entry.name)} from ${JSON.stringify(specifier(entry.path))} with { type: 'file' }`),
  ]
  const dashboardEntries = dashboard.map((entry) => `    ${JSON.stringify(entry.name)}: ${identifier(entry.name)},`)
  return [
    '// @ts-nocheck',
    `// Generated by tools/gen-embedded.ts for ${targetName}; a release build only. Do not commit.`,
    ...imports,
    '',
    'export const embedded: GeneratedAssets = {',
    `  sqlite3mc: { file: sqlite3mcFile, sha256: '${sha256(sqlite3mc)}', sourceSha256: '${SQLITE3MC_ZIP_SHA256}' },`,
    `  vec0: { file: vec0File, sha256: '${vec0Sha256}' },`,
    '  dashboard: {',
    ...dashboardEntries,
    '  },',
    '  opencodePlugin: pluginFile,',
    '  kiloPlugin: kiloPluginFile,',
    '  localModel: { model: modelFile, vocab: vocabFile, wasm: wasmFile },',
    '}',
    '',
  ].join('\n')
}

const MODEL_DIR = join(CACHE_DIR, 'embed-model')
/** The JS half of the model runtime; the bundle carries it, so it counts toward the added size. */
const ORT_BUNDLE = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.bundle.min.mjs')

/** The model files, each checked against its pin, and the whole runtime held under the size ceiling. */
function localModelPaths(): { model: string; vocab: string; wasm: string } {
  const paths = { model: join(MODEL_DIR, LOCAL_MODEL_FILES.model.name), vocab: join(MODEL_DIR, LOCAL_MODEL_FILES.vocab.name), wasm: join(MODEL_DIR, LOCAL_MODEL_FILES.wasm.name) }
  let added = readRequired(ORT_BUNDLE, 'run `bun install` first').length
  for (const key of ['model', 'vocab', 'wasm'] as const) {
    const bytes = readRequired(paths[key], 'run `bun tools/fetch-model.ts` first')
    if (sha256(bytes) !== LOCAL_MODEL_FILES[key].sha256) throw new Error(`${paths[key]} does not match the pinned sha256; nothing was written`)
    added += bytes.length
  }
  if (added > MAX_ADDED_BYTES) throw new Error(`the local model adds ${added} bytes, over the ${MAX_ADDED_BYTES} ceiling; nothing was written`)
  console.log(`local model adds ${added} bytes (ceiling ${MAX_ADDED_BYTES})`)
  return paths
}

/** The generated file is tracked as a stub, so a manual run needs reverting before a commit. The release build restores it on its own. */
function warnIfTracked(): void {
  const path = relative(ROOT, OUT)
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', path], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' })
  if (status.exitCode === 0 && status.stdout.toString().trim() !== '') {
    console.warn(`warning: ${path} is tracked and was rewritten; tools/build-release.ts restores it after compiling, so revert it yourself only after a manual run`)
  }
}

const targetName = process.argv[2]
if (targetName === undefined || targetName === '') throw new Error('usage: bun tools/gen-embedded.ts <target>')
writeFileSync(OUT, await generate(targetName), { mode: 0o644 })
warnIfTracked()
