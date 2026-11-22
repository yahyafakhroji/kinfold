// Kilo Code loads this file. Its default export must be { id, server }, and
// the file exports nothing more: the plugin body lives in kilo-plugin.ts.

import { resolveDataDir } from '../../resources/store/data-dir'
import { createKiloPlugin } from './kilo-plugin'

// The folder comes from, in order: the constant an installed program writes
// above its bundle; globalThis.KINFOLD_DATA_DIR, which a checkout's shim sets
// before it loads this file; then the environment, inside the plugin. It is
// read when the plugin asks, not when this file loads. `typeof` on a name that
// does not exist is safe.
declare const KINFOLD_DATA_DIR: string | undefined

function dataDirFromHost(): string | undefined {
  if (typeof KINFOLD_DATA_DIR === 'string') return KINFOLD_DATA_DIR
  const fromShim = (globalThis as Record<string, unknown>).KINFOLD_DATA_DIR
  return typeof fromShim === 'string' && fromShim !== '' ? fromShim : undefined
}

const { id, server } = createKiloPlugin({ dataDir: () => dataDirFromHost() ?? resolveDataDir() })

export default { id, server }
