// The real command runner and TTY prompts behind InstallEnv; only the CLI
// entry uses them. Children get a fixed small env (PATH, HOME), never the
// installer's own. The secret prompt switches the TTY to raw mode so nothing
// is echoed, and the typed value goes back to the caller only.

import { createInterface } from 'node:readline/promises'
import type { CommandRunner, PromptIO } from './env'

const NOT_FOUND_EXIT = 127
const DEFAULT_TIMEOUT_MS = 15_000

export function createCommandRunner(childEnv: Readonly<Record<string, string>>): CommandRunner {
  return async ({ argv, timeoutMs }) => {
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...childEnv } })
    } catch {
      return { exitCode: NOT_FOUND_EXIT, stdout: '' }
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const stdout = child.stdout instanceof ReadableStream ? await new Response(child.stdout).text() : ''
      const exitCode = await child.exited
      return timedOut ? { exitCode, stdout, timedOut } : { exitCode, stdout }
    } finally {
      clearTimeout(timer)
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
