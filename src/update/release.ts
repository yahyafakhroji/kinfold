// A release as the update check keeps it: its version, whether it is a
// prerelease, and the change lines from its GitHub Release body, which the
// release workflow writes from that version's CHANGELOG.md section. Also the
// one rule for which release is offered to a running version. No file or
// installer imports: the hook path loads the notice text built from these.

import { isPatchUpdate, parseVersion } from './version-order'

export interface ReleaseInfo {
  version: string
  prerelease: boolean
  /** Breaking lines first, then the rest, each once. */
  changes: string[]
  /** The breaking lines alone: major entries, and entries that start with BREAKING:. */
  breaking: string[]
}

/** Enough lines for a banner; a longer changelog is cut, never refused. */
export const MAX_CHANGE_LINES = 40
export const MAX_CHANGE_CHARS = 300

/** A build from a checkout: never offered a release, never updated. */
export function isDevVersion(version: string): boolean {
  return parseVersion(version)?.pre === 'dev'
}

// A Release body is text from the network that ends up on a terminal line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const HASH_PREFIX = /^[0-9a-f]{7,40}: /
const BREAKING_PREFIX = /^BREAKING:/

function cleanLine(text: string): string {
  return text.replace(CONTROL, '').replace(HASH_PREFIX, '').trim().slice(0, MAX_CHANGE_CHARS)
}

/**
 * The change lines of a Release body: the top-level `- ` entries between
 * `## Changes` and the next `## ` heading. Nested bullets belong to their
 * entry and are not lines of their own. A body with no such section, or the
 * "No changelog" line, has none.
 */
export function changeLines(body: unknown): Pick<ReleaseInfo, 'changes' | 'breaking'> {
  if (typeof body !== 'string') return { changes: [], breaking: [] }
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '## Changes')
  if (start === -1) return { changes: [], breaking: [] }
  const breaking: string[] = []
  const rest: string[] = []
  let major = false
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (line.startsWith('### ')) {
      major = line.trim() === '### Major Changes'
      continue
    }
    if (!line.startsWith('- ')) continue
    const text = cleanLine(line.slice(2))
    if (text === '') continue
    ;(major || BREAKING_PREFIX.test(text) ? breaking : rest).push(text)
  }
  return { changes: [...breaking, ...rest].slice(0, MAX_CHANGE_LINES), breaking: breaking.slice(0, MAX_CHANGE_LINES) }
}

/**
 * One release from GitHub's answer, or null: a draft, a tag that is not
 * `v<semver>`, or a final version GitHub still marks as a prerelease, which
 * is what release.yml does until the smoke test passes.
 */
export function releaseFromGithub(value: unknown): ReleaseInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { tag_name: tag, draft, prerelease, body } = value as Record<string, unknown>
  if (draft === true || typeof tag !== 'string' || !tag.startsWith('v')) return null
  const version = tag.slice(1)
  const parsed = parseVersion(version)
  if (parsed === null || isDevVersion(version)) return null
  if (prerelease === true && parsed.pre === null) return null
  return { version, prerelease: parsed.pre !== null, ...changeLines(body) }
}

export type ReleaseKind = 'patch' | 'minor' | 'major' | 'prerelease'

/** How big a step `latest` is from `running`; only `patch` installs without a yes. Both must parse. */
export function releaseKind(running: string, latest: string): ReleaseKind {
  if (isPatchUpdate(running, latest)) return 'patch'
  const from = parseVersion(running)
  const to = parseVersion(latest)
  if (from === null || to === null) throw new Error('not a version')
  if (to.pre !== null) return 'prerelease'
  return to.major !== from.major ? 'major' : 'minor'
}
