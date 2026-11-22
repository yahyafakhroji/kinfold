import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { installPaths } from './install/env'
import * as names from './names'

describe('names', () => {
  test('each product name sits next to its legacy one', () => {
    expect(names.PRODUCT).toBe('Kinfold')
    expect(names.CLI_NAME).toBe('kinfold')
    expect(names.KEYCHAIN_SERVICE).toBe('kinfold')
    expect(names.LEGACY_KEYCHAIN_SERVICE).toBe('shared-agent-memory')
    expect(names.DATA_DIR_NAME).toBe('.kinfold')
    expect(names.LEGACY_DATA_DIR_NAME).toBe('.shared-agent-memory')
    expect(names.LAUNCH_AGENT_LABEL).toBe('dev.kinfold.daemon')
    expect(names.LEGACY_LAUNCH_AGENT_LABEL).toBe('dev.shared-agent-memory.daemon')
    expect(names.MCP_SERVER_NAME).toBe('kinfold')
    expect(names.LEGACY_MCP_SERVER_NAME).toBe('shared-agent-memory')
    expect(names.PLUGIN_FILE_NAME).toBe('kinfold.js')
    expect(names.LEGACY_PLUGIN_FILE_NAME).toBe('shared-agent-memory.js')
    expect(names.LOG_PREFIX).toBe('kinfold-daemon')
  })

  test('installPaths uses the new names and carries the legacy paths', () => {
    const paths = installPaths({ homeDir: '/home/u', dataDir: '/home/u/.kinfold', projectRoot: '/repo' })
    expect(paths.launchAgentPlist.endsWith('dev.kinfold.daemon.plist')).toBe(true)
    expect(paths.legacyLaunchAgentPlist.endsWith('dev.shared-agent-memory.daemon.plist')).toBe(true)
    expect(paths.opencodePlugin.endsWith('kinfold.js')).toBe(true)
    expect(paths.legacyOpencodePlugin.endsWith('shared-agent-memory.js')).toBe(true)
    expect(paths.legacyDataDir).toBe(join('/home/u', '.shared-agent-memory'))
  })
})
