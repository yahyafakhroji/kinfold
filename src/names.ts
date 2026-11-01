// Every product name in one place, each next to the legacy name it replaced.
// The legacy names exist only so install and migration can find and remove what
// an earlier "Shared Agent Memory" install left behind.

export const PRODUCT = 'Kinfold'
export const CLI_NAME = 'kinfold'

export const KEYCHAIN_SERVICE = 'kinfold'
export const LEGACY_KEYCHAIN_SERVICE = 'shared-agent-memory'

export const DATA_DIR_NAME = '.kinfold'
export const LEGACY_DATA_DIR_NAME = '.shared-agent-memory'

export const LAUNCH_AGENT_LABEL = 'dev.kinfold.daemon'
export const LEGACY_LAUNCH_AGENT_LABEL = 'dev.shared-agent-memory.daemon'

export const MCP_SERVER_NAME = 'kinfold'
export const LEGACY_MCP_SERVER_NAME = 'shared-agent-memory'

export const PLUGIN_FILE_NAME = 'kinfold.js'
export const LEGACY_PLUGIN_FILE_NAME = 'shared-agent-memory.js'

/** First-line ownership marker of the OpenCode plugin shim. */
export const SHIM_MARKER = 'kinfold'
export const LEGACY_SHIM_MARKER = 'shared-agent-memory'

export const LOG_PREFIX = 'kinfold-daemon'
