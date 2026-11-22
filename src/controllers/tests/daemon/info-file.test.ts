// The last step of a daemon stop: daemon.json is removed only when it still
// names this process, and a file that cannot be read never fails the stop.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeOwnInfoFile } from '../../daemon/daemon'

let dir: string
let path: string
let logs: string[]
const log = (line: string): void => void logs.push(line)
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-info-file-'))
  path = join(dir, 'daemon.json')
  logs = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('this daemon\'s own file is removed, another daemon\'s is kept, and a missing one is nothing to do', () => {
  removeOwnInfoFile(path, log, 4242)
  writeFileSync(path, JSON.stringify({ pid: 4242, port: 1 }))
  removeOwnInfoFile(path, log, 4242)
  expect(existsSync(path)).toBe(false)
  writeFileSync(path, JSON.stringify({ pid: 7, port: 1 }))
  removeOwnInfoFile(path, log, 4242)
  expect(existsSync(path)).toBe(true)
  expect(logs).toEqual([])
})

test('a file cut short or not JSON is left alone and logged by error class, and the stop does not throw', () => {
  for (const text of ['{"pid": 42', '', 'null', '[4242]']) {
    writeFileSync(path, text)
    expect(() => removeOwnInfoFile(path, log, 4242)).not.toThrow()
    expect(existsSync(path)).toBe(true)
  }
  // The two that are not JSON at all; null and an array parse and simply name no pid.
  expect(logs).toEqual(['daemon.json left in place: SyntaxError', 'daemon.json left in place: SyntaxError'])
})
