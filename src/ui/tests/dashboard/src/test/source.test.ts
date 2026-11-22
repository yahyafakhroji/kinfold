// What the app's own source must never do: build HTML from strings, run
// strings as code, or reach anywhere but this daemon. React escapes every
// value it renders, so stored memory text can only ever be text.

import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '../../../../dashboard/src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

test('no HTML from strings, no eval, no remote address in the app', () => {
  const offenders = sources(SRC).filter((path) => /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function\(|document\.write/.test(readFileSync(path, 'utf8')))
  expect(offenders).toEqual([])
  const remote = sources(SRC).filter((path) => /['"`]https?:\/\/(?!127\.0\.0\.1|dashscope-intl\.aliyuncs\.com)/.test(readFileSync(path, 'utf8')))
  expect(remote).toEqual([])
})

test('the stylesheet uses system fonts only', () => {
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
  expect(css).not.toMatch(/@font-face|fonts\.googleapis|url\(/)
})
