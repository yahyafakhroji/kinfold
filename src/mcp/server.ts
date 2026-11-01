// Entry for the stdio MCP server: `bun src/mcp/server.ts`, registered with
// Claude Code and OpenCode (src/install/mcp-config.ts builds the entries).
// stdout carries the protocol only; logs go to stderr. The project key is
// resolved once from the cwd the host started us in, and the database is
// opened read-only on first use and kept, so it works with the daemon up or
// down and never writes (D3). A missing database is asked for again on each
// call, so memory recorded after start is picked up. Each answered tool call
// is reported to the daemon after the reply (src/mcp/read-reporter.ts), which
// writes the mcp_reads row; the host comes from KINFOLD_MCP_HOST. Search asks the
// daemon for semantic matches too (P2-A, src/mcp/semantic-client.ts) and falls
// back to keyword-only when the daemon is down or slow.

import { resolveDataDir } from '../store/data-dir'
import { DAEMON_GIT_TIMEOUT_MS, type GitRunner, GitTimeoutError, gitRunnerWithTimeout, resolveProjectKey } from '../store/project-key'
import { MAX_LINE_CHARS, handleLine, oversizeReply } from './protocol'
import { type ReadReporter, createReadReporter, hostFromEnv } from './read-reporter'
import { type MemoryReader, openMemoryReader } from './reader'
import { type SemanticClient, createSemanticClient } from './semantic-client'

export interface McpServerOptions {
  dataDir: string
  cwd: string
  git?: GitRunner
  log?: (line: string) => void
  now?: () => number
  clock?: () => number
  /** Read reports to the daemon (P1-H); main() builds one from KINFOLD_MCP_HOST, tests may leave it out. */
  reporter?: ReadReporter
  /** Vector search through the daemon (P2-A); main() builds one, tests may leave it out for keyword-only search. */
  semantic?: SemanticClient
}

export interface McpServer {
  /** Null when git timed out; tools then need an explicit project. */
  projectKey: string | null
  handleLine(line: string): Promise<string | null>
  close(): void
}

export const READER_TTL_MS = 30_000

/** Startup runs off the agent's hot path, so git gets the daemon's longer timeout. */
function projectKeyFor(cwd: string, git: GitRunner): string | null {
  try {
    return resolveProjectKey(cwd, git).key
  } catch (error: unknown) {
    if (error instanceof GitTimeoutError) return null
    throw error
  }
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const log = options.log ?? (() => {})
  const projectKey = projectKeyFor(options.cwd, options.git ?? gitRunnerWithTimeout(DAEMON_GIT_TIMEOUT_MS))
  const now = options.now ?? Date.now
  let reader: MemoryReader | null = null
  let openedAt = 0
  // A reader that fell back to immutable=1 never sees rows written after it
  // opened, and an MCP server lives as long as the host session. Reopening
  // every READER_TTL_MS bounds how stale an answer can be at the cost of a few
  // prepared statements. A reader idle that long is closed too, so an idle
  // session holds no handle on memory.db and `kinfold encrypt` can take the file.
  let idle: Timer | null = null
  const closeReader = (): void => {
    reader?.close()
    reader = null
  }
  const getReader = (): MemoryReader | null => {
    if (idle !== null) clearTimeout(idle)
    idle = setTimeout(closeReader, READER_TTL_MS)
    idle.unref()
    if (reader !== null && now() - openedAt >= READER_TTL_MS) {
      reader.close()
      reader = null
    }
    if (reader === null) {
      reader = openMemoryReader(options.dataDir)
      openedAt = now()
    }
    return reader
  }
  const deps = {
    tools: { reader: getReader, projectKey, now, ...(options.semantic !== undefined ? { semantic: options.semantic } : {}) },
    log,
    clock: options.clock ?? (() => performance.now()),
    ...(options.reporter !== undefined ? { reporter: options.reporter } : {}),
  }
  return {
    projectKey,
    handleLine: (line) => handleLine(line, deps),
    close: () => {
      if (idle !== null) clearTimeout(idle)
      closeReader()
    },
  }
}

/**
 * Reads newline-delimited messages until the input ends. A line longer than
 * MAX_LINE_CHARS is answered with one parse error and skipped to its newline,
 * so a runaway client cannot grow the buffer without bound.
 */
export async function runStdio(server: McpServer, input: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let skipping = false
  const answer = async (line: string): Promise<void> => {
    const reply = await server.handleLine(line)
    if (reply !== null) write(`${reply}\n`)
  }
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      if (!skipping) await answer(buffer.slice(0, newline))
      skipping = false
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    if (!skipping && buffer.length > MAX_LINE_CHARS) {
      write(`${oversizeReply()}\n`)
      skipping = true
    }
    if (skipping) buffer = ''
  }
  if (!skipping) await answer(buffer + decoder.decode())
}

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`sam-mcp: ${line}\n`)
  const dataDir = resolveDataDir()
  const host = hostFromEnv(process.env)
  const reporter = createReadReporter({ dataDir, host })
  const server = createMcpServer({ dataDir, cwd: process.cwd(), log, reporter, semantic: createSemanticClient({ dataDir }) })
  log(`ready project=${server.projectKey === null ? 'unresolved' : 'resolved'} host=${host ?? 'unknown'}`)
  try {
    await runStdio(server, Bun.stdin.stream(), (line) => {
      process.stdout.write(line)
    })
  } finally {
    server.close()
    await reporter.settled()
    log(`stdin closed, exiting report_drops=${reporter.drops()}`)
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`sam-mcp: fatal ${error instanceof Error ? error.name : typeof error}\n`)
    process.exit(1)
  })
}
