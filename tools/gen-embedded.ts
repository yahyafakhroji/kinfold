// Writes the module a release build compiles into the `kinfold` program:
// src/runtime/embedded.generated.ts. Every asset is imported with
// `with { type: 'file' }`, so Bun carries the bytes inside the program and
// `Bun.file` reads them back at run time.
//
// The generator expects the target's inputs already in .cache:
//   .cache/sqlite3mc/libsqlite3mc.<ext>  (bun tools/build-sqlite3mc.ts)
//   .cache/vec0/vec0.<ext>               (bun tools/fetch-vec0.ts)
// plus src/dashboard/public and src/plugins/opencode.ts. It bundles the plugin
// so the program can write a self-contained file for OpenCode.
//
// The committed embedded.generated.ts is the developer stub that exports null.
// A release run replaces it in a throwaway checkout and never commits the
// result; the warning below says so when the working tree has it tracked.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { SQLITE3MC_ZIP_SHA256, sqlite3mcLibraryExtension } from '../src/sqlite/release'
import { vec0AssetFor } from '../src/vectors/vec0-release'
import { vec0FileName } from '../src/vectors/extension'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'src', 'runtime', 'embedded.generated.ts')
const PUBLIC_DIR = join(ROOT, 'src', 'dashboard', 'public')
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

/** One self-contained OpenCode plugin file, which the program writes at install time. */
async function bundlePlugin(target: string): Promise<string> {
  const dir = join(CACHE_DIR, 'embedded', target)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src', 'plugins', 'opencode.ts')],
    target: 'bun',
    format: 'esm',
    outdir: dir,
    naming: 'opencode-plugin.js',
  })
  if (!result.success || result.outputs.length === 0) {
    throw new Error(`could not bundle the OpenCode plugin for ${target}: ${result.logs.join(' | ')}`)
  }
  return result.outputs[0]!.path
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

  const pluginPath = await bundlePlugin(targetName)
  const dashboard = readdirSync(PUBLIC_DIR).filter((name) => /^[a-z0-9-]+\.(js|css|html)$/.test(name)).sort()

  const imports = [
    "import type { GeneratedAssets } from './embedded'",
    `import sqlite3mcFile from ${JSON.stringify(specifier(sqlite3mcPath))} with { type: 'file' }`,
    `import vec0File from ${JSON.stringify(specifier(vec0Path))} with { type: 'file' }`,
    `import pluginFile from ${JSON.stringify(specifier(pluginPath))} with { type: 'file' }`,
    ...dashboard.map((name) => `import ${identifier(name)} from ${JSON.stringify(specifier(join(PUBLIC_DIR, name)))} with { type: 'file' }`),
  ]
  const dashboardEntries = dashboard.map((name) => `    ${JSON.stringify(name)}: ${identifier(name)},`)
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
    '}',
    '',
  ].join('\n')
}

/** The generated file is tracked as a stub, so a build in the working tree would need reverting before a commit. */
function warnIfTracked(): void {
  const path = relative(ROOT, OUT)
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', path], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' })
  if (status.exitCode === 0 && status.stdout.toString().trim() !== '') {
    console.warn(`warning: ${path} is tracked; revert it after compiling, because the generated build is never committed`)
  }
}

const targetName = process.argv[2]
if (targetName === undefined || targetName === '') throw new Error('usage: bun tools/gen-embedded.ts <target>')
writeFileSync(OUT, await generate(targetName), { mode: 0o644 })
warnIfTracked()
