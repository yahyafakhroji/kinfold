// Builds one release program: `bun tools/build-release.ts <target> <version>`.
//
// The embedded asset module and the version module are written for this
// target, compiled into the program, then restored to their committed stubs,
// so a release build leaves the working tree as it found it. The assets come
// from .cache, so the caller builds sqlite3mc for the target and downloads its
// pinned sqlite-vec member first.

import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const ENTRY = join(ROOT, 'src', 'cli', 'kinfold.ts')
const GENERATOR = join(ROOT, 'tools', 'gen-embedded.ts')
const GENERATED = join(ROOT, 'src', 'runtime', 'embedded.generated.ts')
const VERSION_FILE = join(ROOT, 'src', 'version.ts')
const DIST = join(ROOT, 'dist')

/** Bun's compile target for each release target. */
const BUN_TARGETS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64',
}

/** The version is written into a string literal, so it holds version characters only. */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/

function fail(message: string): never {
  console.error(`build failed: ${message}`)
  process.exit(1)
}

function run(step: string, argv: readonly string[]): void {
  const result = Bun.spawnSync([...argv], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) fail(`${step} exited ${result.exitCode ?? 'without a code'}`)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const target = process.argv[2] ?? ''
const version = process.argv[3] ?? ''
if (target === '' || version === '') fail('usage: bun tools/build-release.ts <target> <version>')
const bunTarget = BUN_TARGETS[target]
if (bunTarget === undefined) fail(`unknown target ${target}; expected one of ${Object.keys(BUN_TARGETS).join(', ')}`)
if (!VERSION_PATTERN.test(version)) fail(`${version} is not a version; use letters, digits, dots, plus and hyphen`)

const program = `kinfold-${target}${target === 'windows-x64' ? '.exe' : ''}`
const output = join(DIST, program)
const assetsStub = readFileSync(GENERATED)
const versionStub = readFileSync(VERSION_FILE)
try {
  run('asset generation', [process.execPath, GENERATOR, target])
  // Bun's define replaces a global reference, not an imported binding, so the
  // version module is stamped for the compile and restored afterwards.
  writeFileSync(VERSION_FILE, `// Stamped by tools/build-release.ts; do not commit.\nexport const VERSION = '${version}'\n`, { mode: 0o644 })
  mkdirSync(DIST, { recursive: true, mode: 0o755 })
  run('compile', [
    process.execPath,
    'build',
    '--compile',
    `--target=${bunTarget}`,
    ENTRY,
    '--outfile',
    output,
  ])
} finally {
  writeFileSync(VERSION_FILE, versionStub)
  writeFileSync(GENERATED, assetsStub)
}

const { size } = statSync(output)
console.log(`built ${relative(ROOT, output)} size=${size} sha256=${await sha256(output)}`)
