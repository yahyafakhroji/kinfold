// Puts the pinned sqlite-vec build for this machine under .cache/vec0/ so the
// two vec0 tests can run against the real extension, checking the same two
// hashes `kinfold install` checks. It prints KINFOLD_TEST_VEC0 and, in CI,
// adds it to GITHUB_ENV for the test step. A platform with no pinned build
// prints the reason and exits 0: the program itself has no vec0 there, so the
// tests skipping is the correct result, not an error.

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_VEC0_TARBALL_BYTES, tarMember } from '../src/install/vec0-install'
import { vec0AssetFor } from '../src/vectors/vec0-release'

const CACHE_DIR = join(import.meta.dir, '..', '.cache', 'vec0')
const DOWNLOAD_TIMEOUT_MS = 60_000

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const asset = vec0AssetFor(process.platform, process.arch)
if (asset === null) {
  console.log(`no pinned sqlite-vec build for ${process.platform}-${process.arch}; the vec0 tests skip`)
  process.exit(0)
}

const response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
if (!response.ok) throw new Error(`the sqlite-vec download answered ${response.status}; nothing was written`)
const tarball = new Uint8Array(await response.arrayBuffer())
if (tarball.length > MAX_VEC0_TARBALL_BYTES) throw new Error('the sqlite-vec download is far larger than the release; nothing was written')
if (sha256(tarball) !== asset.tarballSha256) throw new Error('the sqlite-vec download does not match the pinned sha256; nothing was written')
const member = tarMember(Bun.gunzipSync(tarball), asset.member)
if (member === null) throw new Error(`the sqlite-vec tarball has no ${asset.member}; nothing was written`)
if (sha256(member) !== asset.dylibSha256) throw new Error(`${asset.member} does not match the pinned sha256; nothing was written`)

mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
const path = join(CACHE_DIR, asset.member)
writeFileSync(path, member, { mode: 0o600 })
const line = `KINFOLD_TEST_VEC0=${path}`
if (process.env.GITHUB_ENV !== undefined) appendFileSync(process.env.GITHUB_ENV, `${line}\n`)
console.log(line)
