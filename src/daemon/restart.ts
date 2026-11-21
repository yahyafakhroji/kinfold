// Closing the store, running a step with it closed (a restore, a switch
// back), and opening it again. While the store is closed `down` is true, so
// store routes answer 503 and the auto-updater sees the user at work. It goes
// back to false once a new core has the store open, whatever the step did.
// Two failures are fatal instead, so the service starts a fresh daemon rather
// than leave `down` stuck: a store that will not reopen, and a stop that
// rejected. A half-stopped core may still hold the store and run its timers,
// and a second core beside it would drain the same spool twice.

export interface RestartableCore {
  stop(): Promise<void>
}

export interface RestarterDeps<C extends RestartableCore> {
  current: () => C
  /** Opens the store and builds a core on it; throws when the store will not open. */
  start: () => C
  /** Makes `core` the one the routes use. */
  adopt: (core: C) => void
  onFatal: (reason: string) => void
}

export interface Restarter {
  restart(between: () => Promise<void>): Promise<void>
  /** True from the moment a restart starts closing the store until a new core has it open. */
  down(): boolean
  /** The restart in flight, if any, so a stop can let it finish. */
  inFlight(): Promise<void> | null
}

export function createRestarter<C extends RestartableCore>(deps: RestarterDeps<C>): Restarter {
  let down = false
  let restarting: Promise<void> | null = null

  /** Set by a fatal failure: the process is on its way out, and nothing more may stop, step or open a core. */
  let fatal = false
  const failFatal = (reason: string): void => {
    fatal = true
    deps.onFatal(reason)
  }

  const restartNow = async (between: () => Promise<void>): Promise<void> => {
    // A restart that waited behind a fatal one: the old core may still hold the store.
    if (fatal) throw new Error('the daemon is stopping after a failed restart')
    down = true
    let failure: unknown = null
    try {
      await deps.current().stop()
    } catch (error: unknown) {
      // The store may still be open under the old core: neither the step nor a new core may run.
      failFatal(`the store could not be closed for the restore (${error instanceof Error ? error.name : 'error'})`)
      throw error
    }
    try {
      await between()
    } catch (error: unknown) {
      failure = error
    }
    try {
      deps.adopt(deps.start())
      down = false
    } catch (error: unknown) {
      failFatal(`memory.db could not be opened again (${error instanceof Error ? error.name : 'error'})`)
      throw failure ?? error
    }
    if (failure !== null) throw failure
  }

  return {
    restart(between) {
      // One at a time: two restarts at once each stopped the same core and each opened one, and the one not adopted kept its writer and timers.
      // The first still closes the store before this returns; one behind another waits for it, whether it succeeded or not.
      const before = restarting
      const run = (before === null ? restartNow(between) : before.catch(() => {}).then(() => restartNow(between))).finally(() => {
        if (restarting === run) restarting = null
      })
      restarting = run
      return run
    },
    down: () => down,
    inFlight: () => restarting,
  }
}
