// Readers for a caught value. No imports: the hook, the plugins, the daemon and
// the installer all load this, so it must stay a leaf.

/** The message of an Error, anything else as text. A message can quote a path or content: log it only where that is safe. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The class name only, for logs that must not quote a prompt or a path. */
export function errorName(error: unknown, fallback = 'unknown error'): string {
  return error instanceof Error ? error.name : fallback
}

/** The errno-style code (ENOENT, EEXIST) of a failed system call, when the value carries one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
