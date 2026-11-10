// Linux secrets kept in the Secret Service keyring through libsecret, called
// over bun:ffi so no child process ever holds a value. Nothing here unlocks a
// keyring, creates one or prompts: a locked item is refused with a fixed
// message. A session with no D-Bus bus never loads libsecret, since loading
// it there could autolaunch a bus.

import { CString, FFIType, type Pointer, dlopen, ptr, read } from 'bun:ffi'
import { assertCredentialRef, assertStorableValue } from '../credentials'
import type { KeyStore, KeyStoreDeps, KeyStoreModule, KeyStoreProbe } from '../key-store'

export const LIBSECRET_SCHEMA = 'dev.kinfold.Secret'

export type SecretCollectionState = 'missing' | 'locked' | 'unlocked'

export type SecretLookup = { found: false } | { found: true; locked: true } | { found: true; locked: false; value: string | null }

/** The Secret Service, as the store sees it. Nothing here unlocks, creates a keyring, or prompts. */
export interface SecretServiceBinding {
  defaultCollection(): SecretCollectionState
  /** Item metadata only; the secret is not loaded. */
  exists(account: string): boolean
  lookup(account: string): SecretLookup
  /** Replaces the unlocked item in place, else creates one in the default collection. Throws 'locked' for a locked item or collection. */
  store(account: string, label: string, value: string): void
  /** Deletes every item for the account; true when one went. */
  remove(account: string): boolean
}

export type SecretOperation = 'connect' | 'search' | 'lookup' | 'store' | 'delete'

export class SecretServiceError extends Error {
  constructor(readonly operation: SecretOperation, readonly reason: number | 'locked' | 'unloadable') {
    super(`libsecret: ${operation} failed (${typeof reason === 'number' ? `code ${reason}` : reason})`)
    this.name = 'SecretServiceError'
  }
}

export type BindingLoader = () => SecretServiceBinding

const LABEL = 'libsecret'
const PLACE = 'the Secret Service keyring'
const BUS_ENV = 'DBUS_SESSION_BUS_ADDRESS'
const LIBSECRET_SO = 'libsecret-1.so.0'

function itemLabel(account: string): string {
  return `Kinfold ${account}`
}

const messages = {
  unreachable: `${LABEL}: the Secret Service keyring chosen at install cannot be reached (no D-Bus session bus); nothing was read or written`,
  unloadable: `${LABEL}: ${LIBSECRET_SO} cannot be loaded; nothing was read or written`,
  locked: `${LABEL}: the keyring is locked; unlock it and run the command again. Nothing was read or written`,
  failed: (operation: string, code: number | string) => `${LABEL}: ${operation} failed (code ${code})`,
  invalid: (account: string) => `${LABEL}: the keyring item "${itemLabel(account)}" does not hold a valid value`,
}

function hasBus(deps: KeyStoreDeps): boolean {
  const address = deps.envVars[BUS_ENV]
  return address !== undefined && address !== ''
}

/** The fixed message for a failure below the store; no other error text leaves. */
function fixedMessage(error: unknown, operation: SecretOperation): string {
  if (!(error instanceof SecretServiceError)) return messages.failed(operation, 'unknown')
  if (error.reason === 'locked') return messages.locked
  if (error.reason === 'unloadable') return messages.unloadable
  return messages.failed(error.operation, error.reason)
}

export function createLibsecretStore(deps: KeyStoreDeps, load: BindingLoader): KeyStore {
  let binding: SecretServiceBinding | null = null

  // The ref, then the bus (before any dlopen), then the binding.
  const call = <T>(account: string, operation: SecretOperation, body: (service: SecretServiceBinding) => T): T => {
    assertCredentialRef(account)
    if (!hasBus(deps)) throw new Error(messages.unreachable)
    try {
      binding ??= load()
      return body(binding)
    } catch (error: unknown) {
      throw new Error(fixedMessage(error, operation))
    }
  }

  const get = (account: string): string | null => {
    const found = call(account, 'lookup', (service) => service.lookup(account))
    if (!found.found) return null
    if (found.locked) throw new Error(messages.locked)
    if (found.value === null) throw new Error(messages.invalid(account))
    try {
      assertStorableValue(found.value)
    } catch {
      throw new Error(messages.invalid(account))
    }
    return found.value
  }

  const checked = (account: string, value: string): void => {
    assertCredentialRef(account)
    assertStorableValue(value)
  }

  // Check then store. Two processes creating one account at the same moment
  // could both store; install, the only creator, holds its own lock.
  const create = (account: string, value: string): boolean => {
    checked(account, value)
    return call(account, 'store', (service) => {
      if (service.exists(account)) return false
      service.store(account, itemLabel(account), value)
      return true
    })
  }

  const named = (account: string): string => {
    assertCredentialRef(account)
    return account
  }

  return {
    kind: 'libsecret',
    label: LABEL,
    place: PLACE,
    notes: [],
    get,
    exists: (account) => call(account, 'search', (service) => service.exists(account)),
    set: (account, value) => {
      checked(account, value)
      call(account, 'store', (service) => service.store(account, itemLabel(account), value))
    },
    create,
    delete: (account) => call(account, 'delete', (service) => service.remove(account)),
    describeSet: (account) =>
      `${LABEL}: store the secret for ${named(account)} in the default keyring (schema ${LIBSECRET_SCHEMA}, label "${itemLabel(account)}", value <hidden>)`,
    describeDelete: (account) => `${LABEL}: delete the keyring item with schema ${LIBSECRET_SCHEMA} and account ${named(account)}`,
    describeEntry: (account) => `the keyring item "${itemLabel(named(account))}" (schema ${LIBSECRET_SCHEMA}, account ${account})`,
  }
}

/** Install only. Never creates or unlocks a keyring. */
export function probeLibsecret(deps: KeyStoreDeps, load: BindingLoader): KeyStoreProbe {
  if (deps.platform.os !== 'linux') return { usable: false, reason: 'not Linux' }
  if (!hasBus(deps)) return { usable: false, reason: 'no D-Bus session bus' }
  let state: SecretCollectionState
  try {
    state = load().defaultCollection()
  } catch (error: unknown) {
    if (error instanceof SecretServiceError && error.reason === 'unloadable') return { usable: false, reason: `${LIBSECRET_SO} is not installed` }
    return { usable: false, reason: 'the Secret Service did not answer' }
  }
  if (state === 'missing') return { usable: false, reason: 'no default keyring' }
  if (state === 'locked') return { usable: false, reason: 'the default keyring is locked' }
  return { usable: true }
}

export function createLibsecretModule(load: BindingLoader = ffiSecretService): KeyStoreModule {
  return {
    kind: 'libsecret',
    label: LABEL,
    probe: (deps) => probeLibsecret(deps, load),
    open: (deps) => createLibsecretStore(deps, load),
  }
}

export const libsecretModule: KeyStoreModule = createLibsecretModule()

// SecretServiceFlags, SecretSearchFlags, SecretSchemaFlags and friends, from libsecret's headers.
const SERVICE_OPEN_SESSION = 1 << 1
const SEARCH_NONE = 0
const SEARCH_ALL = 1 << 1
const SEARCH_LOAD_SECRETS = 1 << 3
const SCHEMA_NONE = 0
const COLLECTION_NONE = 0
const ITEM_CREATE_NONE = 0
const RTLD_NOW = 2
const POINTER_SIZE = 8
// GError is { GQuark domain; gint code; gchar *message }.
const GERROR_CODE_OFFSET = 4
// GList is { gpointer data; GList *next; GList *prev }.
const GLIST_NEXT_OFFSET = 8
const GLIB_SO = 'libglib-2.0.so.0'

const SECRET_SYMBOLS = {
  secret_service_get_sync: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  secret_collection_for_alias_sync: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  secret_collection_get_locked: { args: [FFIType.ptr], returns: FFIType.i32 },
  secret_service_search_sync: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  secret_item_get_locked: { args: [FFIType.ptr], returns: FFIType.i32 },
  secret_item_get_secret: { args: [FFIType.ptr], returns: FFIType.ptr },
  secret_value_get_text: { args: [FFIType.ptr], returns: FFIType.ptr },
  secret_value_unref: { args: [FFIType.ptr], returns: FFIType.void },
  secret_value_new: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.ptr },
  secret_item_set_secret_sync: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  secret_item_create_sync: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  secret_item_delete_sync: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  secret_schema_newv: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
} as const

const GLIB_SYMBOLS = {
  g_hash_table_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  g_hash_table_insert: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  g_hash_table_unref: { args: [FFIType.ptr], returns: FFIType.void },
  g_list_free: { args: [FFIType.ptr], returns: FFIType.void },
  g_error_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const

const GOBJECT_SYMBOLS = { g_object_unref: { args: [FFIType.ptr], returns: FFIType.void } } as const

const LIBC_SYMBOLS = {
  dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
} as const

function cstring(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf8')
}

function isNull(pointer: number | null): pointer is null {
  return pointer === null || pointer === 0
}

function openLibraries() {
  const secret = dlopen(LIBSECRET_SO, SECRET_SYMBOLS).symbols
  const glib = dlopen(GLIB_SO, GLIB_SYMBOLS).symbols
  const gobject = dlopen('libgobject-2.0.so.0', GOBJECT_SYMBOLS).symbols
  // The real g_str_hash and g_str_equal, so libsecret's own lookups in our
  // attribute tables behave as with secret_attributes_build.
  const libc = dlopen('libc.so.6', LIBC_SYMBOLS).symbols
  const glibName = cstring(GLIB_SO)
  const handle = libc.dlopen(glibName, RTLD_NOW)
  if (isNull(handle)) throw new Error('glib cannot be opened')
  const hashName = cstring('g_str_hash')
  const equalName = cstring('g_str_equal')
  const strHash = libc.dlsym(handle, hashName)
  const strEqual = libc.dlsym(handle, equalName)
  if (isNull(strHash) || isNull(strEqual)) throw new Error('glib has no string hash')
  return { secret, glib, gobject, strHash, strEqual }
}

type Libraries = ReturnType<typeof openLibraries>

let libraries: Libraries | null = null

function loadLibraries(): Libraries {
  if (libraries !== null) return libraries
  try {
    libraries = openLibraries()
  } catch {
    throw new SecretServiceError('connect', 'unloadable')
  }
  return libraries
}

/**
 * dlopens the libraries on first call; throws SecretServiceError('connect', 'unloadable') when libsecret-1.so.0 is missing.
 * The only code that touches native memory: every buffer a pointer is taken from
 * stays referenced until the call that reads it returns, and every object
 * libsecret or GLib hands back is released on every path.
 */
export function ffiSecretService(): SecretServiceBinding {
  const { secret, glib, gobject, strHash, strEqual } = loadLibraries()
  const schemaName = cstring(LIBSECRET_SCHEMA)
  const accountName = cstring('account')
  const defaultAlias = cstring('default')
  const textPlain = cstring('text/plain')
  // Both live as long as the binding: one session, one schema.
  let service: Pointer | null = null
  let schema: Pointer | null = null

  /** Runs a call that ends in GError**; a set error is read for its code only, freed, and thrown. */
  const withError = <T>(operation: SecretOperation, body: (errorOut: Buffer) => T): T => {
    const errorOut = Buffer.alloc(POINTER_SIZE)
    const result = body(errorOut)
    const error = read.ptr(ptr(errorOut), 0) as Pointer
    if (isNull(error)) return result
    const code = read.i32(error, GERROR_CODE_OFFSET)
    glib.g_error_free(error)
    throw new SecretServiceError(operation, code)
  }

  /** A string table over buffers the caller keeps alive until it is unref'd. */
  const stringTable = (key: Buffer, value: Buffer | null): Pointer => {
    const table = glib.g_hash_table_new(strHash, strEqual)
    if (isNull(table)) throw new SecretServiceError('search', 0)
    glib.g_hash_table_insert(table, key, value)
    return table
  }

  const connect = (): Pointer => {
    if (service !== null) return service
    const connected = withError('connect', (errorOut) => secret.secret_service_get_sync(SERVICE_OPEN_SESSION, null, errorOut))
    if (isNull(connected)) throw new SecretServiceError('connect', 0)
    service = connected
    return connected
  }

  const theSchema = (): Pointer => {
    if (schema !== null) return schema
    // One attribute, `account`, of type SECRET_SCHEMA_ATTRIBUTE_STRING (0, so a NULL value).
    const types = stringTable(accountName, null)
    try {
      const made = secret.secret_schema_newv(schemaName, SCHEMA_NONE, types)
      if (isNull(made)) throw new SecretServiceError('search', 0)
      schema = made
      return made
    } finally {
      glib.g_hash_table_unref(types)
    }
  }

  /** Runs `body` with a fresh { account } table, unref'd afterwards. */
  const withAttributes = <T>(account: string, body: (attributes: Pointer) => T): T => {
    const accountValue = cstring(account)
    const attributes = stringTable(accountName, accountValue)
    try {
      return body(attributes)
    } finally {
      glib.g_hash_table_unref(attributes)
      // Keeps the value buffer referenced until the table is gone.
      accountValue.fill(0)
    }
  }

  /** The items for `account`, handed to `body`; every item and the list are released afterwards. */
  const search = <T>(account: string, flags: number, operation: SecretOperation, body: (items: readonly Pointer[]) => T): T => {
    const connected = connect()
    const searchSchema = theSchema()
    const list = withAttributes(account, (attributes) =>
      withError(operation, (errorOut) => secret.secret_service_search_sync(connected, searchSchema, attributes, flags, null, errorOut)))
    const items: Pointer[] = []
    for (let node = list; !isNull(node); node = read.ptr(node, GLIST_NEXT_OFFSET) as Pointer) {
      const item = read.ptr(node, 0) as Pointer
      if (!isNull(item)) items.push(item)
    }
    try {
      return body(items)
    } finally {
      for (const item of items) gobject.g_object_unref(item)
      if (!isNull(list)) glib.g_list_free(list)
    }
  }

  const isLocked = (item: Pointer): boolean => secret.secret_item_get_locked(item) !== 0

  /** null when the secret was not loaded or is not text. */
  const readText = (item: Pointer): string | null => {
    const value = secret.secret_item_get_secret(item)
    if (isNull(value)) return null
    try {
      const text = secret.secret_value_get_text(value)
      return isNull(text) ? null : new CString(text).toString()
    } finally {
      secret.secret_value_unref(value)
    }
  }

  /** A SecretValue from a buffer that is zero-filled once libsecret has its copy. */
  const withValue = <T>(text: string, body: (value: Pointer) => T): T => {
    const bytes = Buffer.from(text, 'utf8')
    let value: Pointer | null
    try {
      value = secret.secret_value_new(bytes, bytes.length, textPlain)
    } finally {
      bytes.fill(0)
    }
    if (isNull(value)) throw new SecretServiceError('store', 0)
    try {
      return body(value)
    } finally {
      secret.secret_value_unref(value)
    }
  }

  /** The default collection, or null when there is none; released afterwards. */
  const withDefault = <T>(operation: SecretOperation, body: (collection: Pointer | null) => T): T => {
    const connected = connect()
    const collection = withError(operation, (errorOut) =>
      secret.secret_collection_for_alias_sync(connected, defaultAlias, COLLECTION_NONE, null, errorOut))
    if (isNull(collection)) return body(null)
    try {
      return body(collection)
    } finally {
      gobject.g_object_unref(collection)
    }
  }

  const createItem = (account: string, label: string, value: Pointer): void =>
    withDefault('store', (collection) => {
      // Creating a default keyring would prompt; the probe refuses a host without one.
      if (collection === null) throw new SecretServiceError('store', 0)
      if (secret.secret_collection_get_locked(collection) !== 0) throw new SecretServiceError('store', 'locked')
      const labelText = cstring(label)
      const itemSchema = theSchema()
      const item = withAttributes(account, (attributes) =>
        withError('store', (errorOut) =>
          secret.secret_item_create_sync(collection, itemSchema, attributes, labelText, value, ITEM_CREATE_NONE, null, errorOut)))
      if (isNull(item)) throw new SecretServiceError('store', 0)
      gobject.g_object_unref(item)
    })

  const setAll = (items: readonly Pointer[], value: Pointer): void => {
    for (const item of items) {
      const ok = withError('store', (errorOut) => secret.secret_item_set_secret_sync(item, value, null, errorOut))
      if (ok === 0) throw new SecretServiceError('store', 0)
    }
  }

  return {
    defaultCollection: () =>
      withDefault('connect', (collection): SecretCollectionState => {
        if (collection === null) return 'missing'
        return secret.secret_collection_get_locked(collection) !== 0 ? 'locked' : 'unlocked'
      }),
    exists: (account) => search(account, SEARCH_NONE, 'search', (items) => items.length > 0),
    // Without SEARCH_ALL libsecret returns one item, an unlocked one when there is one.
    lookup: (account) =>
      search(account, SEARCH_LOAD_SECRETS, 'lookup', (items): SecretLookup => {
        const [item] = items
        if (item === undefined) return { found: false }
        if (isLocked(item)) return { found: true, locked: true }
        return { found: true, locked: false, value: readText(item) }
      }),
    // Every item gets the value, so whichever one a later lookup returns agrees.
    store: (account, label, text) =>
      search(account, SEARCH_ALL, 'store', (items) => {
        if (items.some(isLocked)) throw new SecretServiceError('store', 'locked')
        withValue(text, (value) => (items.length === 0 ? createItem(account, label, value) : setAll(items, value)))
      }),
    remove: (account) =>
      search(account, SEARCH_ALL, 'delete', (items) => {
        // Deleting a locked item can prompt, so none goes while one is locked.
        if (items.some(isLocked)) throw new SecretServiceError('delete', 'locked')
        for (const item of items) {
          const ok = withError('delete', (errorOut) => secret.secret_item_delete_sync(item, null, errorOut))
          if (ok === 0) throw new SecretServiceError('delete', 0)
        }
        return items.length > 0
      }),
  }
}
