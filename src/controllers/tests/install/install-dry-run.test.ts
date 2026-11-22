// The whole macOS dry-run output of a first install and of a re-run, held
// byte for byte against a fixture: every later change to how install plans
// the LaunchAgent must leave this text alone. Machine-specific parts (the temp
// root, the port and pid the test daemon got) are replaced with placeholders.
// KINFOLD_CAPTURE_DRY_RUN=<path> writes the output there instead of comparing.
//
// The fixture is the text of main before the platform work, with one allowed
// difference: the first install records the key store as its third step
// ('record the key store (keychain) in .../key-store.json'), so the later steps
// are numbered one higher and the plan has 22 actions, not 21. The re-run is
// main's text verbatim.

import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { install } from './install'
import { type FakeWorld, YES, createWorld } from './test-support'
import { posixOnly } from '../../test/platform-guards'

const FIXTURE = join(import.meta.dir, 'install-dry-run.golden.txt')

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function normalize(w: FakeWorld, lines: readonly string[]): string[] {
  return lines.map((line) => line
    .replaceAll(w.root, '<root>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
    .replace(/\bport \d+/g, 'port <port>')
    .replace(/\bpid \d+/g, 'pid <pid>'))
}

posixOnly('POSIX paths')('the macOS dry run of a first install and of a re-run is unchanged', async () => {
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', keychainRefs: ['openrouter'] })
  world = w
  const sections: string[] = []
  const dryRun = async (title: string): Promise<void> => {
    w.out.length = 0
    expect(await install(w.env, { ...YES, dryRun: true })).toBe(0)
    sections.push(`== ${title}`, ...normalize(w, w.out))
  }
  await dryRun('first install, dry run')
  expect(await install(w.env, YES)).toBe(0)
  await dryRun('re-run, dry run')
  const text = `${sections.join('\n')}\n`
  const capture = process.env.KINFOLD_CAPTURE_DRY_RUN
  if (capture !== undefined && capture !== '') {
    writeFileSync(capture, text)
    return
  }
  expect(text).toBe(readFileSync(FIXTURE, 'utf8'))
})
