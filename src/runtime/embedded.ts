// The files a release build carries inside the `kinfold` program: sqlite3mc,
// sqlite-vec, the dashboard pages and the OpenCode plugin. A checkout run has
// none of them (the committed stub names no files, so this returns null) and
// keeps using the local build, the pinned download and src/dashboard/public.
//
// The byte accessors are lazy: reading an asset touches the embedded file only
// when an install writes it. The recorded sha256 came from the release build,
// and every consumer checks it before writing anything.

import { embedded } from './embedded.generated'

export interface EmbeddedAssets {
  sqlite3mc: { bytes: () => Promise<Uint8Array>; sha256: string; sourceSha256: string }
  vec0: { bytes: () => Promise<Uint8Array>; sha256: string }
  dashboardFile: (name: string) => Blob | null
  opencodePlugin: () => Promise<string>
}

/** What the generator writes into embedded.generated.ts; a checkout's stub leaves it null. */
export interface GeneratedAssets {
  sqlite3mc: { file: string; sha256: string; sourceSha256: string }
  vec0: { file: string; sha256: string }
  dashboard: Readonly<Record<string, string>>
  opencodePlugin: string
}

/**
 * A dashboard name is one plain file name: never a path, a parent step or a
 * percent-encoded one. The asset routes also require an exact name from a fixed
 * list; this check is the last line for a caller that joins the name itself.
 */
export function safeDashboardName(name: string): boolean {
  return name !== ''
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('%')
    && !name.startsWith('.')
}

async function fileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer())
}

export function embeddedAssets(): EmbeddedAssets | null {
  const generated = embedded
  if (generated === null) return null
  return {
    sqlite3mc: { bytes: () => fileBytes(generated.sqlite3mc.file), sha256: generated.sqlite3mc.sha256, sourceSha256: generated.sqlite3mc.sourceSha256 },
    vec0: { bytes: () => fileBytes(generated.vec0.file), sha256: generated.vec0.sha256 },
    dashboardFile: (name) => {
      if (!safeDashboardName(name)) return null
      const file = generated.dashboard[name]
      return file === undefined ? null : Bun.file(file)
    },
    opencodePlugin: () => Bun.file(generated.opencodePlugin).text(),
  }
}
