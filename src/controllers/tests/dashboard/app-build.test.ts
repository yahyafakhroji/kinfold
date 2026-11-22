// The built dashboard, as the daemon serves it: nothing inline the CSP would
// refuse, nothing loaded from anywhere but this daemon, every file a page
// names really built, and the whole bundle under its size budget. Runs in CI
// with the rest of `bun test`, so a dependency that bloats the bundle fails
// the build.

import { beforeAll, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { APP_ASSETS, APP_DIST, APP_PAGES, ASSET_NAME, ensureAppBuilt, listAssets } from '../../dashboard/app-files'

/** JS and CSS together, compressed: the design's ceiling for the whole dashboard. */
export const BUNDLE_BUDGET_GZIP_BYTES = 400 * 1024
/** What the first page needs before it can paint: the entry, its imports and the stylesheet. */
export const FIRST_PAINT_BUDGET_GZIP_BYTES = 220 * 1024

beforeAll(() => ensureAppBuilt(), 180_000)

const html = (page: string): string => readFileSync(join(APP_DIST, page), 'utf8')
const gzipped = (name: string): number => gzipSync(readFileSync(join(APP_ASSETS, name))).byteLength

test('the pages carry no inline script, style or handler, and load nothing from elsewhere', () => {
  for (const page of APP_PAGES) {
    const text = html(page)
    expect([page, /<script(?![^>]*\bsrc=)[^>]*>/i.test(text)]).toEqual([page, false])
    expect([page, /<style/i.test(text)]).toEqual([page, false])
    expect([page, /\sstyle=/i.test(text)]).toEqual([page, false])
    expect([page, /\son[a-z]+=/i.test(text)]).toEqual([page, false])
    expect([page, /(src|href)="(https?:)?\/\//i.test(text)]).toEqual([page, false])
  }
})

test('every script and stylesheet a page names was built', () => {
  const built = listAssets()
  for (const page of APP_PAGES) {
    const named = [...html(page).matchAll(/(?:src|href)="\/dashboard\/assets\/([^"]+)"/g)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((name) => !built.has(name))).toEqual([])
  }
})

test('every file the build wrote has a name the daemon serves, chunks loaded later included', () => {
  expect(readdirSync(APP_ASSETS).filter((name) => !ASSET_NAME.test(name))).toEqual([])
})

test('the code never builds functions from strings, which the CSP forbids', () => {
  for (const name of listAssets()) {
    if (!name.endsWith('.js')) continue
    const text = readFileSync(join(APP_ASSETS, name), 'utf8')
    expect([name, /\beval\(|new Function\(/.test(text)]).toEqual([name, false])
  }
})

test('the dashboard stays under its size budget', () => {
  const total = [...listAssets()].reduce((sum, name) => sum + gzipped(name), 0)
  const first = [...html('index.html').matchAll(/(?:src|href)="\/dashboard\/assets\/([^"]+)"/g)].reduce((sum, match) => sum + gzipped(match[1]!), 0)
  process.stderr.write(`dashboard bundle: ${Math.round(total / 1024)} KB gzipped in all, ${Math.round(first / 1024)} KB before first paint\n`)
  expect(total).toBeLessThan(BUNDLE_BUDGET_GZIP_BYTES)
  expect(first).toBeLessThan(FIRST_PAINT_BUDGET_GZIP_BYTES)
})
