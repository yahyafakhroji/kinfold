// Writes the npm packages into <distDir>/npm from release programs:
// `bun tools/pack-npm.ts <distDir> <version>`.
//
// The launcher package is small and names one optional platform package per
// target. A platform package carries its program untouched, because publishing
// all five programs in one package would make every install download all of
// them.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface NpmTarget {
  /** The release target, matching tools/build-release.ts. */
  target: string
  packageName: string
  /** The package folder under dist/npm. */
  dir: string
  os: 'darwin' | 'linux' | 'win32'
  cpu: 'x64' | 'arm64'
  /** The release file in distDir. */
  program: string
  /** The file inside the platform package. */
  file: string
}

export const NPM_TARGETS: readonly NpmTarget[] = [
  { target: 'darwin-arm64', packageName: '@kinfold/cli-darwin-arm64', dir: 'cli-darwin-arm64', os: 'darwin', cpu: 'arm64', program: 'kinfold-darwin-arm64', file: 'kinfold' },
  { target: 'darwin-x64', packageName: '@kinfold/cli-darwin-x64', dir: 'cli-darwin-x64', os: 'darwin', cpu: 'x64', program: 'kinfold-darwin-x64', file: 'kinfold' },
  { target: 'linux-x64', packageName: '@kinfold/cli-linux-x64', dir: 'cli-linux-x64', os: 'linux', cpu: 'x64', program: 'kinfold-linux-x64', file: 'kinfold' },
  { target: 'linux-arm64', packageName: '@kinfold/cli-linux-arm64', dir: 'cli-linux-arm64', os: 'linux', cpu: 'arm64', program: 'kinfold-linux-arm64', file: 'kinfold' },
  { target: 'windows-x64', packageName: '@kinfold/cli-windows-x64', dir: 'cli-windows-x64', os: 'win32', cpu: 'x64', program: 'kinfold-windows-x64.exe', file: 'kinfold.exe' },
]

export interface PackSummary {
  target: string
  packageName: string
  path: string
}

export class PackError extends Error {
  override name = 'PackError'
}

/** The same version characters tools/build-release.ts accepts, because both read the same input. */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/
const PLATFORM_LABEL: Readonly<Record<NpmTarget['os'], string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

function description(target: NpmTarget): string {
  return `The Kinfold program for ${PLATFORM_LABEL[target.os]} ${target.cpu}.`
}

/**
 * Writes the launcher package and one platform package per release target.
 * Every program is checked before the first write, so a dist built for only
 * some targets cannot leave a package folder that looks complete.
 */
export function packNpm(distDir: string, version: string, root = join(import.meta.dir, '..')): PackSummary[] {
  if (distDir === '' || version === '') throw new PackError('usage: bun tools/pack-npm.ts <distDir> <version>')
  if (!VERSION_PATTERN.test(version)) throw new PackError(`${version} is not a version; use letters, digits, dots, plus and hyphen`)

  const sources = NPM_TARGETS.map((target) => {
    const path = join(distDir, target.program)
    let isFile = false
    try {
      isFile = statSync(path).isFile()
    } catch {
      isFile = false
    }
    if (!isFile) throw new PackError(`${relative(process.cwd(), path)} is missing; build the release programs first`)
    return { target, path }
  })

  const templateDir = join(root, 'npm', 'kinfold')
  const template = JSON.parse(readFileSync(join(templateDir, 'package.json'), 'utf8')) as Record<string, unknown>
  if (template.dependencies !== undefined) throw new PackError('npm/kinfold/package.json must not declare dependencies')

  const out = join(distDir, 'npm')
  mkdirSync(join(out, 'kinfold', 'bin'), { recursive: true, mode: 0o755 })
  copyFileSync(join(templateDir, 'bin', 'kinfold.js'), join(out, 'kinfold', 'bin', 'kinfold.js'))
  const launcher = {
    ...template,
    version,
    optionalDependencies: Object.fromEntries(NPM_TARGETS.map((target) => [target.packageName, version])),
  }
  writeFileSync(join(out, 'kinfold', 'package.json'), `${JSON.stringify(launcher, null, 2)}\n`)

  const summaries: PackSummary[] = []
  for (const { target, path } of sources) {
    const packageDir = join(out, target.dir)
    mkdirSync(packageDir, { recursive: true, mode: 0o755 })
    const program = join(packageDir, target.file)
    copyFileSync(path, program)
    // npm keeps the executable bit it is given, and the launcher spawns the
    // program directly.
    if (target.os !== 'win32') chmodSync(program, 0o755)
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify(
        {
          name: target.packageName,
          version,
          description: description(target),
          license: 'Apache-2.0',
          os: [target.os],
          cpu: [target.cpu],
          files: [target.file],
        },
        null,
        2,
      )}\n`,
    )
    summaries.push({ target: target.target, packageName: target.packageName, path: packageDir })
  }
  return summaries
}

function main(): void {
  const distDir = process.argv[2] ?? ''
  const version = process.argv[3] ?? ''
  for (const entry of packNpm(distDir, version)) {
    console.log(`wrote ${relative(process.cwd(), entry.path)} (${entry.packageName})`)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error: unknown) {
    if (!(error instanceof PackError)) throw error
    console.error(`pack failed: ${error.message}`)
    process.exitCode = 1
  }
}
