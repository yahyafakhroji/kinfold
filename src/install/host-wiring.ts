// Plan actions for the OpenCode plugin file, the Codex and Cursor hook files
// and for the host_version record, in the same form install.ts builds for
// Claude Code: read the file
// (an unparseable one stops the install untouched), merge ours in with
// host-hooks.ts, back the original up before the first change, write it
// atomically. Uninstall takes only our entries out. Planning only reads;
// nothing here runs unless the host was detected or named by --hosts, so a
// machine without Codex or Cursor never has those files touched.
// Codex's file sits under CODEX_HOME when that is set (codex-home.ts). An
// unusable CODEX_HOME skips Codex with the reason, since Codex would not start
// with it either; uninstall also cleans ~/.codex, where an install run without
// CODEX_HOME would have put our entries.

import { existsSync } from 'node:fs'
import { normalizeVersion, parseHostVersions, serializeHostVersions, statMtime, type HostVersionRecord, type HostVersionRecords } from '../adapters/host-version'
import { type EmbeddedAssets, embeddedAssets } from '../runtime/embedded'
import { DATA_FILE_MODE } from '../store/data-dir'
import type { HostDetection } from './detect'
import { type InstallEnv, codexHomeProblem, errorMessage, installPaths } from './env'
import { entryCommand, entryIdentity } from './entry'
import { describeTextChange, plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { CODEX_HOOK_SPEC, CURSOR_HOOK_SPEC, type CommandHookHost, type CommandHookSpec, inspectHostHooks, mergeHostHooks, removeHostHooks } from './host-hooks'
import { inspectShim, pluginFileContent } from './opencode-shim'
import type { Action } from './plan'

const DIR_MODE = 0o755
const FILE_MODE = 0o644

export const HOST_HOOK_SPECS: Readonly<Record<CommandHookHost, CommandHookSpec>> = { codex: CODEX_HOOK_SPEC, cursor: CURSOR_HOOK_SPEC }

/** Codex runs a non-managed hook only after the user reviews it in /hooks; the hash changes when we rewrite it. */
export const CODEX_TRUST_NOTE = 'codex: open Codex and run /hooks to review and trust the Kinfold hooks; Codex skips untrusted hooks'

function hostFiles(env: InstallEnv, host: CommandHookHost): { dir: string; file: string } {
  const paths = installPaths(env)
  return host === 'codex' ? { dir: paths.codexDir, file: paths.codexHooks } : { dir: paths.cursorDir, file: paths.cursorHooks }
}

/**
 * The OpenCode plugin file. A checkout writes the shim that re-exports its
 * plugin; a program writes the bundle it carries under the data folder, so
 * OpenCode loads a file that needs neither the checkout nor SQLite. Both carry
 * our marker; a file without it is never touched.
 */
export async function opencodeInstallActions(env: InstallEnv, assets: EmbeddedAssets | null = embeddedAssets()): Promise<Action[]> {
  const paths = installPaths(env)
  const before = readTextOrNull(paths.opencodePlugin)
  const state = inspectShim(before, paths.pluginEntry)
  if (state === 'foreign') throw new Error(`${paths.opencodePlugin} exists and is not a Kinfold plugin file; move it away first`)
  const bundle = env.mode.kind === 'program' ? (assets === null ? null : await assets.opencodePlugin()) : ''
  if (bundle === null) throw new Error('this build carries no OpenCode plugin; reinstall from a release build')
  const content = pluginFileContent(env.mode, env.dataDir, bundle)
  if (state === 'yes' && before === content) {
    env.out(`opencode: plugin already in ${paths.opencodePlugin}`)
    return []
  }
  const summary = `${describeTextChange(before, content) ?? 'unchanged'}${state === 'stale' ? ', replacing a stale plugin path' : ''}`
  return [
    ...(existsSync(paths.opencodePluginsDir) ? [] : [{ kind: 'mkdir', path: paths.opencodePluginsDir, mode: DIR_MODE } as const]),
    { kind: 'write', path: paths.opencodePlugin, content, mode: FILE_MODE, summary },
  ]
}

export function hostHookInstallActions(env: InstallEnv, host: CommandHookHost): Action[] {
  const problem = host === 'codex' ? codexHomeProblem(env) : null
  if (problem !== null) {
    env.out(`codex: ${problem}; Codex will not start with it either, so its hooks were not wired. Fix or unset CODEX_HOME and rerun`)
    return []
  }
  const { dir, file: path } = hostFiles(env, host)
  if (host === 'codex' && env.codexHomeEnv !== undefined && env.codexHomeEnv !== '') env.out(`codex: CODEX_HOME is set; using ${path}`)
  const file = readJsonObject(path)
  const merge = mergeHostHooks(HOST_HOOK_SPECS[host], file.exists ? file.value : {}, { entry: entryCommand(env.mode, 'hook', env.dataDir, host) })
  if (!merge.changed) {
    env.out(`${host}: hooks already wired in ${path}`)
    return []
  }
  const backup = plannedBackup(path, env.now())
  const parts = [
    merge.added.length > 0 ? `add Kinfold hooks for ${merge.added.join(', ')}` : '',
    merge.replaced.length > 0 ? `replace Kinfold hooks for ${merge.replaced.join(', ')}` : '',
    'every other key and hook kept',
  ].filter((part) => part !== '')
  if (host === 'codex') env.out(CODEX_TRUST_NOTE)
  return [
    ...(existsSync(dir) ? [] : [{ kind: 'mkdir', path: dir, mode: DIR_MODE } as const]),
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: serializeJson(merge.settings, file.exists ? file.text : null), mode: file.exists ? file.mode : FILE_MODE, summary: parts.join('; ') },
  ]
}

export function hostHookUninstallActions(env: InstallEnv, host: CommandHookHost): Action[] {
  const { file: path } = hostFiles(env, host)
  const file = readJsonObject(path)
  if (!file.exists) return []
  const result = removeHostHooks(HOST_HOOK_SPECS[host], file.value)
  if (result.removed === 0) return []
  const backup = plannedBackup(path, env.now())
  return [
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: serializeJson(result.settings, file.text), mode: file.mode, summary: `remove ${result.removed} Kinfold hook entries; every other key and hook kept` },
  ]
}

/** Codex's entries under CODEX_HOME and, when that is elsewhere, under ~/.codex too. */
export function codexHookUninstallActions(env: InstallEnv): Action[] {
  const here = hostHookUninstallActions(env, 'codex')
  const fallback = { ...env, codexHomeEnv: undefined }
  if (installPaths(fallback).codexHooks === installPaths(env).codexHooks) return here
  return [...here, ...hostHookUninstallActions(fallback, 'codex')]
}

/** For status: yes/no/stale/partial with the file, read-only. */
export function hostWiringLine(env: InstallEnv, host: CommandHookHost): string {
  const { file: path } = hostFiles(env, host)
  const problem = host === 'codex' ? codexHomeProblem(env) : null
  if (problem !== null) return `unknown (${problem}) in ${path}`
  try {
    const file = readJsonObject(path)
    return `${file.exists ? inspectHostHooks(HOST_HOOK_SPECS[host], file.value, entryIdentity(env.mode, 'hook', env.dataDir, host)) : 'no (no hooks.json)'} in ${path}`
  } catch (error: unknown) {
    return `unknown (${errorMessage(error)}) in ${path}`
  }
}

function recordFor(detection: HostDetection, now: number): HostVersionRecord | null {
  if (!detection.selected || detection.version === null) return null
  const version = normalizeVersion(detection.version) ?? detection.version
  const stampPath = detection.stampPath ?? null
  const mtimeMs = stampPath === null ? null : statMtime(stampPath)
  return { version, recordedAt: now, binary: stampPath !== null && mtimeMs !== null ? { path: stampPath, mtimeMs } : null }
}

const sameRecord = (a: HostVersionRecord | undefined, b: HostVersionRecord): boolean =>
  a !== undefined && a.version === b.version && JSON.stringify(a.binary) === JSON.stringify(b.binary)

function currentRecords(path: string): HostVersionRecords {
  const text = readTextOrNull(path)
  if (text === null) return {}
  try {
    return parseHostVersions(JSON.parse(text))
  } catch {
    return {}
  }
}

/**
 * One write of <dataDir>/host-versions.json when a selected host's version or
 * binary stamp changed. Hosts not detected this run keep their old entry, and
 * recordedAt alone never causes a write, so a re-run is a no-op.
 */
export function hostVersionActions(env: InstallEnv, detections: readonly HostDetection[]): Action[] {
  const path = installPaths(env).hostVersionsFile
  const current = currentRecords(path)
  const now = env.now()
  const fresh = detections.flatMap((detection) => {
    const record = recordFor(detection, now)
    return record === null || sameRecord(current[detection.host], record) ? [] : [[detection.host, record] as const]
  })
  if (fresh.length === 0) return []
  const next: HostVersionRecords = { ...current, ...Object.fromEntries(fresh) }
  const summary = `record host_version for ${fresh.map(([host, record]) => `${host} ${record.version}`).join(', ')}`
  return [{ kind: 'write', path, content: serializeHostVersions(next), mode: DATA_FILE_MODE, summary }]
}
