// The /read/ routes: memory reads over the daemon's own store, for a client
// that cannot open memory.db itself. They take the data-folder token like
// every other API route. No route is served yet, so every /read/ path falls
// through to the server's 404.

import type { Parsed } from '../context/types'
import type { MemoryReader } from '../mcp/reader'
import type { SemanticClient } from '../mcp/semantic-client'
import type { ProjectKeyResolver } from '../store/project-key'
import type { RouteAnswer } from './data-routes'

export interface ReadRouteDeps {
  /** A read-only reader over the daemon's store, opened on first use; null while there is no database. */
  reader: () => MemoryReader | null
  /** The resolver ingest uses, so a cwd maps to the same project key on both paths. */
  projectKeyFor: ProjectKeyResolver
  now: () => number
  /** Present only when sqlite-vec loaded in the daemon. */
  semantic?: SemanticClient
}

/** The answer for a /read/ path, or null for the server's 404. */
export async function readRoute(
  _method: string,
  _path: string,
  _body: () => Promise<Parsed<unknown>>,
  _deps: ReadRouteDeps,
  _log: (line: string) => void,
): Promise<RouteAnswer | null> {
  return null
}
