// OpenCode loads this file. Its default export must be { id, setup } and
// nothing else, and the file exports nothing more: the plugin body lives in
// opencode-plugin.ts.

import { createOpenCodePlugin } from './opencode-plugin'

// The installed program writes its data folder as this constant above the
// bundle. A checkout loads the module through a shim with no such constant, so
// it keeps resolving the folder from the environment, as before. `typeof` on a
// name that does not exist is safe.
declare const KINFOLD_DATA_DIR: string | undefined
const { id, setup } = createOpenCodePlugin(typeof KINFOLD_DATA_DIR === 'string' ? { dataDir: () => KINFOLD_DATA_DIR } : {})

export default { id, setup }
