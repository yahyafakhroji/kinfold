import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nudgeDaemon } from './record'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kinfold-record-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, '--version'])
  expect(child.exitCode).toBe(0)
  return child.pid
}

function listener(status: number): { port: number; asked: string[]; stop: () => Promise<void> } {
  const asked: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request) => {
      asked.push(`${request.headers.get('authorization')} ${new URL(request.url).pathname}`)
      return status === 307 ? new Response(null, { status, headers: { location: '/elsewhere' } }) : new Response(null, { status })
    },
  })
  return { port: server.port as number, asked, stop: () => server.stop(true) }
}

function leave(pid: number, port: number): void {
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid, port }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
}

test('the nudge reaches a live daemon with its token', async () => {
  const daemon = listener(202)
  try {
    leave(process.pid, daemon.port)
    expect(await nudgeDaemon(dataDir)).toEqual({ ok: true })
    expect(daemon.asked).toEqual([`Bearer ${'a'.repeat(64)} /spool/nudge`])
  } finally {
    await daemon.stop()
  }
})

test('files a crashed daemon left behind send the token to nobody, whatever now holds the port', async () => {
  const squatter = listener(202)
  try {
    leave(deadPid(), squatter.port)
    expect(await nudgeDaemon(dataDir)).toEqual({ ok: false, reason: 'daemon not running (no daemon.json or token)' })
    expect(squatter.asked).toEqual([])
  } finally {
    await squatter.stop()
  }
})

test('the nudge follows no redirect', async () => {
  const daemon = listener(307)
  try {
    leave(process.pid, daemon.port)
    expect((await nudgeDaemon(dataDir)).ok).toBe(false)
    expect(daemon.asked).toEqual([`Bearer ${'a'.repeat(64)} /spool/nudge`])
  } finally {
    await daemon.stop()
  }
})
