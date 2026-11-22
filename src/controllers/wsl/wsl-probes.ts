// Two cheap questions asked only after the Windows daemon could not be
// reached from WSL, so the unavailable text names the likely cause: which
// networking mode WSL runs in (wslinfo), and whether the pid daemon.json
// names still runs on Windows (tasklist.exe through WSL interop). Both run by
// absolute path, from /, with a minimal environment and a hard timeout; any
// failure answers null ("unknown"), never an exception.

import { existsSync } from 'node:fs'

export const PROBE_TIMEOUT_MS = 1_500

const WSLINFO_PATHS = ['/usr/bin/wslinfo', '/bin/wslinfo'] as const
const TASKLIST = '/mnt/c/Windows/System32/tasklist.exe'
const MODE = /^[a-z]{1,20}$/
const MAX_OUTPUT_CHARS = 64 * 1024

export interface WslProbes {
  /** wslinfo --networking-mode, lowercased (nat, mirrored, ...); null when it cannot be asked. */
  networkingMode: () => Promise<string | null>
  /** Whether a Windows pid runs; null when it cannot be asked. */
  pidAlive: (pid: number) => Promise<boolean | null>
}

/** WSL_INTEROP is how a Windows .exe finds its way back from WSL; nothing else is passed down. */
function probeEnv(): Record<string, string> {
  const interop = process.env.WSL_INTEROP
  return { PATH: '/usr/bin:/bin', ...(interop !== undefined ? { WSL_INTEROP: interop } : {}) }
}

/** Stdout of a command that exited 0 within the timeout, else null. */
export async function runProbe(argv: readonly string[], timeoutMs: number, env: Record<string, string | undefined> = probeEnv()): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...argv], { cwd: '/', env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  } catch {
    // Missing binary or interop turned off.
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, timeoutMs)
  })
  const finished = (async (): Promise<string | null> => {
    const [stdout, code] = await Promise.all([new Response(child.stdout as ReadableStream<Uint8Array>).text(), child.exited])
    return code === 0 ? stdout.slice(0, MAX_OUTPUT_CHARS) : null
  })().catch(() => null)
  try {
    return await Promise.race([finished, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export function parseNetworkingMode(stdout: string | null): string | null {
  const mode = stdout?.trim().toLowerCase() ?? ''
  return MODE.test(mode) ? mode : null
}

/**
 * tasklist /FO CSV /NH prints one quoted row per match, its second field the
 * pid. With no match it prints a localized INFO line and no row, so "no row"
 * is the answer, whatever the language.
 */
export function parseTasklist(stdout: string | null, pid: number): boolean | null {
  if (stdout === null) return null
  const rows = stdout.split(/\r?\n/).filter((line) => line.startsWith('"'))
  return rows.some((row) => row.split('","')[1] === String(pid))
}

export const defaultWslProbes: WslProbes = {
  networkingMode: async () => {
    const wslinfo = WSLINFO_PATHS.find((path) => existsSync(path))
    return wslinfo === undefined ? null : parseNetworkingMode(await runProbe([wslinfo, '--networking-mode'], PROBE_TIMEOUT_MS))
  },
  pidAlive: async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    return parseTasklist(await runProbe([TASKLIST, '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], PROBE_TIMEOUT_MS), pid)
  },
}
