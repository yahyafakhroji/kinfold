// Environment variable names. Each KINFOLD_* variable still reads its legacy
// SAM_* name for one release, when the new one is unset or empty.

export type EnvKey =
  | 'DATA_DIR'
  | 'PORT'
  | 'SESSION_IDLE_MS'
  | 'OBSERVER_MAX_WAIT_MS'
  | 'OBSERVER'
  | 'MCP_HOST'
  | 'DB_KEYSTORE'
  | 'SQLITE3MC_LIB'
  | 'TEST_VEC0'
  | 'RELEASE_SUMS_URL'
  | 'INSTALL_CHANNEL'
  | 'NO_UPDATE_CHECK'

type Env = Readonly<Record<string, string | undefined>>

const ENV_KEYS: readonly EnvKey[] = ['DATA_DIR', 'PORT', 'SESSION_IDLE_MS', 'OBSERVER_MAX_WAIT_MS', 'OBSERVER', 'MCP_HOST', 'DB_KEYSTORE', 'SQLITE3MC_LIB', 'TEST_VEC0', 'RELEASE_SUMS_URL']

export function envName(key: EnvKey): string {
  return `KINFOLD_${key}`
}

export function legacyName(key: EnvKey): string {
  return `SAM_${key}`
}

/** These names never existed under SAM_, so no legacy fallback and no deprecation line. */
const NEW_ONLY_KEYS: readonly EnvKey[] = ['INSTALL_CHANNEL', 'NO_UPDATE_CHECK']

/** The KINFOLD_ value, else the legacy SAM_ one; an empty KINFOLD_ value counts as unset. */
export function readEnv(env: Env, key: EnvKey): string | undefined {
  const value = env[envName(key)]
  if (value !== undefined && value !== '') return value
  return NEW_ONLY_KEYS.includes(key) ? undefined : env[legacyName(key)]
}

/** One line per SAM_ variable read in place of an unset KINFOLD_ one. Names only, never values. */
export function deprecationLines(env: Env): string[] {
  return ENV_KEYS.filter((key) => {
    const current = env[envName(key)]
    return (current === undefined || current === '') && env[legacyName(key)] !== undefined
  }).map((key) => `deprecated: ${legacyName(key)} is read as ${envName(key)}; rename it`)
}
