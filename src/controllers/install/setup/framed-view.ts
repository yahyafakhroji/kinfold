// What a terminal run of install or uninstall shows while it works: one
// progress bar across the plan and the stages after it, lines that need the
// person's attention above the bar, then either a summary with the next
// command or the step that failed, its reason and where the full log is. The
// plan tells it what happens through plan events; it never runs anything.

import type { PlanListener } from '../../../resources/install-plan/plan'
import type { Output, Progress, Row } from '../prompt/prompts'

export interface FramedViewOptions {
  /** The word in "stopped" and "did not finish" lines. */
  command: 'install' | 'uninstall'
  /** Show each numbered line above the bar as its step ends. */
  verbose: boolean
  /** A dry run lists its plan as text and draws no bar. */
  dryRun: boolean
  /** Where the full log is, or null while nothing has been written to it. */
  logPath: () => string | null
}

export interface FramedView {
  /** Listeners for the plan run: the bar, and the verbose lines. */
  readonly planListeners: readonly PlanListener[]
  /** Steps the bar counts beyond the plan's own: a conversion that runs after it. */
  extraStages(count: number): void
  /** One more step on the same bar, outside the plan. */
  stage(label: string): void
  /** A line the person has to see: above the bar while it runs, a warning otherwise. */
  note(line: string): void
  fail(message: string): void
  cancel(message: string): void
  finish(title: string, rows: readonly Row[], next: string): void
  /** True once the frame has been ended; every later call is ignored. */
  readonly closed: boolean
}

export function createFramedView(output: Output, options: FramedViewOptions): FramedView {
  let progress: Progress | null = null
  let extra = 0
  let total = 0
  let closed = false
  let failed: { index: number; label: string; line: string } | null = null
  let current = ''

  const bar = (): Progress => (progress ??= output.progress(total + extra))

  const onPlan: PlanListener = (event) => {
    if (options.dryRun) return
    if (event.type === 'begin') {
      total = event.total
      return
    }
    if (event.type === 'start') {
      current = event.label
      bar().step(event.label)
      return
    }
    if (options.verbose) {
      bar().note(`${event.line}  [${event.outcome}]`)
      if (event.kept !== undefined) bar().note(`     ${event.kept}`)
    }
    if (event.outcome === 'failed') failed = { index: event.index, label: current, line: event.line.trim() }
  }

  return {
    planListeners: [onPlan],
    extraStages(count) {
      extra = count
    },
    stage(label) {
      if (!closed && !options.dryRun) bar().step(label)
    },
    note(line) {
      if (closed) return
      if (progress !== null) progress.note(line, 'warn')
      else output.warn(line)
    },
    fail(message) {
      if (closed) return
      closed = true
      progress?.fail(failed === null ? `${options.command} stopped` : `stopped at step ${failed.index + 1} of ${total}: ${failed.label}`)
      if (failed !== null) output.error(failed.line)
      output.error(message)
      const log = options.logPath()
      output.outro(log === null ? 'Nothing was changed.' : `The full log is in ${log}`)
    },
    cancel(message) {
      if (closed) return
      closed = true
      progress?.fail(`${options.command} cancelled`)
      output.cancelled(message)
    },
    finish(title, rows, next) {
      if (closed) return
      closed = true
      progress?.done(`${total + extra} steps done`)
      const log = options.logPath()
      if (rows.length > 0) output.section(title, [...rows, ...(log === null ? [] : [{ mark: 'none' as const, text: `Full log: ${log}` }])])
      output.outro(next)
    },
    get closed() {
      return closed
    },
  }
}
