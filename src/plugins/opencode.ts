// OpenCode loads this file. Its default export must be { id, setup } and
// nothing else, and the file exports nothing more: the plugin body lives in
// opencode-plugin.ts.

import { createOpenCodePlugin } from './opencode-plugin'

const { id, setup } = createOpenCodePlugin()

export default { id, setup }
