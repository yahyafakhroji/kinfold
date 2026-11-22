import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askDaemon } from '../../context/daemon'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kinfold-ask-daemon-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const REQUEST = { channel: 'prompt', host: 'claude-code', hostSessionId: 's', cwd: '/repo', promptText: 'the prompt' } as unknown as Parameters<typeof askDaemon>[1]

test('a redirect from the port is not followed: the token and the prompt go nowhere else', async () => {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      paths.push(path)
      return path === '/context' ? new Response(null, { status: 307, headers: { location: '/elsewhere' } }) : Response.json({})
    },
  })
  try {
    writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: server.port }))
    writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
    const answer = await askDaemon(dataDir, REQUEST, 5_000, (url, init) => fetch(url, init))
    expect(paths).toEqual(['/context'])
    expect(answer).toMatchObject({ answered: false })
  } finally {
    await server.stop(true)
  }
})

test('the files of a daemon that is gone are not an address to send anything to', async () => {
  const dead = Bun.spawnSync([process.execPath, '--version']).pid
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: dead, port: 9 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  let asked = 0
  const answer = await askDaemon(dataDir, REQUEST, 5_000, async () => ((asked += 1), Response.json({})))
  expect(asked).toBe(0)
  expect(answer).toEqual({ reason: 'daemon not running', answered: false, down: true })
})
