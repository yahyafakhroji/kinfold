// npm installs a CLI on Windows as a .cmd shim (claude.cmd, codex.cmd,
// opencode.cmd). A .cmd file cannot be spawned directly, and running it through
// cmd.exe would put every argument, the observer's system prompt included,
// through cmd's parser, where &, |, % and " change what runs. So the shim is
// read instead and its target run directly: node with the bin script, or the
// bin's own program. npm writes these shims from one template (cmd-shim), and
// anything else is refused rather than handed to a shell.

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { ObserverError } from '../types'
import type { SpawnFn } from './claude-cli'

const IS_CMD = /\.(cmd|bat)$/i
// The last line of a cmd-shim: "%_prog%" (node) then the script, or the program alone, then %*.
const NODE_TARGET = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/
const DIRECT_TARGET = /"%dp0%\\([^"]+)"\s+%\*/

/** A path under the shim's folder, or null when the shim's relative path leaves it. */
function inside(folder: string, windowsRelative: string): string | null {
  const target = join(folder, ...windowsRelative.split('\\'))
  const rel = relative(folder, target)
  return rel === '' || rel.startsWith('..') || rel.split(sep).includes('..') ? null : target
}

/**
 * The command to run in the shim's place, before the CLI's own arguments:
 * [node, script] for a JS bin, [program] for a native one. Null for a file
 * that is not an npm shim, a target that is missing or outside the shim's
 * folder, or a JS bin with no node to run it.
 */
export function resolveCmdShim(
  shimPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  exists: (path: string) => boolean = existsSync,
  which: (command: string) => string | null = (command) => Bun.which(command),
): { argv0: string[] } | null {
  let text: string
  try {
    text = readFile(shimPath)
  } catch {
    return null
  }
  const folder = dirname(shimPath)
  const viaNode = NODE_TARGET.exec(text)
  if (viaNode !== null) {
    const script = inside(folder, viaNode[1]!)
    if (script === null || !exists(script)) return null
    const local = join(folder, 'node.exe')
    const node = exists(local) ? local : which('node')
    return node === null ? null : { argv0: [node, script] }
  }
  const direct = DIRECT_TARGET.exec(text)
  if (direct === null) return null
  const program = inside(folder, direct[1]!)
  return program === null || !exists(program) ? null : { argv0: [program] }
}

/** A spawn that runs a .cmd or .bat first argument through its npm shim's target, and passes everything else through unchanged. */
export function withCmdShims(spawn: SpawnFn, resolve: (shimPath: string) => { argv0: string[] } | null = (path) => resolveCmdShim(path)): SpawnFn {
  return async (request) => {
    const [first, ...rest] = request.cmd
    if (first === undefined || !IS_CMD.test(first)) return spawn(request)
    const shim = resolve(first)
    if (shim === null) {
      throw new ObserverError('cli_missing', `${basename(first)} is a .cmd file that is not an npm shim; install the CLI so it has an .exe`)
    }
    return spawn({ ...request, cmd: [...shim.argv0, ...rest] })
  }
}
