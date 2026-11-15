// One run of install or uninstall: where its lines go. A plain run prints
// every line as it always did. A framed run (a terminal) shows lines while it
// asks its questions, and once the plan starts sends them to the install log
// only, behind the progress bar; a line the person must act on goes through
// `notice`, which prints above the bar. Either way every line reaches
// logs/install.log. The env handed out carries both sinks, so every module
// keeps calling env.out and never needs to know which kind of run it is in.

import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import type { InstallEnv } from '../env'
import { type InstallLog, createInstallLog, installLogPath } from '../install-log'
import type { PlanListener } from '../plan'
import type { Ui } from '../prompt/ui'
import { type FramedView, createFramedView } from './framed-view'

export interface SessionOptions {
  dryRun: boolean
  verbose: boolean
}

export interface Session {
  ui: Ui
  /** The caller's env with `out` and `notice` routed for this run. */
  env: InstallEnv
  /** The bar and the summary; null on a plain run. */
  view: FramedView | null
  /** Listeners every plan of this run takes: the view's, and one that writes the log as each step ends. */
  planListeners: readonly PlanListener[]
  /** The log listener alone, for a plan whose lines are shown as text and must not start the bar. */
  logListeners: readonly PlanListener[]
  /** Lines are shown while the questions are asked. */
  showLines(): void
  /** Lines go to the log only: the bar is about to draw, or a status line is not worth the screen. */
  hideLines(): void
  /** The folder whose logs/install.log this run writes; set once the wizard has settled it. */
  target(dataDir: string): void
  fail(line: string): void
  cancel(line: string): void
  /** Writes what the log has gathered. */
  flush(): void
  readonly dryRun: boolean
}

export function openSession(base: InstallEnv, ui: Ui, command: 'install' | 'uninstall', options: SessionOptions): Session {
  const log: InstallLog = createInstallLog(base.now, command, { dryRun: options.dryRun })
  let dataDir = base.dataDir
  let shown = true
  const flush = (): void => log.flush(dataDir)
  const logPath = (): string | null => {
    flush()
    const path = installLogPath(dataDir)
    if (!existsSync(path)) return null
    // As the person would type it: a long home path would wrap in the summary box.
    return base.homeDir !== '' && path.startsWith(`${base.homeDir}${sep}`) ? `~${path.slice(base.homeDir.length)}` : path
  }
  const view = ui.framed ? createFramedView(ui.output, { command, verbose: options.verbose, dryRun: options.dryRun, logPath }) : null

  const out = (line: string): void => {
    log.add(line)
    if (view === null) base.out(line)
    // A dry run changes nothing and has no log, so its lines always reach the screen.
    else if (shown || options.dryRun) ui.output.say(line)
  }
  const notice = (line: string): void => {
    log.add(line)
    if (view === null) base.out(line)
    else view.note(line)
  }

  // A killed run still leaves the steps that finished in the log.
  const logListener: PlanListener = (event) => void (event.type === 'end' && flush())

  return {
    ui,
    env: { ...base, out, notice },
    view,
    planListeners: [...(view?.planListeners ?? []), logListener],
    logListeners: [logListener],
    showLines: () => void (shown = true),
    hideLines: () => void (shown = false),
    target: (next) => void (dataDir = next),
    fail(line) {
      log.add(line)
      if (view === null) base.out(line)
      else view.fail(line)
    },
    cancel(line) {
      log.add(line)
      if (view === null) base.out(line)
      else view.cancel(line)
    },
    flush,
    dryRun: options.dryRun,
  }
}
