// Which hosts live on this machine; each agent's profile says how it is found
// (src/agents/install-profiles.ts). Claude Code counts when `claude --version`
// answers or ~/.claude exists. OpenCode counts only when `opencode --version`
// reports 2.x or later (the plugin targets the V2 plugin contract), so a
// 1.x OpenCode is refused with a reason while the others still install.
// Codex counts when `codex --version` answers or Codex.app is installed;
// Cursor when `cursor-agent --version` or `cursor --version` answers or
// Cursor.app is installed. A ~/.codex or ~/.cursor directory alone does not
// count: other tools write there, so a leftover config is no sign of the host.
// `--hosts` replaces detection, but never admits a 1.x OpenCode.
// Each detection also names the file that pins its version (the resolved
// binary or the app's Info.plist), so host-versions.ts can tell an upgrade.

import { INSTALL_PROFILES } from '../agents/install-profiles'
import type { AgentId, AgentProfile } from '../agents/profile'
import { KNOWN_HOSTS } from '../contract/event'
import { type HostDetection, detectFromSpec } from './detectors'
import type { InstallEnv } from './env'

export {
  VERSION_TIMEOUT_MS,
  applicationsDirs,
  detectClaudeCode,
  detectFromSpec,
  detectOpenCode,
  findApp,
  parseOpenCodeVersion,
  resolveBinary,
  versionOf,
} from './detectors'
export type { HostDetection, Semver, VersionAnswer } from './detectors'

export const INSTALL_HOSTS = KNOWN_HOSTS
export type InstallHost = AgentId

/** `override` is the --hosts list; null means detect. Order is INSTALL_HOSTS. */
/** `profiles` is the install-profile table; tests pass one with an agent the real table does not have yet. */
export async function detectHosts(env: InstallEnv, override: readonly InstallHost[] | null, profiles: Readonly<Record<AgentId, AgentProfile>> = INSTALL_PROFILES): Promise<HostDetection[]> {
  const excluded = (host: InstallHost): HostDetection => ({ host, selected: false, version: null, note: 'left out by --hosts', leftOut: true })
  const forced = override !== null
  const detections: HostDetection[] = []
  for (const host of INSTALL_HOSTS) {
    const profile = profiles[host]
    if (override !== null && !override.includes(host)) {
      detections.push(excluded(host))
      continue
    }
    const { detection } = profile
    detections.push(typeof detection === 'function' ? await detection(env, forced) : await detectFromSpec(env, host, detection, forced))
  }
  return detections
}

export function selectedHosts(detections: readonly HostDetection[]): InstallHost[] {
  return detections.filter((detection) => detection.selected).map((detection) => detection.host)
}
