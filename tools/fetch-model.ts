// Puts the pinned embedding model, its vocabulary and onnxruntime-web's wasm
// under .cache/embed-model/, for a release build (gen-embedded) and for the
// tests that run the real model. Every file is checked against the hash in
// src/resources/vectors/local-model.ts before it is written, whichever source served
// it. It prints KINFOLD_TEST_MODEL_DIR and, in CI, adds it to GITHUB_ENV.

import { createHash } from 'node:crypto'
import { readBodyCapped } from '../src/system/fs/capped-body'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_MODEL_FILES, type PinnedFile } from '../src/resources/vectors/local-model'

const ROOT = join(import.meta.dir, '..')
export const MODEL_CACHE_DIR = join(ROOT, '.cache', 'embed-model')
const WASM_SOURCE = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const DOWNLOAD_TIMEOUT_MS = 120_000

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function checked(file: PinnedFile, bytes: Uint8Array, source: string): Uint8Array {
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`${file.name} from ${source} does not match the pinned sha256; nothing was written`)
  return bytes
}

async function download(file: PinnedFile): Promise<Uint8Array> {
  if (file.url === undefined) throw new Error(`${file.name} has no download URL`)
  const response = await fetch(file.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${file.name} download answered ${response.status}; nothing was written`)
  // The pinned size is the ceiling, held while the body downloads.
  const bytes = await readBodyCapped(response, file.bytes)
  if (bytes === null) throw new Error(`${file.name} download is larger than the pinned file; nothing was written`)
  return checked(file, bytes, 'the download')
}

async function bytesOf(file: PinnedFile): Promise<Uint8Array> {
  const cached = join(MODEL_CACHE_DIR, file.name)
  // A file already here is only reused when it still matches.
  if (existsSync(cached)) {
    const bytes = new Uint8Array(readFileSync(cached))
    if (bytes.length === file.bytes && sha256(bytes) === file.sha256) return bytes
  }
  if (file.url === undefined) return checked(file, new Uint8Array(readFileSync(join(WASM_SOURCE, file.name))), 'node_modules (run bun install)')
  return download(file)
}

if (import.meta.main) {
  mkdirSync(MODEL_CACHE_DIR, { recursive: true, mode: 0o700 })
  for (const file of Object.values(LOCAL_MODEL_FILES)) writeFileSync(join(MODEL_CACHE_DIR, file.name), await bytesOf(file), { mode: 0o600 })
  const line = `KINFOLD_TEST_MODEL_DIR=${MODEL_CACHE_DIR}`
  if (process.env.GITHUB_ENV !== undefined) appendFileSync(process.env.GITHUB_ENV, `${line}\n`)
  console.log(line)
}
