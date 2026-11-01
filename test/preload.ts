// Every test process opens stores through the sqlite3mc build in .cache/
// (bun tools/build-sqlite3mc.ts), never a data dir's lib/, and with the
// database key store off, so no test reads the real Keychain. Children get
// these only when a test passes them in `env` (Bun.spawn hands a child the
// environment the process started with).

import { DB_KEYSTORE_ENV } from '../src/sqlite/keys'
import { SQLITE3MC_LIB_ENV } from '../src/sqlite/library'
import { testLibraryPath } from '../src/sqlite/test-support'

process.env[SQLITE3MC_LIB_ENV] = testLibraryPath()
process.env[DB_KEYSTORE_ENV] = 'none'
