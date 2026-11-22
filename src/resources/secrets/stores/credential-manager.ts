// Windows Credential Manager as a KeyStore: one generic credential per ref,
// named kinfold/<ref>, through advapi32's CredReadW, CredWriteW and
// CredDeleteW. A value goes from a JS buffer straight into the call, never
// into argv, an env var, a child process, a log line or an error, and the
// buffer is zeroed once the call returns. Errors carry the Win32 code only.
// The credential is kept on this machine and never roams with the profile.
// advapi32 is opened only on Windows, by probe or by a store's first call.

import { type Pointer, dlopen, ptr, read, toArrayBuffer } from 'bun:ffi'
import { assertCredentialRef, assertStorableValue } from '../credentials'
import type { KeyStore, KeyStoreDeps, KeyStoreModule, KeyStoreProbe } from '../key-store'

export const CRED_TARGET_PREFIX = 'kinfold/'
export const CRED_USER_NAME = 'kinfold'
/** CRED_MAX_CREDENTIAL_BLOB_SIZE */
export const CRED_MAX_BLOB_BYTES = 2_560
export const ERROR_NOT_FOUND = 1_168
export const ERROR_NO_SUCH_LOGON_SESSION = 1_312

export const CRED_TYPE_GENERIC = 1
/** Kept on this machine: a roaming profile never copies it elsewhere. */
export const CRED_PERSIST_LOCAL_MACHINE = 2

export type CredResult<T> = { ok: true; value: T } | { ok: false; error: number }

/** The four advapi32 calls; the real one is FFI, tests pass an in-memory one. */
export interface CredApi {
  /** Copies the blob out and frees the native credential. */
  read(target: string): CredResult<Uint8Array>
  /** Reads and frees without copying the blob into JS. */
  peek(target: string): CredResult<true>
  write(target: string, blob: Uint8Array): CredResult<true>
  remove(target: string): CredResult<true>
}

const LABEL = 'Credential Manager'
const PLACE = 'Windows Credential Manager'
const PROBE_TARGET = `${CRED_TARGET_PREFIX}probe`
const OFF_WINDOWS = 'Credential Manager exists only on Windows'

export function credentialTarget(account: string): string {
  return `${CRED_TARGET_PREFIX}${account}`
}

// ---- The x64 CREDENTIALW ------------------------------------------------------

export const CREDENTIALW_SIZE = 80
export const CREDENTIALW_OFFSETS = {
  flags: 0,
  type: 4,
  targetName: 8,
  comment: 16,
  lastWritten: 24,
  credentialBlobSize: 32,
  credentialBlob: 40,
  persist: 48,
  attributeCount: 52,
  attributes: 56,
  targetAlias: 64,
  userName: 72,
} as const

/** A NUL-terminated UTF-16LE string, as the W functions take. */
export function wideString(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${text}\0`, 'utf16le'))
}

/** CREDENTIALW for CredWriteW, with every buffer its pointers name; all must stay alive through the call. */
export interface PackedCredential {
  struct: Uint8Array
  targetName: Uint8Array
  userName: Uint8Array
  blob: Uint8Array
}

/** Fields left unset stay zero: no comment, alias or attributes, and LastWritten is ignored by CredWriteW. */
export function packCredential(target: string, blob: Uint8Array): PackedCredential {
  const targetName = wideString(target)
  const userName = wideString(CRED_USER_NAME)
  const struct = new Uint8Array(CREDENTIALW_SIZE)
  const view = new DataView(struct.buffer)
  const at = CREDENTIALW_OFFSETS
  view.setUint32(at.type, CRED_TYPE_GENERIC, true)
  view.setBigUint64(at.targetName, BigInt(ptr(targetName)), true)
  view.setUint32(at.credentialBlobSize, blob.byteLength, true)
  view.setBigUint64(at.credentialBlob, BigInt(ptr(blob)), true)
  view.setUint32(at.persist, CRED_PERSIST_LOCAL_MACHINE, true)
  view.setBigUint64(at.userName, BigInt(ptr(userName)), true)
  return { struct, targetName, userName, blob }
}

// ---- The real API -------------------------------------------------------------

const ADVAPI32_SYMBOLS = {
  CredReadW: { args: ['ptr', 'u32', 'u32', 'ptr'], returns: 'i32' },
  CredWriteW: { args: ['ptr', 'u32'], returns: 'i32' },
  CredDeleteW: { args: ['ptr', 'u32', 'u32'], returns: 'i32' },
  CredFree: { args: ['ptr'], returns: 'void' },
} as const

const KERNEL32_SYMBOLS = {
  GetLastError: { args: [], returns: 'u32' },
} as const

function createFfiCredApi(): CredApi {
  const advapi = dlopen('advapi32.dll', ADVAPI32_SYMBOLS).symbols
  const kernel = dlopen('kernel32.dll', KERNEL32_SYMBOLS).symbols
  // Asked straight after a call returns FALSE, before anything else can reset it.
  const failed = (): { ok: false; error: number } => ({ ok: false, error: kernel.GetLastError() })

  /** Runs `use` on the native credential, then frees it. */
  const withCredential = <T>(target: string, use: (credential: Pointer) => T): CredResult<T> => {
    const name = wideString(target)
    const out = new BigUint64Array(1)
    if (advapi.CredReadW(ptr(name), CRED_TYPE_GENERIC, 0, ptr(out)) === 0) return failed()
    const credential = Number(out[0]) as Pointer
    try {
      return { ok: true, value: use(credential) }
    } finally {
      advapi.CredFree(credential)
    }
  }

  return {
    read: (target) => withCredential(target, (credential) => {
      const size = read.u32(credential, CREDENTIALW_OFFSETS.credentialBlobSize)
      if (size === 0) return new Uint8Array(0)
      const blob = read.ptr(credential, CREDENTIALW_OFFSETS.credentialBlob) as Pointer
      // slice() copies out of native memory, which CredFree releases next.
      return new Uint8Array(toArrayBuffer(blob, 0, size)).slice()
    }),
    peek: (target) => withCredential(target, () => true as const),
    write: (target, blob) => {
      const packed = packCredential(target, blob)
      try {
        if (advapi.CredWriteW(ptr(packed.struct), 0) === 0) return failed()
        return { ok: true, value: true }
      } finally {
        packed.struct.fill(0)
        blob.fill(0)
      }
    },
    remove: (target) => {
      const name = wideString(target)
      if (advapi.CredDeleteW(ptr(name), CRED_TYPE_GENERIC, 0) === 0) return failed()
      return { ok: true, value: true }
    },
  }
}

let loaded: CredApi | null = null

/** Opens advapi32 and kernel32 on the first call; a failed open is tried again on the next. */
export function loadCredApi(): CredApi {
  loaded ??= createFfiCredApi()
  return loaded
}

// ---- The store ----------------------------------------------------------------

function codeText(error: number): string {
  return error === 0 ? 'unknown' : String(error)
}

function failure(action: 'read' | 'write' | 'delete', ref: string, error: number): Error {
  return new Error(`Credential Manager: could not ${action} ${credentialTarget(ref)} (error ${codeText(error)})`)
}

/** A probe's reason: install prints it after the store's label, so it does not name the store again. */
function loadFailureReason(error: unknown): string {
  return `could not be loaded (${error instanceof Error ? error.name : 'unknown'})`
}

function loadFailure(error: unknown): string {
  return `${LABEL} ${loadFailureReason(error)}`
}

/** UTF-8 bytes. Too long is refused before any call, and no error quotes the value. */
function encodeValue(ref: string, value: string): Uint8Array {
  const blob = new TextEncoder().encode(value)
  if (blob.byteLength > CRED_MAX_BLOB_BYTES) {
    blob.fill(0)
    throw new Error(`Credential Manager: the value for ${ref} is longer than ${CRED_MAX_BLOB_BYTES} bytes`)
  }
  try {
    assertStorableValue(value)
  } catch (error: unknown) {
    blob.fill(0)
    throw error
  }
  return blob
}

export function createCredentialManagerStore(api: CredApi): KeyStore {
  const present = (ref: string): boolean => {
    assertCredentialRef(ref)
    const result = api.peek(credentialTarget(ref))
    if (result.ok) return true
    if (result.error === ERROR_NOT_FOUND) return false
    throw failure('read', ref, result.error)
  }
  const write = (ref: string, blob: Uint8Array): void => {
    try {
      const result = api.write(credentialTarget(ref), blob)
      if (!result.ok) throw failure('write', ref, result.error)
    } finally {
      blob.fill(0)
    }
  }
  return {
    kind: 'credential-manager',
    label: LABEL,
    place: PLACE,
    notes: [],
    get: (ref) => {
      assertCredentialRef(ref)
      const result = api.read(credentialTarget(ref))
      if (!result.ok) {
        if (result.error === ERROR_NOT_FOUND) return null
        throw failure('read', ref, result.error)
      }
      try {
        return new TextDecoder().decode(result.value)
      } finally {
        result.value.fill(0)
      }
    },
    exists: present,
    set: (ref, value) => {
      assertCredentialRef(ref)
      write(ref, encodeValue(ref, value))
    },
    // Install is the one writer of new keys, so this read-then-write is not raced.
    create: (ref, value) => {
      assertCredentialRef(ref)
      const blob = encodeValue(ref, value)
      let exists: boolean
      try {
        exists = present(ref)
      } catch (error: unknown) {
        blob.fill(0)
        throw error
      }
      if (exists) {
        blob.fill(0)
        return false
      }
      write(ref, blob)
      return true
    },
    delete: (ref) => {
      assertCredentialRef(ref)
      const result = api.remove(credentialTarget(ref))
      if (result.ok) return true
      if (result.error === ERROR_NOT_FOUND) return false
      throw failure('delete', ref, result.error)
    },
    describeSet: (ref) => `Credential Manager: CredWriteW generic credential ${credentialTarget(ref)} with value <hidden>`,
    describeDelete: (ref) => `Credential Manager: CredDeleteW generic credential ${credentialTarget(ref)}`,
    describeEntry: (ref) => `the generic credential ${credentialTarget(ref)} in Windows Credential Manager (Control Panel > Credential Manager > Windows Credentials)`,
  }
}

/** Loads on a store's first call, so opening a store that is never used never touches advapi32. */
function lazyCredApi(load: () => CredApi): CredApi {
  const api = (): CredApi => {
    try {
      return load()
    } catch (error: unknown) {
      throw new Error(loadFailure(error))
    }
  }
  return {
    read: (target) => api().read(target),
    peek: (target) => api().peek(target),
    write: (target, blob) => api().write(target, blob),
    remove: (target) => api().remove(target),
  }
}

function probeWith(load: () => CredApi, deps: KeyStoreDeps): KeyStoreProbe {
  if (deps.platform.os !== 'windows') return { usable: false, reason: OFF_WINDOWS }
  let api: CredApi
  try {
    api = load()
  } catch (error: unknown) {
    return { usable: false, reason: loadFailureReason(error) }
  }
  // A read only, never a write: an answer, even "not found", shows the store works in this session.
  const result = api.peek(PROBE_TARGET)
  if (result.ok || result.error === ERROR_NOT_FOUND) return { usable: true }
  return { usable: false, reason: `not available in this logon session (error ${codeText(result.error)})` }
}

/** The module over a loader; the default opens advapi32, tests pass a fake. */
export function createCredentialManagerModule(load: () => CredApi = loadCredApi): KeyStoreModule {
  return {
    kind: 'credential-manager',
    label: LABEL,
    probe: (deps) => probeWith(load, deps),
    open: (deps) => {
      if (deps.platform.os !== 'windows') throw new Error(OFF_WINDOWS)
      return createCredentialManagerStore(lazyCredApi(load))
    },
  }
}

export const credentialManagerModule: KeyStoreModule = createCredentialManagerModule()
