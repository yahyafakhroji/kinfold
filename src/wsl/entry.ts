// What install, status and uninstall do first when they run inside WSL. A
// distro with a Kinfold install on its Windows side links to it (a preview):
// the distro's agents run ~/.kinfold-wsl/bin/kinfold with --data-dir naming
// the Windows data folder through /mnt/<drive>, so both sides share one
// memory, with the daemon on Windows. Hooks spool into that folder and the
// MCP server reads through the daemon over loopback, which WSL reaches only
// with mirrored networking. Each hook answers null to let the command go on
// as on plain Linux, which makes a separate memory in this distro.
//
// The program sits in ~/.kinfold-wsl/bin rather than on /mnt/c: every hook
// starts it, and starting a large binary over the 9P drive mount is slow.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectHosts, INSTALL_HOSTS, type InstallHost, selectedHosts } from '../install/detect'
import { type InstallEnv, platformOf } from '../install/env'
import { hostHookInstallActions } from '../install/host-wiring'
import { EXIT_FAILED, EXIT_OK, agentWiringActions } from '../install/install'
import type { InstallOptions } from '../install/install'
import { type Action, runPlan } from '../install/plan'
import { programInstallActions } from '../install/self-install'
import { currentChannel, installRecordAction, readInstallRecord } from '../install/setup/record'
import { hostStatusLines } from '../install/status'
import { hostUnwireActions } from '../install/uninstall'
import type { UninstallOptions } from '../install/uninstall'
import { DATA_DIR_MODE } from '../store/data-dir'
import { PREVIEW, type WslLink, readWslLink, wslHomeDir, wslLinkAction } from './link'
import { type WindowsDaemonHealth, findWindowsInstall, networkingMode, windowsDaemonHealth } from './windows-install'

export interface WslStatus {
  lines: string[]
  /** True: these lines are the whole status, and the plain Linux status is not printed. */
  replaces: boolean
}

export { PREVIEW }
export const NOT_LINKED_LINE = `${PREVIEW}: this distro keeps its own memory; it is not linked to a Windows install`
export const MIRRORED_ADVICE = 'WSL reaches it only with mirrored networking: add networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, run wsl --shutdown, and install again'

export function noDaemonRefusal(windowsDataDir: string): string {
  return `${PREVIEW}: the Windows install at ${windowsDataDir} has no running daemon; start Kinfold on Windows and install again. Nothing was changed`
}

export function unreachableRefusal(port: number): string {
  return `${PREVIEW}: the Windows daemon at 127.0.0.1:${port} does not answer from this distro. ${MIRRORED_ADVICE}. Nothing was changed`
}

export function fallThroughLine(reason: string): string {
  return `${PREVIEW}: no Windows install found (${reason}); installing a separate Linux memory in this distro`
}

function programPath(homeDir: string): string {
  return join(wslHomeDir(homeDir), 'bin', 'kinfold')
}

/** The env every linked step plans against: the Windows folder, the WSL program, and no service of its own. */
function linkedEnv(env: InstallEnv, dataDir: string): InstallEnv {
  return { ...env, dataDir, unflaggedDataDir: dataDir, mode: { kind: 'program', binPath: programPath(env.homeDir) }, service: null }
}

/** Hosts with Kinfold entries now; unwiring a host with none plans nothing. */
function wiredHosts(env: InstallEnv): InstallHost[] {
  return INSTALL_HOSTS.filter((host) => hostUnwireActions(env, host).length > 0)
}

function hostList(hosts: readonly InstallHost[]): string {
  return hosts.length === 0 ? 'no agents' : hosts.join(', ')
}

/** --data-dir naming another folder asks for a separate Linux memory, which the plain install makes. */
function separateMemoryAsked(env: InstallEnv): boolean {
  return env.unflaggedDataDir !== undefined && env.unflaggedDataDir !== env.dataDir
}

function healthRefusal(health: Exclude<WindowsDaemonHealth, { up: true }>, windowsDataDir: string): string {
  return health.port === null ? noDaemonRefusal(windowsDataDir) : unreachableRefusal(health.port)
}

async function hookActions(env: InstallEnv, hosts: readonly InstallHost[], options: InstallOptions): Promise<Action[]> {
  return [
    ...(await agentWiringActions(env, hosts, options.opencodeAssets)),
    ...(hosts.includes('codex') ? hostHookInstallActions(env, 'codex') : []),
    ...(hosts.includes('cursor') ? hostHookInstallActions(env, 'cursor') : []),
  ]
}

function recordActions(env: InstallEnv, wslHome: string, options: InstallOptions): Action[] {
  const saved = readInstallRecord(wslHome)
  const record = {
    channel: currentChannel(env, saved),
    updateCheck: options.noUpdateCheck === true ? false : (saved?.updateCheck ?? true),
    firstInstalledAt: saved?.firstInstalledAt ?? env.now(),
  }
  const same = saved !== null && saved.channel === record.channel && saved.updateCheck === record.updateCheck
  return same ? [] : [installRecordAction(wslHome, record)]
}

/** The link file, rewritten only when it would name other folders; an unchanged link keeps its time. */
function linkActions(env: InstallEnv, wslHome: string, found: Omit<WslLink, 'linkedAt'>, previous: WslLink | null): Action[] {
  const same = previous !== null && previous.windowsDataDir === found.windowsDataDir && previous.dataDir === found.dataDir && previous.taskConfig === found.taskConfig
  return same ? [] : [wslLinkAction(wslHome, { ...found, linkedAt: env.now() })]
}

/** An exit code ends the install there; null goes on with the plain install. */
export async function wslInstall(env: InstallEnv, options: InstallOptions): Promise<number | null> {
  if (!platformOf(env).wsl || separateMemoryAsked(env)) return null
  const find = await findWindowsInstall(env)
  if (find.kind === 'none') {
    env.out(fallThroughLine(find.reason))
    return null
  }
  const found = find.link
  const health = await windowsDaemonHealth(env, found.dataDir)
  if (!health.up) {
    env.out(healthRefusal(health, found.windowsDataDir))
    return EXIT_FAILED
  }
  const wslHome = wslHomeDir(env.homeDir)
  const linked = linkedEnv(env, found.dataDir)
  const previous = readWslLink(wslHome)
  const hosts = selectedHosts(await detectHosts(linked, options.hosts))
  // Only a previous link's wiring is this distro's to drop; with no link, entries found belong to another install.
  const dropped = previous === null ? [] : wiredHosts(linked).filter((host) => !hosts.includes(host))
  const program = await programInstallActions(linked, { source: options.programSource ?? process.execPath, dryRun: options.dryRun, version: options.releaseVersion })
  const actions: Action[] = [
    ...(existsSync(wslHome) ? [] : [{ kind: 'mkdir', path: wslHome, mode: DATA_DIR_MODE } as const]),
    ...program.actions,
    ...(await hookActions(linked, hosts, options)),
    ...dropped.flatMap((host) => hostUnwireActions(linked, host)),
    ...recordActions(linked, wslHome, options),
    // Last: until every step above ran, status must not report a link.
    ...linkActions(env, wslHome, found, previous),
  ]
  await runPlan(linked, actions, options.dryRun)
  if (!options.dryRun) env.out(`${PREVIEW}: wired ${hostList(hosts)} to the Windows memory at ${found.windowsDataDir}`)
  return EXIT_OK
}

function healthLine(health: WindowsDaemonHealth): string {
  return health.up ? `daemon /health from WSL: up on 127.0.0.1:${health.port} (${health.version})` : `daemon /health from WSL: not answering; ${MIRRORED_ADVICE}`
}

/** Lines printed before the status, or null for none: outside WSL, and for a separate Linux memory named with --data-dir. */
export async function wslStatus(env: InstallEnv): Promise<WslStatus | null> {
  if (!platformOf(env).wsl || separateMemoryAsked(env)) return null
  const link = readWslLink(wslHomeDir(env.homeDir))
  if (link === null) return { lines: [NOT_LINKED_LINE], replaces: false }
  const linked = linkedEnv(env, link.dataDir)
  const [mode, health] = await Promise.all([networkingMode(env), windowsDaemonHealth(env, link.dataDir)])
  return {
    lines: [
      `${PREVIEW}: linked to the Windows memory at ${link.windowsDataDir} (${link.dataDir})`,
      `${PREVIEW}: networking ${mode}`,
      healthLine(health),
      `program: ${programPath(env.homeDir)}`,
      'hosts:',
      ...(await hostStatusLines(linked)),
    ],
    replaces: true,
  }
}

/**
 * An exit code ends the uninstall there; null goes on with the plain uninstall.
 * A linked distro removes only its own wiring and ~/.kinfold-wsl: the Windows
 * folder holds the shared memory and belongs to the Windows install. A
 * separate Linux memory named with --data-dir is the plain uninstall's, and
 * the link stays.
 */
export async function wslUninstall(env: InstallEnv, options: UninstallOptions): Promise<number | null> {
  if (!platformOf(env).wsl || separateMemoryAsked(env)) return null
  const wslHome = wslHomeDir(env.homeDir)
  const link = readWslLink(wslHome)
  if (link === null) return null
  const linked = linkedEnv(env, link.dataDir)
  const hosts = wiredHosts(linked)
  const actions: Action[] = [
    ...hosts.flatMap((host) => hostUnwireActions(linked, host)),
    // Last: until every host entry is gone, each of them still names this program.
    { kind: 'remove', path: wslHome, recursive: true, summary: 'the WSL link, its install record and the WSL kinfold program' },
  ]
  await runPlan(linked, actions, options.dryRun)
  if (!options.dryRun) env.out(`${PREVIEW}: unwired ${hostList(hosts)}; the Windows install at ${link.windowsDataDir} is unchanged. Uninstall it from Windows`)
  return EXIT_OK
}
