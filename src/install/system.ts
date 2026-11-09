// The real command runner and TTY prompts behind InstallEnv; only the CLI
// entry uses them. Children get a fixed small env (PATH, HOME), never the
// installer's own. The secret prompt switches the TTY to raw mode so nothing
// is echoed, and the typed value goes back to the caller only.

import { createInterface } from 'node:readline/promises'
import type { CommandRunner, PromptIO } from './env'

/** The shell's "command not found" exit: only a missing binary maps here. */
export const NOT_FOUND_EXIT = 127
/** The shell's "found but cannot run" exit: any other spawn error (a file without the exec bit, say). */
export const CANNOT_RUN_EXIT = 126
/** After SIGTERM, how long a timed-out child gets before SIGKILL. */
export const KILL_GRACE_MS = 2_000
const DEFAULT_TIMEOUT_MS = 15_000

function spawnErrorExit(error: unknown): number {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 'ENOENT' ? NOT_FOUND_EXIT : CANNOT_RUN_EXIT
}

/**
 * Stdout up to the deadline. A grandchild can keep the pipe open long after
 * the child is gone, so the read stops at the deadline with what it has.
 */
async function readUntil(stream: ReadableStream<Uint8Array>, deadline: Promise<void>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const stopped = deadline.then(() => null)
  let text = ''
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), stopped])
      if (chunk === null || chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // A read that fails ends the output; the exit code still says how the child ended.
  } finally {
    reader.cancel().catch(() => {})
  }
  return text + decoder.decode()
}

export function createCommandRunner(childEnv: Readonly<Record<string, string>>): CommandRunner {
  return async ({ argv, timeoutMs }) => {
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...childEnv } })
    } catch (error: unknown) {
      return { exitCode: spawnErrorExit(error), stdout: '' }
    }
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let reachDeadline = (): void => {}
    const deadline = new Promise<void>((resolve) => (reachDeadline = resolve))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // A child that ignores SIGTERM must not hold the installer forever.
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      reachDeadline()
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const stdout = child.stdout instanceof ReadableStream ? await readUntil(child.stdout, deadline) : ''
      const exitCode = await child.exited
      return timedOut ? { exitCode, stdout, timedOut } : { exitCode, stdout }
    } finally {
      clearTimeout(timer)
      clearTimeout(killTimer)
    }
  }
}

async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

const ENTER = new Set(['\r', '\n'])
const CTRL_C = '\u0003'
const BACKSPACE = new Set(['\u007f', '\b'])

/** Raw mode, no echo; Enter ends, Ctrl-C cancels, Backspace edits. */
function askSecretLine(question: string): Promise<string> {
  process.stderr.write(question)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
    }
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (ENTER.has(char)) return (finish(), resolve(value))
        if (char === CTRL_C) return (finish(), reject(new Error('cancelled at the key prompt')))
        value = BACKSPACE.has(char) ? value.slice(0, -1) : value + char
      }
    }
    stdin.on('data', onData)
  })
}

export function createPromptIO(): PromptIO {
  return {
    interactive: process.stdin.isTTY === true,
    ask: askLine,
    askSecret: askSecretLine,
    readStdin: () => Bun.stdin.text(),
    printsToTerminal: process.stdout.isTTY === true,
  }
}
