// Project keys in central memory. A git remote names the same project on
// every device, so it is shared. A repo root or a plain path is a folder on
// one device: two devices' ~/scratch are different projects, so those keys
// carry the device id. The device resolves the key (it runs git in its own
// folder; the hub never does), and the hub accepts only a shared remote key
// or a key scoped to the sending device.

import type { ProjectKey, ProjectKeyKind } from '../../resources/store/project-key'

const MAX_KEY_CHARS = 4_200
const MAX_NAME_CHARS = 256
const CONTROL = /[\u0000-\u001f\u007f]/
/**
 * host/owner/repo, as remoteSlug writes it: a host (an SSH alias may hold any
 * character but a colon or slash; an IPv6 host comes bracketed), then at least
 * two path segments. No colon outside brackets, so it can never pass for a
 * device-scoped key.
 */
const REMOTE_KEY = /^(?:[^\s/:\[\]]+|\[[0-9a-f:.]+\])(?:\/[^/]+){2,}$/
const KINDS: readonly ProjectKeyKind[] = ['git-remote', 'git-root', 'path']
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

const scopePrefix = (deviceId: string): string => `${deviceId}:`

export function centralProjectKey(project: ProjectKey, deviceId: string): ProjectKey {
  if (project.kind === 'git-remote' || project.key.startsWith(scopePrefix(deviceId))) return project
  return { ...project, key: `${scopePrefix(deviceId)}${project.key}` }
}

/** The project as the hub will store it, or null when this device may not write under it. */
export function parseDeviceProject(value: unknown, deviceId: string): ProjectKey | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { key, kind, displayName } = value as Record<string, unknown>
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_CHARS || CONTROL.test(key)) return null
  if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > MAX_NAME_CHARS || CONTROL.test(displayName)) return null
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null
  const scoped = kind === 'git-remote' ? REMOTE_KEY.test(key) : key.startsWith(scopePrefix(deviceId)) && key.length > scopePrefix(deviceId).length
  if (!scoped) return null
  // The first commit lets the hub merge one repo's keys (store/project-merge.ts); a malformed one is dropped, never the event.
  const { rootCommit } = value as Record<string, unknown>
  const root = typeof rootCommit === 'string' && COMMIT.test(rootCommit) ? { rootCommit } : {}
  return { key, kind: kind as ProjectKeyKind, displayName, ...root }
}
