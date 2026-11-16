// The release block under the update banner: the change lines, breaking
// first, and the Install button, which waits through the daemon's restart.
// Against the fake DOM, with the requests, the health probe and the clock
// injected.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

interface Release { version: string; changes: string[]; breaking: string[]; staged: boolean; installable: boolean }
interface Health { version: string; pid: number }
interface Deps {
  send(method: string, path: string, body?: unknown): Promise<unknown>
  health(): Promise<Health | null>
  installState(): Promise<{ version: string; state: string; message: string | null } | null>
  reload(): void
  sleep(ms: number): Promise<void>
}
interface InstallModule {
  releaseBlock(release: Release, deps: Deps, lastRun?: { version: string; state: string; message: string | null } | null): FakeElement
}

let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const load = async (): Promise<InstallModule> => (await import(join(PUBLIC_DIR, 'update-install.js'))) as InstallModule
const text = (element: FakeElement): string => textNodes(element).map((node) => node.textContent).join(' ')
const button = (block: FakeElement): FakeElement | undefined => elements(block).find((element) => element.tagName === 'BUTTON')
const fire = (element: FakeElement, type: string): void => {
  for (const listener of element.listeners.get(type) ?? []) listener({ preventDefault: () => {} })
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const RELEASE: Release = { version: '0.6.0', changes: ['BREAKING: Moved the data folder.', 'A new page.'], breaking: ['BREAKING: Moved the data folder.'], staged: true, installable: true }

function rig(healths: (Health | null)[], answer: () => Promise<unknown> = async () => ({ install: { state: 'running' } }), runs: ({ version: string; state: string; message: string | null } | null)[] = [null]) {
  const sent: { method: string; path: string; body: unknown }[] = []
  let reloaded = 0
  const deps: Deps = {
    send: (method, path, body) => (sent.push({ method, path, body }), answer()),
    health: async () => (healths.length > 1 ? healths.shift()! : healths[0] ?? null),
    installState: async () => (runs.length > 1 ? runs.shift()! : runs[0] ?? null),
    reload: () => {
      reloaded += 1
    },
    sleep: async () => {},
  }
  return { deps, sent, reloaded: () => reloaded }
}

test('the block lists the changes with the breaking ones first and marked, and an Install button', async () => {
  const block = (await load()).releaseBlock(RELEASE, rig([]).deps)
  const shown = text(block)
  expect(shown.indexOf('Moved the data folder.')).toBeLessThan(shown.indexOf('A new page.'))
  expect(shown).toContain('Breaking')
  expect(text(button(block)!)).toBe('Install Kinfold 0.6.0')
})

test('a release with no changelog says so, and one that cannot be installed here has no button', async () => {
  const block = (await load()).releaseBlock({ ...RELEASE, changes: [], breaking: [], installable: false }, rig([]).deps)
  expect(text(block)).toContain('No changelog for this release.')
  expect(button(block)).toBeUndefined()
})

test('Install starts the update, waits through the restart and reloads once the new version answers', async () => {
  const { deps, sent, reloaded } = rig([{ version: '0.5.0', pid: 1 }, { version: '0.5.0', pid: 1 }, null, { version: '0.6.0', pid: 2 }])
  const block = (await load()).releaseBlock(RELEASE, deps)
  fire(button(block)!, 'click')
  await settle()
  expect(sent).toEqual([{ method: 'POST', path: '/update/install', body: { version: '0.6.0' } }])
  expect(text(block)).toContain('Kinfold 0.6.0 is installed. Reloading')
  expect(reloaded()).toBe(1)
})

test('a daemon that comes back on the old version means the install did not finish, and the page says so', async () => {
  const { deps, reloaded } = rig([{ version: '0.5.0', pid: 1 }, null, { version: '0.5.0', pid: 7 }])
  const block = (await load()).releaseBlock(RELEASE, deps)
  fire(button(block)!, 'click')
  await settle()
  expect(text(block)).toContain('The install did not finish; Kinfold is still 0.5.0')
  expect(text(block)).toContain('logs/auto-update.log')
  expect(reloaded()).toBe(0)
})

test('a refused install shows the reason and leaves the button to try again', async () => {
  const { deps } = rig([{ version: '0.5.0', pid: 1 }], async () => {
    throw new Error('a backup or restore is running; try again when it finishes')
  })
  const block = (await load()).releaseBlock(RELEASE, deps)
  fire(button(block)!, 'click')
  await settle()
  expect(text(block)).toContain('a backup or restore is running')
  expect(button(block)?.attributes.get('disabled')).toBeUndefined()
})

test('a failure before the restart is read from the install record and shown at once, with the button back', async () => {
  const failed = { version: '0.6.0', state: 'failed', message: 'could not ask GitHub for the latest release (TimeoutError)' }
  const { deps, reloaded } = rig([{ version: '0.5.0', pid: 1 }], undefined, [{ version: '0.6.0', state: 'running', message: null }, failed])
  const block = (await load()).releaseBlock(RELEASE, deps)
  fire(button(block)!, 'click')
  await settle()
  expect(text(block)).toContain('The install did not finish: could not ask GitHub for the latest release (TimeoutError)')
  expect(button(block)?.attributes.get('disabled')).toBeUndefined()
  expect(reloaded()).toBe(0)
})

test('the page opened after a failed install shows that failure under the release', async () => {
  const block = (await load()).releaseBlock(RELEASE, rig([]).deps, { version: '0.6.0', state: 'failed', message: 'the daemon is not run by a background service here; run kinfold update' })
  expect(text(block)).toContain('The last install of 0.6.0 did not finish: the daemon is not run by a background service here; run kinfold update')
})
