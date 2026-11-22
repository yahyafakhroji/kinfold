// The daemon's port, as numbers and nothing else: no imports, so the installer,
// the service readers and WSL can name it without loading the daemon (store,
// observers, routes) for one constant.

export const DEFAULT_PORT = 37_811
/** The highest TCP port. */
export const MAX_PORT = 65_535

/**
 * A port as a service's own config holds it (a plist or unit environment
 * value, a task's --port argument): digits only, 1 to 65535. Null for a
 * missing or malformed value. A reader takes any valid port it finds on disk;
 * the range a new install may pick is the installer's rule, not this one.
 */
export function parsePortValue(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= MAX_PORT ? port : null
}
