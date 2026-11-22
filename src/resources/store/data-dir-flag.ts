// A checkout runs hook.ts, server.ts and main.ts directly, so a `--data-dir`
// written into a host entry reaches them as an argument, not through the
// program's global flag parser. This applies it the way the program does:
// the store environment variable wins for the rest of the process.

import { isAbsolute } from 'node:path'
import { envName } from '../env-names'

/** Takes `--data-dir <path>` or `--data-dir=<path>` out of argv, sets the data folder variable from it, and returns the rest. */
export function applyDataDirFlag(argv: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg !== '--data-dir' && !arg.startsWith('--data-dir=')) {
      rest.push(arg)
      continue
    }
    const inline = arg.startsWith('--data-dir=')
    const value = inline ? arg.slice('--data-dir='.length) : argv[index + 1]
    if (value === undefined || value === '' || !isAbsolute(value)) throw new Error('--data-dir needs an absolute path')
    env[envName('DATA_DIR')] = value
    if (!inline) index += 1
  }
  return rest
}
