import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sumsUrl } from './smoke-sums-url'

describe('sumsUrl', () => {
  test('a Windows path keeps its drive letter', () => {
    const url = sumsUrl('D:\\a\\kinfold\\kinfold\\dist\\SHA256SUMS', true)
    expect(url).toBe('file:///D:/a/kinfold/kinfold/dist/SHA256SUMS')
    expect(fileURLToPath(url, { windows: true })).toBe('D:\\a\\kinfold\\kinfold\\dist\\SHA256SUMS')
  })

  test('a macOS path gives the same URL as file://$PWD did', () => {
    const path = '/Users/runner/work/kinfold/kinfold/dist/SHA256SUMS'
    expect(sumsUrl(path, false)).toBe(`file://${path}`)
  })

  test('the command prints the URL for a relative path', () => {
    const root = resolve(import.meta.dir, '..')
    const result = Bun.spawnSync([process.execPath, 'tools/smoke-sums-url.ts', 'dist/SHA256SUMS'], { cwd: root })
    expect(result.exitCode).toBe(0)
    expect(fileURLToPath(result.stdout.toString().trim())).toBe(join(root, 'dist', 'SHA256SUMS'))
  })
})
