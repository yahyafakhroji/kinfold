import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { vec0Path } from '../vectors/extension'
import type { Vec0Asset } from '../vectors/vec0-release'
import type { InstallEnv } from './env'
import { type FakeWorld, createWorld, placeBuiltLibrary } from './test-support'
import { installVec0, tarMember, vec0InstallActions, vectorStatusLine } from './vec0-install'
import { posixOnly } from '../../test/platform-guards'

let w: FakeWorld
beforeEach(() => {
  w = createWorld({ withLibrary: false })
})
afterEach(async () => {
  await w.cleanup()
})

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const DYLIB = new TextEncoder().encode('\xcf\xfa\xed\xfe pretend mach-o bytes')

/** One ustar header plus content, padded to blocks, then the two zero blocks. */
function tarOf(name: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512)
  const put = (text: string, at: number) => header.set(new TextEncoder().encode(text), at)
  put(name, 0)
  put('0000644\0', 100)
  put(`${content.length.toString(8).padStart(11, '0')}\0`, 124)
  put('0', 156)
  put('ustar\0', 257)
  const body = new Uint8Array(Math.ceil(content.length / 512) * 512)
  body.set(content)
  const out = new Uint8Array(512 + body.length + 1024)
  out.set(header)
  out.set(body, 512)
  return out
}

const TARBALL = Bun.gzipSync(tarOf('./vec0.dylib', DYLIB))
const ASSET: Vec0Asset = { url: 'https://example.test/vec0.tgz', tarballSha256: sha(TARBALL), member: 'vec0.dylib', fileSha256: sha(DYLIB) }
const README_TARBALL = Bun.gzipSync(tarOf('README', DYLIB))

function envServing(body: Uint8Array, status = 200): { env: InstallEnv; urls: string[] } {
  const urls: string[] = []
  return { env: { ...w.env, fetch: async (url) => (urls.push(url), new Response(body, { status })) }, urls }
}

test('tarMember finds the member by base name and refuses what is not there', () => {
  const tar = tarOf('./vec0.dylib', DYLIB)
  expect(tarMember(tar, 'vec0.dylib')).toEqual(DYLIB)
  expect(tarMember(tar, 'other.dylib')).toBeNull()
  expect(tarMember(new Uint8Array(1024), 'vec0.dylib')).toBeNull()
})

posixOnly('file modes')('a matching download is unpacked and written 0600 into <dataDir>/lib', async () => {
  const { env, urls } = envServing(TARBALL)
  const path = vec0Path(w.dataDir)
  await installVec0(env, path, ASSET)
  expect(urls).toEqual([ASSET.url])
  expect(new Uint8Array(readFileSync(path))).toEqual(DYLIB)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test.each([
  ['a tarball whose hash differs', Bun.gzipSync(tarOf('vec0.dylib', new TextEncoder().encode('tampered'))), 200, ASSET, 'download does not match'],
  ['a dylib whose hash differs', TARBALL, 200, { ...ASSET, fileSha256: 'f'.repeat(64) }, 'vec0.dylib does not match'],
  ['a tarball without the member', README_TARBALL, 200, { ...ASSET, tarballSha256: sha(README_TARBALL) }, 'has no vec0.dylib'],
  ['an HTTP error', new Uint8Array(0), 404, ASSET, 'answered 404'],
] as const)('%s stops the step with nothing written', async (_name, body, status, asset, message) => {
  const { env } = envServing(body, status)
  const path = vec0Path(w.dataDir)
  await expect(installVec0(env, path, asset)).rejects.toThrow(message)
  expect(existsSync(path)).toBe(false)
})

const DOWN = { up: false, reason: 'not running' } as const

test('on darwin-arm64 without the file the plan downloads it and restarts the daemon to load it', () => {
  const plan = vec0InstallActions({ ...w.env, arch: 'arm64' }, DOWN)
  expect(plan.actions.map((action) => action.kind)).toEqual(['install-vec0'])
  expect(plan.restartDaemon).toBe(true)
  expect(w.out.some((line) => line.includes('brew'))).toBe(false)
})

test('status names what is missing, or that the daemon needs a restart, or that search is on', () => {
  const arm = { ...w.env, arch: 'arm64' }
  const up = (vectorSearch: 'on' | 'off') => ({ up: true, version: '0.0.1', schemaVersion: 8, hmacMode: 'master', vectorSearch }) as const
  expect(vectorStatusLine(arm, DOWN)).toBe('semantic search: off; missing the sqlite3mc library (kinfold install) and sqlite-vec 0.1.9 (kinfold install)')
  placeBuiltLibrary(w.dataDir, 'darwin')
  expect(vectorStatusLine(arm, up('off'))).toBe('semantic search: off; missing sqlite-vec 0.1.9 (kinfold install)')
  expect(vectorStatusLine(arm, up('on'))).toBe('semantic search: on')
  expect(vectorStatusLine(w.env, DOWN)).toBe('semantic search: off (no pinned sqlite-vec build for darwin-test-arch)')
})

test('an arch with no pinned build plans nothing and says search stays keyword-only', () => {
  expect(vec0InstallActions(w.env, DOWN)).toEqual({ actions: [], restartDaemon: false })
  expect(w.out).toContain('semantic search: no pinned sqlite-vec build for darwin-test-arch; search stays keyword-only')
})
