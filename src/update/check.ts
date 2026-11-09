// The daily update check. It asks GitHub for the latest release and nothing
// else: one URL, one header, no body, no identifiers. The attempt time is
// recorded even when the request fails, so a broken network or a rate limit
// is retried in a day, not on every tick.

import { readEnv } from '../env-names'
import { readInstallRecord } from '../install/setup/record'
import { readUpdateState, writeUpdateState } from './state'
import { parseVersion } from './version-order'

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/yahyafakhroji/kinfold/releases/latest'
export const UPDATE_USER_AGENT = 'kinfold-update-check'
export const CHECK_INTERVAL_MS = 86_400_000
export const CHECK_TICK_MS = 3_600_000
export const CHECK_TIMEOUT_MS = 10_000
export const MAX_RELEASE_BYTES = 1_000_000
const DEV_VERSION = '0.0.0-dev'

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

/** The release's version, or null for a draft, a prerelease, or a tag that is not `v<semver>`. */
export function latestFromRelease(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const { tag_name: tag, draft, prerelease } = body as Record<string, unknown>
  if (draft === true || prerelease === true) return null
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null
  const version = tag.slice(1)
  return parseVersion(version) === null ? null : version
}

/** Reads the body up to the cap and stops there; a longer one is refused, not truncated. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RELEASE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new UpdateCheckError('response too large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** The one request, shared with `kinfold update`. Throws UpdateCheckError. */
export async function fetchLatestRelease(fetchFn: UpdateCheckDeps['fetch'], now: () => number): Promise<{ latestVersion: string; checkedAt: number }> {
  let response: Response
  try {
    response = await fetchFn(LATEST_RELEASE_URL, { headers: { 'user-agent': UPDATE_USER_AGENT }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new UpdateCheckError(error instanceof Error ? error.name : 'error')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new UpdateCheckError(String(response.status))
  }
  const text = await readCapped(response)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new UpdateCheckError('malformed response')
  }
  const latestVersion = latestFromRelease(body)
  if (latestVersion === null) throw new UpdateCheckError('no usable release')
  return { latestVersion, checkedAt: now() }
}

export function checkEnabled(deps: UpdateCheckDeps): boolean {
  if (deps.version === DEV_VERSION || parseVersion(deps.version) === null) return false
  if (readEnv(deps.envVars(), 'NO_UPDATE_CHECK') === '1') return false
  const record = readInstallRecord(deps.dataDir)
  return record === null || (record.updateCheck && record.channel !== 'checkout')
}

export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<'disabled' | 'not-due' | 'checked' | 'failed'> {
  try {
    if (!checkEnabled(deps)) return 'disabled'
    const state = readUpdateState(deps.dataDir)
    const startedAt = deps.now()
    if (state.lastAttemptAt !== null && startedAt - state.lastAttemptAt < CHECK_INTERVAL_MS) return 'not-due'
    try {
      const found = await fetchLatestRelease(deps.fetch, deps.now)
      writeUpdateState(deps.dataDir, { ...state, lastAttemptAt: startedAt, latestVersion: found.latestVersion, checkedAt: found.checkedAt })
      return 'checked'
    } catch (error: unknown) {
      writeUpdateState(deps.dataDir, { ...state, lastAttemptAt: startedAt })
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
