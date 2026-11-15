// `kinfold install` can set the two display switches: --show-recall or
// --no-show-recall, and --holdout or --no-holdout. A run that names neither
// leaves both as they are.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { USAGE, displayChangeOf, parseArgs } from './args'
import { putDisplaySettings } from './daemon-client'
import { displayActions } from './install'
import { describeAction } from './plan'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const parsed = (...flags: string[]) => {
  const result = parseArgs(['install', ...flags])
  if (!result.ok) throw new Error(result.error)
  return result.value
}

test('the four flags name a change, and no flag names none', () => {
  expect(displayChangeOf(parsed())).toEqual({})
  expect(displayChangeOf(parsed('--holdout'))).toEqual({ holdout: true })
  expect(displayChangeOf(parsed('--no-holdout'))).toEqual({ holdout: false })
  expect(displayChangeOf(parsed('--no-show-recall'))).toEqual({ showRecall: false })
  expect(displayChangeOf(parsed('--show-recall', '--holdout'))).toEqual({ showRecall: true, holdout: true })
})

test('a flag and its opposite together are refused, and the flags are install-only', () => {
  expect(parseArgs(['install', '--holdout', '--no-holdout'])).toEqual({ ok: false, error: '--holdout and --no-holdout cannot be given together' })
  expect(parseArgs(['install', '--show-recall', '--no-show-recall'])).toEqual({ ok: false, error: '--show-recall and --no-show-recall cannot be given together' })
  expect(parseArgs(['uninstall', '--holdout']).ok).toBe(false)
  expect(USAGE).toContain('--show-recall|--no-show-recall')
  expect(USAGE).toContain('--holdout|--no-holdout')
})

test('a change becomes one plan action after the daemon is up; no change, or no daemon to send it to, plans none', () => {
  world = createWorld({})
  expect(displayActions(world.env, {}, false)).toEqual([])
  expect(displayActions(world.env, { holdout: true }, false)).toEqual([{ kind: 'display-put', change: { holdout: true } }])
  expect(describeAction({ kind: 'display-put', change: { holdout: true, showRecall: false } })).toBe('PUT /data/display showRecall=false holdout=true')
  expect(displayActions(world.env, { holdout: true }, true)).toEqual([])
  expect(world.out.at(-1)).toBe('recall line and impact test: not sent, since no daemon is running; run kinfold install again once it runs')
})

test('the action sends the change to the daemon with the token and reports a refusal by status', async () => {
  world = createWorld({})
  // A daemon endpoint on disk; the fetch below answers for it.
  mkdirSync(world.dataDir, { recursive: true })
  writeFileSync(join(world.dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 4 }))
  writeFileSync(join(world.dataDir, 'daemon.token'), 'a'.repeat(64))
  const seen: { url: string; method: string | undefined; body: unknown; auth: string | null }[] = []
  let status = 200
  world.env.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') })
    return new Response(JSON.stringify(status === 200 ? { showRecall: true, holdout: true } : { error: 'body must be booleans' }), { status })
  }
  await putDisplaySettings(world.env, { holdout: true })
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ method: 'PUT', body: { holdout: true } })
  expect(seen[0]!.url.endsWith('/data/display')).toBe(true)
  expect(seen[0]!.auth?.startsWith('Bearer ')).toBe(true)
  status = 400
  await expect(putDisplaySettings(world.env, { holdout: true })).rejects.toThrow('PUT /data/display answered 400: body must be booleans')
})
