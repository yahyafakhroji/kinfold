// The real terminal behind the prompts: raw stdin as a stream of keys, stdout
// for output. nodeTerminal() is null unless both ends are a TTY, so a pipe or
// a CI run never reaches a prompt (and never prints a secret).

import { type Key, decodeKeys } from './keys'

export interface TerminalIO {
  keys(): AsyncIterable<Key>
  write(text: string): void
  setRaw(on: boolean): void
}

export function nodeTerminal(): TerminalIO | null {
  const stdin = process.stdin
  if (!stdin.isTTY || !process.stdout.isTTY) return null
  // Keys that arrived in one chunk but were not read yet stay queued for the next prompt.
  const queue: Key[] = []
  let ended = false
  let wake: (() => void) | null = null
  let attached = false
  const notify = (): void => {
    const waiting = wake
    wake = null
    waiting?.()
  }
  const onData = (chunk: Buffer | string): void => {
    queue.push(...decodeKeys(chunk.toString()))
    notify()
  }
  const onEnd = (): void => {
    ended = true
    notify()
  }
  const attach = (): void => {
    if (attached) return
    attached = true
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.on('close', onEnd)
    stdin.resume()
  }
  const detach = (): void => {
    if (!attached) return
    attached = false
    stdin.off('data', onData)
    stdin.off('end', onEnd)
    stdin.off('close', onEnd)
    stdin.pause()
  }
  const restore = (): void => {
    try {
      stdin.setRawMode(false)
      process.stdout.write('\u001b[?25h')
    } catch {
      // The terminal is already gone; nothing is left to restore.
    }
  }
  process.once('exit', restore)
  return {
    async *keys() {
      attach()
      try {
        for (;;) {
          const next = queue.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          if (ended) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
        detach()
      }
    },
    write: (text) => void process.stdout.write(text),
    setRaw: (on) => void stdin.setRawMode(on),
  }
}
