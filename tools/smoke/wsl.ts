// The WSL smoke on a Windows runner: Kinfold installed on Windows, the Linux
// build run inside an Ubuntu distro. GitHub's Windows runners refuse
// networkingMode=mirrored (WSL falls back with ConfigureNetworking/0x803b0015),
// so the distro runs under NAT and cannot reach the Windows daemon over
// loopback. What the run proves is everything short of that hop: the distro
// finds the Windows install through interop and /mnt/c, install refuses under
// NAT with the mirrored advice and changes nothing, and a hook run in the
// distro spools into the Windows folder, where the Windows daemon ingests it.

import { NOT_LINKED_LINE, unreachableRefusal } from '../../src/wsl/entry'
import { SmokeError, type SmokeResult } from './platform'

/** The distro's root user, whose home the WSL install would write to. */
const DISTRO_HOME = '/root'

/** --exec starts the command itself: after a bare --, the distro's shell would read each argument and drop a Windows path's backslashes. */
export function distroArgv(distro: string, argv: readonly string[]): string[] {
  return ['wsl.exe', '-d', distro, '-u', 'root', '--exec', 'env', `HOME=${DISTRO_HOME}`, ...argv]
}

function shown(result: SmokeResult): string {
  return `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
}

export function expectNotLinked(result: SmokeResult): void {
  if (!result.stdout.includes(NOT_LINKED_LINE)) throw new SmokeError('wsl status', `status in the distro did not say it is unlinked\n${shown(result)}`)
}

/** NAT never links: install must fail with the unreachable refusal, which carries the mirrored advice. */
export function expectNatRefusal(result: SmokeResult, port: number): void {
  if (result.code === 0) throw new SmokeError('wsl install', `install in the distro succeeded under NAT networking\n${shown(result)}`)
  if (!result.stdout.includes(unreachableRefusal(port))) throw new SmokeError('wsl install', `install in the distro did not refuse with the NAT explanation\n${shown(result)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The event count the daemon's /sessions route gives the session, or null when it lists none by that id. */
export function sessionEventCount(body: unknown, hostSessionId: string): number | null {
  if (!isRecord(body) || !Array.isArray(body.sessions)) return null
  const session = body.sessions.find((row) => isRecord(row) && row.hostSessionId === hostSessionId)
  return isRecord(session) && typeof session.eventCount === 'number' ? session.eventCount : null
}

export function hookPayload(marker: string): string {
  return JSON.stringify({
    session_id: `wsl-${marker}`,
    cwd: DISTRO_HOME,
    hook_event_name: 'Stop',
    last_assistant_message: `A hook in the WSL distro carried ${marker} into the Windows memory.`,
  })
}
