// Where the built dashboard lives and how to build it. The app's source is in
// src/ui/dashboard; `bun run dashboard:build` (Vite) writes dist/index.html,
// dist/login.html and dist/assets/<name>-<hex>.js|css there. dist is not
// committed: a checkout's daemon serves it once built, the release build
// (tools/gen-embedded.ts) builds it and embeds every file, and tests that need
// the pages call ensureAppBuilt().

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const APP_DIR = join(import.meta.dir, '../../ui/dashboard')
export const APP_DIST = join(APP_DIR, 'dist')
export const APP_ASSETS = join(APP_DIST, 'assets')
export const APP_PAGES = ['index.html', 'login.html'] as const
/** Lowercase names with a hex hash: what the build writes and the asset route accepts. */
export const ASSET_NAME = /^[a-z0-9-]+\.(js|css)$/

/** Every servable asset in `dir`; none when the app was never built. */
export function listAssets(dir: string = APP_ASSETS): ReadonlySet<string> {
  try {
    return new Set(readdirSync(dir).filter((name) => ASSET_NAME.test(name)))
  } catch (error: unknown) {
    // A compiled program has no dist folder on disk, and a fresh checkout has not built one yet.
    // Any other failure would turn every asset into a silent 404, so it must not read as empty.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
}

export function appBuilt(dir: string = APP_DIST): boolean {
  return APP_PAGES.every((page) => existsSync(join(dir, page))) && listAssets(join(dir, 'assets')).size > 0
}

const VITE = join(APP_DIR, '..', '..', '..', 'node_modules', 'vite', 'bin', 'vite.js')

/** The release smoke runs the tests of a built program with no dependencies installed, so it cannot build. */
export function canBuildApp(): boolean {
  return existsSync(VITE)
}

/** Runs the Vite build with this Bun; throws with its output when it fails. */
export function buildApp(): void {
  const vite = VITE
  const result = Bun.spawnSync([process.execPath, '--bun', vite, 'build', '--logLevel', 'warn'], { cwd: APP_DIR, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`the dashboard build failed:\n${result.stdout.toString()}${result.stderr.toString()}`)
}

/** For tests and the release build: builds the app unless dist already holds it. */
export function ensureAppBuilt(): void {
  if (!appBuilt()) buildApp()
}
