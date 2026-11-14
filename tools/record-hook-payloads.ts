// Records real hook payloads from a coding agent so they can become test
// fixtures, after a manual read for anything personal.
//
//   bun tools/record-hook-payloads.ts command <agent> <outDir>
//       prints the hook command line to wire into the agent's config
//   bun tools/record-hook-payloads.ts capture <agent> <outDir>
//       reads one stdin JSON payload, redacts it, writes <outDir>/<event>-<n>.json
//
// Only agents whose hooks pipe a JSON payload to a command on stdin fit here.
// Amp and Kilo's OpenCode plugin run TypeScript plugin code inside the agent
// instead, so their payloads are recorded differently, not by this tool.
//
// capture always exits 0 and writes nothing to stdout: some agents inject hook
// stdout into the model's context, and a failing hook can block the agent.
// Errors go to stderr and never include payload text.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { redactJson } from '../src/redaction/redact'

const EVENT_FIELDS = ['hook_event_name', 'event', 'hookEventName'] as const
const SAFE_NAME = /[^A-Za-z0-9_.-]/g
const TEST_DIR = resolve(import.meta.dir, '..', 'test')

/** POSIX single-quoting: safe for any characters in a path. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Returns an error message, or null when outDir is acceptable. */
export function checkOutDir(outDir: string): string | null {
  if (!isAbsolute(outDir)) return 'outDir must be an absolute path'
  const rel = relative(TEST_DIR, resolve(outDir))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return `outDir must not be inside test/ (copy fixtures in by hand after review)`
  }
  return null
}

export function hookCommand(agent: string, outDir: string): string {
  const script = import.meta.path
  return [process.execPath, script, 'capture', agent, outDir].map(shellQuote).join(' ')
}

function eventName(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    for (const field of EVENT_FIELDS) {
      const value = (payload as Record<string, unknown>)[field]
      if (typeof value === 'string' && value !== '') return value.replace(SAFE_NAME, '_')
    }
  }
  return 'unknown'
}

function nextPath(outDir: string, event: string): string {
  for (let n = 1; ; n++) {
    const path = join(outDir, `${event}-${n}.json`)
    if (!existsSync(path)) return path
  }
}

/** Writes the redacted payload; returns an error message or null. Never echoes payload text. */
export function capture(raw: string, outDir: string): string | null {
  const dirError = checkOutDir(outDir)
  if (dirError) return dirError
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return 'stdin was not valid JSON; nothing written'
  }
  // A throwaway key: fixtures carry refs that can't be matched to the real marker key.
  const redacted = redactJson(payload, 'payload', { hmacKey: randomBytes(32).toString('hex'), entropyMode: 'strict' })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(nextPath(outDir, eventName(payload)), `${JSON.stringify(redacted.value, null, 2)}\n`, { flag: 'wx' })
  return null
}

async function main(argv: string[]): Promise<number> {
  const [mode, agent, outDir] = argv
  if ((mode !== 'command' && mode !== 'capture') || !agent || !outDir) {
    console.error('usage: record-hook-payloads.ts <command|capture> <agent> <outDir>')
    return mode === 'capture' ? 0 : 2
  }
  if (mode === 'command') {
    const dirError = checkOutDir(outDir)
    if (dirError) {
      console.error(dirError)
      return 2
    }
    process.stdout.write(`${hookCommand(agent, outDir)}\n`)
    return 0
  }
  try {
    const error = capture(await Bun.stdin.text(), outDir)
    if (error) console.error(`record-hook-payloads: ${error}`)
  } catch (error) {
    console.error(`record-hook-payloads: ${error instanceof Error ? error.name : 'failed'}`)
  }
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
