// One command's run on the output layer. Every command but install and
// uninstall (which keep a session of their own) goes through runFramed. On a
// plain run the command gets its env untouched and prints what it always
// printed. On a terminal it gets an env that draws: `out` puts a line on the
// rail, `io.ask` and `io.askSecret` are the layer's text and masked input, and
// `ui` carries what plain text has no word for: a section of marked rows, a
// spinner for a wait, an error, and the command to run next.

import { VERSION } from '../../../system/version'
import type { InstallEnv } from '../../../resources/install-plan/env'
import { type Busy, PromptCancelled, type Row } from './prompts'
import { uiFor } from './ui'

/** 128 + SIGINT, as a shell reports a Ctrl-C. */
export const EXIT_CANCELLED = 130

export interface CommandBusy {
  /** What the spinner says while the wait goes on. */
  label(text: string): void
  /** Ends the wait; the last line the command printed becomes the result line. */
  done(): void
  fail(): void
}

/** What a command can draw beyond lines. Present only on a terminal run, so `env.ui === undefined` is the plain path. */
export interface CommandUi {
  section(title: string, rows: readonly Row[]): void
  busy(label: string): CommandBusy
  error(line: string): void
  /** A yes or no, with the answer Enter gives. */
  confirm(question: string, initial: boolean): Promise<boolean>
  /** The run's last line: the command to run next. */
  next(line: string): void
}

/** A question as a prompt shows it: the layer draws its own cue, so the trailing "> " or space goes. */
const questionOf = (text: string): string => text.replace(/[\s>]+$/, '')

export async function runFramed(env: InstallEnv, title: string, run: (env: InstallEnv) => Promise<number>): Promise<number> {
  const ui = await uiFor(env, { yes: false })
  const prompts = ui.prompts
  if (prompts === null) return run(env)

  let spinner: Busy | null = null
  // The newest line under a spinner waits here: it is the result line if the wait ends next.
  let pending: string | null = null
  let next: string | null = null

  // A message of several lines is several lines here too: the layer draws one line per call.
  const out = (text: string): void => {
    for (const line of text.split('\n')) {
      if (spinner === null) prompts.say(line)
      else {
        if (pending !== null) spinner.note(pending)
        pending = line
      }
    }
  }
  /** A signal handler that exits mid-wait must not leave the shell's prompt on the spinner's line. */
  const onExit = (): void => {
    pending = null
    spinner?.fail(`${title} interrupted`)
    spinner = null
  }
  const end = (ok: boolean): void => {
    process.off('exit', onExit)
    if (spinner === null) return
    const line = pending ?? ''
    if (ok) spinner.done(line)
    else spinner.fail(line)
    spinner = null
    pending = null
  }

  const framed: InstallEnv = {
    ...env,
    out,
    notice: out,
    io: {
      ...env.io,
      interactive: true,
      ask: (question) => prompts.text(questionOf(question), ''),
      askSecret: (question) => prompts.password(questionOf(question)),
    },
    ui: {
      section: (heading, rows) => prompts.section(heading, rows),
      busy(label) {
        end(true)
        spinner = prompts.busy(label)
        process.once('exit', onExit)
        return { label: (text) => spinner?.label(text), done: () => end(true), fail: () => end(false) }
      },
      error: (text) => {
        for (const line of text.split('\n')) prompts.error(line)
      },
      confirm: (question, initial) => prompts.confirm(question, initial),
      next: (line) => void (next = line),
    },
  }

  prompts.intro(`Kinfold ${VERSION} ${title}`)
  let code: number | null = null
  try {
    code = await run(framed)
    return code
  } catch (error: unknown) {
    if (!(error instanceof PromptCancelled)) throw error
    end(false)
    prompts.cancelled(`${title} cancelled; nothing was changed`)
    code = EXIT_CANCELLED
    return code
  } finally {
    if (code !== EXIT_CANCELLED) {
      end(code === 0)
      prompts.outro(code === 0 ? (next ?? 'Done.') : `kinfold ${title} did not finish.`)
    }
  }
}
