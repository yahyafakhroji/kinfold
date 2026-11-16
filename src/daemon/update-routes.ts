// What the dashboard asks of updates beyond the banner: the release on offer
// with its change lines, the updates settings, and the Install button. The
// button starts `kinfold update --staged <version>` detached, the same way the
// daemon starts an automatic update, because that update stops this daemon.
// It refuses while a backup, a restore or another update runs, and for any
// release that is not the staged one; the updater re-checks the program
// against SHA256SUMS before it installs it.

import { readInstallRecord, setUpdateSettings, updateLevel } from '../install/setup/record'
import type { OsName } from '../platform/platform'
import { detachPlan, spawnDetached } from '../update/detach'
import { autoUpdateSetting, updatesEnabled } from '../update/enabled'
import { type InstallRun, readInstallRun, writeInstallRun } from '../update/install-run'
import { updateLockHolder } from '../update/lock'
import { stagedProgram } from '../update/stage'
import { knownRelease, readUpdateState } from '../update/state'
import { compareVersions } from '../update/version-order'
import type { RouteAnswer } from './data-routes'
import type { UpdateHandlers, UpdateRelease, UpdateSettings } from './server'

type Env = Readonly<Record<string, string | undefined>>

/** A run that has said nothing for this long died with its updater: past the updater's own 15-minute install deadline, with room to spare. */
export const INSTALL_RUN_STALE_MS = 1_200_000

export interface UpdateRouteDeps {
  dataDir: string
  version: string
  platform: NodeJS.Platform
  envVars: () => Env
  now: () => number
  log: (line: string) => void
  /** Why the store is busy with a backup or a restore; null when it is not. */
  storeBusy: () => string | null
  /** The installed program this daemon runs and its OS; null where there is none (a checkout, a test without one). */
  program: { path: string; os: OsName } | null
  spawn?: (argv: string[], env: Env) => number
  exists?: (path: string) => boolean
}

const refuse = (error: string): RouteAnswer => ({ status: 409, body: { error } })

function releaseView(deps: UpdateRouteDeps): UpdateRelease | null {
  const record = readInstallRecord(deps.dataDir)
  const env = deps.envVars()
  if (!updatesEnabled(deps.version, record, env)) return null
  const release = knownRelease(readUpdateState(deps.dataDir), record?.beta === true)
  if (release === null || compareVersions(release.version, deps.version) <= 0) return null
  const staged = stagedProgram(deps.dataDir, deps.platform)?.version === release.version
  // The button belongs to the patch level, and needs a program here the updater can replace.
  const installable = staged && deps.program !== null && autoUpdateSetting(deps.version, record, env).on
  return { version: release.version, changes: release.changes, breaking: release.breaking, staged, installable }
}

function settings(dataDir: string): UpdateSettings {
  const record = readInstallRecord(dataDir)
  return { level: updateLevel(record), beta: record?.beta === true }
}

/** Whether a dashboard install of `version` is still under way: one press is enough. */
function stillRunning(run: InstallRun | null, now: number): boolean {
  return run !== null && run.state === 'running' && now - run.at < INSTALL_RUN_STALE_MS
}

function install(deps: UpdateRouteDeps, version: string): RouteAnswer {
  const busy = deps.storeBusy()
  if (busy !== null) return refuse(busy)
  const holder = updateLockHolder(deps.dataDir)
  if (holder !== null || stillRunning(readInstallRun(deps.dataDir), deps.now())) return refuse('another update is running; try again when it finishes')
  const offered = releaseView(deps)
  if (offered === null || offered.version !== version || !offered.staged) return refuse(`no checked download of ${version} is waiting; run kinfold update instead`)
  if (!offered.installable || deps.program === null) return refuse('installing from the dashboard needs updates set to patch and an installed program; run kinfold update instead')
  const env = deps.envVars()
  const plan = detachPlan({ os: deps.program.os, program: deps.program.path, args: ['--data-dir', deps.dataDir, 'update', '--staged', version], envVars: env, ...(deps.exists !== undefined ? { exists: deps.exists } : {}) })
  if (!plan.ok) return refuse(`${plan.reason}; run kinfold update instead`)
  const run: InstallRun = { version, previous: deps.version, state: 'running', message: null, at: deps.now() }
  // Written before the start, so a daemon the updater restarts still knows the page is waiting on it.
  writeInstallRun(deps.dataDir, run)
  try {
    const pid = (deps.spawn ?? spawnDetached)(plan.argv, env)
    deps.log(`dashboard install of ${version} started pid=${pid} via=${plan.via}`)
  } catch (error: unknown) {
    // The name only: a spawn error's message carries the path.
    const message = `could not start the updater (${error instanceof Error ? error.name : 'error'})`
    writeInstallRun(deps.dataDir, { ...run, state: 'failed', message })
    return { status: 500, body: { error: message } }
  }
  return { status: 202, body: { install: run } }
}

export function updateRouteHandlers(deps: UpdateRouteDeps): Pick<UpdateHandlers, 'view' | 'setSettings' | 'install' | 'installState'> {
  return {
    view: () => ({ release: releaseView(deps), settings: settings(deps.dataDir), install: readInstallRun(deps.dataDir) }),
    setSettings: (choice) => {
      const saved = setUpdateSettings(deps.dataDir, choice, deps.now())
      if (saved) deps.log(`updates set to ${choice.level}, beta ${choice.beta ? 'on' : 'off'}, from the dashboard`)
      return saved
    },
    install: (version) => install(deps, version),
    installState: () => ({ running: deps.version, install: readInstallRun(deps.dataDir) }),
  }
}
