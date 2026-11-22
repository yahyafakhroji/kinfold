// The daily update check. It asks GitHub for the latest release and nothing
// else: one URL, one header, no body, no identifiers. The attempt time is
// recorded even when the request fails, so a broken network or a rate limit
// is retried in a day, not on every tick.

import { readInstallRecord } from '../../resources/install-plan/setup/record'
import { betaChannelOn, updatesEnabled } from './enabled'
import { type ReleaseInfo, releaseFromGithub } from './release'
import { mergeUpdateState, readUpdateState } from './state'
import { compareVersions, isPatchUpdate } from './version-order'
import { readCappedText } from '../../system/http/capped'

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/yahyafakhroji/kinfold/releases/latest'
/** The beta channel's one URL: /releases/latest never names a prerelease. */
export const RELEASES_URL = 'https://api.github.com/repos/yahyafakhroji/kinfold/releases?per_page=10'
export const UPDATE_USER_AGENT = 'kinfold-update-check'
export const CHECK_INTERVAL_MS = 86_400_000
export const CHECK_TICK_MS = 3_600_000
export const CHECK_TIMEOUT_MS = 10_000
export const MAX_RELEASE_BYTES = 1_000_000

export interface UpdateCheckDeps {
  dataDir: string
  version: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  now: () => number
  envVars: () => Readonly<Record<string, string | undefined>>
  log: (line: string) => void
}

/** A failed request, named by its status or error name only: a message can quote the response. */
export class UpdateCheckError extends Error {
  readonly label: string
  constructor(label: string) {
    super(`update check failed (${label})`)
    this.name = 'UpdateCheckError'
    this.label = label
  }
}

/** The newest of `releases` the channel takes: finals, and prereleases with beta on. */
function newest(releases: readonly ReleaseInfo[], beta: boolean): ReleaseInfo | null {
  let best: ReleaseInfo | null = null
  for (const release of releases) {
    if (release.prerelease && !beta) continue
    if (best === null || compareVersions(release.version, best.version) > 0) best = release
  }
  return best
}

/** The newest final release that is a patch of `running`, so a newer beta on offer never holds it back. */
function newestPatch(releases: readonly ReleaseInfo[], running: string | null): string | null {
  if (running === null) return null
  const patches = releases.filter((release) => isPatchUpdate(running, release.version))
  return newest(patches, false)?.version ?? null
}

export interface NewestRelease {
  /** The release on offer: the channel's newest. */
  release: ReleaseInfo
  /** The newest patch of the running version in the same answer, or null. */
  patch: string | null
  checkedAt: number
}

/**
 * The one request, shared with `kinfold update`: the latest release, or with
 * the beta channel the newest of the last few. Throws UpdateCheckError.
 */
export async function fetchNewestRelease(fetchFn: UpdateCheckDeps['fetch'], now: () => number, beta: boolean = false, running: string | null = null): Promise<NewestRelease> {
  const body = await fetchJson(fetchFn, beta ? RELEASES_URL : LATEST_RELEASE_URL)
  const releases = (Array.isArray(body) ? body : [body]).map(releaseFromGithub).filter((release): release is ReleaseInfo => release !== null)
  const release = newest(releases, beta)
  if (release === null) throw new UpdateCheckError('no usable release')
  return { release, patch: newestPatch(releases, running), checkedAt: now() }
}

async function fetchJson(fetchFn: UpdateCheckDeps['fetch'], url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetchFn(url, { headers: { 'user-agent': UPDATE_USER_AGENT }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new UpdateCheckError(error instanceof Error ? error.name : 'error')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new UpdateCheckError(String(response.status))
  }
  // A longer body is refused, not truncated.
  const text = await readCappedText(response, MAX_RELEASE_BYTES)
  if (text === null) throw new UpdateCheckError('response too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new UpdateCheckError('malformed response')
  }
}

export function checkEnabled(deps: UpdateCheckDeps): boolean {
  return updatesEnabled(deps.version, readInstallRecord(deps.dataDir), deps.envVars())
}

const betaOn = (deps: UpdateCheckDeps): boolean => betaChannelOn(readInstallRecord(deps.dataDir), deps.version)

export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<'disabled' | 'not-due' | 'checked' | 'failed'> {
  try {
    if (!checkEnabled(deps)) return 'disabled'
    const state = readUpdateState(deps.dataDir)
    const startedAt = deps.now()
    const beta = betaOn(deps)
    // A check made for the other channel answers a different question, so it is due now.
    const sameChannel = (state.beta ?? false) === beta
    if (sameChannel && state.lastAttemptAt !== null && startedAt - state.lastAttemptAt < CHECK_INTERVAL_MS) return 'not-due'
    try {
      const found = await fetchNewestRelease(deps.fetch, deps.now, beta, deps.version)
      mergeUpdateState(deps.dataDir, { lastAttemptAt: startedAt, latestVersion: found.release.version, checkedAt: found.checkedAt, beta, release: found.release, patchVersion: found.patch })
      return 'checked'
    } catch (error: unknown) {
      mergeUpdateState(deps.dataDir, { lastAttemptAt: startedAt, beta })
      deps.log(`update check failed (${error instanceof UpdateCheckError ? error.label : error instanceof Error ? error.name : 'error'})`)
      return 'failed'
    }
  } catch (error: unknown) {
    deps.log(`update check failed (${error instanceof Error ? error.name : 'error'})`)
    return 'failed'
  }
}

/** The first run goes on the next tick of the event loop, so the daemon is already answering. */
export function startUpdateChecks(deps: UpdateCheckDeps): { stop(): void } {
  let running = false
  const run = (): void => {
    if (running) return
    running = true
    void runUpdateCheck(deps).finally(() => {
      running = false
    })
  }
  const first = setTimeout(run, 0)
  const tick = setInterval(run, CHECK_TICK_MS)
  return {
    stop(): void {
      clearTimeout(first)
      clearInterval(tick)
    },
  }
}
